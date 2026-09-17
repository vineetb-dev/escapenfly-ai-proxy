/**
 * publish-social.test.js — sanity checks for publish-social.js's pure logic
 * Run with: node tests/publish-social.test.js   (no test framework needed)
 *
 * Mostly covers the exported pure functions (no network, no Supabase) — same
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
 *
 * The one exception to "no network": publishReel() below, added after a
 * real run (real token, real Egypt carousel succeeding via the same token —
 * scopes were never the problem) hit a real Graph API error the pure-logic
 * tests couldn't have caught, since request-body construction across a
 * 3-phase sequence isn't pure-function-testable. That test fakes global.fetch
 * for exactly the three calls this one function makes, then restores it —
 * still no real network, but no longer "pure functions only" either.
 */

'use strict';

const assert = require('assert');
const {
  isVideoUrl, hasFbId, extractIgMediaId, appendFbId, trimCaption, planFbPublish,
  pickAiSensyTemplate, selectPrimaryContent, todayIST, publishReel, pollReelStatus
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

console.log('\nextractIgMediaId');
t('pulls the id out of a bare ig: entry', () => assert.strictEqual(extractIgMediaId('ig:18120496165921301'), '18120496165921301'));
t('pulls the id out when an fb: id already follows', () =>
  assert.strictEqual(extractIgMediaId('ig:18120496165921301;fb:67890'), '18120496165921301'));
t('no ig: entry -> null', () => assert.strictEqual(extractIgMediaId('fb:67890'), null));
t('missing platform_post_id -> null', () => assert.strictEqual(extractIgMediaId(null), null));

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

console.log('\npublishReel (fake 3-phase Graph sequence — start/rupload/finish, no real network)');
async function testPublishReel() {
  const FAKE_VIDEO_ID = 'vid_fake_123';
  const FAKE_UPLOAD_URL = 'https://rupload.facebook.com/video-upload/v25.0/vid_fake_123';
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, opts });
    if (urlStr.includes('rupload.facebook.com')) {
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (urlStr.includes('/video_reels')) {
      const body = JSON.parse(opts.body);
      if (body.upload_phase === 'start') {
        return { ok: true, json: async () => ({ video_id: FAKE_VIDEO_ID, upload_url: FAKE_UPLOAD_URL }) };
      }
      return { ok: true, json: async () => ({ success: true }) }; // finish
    }
    return { ok: true, json: async () => ({ status: { video_status: 'ready' } }) }; // status poll
  };
  try {
    const result = await publishReel({
      pageId: 'PAGE1', pageToken: 'TOKEN1', videoUrl: 'https://cdn.example.com/x.mp4', description: 'a caption'
    });

    const finishCall = calls.find(c => c.url.includes('/video_reels') && JSON.parse(c.opts.body).upload_phase === 'finish');
    assert.ok(finishCall, 'a finish-phase video_reels call was made');
    const finishBody = JSON.parse(finishCall.opts.body);
    assert.strictEqual(finishBody.video_id, FAKE_VIDEO_ID, 'finish call must carry the video_id from the start-phase response — this was the actual bug (Graph API #100 "Missing parameter: video_id")');
    assert.strictEqual(finishBody.video_state, 'PUBLISHED');
    assert.strictEqual(finishBody.description, 'a caption');

    const uploadCall = calls.find(c => c.url.includes('rupload.facebook.com'));
    assert.ok(uploadCall, 'the file was uploaded via rupload.facebook.com');
    assert.strictEqual(uploadCall.url, FAKE_UPLOAD_URL, 'must upload to the upload_url the start phase returned, not a hand-built guess');
    assert.strictEqual(uploadCall.opts.headers['file_url'], 'https://cdn.example.com/x.mp4');

    assert.strictEqual(result.videoId, FAKE_VIDEO_ID);
    assert.strictEqual(calls.some(c => !c.url.includes('rupload.facebook.com') && !c.url.includes('/video_reels')), false,
      'publishReel resolves as soon as finish succeeds — it must not itself poll the status endpoint (see pollReelStatus)');

    pass++;
    console.log('  ok   finish call carries video_id; upload uses the start phase\'s upload_url; no status poll from within publishReel');
  } catch (e) {
    console.error('  FAIL publishReel fake 3-phase sequence\n       ' + e.message);
    process.exitCode = 1;
  } finally {
    global.fetch = realFetch;
  }
}

console.log('\npollReelStatus (best-effort — must never throw, even on a Graph API error)');
async function testPollReelStatusError() {
  // Real bug this reproduces: a Morocco reel had start/upload/finish all
  // succeed (video_id 3608214656001289), but the immediate status GET came
  // back with Graph error #100 "Unsupported get request". Before the fix,
  // that exception unwound out of the combined publishReel() and was caught
  // by publishFbRow's try/catch as a total failure — even though the reel
  // was already live and platform_post_id was never written.
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ error: { message: 'Unsupported get request.', code: 100 } })
  });
  try {
    const result = await pollReelStatus({ videoId: 'vid_fake_123', pageToken: 'TOKEN1' });
    assert.strictEqual(result.status, 'unknown', 'a poll error leaves status as "unknown" rather than throwing');
    assert.strictEqual(result.permalinkUrl, null);
    pass++;
    console.log('  ok   a Graph API error on the status poll is swallowed, not thrown');
  } catch (e) {
    console.error('  FAIL pollReelStatus swallows a Graph API error\n       ' + e.message);
    process.exitCode = 1;
  } finally {
    global.fetch = realFetch;
  }
}

console.log('\nfinish-success-then-poll-error (the exact sequence publishFbRow now runs for a reel)');
async function testFinishSuccessThenPollError() {
  const FAKE_VIDEO_ID = 'vid_fake_456';
  const FAKE_UPLOAD_URL = 'https://rupload.facebook.com/video-upload/v25.0/vid_fake_456';
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr.includes('rupload.facebook.com')) return { ok: true, json: async () => ({ success: true }) };
    if (urlStr.includes('/video_reels')) {
      const body = JSON.parse(opts.body);
      if (body.upload_phase === 'start') {
        return { ok: true, json: async () => ({ video_id: FAKE_VIDEO_ID, upload_url: FAKE_UPLOAD_URL }) };
      }
      return { ok: true, json: async () => ({ success: true }) }; // finish
    }
    // the status-poll GET — the leg that fails in the real Morocco incident
    return { ok: true, json: async () => ({ error: { message: 'Unsupported get request.', code: 100 } }) };
  };
  try {
    // Mirrors publishFbRow's reel branch: publishReel() (finish) must
    // resolve successfully on its own — a caller can (and now does) record
    // the fb: id right here, before ever calling pollReelStatus.
    const { videoId } = await publishReel({
      pageId: 'PAGE1', pageToken: 'TOKEN1', videoUrl: 'https://cdn.example.com/x.mp4', description: 'a caption'
    });
    assert.strictEqual(videoId, FAKE_VIDEO_ID, 'finish succeeding hands back a real video id, independent of the poll');

    // The subsequent poll fails, but must not throw and must not retract
    // the success above in any way.
    const { status } = await pollReelStatus({ videoId, pageToken: 'TOKEN1' });
    assert.strictEqual(status, 'unknown');

    pass++;
    console.log('  ok   finish success (real video id) survives a subsequent poll failure with no exception');
  } catch (e) {
    console.error('  FAIL finish-success-then-poll-error\n       ' + e.message);
    process.exitCode = 1;
  } finally {
    global.fetch = realFetch;
  }
}

testPublishReel()
  .then(testPollReelStatusError)
  .then(testFinishSuccessThenPollError)
  .then(() => console.log(`\n${pass} passed`));
