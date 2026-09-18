import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../bench/report.js';

const setup = { info: 'raw', strategy: 'choice' };
function suiteDecision(id, pos, kind, pick, order, pOfFirst) {
  const moves = order.map((san, i) => ({ san, uci: san, p: i === 0 ? pOfFirst : (1 - pOfFirst) / (order.length - 1) }));
  return { type: 'decision', decision_id: id, game_id: `suite:x:${pos}`, ply: 0, fen: `fen-${pos}`, setup, suite: true,
    position_id: pos, category: 'sampled', order_kind: kind, order, moves, pick, confidence: 0.5, usage: { input_tokens: 100 }, latency_ms: 100 };
}
const grade = (id, loss) => ({ type: 'grade', decision_id: id, check: false, depth: 12, pick_uci: 'x', pick_loss: loss, pick_accuracy: 80,
  pick_label: null, best_ucis: ['a'], best_cp: 0, p_best: 0.5, expected_loss: loss, spearman: 0.1, sf_bucket: 2, jev_bucket: 2 });

test('order sensitivity: pick agreement across orders and position-in-list bias', () => {
  const lines = [
    suiteDecision('1', 'p1', 'fixed', 'a', ['a', 'b', 'c', 'd', 'e'], 0.6), grade('1', 0),
    suiteDecision('2', 'p1', 'reversed', 'e', ['e', 'd', 'c', 'b', 'a'], 0.6), grade('2', 50),
    suiteDecision('3', 'p2', 'fixed', 'a', ['a', 'b', 'c', 'd', 'e'], 0.2), grade('3', 0),
    suiteDecision('4', 'p2', 'reversed', 'a', ['e', 'd', 'c', 'b', 'a'], 0.2), grade('4', 0),
  ];
  const r = buildReport(lines, null);
  const o = r.order[0];
  assert.equal(o.positions, 2);
  assert.equal(o.allSame, 0.5, 'p2 kept its pick in both orders, p1 did not');
  assert.equal(o.pairAgree, 0.5);
  assert.equal(o.lossSpread, 25);
  assert.ok(o.quintiles[0] > o.quintiles[4], 'the first-listed option got more probability here');
  assert.equal(r.suite[0].positions, 2, 'quality metrics use the fixed order only');
});
