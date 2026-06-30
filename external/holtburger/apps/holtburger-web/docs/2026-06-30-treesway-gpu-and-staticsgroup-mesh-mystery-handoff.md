# Handoff — GPU tree-sway shipped + eye-test PASSED · cross-LB atlas is FINE (feedbug was a misread) · ~12k invisible staticsGroup meshes RESOLVED (RP6-culled bake-manager particles, NOT a leak) — 2026-06-30

## TL;DR
- **SHIPPED + pushed (`21c3ff74`, origin/master):** default-on **GPU instanced tree-sway** (`?treeWindGpu`, `deformation.windSwayGpu`, MECH-B vertex bend). Verified animating on the real GTX 1070 at ultra. No fps cliff (rides the frozen InstancedMesh frag-material patch; no de-instancing).
- **CORRECTION to the 2026-06-28 cross-LB-atlas "feedbug" handoff: there is NO atlas feedbug.** The atlas works; statics are fully batched. The "~6,136 unbatched singletons" was a **measurement artifact** — the count swept up thousands of unnamed non-static meshes.
- **OPEN MYSTERY (the real remaining issue):** `staticsGroup` accumulates **~9.7k–18k invisible, unnamed, no-`landblockId` `MeshBasic` meshes** during the boot-ring bake / LB streaming. They are **invisible → zero draw-call / zero fps cost**, but bloat the scene graph + heap. **They are NOT orphaned particle meshes** (proven below). True source still unidentified.
- **A particle-teardown fix was attempted and REVERTED** — verified ineffective on the 1070.

---

## ✅ RESOLVED (2026-06-30, evening — live diagnosis on the real GTX 1070)
**The "~12k invisible meshes" are NOT a leak and NOT unexplained. They are the RP6-CULLED active particle meshes of the *bake-side* static `ParticleManager`, owned and accounted for. §3's "NOT particles" conclusion was a measurement artifact from probing the WRONG facade.**

### How it was nailed (off-screen real-GPU chrome on the 1070, `account=tailnet1`, weather off, ultra)
1. **Lit boot-time `Object3D.prototype.add` source-trace** (wrapped via the staticsGroup prototype before the bake): **11,591 orphan adds, 100% from ONE stack** —
   `O3D.add ← ParticleEmitter.emitParticle (particle_emitter.js:305) ← updateParticles (:399) ← ParticleManager.tick (particle_manager.js:938) ← _spLoop (statics.js:3814)`, parent group = `"statics"`. So the wire-mode trace §3 *dismissed* was correct all along; the orphans ARE static particle meshes (`MeshBasic`, transparent, 6-vert quad, `__disposable` slot-clone, `visible:false`).
2. **The blind spot:** a BFS over `window.liveScene3d` finds **THREE** managers, and the orphans are owned by the one nobody was probing:

   | manager path | emitters | culled | storage meshes |
   |---|---|---|---|
   | `liveScene3d._staticParticleManager` (what §3 + earlier probes saw) | 24 | 21 | 334 |
   | `liveScene3d.entityManager._worldParticleManager` | 0 | 0 | 0 |
   | **`liveScene3d.cameraSwitcher.scene3d._staticParticleManager`** (the real bake manager) | **5,143** | **5,128** | **81,819** |

   `cameraSwitcher.scene3d` **IS** `scene3dForBuilders` — "a DIFFERENT object than the `window.liveScene3d` facade" (the exact footgun the statics.js:3786 comment warns about). Probing `window.liveScene3d._staticParticleManager` (24 emitters / 334 pool meshes) is why §3 saw "408 ≠ 11,850" and concluded "owned by neither manager."
3. **Membership test across ALL THREE managers' `parts[]`+`partStorage[]`:** of 20,264 invisible orphans, **`orphan_TRULY_unreferenced = 0`** — every single one is a live emitter's mesh. 5,128 / 5,143 bake emitters are RP6-culled (the freshly-baked Holtburg ring is mostly off-screen); the cull's "pure visibility flip — no reparent" (particle_manager.js:856-874) leaves their emitted meshes `visible:false` but parented to the shared `staticsGroup`. ⇒ thousands of invisible-but-owned meshes, **zero draw cost**, exactly as observed. Grows with bake/streaming because more ring LBs → more scripted-static emitters.

