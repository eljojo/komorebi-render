// A job's spec: validated once, at the door, into the canonical shape everything downstream reads.
import { checkQuality } from './quality.js';

export const DEFAULT_MAX_SECONDS = 6 * 3600;   // KOMOREBI_RENDER_MAX_SECONDS overrides: the config passes it in
export class SpecError extends Error {
  constructor(errors) { super(errors.join('; ')); this.name = 'SpecError'; this.errors = errors; }
}

const KEYS = ['preset', 'look', 'size', 'seconds', 'fps', 'master', 'delivery', 'quality'];
const PRESET = /^([1-9]\d*)(?:@([1-9]\d*))?(?::(\S+))?$/;   // the exporter's own --arboretum grammar
const BITRATE = /^[1-9]\d*(\.\d+)?[kKM]$/;   // ffmpeg reads a lowercase m as milli
const SIZES = { '1080p': '1920x1080', '4k': '3840x2160' };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseSize(s) {
  if (typeof s === 'string' && SIZES[s]) return SIZES[s];
  const m = typeof s === 'string' ? /^(\d{2,4})x(\d{2,4})$/.exec(s) : null;
  if (!m) return null;
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (w < 64 || h < 64 || w > 7680 || h > 4320 || w % 2 || h % 2) return null;
  return `${w}x${h}`;
}

export function validateSpec(raw, { maxSeconds = DEFAULT_MAX_SECONDS } = {}) {
  if (!isObject(raw)) throw new SpecError(['spec must be a JSON object']);
  const errors = [];
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  const spec = {};

  const hasPreset = raw.preset !== undefined, hasLook = raw.look !== undefined;
  if (hasPreset === hasLook) errors.push('exactly one of preset or look is required');
  if (hasPreset) {
    if (typeof raw.preset === 'string' && PRESET.test(raw.preset)) spec.preset = raw.preset;
    else errors.push('preset must look like "<id>[@version][:share]", e.g. "3", "3@2" or "3:token"');
  }
  if (hasLook) {
    if (!isObject(raw.look) || !isObject(raw.look.params)) errors.push('look.params must be an object');
    else if (raw.look.name !== undefined && typeof raw.look.name !== 'string') errors.push('look.name must be a string');
    else spec.look = raw.look.name === undefined ? { params: raw.look.params } : { name: raw.look.name, params: raw.look.params };
  }

  const size = parseSize(raw.size);
  if (size) spec.size = size; else errors.push('size must be "1080p", "4k" or an even "WxH" between 64x64 and 7680x4320');

  if (Number.isInteger(raw.seconds) && raw.seconds >= 1 && raw.seconds <= maxSeconds) spec.seconds = raw.seconds;
  else errors.push(`seconds must be a whole number from 1 to at most ${maxSeconds}`);

  if (raw.fps === undefined) spec.fps = 60;
  else if (raw.fps === 30 || raw.fps === 60) spec.fps = raw.fps;
  else errors.push('fps must be 30 or 60');

  if (raw.master === undefined) spec.master = false;
  else if (typeof raw.master === 'boolean') spec.master = raw.master;
  else errors.push('master must be true or false');

  if (raw.delivery !== undefined) {
    if (!isObject(raw.delivery)) errors.push('delivery must be an object');
    else {
      const d = raw.delivery, out = {};
      for (const k of Object.keys(d)) if (!['vt_bitrate', 'vt_quality'].includes(k)) errors.push(`delivery.${k} is not a delivery option; allowed: vt_bitrate, vt_quality`);
      if (d.vt_bitrate !== undefined && d.vt_quality !== undefined) errors.push('delivery takes vt_bitrate or vt_quality, not both');
      else {
        if (d.vt_bitrate !== undefined) {
          if (typeof d.vt_bitrate === 'string' && BITRATE.test(d.vt_bitrate)) out.vt_bitrate = d.vt_bitrate;
          else errors.push('delivery.vt_bitrate must look like "60M" or "8000k" (k, K or M; never a lowercase m)');
        }
        if (d.vt_quality !== undefined) {
          if (Number.isInteger(d.vt_quality) && d.vt_quality >= 0 && d.vt_quality <= 100) out.vt_quality = d.vt_quality;
          else errors.push('delivery.vt_quality must be a whole number from 0 to 100');
        }
      }
      if (Object.keys(out).length) spec.delivery = out;
    }
  }

  const q = checkQuality(raw.quality);
  errors.push(...q.errors);
  if (!q.errors.length) spec.quality = q.value;

  if (errors.length) throw new SpecError(errors);
  return spec;
}

export function slugify(s) {
  const slug = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'look';
}

// <yyyy-mm-dd>-<id>-<slug>. Only the preset's id is slugged: the version and the share token stay out of a folder name.
export function folderName({ id, createdAt, spec }) {
  const slug = spec.preset ? `preset-${spec.preset.split(/[@:]/)[0]}` : slugify(spec.look.name ?? 'look');
  return `${createdAt.slice(0, 10)}-${id}-${slug}`;
}

// The share token is a credential: it is stored (the exporter needs it to resume) but never shown.
export const redactSpec = (spec) => (spec.preset ? { ...spec, preset: spec.preset.replace(/:.+$/, ':…') } : spec);
