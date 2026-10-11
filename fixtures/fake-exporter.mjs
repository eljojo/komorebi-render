// Stands in for test-gl/render-video.mjs: the same flags in, the same files out (seg/*.json, run.log, manifest.json, delivery.mp4), no render.
// FAKE_MODE: ok (default) | fail | hang (one segment, then waits to be killed).  FAKE_SEGMENT_MS paces the segments.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const out = flag('--out');
const seconds = Number(flag('--seconds'));
const mode = process.env.FAKE_MODE || 'ok';
const pace = Number(process.env.FAKE_SEGMENT_MS || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => appendFileSync(join(out, 'run.log'), `${m}\n`);

mkdirSync(join(out, 'seg'), { recursive: true });
writeFileSync(join(out, 'argv.json'), JSON.stringify({ argv, sawToken: Boolean(process.env.ARBORETUM_TOKEN), browsers: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null }));
const total = Math.ceil(seconds / 10);
for (let i = 0; i < total; i++) {
  await sleep(pace);
  writeFileSync(join(out, 'seg', `seg_${String(i).padStart(5, '0')}.json`), '{}');
  log(`segment ${i} done`);
  if (mode === 'hang') await new Promise(() => setInterval(() => {}, 1000));
  if (mode === 'fail' && i === 0) { log('FAILED: boom'); process.exit(1); }
}
if (flag('--delivery') === 'none' && flag('--stills') === '0') {
  // Real 64x64 RGB PNG; verification decodes it with ffmpeg rather than trusting the extension.
  const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=green:s=${mode === 'wrong-size-png' ? '64x64' : flag('--size')}`,
    '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']);
  writeFileSync(join(out, 'master-still-00s.png'), mode === 'bad-png' ? 'broken PNG' : png);
  writeFileSync(join(out, 'seg', 'seg_00000.mkv'), 'lossless intermediate');
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ engine: { commit: flag('--commit') }, master: { segments_on_disk: true },
    frame_accounting: { exact: true, frames_requested: 1 } }));
  writeFileSync(join(out, 'complete.json'), JSON.stringify({ key: 'fake-key', frames: 1 }));
} else {
  writeFileSync(join(out, 'delivery.mp4'), 'x');
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ delivery: { bitrate_arg: '60M' }, delivery_probe: { mbit_s: 59.5, size_mib: 12.5, decoded_frames: seconds * 60 } }));
}
log('done');
process.exit(0);
