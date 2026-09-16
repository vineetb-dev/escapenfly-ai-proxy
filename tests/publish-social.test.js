/**
 * publish-social.test.js — sanity checks for publish-social.js's pure logic
 * Run with: node tests/publish-social.test.js   (no test framework needed)
 *
 * Covers only the exported pure functions (no network, no Supabase) — same
 * scope discipline as canton.test.js. The Supabase-reading/Meta/AiSensy-
 * calling functions (publishFbRow, teamDailyContent, fbSafetyCrosspost) were
 * verified separately: real local server start, real ?dry=1 requests against
 * production Supabase data (Norway reel b7ac9db1-…, today's Morocco reel),
 * auth gating (401 with no/wrong secret), and a real bug this exact process
 * caught — the first version of teamDailyContent() wrote a real
 * internal_notifications row even under ?dry=1 — found by checking the DB
 * after the dry-run curl call, not assumed safe. Fixed, re-verified 0 rows
 * written on a second dry run, then the original stray row deleted. None of
 * that is reproducible here without real META_ACCESS_TOKEN/AISENSY_KEY/a
 * live Render deploy, so it isn't pretended to be — see the PR description
 * for the exact commands run and their real output.
 */

'use strict';

const assert = require('assert');
const {
  isVideoUrl, hasFbId, appendFbId, trimCaption, planFbPublish,
  pickAiSensyTemplate, selectPrimaryContent, todayIST
} = require('../publish-social');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

console.log('\nisVideoUrl');
t('bare .mp4', () => assert.strictEqual(isVideoUrl('https://cdn.example.com/x.mp4'), true));
t('.mp4 with query string', () => assert.strictEqual(isVideoUrl('https://cdn.example.com/x.mp4?sig=abc'), true));
t('a jpg is not a video', () => assert.strictEqual(isVideoUrl('https://cdn.example.com/x.jpg'), false));
t('missing url', () => assert.strictEqual(isVideoUrl(null), false));
t('mp4 in the middle of a path segment is not a match', () =>
  assert.strictEqual(isVideoUrl('https://cdn.example.com/mp4files/x.mov'), false));

console.log('\nhasFbId / appendFbId');
t('no existing id -> false', () => assert.strictEqual(hasFbId(null), false));
t('an ig: id alone -> false', () => assert.strictEqual(hasFbId('ig:12345'), false));
t('ig: plus fb: -> true', () => assert.strictEqual(hasFbId('ig:12345;fb:67890'), true));
t('fb: as the only id -> true', () => assert.strictEqual(hasFbId('fb:67890'), true));
t('append to an existing ig: id keeps it', () =>
  assert.strictEqual(appendFbId('ig:12345', '67890'), 'ig:12345;fb:67890'));
t('append with no existing id', () => assert.strictEqual(appendFbId('', '67890'), 'fb:67890'));
t('append trims a stray trailing semicolon', () =>
  assert.strictEqual(appendFbId('ig:12345;', '67890'), 'ig:12345;fb:67890'));

console.log('\ntrimCaption');
t('short text is untouched', () => assert.strictEqual(trimCaption('hello', 900), 'hello'));
t('long text is cut to the limit with an ellipsis', () => {
  const r = trimCaption('a'.repeat(1000), 900);
  assert.strictEqual(r.length, 900);
  assert.strictEqual(r.endsWith('…'), true);
});
t('empty/undefined caption does not throw', () => assert.strictEqual(trimCaption(undefined, 900), ''));

console.log('\nplanFbPublish');
t('an mp4 asset plans a reel', () => {
  const p = planFbPublish({ asset_url: 'https://x/y.mp4', type: 'video' });
  assert.strictEqual(p.mode, 'reel');
  assert.strictEqual(p.videoUrl, 'https://x/y.mp4');
});
t('a carousel asset with image_urls plans a carousel', () => {
  const p = planFbPublish({ asset_url: 'https://x/y.jpg', type: 'carousel' },
    { imageUrls: ['a.jpg', 'b.jpg'] });
  assert.strictEqual(p.mode, 'carousel');
  assert.deepStrictEqual(p.imageUrls, ['a.jpg', 'b.jpg']);
});
t('a carousel asset with no image_urls errors instead of guessing', () => {
  const p = planFbPublish({ asset_url: 'https://x/y.jpg', type: 'carousel' }, {});
  assert.strictEqual(p.mode, 'error');
});
t('a plain image asset with allow_text plans text', () => {
  const p = planFbPublish({ asset_url: 'https://x/y.jpg', type: 'image' }, { allowText: true });
  assert.strictEqual(p.mode, 'text');
});
t('a plain image asset without allow_text refuses rather than silently posting', () => {
  const p = planFbPublish({ asset_url: 'https://x/y.jpg', type: 'image' }, {});
  assert.strictEqual(p.mode, 'error');
});

console.log('\npickAiSensyTemplate');
t('video -> the video variant', () => assert.strictEqual(pickAiSensyTemplate(true), 'team_daily_content_video'));
t('not video -> the image variant', () => assert.strictEqual(pickAiSensyTemplate(false), 'team_daily_content_image'));

console.log('\nselectPrimaryContent');
t('prefers a reel over a status set, even with status images available', () => {
  const rows = [
    { row: { channel: 'whatsapp' }, asset: { asset_url: null } },
    { row: { channel: 'ig_fb_reel' }, asset: { asset_url: 'https://x/reel.mp4' } }
  ];
  const p = selectPrimaryContent(rows, ['https://x/status1.jpg']);
  assert.strictEqual(p.row.channel, 'ig_fb_reel');
  assert.strictEqual(p.isVideo, true);
});
t('falls back to a whatsapp status set only when status_image_urls was actually passed', () => {
  const rows = [{ row: { channel: 'whatsapp' }, asset: { asset_url: null } }];
  assert.strictEqual(selectPrimaryContent(rows, null), null);
  const p = selectPrimaryContent(rows, ['https://x/status1.jpg']);
  assert.strictEqual(p.mediaUrl, 'https://x/status1.jpg');
});
t('no eligible rows and no status images -> null, never fabricates a send', () => {
  assert.strictEqual(selectPrimaryContent([], null), null);
});

console.log('\ntodayIST');
t('returns a YYYY-MM-DD string', () => assert.match(todayIST(), /^\d{4}-\d{2}-\d{2}$/));

console.log(`\n${pass} passed`);
