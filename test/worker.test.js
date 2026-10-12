import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from '../src/worker.js';
import { openStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { validateSpec } from '../src/spec.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-exporter.mjs');
const SHA = 'a6b6fa25a98d47fa8ae312b4bfae4c9fde99f849';

const rig = (over = {}) => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'kr-w-')));
  const config = loadConfig({ KOMOREBI_RENDER_STATE: join(out, 'state'), KOMOREBI_RENDER_OUT: out, KOMOREBI_RENDER_ALLOW_LOCAL: '1', ...over.env }, '/h');
  const store = openStore(':memory:');
  const lines = [];
  const prepared = { n: 0 };
  const worker = createWorker({
    store, config, log: (l) => lines.push(l),
    prepare: async () => { prepared.n++; if (over.prepareFails) throw new Error('no network'); return { script: FAKE, commit: SHA }; },
    checkOut: over.checkOut ?? (() => ({ ok: true, fstype: 'test' })),
    caffeinate: false, pollMs: 10, progressMs: 15, graceMs: 50, extraEnv: over.extraEnv ?? {},
    isOurs: over.isOurs, kill: over.kill,
  });
  return { out, config, store, worker, lines, prepared };
};
const submit = (store, raw) => store.create(validateSpec({ size: '1080p', seconds: 30, preset: '3', ...raw }));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const argvOf = (folder) => JSON.parse(readFileSync(join(folder, 'argv.json'), 'utf8'));

test('the output root is checked again after preparing, before any output is written', async () => {
  let checks = 0;
  const { store, worker, out } = rig({ checkOut: () => ++checks === 1 ? { ok: true } : { ok: false, reason: 'mount disappeared' } });
  const job = submit(store, {});
  assert.equal((await worker.runOnce()).outcome, 'blocked');
  assert.equal(store.get(job.id).state, 'queued');
  assert.equal(existsSync(join(out, job.folder_name)), false);
});

test('a job runs to done: folder, argv, progress, and the delivery from the manifest', async () => {
  const { store, worker, out } = rig();
  const j = submit(store, {});
  const r = await worker.runOnce();
  assert.equal(r.outcome, 'done');
  const done = store.get(j.id);
  assert.equal(done.state, 'done');
  assert.equal(done.folder, join(out, j.folder_name));
  assert.deepEqual([done.seg_done, done.seg_total], [3, 3]);
  assert.equal(done.result.delivery, join(done.folder, 'delivery.mp4'));
  assert.equal(done.result.mbit_s, 59.5);
  const { argv } = argvOf(done.folder);
  assert.deepEqual(argv.slice(argv.indexOf('--arboretum'), argv.indexOf('--arboretum') + 2), ['--arboretum', '3']);
  assert.equal(argv[argv.indexOf('--commit') + 1], SHA);
  assert.equal(argv[argv.indexOf('--out') + 1], done.folder);
  assert.ok(argv.includes('--discard-master'));
  assert.equal(done.last_line, 'done');
});

test('master: true keeps the lossless segments', async () => {
  const { store, worker } = rig();
  const j = submit(store, { master: true });
  await worker.runOnce();
  assert.ok(!argvOf(store.get(j.id).folder).argv.includes('--discard-master'));
});

test('a look job gets its look written beside the output and passed by file', async () => {
  const { store, worker } = rig();
  const j = submit(store, { preset: undefined, look: { name: 'Mine', params: { sample_count: 8 } } });
  await worker.runOnce();
  const f = store.get(j.id).folder;
  const { argv } = argvOf(f);
  assert.equal(argv[argv.indexOf('--look-json') + 1], join(f, 'look-input.json'));
  assert.deepEqual(JSON.parse(readFileSync(join(f, 'look-input.json'), 'utf8')).params, { sample_count: 8 });
});

test('max quality reaches the exporter as --set and --ss', async () => {
  const { store, worker } = rig();
  const j = submit(store, { quality: 'max' });
  await worker.runOnce();
  const { argv } = argvOf(store.get(j.id).folder);
  assert.ok(argv.includes('tex_resolution=4096'));
  assert.equal(argv[argv.indexOf('--ss') + 1], '2');
});

test('a non-zero exit is failed, with the run.log tail', async () => {
  const { store, worker } = rig({ extraEnv: { FAKE_MODE: 'fail' } });
  const j = submit(store, {});
  const r = await worker.runOnce();
  assert.equal(r.outcome, 'failed');
  const f = store.get(j.id);
  assert.equal(f.state, 'failed');
  assert.match(f.error, /exit code 1/);
  assert.match(f.error, /FAILED: boom/);
  assert.ok(f.finished_at);
});

test('cancel: SIGTERM to the exporter, state cancelled, the folder kept', async () => {
  const { store, worker } = rig({ extraEnv: { FAKE_MODE: 'hang' } });
  const j = submit(store, {});
  const run = worker.runOnce();
  await until(() => store.get(j.id).seg_done >= 1);
  assert.equal(store.requestCancel(j.id), 'requested');
  const r = await run;
  assert.equal(r.outcome, 'cancelled');
  const c = store.get(j.id);
  assert.equal(c.state, 'cancelled');
  assert.ok(existsSync(join(c.folder, 'seg')));
});

