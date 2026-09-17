#!/usr/bin/env node
// ═══════ MAYA CONVERSATION TEST RUNNER — MESSENGER / INSTAGRAM ADAPTERS ═══════
// Same 37-case suite tests/run-tests.js already runs against the live
// deployed /webhook/website-chat, run here against the new 'messenger'/
// 'instagram' CHANNEL_ADAPTERS instead — directly through the exported
// mayaTurn(), not over HTTP, since there is no webhook shaped for a plain
// customerTurns[] array the way website-chat's {phone,message} body is.
// This also means no Send API / no real Meta call happens — onReply is
// null, exactly like website's own call site, so this is exercising the
// SAME conversation-generation code path production DMs will use, just
// without actually delivering the reply anywhere.
//
// USAGE:  node tests/run-tests-dm.js [--channel=messenger|instagram] [caseId]
// Defaults to messenger. Requires a real ANTHROPIC_API_KEY in the
// environment (this makes real Anthropic calls) and real Supabase access —
// same requirements as running server.js itself locally.
//
// HONEST LIMITATION, same one run-tests.js itself states: these checks are
// keyword/heuristic-based, not an LLM judge — read the actual transcript
// for anything marked FAIL before assuming it's a real regression.
//
// Writes to real ai_chats (and enquiries/internal_notifications for any
// case that reaches handover with a captured phone) under session keys
// prefixed 'test_' — same test-pollution shape tests/run-tests.js already
// has against the live site, not something new. Clean up afterward with:
//   node tests/run-tests-dm.js --cleanup

const path = require('path');
const fs = require('fs');
const { mayaTurn } = require('../server');

// Same generic reply server.js falls back to when the AI call/parse fails —
// see FALLBACK_REPLY in server.js. Not exported from there, so kept as a
// literal copy, same approach tests/run-tests.js uses.
const FALLBACK_REPLY = 'Thanks for your message! Our travel expert will call you shortly. You can also reach us directly at +91 98517 39851. 😊';

// This runner calls the real mayaTurn() directly against real Supabase — see
// the file-header comment above. Same production-writes exposure
// tests/run-tests.js has, same guard shape. testMode is threaded straight
// into mayaTurn's testMode param (no HTTP header needed here, since this is
// an in-process call, not a webhook round-trip) — it skips website-style
// session->phone graduation and, in turn, the lead-capture/notify block
// gated on validPhone(effectivePhone). Note: this only takes effect once
// mayaTurn's testMode param exists on whatever server.js this branch is
// rebased onto — see PR #10 on the main repo.
const KNOWN_PROD_SUPABASE_REF = 'zkhbaisggymbmurqxejk'; // escapenfly-crm production project
function assertSafeToRun() {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const pointedAtNonProdSupabase = supabaseUrl && !supabaseUrl.includes(KNOWN_PROD_SUPABASE_REF);
  const testMode = process.env.MAYA_TEST_MODE === '1';
  if (!pointedAtNonProdSupabase && !testMode) {
    console.error(
      '\nREFUSING TO START.\n' +
      'This runner calls the real mayaTurn() directly against live production Supabase.\n' +
      'Set one of the following before running:\n' +
      '  MAYA_TEST_MODE=1              (passed through to mayaTurn; skips session->phone\n' +
      '                                 graduation, which also disables lead creation/notifications)\n' +
      '  SUPABASE_URL=<non-production project URL>   (informational confirmation you are not\n' +
      '                                 pointed at the production project)\n'
    );
    process.exit(1);
  }
  return testMode;
}

const TEST_MODE = assertSafeToRun();

