// Setup names, shared by the server, the UI, the dashboard and the bench. A setup's name says
// exactly what Jev was shown, so stats never pool different setups: "raw-choice",
// "assisted-noul", "assisted-choice-f2" for assisted with foresight level 2,
// "assisted-noul-f1-L2live" for foresight 1 with lessons level 2 from the live lessons, and
// "assisted-noul-f1-L2b3" for the same from frozen lesson book 3.

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

/**
 * Lesson levels (assisted only, PLAN.md §3 "Lessons"). They add what Jev's graded failures
 * taught, from the live lessons (setup.book 'live') or a frozen book (a number), so Stockfish's
 * grades reach Jev's input through them. Each level adds one fact on top of the level below;
 * level 0 is the setup without lessons, unchanged. server/lessons.js documents the facts.
 */
export const LESSONS = [
  { level: 0, fact: null, title: 'No lessons' },
  { level: 1, fact: 'lesson', title: 'Level 1: warns about moves that match a pattern that was often a mistake in past games' },
  { level: 2, fact: 'last_time_here', title: 'Level 2: adds memory: moves chosen before in this exact position that were mistakes' },
];
export const MAX_LESSONS = LESSONS.length - 1;

/** The foresight level that applies: always 0 for raw. */
export const foresightOf = s => (s.info === 'assisted' ? Number(s.foresight ?? 0) : 0);

/** The lesson level that applies: 0 for raw, and for setups logged before lessons existed. */
export const lessonsOf = s => (s.info === 'assisted' ? Number(s.lessons ?? 0) : 0);

export const setupName = s => {
  const f = foresightOf(s);
  const l = lessonsOf(s);
  const book = s.book === 'live' ? 'live' : `b${s.book}`;
  return `${s.info}-${s.strategy}${f ? `-f${f}` : ''}${l ? `-L${l}${book}` : ''}`;
};

/**
 * "assisted-choice-f2-L1live" → { info: 'assisted', strategy: 'choice', foresight: 2, lessons: 1, book: 'live' };
 * "…-L1b3" has book: 3.
 */
export function parseSetupName(name) {
  const m = /^(raw|assisted)-(choice|noul)(?:-f(\d+))?(?:-L(\d+)(?:b(\d+)|(live)))?$/.exec(name);
  if (!m) throw new Error(`Unknown setup "${name}". Use info-strategy with an optional -fN and -LNlive or -LNbM, e.g. assisted-choice-f2 or assisted-noul-f1-L2live.`);
  const foresight = Number(m[3] ?? 0);
  if (m[3] !== undefined && m[1] === 'raw') throw new Error(`"${name}": foresight applies to assisted setups only.`);
  if (foresight < 1 && m[3] !== undefined) throw new Error(`"${name}": write level 0 without -f0.`);
  if (foresight > MAX_FORESIGHT) throw new Error(`"${name}": foresight goes from 0 to ${MAX_FORESIGHT}.`);
  const out = { info: m[1], strategy: m[2], foresight };
  if (m[4] === undefined) return out;
  const lessons = Number(m[4]);
  const book = m[6] ? 'live' : Number(m[5]);
  if (m[1] === 'raw') throw new Error(`"${name}": lessons apply to assisted setups only.`);
  if (lessons < 1) throw new Error(`"${name}": write lessons level 0 without -L0.`);
  if (lessons > MAX_LESSONS) throw new Error(`"${name}": lessons go from 0 to ${MAX_LESSONS}.`);
  if (book !== 'live' && book < 1) throw new Error(`"${name}": lesson books are numbered from 1.`);
  return { ...out, lessons, book };
}
