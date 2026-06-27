# HANDOFF — cold-load shader-compile freeze fix (2026-06-27)

Operational handoff to pick up the **first-load terrain-shader freeze**. Deep analysis +
ranked options live in [`freeze-investigation-2026-06-27.md`](freeze-investigation-2026-06-27.md);
this doc is the "how to execute it" companion (the 1070 spike + prototype order).

## Session context (where the world stands)

The per-landblock-faithful restoration is **done, live, and validated** (see
[`per-landblock-faithful-world-method-2026-06-26.md`](per-landblock-faithful-world-method-2026-06-26.md)
+ `-EXECUTION-` + `eyetest-genfix-2026-06-26/FINDINGS.md`):

- **Fix 1 (generators)** + **Fix 2 (orientation)** shipped (C# in this commit) and re-staged into
  `dist/spawns` (38,152 LBs; dungeon `0x00B4` 0→810 monsters; oriented portals/NPCs).
- **Fix 3 (events)** world-baked into `dist/events` (40,197 LBs, ~35s local).
- **Interior-complete oracle** (`dump-lb-expectations.interior` now emits per-cell stabs+portals).
- **Validated** on the 1070 (real GPU) + laptop (software GL via `__diag`): interiors load
  completely, world populated/textured, no white-box, no barren, zero errors.
- Render-polish triage: Fix 4 (depth-clear) + Fix 5 (LRU) = **no action** (correct as-is).

> Data note: `dist/{spawns,events}` lives on `/mnt/wbterminal2/holtburger-dist` (NOT git). Rollback
> dirs: `spawns.bak-pre-genfix-2026-06-26`, `events.bak-169ring-2026-06-26`. Regenerate per the
> EXECUTION runbook (re-ingest from ACE → `stage-ring-spawns.py --all-world`; `event-bake @<list>`).

**The freeze is the ONLY remaining render item** — and it is a standalone perf project, NOT a
regression in the restored world. For the owner's persistent Chrome profile it is already a
once-per-config cost (Chrome GPUDiskCache: cold 22s → warm 7.5s). Target = cold first load.

## Root cause (one paragraph)

Boot `renderer.compile(scene,camera)` (`index.js:3796`) warms the terrain shader's **sRGB-canvas**
program; the atmosphere composer renders terrain into a **HalfFloat/linear** buffer
(`atmosphere_pipeline.js:133`) = a **different** GL program, compiled **synchronously on the main
thread at the first composer DRAW** (`index.js:2094`, ~24s cold). ANGLE/D3D11 defers the HLSL→bytecode
compile to first *draw*, so `compileAsync` returns early and can't hide it. All 8 prior fixes were
main-thread → none could move the synchronous draw-compile off it.

## NEXT STEPS (in order)

### 0. The 1070 spike (~1 hour, do FIRST — decides everything)
On the 1070, with a COLD Playwright `newContext` (= cold GPU cache = the first-load case), measure:
- **Q1 (A1 vs A2):** bind the composer's HalfFloat target (`renderer.setRenderTarget(atmospherePipeline.inputBuffer)`
  or match `outputColorSpace`/buffer type) then `renderer.compile(scene,camera)`. Does the ~24s land
  at the `compile` call (link-time → **A1** works) or only at the first composer `render` (draw-time
  → need **A2**, a throwaway composer warm-frame)? Instrument with `performance.now()` around each.
- **Q2 (is B viable):** spin an `OffscreenCanvas` in a Web Worker, build the terrain `ShaderMaterial`
  + a small terrain mesh + a HalfFloat target there, draw once (eat the compile on the worker
  thread), then on the MAIN thread compile/draw the same shader source — is it now fast (GPUDiskCache
  hit)? If yes, **B is the real fix**.

Repro + tunnels + accounts: handoff §4 of `…/2026-06-20-busted-world-load-freeze-handoff.md`
(`repro-busted-world-1070.mjs`; reverse `-R 18765`, account `phase4demo` GM, `?nosw=1`,
`renderDiag=on`). The genfix harnesses in `docs/eyetest-genfix-2026-06-26/` are a working
boot+teleport+`__diag` template to adapt (note: `bootInWorld` must accept boot state `"ready"`, and
the box's GPU session must be unlocked or new headless WebGL contexts fail with `renderer:err`).

### 1. Ship A — relocate the freeze into the loading phase (cheap, low-risk)
After Q1: replace the wasted sRGB precompile with a **correct-variant warm** during boot (A1 =
`renderer.compile` with HalfFloat target bound; A2 = one throwaway `atmospherePipeline.render()` to a
dummy target) AFTER the boot ring has baked terrain (the `:3543` "scene fully populated" timing
already holds). Flag `?composerWarmReal` (default-off until 1070-validated; then default-on with
`=off`). Removes the wasted sRGB compile and moves the ~24s behind the loading screen. **Relocates,
does not eliminate** — but it's the immediate UX win. (Attempt #5 was close but used early-resolving
`compileAsync` + an incomplete scene; use SYNC compile / a real warm-frame.)

### 2. Build B — off-main-thread GPUCache warm (eliminates first-load freeze; highest value)
If Q2 confirms cache-sharing: a Web Worker + `OffscreenCanvas` compiles/draws the terrain shader off
the main thread to warm Chrome's source-keyed GPUDiskCache; main thread shows a cheap first-paint and
swaps when the worker postMessages "warmed". Worker harness precedent: `bake_worker_client.js` /
`bake_transfer.js`. **Hard part:** keep the worker's terrain `ShaderMaterial` source in lockstep with
`terrain.js:3007` (a drift = a wasted warm of a different program). Fall back to **C (shader-split:
cheap variant → swap with a visible pop)** if cache-sharing doesn't hold.

### Do NOT
- Re-try the 8 reverted main-thread approaches (handoff §2.3).
- Build a program-binary cache (duplicates Chrome's GPUDiskCache; ANGLE binaries non-portable).
- Reduce shader complexity (changes visuals).
- Expect ANY of this to repro on laptop SwiftShader — it's ANGLE/D3D11-only. GPU-gated end to end.

## Acceptance
- A: on a COLD-cache 1070 load, the post-"ready" main-thread stall (`pumpAge` spike) is gone — the
  ~24s now lands during the loading phase; `off=byte-identical` to today; no wasted sRGB program.
- B/C: COLD-cache 1070 first load reaches interactive with **no** >2s main-thread stall; terrain
  renders correctly after the warm/swap.

## Key refs
- Analysis: `docs/freeze-investigation-2026-06-27.md`. Prior attempts + GPU-cache numbers:
  `external/holtburger/apps/holtburger-web/docs/2026-06-20-busted-world-load-freeze-handoff.md`.
- Code: `scene3d/index.js:3793/3796` (precompile), `:2094` (composer render), `:3524-3581` (pipeline
  construct/timing); `scene3d/atmosphere_pipeline.js:131-133` (HalfFloat); `scene3d/terrain.js:3007`
  (terrain ShaderMaterial); `scene3d/bake_prewarm.js` + `cells.js:815` (working compileAsync prewarm).
