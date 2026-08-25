# HANDOFF — three perf follow-up levers, post light-pool ship (2026-06-22)

> **Context.** `docs/HANDOFF-shader-compile-trim-72programs-2026-06-22.md` was executed and the one
> lever that mattered — shrinking the fixed light pool 32/8 → 8/2 — is **shipped on `origin/master`
> = `59544b35`** (−76 % surface shader-link, ~−47 s of the cold first-load draw-distance stall;
> see `docs/RESULTS-shader-compile-trim-72programs-2026-06-22.md`). That fix removed the **shader-
> link wall**. This handoff captures the three *other* perf levers that surfaced while in there —
> deliberately scoped OUT of the shader-compile work because they're a different kind of work.
>
> **Honest provenance / prioritization:**
> - **Lever B (CPU-side draw-distance)** is the highest value — it's where the *remaining* r10 time
>   actually goes — but it is **already documented** in existing memories, not a fresh find. Re-stated
>   here so all three live in one place.
> - **Lever A (clouds prebake)** is a *fresh* find from this session's 72-program sweep, but it is
>   **conditional** — it only bites if clouds ever defaults on.
> - **Lever C (logDepth)** is a real cross-cutting cost but **high-risk**; last resort.
>
> None of this was a broad perf audit — the roam was shader-focused. A real subsystem-wide sweep (per-
> frame loop, draw calls, wasm boundary, bake pipeline) would likely surface more; see "If you want more".

---

## Lever A — Clouds procedural-noise bake (~33 s) → ship pre-baked `.bin` noise  *(conditional)*

**What.** With `?clouds=on`, ~38.9 s of the 72-program cold link is the **takram cloud subsystem**, and
~33 s of that is **4 procedural noise-texture bake programs** (Perlin/Worley/curl volume + detail
noise), compiled+run on first load. In the manifest these are the rank-0 program (~26 s — note this
one ALSO carries the one-time D3D11 first-link **driver warmup**, so its absolute ms is inflated),
rank-1 (~6 s), plus #23 and #30. The 2 render programs (`CloudsMaterial` ~2.7 s, `CloudsResolveMaterial`
~2.8 s) are the unavoidable remainder.

**Why it's parked, not done.** Clouds are **default-OFF** on the cold path, so this 33 s is **NOT in
today's budget**. It only becomes the single biggest lever **if clouds ever ships default-on** — at
which point it dominates everything, including the light pool.

**The fix (already scaffolded).** A `proceduralTextures=false` path exists — ship the cloud volume
noise as pre-baked `.bin` textures instead of generating them on the GPU at boot. That eliminates the
4 bake programs (~33 s) outright; only the 2 render programs remain.
- Anchors (from the 72-agent sweep — **verify before editing**): `cloud_overlay.js:~95-100`
  (`proceduralTextures` gate), `cloud_volume.js:~71` (`new CloudsEffect`),
  `vendor/takram-three-clouds/src/qualityPresets.ts:~41` (cascade/octave counts).
- Secondary (if kept procedural): halve octaves (Perlin 8→4, Worley 4→2), cascades 3→2,
  `MULTI_SCATTERING_OCTAVES`/`SHADOW_SAMPLE_COUNT` 8→4 — cheapens the bakes without prebaking.

**Validation.** Re-run the manifest capture (`shader-manifest.cjs`) with `?clouds=on` cold, before vs
after: the 4 noise-bake rows should disappear from the link budget. Eye-test that clouds look
identical (the prebaked noise is the same data, just not regenerated).

**Risk.** Low (prebaked noise == generated noise). The only cost is shipping the `.bin` assets.

---

## Lever B — The *next* draw-distance bottleneck is CPU, not shaders  *(highest value; already-open)*

**What.** After the light-pool fix removed the shader-link wall, the r10 (`pvsRingRadius=10`) stall's
**other half is CPU compute**, not GPU. From the continuous-profile measurements + existing notes, the
remaining cold-fill cost is:
1. **wasm geometry decode / subdivide** — was **33–58 %** of the busy CPU during the fill (manifest
   decode → mesh build → terrain subdivide), single-threaded.
2. **A 33 MiB *synchronous* terrain-atlas build** on the main thread.
3. **Un-budgeted boot terrain bakes** — the ring bakes terrain in big synchronous bursts rather than
   on a per-frame budget.

Net: even with `bakePrewarm` shipped (worst frame 57 s → 9.1 s, total stall −44 %), **r10 is still
~4.6 fps** — the leftover is this CPU work.

