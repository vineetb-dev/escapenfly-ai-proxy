/**
 * maya-messaging.test.js — sanity checks for maya-messaging.js's pure logic
 * Run with: node tests/maya-messaging.test.js   (no test framework needed)
 *
 * Same scope discipline as canton.test.js/publish-social.test.js: only the
 * exported pure functions (no network, no Supabase). handleMessagingEntry
 * (the orchestration function that calls mayaTurn/Send API/dm_sessions) is
 * exercised separately — see the "real verification" notes in the PR
 * description for what was actually run against real Supabase and the real
 * Anthropic API, and what genuinely could not be (no real META_ACCESS_TOKEN
 * in this environment, same limitation this repo already states plainly
 * for meta-sync.js/publish-social.js).
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  parseMessagingEvent, sessionKeyFor, referralToAttribution,
  isEscalationPhrase, splitLongMessage, checkMetaSignature, isCurrentlyHandedOff
} = require('../maya-messaging');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// ── Real-shaped fixtures, per Meta's documented Messenger/Instagram webhook payloads ──

const MESSENGER_TEXT_EVENT = {
  sender: { id: '5591234567890123' },
  recipient: { id: '128897537530800' },
  timestamp: 1758000000000,
  message: { mid: 'm_AbCdEfGh12345', text: 'Hi, I want to plan a trip to Bali' }
};

const MESSENGER_ECHO_EVENT = {
  sender: { id: '128897537530800' },
  recipient: { id: '5591234567890123' },
  timestamp: 1758000001000,
  message: { mid: 'm_EchoXyz', is_echo: true, text: 'Hi! This is Maya from EscapeNFly...' }
};

const MESSENGER_POSTBACK_EVENT = {
  sender: { id: '5591234567890123' },
  recipient: { id: '128897537530800' },
  timestamp: 1758000002000,
  postback: { mid: 'm_Postback1', title: 'Get Started', payload: 'GET_STARTED' }
};

const MESSENGER_REFERRAL_MESSAGE_EVENT = {
  sender: { id: '5591234567890123' },
  recipient: { id: '128897537530800' },
  timestamp: 1758000003000,
  message: { mid: 'm_Referral1', text: 'Hi', referral: { ref: 'BALI_SEP', source: 'ADS', type: 'OPEN_THREAD', ad_id: '120210000000001' } }
};

const MESSENGER_STANDALONE_REFERRAL_EVENT = {
  sender: { id: '5591234567890123' },
  recipient: { id: '128897537530800' },
  timestamp: 1758000004000,
  referral: { ref: 'BALI_SEP', source: 'SHORTLINK', type: 'OPEN_THREAD' }
};

const MESSENGER_ATTACHMENT_ONLY_EVENT = {
  sender: { id: '5591234567890123' },
  recipient: { id: '128897537530800' },
  timestamp: 1758000005000,
  message: { mid: 'm_Attach1', attachments: [{ type: 'image', payload: { url: 'https://example.com/x.jpg' } }] }
};

const MESSENGER_DELIVERY_EVENT = {
  sender: { id: '5591234567890123' },
  recipient: { id: '128897537530800' },
  delivery: { mids: ['m_AbCdEfGh12345'], watermark: 1758000000500 }
};

console.log('\nparseMessagingEvent');
t('a plain text message parses as type message with mid/text', () => {
  const p = parseMessagingEvent(MESSENGER_TEXT_EVENT);
  assert.strictEqual(p.type, 'message');
  assert.strictEqual(p.senderId, '5591234567890123');
  assert.strictEqual(p.mid, 'm_AbCdEfGh12345');
  assert.strictEqual(p.text, 'Hi, I want to plan a trip to Bali');
});
t('an echo is flagged as type echo, never routed to Maya', () => {
  const p = parseMessagingEvent(MESSENGER_ECHO_EVENT);
  assert.strictEqual(p.type, 'echo');
});
t('a postback parses with its title as text', () => {
  const p = parseMessagingEvent(MESSENGER_POSTBACK_EVENT);
  assert.strictEqual(p.type, 'postback');
  assert.strictEqual(p.text, 'Get Started');
});
t('a message carrying a referral object exposes it', () => {
  const p = parseMessagingEvent(MESSENGER_REFERRAL_MESSAGE_EVENT);
  assert.strictEqual(p.type, 'message');
  assert.ok(p.referral && p.referral.ad_id === '120210000000001');
});
t('a standalone referral with no message is its own type, not dropped silently', () => {
  const p = parseMessagingEvent(MESSENGER_STANDALONE_REFERRAL_EVENT);
  assert.strictEqual(p.type, 'referral_only');
});
t('an attachment-only message (no text) is unsupported, not a crash', () => {
  const p = parseMessagingEvent(MESSENGER_ATTACHMENT_ONLY_EVENT);
  assert.strictEqual(p.type, 'unsupported');
});
t('a delivery receipt (no message/postback/referral) is ignored', () => {
  const p = parseMessagingEvent(MESSENGER_DELIVERY_EVENT);
  assert.strictEqual(p.type, 'ignored');
});
t('a malformed event with no sender.id returns null rather than throwing', () => {
  assert.strictEqual(parseMessagingEvent({ message: { text: 'hi' } }), null);
  assert.strictEqual(parseMessagingEvent(null), null);
});

console.log('\nsessionKeyFor');
t('messenger key is prefixed and never looks like a bare phone number', () => {
  const k = sessionKeyFor('messenger', '5591234567890123');
  assert.strictEqual(k, 'msgr:5591234567890123');
  assert.strictEqual(/^\d{10,15}$/.test(k), false); // must not pass validPhone()'s own regex
});
t('instagram key uses its own prefix', () => {
  assert.strictEqual(sessionKeyFor('instagram', '999888777'), 'igdm:999888777');
});

console.log('\nreferralToAttribution');
t('maps ad_id/ref/source/referer_uri into ATTRIBUTION_KEYS-shaped fields', () => {
  const a = referralToAttribution({ ad_id: '120210000000001', ref: 'BALI_SEP', source: 'ADS', referer_uri: 'https://facebook.com/ads/x' });
  assert.strictEqual(a.platform_ad_id, '120210000000001');
  assert.strictEqual(a.utm_campaign, 'BALI_SEP');
  assert.strictEqual(a.utm_source, 'ADS');
  assert.strictEqual(a.referrer, 'https://facebook.com/ads/x');
});
t('an empty/missing referral returns null, not an empty object staff might mistake for real attribution', () => {
  assert.strictEqual(referralToAttribution(null), null);
  assert.strictEqual(referralToAttribution({}), null);
});

console.log('\nisEscalationPhrase');
t('recognizes common escalation phrasings', () => {
  assert.strictEqual(isEscalationPhrase('can I talk to a human please'), true);
  assert.strictEqual(isEscalationPhrase('I want to speak to a manager'), true);
  assert.strictEqual(isEscalationPhrase('call me'), true);
});
t('a normal travel question is not an escalation', () => {
  assert.strictEqual(isEscalationPhrase('what is the visa process for dubai'), false);
});

console.log('\nsplitLongMessage');
t('short text is untouched, single chunk', () => {
  assert.deepStrictEqual(splitLongMessage('hello'), ['hello']);
});
t('long text splits at a word boundary under the 2000-char Send API limit', () => {
  const long = ('word '.repeat(500)).trim(); // ~2500 chars
  const chunks = splitLongMessage(long, 2000);
  assert.ok(chunks.length >= 2);
  chunks.forEach(c => assert.ok(c.length <= 2000));
  assert.strictEqual(chunks.join(' ').replace(/\s+/g, ' '), long);
});

console.log('\ncheckMetaSignature');
t('no app secret configured -> not checked, never a false match', () => {
  const r = checkMetaSignature('{"a":1}', 'sha256=deadbeef', '');
  assert.strictEqual(r.checked, false);
});
t('a real HMAC over the exact raw body matches', () => {
  const secret = 'test-app-secret';
  const raw = '{"object":"page","entry":[]}';
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = checkMetaSignature(raw, sig, secret);
  assert.strictEqual(r.checked, true);
  assert.strictEqual(r.matched, true);
});
t('a tampered body does not match', () => {
  const secret = 'test-app-secret';
  const raw = '{"object":"page","entry":[]}';
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = checkMetaSignature(raw + 'tampered', sig, secret);
  assert.strictEqual(r.matched, false);
});

console.log('\nisCurrentlyHandedOff');
t('not handed off -> false', () => {
  assert.strictEqual(isCurrentlyHandedOff({ handed_off: false }), false);
  assert.strictEqual(isCurrentlyHandedOff(null), false);
});
t('handed off recently -> true (Maya stays silent)', () => {
  assert.strictEqual(isCurrentlyHandedOff({ handed_off: true, handed_off_at: new Date().toISOString() }), true);
});
t('handed off more than 24h ago -> false (auto-resumes)', () => {
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(isCurrentlyHandedOff({ handed_off: true, handed_off_at: old }), false);
});

console.log(`\n${pass} passed`);
