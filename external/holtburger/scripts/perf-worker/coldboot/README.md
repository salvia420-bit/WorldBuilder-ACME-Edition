# coldboot — first-visit cold-load measurement + 1070 eye-test helpers (2026-10-09)

Measures what a first-time player waits through: a fresh Chrome profile on the 1070 (empty HTTP
cache, no service worker), the real public front (`scripts/proxy.cjs`: bundled shell + `/wsbridge`),
every byte counted by a laptop-side relay.

## Box discipline (owner rule: if someone is using the 1070, stop)

1. Copy `../box/idlewatch.ps1`, `../box/idlewatch.vbs`, `../box/hbwho.ps1` to `D:\Temp\hbbench\`.
2. Start the idle watcher in the person's INTERACTIVE session, hidden (GetLastInputInfo only sees the
   calling session; SSH runs in another one):
   `ssh young@100.127.215.75 'schtasks /create /tn hbidle /tr "wscript.exe D:\Temp\hbbench\idlewatch.vbs" /sc once /st 00:00 /it /f & schtasks /run /tn hbidle'`
   It writes `<unix-ts> <idle-s> <pid>` to `D:\Temp\hbbench\idle.txt` every 5 s, and exits after 16 h
   or when `D:\Temp\hbbench\idlewatch.stop` exists. It reads no window titles.
3. Run `watch1070.sh` under the Claude Code Monitor tool (30 min cap: re-arm on expiry). It polls every
   15 s and prints one line per state change: AWAY / PRESENT (any keyboard/mouse input since the last
   poll or < 180 s ago, or a desktop browser window of theirs — they use Chrome) / GPU-BUSY (other
   processes' 3D engine ≥ 35 % twice — a gamepad player) / WATCHER-STALE / UNREACHABLE. On PRESENT or
   GPU-BUSY it kills ONLY the `D:\Temp\hbbench\` test Chrome. After PRESENT, AWAY needs 15 min with no
   input and no browser of theirs.

## Tunnel and paths

- CDP only over SSH: `ssh -fN -L 9333:127.0.0.1:9333 young@100.127.215.75`.
- Data path, raw link (no Cloudflare, no throttle — the owner's preference): the 1070 talks to the
  laptop's tailnet IP. `node relay.mjs --host 100.116.47.66 --listen 7093 --target 7080 --log run.tsv`
  (counts every byte incl. the game WebSocket; `--kbps N --delay MS` shapes a slow link: one shared
  round-robin pipe).

## Tools

| file | what |
|---|---|
| `relay.mjs` | counting / optional throttling TCP relay (per-second `wall_ms down up open total` TSV) |
| `coldboot.mjs --label X --host H --port P --relay-log run.tsv` | one fresh-profile boot: boot states, first statics / terrain, settled (no change + < 150 KB for `--settle-s`), JPGs at ready / +10/30/60/120/180/300 s / settled, `summary.json` + `timeline.json` under `$COLDBOOT_OUT` |
| `sess.mjs boot [--spawn first\|select]` | persistent eye-test session (fresh profile, full resource-timing buffer); `select` stops on the character screen (then `enterchar.mjs`) |
| `probe.mjs file.js` | evaluate a snippet (body of an async fn) in the live page over a second CDP client |
| `shot.mjs out.png [dom\|3d] [selector]` | DOM screenshot (HUD; element clip with a selector) or the 3D frame (`toDataURL` inside the render) |
| `click.mjs 'selector' [dbl]` | real mouse click |
| `academy.mjs --label X [--flags a=b] [--profile] [--linkmap]` | fresh-profile spawn of the account's first character (the academy one) with the EnvCell build polled every 2 s + page/bake-worker resource timing + console breadcrumbs → `acad-<label>.json`. `--profile`: main-thread CPU profile → `acad-<label>.cpuprofile`. `--linkmap`: time blocked per GL program (a synchronous driver link shows as the first query on it), named via `renderer.info.programs` → `sum.linkmap` (how the 4,963 ms `far-terrain-bake` link was found) |
| `wizwarm.mjs <label> <dwellMs> [name]` | on the character screen: Create Character → dwell in the wizard (the academy loads behind it) → × → select → ENTER → time to the academy's cells |
| `academy.mjs … --fetchmap` / `--longtasks` | per `/shards/` request: `fetch()` call time and body-in-JS time vs the network's `responseEnd` (the gap = main-thread delivery delay); every task over 50 ms. Both land in `acad-<label>.json` |
| `townnet.mjs <label> [--from Holtburg] [--to TownNetwork] [--shots 5,15,30]` | on a live `sess.mjs` page: `@telepoi <from>`, wait until settled, `@telepoi <to>`, then per second: interior builds, cell meshes, pending surfaces, outdoor terrain/far ring, entities, particles, bake-worker queue, depth split, bytes; 3D JPGs at the `--shots`; downloads since the teleport by class (`NET` lines) → `townnet-<label>.json` |
| `enterchar.mjs "<Name>"` | on the character screen (`sess.mjs boot --spawn select`): select that exact row ("+" admin prefix ignored), ENTER, wait for in-world. (`autoSpawn=<Name>` errors; `autoSpawn=first` takes the MOST RECENTLY PLAYED character) |
| `teleshot.mjs "<@cmd>" out.jpg [waitMs]` | send an admin chat command (e.g. `@teleloc 0x00070140 70 -30 0.005 0.7071 0 0 0.7071`), wait, 3D JPG |
| `camset.mjs ex ey ez tx ty tz out.jpg [keep]` | park the `?camDebug=on` free camera (`window.__cam.set`, AC-world metres: x east, y north incl. the landblock origin, z up) and shoot one frame — the way to look AT an object; the follow camera never points where you expect |
| `replay.mjs <port> <conns> urls.txt` | server-side cost of a run's requests with no browser: replay the paths over N keep-alive connections, req/s + p50/p90 |
| `hbns.py shards.json fromMs [toMs]` | which DAT records a run downloaded: decodes the HBNS catalogs (`dist/manifest/*.bin` + `regions/eor-cell/`) and sums bytes by namespace + type (how the Town Network's 200 MB of `tex-xu7` was found) |
| `prof-decode.mjs` | CPU-profile one main-thread `fetch_surfaces_pixels` over the page's cached surfaces (writes `prof-dec.cpuprofile`) |

Release wasm has no names: re-run `wasm-bindgen --target web` on
`target/wasm32-unknown-unknown/release/holtburger_web.wasm` and `wasm-opt -O -g` (cmp the `-O` output
with the deployed `pkg/` first — identical means the function indices match), then read the `name`
section to map `wasm-function[N]` to a symbol (how the height_seam hotspot was found, 2026-10-09).

## Traps seen

- `serve.py` answered every keep-alive request ~42 ms late (Nagle vs Linux delayed ACK) until
  2026-10-09 (`disable_nagle_algorithm`). Replay a run's shard list locally before blaming the
  client: `replay.mjs`-style, 6 keep-alive connections — 2,138 academy records took 15 s, now 1.1 s.
- Indoor rendering runs in two passes (`?indoorDepthSplit`): anything on layer 0 inside a dungeon is
  painted over by the cells. `__diag.portalEmitterState()` can say OK_VISIBLE for particles nobody
  can see — test by enabling layer 1 on the object and re-shooting (`camset.mjs`).
- `pkill -f '<pattern>'` from a tool shell matches the shell's own command line and kills it.

- Editing an app source during a measured run makes the shell bundle stale for the run's own
  navigation (the gate serves the unbundled page): bench a frozen snapshot (`../hb-mksnap.sh` + a
  second `serve.py --port 8766` and `PROXY_PORT=7091 HTTP_BACKEND_PORT=8766 node scripts/proxy.cjs`
  from the snapshot) or edit nothing.
- Killing a Chrome that sat on the character screen leaves its ACE session alive (no character in
  the world, so no LOGOUT line): the next login meets it and ACE drops BOTH ("Account In Use"). Wait
  for ACE's drop or use a build with `SessionHandle.disconnect()` (2026-10-09).
- Every page logs 512 `glBlitFramebuffer: Depth/stencil buffer format combination not allowed for
  blit` WebGL errors (capped): pre-existing, all sessions.
