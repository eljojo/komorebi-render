import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, SpecError, folderName, slugify, redactSpec, scrubSecrets, SPEC_KEYS, DELIVERY_KEYS, DEFAULT_MAX_SECONDS } from '../src/spec.js';

const ok = (raw) => validateSpec(raw);
const bad = (raw, re) => assert.throws(() => validateSpec(raw), (e) => e instanceof SpecError && re.test(e.message));

test('a preset job gets its defaults and a canonical size', () => {
  assert.deepEqual(ok({ preset: '3', size: '1080p', seconds: 300 }), {
    preset: '3', size: '1920x1080', seconds: 300, fps: 60, master: false, quality: 'authored',
  });
  assert.equal(ok({ preset: '3', size: '4k', seconds: 10 }).size, '3840x2160');
  assert.equal(ok({ preset: '3', size: '1280x720', seconds: 10 }).size, '1280x720');
});

test('preset accepts id, @version and :share, and nothing else', () => {
  for (const p of ['3', '3@2', '3:abc-DEF_9', '12@4:tok']) assert.equal(ok({ preset: p, size: '1080p', seconds: 5 }).preset, p);
  for (const p of ['0', 'x', '3@', '3 4', '', '@2', '3@0', 3]) bad({ preset: p, size: '1080p', seconds: 5 }, /preset/);
});

test('exactly one of preset and look', () => {
  bad({ size: '1080p', seconds: 5 }, /exactly one of preset or look/);
  bad({ preset: '3', look: { params: {} }, size: '1080p', seconds: 5 }, /exactly one of preset or look/);
});

test('a look carries params, and may carry a name', () => {
  const s = ok({ look: { name: 'My Look', params: { sample_count: 8 } }, size: '1080p', seconds: 5 });
  assert.deepEqual(s.look, { name: 'My Look', params: { sample_count: 8 } });
  bad({ look: {}, size: '1080p', seconds: 5 }, /look\.params/);
  bad({ look: { params: [] }, size: '1080p', seconds: 5 }, /look\.params/);
  bad({ look: { params: {}, name: 4 }, size: '1080p', seconds: 5 }, /look\.name/);
});

test('size is 1080p, 4k or an even WxH inside sane bounds', () => {
  for (const s of ['720p', '1921x1080', '10x10', '8000x4000', '1920x', 'x', 1080]) bad({ preset: '3', size: s, seconds: 5 }, /size/);
  bad({ preset: '3', seconds: 5 }, /size/);
});

test('seconds is a whole number from 1 to the configured maximum (6 h by default)', () => {
  for (const s of [0, 1.5, '10', -4, NaN, undefined]) bad({ preset: '3', size: '1080p', seconds: s }, /seconds/);
  assert.equal(ok({ preset: '3', size: '1080p', seconds: 1 }).seconds, 1);
  assert.equal(ok({ preset: '3', size: '4k', seconds: 3 * 3600 }).seconds, 10800);   // an hours-long job is a normal job
  assert.equal(ok({ preset: '3', size: '1080p', seconds: DEFAULT_MAX_SECONDS }).seconds, 21600);
  bad({ preset: '3', size: '1080p', seconds: DEFAULT_MAX_SECONDS + 1 }, /seconds.*21600/);
});

test('the maximum is a parameter, and the refusal names it', () => {
  assert.equal(validateSpec({ preset: '3', size: '1080p', seconds: 600 }, { maxSeconds: 600 }).seconds, 600);
  assert.throws(() => validateSpec({ preset: '3', size: '1080p', seconds: 601 }, { maxSeconds: 600 }), (e) => e instanceof SpecError && /at most 600/.test(e.message));
});

test('fps is 30 or 60, master is a boolean', () => {
  assert.equal(ok({ preset: '3', size: '1080p', seconds: 5, fps: 30 }).fps, 30);
  for (const f of [24, '60', 120]) bad({ preset: '3', size: '1080p', seconds: 5, fps: f }, /fps/);
  assert.equal(ok({ preset: '3', size: '1080p', seconds: 5, master: true }).master, true);
  bad({ preset: '3', size: '1080p', seconds: 5, master: 'yes' }, /master/);
});

test('delivery takes vt_bitrate or vt_quality, not both', () => {
  const base = { preset: '3', size: '4k', seconds: 5 };
  assert.deepEqual(ok({ ...base, delivery: { vt_bitrate: '80M' } }).delivery, { vt_bitrate: '80M' });
  assert.deepEqual(ok({ ...base, delivery: { vt_bitrate: '8000k' } }).delivery, { vt_bitrate: '8000k' });
  assert.deepEqual(ok({ ...base, delivery: { vt_quality: 100 } }).delivery, { vt_quality: 100 });
  assert.equal('delivery' in ok({ ...base, delivery: {} }), false);
  bad({ ...base, delivery: { vt_bitrate: '60m' } }, /vt_bitrate/);   // ffmpeg reads a lowercase m as milli
  bad({ ...base, delivery: { vt_quality: 101 } }, /vt_quality/);
  bad({ ...base, delivery: { vt_quality: 1.5 } }, /vt_quality/);
  bad({ ...base, delivery: { vt_bitrate: '60M', vt_quality: 50 } }, /not both/);
  bad({ ...base, delivery: { codec: 'x' } }, /delivery\.codec/);
});

test('unknown keys are refused, and every problem is reported at once', () => {
  bad({ preset: '3', size: '1080p', seconds: 5, extra: 1 }, /unknown key "extra"/);
  assert.throws(() => validateSpec({ preset: 'x', size: 'y', seconds: 0 }), (e) => e.errors.length === 3);
  bad(null, /object/);
  bad([], /object/);
});

