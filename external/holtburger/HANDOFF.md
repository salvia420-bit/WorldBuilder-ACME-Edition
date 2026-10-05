# holtburger — start here

_Rewritten 2026-10-05 against the code at commit `93461059`. Every path and
command below was checked against the tree, not copied from older docs. If you
find something here that disagrees with the code, the code is right: fix this
file in the same commit._

This file replaces the May 2026 post-mortem that used to live here. Older
handoffs, status logs and agent prompts are in [`docs/archive/`](docs/archive/README.md);
treat them as history, not instructions.

---

## 1. What holtburger is

holtburger is an Asheron's Call client that talks to a stock
[ACE](https://github.com/ACEmulator/ACE) server. It started as a hard fork of
`merklejerk/holtburger` (a Rust TUI client, see [`VENDORED.md`](VENDORED.md));
most of the work since then is the **browser client**: a three.js 3D renderer
in plain ES modules, driven by a Rust core compiled to WebAssembly.

How a session is wired:

```
browser (index.html + scene3d/*.js + plugins/*.js)
   │  wasm-bindgen calls / poll_events()
   ▼
pkg/holtburger_web.js (+ _bg.wasm)   ← apps/holtburger-web/src/*.rs
   │  WebSocket (binary frames)
   ▼
holtburger-wsbridge  :8080           ← apps/holtburger-wsbridge
   │  UDP
   ▼
ACE server  UDP :9000/:9001          (vanilla ACE, not part of this tree)
```

World data (terrain, statics, scenery, spawns, textures) does not come from
ACE. It is baked offline from the retail DATs into a content-addressed `dist/`
tree (`manifest.json` + `shards/` + per-landblock layers) that `scripts/serve.py`
serves next to the app.

## 2. Repo layout

All paths are relative to `external/holtburger/`.

| Path | What it is |
|---|---|
| `apps/holtburger-web/index.html` | The app shell (~11.9k lines). Login form, boot state machine (`window.__bootState`), import map (three 0.184.0, postprocessing 6.39.1, @takram atmosphere/clouds), the `drainEvents()` ClientEvent dispatcher, and the `window.__hbWasm` diagnostic surface. |
| `apps/holtburger-web/scene3d/` | The 3D client, about 150 modules. Entry is `index.js` (`init3D`, the rAF tick). Also `loop.js` (per-frame work), `atmosphere_pipeline.js` (post-processing composer), `entities.js` (entity rigs and animation), `cells.js` (indoor cells, portals), `terrain*.js`, `statics.js`, `landblock_lru.js` (residency), `bake_worker*.js`, `net_worker*.js`, `camera.js`, `particles/`, `vfx/`. |
| `apps/holtburger-web/src/` | The wasm crate (`holtburger-web`, a `cdylib`). `lib.rs` is about 64.5k lines: the `SessionHandle` class, `start_session`, `recv_loop`, `SessionCommand`, `ClientEvent`, plus DAT decode and bake exports. The sibling files (`motion_sequence.rs`, `net_worker.rs`, `prefetch.rs`, `decode_*.rs`, `geom_bundles.rs` and others) are split-out pieces. |
| `apps/holtburger-web/plugins/` | HUD and panel plugins (chat, inventory, spellbook, combat bar, vitals, and more). Each panel is `*.js` plus `*.manifest.json`. `plugins/api.js` is the plugin event bus. |
| `apps/holtburger-web/ui/` | Retail-UI helpers (layout, fonts, cast/attack logic) that the plugins use. |
| `apps/holtburger-web/harness/` | Test runners and probes: `run-js-headless.mjs` (the Node test gate), `cargo-tests.mjs`, `playwright/drive.mjs`, the 1070/perf probes, and `README.md` / `COVERAGE.md`. |
| `apps/holtburger-web/tests/` | About 80 Node unit tests (`*.test.mjs` / `*.test.cjs`). The top-level `test_*.mjs` files are more of the same. Most of both are listed in `run-js-headless.mjs`. |
| `apps/holtburger-web/rynth/`, `netbrain/` | The in-browser bot/agent stack and its tests (`rynth_*.cjs`). |
| `apps/holtburger-web/legacy/` | The retired PixiJS 2D renderer (`render_2d.js`, `entity_2d.js`, `door_2d.js`). Nothing loads it. |
| `apps/holtburger-web/docs/` | App docs. The ones that matter are listed in [`DOCS_INDEX.md`](DOCS_INDEX.md). |
| `apps/holtburger-wsbridge/` | WebSocket↔UDP bridge (`holtburger-wsbridge` binary, plus `holtburger-wsshim`). |
| `apps/holtburger-cli/`, `apps/holtburger-tools/` | The original TUI client (the workspace default member) and the offline tools (`dat2hba`, `dat-shard`, bakers). |
| `apps/rynthnav-sidecar/`, `apps/wbt-sidecar/` | Sidecars for the bot stack. These are not workspace members. |
| `crates/holtburger-protocol` | Packet and message codec, opcodes. |
| `crates/holtburger-session` | Packet sequencing, fragments, ISAAC, transport trait. |
| `crates/holtburger-core` | Client orchestration. **`src/client/movement/`** holds the retail motion stack: `motion_interp.rs`, `movement_manager.rs`, `move_to.rs`, `jump_charge.rs`, `motion_table_manager.rs`, `stall_recovery.rs`, `system.rs` + `system/tests.rs`, `retail_behavior_tests.rs`. |
| `crates/holtburger-world` | World state, entities, physics/spatial (BSP), and the `pose_snap_diag` / `leash_echo_diag` diagnostics. |
| `crates/holtburger-dat`, `-dat-write` | DAT parsing (portal/cell), and DAT writing. |
| `crates/holtburger-content`, `-manifest`, `-resource-http` | Content mounting, the dist manifest, and HTTP resource fetch for wasm. |
| `crates/holtburger-scenery-bake`, `-event-bake`, `-suite-bake` | Offline bakers for the per-landblock `dist/` layers. |
| `crates/holtburger-transport-ws` | WebSocket transport used by the wasm session. |
| `crates/holtburger-scripting`, `-common` | The Deno scripting host (TUI) and shared types. |
| `scripts/` | `serve.py`, `wsbridge-supervise.sh`, `proxy.cjs`, `lint-url-flags.mjs`, `audit-flag-defaults.mjs`, `setup-dist-symlinks.sh`, `net-review/`, `perf-worker/`, `visual-regression/`, `oracle/`. |
| `docs/` | Fork-level docs, plus `docs/archive/`. |

`README.md` and `ARCHITECTURE.md` at this level still describe the upstream TUI
fork (last touched 2026-05-03). The per-crate `crates/*/ARCHITECTURE.md` files
are still broadly accurate for the protocol, session and DAT layers.

## 3. Running it locally

### 3.1 Build the wasm

```sh
cd apps/holtburger-web
wasm-pack build --target web --out-dir pkg --release
```

- `pkg/` is **gitignored**. Rebuild it after any change to Rust under
  `apps/holtburger-web/src/` or `crates/`, and after any pull that touches
  them. A stale `pkg/` shows up as a silent boot failure or as
  `TypeError: … is not a function`. The main thread and the bake worker both
  import `pkg/holtburger_web.js`.
- Always use `--release` for anything you measure or ship. A `--dev` build is
  about 17–19 MB, against about 4.2–4.7 MB for release, and runs several times
  slower. `serve.py` warns when the wasm it serves is over 8 MB.
- On the 8 GB dev laptop, run Rust builds through the `capped-build` OOM wrapper
  and never run `cargo build/test --workspace`. See the user's MEMORY.md
  "capped-builds" entry.

### 3.2 Serve the app and the baked world

```sh
python3 scripts/serve.py            # validate dist, write dist/_health.json, serve :8765
python3 scripts/serve.py --check    # validate only, then exit (preflight / CI)
python3 scripts/serve.py --allow-missing   # serve even if a baked layer is absent
python3 scripts/serve.py --port N --bind 127.0.0.1
# open http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1
```

- `serve.py` works from any cwd. It (re)points the single `external/holtburger/dist`
  symlink at `$HOLTBURGER_DIST`, which defaults to
  `/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2`.
- `manifest.json`, `shards/`, `scenery/` and `spawns/` are required, and a
  missing one fails loudly. `events/` only produces a warning.
- `--allow-missing` gives you a partial world without saying so: every
  landblock that 404s comes back with "0 placements".
- Put **`?nosw=1` on every dev URL.** The service worker caches `index.html`,
  shards and `boot.hba` across reloads and even browser restarts.
  `?nosw=1` unregisters it, clears its caches and reloads once.
  Ctrl+Shift+R does not do this.

### 3.3 Bridge and server

- **ACE**: a vanilla ACE server on UDP `:9000` (and `:9001`). The account needs
  `accessLevel ≥ 4` (Developer) for the `@telepoi` and `@teleloc` admin
  commands the harnesses rely on.
- **wsbridge**: build it with `cargo build --release -p holtburger-wsbridge`,
  then run `scripts/wsbridge-supervise.sh`. The script restarts the bridge if
  it dies, listens on `0.0.0.0:8080` (override with `WSBRIDGE_LISTEN`), logs to
  `/mnt/wbterminal2/wsbridge_console.log`, and stops when
  `/mnt/wbterminal2/wsbridge.STOP` exists. To survive a reboot on this
  sysvinit box, start it from cron with `@reboot`.
- The login form defaults to `ws://127.0.0.1:8080/` and `127.0.0.1:9000`. The
  `bridge_url`, `server_host` and `server_port` URL params override those
  defaults.

### 3.4 Auto-login (agents, bots, headless)

```
index.html?nosw=1&autoLogin=1&account=X&password=X&autoSpawn=first
```

- `autoSpawn` takes `first` or a character name.
- `&agent=1` (or `&bot=1`) turns on the net worker (`scene3d/net_worker_client.js`).
  The net worker is off by default for human sessions.
- Gate your script on `window.__bootStateHistory`, not only on the
  `__bootState` scalar. Scene-ready and in-world can arrive in either order.
- Since `93461059`, `?password=` is moved into the tab's `sessionStorage` and
  removed from the URL and history. Reloads still log in.
- No-GPU modes: `?wireframe=1`, and `?nullRender=1` (no `render()` call; the
  sim and the event drain keep running). For a zero-GPU bot use
  `?nullRender=1&renderOnDemand=1&netDrainHz=30`.

### 3.5 Remote play: proxy plus Cloudflare quick tunnel

`scripts/proxy.cjs` puts the app and the bridge on one origin at
`127.0.0.1:7080`. `/wsbridge` is upgraded to a WebSocket and forwarded to
`:8080`; every other path is forwarded to `:8765`.

```sh
node scripts/proxy.cjs
cloudflared tunnel --url http://127.0.0.1:7080      # prints https://<host>.trycloudflare.com
```

```
https://<host>/apps/holtburger-web/index.html?nosw=1&autoLogin=1&account=X&password=X&autoSpawn=first&bridge_url=wss://<host>/wsbridge&server_host=127.0.0.1&server_port=9000
```

- `bridge_url` **must** be `wss://<same tunnel host>/wsbridge`. A
  `ws://127.0.0.1:8080` URL points at the remote browser's own localhost, and
  the browser blocks it as mixed content.
- `server_host` and `server_port` stay laptop-local, because the bridge dials
  ACE, not the browser.
- The quick-tunnel host changes on every cloudflared restart. Get the current
  one from the cloudflared log.
- On Tailscale you can skip the tunnel and use
  `http://<tailnet-ip>:7080/...&bridge_url=ws://<tailnet-ip>:7080/wsbridge`.

### 3.6 Diagnostics in the page

- `window.__hbWasm`: wasm diagnostic exports, including `localPoseSnapDiag()`,
  `leashEchoDiag()`, `moveTelemetryDrain()` and `moveTelemetryStatus()`.
- `window.__diag.*`: per-subsystem surfaces.
- `window.liveScene3d`: set once by `init3D`. It is a **snapshot**, not a live
  facade, and it is set late, so poll for it to be non-null first.
- A wasm panic now calls `window.__hbWasmPanicked` and shows the disconnect
  banner. Before `93461059` the world just froze.

## 4. Testing

| What | Command | Notes |
|---|---|---|
| Headless JS gate | `cd apps/holtburger-web && node harness/run-js-headless.mjs --quiet` | Pure Node: no browser, no wasm build, no server. Runs about 300 listed unit tests, one child process each. A child that prints SKIP counts as a failure unless you pass `--allow-skips`. `--list` prints the plan; `--only=substr` filters it. |
| `npm test` | `cd apps/holtburger-web && npm ci && npm test` | Same gate. `apps/holtburger-web/package.json` pins three, postprocessing and @takram as dev dependencies so Node can resolve them. It was added together with the CI workflow below; if your checkout does not have it yet, run the `node` command directly. |
| Flag lints | `node scripts/lint-url-flags.mjs [--strict]` · `node scripts/audit-flag-defaults.mjs [--off\|--all\|--mismatch]` | Check that every flag reader has a docs row, and that the default each row documents matches what the code does. |
| ClientEvent kinds | `node scripts/gen-client-event-kinds.mjs [--check]` | Regenerates `scene3d/client_event_kinds.js` from the `CLIENT_EVENT_KIND_*` constants in `src/lib.rs` (54 distinct kinds today). `--check` exits 1 if the file is stale. |
| Rust, no DATs | `cargo test -p holtburger-common -p holtburger-protocol -p holtburger-core --lib` | The set CI runs. The movement tests (`client/movement/system/tests.rs`, `retail_behavior_tests.rs`) are in `holtburger-core`. |
| Rust, DAT-backed | `cargo test -p holtburger-dat` (and others) | These need retail DATs: `HOLTBURGER_PORTAL_DAT`, `dats/portal.dat`, or `~/ac_base_dats/client_{portal,cell_1}.dat`. Without them, many of these tests print SKIP and **pass**, so a green run without DATs proves very little. |
| Wasm smoke | `node smoke_test.cjs [--fast]` | Needs a `--target nodejs` build in `pkg-node/`. The full run bakes a fixture dist (hash-cached). |
| In-browser | `harness/playwright/drive.mjs`, `capture_*.cjs`, `probe_*.cjs` | Need a running serve.py, bridge and ACE. Laptop Chromium uses SwiftShader, so trust it for logic, not for pixels or perf. |

**CI:** `holtburger-ci.yml` at the **repository root**
(`.github/workflows/holtburger-ci.yml`) runs on pushes and PRs to `master` that
touch `external/holtburger/**`. It has two jobs:

- `js`: `npm ci`, `run-js-headless.mjs --quiet`, `gen-client-event-kinds.mjs --check`, `lint-url-flags.mjs`, `audit-flag-defaults.mjs`.
- `rust`: the no-DAT `cargo test` line from the table.

The workflows under `external/holtburger/.github/` never run, because GitHub
only reads the root `.github/`.

## 5. Architecture in brief

### 5.1 Frame loop

`scene3d/index.js` owns the `requestAnimationFrame` `tick`. Each frame it calls
`tickPerFrame(scene3d, sessionHandle, dt)` from **`scene3d/loop.js`**, then
renders through the atmosphere composer. If the composer is not up, it falls
back to `renderer.render`.

`tickPerFrame` drives:

- the camera, and the WASD → `setMovementInput` path
- entity update drain and dispatch (`dispatchEntityUpdate`, `installSharedDrainHook`)
- the entity tick
- cell visibility, portal punch and seal feeds (`cells.js`)
- lighting
- landblock streaming and eviction (`landblock_lru.js`)
- far terrain, and the static and terrain batch compaction

A separate `setInterval` net-drain pump keeps `tickPerFrame` running while
rendering is paused (`?netDrainHz`, `?nullRender`).

### 5.2 Render pipeline

`scene3d/atmosphere_pipeline.js` builds a pmndrs `EffectComposer`. The passes,
in order:

1. Sky `RenderPass` and `SkyCapturePass`
2. World mask and world `RenderPass`
3. Optional `PortalStencilPass` (retired scaffold, `?portalStencil`, off)
4. Portal punch (see below)
5. Indoor depth clear (`ClearPass`, depth only)
6. Portal **seal** pass (when `?indoorDepthSplit`, which is on by default)
7. Cells mask and cells `RenderPass`
8. One `EffectPass`: HeatHaze → AerialPerspective → LensFlare → Bloom →
   Vignette → ToneMapping → Dithering

The renderer runs `logarithmicDepthBuffer: true`.

**Portal punch.** `?portalPunch` has been on by default since 2026-08-04. With
**`?punchRetail`**, which has also been on by default since 2026-10-05, the
punch is no longer a composer pass. Its aperture mesh joins the main scene, and
`punchPhaseOpaqueSort` orders the single world pass as terrain → punch →
shells/statics/cells/entities. That is retail's `DrawBuilding` order: the punch
only erases terrain depth, and every nearer occluder depth-tests normally.
`?punchRetail=off` brings back the old world/cells split, with the union
scissor and the optional `?punchOcclusion=on` stencil gate.

### 5.3 Entities and animation

`scene3d/entities.js` (~17.6k lines) holds the `EntityManager`: one Object3D rig
per entity. Motion runs on the **Rust `MotionSequence` playhead**
(`src/motion_sequence.rs`, exposed through `window.__hbWasm`).
`scene3d/motion/motion_sequence.js` `poseRigAt` writes the per-part pose, and
`scene3d/motion_queue.js` is a transcription of retail
`MotionTableManager::pending_animations`.

`?unifiedMotion` selects which motion classes use that playhead. When the flag
is absent, every class does: locomotion, attack, cast, death, door and missile.
Locomotion joined that default set on 2026-08-13.

The legacy three.js `AnimationMixer`, one per entity, is **being retired**. It
is still built and is the soft-degrade path for `?unifiedMotion=off` and for a
stale `pkg/` that lacks `MotionSequence`. `entities.js` has about 40 `mixer.`
call sites and 6 `clipAction(` calls left.

### 5.4 Wasm session

`start_session(bridge_url, server_ip, server_port, user, pass, asset_url)` in
`src/lib.rs` opens the WebSocket transport, logs in, and spawns
**`recv_loop`**. `recv_loop` is a single `async fn` of about 12k lines that
owns the `Session`. It `tokio::select!`s inbound messages against a command
channel.

- **JS → Rust:** `SessionHandle` methods enqueue **`SessionCommand`** variants.
  `recv_loop` dispatches them; the enum alone is about 1,000 lines.
  Since `93461059`, outbound actions are sent in order through
  `send_ordered!` / `defer_if_ordered`, so a combat request waiting behind its
  stop cannot be overtaken by a later action.
- **Rust → JS:** `poll_events()` returns `ClientEvent[]` tagged by numeric
  `kind`. The kinds are the `CLIENT_EVENT_KIND_*` constants. Use the generated
  `scene3d/client_event_kinds.js` names (from
  `scripts/gen-client-event-kinds.mjs`) instead of bare numbers. Entity spawns,
  moves and removals go through a separate `pollEntityUpdates` stream.
- `?netWorker` (on for `agent=1` / `bot=1`) runs the session in a worker
  (`src/net_worker.rs`, `scene3d/net_worker*.js`).

### 5.5 Movement and physics

Local-player movement is the retail motion stack in Rust under
**`crates/holtburger-core/src/client/movement/`**: the `CMotionInterp` port,
`MovementManager`, `MoveTo`, jump charge, stall recovery and command stacks.
Physics and collision, including the cell and static BSP, are in
`crates/holtburger-world/src/spatial*`. The JS side only feeds input
(`setMovementInput`) and reads poses back.

## 6. URL flags

[`apps/holtburger-web/docs/url-flags.md`](apps/holtburger-web/docs/url-flags.md)
is the **one** canonical flags doc. Extend it; don't start a parallel ledger.

House rules:

- An **absent flag means the shipped default.** Every flag needs a docs row
  that states that default.
- A reader written as `!== "off"` is **on by default**: absent reads as on, and
  `=off` is the escape. Only `=== "on"` (or `=== "1"`) is a true opt-in. Many
  old comments say "default OFF" over a `!== "off"` reader, so trust the
  reader, not the comment.
- Run `lint-url-flags.mjs --strict` and `audit-flag-defaults.mjs` before
  claiming any flag's default.
- Validated features ship on by default with an `=off` escape. Section §0 of
  url-flags.md lists every deliberately off-by-default flag and the evidence
  that would flip it.
- Harness and boot params (`nullRender`, `wireframe`, `renderOnDemand`, `diag`,
  `nosw`, `agent`, `autoLogin`, `account`, `password`, and so on) stay opt-in.

## 7. Known broken and open issues (2026-10-05 audit)

1. **Running "jut back".** While running, the local player visibly snaps back.
   The cause is not pinned down. It needs a capture first: load with
   `&moveTelemetry=1`, reproduce, then save `__hbWasm.moveTelemetryDrain()`,
   `__hbWasm.localPoseSnapDiag()` and `__hbWasm.leashEchoDiag()`. Fixing it
   without that data is guesswork. Related: `b6c7474c` (audit F1) fixed a stop
   that left the walk cycle running.
2. **Portal punch in retail order is not yet checked on a real GPU.**
   `?punchRetail` is on by default but has only been checked under SwiftShader.
   It needs a real-GPU look (1070 or T4) at doorways seen from outside, at
   distance, and from inside. `=off` is the fallback.
3. **The indoor seal writes perspective depth into a log-depth buffer.**
   `makeSealMaterial()` in `scene3d/portal_punch.js` is a bare `ShaderMaterial`
   with no `gl_FragDepth` write. It writes rasterizer (perspective) depth, while
   every other material writes logarithmic depth
   (`logarithmicDepthBuffer: true`). So the seal compares in the wrong depth
   space, and the error grows with distance. The punch material does it
   correctly: it uses `MeshBasicMaterial` so three injects the logdepth chunk.
4. **The cloud overlay runs a second composer and skips tone mapping.**
   `scene3d/cloud_overlay.js` builds its own `EffectComposer` (RenderPass of the
   main scene + `EffectPass(CloudsEffect)`). That renders the world a second
   time per frame just to get depth. The overlay is then composited outside the
   main `EffectPass`, so it never goes through ToneMapping.
5. **AnimationMixer retirement.** The plan has three steps:
   - Move every remaining mixer caller in `entities.js` onto the
     `MotionSequence` playhead.
   - Turn the stale-`pkg/` soft-degrade into a hard boot error.
   - Delete the mixer path, along with `?unifiedMotion=off`.

   Do not add new mixer callers.
6. **The `recv_loop` monolith.** `recv_loop` (~12k lines) and `SessionCommand`
   (~1k lines) in a 64.5k-line `lib.rs` make the session hard to review or
   test. Split the command arms into per-domain handlers. The ordered-outbound
   change in `93461059` is the invariant that split must keep.
7. **About 540 URL flags.** The 2026-08-02 audit counted 547 flags. Most of the
   on-by-default ones are settled and should become plain code. Retire them in
   batches: delete the reader and the off branch, and move the row to a
   "retired" section. `93461059` removed `?unifiedTransition` and
   `?faithfulTransition` this way.

For the most recent retail-parity comparison by subsystem (collision, doors,
combat, remote motion, perf), see
`apps/holtburger-web/docs/openac-comparison-2026-10-04/`. Several of the
2026-10-04/05 commits come out of it.

## 8. Working rules that save time

- Ground truth for retail behaviour is the decomp (`acclient.c` / `acclient.h`),
  then ACE, then DatReaderWriter. Comments cite `acclient.c:<line>`; re-verify
  them, because they drift.
- Keep ACE vanilla. Never fix client problems by patching the server.
- Read the browser console before diagnosing anything 3D, and again after any
  shader edit.
- The bake worker is on by default (`?bakeWorker=0` opts out) and holds its own
  wasm instance. After a wasm rebuild, do a full reload or perf numbers can
  come from a stale path.
- For eye-tests and perf, SwiftShader is not evidence. Use a real GPU and queue
  the URL flags for one batched session.
- Commit messages say what the user sees ("doors no longer turn see-through"),
  not which task number they close.
