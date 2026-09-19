// The lessons, seen from the command line (PLAN.md §3, "Lessons"). Nothing here is needed for
// learning: the live lessons learn inside the server and the bench as grades are logged.
//   npm run lessons                 Catches up with runs/ and writes a report on the live lessons
//                                   to lessons/live.md.
//   npm run lessons -- --freeze     Also saves them as the next frozen book (lessons/book-vN.json
//                                   and .md), for a setup that must not change during a run (-LNbN).
//   npm run lessons -- --list       Lists the frozen books.
// Options: [--min-support 10] [--min-lift 2] [--min-precision 0.5] [--usually-at 0.75] change the
// promotion rules for this report or frozen book only (the server always uses the defaults).
// Pattern analysis is cached in lessons/cache/ (gitignored).
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderReport } from '../server/mine.js';
import { createLearner } from '../server/learner.js';
import { LESSONS_DIR, loadBook, versions } from '../server/book.js';

const { values } = parseArgs({
  options: {
    freeze: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    'min-support': { type: 'string' },
    'min-lift': { type: 'string' },
    'min-precision': { type: 'string' },
    'usually-at': { type: 'string' },
  },
});

const inLessons = name => new URL(name, LESSONS_DIR);
const shown = url => fileURLToPath(url).replace(`${process.cwd()}/`, '');

if (values.list) {
  const books = versions();
  if (!books.length) console.log('No frozen books. The live lessons need none: use -L1live or -L2live.');
  for (const v of books) {
    const b = loadBook(v);
    const moves = Object.values(b.memory).reduce((n, m) => n + Object.keys(m).length, 0);
    console.log(`book v${v} (${b.created}): ${b.patterns.filter(p => p.promoted).map(p => p.id).join(', ') || 'no patterns'}; memory of ${moves} moves`);
  }
  process.exit(0);
}

const num = k => (values[k] === undefined ? undefined : Number(values[k]));
const rules = Object.fromEntries(Object.entries({
  minSupport: num('min-support'), minLift: num('min-lift'), minPrecision: num('min-precision'), usuallyAt: num('usually-at'),
}).filter(([, v]) => v !== undefined));
const learner = createLearner({ rules, log: msg => console.log(msg) });
await learner.catchUp();
const live = learner.book();
const promoted = live.patterns.filter(p => p.promoted).map(p => p.id);
console.log(`Live lessons: learned from ${live.rev} graded decisions. Promoted: ${promoted.join(', ') || 'none'}. Memory of ${Object.keys(live.memory).length} positions.`);
await writeFile(inLessons('live.md'), renderReport(live, learner.report()));
console.log(`Report: ${shown(inLessons('live.md'))}`);

if (values.freeze) {
  const books = versions();
  const parent = books.length ? loadBook(books.at(-1)) : null;
  const version = (books.at(-1) ?? 0) + 1;
  const { rev: _rev, heldOutKeys: _keys, ...book } = live;
  Object.assign(book, { version, parent: parent?.version ?? null, memory: structuredClone(live.memory) });
  await writeFile(inLessons(`book-v${version}.json`), `${JSON.stringify(book, null, 1)}\n`);
  await writeFile(inLessons(`book-v${version}.md`), renderReport(book, learner.report(), parent));
  loadBook(version); // checks the file
  console.log(`Frozen as lesson book v${version}: ${shown(inLessons(`book-v${version}.json`))}. Setups: assisted-…-L1b${version}, -L2b${version}.`);
}