### What this means
- **No correctness leak. Do NOT re-attempt the destroyParticleEmitter/partStorage-removal fix** — it was correctly reverted (nothing is leaking).
- **Real cost = heap/scene-graph, not draw calls:** ~82k pre-allocated `THREE.Mesh` slot meshes (5,143 emitters × ~16 pool) + ~20k emitted-but-hidden, all in `staticsGroup`. If this bloat matters, the lever is **eager bake-ring emitter allocation**, not teardown: lazily create static emitters for near/on-screen LBs only, shrink pools while culled, or reparent culled emitters' meshes out of the graph (trading the reparent churn RP6 deliberately avoids). Tracking-only; not urgent.
- **Latent smell:** TWO static `ParticleManager`s tick the same `staticsGroup` (the 24-emitter `liveScene3d` one + the 5,143-emitter `scene3dForBuilders` one). `_ensureStaticParticleManager` keys idempotency on the per-facade `scene3d._staticParticleManager`, so each facade that reaches it spins its own manager. Harmless today (both target the same group) but worth collapsing to one.

### Tree-sway eye-test — PASSED (the §1 "STILL OWED" item)
Real GTX 1070, `quality=ultra`, weather off, `treeWindStrength=1.5`: 40 materials carry `deformation.windSwayGpu`; boots clean default-on. Frame-diff over 2.5 s isolates motion to the **treeline band only** (1.02% changed) — buildings/terrain/avatar static (0.00–0.03%); the amplified diff heatmap traces individual tree silhouettes swaying. Natural amplitude, no thrash, no slivers, no fps regression. **Amplitude/freq signed off at defaults × 1.5.** (Diagnostic artifacts: `scratchpad/{addtrace,probe,probe2,probe_all,drive3}.json`, `dry_*.png`, `sway_diff_0v5.png`.)

---

## 1. SHIPPED: GPU tree-sway (`?treeWindGpu`, default-ON)
Commit `21c3ff74` on `origin/master`. Files:
- `scene3d/vfx/components/windSwayGpu.js` (NEW) — MECH-B vertex component, modeled on `tipFlex`. Height-weighted horizontal shear in **object space (AC Z-up; `transformed.z` = height)**, base-anchored (trunk planted), per-instance phase via the slice-03 `vVfxHash` varying, driven by the shared `VFX_GLOBALS.uTime`. **Config-invariant GLSL → ONE program. Model-invariant** (no per-model height uniform → one shared surface-keyed material clone is correct for a 1.25 m fern AND a 22 m tree).
- `scene3d/tree_wind.js` — `windSwayGpuEnabled()` (default-on; `?treeWindGpu=off` escape; stands down under `?treeWind`/`?windGeo`).
- `scene3d/vfx_catalog.js` — `COMPONENT_MECH["deformation.windSwayGpu"]="B"`.
- `scene3d/vfx/components/index.js` — barrel export + `TIER1_COMPONENT_IDS` (legacy-safety audit asserts exact-equality, so it MUST be listed).
- `scene3d/vfx/frag_attach.js` — injects the component for every `windResponds()` DID (the exact selector the old default-on peel used), so no catalog re-bake.
- `scene3d/statics.js` — `await ensureVfxCatalog()` in the default path so the frag seam resolves descriptors.
- `docs/url-flags.md` — documented.

**Why it's cheap:** the OLD `deformation.windBend` (MECH-A) peeled ~4096 trees into ~17k CPU meshes (1 fps on the 1070 — commit `968139a4` flipped it default-off). `windSwayGpu` keeps trees in the frozen InstancedMesh and bends them in the vertex shader on the shared material clone (same install path as `tipFlex`; `frag_install.PATCH_MECHS` includes `"B"`).

**Verified on the 1070 (lit, `quality=ultra`):** renderer `ANGLE (NVIDIA GeForce GTX 1070 … Direct3D11)`; **40 tree materials** carry the `windSwayGpu` `__vfxSetKey`; the VFX clock advances real-time → trees animate.

**STILL OWED:** the batched 1070 *eye-test* for amplitude/frequency sign-off (defaults `baseAmp 0.03 / freqHz 0.15 / flutter 0.3`, scaled by `?treeWindStrength`, default 1; tested at 1.5). "treesway" and "treebend" are the same effect (the bend IS the sway). The MECH-A keyframe `windBend` stays default-off (slow path).

---

