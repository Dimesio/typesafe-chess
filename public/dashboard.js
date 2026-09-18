// Session dashboard: every logged decision and game (runs/*.jsonl), per setup.
import { buildSession } from './sessions.js';
import { moveQualityElo } from './elo.js';
import { EVAL_LEVELS, UNDECIDED_CP } from './grading.js';

const $ = id => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v, digits = 0, suffix = '') => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(digits)}${suffix}`);
const SERIES = ['#6d5ce7', '#1f8a4c', '#c4561d', '#1c6fd1', '#a8740a', '#c42b2b'];

let data = { lines: [], files: [] };
let calibration = null;

function eloCell(e) {
  if (!e) return '—';
  if (e.bound) return `${e.bound === 'below' ? '<' : e.bound === 'above' ? '>' : e.bound} ${Math.round(e.value)}`;
  const range = e.low !== undefined && e.low !== null ? ` [${Math.round(e.low)}–${Math.round(e.high)}]` : '';
  return `${Math.round(e.elo ?? e.value)}${range}`;
}

function perfCell(p) {
  if (!p.games) return '—';
  return `${eloCell(p.elo)} · ${p.wins}/${p.draws}/${p.losses}`;
}

function render() {
  const includeMock = $('f-mock').checked;
  const includeExtra = $('f-extra').checked;
  const depth = $('f-depth').value ? Number($('f-depth').value) : null;
  const s = buildSession(data.lines, { includeMock, includeExtra, depth });

  const depths = [...new Set(data.lines.filter(l => l.type === 'grade').map(l => l.depth))].sort((a, b) => a - b);
  const sel = $('f-depth');
  const current = sel.value;
  sel.replaceChildren(new Option('any', ''), ...depths.map(d => new Option(String(d), String(d))));
  sel.value = current;

  $('summary').textContent = `${data.files.length} log file${data.files.length === 1 ? '' : 's'} · ${s.counts.decisions} decisions counted, ${s.counts.graded} graded · `
    + `${s.perfGames.length} games count toward performance Elo, ${s.ineligibleGames} don't.`;

  // Per-setup table.
  const table = $('setups');
  table.replaceChildren();
  const head = table.insertRow();
  const cols = ['setup', 'decisions', 'graded', 'accuracy', 'avg cp loss', '?? rate', 'top-1', 'avg P(best)', 'exp. loss', 'conf ↔ loss r',
    'own eval agrees', 'est. Elo (moves)', 'perf. Elo vs Stockfish · W/D/L', 'perf. Elo vs you', 'latency', 'tokens in', 'cost'];
  head.append(...cols.map(c => el('th', { textContent: c })));
  for (const x of s.setups) {
    const sm = x.summary;
    const depthOk = calibration && x.depths.length === 1 && x.depths[0] === calibration.depth && calibration.band === UNDECIDED_CP;
    const mq = depthOk && sm.undecided.n ? moveQualityElo(sm.undecided.avgLoss, sm.undecided.lossSE, calibration) : null;
    const tr = table.insertRow();
    const cells = [
      x.name,
      `${x.decisions}${x.kinds.compare || x.kinds.shadow ? ` (${x.kinds.main} played, ${x.kinds.compare} compare, ${x.kinds.shadow} shadow)` : ''}`,
      String(x.graded),
      fmt(sm.accuracy, 0, '%'),
      sm.avgLoss === null ? '—' : `${Math.round(sm.avgLoss)}${sm.lossSE ? ` ± ${Math.round(1.96 * sm.lossSE)}` : ''}`,
      sm.n ? fmt((sm.blunders / sm.n) * 100, 0, '%') : '—',
      fmt(sm.top1 === null ? null : sm.top1 * 100, 0, '%'),
      fmt(sm.avgPBest === null ? null : sm.avgPBest * 100, 0, '%'),
      fmt(sm.avgExpectedLoss),
      fmt(sm.confLossR, 2),
      fmt(sm.evalAgreement === null ? null : sm.evalAgreement * 100, 0, '%'),
      !calibration ? 'uncalibrated' : !depthOk ? `needs depth ${calibration.depth}` : mq ? `${eloCell({ ...mq, elo: mq.value })} (n ${sm.undecided.n})` : '—',
      perfCell(x.vsStockfish),
      perfCell(x.vsHuman),
      `${Math.round(x.latencyMs ?? 0)} ms`,
      String(Math.round(x.inputTokens ?? 0)),
      `$${x.cost.toFixed(4)}`,
    ];
    tr.append(...cells.map((c, i) => el('td', { textContent: c, className: i === 0 ? 'left' : '' })));
  }
  if (!s.setups.length) {
    const tr = table.insertRow();
    tr.append(el('td', { textContent: 'No decisions yet with these filters.', colSpan: cols.length, className: 'left muted' }));
  }

  renderConfidence(s);
  renderLadder(s);
  renderConfusions(s);
}

