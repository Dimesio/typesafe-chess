// Calls to the local server. The browser never talks to TypeSafe directly.

async function postJson(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  if (!res.ok) {
    const err = new Error(formatError(data.error, res.status));
    err.details = data.error;
    throw err;
  }
  return data;
}

/** One readable line (plus the raw body) for an error returned by the server. */
export function formatError(error, httpStatus) {
  if (!error) return `HTTP ${httpStatus}`;
  const parts = [error.name, error.status && `HTTP ${error.status}`, error.message].filter(Boolean);
  let text = parts.join(': ');
  if (error.body) text += `\n${typeof error.body === 'string' ? error.body : JSON.stringify(error.body)}`;
  return text;
}

export const getStatus = () => fetch('/api/status').then(r => r.json());
export const getPositions = () => fetch('/api/positions').then(r => (r.ok ? r.json() : []));
/** The Elo calibration from the bench (M4), or null before it has been run. */
export const getCalibration = () => fetch('/api/calibration').then(r => (r.ok ? r.json() : null));
/** The live lessons' summary and the frozen books: { live: { rev, promoted, … }, books: [...] }. */
export const getLessons = () => fetch('/api/lessons').then(async r => {
  const data = await r.json();
  if (!r.ok) throw new Error(formatError(data.error, r.status));
  return data;
});
export const askJev = (body, signal) => postJson('/api/jev', body, signal);
export const postLog = lines => postJson('/api/log', lines);
