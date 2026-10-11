import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

test('CLI submit, status and list identify the effective pipeline without changing legacy specs', async () => {
  const state = mkdtempSync(join(tmpdir(), 'kr-cli-'));
  const file = join(state, 'spec.json');
  const env = { KOMOREBI_RENDER_STATE: state };
  const output = [];
  const io = { out: s => output.push(s), err: s => assert.fail(s) };
  for (const pipeline of [undefined, 'gpu', 'gpu-main10', 'browser']) {
    writeFileSync(file, JSON.stringify({ preset: '3', size: '1080p', seconds: 5, ...(pipeline ? { pipeline } : {}) }));
    assert.equal(await main(['submit', file], env, io), 0);
    const job = JSON.parse(output.pop());
    assert.equal(job.pipeline, pipeline ?? 'master');
    assert.equal(job.spec.pipeline, pipeline);
    assert.equal(await main(['status', String(job.id)], env, io), 0);
    assert.equal(JSON.parse(output.pop()).pipeline, pipeline ?? 'master');
  }
  assert.equal(await main(['list'], env, io), 0);
  const rows = output.map(s => s.split('\t'));
  assert.deepEqual(rows.map(row => row[4]), ['browser', 'gpu-main10', 'gpu', 'master']);
});
