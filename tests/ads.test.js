/**
 * ads.test.js — sanity checks for ads.js's pure logic, pagination, and the
 * safety properties every write function must hold (dry-by-default, PAUSED
 * always, one notification per successful write).
 *
 * Run with: node tests/ads.test.js
 *
 * Same scope discipline as publish-social.test.js: pure helpers get real
 * unit tests; anything that calls Graph fakes global.fetch (no real
 * network — no META_ACCESS_TOKEN/ad-account access in this environment).
 * logAdsChange()'s Supabase call is never faked — with no real
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set, getSupabase()'s requireEnv()
 * throws, which logAdsChange() catches internally and logs (by design, see
 * ads.js's SAFETY MODEL comment) — this is real, exercised behavior in
 * every test below that reaches a confirmed write, not a gap.
 */

'use strict';

const assert = require('assert');
const {
  getAdsOverview, getAdAudiences, setAdsObjectStatus, updateAdsBudget, createEngagementFromPost,
  inrToPaise, isFacebookPostId, sumActionValues, pickResult, summarizeInsights, buildTargeting,
  creativeParamsForPost, unknownPlacements, graphGetAll, AD_ACCOUNT_ID, FB_PAGE_ID
} = require('../ads');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
async function at(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

console.log('\ninrToPaise');
t('₹500 -> 50000 paise', () => assert.strictEqual(inrToPaise(500), 50000));
t('rounds fractional rupees', () => assert.strictEqual(inrToPaise(499.999), 50000));
t('handles a string input', () => assert.strictEqual(inrToPaise('750'), 75000));

console.log('\nisFacebookPostId');
t(`"${FB_PAGE_ID}_123" is a Facebook post id`, () => assert.strictEqual(isFacebookPostId(`${FB_PAGE_ID}_123`), true));
t('a bare numeric id is not', () => assert.strictEqual(isFacebookPostId('17958012345678901'), false));
t('null does not throw', () => assert.strictEqual(isFacebookPostId(null), false));

console.log('\ncreativeParamsForPost');
t('Facebook post id -> object_story_id', () => {
  const p = creativeParamsForPost(`${FB_PAGE_ID}_999`);
  assert.deepStrictEqual(p, { object_story_id: `${FB_PAGE_ID}_999` });
});
t('bare id -> Instagram media params', () => {
  const p = creativeParamsForPost('17958012345678901');
  assert.strictEqual(p.source_instagram_media_id, '17958012345678901');
  assert.ok(p.instagram_actor_id, 'includes instagram_actor_id');
});

console.log('\nsumActionValues / pickResult');
t('sums a list of action values', () => {
  assert.strictEqual(sumActionValues([{ value: '3' }, { value: '5' }]), 8);
});
t('empty/missing actions -> 0', () => {
  assert.strictEqual(sumActionValues(null), 0);
  assert.strictEqual(sumActionValues([]), 0);
});
t('OUTCOME_TRAFFIC -> link_click results + cost_per_result', () => {
  const r = pickResult('OUTCOME_TRAFFIC',
    [{ action_type: 'link_click', value: '40' }, { action_type: 'landing_page_view', value: '35' }],
    [{ action_type: 'link_click', value: '12.5' }], '500');
  assert.strictEqual(r.results, 40);
  assert.strictEqual(r.cost_per_result, 12.5);
  assert.strictEqual(r.result_type, 'link_click');
});
t('falls back to spend/results when cost_per_action_type is missing that action', () => {
  const r = pickResult('OUTCOME_LEADS', [{ action_type: 'lead', value: '10' }], [], '500');
  assert.strictEqual(r.results, 10);
  assert.strictEqual(r.cost_per_result, 50);
});
t('OUTCOME_AWARENESS has no result action type by design', () => {
  const r = pickResult('OUTCOME_AWARENESS', [{ action_type: 'link_click', value: '5' }], [], '100');
  assert.strictEqual(r.results, null);
  assert.strictEqual(r.result_type, null);
});
t('no matching action -> null results, not zero (never fabricates a number)', () => {
  const r = pickResult('OUTCOME_LEADS', [{ action_type: 'link_click', value: '5' }], [], '100');
  assert.strictEqual(r.results, null);
});

console.log('\nsummarizeInsights');
t('no insights row -> honest zeros/nulls, still carries the objective\'s result_type', () => {
  const s = summarizeInsights('OUTCOME_TRAFFIC', null);
  assert.strictEqual(s.spend, 0);
  assert.strictEqual(s.results, null);
  assert.strictEqual(s.result_type, 'link_click');
});
t('a real row: numbers coerced, thruplays summed, raw actions/cost_per_action_type preserved', () => {
  const s = summarizeInsights('OUTCOME_ENGAGEMENT', {
    spend: '123.45', impressions: '1000', reach: '800', ctr: '1.5', frequency: '1.25',
    video_thruplay_watched_actions: [{ value: '30' }],
    actions: [{ action_type: 'post_engagement', value: '55' }],
    cost_per_action_type: [{ action_type: 'post_engagement', value: '2.24' }]
  });
  assert.strictEqual(s.spend, 123.45);
  assert.strictEqual(s.thruplays, 30);
  assert.strictEqual(s.results, 55);
  assert.strictEqual(s.cost_per_result, 2.24);
  assert.strictEqual(s.actions.length, 1);
  assert.strictEqual(s.cost_per_action_type.length, 1);
});

console.log('\nunknownPlacements / buildTargeting');
t('"reels" is known, "stories" is not', () => {
  assert.deepStrictEqual(unknownPlacements(['reels', 'stories']), ['stories']);
  assert.deepStrictEqual(unknownPlacements(['reels']), []);
});
t('builds custom_audiences from audienceIds + a lookalike id, plus reels placement targeting', () => {
  const targeting = buildTargeting({ audienceIds: ['aud_1', 'aud_2'], lookalikeAudienceId: 'aud_lookalike', placements: ['reels'] });
  assert.deepStrictEqual(targeting.custom_audiences, [{ id: 'aud_1' }, { id: 'aud_2' }, { id: 'aud_lookalike' }]);
  assert.deepStrictEqual(targeting.geo_locations, { countries: ['IN'] });
  assert.deepStrictEqual(targeting.instagram_positions, ['reels']);
  assert.deepStrictEqual(targeting.facebook_positions, ['facebook_reels']);
});
t('no audiences at all -> custom_audiences omitted, not an empty array', () => {
  const targeting = buildTargeting({ audienceIds: [], lookalikeAudienceId: null, placements: [] });
  assert.strictEqual(targeting.custom_audiences, undefined);
});

async function main() {
  // Every real-call test below fakes global.fetch, so this value is never
  // actually sent anywhere — it only needs to be present so requireEnv()
  // doesn't throw before reaching the faked fetch.
  const realToken = process.env.META_ACCESS_TOKEN;
  process.env.META_ACCESS_TOKEN = 'test-token';

  console.log('\ngraphGetAll (fake paginated Graph response, no real network)');
  await at('follows paging.next and concatenates both pages', async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }], paging: { next: 'https://graph.facebook.com/v25.0/fake?after=xyz' } }) };
      }
      return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'c' }], paging: {} }) };
    };
    try {
      const rows = await graphGetAll('/fake', { fields: 'id' }, 'tok');
      assert.deepStrictEqual(rows.map(r => r.id), ['a', 'b', 'c']);
      assert.strictEqual(calls.length, 2, 'made exactly two requests, one per page');
      assert.strictEqual(calls[1], 'https://graph.facebook.com/v25.0/fake?after=xyz', 'second call used paging.next verbatim');
    } finally {
      global.fetch = realFetch;
    }
  });

  await at('surfaces a Graph API error with its real message and code', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } }) });
    try {
      await assert.rejects(() => graphGetAll('/fake', {}, 'tok'), /Invalid parameter \(code 100\)/);
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log('\nsetAdsObjectStatus — dry by default, one write when confirmed');
  await at('no confirm -> dry preview, zero fetch calls', async () => {
    const realFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; throw new Error('should not have been called'); };
    try {
      const r = await setAdsObjectStatus({ level: 'campaign', id: '123', status: 'PAUSED', confirm: false });
      assert.strictEqual(r.dry, true);
      assert.strictEqual(fetchCalled, false);
    } finally {
      global.fetch = realFetch;
    }
  });
  await at('an unknown level is rejected before anything else', async () => {
    const r = await setAdsObjectStatus({ level: 'account', id: '1', status: 'PAUSED', confirm: true });
    assert.strictEqual(r.ok, false);
  });
  await at('confirm=true -> exactly one POST to /<id> with {status}', async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, text: async () => JSON.stringify({ success: true }) };
    };
    try {
      const r = await setAdsObjectStatus({ level: 'adset', id: 'adset_1', status: 'ACTIVE', confirm: true });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(calls.length, 1);
      assert.ok(calls[0].url.includes('/adset_1'));
      assert.deepStrictEqual(calls[0].body, { status: 'ACTIVE' });
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log('\nupdateAdsBudget — rejects ad-level, converts INR to paise correctly');
  await at('level "ad" is rejected — ads do not carry a budget', async () => {
    const r = await updateAdsBudget({ level: 'ad', id: 'ad_1', dailyBudgetInr: 500, confirm: true });
    assert.strictEqual(r.ok, false);
  });
  await at('dry preview shows the correct paise conversion, zero fetch calls', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('should not have been called'); };
    try {
      const r = await updateAdsBudget({ level: 'campaign', id: 'c_1', dailyBudgetInr: 1234, confirm: false });
      assert.strictEqual(r.would.daily_budget_paise, 123400);
    } finally {
      global.fetch = realFetch;
    }
  });
  await at('confirmed budget update sends the converted paise value, not raw rupees', async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, text: async () => JSON.stringify({ success: true }) };
    };
    try {
      await updateAdsBudget({ level: 'adset', id: 'as_1', dailyBudgetInr: 800, confirm: true });
      assert.strictEqual(calls[0].daily_budget, 80000);
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log('\ncreateEngagementFromPost — validation, dry preview, PAUSED-always safety property');
  await at('unknown goal is rejected before anything else', async () => {
    const r = await createEngagementFromPost({
      campaignName: 'Test', postId: `${FB_PAGE_ID}_1`, audienceIds: [], lookalikeFromAudienceId: null,
      dailyBudgetInr: 500, placements: ['reels'], goals: ['not_a_real_goal'], confirm: true
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('not_a_real_goal'));
  });
  await at('unknown placement is rejected before anything else', async () => {
    const r = await createEngagementFromPost({
      campaignName: 'Test', postId: `${FB_PAGE_ID}_1`, audienceIds: [], lookalikeFromAudienceId: null,
      dailyBudgetInr: 500, placements: ['stories'], goals: ['thruplay'], confirm: true
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('stories'));
  });
  await at('dry preview: zero fetch calls, correct per-goal optimization_goal mapping', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('should not have been called'); };
    try {
      const r = await createEngagementFromPost({
        campaignName: 'Bali Reel Boost', postId: `${FB_PAGE_ID}_555`, audienceIds: ['aud_1'], lookalikeFromAudienceId: null,
        dailyBudgetInr: 1000, placements: ['reels'], goals: ['thruplay', 'profile_visits'], confirm: false
      });
      assert.strictEqual(r.dry, true);
      assert.strictEqual(r.would.status, 'PAUSED');
      assert.strictEqual(r.would.adsets.length, 2);
      assert.strictEqual(r.would.adsets[0].optimization_goal, 'THRUPLAY');
      assert.strictEqual(r.would.adsets[1].optimization_goal, 'PROFILE_VISIT');
      assert.strictEqual(r.would.creative_source, 'facebook_post');
    } finally {
      global.fetch = realFetch;
    }
  });

  await at('confirmed run with a Facebook post id: every created object is PAUSED, creative uses object_story_id', async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).includes('/adcreatives')) return { ok: true, text: async () => JSON.stringify({ id: 'creative_1' }) };
      if (String(url).includes('/adsets')) return { ok: true, text: async () => JSON.stringify({ id: `adset_${calls.length}` }) };
      if (String(url).includes('/ads')) return { ok: true, text: async () => JSON.stringify({ id: `ad_${calls.length}` }) };
      if (String(url).includes('/campaigns')) return { ok: true, text: async () => JSON.stringify({ id: 'campaign_1' }) };
      return { ok: true, text: async () => JSON.stringify({ id: 'unexpected' }) };
    };
    try {
      const r = await createEngagementFromPost({
        campaignName: 'Bali Reel Boost', postId: `${FB_PAGE_ID}_555`, audienceIds: ['aud_1'], lookalikeFromAudienceId: null,
        dailyBudgetInr: 1000, placements: ['reels'], goals: ['thruplay', 'profile_visits'], confirm: true
      });
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.campaign_id, 'campaign_1');
      assert.strictEqual(r.adsets.length, 2, 'one ad set per goal');

      const campaignCall = calls.find(c => c.url.includes('/campaigns') && !c.url.includes('/adcreatives'));
      assert.strictEqual(campaignCall.body.status, 'PAUSED');
      assert.deepStrictEqual(campaignCall.body.special_ad_categories, []);

      const creativeCall = calls.find(c => c.url.includes('/adcreatives'));
      assert.strictEqual(creativeCall.body.object_story_id, `${FB_PAGE_ID}_555`);
      assert.strictEqual(creativeCall.body.source_instagram_media_id, undefined);

      const adsetCalls = calls.filter(c => c.url.includes('/adsets'));
      assert.strictEqual(adsetCalls.length, 2);
      const adCalls = calls.filter(c => c.url.includes('/ads') && !c.url.includes('/adsets'));
      assert.strictEqual(adCalls.length, 2);

      // The critical safety assertion: nothing anywhere in this whole
      // create sequence is ever set to ACTIVE.
      for (const c of [campaignCall, ...adsetCalls, ...adCalls]) {
        assert.strictEqual(c.body.status, 'PAUSED', `${c.url} must be created PAUSED`);
      }
      const anyActive = calls.some(c => c.body && JSON.stringify(c.body).includes('ACTIVE'));
      assert.strictEqual(anyActive, false, 'no request body anywhere contains ACTIVE');
    } finally {
      global.fetch = realFetch;
    }
  });

  await at('confirmed run with a bare Instagram media id: creative uses source_instagram_media_id', async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).includes('/adcreatives')) return { ok: true, text: async () => JSON.stringify({ id: 'creative_2' }) };
      if (String(url).includes('/adsets')) return { ok: true, text: async () => JSON.stringify({ id: 'adset_ig' }) };
      if (String(url).includes('/ads')) return { ok: true, text: async () => JSON.stringify({ id: 'ad_ig' }) };
      if (String(url).includes('/campaigns')) return { ok: true, text: async () => JSON.stringify({ id: 'campaign_ig' }) };
      return { ok: true, text: async () => JSON.stringify({ id: 'unexpected' }) };
    };
    try {
      const r = await createEngagementFromPost({
        campaignName: 'IG Reel Boost', postId: '17958012345678901', audienceIds: [], lookalikeFromAudienceId: null,
        dailyBudgetInr: 500, placements: ['reels'], goals: ['thruplay'], confirm: true
      });
      assert.strictEqual(r.ok, true, r.error);
      const creativeCall = calls.find(c => c.url.includes('/adcreatives'));
      assert.strictEqual(creativeCall.body.source_instagram_media_id, '17958012345678901');
      assert.strictEqual(creativeCall.body.object_story_id, undefined);
      assert.ok(creativeCall.body.instagram_actor_id, 'includes instagram_actor_id alongside source_instagram_media_id');
    } finally {
      global.fetch = realFetch;
    }
  });

  await at('lookalike_from_audience_id creates a lookalike audience first and includes it in targeting', async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).includes('/customaudiences')) return { ok: true, text: async () => JSON.stringify({ id: 'lookalike_99' }) };
      if (String(url).includes('/adcreatives')) return { ok: true, text: async () => JSON.stringify({ id: 'creative_3' }) };
      if (String(url).includes('/adsets')) return { ok: true, text: async () => JSON.stringify({ id: 'adset_lal' }) };
      if (String(url).includes('/ads')) return { ok: true, text: async () => JSON.stringify({ id: 'ad_lal' }) };
      if (String(url).includes('/campaigns')) return { ok: true, text: async () => JSON.stringify({ id: 'campaign_lal' }) };
      return { ok: true, text: async () => JSON.stringify({ id: 'unexpected' }) };
    };
    try {
      const r = await createEngagementFromPost({
        campaignName: 'Lookalike Test', postId: `${FB_PAGE_ID}_1`, audienceIds: [], lookalikeFromAudienceId: 'aud_source',
        dailyBudgetInr: 500, placements: [], goals: ['thruplay'], confirm: true
      });
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.lookalike_audience_id, 'lookalike_99');
      const lookalikeCall = calls.find(c => c.url.includes('/customaudiences'));
      assert.strictEqual(lookalikeCall.body.origin_audience_id, 'aud_source');
      assert.strictEqual(lookalikeCall.body.subtype, 'LOOKALIKE');
      const adsetCall = calls.find(c => c.url.includes('/adsets'));
      assert.deepStrictEqual(adsetCall.body.targeting.custom_audiences, [{ id: 'lookalike_99' }]);
    } finally {
      global.fetch = realFetch;
    }
  });

  await at('a mid-sequence failure returns ok:false with whatever was created so far, not a silent crash', async () => {
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('/campaigns')) return { ok: true, text: async () => JSON.stringify({ id: 'campaign_fail' }) };
      if (String(url).includes('/adcreatives')) return { ok: true, text: async () => JSON.stringify({ id: 'creative_fail' }) };
      // adsets call fails
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Invalid targeting', code: 100 } }) };
    };
    try {
      const r = await createEngagementFromPost({
        campaignName: 'Will Fail', postId: `${FB_PAGE_ID}_1`, audienceIds: [], lookalikeFromAudienceId: null,
        dailyBudgetInr: 500, placements: [], goals: ['thruplay'], confirm: true
      });
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.includes('Invalid targeting'));
      assert.strictEqual(r.created.campaign_id, 'campaign_fail', 'reports the campaign that was actually created before the failure');
      assert.strictEqual(r.created.creative_id, 'creative_fail');
      assert.strictEqual(r.created.adsets.length, 0);
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log('\ngetAdsOverview / getAdAudiences — validation and structure joining');
  await at('since without until is rejected before any fetch call', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('should not have been called'); };
    try {
      const r = await getAdsOverview({ since: '2026-09-01', until: null });
      assert.strictEqual(r.ok, false);
    } finally {
      global.fetch = realFetch;
    }
  });

  await at('joins campaigns -> adsets -> ads with their insights rows correctly', async () => {
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      const page = (data) => ({ ok: true, text: async () => JSON.stringify({ data, paging: {} }) });
      if (u.includes('/campaigns')) return page([{ id: 'camp_1', name: 'Bali Awareness', objective: 'OUTCOME_TRAFFIC', status: 'ACTIVE', daily_budget: '100000' }]);
      if (u.includes('/adsets')) return page([{ id: 'as_1', name: 'AS1', status: 'ACTIVE', daily_budget: null, campaign_id: 'camp_1' }]);
      if (u.includes(`/${AD_ACCOUNT_ID}/ads`)) return page([{ id: 'ad_1', name: 'Ad1', status: 'ACTIVE', adset_id: 'as_1', campaign_id: 'camp_1' }]);
      if (u.includes('level=campaign')) return page([{ campaign_id: 'camp_1', spend: '500', impressions: '10000', reach: '8000', ctr: '2.1', frequency: '1.2', actions: [{ action_type: 'link_click', value: '20' }], cost_per_action_type: [{ action_type: 'link_click', value: '25' }] }]);
      if (u.includes('level=adset')) return page([]);
      if (u.includes('level=ad')) return page([]);
      return page([]);
    };
    try {
      const r = await getAdsOverview({ since: null, until: null });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.date_preset, 'last_7d');
      assert.strictEqual(r.campaigns.length, 1);
      const camp = r.campaigns[0];
      assert.strictEqual(camp.daily_budget_inr, 1000, 'daily_budget paise converted to INR');
      assert.strictEqual(camp.results, 20);
      assert.strictEqual(camp.cost_per_result, 25);
      assert.strictEqual(camp.adsets.length, 1);
      assert.strictEqual(camp.adsets[0].ads.length, 1);
      // adset/ad had no insights row in this fixture -> honest zeros, not crashes.
      assert.strictEqual(camp.adsets[0].spend, 0);
    } finally {
      global.fetch = realFetch;
    }
  });

  await at('audiences: exposes approximate_size as a lower/upper range', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({
      data: [{ id: 'aud_1', name: 'Warm — Bali interest', subtype: 'CUSTOM', approximate_count_lower_bound: '9000', approximate_count_upper_bound: '11000' }],
      paging: {}
    }) });
    try {
      const r = await getAdAudiences();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.audiences.length, 1);
      assert.deepStrictEqual(r.audiences[0].approximate_size, { lower_bound: 9000, upper_bound: 11000 });
    } finally {
      global.fetch = realFetch;
    }
  });

  if (realToken === undefined) delete process.env.META_ACCESS_TOKEN; else process.env.META_ACCESS_TOKEN = realToken;
  console.log(`\n${pass} passed`);
}

main().catch(e => { console.error('Test runner crashed:', e); process.exitCode = 1; });
