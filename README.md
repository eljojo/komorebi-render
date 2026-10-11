# komorebi-render

A render server for [komorebi](https://github.com/eljojo/komorebi): send a job (a look, a size, a length) and get a 1080p or
4K video, rendered frame by frame on the Mac mini's GPU and written to the NAS.

It does not render anything itself. It runs komorebi's own video exporter (`test-gl/render-video.mjs`) from a **pinned
komorebi commit** (`komorebi.json`), so there is one definition of a render. What it adds is a queue, a worker, progress,
resume after a crash, and the guard that keeps gigabytes off the Mac's own disk.

- Single looks only (an arboretum preset, or look params). One job at a time.
- Output goes to `$KOMOREBI_RENDER_OUT`, which must be a mounted network share (on the mini, `/Volumes/home/komorebi/jobs`).
- Masters (the lossless segments) are off by default: they are deleted once the delivery is verified.
- Hours-long jobs are normal: the maximum is 6 h by default (`KOMOREBI_RENDER_MAX_SECONDS`).
- Plain Node 22 ES modules, no dependencies (`node:sqlite`, `node:child_process`). Packaged as a nix flake.

## Run it in dev

```sh
nix develop            # node 22, ffmpeg, git
node --test            # the tests: no GPU, no network
KOMOREBI_RENDER_OUT=/tmp/out KOMOREBI_RENDER_ALLOW_LOCAL=1 node src/cli.js worker
```

`nix run . -- <command>` runs the packaged `bin/komorebi-render`. A flake in a git repo only sees tracked files: `git add`
before `nix flake check` / `nix develop`, or use `path:$PWD`.

The first job (or `komorebi-render prepare`) sets up the engine under the state dir: a bare mirror of komorebi, a worktree of the
pinned commit, `npm ci` in its `test-gl/`, and Chromium for Playwright. That needs the network once.

## CLI

```
komorebi-render submit <spec.json|->   validate and queue a job; prints it
komorebi-render list [state]           one line per job, newest first
komorebi-render status <id>            progress, ETA, result or error
komorebi-render cancel <id>            queued: cancelled now; running: the exporter is stopped, the folder is kept
komorebi-render prepare                make the pinned engine ready; idempotent
komorebi-render worker                 run queued jobs
komorebi-render serve                  run the HTTP API and one worker together
```

`cancel` and `submit` only write the database; a running `worker` (any process, same state dir) does the rest.

## The job spec

```json
{ "preset": "3@2", "size": "4k", "seconds": 300, "fps": 60, "master": false,
  "quality": "max", "delivery": { "vt_bitrate": "80M" } }
```

| field | |
|---|---|
| `preset` | `"<arboretum id>[@version][:share]"`. Exactly one of `preset` or `look`. Without `@version` the head is pinned at the first run. A private preset needs `ARBORETUM_TOKEN` in the worker's environment; `:share` opens an unlisted one. |
| `look` | `{ "name"?: string, "params": {…} }`: the look's params, as the editor saves them. |
| `size` | `"1080p"`, `"4k"` or `"WxH"` (even, 64x64 to 7680x4320). |
| `seconds` | whole number, 1 to `KOMOREBI_RENDER_MAX_SECONDS` (default 21600). |
| `fps` | `30` or `60` (default 60). |
| `master` | `false` (default): the lossless segments are deleted once the delivery is verified. `true` keeps them. |
| `quality` | `"authored"` (default: the look as saved), `"max"`, or an object (below). |
| `pipeline` | `"master"` (default), `"gpu"`, `"gpu-main10"` or `"browser"`; capture and encoding, independent of quality. |
| `delivery` | optional, one of `{ "vt_bitrate": "60M" }` (k, K or M) or `{ "vt_quality": 0..100 }`; browser requires omitted or empty delivery. |

**Quality.** `"max"` is `tex_resolution` 4096, `bake_resolution` 0 (follows tex, so a 4096 bake) and `sample_count` 48; at 1080p
or smaller it also renders at 2x and downscales (`--ss 2`). An object takes any of `tex_resolution` (1024, 2048, 4096),
`bake_resolution` (0, 768, 1024, 1536, 2048), `sample_count` (16 to 48) and `ss` (1, 2). Only these keys are ever passed to the
exporter (as `--set` and `--ss`), so its manifest still says the look is as authored.

**ETA.** Measured on the mini, authored is about 15 ms/frame at 1080p and 37 at 4K; max is about 300 at either size. A one-hour
max-quality job at 60 fps is about 18 hours: `status` says so as an ETA and the job is never refused. Once segments finish,
the ETA is measured from this run's own rate.

## Choosing the render pipeline

All four pipelines render the same scene with the same quality knobs and frame clock. `pipeline` chooses how frames reach
the MP4 encoder; it does not set the render resolution or lower scene quality.

| Pipeline | Use it for | Capture and encoding |
| --- | --- | --- |
| `master` | Lossless archives, studies, and re-encoding deliveries later | Existing lossless RGB segment masters, then an eight-bit HEVC MP4. Default; master retention remains off unless requested. |
| `gpu` | Everyday production MP4s | Resize on the GPU when supersampling, read back output-sized RGB, encode eight-bit HEVC using VideoToolbox. Extremely close to the old output in the measured comparison. |
| `gpu-main10` | Highest measured production fidelity, especially faint colours | Same GPU capture, direct ten-bit YUV conversion and VideoToolbox HEVC Main10. Source RGB is still eight-bit; this is SDR, not HDR. |
| `browser` | Short scene-planning tests and fastest turnaround | GPU capture into VideoFrame, direct browser HEVC encoding at fixed QP1, then MP4 muxing. Small measured fidelity loss compared with the old output. |

`master: true` is only accepted with the master pipeline; it is refused for the three direct pipelines, which have no
lossless master. `browser` refuses nonempty `delivery` because its HEVC QP1 is fixed. The other pipelines keep the existing
`60M` bitrate default (75M cap, 120M buffer); choose `delivery: { "vt_quality": 100 }` for highest-fidelity production
encoding. Larger output files are expected at that setting. Main10 playback depends on player support.

Supersampling is a separate choice: for a **1920x1080 output**, `ss: 2` renders **3840x2160**, then averages those four
rendered pixels per output pixel in linear light. This can reduce jagged edges and unstable fine detail; it does not upscale
1080p into 4K. `ss: 1` renders 1920x1080 directly and avoids that fourfold pixel count. GPU pipelines support both; with
ss 1 no resize is needed. `quality: "max"` chooses ss 2 for 1080p or smaller; use an explicit quality object with ss 1 to
keep the other maximum knobs while avoiding supersampling. How visible that difference is depends on the look.

For short tests:
```json
{"preset":"3","size":"1080p","seconds":5,"pipeline":"browser","quality":"authored"}
```
For production, with maximum scene settings but direct 1080p rendering:
```json
{"preset":"3","size":"1080p","seconds":30,"pipeline":"gpu-main10","quality":{"tex_resolution":4096,"bake_resolution":0,"sample_count":48,"ss":1},"delivery":{"vt_quality":100}}
```
Use `pipeline: "gpu"` for eight-bit output, or `quality: "max"` for supersampled production output.
The API summaries and details, CLI submit/status JSON and CLI list show the effective pipeline, including master on older jobs.

In two matched 30-second 1080p60 clips on an **M1 Pro**, all rendered at 4K then downscaled, GPU eight-bit took 5m28s–5m50s
versus 6m28s–6m46s for the old master workflow (14–16% faster). Browser took 5m02s–5m25s (20–22% faster); Main10 took
5m30s–5m57s (12–15% faster). These used vt_quality 100 or browser QP1. Main10 had the best measured source fidelity but
roughly twice the file size; GPU eight-bit was near-identical to the old MP4. These are two looks and one run per method,
not M4 mini timing guarantees or proof that every human sees no difference. Timings compare old render plus delivery encode
with direct capture/encode/mux including setup; they exclude subsequent verification and predate server segment integration. Before a measured segment, ETA keeps
the existing quality-based estimates and applies no speculative pipeline speed multiplier.

## Where things are

| | |
|---|---|
| `$KOMOREBI_RENDER_STATE` (default `~/.local/state/komorebi-render`) | `jobs.sqlite`, `komorebi.git` (mirror), `engine/<sha>/` (the pinned worktree), `browsers/` (Playwright's Chromium) |
| `$KOMOREBI_RENDER_OUT/<yyyy-mm-dd>-<id>-<slug>/` | one folder per job: `delivery.mp4`, `manifest.json`, `run.log`, `seg/` (kept as the master only with `master: true`), `look-input.json` for a `look` job |

Before taking a job the worker checks that the output root exists, is writable and is on `smbfs`, `nfs` or `afpfs` (read from `mount`).
If not, the job **stays queued** with the reason in `blocked` (so a NAS that comes back lets it run) and nothing is written.
`KOMOREBI_RENDER_ALLOW_LOCAL=1` skips the network-mount check, for tests and dev.

Progress is finished segments over `ceil(seconds / 10)`, read from `seg/*.json`. A job left running when the worker starts goes back
to the queue and the exporter resumes it from its last committed segment. Direct pipelines checkpoint motion and commit
encoded MP4 segments instead of lossless masters, then concatenate them without re-encoding. Interrupted jobs keep those
segments; after the final delivery is verified they are deleted. The manifest records encoded segment checksums and decoded
frame counts. Browser capture avoids reading raw pixels for frame hashes. Direct outputs cannot be re-encoded from a master.

## Environment

`KOMOREBI_RENDER_STATE`, `KOMOREBI_RENDER_OUT`, `KOMOREBI_RENDER_MAX_SECONDS` (21600), `KOMOREBI_RENDER_ALLOW_LOCAL`,
`KOMOREBI_RENDER_HOST` (the API's listen address, default `0.0.0.0`, no auth: for the LAN), `KOMOREBI_RENDER_PORT` (8077),
`ARBORETUM_TOKEN` (given to the exporter alone; never logged or stored), `KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE` (optional
absolute path to a token read once at startup; the environment token takes precedence).

## HTTP API

`komorebi-render serve` runs the API and worker in one process. [llms.txt](llms.txt) documents every spec field, route,
response and polling rule; it is also served at `/llms.txt`. Routes are `POST /jobs`, `GET /jobs`, `GET /jobs/:id`,
`DELETE /jobs/:id` and `GET /health`. Poll no faster than every 10 seconds. There is no auth yet; use the LAN or tailnet.

## Deploying on the mini

Add the input to dotfiles' `flake.nix`:

```nix
inputs.komorebi-render.url = "github:eljojo/komorebi-render";
```

In `mkMac`'s modules list, import the module and enable it under the same host guard as `nix/r2d2-mount.nix`:

```nix
inputs.komorebi-render.darwinModules.default
({ lib, hostName, ... }: lib.mkIf (hostName == "jojo-m4-mini") {
  services.komorebi-render = {
    enable = true;
    outDir = "/Volumes/home/komorebi/jobs";
    # Optional: use a quoted runtime path, never a Nix path literal or builtins.readFile.
    # arboretumTokenFile = "/Users/jojo/.config/komorebi/arboretum-token";
  };
})
```

The agent runs in `system.primaryUser`'s session (`jojo` in dotfiles), with state under
`/Users/<user>/.local/state/komorebi-render`. The options are `enable`, `package`, `host` (`0.0.0.0`), `port` (8077),
`stateDir`, required `outDir`, `maxSeconds` (21600), and nullable `arboretumTokenFile`. Token files are read by the program;
their contents never enter the Nix store. Activation creates the state directory before launchd opens its logs.

The launchd user agent runs `/usr/bin/caffeinate -i <package>/bin/komorebi-render serve`, with KeepAlive and RunAtLoad.
It needs the owner logged in for GPU access. Service stdout and stderr are `stdout.log` and `stderr.log` under stateDir.
The flake checks evaluate the module with `lib.evalModules` and stub launchd/activation options; assertions cover its
defaults, overrides, environment, arguments and log-directory setup without building a full nix-darwin system.

After applying dotfiles on the mini, prepare the engine once using the package from the same dotfiles lock:

```sh
nix run --inputs-from ~/code/dotfiles komorebi-render -- prepare
```

Chromium is installed by Playwright under stateDir (nixpkgs has no Chromium on darwin). The first queued job also prepares
the engine if needed. Reach the API at `http://<mini's tailnet name or IP>:8077`:

```sh
curl -sS http://jojo-m4-mini:8077/health
curl -sS http://jojo-m4-mini:8077/llms.txt
```

## Pinning komorebi

`node scripts/pin.mjs [sha|ref]` resolves against the mirror and rewrites `komorebi.json`. Commit the result; the next `prepare` builds the new engine beside the old.
