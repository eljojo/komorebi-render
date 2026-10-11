// komorebi-render submit|list|status|cancel|prepare|worker|serve. Output is JSON (list: one line per job) so agents and curl-minded humans read it alike.
import { readFileSync, mkdirSync } from 'node:fs';
import { loadConfig, loadPin } from './config.js';
import { openStore, StoreError } from './store.js';
import { validateSpec, SpecError } from './spec.js';
import { jobView } from './view.js';
import { prepare } from './engine.js';
import { createWorker } from './worker.js';
import { serve } from './serve.js';

const USAGE = `usage: komorebi-render <command>
  submit <spec.json|->   validate and queue a job; prints it
  list [state]           one line per job, newest first
  status <id>            the job: progress, ETA, result or error
  cancel <id>            queued: cancelled now; running: the worker stops the exporter (the folder is kept)
  prepare                make the pinned engine ready (mirror, worktree, npm ci, chromium); idempotent
  worker                 run queued jobs, one at a time
  serve                  the HTTP API and the worker in one process (the deployed mode)
environment: KOMOREBI_RENDER_STATE, KOMOREBI_RENDER_OUT, KOMOREBI_RENDER_MAX_SECONDS, KOMOREBI_RENDER_ALLOW_LOCAL,
  KOMOREBI_RENDER_HOST, KOMOREBI_RENDER_PORT, ARBORETUM_TOKEN, KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE`;

const fmtEta = (s) => (s === null || s === undefined ? '' : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.ceil(s / 60)}m`);

export async function main(argv, env = process.env, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const [cmd, arg] = argv;
  const config = loadConfig(env);
  const open = () => { mkdirSync(config.state, { recursive: true }); return openStore(config.dbPath); };
  try {
    switch (cmd) {
      case 'submit': {
        if (!arg) throw new Error('submit needs a spec file (or - for stdin)');
        const spec = validateSpec(JSON.parse(readFileSync(arg === '-' ? 0 : arg, 'utf8')), { maxSeconds: config.maxSeconds });
        const store = open();
        io.out(JSON.stringify(jobView(store.create(spec)), null, 2));
        return 0;
      }
      case 'list': {
        for (const j of open().list({ state: arg }).map((x) => jobView(x))) {
          io.out([j.id, j.state, `${j.progress.done}/${j.progress.total}`, j.quality.name, j.pipeline, fmtEta(j.eta?.seconds), j.folder_name, j.blocked ?? ''].join('\t'));
        }
        return 0;
      }
      case 'status': {
        const job = open().get(Number(arg));
        if (!job) throw new StoreError(`no job ${arg}`);
        io.out(JSON.stringify(jobView(job), null, 2));
        return 0;
      }
      case 'cancel': {
        const store = open();
        const how = store.requestCancel(Number(arg));
        io.out(JSON.stringify({ id: Number(arg), cancel: how }));
        return 0;
      }
      case 'prepare': {
        const r = prepare({ config, pin: loadPin() });
        io.out(JSON.stringify({ commit: r.commit, script: r.script }));
        return 0;
      }
      case 'worker': {
        const pin = loadPin();
        const worker = createWorker({ store: open(), config, prepare: async () => prepare({ config, pin }) });
        for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => worker.stop());
        await worker.run();
        return 0;
      }
      case 'serve': {
        const pin = loadPin();
        const svc = await serve({ store: open(), config, pin, prepare: async () => prepare({ config, pin }) });
        for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => svc.stop());
        await svc.finished;
        return 0;
      }
      default:
        io.err(USAGE);
        return cmd ? 2 : 0;
    }
  } catch (e) {
    io.err(`komorebi-render: ${e instanceof SpecError ? `invalid spec: ${e.errors.join('; ')}` : e.message}`);
    return e instanceof SpecError ? 2 : 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/src/cli.js')) {
  process.exitCode = await main(process.argv.slice(2));
}
