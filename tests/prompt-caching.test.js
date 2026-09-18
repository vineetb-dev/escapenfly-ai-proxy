/**
 * prompt-caching.test.js — guards the cache_control structure on
 * callMayaJSON's system prompt (added 18 Aug 2026, see server.js's CLAUDE.md
 * writeup) and the console.log hit-rate visibility line (added 18 Sep 2026)
 * against silent regression.
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

    console.log('\ncache hit-rate console.log line — visible in Render logs per call');
    // Still inside the faked-fetch scope — a real network call here would
    // just hang/fail with no ANTHROPIC_API_KEY in this environment.
    const realLog = console.log;
    const logged = [];
    console.log = (...args) => logged.push(args.join(' '));
    try {
      await server.callMayaJSON(
        [{ role: 'user', content: 'Hi again' }],
        { name: 'Gamma Traveller' }, 'test_session_c', 'whatsapp', [], [], 'holiday'
      );
    } finally {
      console.log = realLog;
    }
    const cacheLine = logged.find(l => l.includes('Maya cache usage'));
    t('a cache-usage line was logged for this call', () => assert.ok(cacheLine, 'no "Maya cache usage" line found in console.log output'));
    t('it names the channel and intent', () => assert.ok(cacheLine.includes('[whatsapp/holiday]')));
    t('it carries both cache_read_input_tokens and cache_creation_input_tokens', () => {
      assert.ok(cacheLine.includes('cache_read_input_tokens='));
      assert.ok(cacheLine.includes('cache_creation_input_tokens='));
    });
  } finally {
    global.fetch = realFetch;
  }

  console.log(`\n${pass} passed`);
}

main().catch(e => { console.error('Test runner crashed:', e); process.exitCode = 1; });
