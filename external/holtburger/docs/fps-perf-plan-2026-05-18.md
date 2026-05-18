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
**Severity** Med • **File** `scene3d/index.js:820-825`

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
**Severity** Med • **File** `scene3d/quality.js:175-189`

**Problem.** Same `mid` preset defaults for GTX 1050 and RTX 4090. `WEBGL_debug_renderer_info` is widely available.

**Fix.** Read `UNMASKED_RENDERER_WEBGL`; pattern-match for well-known low-tier strings (Mali, Adreno, Intel HD/UHD, GTX 10×0/9×0 mobile) and downshift the preset. Keep an override URL param.

**Acceptance.** On a budget device the default lands at `low`; on a high-end the default stays at `high`.

**Risk.** Substring matching is brittle; ship a small allowlist of known-good GPUs as `high` and otherwise fall back to `mid`.

## A6 — Batch `Uint32Array.from` allocations during burst spawn
**Severity** Med • **File** `scene3d/loop.js:468-517` (`toMeta`)

**Problem.** Three `Uint32Array.from(...)` calls per spawn × N batched spawns = stall during PVS expansion.

**Fix.** Reuse a per-spawn scratch `Uint32Array` of generous size; copy/slice into per-entity storage only at the point of retention.

**Acceptance.** PVS-expansion capture (200 simultaneous spawns) frametime drop ≥ 1 ms during the burst.

**Risk.** Low; ensure no reader retains a reference to the scratch buffer.

## A7 — `_ric_shim.js` time-remaining sanity check
**Severity** Low • **File** `scene3d/_ric_shim.js:54-65`

**Problem.** Shim assumes a 50 ms budget; under host load (Discord, OBS) actual is 5–10 ms and the bake overshoots, producing stalls.

**Fix.** Measure actual elapsed inside the callback and short-circuit if elapsed > 30 ms before yielding work; expose `lastBudgetMs` for telemetry.

**Acceptance.** Atmosphere bake under simulated CPU load (run with `--cpu-throttling-rate=4`) shows no >100 ms main-thread tasks.

**Risk.** Affects bake path that's mostly already-shipped — verify atmosphere stack still bakes within ~12 s on 1070.

---

# Workstream B — Entities + animation + dispose

## B1 — Frustum + distance gate on `entities.tick()`
**Severity** High • **File** `scene3d/entities.js:2005-2083`

**Problem.** `for (const e of this.entityMap.values())` updates mixers, hooks, tweens for every entity regardless of camera visibility or distance. Academy has 104 spawns; typically ~20 are in PVS + frustum.

**Fix.** For each entity, compute `inFrustum && distSq < maxTickDistSq`; skip mixer/hook/tween update otherwise. **Exceptions** (must keep ticking even when off-screen): the local player, anyone targeted, anyone with an active swing/spell-effect hook, and anyone whose AI animation drives a one-shot networked event. Add a small "force tick" set.

**Acceptance.** Academy idle frametime drops by 2–4 ms with no visible animation pop when entities re-enter frustum.

**Risk.** Animation snap on re-entry — mitigate by carrying mixer time forward via `dt` accumulation, or accept the snap if visually unnoticeable.

## B2 — Reuse Quat/Euler/Vec3 scratches in jump tween + particle attach
**Severity** High • **File** `scene3d/entities.js:1297-1304` (jump tween), `1758-1768` (particle attach hook)

**Problem.** `new Quaternion()` × 2 per airborne generic-rig per frame, plus `new Vector3()` + `new Quaternion()` per particle hook fire.

**Fix.** Module-level `const _scratchQuatA = new Quaternion()`, `_scratchQuatB`, `_scratchVec3`, `_identityQuat = new Quaternion()`. Replace in-place. Document that callers may not retain references.

**Acceptance.** Heap profile during a "20 entities jump simultaneously" smoke shows the entity-tick alloc lane go flat.

**Risk.** Caller-retention bug — search for any code that captures the result of the affected functions by reference.

## B3 — Complete `Entity.dispose()` to release child Geometry/Material
**Severity** High (long-session) • **File** `scene3d/entities.js:390-410`

**Problem.** `dispose()` removes the root but doesn't traverse children — geometries and per-instance materials leak in VRAM.

**Fix.** Walk `root.traverse(obj => { if (obj.isMesh) { obj.geometry?.dispose(); if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose()); else obj.material?.dispose(); } })`. Be careful: **never dispose a cached material from `MaterialCache`**. Track which materials are clones vs cache refs (e.g. tag clones with `_disposable = true`).

**Acceptance.** 200 NPC spawn/despawn cycles → `renderer.info.memory.geometries` and `.textures` return to baseline ±5%.

**Risk.** High. Disposing a cached material crashes future renders. Lean on the `_disposable` tag pattern; add a unit test or assertion.

