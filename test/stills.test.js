import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec, SpecError } from '../src/spec.js';
import { exporterArgs, finalizeImage } from '../src/exporter.js';
import { openStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { createWorker } from '../src/worker.js';
import { createApi } from '../src/api.js';
import { main } from '../src/cli.js';

const SHA = '12012228ddd68c21436b244269b4932d31b4aee3';
const IMAGE = { look: { name: 'Thumbnail', params: { wind_strength: 1.3 } }, size: '64x64', format: 'png', quality: 'max' };
const FAKE = fileURLToPath(new URL('../fixtures/fake-exporter.mjs', import.meta.url));

test('PNG specs take a look or preset, resolution and existing quality knobs without video timing', () => {
  assert.deepEqual(validateSpec(IMAGE), IMAGE);
  assert.deepEqual(validateSpec({ preset: '28@2:share', size: '641x361', format: 'png' }), {
    preset: '28@2:share', size: '641x361', format: 'png', quality: 'authored',
  });
  assert.equal(validateSpec({ ...IMAGE, size: '1080p', quality: { ss: 1, sample_count: 48 } }).size, '1920x1080');
});

test('PNG refuses video-only fields and invalid formats with their actual field names', () => {
  for (const [field, value] of Object.entries({ seconds: 15, fps: 30, master: true, pipeline: 'browser', delivery: { vt_quality: 100 } })) {
    assert.throws(() => validateSpec({ ...IMAGE, [field]: value }), e => e instanceof SpecError && e.fields[0] === field);
  }
  assert.throws(() => validateSpec({ ...IMAGE, format: 'jpeg' }), e => e instanceof SpecError && e.fields[0] === 'format');
});

test('explicit MP4 preserves the existing canonical video shape and timing validation', () => {
  const video = { preset: '3', size: '1080p', seconds: 15 };
  assert.deepEqual(validateSpec({ ...video, format: 'mp4' }), validateSpec(video));
  assert.throws(() => validateSpec({ preset: '3', size: '1080p', format: 'mp4' }), /seconds/);
});

test('PNG delegates one frame to the pinned exporter and extracts RGB from the master, with no MP4', () => {
  const args = exporterArgs({ script: FAKE, commit: SHA, folder: '/out', spec: IMAGE });
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(args[0], FAKE);
  assert.equal(value('--commit'), SHA);
  assert.equal(value('--look-json'), '/out/look-input.json');
  assert.equal(Number(value('--seconds')) * Number(value('--fps')), 1);
  assert.equal(value('--delivery'), 'none');
  assert.equal(value('--stills'), '0');
  assert.equal(value('--ss'), '2');
  assert.ok(args.includes('sample_count=48'));
  for (const flag of ['--discard-master', '--pipeline', '--vt-quality', '--vt-bitrate']) assert.ok(!args.includes(flag), flag);
});

function rig(extraEnv = {}) {
  const out = mkdtempSync(join(tmpdir(), 'kr-still-'));
  const config = loadConfig({ KOMOREBI_RENDER_STATE: join(out, 'state'), KOMOREBI_RENDER_OUT: out, KOMOREBI_RENDER_ALLOW_LOCAL: '1' });
  const store = openStore(':memory:');
  const worker = createWorker({ store, config, log: () => {}, prepare: async () => ({ script: FAKE, commit: SHA }),
    checkOut: async () => ({ ok: true }), caffeinate: false, progressMs: 10, extraEnv });
  const api = createApi({ store, config, pin: { commit: SHA }, log: () => {}, checkOut: async () => ({ ok: true }) });
  const call = async (method, url, body) => {
    const r = await api.handle({ method, url, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: JSON.parse(r.body) };
  };
  return { out, store, worker, call };
}

test('PNG goes through API, queue and worker to a verified image result with provenance and no MP4', async () => {
  const { store, worker, call } = rig();
  try {
    const created = await call('POST', '/jobs', IMAGE);
    assert.equal(created.status, 201);
    const id = created.data.id;
    const queued = (await call('GET', `/jobs/${id}`)).data;
    assert.equal(queued.format, 'png');
    assert.equal(queued.pipeline, null);
    assert.equal(queued.seconds, null);
    assert.equal(queued.fps, null);
    assert.equal(queued.eta_s, null);
    assert.deepEqual(queued.progress, { done: 0, total: 1, fraction: 0 });
    assert.equal((await worker.runOnce()).outcome, 'done', store.get(id).error);
    const done = (await call('GET', `/jobs/${id}`)).data;
    assert.equal(done.state, 'done');
    assert.equal(done.delivery.path, join(done.folder, 'delivery.png'));
    assert.equal(done.delivery.mime_type, 'image/png');
    assert.deepEqual([done.delivery.width, done.delivery.height], [64, 64]);
    assert.equal(done.delivery.mbit_s, null);
    assert.match(done.delivery.sha256, /^[a-f0-9]{64}$/);
    assert.ok(done.delivery.size_mib > 0);
    assert.deepEqual(done.progress, { done: 1, total: 1, fraction: 1 });
    assert.equal(existsSync(join(done.folder, 'delivery.mp4')), false);
    const manifest = JSON.parse(readFileSync(join(done.folder, 'manifest.json')));
    assert.equal(manifest.image.file, 'delivery.png');
    assert.equal(manifest.image.frame_index, 0);
    assert.equal(manifest.image.sha256, done.delivery.sha256);
    assert.equal(manifest.frame_accounting.exact, true);
    assert.equal(manifest.engine.commit, SHA);
    assert.equal(existsSync(join(done.folder, 'seg', 'seg_00000.mkv')), false);
    assert.equal(JSON.parse(readFileSync(join(done.folder, 'complete.json'))).master_discarded, true);
    assert.equal((await finalizeImage(done.folder, store.get(id).spec)).sha256, done.delivery.sha256);
  } finally { await worker.stop(); store.close(); }
});

test('PNG with a broken or wrong-size output fails instead of reporting a usable thumbnail', async () => {
  for (const mode of ['bad-png', 'wrong-size-png']) {
    const { store, worker, call } = rig({ FAKE_MODE: mode });
    try {
      const created = await call('POST', '/jobs', mode === 'wrong-size-png' ? { ...IMAGE, size: '66x66' } : IMAGE);
      assert.equal(created.status, 201);
      assert.equal((await worker.runOnce()).outcome, 'failed');
      const job = store.get(created.data.id);
      assert.equal(job.result, null);
      assert.match(job.error, mode === 'wrong-size-png' ? /dimensions/ : /PNG/);
    } finally { await worker.stop(); store.close(); }
  }
});

test('both guides document PNG requests, their output and omission of video fields', () => {
  for (const file of ['README.md', 'llms.txt']) {
    const doc = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const text of ['`format`', 'delivery.png', 'image/png', 'pre-roll']) assert.ok(doc.includes(text), `${file}: ${text}`);
    assert.match(doc, /"format"\s*:\s*"png"/);
    assert.match(doc, /(?:omit|refus|video.only).*seconds|seconds.*(?:omit|refus|video.only)/i);
  }
});

test('PNG preset credentials remain redacted and the job can be cancelled in the normal queue', async () => {
  const { store, worker, call } = rig();
  try {
    const created = await call('POST', '/jobs', { preset: '28@2:secret-share', size: '512x512', format: 'png' });
    assert.equal(created.status, 201);
    for (const url of ['/jobs', `/jobs/${created.data.id}`]) {
      const r = await call('GET', url);
      assert.ok(!JSON.stringify(r.data).includes('secret-share'));
    }
    assert.equal((await call('DELETE', `/jobs/${created.data.id}`)).status, 200);
    assert.equal(store.get(created.data.id).state, 'cancelled');
  } finally { await worker.stop(); store.close(); }
});

test('CLI submit/status/list identify PNG jobs without a video pipeline', async () => {
  const state = mkdtempSync(join(tmpdir(), 'kr-still-cli-'));
  const file = join(state, 'spec.json');
  writeFileSync(file, JSON.stringify(IMAGE));
  const output = [], env = { KOMOREBI_RENDER_STATE: state };
  const io = { out: s => output.push(s), err: s => assert.fail(s) };
  assert.equal(await main(['submit', file], env, io), 0);
  const job = JSON.parse(output.pop());
  assert.equal(job.format, 'png');
  assert.equal(await main(['status', String(job.id)], env, io), 0);
  assert.equal(JSON.parse(output.pop()).format, 'png');
  assert.equal(await main(['list'], env, io), 0);
  assert.ok(output.pop().split('\t').includes('png'));
});
