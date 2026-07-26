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

const API_URL = 'https://escapenfly-ai-proxy.onrender.com/webhook/website-chat';

async function sendMessage(sessionKey, message) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  for (const kw of (testCase.mustAsk || [])) {
    if (!contains(fullText, kw)) failures.push(`expected to ask about "${kw}" — not found anywhere in replies`);
  }
  for (const kw of (testCase.mustNotAsk || [])) {
    if (contains(fullText, kw)) failures.push(`should NOT have asked about "${kw}" — found in replies`);
  }
  for (const kw of (testCase.mustNotSay || [])) {
    if (contains(fullText, kw)) failures.push(`should NOT have said "${kw}" — found in replies`);
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
