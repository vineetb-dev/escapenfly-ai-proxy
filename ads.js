/**
 * ads.js
 * Meta Marketing API integration for EscapeNFly's ad account — read-only
 * reporting (campaign/adset/ad overview with insights, custom audiences)
 * plus tightly-scoped writes (pause/enable, budget, and a "boost an
 * existing post into an engagement campaign" builder). Wired into
 * server.js the same "thin wrapper" shape as publish-social.js — real
 * logic here, routes + auth there.
 *
 * Self-contained like every other integration file in this repo (own
 * Supabase client, own GRAPH_VERSION pin — see publish-social.js's header
 * comment for why these don't cross-import).
 *
 * SAFETY MODEL — read this before touching a write function:
 *   - Every write (setAdsObjectStatus, updateAdsBudget,
 *     createEngagementFromPost) takes a `confirm` flag. Without it, the
 *     function returns a `{ ok:true, dry:true, would:{...} }` preview and
 *     makes ZERO Graph API calls — nothing about the account is touched.
 *   - createEngagementFromPost NEVER sets status:'ACTIVE' anywhere, with
 *     or without confirm — the campaign, every ad set, and every ad it
 *     creates are always 'PAUSED'. Turning real spend on is a deliberate,
 *     separate human action via /internal/ads/enable, not something this
 *     endpoint ever does itself.
 *   - Every successful write logs to internal_notifications
 *     (notification_type: 'ads_change') via logAdsChange(), which never
 *     throws — a missing/broken Supabase config degrades to a
 *     console.error, it never makes an already-successful Meta write look
 *     like it failed. Deliberately different from publish-social.js's
 *     writeNotification() (which takes an already-created `sb` and lets a
 *     missing Supabase config fail the whole call) — there, Supabase is a
 *     true prerequisite (the row being published lives there); here it's
 *     purely observational on top of a write that already succeeded
 *     against Meta.
 *
 * NOT independently verified against a live ad account — no real
 * META_ACCESS_TOKEN/ad-account access in this environment. Structural API
 * shape (campaigns -> adsets -> ads, AdCreative via object_story_id /
 * source_instagram_media_id, budgets in minor currency units, PAUSED by
 * default) is high-confidence, matches Meta's documented Marketing API.
 * Lower-confidence, flagged individually below where they occur: the exact
 * optimization_goal enum spelling for each `goal`, the exact placement
 * targeting field values for 'reels', and the objective->"Results" action
 * type mapping (Ads Manager's own Results column is objective/optimization
 * goal specific — the raw actions[]/cost_per_action_type[] arrays are
 * always included alongside the computed guess so nothing is hidden if a
 * mapping is wrong for a particular campaign). Spot-check all of these
 * against a real account before the first real (confirm=1) use.
 *
 * REQUIRED ENV VARS:
 *   META_ACCESS_TOKEN          - same system-user token server.js/
 *                                 publish-social.js/maya-messaging.js use,
 *                                 now also granted ads_read + ads_management
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - already set (shared with the
 *                                 other integration files)
 */

const { createClient } = require('@supabase/supabase-js');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getSupabase() {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'));
}

// Expired Graph API versions do NOT error — they silently reroute to the
// next oldest supported version with no signal (see server.js's CLAUDE.md
// writeup on the v18.0/v21.0 incident). v25.0 is current as of Feb 2026 —
// pinned independently here, same "each integration file pins its own, kept
// in step by hand" reasoning as publish-social.js/meta-sync.js.
const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Real EscapeNFly identifiers — pinned here same as FB_PAGE_ID is pinned
// independently in publish-social.js/maya-messaging.js.
const AD_ACCOUNT_ID = 'act_710120866692554';
const FB_PAGE_ID = '128897537530800';
const IG_BUSINESS_ID = '17841476056303450';

// ── GRAPH API — text-first parsing (same fix as maya-messaging.js's
//    graphGet/sendViaGraph — a non-2xx response isn't guaranteed to be
//    JSON, and letting JSON.parse throw there loses the HTTP status and
//    body entirely) ──

