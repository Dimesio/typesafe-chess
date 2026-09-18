// Ask Jev about one position with one or more setups and print the distributions.
//   node scripts/ask.js --fen "<fen>" [--setups raw-choice,assisted-choice,raw-noul,assisted-noul]
//                       [--history "e4 e5 Nf3"] [--no-shuffle] [--include-fen] [--top 8] [--json]
// Uses the live API when a key is present (TYPESAFE_MOCK=1 for the mock).
import { parseArgs } from 'node:util';
import { createJev } from '../server/typesafe.js';
import { askJev } from '../server/jev.js';

const { values } = parseArgs({
  options: {
    fen: { type: 'string', default: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
    setups: { type: 'string', default: 'raw-choice,assisted-choice,raw-noul,assisted-noul' },
    history: { type: 'string', default: '' },
    'no-shuffle': { type: 'boolean', default: false },
    'include-fen': { type: 'boolean', default: false },
    top: { type: 'string', default: '8' },
    json: { type: 'boolean', default: false },
  },
});

const jev = createJev();
const history = values.history.split(/\s+/).filter(Boolean);
const pct = p => `${(p * 100).toFixed(1)}%`;
const all = [];

console.log(`${jev.mock ? 'MOCK' : 'live'} | ${values.fen}`);
for (const name of values.setups.split(',')) {
  const [info, strategy] = name.split('-');
  const setup = { info, strategy, shuffle: !values['no-shuffle'], includeFen: values['include-fen'] };
  try {
    const res = await askJev({ fen: values.fen, history, setup }, { jev });
    all.push({ name, ...res });
    const top = res.moves.slice(0, Number(values.top))
      .map(m => `${m.san} ${pct(m.p)}${m.noul !== undefined ? ` (yes ${m.noul})` : ''}`).join(', ');
    const pe = res.positionEval;
    console.log(`\n${name}: pick ${res.pick.san}` +
      `${res.confidence !== null ? `, confidence ${res.confidence}` : ''}` +
      ` | ${res.latencyMs} ms, ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens | ${res.model}`);
    console.log(`  top: ${top}`);
    console.log(`  zero-probability moves: ${res.moves.filter(m => m.p === 0).length} of ${res.moves.length}`);
    if (pe) console.log(`  position_eval: ${pe.score.toFixed(2)} (0 = losing decisively … 4 = winning decisively), confidence ${pe.confidence}`);
  } catch (err) {
    console.log(`\n${name}: ERROR ${err.name} ${err.status ?? ''} ${JSON.stringify(err.body ?? err.message)}`);
    process.exitCode = 1;
  }
}
if (values.json) console.log(JSON.stringify(all, null, 2));
