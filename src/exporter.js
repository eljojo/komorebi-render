// The seam to render-video.mjs: its argv from a spec and its output. Video results are read; PNG delivery and
// recovery metadata are finalized here. The exporter is komorebi's: there is one definition of a render.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { QUALITY_KEYS, resolveQuality } from './quality.js';

export const SEGMENT_SECONDS = 10;   // the exporter's --segment-seconds default; progress counts in these
// The look is passed from a file of ours, not from <folder>/look.json: the exporter rewrites that one as the look as
// rendered, and a resume that finds different bytes in its --look-json refuses on a changed run key.
export const LOOK_FILE = 'look-input.json';
const TAIL_BYTES = 4096;

export function exporterArgs({ script, commit, folder, spec }) {
  const q = resolveQuality(spec);
  const image = spec.format === 'png';
  const args = [script, ...(spec.preset ? ['--arboretum', spec.preset] : ['--look-json', join(folder, LOOK_FILE)]),
    '--commit', commit, '--out', folder, '--seconds', String(image ? 1 / 60 : spec.seconds), '--size', spec.size, '--fps', String(image ? 60 : spec.fps)];
  for (const k of QUALITY_KEYS) if (q.set[k] !== undefined) args.push('--set', `${k}=${q.set[k]}`);
  if (q.ss > 1) args.push('--ss', String(q.ss));
  if (image) return [...args, '--delivery', 'none', '--stills', '0'];
  if (spec.pipeline && spec.pipeline !== 'master') args.push('--pipeline', spec.pipeline);
  if (spec.delivery?.vt_bitrate) args.push('--vt-bitrate', spec.delivery.vt_bitrate);
  if (spec.delivery?.vt_quality !== undefined) args.push('--vt-quality', String(spec.delivery.vt_quality));
  if (!spec.master && (!spec.pipeline || spec.pipeline === 'master')) args.push('--discard-master');
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

export function readResult(folder, spec = {}) {
  const manifestFile = join(folder, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error('the exporter exited 0 but left no manifest.json');
  const delivery = join(folder, spec.format === 'png' ? 'delivery.png' : 'delivery.mp4');
  if (!existsSync(delivery)) throw new Error(`the exporter exited 0 but left no ${spec.format === 'png' ? 'delivery.png' : 'delivery.mp4'}`);
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (spec.format === 'png') {
    if (!m.image) throw new Error('the PNG has no verified image manifest');
    return { delivery, mime_type: 'image/png', size_mib: m.image.bytes / 2 ** 20, mbit_s: null, frames: 1,
      bitrate_arg: null, width: m.image.width, height: m.image.height, sha256: m.image.sha256 };
  }
  const p = m.delivery_probe ?? {};
  return { delivery, mbit_s: p.mbit_s ?? null, size_mib: p.size_mib ?? null, frames: p.decoded_frames ?? null, bitrate_arg: m.delivery?.bitrate_arg ?? null };
}

// A single frame goes through the exporter's existing render and linear downscale, never through a lossy MP4.
// Commit the verified PNG before marking the master discarded, so recovery can reuse the completed exporter run.
export async function finalizeImage(folder, spec) {
  const manifestPath = join(folder, 'manifest.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!m.frame_accounting?.exact || m.frame_accounting.frames_requested !== 1) throw new Error('PNG requires exact one-frame accounting');
  const source = existsSync(join(folder, 'master-still-00s.png')) ? join(folder, 'master-still-00s.png') : join(folder, 'delivery.png');
  const bytes = readFileSync(source);
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('invalid PNG signature');
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)('ffmpeg', ['-hide_banner', '-v', 'error', '-xerror', '-i', source, '-map', '0:v:0', '-f', 'framehash', '-']));
  } catch (e) { throw new Error(`PNG decode failed: ${e.stderr || e.message}`); }
  const dimensions = /^#dimensions 0:\s+(\d+)x(\d+)$/m.exec(stdout);
  const decoded = stdout.split('\n').filter(line => /^0,/.test(line));
  const [width, height] = spec.size.split('x').map(Number);
  if (!dimensions || Number(dimensions[1]) !== width || Number(dimensions[2]) !== height || decoded.length !== 1) throw new Error('PNG decoded dimensions or frame count disagree with the job');
  const image = { file: 'delivery.png', mime_type: 'image/png', width, height, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), frame_index: 0, source: 'lossless RGB master after standard pre-roll and optional linear supersampling' };
  if (source !== join(folder, 'delivery.png')) renameSync(source, join(folder, 'delivery.png'));
  m.image = image;
  Object.assign(m.master, { discarded: true, segments_on_disk: false });
  writeFileSync(`${manifestPath}.part`, `${JSON.stringify(m, null, 2)}\n`);
  renameSync(`${manifestPath}.part`, manifestPath);
  const completePath = join(folder, 'complete.json');
  const complete = JSON.parse(readFileSync(completePath, 'utf8'));
  writeFileSync(`${completePath}.part`, JSON.stringify({ ...complete, master_discarded: true }));
  renameSync(`${completePath}.part`, completePath);
  for (const file of readdirSync(join(folder, 'seg'))) if (/^seg_\d+\.mkv$/.test(file)) unlinkSync(join(folder, 'seg', file));
  return readResult(folder, spec);
}
