// llms.txt is how a bot learns to use the server: it must not drift from the code. These tests hold it to the routes the server
// registers and the fields the validator knows; the examples it gives must be specs the validator accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTES } from '../src/api.js';
import { SPEC_KEYS, DELIVERY_KEYS, DEFAULT_MAX_SECONDS, validateSpec } from '../src/spec.js';
import { QUALITY_FIELDS, QUALITY_CHOICES } from '../src/quality.js';
import { loadConfig } from '../src/config.js';

const doc = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');
const states = ['queued', 'running', 'done', 'failed', 'cancelled'];

test('every route the server registers is in llms.txt, as "METHOD /path"', () => {
  assert.ok(ROUTES.length >= 6);
  for (const r of ROUTES) assert.ok(doc.includes(`${r.method} ${r.path}`), `llms.txt does not document ${r.method} ${r.path}`);
});

test('every spec field the validator knows is documented, as `field`', () => {
  const fields = [...SPEC_KEYS, 'look.name', 'look.params', ...DELIVERY_KEYS.map((k) => `delivery.${k}`), ...QUALITY_FIELDS.map((k) => `quality.${k}`)];
  for (const f of fields) assert.ok(doc.includes(`\`${f}\``), `llms.txt does not document \`${f}\``);
});

test('the allowed quality values, the seconds limit and the defaults are the code\'s', () => {
  for (const k of ['tex_resolution', 'bake_resolution', 'ss']) assert.ok(doc.includes(QUALITY_CHOICES[k].join(', ')), `${k}: ${QUALITY_CHOICES[k].join(', ')}`);
  const [lo, hi] = QUALITY_CHOICES.sample_count;
  assert.ok(doc.includes(`${lo} to ${hi}`), 'sample_count range');
  assert.ok(doc.includes(String(DEFAULT_MAX_SECONDS)), 'the default maximum seconds');
  const c = loadConfig({}, '/h');
  assert.ok(doc.includes(String(c.port)), 'the default port');
  assert.ok(doc.includes('KOMOREBI_RENDER_HOST') || doc.includes(c.host), 'the listen address');
  for (const s of states) assert.ok(doc.includes(`\`${s}\``), `state ${s}`);
});

test('every example spec (a ```json spec block) is accepted by the validator', () => {
  const blocks = [...doc.matchAll(/```json spec\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 3, 'at least a preset, a look and a quality example');
  for (const b of blocks) assert.doesNotThrow(() => validateSpec(JSON.parse(b)), b);
});

test('the etiquette an agent must follow is written down', () => {
  for (const must of ['every 10 seconds', 'one worker', 'run.log', 'never resubmit blindly', 'hours']) assert.ok(doc.includes(must), `etiquette: ${must}`);
});
