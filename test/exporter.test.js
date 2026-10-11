import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exporterArgs, exporterCommand, progress, readResult, etaSeconds, LOOK_FILE } from '../src/exporter.js';

const SHA = 'a6b6fa25a98d47fa8ae312b4bfae4c9fde99f849';
const base = { script: '/e/test-gl/render-video.mjs', commit: SHA, folder: '/out/2026-10-10-1-preset-3' };
const spec = (extra = {}) => ({ preset: '3', size: '1920x1080', seconds: 300, fps: 60, master: false, ...extra });

test('a preset job: the exporter argv, with --discard-master unless a master is asked for', () => {
  assert.deepEqual(exporterArgs({ ...base, spec: spec() }), [
    '/e/test-gl/render-video.mjs', '--arboretum', '3', '--commit', SHA, '--out', base.folder,
    '--seconds', '300', '--size', '1920x1080', '--fps', '60', '--discard-master',
  ]);
  assert.ok(!exporterArgs({ ...base, spec: spec({ master: true }) }).includes('--discard-master'));
});

test('a look job reads the look from a file beside the exporter output, never from look.json', () => {
  const args = exporterArgs({ ...base, spec: { look: { params: { a: 1 } }, size: '3840x2160', seconds: 10, fps: 30, master: true } });
  const i = args.indexOf('--look-json');
  assert.equal(args[i + 1], join(base.folder, LOOK_FILE));
  assert.notEqual(LOOK_FILE, 'look.json');   // the exporter rewrites look.json: reading it back would change the run key
  assert.ok(!args.includes('--arboretum'));
  assert.equal(args[args.indexOf('--size') + 1], '3840x2160');
});

test('delivery options become the exporter flags', () => {
  const a = exporterArgs({ ...base, spec: spec({ delivery: { vt_bitrate: '80M' } }) });
  assert.equal(a[a.indexOf('--vt-bitrate') + 1], '80M');
  const b = exporterArgs({ ...base, spec: spec({ delivery: { vt_quality: 100 } }) });
  assert.equal(b[b.indexOf('--vt-quality') + 1], '100');
});

test('caffeinate wraps the node run only where it exists', () => {
  const args = ['x.mjs', '--a'];
  assert.deepEqual(exporterCommand({ node: '/bin/node', args, caffeinate: true }), { cmd: 'caffeinate', args: ['-i', '/bin/node', 'x.mjs', '--a'] });
  assert.deepEqual(exporterCommand({ node: '/bin/node', args, caffeinate: false }), { cmd: '/bin/node', args });
});

const folderWith = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-prog-'));
  mkdirSync(join(dir, 'seg'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

test('progress counts finished segment jsons over ceil(seconds / 10)', () => {
  const dir = folderWith({
    'seg/seg_00000.json': '{}', 'seg/seg_00000.mkv': '', 'seg/seg_00000.hashes': '',
    'seg/seg_00001.json': '{}', 'seg/seg_00002.mkv': '',   // segment 2 is rendering: no json yet
    'seg/list.txt': '', 'run.log': '[10:00:00] first\n[10:00:09] segment 1 done\n\n',
  });
  assert.deepEqual(progress(dir, 45), { done: 2, total: 5, fraction: 0.4, lastLine: '[10:00:09] segment 1 done' });
});

test('progress is zero before anything exists, and never passes the total', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-prog-'));
  assert.deepEqual(progress(dir, 25), { done: 0, total: 3, fraction: 0, lastLine: null });
  const full = folderWith({ 'seg/seg_00000.json': '{}', 'seg/seg_00001.json': '{}', 'seg/seg_00002.json': '{}' });
  assert.equal(progress(full, 10).done, 1);
});

test('progress over a 3-hour job: hundreds of segments, and a run.log of megabytes read from its end', () => {
  const files = {};
  for (let i = 0; i < 500; i++) files[`seg/seg_${String(i).padStart(5, '0')}.json`] = '{}';
  const lines = Array.from({ length: 60000 }, (_, i) => `[10:00:00] line ${i} ${'x'.repeat(60)}`);
  files['run.log'] = `${lines.join('\n')}\n`;
  const dir = folderWith(files);
  const p = progress(dir, 3 * 3600);
  assert.deepEqual([p.done, p.total], [500, 1080]);
  assert.equal(p.lastLine, lines.at(-1));
});

test('a last line longer than the read window is cut, not an error', () => {
  const dir = folderWith({ 'run.log': `short\n${'y'.repeat(100000)}\n` });
  const { lastLine } = progress(dir, 10);
  assert.ok(lastLine.length > 0 && lastLine.length <= 4096);
});

test('ETA extrapolates from the segments finished since this attempt began', () => {
  const t0 = Date.parse('2026-10-10T12:00:00Z');
  // 100 of 1080 done in 1000 s of this attempt: 10 s each, 980 left
  assert.equal(etaSeconds({ startedAt: new Date(t0).toISOString(), now: t0 + 1000_000, done: 100, base: 0, total: 1080 }), 9800);
  // resumed with 400 already on disk: only the 100 new ones count toward the rate
  assert.equal(etaSeconds({ startedAt: new Date(t0).toISOString(), now: t0 + 1000_000, done: 500, base: 400, total: 1080 }), 5800);
  assert.equal(etaSeconds({ startedAt: new Date(t0).toISOString(), now: t0 + 5000, done: 0, base: 0, total: 10 }), null);
});

test('the result is the manifest delivery path and bitrate', () => {
  const dir = folderWith({
    'delivery.mp4': 'x',
    'manifest.json': JSON.stringify({ delivery: { bitrate_arg: '60M' }, delivery_probe: { mbit_s: 58.2, size_mib: 41.5, decoded_frames: 600 } }),
  });
  assert.deepEqual(readResult(dir), { delivery: join(dir, 'delivery.mp4'), mbit_s: 58.2, size_mib: 41.5, frames: 600, bitrate_arg: '60M' });
});

test('a clean exit without a manifest or delivery is an error, not a result', () => {
  assert.throws(() => readResult(folderWith({})), /manifest\.json/);
  assert.throws(() => readResult(folderWith({ 'manifest.json': '{}' })), /delivery\.mp4/);
});
