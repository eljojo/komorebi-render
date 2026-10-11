import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { validateSpec } from '../src/spec.js';

const spec = (extra = {}) => validateSpec({ preset: '3', size: '1080p', seconds: 25, ...extra });
const clock = () => { let n = 0; return () => new Date(Date.UTC(2026, 9, 10, 12, 0, n++)).toISOString(); };
const fresh = () => openStore(':memory:', { now: clock() });

test('a new job is queued, with an id, a folder name, a segment total and a created time', () => {
  const s = fresh();
  const j = s.create(spec());
  assert.equal(j.id, 1);
  assert.equal(j.state, 'queued');
  assert.equal(j.folder_name, '2026-10-10-1-preset-3');
  assert.equal(j.seg_total, 3);
  assert.equal(j.created_at, '2026-10-10T12:00:00.000Z');
  assert.equal(j.started_at, null);
  assert.deepEqual(j.spec, spec());
  assert.deepEqual(j.quality, { name: 'authored', set: {}, ss: 1 });
});

test('queued -> running -> done, with timestamps, progress and a result', () => {
  const s = fresh();
  const { id } = s.create(spec());
  assert.equal(s.start(id, { folder: '/out/x', base: 1 }), true);
  s.setPid(id, 4242);
  s.progress(id, { done: 2, total: 3, line: 'seg 1' });
  let j = s.get(id);
  assert.deepEqual([j.state, j.seg_done, j.seg_base, j.last_line, j.pid, j.folder, j.attempts], ['running', 2, 1, 'seg 1', 4242, '/out/x', 1]);
  assert.ok(j.started_at);
  s.finish(id, { delivery: '/out/x/delivery.mp4', mbit_s: 60 });
  j = s.get(id);
  assert.equal(j.state, 'done');
  assert.ok(j.finished_at);
  assert.equal(j.pid, null);
  assert.deepEqual(j.result, { delivery: '/out/x/delivery.mp4', mbit_s: 60 });
});

test('running -> failed keeps the reason', () => {
  const s = fresh();
  const { id } = s.create(spec());
  s.start(id, { folder: '/f' });
  s.fail(id, 'exit 1: boom');
  assert.deepEqual([s.get(id).state, s.get(id).error], ['failed', 'exit 1: boom']);
});

test('transitions are guarded', () => {
  const s = fresh();
  const { id } = s.create(spec());
  assert.throws(() => s.finish(id, {}), /not running/);
  assert.throws(() => s.fail(id, 'x'), /not running/);
  s.start(id, { folder: '/f' });
  assert.equal(s.start(id, { folder: '/f' }), false);   // already taken
  s.finish(id, {});
  assert.throws(() => s.requestCancel(id), /already done/);
  assert.throws(() => s.get(99) ?? (() => { throw new Error('none'); })(), /none/);
});

test('cancel: a queued job is cancelled at once, a running one is asked and then cancelled', () => {
  const s = fresh();
  const q = s.create(spec()), r = s.create(spec());
  assert.equal(s.requestCancel(q.id), 'cancelled');
  assert.equal(s.get(q.id).state, 'cancelled');
  s.start(r.id, { folder: '/f' });
  assert.equal(s.requestCancel(r.id), 'requested');
  assert.equal(s.get(r.id).cancel_requested, true);
  assert.equal(s.get(r.id).state, 'running');
  s.cancelled(r.id);
  assert.equal(s.get(r.id).state, 'cancelled');
  assert.ok(s.get(r.id).finished_at);
});

test('nextQueued is first-in first-out and skips what is not queued', () => {
  const s = fresh();
  const a = s.create(spec()), b = s.create(spec());
  assert.equal(s.nextQueued().id, a.id);
  s.start(a.id, { folder: '/f' });
  assert.equal(s.nextQueued().id, b.id);
  s.requestCancel(b.id);
  assert.equal(s.nextQueued(), null);
});

test('requeueRunning at startup: running goes back to queued, a cancel that was asked is honoured, finished jobs are untouched', () => {
  const s = fresh();
  const run = s.create(spec()), asked = s.create(spec()), done = s.create(spec());
  for (const j of [run, asked, done]) s.start(j.id, { folder: '/f' });
  s.setPid(run.id, 77);
  s.requestCancel(asked.id);
  s.finish(done.id, {});
  const requeued = s.requeueRunning();
  assert.deepEqual(requeued.map((j) => [j.id, j.pid]), [[run.id, 77], [asked.id, null]]);
  assert.equal(s.get(run.id).state, 'queued');
  assert.equal(s.get(run.id).pid, null);
  assert.equal(s.get(run.id).attempts, 1);
  assert.equal(s.get(asked.id).state, 'cancelled');
  assert.equal(s.get(done.id).state, 'done');
  s.start(run.id, { folder: '/f' });
  assert.equal(s.get(run.id).attempts, 2);
});

test('release puts one running job back in the queue', () => {
  const s = fresh();
  const { id } = s.create(spec());
  s.start(id, { folder: '/f' });
  s.release(id);
  assert.equal(s.get(id).state, 'queued');
});

test('block records why a queued job is waiting, and starting clears it', () => {
  const s = fresh();
  const { id } = s.create(spec());
  s.block(id, 'NAS not mounted');
  assert.deepEqual([s.get(id).state, s.get(id).blocked], ['queued', 'NAS not mounted']);
  s.start(id, { folder: '/f' });
  assert.equal(s.get(id).blocked, null);
});

test('list returns newest first, filtered by state', () => {
  const s = fresh();
  const a = s.create(spec()), b = s.create(spec());
  s.start(a.id, { folder: '/f' });
  assert.deepEqual(s.list().map((j) => j.id), [b.id, a.id]);
  assert.deepEqual(s.list({ state: 'running' }).map((j) => j.id), [a.id]);
});

test('jobs survive closing and reopening the file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kr-db-')), 'jobs.sqlite');
  const a = openStore(file);
  const { id } = a.create(spec());
  a.close();
  assert.equal(openStore(file).get(id).state, 'queued');
});
