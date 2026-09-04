// Deterministic checks only — no model calls, no semantic judgment. Anything
// requiring reading comprehension (failed adaptation, contradiction,
// unwarranted assumption, generic-non-answer-beyond-known-phrasings) belongs
// in lib/ai-triage.js instead — see the Phase 2 report for why that split is
// drawn where it is.

function contains(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// Per-field characteristic re-ask phrasings. Deliberately narrow (a few real
// phrasings per field, not an exhaustive paraphrase list) — this check is
// meant to catch the clear, mechanical case (asking again for a field
// that's already known), not every possible rewording. Broader "did she use
// the information given" judgment belongs in AI triage.
const REASK_PHRASES = {
  travel_month: ['which month', 'what month', 'when are you', 'when would you like to travel', 'when are you planning', 'when are you thinking', 'which time of year'],
  pax: ['how many people', 'how many of you', 'how many travellers', 'number of travellers', 'how many guests', 'how many passengers'],
  budget: ["what's your budget", 'what is your budget', 'budget range', 'how much are you looking to spend', 'how much is your budget'],
  name: ["what's your name", 'may i have your name', 'could i get your name', "what's your good name"],
  destination: ['which destination', 'where are you thinking of going', 'where would you like to travel', 'which country are you']
};

function lastQuestion(text) {
  const sentences = (text || '').split(/(?<=[.?!])\s+/);
  const qs = sentences.filter(s => s.trim().endsWith('?'));
  return qs.length ? qs[qs.length - 1].trim().toLowerCase() : null;
}

function questionCount(text) {
  return ((text || '').match(/\?/g) || []).length;
}

/**
 * @param {object} scenario - scenario definition (may include expectedLead)
 * @param {Array<{reply: string, lead: object, intent: string, knownBeforeTurn: object}>} modelTurns
 *        - one entry per turn, in order, for ONE model's run of this scenario
 */
function scoreScenario(scenario, modelTurns) {
  const okTurns = modelTurns.filter(t => t && typeof t.reply === 'string');
  const allReplies = okTurns.map(t => t.reply);
  const fullText = allReplies.join(' \n--- \n ');
  const finalIntent = okTurns.length ? okTurns[okTurns.length - 1].intent : null;
  const finalLead = okTurns.length ? okTurns[okTurns.length - 1].lead : null;

  const failures = [];

  // ── existing keyword-based checks ──
  if (scenario.expectedIntent && finalIntent &&
      finalIntent.toLowerCase() !== scenario.expectedIntent.toLowerCase()) {
    failures.push(`expected intent "${scenario.expectedIntent}", got "${finalIntent}"`);
  }
  if (scenario.mustAsk && scenario.mustAsk.length && !scenario.mustAsk.some(kw => contains(fullText, kw))) {
    failures.push(`expected to ask about one of [${scenario.mustAsk.join(', ')}] — none found in replies`);
  }
  for (const kw of (scenario.mustNotAsk || [])) {
    if (contains(fullText, kw)) failures.push(`should NOT have asked about "${kw}" — found in replies`);
  }
  for (const kw of (scenario.mustNotSay || [])) {
    if (contains(fullText, kw)) failures.push(`should NOT have said "${kw}" — found in replies`);
  }
  for (const kw of (scenario.mustNotSayInLastReply || [])) {
    if (contains(allReplies[allReplies.length - 1] || '', kw)) failures.push(`should NOT have said "${kw}" in the final reply — found there`);
  }

  // ── NEW: re-asked-already-known-field ──
  for (let i = 0; i < okTurns.length; i++) {
    const turn = okTurns[i];
    const known = turn.knownBeforeTurn || {};
    for (const [field, phrases] of Object.entries(REASK_PHRASES)) {
      if (known[field] && phrases.some(p => contains(turn.reply, p))) {
        failures.push(`turn ${i + 1}: re-asked for "${field}" (already known: "${known[field]}") — matched phrase in reply`);
      }
    }
  }

  // ── NEW: exact repeated trailing question across consecutive turns ──
  for (let i = 1; i < okTurns.length; i++) {
    const prevQ = lastQuestion(okTurns[i - 1].reply);
    const curQ = lastQuestion(okTurns[i].reply);
    if (prevQ && curQ && prevQ === curQ) {
      failures.push(`turn ${i + 1}: repeats turn ${i}'s trailing question verbatim: "${curQ}"`);
    }
  }

  // ── NEW: question count (stacked-question proxy) ──
  okTurns.forEach((turn, i) => {
    const qc = questionCount(turn.reply);
    if (qc >= 3) failures.push(`turn ${i + 1}: ${qc} question marks in one reply — possible stacked-question pattern`);
  });

  // ── NEW: lead-field accuracy against expectedLead ──
  if (scenario.expectedLead && finalLead) {
    for (const [field, expectedVal] of Object.entries(scenario.expectedLead)) {
      const actualVal = (finalLead[field] || '').toString().trim();
      const expected = expectedVal.toString().trim();
      if (!actualVal) {
        failures.push(`lead.${field}: expected "${expected}", got empty`);
      } else if (!fuzzyMatch(actualVal, expected)) {
        failures.push(`lead.${field}: expected "${expected}", got "${actualVal}"`);
      }
    }
  }

  return { status: failures.length ? 'FAIL' : 'PASS', failures };
}

// Loose match — case-insensitive substring either direction. Real lead
// values legitimately vary in formatting ("2 lakh" vs "₹2,00,000" vs
// "200000") more than a strict equality check should penalize; this catches
// genuine extraction misses (wrong destination, dropped field) without
// false-failing on formatting differences.
function fuzzyMatch(actual, expected) {
  const a = actual.toLowerCase().replace(/[₹,]/g, '');
  const e = expected.toLowerCase().replace(/[₹,]/g, '');
  return a.includes(e) || e.includes(a);
}

module.exports = { scoreScenario, REASK_PHRASES, lastQuestion, questionCount };
