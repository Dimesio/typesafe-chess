// Frozen lesson books on disk: lessons/book-vN.json, a copy of the live lessons saved by
// `npm run lessons -- --freeze` (book 1 was mined and accepted before lessons went live). A
// frozen book is never edited (a new version is a new file), so each one is read once. LESSONS_DIR points somewhere else, e.g. a
// scratch folder for trying a proposal in the app without accepting it.
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { checkBook } from './lessons.js';

export const LESSONS_DIR = process.env.LESSONS_DIR
  ? pathToFileURL(`${resolve(process.env.LESSONS_DIR)}/`)
  : new URL('../lessons/', import.meta.url);
const cache = new Map();

/** Versions found in lessons/ for a file kind ('book' or 'proposed'), ascending. */
export function versions(kind = 'book') {
  let names = [];
  try { names = readdirSync(LESSONS_DIR); } catch { return []; }
  const re = new RegExp(`^${kind}-v(\\d+)\\.json$`);
  return names.map(n => re.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

export function loadBook(version) {
  if (!cache.has(version)) {
    let text;
    try {
      text = readFileSync(new URL(`book-v${version}.json`, LESSONS_DIR), 'utf8');
    } catch {
      throw new Error(`Lesson book ${version} doesn't exist. Accepted books: ${versions().join(', ') || 'none yet'} (npm run lessons -- --list).`);
    }
    const book = checkBook(JSON.parse(text));
    if (book.version !== version) throw new Error(`lessons/book-v${version}.json says it is version ${book.version}`);
    cache.set(version, book);
  }
  return cache.get(version);
}

/** A summary of every accepted book, for the UI. */
export function listBooks() {
  return versions().map(v => {
    const b = loadBook(v);
    return {
      version: b.version, created: b.created, parent: b.parent,
      promoted: b.patterns.filter(p => p.promoted).map(p => p.id),
      memory_positions: Object.keys(b.memory).length,
      memory_moves: Object.values(b.memory).reduce((n, moves) => n + Object.keys(moves).length, 0),
    };
  });
}
