#!/usr/bin/env node
// ═══════════════ MAYA CONVERSATION TEST RUNNER — WHATSAPP ═══════════════
// Same 37-case suite tests/run-tests.js already runs against the live
// deployed /webhook/website-chat, run here against the 'whatsapp' channel
// instead — directly through the exported mayaTurn(), not over HTTP, since
// /webhook/incoming ACKs immediately and sends Maya's actual reply
// asynchronously via the real WhatsApp Send API (sendSessionMessage) rather
// than returning it in the HTTP response — there is no reply text to read
// from a fixture POST there. mayaTurn()'s onReply callback is passed as
// null (exactly like /webhook/website-chat's own call site, and exactly
// like tests/run-tests-dm.js's messenger/instagram runner), so no send of
// any kind is attempted — the reply is only ever the function's return
// value. This exercises the SAME conversation-generation code production
// whatsapp messages use, without delivering anything anywhere.
//
// USAGE:  node tests/run-tests-whatsapp.js [caseId]
// Requires a real ANTHROPIC_API_KEY in the environment (this makes real
// Anthropic calls) and real Supabase access — same requirements as running
// server.js itself locally.
//
// HONEST LIMITATION, same one run-tests.js itself states: these checks are
// keyword/heuristic-based, not an LLM judge — read the actual transcript
// for anything marked FAIL before assuming it's a real regression.
//
// Writes to real ai_chats under session keys prefixed 'test_' — same
// test-pollution shape tests/run-tests.js already has against the live
// site, not something new (and see mayaTurn's testMode param: with
// MAYA_TEST_MODE=1 the LEAD CAPTURE block is skipped outright, so no
// enquiries/internal_notifications/team notification is ever created by
// this runner regardless of how a conversation ends — see server.js's
// LEAD CAPTURE gate, fixed alongside this file to check !testMode directly
// rather than only indirectly via validPhone(effectivePhone), which never
// protected whatsapp/messenger/instagram since their phone/psid/igsid is
// real from the first turn, not something that only becomes real after a
// website-style graduation step).

const path = require('path');
const fs = require('fs');
const { mayaTurn } = require('../server');

// Same generic reply server.js falls back to when the AI call/parse fails —
// see FALLBACK_REPLY in server.js. Not exported from there, so kept as a
// literal copy, same approach tests/run-tests.js and run-tests-dm.js use.
const FALLBACK_REPLY = 'Thanks for your message! Our travel expert will call you shortly. You can also reach us directly at +91 98517 39851. 😊';

// This runner calls the real mayaTurn() directly against real Supabase —
// see the file-header comment above. Same production-writes exposure
// tests/run-tests.js has, same guard shape as tests/run-tests-dm.js.
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
      '  MAYA_TEST_MODE=1              (passed through to mayaTurn; disables the LEAD CAPTURE\n' +
      '                                 block entirely for this run, whatever a conversation\n' +
      '                                 resolves to)\n' +
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

async function runCase(testCase) {
  const sessionKey = 'test_' + testCase.id + '_' + Date.now();
  const allReplies = [];
  let lastOut = {};

  for (const turn of testCase.customerTurns) {
    try {
      const out = {};
      const reply = await mayaTurn(sessionKey, turn, null, 'whatsapp', out, null, '', TEST_MODE);
      allReplies.push(reply || '');
      lastOut = out;
      if (reply === FALLBACK_REPLY) {
        return {
          id: testCase.id, category: testCase.category, status: 'FAIL',
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
    status: failures.length ? 'FAIL' : 'PASS',
    failures,
    transcript: allReplies,
    finalKnown: lastOut.known,
    finalIntent: gotIntent,
    sessionKey
  };
}

async function main() {
  const filterArg = process.argv[2];
  const allCases = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-cases.json'), 'utf8'));
  const cases = filterArg ? allCases.filter(c => c.id === filterArg) : allCases;
  if (!cases.length) {
    console.log(filterArg ? `No test case with id "${filterArg}"` : 'No test cases found.');
    return;
  }

  console.log(`Running ${cases.length} test case(s) against the 'whatsapp' channel, direct mayaTurn() calls (no HTTP, no Send API)\n`);

  const results = [];
  for (const tc of cases) {
    process.stdout.write(`  ${tc.id} ... `);
    const r = await runCase(tc);
    results.push(r);
    console.log(r.status + (r.status === 'FAIL' ? '  (' + r.failures.length + ' issue(s))' : ''));
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const error = results.filter(r => r.status === 'ERROR').length;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`RESULTS (whatsapp): ${pass} passed, ${fail} failed, ${error} errored — out of ${results.length}`);
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

  const reportPath = path.join(__dirname, 'last-run-results-whatsapp.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`Full results written to ${reportPath}`);
  console.log(`Session keys used are all prefixed 'test_'.`);
}

main().catch(e => { console.error('WhatsApp test runner crashed:', e); process.exit(1); });