## B4 — Index name→guid for `findGuidByName`
**Severity** High • **File** `scene3d/entities.js:1162-1167`

**Problem.** Linear scan of `entityMap` for every remote-swing dispatch.

**Fix.** Maintain a `Map<string, Set<guid>>` updated on spawn/despawn/rename. Names aren't unique (multiple "Drudge") so use a `Set` and let the caller pick (current behavior is "first match" — match that).

**Acceptance.** Lookup is O(1). Combat capture in a populated zone shows no perceptible cost from swing dispatch.

**Risk.** Stale entries after rename — ensure the rename path (if any) updates the index.

## B5 — Pre-allocate `nameplate_sprite.js` child-scan
**Severity** Med • **File** `scene3d/nameplate_sprite.js:465-479`

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
**Severity** Low • **File** `scene3d/spawns.js:529-575`

**Problem.** Synthetic spawn injection takes one snapshot in the loop and another in dispatch.

**Fix.** Pass the snapshot reference through; only clone where the consumer requires immutability.

**Acceptance.** Holtburg initial spawn injection completes ≥ 5 ms faster (cold-start metric).

**Risk.** Low; verify no consumer mutates the snapshot.

---

# Workstream C — Cells + statics + buildings + CSM + lighting

## C1 — Fuse EnvCell per-surface meshes
**Severity** High • **File** `scene3d/cells.js:308-323`

**Problem.** Each cell creates one `THREE.Mesh` + material per surface DID. Academy = ~100–800 material binds/frame indoors.

**Fix.** Per cell, fuse all surfaces into a single `BufferGeometry` with `groups` (index ranges) and a `material` array — Three.js will bind once and draw groups. Material identity per group is preserved.

**Acceptance.** `renderer.info.render.calls` drops 5×–10× indoors. Visual diff capture (`capture_phase6_step_c_envcells.cjs`) is pixel-identical or within tolerance.

**Risk.** High blast radius — touches indoor rendering. Stage behind a `?envcellFusion=1` flag during shakedown.

## C2 — Gate statics `receiveShadow` on distance / tier
**Severity** High • **File** `scene3d/statics.js:508-520` • **Status** ✅ Done (commit `8ceafa0` — `low`-preset gate only; distance-tier follow-on remains open)

**Problem.** All 16,700 placements set `receiveShadow=true`; CSM frustum-test cost scales linearly.

**Fix.** Only foreground tier (e.g. dist² < 60²) gets `receiveShadow=true`; beyond that, `false`. Re-evaluate on PVS expansion. At `low` quality preset, default everything to `false`.

**Acceptance.** Holtburg outdoor frametime drops ≥ 1 ms; ground beyond ~60 m visibly self-shadows-only (acceptable).

**Risk.** Distant terrain darkening looks wrong if CSM range was tuned around all-receivers — sanity-check the cascade splits.

## C3 — Statics receiveShadow audit also covers buildings
**Severity** Low • **File** `scene3d/buildings.js:255-258`

**Problem.** Per-surface granularity is correct but adds per-mesh overhead.

**Fix.** Apply the same distance/tier gate as C2 to building surfaces. Fold into C2's quality flag.

**Acceptance.** Same as C2.

**Risk.** Same as C2.

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

## C7 — Light clone deduplication
**Severity** Med • **File** `scene3d/lighting.js:776`

**Problem.** `Light.clone()` per placement; large model × N placements = hundreds of clones at load.

**Fix.** When the light's transform is identity-relative to the model root, reuse a single Light reference; only clone when per-placement transform varies. Or pre-bake light positions into a single per-landblock list.

**Acceptance.** Holtburg statics-bake: scene `lights.length` drops materially; ground-truth illumination unchanged.

**Risk.** Shared lights need their per-frame updates done once, not N times — check the iteration logic.

---

# Workstream D — Terrain + materials shaders

## D1 — Verify water fragment cost is acceptable
**Severity** Low (audit / no-op probable) • **File** `scene3d/terrain.js:428-438, 469-472`

**Problem.** Per-fragment `sin(uTime*…)` for displacement modulation + tint. Magnitude is fine but worth measuring.

**Fix.** Profile water fragment cost on R9 290 (worst case). If > 0.5 ms / frame at fullscreen water, fold the modulation into vertex shader and pass through varyings.

**Acceptance.** Either confirm baseline within budget (close the task) or land vertex-side modulation.

**Risk.** None — measurement first.

## D2 — POM step-count quality knob
**Severity** Med • **File** `scene3d/materials.js:519-521, 524-525` • **Status** ✅ Done (commit `fede972`)

**Problem.** Stone/brick/tile POM is 16 primary + 8 self-shadow steps at close range; close-up walls = expensive per-pixel.

