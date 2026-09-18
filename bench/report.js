// Bench report: games (performance and move-quality Elo per setup), the position suite (quality
// on fixed positions, order stability and position-in-list bias), and the deeper check.
// Pure over logged lines, so it can re-summarize any set of runs/*.jsonl.
import { buildSession, gradeFromLine, setupKey, COST_PER_INPUT_TOKEN } from '../public/sessions.js';
import { summarize, UNDECIDED_CP } from '../public/grading.js';
import { moveQualityElo } from '../public/elo.js';

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const f = (v, d = 0, suffix = '') => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(d)}${suffix}`);
const pctf = v => f(v === null || v === undefined ? null : v * 100, 0, '%');

function eloText(e) {
  if (!e) return '—';
  if (e.bound) return `${e.bound === 'below' ? '<' : '>'} ${Math.round(e.value)}`;
  const v = e.elo ?? e.value;
  return `${Math.round(v)}${e.low !== undefined && e.low !== null ? ` [${Math.round(e.low)}–${Math.round(e.high)}]` : ''}`;
}

function moveElo(summary, calibration, depths) {
  if (!calibration || calibration.band !== UNDECIDED_CP || depths.some(d => d !== calibration.depth)) return null;
  if (!summary.undecided.n) return null;
  return moveQualityElo(summary.undecided.avgLoss, summary.undecided.lossSE, calibration);
}

export function buildReport(lines, calibration) {
  const out = { games: [], suite: [], order: [], curated: [], check: null };

  // Games: everything that isn't the suite.
  const gameLines = lines.filter(l => !l.suite);
  // A mock-only run (a smoke test) still gets a report; mixed runs leave mock out.
  const decisions = lines.filter(l => l.type === 'decision');
  const mockOnly = decisions.length > 0 && decisions.every(l => l.mock);
  const session = buildSession(gameLines, { includeMock: mockOnly });
  for (const s of session.setups) {
    const decisionsInGames = s.kinds.main;
    if (!decisionsInGames) continue;
    out.games.push({
      setup: s.name, decisions: s.decisions, graded: s.graded, summary: s.summary,
      moveElo: moveElo(s.summary, calibration, s.depths), perf: s.vsStockfish,
      latencyMs: s.latencyMs, inputTokens: s.inputTokens, cost: s.cost,
    });
  }

  // Suite.
  const grades = new Map(lines.filter(l => l.type === 'grade' && !l.check).map(l => [l.decision_id, l]));
  const suite = lines.filter(l => l.type === 'decision' && l.suite && grades.has(l.decision_id));
  const bySetup = new Map();
  for (const d of suite) {
    const k = setupKey(d.setup);
    if (!bySetup.has(k)) bySetup.set(k, []);
    bySetup.get(k).push(d);
  }
  for (const [name, list] of [...bySetup].sort(([a], [b]) => a.localeCompare(b))) {
    const fixed = list.filter(d => d.order_kind === 'fixed');
    const items = fixed.map(d => ({ grade: gradeFromLine(grades.get(d.decision_id)), confidence: d.confidence }));
    const summary = summarize(items);
    const depths = [...new Set(fixed.map(d => grades.get(d.decision_id).depth))];
    const tokens = list.map(d => d.usage?.input_tokens ?? 0);
    out.suite.push({
      setup: name, positions: fixed.length, summary, moveElo: moveElo(summary, calibration, depths),
      latencyMs: mean(list.map(d => d.latency_ms ?? 0)), inputTokens: mean(tokens),
      cost: tokens.reduce((a, b) => a + b, 0) * COST_PER_INPUT_TOKEN,
    });

    // Order stability: same position, different option orders.
    const byPos = new Map();
    for (const d of list) {
      if (!byPos.has(d.position_id)) byPos.set(d.position_id, []);
      byPos.get(d.position_id).push(d);
    }
    let allSame = 0;
    const pairAgree = [];
    const pBestSpread = [];
    const lossSpread = [];
    for (const ds of byPos.values()) {
      const picks = ds.map(d => d.pick);
      if (new Set(picks).size === 1) allSame += 1;
      for (let i = 0; i < picks.length; i++) for (let j = i + 1; j < picks.length; j++) pairAgree.push(picks[i] === picks[j] ? 1 : 0);
      const pb = ds.map(d => grades.get(d.decision_id).p_best);
      const ls = ds.map(d => grades.get(d.decision_id).pick_loss);
      pBestSpread.push(Math.max(...pb) - Math.min(...pb));
      lossSpread.push(Math.max(...ls) - Math.min(...ls));
    }
    // Position in the list: p × n by quintile of where the move was listed (1.0 = no effect).
    const quint = [0, 0, 0, 0, 0].map(() => []);
    for (const d of list) {
      const n = d.order.length;
      const pBySan = new Map(d.moves.map(m => [m.san, m.p]));
      d.order.forEach((san, idx) => quint[Math.min(4, Math.floor((5 * idx) / n))].push((pBySan.get(san) ?? 0) * n));
    }
    out.order.push({
      setup: name, positions: byPos.size, variants: Math.round(list.length / Math.max(1, byPos.size)),
      allSame: allSame / Math.max(1, byPos.size), pairAgree: mean(pairAgree),
      pBestSpread: mean(pBestSpread), lossSpread: mean(lossSpread), quintiles: quint.map(q => mean(q)),
    });
  }

  // Curated positions (fixed order): pick and loss per setup.
  const curated = suite.filter(d => d.category !== 'sampled' && d.order_kind === 'fixed');
  const byPosition = new Map();
  for (const d of curated) {
    if (!byPosition.has(d.position_id)) byPosition.set(d.position_id, { position: d.position_id, category: d.category, bySetup: {} });
    const g = grades.get(d.decision_id);
    byPosition.get(d.position_id).bySetup[setupKey(d.setup)] = { pick: d.pick, loss: g.pick_loss, label: g.pick_label, best: g.best_ucis };
  }
  out.curated = [...byPosition.values()];

  // Deeper check.
  const checks = lines.filter(l => l.type === 'deep_check');
  if (checks.length) {
    const undecided = checks.filter(c => Math.abs(c.deep_best_cp) < UNDECIDED_CP);
    out.check = {
      n: checks.length,
      depth: checks[0].depth,
      baseDepth: checks[0].base_depth,
      bestAgrees: mean(checks.map(c => (c.best_agrees ? 1 : 0))),
      baseLoss: mean(checks.map(c => c.base_loss)),
      deepLoss: mean(checks.map(c => c.deep_loss)),
      baseLossUndecided: mean(undecided.map(c => c.base_loss)),
      deepLossUndecided: mean(undecided.map(c => c.deep_loss)),
      labelChanged: mean(checks.map(c => (c.base_label === c.deep_label ? 0 : 1))),
      meanAbsLossChange: mean(checks.map(c => Math.abs(c.deep_loss - c.base_loss))),
      msPerPosition: mean(checks.map(c => c.ms)),
    };
  }
  out.session = { perfGames: session.perfGames.length, ineligible: session.ineligibleGames };
  return out;
}

/** The report as Markdown tables. */
export function reportMarkdown(r) {
  const md = [];
  if (r.games.length) {
    md.push('### Games vs the Stockfish ladder', '',
      '| setup | games (W/D/L) | performance Elo | move-quality Elo | accuracy | avg cp loss | undecided cp loss (n) | ?? rate | top-1 | avg P(best) | conf ↔ loss r | own eval agrees | latency | tokens in | cost |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const g of r.games) {
      const s = g.summary;
      const p = g.perf;
      md.push(`| ${g.setup} | ${p.games} (${p.wins}/${p.draws}/${p.losses}) | ${eloText(p.elo)} | ${eloText(g.moveElo)} | ${pctf(s.accuracy / 100)} | ${f(s.avgLoss)} | ${f(s.undecided.avgLoss)} (${s.undecided.n}) | ${s.n ? pctf(s.blunders / s.n) : '—'} | ${pctf(s.top1)} | ${pctf(s.avgPBest)} | ${f(s.confLossR, 2)} | ${pctf(s.evalAgreement)} | ${f(g.latencyMs)} ms | ${f(g.inputTokens)} | $${g.cost.toFixed(3)} |`);
    }
    md.push('');
  }
  if (r.suite.length) {
    md.push('### Position suite (fixed option order)', '',
      '| setup | positions | move-quality Elo | avg cp loss | undecided cp loss (n) | top-1 | avg P(best) | exp. cp loss | ?? rate | conf ↔ loss r | own eval agrees | latency | tokens in |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of r.suite) {
      const s = x.summary;
      md.push(`| ${x.setup} | ${x.positions} | ${eloText(x.moveElo)} | ${f(s.avgLoss)} | ${f(s.undecided.avgLoss)} (${s.undecided.n}) | ${pctf(s.top1)} | ${pctf(s.avgPBest)} | ${f(s.avgExpectedLoss)} | ${s.n ? pctf(s.blunders / s.n) : '—'} | ${f(s.confLossR, 2)} | ${pctf(s.evalAgreement)} | ${f(x.latencyMs)} ms | ${f(x.inputTokens)} |`);
    }
    md.push('', '### Order sensitivity (same position, different option orders)', '',
      '| setup | positions × orders | same pick in every order | pairwise pick agreement | avg P(best) spread | avg cp-loss spread | p × n by list position (1st → 5th fifth) |',
      '|---|---|---|---|---|---|---|');
    for (const o of r.order) {
      md.push(`| ${o.setup} | ${o.positions} × ${o.variants} | ${pctf(o.allSame)} | ${pctf(o.pairAgree)} | ${pctf(o.pBestSpread)} | ${f(o.lossSpread)} | ${o.quintiles.map(q => f(q, 2)).join(' / ')} |`);
    }
    md.push('');
  }
  if (r.curated.length) {
    const setups = [...new Set(r.curated.flatMap(c => Object.keys(c.bySetup)))].sort();
    md.push('### Curated positions (fixed order): pick and cp loss', '', `| position | ${setups.join(' | ')} |`, `|---|${setups.map(() => '---').join('|')}|`);
    for (const c of r.curated) {
      md.push(`| ${c.position} | ${setups.map(s => { const x = c.bySetup[s]; return x ? `${x.pick} (${Math.round(x.loss)}${x.label ? `, ${x.label}` : ''})` : '—'; }).join(' | ')} |`);
    }
    md.push('');
  }
  if (r.check) {
    const c = r.check;
    md.push('### Deeper check', '',
      `${c.n} positions re-graded at depth ${c.depth} (base depth ${c.baseDepth}), ${f(c.msPerPosition / 1000, 1)} s each:`,
      `- the depth-${c.baseDepth} best move agrees with depth ${c.depth} in ${pctf(c.bestAgrees)} of positions`,
      `- Jev's average pick loss: ${f(c.baseLoss)} cp at depth ${c.baseDepth} → ${f(c.deepLoss)} cp at depth ${c.depth} (undecided positions: ${f(c.baseLossUndecided)} → ${f(c.deepLossUndecided)})`,
      `- mean |change| in the pick's loss: ${f(c.meanAbsLossChange)} cp; the pick's label changed in ${pctf(c.labelChanged)}`, '');
  }
  return md.join('\n');
}
