// Stockfish for the bench: the same UciEngine as the browser, over a child process.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UciEngine } from '../public/engine.js';

export const STOCKFISH = fileURLToPath(new URL('../public/vendor/stockfish/stockfish-19-lite-single.js', import.meta.url));

export function nodeEngine() {
  const child = spawn(process.execPath, [STOCKFISH], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lineFns = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      for (const fn of lineFns) fn(line);
    }
  });
  return new UciEngine({
    post: cmd => child.stdin.write(`${cmd}\n`),
    onLine: fn => lineFns.push(fn),
    onError: fn => {
      child.on('error', fn);
      child.on('exit', code => fn(new Error(`Stockfish exited (${code})`)));
    },
    close: () => { child.stdin.end('quit\n'); child.kill(); },
  });
}
