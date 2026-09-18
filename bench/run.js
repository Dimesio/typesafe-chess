// Headless bench entry point.
//   Calibration:  npm run bench -- --calibrate [--quick] [--per-pair 12] [--depth 12] [--nodes 150000]
//                                  [--samples 120] [--prefilter 600] [--workers N] [--max-plies 300] [--out path]
//   Jev games:    npm run bench -- --games 20 [--setups raw-choice,assisted-choice,raw-noul,assisted-noul]
//                                  [--chains 2] [--depth 12] [--max-plies 300] [--policy argmax]
//   Suite:        npm run bench -- --suite bench/positions.json [--sample 100] [--shuffles 3] [--setups …]
//   Deeper check: npm run bench -- --check 60 [--check-depth 16] --from runs/bench-….jsonl
//   Report:       npm run bench -- --report runs/bench-a.jsonl runs/bench-b.jsonl …
//   Everything:   npm run bench -- --all  (suite, games, check and report)
// Common: [--rps 8] [--concurrency 8] [--workers 8] [--mock]. Uses the live API when a key exists.
// Setup names are info-strategy with an optional foresight level (assisted only): assisted-choice-f2.
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calibrate } from './calibrate.js';
import { parseSetupName } from '../public/setups.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    calibrate: { type: 'boolean', default: false },
    quick: { type: 'boolean', default: false },
    'per-pair': { type: 'string' },
    depth: { type: 'string' },
    nodes: { type: 'string' },
    samples: { type: 'string' },
    prefilter: { type: 'string' },
    workers: { type: 'string' },
    'max-plies': { type: 'string' },
    out: { type: 'string' },
    games: { type: 'string' },
    setups: { type: 'string', default: 'raw-choice,assisted-choice,raw-noul,assisted-noul' },
    chains: { type: 'string', default: '2' },
    policy: { type: 'string', default: 'argmax' },
    suite: { type: 'string' },
    sample: { type: 'string' },
    shuffles: { type: 'string', default: '3' },
    check: { type: 'string' },
    'check-depth': { type: 'string', default: '16' },
    from: { type: 'string', multiple: true },
    report: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    rps: { type: 'string', default: '8' },
    concurrency: { type: 'string', default: '8' },
    mock: { type: 'boolean', default: false },
  },
});

const num = v => (v === undefined ? undefined : Number(v));
const log = (...a) => console.log(...a);

async function readLines(paths) {
  const out = [];
  for (const p of paths) {
    for (const t of (await readFile(resolve(p), 'utf8')).split('\n')) if (t.trim()) out.push(JSON.parse(t));
  }
  return out;
}

async function loadCalibration() {
  try { return JSON.parse(await readFile(new URL('./elo-calibration.json', import.meta.url), 'utf8')); } catch { return null; }
}

if (values.calibrate) {
  await calibrate({
    quick: values.quick,
    perPair: num(values['per-pair']) ?? (values.quick ? 2 : undefined),
    depth: num(values.depth),
    nodes: num(values.nodes),
    samples: num(values.samples) ?? (values.quick ? 10 : undefined),
    prefilter: num(values.prefilter) ?? (values.quick ? 40 : undefined),
    workers: num(values.workers),
    maxPlies: num(values['max-plies']),
    ...(values.out && { out: pathToFileURL(resolve(values.out)) }),
  });
  process.exit(0);
}

if (values.mock) process.env.TYPESAFE_MOCK = '1';
const { createJev } = await import('../server/typesafe.js');
const { GradePool, logWriter, rateLimiter, stamp } = await import('./common.js');
const { runGames } = await import('./games.js');
const { runSuite, sampleSuite } = await import('./suite.js');
const { runCheck } = await import('./check.js');
const { buildReport, reportMarkdown } = await import('./report.js');

const calibration = await loadCalibration();
const depth = num(values.depth) ?? calibration?.depth ?? 12;
const setups = values.setups.split(',');
setups.forEach(parseSetupName); // fail before any request on a bad name
const written = [];

async function withJev(fn) {
  const jev = createJev();
  log(`Jev: ${jev.mock ? `MOCK (${jev.reason})` : `live (${jev.reason})`} · grading depth ${depth}${calibration ? ` · calibration ${calibration.created.slice(0, 10)}` : ' · no calibration'}`);
  const grader = new GradePool(num(values.workers) ?? 8);
  try {
    return await fn({ jev, grader, limiter: rateLimiter(num(values.rps)) });
  } finally {
    grader.close();
  }
}

if (values.suite || values.all) {
  await withJev(async ({ jev, grader, limiter }) => {
    const out = await logWriter('bench-suite');
    written.push(out.path);
    const curated = JSON.parse(await readFile(resolve(values.suite ?? 'bench/positions.json'), 'utf8'));
    const sampled = num(values.sample) ?? (values.all ? 100 : 0);
    const positions = [...curated, ...(sampled && calibration?.raw ? await sampleSuite(sampled, { calibrationRaw: calibration.raw }) : [])];
    await runSuite({ jev, grader, limiter, write: out.write, positions, setups, shuffles: num(values.shuffles), depth,
      concurrency: num(values.concurrency), runId: stamp(), log });
    await out.flush();
    log(`Wrote ${out.path}`);
  });
}

if (values.games || values.all) {
  await withJev(async ({ jev, grader, limiter }) => {
    const out = await logWriter('bench-games');
    written.push(out.path);
    await runGames({ jev, grader, limiter, write: out.write, setups, games: num(values.games) ?? 20, chains: num(values.chains),
      depth, calibration, maxPlies: num(values['max-plies']) ?? 300, policy: values.policy, log });
    await out.flush();
    log(`Wrote ${out.path}`);
  });
}

if (values.check || values.all) {
  const sources = values.from ?? [...written];
  const checkDepth = num(values['check-depth']);
  const grader = new GradePool(num(values.workers) ?? 8);
  try {
    const out = await logWriter('bench-check');
    written.push(out.path);
    await runCheck({ lines: await readLines(sources), depth: checkDepth, sample: num(values.check) ?? 60, grader, write: out.write, log });
    await out.flush();
    log(`Wrote ${out.path}`);
  } finally {
    grader.close();
  }
}

if (values.report || values.all) {
  const sources = positionals.length ? positionals : written;
  const r = buildReport(await readLines(sources), calibration);
  const md = reportMarkdown(r);
  const name = `runs/summary-${stamp()}`;
  await writeFile(resolve(`${name}.json`), `${JSON.stringify({ sources, report: r }, null, 2)}\n`);
  await writeFile(resolve(`${name}.md`), `${md}\n`);
  log(`\n${md}\nWrote ${name}.json and ${name}.md`);
}

if (!values.suite && !values.games && !values.check && !values.report && !values.all) {
  console.error('Nothing to do. See the usage at the top of bench/run.js.');
  process.exitCode = 1;
}
