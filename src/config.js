// Everything the environment decides, read once. The ARBORETUM_TOKEN lives here and is handed to the exporter alone:
// never print a config.
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_SECONDS } from './spec.js';

export function loadConfig(env = process.env, home = homedir()) {
  const state = env.KOMOREBI_RENDER_STATE || join(home, '.local', 'state', 'komorebi-render');
  let maxSeconds = DEFAULT_MAX_SECONDS;
  if (env.KOMOREBI_RENDER_MAX_SECONDS !== undefined) {
    maxSeconds = Number(env.KOMOREBI_RENDER_MAX_SECONDS);
    if (!Number.isInteger(maxSeconds) || maxSeconds < 1) throw new Error(`KOMOREBI_RENDER_MAX_SECONDS must be a whole number of seconds, got ${JSON.stringify(env.KOMOREBI_RENDER_MAX_SECONDS)}`);
  }
  return {
    state,
    dbPath: join(state, 'jobs.sqlite'),
    mirror: join(state, 'komorebi.git'),
    browsers: join(state, 'browsers'),
    engineDir: (sha) => join(state, 'engine', sha),
    out: env.KOMOREBI_RENDER_OUT || null,
    allowLocal: env.KOMOREBI_RENDER_ALLOW_LOCAL === '1',
    maxSeconds,
    host: env.KOMOREBI_RENDER_HOST || '0.0.0.0',   // no auth: the API is for the LAN (brief 3)
    token: env.ARBORETUM_TOKEN || null,
  };
}

export function loadPin(file = fileURLToPath(new URL('../komorebi.json', import.meta.url))) {
  const pin = JSON.parse(readFileSync(file, 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error(`${file}: commit must be a full 40-hex sha`);
  return pin;
}
