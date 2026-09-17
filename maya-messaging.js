/**
 * maya-messaging.js
 * Maya on Facebook Messenger + Instagram DMs — wired into server.js's
 * /webhook/meta like publish-social.js is wired into its own routes.
 *
 * Reuses server.js's CHAT_CORE/CHANNEL_ADAPTERS/mayaTurn() unmodified (the
 * 'messenger'/'instagram' CHANNEL_ADAPTERS entries and the small mayaTurn
 * fixes this feature needed — source/name-placeholder ternaries, the
 * graduation gate, a new `medium` field — live in server.js itself, next to
 * the website adapter they mirror; that logic can't be forked out of the
 * shared brain). This file owns everything Messenger/Instagram-specific:
 * webhook payload parsing, dedupe/echo handling, referral attribution,
 * Send API replies, and dm_sessions (the psid/igsid <-> phone map + human
 * handoff bookkeeping — see migrations/001_dm_sessions.sql).
 *
 * Self-contained like meta-sync.js/google-sync.js/publish-social.js: own
 * Supabase access, own GRAPH_VERSION pin (keep in step with server.js's
 * META_GRAPH_VERSION by hand — see that constant's own comment on why this
 * isn't shared via import).
 *
 * mayaTurn()/validPhone() are passed in as `deps` rather than
 * require()'d from server.js — server.js requires this file at module
 * load, so a require('./server') here would hit server.js mid-
 * initialization and get back an empty module.exports (server.js's
 * `module.exports = {...}` line is the last thing in the file). Passing
 * them as parameters avoids the circular require entirely and makes the
 * orchestration function trivially testable with fakes.
 */

const crypto = require('crypto');

const SB_URL = process.env.SUPABASE_URL || 'https://zkhbaisggymbmurqxejk.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_cXjJKnSOprBxp4CO0wQTsg_azzuBFTi';
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

// Expired Graph API versions do NOT error — see server.js's CLAUDE.md writeup
// on the v18.0/v21.0 incident. v25.0 current as of Feb 2026, v24.0 oldest
// supported.
const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Same Page publish-social.js's FB_PAGE_ID targets — kept as its own literal
// here rather than imported, same "each integration file pins its own"
// reasoning as GRAPH_VERSION above. Real incident this fixes: a live
// Instagram DM (igsid 1752411822575849, 17 Sep 2026) created its dm_sessions
// row fine but got no reply. entry.id for an Instagram webhook is the
// Instagram Business Account id (confirmed from that session's own stored
// page_id: 17841476056303450 — structurally an IG-scoped id, not this Page
// id), and Meta's Instagram Messaging docs are explicit that sending
// requires the Page Access Token obtained via the Page node, not the IG
// node — GET /{ig-business-account-id}?fields=access_token is not the
// documented way to get one. handleMessagingEntry() below now always
// exchanges the token against FB_PAGE_ID for both channels; entry.id is
// still used for the send edge itself (/{ig-user-id}/messages), which is
// correct as-is.
const FB_PAGE_ID = '128897537530800';

const MAX_MESSAGE_LEN = 2000; // Meta Send API text limit
const HANDOFF_AUTO_RESUME_MS = 24 * 60 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, opts, label) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status >= 500 && i === 0) { await sleep(300); continue; }
      return r;
    } catch (e) {
      if (i === 1) throw e;
    }
  }
}

// ── PURE HELPERS (exported for tests — no network, no Supabase) ──

function sessionKeyFor(channel, platformUserId) {
  // Messenger/Instagram ids are large numeric strings — indistinguishable
  // from a real phone number by validPhone()'s \d{10,15} check unless
  // prefixed. Without this, an ungraduated DM session would look
  // "already phone-keyed" to mayaTurn and skip graduation entirely, and a
  // lead could end up with a Facebook id sitting in enquiries.phone.
  const prefix = channel === 'instagram' ? 'igdm:' : 'msgr:';
  return prefix + String(platformUserId);
}

