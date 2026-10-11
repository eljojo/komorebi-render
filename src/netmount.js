// Refuses an output root that is not a mounted network share: a render writes gigabytes, and a missing mount would
// silently fill the Mac's own disk with an ordinary folder at the same path.
import { accessSync, constants, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

const readMountDefault = () => execFileSync('mount', { encoding: 'utf8' });

export function checkOutputRoot(out, { readMount = readMountDefault, allowLocal = false } = {}) {
  if (!out) return { ok: false, reason: 'KOMOREBI_RENDER_OUT is not set' };
  let real;
  try {
    if (!statSync(out).isDirectory()) return { ok: false, reason: `${out} is not a directory` };
    real = realpathSync(out);
  } catch { return { ok: false, reason: `${out} does not exist` }; }
  try {
    accessSync(out, constants.W_OK);
    // SMB reports W_OK generously; only a write proves it.
    const probe = join(out, `.komorebi-render-probe-${process.pid}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (e) { return { ok: false, reason: `${out} is not writable (${e.code ?? e.message})` }; }
  if (allowLocal) return { ok: true, fstype: 'local (KOMOREBI_RENDER_ALLOW_LOCAL)' };
  let mounts;
  try { mounts = parseMounts(readMount()); } catch (e) { return { ok: false, reason: `cannot read the mount table: ${e.message}` }; }
  const m = mountFor(real, mounts);
  if (!m) return { ok: false, reason: `${real} is on no mount the mount table lists` };
  if (!NETWORK.test(m.fstype)) return { ok: false, reason: `${real} is not a network mount (it is on ${m.point}, ${m.fstype})` };
  return { ok: true, fstype: m.fstype };
}
