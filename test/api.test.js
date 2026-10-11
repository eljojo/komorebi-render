import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi, listen, ROUTES } from '../src/api.js';
import { openStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { validateSpec } from '../src/spec.js';
import { readResult } from '../src/exporter.js';

const SHA = 'a6b6fa25a98d47fa8ae312b4bfae4c9fde99f849';
const SPEC = { preset: '3', size: '1080p', seconds: 30 };

const rig = (over = {}) => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'kr-api-')));
  const config = loadConfig({ KOMOREBI_RENDER_STATE: join(out, 'state'), KOMOREBI_RENDER_OUT: out, ...over.env }, '/h');
  const store = over.t0 ? openStore(':memory:', { now: () => new Date(over.t0).toISOString() }) : openStore(':memory:');
  const nas = { ok: true, reason: null };
  const api = createApi({ store, config, pin: { commit: SHA }, log: () => {}, checkOut: () => (nas.ok ? { ok: true } : { ok: false, reason: nas.reason ?? 'gone' }), now: over.now });
  const call = async (method, path, body) => {
    const r = await api.handle({ method, url: path, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    let json = null;
    if (r.headers['content-type']?.startsWith('application/json')) json = JSON.parse(r.body);
    return { status: r.status, headers: r.headers, text: r.body, json };
  };
  const submit = (raw = {}) => store.create(validateSpec({ ...SPEC, ...raw }));
  // A job the worker has run: a folder with the files the exporter leaves, then the store's own transitions.
  const finished = (job, { log = 'segment 0 done\ndone\n', manifest } = {}) => {
    const folder = join(out, job.folder_name);
    mkdirSync(join(folder, 'seg'), { recursive: true });
    writeFileSync(join(folder, 'run.log'), log);
    writeFileSync(join(folder, 'delivery.mp4'), 'x');
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest ?? { delivery: { bitrate_arg: '60M' }, delivery_probe: { mbit_s: 59.5, size_mib: 12.5, decoded_frames: 1800 }, quality_vs_master: { psnr: { mean: 47.1 }, ssim: { mean: 0.998 } } }));
    store.start(job.id, { folder });
    store.progress(job.id, { done: 3, total: 3 });
    store.finish(job.id, readResult(folder));
    return folder;
  };
  return { out, config, store, api, call, submit, finished, nas };
};

test('API accepts and displays every pipeline, including the effective master default on older jobs', async () => {
  const { call, submit, store } = rig();
  const old = submit();
  assert.equal('pipeline' in store.get(old.id).spec, false);
  assert.equal((await call('GET', `/jobs/${old.id}`)).json.pipeline, 'master');
  for (const pipeline of ['master', 'gpu', 'gpu-main10', 'browser']) {
    const r = await call('POST', '/jobs', { ...SPEC, pipeline });
    assert.equal(r.status, 201);
    const detail = (await call('GET', `/jobs/${r.json.id}`)).json;
    assert.equal(detail.pipeline, pipeline);
    assert.equal(detail.spec.pipeline, pipeline);
  }
  assert.deepEqual((await call('GET', '/jobs')).json.jobs.map(j => j.pipeline), ['browser', 'gpu-main10', 'gpu', 'master', 'master']);
});

test('API refuses incompatible master and browser delivery choices with their fields', async () => {
  const { call, store } = rig();
  for (const [extra, field] of [
    [{ pipeline: 'gpu', master: true }, 'master'],
    [{ pipeline: 'gpu-main10', master: true }, 'master'],
    [{ pipeline: 'browser', master: true }, 'master'],
    [{ pipeline: 'browser', delivery: { vt_quality: 100 } }, 'delivery'],
    [{ pipeline: 'unknown' }, 'pipeline'],
  ]) {
    const r = await call('POST', '/jobs', { ...SPEC, ...extra });
    assert.equal(r.status, 422);
    assert.equal(r.json.field, field);
  }
  assert.equal(store.list().length, 0);
});

test('POST /jobs queues a job: 201 with id, state and the folder it will land in', async () => {
  const { call, store, out } = rig();
  const r = await call('POST', '/jobs', { ...SPEC, quality: 'max' });
  assert.equal(r.status, 201);
  assert.equal(r.json.id, 1);
  assert.equal(r.json.state, 'queued');
  assert.equal(r.json.folder, join(out, store.get(1).folder_name));
  assert.match(r.json.folder, /\d{4}-\d\d-\d\d-1-preset-3$/);
  assert.equal(store.get(1).quality.name, 'max');
  assert.equal(store.get(1).spec.fps, 60);   // the validator's defaults, not the raw body
});

