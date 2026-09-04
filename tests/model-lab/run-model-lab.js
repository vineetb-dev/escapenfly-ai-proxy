#!/usr/bin/env node
// ═══════════════════ MAYA MODEL TEST LAB — PILOT RUNNER ═══════════════════
// Runs every scenario in scenarios.json against multiple Claude models via
// the REAL production callMayaJSON() (server.js, in-process require — not a
// mock, not a re-implementation of the prompt). External context (founder
// notes, visa intelligence, weather, forex, CRM lookups) is frozen once per
// scenario/turn and reused identically across every model — see
// lib/context-snapshot.js for exactly where and how.
//
// Fully isolated from production data:
//  - No ai_chats rows created (callMayaJSON is called directly, not via the
//    webhook — the code path that writes ai_chats lives in loadChat()/
//    mayaTurn(), neither of which this harness calls).
//  - No WhatsApp/AiSensy send — onReply is never invoked, nothing leaves
//    this process.
//  - No leads/enquiries/bookings created — mayaTurn's CRM-write logic
//    (chat.known merge -> Supabase enquiries write, team notification,
//    etc.) lives entirely after the callMayaJSON() call inside mayaTurn,
//    which this harness never calls.
//  - Synthetic, non-numeric test phone ('modeltest-<scenario id>') so
//    validPhone() rejects it and every CRM-read helper (enquiry status,
//    past destinations, customer profile) resolves empty — no real
//    customer's data is read.
//  - Results written to local JSON/Markdown files only — no Supabase writes
//    at all in V1.
//
// USAGE:  node tests/model-lab/run-model-lab.js

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const REPO_ROOT = path.join(__dirname, '../..');
const maya = require(path.join(REPO_ROOT, 'server.js'));
const { resolveFrozenContext } = require('./lib/context-snapshot');
const { scoreScenario } = require('./lib/objective-scorer');
const { estimateCost } = require('./lib/cost');
const { buildReport } = require('./lib/report');

// Approved for Phase 2: exactly these 3, Fable 5 excluded.
const MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'claude-opus-5'
];

const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'));

