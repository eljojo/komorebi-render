import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { prepare, resolveCommit, defaultRun } from '../src/engine.js';

test('engine subprocesses let timers run before the command completes', async () => {
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  const running = defaultRun(process.execPath, ['-e', 'setTimeout(() => {}, 50)']);
  await new Promise(resolve => setTimeout(resolve, 5));
  const result = await running;
  clearTimeout(timer);
  assert.equal(ticked, true);
  assert.equal(typeof running.then, 'function');
  assert.equal(result.status, 0);
});

test('engine subprocesses can be aborted during preparation', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5);
  const r = await defaultRun(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { signal: controller.signal });
  clearTimeout(timer);
  assert.equal(r.error?.name, 'AbortError');
});

const SHA = 'a6b6fa25a98d47fa8ae312b4bfae4c9fde99f849';
const pin = { repo: 'https://github.com/eljojo/komorebi', commit: SHA };
const setup = () => {
  const state = mkdtempSync(join(tmpdir(), 'kr-state-'));
  return { state, config: loadConfig({ KOMOREBI_RENDER_STATE: state, ARBORETUM_TOKEN: 'sekret' }, '/h') };
};

// A scripted git / npm: records every call and plays the side effects the real ones have on disk.
// `missing` is how many `cat-file` probes of the pinned commit fail before the commit "arrives".
const fakeRunner = (config, { missing = 0, npmStatus = 0 } = {}) => {
  const calls = [];
  let probes = 0;
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
    const ok = { status: 0, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'clone') { mkdirSync(args.at(-1), { recursive: true }); writeFileSync(join(args.at(-1), 'HEAD'), 'ref: refs/heads/main\n'); }
    if (cmd === 'git' && args.includes('cat-file')) return probes++ < missing ? { ...ok, status: 1 } : ok;
    if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
      const dir = args.at(-2);
      mkdirSync(join(dir, 'test-gl'), { recursive: true });
      writeFileSync(join(dir, '.git'), 'gitdir: x\n');
      writeFileSync(join(dir, 'test-gl', 'render-video.mjs'), '');
    }
    if (cmd === 'git' && args.includes('rev-parse')) return { ...ok, stdout: `${SHA}\n` };
    if (cmd === 'npm') return { ...ok, status: npmStatus, stderr: npmStatus ? 'ENOTFOUND' : '' };
    return ok;
  };
  return { run, calls };
};

test('a fresh state dir: mirror clone, pinned worktree, npm ci, chromium into the state dir', async () => {
  const { config } = setup();
  const { run, calls } = fakeRunner(config);
  const r = await prepare({ config, pin, run });
  const flat = calls.map((c) => [c.cmd, ...c.args].join(' '));
  assert.ok(flat.includes(`git clone --mirror ${pin.repo} ${config.mirror}`), flat.join('\n'));
  assert.ok(flat.some((l) => l.startsWith(`git -C ${config.mirror} worktree add --detach ${config.engineDir(SHA)} ${SHA}`)));
  const npm = calls.find((c) => c.cmd === 'npm');
  assert.deepEqual(npm.args.slice(0, 1), ['ci']);
  assert.equal(npm.cwd, join(config.engineDir(SHA), 'test-gl'));
  const pw = calls.find((c) => c.cmd === 'npx');
  assert.deepEqual(pw.args, ['playwright', 'install', 'chromium']);
  assert.equal(pw.cwd, join(config.engineDir(SHA), 'test-gl'));
  assert.equal(pw.env.PLAYWRIGHT_BROWSERS_PATH, config.browsers);
  assert.equal(r.script, join(config.engineDir(SHA), 'test-gl', 'render-video.mjs'));
  assert.equal(r.commit, SHA);
});

test('the arboretum token never reaches git, npm or npx', async () => {
  const { config } = setup();
  const { run, calls } = fakeRunner(config);
  await prepare({ config, pin, run });
  for (const c of calls) assert.equal(c.env?.ARBORETUM_TOKEN, undefined, `${c.cmd} ${c.args[0]}`);
});

test('prepare is idempotent: a second call runs nothing', async () => {
  const { config } = setup();
  const first = fakeRunner(config);
  await prepare({ config, pin, run: first.run });
  const second = fakeRunner(config);
  await prepare({ config, pin, run: second.run });
  assert.deepEqual(second.calls, []);
});

test('the mirror is fetched only when it lacks the pinned commit', async () => {
  const { config } = setup();
  const have = fakeRunner(config);
  await prepare({ config, pin, run: have.run });
  assert.ok(!have.calls.some((c) => c.args.includes('fetch')));
  const { config: c2 } = setup();
  const lacks = fakeRunner(c2, { missing: 1 });
  await prepare({ config: c2, pin, run: lacks.run });
  assert.ok(lacks.calls.some((c) => c.cmd === 'git' && c.args.includes('fetch')));
});

test('a commit that is not there even after fetching is an error naming it', async () => {
  const { config } = setup();
  const { run } = fakeRunner(config, { missing: 99 });
  await assert.rejects(() => prepare({ config, pin, run }), new RegExp(SHA));
});

test('a failed npm ci throws and leaves no marker, so the next prepare retries', async () => {
  const { config } = setup();
  await assert.rejects(() => prepare({ config, pin, run: fakeRunner(config, { npmStatus: 1 }).run }), /npm ci/);
  const retry = fakeRunner(config);
  await prepare({ config, pin, run: retry.run });
  assert.ok(retry.calls.some((c) => c.cmd === 'npm'));
  assert.ok(!retry.calls.some((c) => c.args.includes('clone')));   // the mirror it already has
});

test('resolveCommit expands a ref against the mirror and refuses what is not a commit', async () => {
  const { config } = setup();
  mkdirSync(config.mirror, { recursive: true });
  writeFileSync(join(config.mirror, 'HEAD'), '');
  const run = (cmd, args) => (args.includes('rev-parse') ? { status: 0, stdout: `${SHA}\n`, stderr: '' } : { status: 0, stdout: '', stderr: '' });
  assert.equal(await resolveCommit({ config, pin, run, ref: 'a6b6fa2' }), SHA);
  const none = () => ({ status: 128, stdout: '', stderr: 'unknown revision' });
  await assert.rejects(() => resolveCommit({ config, pin, run: none, ref: 'nope' }), /nope/);
  await assert.rejects(() => resolveCommit({ config, pin, run, ref: '--upload-pack=x' }), /ref/);
  assert.ok(existsSync(config.mirror));
});
