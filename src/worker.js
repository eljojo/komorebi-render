// The loop that runs jobs, one at a time. The exporter is a child process; the database is the only channel to it
// (progress out, cancel in), so a CLI or API in another process drives the same worker.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOOK_FILE, exporterArgs, exporterCommand, progress, readResult, tailLines } from './exporter.js';
import { checkOutputRoot } from './netmount.js';
import { childEnv } from './engine.js';
import { scrubSecrets } from './spec.js';

const defaultIsOurs = (pid) => {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && /render-video\.mjs/.test(r.stdout);   // a reused pid is not ours
};

export function createWorker({
  store, config, log = console.log, prepare, checkOut,
  spawn = nodeSpawn, kill = process.kill.bind(process), isOurs = defaultIsOurs,
  node = process.execPath, caffeinate = process.platform === 'darwin' && existsSync('/usr/bin/caffeinate'),
  pollMs = 5000, progressMs = 3000, graceMs = 30000, extraEnv = {},
}) {
  const check = checkOut ?? (() => checkOutputRoot(config.out, { allowLocal: config.allowLocal }));
  const sleepers = new Set();
  const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(done, ms); function done() { clearTimeout(t); sleepers.delete(done); resolve(); } sleepers.add(done); });
  let stopping = false, preparing = null, current = null;

  // The token may sit in the exporter's output; it must not reach the database or a log line.
  const scrub = (text, spec) => scrubSecrets(text, spec, config.token);

  const ensurePrepared = () => {
    if (!preparing) preparing = Promise.resolve().then(prepare).catch((e) => { preparing = null; throw e; });
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
    const ok = check();
    if (!ok.ok) return block(job, `output root: ${ok.reason}`);
    let engine;
    try { engine = await ensurePrepared(); } catch (e) { return block(job, `engine not ready: ${scrub(e.message, job.spec)}`); }

    const { id, spec } = job;
    const folder = join(config.out, job.folder_name);
    mkdirSync(folder, { recursive: true });
    if (spec.look) writeFileSync(join(folder, LOOK_FILE), JSON.stringify({ ...(spec.look.name ? { name: spec.look.name } : {}), params: spec.look.params }));
    const base = progress(folder, spec.seconds).done;   // segments already on disk: a resume continues after them
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
      log(`job ${id} started: ${spec.preset ? `preset ${spec.preset.replace(/:.+$/, '')}` : 'look'} ${spec.size} ${spec.seconds}s @${spec.fps} (${job.quality.name} quality)`);
      const tick = () => {
        const p = progress(folder, spec.seconds);
        store.progress(id, { done: p.done, total: p.total, line: p.lastLine === null ? null : scrub(p.lastLine, spec) });
        if (!killed && store.get(id).cancel_requested) { killed = true; terminate(child); }
      };
      const timer = setInterval(tick, progressMs);
      child.on('close', () => clearInterval(timer));
      child.on('error', () => clearInterval(timer));
    });
    current = null;

    const p = progress(folder, spec.seconds);
    store.progress(id, { done: p.done, total: p.total, line: p.lastLine === null ? null : scrub(p.lastLine, spec) });
    const now = store.get(id);
    if (now.cancel_requested) { store.cancelled(id); log(`job ${id} cancelled`); return { job, outcome: 'cancelled' }; }
    if (stopping) { store.release(id); log(`job ${id} put back in the queue; the exporter resumes it`); return { job, outcome: 'released' }; }
    if (!exit.error && exit.code === 0) {
      try { store.finish(id, readResult(folder)); log(`job ${id} done`); return { job, outcome: 'done' }; } catch (e) { exit.error = e; }
    }
    const why = exit.error ? exit.error.message : exit.signal ? `killed by ${exit.signal}` : `exit code ${exit.code}`;
    const detail = tailLines(join(folder, 'run.log')) || stderr.trim();
    store.fail(id, scrub(`${why}${detail ? `\n${detail}` : ''}`, spec));
    log(`job ${id} failed: ${why}`);
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
      if (!r || r.outcome === 'blocked') await sleep(pollMs);
    }
  }

  async function stop() {
    stopping = true;
    for (const wake of [...sleepers]) wake();
    if (current) current.terminate();
  }

  return { runOnce, recover, run, stop };
}
