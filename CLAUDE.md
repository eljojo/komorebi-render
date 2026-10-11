# CLAUDE.md — the repo map

What each file is and what it owns. The README is for people who send jobs; this file is for people who work on komorebi-render.
The exporter itself (`test-gl/render-video.mjs` in the komorebi repo) is not here and is never copied: read its header comment
before you change how it is called.

## Files

- **`flake.nix`** — devShell (node 22, ffmpeg, git), `packages.default` (bin/komorebi-render and llms.txt, PATH prefixed so `caffeinate` stays reachable), `apps`, `checks.tests`, `checks.darwin-module`, `darwinModules.default`.
- **`komorebi.json`** — the pinned komorebi commit (full sha) and its repo URL. Bumped by `scripts/pin.mjs`.
- **`src/cli.js`** — the commands: submit, list, status, cancel, prepare, worker, serve. Thin: it calls the modules below.
- **`src/config.js`** — `loadConfig(env)`: every path and limit the environment decides, ARBORETUM_TOKEN (or its runtime token file), `maxSeconds`, `host`, `port`. `loadPin()` reads `komorebi.json`.
- **`src/spec.js`** — the job spec: validation into the canonical shape (`validateSpec`, `SpecError`), the folder name, the share-token redaction.
- **`src/quality.js`** — the quality knobs (`checkQuality`, `resolveQuality`) and their cost (`msPerFrame`, `estimateSeconds`). The only place that names the keys that may become `--set`.
- **`src/exporter.js`** — the seam to render-video.mjs: argv from a spec, the caffeinate wrapper, progress from `seg/*.json`, the bounded `run.log` tail, the ETA from a run's own rate, the result from `manifest.json`.
- **`src/store.js`** — `jobs.sqlite` over `node:sqlite`: the job table and its guarded state machine (queued, running, done, failed, cancelled), cancel requests, requeue at start.
- **`src/netmount.js`** — the async output-root check: exists, writable (a real write), on a network mount (`mount` output, injectable); `createOutputRootCheck` bounds callers to five seconds while retaining one stuck probe until it settles.
- **`src/engine.js`** — `prepare` (mirror, pinned worktree, `npm ci`, Chromium) and `resolveCommit`, over an injectable runner. The worktree is what makes the exporter's `--commit` (`git -C <its repo> archive`) work.
- **`src/worker.js`** — `createWorker`: takes a job, checks the output root, prepares once, spawns the exporter in its own process group, polls progress and cancel, ends the job, recovers at start.
- **`src/view.js`** — `jobView`: a job as the CLI and API show it (redacted spec, progress, ETA).
- **`src/api.js`** — `createApi`: the six routes in `ROUTES`, a directly testable handler and the thin node:http listener; summaries, details, refusals and token scrubbing.
- **`src/serve.js`** — starts the API before one worker, shares their bounded output-root check, closes both on shutdown and closes the API if the worker fails so launchd can restart them together.
- **`llms.txt`** — the API contract for agents, served as text/plain; `test/llms.test.js` checks routes, fields, values, examples and etiquette against the code.
- **`nix/darwin-module.nix`** — `services.komorebi-render`: a caffeinated launchd user agent, runtime token-file path, logs, and state-directory creation before launchd loads it.
- **`nix/module-test.nix`** — evaluates the module with stub launchd/activation options and checks disabled behavior, defaults, overrides, arguments, environment and logs.
- **`scripts/pin.mjs`** — bumps `komorebi.json`.
- **`test/*.test.js`** — `node --test`; no GPU, no network, no real git/npm. `fixtures/fake-exporter.mjs` stands in for render-video (seg/*.json, run.log, manifest.json, exit code from `FAKE_MODE`).

## Rules that bite

- One job at a time; the database is the only channel between a CLI/API process and the worker.
- The look for a `look` job goes in `look-input.json`, never `look.json`: the exporter rewrites that one, and a resume re-reads its `--look-json`.
- Only `tex_resolution`, `bake_resolution`, `sample_count` may become `--set`; anything else changes the look.
- The share token and ARBORETUM_TOKEN stay out of logs, error text and listings (`redactSpec`, `scrub`). Never log an argv.
- A run must never fill the Mac's disk: the output-root check precedes every job.
- Tests run through the flake: `nix develop -c node --test`.
