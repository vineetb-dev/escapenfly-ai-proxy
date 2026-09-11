/**
 * canton.test.js — sanity checks for canton-product.js
 * Run with: node tests/canton.test.js   (no test framework needed)
 *
 * These are the cases that would actually cost money if they broke:
 * a Phase 3 buyer sold a Phase 1 seat, or Maya still selling after 15 Oct.
 *
 * canton-product.js lives in the repo root, next to server.js/CHAT_CORE —
 * this file lives in tests/, hence '../canton-product' below (only the
 * relative path changed from the original root-level copy; the checks
 * themselves are untouched).
 */

'use strict';

const assert = require('assert');
const { isCantonEnquiry, matchPhase, CANTON_KNOWLEDGE } = require('../canton-product');

const BEFORE = new Date('2026-09-20T10:00:00Z');
const AFTER = new Date('2026-10-20T10:00:00Z');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

console.log('\nisCantonEnquiry');
t('matches the word canton', () =>
  assert.strictEqual(isCantonEnquiry({ text: 'tell me about canton fair', now: BEFORE }), true));
t('matches guangzhou', () =>
  assert.strictEqual(isCantonEnquiry({ text: 'Guangzhou trip kitna ka hai', now: BEFORE }), true));
t('matches on campaign code with no keyword', () =>
  assert.strictEqual(isCantonEnquiry({ text: 'hi', campaignCode: 'CANTON-OCT26', now: BEFORE }), true));
t('matches on broadcast code with no keyword', () =>
  assert.strictEqual(isCantonEnquiry({ text: 'more info', broadcastCode: 'CANTON', now: BEFORE }), true));
t('matches on ad referral text', () =>
  assert.strictEqual(isCantonEnquiry({ text: 'Hello! Can I get more info on this?',
    adReferral: '140th CANTON FAIR — GUANGZHOU', now: BEFORE }), true));
t('ignores an unrelated holiday enquiry', () =>
  assert.strictEqual(isCantonEnquiry({ text: 'bali honeymoon package', now: BEFORE }), false));
t('goes quiet after bookings close', () =>
  assert.strictEqual(isCantonEnquiry({ text: 'canton fair', now: AFTER }), false));
t('stays quiet after close even with the campaign code', () =>
  assert.strictEqual(isCantonEnquiry({ text: 'hi', campaignCode: 'CANTON-OCT26', now: AFTER }), false));

console.log('\nmatchPhase');
t('LED lights -> Phase 1', () =>
  assert.strictEqual(matchPhase('we import LED lighting').phase, 1));
t('furniture -> Phase 2', () =>
  assert.strictEqual(matchPhase('we deal in furniture').phase, 2));
t('shoes -> Phase 3', () =>
  assert.strictEqual(matchPhase('shoes and footwear').phase, 3));
t('Phase 3 is flagged as having no package', () =>
  assert.strictEqual(matchPhase('garments and clothing').hasPackage, false));
t('Phase 1 travel dates are the travel dates, not the fair dates', () =>
  assert.strictEqual(matchPhase('hardware and tools').travelDates, '13-19 October 2026 (6N/7D)'));
t('unknown product returns null rather than guessing', () =>
  assert.strictEqual(matchPhase('handmade incense sticks'), null));

console.log('\nknowledge block');
t('never contains a price figure', () =>
  assert.ok(!/1,?65,?000|₹\s?\d/.test(CANTON_KNOWLEDGE), 'a price leaked into the prompt'));
t('carries the no-price rule', () =>
  assert.ok(/NEVER quote, estimate, confirm or hint at a price/.test(CANTON_KNOWLEDGE)));
t('carries the no-entry-promise rule', () =>
  assert.ok(/never promise entry approval/i.test(CANTON_KNOWLEDGE)));
t('routes visa questions to Damini', () =>
  assert.ok(/Damini/.test(CANTON_KNOWLEDGE)));

console.log(`\n${pass} checks passed\n`);
