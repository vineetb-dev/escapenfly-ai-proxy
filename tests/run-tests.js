#!/usr/bin/env node
// ═══════════════════ MAYA CONVERSATION TEST RUNNER ═══════════════════
// Runs every case in test-cases.json against the LIVE deployed
// /webhook/website-chat endpoint (not a mock) and checks the results
// against each case's expectations.
//
// USAGE:  node tests/run-tests.js
// Optional: node tests/run-tests.js visa_01_basic_tourist   (run one case)
//
// HONEST LIMITATION: these checks are keyword/heuristic-based, not an
// LLM judge. They catch the concrete regressions this project has hit
// (asking budget on a visa enquiry, inventing a processing-time number,
// re-asking for info already given) — they do NOT reliably judge subtle
// things like "warmth of tone". A case can technically fail on a keyword
// that appears in a sentence explicitly saying the opposite (e.g. "budget
// is not relevant here" contains the word "budget") — always read the
// actual transcript for any case marked FAIL before assuming it's a real
// regression. This is a first pass, not a replacement for reading Maya's
// actual replies.

const API_URL = process.env.MAYA_TEST_API_URL || 'https://escapenfly-ai-proxy.onrender.com/webhook/website-chat';
// Same generic reply server.js falls back to when the AI call/parse fails —
// see FALLBACK_REPLY in server.js. Kept as a literal copy rather than an
// import since this runner talks to the deployed API over HTTP, not the
// module directly.
const FALLBACK_REPLY = 'Thanks for your message! Our travel expert will call you shortly. You can also reach us directly at +91 98517 39851. 😊';

// This runner sends real requests to the LIVE production API_URL above,
// which write to real production Supabase (ai_chats/customer_profile/
// enquiries/internal_notifications) unless the server is told this is a
// test run. Refuse to start unless that's explicitly true — see the 16 Sep
// 2026 incident this guard exists because of (CLAUDE.md/PR history): 261
// rows across 4 tables from an ungated run, some of which escaped
// test-artifact tagging entirely and sat in the CRM as live fake leads.
const KNOWN_PROD_SUPABASE_REF = 'zkhbaisggymbmurqxejk'; // escapenfly-crm production project
function assertSafeToRun() {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const pointedAtNonProdSupabase = supabaseUrl && !supabaseUrl.includes(KNOWN_PROD_SUPABASE_REF);
  const testMode = process.env.MAYA_TEST_MODE === '1';
  if (!pointedAtNonProdSupabase && !testMode) {
    console.error(
      '\nREFUSING TO START.\n' +
      `This runner sends real messages to ${API_URL},\n` +
      'which is the live production server and writes to live production Supabase.\n' +
      'Set one of the following before running:\n' +
      '  MAYA_TEST_MODE=1              (sends an x-maya-test-mode header; the server then routes\n' +
      '                                 writes to this run\'s test_-prefixed session keys and\n' +
      '                                 disables lead creation/notifications for it)\n' +
      '  SUPABASE_URL=<non-production project URL>   (informational confirmation you are not\n' +
      '                                 pointed at the production project)\n'
    );
    process.exit(1);
  }
  return testMode;
}

const TEST_MODE = assertSafeToRun();

