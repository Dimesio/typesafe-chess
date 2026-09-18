// Setup names, shared by the server, the UI, the dashboard and the bench. A setup's name says
// exactly what Jev was shown, so stats never pool different setups: "raw-choice",
// "assisted-noul", and "assisted-choice-f2" for assisted with foresight level 2.

export const INFO = ['raw', 'assisted'];
export const STRATEGIES = ['choice', 'noul'];

/**
 * Foresight levels (assisted only). Each level adds one fact about the opponent's reply to
 * every move it applies to, on top of the level below, so level N against N − 1 measures that
 * one fact. server/position.js documents the facts.
 */
export const FORESIGHT = [
  { level: 0, fact: null, title: 'No foresight: the assisted facts as in M5' },
  { level: 1, fact: 'after_their_best_capture', title: "Level 1: what you win or lose after the opponent's best capture" },
  { level: 2, fact: 'allows_mate', title: 'Level 2: adds whether the opponent can then mate in one' },
  { level: 3, fact: 'allows_fork', title: 'Level 3: adds whether the opponent can then attack two of your pieces at once' },
];
export const MAX_FORESIGHT = FORESIGHT.length - 1;

/** The foresight level that applies: always 0 for raw. */
export const foresightOf = s => (s.info === 'assisted' ? Number(s.foresight ?? 0) : 0);

export const setupName = s => `${s.info}-${s.strategy}${foresightOf(s) ? `-f${foresightOf(s)}` : ''}`;

/** "assisted-choice-f2" → { info: 'assisted', strategy: 'choice', foresight: 2 }. */
export function parseSetupName(name) {
  const m = /^(raw|assisted)-(choice|noul)(?:-f(\d+))?$/.exec(name);
  if (!m) throw new Error(`Unknown setup "${name}". Use info-strategy with an optional -fN, e.g. assisted-choice-f2.`);
  const foresight = Number(m[3] ?? 0);
  if (m[3] !== undefined && m[1] === 'raw') throw new Error(`"${name}": foresight applies to assisted setups only.`);
  if (foresight < 1 && m[3] !== undefined) throw new Error(`"${name}": write level 0 without -f0.`);
  if (foresight > MAX_FORESIGHT) throw new Error(`"${name}": foresight goes from 0 to ${MAX_FORESIGHT}.`);
  return { info: m[1], strategy: m[2], foresight };
}