// Meta's actual webhook shape for DMs: entry.messaging[] (NOT entry.changes[],
// which is what leadgen already handles). One event per array entry.
function parseMessagingEvent(event) {
  if (!event || !event.sender || !event.sender.id) return null;
  const senderId = String(event.sender.id);
  const recipientId = event.recipient && event.recipient.id ? String(event.recipient.id) : '';

  if (event.message) {
    if (event.message.is_echo) return { type: 'echo', senderId, recipientId, mid: event.message.mid || '' };
    const text = String(event.message.text || '').trim();
    if (!text) return { type: 'unsupported', senderId, recipientId, mid: event.message.mid || '' }; // image/attachment-only — "Not in v1"
    return {
      type: 'message', senderId, recipientId,
      mid: event.message.mid || '',
      text,
      referral: (event.message.referral || event.referral) ? (event.message.referral || event.referral) : null
    };
  }
  if (event.postback) {
    return {
      type: 'postback', senderId, recipientId,
      mid: event.postback.mid || `postback:${senderId}:${event.postback.payload || ''}`,
      text: event.postback.title || event.postback.payload || '',
      referral: event.postback.referral || null
    };
  }
  if (event.referral) {
    // A standalone m.me/ig.me referral with no message (rare, but documented).
    return { type: 'referral_only', senderId, recipientId, mid: `referral:${senderId}:${Date.now()}`, referral: event.referral };
  }
  // delivery / read / reaction receipts, account_linking, etc. — nothing to act on.
  return { type: 'ignored', senderId, recipientId };
}

// Meta's click-to-Messenger/ig.me referral shape: { ref, source, type, ad_id,
// referer_uri }. Same attribution destination as CTWA's, via ATTRIBUTION_KEYS
// on the server.js side — this only does the DM-shaped parsing, whitelisting
// happens where it always has (mayaTurn's own ATTRIBUTION_KEYS loop).
function referralToAttribution(referral) {
  if (!referral || typeof referral !== 'object') return null;
  const out = {};
  if (referral.ad_id) out.platform_ad_id = String(referral.ad_id);
  if (referral.ref) out.utm_campaign = String(referral.ref).slice(0, 200);
  if (referral.source) out.utm_source = String(referral.source).slice(0, 60);
  if (referral.referer_uri) out.referrer = String(referral.referer_uri).slice(0, 500);
  return Object.keys(out).length ? out : null;
}

// Detect-and-log style, same severity class as server.js's stacked-question
// detector — a DM handoff isn't safety-critical, just a "get a human" signal.
const ESCALATION_RE = /\b(talk to (a |your )?(human|manager)|speak to (a |your )?(human|person|someone|agent|manager)|real person|call me|(need|want) a (call|manager)|not (helpful|working)|human agent)\b/i;
function isEscalationPhrase(text) {
  return ESCALATION_RE.test(String(text || ''));
}

function splitLongMessage(text, maxLen = MAX_MESSAGE_LEN) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen; // no reasonable space — hard cut
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Same fail-closed comment as server.js's own secret family — set to '' if
// unconfigured; a checkMetaSignature() call with '' as appSecret always
// returns {checked:false}, never a false "matched".
function checkMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return { checked: false, reason: 'META_APP_SECRET not configured' };
  if (!signatureHeader) return { checked: false, reason: 'no X-Hub-Signature-256 header on this request' };
  if (!rawBody) return { checked: false, reason: 'no raw body captured' };
  try {
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const receivedBuf = Buffer.from(String(signatureHeader), 'utf8');
    const matched = expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf);
    return { checked: true, matched, expected, received: String(signatureHeader) };
  } catch (e) {
    return { checked: false, reason: `error computing signature: ${e.message}` };
  }
}

// ── GRAPH API ──

// Reads the body as text first, not straight .json() — a non-2xx Graph
// response isn't guaranteed to be JSON (gateway/proxy error pages included),
// and letting JSON.parse throw there would lose the HTTP status and raw
// body entirely, replacing them with an opaque "Unexpected token" error.
async function graphGet(path, params, token) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', token);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const rawText = await res.text();
  let data = null;
  try { data = JSON.parse(rawText); } catch { /* non-JSON body, handled below */ }
  if (data && data.error) throw new Error(`Graph API error [${path}]: ${data.error.message} (code ${data.error.code})`);
  if (!res.ok) throw new Error(`Graph API error [${path}]: HTTP ${res.status} — ${rawText.slice(0, 300)}`);
  return data || {};
}

