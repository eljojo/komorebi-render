// The seam to render-video.mjs: its argv from a spec, and what it leaves in the output folder (read, never changed:
// the exporter is komorebi's, and there is one definition of a render).
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { QUALITY_KEYS, resolveQuality } from './quality.js';

export const SEGMENT_SECONDS = 10;   // the exporter's --segment-seconds default; progress counts in these
// The look is passed from a file of ours, not from <folder>/look.json: the exporter rewrites that one as the look as
// rendered, and a resume that finds different bytes in its --look-json refuses on a changed run key.
export const LOOK_FILE = 'look-input.json';
const TAIL_BYTES = 4096;

export function exporterArgs({ script, commit, folder, spec }) {
  const q = resolveQuality(spec);
  const args = [script, ...(spec.preset ? ['--arboretum', spec.preset] : ['--look-json', join(folder, LOOK_FILE)]),
    '--commit', commit, '--out', folder, '--seconds', String(spec.seconds), '--size', spec.size, '--fps', String(spec.fps)];
  for (const k of QUALITY_KEYS) if (q.set[k] !== undefined) args.push('--set', `${k}=${q.set[k]}`);
  if (q.ss > 1) args.push('--ss', String(q.ss));
  if (spec.delivery?.vt_bitrate) args.push('--vt-bitrate', spec.delivery.vt_bitrate);
  if (spec.delivery?.vt_quality !== undefined) args.push('--vt-quality', String(spec.delivery.vt_quality));
  if (!spec.master) args.push('--discard-master');
  return args;
}

// caffeinate -i: a render of hours must not idle-sleep. Only where it exists.
export function exporterCommand({ node, args, caffeinate }) {
  return caffeinate ? { cmd: 'caffeinate', args: ['-i', node, ...args] } : { cmd: node, args };
}

// The last line of a file, reading only its end: run.log of a long render is megabytes and is polled every few seconds.
export function tailLine(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8').trimEnd();
    return text.slice(text.lastIndexOf('\n') + 1) || null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// The last lines of run.log, for a failure message.
export function tailLines(file, n = 20, bytes = 16384) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').trimEnd().split('\n').slice(-n).join('\n');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

// Finished segments are the seg_NNNNN.json the exporter writes once a segment's master, hashes and checkpoint are committed.
export function progress(folder, seconds) {
  const total = Math.ceil(seconds / SEGMENT_SECONDS);
  let done = 0;
  try { done = readdirSync(join(folder, 'seg')).filter((f) => /^seg_\d+\.json$/.test(f)).length; } catch { /* nothing rendered yet */ }
  done = Math.min(done, total);
  return { done, total, fraction: total ? done / total : 0, lastLine: tailLine(join(folder, 'run.log')) };
}

// Seconds left, from the rate of this attempt only: segments already on disk when it began (a resume) were not rendered in its time.
export function etaSeconds({ startedAt, now, done, base = 0, total }) {
  const fresh = done - base;
  if (fresh <= 0) return null;
  const elapsed = (now - Date.parse(startedAt)) / 1000;
  return Math.round((elapsed / fresh) * (total - done));
}

export function readResult(folder) {
  const manifestFile = join(folder, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error('the exporter exited 0 but left no manifest.json');
  const delivery = join(folder, 'delivery.mp4');
  if (!existsSync(delivery)) throw new Error('the exporter exited 0 but left no delivery.mp4');
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const p = m.delivery_probe ?? {};
  return { delivery, mbit_s: p.mbit_s ?? null, size_mib: p.size_mib ?? null, frames: p.decoded_frames ?? null, bitrate_arg: m.delivery?.bitrate_arg ?? null };
}
