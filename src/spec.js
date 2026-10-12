// A job's spec: validated once, at the door, into the canonical shape everything downstream reads.
import { checkQuality } from './quality.js';

export const DEFAULT_MAX_SECONDS = 6 * 3600;   // KOMOREBI_RENDER_MAX_SECONDS overrides: the config passes it in
// `fields[i]` is the field `errors[i]` is about (null for the whole spec): the API answers 422 with it.
export class SpecError extends Error {
  constructor(errors) { super(errors.join('; ')); this.name = 'SpecError'; this.errors = errors; this.fields = errors.map(fieldOf); }
}

export const SPEC_KEYS = ['preset', 'look', 'size', 'seconds', 'fps', 'master', 'delivery', 'quality', 'pipeline', 'format'];
export const PIPELINES = ['master', 'gpu', 'gpu-main10', 'browser'];
export const DELIVERY_KEYS = ['vt_bitrate', 'vt_quality'];
const KEYS = SPEC_KEYS;

// Every message starts with the field it is about ("seconds must be…", "quality.ss must be…") except two.
function fieldOf(message) {
  const unknown = /^unknown key "(.*)"$/.exec(message);
  if (unknown) return unknown[1];
  if (message.startsWith('exactly one of preset or look')) return 'preset';
  const m = /^((?:look|delivery|quality)\.\w+|\w+)/.exec(message);
  return m && (KEYS.includes(m[1].split('.')[0])) ? m[1] : null;
}
const PRESET = /^([1-9]\d*)(?:@([1-9]\d*))?(?::(\S+))?$/;   // the exporter's own --arboretum grammar
const BITRATE = /^[1-9]\d*(\.\d+)?[kKM]$/;   // ffmpeg reads a lowercase m as milli
const SIZES = { '1080p': '1920x1080', '4k': '3840x2160' };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseSize(s, image = false) {
  if (typeof s === 'string' && Object.hasOwn(SIZES, s)) return SIZES[s];
  const m = typeof s === 'string' ? /^(\d{2,4})x(\d{2,4})$/.exec(s) : null;
  if (!m) return null;
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (w < 64 || h < 64 || w > 7680 || h > 4320 || (!image && (w % 2 || h % 2))) return null;
  return `${w}x${h}`;
}

export function validateSpec(raw, { maxSeconds = DEFAULT_MAX_SECONDS } = {}) {
  if (!isObject(raw)) throw new SpecError(['spec must be a JSON object']);
  const errors = [];
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  const spec = {};
  const image = raw.format === 'png';
  if (raw.format !== undefined && !['png', 'mp4'].includes(raw.format)) errors.push('format must be png or mp4');
  if (image) spec.format = 'png';

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

  const size = parseSize(raw.size, image);
  if (size) spec.size = size; else errors.push(`size must be "1080p", "4k" or ${image ? 'a' : 'an even'} "WxH" between 64x64 and 7680x4320`);

  if (image) {
    for (const k of ['seconds', 'fps', 'master', 'delivery', 'pipeline']) {
      if (raw[k] !== undefined) errors.push(`${k} is a video option; omit it for PNG`);
    }
  } else {
    if (Number.isInteger(raw.seconds) && raw.seconds >= 1 && raw.seconds <= maxSeconds) spec.seconds = raw.seconds;
    else errors.push(`seconds must be a whole number from 1 to at most ${maxSeconds}`);

    if (raw.fps === undefined) spec.fps = 60;
    else if (raw.fps === 30 || raw.fps === 60) spec.fps = raw.fps;
    else errors.push('fps must be 30 or 60');

    if (raw.master === undefined) spec.master = false;
    else if (typeof raw.master === 'boolean') spec.master = raw.master;
    else errors.push('master must be true or false');

    // Omitted pipeline stays omitted in stored specs, preserving older jobs and their exporter run keys.
    if (raw.pipeline !== undefined) {
      if (PIPELINES.includes(raw.pipeline)) spec.pipeline = raw.pipeline;
      else errors.push('pipeline must be master, gpu, gpu-main10 or browser');
    }
    if (spec.pipeline && spec.pipeline !== 'master' && spec.master === true) errors.push('master must be false for a direct pipeline; only master retains lossless segments');

    if (raw.delivery !== undefined) {
      if (!isObject(raw.delivery)) errors.push('delivery must be an object');
      else {
        const d = raw.delivery, out = {};
        if (spec.pipeline === 'browser' && Object.keys(d).length) errors.push('delivery must be omitted or empty for browser; it uses fixed HEVC QP1');
        for (const k of Object.keys(d)) if (!DELIVERY_KEYS.includes(k)) errors.push(`delivery.${k} is not a delivery option; allowed: vt_bitrate, vt_quality`);
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

// Hides the arboretum token and the preset's share token in text that may carry them (the exporter's output, a log line).
export function scrubSecrets(text, spec, token) {
  let t = String(text);
  const share = spec.preset?.split(':')[1];
  for (const secret of [token, share]) if (secret) t = t.split(secret).join('***');
  return t;
}