test('folder: date, id, slug of the preset id or the look name', () => {
  const at = '2026-10-10T23:59:00.000Z';
  assert.equal(folderName({ id: 7, createdAt: at, spec: ok({ preset: '3@2', size: '1080p', seconds: 5 }) }), '2026-10-10-7-preset-3');
  assert.equal(folderName({ id: 8, createdAt: at, spec: ok({ look: { name: 'Évening Light / v2', params: {} }, size: '1080p', seconds: 5 }) }), '2026-10-10-8-vening-light-v2');
  assert.equal(folderName({ id: 9, createdAt: at, spec: ok({ look: { params: {} }, size: '1080p', seconds: 5 }) }), '2026-10-10-9-look');
});

test('the share token never reaches a folder name or a redacted spec', () => {
  const spec = ok({ preset: '3@2:s3cr3t', size: '1080p', seconds: 5 });
  assert.ok(!folderName({ id: 1, createdAt: '2026-01-01T00:00:00Z', spec }).includes('s3cr3t'));
  assert.equal(redactSpec(spec).preset, '3@2:…');
  assert.equal(redactSpec(ok({ preset: '3', size: '1080p', seconds: 5 })).preset, '3');
});

test('slugify bounds the length and has a fallback', () => {
  assert.equal(slugify('  A  B  '), 'a-b');
  assert.equal(slugify('!!!'), 'look');
  assert.ok(slugify('x'.repeat(200)).length <= 40);
});

test('every refusal names the field it is about', () => {
  const fields = (raw) => { try { validateSpec(raw); } catch (e) { return e.fields; } };
  assert.deepEqual(fields({ preset: '3', size: '1080p', seconds: 5, bogus: 1 }), ['bogus']);
  assert.deepEqual(fields({ preset: 'x', size: '8k', seconds: 0 }), ['preset', 'size', 'seconds']);
  assert.deepEqual(fields({ size: '1080p', seconds: 5 }), ['preset']);
  assert.deepEqual(fields({ preset: '3', size: '1080p', seconds: 5, fps: 24, master: 1 }), ['fps', 'master']);
  assert.deepEqual(fields({ preset: '3', size: '1080p', seconds: 5, delivery: { vt_bitrate: '60m' } }), ['delivery.vt_bitrate']);
  assert.deepEqual(fields({ preset: '3', size: '1080p', seconds: 5, delivery: { vt_bitrate: '6M', vt_quality: 5 } }), ['delivery']);
  assert.deepEqual(fields({ preset: '3', size: '1080p', seconds: 5, quality: { tex_resolution: 3000 } }), ['quality.tex_resolution']);
  assert.deepEqual(fields({ preset: '3', size: '1080p', seconds: 5, quality: 'best' }), ['quality']);
  assert.deepEqual(fields({ look: { params: 3 }, size: '1080p', seconds: 5 }), ['look.params']);
  assert.deepEqual(fields([]), [null]);
});

test('the keys the validator knows are exported, for the docs that must list them', () => {
  assert.deepEqual(SPEC_KEYS, ['preset', 'look', 'size', 'seconds', 'fps', 'master', 'delivery', 'quality', 'pipeline']);
  assert.deepEqual(DELIVERY_KEYS, ['vt_bitrate', 'vt_quality']);
});

test('pipeline is optional for older specs and accepts the four export mechanisms independently of quality', () => {
  const base = { preset: '3', size: '1080p', seconds: 5 };
  assert.equal('pipeline' in ok(base), false);
  for (const pipeline of ['master', 'gpu', 'gpu-main10', 'browser']) {
    for (const quality of ['authored', 'max', { ss: 1 }, { ss: 2 }]) {
      assert.equal(ok({ ...base, pipeline, quality }).pipeline, pipeline);
    }
  }
  for (const pipeline of ['fast', '', null, 1, {}]) bad({ ...base, pipeline }, /pipeline.*master.*gpu.*gpu-main10.*browser/);
});

test('direct pipelines refuse retained masters; browser refuses delivery controls', () => {
  const base = { preset: '3', size: '1080p', seconds: 5 };
  for (const pipeline of ['gpu', 'gpu-main10', 'browser']) {
    assert.throws(() => ok({ ...base, pipeline, master: true }), e => e instanceof SpecError && e.fields[0] === 'master');
    assert.equal(ok({ ...base, pipeline, master: false }).master, false);
  }
  assert.equal(ok({ ...base, pipeline: 'master', master: true }).master, true);
  for (const pipeline of ['gpu', 'gpu-main10']) assert.deepEqual(ok({ ...base, pipeline, delivery: { vt_quality: 100 } }).delivery, { vt_quality: 100 });
  assert.equal('delivery' in ok({ ...base, pipeline: 'browser', delivery: {} }), false);
  for (const delivery of [{ vt_quality: 100 }, { vt_bitrate: '80M' }]) {
    assert.throws(() => ok({ ...base, pipeline: 'browser', delivery }), e => e instanceof SpecError && e.fields[0] === 'delivery');
  }
});

test('scrubSecrets hides the arboretum token and the preset share token wherever they appear', () => {
  const spec = ok({ preset: '3@2:shareTOK', size: '1080p', seconds: 5 });
  const text = 'fetching 3:shareTOK with Bearer arbTOK; again shareTOK';
  assert.equal(scrubSecrets(text, spec, 'arbTOK'), 'fetching 3:*** with Bearer ***; again ***');
  assert.equal(scrubSecrets('plain', ok({ look: { params: {} }, size: '1080p', seconds: 5 }), null), 'plain');
});