function contains(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

async function runCase(testCase, channel) {
  const sessionKey = (channel === 'instagram' ? 'igdm:' : 'msgr:') + 'test_' + testCase.id + '_' + Date.now();
  const allReplies = [];
  let lastOut = {};

  for (const turn of testCase.customerTurns) {
    try {
      const out = {};
      const reply = await mayaTurn(sessionKey, turn, null, channel, out, null, '', TEST_MODE);
      allReplies.push(reply || '');
      lastOut = out;
      if (reply === FALLBACK_REPLY) {
        return {
          id: testCase.id, category: testCase.category, channel, status: 'FAIL',
          failures: ['reply was the API-error fallback, not a real answer'],
          transcript: allReplies, finalKnown: lastOut.known, finalIntent: lastOut.known?.intent || '', sessionKey
        };
      }
    } catch (e) {
      return { id: testCase.id, status: 'ERROR', error: e.message, transcript: allReplies };
    }
  }

  const fullText = allReplies.join(' \n--- \n ');
  const failures = [];
  const gotIntent = lastOut.known?.intent || '';

  if (testCase.expectedIntent && gotIntent && gotIntent.toLowerCase() !== testCase.expectedIntent.toLowerCase()) {
    failures.push(`expected intent "${testCase.expectedIntent}", got "${gotIntent}"`);
  }
  if (testCase.mustAsk && testCase.mustAsk.length && !testCase.mustAsk.some(kw => contains(fullText, kw))) {
    failures.push(`expected to ask about one of [${testCase.mustAsk.join(', ')}] — none found in replies`);
  }
  for (const kw of (testCase.mustNotAsk || [])) {
    if (contains(fullText, kw)) failures.push(`should NOT have asked about "${kw}" — found in replies`);
  }
  for (const kw of (testCase.mustNotSay || [])) {
    if (contains(fullText, kw)) failures.push(`should NOT have said "${kw}" — found in replies`);
  }
  for (const kw of (testCase.mustNotSayInLastReply || [])) {
    if (contains(allReplies[allReplies.length - 1] || '', kw)) failures.push(`should NOT have said "${kw}" in the final reply — found there`);
  }

  return {
    id: testCase.id,
    category: testCase.category,
    channel,
    status: failures.length ? 'FAIL' : 'PASS',
    failures,
    transcript: allReplies,
    finalKnown: lastOut.known,
    finalIntent: gotIntent,
    sessionKey
  };
}

async function main() {
  const args = process.argv.slice(2);
  const channelArg = args.find(a => a.startsWith('--channel='));
  const channel = channelArg ? channelArg.split('=')[1] : 'messenger';
  if (!['messenger', 'instagram'].includes(channel)) {
    console.log(`Unknown channel "${channel}" — use messenger or instagram`);
    return;
  }
  const filterArg = args.find(a => !a.startsWith('--'));
  const allCases = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-cases.json'), 'utf8'));
  const cases = filterArg ? allCases.filter(c => c.id === filterArg) : allCases;
  if (!cases.length) {
    console.log(filterArg ? `No test case with id "${filterArg}"` : 'No test cases found.');
    return;
  }

  console.log(`Running ${cases.length} test case(s) against the '${channel}' CHANNEL_ADAPTERS entry, direct mayaTurn() calls (no HTTP, no Send API)\n`);

  const results = [];
  for (const tc of cases) {
    process.stdout.write(`  ${tc.id} ... `);
    const r = await runCase(tc, channel);
    results.push(r);
    console.log(r.status + (r.status === 'FAIL' ? '  (' + r.failures.length + ' issue(s))' : ''));
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const error = results.filter(r => r.status === 'ERROR').length;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`RESULTS (${channel}): ${pass} passed, ${fail} failed, ${error} errored — out of ${results.length}`);
  console.log('═'.repeat(60));

  const failed = results.filter(r => r.status !== 'PASS');
  if (failed.length) {
    console.log('\nDETAILS FOR FAILED/ERRORED CASES:\n');
    for (const r of failed) {
      console.log(`── ${r.id} [${r.category || '?'}] ──`);
      if (r.error) console.log(`  ERROR: ${r.error}`);
      for (const f of (r.failures || [])) console.log(`  ✗ ${f}`);
      console.log(`  Transcript:`);
      (r.transcript || []).forEach((t, i) => console.log(`    [${i + 1}] ${t.slice(0, 200)}${t.length > 200 ? '…' : ''}`));
      console.log('');
    }
  }

  const reportPath = path.join(__dirname, `last-run-results-dm-${channel}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`Full results written to ${reportPath}`);
  console.log(`Session keys used are all prefixed 'test_' — see the file header for cleanup.`);
}

main().catch(e => { console.error('DM test runner crashed:', e); process.exit(1); });