test('stop() during a render sends the job back to the queue for the exporter to resume', async () => {
  const { store, worker } = rig({ extraEnv: { FAKE_MODE: 'hang' } });
  const j = submit(store, {});
  const run = worker.runOnce();
  await until(() => store.get(j.id).seg_done >= 1);
  await worker.stop();
  await run;
  assert.equal(store.get(j.id).state, 'queued');
});

test('a network mount that fails the check keeps the job queued with the reason, and spawns nothing', async () => {
  const { store, worker, out, prepared } = rig({ checkOut: () => ({ ok: false, reason: 'not a network mount (apfs)' }) });
  const j = submit(store, {});
  const r = await worker.runOnce();
  assert.equal(r.outcome, 'blocked');
  assert.deepEqual([store.get(j.id).state, store.get(j.id).blocked], ['queued', 'output root: not a network mount (apfs)']);
  assert.equal(existsSync(join(out, j.folder_name)), false);
  assert.equal(prepared.n, 0);
});

test('prepare runs once before the first job, and a failing prepare blocks the job', async () => {
  const a = rig();
  submit(a.store, {}); submit(a.store, {});
  await a.worker.runOnce(); await a.worker.runOnce();
  assert.equal(a.prepared.n, 1);
  const b = rig({ prepareFails: true });
  const j = submit(b.store, {});
  assert.equal((await b.worker.runOnce()).outcome, 'blocked');
  assert.match(b.store.get(j.id).blocked, /engine not ready: no network/);
});

test('no queued job: runOnce does nothing', async () => {
  assert.equal(await rig().worker.runOnce(), null);
});

test('start-up recovery: a job left running is queued again, and a still-living exporter of it is stopped first', async () => {
  const killed = [];
  const { store, worker } = rig({ isOurs: (pid) => pid === 4242, kill: (pid, sig) => killed.push([pid, sig]) });
  const a = submit(store, {}), b = submit(store, {});
  store.start(a.id, { folder: '/f', base: 0 }); store.setPid(a.id, 4242);
  store.start(b.id, { folder: '/g', base: 0 }); store.setPid(b.id, 999);   // pid reused by something else
  const re = await worker.recover();
  assert.deepEqual(re.map((j) => j.id), [a.id, b.id]);
  assert.deepEqual(killed, [[-4242, 'SIGTERM']]);
  assert.deepEqual([store.get(a.id).state, store.get(b.id).state], ['queued', 'queued']);
});

test('the arboretum token reaches the exporter and no log line', async () => {
  const { store, worker, lines } = rig({ env: { ARBORETUM_TOKEN: 'sekret-token' } });
  const j = submit(store, { preset: '3:sharetok' });
  await worker.runOnce();
  assert.equal(argvOf(store.get(j.id).folder).sawToken, true);
  const all = lines.join('\n') + JSON.stringify(store.get(j.id).result) + (store.get(j.id).error ?? '');
  assert.ok(!all.includes('sekret-token'));
  assert.ok(!all.includes('sharetok'));
});

test('run() takes queued jobs one at a time until stopped', async () => {
  const { store, worker } = rig();
  const a = submit(store, {}), b = submit(store, {});
  const loop = worker.run();
  await until(() => store.get(a.id).state === 'done' && store.get(b.id).state === 'done');
  await worker.stop();
  await loop;
});

test('an async NAS refusal waits for the check then blocks without preparing or rendering', async () => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const { store, worker, prepared } = rig({ checkOut: () => stalled });
  const job = submit(store, {});
  let finished = false;
  const run = worker.runOnce().then((result) => { finished = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  const premature = finished;
  release({ ok: false, reason: 'NAS check timed out' });
  const result = await run;
  assert.equal(premature, false);
  assert.equal(result.outcome, 'blocked');
  assert.equal(store.get(job.id).blocked, 'output root: NAS check timed out');
  assert.equal(prepared.n, 0);
});

test('stop during an async NAS check leaves the job queued without preparing when the check returns', async () => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const { store, worker, prepared } = rig({ checkOut: () => stalled });
  const job = submit(store, {});
  const run = worker.runOnce();
  await worker.stop();
  release({ ok: true });
  await run;
  assert.equal(prepared.n, 0);
  assert.equal(store.get(job.id).state, 'queued');
});

test('the worker loop stops without a new poll sleep after an awaited NAS check', async () => {
  let release, entered;
  const stalled = new Promise((resolve) => { release = resolve; });
  const checking = new Promise((resolve) => { entered = resolve; });
  const { store, worker } = rig({ checkOut: () => { entered(); return stalled; } });
  submit(store, {});
  const loop = worker.run();
  let timer;
  try {
    await checking;
    await worker.stop();
    release({ ok: true });
    const stopped = await Promise.race([
      loop.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5); }),
    ]);
    assert.equal(stopped, true);
  } finally {
    clearTimeout(timer);
    release({ ok: false });
    await worker.stop();
    await loop;
  }
});