async function graphGet(path, params, token) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', token);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  return parseGraphResponse(path, res);
}

// Complex objects and arrays are passed as native JS values, not
// individually JSON-stringified — same convention publishCarousel()
// already uses for attached_media in publish-social.js. Content-Type:
// application/json means the WHOLE body is stringified once here; Graph
// API accepts nested JSON directly in a JSON request body.
async function graphPost(path, body, token) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', token);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return parseGraphResponse(path, res);
}

async function parseGraphResponse(path, res) {
  const rawText = await res.text();
  let data = null;
  try { data = JSON.parse(rawText); } catch { /* non-JSON body, handled below */ }
  if (data && data.error) throw new Error(`Graph API error [${path}]: ${data.error.message} (code ${data.error.code})`);
  if (!res.ok) throw new Error(`Graph API error [${path}]: HTTP ${res.status} — ${rawText.slice(0, 300)}`);
  return data || {};
}

// Follows paging.next (a complete, ready-to-fetch URL Graph API returns —
// already carries the access token and original params) until it runs out
// or a safety cap is hit, guarding against a pagination bug looping forever
// against a real, possibly-large ad account.
const MAX_PAGES = 50;
async function graphGetAll(path, params, token) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', token);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));

  let allData = [];
  let nextUrl = url.toString();
  let pages = 0;
  while (nextUrl && pages < MAX_PAGES) {
    const res = await fetch(nextUrl);
    const data = await parseGraphResponse(path, res);
    allData = allData.concat(data.data || []);
    nextUrl = (data.paging && data.paging.next) || null;
    pages++;
  }
  return allData;
}

// ── PURE HELPERS (exported for tests — no network, no Supabase) ──

// Meta bills daily_budget in the ad account's currency's smallest unit —
// for INR (2 decimal places) that's paise, i.e. rupees * 100. Not verified
// against a real account (no live ad-account access here); flagged the
// same way the CRM's own costing-markup rounding rules are, since a silent
// off-by-100 here would be a real, expensive mistake.
function inrToPaise(inr) {
  return Math.round(Number(inr) * 100);
}

function isFacebookPostId(postId) {
  return typeof postId === 'string' && postId.startsWith(`${FB_PAGE_ID}_`);
}

function sumActionValues(actionsArr) {
  if (!actionsArr || !actionsArr.length) return 0;
  return actionsArr.reduce((sum, a) => sum + Number(a.value || 0), 0);
}

// Best-effort mapping from a campaign's objective to the action_type Ads
// Manager's own "Results" column would show for it. NOT independently
// verified against a live account — the real mapping actually depends on
// the ad set's optimization_goal, not just the campaign's objective, so
// this is a coarser approximation. The raw actions[]/cost_per_action_type[]
// arrays are always included in the response alongside this computed
// guess so nothing is hidden if it's wrong for a particular campaign —
// spot-check against Ads Manager's Results column once real data exists.
const OBJECTIVE_RESULT_ACTION_TYPE = {
  OUTCOME_ENGAGEMENT: 'post_engagement',
  OUTCOME_TRAFFIC: 'link_click',
  OUTCOME_LEADS: 'lead',
  OUTCOME_SALES: 'purchase',
  OUTCOME_APP_PROMOTION: 'app_install'
  // OUTCOME_AWARENESS deliberately has no entry — awareness campaigns are
  // read via reach/impressions/frequency directly, not a discrete "result"
  // action type.
};

function pickResult(objective, actions, costPerActionType, spend) {
  const actionType = OBJECTIVE_RESULT_ACTION_TYPE[objective] || null;
  if (!actionType || !actions) return { results: null, cost_per_result: null, result_type: actionType };
  const match = actions.find(a => a.action_type === actionType);
  if (!match) return { results: null, cost_per_result: null, result_type: actionType };
  const results = Number(match.value);
  const costMatch = costPerActionType && costPerActionType.find(a => a.action_type === actionType);
  const cost_per_result = costMatch ? Number(costMatch.value) : (results ? Number(spend || 0) / results : null);
  return { results, cost_per_result, result_type: actionType };
}

