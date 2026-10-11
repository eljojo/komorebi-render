// Everything the environment decides, read once. The ARBORETUM_TOKEN (or the file it is read from) lives here and is handed to the exporter alone:
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
  let port = 8077;
  if (env.KOMOREBI_RENDER_PORT !== undefined) {
    port = env.KOMOREBI_RENDER_PORT === '' ? NaN : Number(env.KOMOREBI_RENDER_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`KOMOREBI_RENDER_PORT must be a port number (0 to 65535), got ${JSON.stringify(env.KOMOREBI_RENDER_PORT)}`);
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
    port,
    token: env.ARBORETUM_TOKEN || readTokenFile(env.KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE),
  };
}

// The nix module hands the program a path, never the token: the token must not enter the nix store. Read once, at start.
// A configured file that cannot be used stops the start (the message names the path, never the contents).
function readTokenFile(file) {
  if (!file) return null;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new Error(`KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE ${file} cannot be read (${e.code ?? e.message})`); }
  const token = text.trim();
  if (!token) throw new Error(`KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE ${file} is empty`);
  return token;
}

export function loadPin(file = fileURLToPath(new URL('../komorebi.json', import.meta.url))) {
  const pin = JSON.parse(readFileSync(file, 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error(`${file}: commit must be a full 40-hex sha`);
  return pin;
}