test('POST /jobs with no output root configured still queues; the folder is null until one is', async () => {
  const out = mkdtempSync(join(tmpdir(), 'kr-api-'));
  const config = loadConfig({ KOMOREBI_RENDER_STATE: out }, '/h');
  const api = createApi({ store: openStore(':memory:'), config, pin: { commit: SHA } });
  const r = await api.handle({ method: 'POST', url: '/jobs', body: JSON.stringify(SPEC) });
  assert.equal(r.status, 201);
  assert.equal(JSON.parse(r.body).folder, null);
});

test('a refused spec is 422 with the first error and its field, and every error in errors; nothing is queued', async () => {
  const { call, store } = rig();
  const r = await call('POST', '/jobs', { preset: 'x', size: '8k', seconds: 99999, bogus: 1 });
  assert.equal(r.status, 422);
  assert.match(r.json.error, /unknown key "bogus"/);
  assert.equal(r.json.field, 'bogus');
  assert.deepEqual(r.json.errors.map((e) => e.field), ['bogus', 'preset', 'size', 'seconds']);
  assert.match(r.json.errors[3].error, /at most 21600/);
  assert.equal(store.list().length, 0);

  const q = await call('POST', '/jobs', { ...SPEC, quality: { tex_resolution: 3000 } });
  assert.equal(q.status, 422);
  assert.equal(q.json.field, 'quality.tex_resolution');
  assert.match(q.json.error, /one of 1024, 2048, 4096/);
});

test('seconds is held to the configured maximum', async () => {
  const { call } = rig({ env: { KOMOREBI_RENDER_MAX_SECONDS: '60' } });
  assert.equal((await call('POST', '/jobs', { ...SPEC, seconds: 61 })).json.field, 'seconds');
  assert.equal((await call('POST', '/jobs', { ...SPEC, seconds: 60 })).status, 201);
});

test('a body that is not JSON is 400; JSON that is not an object is a 422 about the whole spec', async () => {
  const { call } = rig();
  const bad = await call('POST', '/jobs', '{nope');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /JSON/);
  const arr = await call('POST', '/jobs', '[1]');
  assert.equal(arr.status, 422);
  assert.equal(arr.json.field, null);
  assert.equal((await call('POST', '/jobs')).status, 400);   // no body at all
});

test('GET /jobs lists newest first with state, progress, eta_s, size, seconds, quality and the name', async () => {
  const { call, submit, store } = rig();
  submit({ preset: '3@2', quality: 'max' });
  submit({ preset: undefined, look: { name: 'Autumn Gold', params: {} }, size: '4k', seconds: 100 });
  const done = submit({ preset: '9' });
  store.start(done.id, { folder: '/x' });
  store.progress(done.id, { done: 1, total: 3 });
  const r = await call('GET', '/jobs');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.jobs.map((j) => j.id), [3, 2, 1]);
  const [running, look, preset] = r.json.jobs;
  assert.equal(running.state, 'running');
  assert.deepEqual([running.progress.done, running.progress.total], [1, 3]);
  assert.equal(look.name, 'Autumn Gold');
  assert.deepEqual([look.size, look.seconds, look.fps, look.quality.name], ['3840x2160', 100, 60, 'authored']);
  assert.equal(typeof look.eta_s, 'number');
  assert.equal(preset.name, 'preset 3@2');
  assert.equal(preset.quality.name, 'max');
  assert.equal(preset.eta_basis, 'estimate');
  assert.equal(preset.eta_s, 540);   // 30 s x 60 fps x 300 ms (the max-quality default) = 540 s
  assert.equal(preset.spec, undefined);   // the list is a summary
});

test('a finished job has no ETA', async () => {
  const { call, submit, finished } = rig();
  finished(submit());
  const j = (await call('GET', '/jobs')).json.jobs[0];
  assert.equal(j.state, 'done');
  assert.equal(j.eta_s, null);
  assert.equal(j.eta_basis, null);
});

test('a running job\'s ETA is measured from its own rate once a segment is done', async () => {
  const t0 = Date.parse('2026-10-10T10:00:00Z');
  const { call, submit, store } = rig({ t0, now: () => t0 + 60_000 });
  const j = submit({ seconds: 100 });   // 10 segments
  store.start(j.id, { folder: '/x' });
  store.progress(j.id, { done: 2, total: 10 });
  const r = await call('GET', `/jobs/${j.id}`);
  assert.equal(r.json.eta_basis, 'measured');
  assert.equal(r.json.eta_s, 240);   // 2 segments in 60 s: 8 more at 30 s
});