**Fix.** Move step counts into the quality preset (`low: 0 disable, mid: 8+4, high: 16+8, ultra: 24+12`). Compile-out POM entirely at `low`.

**Acceptance.** `low` preset POM is gone; `mid` is ~25% cheaper than `high` on the same scene.

**Risk.** Visual diff vs `high` — expected.

## D3 — Triplanar slope gate audit
**Severity** Med • **File** `scene3d/terrain.js:542-582`

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
**Severity** High • **File** `scene3d/particles/particle_emitter_info.js:151-191`

**Problem.** Each helper `.clone()` a Vector3 per spawn.

**Fix.** Change the API: `getRandomOffset(out)` writes into a caller-supplied Vector3 and returns it. Update callers in `particle_emitter.js`.

**Acceptance.** 100/s spawn rate over 30 s → no Vector3-from-Float32Array clone churn in heap profile.

**Risk.** Caller-retention — same caveat. Search call sites.

## E3 — Dispose cloned particle materials on emitter destroy
**Severity** Med (long-session) • **File** `scene3d/particles/particle_manager.js:89-96`

**Problem.** `destroyParticleEmitter` doesn't dispose the cloned material per slot.

**Fix.** Walk emitter slots in destroy; `material.dispose()` and `geometry?.dispose()` for any disposable per-slot resource. Coordinate with B3/C5 on the `_disposable` tag convention.

**Acceptance.** Spell-emitter spawn/despawn loop (× 200) leaves texture count flat.

**Risk.** Same dispose-shared-material caveat as B3/C5.

## E4 — Drop per-frame `Vector3.clone()` in birthrate-per-meter
**Severity** Med • **File** `scene3d/particles/particle_emitter.js:160`

**Problem.** BirthratePerMeter allocates a fresh Vector3 per tick.

**Fix.** Reuse a module-scratch Vector3. In-place math for travel distance.

**Acceptance.** Heap profile in-place.

**Risk.** None.

## E5 — Material flags: alphaTest gating + sortObjects toggle
**Severity** Low • **File** `scene3d/particles/particle_manager.js:91`

**Problem.** All particle materials are `transparent:true` with no `alphaTest`, forcing depth-sort on every particle.

**Fix.** For binary-masked particles, use `alphaTest=0.5` + `transparent:false` so they write depth and skip sort. For true alpha-blended particles, keep `transparent:true` but consider disabling `sortObjects` at the scene level if the visual cost is acceptable.

**Acceptance.** 1000-particle scene → render call cost drops; ordering bugs noted in PR description if any.

**Risk.** Visual diff — alpha-edged sprites will harden at the alphaTest threshold.

## E6 — Runtime particle-count cap
**Severity** Low • **File** `scene3d/particles/particle_emitter.js:268`

**Problem.** AC ParticleEmitter can request unbounded particle counts; the slot-search loop silently drops.

**Fix.** Hard-cap `maxParticles` per emitter from quality preset (`low: 64, mid: 256, high: 1024`). Log on cap-hit.

**Acceptance.** A pathological spell effect can't blow up frametime.

**Risk.** Visual fidelity regression on heavy effects at `low` — expected.

---

# Workstream F — UI plugins + HUD + picking

## F1 — Debounce / coalesce combat-bar power-slider syncs
**Severity** High • **File** `plugins/combat-bar.js:472-476`

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
**Severity** Med • **File** `plugins/spellbook.js:431-482`

**Problem.** `rerenderList()` clears `innerHTML` and rewires drag listeners on every filter change.

**Fix.** Keep a `Map<spellId, HTMLElement>`; on filter, toggle `display` instead of rebuilding. Listeners stay attached.

**Acceptance.** Rapid filter toggling produces no DOM churn.

**Risk.** None.

## F5 — Damage-feed: ring-buffer DOM nodes
**Severity** Med • **File** `plugins/combat-bar.js:917-927`

**Problem.** Each combat event creates / appends / removes a DOM node.

**Fix.** Pre-create `FEED_LIMIT` (=5) line nodes once; rotate text content + class through them. Append is O(1) and never touches the DOM tree shape.

**Acceptance.** Sustained 5 hits/s shows no DOM mutations beyond text/class.

**Risk.** None.

## F6 — Replace forced-sync layout in bar positioning
**Severity** Med • **File** `ui/bar.js:580, 709`

**Problem.** `requestAnimationFrame(() => getBoundingClientRect())` after style writes forces a synchronous layout pass.

**Fix.** Use `ResizeObserver` for bar size; cache last bounds; apply position based on cached values. Avoid `getBoundingClientRect` in the rAF body entirely.

**Acceptance.** Orientation toggle produces no "Forced reflow" warnings in devtools.

**Risk.** Slight delay on first paint after a resize — acceptable.

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
**Severity** Cosmetic • **File** `plugins/api.js:49-50`

Delete the shadowed earlier definition.

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
