/**
 * google-sync.js
 * Pulls Google Ads spend and GA4 site traffic directly from Google's official
 * APIs — replaces the Windsor.ai "google_ads" and "googleanalytics4" connectors.
 *
 * REQUIRED ENV VARS (set in Render):
 *   GOOGLE_ADS_DEVELOPER_TOKEN   - from Google Ads API Center
 *   GOOGLE_ADS_CLIENT_ID          - OAuth client ID (Google Cloud Console)
 *   GOOGLE_ADS_CLIENT_SECRET      - OAuth client secret
 *   GOOGLE_ADS_REFRESH_TOKEN      - obtained once via OAuth consent flow
 *   GOOGLE_ADS_CUSTOMER_ID        - Escapenfly's Ads account ID, digits only
 *   GA4_PROPERTY_ID               - "508356004"
 *   GA4_SERVICE_ACCOUNT_JSON      - full JSON key of a service account with
 *                                    Viewer access on the GA4 property
 */

const { createClient } = require('@supabase/supabase-js');
const { GoogleAuth } = require('google-auth-library');

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

/** GA4 sessions/users/conversions for yesterday via the GA4 Data API (free) */
async function fetchGA4Yesterday() {
  const propertyId = requireEnv('GA4_PROPERTY_ID');
  const serviceAccountJson = JSON.parse(requireEnv('GA4_SERVICE_ACCOUNT_JSON'));

  const auth = new GoogleAuth({
    credentials: serviceAccountJson,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'conversions' },
          { name: 'engagementRate' },
        ],
      }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(`GA4 API error: ${data.error.message}`);

  const row = data.rows?.[0]?.metricValues;
  if (!row) return { sessions: 0, users: 0, conversions: 0, engagementRate: 0 };

  return {
    sessions: parseInt(row[0]?.value || 0, 10),
    users: parseInt(row[1]?.value || 0, 10),
    conversions: parseFloat(row[2]?.value || 0),
    engagementRate: parseFloat(row[3]?.value || 0),
  };
}

/**
 * Google Ads spend/clicks/impressions for yesterday via Google Ads API
 * (GAQL query, official REST interface).
 */
async function fetchGoogleAdsYesterday() {
  const customerId = requireEnv('GOOGLE_ADS_CUSTOMER_ID');
  const developerToken = requireEnv('GOOGLE_ADS_DEVELOPER_TOKEN');
  const clientId = requireEnv('GOOGLE_ADS_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_ADS_CLIENT_SECRET');
  const refreshToken = requireEnv('GOOGLE_ADS_REFRESH_TOKEN');

  // Exchange refresh token for a fresh access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(`Google OAuth refresh failed: ${tokenData.error_description}`);

  const query = `
    SELECT campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions
    FROM campaign
    WHERE segments.date DURING YESTERDAY
  `;

  const res = await fetch(
    `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:searchStream`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'developer-token': developerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(`Google Ads API error: ${JSON.stringify(data.error)}`);

  const rows = [];
  for (const batch of data) {
    for (const r of batch.results || []) {
      rows.push({
        campaign_name: r.campaign.name,
        spend: (parseInt(r.metrics.costMicros || 0, 10)) / 1_000_000,
        clicks: parseInt(r.metrics.clicks || 0, 10),
        impressions: parseInt(r.metrics.impressions || 0, 10),
      });
    }
  }
  return rows;
}

async function runSync() {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const summary = { date: today, errors: [] };

  try {
    const ga4 = await fetchGA4Yesterday();
    const { error } = await supabase.from('marketing_performance').upsert({
      id: `ga4_${today}`,
      campaign_code: 'WEBSITE_TRAFFIC',
      platform: 'GA4',
      reach: ga4.users,
      engagement: ga4.sessions,
      spend: null,
      followers_gained: null,
      source: 'google_ga4_api',
      snapshot_date: today,
    }, { onConflict: 'id' });
    if (error) throw error;
    summary.ga4 = ga4;
  } catch (e) {
    summary.errors.push(`ga4: ${e.message}`);
  }

  try {
    const ads = await fetchGoogleAdsYesterday();
    const adsRows = ads.map((a, i) => ({
      id: `gads_${today}_${i}`,
      campaign_code: a.campaign_name || 'UNKNOWN_CAMPAIGN',
      platform: 'Google Ads',
      reach: a.impressions,
      engagement: a.clicks,
      spend: a.spend,
      followers_gained: null,
      source: 'google_ads_api',
      snapshot_date: today,
    }));
    if (adsRows.length) {
      const { error } = await supabase.from('marketing_performance').upsert(adsRows, { onConflict: 'id' });
      if (error) throw error;
    }
    summary.ads = adsRows.length;
  } catch (e) {
    summary.errors.push(`google_ads: ${e.message}`);
  }

  return summary;
}

module.exports = { runSync, fetchGA4Yesterday, fetchGoogleAdsYesterday };

if (require.main === module) {
  runSync()
    .then(summary => {
      console.log('Google sync complete:', JSON.stringify(summary, null, 2));
      process.exit(summary.errors.length ? 1 : 0);
    })
    .catch(err => {
      console.error('Google sync failed:', err);
      process.exit(1);
    });
}
