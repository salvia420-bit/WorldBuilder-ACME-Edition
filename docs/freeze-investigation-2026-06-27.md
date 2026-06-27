# Cold-load terrain-shader freeze — investigation + fix plan (2026-06-27)

Follow-up to `external/holtburger/apps/holtburger-web/docs/2026-06-20-busted-world-load-freeze-handoff.md`
(8 fixes tried + reverted). This doc pins the exact mechanism and proposes the approaches the prior
round did NOT try (all 8 were main-thread). **GPU-validation-required** — the freeze is ANGLE/D3D11-
specific and does NOT reproduce on laptop SwiftShader; needs a 1070 window to measure any fix.

## Confirmed mechanism

1. **The boot precompile warms the WRONG program variant.** `renderer.compile(scene, camera)`
   (`scene3d/index.js:3796`, synchronous `doCompile`) compiles each material's program for the
   renderer's *current output state* = the **sRGB direct canvas**. The terrain `ShaderMaterial`
   (`terrain.js:3007`, triplanar + atmosphere + CSM + log-depth) gets its **sRGB** program compiled.
2. **The composer renders terrain into a different (HalfFloat/linear) target.** The atmosphere
   `EffectComposer` uses `frameBufferType: THREE.HalfFloatType` (`atmosphere_pipeline.js:133`). The
   terrain program for that output encoding is a **different GL program** than the sRGB one — so the
   precompile's terrain work is discarded.
3. **First composer render = the freeze.** `atmospherePipeline.render()` (`index.js:2094`, fired from
   the `atmosphereRuntime.whenReady().then()` block that constructs the pipeline at `:3571`) is the
   first time the HalfFloat terrain program is actually **drawn**. ANGLE/D3D11 cross-compiles the big
   shader (GLSL→HLSL→D3D bytecode via FXC) **synchronously on the main thread** — CDP profile:
   `onFirstUse` (three.module.js) ≈ 65k ms self-time. ~8 unique programs, each ~3–8s.