test('GET /jobs/:id adds the folder, the delivery, the Mbit/s, the run.log tail and the measured quality', async () => {
  const { call, submit, finished, out } = rig();
  const j = submit({ quality: 'max' });
  const log = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const folder = finished(j, { log });
  const r = await call('GET', `/jobs/${j.id}`);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.state, 'done');
  assert.equal(d.folder, folder);
  assert.equal(d.folder, join(out, j.folder_name));
  assert.deepEqual(d.delivery, { path: join(folder, 'delivery.mp4'), size_mib: 12.5, mbit_s: 59.5 });
  assert.equal(d.log_tail.length, 20);
  assert.equal(d.log_tail.at(-1), 'line 29');
  assert.deepEqual(d.quality_vs_master, { psnr: { mean: 47.1 }, ssim: { mean: 0.998 } });
  assert.equal(d.spec.preset, '3');
  assert.deepEqual(d.quality, { name: 'max', set: { tex_resolution: 4096, bake_resolution: 0, sample_count: 48 }, ss: 2 });
  assert.equal(d.progress.fraction, 1);
});

test('a queued job shows where it will land and why it waits; no files are read', async () => {
  const { call, submit, store, out } = rig();
  const j = submit();
  store.block(j.id, 'output root: /Volumes/home/komorebi/jobs does not exist');
  const d = (await call('GET', `/jobs/${j.id}`)).json;
  assert.equal(d.state, 'queued');
  assert.equal(d.blocked, 'output root: /Volumes/home/komorebi/jobs does not exist');
  assert.equal(d.folder, join(out, j.folder_name));
  assert.deepEqual([d.delivery, d.log_tail, d.quality_vs_master], [null, [], null]);
});

test('a failed job carries its error; a manifest without a measure gives quality_vs_master null', async () => {
  const { call, submit, store, finished } = rig();
  const f = submit();
  store.start(f.id, { folder: '/nowhere' });
  store.fail(f.id, 'exit code 1\nFAILED: boom');
  const d = (await call('GET', `/jobs/${f.id}`)).json;
  assert.equal(d.state, 'failed');
  assert.match(d.error, /FAILED: boom/);
  assert.equal(d.delivery, null);
  const g = submit();
  finished(g, { manifest: { delivery_probe: { mbit_s: 1, size_mib: 2 } } });
  assert.equal((await call('GET', `/jobs/${g.id}`)).json.quality_vs_master, null);
});

test('an unknown job, an unknown route and a wrong method are answered, not thrown', async () => {
  const { call } = rig();
  for (const path of ['/jobs/99', '/jobs/abc', '/jobs/1.5', '/jobs/0']) assert.equal((await call('GET', path)).status, 404);
  const none = await call('GET', '/nothing');
  assert.equal(none.status, 404);
  assert.match(none.json.error, /no such route/);
  const wrong = await call('PUT', '/jobs');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, 'GET, POST');
  assert.equal((await call('POST', '/health')).status, 405);
  assert.equal((await call('GET', '/jobs/')).status, 404);
});

