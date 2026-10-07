// The day's Kite session and local settings, shared by the bridge and the
// trading bot. No dependencies: the bot imports this without the server.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { istDate } from './kite.mjs';

export const SESSION_FILE = fileURLToPath(new URL('../.kite-session.json', import.meta.url));
export const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

/** Reads KEY=VALUE lines from a .env file without adding a dependency. */
export function loadDotEnv(file, env = process.env) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/** Today's access token for this API key, or null. */
export function readSession(file, apiKey) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    // Kite sessions end early each morning; a token from another day is useless.
    return s.apiKey === apiKey && s.date === istDate() && s.accessToken ? s.accessToken : null;
  } catch {
    return null;
  }
}

export function writeSession(file, apiKey, accessToken) {
  writeFileSync(file, JSON.stringify({ apiKey, accessToken, date: istDate() }), { mode: 0o600 });
}
