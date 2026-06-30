# Handoff — post-2D-retire "busted/sparse world" + cold-load compile freeze (2026-06-20)

## TL;DR
Two distinct problems behind the user's report *"loads a busted version of the world, sparse
terrain, not painted right; now there's so much loading at startup that things are breaking."*

1. **Permanent-barren ("stays busted") — FIXED + SHIPPED.** Commit `5957fd55` (pushed to
   `origin`/salvia420-bit `master`). Four bakers marked a landblock "baked" *before* their
   load-bearing fetch, so one fetch throw under the heavy boot load permanently stripped that LB
   for the whole session. Plus boot-ring frame-budget, PVS-fan-out cap, and an orphan-on-pause seam.
2. **Cold-load ~24s freeze — DIAGNOSED, NOT fixed (8 attempts, all reverted).** The first atmosphere
   composer render synchronously ANGLE-compiles the big terrain shader. It's a *cold* compile —
   Chrome's persistent GPU cache mitigates it ~3× on repeat loads. Remaining work to kill the
   *first*-load freeze is a focused rendering-perf project (program-binary cache or shader-split).

Working tree is clean at `5957fd55`. All freeze experiments reverted.

---

## 1. What shipped — `5957fd55` (8 files, JS-only, no wasm rebuild)
All behavioral changes are flag-gated **default-ON with `=off` escapes**; the A/C correctness fixes
apply directly. Diagnosed by a 1070 real-GPU repro + a 13-agent audit; parallel-verified + diff-reviewed.

- **A1 terrain** (`terrain.js`, `index.js`): stash `scene3d.terrainOpts` at *resolve* time (not
  ring-end) + lazy-resolve fallback in `loadTerrainForLandblock`. An undefined `terrainOpts` no longer
  makes every streaming terrain bake throw "opts missing" + cooldown-retry forever (the worst
  permanent-barren path).
- **A2 statics / A3 buildings** (`statics.js`, `buildings.js`): mark the LB permanently baked **after**
  fetch+drain succeeds; a new module-local in-flight `Set` preserves the concurrent-call dedup the
  pre-add used to provide. A throw now leaves the LB retryable instead of permanently missing
  trees/cottages.
- **A4 spawns** (`spawns.js`, `landblock_lru.js`): drop the poison-on-failure add (was permanent —
  module-local set, never LRU-cleared); use a short retry cooldown, mark only on success, and add an
  LRU eviction hook so roaming back re-injects.
- **B2/B3** (terrain/statics/buildings): frame-budget the radius-6 boot ring bakes with real macrotask
  yields (`?terrainRingTimeSlice` / `?staticsRingTimeSlice` / `?buildingsRingTimeSlice`, default-on).
  1070-measured: net pump stays fresh (pumpAge 1–8 ms) through the bake; watchdog stops tripping on it.
- **C1** (`cells.js`, `stream_bake_guard.js`): cap the PVS-ring fan-out (`?pvsBakeCap`, global
  maxInFlight 6 + per-frame K=4 nearest-first) so the uncapped ~363-call/crossing storm stops
  saturating the bake worker.