function summarizeInsights(objective, row) {
  if (!row) {
    return {
      spend: 0, impressions: 0, reach: 0, ctr: null, frequency: null, thruplays: 0,
      results: null, cost_per_result: null, result_type: OBJECTIVE_RESULT_ACTION_TYPE[objective] || null,
      actions: [], cost_per_action_type: []
    };
  }
  const thruplays = sumActionValues(row.video_thruplay_watched_actions);
  const { results, cost_per_result, result_type } = pickResult(objective, row.actions, row.cost_per_action_type, row.spend);
  return {
    spend: row.spend != null ? Number(row.spend) : 0,
    impressions: row.impressions != null ? Number(row.impressions) : 0,
    reach: row.reach != null ? Number(row.reach) : 0,
    ctr: row.ctr != null ? Number(row.ctr) : null,
    frequency: row.frequency != null ? Number(row.frequency) : null,
    thruplays,
    results, cost_per_result, result_type,
    actions: row.actions || [],
    cost_per_action_type: row.cost_per_action_type || []
  };
}

// NOT independently verified against Meta's current Placements reference —
// double-check facebook_positions/instagram_positions enum values before
// the first real (confirm=1) use of engagement-from-post.
const PLACEMENT_TARGETING = {
  reels: {
    publisher_platforms: ['facebook', 'instagram'],
    facebook_positions: ['facebook_reels'],
    instagram_positions: ['reels']
  }
};

function buildTargeting({ audienceIds, lookalikeAudienceId, placements }) {
  const customAudiences = [...(audienceIds || []), ...(lookalikeAudienceId ? [lookalikeAudienceId] : [])]
    .map(id => ({ id }));
  let placementFields = {};
  for (const p of (placements || [])) {
    placementFields = { ...placementFields, ...PLACEMENT_TARGETING[p] };
  }
  const targeting = { geo_locations: { countries: ['IN'] }, ...placementFields };
  if (customAudiences.length) targeting.custom_audiences = customAudiences;
  return targeting;
}

function creativeParamsForPost(postId) {
  if (isFacebookPostId(postId)) return { object_story_id: postId };
  // Bare id (no FB_PAGE_ID prefix) -> treated as an Instagram media id, per
  // this endpoint's documented contract ("page_id_postid or ig media id").
  return { instagram_actor_id: IG_BUSINESS_ID, source_instagram_media_id: postId };
}

function unknownPlacements(placements) {
  return (placements || []).filter(p => !PLACEMENT_TARGETING[p]);
}

// ── NOTIFICATIONS — see the file header's SAFETY MODEL note on why this
//    never throws, unlike publish-social.js's writeNotification() ──

async function logAdsChange({ action, level, id, detail }) {
  try {
    const sb = getSupabase();
    const summary = `Ads: ${action}${level ? ` ${level}` : ''}${id ? ` ${id}` : ''}${detail ? ` — ${detail}` : ''}`;
    const { error } = await sb.from('internal_notifications').insert({ notification_type: 'ads_change', summary });
    if (error) console.error(`ads logAdsChange [${action}] failed:`, error.message);
  } catch (e) {
    console.error(`ads logAdsChange [${action}] failed:`, e.message);
  }
}

// ── 1. GET /internal/ads/overview?since=&until= ──

const METRIC_FIELDS = 'spend,impressions,reach,actions,cost_per_action_type,ctr,frequency,video_thruplay_watched_actions';

