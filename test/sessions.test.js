import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSession } from '../public/sessions.js';

const W = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const setup = (info, strategy) => ({ info, strategy, shuffle: true, includeFen: false });
let t = 0;
const at = () => `2026-09-18T10:00:${String(t++).padStart(2, '0')}.000Z`;

function decision(id, game, extra = {}) {
  return { type: 'decision', decision_id: id, game_id: game, ply: 0, fen: W, setup: setup('assisted', 'choice'),
    players: { w: 'jev', b: 'stockfish' }, confidence: 0.5, usage: { input_tokens: 1000 }, latency_ms: 150, mock: false, logged_at: at(), ...extra };
}
function grade(id, loss, extra = {}) {
  return { type: 'grade', decision_id: id, check: false, depth: 12, pick_uci: 'e2e4', pick_loss: loss, pick_accuracy: 90,
    pick_label: loss >= 200 ? 'blunder' : null, best_ucis: loss === 0 ? ['e2e4'] : ['d2d4'], p_best: 0.4, expected_loss: loss + 10,
    spearman: 0.3, sf_bucket: 2, jev_bucket: 2, best_rank: 1, logged_at: at(), ...extra };
}
const end = (game, result, extra = {}) => ({ type: 'game_end', game_id: game, result, start: 'standard', overrides: 0, cuts: 0,
  jev_color: 'w', opponent: { kind: 'stockfish', rating: 1500, rating_source: 'calibrated' }, logged_at: at(), ...extra });

test('counting rules: overrides, discards, mock, and one decision per position (played, else latest)', () => {
  const lines = [
    decision('a1', 'g1'), grade('a1', 50),
    decision('a2', 'g1'), grade('a2', 10), // second attempt, same position: the played one wins
    { type: 'move', game_id: 'g1', ply: 0, by: 'jev', decision_id: 'a1' },
    decision('b1', 'g2', { ply: 1 }), grade('b1', 300), { type: 'move', game_id: 'g2', ply: 1, by: 'override', decision_id: 'b1' },
    decision('c1', 'g2', { ply: 2, discarded: true }), grade('c1', 0),
    decision('m1', 'g3', { mock: true }), grade('m1', 0),
    decision('s1', 'g1', { shadow: true, setup: setup('raw', 'noul'), confidence: null }), grade('s1', 400),
    grade('a1', 999, { check: true, depth: 16 }), // a deeper check never replaces the grade
  ];
  const s = buildSession(lines);
  const ac = s.setups.find(x => x.name === 'assisted-choice');
  assert.equal(ac.decisions, 1);
  assert.equal(ac.summary.avgLoss, 50, 'the played attempt counts, not the latest');
  const rn = s.setups.find(x => x.name === 'raw-noul');
  assert.equal(rn.kinds.shadow, 1);
  assert.equal(buildSession(lines, { includeExtra: false }).setups.find(x => x.name === 'raw-noul'), undefined);
  assert.equal(buildSession(lines, { includeMock: true }).setups.find(x => x.name === 'assisted-choice').decisions, 2);
});

test('performance Elo only from eligible games, per setup', () => {
  const lines = [];
  const game = (id, result, extra = {}) => {
    lines.push(decision(`${id}-d`, id), grade(`${id}-d`, 20), end(id, result, extra));
  };
  game('w1', '1-0');
  game('l1', '0-1');
  game('d1', '1/2-1/2');
  game('custom', '1-0', { start: 'custom' });
  game('over', '1-0', { overrides: 1 });
  game('cut', '1-0', { cuts: 1 });
  game('unrated', '1-0', { opponent: { kind: 'stockfish', rating: null } });
  game('bounded', '1-0', { opponent: { kind: 'stockfish', rating: 1200, rating_bound: 'upper' } });
  lines.push({ type: 'players', game_id: 'w1' }); // changed mid-game: no longer eligible
  const s = buildSession(lines);
  const perf = s.setups.find(x => x.name === 'assisted-choice').vsStockfish;
  assert.deepEqual([perf.games, perf.wins, perf.draws, perf.losses], [2, 0, 1, 1]);
  assert.equal(s.ineligibleGames, 6);
  assert.ok(perf.elo.elo < 1500);
});

test('mixed setups in one game make it ineligible; black Jev scores from its side', () => {
  const lines = [
    decision('x1', 'mix'), decision('x2', 'mix', { ply: 2, setup: setup('raw', 'choice') }), end('mix', '1-0'),
    decision('y1', 'blk', { fen: W.replace(' w ', ' b '), players: { w: 'stockfish', b: 'jev' } }), end('blk', '0-1', { jev_color: 'b' }),
  ];
  const s = buildSession(lines);
  assert.equal(s.perfGames.length, 1);
  assert.equal(s.perfGames[0].score, 1);
});

test('confidence bins and cost', () => {
  const lines = [decision('c1', 'g', { confidence: 0.1 }), grade('c1', 100), decision('c2', 'g', { ply: 2, confidence: 0.95 }), grade('c2', 0)];
  const ac = buildSession(lines).setups[0];
  assert.equal(ac.confidenceBins[0].avgLoss, 100);
  assert.equal(ac.confidenceBins[4].avgLoss, 0);
  assert.ok(Math.abs(ac.cost - 2000 * 0.042 / 1e6) < 1e-12);
});