async function sendMessage(sessionKey, message) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TEST_MODE ? { 'x-maya-test-mode': '1' } : {})
    },
    body: JSON.stringify({ phone: sessionKey, message })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function contains(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

async function runCase(testCase) {
  const sessionKey = 'test_' + testCase.id + '_' + Date.now();
  const allReplies = [];
  let lastResponse = null;

  for (const turn of testCase.customerTurns) {
    try {
      lastResponse = await sendMessage(sessionKey, turn);
      allReplies.push(lastResponse.reply || '');
      // A fallback reply means the AI call/parse itself failed server-side —
      // that's never a pass, whatever mustAsk/mustNotSay happen to check for
      // (an empty mustNotSay list, e.g., would otherwise let this through
      // silently as PASS). Stop the conversation here rather than continuing
      // to send turns against a session that's already failed.
      if (lastResponse.reply === FALLBACK_REPLY) {
        return {
          id: testCase.id, category: testCase.category, status: 'FAIL',
          failures: ['reply was the API-error fallback, not a real answer'],
          transcript: allReplies, finalLead: lastResponse?.lead, finalIntent: lastResponse?.intent
        };
      }
    } catch (e) {
      return { id: testCase.id, status: 'ERROR', error: e.message, transcript: allReplies };
    }
  }

  const fullText = allReplies.join(' \n--- \n ');
  const failures = [];

  if (testCase.expectedIntent && lastResponse?.intent &&
      lastResponse.intent.toLowerCase() !== testCase.expectedIntent.toLowerCase()) {
    failures.push(`expected intent "${testCase.expectedIntent}", got "${lastResponse.intent}"`);
  }

  // mustAsk entries are alternate phrasings of the SAME expected question —
  // any one match is a pass. (Fixed from AND to OR: "month" vs "travel" or
  // "country" vs "where" were both valid phrasings, but the AND version
  // required both literal words and false-failed on wording choice.)
  if (testCase.mustAsk && testCase.mustAsk.length && !testCase.mustAsk.some(kw => contains(fullText, kw))) {
    failures.push(`expected to ask about one of [${testCase.mustAsk.join(', ')}] — none found in replies`);
  }
  for (const kw of (testCase.mustNotAsk || [])) {
    if (contains(fullText, kw)) failures.push(`should NOT have asked about "${kw}" — found in replies`);
  }
  for (const kw of (testCase.mustNotSay || [])) {
    if (contains(fullText, kw)) failures.push(`should NOT have said "${kw}" — found in replies`);
  }
  // Checked against only the LAST reply, not the whole transcript — for
  // things that are fine earlier (e.g. the pre-switch destination) but
  // shouldn't linger after a stated change.
  for (const kw of (testCase.mustNotSayInLastReply || [])) {
    if (contains(allReplies[allReplies.length - 1] || '', kw)) failures.push(`should NOT have said "${kw}" in the final reply — found there`);
  }

  return {
    id: testCase.id,
    category: testCase.category,
    status: failures.length ? 'FAIL' : 'PASS',
    failures,
    transcript: allReplies,
    finalLead: lastResponse?.lead,
    finalIntent: lastResponse?.intent
  };
}

async function main() {
  const fs = require('fs');
  const path = require('path');
  const allCases = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-cases.json'), 'utf8'));

  const filterArg = process.argv[2];
  const cases = filterArg ? allCases.filter(c => c.id === filterArg) : allCases;
  if (!cases.length) {
    console.log(filterArg ? `No test case with id "${filterArg}"` : 'No test cases found.');
    return;
  }

  console.log(`Running ${cases.length} test case(s) against ${API_URL}\n`);
  console.log('Note: the backend may take up to ~50s to wake up on the first request if idle.\n');

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
  console.log(`RESULTS: ${pass} passed, ${fail} failed, ${error} errored — out of ${results.length}`);
  console.log('═'.repeat(60));

  const failed = results.filter(r => r.status !== 'PASS');
  if (failed.length) {
    console.log('\nDETAILS FOR FAILED/ERRORED CASES:\n');
    for (const r of failed) {
      console.log(`── ${r.id} [${r.category || '?'}] ──`);
      if (r.error) console.log(`  ERROR: ${r.error}`);
      for (const f of (r.failures || [])) console.log(`  ✗ ${f}`);
      console.log(`  Transcript:`);
      r.transcript.forEach((t, i) => console.log(`    [${i + 1}] ${t.slice(0, 200)}${t.length > 200 ? '…' : ''}`));
      console.log('');
    }
  }

  const reportPath = path.join(__dirname, 'last-run-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`Full results written to ${reportPath}`);
}

main().catch(e => { console.error('Test runner crashed:', e); process.exit(1); });