/** Line chart: x = confidence bin, y = average cp loss, one line per Choice setup. */
function renderConfidence(s) {
  const box = $('conf-chart');
  const W = box.clientWidth || 520;
  const H = 220;
  const pad = { l: 44, r: 12, t: 10, b: 28 };
  const series = s.setups.filter(x => x.name.endsWith('choice') && x.confidenceBins.some(b => b.n));
  const maxLoss = Math.max(50, ...series.flatMap(x => x.confidenceBins.map(b => b.avgLoss ?? 0)));
  const x = c => pad.l + c * (W - pad.l - pad.r);
  const y = v => pad.t + (1 - v / maxLoss) * (H - pad.t - pad.b);
  const parts = [];
  for (let k = 0; k <= 4; k++) {
    const v = (maxLoss / 4) * k;
    parts.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--border)"/>`,
      `<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" style="fill:var(--muted);font-size:11px">${Math.round(v)}</text>`);
  }
  for (let k = 0; k <= 5; k++) {
    parts.push(`<text x="${x(k / 5)}" y="${H - 8}" text-anchor="middle" style="fill:var(--muted);font-size:11px">${(k / 5).toFixed(1)}</text>`);
  }
  series.forEach((sr, i) => {
    const pts = sr.confidenceBins.filter(b => b.n).map(b => [x((b.lo + b.hi) / 2), y(b.avgLoss)]);
    const color = SERIES[i % SERIES.length];
    parts.push(`<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts.map(p => p.join(',')).join(' ')}"/>`);
    sr.confidenceBins.filter(b => b.n).forEach(b => parts.push(`<circle cx="${x((b.lo + b.hi) / 2)}" cy="${y(b.avgLoss)}" r="${Math.min(7, 2 + Math.sqrt(b.n))}" fill="${color}"><title>${esc(sr.name)}: confidence ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}, ${b.n} moves, avg loss ${Math.round(b.avgLoss)} cp</title></circle>`));
  });
  box.innerHTML = series.length
    ? `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Average cp loss by confidence">${parts.join('')}</svg>`
    : '<p class="muted small">Needs graded Choice decisions.</p>';
  $('conf-legend').replaceChildren(...series.map((sr, i) => el('span', {}, el('i', { className: 'sw', style: `background:${SERIES[i % SERIES.length]}` }), sr.name)));
}

/** Opponent rating by game, marker by Jev's result. */
function renderLadder(s) {
  const box = $('ladder-chart');
  const games = [...s.perfGames].filter(g => g.kind === 'stockfish').sort((a, b) => (a.logged_at ?? '').localeCompare(b.logged_at ?? ''));
  if (!games.length) {
    box.innerHTML = '<p class="muted small">No eligible Jev vs Stockfish games yet. Turn on the ladder in the Stockfish settings.</p>';
    $('ladder-note').textContent = '';
    return;
  }
  const W = box.clientWidth || 520;
  const H = 220;
  const pad = { l: 48, r: 12, t: 10, b: 24 };
  const lo = Math.min(...games.map(g => g.opp)) - 100;
  const hi = Math.max(...games.map(g => g.opp)) + 100;
  const x = i => pad.l + (games.length === 1 ? 0.5 : i / (games.length - 1)) * (W - pad.l - pad.r);
  const y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const parts = [];
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) / 4) * k;
    parts.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--border)"/>`,
      `<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" style="fill:var(--muted);font-size:11px">${Math.round(v)}</text>`);
  }
  parts.push(`<polyline fill="none" style="stroke:var(--muted)" stroke-width="1.5" points="${games.map((g, i) => `${x(i)},${y(g.opp)}`).join(' ')}"/>`);
  games.forEach((g, i) => {
    const fill = g.score === 1 ? 'var(--accent)' : g.score === 0.5 ? 'var(--surface-2)' : 'var(--surface)';
    parts.push(`<circle cx="${x(i)}" cy="${y(g.opp)}" r="5" style="fill:${fill};stroke:var(--accent)" stroke-width="2"><title>${esc(g.setup)} vs ${esc(g.opp)} (${esc(g.source)}): ${esc(g.score)}</title></circle>`);
  });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Ladder history">${parts.join('')}</svg>`;
  const sources = [...new Set(games.map(g => g.source))].join(', ');
  $('ladder-note').textContent = `${games.length} eligible games · opponent ratings: ${sources}.`;
}

