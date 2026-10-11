import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, SpecError } from '../src/spec.js';
import { resolveQuality, msPerFrame, estimateSeconds } from '../src/quality.js';
import { exporterArgs } from '../src/exporter.js';
import { jobView } from '../src/view.js';

const base = (extra = {}) => ({ preset: '3', size: '1080p', seconds: 60, ...extra });
const bad = (raw, re) => assert.throws(() => validateSpec(raw), (e) => e instanceof SpecError && re.test(e.message));
const SHA = 'a6b6fa25a98d47fa8ae312b4bfae4c9fde99f849';
const args = (spec) => exporterArgs({ script: 's.mjs', commit: SHA, folder: '/o', spec: validateSpec(spec) });
const sets = (a) => a.flatMap((x, i) => (a[i - 1] === '--set' ? [x] : []));

test('quality defaults to authored, and every form validates', () => {
  assert.equal(validateSpec(base()).quality, 'authored');
  assert.equal(validateSpec(base({ quality: 'authored' })).quality, 'authored');
  assert.equal(validateSpec(base({ quality: 'max' })).quality, 'max');
  const o = { tex_resolution: 2048, bake_resolution: 0, sample_count: 32, ss: 2 };
  assert.deepEqual(validateSpec(base({ quality: o })).quality, o);
  assert.deepEqual(validateSpec(base({ quality: { bake_resolution: 768 } })).quality, { bake_resolution: 768 });
  assert.equal(validateSpec(base({ quality: {} })).quality, 'authored');
});

test('refusals name what is allowed', () => {
  bad(base({ quality: 'ultra' }), /quality.*"authored".*"max"/);
  bad(base({ quality: { tex_resolution: 3000 } }), /tex_resolution.*1024, 2048, 4096/);
  bad(base({ quality: { bake_resolution: 512 } }), /bake_resolution.*0, 768, 1024, 1536, 2048/);
  bad(base({ quality: { sample_count: 8 } }), /sample_count.*16 to 48/);
  bad(base({ quality: { sample_count: 20.5 } }), /sample_count.*16 to 48/);
  bad(base({ quality: { ss: 3 } }), /ss.*1, 2/);
  bad(base({ quality: { adaptive_motion: true } }), /quality\.adaptive_motion.*tex_resolution, bake_resolution, sample_count, ss/);
  bad(base({ quality: 5 }), /quality/);
});

test('max: tex 4096, bake follows tex, 48 samples; supersampled 2x only at 1080p or smaller', () => {
  assert.deepEqual(resolveQuality({ size: '1920x1080', quality: 'max' }), { name: 'max', set: { tex_resolution: 4096, bake_resolution: 0, sample_count: 48 }, ss: 2 });
  assert.deepEqual(resolveQuality({ size: '1280x720', quality: 'max' }).ss, 2);
  assert.deepEqual(resolveQuality({ size: '3840x2160', quality: 'max' }), { name: 'max', set: { tex_resolution: 4096, bake_resolution: 0, sample_count: 48 }, ss: 1 });
  assert.deepEqual(resolveQuality({ size: '1920x1080', quality: 'authored' }), { name: 'authored', set: {}, ss: 1 });
});

test('max at 1080p maps to the exporter argv with --ss 2; at 4K without it', () => {
  const a = args(base({ quality: 'max' }));
  assert.deepEqual(sets(a), ['tex_resolution=4096', 'bake_resolution=0', 'sample_count=48']);
  assert.equal(a[a.indexOf('--ss') + 1], '2');
  const b = args(base({ size: '4k', quality: 'max' }));
  assert.deepEqual(sets(b), ['tex_resolution=4096', 'bake_resolution=0', 'sample_count=48']);
  assert.ok(!b.includes('--ss'));
});

test('authored passes no --set and no --ss; an object passes only what it names', () => {
  const a = args(base());
  assert.ok(!a.includes('--set') && !a.includes('--ss'));
  const o = args(base({ quality: { tex_resolution: 2048, ss: 2 } }));
  assert.deepEqual(sets(o), ['tex_resolution=2048']);
  assert.equal(o[o.indexOf('--ss') + 1], '2');
});

test('no key outside the three quality keys can reach --set, whatever the spec carries', () => {
  const spec = validateSpec(base({ quality: 'max' }));
  spec.quality = { tex_resolution: 4096, adaptive_motion: false, evil: 1 };   // bypassing validation on purpose
  const a = exporterArgs({ script: 's.mjs', commit: SHA, folder: '/o', spec });
  assert.deepEqual(sets(a), ['tex_resolution=4096']);
  assert.throws(() => validateSpec(base({ look: { params: {} }, preset: undefined, quality: { '--set': 'x' } })), SpecError);
});

test('ETA defaults in ms per frame: authored 15 / 37, max about 300', () => {
  const q = (size, quality) => msPerFrame({ size, quality, fps: 60 });
  assert.equal(q('1920x1080', 'authored'), 15);
  assert.equal(q('3840x2160', 'authored'), 37);
  assert.equal(q('1920x1080', 'max'), 300);
  assert.equal(q('3840x2160', 'max'), 300);
  assert.equal(q('1920x1080', { ss: 2 }), 37);   // supersampling a 1080p costs about a 4K render
  assert.equal(q('1920x1080', { tex_resolution: 4096 }), 300);
});

test('a one-hour max-quality job at 60 fps is estimated at 18 hours, and not refused', () => {
  const spec = validateSpec(base({ seconds: 3600, quality: 'max' }));
  assert.equal(estimateSeconds(spec), 18 * 3600);
  assert.equal(spec.seconds, 3600);
});

const job = (over = {}) => {
  const spec = validateSpec(base({ seconds: 100, preset: '3:tok' }));
  return { id: 1, state: 'queued', spec, quality: resolveQuality(spec), seg_done: 0, seg_base: 0, seg_total: 10, started_at: null, ...over };
};

test('the job view redacts the share token, shows quality and an estimated ETA before it starts', () => {
  const v = jobView(job(), Date.now());
  assert.equal(v.spec.preset, '3:…');
  assert.equal(v.quality.name, 'authored');
  assert.equal(v.progress.fraction, 0);
  assert.deepEqual([v.eta.seconds, v.eta.basis], [Math.round(100 * 60 * 15 / 1000), 'estimate']);
});

test('once segments finish the ETA is measured; finished jobs have none', () => {
  const t0 = Date.parse('2026-10-10T12:00:00Z');
  const run = jobView(job({ state: 'running', seg_done: 2, started_at: new Date(t0).toISOString() }), t0 + 20_000);
  assert.deepEqual([run.eta.seconds, run.eta.basis], [80, 'measured']);
  assert.equal(jobView(job({ state: 'done', seg_done: 10 }), t0).eta, null);
});
