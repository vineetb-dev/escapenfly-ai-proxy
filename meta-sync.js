/**
 * meta-sync.js
 * Pulls Facebook Ads, Facebook Page (organic), and Instagram data directly
 * from Meta's official Graph API — no third-party aggregator, no recurring fee.
 *
 * Replaces the Windsor.ai "facebook", "facebook_organic", "facebook_leads",
 * "instagram", and "instagram_public" connectors for EscapeNFly's
 * marketing_performance table.
 *
 * REQUIRED ENV VARS (set these in Render, never in code or chat):
 *   META_ACCESS_TOKEN   - Long-lived Page/System User token with
 *                          ads_read, pages_read_engagement, instagram_basic,
 *                          instagram_manage_insights permissions
 *   META_PAGE_ID         - Escapenfly Facebook Page ID
 *   META_IG_BUSINESS_ID  - Instagram Business Account ID linked to the Page
 *   META_AD_ACCOUNT_ID   - Ad account ID, format: act_XXXXXXXXXX
 *   SUPABASE_URL          - already set (shared with rest of ai-proxy)
 *   SUPABASE_SERVICE_ROLE_KEY - already set (shared with rest of ai-proxy)
 */

const { createClient } = require('@supabase/supabase-js');

// Expired versions do NOT error — they silently reroute to the next oldest
// supported version and can change response shape with no signal. Keep this
// in step with server.js's META_GRAPH_VERSION, and check Meta's changelog
// before bumping. v25.0 current as of Feb 2026; v24.0 is the oldest
// supported.
const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getSupabase() {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  );
}

async function graphGet(path, params = {}, tokenOverride = null) {
  const token = tokenOverride || requireEnv('META_ACCESS_TOKEN');
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', token);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) {
    throw new Error(`Graph API error [${path}]: ${data.error.message} (code ${data.error.code})`);
  }
  return data;
}

/** Exchange the System User token for this specific Page's own Page Access Token */
async function getPageAccessToken(pageId) {
  const data = await graphGet(`/${pageId}`, { fields: 'access_token' });
  if (!data.access_token) throw new Error('Could not obtain Page Access Token — check system user has admin access on the Page');
  return data.access_token;
}

/** Ads spend/reach/engagement, yesterday, per campaign */
async function fetchAdsInsights() {
  const adAccountId = requireEnv('META_AD_ACCOUNT_ID'); // act_XXXXXXXXXX
  const data = await graphGet(`/${adAccountId}/insights`, {
    level: 'campaign',
    fields: 'campaign_name,spend,reach,impressions,clicks,actions',
    date_preset: 'yesterday',
  });
  return (data.data || []).map(row => ({
    campaign_name: row.campaign_name,
    spend: parseFloat(row.spend || 0),
    reach: parseInt(row.reach || 0, 10),
    engagement: (row.actions || [])
      .filter(a => ['post_engagement', 'page_engagement'].includes(a.action_type))
      .reduce((sum, a) => sum + parseInt(a.value || 0, 10), 0),
  }));
}

/** Facebook Page organic insights, last 1 day */
async function fetchPageOrganicInsights() {
  const pageId = requireEnv('META_PAGE_ID');
  const pageToken = await getPageAccessToken(pageId);
  const data = await graphGet(`/${pageId}/insights`, {
    metric: 'page_views_total,page_post_engagements',
    period: 'day',
  }, pageToken);
  const byMetric = {};
  (data.data || []).forEach(m => {
    const latest = m.values?.[m.values.length - 1];
    byMetric[m.name] = latest ? latest.value : 0;
  });
  return {
    reach: byMetric.page_views_total || 0,
    engagement: byMetric.page_post_engagements || 0,
  };
}

