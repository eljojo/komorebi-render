// The HTTP API over the job store: JSON over node:http, no framework, no auth (the LAN; auth comes before any exposure beyond it).
// `createApi` returns `handle({ method, url, body })` -> { status, headers, body }, which is all the logic and what the tests call;
// `listener` is the thin node:http shell around it (reads the body, writes the answer). The same database as the worker's is the
// only channel: a submit writes a row, the worker takes it; a cancel sets a flag, the worker stops the exporter.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StoreError } from './store.js';
import { SpecError, scrubSecrets, validateSpec } from './spec.js';
import { jobView } from './view.js';
import { tailLines } from './exporter.js';
import { checkOutputRoot } from './netmount.js';

const MAX_BODY = 1024 * 1024;   // a look's params are tens of KB
const LLMS = new URL('../llms.txt', import.meta.url);

const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: `${JSON.stringify(body, null, 2)}\n` });
const text = (status, body) => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body });

// The name a job goes by: its preset (version kept, share token never) or its look's name.
const nameOf = (spec) => (spec.preset ? `preset ${spec.preset.replace(/:.+$/, '')}` : spec.look.name ?? 'look');

function summary(job, now, token) {
  const v = jobView(job, now);
  return {
    id: job.id, state: job.state, name: nameOf(job.spec),
    size: job.spec.size, seconds: job.spec.seconds, fps: job.spec.fps, quality: job.quality,
    progress: v.progress, eta_s: v.eta?.seconds ?? null, eta_basis: v.eta?.basis ?? null,
    blocked: job.blocked === null ? null : scrubSecrets(job.blocked, job.spec, token), created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at,
  };
}

function readManifest(folder) {
  try { return JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')); } catch { return null; }
}

// ROUTES is the registry: llms.txt must document every entry (test/llms.test.js).
function post({ store, config }, _params, { body }) {
  let raw;
  try { raw = JSON.parse(body); } catch { return json(400, { error: 'the body must be a JSON job spec' }); }
  let spec;
  try { spec = validateSpec(raw, { maxSeconds: config.maxSeconds }); } catch (e) {
    if (!(e instanceof SpecError)) throw e;
    const scrub = (value) => value === null ? null : scrubSecrets(value, { preset: typeof raw?.preset === 'string' ? raw.preset : undefined }, config.token);
    return json(422, { error: scrub(e.errors[0]), field: scrub(e.fields[0]), errors: e.errors.map((error, i) => ({ field: scrub(e.fields[i]), error: scrub(error) })) });
  }
  const job = store.create(spec);
  return json(201, { id: job.id, state: job.state, folder: config.out ? join(config.out, job.folder_name) : null });
}

function list({ store, config, now }) {
  const at = now();
  return json(200, { jobs: store.list().map((j) => summary(j, at, config.token)) });
}

function detail({ store, config, now }, { id }) {
  const job = store.get(id);
  if (!job) return json(404, { error: `no job ${id}` });
  const scrub = (t) => (t === null || t === undefined ? t : scrubSecrets(t, job.spec, config.token));
  const folder = job.folder ?? (config.out ? join(config.out, job.folder_name) : null);
  const started = job.folder !== null;
  const manifest = started ? readManifest(job.folder) : null;
  const r = job.result;
  return json(200, {
    ...summary(job, now(), config.token),
    spec: jobView(job).spec,
    folder,
    delivery: r ? { path: r.delivery, size_mib: r.size_mib, mbit_s: r.mbit_s } : null,
    error: scrub(job.error), last_line: scrub(job.last_line),
    log_tail: started && existsSync(join(job.folder, 'run.log')) ? scrub(tailLines(join(job.folder, 'run.log'))).split('\n').filter(Boolean) : [],
    quality_vs_master: manifest?.quality_vs_master ?? null,
    cancel_requested: job.cancel_requested, attempts: job.attempts,
  });
}

function cancel({ store }, { id }) {
  const job = store.get(id);
  if (!job) return json(404, { error: `no job ${id}` });
  let how;
  try { how = store.requestCancel(id); } catch (e) {
    if (e instanceof StoreError) return json(409, { error: e.message });
    throw e;
  }
  return json(how === 'cancelled' ? 200 : 202, { id, cancel: how, state: store.get(id).state });
}

function health({ store, config, pin, checkOut }) {
  const worker = store.list({ state: 'running' }).length ? 'busy' : store.list({ state: 'queued' }).some((j) => j.blocked) ? 'blocked' : 'idle';
  return json(200, { ok: true, pin: pin.commit, worker, nas: checkOut().ok ? 'ok' : 'missing' });
}

function llms({ llmsFile }) {
  return text(200, readFileSync(llmsFile, 'utf8'));
}

export const ROUTES = [
  { method: 'POST', path: '/jobs', run: post },
  { method: 'GET', path: '/jobs', run: list },
  { method: 'GET', path: '/jobs/:id', run: detail },
  { method: 'DELETE', path: '/jobs/:id', run: cancel },
  { method: 'GET', path: '/health', run: health },
  { method: 'GET', path: '/llms.txt', run: llms },
];

// -> params, or null. :id is a positive whole number; anything else is a path that names no job.
function match(pattern, path) {
  const want = pattern.split('/'), have = path.split('/');
  if (want.length !== have.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i] === ':id') {
      if (!/^[1-9]\d*$/.test(have[i])) return null;
      params.id = Number(have[i]);
    } else if (want[i] !== have[i]) return null;
  }
  return params;
}

export function createApi({ store, config, pin, checkOut, now = Date.now, log = console.error, llmsFile = LLMS }) {
  const ctx = { store, config, pin, now, llmsFile, checkOut: checkOut ?? (() => checkOutputRoot(config.out, { allowLocal: config.allowLocal })) };

  function handle({ method, url, body }) {
    try {
      const path = new URL(url, 'http://localhost').pathname;
      const hits = ROUTES.map((r) => ({ r, params: match(r.path, path) })).filter((h) => h.params);
      if (!hits.length) return json(404, { error: `no such route: ${path}` });
      const hit = hits.find((h) => h.r.method === method);
      if (!hit) return json(405, { error: `${method} is not allowed on ${path}` }, { allow: hits.map((h) => h.r.method).sort().join(', ') });
      return hit.r.run(ctx, hit.params, { body });
    } catch (e) {
      log(`komorebi-render: ${e.message}`);
      return json(500, { error: 'internal error' });
    }
  }

  function listener(req, res) {
    const chunks = [];
    let size = 0, tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) tooBig = true; else chunks.push(c); });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      const r = tooBig ? json(413, { error: `the body is over ${MAX_BODY} bytes` }) : handle({ method: req.method, url: req.url, body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined });
      res.writeHead(r.status, { ...r.headers, 'content-length': Buffer.byteLength(r.body) });
      res.end(r.body);
    });
  }

  return { handle, listener };
}

export function listen(api, { host, port }) {
  return new Promise((resolve, reject) => {
    const server = createServer(api.listener);
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
