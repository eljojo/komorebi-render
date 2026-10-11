// The quality knobs a job may set, and what they cost. Only the exporter's own QUALITY_KEYS (render-video.mjs) may ever
// be passed as --set: they keep the look "as authored" in its manifest. Any other key would change the look, so nothing
// here can name one.
export const QUALITY_KEYS = ['tex_resolution', 'bake_resolution', 'sample_count'];
const CHOICES = {
  tex_resolution: [1024, 2048, 4096],
  bake_resolution: [0, 768, 1024, 1536, 2048],   // 0 follows tex_resolution
  ss: [1, 2],
};
const SAMPLES = [16, 48];   // the editor's own range (editor.js PANEL)
const MAX_SET = { tex_resolution: 4096, bake_resolution: 0, sample_count: 48 };
const FULL_HD = [1920, 1080];

// Returns { value, errors }: value is 'authored', 'max' or a normalised object; {} is "authored".
export function checkQuality(q) {
  if (q === undefined || q === 'authored') return { value: 'authored', errors: [] };
  if (q === 'max') return { value: 'max', errors: [] };
  const names = [...QUALITY_KEYS, 'ss'];
  if (q === null || typeof q !== 'object' || Array.isArray(q)) {
    return { errors: [`quality must be "authored", "max" or an object of ${names.join(', ')}`] };
  }
  const errors = [], value = {};
  for (const k of Object.keys(q)) {
    if (!names.includes(k)) errors.push(`quality.${k} is not a quality setting; allowed: ${names.join(', ')}`);
  }
  for (const k of ['tex_resolution', 'bake_resolution', 'ss']) {
    if (q[k] === undefined) continue;
    if (CHOICES[k].includes(q[k])) value[k] = q[k]; else errors.push(`quality.${k} must be one of ${CHOICES[k].join(', ')}`);
  }
  if (q.sample_count !== undefined) {
    if (Number.isInteger(q.sample_count) && q.sample_count >= SAMPLES[0] && q.sample_count <= SAMPLES[1]) value.sample_count = q.sample_count;
    else errors.push(`quality.sample_count must be a whole number from ${SAMPLES[0]} to ${SAMPLES[1]}`);
  }
  if (errors.length) return { errors };
  return { value: Object.keys(value).length ? value : 'authored', errors };
}

const sizeOf = (size) => size.split('x').map(Number);

// { name, set, ss }: `set` is exactly the --set pairs, `ss` the --ss factor (1 passes no flag).
// "max" supersamples 2x only when the output is 1080p or smaller: at 4K the render is already the size it costs.
export function resolveQuality({ size, quality = 'authored' }) {
  if (quality === 'authored') return { name: 'authored', set: {}, ss: 1 };
  const [w, h] = sizeOf(size);
  if (quality === 'max') return { name: 'max', set: { ...MAX_SET }, ss: w <= FULL_HD[0] && h <= FULL_HD[1] ? 2 : 1 };
  const set = {};
  for (const k of QUALITY_KEYS) if (quality[k] !== undefined) set[k] = quality[k];
  return { name: 'custom', set, ss: quality.ss ?? 1 };
}

// ms per frame, measured on the M4 mini. Authored: 15 at 1080p, 37 at 4K (between, by pixels). A 4096 bake dominates
// everything else (about 300 at any size); supersampling costs as the render of ss x ss times the pixels.
const PX_HD = FULL_HD[0] * FULL_HD[1], PX_4K = 3840 * 2160;
const authoredMs = (px) => {
  if (px <= PX_HD) return 15;
  if (px >= PX_4K) return Math.round(37 * (px / PX_4K));
  return Math.round(15 + (22 * (px - PX_HD)) / (PX_4K - PX_HD));
};
export function msPerFrame({ size, quality }) {
  const r = resolveQuality({ size, quality });
  if (r.name === 'max' || r.set.tex_resolution === 4096) return 300;
  const [w, h] = sizeOf(size);
  return authoredMs(w * h * r.ss * r.ss);
}

// A guess for the whole job, from the defaults above: a one-hour max-quality job at 60 fps is 18 hours, and says so.
export const estimateSeconds = (spec) => Math.round((spec.seconds * spec.fps * msPerFrame(spec)) / 1000);
