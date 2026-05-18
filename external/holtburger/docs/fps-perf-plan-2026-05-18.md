# FPS Perf Plan — emit-dynamic-site 3D renderer (2026-05-18)

Multi-agent execution plan for the FPS audit findings. Scope is `apps/holtburger-web/scene3d/` + `apps/holtburger-web/plugins/` + `apps/holtburger-web/ui/`. **Sky / moons / clouds / atmosphere / aurora are explicitly out of scope** (already perf-reviewed): do not modify `atmosphere_*.js`, `sky_*.js`, `cloud_*.js`, `sun_direction.js`, `ac_moons.js`, `aurora.js`, `daygroup_weather.js`, `weather_state.js`.

Target: 60 FPS on GTX 1070 at Holtburg load (~16,700 statics, ~104 academy spawns, 568 EnvCells indoors). Cross-validated on R9 290 where available.

## Conventions for picking up a task

1. One PR per workstream task (e.g. `B1`, `D2`). Branch: `perf/<id>-<slug>`. Reference this doc + task id in the commit body.
2. Each task lists: **Severity • File:line • Problem • Fix • Acceptance • Risk**. Don't broaden scope; one fix per PR.
3. Validate with the appropriate `capture_*.cjs` smoke (see Acceptance per task). Run on the GTX 1070 host where possible; report frametime delta or DOM/alloc counter delta with the PR.
4. Memory-leak items (B3, C5, E3, A4) require a 30-minute soak test or scripted spawn/despawn loop to validate. A single-frame smoke is insufficient.
5. Don't touch a file in two parallel PRs. The parallelism matrix below is the source of truth for what can run concurrently.

## Parallelism matrix

| Workstream | Files touched | Can run in parallel with |
|---|---|---|
| A — Renderer init + loop | `index.js`, `loop.js`, `_ric_shim.js`, `quality.js` | B, C, D, E, F |
| B — Entities + animation + dispose | `entities.js`, `animation.js`, `spawns.js`, `nameplate_sprite.js` | A, C, D, E, F |
| C — Cells + statics + buildings + CSM + lighting | `cells.js`, `statics.js`, `buildings.js`, `csm.js`, `lighting.js` | A, B, D (mostly), E, F |
| D — Terrain + materials shaders | `terrain.js`, `materials.js` | A, B, C (avoid C2/C3 simultaneous edits to `statics.js`/`buildings.js` shadow flags), E, F |
| E — Particles | `scene3d/particles/*` | A, B, C, D, F |
| F — UI plugins + HUD + picking | `plugins/*`, `ui/bar.js`, `hud.js`, `picking.js` | A, B, C, D, E |

`materials.js` is touched only by D6 (POM gate) and C overlap is minimal. If a conflict arises, D takes priority.

## Lessons & conventions from waves 1–5

The first 21 audit findings shipped across 5 parallel-agent waves. Remaining tasks should benefit from what we learned:

### Verification: `import()`, not just `node --check`

`node --check` only checks for top-level parse errors. It silently accepts template-literal closure bugs (the D3 wave shipped a shader-comment with backticks inside a `` `...` `` template, which silently terminated the literal — `--check` passed, real ESM `import()` failed). **Every PR's verification step must use the actual import form**:

```bash
cd .../holtburger-web && node -e "import('./PATH/FILE.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

`OK` = full import succeeded. `OK (parse ok)` = file parsed but couldn't resolve a node-side dep like `three` (expected for any file that imports `three`). `FAIL: ...` = real syntax/structure error to fix.

### Module-scratch naming convention

Per-file module-scope scratches use the `_scratchX` underscore prefix. Read-only sentinels (e.g. identity quaternions) use `_SCREAMING_CASE` with a `// READ-ONLY` comment. No exports.

**Existing scratches across the codebase** — don't collide:

