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
  isEscalationPhrase, splitLongMessage, checkMetaSignature, isCurrentlyHandedOff,
  handleMessagingEntry, getPageAccessToken, sendMessengerReply, sendInstagramReply, FB_PAGE_ID
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

console.log('\ngetPageAccessToken (fake Graph response — no real network)');
async function testGetPageAccessTokenErrorDetail() {
  const realFetch = global.fetch;

  // A 200 response with no access_token field used to throw a hardcoded,
  // context-free message — the actual gap this whole fix is about. Using a
  // distinct fake page id per sub-test avoids the in-module token cache.
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ id: 'fake_page_999a' }) });
  try {
    await getPageAccessToken('fake_page_999a', 'sys_token');
    console.error('  FAIL getPageAccessToken should have thrown when access_token is missing');
    process.exitCode = 1;
  } catch (e) {
    assert.ok(e.message.includes('fake_page_999a'), 'error names which page id failed');
    assert.ok(e.message.includes('"id":"fake_page_999a"'), 'error includes the raw Graph response body, not just a generic message');
    pass++;
    console.log('  ok   missing access_token -> error includes the raw Graph response body');
  }

  global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Unsupported get request.', code: 100 } }) });
  try {
    await getPageAccessToken('fake_page_999b', 'sys_token');
    console.error('  FAIL getPageAccessToken should have thrown on a Graph API error');
    process.exitCode = 1;
  } catch (e) {
    assert.ok(e.message.includes('Unsupported get request'));
    assert.ok(e.message.includes('code 100'));
    pass++;
    console.log('  ok   an explicit Graph API error still surfaces its real message and code');
  }

  global.fetch = realFetch;
}

console.log('\nsendMessengerReply / sendInstagramReply (fake Send API response — no real network)');
async function testSendViaGraphErrorDetail() {
  const realFetch = global.fetch;

  // A non-JSON body on a non-2xx response used to throw an opaque JSON
  // parse error with no HTTP status or body — exactly the shape a
  // real Send API failure could take that "check e.message" wouldn't help
  // diagnose.
  global.fetch = async () => ({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' });
  try {
    await sendMessengerReply('5591234567890123', 'hi', 'page_token');
    console.error('  FAIL sendMessengerReply should have thrown on a non-JSON, non-2xx response');
    process.exitCode = 1;
  } catch (e) {
    assert.ok(e.message.includes('502'), 'error includes the HTTP status');
    assert.ok(e.message.includes('Bad Gateway'), 'error includes the raw response body');
    pass++;
    console.log('  ok   a non-JSON Send API failure still surfaces HTTP status + raw body');
  } finally {
    global.fetch = realFetch;
  }
}

console.log('\nhandleMessagingEntry (fake Graph/Send/Supabase — the real bug: Instagram token exchange)');
async function testInstagramTokenExchangeUsesPageId() {
  const realFetch = global.fetch;
  // Real values from the incident this fixes: entry.id for an Instagram
  // webhook is the linked Instagram Business Account id (confirmed from
  // the real dm_sessions row's own page_id column), not the Facebook Page
  // id — igsid is the real sender from that same session.
  const IG_BUSINESS_ACCOUNT_ID = '17841476056303450';
  const IGSID = '1752411822575849';

  const entry = {
    id: IG_BUSINESS_ACCOUNT_ID,
    messaging: [{
      sender: { id: IGSID },
      recipient: { id: IG_BUSINESS_ACCOUNT_ID },
      timestamp: Date.now(),
      message: { mid: 'ig_m_1', text: 'Hi, tell me about Bali packages' }
    }]
  };

  const calls = [];
  global.fetch = async (url) => {
    const urlStr = String(url);
    calls.push(urlStr);
    if (urlStr.includes(`/${FB_PAGE_ID}?`)) {
      return { ok: true, text: async () => JSON.stringify({ access_token: 'real_page_token' }) };
    }
    if (urlStr.includes(`/${IG_BUSINESS_ACCOUNT_ID}/messages`)) {
      return { ok: true, text: async () => JSON.stringify({ message_id: 'sent_1' }) };
    }
    // dm_sessions upsert/patch (Supabase REST) — not what this test is
    // about; a real, minimal representation-shaped response is enough to
    // let the orchestration complete.
    return { ok: true, text: async () => '[{"id":"fake-session-id","phone":null}]', json: async () => [{ id: 'fake-session-id', phone: null }] };
  };

  const deps = {
    mayaTurn: async () => 'Bali packages start at ₹70,000 per person...',
    validPhone: () => false,
    writeNotification: async () => {}
  };

  try {
    await handleMessagingEntry(entry, 'instagram', deps, 'system_user_token', () => false);

    const tokenCall = calls.find(c => c.includes('fields=access_token'));
    assert.ok(tokenCall, 'a Page-token exchange call was made');
    assert.ok(tokenCall.includes(`/${FB_PAGE_ID}?`), `token exchange must target FB_PAGE_ID (${FB_PAGE_ID}), not entry.id — got: ${tokenCall}`);
    assert.ok(!tokenCall.includes(IG_BUSINESS_ACCOUNT_ID), 'token exchange must NOT use the Instagram Business Account id — this was the real bug (igsid ' + IGSID + ' never got a reply)');

    const sendCall = calls.find(c => c.includes('/messages?'));
    assert.ok(sendCall, 'a Send API call was made');
    assert.ok(sendCall.includes(`/${IG_BUSINESS_ACCOUNT_ID}/messages`), 'the send edge itself correctly still targets the Instagram Business Account id');

    pass++;
    console.log('  ok   Instagram token exchange uses FB_PAGE_ID; send edge still uses the IG business account id');
  } catch (e) {
    console.error('  FAIL handleMessagingEntry Instagram token exchange\n       ' + e.message);
    process.exitCode = 1;
  } finally {
    global.fetch = realFetch;
  }
}

testGetPageAccessTokenErrorDetail()
  .then(testSendViaGraphErrorDetail)
  .then(testInstagramTokenExchangeUsesPageId)
  .then(() => console.log(`\n${pass} passed`));