- **C2** (`index.js`): `_releaseFrameDriverClaim` no longer resumes the retired net-only 2D driver on
  a context-loss pause (it can't stream PVS); onResume re-claims the sole 3D loop + clears the
  ring-fire sig.

Note: the watchdog orphan that `acb8fda2` fixed (hold the 3D claim on stale heartbeat instead of
handing off to the removed 2D driver) is verified working — that's *not* re-broken.

---

## 2. The cold-load freeze — diagnosis + everything that was tried

### Root cause (CPU-profiled, certain)
The first `atmospherePipeline.render()` — the pmndrs `EffectComposer` render at **`index.js:1895`**
(Sky-K.2 path; the `renderer.render` at `:1971/:1976` is a fallback that does NOT run when atmosphere
is on) — synchronously compiles the big terrain `ShaderMaterial` (triplanar + atmosphere + CSM +
log-depth). CDP CPU profile: **`onFirstUse` (three.module.js:7090) = 65k ms self-time** = first-use
shader compile. Only ~8 unique programs but each is a huge shader that ANGLE/D3D11 cross-compiles in
~3–8 s. `tickPerFrame` itself is fast (~38 ms); entity spawns are *victims* of the frozen main thread,
not the cause.

### THE KEY FINDING — it's a COLD compile; Chrome's GPU cache mitigates repeat loads
Test: 2 sequential `launchPersistentContext` loads sharing one `--user-data-dir` (run1 tailnet1 / run2
phase4demo — the GPU cache is shader-source-keyed, account-independent, so use different accounts to
dodge the single-login collision):

| | maxPumpAge (freeze) | time-to-ready |
|---|---|---|
| run1 — COLD GPU cache | 22.3 s | 51 s |
| run2 — WARM cache (same profile) | **7.5 s** | **18 s** |

So: (a) the ~24 s is a **one-time-per-shader-config cold compile, NOT re-done every load**; (b) the
owner's desktop shortcut uses a persistent `--user-data-dir=C:\Temp\chrome-holtburger`, so repeat
loads are ~3× faster — they mostly pay the freeze once per flag-set; (c) `?nosw=1` clears the Cache API
but NOT the GPUCache, so it doesn't defeat this; (d) **all the headless repros showed the full 24 s
because Playwright `newContext` = a COLD cache every run** — that's why every surgical fix looked like
it hit a fixed wall.

### Eight fixes tried, ALL reverted (don't re-try these)
1. Chunk the backlog-replay dispatch + `setTimeout` yields — no effect (the freeze isn't the spawns).
2. `?replaySerial` — `_armSpawn` returns the promise + await each NPC spawn — no effect.
3. `?spawnYield` — macrotask yield inside `_spawnImpl` before Step B — no effect.
4. Shrink boot ring to radius 2 (`?ringRadius=2&staticsRadius=2&buildingsRadius=2`) — STILL ~30 s, so
   the freeze does NOT scale with boot-ring size.
5. `?composerWarmup` — one-shot `renderer.compileAsync(scene)` with `composer.inputBuffer` bound,
   before arming the composer — got programs=20 (scene incomplete due to B2's spread bake) → still froze.
6. `?streamCompile` — per-LB `compileAsync` as each terrain LB bakes (EnvCell pattern, cells.js:724) —
   halved it at best but the 1st composer render still beat the background compile.
7. `?streamCompile` + **compile gate** — defer arming the composer until the collected per-LB
   `compileAsync` promises settle. **`compileAsync` resolved all 169 promises in 10 ms** → it resolves
   on *dispatch*, not compile *completion*, here → can't gate the freeze.
8. (implicit) reduce shader complexity — not pursued (changes visual output).

### Remaining work to kill the FIRST-load freeze (focused rendering-perf project, NOT surgical)
Pick one:
- **App-level program-binary cache** — persist `gl.getProgramBinary` blobs (per program, keyed by
  shader source + driver string), restore via `gl.programBinary` on next load. three.js doesn't expose
  this; needs custom `WebGLRenderer`/`WebGLProgram` plumbing (or a fork of the program init path). Makes
  *every* first load fast on any machine, not just repeat loads on one profile. Highest value.
- **Shader-split** — compile a cheap terrain variant (no atmosphere/CSM/triplanar) for instant
  first-paint, swap to the full `ShaderMaterial` once it's compiled in the background. Visible "pop"
  when it swaps, but no freeze.

For the owner's day-to-day (persistent profile) the freeze is already a once-per-config cost.

---

## 3. Lighting effects — diagnosed + fixed (config, not a bug)
User saw no "rays from sun". Probe (chrome-devtools on the live 1070 session) showed everything wired
(sun light intensity 1, aerial-perspective on, atmosphere ready) — `quality=low` just **disables the
post-effects**: `lightShafts` (takram crepuscular rays = the sun rays, wired `index.js:2975`, reuses
the cloud-volume passes so needs `clouds=on`), `lensFlare` (screen-space sun glare), `bloom` (glow),
`csm` (shadows). These are per-feature flags — `?lightShafts=on&lensFlare=on&bloom=on&csm=on` re-enables
them while keeping `quality=low` textures. `?csm=on` alone enables CSM (needs `quality.flags.csm` true +
`?shadows` not `=off`). `window.__setLightShafts(true)` toggles crepuscular rays live; bloom/lensFlare/
csm are init-built (need a relaunch). The owner's "Holtburg (Chrome)" desktop shortcut is set to
`quality=low&clouds=on&rain=off&lightShafts=on&lensFlare=on&bloom=on&csm=on`.

---

## 4. Validation infrastructure (how to repro on the 1070)
- **Accounts:** `tailnet1`/`tailnet1` is the OWNER's live playtest account — DO NOT clobber. Use
  `phase4demo`/`phase4demo` (indoor Holtburg, GM) for headless validation. Both single-login; for
  back-to-back runs either wait ~25–40 s between OR use different accounts (avoids the
  "Account In Use" boot-loop the ACE log shows).
- **Tunnels (on the laptop, run via `run_in_background`, NOT `ssh -fN` which exits 144 in this Bash):**
  reverse `ssh -N -R 18765:127.0.0.1:8765 young@100.127.215.75` (1070 reaches the app at
  `127.0.0.1:18765`); forward `ssh -N -L 9333:127.0.0.1:9333 …` (laptop reaches the 1070's Chrome CDP
  for the chrome-devtools MCP / curl `127.0.0.1:9333/json/list`). serve.py:8765 serves the live working
  tree (no-store), so uncommitted changes are testable without a build.
- **Headless repro (real GPU, ANGLE/D3D11):** `/mnt/wbterminal1/tmp/claude-scratch/repro-busted-world-1070.mjs`
  (Playwright-chromium ON the 1070 via `scp` + `ssh node`). Probes `__bootState`, `pumpAge`
  (staleness = the freeze), watchdog warnings, `__diag.summary()`, scene complexity, screenshots. URL:
  `…/index.html?nosw=1&quality=low&clouds=off&autoLogin=1&account=phase4demo&password=phase4demo&autoSpawn=first&bridge_url=ws://100.116.47.66:8080/&server_host=127.0.0.1&server_port=9000&renderDiag=on`.
  GPU-cache test: `repro-cache-test-1070.mjs` (launchPersistentContext, cold vs warm). `?nosw=1`
  mandatory; CAVEAT: fresh Playwright context = COLD GPU cache every run (always shows the full freeze).
- **chrome-devtools MCP** connects to the 1070's Chrome over the `-L 9333` forward (the desktop shortcut
  launches Chrome with `--remote-debugging-port=9333 --remote-allow-origins=*`). Good for read-only live
  probing of atmosphere/lighting/program state.

## 5. Key code locations
- Boot ring radii (`index.js:124-184`): `HOLTBURG_RING_RADIUS`/`STATICS_RING_RADIUS`/
  `BUILDINGS_RING_RADIUS` default 6; `PVS_RING_RADIUS` default 5.
- `init3D` order: `bakeTerrainRing` (`:1231`) → buildings/statics Promise.all (`~:1461`) →
  EntityManager (`:2139`/`:2246`) → `liveScene3d` (`:2291`, references bake summaries — can't move
  before the bakes) → publish `window.liveScene3d` (`:2726`) → `installSharedDrainHook` (`:4078`) +
  pump claim (`:4088`). atmosphere pipeline created + composer armed in the
  `atmosphereRuntime.whenReady().then()` block (`:3161`); world precompile `renderer.compile(scene,camera)`
  at `:3377` (compiles the wasted sRGB-canvas variant — the composer needs the HalfFloat/linear one).
- Composer render `index.js:1895`; atmosphere composer `atmosphere_pipeline.js` (HalfFloatType buffers
  `:133`). EnvCell `compileAsync` precedent `cells.js:720-724`.

Full running notes: memory `project_holtburger_2dretire_load_busted_world_2026-06-20`.