## 2. CORRECTION: the cross-LB atlas is NOT broken
The 2026-06-28 `cross-lb-atlas-feedbug-handoff.md` reported the atlas under-delivers (~115 atlased, ~6,136 unbatched). **That was a measurement artifact.** Measured on the 1070 (lit, ultra, Holtburg):
- Statics fully batched: **232 InstancedMeshes + 21 cross-LB atlas batches + ~115–232 named static singletons** (`static-<lb>_…`, carry `userData.landblockId`).
- There are only **~115 real static singletons** (the atlas's entire workload) — and the atlas batches **all** of them. `addSingletonsToCrossLbAtlas` returns **0 passthrough** for everything it's handed; the feed mechanism is correct.
- The "unbatched singletons" both the handoff's `q.mjs` and my early runs counted were the unnamed non-static meshes in §3 — never static scenery.

**Action:** no atlas fix needed. Treat the 2026-06-28 feedbug as resolved-by-reclassification.

---

## 3. OPEN MYSTERY: ~12k invisible unnamed meshes in `staticsGroup`
### What's known (measured on the real GTX 1070, lit, ultra, Holtburg)
- Count: **9,735 → 18,399** depending on session (grows during LB streaming; stable when stationary).
- Each: `isMesh`, **no `userData.landblockId`, no `name`**, `MeshBasicMaterial`, `transparent`, **6-vertex quad** (in wire mode), own cloned material. `userData` keys `_cullSphere`/`_lightScanCount`/`_ownsLight` are **per-frame cull/light caches `statics.js` stamps on ALL `staticsGroup` children** — NOT identifying.
- **`visible: 0` — none are drawn. Zero draw calls. Zero fps cost.** (Confirmed; `?visual=off` and matrix-freeze gave ~0 fps change in the 2026-06-27 sprint too.) The cost is scene-graph traversal (matrix/cull each frame) + heap/GPU memory.
- They appear **during the boot-ring bake** (0 at `bootState` in-world / T+25s → ~11.8k by T+85s as Holtburg bakes) and grow with movement/streaming.

### Why they are NOT orphaned particle meshes (this disproves my earlier claim)
Two `ParticleManager`s exist:
- `_staticParticleManager` (scene = `staticsGroup`): **`nextEmitterId=25` → 24 emitters EVER created**, 24 alive, **334 pool meshes**, 2 destroyed-ish.
- `_worldParticleManager` (scene = `entitiesGroup`): `nextEmitterId=10` → 9 created, 7 alive, 74 pool meshes.
- **33 emitters total, ~408 pool meshes** — but **11,850 orphans owned by NEITHER manager's `partStorage`.** 408 ≠ 11,850. So they did not come from the particle managers.
- A **wire-mode** `staticsGroup.add` source-trace attributed adds to `ParticleEmitter.emitParticle <- ParticleManager.tick`, but the **lit-mode emitter accounting contradicts that** — so the wire trace likely caught only the steady-state churn (live trace: `emitParticle` +635 ≈ `killParticle` −633 over 20 s, net ~0), NOT the ~11.8k bulk. There is a non-emitter (or hidden-manager) add path I did not find.

### The fix that FAILED (reverted — do not retry as-is)
Hypothesis: `destroyParticleEmitter` (particle_manager.js ~983) and the tick auto-finish (~946) remove only the **active `e.parts`** subset from the scene; the `partStorage` loop disposes materials but never removes the meshes → orphans on teardown. Added `if (slotMesh.parent) slotMesh.parent.remove(slotMesh)` to both loops.
- **Verified ineffective on the 1070**: with the fix served (`Cache-Control: no-cache`, both markers confirmed in the served file), orphans still grew 0 → 11,851. **Reverted.** Root cause is NOT emitter teardown (only ~2 emitters were ever destroyed all session).

### Decisive next diagnostic (for a clean, no-contention session)
1. **Lit boot-time `staticsGroup.add` source trace with FULL stacks**, capturing from page-load through the entire boot-ring bake (wrap `liveScene3d.staticsGroup.add` the instant it exists). My attempt failed only because the boot errored on account contention (see §4) — the init-script wrap never fired. This will name the exact code path that adds the ~11.8k meshes.
2. **Deep-probe the LIT orphans' identity** (geometry `position.count`, `geometry.type`, material, full own-prop keys) — I only deep-probed them in WIRE mode. Confirm in lit; look for a back-reference to their creator.
3. Candidate creators to check: the boot-ring bake's billboard/sprite path, default-script (`CallPES`) particles, or a sprite pool — anything that adds 2-triangle quads to `staticsGroup` *not* via `ParticleManager`.

### Code map
- `particle_manager.js`: class ~523; `addEmitter` ~623 (fresh `new ParticleEmitter` per call, `scene: this._scene`, `meshFactory` per-slot, line ~720); `tick`+auto-finish `removeIds` ~946; `destroyParticleEmitter` ~983. `nextEmitterId` ~531/806.
- `particle_emitter.js`: `setInfo` ~196 (creates `partStorage[i]=meshFactory(i)`, invisible, **unparented**); `emitParticle` ~295 (`_scene.add` since static manager passes no `onMeshActive`); `killParticle` ~228 (**`_scene.remove` only when `mesh.parent === this._scene`** — a re-parented mesh slips this guard; then `visible=false`, `parts[i]=null`).
- `owner_registry.js`: `destroyAllForOwner` (302) → `manager.destroyParticleEmitter`. `_evictStaticParticlesForLb` (statics.js:3731) → `ownerRegistry.destroyAllForOwner`.
- Managers: `statics.js:3330` (static, scene=staticsGroup); `entities.js:9272` (world, scene=`entitiesGroup ?? rig?.parent ?? null`).

---

## 4. Operational learnings — driving the 1070 ON-SCREEN (real GPU)
- Launch on the **interactive session** via `schtasks /it` (SSH-launched chrome = session-0, no GL). Batch file must use **`[char]34`** for quotes (PowerShell) — **`Chr(34)` is VBScript and silently writes an empty batch**.
- A **fresh `--user-data-dir` profile opens `chrome://intro/` and swallows the launch URL** → add `--no-first-run --no-default-browser-check`, or navigate via CDP after launch.
- Real-GPU flags: `--remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --user-data-dir=C:\Temp\cdpwb-<tag> --new-window --start-maximized "<url>"`. Confirmed `UNMASKED_RENDERER = ANGLE (NVIDIA … GTX 1070 … Direct3D11)`.
- The 1070 reaches the laptop's serve.py + bridge **directly over tailscale** (laptop tailscale IP **100.116.47.66**): `http://100.116.47.66:8765/...?...&bridge_url=ws://100.116.47.66:8080/&server_host=127.0.0.1&server_port=9000`. ACE = UDP 9000 (won't show in `ss -ltn`); bridge = `holtburger-wsbridge --listen 0.0.0.0:8080`.
- CDP from laptop: tunnel `ssh -fN -L 9445:127.0.0.1:9333 young@<1070>` (laptop **9333 is taken by the local chrome-devtools-mcp chrome** → use 9445). `connectOverCDP('http://127.0.0.1:9445')`. **NEVER `browser.close()`** (kills the on-screen window) — just disconnect / `process.exit`.
- **`tailnet1` is SINGLE-LOGIN.** Reload races ACE's ~25 s in-world grace → `bootState: 'error'`. Disconnect (`about:blank`) + wait ~32 s before reconnect. Repeated reloads = repeated boot errors (and may boot a human who's also on `tailnet1`). This flakiness is why the live diagnosis stalled.
- **Teleport to Holtburg:** the boot ring is hardcoded to Holtburg (`bakeStaticsRing(…, HOLTBURG_X, HOLTBURG_Y, …)`), so it bakes regardless of spawn. The avatar spawns at its saved loc; `@telepoi Holtburg` via chat is a Developer-4 command that didn't move the avatar cleanly here, and `#teleport-button` is hidden outside the academy. The town renders anyway because the ring is at Holtburg.
- **Detecting a human on the box (Windows Home — no `quser`/`qwinsta`):** check `Get-Process RobloxPlayerBeta` + per-process GPU (`Get-Counter "\GPU Engine(*)\Utilization Percentage"`). Roblox does **not** expose a `MainWindowTitle`, so "no visible windows" ≠ idle — chase the GPU number. (I missed this once: 36% GPU "background" was actually a live Roblox session.)
- **Cleanup:** kill test chrome by user-data-dir match — `Get-CimInstance Win32_Process | ? CommandLine -like '*cdpwb-<tag>*' | %{ Stop-Process $_.ProcessId -Force }`. NEVER `taskkill /IM chrome.exe`. Delete the `schtasks` task + the `.bat`. Kill the laptop tunnel with the bracket trick (`ps … | grep '[9]445…'`) to avoid self-kill.

---

## 5. Status of the live box at handoff time
Everything I started is torn down: 1070 test chrome closed (0 chrome procs), `holtrun` task + `launch-holt.bat` removed, laptop CDP tunnel killed, **Roblox left running and untouched**. Repo working tree clean (particle fix reverted; `treeWindGpu` committed + pushed).
