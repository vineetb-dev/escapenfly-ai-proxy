#!/usr/bin/env node
// ═══════════════════ AI-TRIAGE VALIDATION — against the 8 real pilot scenarios ═══════════════════
// Runs the flag-only judge against the ALREADY-COLLECTED pilot transcripts
// (tests/model-lab/results/pilot_2026-08-13T14-22-36-742Z/) — no new
// comparison-generation calls, only new judge calls. Approved as a
// validation step per the Phase 2 decisions (run before spending on the
// full 65-scenario triage).
//
// NOTE ON SCOPE: this validation pass includes all 4 original pilot models
// (Haiku/Sonnet/Opus/Fable), NOT just the 3 approved for the real
// comparison run, specifically because the known issues to test recall
// against include one from Fable ("you could even do both comfortably").
// This means Fable is, for this one validation pass only, judging a
// transcript that includes its own reply (blind-labeled, but still).
// The REAL 65-scenario triage (if approved later) will only ever have
// Haiku/Sonnet/Opus as labeled candidates — Fable never appears as a
// candidate there, so this one-time overlap doesn't carry forward.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const { runTriage, assignBlindLabels } = require('./lib/ai-triage');

const PILOT_RUN_DIR = path.join(__dirname, 'results/pilot_2026-08-13T14-22-36-742Z');
const results = JSON.parse(fs.readFileSync(path.join(PILOT_RUN_DIR, 'raw-results.json'), 'utf8'));
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'))
  .filter(s => s.id.startsWith('pilot_'));

const ALL_PILOT_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'];

function frozenContextSummaryFor(scenarioId) {
  const snapPath = path.join(PILOT_RUN_DIR, 'snapshots', `${scenarioId}_turn0.json`);
  if (!fs.existsSync(snapPath)) return null;
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const parts = [];
  if (snap.founderNotesList && snap.founderNotesList.length) {
    parts.push('founder_notes: ' + JSON.stringify(snap.founderNotesList).slice(0, 1500));
  }
  if (snap.visaIntelList && snap.visaIntelList.length) {
    parts.push('visa_intelligence: ' + JSON.stringify(snap.visaIntelList).slice(0, 1500));
  }
  return parts.join('\n') || null;
}

async function main() {
  const allFlags = []; // { scenarioId, label, realModel, ...flag }

  for (const scenario of scenarios) {
    const labelToModel = assignBlindLabels(ALL_PILOT_MODELS);
    const modelToLabel = Object.fromEntries(Object.entries(labelToModel).map(([l, m]) => [m, l]));

    const blindTranscripts = {};
    for (const model of ALL_PILOT_MODELS) {
      const label = modelToLabel[model];
      const turns = results
        .filter(r => r.scenarioId === scenario.id && r.model === model && !r.error)
        .sort((a, b) => a.turnIndex - b.turnIndex)
        .map(r => ({ customerMessage: r.customerMessage, reply: r.reply }));
      if (turns.length) blindTranscripts[label] = turns;
    }

    const frozenSummary = frozenContextSummaryFor(scenario.id);
    process.stdout.write(`  ${scenario.id} ... `);
    const judged = await runTriage(scenario, blindTranscripts, frozenSummary);
    if (judged.error) {
      console.log('JUDGE ERROR:', judged.error);
      continue;
    }
    console.log(`${judged.flags.length} flag(s)`);
    for (const f of judged.flags) {
      allFlags.push({ scenarioId: scenario.id, realModel: labelToModel[f.label], ...f });
    }
    // Persist the label mapping too, so it's auditable which real model each flag was about.
    fs.mkdirSync(path.join(__dirname, 'results/triage-validation'), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, 'results/triage-validation', `${scenario.id}.json`),
      JSON.stringify({ labelToModel, flags: judged.flags, usage: judged.usage }, null, 2)
    );
  }

  fs.writeFileSync(
    path.join(__dirname, 'results/triage-validation/all-flags.json'),
    JSON.stringify(allFlags, null, 2)
  );
  console.log(`\nTotal flags across all pilot scenarios: ${allFlags.length}`);
  console.log('Written to tests/model-lab/results/triage-validation/');
}

main().catch(e => { console.error('Triage validation crashed:', e); process.exit(1); });
