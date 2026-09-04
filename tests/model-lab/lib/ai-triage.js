// ═══════════════════ AI TRIAGE — FLAG-ONLY, NEVER SCORES OR RANKS ═══════════════════
// A separate judge pass over already-collected transcripts. Structurally
// incapable of scoring or ranking: the output schema has no field that
// could hold a score, a rank, a "winner", or a recommendation — only a list
// of typed, turn-anchored, evidence-quoting flags. This is enforced by the
// tool schema itself (forced tool-use, matching this project's existing
// callMayaJSON pattern), not by a prompt instruction that could drift.
//
// Judge model: claude-fable-5, deliberately EXCLUDED from the 3-model
// comparison set (Haiku/Sonnet/Opus) approved for Phase 2. This sidesteps
// the self-judging bias question entirely — the judge is never evaluating
// its own output, and structurally cannot develop a "prefer myself" pattern
// since it never appears as a labeled candidate. Reassess if the compared
// model set ever changes to include Fable 5.
//
// Blind labeling: the judge sees "Model A / Model B / Model C" — never real
// model names — so even a self-preference bias would have nothing to latch
// onto. The mapping (label -> real model) is generated per scenario and
// revealed only in the harness's own output, never sent to the judge.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const JUDGE_MODEL = 'claude-fable-5';

const TRIAGE_TOOL = {
  name: 'triage_flags',
  description: 'Report ONLY concrete, evidence-quoting flags found in the transcripts. Never rank, score, or recommend a model.',
  input_schema: {
    type: 'object',
    properties: {
      flags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Which blind-labeled model this flag is about — e.g. "A", "B", or "C".' },
            type: {
              type: 'string',
              enum: ['failed_adaptation', 'contradiction', 'unwarranted_assumption', 'generic_non_answer']
            },
            turnIndex: { type: 'integer', description: '0-based turn index where this occurs.' },
            evidence: { type: 'string', description: 'Exact quote from that model\'s reply at that turn.' },
            explanation: { type: 'string', description: 'One sentence, grounded in what changed between turns or what was/was not present in the frozen context — not a subjective quality judgment.' }
          },
          required: ['label', 'type', 'turnIndex', 'evidence', 'explanation']
        }
      }
    },
    required: ['flags']
  }
};

// perTurnContextSummaries: array indexed by turnIndex, one summary per turn
// (NOT one summary for the whole scenario — a bug in the earlier pilot
// validation pass used only turn 0's context for every turn, which produced
// false "unwarranted_assumption" flags on any scenario where the resolved
// destination changes mid-conversation, e.g. a second country introduced
// partway through. Fixed here: context is shown per-turn, explicitly
// labeled with which turn it applies to, so a later turn's genuinely
// different (and equally real) context isn't mistaken for missing data.
function buildJudgePrompt(scenario, blindTranscripts, perTurnContextSummaries) {
  const transcriptText = Object.entries(blindTranscripts).map(([label, turns]) => {
    const turnsText = turns.map((t, i) =>
      `Turn ${i}:\nCustomer: ${t.customerMessage}\nModel ${label}: ${t.reply}`
    ).join('\n\n');
    return `=== Model ${label} ===\n${turnsText}`;
  }).join('\n\n');

  const contextText = (perTurnContextSummaries || []).map((summary, i) =>
    `Turn ${i} frozen context: ${summary || '(no founder_notes or verified visa_intelligence was available for this turn — any specific factual claim beyond common knowledge is ungrounded)'}`
  ).join('\n\n');

  return `You are auditing conversation transcripts for a travel-consultant AI named Maya. Three anonymized models (labeled A, B, C) each handled the SAME customer scenario, turn by turn, with IDENTICAL frozen context AT EACH TURN — any difference between the models at a given turn is purely a difference in how each model reasoned, not what data it had. The frozen context CAN legitimately differ ACROSS turns within the same scenario (e.g. the customer introduces a second destination partway through, which resolves its own separate, equally real context) — do not treat a later turn's different context as evidence the earlier turn's context should still apply, and do not flag a claim as unsupported without checking the SPECIFIC turn's own context below, not just turn 0's.

SCENARIO: ${scenario.description}

FROZEN CONTEXT PER TURN (identical across all three models at each given turn):
${contextText}

TRANSCRIPTS:
${transcriptText}

Your ONLY job is to find and report concrete instances of these four flag types, each anchored to an exact quote:
- failed_adaptation: the customer gave new information in a later turn, but the model's recommendation did not actually change in substance — only acknowledged the new information in passing.
- contradiction: the model said something in one turn that conflicts with something it said in an earlier turn.
- unwarranted_assumption: the model stated a specific fact (a number, a visa rule, a claim about the destination) that is not supported by the frozen context above and is not common knowledge.
- generic_non_answer: the model's reply, especially to a comparison or decision question, doesn't actually help the customer decide — vague reassurance instead of a real differentiated answer.

Do not report stylistic preferences, tone, warmth, or which model you personally find more helpful — only concrete, quotable instances of the four types above. If a model has no issues, report no flags for it. Do not rank, score, or state which model is best — you have no field to do so and should not attempt it in the explanation text either.`;
}

/**
 * @param {object} scenario
 * @param {object} blindTranscripts - { A: [{customerMessage, reply}, ...], B: [...], C: [...] }
 * @param {string[]} perTurnContextSummaries - one context summary PER TURN
 *        (index = turnIndex), not one summary for the whole scenario — see
 *        the note above buildJudgePrompt for why this distinction matters.
 * @returns {Promise<{flags: Array}|null>}
 */
async function runTriage(scenario, blindTranscripts, perTurnContextSummaries) {
  const prompt = buildJudgePrompt(scenario, blindTranscripts, perTurnContextSummaries);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
      tools: [TRIAGE_TOOL],
      tool_choice: { type: 'tool', name: 'triage_flags' }
    })
  });
  const d = await r.json();
  if (!r.ok) {
    return { error: `HTTP ${r.status}: ${d?.error?.message || JSON.stringify(d).slice(0, 300)}` };
  }
  const toolBlock = (d.content || []).find(b => b.type === 'tool_use' && b.name === 'triage_flags');
  if (!toolBlock) return { error: 'No triage_flags tool_use block in judge response' };
  return { flags: toolBlock.input.flags || [], usage: d.usage, model: d.model };
}

// Assigns blind labels (A/B/C...) to real model IDs, shuffled per scenario
// so there's no fixed positional pattern the judge could latch onto even
// unintentionally.
function assignBlindLabels(modelIds) {
  const letters = ['A', 'B', 'C', 'D', 'E'];
  const shuffled = [...modelIds].sort(() => Math.random() - 0.5);
  const labelToModel = {};
  shuffled.forEach((m, i) => { labelToModel[letters[i]] = m; });
  return labelToModel;
}

module.exports = { runTriage, assignBlindLabels, TRIAGE_TOOL, JUDGE_MODEL };