async function getAdsOverview({ since, until }) {
  if ((since && !until) || (until && !since)) {
    return { ok: false, error: 'since and until must both be provided, or neither' };
  }
  const token = requireEnv('META_ACCESS_TOKEN');
  const timeParam = (since && until) ? { time_range: JSON.stringify({ since, until }) } : { date_preset: 'last_7d' };

  const [campaigns, adsets, ads, campaignInsights, adsetInsights, adInsights] = await Promise.all([
    graphGetAll(`/${AD_ACCOUNT_ID}/campaigns`, { fields: 'id,name,objective,status,daily_budget', limit: '100' }, token),
    graphGetAll(`/${AD_ACCOUNT_ID}/adsets`, { fields: 'id,name,status,daily_budget,campaign_id', limit: '100' }, token),
    graphGetAll(`/${AD_ACCOUNT_ID}/ads`, { fields: 'id,name,status,adset_id,campaign_id', limit: '100' }, token),
    graphGetAll(`/${AD_ACCOUNT_ID}/insights`, { level: 'campaign', fields: `campaign_id,${METRIC_FIELDS}`, limit: '100', ...timeParam }, token),
    graphGetAll(`/${AD_ACCOUNT_ID}/insights`, { level: 'adset', fields: `adset_id,campaign_id,${METRIC_FIELDS}`, limit: '100', ...timeParam }, token),
    graphGetAll(`/${AD_ACCOUNT_ID}/insights`, { level: 'ad', fields: `ad_id,adset_id,campaign_id,${METRIC_FIELDS}`, limit: '100', ...timeParam }, token)
  ]);

  const byId = (rows, key) => new Map(rows.map(r => [r[key], r]));
  const campaignInsightsById = byId(campaignInsights, 'campaign_id');
  const adsetInsightsById = byId(adsetInsights, 'adset_id');
  const adInsightsById = byId(adInsights, 'ad_id');

  const groupBy = (rows, key) => rows.reduce((acc, r) => {
    (acc[r[key]] = acc[r[key]] || []).push(r);
    return acc;
  }, {});
  const adsetsByCampaignId = groupBy(adsets, 'campaign_id');
  const adsByAdsetId = groupBy(ads, 'adset_id');

  const toBudgetInr = (v) => (v != null ? Number(v) / 100 : null);

  const tree = campaigns.map(c => ({
    id: c.id, name: c.name, objective: c.objective, status: c.status,
    daily_budget_inr: toBudgetInr(c.daily_budget),
    ...summarizeInsights(c.objective, campaignInsightsById.get(c.id)),
    adsets: (adsetsByCampaignId[c.id] || []).map(as => ({
      id: as.id, name: as.name, status: as.status,
      daily_budget_inr: toBudgetInr(as.daily_budget),
      ...summarizeInsights(c.objective, adsetInsightsById.get(as.id)),
      ads: (adsByAdsetId[as.id] || []).map(ad => ({
        id: ad.id, name: ad.name, status: ad.status,
        ...summarizeInsights(c.objective, adInsightsById.get(ad.id))
      }))
    }))
  }));

  return {
    ok: true,
    since: since || null, until: until || null,
    date_preset: (since && until) ? null : 'last_7d',
    campaigns: tree
  };
}

// ── 2. GET /internal/ads/audiences ──

async function getAdAudiences() {
  const token = requireEnv('META_ACCESS_TOKEN');
  const rows = await graphGetAll(`/${AD_ACCOUNT_ID}/customaudiences`, {
    fields: 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound',
    limit: '100'
  }, token);
  return {
    ok: true,
    audiences: rows.map(r => ({
      id: r.id, name: r.name, subtype: r.subtype,
      // approximate_count is a deprecated single-number field on current
      // Graph API versions — the real field is this lower/upper range.
      approximate_size: {
        lower_bound: r.approximate_count_lower_bound != null ? Number(r.approximate_count_lower_bound) : null,
        upper_bound: r.approximate_count_upper_bound != null ? Number(r.approximate_count_upper_bound) : null
      }
    }))
  };
}

// ── 3. POST /internal/ads/pause and /internal/ads/enable ──

const VALID_LEVELS = ['campaign', 'adset', 'ad'];

async function setAdsObjectStatus({ level, id, status, confirm }) {
  if (!VALID_LEVELS.includes(level)) return { ok: false, error: `level must be one of ${VALID_LEVELS.join(', ')}` };
  if (!id) return { ok: false, error: 'id is required' };
  if (!confirm) return { ok: true, dry: true, would: { level, id, status } };

  const token = requireEnv('META_ACCESS_TOKEN');
  const graph_response = await graphPost(`/${id}`, { status }, token);
  await logAdsChange({ action: status === 'ACTIVE' ? 'enable' : 'pause', level, id });
  return { ok: true, level, id, status, graph_response };
}