const pageTokenCache = new Map(); // pageId -> {token, at}
const PAGE_TOKEN_TTL_MS = 60 * 60 * 1000;
async function getPageAccessToken(pageId, systemUserToken) {
  const cached = pageTokenCache.get(pageId);
  if (cached && Date.now() - cached.at < PAGE_TOKEN_TTL_MS) return cached.token;
  const data = await graphGet(`/${pageId}`, { fields: 'access_token' }, systemUserToken);
  // graphGet already throws on an explicit Graph error or a non-2xx status
  // (with the raw body) — this covers the remaining silent case: a 200
  // response that simply doesn't carry the field (e.g. the system user
  // lacks admin access on this Page). Include the raw response so this
  // isn't a repeat of the same "no reason logged anywhere" gap.
  if (!data.access_token) {
    throw new Error(`Could not obtain Page Access Token for ${pageId} — check the system user has admin access on the Page. Graph response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  pageTokenCache.set(pageId, { token: data.access_token, at: Date.now() });
  return data.access_token;
}

// Called once by server.js right after this module loads, so a broken
// Page-token exchange shows up immediately in deploy logs instead of only
// surfacing silently on the first real DM (exactly what happened with the
// igsid 1752411822575849 incident above — nothing in the logs pointed at
// the token exchange until this was added). Never throws: a missing
// META_ACCESS_TOKEN or a failed exchange is logged and left for the
// per-message lazy fetch in handleMessagingEntry (same cache) to retry.
async function initMetaPageToken(systemUserToken) {
  if (!systemUserToken) { console.error('initMetaPageToken skipped: META_ACCESS_TOKEN not set'); return; }
  try {
    await getPageAccessToken(FB_PAGE_ID, systemUserToken);
    console.log(`✅ Meta Page access token obtained at startup for Page ${FB_PAGE_ID} (used for both Messenger and Instagram sends)`);
  } catch (e) {
    console.error(`❌ initMetaPageToken failed for Page ${FB_PAGE_ID}:`, e.message);
  }
}

// recipientIdField: Messenger's Send API takes {recipient:{id: psid}} against
// /me/messages; Instagram takes the same shape but against the IG business
// account's own /{ig-user-id}/messages edge — both use recipient.id = the
// sender's own psid/igsid (Meta's docs are explicit this is symmetric).
async function sendViaGraph(edgePath, recipientId, text, pageToken) {
  const chunks = splitLongMessage(text);
  for (const chunk of chunks) {
    const url = new URL(`${GRAPH_BASE}${edgePath}`);
    url.searchParams.set('access_token', pageToken);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text: chunk } })
    });
    // Same text-first parsing as graphGet — a non-2xx Send API response
    // isn't guaranteed to be JSON, and this is the exact call this whole
    // fix is about being able to diagnose from the logs alone.
    const rawText = await res.text();
    let data = null;
    try { data = JSON.parse(rawText); } catch { /* non-JSON body, handled below */ }
    if (data && data.error) throw new Error(`Send API error [${edgePath}]: ${data.error.message} (code ${data.error.code})`);
    if (!res.ok) throw new Error(`Send API error [${edgePath}]: HTTP ${res.status} — ${rawText.slice(0, 300)}`);
  }
  return true;
}

async function sendMessengerReply(psid, text, pageToken) {
  return sendViaGraph('/me/messages', psid, text, pageToken);
}
async function sendInstagramReply(igsid, text, igUserId, pageToken) {
  return sendViaGraph(`/${igUserId}/messages`, igsid, text, pageToken);
}

// ── DM_SESSIONS ──

async function upsertDmSession({ channel, platformUserId, pageId }) {
  const now = new Date().toISOString();
  const r = await fetchRetry(`${SB_URL}/rest/v1/dm_sessions?on_conflict=channel,platform_user_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ channel, platform_user_id: platformUserId, page_id: pageId || null, last_inbound_at: now, updated_at: now })
  }, 'SB-upsertDmSession');
  if (!r.ok) { console.error('upsertDmSession failed:', r.status, await r.text()); return null; }
  const rows = await r.json();
  return rows[0] || null;
}

