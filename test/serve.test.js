import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-exporter.mjs');
const SHA = 'a6b6fa25a98d47fa8ae312b4bfae4c9fde99f849';
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const configFor = (out, port) => loadConfig({ KOMOREBI_RENDER_STATE: join(out, 'state'), KOMOREBI_RENDER_OUT: out, KOMOREBI_RENDER_ALLOW_LOCAL: '1', KOMOREBI_RENDER_HOST: '127.0.0.1', KOMOREBI_RENDER_PORT: String(port) }, '/h');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'kr-serve-')));

test('serve runs the API and the worker in one process: a job posted over HTTP is rendered, then everything stops', async () => {
  const out = tmp();
  const lines = [];
  const prepared = { n: 0 };
  const svc = await serve({
    store: openStore(':memory:'), config: configFor(out, 0), pin: { commit: SHA }, log: (l) => lines.push(l),
    prepare: async () => { prepared.n++; return { script: FAKE, commit: SHA }; },
    workerOptions: { caffeinate: false, pollMs: 10, progressMs: 15, graceMs: 50 },
  });
  const port = svc.server.address().port;
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.ok(lines.some((l) => l.includes(`listening on 127.0.0.1:${port}`)));
    assert.equal((await (await fetch(`${base}/health`)).json()).worker, 'idle');

    const post = await fetch(`${base}/jobs`, { method: 'POST', body: JSON.stringify({ preset: '3', size: '1080p', seconds: 20 }) });
    assert.equal(post.status, 201);
    const { id, folder } = await post.json();
    await until(async () => (await (await fetch(`${base}/jobs/${id}`)).json()).state === 'done');
    const job = await (await fetch(`${base}/jobs/${id}`)).json();
    assert.equal(job.delivery.path, join(folder, 'delivery.mp4'));
    assert.equal(job.delivery.mbit_s, 59.5);
    assert.ok(existsSync(job.delivery.path));
    assert.equal(prepared.n, 1);   // the engine is prepared by the worker before its first job
  } finally {
    await svc.stop();
  }
  await svc.finished;   // the worker loop ended
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});

test('serve does not start the worker when the port is taken', async () => {
  const out = tmp();
  const opts = { pin: { commit: SHA }, log: () => {}, workerOptions: { pollMs: 10 } };
  const first = await serve({ ...opts, store: openStore(':memory:'), config: configFor(out, 0), prepare: async () => ({ script: FAKE, commit: SHA }) });
  try {
    const taken = first.server.address().port;
    await assert.rejects(serve({ ...opts, store: openStore(':memory:'), config: configFor(out, taken), prepare: async () => { throw new Error('the worker must not start'); } }), /EADDRINUSE/);
  } finally { await first.stop(); }
});

test('a failed worker closes the API so launchd can restart the whole service', async () => {
  const out = tmp();
  const store = openStore(':memory:');
  const closed = store.close;
  store.requeueRunning = () => { throw new Error('recovery failed'); };
  const svc = await serve({
    store, config: configFor(out, 0), pin: { commit: SHA }, log: () => {},
    prepare: async () => ({ script: FAKE, commit: SHA }),
  });
  try {
    await assert.rejects(svc.finished, /recovery failed/);
    assert.equal(svc.server.listening, false);
  } finally { await svc.stop(); closed(); }
});
