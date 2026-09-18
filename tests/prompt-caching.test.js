/**
 * prompt-caching.test.js — guards the cache_control structure on
 * callMayaJSON's system prompt (added 18 Aug 2026, see server.js's CLAUDE.md
 * writeup) and the /debug/cache-usage-log hit-rate logging (added 18 Sep
 * 2026) against silent regression.
 *
 * Run with: node tests/prompt-caching.test.js
 *
 * No real ANTHROPIC_API_KEY in this environment — same limitation this
 * repo's other tests state. global.fetch is faked to intercept the request
 * server.js actually builds and sends to api.anthropic.com, and to return a
 * synthetic response carrying real-shaped usage.cache_read_input_tokens/
 * cache_creation_input_tokens. This proves the REQUEST SHAPE is correct
 * (system array order, cache_control placement, prefix stability across
 * different sessions) — it does not and cannot prove Anthropic's servers
 * actually cache it, which was verified separately with real API calls back
 * in August (see CLAUDE.md's "Verified with real Anthropic API calls" log).
 */

'use strict';

const assert = require('assert');
const server = require('../server');

async function main() {
  const realFetch = global.fetch;
  const capturedBodies = [];
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('api.anthropic.com')) {
      capturedBodies.push(JSON.parse(opts.body));
      return {
        ok: true,
        json: async () => ({
          model: 'claude-sonnet-5',
          content: [{
            type: 'tool_use', name: 'maya_reply',
            input: {
              reply: 'Hi! Where are you thinking of travelling?',
              intent: 'holiday', lead: {}, lead_summary: '', next_action: '',
              handover: false, ready: false
            }
          }],
          usage: {
            input_tokens: 350,
            cache_creation_input_tokens: capturedBodies.length === 1 ? 12118 : 0,
            cache_read_input_tokens: capturedBodies.length === 1 ? 0 : 12118,
            output_tokens: 40
          }
        })
      };
    }
    return realFetch(url, opts);
  };

  let pass = 0;
  function t(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
  }

  try {
    console.log('\ncallMayaJSON system prompt — cache_control structure + prefix stability');

    // Two different "sessions": different phone, different known lead info
    // (so the dynamic tail genuinely differs) — same channel+intent, so the
    // static prefix (buildChatSystem's output) must be byte-identical, the
    // exact property cache_control relies on to ever hit.
    const resultA = await server.callMayaJSON(
      [{ role: 'user', content: 'Hi, thinking about a trip' }],
      { name: 'Alpha Traveller' }, 'test_session_a', 'whatsapp',
      [], [], 'holiday'
    );
    const resultB = await server.callMayaJSON(
      [{ role: 'user', content: 'Hi, thinking about a trip' }],
      { name: 'Beta Traveller' }, 'test_session_b', 'whatsapp',
      [], [], 'holiday'
    );

    t('both calls reached the fake Anthropic endpoint', () => {
      assert.strictEqual(capturedBodies.length, 2);
    });
    t('system is a 2-block array on both calls', () => {
      assert.strictEqual(capturedBodies[0].system.length, 2);
      assert.strictEqual(capturedBodies[1].system.length, 2);
    });
    t('block 0 (static prefix) carries cache_control: ephemeral', () => {
      assert.deepStrictEqual(capturedBodies[0].system[0].cache_control, { type: 'ephemeral' });
      assert.deepStrictEqual(capturedBodies[1].system[0].cache_control, { type: 'ephemeral' });
    });
    t('block 1 (dynamic tail) carries no cache_control', () => {
      assert.strictEqual(capturedBodies[0].system[1].cache_control, undefined);
      assert.strictEqual(capturedBodies[1].system[1].cache_control, undefined);
    });
    t('the static prefix is byte-identical across two different sessions', () => {
      assert.strictEqual(capturedBodies[0].system[0].text, capturedBodies[1].system[0].text);
    });
    t('the dynamic tail genuinely differs between sessions (proves this is a real split, not a no-op wrapper)', () => {
      assert.notStrictEqual(capturedBodies[0].system[1].text, capturedBodies[1].system[1].text);
      assert.ok(capturedBodies[0].system[1].text.includes('Alpha Traveller'));
      assert.ok(capturedBodies[1].system[1].text.includes('Beta Traveller'));
    });
    t('both calls returned a parsed reply (sanity: the fake response shape was accepted)', () => {
      assert.strictEqual(resultA.reply, 'Hi! Where are you thinking of travelling?');
      assert.strictEqual(resultB.intent, 'holiday');
    });

    console.log('\n/debug/cache-usage-log — logs a cache-read vs cache-creation entry per call');
    t('two entries logged, most recent first', () => {
      assert.ok(server.cacheUsageLog.length >= 2);
      assert.strictEqual(server.cacheUsageLog[0].channel, 'whatsapp');
      assert.strictEqual(server.cacheUsageLog[0].intent, 'holiday');
    });
    t('first call was a cache write, second was a cache read', () => {
      const [second, first] = server.cacheUsageLog; // unshift -> most recent at [0]
      assert.strictEqual(first.cache_creation_input_tokens, 12118);
      assert.strictEqual(first.cache_read_input_tokens, 0);
      assert.strictEqual(second.cache_creation_input_tokens, 0);
      assert.strictEqual(second.cache_read_input_tokens, 12118);
    });
  } finally {
    global.fetch = realFetch;
  }

  console.log(`\n${pass} passed`);
}

main().catch(e => { console.error('Test runner crashed:', e); process.exitCode = 1; });
