const MODEL_LABELS = {
  'claude-haiku-4-5-20251001': 'HAIKU 4.5',
  'claude-sonnet-5': 'SONNET 5',
  'claude-opus-5': 'OPUS 5',
  'claude-fable-5': 'FABLE 5'
};

function fmtUsd(n) {
  return '$' + n.toFixed(4);
}

function buildReport({ runId, promptVersion, models, scenarios, results, objectiveResults }) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`# Maya Model Test Lab — Pilot Report`);
  push(``);
  push(`Run ID: \`${runId}\`  `);
  push(`Prompt version (server.js git SHA): \`${promptVersion}\`  `);
  push(`Generated: ${new Date().toISOString()}  `);
  push(`Models: ${models.map(m => `\`${m}\``).join(', ')}`);
  push(``);
  push(`---`);
  push(``);

  // ── Cost & latency summary ──
  push(`## Cost & latency summary`);
  push(``);
  push(`| Model | Calls | Errors | Avg latency (ms) | Total input tok | Total output tok | Total cost |`);
  push(`|---|---|---|---|---|---|---|`);
  let grandTotal = 0;
  for (const model of models) {
    const rows = results.filter(r => r.model === model);
    const okRows = rows.filter(r => !r.error);
    const errCount = rows.length - okRows.length;
    const avgLatency = okRows.length ? Math.round(okRows.reduce((s, r) => s + r.latencyMs, 0) / okRows.length) : 0;
    const totalIn = okRows.reduce((s, r) => s + (r.usage?.input_tokens || 0) + (r.usage?.cache_creation_input_tokens || 0) + (r.usage?.cache_read_input_tokens || 0), 0);
    const totalOut = okRows.reduce((s, r) => s + (r.usage?.output_tokens || 0), 0);
    const totalCost = okRows.reduce((s, r) => s + (r.cost?.usdCost || 0), 0);
    grandTotal += totalCost;
    push(`| ${MODEL_LABELS[model] || model} | ${rows.length} | ${errCount} | ${avgLatency} | ${totalIn} | ${totalOut} | ${fmtUsd(totalCost)} |`);
  }
  push(`| **TOTAL** | | | | | | **${fmtUsd(grandTotal)}** |`);
  push(``);
  push(`---`);
  push(``);

  // ── Objective test results ──
  push(`## Objective test results (keyword/heuristic — same checks as tests/run-tests.js, not an LLM judge)`);
  push(``);
  push(`| Scenario | ${models.map(m => MODEL_LABELS[m] || m).join(' | ')} |`);
  push(`|---|${models.map(() => '---').join('|')}|`);
  for (const scenario of scenarios) {
    const cells = models.map(m => {
      const r = objectiveResults[scenario.id]?.[m];
      if (!r) return '?';
      if (r.status === 'PASS') return 'PASS';
      return `FAIL (${r.failures.length})`;
    });
    push(`| ${scenario.id} | ${cells.join(' | ')} |`);
  }
  push(``);
  for (const scenario of scenarios) {
    for (const m of models) {
      const r = objectiveResults[scenario.id]?.[m];
      if (r && r.status === 'FAIL') {
        push(`- **${scenario.id} / ${MODEL_LABELS[m] || m}**: ${r.failures.join('; ')}`);
      }
    }
  }
  push(``);
  push(`---`);
  push(``);

  // ── Human evaluation checklist (blank — fill in while reading below) ──
  push(`## Human evaluation — read the conversations below and judge each response against:`);
  push(``);
  push(`1. Did Maya understand the customer?`);
  push(`2. Did she use the information already given?`);
  push(`3. Did the recommendation materially improve after each new answer?`);
  push(`4. Did she demonstrate genuine travel judgment?`);
  push(`5. Did she give a specific, useful insight?`);
  push(`6. Did she avoid generic OTA-style responses?`);
  push(`7. Did she ask the right NEXT question?`);
  push(`8. Did she avoid unnecessary questions?`);
  push(`9. Did she sound like an experienced EscapeNFly consultant?`);
  push(`10. Did she remain factually safe and avoid manufactured confidence?`);
  push(`11. Would you be comfortable sending this response to a real customer?`);
  push(`12. Would this response increase the probability of conversion?`);
  push(``);
  push(`Not averaged into one score — read them side by side per scenario below.`);
  push(``);
  push(`---`);
  push(``);

  // ── Scenario-by-scenario conversations ──
  push(`## Scenario-by-scenario conversations`);
  push(``);
  for (const scenario of scenarios) {
    push(`### \`${scenario.id}\` — ${scenario.category}`);
    push(``);
    push(`**Notes:** ${scenario.notes || scenario.description}`);
    push(``);
    const scenarioResults = results.filter(r => r.scenarioId === scenario.id);
    const maxTurn = Math.max(...scenarioResults.map(r => r.turnIndex));
    for (let t = 0; t <= maxTurn; t++) {
      const turnResults = scenarioResults.filter(r => r.turnIndex === t);
      const customerMessage = turnResults[0]?.customerMessage || '(missing)';
      push(`**Turn ${t + 1}** — Customer: "${customerMessage}"`);
      push(``);
      for (const model of models) {
        const r = turnResults.find(x => x.model === model);
        if (!r) { push(`- **${MODEL_LABELS[model] || model}**: (no data)`); continue; }
        if (r.error) {
          push(`- **${MODEL_LABELS[model] || model}** — ERROR: ${r.error}`);
          push(``);
          continue;
        }
        const inTok = (r.usage?.input_tokens || 0) + (r.usage?.cache_creation_input_tokens || 0) + (r.usage?.cache_read_input_tokens || 0);
        const outTok = r.usage?.output_tokens || 0;
        push(`- **${MODEL_LABELS[model] || model}** _(${r.latencyMs}ms, ${inTok} in / ${outTok} out tok, ${fmtUsd(r.cost?.usdCost || 0)})_`);
        push(`  > ${(r.reply || '').replace(/\n/g, '\n  > ')}`);
        push(``);
      }
    }
    push(`---`);
    push(``);
  }

  return lines.join('\n');
}

module.exports = { buildReport, MODEL_LABELS };
