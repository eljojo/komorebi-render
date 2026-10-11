# CLAUDE.md — the repo map

What each file is and what it owns. The README is for people who send jobs; this file is for people who work on komorebi-render.
The exporter itself (`test-gl/render-video.mjs` in the komorebi repo) is not here and is never copied: read its header comment
before you change how it is called.

## Files

- **`flake.nix`** — devShell (node 22, ffmpeg, git), `packages.default` (bin/komorebi-render, PATH prefixed so `caffeinate` stays reachable), `apps`, `checks.tests`. `darwinModules.default` is brief 4's slot (a comment marks it).
- **`komorebi.json`** — the pinned komorebi commit (full sha) and its repo URL. Bumped by `scripts/pin.mjs`.
- **`src/cli.js`** — the commands: submit, list, status, cancel, prepare, worker. Thin: it calls the modules below.
- **`src/config.js`** — `loadConfig(env)`: every path and limit the environment decides, the ARBORETUM_TOKEN, `maxSeconds`, `host`. `loadPin()` reads `komorebi.json`.
- **`src/spec.js`** — the job spec: validation into the canonical shape (`validateSpec`, `SpecError`), the folder name, the share-token redaction.
- **`src/quality.js`** — the quality knobs (`checkQuality`, `resolveQuality`) and their cost (`msPerFrame`, `estimateSeconds`). The only place that names the keys that may become `--set`.
- **`src/exporter.js`** — the seam to render-video.mjs: argv from a spec, the caffeinate wrapper, progress from `seg/*.json`, the bounded `run.log` tail, the ETA from a run's own rate, the result from `manifest.json`.
- **`src/store.js`** — `jobs.sqlite` over `node:sqlite`: the job table and its guarded state machine (queued, running, done, failed, cancelled), cancel requests, requeue at start.
- **`src/netmount.js`** — the output-root check: exists, writable (a real write), on a network mount (`mount` output, injectable).
- **`src/engine.js`** — `prepare` (mirror, pinned worktree, `npm ci`, Chromium) and `resolveCommit`, over an injectable runner. The worktree is what makes the exporter's `--commit` (`git -C <its repo> archive`) work.
- **`src/worker.js`** — `createWorker`: takes a job, checks the output root, prepares once, spawns the exporter in its own process group, polls progress and cancel, ends the job, recovers at start.
- **`src/view.js`** — `jobView`: a job as the CLI and API show it (redacted spec, progress, ETA).
- **`scripts/pin.mjs`** — bumps `komorebi.json`.
- **`test/*.test.js`** — `node --test`; no GPU, no network, no real git/npm. `fixtures/fake-exporter.mjs` stands in for render-video (seg/*.json, run.log, manifest.json, exit code from `FAKE_MODE`).

## Rules that bite

- One job at a time; the database is the only channel between a CLI/API process and the worker.
- The look for a `look` job goes in `look-input.json`, never `look.json`: the exporter rewrites that one, and a resume re-reads its `--look-json`.
- Only `tex_resolution`, `bake_resolution`, `sample_count` may become `--set`; anything else changes the look.
- The share token and ARBORETUM_TOKEN stay out of logs, error text and listings (`redactSpec`, `scrub`). Never log an argv.
- A run must never fill the Mac's disk: the output-root check precedes every job.
- Tests run through the flake: `nix develop -c node --test`.