function gitShaOf(repoPath) {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// Lightweight, documented approximation of mayaTurn's mergeLeadData() (not
// exported — not needed for the drift-sensitive context-resolution path,
// only for the per-model "KNOWN LEAD INFO" line each model sees in its own
// system prompt). Non-empty new values overwrite; empty ones don't erase
// what was already known. Deliberately per-model — each model's own
// extraction of what it "knows" is exactly what turn-over-turn improvement
// is testing.
function mergeKnown(prevKnown, parsed) {
  const fresh = {
    name: parsed.lead?.name || '',
    destination: parsed.lead?.destination || '',
    travel_month: parsed.lead?.travel_month || '',
    pax: parsed.lead?.pax || '',
    budget: parsed.lead?.budget || '',
    type: parsed.lead?.type || '',
    travel_style: parsed.lead?.travel_style || '',
    visa_type: parsed.lead?.visa_type || ''
  };
  const merged = { ...prevKnown };
  for (const [k, v] of Object.entries(fresh)) if (v) merged[k] = v;
  return merged;
}

async function runScenario(scenario, runId) {
  const testPhone = `modeltest-${scenario.id}`;
  const perModel = {};
  for (const m of MODELS) perModel[m] = { msgs: [], known: {}, replies: [], finalIntent: null, errored: false };

  let priorKnownDestination = '';
  const turnResults = [];

  for (let turnIndex = 0; turnIndex < scenario.customerTurns.length; turnIndex++) {
    const customerMessage = scenario.customerTurns[turnIndex];

    const snapshot = await resolveFrozenContext({
      message: customerMessage,
      priorKnownDestination,
      turnIndex,
      phone: testPhone,
      syntheticReturningProfile: scenario.syntheticReturningProfile
    });

    // Snapshot audit trail — one file per scenario/turn, so it's easy to
    // confirm every model in this turn really did receive identical context.
    const snapshotDir = path.join(__dirname, 'results', runId, 'snapshots');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(
      path.join(snapshotDir, `${scenario.id}_turn${turnIndex}.json`),
      JSON.stringify(snapshot, null, 2)
    );

    // All 4 models called in parallel for this turn — they're independent
    // API calls; only the per-model history must stay sequential, which it
    // does (each model's own msgs[] array).
    await Promise.all(MODELS.map(async (model) => {
      if (perModel[model].errored) return; // a prior turn already failed for this model
      const state = perModel[model];
      const debugRef = {};
      const t0 = Date.now();
      let parsed = null;
      let errorMsg = null;
      // Mirrors mayaTurn: chat.msgs.push({role:'user', content: message}) happens
      // BEFORE callMayaJSON — the current turn's message must already be in the
      // array the model sees. Built as a local copy so state.msgs (this model's
      // committed history) is only updated on success, below.
      const msgsForThisCall = [...state.msgs, { role: 'user', content: customerMessage }];
      const knownBeforeTurn = { ...state.known }; // snapshot BEFORE this turn's merge, for the re-ask check
      try {
        parsed = await maya.callMayaJSON(
          msgsForThisCall, state.known, testPhone, 'whatsapp',
          snapshot.founderNotesList, snapshot.visaIntelList, snapshot.effectiveIntent,
          snapshot.liveWeather, snapshot.forexRate, snapshot.enquiryStatus,
          snapshot.pastDestinations, snapshot.returningProfile,
          debugRef, model
        );
      } catch (e) {
        errorMsg = e.message;
      }
      const latencyMs = Date.now() - t0;

      if (!parsed) {
        state.errored = true;
        turnResults.push({
          scenarioId: scenario.id, turnIndex, customerMessage, model,
          error: errorMsg || debugRef.errorMessage || 'callMayaJSON returned null (see server logs / debugRef)',
          latencyMs
        });
        return;
      }

      state.msgs.push({ role: 'user', content: customerMessage });
      state.msgs.push({ role: 'assistant', content: parsed.reply });
      state.known = mergeKnown(state.known, parsed);
      state.replies.push(parsed.reply || '');
      state.finalIntent = parsed.intent;

      const cost = estimateCost(debugRef.model || model, debugRef.usage);

      turnResults.push({
        scenarioId: scenario.id, turnIndex, customerMessage, model,
        reply: parsed.reply, lead: parsed.lead, intent: parsed.intent, knownBeforeTurn,
        latencyMs, usage: debugRef.usage, cost, actualModel: debugRef.model
      });
    }));

    priorKnownDestination = snapshot.newKnownDestination || priorKnownDestination;
  }

  const objectiveResults = {};
  for (const model of MODELS) {
    const state = perModel[model];
    if (state.errored) {
      objectiveResults[model] = { status: 'ERROR', failures: ['one or more turns errored — see report'] };
      continue;
    }
    const modelTurns = turnResults
      .filter(r => r.model === model && r.scenarioId === scenario.id && !r.error)
      .sort((a, b) => a.turnIndex - b.turnIndex);
    objectiveResults[model] = scoreScenario(scenario, modelTurns);
  }

  return { turnResults, objectiveResults };
}

async function main() {
  // --resume=<runId>: re-run only the scenarios that had ANY error in a
  // previous run of that same runId (e.g. after an external interruption
  // like running out of API credit mid-run), then merge into the same
  // output directory rather than starting a fresh, full-cost run.
  const resumeArg = process.argv.find(a => a.startsWith('--resume='));
  const resumeRunId = resumeArg ? resumeArg.split('=')[1] : null;
  const runId = resumeRunId || ('pilot_' + new Date().toISOString().replace(/[:.]/g, '-'));
  const promptVersion = gitShaOf(REPO_ROOT);
  const resultsDir = path.join(__dirname, 'results', runId);

  let allResults = [];
  let allObjective = {};
  let scenariosToRun = scenarios;

  if (resumeRunId) {
    const existingRaw = JSON.parse(fs.readFileSync(path.join(resultsDir, 'raw-results.json'), 'utf8'));
    const failedScenarioIds = new Set(existingRaw.filter(r => r.error).map(r => r.scenarioId));
    // Drop ALL rows (success or error) for any scenario that had any
    // failure — it gets a clean full re-run, not a partial patch — and
    // keep every row for scenarios that were already fully clean.
    allResults = existingRaw.filter(r => !failedScenarioIds.has(r.scenarioId));
    scenariosToRun = scenarios.filter(s => failedScenarioIds.has(s.id));
    const existingObjective = JSON.parse(fs.readFileSync(path.join(resultsDir, 'objective-results.json'), 'utf8'));
    for (const [id, obj] of Object.entries(existingObjective)) {
      if (!failedScenarioIds.has(id)) allObjective[id] = obj;
    }
    console.log(`Resuming run ${runId} — re-running ${scenariosToRun.length} previously-failed scenario(s): ${[...failedScenarioIds].join(', ')}\n`);
  } else {
    console.log(`Model Test Lab pilot — run ${runId}`);
  }

  console.log(`server.js @ ${promptVersion}`);
  console.log(`${scenariosToRun.length} scenarios x ${MODELS.length} models\n`);

  for (const scenario of scenariosToRun) {
    process.stdout.write(`  ${scenario.id} ... `);
    const { turnResults, objectiveResults } = await runScenario(scenario, runId);
    allResults.push(...turnResults);
    allObjective[scenario.id] = objectiveResults;
    const errCount = turnResults.filter(r => r.error).length;
    console.log(errCount ? `done (${errCount} error(s))` : 'done');
  }

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'raw-results.json'), JSON.stringify(allResults, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'objective-results.json'), JSON.stringify(allObjective, null, 2));

  const report = buildReport({
    runId, promptVersion, models: MODELS, scenarios, results: allResults, objectiveResults: allObjective
  });
  fs.writeFileSync(path.join(resultsDir, 'report.md'), report);

  console.log(`\nResults: ${resultsDir}`);
  console.log(`Report:  ${path.join(resultsDir, 'report.md')}`);
}

main().catch(e => { console.error('Model Test Lab crashed:', e); process.exit(1); });
