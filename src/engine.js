// The pinned komorebi engine: a bare mirror of the repo, a git worktree of the pinned commit, its test-gl deps and
// Chromium. A worktree (not `git archive`) because render-video.mjs runs `git -C <its own repo> archive <sha>` for --commit:
// it must live inside a git repo that knows the commit, and a worktree's .git file leads to the mirror's object store.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const execute = promisify(execFile);
export async function defaultRun(cmd, args, { cwd, env, signal } = {}) {
  try {
    const r = await execute(cmd, args, { cwd, env, signal, encoding: 'utf8', maxBuffer: 64 << 20 });
    return { ...r, status: 0 };
  } catch (error) {
    return { status: typeof error.code === 'number' ? error.code : null, stdout: error.stdout, stderr: error.stderr,
      error: typeof error.code === 'number' ? null : error };
  }
}

// The arboretum token is for the exporter alone: git, npm and playwright never see it.
export function childEnv(config, base = process.env) {
  const env = { ...base, PLAYWRIGHT_BROWSERS_PATH: config.browsers };
  delete env.ARBORETUM_TOKEN;
  return env;
}

const tail = (r) => String(r.stderr || r.stdout || '').trim().split('\n').slice(-5).join(' | ');

async function step(run, env, label, cmd, args, cwd, signal) {
  const r = await run(cmd, args, { cwd, env, signal });
  if (r.error || r.status !== 0) throw new Error(`${label} failed${r.status != null ? ` (status ${r.status})` : ''}: ${r.error?.message ?? tail(r)}`);
  return r;
}

export async function ensureMirror({ config, pin, run = defaultRun, signal }) {
  const env = childEnv(config);
  mkdirSync(config.state, { recursive: true });
  if (!existsSync(join(config.mirror, 'HEAD'))) await step(run, env, 'git clone --mirror', 'git', ['clone', '--mirror', pin.repo, config.mirror], undefined, signal);
  return env;
}

const hasCommit = async (run, env, config, sha, signal) => (await run('git', ['-C', config.mirror, 'cat-file', '-e', `${sha}^{commit}`], { env, signal })).status === 0;

export async function prepare({ config, pin, run = defaultRun, signal }) {
  const sha = pin.commit;
  const dir = config.engineDir(sha);
  const script = join(dir, 'test-gl', 'render-video.mjs');
  const marker = join(dir, '.komorebi-render-prepared');
  const result = { dir, script, commit: sha };
  // Only a complete prepare leaves the marker: a half-done one (npm offline) is redone from where it stopped, each step being idempotent.
  if (existsSync(marker) && existsSync(script)) return result;

  const env = await ensureMirror({ config, pin, run, signal });
  if (!await hasCommit(run, env, config, sha, signal)) {
    await step(run, env, 'git fetch', 'git', ['-C', config.mirror, 'fetch', '--prune', 'origin'], undefined, signal);
    if (!await hasCommit(run, env, config, sha, signal)) throw new Error(`commit ${sha} is not in ${pin.repo} (the mirror has fetched everything it has)`);
  }
  if (!existsSync(join(dir, '.git'))) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });   // a worktree that never finished
    mkdirSync(join(config.state, 'engine'), { recursive: true });
    await run('git', ['-C', config.mirror, 'worktree', 'prune'], { env, signal });
    await step(run, env, 'git worktree add', 'git', ['-C', config.mirror, 'worktree', 'add', '--detach', dir, sha], undefined, signal);
  }
  const testGl = join(dir, 'test-gl');
  await step(run, env, 'npm ci', 'npm', ['ci', '--no-audit', '--no-fund'], testGl, signal);
  mkdirSync(config.browsers, { recursive: true });
  await step(run, env, 'playwright install chromium', 'npx', ['playwright', 'install', 'chromium'], testGl, signal);
  writeFileSync(marker, `${sha}\n`);
  return result;
}

// A ref (sha, prefix, branch, "HEAD") to a full commit sha in the mirror, for scripts/pin.mjs. A branch is fetched first; a sha
// is fetched for only when the mirror does not have it yet.
export async function resolveCommit({ config, pin, run = defaultRun, ref = 'HEAD', signal }) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) throw new Error(`ref ${JSON.stringify(ref)} is not a commit name`);
  const env = await ensureMirror({ config, pin, run, signal });
  const parse = () => run('git', ['-C', config.mirror, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env, signal });
  const fetch = () => run('git', ['-C', config.mirror, 'fetch', '--prune', 'origin'], { env, signal });
  let fetched = null;
  if (!/^[0-9a-f]{7,40}$/i.test(ref)) fetched = await fetch();
  let r = await parse();
  if (r.status !== 0 && !fetched) { fetched = await fetch(); r = await parse(); }
  const sha = String(r.stdout || '').trim();
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`cannot resolve ${JSON.stringify(ref)} to a commit in ${pin.repo}${fetched?.status ? ` (fetch: ${tail(fetched)})` : ''}`);
  return sha;
}