function renderConfusions(s) {
  const short = ['losing', 'worse', 'equal', 'better', 'winning'];
  const blocks = s.setups.filter(x => x.summary.evalAgreement !== null).map(x => {
    const table = el('table', { className: 'confusion' });
    const head = table.insertRow();
    head.append(el('th', { textContent: 'Stockfish ↓ / Jev →' }), ...short.map(t => el('th', { textContent: t })));
    x.summary.confusion.forEach((row, i) => {
      const tr = table.insertRow();
      tr.append(el('th', { textContent: short[i] }), ...row.map((v, j) => el('td', { textContent: v || '', className: i === j ? 'diag' : '' })));
    });
    return el('div', {}, el('div', { className: 'side-head', textContent: `${x.name} · ${fmt(x.summary.evalAgreement * 100, 0, '%')} agree` }), table);
  });
  $('confusions').replaceChildren(...(blocks.length ? blocks : [el('p', { className: 'muted small', textContent: `No graded decisions with a position_eval yet. Levels: ${EVAL_LEVELS.join(', ')}.` })]));
}

function renderCalibration() {
  if (!calibration) return;
  $('cal-meta').textContent = `${calibration.games} games · ${calibration.nodes} nodes per move · graded at depth ${calibration.depth} · ${calibration.created.slice(0, 10)}`;
  const table = el('table', { className: 'compare' });
  const head = table.insertRow();
  head.append(...['rung', 'rating', '± (1 SE)', 'score', `avg cp loss (undecided, ±${calibration.band ?? '?'} cp)`, 'nominal'].map(t => el('th', { textContent: t })));
  for (const r of calibration.rungs) {
    const tr = table.insertRow();
    const rating = `${r.bound === 'upper' ? '≤ ' : r.bound === 'lower' ? '≥ ' : ''}${r.rating}`;
    tr.append(...[r.label, rating, r.bound ? 'bound' : r.se ?? '—', `${r.score}/${r.games}`, `${r.acpl ?? '—'} (${r.acplN})`, r.nominal ?? '—']
      .map((c, i) => el('td', { textContent: String(c), className: i === 0 ? 'left' : '' })));
  }
  const box = $('calibration');
  box.className = 'table-wrap';
  box.replaceChildren(table, el('p', { className: 'muted small stats-note', textContent: calibration.anchor }));
}

function download() {
  const includeMock = $('f-mock').checked;
  const text = data.lines.filter(l => includeMock || !l.mock).map(({ file, ...l }) => JSON.stringify(l)).join('\n');
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'application/x-ndjson' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `typesafe-chess-session-${new Date().toISOString().slice(0, 10)}.jsonl` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function load() {
  const [runs, cal] = await Promise.all([
    fetch('/api/runs').then(r => r.json()),
    fetch('/api/calibration').then(r => (r.ok ? r.json() : null)),
  ]);
  data = runs;
  calibration = cal;
  renderCalibration();
  render();
}

for (const id of ['f-mock', 'f-extra', 'f-depth']) $(id).onchange = render;
$('reload').onclick = load;
$('download').onclick = download;
window.addEventListener('resize', render);
load().catch(err => { $('summary').textContent = `Couldn't load the logs: ${err.message}`; });
