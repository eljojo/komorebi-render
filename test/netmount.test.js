import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMounts, mountFor, checkOutputRoot } from '../src/netmount.js';
import * as netmount from '../src/netmount.js';
import * as fs from 'node:fs/promises';

const MAC = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)
//jojo@nas.local/home on /Volumes/home (smbfs, nodev, nosuid, mounted by jojo)
nas.local:/export on /Volumes/nfsdata (nfs, nodev, nosuid, mounted by jojo)
`;

const outDir = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kr-out-')));
  const out = join(root, 'jobs');
  mkdirSync(out);
  return { root, out };
};
const mountsFor = (root, fstype) => `/dev/disk3s1s1 on / (apfs, local)\n//nas/home on ${root} (${fstype}, nodev, nosuid)\n`;

test('output access bounds and retains one stalled operation across readers', async () => {
  assert.equal(typeof netmount.createOutputAccess, 'function');
  const access = netmount.createOutputAccess({ timeoutMs: 10 });
  let release, calls = 0;
  const stalled = new Promise(resolve => { release = resolve; });
  const read = async () => { calls++; await stalled; return 'ok'; };
  const first = access('progress', read);
  assert.equal(access('progress', read), first);
  await assert.rejects(first, /timed out/);
  await assert.rejects(access('detail', read), /busy/);
  await assert.rejects(access('progress', read), /timed out/);
  assert.equal(calls, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await access('detail', read), 'ok');
  assert.equal(calls, 2);
});

test('parseMounts reads macOS and Linux mount lines', () => {
  const m = parseMounts(`${MAC}host:/x on /mnt/x type nfs4 (rw,relatime)\n`);
  assert.deepEqual(m.find((x) => x.point === '/Volumes/home'), { device: '//jojo@nas.local/home', point: '/Volumes/home', fstype: 'smbfs' });
  assert.equal(m.find((x) => x.point === '/').fstype, 'apfs');
  assert.equal(m.find((x) => x.point === '/mnt/x').fstype, 'nfs4');
});

test('mountFor picks the longest mount point that contains the path', () => {
  const m = parseMounts(MAC);
  assert.equal(mountFor('/Volumes/home/komorebi/jobs', m).fstype, 'smbfs');
  assert.equal(mountFor('/Volumes/homework', m).fstype, 'apfs');   // a prefix of the name is not a parent directory
  assert.equal(mountFor('/Users/jojo', m).fstype, 'apfs');
});

test('a writable smbfs / nfs / afpfs mount passes', async () => {
  for (const t of ['smbfs', 'nfs', 'afpfs']) {
    const { root, out } = outDir();
    const r = await checkOutputRoot(out, { readMount: () => mountsFor(root, t) });
    assert.deepEqual(r, { ok: true, fstype: t });
  }
});

test('a local filesystem is refused, naming it', async () => {
  const { root, out } = outDir();
  const r = await checkOutputRoot(out, { readMount: () => mountsFor(root, 'apfs') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a network mount.*apfs/);
});

test('KOMOREBI_RENDER_ALLOW_LOCAL skips the mount check but not the folder checks', async () => {
  const { out } = outDir();
  const boom = () => { throw new Error('mount must not be read'); };
  assert.equal((await checkOutputRoot(out, { readMount: boom, allowLocal: true })).ok, true);
  const gone = await checkOutputRoot(join(out, 'nope'), { readMount: boom, allowLocal: true });
  assert.equal(gone.ok, false);
});

test('a missing output root is refused, and not created', async () => {
  const { out } = outDir();
  const r = await checkOutputRoot(join(out, 'missing'), { readMount: () => '' });
  assert.match(r.reason, /does not exist/);
});

test('an unwritable output root is refused', { skip: process.getuid?.() === 0 }, async () => {
  const { root, out } = outDir();
  chmodSync(out, 0o555);
  try {
    const r = await checkOutputRoot(out, { readMount: () => mountsFor(root, 'smbfs') });
    assert.match(r.reason, /not writable/);
  } finally { chmodSync(out, 0o755); }
});

test('an unset output root is refused', async () => {
  assert.match((await checkOutputRoot(null, { readMount: () => '' })).reason, /KOMOREBI_RENDER_OUT/);
});

test('a mount table that cannot be read refuses rather than guesses', async () => {
  const { out } = outDir();
  const r = await checkOutputRoot(out, { readMount: () => { throw new Error('mount: not found'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /mount: not found/);
});

test('a stalled write probe is asynchronous and a bounded shared check starts no more probes until it settles', async () => {
  const { out } = outDir();
  let release, writes = 0;
  const stalled = new Promise((resolve) => { release = resolve; });
  const check = netmount.createOutputRootCheck(out, {
    allowLocal: true, timeoutMs: 25,
    fs: { ...fs, writeFile: async () => { writes++; await stalled; }, unlink: async () => {} },
  });
  const first = check();
  assert.equal(check(), first);
  const result = await first;
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out/);
  assert.equal(writes, 1);
  assert.equal(await check(), result);
  assert.equal(writes, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await check()).ok, true);
  assert.equal(writes, 2);
});