// ── 4. POST /internal/ads/budget ──

async function updateAdsBudget({ level, id, dailyBudgetInr, confirm }) {
  if (level !== 'campaign' && level !== 'adset') {
    return { ok: false, error: 'level must be campaign or adset — an ad does not carry a budget' };
  }
  if (!id) return { ok: false, error: 'id is required' };
  const paise = inrToPaise(dailyBudgetInr);
  if (!Number.isFinite(paise) || paise <= 0) return { ok: false, error: 'daily_budget_inr must be a positive number' };
  if (!confirm) return { ok: true, dry: true, would: { level, id, daily_budget_inr: dailyBudgetInr, daily_budget_paise: paise } };

  const token = requireEnv('META_ACCESS_TOKEN');
  const graph_response = await graphPost(`/${id}`, { daily_budget: paise }, token);
  await logAdsChange({ action: 'budget', level, id, detail: `daily_budget -> ₹${dailyBudgetInr}/day` });
  return { ok: true, level, id, daily_budget_inr: dailyBudgetInr, graph_response };
}

// ── 5. POST /internal/ads/engagement-from-post ──

// NOT independently verified against Meta's current optimization_goal
// reference — double-check these exact enum strings before the first real
// (confirm=1) use. A wrong value surfaces as a clear Graph API 400, not a
// silent failure, but better to catch it before spending anything.
const GOAL_TO_OPTIMIZATION_GOAL = {
  thruplay: 'THRUPLAY',
  profile_visits: 'PROFILE_VISIT'
};

// 1% India lookalike — a reasonable EscapeNFly-market default, not
// independently verified against a live account. Pass a pre-built
// lookalike audience id via audience_ids instead if a different
// ratio/country is ever needed; this default only applies when
// lookalike_from_audience_id asks this endpoint to build a new one.
const DEFAULT_LOOKALIKE_SPEC = { type: 'similarity', ratio: 0.01, country: 'IN' };

async function createLookalikeAudience(sourceAudienceId, token) {
  const name = `Lookalike of ${sourceAudienceId} (auto, ${new Date().toISOString().slice(0, 10)})`;
  const data = await graphPost(`/${AD_ACCOUNT_ID}/customaudiences`, {
    name,
    subtype: 'LOOKALIKE',
    origin_audience_id: sourceAudienceId,
    lookalike_spec: DEFAULT_LOOKALIKE_SPEC
  }, token);
  await logAdsChange({ action: 'create_lookalike_audience', level: 'audience', id: data.id, detail: `from ${sourceAudienceId}` });
  return data.id;
}

