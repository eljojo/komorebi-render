import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { loadConfig, loadPin } from '../src/config.js';
import { exporterArgs } from '../src/exporter.js';

test('relative paths keep the worker and exporter on the same output root', () => {
  const c = loadConfig({ KOMOREBI_RENDER_STATE: 'state', KOMOREBI_RENDER_OUT: 'nas/jobs' }, '/h');
  const script = join(c.engineDir('sha'), 'test-gl', 'render-video.mjs');
  const folder = join(c.out, 'job');
  const args = exporterArgs({ script, commit: 'sha', folder, spec: { preset: '3', size: '64x64', seconds: 1, fps: 60 } });
  assert.equal(resolve(dirname(script), args[args.indexOf('--out') + 1]), resolve(folder));
  assert.equal(c.state, resolve('state'));
});

test('defaults: state under the home, no output root, 6 h maximum, listen on 0.0.0.0', () => {
  const c = loadConfig({}, '/home/u');
  assert.equal(c.state, '/home/u/.local/state/komorebi-render');
  assert.equal(c.dbPath, '/home/u/.local/state/komorebi-render/jobs.sqlite');
  assert.equal(c.mirror, '/home/u/.local/state/komorebi-render/komorebi.git');
  assert.equal(c.browsers, '/home/u/.local/state/komorebi-render/browsers');
  assert.equal(c.out, null);
  assert.equal(c.maxSeconds, 21600);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 8077);
  assert.equal(c.token, null);
  assert.equal(c.allowLocal, false);
  assert.equal(c.engineDir('abc'), '/home/u/.local/state/komorebi-render/engine/abc');
});

test('the environment overrides every path and limit', () => {
  const c = loadConfig({
    KOMOREBI_RENDER_STATE: '/s', KOMOREBI_RENDER_OUT: '/Volumes/home/komorebi/jobs', KOMOREBI_RENDER_MAX_SECONDS: '43200',
    KOMOREBI_RENDER_HOST: '127.0.0.1', KOMOREBI_RENDER_ALLOW_LOCAL: '1', ARBORETUM_TOKEN: 't',
  }, '/home/u');
  assert.deepEqual([c.state, c.out, c.maxSeconds, c.host, c.allowLocal, c.token], ['/s', '/Volumes/home/komorebi/jobs', 43200, '127.0.0.1', true, 't']);
});

test('a bad maximum is refused at startup, not at the first job', () => {
  for (const v of ['0', '-5', 'abc', '1.5']) assert.throws(() => loadConfig({ KOMOREBI_RENDER_MAX_SECONDS: v }, '/h'), /KOMOREBI_RENDER_MAX_SECONDS/);
});

test('the pin is a full sha', () => {
  const pin = loadPin();
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.equal(pin.commit, '12012228ddd68c21436b244269b4932d31b4aee3');
  assert.match(pin.repo, /^https:\/\/github\.com\/eljojo\/komorebi/);
});

test('the port is KOMOREBI_RENDER_PORT; a bad one is refused at startup (0 is allowed: the OS picks, for tests)', () => {
  assert.equal(loadConfig({ KOMOREBI_RENDER_PORT: '9000' }, '/h').port, 9000);
  assert.equal(loadConfig({ KOMOREBI_RENDER_PORT: '0' }, '/h').port, 0);
  for (const v of ['-1', '65536', 'abc', '80.5', '']) assert.throws(() => loadConfig({ KOMOREBI_RENDER_PORT: v }, '/h'), /KOMOREBI_RENDER_PORT/);
});

const tokenFile = (text) => { const f = join(mkdtempSync(join(tmpdir(), 'kr-tok-')), 'token'); writeFileSync(f, text); return f; };

test('KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE is read at start into the token, its trailing newline dropped', () => {
  const c = loadConfig({ KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE: tokenFile('s3cret-token\n') }, '/h');
  assert.equal(c.token, 's3cret-token');
});

test('ARBORETUM_TOKEN in the environment wins over the file', () => {
  const c = loadConfig({ ARBORETUM_TOKEN: 'from-env', KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE: tokenFile('from-file') }, '/h');
  assert.equal(c.token, 'from-env');
});

test('a token file that is missing or empty stops startup, naming the path and never the contents', () => {
  assert.throws(() => loadConfig({ KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE: '/nonexistent/kr-token' }, '/h'), /KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE.*\/nonexistent\/kr-token/);
  assert.throws(() => loadConfig({ KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE: tokenFile(' \n') }, '/h'), /is empty/);
});