test('DELETE /jobs/:id cancels a queued job at once and asks for a running one to be stopped', async () => {
  const { call, submit, store } = rig();
  const q = submit();
  const r = await call('DELETE', `/jobs/${q.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: q.id, cancel: 'cancelled', state: 'cancelled' });
  assert.equal(store.get(q.id).state, 'cancelled');

  const run = submit();
  store.start(run.id, { folder: '/x' });
  const r2 = await call('DELETE', `/jobs/${run.id}`);
  assert.equal(r2.status, 202);
  assert.deepEqual(r2.json, { id: run.id, cancel: 'requested', state: 'running' });
  assert.equal(store.get(run.id).cancel_requested, true);
});

test('DELETE on a finished job is 409, on an unknown one 404', async () => {
  const { call, submit, finished } = rig();
  const j = submit();
  finished(j);
  const r = await call('DELETE', `/jobs/${j.id}`);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already done/);
  assert.equal((await call('DELETE', '/jobs/77')).status, 404);
});

test('GET /health: idle, busy, blocked; the share is ok or missing; the pin is the commit', async () => {
  const { call, submit, store, nas } = rig();
  let h = (await call('GET', '/health')).json;
  assert.deepEqual(h, { ok: true, pin: SHA, worker: 'idle', nas: 'ok' });

  const j = submit();
  assert.equal((await call('GET', '/health')).json.worker, 'idle');   // queued and not yet blocked: the worker is about to take it
  nas.ok = false;
  store.block(j.id, 'output root: gone');
  h = (await call('GET', '/health')).json;
  assert.deepEqual([h.worker, h.nas, h.ok], ['blocked', 'missing', true]);

  nas.ok = true;
  store.block(j.id, null);
  store.start(j.id, { folder: '/x' });
  h = (await call('GET', '/health')).json;
  assert.deepEqual([h.worker, h.nas], ['busy', 'ok']);
});

test('GET /llms.txt is the repo\'s llms.txt, as text/plain', async () => {
  const { call } = rig();
  const r = await call('GET', '/llms.txt');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/plain/);
  assert.equal(r.text, readFileSync(new URL('../llms.txt', import.meta.url), 'utf8'));
});

test('the share token appears in no response: not when queued, listed, detailed, in the log tail, in an error, or in a refusal', async () => {
  const token = 'sh4reT0kenXYZ';
  const arb = 'arb-t0ken-123';
  const { call, submit, store, finished } = rig({ env: { ARBORETUM_TOKEN: arb } });
  const created = await call('POST', '/jobs', { ...SPEC, preset: `3@2:${token}` });
  assert.equal(created.status, 201);
  const id = created.json.id;
  const seen = [created.text];
  seen.push((await call('GET', '/jobs')).text, (await call('GET', `/jobs/${id}`)).text);

  // The exporter echoed the secrets into its log and the job failed with them in its error: the API hides them again.
  const folder = finished(store.get(id), { log: `fetching 3:${token}\nAuthorization: Bearer ${arb}\n` });
  store.progress(id, { done: 3, total: 3, line: `fetching 3:${token}` });
  seen.push((await call('GET', `/jobs/${id}`)).text, (await call('GET', '/jobs')).text);
  const failed = submit({ preset: `4:${token}` });
  store.start(failed.id, { folder });
  store.fail(failed.id, `boom with ${token} and ${arb}`);
  seen.push((await call('GET', `/jobs/${failed.id}`)).text, (await call('DELETE', `/jobs/${failed.id}`)).text);
  seen.push((await call('POST', '/jobs', { preset: `3:${token}`, size: 'huge', seconds: 5 })).text);
  for (const t of seen) { assert.ok(!t.includes(token), 'share token leaked'); assert.ok(!t.includes(arb), 'arboretum token leaked'); }
  assert.match(seen[3], /3:\*\*\*/);   // scrubbed in the log tail
  assert.match(JSON.parse(seen[1]).jobs[0].name, /^preset 3@2$/);
});

test('every registered route is in ROUTES with its method and pattern', () => {
  assert.deepEqual(ROUTES.map((r) => `${r.method} ${r.path}`), ['POST /jobs', 'GET /jobs', 'GET /jobs/:id', 'DELETE /jobs/:id', 'GET /health', 'GET /llms.txt']);
});

test('blocked reasons and refusals scrub credentials even when an invalid field repeats a share token', async () => {
  const token = 'share-for-redaction';
  const arb = 'arb-for-redaction';
  const { call, submit, store } = rig({ env: { ARBORETUM_TOKEN: arb } });
  const job = submit({ preset: `3:${token}` });
  store.block(job.id, `engine failed for ${token} and ${arb}`);
  const responses = [
    await call('GET', '/jobs'),
    await call('GET', `/jobs/${job.id}`),
    await call('POST', '/jobs', { ...SPEC, preset: `3:${token}`, [token]: true }),
  ];
  for (const response of responses) {
    assert.ok(!response.text.includes(token), 'share token leaked');
    assert.ok(!response.text.includes(arb), 'arboretum token leaked');
  }
});

test('over real HTTP: a round trip on port 0, an oversized body refused, a handler error answered as 500', async () => {
  const { api, store } = rig();
  const server = await listen(api, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = await fetch(`${base}/jobs`, { method: 'POST', body: JSON.stringify(SPEC), headers: { 'content-type': 'application/json' } });
    assert.equal(post.status, 201);
    assert.match(post.headers.get('content-type'), /^application\/json/);
    assert.equal((await post.json()).id, 1);
    const get = await fetch(`${base}/jobs/1`);
    assert.equal((await get.json()).state, 'queued');
    const big = await fetch(`${base}/jobs`, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) });
    assert.equal(big.status, 413);
    assert.equal((await fetch(`${base}/llms.txt`)).headers.get('content-type').split(';')[0], 'text/plain');
    store.close();   // the next request cannot reach the database
    const broken = await fetch(`${base}/jobs`);
    assert.equal(broken.status, 500);
    assert.deepEqual(await broken.json(), { error: 'internal error' });
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test('while health awaits a stalled NAS check, queued-job routes remain responsive over HTTP', async () => {
  const { store, config, submit } = rig();
  const job = submit();
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const api = createApi({ store, config, pin: { commit: SHA }, checkOut: () => stalled });
  const server = await listen(api, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  let healthDone = false;
  const health = fetch(`${base}/health`).then(async (response) => { healthDone = true; return response.json(); });
  try {
    assert.equal((await (await fetch(`${base}/jobs/${job.id}`)).json()).state, 'queued');
    assert.equal((await fetch(`${base}/jobs`)).status, 200);
    assert.equal(healthDone, false);
    assert.equal((await fetch(`${base}/jobs/${job.id}`, { method: 'DELETE' })).status, 200);
    release({ ok: true });
    assert.equal((await health).nas, 'ok');
  } finally {
    release({ ok: false });
    await health;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
