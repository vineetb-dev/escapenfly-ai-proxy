/**
 * publish-social.js
 * Two things Windsor.ai cannot do, run on Render where META_ACCESS_TOKEN and
 * AISENSY_KEY already live:
 *   - Facebook Page VIDEO (reels) / carousel / text cross-posting of a
 *     marketing_publishes row — Windsor has text/photo only for Pages, and
 *     Instagram's in-app "share to Facebook" toggle doesn't apply to
 *     API-published media.
 *   - The daily "share this yourself" AiSensy WhatsApp send to the team.
 *
 * Self-contained like meta-sync.js/google-sync.js: own Supabase client, own
 * GRAPH_VERSION pin (see that file's comment on why this isn't shared via
 * import — each integration file pins its own, checked at bump time, kept
 * in step with server.js's META_GRAPH_VERSION by hand).
 *
 * REQUIRED ENV VARS:
 *   META_ACCESS_TOKEN          - same system-user token server.js/meta-sync.js use,
 *                                 already granted admin on the Page below
 *   AISENSY_KEY                - already set (server.js's sendWA/sendSessionMessage use it)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - already set (shared with meta-sync.js)
 *   PUBLISH_MAX_PER_RUN        - optional, defaults to 20 (caps the safety-cron batch)
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
// writeup on the v18.0/v21.0 incident). v25.0 is current as of Feb 2026,
// v24.0 the oldest still supported — used for BOTH graph.facebook.com and
// rupload.facebook.com below, deliberately not a separately-pinned literal.
const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const FB_PAGE_ID = '128897537530800';

const PUBLISH_MAX_PER_RUN = parseInt(process.env.PUBLISH_MAX_PER_RUN || '20', 10);

const AISENSY_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

// ── PURE HELPERS (exported for tests — no network, no Supabase) ──

function isVideoUrl(url) {
  return /\.mp4($|\?)/i.test(url || '');
}

function hasFbId(platformPostId) {
  return /(^|;)fb:/.test(platformPostId || '');
}

function extractIgMediaId(platformPostId) {
  const m = /(^|;)ig:([^;]+)/.exec(platformPostId || '');
  return m ? m[2] : null;
}

function appendFbId(existingId, fbId) {
  const trimmed = (existingId || '').trim().replace(/;+$/, '');
  return trimmed ? `${trimmed};fb:${fbId}` : `fb:${fbId}`;
}

function trimCaption(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function planFbPublish(asset, { allowText, imageUrls } = {}) {
  const caption = null; // caller fills in the real caption; this only decides the MODE
  if (isVideoUrl(asset.asset_url)) return { mode: 'reel', videoUrl: asset.asset_url };
  if (asset.type === 'carousel') {
    if (!imageUrls || !imageUrls.length) return { mode: 'error', error: 'image_urls required in body for a carousel asset' };
    return { mode: 'carousel', imageUrls };
  }
  if (allowText) return { mode: 'text' };
  return { mode: 'error', error: 'asset is not a reel or carousel, and allow_text was not set' };
}

// team_daily_content has two approved variants, one per header media type —
// there is no text-only variant, so a day with no available media has
// nothing it can send (see teamDailyContent()'s selectPrimaryContent below).
function pickAiSensyTemplate(isVideo) {
  return isVideo ? 'team_daily_content_video' : 'team_daily_content_image';
}

// Prefers content that always carries its own media (a reel's asset_url is
// never optional) over the WhatsApp status-set row, whose media depends on
// the caller having passed status_image_urls this run. That keeps a day's
// send from depending on an optional body field whenever a reel exists.
function selectPrimaryContent(eligibleRows, statusImageUrls) {
  const reel = eligibleRows.find(e => e.row.channel === 'ig_fb_reel' && e.asset.asset_url);
  if (reel) return { row: reel.row, asset: reel.asset, mediaUrl: reel.asset.asset_url, isVideo: true };

  const carousel = eligibleRows.find(e => e.row.channel === 'ig_carousel' && e.asset.asset_url);
  if (carousel) return { row: carousel.row, asset: carousel.asset, mediaUrl: carousel.asset.asset_url, isVideo: isVideoUrl(carousel.asset.asset_url) };

  const firstStatusImage = statusImageUrls && statusImageUrls.length ? statusImageUrls[0] : null;
  const waRow = eligibleRows.find(e => e.row.channel === 'whatsapp');
  if (waRow && firstStatusImage) return { row: waRow.row, asset: waRow.asset, mediaUrl: firstStatusImage, isVideo: false };

  return null;
}

// ── FACEBOOK GRAPH API ──

async function graphGet(path, params, token) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', token);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`Graph API error [${path}]: ${data.error.message} (code ${data.error.code})`);
  return data;
}

async function graphPost(path, body, token) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', token);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json();
  if (data.error) throw new Error(`Graph API error [POST ${path}]: ${data.error.message} (code ${data.error.code})`);
  return data;
}

// Exchange the system-user token for the Page's own token — same flow
// meta-sync.js's getPageAccessToken() uses for this same Page, reimplemented
// locally rather than imported (see the file header comment on why these
// integration files don't cross-import).
async function getPageAccessToken(pageId, systemUserToken) {
  const data = await graphGet(`/${pageId}`, { fields: 'access_token' }, systemUserToken);
  if (!data.access_token) throw new Error('Could not obtain Page Access Token — check the system user has admin access on the Page');
  return data.access_token;
}

async function publishReel({ pageId, pageToken, videoUrl, description }) {
  const start = await graphPost(`/${pageId}/video_reels`, { upload_phase: 'start' }, pageToken);
  const videoId = start.video_id;
  if (!videoId) throw new Error('video_reels start did not return a video_id');

  // Meta's own docs say the start-phase response carries upload_url — prefer
  // it over hand-building the rupload URL (same GRAPH_VERSION either way
  // today, but the returned URL is the one actually guaranteed to work).
  const uploadUrl = start.upload_url || `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}/${videoId}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Authorization': `OAuth ${pageToken}`, 'file_url': videoUrl }
  });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || uploadData.success === false) {
    throw new Error(`rupload failed: ${uploadRes.status} ${JSON.stringify(uploadData).slice(0, 200)}`);
  }

  // video_id is required here too — omitting it fails with "(#100) Missing
  // parameter: video_id" (found on the first real run with a working token;
  // start/upload had already succeeded, so this was the only untested leg).
  const finish = await graphPost(`/${pageId}/video_reels`, {
    video_id: videoId,
    upload_phase: 'finish',
    video_state: 'PUBLISHED',
    description
  }, pageToken);
  if (finish.success === false) throw new Error('video_reels finish reported failure');

  const deadline = Date.now() + 60000;
  let status = 'unknown';
  while (Date.now() < deadline) {
    const s = await graphGet(`/${videoId}`, { fields: 'status' }, pageToken);
    status = (s.status && s.status.video_status) || status;
    if (status === 'ready') break;
    if (status === 'error') throw new Error(`Reel processing failed: ${JSON.stringify(s.status)}`);
    await sleep(3000);
  }
  return { videoId, status };
}

async function publishCarousel({ pageId, pageToken, imageUrls, message }) {
  const mediaIds = [];
  for (const url of imageUrls) {
    const photo = await graphPost(`/${pageId}/photos`, { url, published: false }, pageToken);
    if (!photo.id) throw new Error(`unpublished photo upload failed for ${url}`);
    mediaIds.push(photo.id);
  }
  const feed = await graphPost(`/${pageId}/feed`, {
    message,
    attached_media: mediaIds.map(id => ({ media_fbid: id }))
  }, pageToken);
  if (!feed.id) throw new Error('feed post with attached_media did not return an id');
  return feed.id;
}

async function publishText({ pageId, pageToken, message }) {
  const feed = await graphPost(`/${pageId}/feed`, { message }, pageToken);
  if (!feed.id) throw new Error('text feed post did not return an id');
  return feed.id;
}

// ── SUPABASE READS/WRITES ──

async function fetchPublishRow(sb, publishId) {
  const { data } = await sb.from('marketing_publishes').select('*').eq('id', publishId).eq('is_deleted', false).single();
  return data || null;
}
async function fetchAsset(sb, assetId) {
  const { data } = await sb.from('marketing_assets').select('*').eq('id', assetId).eq('is_deleted', false).single();
  return data || null;
}
async function writeNotification(sb, { type, summary }) {
  const { error } = await sb.from('internal_notifications').insert({ notification_type: type, summary });
  if (error) console.error(`publish-social writeNotification [${type}] failed:`, error.message);
}

// ── 1. POST /internal/publish-fb?publish_id=... ──

async function publishFbRow({ publishId, dry, allowText, imageUrls }) {
  if (!publishId) return { ok: false, error: 'publish_id is required' };

  const sb = getSupabase();
  const row = await fetchPublishRow(sb, publishId);
  if (!row) return { ok: false, error: 'marketing_publishes row not found' };
  const asset = await fetchAsset(sb, row.asset_id);
  if (!asset) return { ok: false, error: 'asset not found' };

  if (asset.status !== 'approved' || asset.production_status !== 'ready') {
    return { ok: false, error: 'asset is not approved+ready' };
  }
  if (hasFbId(row.platform_post_id)) {
    return { ok: true, skipped: true, reason: 'already has an fb: id', platform_post_id: row.platform_post_id };
  }

  const caption = [row.caption, row.hashtags].filter(Boolean).join('\n\n');

  // Every carousel is posted to Instagram before Facebook, so when the
  // caller didn't pass image_urls, derive them from the row's own ig: id
  // instead of requiring a manual export every time. Read-only Graph call,
  // so it runs under dry too — that's the point of testing with ?dry=1
  // before a real run: it shows the derived URLs without ever writing.
  let derivedImageUrls = null;
  if (asset.type === 'carousel' && (!imageUrls || !imageUrls.length)) {
    const igMediaId = extractIgMediaId(row.platform_post_id);
    if (igMediaId) {
      try {
        const children = await graphGet(`/${igMediaId}/children`, { fields: 'media_url' }, requireEnv('META_ACCESS_TOKEN'));
        derivedImageUrls = (children.data || []).map(d => d.media_url).filter(Boolean);
      } catch (e) {
        if (!dry) {
          await sb.from('marketing_publishes').update({
            error_text: String(e.message).slice(0, 500), updated_at: new Date().toISOString()
          }).eq('id', publishId);
        }
        return { ok: false, error: `ig children lookup failed: ${e.message}` };
      }
    }
  }
  const effectiveImageUrls = (imageUrls && imageUrls.length) ? imageUrls : derivedImageUrls;

  const plan = planFbPublish(asset, { allowText, imageUrls: effectiveImageUrls });
  if (plan.mode === 'error') return { ok: false, error: plan.error, derived_image_urls: derivedImageUrls || undefined };

  if (dry) return { ok: true, dry: true, mode: plan.mode, plan, derived_image_urls: derivedImageUrls || undefined };

  const pageToken = await getPageAccessToken(FB_PAGE_ID, requireEnv('META_ACCESS_TOKEN'));
  try {
    let fbId;
    if (plan.mode === 'reel') {
      const r = await publishReel({ pageId: FB_PAGE_ID, pageToken, videoUrl: plan.videoUrl, description: caption });
      fbId = r.videoId;
    } else if (plan.mode === 'carousel') {
      fbId = await publishCarousel({ pageId: FB_PAGE_ID, pageToken, imageUrls: plan.imageUrls, message: caption });
    } else {
      fbId = await publishText({ pageId: FB_PAGE_ID, pageToken, message: caption });
    }
    const newPlatformPostId = appendFbId(row.platform_post_id, fbId);
    await sb.from('marketing_publishes').update({
      platform_post_id: newPlatformPostId, updated_at: new Date().toISOString()
    }).eq('id', publishId);
    return { ok: true, mode: plan.mode, fb_id: fbId, platform_post_id: newPlatformPostId };
  } catch (e) {
    await sb.from('marketing_publishes').update({
      error_text: String(e.message).slice(0, 500), updated_at: new Date().toISOString()
    }).eq('id', publishId);
    return { ok: false, error: e.message };
  }
}

// ── 09:30 IST safety cron — cross-posts any row of the day with an ig: id
//    and no fb: id yet. The everyday path is Cowork calling publishFbRow()
//    per row right after it posts; this only catches ones that fell through.

async function fbSafetyCrosspost({ dry }) {
  const sb = getSupabase();
  const date = todayIST();
  const { data: rows, error } = await sb
    .from('marketing_publishes')
    .select('id, platform_post_id, scheduled_for')
    .eq('is_deleted', false)
    .gte('scheduled_for', `${date}T00:00:00+05:30`)
    .lt('scheduled_for', `${date}T23:59:59.999+05:30`)
    .like('platform_post_id', '%ig:%');
  if (error) throw new Error(error.message);

  const eligible = (rows || []).filter(r => !hasFbId(r.platform_post_id)).slice(0, PUBLISH_MAX_PER_RUN);
  const results = [];
  for (const row of eligible) {
    const r = await publishFbRow({ publishId: row.id, dry, allowText: false, imageUrls: null });
    results.push({ id: row.id, ...r });
  }
  return { date, checked: (rows || []).length, attempted: eligible.length, results };
}

// ── 2. POST /internal/team-daily-content?date=YYYY-MM-DD ──

async function sendAiSensyMediaTemplate({ phone, userName, templateName, params, media }) {
  if (!process.env.AISENSY_KEY) {
    console.error('sendAiSensyMediaTemplate skipped: AISENSY_KEY not set');
    return { ok: false, error: 'AISENSY_KEY not set' };
  }
  const body = {
    apiKey: process.env.AISENSY_KEY,
    campaignName: templateName,
    destination: phone,
    userName: userName || 'Team',
    templateParams: params,
    media
  };
  const res = await fetch(AISENSY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (res.ok) return { ok: true };
  console.error(`❌ sendAiSensyMediaTemplate '${templateName}' → ${phone} FAILED (${res.status}):`, text.slice(0, 200));
  return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
}

async function teamDailyContent({ date, to, dry, statusImageUrls }) {
  const sb = getSupabase();
  const targetDate = date || todayIST();
  const CHANNELS = ['ig_fb_reel', 'ig_carousel', 'whatsapp'];

  const { data: pubs, error: pubErr } = await sb
    .from('marketing_publishes')
    .select('*')
    .eq('is_deleted', false)
    .in('channel', CHANNELS)
    .gte('scheduled_for', `${targetDate}T00:00:00+05:30`)
    .lt('scheduled_for', `${targetDate}T23:59:59.999+05:30`);
  if (pubErr) throw new Error(pubErr.message);

  const eligibleRows = [];
  for (const row of (pubs || [])) {
    const asset = await fetchAsset(sb, row.asset_id);
    if (asset && asset.status === 'approved' && asset.production_status === 'ready') {
      eligibleRows.push({ row, asset });
    }
  }

  const primary = selectPrimaryContent(eligibleRows, statusImageUrls);
  if (!primary) return { sent: 0, failed: [], reason: 'no eligible content with available media for this date' };

  const title = primary.asset.title || "Today's post";
  const caption = trimCaption(primary.row.caption || primary.asset.content || '', 900);
  const template = pickAiSensyTemplate(primary.isVideo);
  const mediaFilename = primary.isVideo ? 'reel.mp4' : 'content.jpg';

  let recipients;
  if (to) {
    recipients = [{ phone: String(to), name: 'Team' }];
  } else {
    const { data: team, error: teamErr } = await sb
      .from('team_members').select('name, phone').eq('is_active', true).not('phone', 'is', null);
    if (teamErr) throw new Error(teamErr.message);
    recipients = (team || []).filter(t => t.phone);
  }

  let sent = 0;
  const failed = [];
  for (const r of recipients) {
    if (dry) { sent++; continue; }
    const result = await sendAiSensyMediaTemplate({
      phone: r.phone,
      userName: r.name,
      templateName: template,
      params: [title, caption, primary.mediaUrl],
      media: { url: primary.mediaUrl, filename: mediaFilename }
    });
    if (result.ok) sent++; else failed.push({ phone: r.phone, error: result.error });
  }

  if (!dry) {
    await writeNotification(sb, {
      type: 'team_content',
      summary: `Today's content sent to ${sent} team member${sent === 1 ? '' : 's'}${failed.length ? `, ${failed.length} failed` : ''} — "${title}"`
    });
  }

  return { sent, failed, date: targetDate, template, title, dry: !!dry };
}

module.exports = {
  // routes call these
  publishFbRow,
  fbSafetyCrosspost,
  teamDailyContent,
  // exported for tests — publishReel needs a fake 3-phase Graph sequence
  // (global.fetch mocked), not the "pure, no network" discipline the rest
  // of this list follows
  publishReel,
  // exported for tests — pure, no network/Supabase
  isVideoUrl,
  hasFbId,
  extractIgMediaId,
  appendFbId,
  trimCaption,
  planFbPublish,
  pickAiSensyTemplate,
  selectPrimaryContent,
  todayIST,
  PUBLISH_MAX_PER_RUN
};
