// Refuses an output root that is not a mounted network share: a render writes gigabytes, and a missing mount would
// silently fill the Mac's own disk with an ordinary folder at the same path.
import { constants } from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, sep } from 'node:path';

const NETWORK = /^(smbfs|afpfs|nfs\d*)$/;

// macOS: "//user@host/share on /Volumes/home (smbfs, nodev, ...)"   Linux: "host:/x on /mnt/x type nfs4 (rw,...)"
export function parseMounts(text) {
  const mounts = [];
  for (const line of text.split('\n')) {
    const m = /^(.*?) on (.+?) (?:type (\S+) )?\(([^,)]*)/.exec(line);
    if (m) mounts.push({ device: m[1], point: m[2], fstype: m[3] ?? m[4].trim() });
  }
  return mounts;
}

export function mountFor(path, mounts) {
  let best = null;
  for (const m of mounts) {
    const inside = path === m.point || path.startsWith(m.point.endsWith(sep) ? m.point : m.point + sep);
    if (inside && (!best || m.point.length > best.point.length)) best = m;
  }
  return best;
}

const run = promisify(execFile);
const readMountDefault = async () => (await run('mount', { encoding: 'utf8' })).stdout;

export async function checkOutputRoot(out, { readMount = readMountDefault, allowLocal = false, fs = fileSystem } = {}) {
  if (!out) return { ok: false, reason: 'KOMOREBI_RENDER_OUT is not set' };
  let real;
  try {
    if (!(await fs.stat(out)).isDirectory()) return { ok: false, reason: `${out} is not a directory` };
    real = await fs.realpath(out);
  } catch { return { ok: false, reason: `${out} does not exist` }; }
  try {
    await fs.access(out, constants.W_OK);
    // SMB reports W_OK generously; only a write proves it.
    const probe = join(out, `.komorebi-render-probe-${process.pid}`);
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
  } catch (e) { return { ok: false, reason: `${out} is not writable (${e.code ?? e.message})` }; }
  if (allowLocal) return { ok: true, fstype: 'local (KOMOREBI_RENDER_ALLOW_LOCAL)' };
  let mounts;
  try { mounts = parseMounts(await readMount()); } catch (e) { return { ok: false, reason: `cannot read the mount table: ${e.message}` }; }
  const m = mountFor(real, mounts);
  if (!m) return { ok: false, reason: `${real} is on no mount the mount table lists` };
  if (!NETWORK.test(m.fstype)) return { ok: false, reason: `${real} is not a network mount (it is on ${m.point}, ${m.fstype})` };
  return { ok: true, fstype: m.fstype };
}

// A stuck SMB syscall cannot be cancelled. Share its bounded answer until the actual probe settles, rather than
// starting another probe on each worker/API poll and eventually consuming the filesystem thread pool.
export function createOutputRootCheck(out, { timeoutMs = 5000, ...options } = {}) {
  let pending = null;
  return () => {
    if (pending) return pending;
    let finish;
    const answer = new Promise((resolve) => { finish = resolve; });
    pending = answer;
    const timer = setTimeout(() => finish({ ok: false, reason: `${out} check timed out` }), timeoutMs);
    checkOutputRoot(out, options).then((result) => {
      clearTimeout(timer);
      finish(result);
      pending = null;
    });
    return answer;
  };
}