async function getDmSession(channel, platformUserId) {
  const r = await fetchRetry(
    `${SB_URL}/rest/v1/dm_sessions?channel=eq.${channel}&platform_user_id=eq.${encodeURIComponent(platformUserId)}&select=*&limit=1`,
    { headers: SB_HEADERS }, 'SB-getDmSession'
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function patchDmSession(id, fields) {
  const r = await fetchRetry(`${SB_URL}/rest/v1/dm_sessions?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() })
  }, 'SB-patchDmSession');
  if (!r.ok) console.error('patchDmSession failed:', r.status, await r.text());
  return r.ok;
}

// true if Maya should stay silent in this thread right now.
function isCurrentlyHandedOff(session) {
  if (!session || !session.handed_off) return false;
  if (!session.handed_off_at) return true;
  const age = Date.now() - new Date(session.handed_off_at).getTime();
  return age < HANDOFF_AUTO_RESUME_MS;
}

async function writeHandoffNotification(writeNotification, { channel, platformUserId, pageId, reason }) {
  const inboxUrl = 'https://business.facebook.com/latest/inbox/all';
  return writeNotification({
    type: 'dm_handoff',
    summary: `${channel === 'instagram' ? 'Instagram DM' : 'Messenger'} needs a human (${reason}) — ${inboxUrl}`
  });
}

// ── ORCHESTRATION ──
// deps = { mayaTurn, validPhone, writeNotification } — see file header for
// why these come in as parameters instead of require('./server').
// systemUserToken = process.env.META_ACCESS_TOKEN, read by the caller so
// this function stays testable with a fake.
async function handleMessagingEntry(entry, objectType, deps, systemUserToken, isDuplicateMsgId) {
  const channel = objectType === 'instagram' ? 'instagram' : 'messenger';
  const pageId = entry.id ? String(entry.id) : '';
  const results = [];

  for (const rawEvent of entry.messaging || []) {
    const parsed = parseMessagingEvent(rawEvent);
    if (!parsed || parsed.type === 'ignored' || parsed.type === 'echo' || parsed.type === 'unsupported') {
      results.push({ skipped: parsed ? parsed.type : 'unparseable' });
      continue;
    }
    if (parsed.mid && isDuplicateMsgId(parsed.mid)) { results.push({ skipped: 'duplicate' }); continue; }

    const session = await upsertDmSession({ channel, platformUserId: parsed.senderId, pageId });
    if (isCurrentlyHandedOff(session)) { results.push({ skipped: 'handed_off' }); continue; }

    if (parsed.type === 'referral_only') { results.push({ skipped: 'referral_only-recorded' }); continue; }

    // Once graduated, reuse the real phone as mayaTurn's key, not the raw
    // psid/igsid again — Meta always sends the same sender.id forever, so
    // re-deriving 'msgr:<id>' every call would load a fresh, empty
    // ai_chats row each time post-graduation (that row now lives under the
    // real phone, upserted by graduateSessionToPhone) and silently drop
    // everything Maya had already learned. Confirmed as a real bug, not
    // hypothetical: a live test conversation asked for budget again and
    // reset to ready:false right after a graduation turn, before this
    // fix — session.phone existing is exactly graduation having happened.
    const sessionKey = (session && session.phone && deps.validPhone(session.phone))
      ? session.phone
      : sessionKeyFor(channel, parsed.senderId);
    const attribution = referralToAttribution(parsed.referral);
    const outRef = {};
    let reply;
    try {
      reply = await deps.mayaTurn(sessionKey, parsed.text, null, channel, outRef, attribution);
    } catch (e) {
      console.error(`mayaTurn error [${channel}:${parsed.senderId}]:`, e.message);
      results.push({ error: e.message });
      continue;
    }

    try {
      // Always exchange against FB_PAGE_ID, never the per-message `pageId`
      // (entry.id) — for a Messenger webhook that already equals FB_PAGE_ID,
      // but for an Instagram webhook entry.id is the linked Instagram
      // Business Account id, and Meta's Send API requires the Page Access
      // Token (obtained via the Page node) for both channels. `pageId` is
      // still the right value for the actual send edge below — Instagram's
      // /{ig-user-id}/messages genuinely does take the IG business id.
      const pageToken = await getPageAccessToken(FB_PAGE_ID, systemUserToken);
      if (channel === 'instagram') await sendInstagramReply(parsed.senderId, reply, pageId, pageToken);
      else await sendMessengerReply(parsed.senderId, reply, pageToken);
    } catch (e) {
      console.error(`Send API error [${channel}:${parsed.senderId}]:`, e.message);
    }

    if (session) {
      const patch = {};
      if (outRef.effectivePhone && deps.validPhone(outRef.effectivePhone) && outRef.effectivePhone !== session.phone) {
        patch.phone = outRef.effectivePhone;
      }
      const escalated = isEscalationPhrase(parsed.text) || (outRef.known && outRef.known.handover);
      if (escalated && !session.handed_off) {
        patch.handed_off = true;
        patch.handed_off_at = new Date().toISOString();
        if (deps.writeNotification) {
          await writeHandoffNotification(deps.writeNotification, {
            channel, platformUserId: parsed.senderId, pageId,
            reason: outRef.known && outRef.known.handover ? 'ready for quote' : 'asked for a human'
          });
        }
      }
      if (Object.keys(patch).length) await patchDmSession(session.id, patch);
    }

    results.push({ ok: true, mid: parsed.mid });
  }
  return results;
}

module.exports = {
  // orchestration
  handleMessagingEntry,
  // called once by server.js at startup
  initMetaPageToken,
  // pure/testable
  parseMessagingEvent,
  sessionKeyFor,
  referralToAttribution,
  isEscalationPhrase,
  splitLongMessage,
  checkMetaSignature,
  isCurrentlyHandedOff,
  // network — exported for real (non-dry) verification and reuse
  getPageAccessToken,
  sendMessengerReply,
  sendInstagramReply,
  upsertDmSession,
  getDmSession,
  patchDmSession,
  HANDOFF_AUTO_RESUME_MS,
  FB_PAGE_ID
};
