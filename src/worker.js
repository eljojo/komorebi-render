// The loop that runs jobs, one at a time. The exporter is a child process; the database is the only channel to it
// (progress out, cancel in), so a CLI or API in another process drives the same worker.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LOOK_FILE, exporterArgs, exporterCommand, finalizeImage, progress, readResult, tailLines } from './exporter.js';
import { createOutputAccess, createOutputRootCheck } from './netmount.js';
import { childEnv } from './engine.js';
import { scrubSecrets } from './spec.js';

const defaultIsOurs = (pid) => {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && /render-video\.mjs/.test(r.stdout);   // a reused pid is not ours
};

export function createWorker({
  store, config, log = console.log, prepare, checkOut, outputAccess = createOutputAccess(),
  spawn = nodeSpawn, kill = process.kill.bind(process), isOurs = defaultIsOurs,
  node = process.execPath, caffeinate = process.platform === 'darwin' && existsSync('/usr/bin/caffeinate'),
  pollMs = 5000, progressMs = 3000, graceMs = 30000, extraEnv = {},
}) {
  const check = checkOut ?? createOutputRootCheck(config.out, { allowLocal: config.allowLocal });
  const sleepers = new Set();
  const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(done, ms); function done() { clearTimeout(t); sleepers.delete(done); resolve(); } sleepers.add(done); });
  let stopping = false, preparing = null, current = null;
  const preparation = new AbortController();

  // The token may sit in the exporter's output; it must not reach the database or a log line.
  const scrub = (text, spec) => scrubSecrets(text, spec, config.token);

  const ensurePrepared = () => {
    if (!preparing) preparing = Promise.resolve().then(() => prepare({ signal: preparation.signal })).catch((e) => { preparing = null; throw e; });
    return preparing;
  };

  const block = (job, reason) => {
    if (job.blocked !== reason) log(`job ${job.id} waits: ${reason}`);
    store.block(job.id, reason);
    return { job, outcome: 'blocked' };
  };

  // The exporter runs under caffeinate in its own process group: SIGTERM to the group reaches caffeinate and node together.
  const terminate = (child) => {
    try { kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  };

  async function runOnce() {
    if (stopping) return null;
    const job = store.nextQueued();
    if (!job) return null;
    const ok = await check();
    if (stopping) return null;
    if (!ok.ok) return block(job, `output root: ${ok.reason}`);
    let engine;
    try { engine = await ensurePrepared(); } catch (e) { return block(job, `engine not ready: ${scrub(e.message, job.spec)}`); }
    if (stopping) return null;

    const { id, spec } = job;
    const seconds = spec.format === 'png' ? 1 / 60 : spec.seconds;
    const folder = join(config.out, job.folder_name);
    let base;
    try {
      base = await outputAccess(`setup:${folder}`, async (signal) => {
        const ready = await check();
        if (!ready.ok) throw new Error(ready.reason);
        if (stopping) return 0;
        signal.throwIfAborted();
        await mkdir(folder, { recursive: true });
        signal.throwIfAborted();
        if (spec.look) await writeFile(join(folder, LOOK_FILE), JSON.stringify({ ...(spec.look.name ? { name: spec.look.name } : {}), params: spec.look.params }), { signal });
        return (await progress(folder, seconds)).done;   // segments already on disk: a resume continues after them
      });
    } catch (e) { return block(job, `output root: ${scrub(e.message, spec)}`); }
    if (stopping) return null;
    if (!store.start(id, { folder, base })) return { job, outcome: 'skipped' };

    const { cmd, args } = exporterCommand({ node, args: exporterArgs({ script: engine.script, commit: engine.commit, folder, spec }), caffeinate });
    const env = { ...childEnv(config), ...(config.token ? { ARBORETUM_TOKEN: config.token } : {}), ...extraEnv };
    let stderr = '';
    const exit = await new Promise((resolve) => {
      let child, killed = false;
      try { child = spawn(cmd, args, { cwd: dirname(engine.script), env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { resolve({ error: e }); return; }
      current = { child, terminate: () => { killed = true; terminate(child); } };
      if (stopping) current.terminate();   // stop() came in between the queue and the spawn
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4096); });
      child.on('error', (error) => resolve({ error }));
      child.on('close', (code, signal) => resolve({ code, signal }));
      if (child.pid) store.setPid(id, child.pid);
      log(`job ${id} started: ${spec.preset ? `preset ${spec.preset.replace(/:.+$/, '')}` : 'look'} ${spec.size} ${spec.format === 'png' ? 'PNG' : `${spec.seconds}s @${spec.fps}`} (${job.quality.name} quality)`);
      let closed = false, polling = false;
      const tick = () => {
        if (closed) return;
        if (!killed && store.get(id).cancel_requested) { killed = true; terminate(child); }
        if (polling) return;
        polling = true;
        outputAccess(`progress:${folder}`, () => progress(folder, seconds)).then(p => {
          if (!closed) store.progress(id, { done: p.done, total: p.total, line: p.lastLine === null ? null : scrub(p.lastLine, spec) });
        }).catch(() => {}).finally(() => { polling = false; });
      };
      const timer = setInterval(tick, progressMs);
      const clear = () => { closed = true; clearInterval(timer); };
      child.on('close', clear);
      child.on('error', clear);
    });
    current = null;

    try {
      const p = await outputAccess(`progress:${folder}`, () => progress(folder, seconds));
      store.progress(id, { done: p.done, total: p.total, line: p.lastLine === null ? null : scrub(p.lastLine, spec) });
    } catch { /* keep the last database progress if the share is unavailable */ }
    const now = store.get(id);
    if (now.cancel_requested) { store.cancelled(id); log(`job ${id} cancelled`); return { job, outcome: 'cancelled' }; }
    if (stopping) { store.release(id); log(`job ${id} put back in the queue; the exporter resumes it`); return { job, outcome: 'released' }; }
    if (!exit.error && exit.code === 0) {
      try {
        const result = await outputAccess(`result:${folder}`, signal => spec.format === 'png' ? finalizeImage(folder, spec, signal) : readResult(folder));
        const latest = store.get(id);
        if (latest.cancel_requested) { store.cancelled(id); return { job, outcome: 'cancelled' }; }
        if (stopping) { store.release(id); return { job, outcome: 'released' }; }
        store.finish(id, result); log(`job ${id} done`); return { job, outcome: 'done' };
      } catch (e) { exit.error = e; }
    }
    const why = exit.error ? exit.error.message : exit.signal ? `killed by ${exit.signal}` : `exit code ${exit.code}`;
    const detail = await outputAccess(`log:${folder}`, () => tailLines(join(folder, 'run.log'))).catch(() => '') || stderr.trim();
    store.fail(id, scrub(`${why}${detail ? `\n${detail}` : ''}`, spec));
    log(`job ${id} failed: ${scrub(why, spec)}`);
    return { job, outcome: 'failed' };
  }

  // Start-up: what was running is queued again (the exporter resumes it); an exporter that outlived the last worker is stopped first,
  // or two would write one folder.
  async function recover() {
    const rows = store.requeueRunning();
    for (const j of rows) {
      if (!j.pid || !isOurs(j.pid)) continue;
      try { kill(-j.pid, 'SIGTERM'); } catch { /* gone between the check and the kill */ }
      const until = Date.now() + graceMs;
      while (isOurs(j.pid) && Date.now() < until) await sleep(100);
      log(`job ${j.id}: stopped an exporter left running (pid ${j.pid})`);
    }
    if (rows.length) log(`requeued ${rows.length} job(s) left running: ${rows.map((j) => j.id).join(', ')}`);
    return rows;
  }

  async function run() {
    await recover();
    while (!stopping) {
      const r = await runOnce();
      if (!stopping && (!r || r.outcome === 'blocked')) await sleep(pollMs);
    }
  }

  async function stop() {
    stopping = true;
    preparation.abort();
    for (const wake of [...sleepers]) wake();
    if (current) current.terminate();
  }

  return { runOnce, recover, run, stop };
}