**Provenance — read these first (this is documented, don't re-derive):**
- `[[project_goal1_drawdistance_compute_bound_2026-06-22]]` — the definitive root-cause + the
  shipped streaming/prewarm items + the "still CPU-bound at 4.6 fps" finding.
- `[[project_holtburger_stutter_diag_2026-06-01]]` — names the two surviving costs and the fix
  direction: **"Web Worker atlas + frame-budget"** (move the 33 MiB atlas build off-thread; budget
  the boot terrain bakes to ≤1–2 per frame).
- `docs/PLAN-goal1-drawdistance-streaming-throttle-2026-06-22.md` — the streaming plan + empirical
  results.

**Approach (sketch — design properly against the above).**
- **Atlas → Web Worker**: build the 33 MiB terrain texture atlas off the main thread, transfer via
  `ImageBitmap`/`OffscreenCanvas` so the GPU upload is the only main-thread cost.
- **Frame-budget the bakes**: convert the synchronous ring-bake bursts into a per-frame budget
  (the `bake_prewarm.js` / `_guardedStreamBake` path already exists — extend it to cap work/frame).
- **wasm decode**: harder (single-thread wasm is the long pole, per memory). Options = a decode
  worker, or chunked/yielding decode. Measure first.

**Validation.** The established methodology (DON'T regress to it the hard way):
- **Fresh Chrome profile per arm** (a warmed profile makes arm 2 spuriously fast — burned 5 prior A/Bs).
- **Continuous whole-fill CPU profile + run-to-geometry-plateau (equalized work)** — NOT a 4 s
  phase-snapshot (it once reported a bogus "71 % catalog" artifact).
- Real 1070, headless. Target metric = time-to-bake-N-LBs + worst-frame ms + fps over the full fill.
- Harness: `/mnt/wbterminal1/tmp/claude-scratch/terrain-realism/goal1-probe.cjs`.

**Risk.** Medium-to-high effort (threading + transfer correctness), but **this is the real remaining
draw-distance win** — the highest-value of the three.

---

## Lever C — `logarithmicDepthBuffer` global  *(high-risk; last resort)*

**What.** `index.js:578` sets `logarithmicDepthBuffer: true` globally → `USE_LOGARITHMIC_DEPTH_BUFFER`
on **63/72 programs**. On D3D11/ANGLE this **exports `gl_FragDepth`**, which **disables early-Z / Hi-Z**
(a per-frame fill-rate cost on EVERY lit pixel) and adds a little to each shader's compile.

**Why it's parked.** It's **load-bearing**: the large draw distance needs the z-precision, and the
indoor-floor coplanar bias (`applyFloorDepthBias`, `materials.js:~383`) is written in log-depth space.
Removing it globally risks far-terrain z-fighting + indoor floor flicker. **Don't** flip it wholesale.

**Cheap sub-win (low-risk slice).** Scope log-depth **OFF** for passes where it's *inert*: the
orthographic shadow/depth pass (`MeshDepthMaterial` — ortho cameras get no precision benefit) and the
fullscreen post-process passes (they read depth, never write `gl_FragDepth`). That restores early-Z on
those without touching world z-precision. Small win, modest effort.

**Validation.** Real-GPU only (swiftshader can't show z-fighting). Eye-test far terrain + indoor floors
+ shadow acne/peter-panning before/after, on the 1070, batched.

**Risk.** Global removal = HIGH. The ortho/post scoping = LOW. Only the scoping is recommended.

---

## Shared invariants (apply to all three — don't relearn the hard way)

- **1070 tests headless / off-screen only** (`[[feedback_1070_tests_never_on_screen]]`); the app is
  served live by laptop `serve.py:8765` over a reverse tunnel to the 1070's `:18765` (re-establish
  with `ssh -fN -R 18765:127.0.0.1:8765 <user>@<gpu-box-ip>` if down — it serves the live working
  tree, so JS edits are live with no build).
- **Fresh Chrome profile per A/B arm; continuous full-fill profile; run-to-plateau** — the
  cache-disambiguation method that survived the shader work.
- **Every render change ships behind a `?flag` default-OFF until a BATCHED 1070 eye-test**, then flips
  default-ON with `=off` escape (`[[feedback_default_on_no_eyetest_gate]]`,
  `[[feedback_1070_eyetests_batched]]`).
- `scp` to/from the 1070 needs **forward slashes** in the Windows path.
- Capture-harness gotchas (this session): `window.liveScene3d` isn't assigned until **~35 s after**
  the `__sessionHandle` in-world gate (poll for it); **`predictedPlayerPos` is AC space**
  (x-east, y-north, z-up) → three.js world `(x, z, -y)` (raw use = camera 34 km up); freeze the
  camera by repurposing `cameraSwitcher.tick` as a re-lock.

## Priority

1. **Lever B** (CPU: atlas→worker + frame-budget bakes) — the real remaining draw-distance gain.
2. **Lever A** (clouds prebake) — do it the day clouds defaults on; ~33 s, low-risk, scaffolded.
3. **Lever C** (logDepth ortho/post scoping only) — small, low-risk; skip the global removal.

## If you want more

This was not a broad audit. A subsystem-wide perf sweep (per-frame `loop.js` hot path, draw-call /
instancing counts, the wasm boundary, the bake pipeline) would likely surface additional ranked wins
with evidence — a good fit for a multi-agent fan-out. Not done here.