| File | Scratch | Owner task |
|---|---|---|
| `scene3d/loop.js` | `_velScratch`, `_modelChangesScratch`, `_textureChangesScratch`, `_subPalettesScratch`, `_emptyU32` | A2, A6 |
| `scene3d/entities.js` | `_tickGateScratch`, `_IDENTITY_QUAT`, `_particleAttachScratchVec3`, `_particleAttachScratchQuat`, `_nameToGuid` | B1, B2, B4 |
| `scene3d/particles/particle.js` | `_scratchEuler`, `_scratchQuat` | E1 |
| `scene3d/particles/particle_emitter.js` | `_scratchVec3`, `_offsetScratch`, `_aScratch`, `_bScratch`, `_cScratch`, `_e6WarnedEmitterIds`, `_E6_FALLBACK_CAP` | E2, E4, E6 |
| `scene3d/particles/particle_emitter_info.js` | `_offsetR`, `_offsetProj` | E2 |
| `scene3d/csm.js` | `csmState._lastCamX/Y/Z`, `_lastSunX/Y/Z` | C4 |
| `scene3d/lighting.js` | `scene3d._lightSortFrameCounter`, `_lightSortLastFrame`, `_lightSortLastCount` | C6 |
| `plugins/combat-bar.js` | `_powerSyncRafId`, `_feedSlots`, `_feedRingHead`, `_feedFilled` (and F2's rAF closure) | F1, F2, F5 |

### Bail responsibly

If an agent uncovers an architectural blocker mid-implementation, **stop and document** rather than ship an unsafe pool / refactor / etc. The C7 (`lighting.js`) wave correctly bailed when it realised pooling lights breaks three.js's one-parent rule. Reasoned bails go in the **Status** line with a "what needs to change first" note + file:line evidence.

### Caller-retention audit (load-bearing for any pooling work)

Before pooling an object, grep all callers of the function returning it. Classify each call site:

- Result is `.copy()`'d into a persistent slot → pooling SAFE.
- Result is stored as `obj.field = result;` (retained by reference) → pooling UNSAFE. Skip that allocation OR change the API so the caller passes a destination.
- Result is scalar-only-read (`.x`, `.length()`, etc.) → pooling SAFE.

B2 documented an example: the slerpQuaternions result is retained via `inst.airborneTilt`, so that specific allocation was deliberately NOT pooled.

### The `__disposable` material/geometry tag convention

Tasks B3, C5, and E3 all need disposal of cloned materials. To avoid disposing shared cache references (which crashes future renders), the convention is:

```js
// At every `material.clone()` site outside the cache:
const matClone = baseMaterial.clone();
matClone.userData.__disposable = true;

// At the dispose site:
function _disposeMaterialIfOwned(mat) {
  if (mat?.userData?.__disposable === true) mat.dispose();
}
```

`MaterialCache.get(did)` never tags its returned materials — those are cache-owned and the dispose helper skips them. **B3 owns the convention's first introduction; C5 and E3 build on it.** Do not rename `__disposable` without coordinating all three.

### Scope discipline

One PR per task. Don't bundle "while I'm in this file, let me also fix that other thing." If an agent uncovers a parallel issue, leave a `TODO(<task-id>):` breadcrumb and surface the new finding here.

## Suggested critical path (fastest visible wins)

Pick these first in order — they're high-impact and low-risk:

1. **A1** — gate `antialias` on quality preset.
2. **B1** — frustum/distance-gate `entities.tick()`.
3. **A4** — prune `__lastEntityWorldPos` on despawn (prevents long-session degradation).
4. **B3 / C5 / E3** — dispose chains for entity rigs, building materials, particle materials.
5. **C1 / C2** — cell mesh fusion + statics `receiveShadow` gate (structural, biggest single Holtburg win but largest blast radius).

The rest can run in parallel waves.

---

# Workstream A — Renderer init + main loop

## A1 — Gate antialias on quality preset
**Severity** High • **File** `scene3d/index.js:199` • **Status** ✅ Done (commit `f45dd3c`)

**Problem.** `new THREE.WebGLRenderer({ canvas, antialias: true })` forces MSAA unconditionally. On a GTX 1070 at 1080p, MSAA 4× adds ~4–6 ms / frame (≈25%).

**Fix.** Read `quality.flags.antialias` (add the flag if not yet in the preset table) and pass it to the WebGLRenderer constructor. Default: `off` at `low`, `on` at `mid`/`high`.

**Acceptance.** Frametime drops 3–6 ms when launched with `?quality=low`. Existing `mid`/`high` captures unchanged (visual diff against `screenshots/` baseline).

**Risk.** Visible aliasing at `low` — that's the intended trade.

## A2 — Pool position / velocity event objects
**Severity** High • **File** `scene3d/loop.js:701-731` • **Status** ✅ Done (commit `966d71f`)

**Problem.** Every `KIND_POSITION` allocates `{x,y,z,ts}`; every `KIND_VELOCITY` allocates `{guid,vx,vy,vz,omegaZ}`. With 50+ moving entities this is sustained GC pressure.

**Fix.** Pre-allocate two pools (positions, velocities) indexed by guid; reuse and overwrite in place. The downstream consumer (`__lastEntityWorldPos`) must be updated to read from the pooled slot, not retain a reference.

**Acceptance.** Chrome devtools Performance recording shows a flatter "GC" lane across a 10-second walk. Alloc rate from `entities-events` drops to near-zero steady state.

**Risk.** Any downstream code that captured the old object literal by reference will break — grep for `__lastEntityWorldPos` and `KIND_POSITION` consumers first.

## A3 — Add dt-recovery lerp after tab unfocus
**Severity** Med • **File** `scene3d/index.js:820-825` • **Status** ✅ Done (commit `936d54d` — "skip simulation" rather than ramp; 0.5 s trigger, 10-frame recovery)

**Problem.** `dt = Math.min((ts - lastFrameTs)/1000, 0.1)` caps at 100 ms but applies that full 100 ms instantly on the first post-unfocus frame, producing a visible snap.

**Fix.** After a `dt > 0.1` clamp event, mark "recovering" and ease dt back toward real frame time over the next ~10 frames; skip physics/animation tween during recovery.

**Acceptance.** Alt-tab away for 5 s, alt-tab back: camera + entities resume smoothly, no teleport.

**Risk.** Low — pure rendering-side smoothing.

## A4 — Prune `__lastEntityWorldPos` on despawn
**Severity** High (long-session) • **File** `scene3d/loop.js:702` • **Status** ✅ Done (commit `56879f3`)

**Problem.** Map grows on every `KIND_POSITION` but no `KIND_REMOVE` handler deletes entries. Hours of NPC churn = unbounded growth.

**Fix.** Add `__lastEntityWorldPos.delete(guid)` in the despawn / `KIND_REMOVE` branch. Optionally switch to a WeakMap keyed by entity ref (preferable if entity refs are stable).

**Acceptance.** Spawn-and-despawn loop (200 NPCs × 50 cycles) shows `__lastEntityWorldPos.size` returning to baseline.

**Risk.** None.

## A5 — Detect GPU tier in quality preset selection
**Severity** Med • **File** `scene3d/quality.js` (probe added) • **Status** Open

**Problem.** `getQuality()` resolves the preset from URL + UA only — same `mid` default for a GTX 1050 (2.5 TF) and an RTX 4090 (165 TF). Mobile UA gets the `low` downshift; weak desktop GPUs do not. `WEBGL_debug_renderer_info` exposes a renderer string usable for coarse tier classification.

**Briefing.**

Recent quality.js commits to read fresh:
- A1 (`f45dd3c`) added `antialias` flag + localStorage merge path.
- D2 (`fede972`) added `pomStepsPrimary` / `pomStepsSelfShadow` int flags.
- D3 (`8664218`) added `triplanarSlopeThresholdPct` int flag.
- E6 (`805b9ab`) added `maxParticlesPerEmitter` int flag.

**Implementation gotcha:** at the time `installQualityOnWindow(getQuality())` runs in `scene3d/index.js` (line ~122), the `WebGLRenderer` has NOT been created yet. A WebGL context is required to query `WEBGL_debug_renderer_info`. Two safe paths:

- **Path 1 — throwaway probe canvas:** create a 1×1 `<canvas>` in `quality.js`'s `detectGpuTier()` helper, get `webgl` context, query, destroy. Cost: ~5 ms of init time. Single source of truth.
- **Path 2 — defer the resolution:** resolve URL+UA at module load as today, then expose a `refineWithGpuInfo(quality, gl)` helper that `index.js` calls AFTER `new THREE.WebGLRenderer(...)`. If the probe lands on a different tier and the source is `"default"`, mutate `window.__quality.preset` + show a reload-style banner.

**Pick Path 1.** Path 2 leaves a brief "wrong preset" window between init and refinement.

**Classification heuristics** (apply in order — longest match first, most-specific first):

```
HIGH allowlist:
  /RTX 30\d\d|RTX 40\d\d|RTX 20[678]0|RX 7[890]\d\d|RX 6[89]\d\d|M[1-4]( Pro| Max| Ultra)?|Apple GPU|Radeon Pro/i

LOW deny-list:
  /Mali|Adreno [0-5]\d\d|PowerVR SGX|Intel\(R\) (HD|UHD|Iris Plus)|Intel\(R\) Atom|Tegra/i

MID = everything else (safe default for unrecognized GPUs)
```

**Critical rules:**
- DO NOT auto-promote to `ultra` — that's a deliberate opt-in tier; users pass `?quality=ultra` explicitly.
- URL + localStorage still win over the probe (existing merge order in `getQuality`).
- The probe is the new default-resolver, slotted BETWEEN localStorage and mobile-UA in the precedence chain.
- Source label: `"gpu-probe"` (new value). Add to `installQualityOnWindow`'s logged values + the source enum in `docs/quality-presets.md`.

**Caveats:**
- Some browsers (notably Firefox with privacy.resistFingerprinting) strip the renderer string and return `"Mozilla"` / `"WebGL Generic"` / similar. Treat unrecognised strings as "probe failed; abstain to existing default".
- The probe canvas MUST be destroyed (`canvas.remove()` after the probe + null out the context reference) so the throwaway WebGL context doesn't sit in the page's WebGL-context budget (browsers cap to ~16 live contexts).
- If `WEBGL_debug_renderer_info` is unavailable (`gl.getExtension('WEBGL_debug_renderer_info')` returns null), abstain.

**Acceptance.** On a tested low-tier device (Intel UHD 620), default lands at `low` without URL override. On a tested high-tier device (RTX 3060+), default lands at `high`. On Firefox-strict (renderer string masked), source falls through to `"default"` (=`mid`). Across all hosts, source is one of `"url"|"localstorage"|"gpu-probe"|"mobile-default"|"default"`.

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/quality.js').then(({getQuality}) => { const q = getQuality('http://x/?'); console.log(q); })"
```

The probe path is browser-only; the Node smoke just verifies parse + URL/UA fallback survives the changes.

**Risk.**
- Brittle substring matching. Ship a small allowlist for HIGH, a larger deny-list for LOW, default to MID. Errs toward over-trusting MID, the safest "unknown GPU" tier.
- Throwaway-context budget — destroy explicitly.

**Cross-refs.** Builds on `getQuality()`'s existing merge order. Surface `?quality=auto-disable=1` URL escape hatch to skip the probe if it causes site-wide breakage in the wild.

## A6 — Batch `Uint32Array.from` allocations during burst spawn
**Severity** Med • **File** `scene3d/loop.js:468-517` (`toMeta`) • **Status** ✅ Done (commit `703f4fb` — slice-on-return mandatory because EntityInstance retains `meta`; empty-array sentinel `_emptyU32` shared)

**Problem.** Three `Uint32Array.from(...)` calls per spawn × N batched spawns = stall during PVS expansion.

**Fix.** Reuse a per-spawn scratch `Uint32Array` of generous size; copy/slice into per-entity storage only at the point of retention.

**Acceptance.** PVS-expansion capture (200 simultaneous spawns) frametime drop ≥ 1 ms during the burst.

**Risk.** Low; ensure no reader retains a reference to the scratch buffer.

## A7 — `_ric_shim.js` time-remaining sanity check
**Severity** Low • **File** `scene3d/_ric_shim.js:54-65` • **Status** Open

**Problem.** The shim provides a microtask-driven fallback for `window.requestIdleCallback` so takram's atmosphere precompute can yield work across frames. It currently advertises a 50 ms time budget per microtask callback. Under host load (Discord screen-share, OBS, VS Code, etc.) actual main-thread idle time is more like 5–10 ms. The takram generator's inner loop checks `deadline.timeRemaining()`, sees 50 ms remaining, runs heavy work, overshoots — produces visible main-thread tasks > 100 ms.

**Briefing.**

Read fresh — the shim's header comment explains why it exists (takram snapshots `requestIdleCallback` at module-load; without the shim the bake hangs in-game because the busy render loop never goes idle and the snapshotted rIC never fires). Don't break that contract.

Steps:

1. At the top of the shim's microtask handler, capture `const microtaskStart = performance.now()`.
2. Pass a `deadline` object with `timeRemaining()` and `didTimeout` to the user callback. Implement `timeRemaining()` as:
   ```js
   const ACTUAL_BUDGET_MS = 30; // conservative; see comment block
   timeRemaining: () => Math.max(0, ACTUAL_BUDGET_MS - (performance.now() - microtaskStart))
   ```
   Reduces advertised budget from 50 ms to 30 ms. The takram loop checks this multiple times per iteration and yields when the budget runs out.
3. Track actual elapsed at end-of-callback (after the user's loop returns). Stash on `window.__ricShimLastBudgetMs` for devtools inspection. This lets users + the FPS validator see whether the shim was overrunning its budget.
4. If `actualElapsed > 50 ms` was observed, log a one-time `console.warn` (rate-limit to once per page load) so dev sessions notice host-load stalls.

Don't change the chaining/scheduling logic. The shim still re-schedules itself via `Promise.resolve().then(...)` (or whatever the existing pattern is). Read the current loop body before touching.

**Acceptance.** Run the atmosphere bake with `--cpu-throttling-rate=4` in Chrome devtools. In the Performance pane: no main-thread tasks > 100 ms during the bake. Without the change, with the throttle, you'll see 200–400 ms tasks. (Without the throttle on a 1070, the bake completes in ~8 s within normal frame budgets.)

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/_ric_shim.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

**Risk.** The shim is upstream of the entire atmosphere stack (Sky-K series). A regression breaks the visible sky during init. Smoke test: load the page with `?renderer=3d` and confirm sky + clouds render after ~8–15 s on a 1070. If the atmosphere bake produces visible artifacts (missing tables / black sky), the shim regressed.

**Cross-refs.** Independent of all other open tasks. Sky team owns the consumer; coordinate before landing if mid-flight Sky work is in-flight.

---

# Workstream B — Entities + animation + dispose

## B1 — Frustum + distance gate on `entities.tick()`
**Severity** High • **File** `scene3d/entities.js:2005-2083` • **Status** ✅ Done (commit `8d71b7f` — distance-only MVP; frustum cull is the follow-on)

**Problem.** `for (const e of this.entityMap.values())` updates mixers, hooks, tweens for every entity regardless of camera visibility or distance. Academy has 104 spawns; typically ~20 are in PVS + frustum.

**Fix.** For each entity, compute `inFrustum && distSq < maxTickDistSq`; skip mixer/hook/tween update otherwise. **Exceptions** (must keep ticking even when off-screen): the local player, anyone targeted, anyone with an active swing/spell-effect hook, and anyone whose AI animation drives a one-shot networked event. Add a small "force tick" set.

**Acceptance.** Academy idle frametime drops by 2–4 ms with no visible animation pop when entities re-enter frustum.

**Risk.** Animation snap on re-entry — mitigate by carrying mixer time forward via `dt` accumulation, or accept the snap if visually unnoticeable.

## B2 — Reuse Quat/Euler/Vec3 scratches in jump tween + particle attach
**Severity** High • **File** `scene3d/entities.js:1297-1304` (jump tween), `1758-1768` (particle attach hook) • **Status** ✅ Done (commit `8466e59` — refused to pool `slerpQuaternions` result because it's retained via `inst.airborneTilt`; particle-attach scratch has narrow async race noted inline)

**Problem.** `new Quaternion()` × 2 per airborne generic-rig per frame, plus `new Vector3()` + `new Quaternion()` per particle hook fire.

**Fix.** Module-level `const _scratchQuatA = new Quaternion()`, `_scratchQuatB`, `_scratchVec3`, `_identityQuat = new Quaternion()`. Replace in-place. Document that callers may not retain references.

**Acceptance.** Heap profile during a "20 entities jump simultaneously" smoke shows the entity-tick alloc lane go flat.

**Risk.** Caller-retention bug — search for any code that captures the result of the affected functions by reference.

## B3 — Complete `Entity.dispose()` to release child Geometry/Material
**Severity** High (long-session) • **File** `scene3d/entities.js:390-410` • **Status** Open — **DO THIS FIRST** (load-bearing for C5 + E3)

**Problem.** `Entity.dispose()` removes the rig's root group from the scene but doesn't traverse children to call `.dispose()` on geometries + materials. Over a long session of NPC spawn/despawn the page accumulates orphan geometries and materials in WebGL — `renderer.info.memory.geometries` and `.textures` grow monotonically. After ~30 minutes of populated-zone play this manifests as GPU memory pressure, then driver-side stalls.

**Briefing.**

This task **defines the shared `__disposable` material/geometry-tag convention** used by C5 + E3. Land B3 first; let it sit for a few days of soak before C5/E3 take their swings. See "The `__disposable` material/geometry tag convention" in the Lessons section above.

Recent commits in entities.js to be aware of (read fresh):
- B1 (`8d71b7f`) added `_tickGateScratch` module scratch and `_shouldTickEntity` distance gate.
- B2 (`8466e59`) added `_IDENTITY_QUAT`, `_particleAttachScratchVec3`, `_particleAttachScratchQuat`.
- B4 (`b0469a4`) added `_nameToGuid` Map maintained at spawn/remove.

**Step-by-step.**

1. Add `_disposeMaterialIfOwned` and `_disposeMeshChildren` helpers at module scope (near B1/B2 scratches):
   ```js
   function _disposeMaterialIfOwned(mat) {
     if (!mat) return;
     if (mat.userData && mat.userData.__disposable === true) {
       mat.dispose();
     }
     // else: cache-owned, do nothing
   }

   function _disposeMeshChildren(root) {
     if (!root) return;
     root.traverse((obj) => {
       if (!obj.isMesh) return;
       obj.geometry?.dispose();
       if (Array.isArray(obj.material)) {
         obj.material.forEach(_disposeMaterialIfOwned);
       } else {
         _disposeMaterialIfOwned(obj.material);
       }
     });
   }
   ```

2. In `Entity.dispose()` (line ~390), call `_disposeMeshChildren(this.root)` BEFORE the existing `this.root.parent?.remove(this.root)`. Order matters: while the root is still attached, the traverse path is intact.

3. **Audit the spawn/build path for material clones.** Search entities.js for every `material.clone()` and `geometry.clone()`. For each `material.clone()`:
   - If the result is going onto a Mesh that's part of an entity rig (likely): tag with `userData.__disposable = true`.
   - If it's a one-off (e.g. debug visualization): also tag, since dispose should clean it up.

4. Find every place `MaterialCache.get(...)` is called and ensure the returned material is NOT tagged disposable. Cache materials live for the page's lifetime; we never dispose them. **Belt-and-braces:** have `MaterialCache.get()` set `userData.__cacheOwned = true` and assert `!userData.__cacheOwned` inside `_disposeMaterialIfOwned`. This catches a missing-`__disposable` bug at runtime instead of producing a silent crash on next render.

5. Audit `geometry.clone()` and `new BufferGeometry()` similarly. Per-entity geometries always belong to the entity and are safe to dispose at entity-dispose time.

**Cross-cutting audit (REQUIRED before shipping):**

- Search ALL files (not just entities.js) for `material.clone()` and `geometry.clone()` to make sure nothing OUTSIDE entities.js puts a non-disposable Material onto an entity rig. If buildings.js does this (it might — buildings have per-placement Groups), the building dispose path (C5) must handle the same tag.
- Search for any code that reads from `inst.root` and PASSES the materials back to a cache. Currently no such path is known to exist, but verify.

**Acceptance.** Run a 200-NPC spawn/despawn loop (50 cycles). `renderer.info.memory.geometries` and `.textures` return to within 5% of baseline after the loop. Without this fix, both grow monotonically by ~50/cycle.

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/entities.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

Plus a 30-minute populated-zone soak (run `capture_audio_heap.cjs` or similar long-runner) and verify `renderer.info.memory` stays flat.

**Risk.** **HIGH.** Disposing a shared cache material crashes future renders (the GPU resource is freed but the JS object still references it). If the audit misses any spawn/build site that puts a cached material onto an entity rig, that material gets disposed on first entity dispose and breaks every other entity / building / static that shares it. **Mitigation:** the `__cacheOwned` assertion in `_disposeMaterialIfOwned` catches this at the call site instead of producing silent GPU errors.

**Cross-refs.**
- **Blocks C5 and E3** — they consume the `__disposable` convention defined here. Ship B3 first.
- Add a doc-comment block at the top of `entities.js` documenting the convention so future material-clone introductions don't slip past.
- Coordinate with `MaterialCache.get()` to add the `__cacheOwned` tag (single line; same PR).

## B4 — Index name→guid for `findGuidByName`
**Severity** High • **File** `scene3d/entities.js:1162-1167` • **Status** ✅ Done (commit `b0469a4` — Map<name, Set<guid>> indexed at spawn/remove; "first match wins" preserved via Set insertion order)

**Problem.** Linear scan of `entityMap` for every remote-swing dispatch.

**Fix.** Maintain a `Map<string, Set<guid>>` updated on spawn/despawn/rename. Names aren't unique (multiple "Drudge") so use a `Set` and let the caller pick (current behavior is "first match" — match that).

**Acceptance.** Lookup is O(1). Combat capture in a populated zone shows no perceptible cost from swing dispatch.

**Risk.** Stale entries after rename — ensure the rename path (if any) updates the index.

## B5 — Pre-allocate `nameplate_sprite.js` child-scan
**Severity** Med • **File** `scene3d/nameplate_sprite.js:465-479` • **Status** ✅ Done (commit `cf23191` — scan now gated on `window.__debugNameplates` for the Vite-hot-reload race; production trusts the `inst._nameplateSprite` slot)

**Problem.** Defensive O(children) scan per nameplate creation. Cheap individually, multiplies at spawn-burst.

**Fix.** Maintain a per-entity `nameplateSprite` slot directly; skip the scan entirely. The scan was insurance against orphan sprites — replace with an assertion in dev mode only.

**Acceptance.** 100-entity spawn burst frametime drop ≥ 0.5 ms.

**Risk.** If the scan was catching real orphan cases, we'll regress; check git log for the original incident before deleting.

## B6 — Cache nameplate transform writes (style-write dedup)
**Severity** Low → Med (scales with nameplate count) • **File** `scene3d/hud.js:293-295` • **Status** ✅ Done (commit `5242b8b`)

**Problem.** `style.left`/`top` written every frame for every nameplate even when values are unchanged.

**Fix.** Cache last `{left, top}` per nameplate; skip write when within 0.5 px. Use `transform: translate3d()` instead of `left/top` — composited, layout-free.

**Acceptance.** With 100 visible nameplates, frame's "Style/Layout" lane in devtools drops to near-zero.

**Risk.** None.

## B7 — Spawns: collapse double-snapshot pattern
**Severity** Low • **File** `scene3d/spawns.js:529-575` • **Status** ✅ Done (commit `65d6c2e` — single `buildUpd(rec, ...)` eagerly; 427 × 2 → 427 × 1 allocations on cold start)

**Problem.** Synthetic spawn injection takes one snapshot in the loop and another in dispatch.

**Fix.** Pass the snapshot reference through; only clone where the consumer requires immutability.

**Acceptance.** Holtburg initial spawn injection completes ≥ 5 ms faster (cold-start metric).

**Risk.** Low; verify no consumer mutates the snapshot.

---

# Workstream C — Cells + statics + buildings + CSM + lighting

## C1 — Fuse EnvCell per-surface meshes
**Severity** High • **File** `scene3d/cells.js:308-323` • **Status** Open — **HIGHEST BLAST RADIUS** in the plan; flag-gate mandatory

**Problem.** Each EnvCell creates one `THREE.Mesh` + Material per surface DID. The Academy alone (568 cells) at typical PVS depth shows 24–104 visible cells × 4–8 surface DIDs each = 96–832 material binds per frame indoors. Three.js batches by material so this proliferation directly maps to bind-state overhead. On a GTX 1070 this is ~2–3 ms of frametime lost to state-machine overhead, separate from the actual draw work.

**Briefing.**

This is the single biggest structural Holtburg win in the audit but also the highest-blast-radius change. **Ship behind a URL flag** (`?envcellFusion=1`) so it can be A/B'd against the existing path during shakedown. Default OFF until at least one populated-zone capture validates pixel-identical (or within tolerance) output.

Read fresh — verify recent commits with `git log -- scene3d/cells.js`. EnvCell wiring was last touched substantially during the academy follow-on work (project memory references); the bake path may have invariants you're not expecting.

**Approach:**

1. Per cell at build time, gather all surface-DID groups. Each group is a `(surfaceDid, indexRange, material)` triple — already accessible in the current per-Mesh loop.

2. Fuse into a single `BufferGeometry`:
   ```js
   const fused = new BufferGeometry();
   fused.setAttribute("position", ...);
   fused.setAttribute("normal", ...);
   fused.setAttribute("uv", ...);
   fused.setIndex(combinedIndex);
   // Assign per-surface index ranges as Three.js groups:
   let offset = 0;
   for (let g = 0; g < groups.length; g++) {
     fused.addGroup(offset, groups[g].count, g); // materialIndex = g
     offset += groups[g].count;
   }
   ```

3. Build a `material` ARRAY parallel to the groups:
   ```js
   const materials = groups.map((g) => materialCache.get(g.surfaceDid));
   ```

4. Construct ONE `THREE.Mesh(fused, materials)` per cell. Three.js will bind the correct material per group automatically.

5. Wire `?envcellFusion=1` URL flag at the top of `buildEnvCellsForLandblock`. If unset, fall through to the existing per-surface-Mesh path. Both code paths live in the same function, gated by the flag.

**Critical preservation rules:**

- **Material identity per surface** stays correct (the `materialCache.get(did)` map ensures this).
- **Visibility flips** still work — the cell's single Mesh `.visible` flag toggles the whole cell on/off, which is how PVS gating works today. No per-surface visibility exists today, so this is moot.
- **castShadow / receiveShadow** flags apply at the Mesh level, not per-group. The existing per-surface translucent gate (which sets `castShadow=false` for translucent surfaces) currently flips per-mesh; in fused mode, the WHOLE cell's `castShadow` becomes the OR of the surface flags — likely fine since cells with translucent surfaces are rare and translucent shadows are a known artifact.
- **Vertex layout** must match across surfaces — they all share position/normal/uv attributes from the EnvCell vertex stream, so this is a non-issue.
- **Transparent ordering**: if a cell has both opaque and transparent groups, Three.js's per-mesh transparent flag won't render the transparent group correctly within the opaque queue. **May require splitting transparent-bearing cells into two Meshes** (one opaque, one transparent). Probe the data: how many cells in the Academy contain transparent surfaces? If < 5%, the simpler "one Mesh per cell" model is fine.

**Acceptance.**

`renderer.info.render.calls` drops 5×–10× indoors. Visual diff capture (`capture_phase6_step_c_envcells.cjs` + `capture_academy_envcells.cjs`) is pixel-identical or SSIM > 0.995 over a full Academy tour. Frametime drops 1.5–3 ms indoors at typical PVS depth.

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/cells.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

Plus `capture_phase6_step_c_envcells.cjs` and `capture_academy_envcells.cjs` runs with `?envcellFusion=1` and side-by-side diff against baseline.

**Risk.** **HIGHEST in the plan.** Indoor rendering is the most visually salient part of the academy; a regression here is immediately user-visible. Flag-gating + SSIM-based visual diff is non-negotiable.

Specific regression vectors to watch:
- **Group order**: if the index ranges don't perfectly tile the geometry, you'll see missing triangles or z-fighting.
- **Material array sparse holes**: a `materials` array with `undefined` entries triggers a default Three.js material (purple/lambert) — guard with `.filter(Boolean)` or assertions before constructing the Mesh.
- **Transparent ordering** (per above): split into opaque + transparent Meshes per cell if transparent surfaces are common.

**Cross-refs.**
- Coordinates with C4 (commit `b089c6d`) — fused meshes still receive shadows the same way through the CSM cascade-skip gate.
- Doesn't depend on any other open task. Self-contained but high-stakes.
- The post-implementation visual-diff gate is critical; line up a known-good `screenshots/` baseline BEFORE starting work so the diff has something to compare against.

## C2 — Gate statics `receiveShadow` on distance / tier
**Severity** High • **File** `scene3d/statics.js:508-520` • **Status** ✅ Done (commit `8ceafa0` — `low`-preset gate only; distance-tier follow-on remains open)

**Problem.** All 16,700 placements set `receiveShadow=true`; CSM frustum-test cost scales linearly.

**Fix.** Only foreground tier (e.g. dist² < 60²) gets `receiveShadow=true`; beyond that, `false`. Re-evaluate on PVS expansion. At `low` quality preset, default everything to `false`.

**Acceptance.** Holtburg outdoor frametime drops ≥ 1 ms; ground beyond ~60 m visibly self-shadows-only (acceptable).

**Risk.** Distant terrain darkening looks wrong if CSM range was tuned around all-receivers — sanity-check the cascade splits.

## C3 — Statics receiveShadow audit also covers buildings
**Severity** Low • **File** `scene3d/buildings.js:255-258` • **Status** Open (small follow-on to C2)

**Problem.** Buildings set `receiveShadow=true` per-surface (correctly — translucent surfaces get the per-material gate). Holtburg has ~46 building placements at radius=1 × ~8 parts × ~2–3 meshes/part ≈ 460+ receiver meshes. Each is individually testable in the CSM frustum-cull pass. Less impactful than the 16,700-static C2 win, but the same pattern applies.

**Briefing.**

C2 (commit `8ceafa0`) landed the `low`-preset gate for statics. The full audit recommendation is a distance-tier gate (foreground `dist² < 60²` → `receiveShadow=true`; beyond → `false`). C3 should fold buildings into the same gate.

Read fresh — `git log -- scene3d/buildings.js`. C5 is likely the only other open work on this file.

**Steps:**

1. Find the existing per-surface mesh build (line ~255–258 per audit).
2. Apply the same predicate C2 uses: read `scene3d.quality?.preset` (low → off) AND optionally distance.
3. **Coordination with C2's distance follow-on**: the C2 commit (`8ceafa0`) left a TODO for the distance-tier follow-on at four sites in `statics.js`. Two options:
   - **(a)** Land C3 with the low-preset gate ONLY for now; defer the distance gate to a combined "C2+C3 distance follow-on" PR later.
   - **(b)** Land both C2 distance tier + C3 in one PR (touches statics.js + buildings.js).

   **Pick (a).** Single-file scope keeps the PR small and lets C3 ship independently. C2's distance follow-on can be its own task later.

4. Per-surface granularity stays — translucent gate still applies, just gated by quality AND by per-material decision.

5. Compute `buildingsReceiveShadow = scene3d.quality?.preset !== "low"` once per bake (mirror C2's `staticsReceiveShadow` convention from `8ceafa0`). Thread it through to the surface-mesh write site.

**Acceptance.** At `low` preset, building surfaces have `receiveShadow=false`. At `mid`/`high`/`ultra`, current behaviour (`receiveShadow=true`) preserved. Visual diff: ground beneath buildings will visibly self-shadow-only at `low`.

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/buildings.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

**Risk.** Low. Same self-shadowing concern as C2 at `low` — buildings without ground-cast shadows look odd. Acceptable given the perf trade.

**Cross-refs.**
- Mirrors C2's logic. Match its predicate name (`buildingsReceiveShadow` analogous to `staticsReceiveShadow`).
- Coordinate with C5 if both run concurrently — different concerns (`receiveShadow` vs dispose) but same file.

## C5 — Building materials disposal on cell unload
**Severity** Med (long-session) • **File** `scene3d/buildings.js` (unload path) • **Status** Open — **DEPENDS ON B3**

**Problem.** PVS contraction removes building Groups from the scene but cloned materials (per-placement `material.clone()` from `MaterialCache`) stay live in WebGL. Walk in/out of PVS 100 times → texture count grows by ~hundreds.

**Briefing.**

**Depends on B3.** Wait until the `__disposable` convention is defined in entities.js (see Lessons section). If B3 hasn't landed, pause.

Read fresh — buildings.js. The unload path may be `removeBuildingsForLandblock`, `unloadBuildingsForLandblock`, or similar — search for `unload` / `remove` in the file.

**Steps:**

1. Walk the building Group being unloaded with `Group.traverse(obj => { ... })` (same pattern as B3).
2. For each Mesh, call the `_disposeMaterialIfOwned` helper (or its buildings.js equivalent — preferably import the entities.js helper if it's exported; otherwise duplicate it locally and document why):
   ```js
   function _disposeMaterialIfOwned(mat) {
     if (mat?.userData?.__disposable === true) mat.dispose();
   }
   ```
3. Dispose per-placement geometry (`geometry.dispose()`) too. Geometries cloned from a shared template are usually NOT disposable; verify with B3's convention. If in doubt, only dispose geometries tagged `userData.__disposable = true`.

**Audit step (REQUIRED):** find every `material.clone()` in buildings.js and ensure the clone is tagged `userData.__disposable = true`. Without this, the disposal walk silently no-ops and the leak persists.

**Acceptance.** PVS-cycle soak (walk in/out of PVS 100 times) leaves `renderer.info.memory.textures` flat (±5%).

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/buildings.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

Plus a scripted PVS-cycle smoke test (5-minute walk script).

**Risk.** Same as B3 — disposing a cached material crashes. Mitigation: strict reliance on the `__disposable` tag set at clone time. If a clone site is missed in the audit, this PR is a no-op for those materials (still safe), just doesn't free them. Better to under-dispose than over-dispose.

**Cross-refs.**
- **Depends on B3** (defines the convention).
- Coordinates with C3 (same file, different concern).
- Pairs with E3 — they implement the same pattern for particles.

## C4 — CSM skip-rebuild when camera + sun unchanged
**Severity** High • **File** `scene3d/csm.js:388-413` • **Status** ✅ Done (commit `b089c6d`)

**Problem.** All 3 cascades re-fit every frame (corner transforms, AABB, texel snap, matrix updates).

**Fix.** Cache last camera position + sun direction; if delta below thresholds (e.g. ‖Δcam‖² < 0.01 m² AND ‖Δsun‖² < 1e-6), skip `_fitCascade()`. Force rebuild on quality change.

**Acceptance.** Standing still indoors: CSM update lane drops to ~0 ms. Walking: rebuild every frame as before. No shadow swimming.

**Risk.** Mis-tuned threshold causes shadow acne / swim — start conservative.

## C5 — Building materials disposal on cell unload
**Severity** Med (long-session) • **File** `scene3d/buildings.js` (unload path)

**Problem.** PVS contraction removes building Groups but cloned materials stay live.

**Fix.** On unload, traverse the building Group and dispose materials tagged `_disposable=true` (same convention as B3). Don't dispose cache refs.

**Acceptance.** PVS-cycle soak (walk in/out of PVS 100 times) leaves `renderer.info.memory.textures` flat.

**Risk.** Same caveat as B3 — disposing a shared cache material crashes.

## C6 — Throttle the per-frame light distance sort
**Severity** Med • **File** `scene3d/lighting.js:534` • **Status** ✅ Done (commit `cb8527f`)

**Problem.** `scratch.sort(sortByDistSq)` over 100–300+ lights every frame is ~0.5–1 ms.

**Fix.** Sort every Nth frame (N=4 or 8) unless the light count just changed. Cache the sorted order between sorts. Or, switch to a partial-sort / k-smallest via a min-heap of size = cap.

**Acceptance.** With ~200 dungeon lights, frametime drops ≥ 0.5 ms.

**Risk.** Lights popping in/out as the cap changes between sorts — mitigate by always-sort on cap-cross.

## C7 — Light clone deduplication (re-open after architecture restructure)
**Severity** Med • **File** `scene3d/lighting.js:776` • **Status** ⛔ Blocked on C7-prereq; see split below

### Original problem
`Light.clone()` per placement; large model × N placements = hundreds of clones at load.

### Why the first attempt bailed (wave 4)
Pooling lights is structurally unsafe given:
1. C6's per-light `.visible` toggling (each placement's light needs independent visibility for the distance cap).
2. Three.js's `Object3D.add()` enforces one parent per object. A pooled Light can only have one parent and one world position, but N placements need N world positions.

### Re-open plan (C7-prereq → C7-real split)

#### C7-prereq — Decouple cap/sort from the Light instance
**Severity** Med (foundational refactor) • **File** `scene3d/lighting.js`

Introduce a per-placement metadata array:

```js
const lightSlots = []; // { lightRef, parentRef, worldPosCache, visible, distSq, ... }
```

The C6 distance-sort iterates `lightSlots` (not `scene3d.activeLights`). Each slot's `visible` flag flips on the SLOT, not the Light instance. The Light instance can then potentially be shared across placements.

**Render integration.** The slot's `visible` needs to gate the light's CONTRIBUTION to the scene. Two options:

- **Option A** (recommended): each placement still has its own Light Object3D, but the LIGHT'S RENDER PARAMETERS (intensity, color, distance, decay, ...) are cloned-by-reference from a shared "lightInfo" template. The Object3D wrapper is per-placement so `.visible` works; only the parameter-bag is shared. This is "shared parameters, separate instances" — not true pooling, but it kills the heavy `Light.clone()` allocations that copy all per-instance state.
- **Option B**: Use `Object3D.layers` or render passes to mask out lights selectively. Complex; not recommended.

**Pick Option A.** The "shared template" is a frozen `{type, color, intensity, distance, decay, ...}` object built once per source model. Each placement gets a fresh Light Object3D with copied properties — separate `.visible`, separate parent. Drops the clone cost without breaking C6.

#### C7-real — Wire the template
After C7-prereq lands, replace `Light.clone()` with `createLightFromTemplate(template, transform)`. The template is built once per source model; each placement gets a fresh Light Object3D with copied properties. No clone cost.

### Acceptance (C7-real)

Holtburg statics-bake: scene `lights.length` is unchanged but the construction time drops. `Light.clone()` no longer appears in the heap profile during a populated-zone load.

### Verification

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/lighting.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

### Risk

Each step (C7-prereq, C7-real) is its own PR. C6's distance sort needs careful preservation through C7-prereq — verify with `capture_phase7_6_lighting.cjs` or equivalent.

### Cross-refs

- Coordinates with C6 (commit `cb8527f`) which owns the per-frame sort.
- Defer C7-prereq until at least one capture validates C6 + B3 hold up under realistic gameplay load.
- Note: statics are unaffected by the original C7 problem — they already share `lightObj` via the `InstancedMesh` path's `attachedAny=false` branch (file evidence at lighting.js:707 per the wave-4 audit). The clone pressure is from buildings + entities only.

---

# Workstream D — Terrain + materials shaders

## D1 — Verify water fragment cost is acceptable
**Severity** Low (audit / no-op probable) • **File** `scene3d/terrain.js:428-438, 469-472` • **Status** Open (procedural — measurement first)

**Problem.** Water tiles use per-fragment `sin(uTime * 0.3)` and `sin(uTime * 0.5 + worldXy.x * 0.1)` for displacement modulation + tint. Magnitude is fine on a 1070 (terrain shader is simple enough that this is negligible) but the audit flagged it for measurement.

**Briefing.**

This is a **measurement task first**, not a code change. The decision tree:

1. Use `capture_visfid_p22_displacement.cjs` (water/lava displacement smoke) on the R9 290 (worst-case GPU available — see `reference_r9_290_visual_validation.md` for setup). Measure fragment cost at full-screen water.
2. If water fragment cost < 0.5 ms / frame at fullscreen: **close task as no-action**. Add a comment to terrain.js (near the existing `sin(...)` lines) recording the measurement + budget headroom so this doesn't re-surface as a phantom finding.
3. If water fragment cost > 0.5 ms / frame: **fold the modulation into the vertex shader**. Pass `vWaveModulation` (= the `sin(...)` result) as a varying to the fragment shader. Pixel cost drops to one varying read + one mul instead of two `sin(...)` evaluations per pixel.

Read fresh — terrain.js was touched recently by D3 (commit `8664218`) which added the `uTriplanarSlopeLo` uniform around line 311. **Don't collide with that uniform's wiring**.

**If you land the vertex-shader fold (option 3):**

- Add a new varying `vWaveModulation` (single `float`, or `vec2` if both `sin` calls share interpolation).
- Compute the `sin(...)` per vertex (in `TERRAIN_VERTEX_GLSL`); pass via varying. Interpolation across the quad is fine for this slow-changing visual.
- In `TERRAIN_FRAGMENT_GLSL`, replace the `sin(...)` calls with `vWaveModulation`.
- Update the `uniforms`/`varyings` declarations accordingly.

**WATCH OUT — GLSL template literals + backticks:** terrain.js builds its shader text via JS template literals (`` `...` ``). The D3 wave shipped a backtick inside a GLSL comment, which silently terminated the JS template literal — `node --check` passed, real ESM `import()` failed. **Use single quotes or plain text in any comments you add inside the shader template literal.** Apostrophes are fine; backticks are not.

**Acceptance.** Either close with measurement evidence (budget within target) or land the vertex-side modulation with a frametime delta of ≥ 0.3 ms / frame at fullscreen water on the R9 290.

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/terrain.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

**Risk.** Low — measurement-first. The vertex-fold change is mechanical if needed; visual diff is the only concern (vertex interpolation will smooth the modulation differently than per-pixel, but at this slow frequency it'll be imperceptible).

**Cross-refs.** Independent of other open tasks. Lives entirely in terrain.js.

## D2 — POM step-count quality knob
**Severity** Med • **File** `scene3d/materials.js:519-521, 524-525` • **Status** ✅ Done (commit `fede972`)

**Problem.** Stone/brick/tile POM is 16 primary + 8 self-shadow steps at close range; close-up walls = expensive per-pixel.

**Fix.** Move step counts into the quality preset (`low: 0 disable, mid: 8+4, high: 16+8, ultra: 24+12`). Compile-out POM entirely at `low`.

**Acceptance.** `low` preset POM is gone; `mid` is ~25% cheaper than `high` on the same scene.

**Risk.** Visual diff vs `high` — expected.

## D3 — Triplanar slope gate audit
**Severity** Med • **File** `scene3d/terrain.js:542-582` • **Status** ✅ Done (commit `8664218` — new `triplanarSlopeThresholdPct` int flag; mid=60 / high+ultra=30; note shifts shader-baked 0.2 → uniform default 0.3 at high/ultra)

**Problem.** Triplanar = 3× detail-normal samples on slopes. Activates at slope ≥ 0.3.

**Fix.** Move the slope gate threshold into quality preset; at `low`, disable triplanar entirely; at `mid`, raise threshold to e.g. 0.6 (only the steepest cliffs).

**Acceptance.** `low` preset has flat slopes; `mid` retains triplanar on cliffs only.

**Risk.** Subtle artifacting on moderate slopes at `mid` — eyeball.

---

# Workstream E — Particles

## E1 — Module-scratch Euler/Quat in per-particle update
**Severity** High • **File** `scene3d/particles/particle.js:338-339` • **Status** ✅ Done (commit `5b6ff4e`)

**Problem.** `new THREE.Euler()` + `new THREE.Quaternion()` per particle per frame for rotation types.

**Fix.** Module-level scratch pair. Replace in-place.

**Acceptance.** 1000-particle effect → particle update lane drops in allocations to near-zero.

**Risk.** None if scratches stay module-private.

## E2 — Write `getRandomOffset/A/B/C` in-place
**Severity** High • **File** `scene3d/particles/particle_emitter_info.js:151-191` • **Status** ✅ Done (commit `68e8480` — optional `out` Vector3 param; four new module scratches in `particle_emitter.js`; offset path also drops two internal Vector3 allocations via `subVectors`)

**Problem.** Each helper `.clone()` a Vector3 per spawn.

**Fix.** Change the API: `getRandomOffset(out)` writes into a caller-supplied Vector3 and returns it. Update callers in `particle_emitter.js`.

**Acceptance.** 100/s spawn rate over 30 s → no Vector3-from-Float32Array clone churn in heap profile.

**Risk.** Caller-retention — same caveat. Search call sites.

## E3 — Dispose cloned particle materials on emitter destroy
**Severity** Med (long-session) • **File** `scene3d/particles/particle_manager.js:89-96` • **Status** Open — **DEPENDS ON B3**

**Problem.** `destroyParticleEmitter` (in particle_manager.js) doesn't dispose the cloned material per slot. Each `baseMaterial.clone()` lives forever in WebGL. Over a session with many spell-effect spawns + despawns, particle materials accumulate.

**Briefing.**

**Depends on B3** — wait until the `__disposable` convention is defined in entities.js. If B3 hasn't landed, pause and document the dependency.

Recent commits in particle_manager.js: none yet. Read fresh.

Other particle files recently touched (don't collide with their scratches — see Lessons section):
- E1 (`5b6ff4e`) — particle.js scratches.
- E2 (`68e8480`) — particle_emitter_info.js + particle_emitter.js in-place API.
- E4 (`80e9812`) — particle_emitter.js scratch.
- E6 (`805b9ab`) — particle_emitter.js + quality.js cap.

**Implementation:**

1. In `particle_manager.js`, find `destroyParticleEmitter` (line ~89–96 per audit).
2. Before removing the emitter from the manager's tracking, walk each slot:
   ```js
   for (const slot of emitter.slots) {
     if (slot.mesh) {
       slot.mesh.geometry?.dispose();
       const mat = slot.mesh.material;
       if (mat?.userData?.__disposable === true) {
         mat.dispose();
       }
     }
   }
   ```
3. **At the clone site** (also near line 89 per audit), tag the cloned material as disposable:
   ```js
   slot.mesh.material = baseMaterial.clone();
   slot.mesh.material.userData.__disposable = true;
   ```
4. Make sure `baseMaterial` itself (from `MaterialCache` or the `materialFactory` returning cached refs) is NOT tagged — that's the cache reference.

**Acceptance.** Spell-emitter spawn/despawn loop × 200 leaves texture count flat (`renderer.info.memory.textures` ±5%).

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/particles/particle_manager.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

Plus a scripted spell-cast loop running 200 × spell-effect with `manager.destroyParticleEmitter()` between each cycle, checking `renderer.info.memory.textures` at start + end.

**Risk.** Same dispose-shared-material caveat as B3. The `__disposable` tag is the safety net.

**Cross-refs.**
- **Depends on B3** (defines the `__disposable` convention).
- Mirrors C5 (different file, same pattern).
- Coordinates with E5 — E5 changes the material FLAGS (alphaTest, sortObjects); E3 changes the material LIFECYCLE (dispose). Both can land in either order, but coordinate on the `__disposable` tagging at clone site (E3 owns that; E5 just reads the resulting material).

## E4 — Drop per-frame `Vector3.clone()` in birthrate-per-meter
**Severity** Med • **File** `scene3d/particles/particle_emitter.js:160` • **Status** ✅ Done (commit `80e9812`)

**Problem.** BirthratePerMeter allocates a fresh Vector3 per tick.

**Fix.** Reuse a module-scratch Vector3. In-place math for travel distance.

**Acceptance.** Heap profile in-place.

**Risk.** None.

## E5 — Material flags: alphaTest gating + sortObjects toggle
**Severity** Low • **File** `scene3d/particles/particle_manager.js:91` • **Status** Open

**Problem.** All particle materials default to `transparent: true` with no `alphaTest`. This forces Three.js to add every particle to the transparent queue, sort by depth (O(N log N) on 1000 particles), and disable depth-write (so particles can't occlude each other or write depth for subsequent passes). For binary-masked particles (where the alpha channel is mostly 0 or 255), `alphaTest=0.5` + `transparent=false` lets the particle render in the opaque queue, skip the sort, and write depth.

**Briefing.**

Recent commits in particle_manager.js: none yet. Read fresh.

**The hard part — which particles are binary-masked?** The audit handwaved this. The agent needs to decide:

- **AC particle blend mode tells us.** Retail AC `ParticleEmitter` records carry a blend-mode field (or equivalent). Read particle_emitter_info.js to find what the type system exposes — likely `info.blendType` / `info.blendMode` / similar. Map it to one of:
  - `BlendMode::Add` → additive (alpha contributes brightness, not coverage).
  - `BlendMode::Alpha` → standard alpha blend.

- **Recommended classification:**
  - **Additive:** `transparent=true`, `blending=THREE.AdditiveBlending`, `depthWrite=false`. No alphaTest. Sort matters less than alpha-blend sort; consider `sortObjects=false` at the scene level (URL flag) if the visual impact is acceptable.
  - **Alpha:** `transparent=true`, `alphaTest=0.1` (catches near-zero alpha and enables depth-write for those pixels), `depthWrite=true`. The `alphaTest` does most of the depth-write benefit even when the texture has a soft edge.
  - **Unknown / fallback:** `transparent=true`, no alphaTest (current behaviour).

- **URL flag:** ship `?particleSortObjects=off` as an escape hatch. Default ON (existing behaviour). Allows perf testing without committing to the scene-level toggle.

**Steps:**

1. Read particle_emitter_info.js to find the blend-mode field. If there isn't one exposed at the JS layer, document that as a follow-on and ship the "alphaTest=0.1, transparent=true, depthWrite=true" path for ALL particles. That's a conservative perf win without needing per-emitter classification.
2. In particle_manager.js's material setup (line ~91), branch on the blend mode and set flags accordingly.
3. Document the per-mode flag choices inline with a one-line comment explaining the trade.

**Acceptance.** With 1000 active particles, frametime drops (depth-write enabled for non-additive particles cuts overdraw cost). Visual diff: minor hardening of alpha edges on alpha-blended particles — note in PR description with side-by-side captures.

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./scene3d/particles/particle_manager.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

**Risk.** Visual diff — alpha-edged sprites will harden slightly. Expected. If a specific spell-effect looks bad, the URL flag `?particleSortObjects=off` (or a per-emitter override) can roll it back without code change.

**Cross-refs.**
- Coordinates with E3 — E3 changes the material LIFECYCLE (dispose); E5 changes the material FLAGS. Both can land in either order, but coordinate at the clone site (E3 owns `__disposable` tagging there).

## E6 — Runtime particle-count cap
**Severity** Low • **File** `scene3d/particles/particle_emitter.js:268` • **Status** ✅ Done (commit `805b9ab` — `maxParticlesPerEmitter` INT_FLAG; low=64/mid=256/high=1024/ultra=2048; one-time warn per emitter DID)

**Problem.** AC ParticleEmitter can request unbounded particle counts; the slot-search loop silently drops.

**Fix.** Hard-cap `maxParticles` per emitter from quality preset (`low: 64, mid: 256, high: 1024`). Log on cap-hit.

**Acceptance.** A pathological spell effect can't blow up frametime.

**Risk.** Visual fidelity regression on heavy effects at `low` — expected.

---

# Workstream F — UI plugins + HUD + picking

## F1 — Debounce / coalesce combat-bar power-slider syncs
**Severity** High • **File** `plugins/combat-bar.js:472-476` • **Status** ✅ Done (commit `e3c4204`)

**Problem.** `syncWindowState()` fires on every slider input tick (60+/s on drag).

**Fix.** Debounce to ~30 ms or coalesce via `requestAnimationFrame`. The wire-side update only needs to land on release for most ACE-side semantics.

**Acceptance.** Dragging the slider stops producing per-tick window-state writes; final value still applied on release.

**Risk.** None.

## F2 — Stop the power-meter rAF loop when panel is hidden
**Severity** High • **File** `plugins/combat-bar.js:541-551` • **Status** ✅ Done (commit `9cffce9`)

**Problem.** rAF loop runs continuously during attack refill even if the combat-bar is collapsed or off-screen.

**Fix.** Check the bar's `display`/`visibility` (or an explicit `isOpen` flag) at the top of the rAF; bail and exit the loop if hidden. Restart loop when the bar reopens during refill.

**Acceptance.** Closing the combat-bar mid-refill stops style writes within 1 frame.

**Risk.** None.

## F3 — Replace vitals-hud `innerHTML` rebuild with field-level updates
**Severity** High • **File** `plugins/vitals-hud.js:113` • **Status** ✅ Done (commit `0c10af9`)

**Problem.** `overlay.innerHTML = rows.join('')` destroys + rebuilds the whole HUD on every stats event.

**Fix.** On first render, build the DOM once and keep direct references to each bar's fill/text node. On stats events, mutate only the changed field's `style.width` / `textContent`.

**Acceptance.** Stats-tick during combat shows no DOM mutation in the "Layout" lane.

**Risk.** None.

## F4 — Spellbook list: diffed render
**Severity** Med • **File** `plugins/spellbook.js:431-482` • **Status** ✅ Done (commit `60942c9` — `Map<spellId, {row, meta}>` keeps rows; filter toggles `display`; listeners stay attached)

**Problem.** `rerenderList()` clears `innerHTML` and rewires drag listeners on every filter change.

**Fix.** Keep a `Map<spellId, HTMLElement>`; on filter, toggle `display` instead of rebuilding. Listeners stay attached.

**Acceptance.** Rapid filter toggling produces no DOM churn.

**Risk.** None.

## F5 — Damage-feed: ring-buffer DOM nodes
**Severity** Med • **File** `plugins/combat-bar.js:917-927` • **Status** ✅ Done (commit `4681e49` — lazy first-use; `insertBefore` move keeps newest-at-top; zero `createElement`/`remove`/`unshift`/`pop` in steady state)

**Problem.** Each combat event creates / appends / removes a DOM node.

**Fix.** Pre-create `FEED_LIMIT` (=5) line nodes once; rotate text content + class through them. Append is O(1) and never touches the DOM tree shape.

**Acceptance.** Sustained 5 hits/s shows no DOM mutations beyond text/class.

**Risk.** None.

## F6 — Replace forced-sync layout in bar positioning
**Severity** Med • **File** `ui/bar.js:580, 709` • **Status** Open (read fresh — file has recent prelude work)

**Problem.** Two sites in `ui/bar.js` schedule a `requestAnimationFrame(() => bar.getBoundingClientRect())` after style writes. This pattern forces a synchronous layout flush — even when the layout hasn't actually changed in a way that requires it. Bar repositioning + orientation toggles produce "Forced reflow" warnings in Chrome devtools.

**Briefing.**

`ui/bar.js` has been touched recently:
- Graphics-tab prelude (commit `f45dd3c`) added the tab strip + Graphics panel and routes settings through it. The CSS and `openSettings()` function are now much larger than the audit's snapshot.

Read bar.js FRESH. The audit line numbers (580, 709) have shifted — find them by searching for the two `requestAnimationFrame` calls that immediately read `getBoundingClientRect()` inside.

**Approach:**

1. Replace the rAF + `getBoundingClientRect()` pattern with a `ResizeObserver` set up ONCE at bar init.
2. The observer fires whenever the bar's size changes. Stash the last bounds in a closure variable.
3. The repositioning logic reads from the cached bounds, not from a fresh `getBoundingClientRect()`.

**Specifics:**

```js
let cachedBounds = { width: 0, height: 0 };
const ro = new ResizeObserver((entries) => {
  for (const entry of entries) {
    cachedBounds.width = entry.contentRect.width;
    cachedBounds.height = entry.contentRect.height;
  }
});
ro.observe(bar);
```

Then `clampToViewport(state.left, state.top, cachedBounds.width, cachedBounds.height)` replaces the fresh-rect read.

**Cleanup:** store the observer on a teardown reference + disconnect on `destroy()`.

**Important caveats:**

- The first `ResizeObserver` callback fires AFTER initial layout. Until then, `cachedBounds` is `{0, 0}`. The init path needs to either (a) use the cached bounds and tolerate the brief zero state, or (b) do ONE synchronous `getBoundingClientRect()` at init only, then rely on the observer.
- Don't break the orientation-toggle re-clamp logic. After orientation flip, the bar's bounds change; the ResizeObserver should fire and trigger a re-clamp. Chain: orientation flip → style write → observer fires → re-clamp from cache.
- The Graphics-tab work added the `hb-settings-wide` class that widens the settings popover when on the Graphics tab. The popover positioner (`positionSettings`) reads `el.offsetWidth/offsetHeight` — that's a layout read but it's bounded (popover has fixed sizes), so leaving it as-is is OK. Focus on the bar's own rAF + `getBoundingClientRect` pattern.

**Acceptance.** Orientation toggle produces no "Forced reflow" warnings in Chrome devtools (Performance pane → "Frame chart" view, filter for "Recalculate Style" / "Layout").

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./ui/bar.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

**Risk.** Slight delay on first paint after a resize — acceptable. `ResizeObserver` is widely supported (all modern browsers).

**Cross-refs.**
- Don't touch the Graphics tab logic (commit `f45dd3c`) — different concern.
- Coordinate with any other UI tab work since bar.js owns the settings popover layout.

## F7 — Pre-filter picking raycast targets
**Severity** Med • **File** `scene3d/picking.js:145-156` • **Status** ✅ Done (commit `9c64bdb`)

**Problem.** Raycast walks the entire `entityManager.entityMap` on every click. With 16,700 statics that's a click-stall risk if `recursive=true`.

**Fix.** Maintain a `pickableTargets` array updated on spawn/despawn; raycast against it directly with `recursive=false`. Confirm statics are not in the pickable set (they shouldn't be for entity picking).

**Acceptance.** Click latency in Holtburg drops to imperceptible.

**Risk.** Missed pickables — write an assertion that fires in dev mode if an expected pickable isn't in the array.

## F8 — Combat-bar height button: no-op (audit-only)
**Severity** Low • **File** `plugins/combat-bar.js:682-685`

Click-once-per-second; no perf issue. **Close as no-action.**

## F9 — Remove duplicate `forgetSpell` definition
**Severity** Cosmetic • **File** `plugins/api.js:49-50` • **Status** Open (trivial)

**Problem.** `plugins/api.js` has two `forgetSpell` definitions; the second shadows the first. The first is dead code (memorialised in the audit at api.js:49-50).

**Briefing.**

1. Open plugins/api.js.
2. Find both `forgetSpell` definitions (lines ~45 + ~49 per audit).
3. Delete the EARLIER one. The later definition is the live one and contains the actual implementation.
4. Confirm no other file imports the api.js export by ordinal position (`grep -r forgetSpell` — should only show field-access references like `api.forgetSpell(...)`).

**Acceptance.** One `forgetSpell` definition. No behavioural change. Lint passes.

**Verification.**

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && node -e "import('./plugins/api.js').then(()=>console.log('OK')).catch(e=>{const m=e.message.split('\\n')[0];console.log(m.includes('Cannot find package')?'OK (parse ok)':'FAIL: '+m)})"
```

**Risk.** None. Cosmetic.

**Cross-refs.** None.

---

# Validated optimizations (already clean — no work)

For agent awareness; don't "re-optimize" these:

- Statics instancing via `InstancedMesh` for modelId with ≥ 2 placements.
- Terrain + water vertex displacement (already vertex-shader-driven).
- Material cache deduplicated per-DID (not per-object).
- EnvCells start `visible=false` for PVS gating (`cells.js:359`).
- `materialCanCastShadow()` gates translucent surfaces from shadow pass.
- PVS load hooks are idempotent (Set-guarded).
- Terrain texture mipmaps generated correctly at bake (`terrain.js:760-793`).

---

# Reporting back

Each PR description should include:

1. Task id (`A1`, `B3`, etc.) and one-line restatement of the fix.
2. Before/after numbers from the smoke specified in **Acceptance**. For frametime, give median + p95 over a 10-s capture. For memory, give `renderer.info.memory` before/after the soak.
3. Visual-diff link if the change can alter rendering (most C and D tasks).
4. Any cross-cutting choices (e.g. the `_disposable` material tag convention introduced in B3) must be linked from later PRs that consume them.

If a task turns out to be wrong on inspection (e.g. acceptance smoke doesn't budge), comment here with the file:line + finding and close as "Audit error" — do not delete from this doc.
