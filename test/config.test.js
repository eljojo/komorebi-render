import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadPin } from '../src/config.js';

test('defaults: state under the home, no output root, 6 h maximum, listen on 0.0.0.0', () => {
  const c = loadConfig({}, '/home/u');
  assert.equal(c.state, '/home/u/.local/state/komorebi-render');
  assert.equal(c.dbPath, '/home/u/.local/state/komorebi-render/jobs.sqlite');
  assert.equal(c.mirror, '/home/u/.local/state/komorebi-render/komorebi.git');
  assert.equal(c.browsers, '/home/u/.local/state/komorebi-render/browsers');
  assert.equal(c.out, null);
  assert.equal(c.maxSeconds, 21600);
  assert.equal(c.host, '0.0.0.0');
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
  assert.equal(pin.commit, 'a6b6fa25a98d47fa8ae312b4bfae4c9fde99f849');
  assert.match(pin.repo, /^https:\/\/github\.com\/eljojo\/komorebi/);
});