/** Instagram media list + per-media insights, last 3 days (covers reels check) */
async function fetchInstagramMediaInsights(sinceDays = 3) {
  const igId = requireEnv('META_IG_BUSINESS_ID');
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;

  const mediaList = await graphGet(`/${igId}/media`, {
    fields: 'id,caption,media_type,media_product_type,permalink,timestamp',
    since,
  });

  const results = [];
  for (const media of mediaList.data || []) {
    const isReel = media.media_product_type === 'REELS';
    const metrics = isReel
      ? 'reach,likes,comments,saved,shares,total_interactions'
      : 'reach,likes,comments,saved,shares';

    let insights;
    try {
      insights = await graphGet(`/${media.id}/insights`, { metric: metrics });
    } catch (e) {
      console.warn(`Skipping insights for media ${media.id}: ${e.message}`);
      continue;
    }

    const byMetric = {};
    (insights.data || []).forEach(m => {
      byMetric[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
    });

    results.push({
      media_id: media.id,
      caption: media.caption || '',
      permalink: media.permalink,
      media_type: media.media_product_type,
      timestamp: media.timestamp,
      reach: byMetric.reach || 0,
      likes: byMetric.likes || 0,
      comments: byMetric.comments || 0,
      saved: byMetric.saved || 0,
      shares: byMetric.shares || 0,
      total_interactions: byMetric.total_interactions || null,
    });
  }
  return results;
}

/**
 * Matches Instagram media to a marketing_assets row by permalink (stored in
 * asset_url), so performance data lands against the right campaign_code.
 * Falls back to campaign_code = 'UNMATCHED_IG' if no asset row has that URL —
 * surfaces gaps instead of silently dropping data.
 */
async function matchAndUpsert(supabase, igResults) {
  const { data: assets } = await supabase
    .from('marketing_assets')
    .select('id, campaign_code, asset_url')
    .eq('platform', 'Instagram');

  const byUrl = new Map((assets || []).map(a => [a.asset_url, a.campaign_code]));
  const today = new Date().toISOString().slice(0, 10);

  const rows = igResults.map(m => ({
    id: `meta_${m.media_id}_${today}`,
    campaign_code: byUrl.get(m.permalink) || 'UNMATCHED_IG',
    platform: 'Instagram',
    reach: m.reach,
    engagement: m.likes + m.comments + m.saved + m.shares,
    spend: null,
    followers_gained: null,
    source: 'meta_graph_api',
    snapshot_date: today,
  }));

  if (rows.length === 0) return { upserted: 0 };

  const { error } = await supabase
    .from('marketing_performance')
    .upsert(rows, { onConflict: 'id' });

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  return { upserted: rows.length, unmatched: rows.filter(r => r.campaign_code === 'UNMATCHED_IG').length };
}

async function runSync() {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const summary = { date: today, errors: [] };

  try {
    const ads = await fetchAdsInsights();
    const adsRows = ads.map((a, i) => ({
      id: `meta_ads_${today}_${i}`,
      campaign_code: a.campaign_name || 'UNKNOWN_CAMPAIGN',
      platform: 'Facebook Ads',
      reach: a.reach,
      engagement: a.engagement,
      spend: a.spend,
      followers_gained: null,
      source: 'meta_graph_api',
      snapshot_date: today,
    }));
    if (adsRows.length) {
      const { error } = await supabase.from('marketing_performance').upsert(adsRows, { onConflict: 'id' });
      if (error) throw error;
    }
    summary.ads = adsRows.length;
  } catch (e) {
    summary.errors.push(`ads: ${e.message}`);
  }

  try {
    const page = await fetchPageOrganicInsights();
    const { error } = await supabase.from('marketing_performance').upsert({
      id: `meta_page_${today}`,
      campaign_code: 'ORGANIC_PAGE',
      platform: 'Facebook Organic',
      reach: page.reach,
      engagement: page.engagement,
      spend: null,
      followers_gained: null,
      source: 'meta_graph_api',
      snapshot_date: today,
    }, { onConflict: 'id' });
    if (error) throw error;
    summary.page = 1;
  } catch (e) {
    summary.errors.push(`page: ${e.message}`);
  }

  try {
    const ig = await fetchInstagramMediaInsights(3);
    const result = await matchAndUpsert(supabase, ig);
    summary.instagram = result;
  } catch (e) {
    summary.errors.push(`instagram: ${e.message}`);
  }

  return summary;
}

module.exports = { runSync, fetchAdsInsights, fetchPageOrganicInsights, fetchInstagramMediaInsights };

if (require.main === module) {
  runSync()
    .then(summary => {
      console.log('Meta sync complete:', JSON.stringify(summary, null, 2));
      process.exit(summary.errors.length ? 1 : 0);
    })
    .catch(err => {
      console.error('Meta sync failed:', err);
      process.exit(1);
    });
}