4. **Why `compileAsync` works for EnvCells but not terrain.** `bake_prewarm.js` / `cells.js` use
   `renderer.compileAsync` and it backgrounds EnvCell programs fine. For the terrain material it
   resolves early ("169 promises in 10ms", handoff attempt #7). The most consistent explanation:
   **ANGLE/D3D11 defers the costly HLSL→bytecode compile to the first DRAW**, not link. `compileAsync`
   links + polls `COMPLETION_STATUS_KHR` (true quickly) but never draws → resolves before the real
   cost → the first composer **draw** still pays it. (EnvCell shaders are small enough that even the
   draw-time compile is sub-frame.)

**Therefore:** every prior fix failed because it operated on the **main thread** (compileAsync gating,
boot-ring shrink, spawn yields) and the expensive step is a **synchronous main-thread draw-compile**
that nothing main-thread can hide. Also the existing precompile is **doubly wasteful** — it spends
time compiling the sRGB terrain variant that is never used.

## Already-mitigated reality (don't over-invest)

Chrome's on-disk **GPUDiskCache** is shader-source-keyed, account-independent, GPU-process-wide, and
persists across loads (handoff: cold 22.3s → warm 7.5s on the same `--user-data-dir`). The owner's
desktop shortcut uses a persistent profile, so the freeze is a **once-per-shader-config** cost in
daily use. The target is the **first load on a cold cache** (new machine / new shader config / the
headless `newContext` path).

## Ranked fix options

### A. Relocate the freeze into the loading phase (simplest; relocates, not eliminates)
Stop wasting the sRGB precompile; instead warm the **exact program the composer uses**, during boot
(behind the loading screen) rather than after "ready". Two sub-variants — measure both on the 1070:
- **A1 (link-time):** before `doCompile`, bind the composer's HalfFloat target —
  `renderer.setRenderTarget(atmospherePipeline.inputBuffer)` (or set `renderer.outputColorSpace` /
  the buffer's type to match) — then `renderer.compile(scene, camera)`, then restore. If ANGLE
  compiles at *link*, this pays the cost during boot and the composer's first render is a cache hit.
- **A2 (draw-time, needed if ANGLE defers to draw):** do ONE throwaway `atmospherePipeline.render()`
  to a dummy/offscreen target during boot (a "composer warm-frame") so the draw-compile happens
  behind the loading screen. Then the first user-visible composer render is warm.
Cost ~50 LOC, flagged `?composerWarmReal` (default off until 1070-validated). Risk: low (boot-only;
restores state). Win: the ~24s moves from "after the world looks ready" to "during loading", and the
wasted sRGB compile is removed. **Does NOT make it faster — only better-placed.** This is the
cheapest meaningful UX win and the right first experiment (attempt #5 was close but used early-
resolving `compileAsync` + an incomplete scene; use SYNC `renderer.compile`/a real warm-frame AFTER
the boot ring has baked terrain — the `:3543` "scene fully populated" timing already holds).

### B. Off-main-thread GPUCache warm via OffscreenCanvas + Worker (eliminates; highest value; novel)
None of the 8 prior attempts left the main thread. Compile+draw the terrain shader in a **Web Worker
with an OffscreenCanvas** (its own GL context, on the worker thread). The expensive D3D compile runs
**off the main thread**, populating Chrome's source-keyed GPUDiskCache (shared across all contexts in
the GPU process). The main thread renders a cheap first-paint meanwhile; when the worker signals
"warmed", the main thread's compile/draw of the same shader source is a **cache hit** → no freeze, on
ANY machine's first load. Requires: a worker that builds the identical terrain `ShaderMaterial` source
+ a representative terrain mesh + the composer's HalfFloat target, draws once, postMessages done.
Cost ~ a few hundred LOC + careful shader-source parity. Infra precedent: `bake_worker_client.js` /
`bake_transfer.js` (worker harness exists, though for wasm decode, not GL). Risk: medium (shader-
source drift between main + worker must be kept in lockstep). **Validate the core assumption first**
(cheap spike): does a worker-context draw of the terrain shader warm the GPUDiskCache such that a
subsequent main-context compile is fast? If yes, this is the real fix.

### C. Shader-split (eliminates; visible "pop")
First-paint terrain with a cheap variant (no atmosphere/CSM/triplanar — fast compile), swap to the
full `ShaderMaterial` once warmed (via B's worker, or after a fixed delay). No freeze; a one-time
visual pop when it swaps. Good fallback if B's GPUCache-sharing assumption fails. Changes first-paint
appearance, so it needs an eye-test sign-off.

### D. App-level program-binary cache — NOT recommended
`gl.getProgramBinary` persist/restore duplicates what Chrome's GPUDiskCache already does, and ANGLE
program binaries are **not portable across GPUs/drivers** (restore fails → recompile on a different
machine). Only helps same-machine repeat loads, which Chrome already handles. Low marginal value for
high plumbing cost (custom `WebGLRenderer`). Skip.

### Not viable
- Chrome flags to force ANGLE parallel-compile: not shippable (can't control end-user Chrome flags).
- Reducing shader complexity: changes visual output (handoff #8).

## Recommendation

1. **First, the cheap spike (no code-ship):** on the 1070, confirm (a) whether `renderer.compile`
   with the HalfFloat target bound pays the compile at link or defers to draw (decides A1 vs A2), and
   (b) whether an OffscreenCanvas-worker draw warms the GPUDiskCache for the main context (decides if
   B is viable). Both are ~1 hour of 1070 measurement.
2. **Ship A** (relocate to loading) as the immediate, low-risk UX win — flagged, default-on once
   validated. It removes the wasted sRGB compile and moves the freeze behind the loading screen.
3. **If a true first-load-no-freeze is wanted on cold machines, build B** (worker GPUCache warm) as a
   scoped follow-on; fall back to **C** (shader-split) if B's cache-sharing doesn't hold.

All of the above are GPU-gated: nothing here can be validated on laptop SwiftShader. Pair with the
1070 repro `…/repro-busted-world-1070.mjs` (handoff §4) — but note Playwright `newContext` = cold
cache every run, which is exactly the first-load case we're targeting.

## Key code refs
- Precompile (wasted sRGB variant): `scene3d/index.js:3793` (`doCompile`) / `:3796` (`renderer.compile`).
- Composer render (the freeze): `scene3d/index.js:2094` (`atmospherePipeline.render`).
- Pipeline construction + whenReady timing: `scene3d/index.js:3524`–`3581`.
- HalfFloat composer buffer: `scene3d/atmosphere_pipeline.js:131-133`.
- Terrain `ShaderMaterial`: `scene3d/terrain.js:3007`, onBeforeCompile/CSM `:3245`.
- Working `compileAsync` prewarm (EnvCells/bakes): `scene3d/bake_prewarm.js`, `cells.js:815`.
- Prior attempts + GPU-cache measurements: `…/docs/2026-06-20-busted-world-load-freeze-handoff.md`.
