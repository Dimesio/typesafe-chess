// TypeSafe client setup. The API key never leaves this module: it is not logged, not
// returned to callers, and never sent to the browser.
import { readFileSync } from 'node:fs';
import { TypeSafeClient } from '@typesafe-ai/sdk';

const KEY_FILE = new URL('../.typesafe-api-key', import.meta.url);

/** Returns the key and where it came from: env TYPESAFE_API_KEY first, then .typesafe-api-key. */
function loadApiKey() {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  try {
    const fromFile = readFileSync(KEY_FILE, 'utf8').trim();
    if (fromFile) return { key: fromFile, source: 'file' };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { key: null, source: null };
}

/**
 * Decides live vs. mock and builds the client.
 * Mock only when TYPESAFE_MOCK=1 or no key exists. With a key, failures surface as errors;
 * there is no silent fallback to mock.
 * @returns {{ mock: boolean, reason: string, keySource: 'env'|'file'|null, client: TypeSafeClient|null }}
 */
export function createJev({ timeout = 30_000 } = {}) {
  if (process.env.TYPESAFE_MOCK === '1') {
    return { mock: true, reason: 'TYPESAFE_MOCK=1', keySource: null, client: null };
  }
  const { key, source } = loadApiKey();
  if (!key) {
    return { mock: true, reason: 'no API key found', keySource: null, client: null };
  }
  // logLevel stays at "warn": "debug" would log request bodies.
  const client = new TypeSafeClient({ apiKey: key, timeout, logLevel: 'warn' });
  return { mock: false, reason: `key from ${source}`, keySource: source, client };
}