async function createEngagementFromPost({ campaignName, postId, audienceIds, lookalikeFromAudienceId, dailyBudgetInr, placements, goals, confirm }) {
  if (!campaignName) return { ok: false, error: 'campaign_name is required' };
  if (!postId) return { ok: false, error: 'post_id is required' };
  if (!goals || !goals.length) return { ok: false, error: 'at least one goal is required' };
  const unknownGoals = goals.filter(g => !GOAL_TO_OPTIMIZATION_GOAL[g]);
  if (unknownGoals.length) {
    return { ok: false, error: `unknown goal(s): ${unknownGoals.join(', ')} — supported: ${Object.keys(GOAL_TO_OPTIMIZATION_GOAL).join(', ')}` };
  }
  const badPlacements = unknownPlacements(placements);
  if (badPlacements.length) {
    return { ok: false, error: `unknown placement(s): ${badPlacements.join(', ')} — supported: ${Object.keys(PLACEMENT_TARGETING).join(', ')}` };
  }
  const paise = inrToPaise(dailyBudgetInr);
  if (!Number.isFinite(paise) || paise <= 0) return { ok: false, error: 'daily_budget_inr must be a positive number' };

  const creativeSource = isFacebookPostId(postId) ? 'facebook_post' : 'instagram_media';

  if (!confirm) {
    return {
      ok: true, dry: true,
      would: {
        campaign_name: campaignName, objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED',
        creative_source: creativeSource,
        will_create_lookalike_from: lookalikeFromAudienceId || null,
        adsets: goals.map(g => ({
          goal: g, optimization_goal: GOAL_TO_OPTIMIZATION_GOAL[g],
          daily_budget_inr: dailyBudgetInr, daily_budget_paise: paise,
          placements: placements || [], status: 'PAUSED'
        }))
      }
    };
  }

  const token = requireEnv('META_ACCESS_TOKEN');

  // No automatic rollback on a partial failure below (creating a real
  // campaign is itself a mutating Meta action — auto-deleting one on error
  // would be a second unattended mutation, which this repo's established
  // pattern avoids; see publishFbRow's own catch, which records the error
  // rather than trying to undo prior steps). Whatever was created so far is
  // returned alongside the error so a human can see exactly what exists.
  const created = { lookalike_audience_id: null, campaign_id: null, creative_id: null, adsets: [] };
  try {
    if (lookalikeFromAudienceId) {
      created.lookalike_audience_id = await createLookalikeAudience(lookalikeFromAudienceId, token);
    }

    // Created PAUSED — this endpoint never activates anything, by design.
    const campaign = await graphPost(`/${AD_ACCOUNT_ID}/campaigns`, {
      name: campaignName,
      objective: 'OUTCOME_ENGAGEMENT',
      status: 'PAUSED',
      special_ad_categories: []
    }, token);
    created.campaign_id = campaign.id;

    const creativeParams = creativeParamsForPost(postId);
    const creative = await graphPost(`/${AD_ACCOUNT_ID}/adcreatives`, {
      name: `${campaignName} — creative`,
      ...creativeParams
    }, token);
    created.creative_id = creative.id;

    const targeting = buildTargeting({ audienceIds, lookalikeAudienceId: created.lookalike_audience_id, placements });

    for (const goal of goals) {
      const adset = await graphPost(`/${AD_ACCOUNT_ID}/adsets`, {
        name: `${campaignName} — ${goal}`,
        campaign_id: campaign.id,
        optimization_goal: GOAL_TO_OPTIMIZATION_GOAL[goal],
        billing_event: 'IMPRESSIONS',
        daily_budget: paise,
        status: 'PAUSED',
        targeting
      }, token);

      const ad = await graphPost(`/${AD_ACCOUNT_ID}/ads`, {
        name: `${campaignName} — ${goal} ad`,
        adset_id: adset.id,
        creative: { creative_id: creative.id },
        status: 'PAUSED'
      }, token);

      created.adsets.push({ goal, adset_id: adset.id, ad_id: ad.id });
    }
  } catch (e) {
    await logAdsChange({
      action: 'create_engagement_campaign_partial_failure', level: 'campaign', id: created.campaign_id,
      detail: `"${campaignName}" — failed: ${e.message}`
    });
    return { ok: false, error: e.message, created };
  }

  await logAdsChange({
    action: 'create_engagement_campaign', level: 'campaign', id: created.campaign_id,
    detail: `"${campaignName}" — ${goals.length} ad set(s), all PAUSED, ₹${dailyBudgetInr}/day each`
  });

  return { ok: true, ...created };
}

module.exports = {
  getAdsOverview,
  getAdAudiences,
  setAdsObjectStatus,
  updateAdsBudget,
  createEngagementFromPost,
  // exported for tests — pure, no network/Supabase
  inrToPaise,
  isFacebookPostId,
  sumActionValues,
  pickResult,
  summarizeInsights,
  buildTargeting,
  creativeParamsForPost,
  unknownPlacements,
  // exported for tests — needs a fake global.fetch
  graphGetAll,
  AD_ACCOUNT_ID,
  FB_PAGE_ID,
  IG_BUSINESS_ID
};
