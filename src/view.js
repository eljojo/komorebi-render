// A job as the CLI and the API show it: the share token hidden, progress and an ETA worked out.
import { redactSpec } from './spec.js';
import { estimateSeconds } from './quality.js';
import { etaSeconds } from './exporter.js';

export function jobView(job, now = Date.now()) {
  const { spec, quality, seg_done: done, seg_base: base, seg_total: total } = job;
  let eta = null;
  if (spec.format !== 'png' && (job.state === 'queued' || job.state === 'running')) {
    const measured = job.state === 'running' ? etaSeconds({ startedAt: job.started_at, now, done, base, total }) : null;
    // Before the first segment of this attempt there is no rate: the measured ms/frame stand in, and the basis says so.
    eta = measured !== null ? { seconds: measured, basis: 'measured' } : { seconds: Math.round(estimateSeconds(spec) * (1 - done / total)), basis: 'estimate' };
  }
  const { pid, cancel_requested: _c, seg_done: _d, seg_base: _b, seg_total: _t, ...rest } = job;
  return { ...rest, format: spec.format ?? 'mp4', pipeline: spec.format === 'png' ? null : spec.pipeline ?? 'master', spec: redactSpec(spec), cancel_requested: job.cancel_requested, progress: { done, total, fraction: total ? done / total : 0 }, eta };
}
