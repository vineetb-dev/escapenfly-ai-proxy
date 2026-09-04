#!/usr/bin/env node
// ═══════════════════ AI TRIAGE — full run, over a completed comparison run's output ═══════════════════
// Reads a run-model-lab.js output directory (raw-results.json + per-turn
// snapshots, already saved one file per scenario per turn) and runs the
// flag-only judge scenario-by-scenario, with the PER-TURN context fix
// (see lib/ai-triage.js) — the pilot-validation script's bug (turn-0-only
// context reused for every turn) does not apply here: snapshots are read
// per turnIndex, matching how they were actually written.
//
// USAGE: node tests/model-lab/run-triage.js <runId>

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const { runTriage, assignBlindLabels } = require('./lib/ai-triage');

const runId = process.argv[2];
if (!runId) { console.error('Usage: node run-triage.js <runId>'); process.exit(1); }

const RUN_DIR = path.join(__dirname, 'results', runId);
const results = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'raw-results.json'), 'utf8'));
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'));

// Only the 3 approved models are ever candidates — Fable 5 is the judge and
// is never itself a labeled transcript in this real run (unlike the
// pilot-validation pass, which deliberately included Fable to test recall
// against a known Fable issue).
const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'];

function perTurnContextSummaries(scenarioId, numTurns) {
  const summaries = [];
  for (let t = 0; t < numTurns; t++) {
    const snapPath = path.join(RUN_DIR, 'snapshots', `${scenarioId}_turn${t}.json`);
    if (!fs.existsSync(snapPath)) { summaries.push(null); continue; }
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    const parts = [];
    if (snap.founderNotesList && snap.founderNotesList.length) {
      parts.push('founder_notes: ' + JSON.stringify(snap.founderNotesList).slice(0, 1200));
    }
    if (snap.visaIntelList && snap.visaIntelList.length) {
      parts.push('visa_intelligence: ' + JSON.stringify(snap.visaIntelList).slice(0, 1200));
    }
    summaries.push(parts.join('\n') || null);
  }
  return summaries;
}

async function main() {
  const allFlags = [];
  let totalUsageCost = 0;
  console.log(`AI triage — run ${runId}, judge model claude-fable-5, candidates: ${MODELS.join(', ')}\n`);

  for (const scenario of scenarios) {
    const labelToModel = assignBlindLabels(MODELS);
    const modelToLabel = Object.fromEntries(Object.entries(labelToModel).map(([l, m]) => [m, l]));

    const blindTranscripts = {};
    for (const model of MODELS) {
      const label = modelToLabel[model];
      const turns = results
        .filter(r => r.scenarioId === scenario.id && r.model === model && !r.error)
        .sort((a, b) => a.turnIndex - b.turnIndex)
        .map(r => ({ customerMessage: r.customerMessage, reply: r.reply }));
      if (turns.length) blindTranscripts[label] = turns;
    }
    if (!Object.keys(blindTranscripts).length) {
      console.log(`  ${scenario.id} ... skipped (no successful turns for any model)`);
      continue;
    }

    const contexts = perTurnContextSummaries(scenario.id, scenario.customerTurns.length);
    process.stdout.write(`  ${scenario.id} ... `);
    const judged = await runTriage(scenario, blindTranscripts, contexts);
    if (judged.error) { console.log('JUDGE ERROR:', judged.error); continue; }
    console.log(`${judged.flags.length} flag(s)`);
    for (const f of judged.flags) {
      allFlags.push({ scenarioId: scenario.id, realModel: labelToModel[f.label], ...f });
    }
    if (judged.usage) {
      const inTok = (judged.usage.input_tokens || 0) + (judged.usage.cache_creation_input_tokens || 0) + (judged.usage.cache_read_input_tokens || 0);
      const outTok = judged.usage.output_tokens || 0;
      totalUsageCost += (inTok / 1e6 * 10) + (outTok / 1e6 * 50); // Fable pricing
    }

    const triageDir = path.join(RUN_DIR, 'triage');
    fs.mkdirSync(triageDir, { recursive: true });
    fs.writeFileSync(
      path.join(triageDir, `${scenario.id}.json`),
      JSON.stringify({ labelToModel, flags: judged.flags, usage: judged.usage }, null, 2)
    );
  }

  fs.writeFileSync(path.join(RUN_DIR, 'triage', 'all-flags.json'), JSON.stringify(allFlags, null, 2));
  console.log(`\nTotal flags: ${allFlags.length}`);
  console.log(`Total triage cost: $${totalUsageCost.toFixed(4)}`);
  console.log(`Written to ${path.join(RUN_DIR, 'triage')}`);
}

main().catch(e => { console.error('Triage run crashed:', e); process.exit(1); });
