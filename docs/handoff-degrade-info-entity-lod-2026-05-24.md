# Handoff: GfxObjDegradeInfo (DAT 0x11) entity-side LOD integration

**For:** historical reference — closed.
**Status (2026-05-24 update — Wave 7.4 SHIPPED):** parser + wasm reader + JS runtime + diag shipped in Wave 7.1; **entity-spawn integration shipped in Wave 7.4** (this session). Reader-side band picker (`ui/ac_lod.js::pickDegradeBand`) still useful for any future per-frame LOD code or LOD-aware plugins.

## Wave 7.4 — what shipped 2026-05-24

The handoff's "Required shape (a) spawn-time substitution" approach landed cleanly:

1. **`apps/holtburger-web/src/lib.rs`** — new `fetch_entity_degrade_for_distance(setup_id: u32, distance: f32) -> u32` wasm export (~L5405 region). Composes the existing `resolve_did_degrade` walk (SetupModel → first GfxObj → did_degrade) + `GfxObjDegradeInfo::unpack` + band selection in Rust so JS gets a single call → single substitute setupId answer. Returns the band's `gfx_obj_id` (0x01 prefix) or 0 when no chain / no band matches / no camera. Distance is meters in AC world frame.
2. **`apps/holtburger-web/index.html`** — exposed via `window.__hbWasm` (around L1300) and listed in the `init3D` wasmExports object (around L6086) so `EntityManager.wasmExports` carries it.
3. **`apps/holtburger-web/scene3d/entities.js::_spawnImpl`** — added the spawn-time LOD gate at the top of `_spawnImpl` (~L860). Reads `window.liveScene3d.camera.position`, computes horizontal distance to the entity's world pose (`lbX*192 + meta.x`, `lbY*192 + meta.y`), calls the wasm helper, substitutes setupId if non-zero. Distance frozen at spawn — entities crossing a band threshold mid-game won't switch (matches the handoff's shape-a recommendation).
4. **`apps/holtburger-web/scene3d/diag/lod.js`** — added `onSpawnAttempt` + `onSpawnSubstitution` hooks with `spawnAttempts` + `spawnSubstitutions` counters + `recentSubstitutions` ring (max 50 samples). `onSpawnAttempt` fires on every camera-positioned spawn regardless of result; `onSpawnSubstitution` fires only when the wasm helper returned a substitute.

**Critical wasm-side compatibility note:** `fetch_entity_animation_keyframes` (lib.rs:~L10840) already branches on `(setup_id >> 24) != 0x02` and takes the GfxObj direct path for 0x01 prefixes. So substituting a 0x01 setupId from the LOD chain is safe — no entity render-path changes were needed. Matches the statics LOD path that uses the same convention.

Verified end-to-end on `?wireframe=1&hud=none&plugins=none&diag=1` against live ACE:
- **Direct wasm probe:** 14 of 21 spawned-entity setups have GfxObjDegradeInfo chains; helper returns valid substitutes at 15m distance.
- **Spawn-time integration:** 70 `spawnAttempts` during boot drain + active probe; 1 `spawnSubstitution` actually fired — entity `0x7a9b3001` at 14.42m, setup `0x020006ef` → substitute `0x010019a5`. The other 69 attempts were correctly skipped (no chain OR distance out of band; both expected).

Harness: `/mnt/wbterminal1/tmp/claude-scratch/wire-agent-new-pipelines-2026-05-24/run-diag-entity-lod.mjs`.

**What this guarantees:** entities arriving in view with a registered LOD chain + at appropriate distance now spawn with the lower-detail GfxObj instead of the full SetupModel. Frees GPU work for distant NPCs/creatures matching the statics path that's been in place since the visual-fidelity waves.

**Known limitations (deferred, see below):**
- **First-part-only LOD** — `resolve_did_degrade` only consults the first GfxObj part of a SetupModel. Multi-part entities with per-part degrade chains only LOD their first part. Same as the statics behavior; matches the original handoff's flagged limitation.
- **Spawn-time only** — entities crossing the threshold mid-game won't switch. Shape-(b) continuous per-frame LOD swap is the future optimization if this becomes a visible regression in dense Holtburg scenes.
- **Camera-must-be-positioned** — boot-time entities that arrive before the camera is anchored skip the LOD check entirely (early-return on `cameraPos = null`). The next time those entities receive a wire update that triggers respawn (e.g. UpdateObject equip-change via W7.3 applyAppearance), the LOD check runs with a valid camera.

## What ships in Wave 7.1

- `fetch_gfx_obj_degrade_info(id)` wasm export at `apps/holtburger-web/src/lib.rs` (after `fetch_palette_set`)
- `ui/ac_lod.js` JS runtime with `loadDegradeInfo(id)`, `getDegradeInfo(id)`, `pickDegradeBand(runtime, distance)`
- `__diag.lod` surface in `scene3d/diag/lod.js` with `summary()`, `snapshot()`, band-hit/miss counters
- Verified on real retail bytes: GfxObjDegradeInfo `0x11000001` loads + `pickDegradeBand(runtime, 30.0)` returns the 10-25-50m band's GfxObj `0x0100376A`. Confirmed in `/mnt/wbterminal1/tmp/claude-scratch/wire-agent-new-pipelines-2026-05-24/out-wave7-1-2026-05-24T*/lod_post.json`.

## What's NOT shipped

The actual entity render path doesn't consume `pickDegradeBand` yet. At entity spawn time, `EntityManager.spawn()` calls `fetchEntityAnimationKeyframes(setupId)` with the original setupId regardless of camera distance.

## The integration shape (proposed by the explore report — shape (a) spawn-time substitution)

Mirrors the existing statics.js pattern:

1. **Wasm helper** (new): `fetch_entity_degrade_for_distance(setup_id: u32, distance: f32) -> u32`. Walks SetupModel → first GfxObj → did_degrade (already done by `resolve_did_degrade` at lib.rs:4475) → parses the chain → picks the band whose distance window contains `distance` → returns the band's `gfx_obj_id` (or 0 if no chain / out-of-range).

2. **JS spawn-time gate** in `scene3d/entities.js::EntityManager.spawn(meta)` (around L852-881):

   ```js
   // After meta.setupId is resolved, before fetchEntityAnimationKeyframes:
   const cameraPos = liveScene3d?.camera?.position;
   const distance = cameraPos ? entityDistanceFromCamera(meta, cameraPos) : 0;
   const degradedGfxObjId = await wasm.fetch_entity_degrade_for_distance(setupId, distance);
   const effectiveSetupId = degradedGfxObjId !== 0 ? degradedGfxObjId : setupId;
   await this.fetchEntityAnimationKeyframes(effectiveSetupId); // existing call
   ```

3. **Caveat:** GfxObjDegradeInfo bands return GfxObj DIDs (0x01 prefix), not SetupModel DIDs (0x02 prefix). The entity render path expects setups. Two options:
   - **(3a)** Have wasm return the GfxObj DID; teach `fetchEntityAnimationKeyframes` to accept either 0x01 or 0x02 prefix and route accordingly. Statics already handle this — see `resolve_did_degrade` callers.
   - **(3b)** Build a degraded SetupModel wrapper on the fly inside wasm. More invasive, more retail-accurate (preserves multi-part rigs).

   Recommendation: 3a — the statics path already proves it's safe.

## Why this wasn't shipped in Wave 7.1

The explore report estimated 6 hours including animation-mixer state sync and a parity test. The entity render path is a long file (`entities.js` >2200 LOC) with several invariants around async spawn ordering. Shipping it required reading + testing in detail that the Wave 7.1 push couldn't fit alongside the 3 wasm exports + 3 JS runtimes + 3 diag surfaces + 2 handoff docs.

The wasm + JS reader + diag are the prerequisite layer. Wire them in this follow-on without re-doing the parser/export work.

## How to pick up

1. Read this doc + `ui/ac_lod.js` + `scene3d/diag/lod.js`.
2. Read `scene3d/statics.js:599-627` for the existing LOD wiring pattern.
3. Read `scene3d/entities.js:852-881` (spawn flow) — find the cleanest hook site.
4. Add `fetch_entity_degrade_for_distance` to `apps/holtburger-web/src/lib.rs` (it's the only wasm work — composes existing `resolve_did_degrade` + `pickDegradeBand` logic in Rust).
5. Wire into `EntityManager.spawn()`.
6. Add a `__diag.entitySpawn?` cross-ref or extend the existing `__diag.spawns` byLb metadata with a `degradedAtSpawn` boolean.
7. Verify on the wire agent — bring an entity in/out at >100m camera distance, confirm via `__diag.lod.bandHits` that the band picked correctly and via `__diag.spawns.byLandblock` that the spawn used a degraded setupId.
8. Update `docs/ui-asset-completeness-method.md` to note entity LOD shipped.

## Risks

1. **Animation-mixer state sync** (MEDIUM) — if entity re-spawns with degraded rig, the AnimationMixer must resume on the new mesh seamlessly. Low risk per the explore agent's note that each spawn is fresh.
2. **Distance threshold choice** (LOW) — statics use 100m. Entities often cluster tighter (~25-50m for combat). The retail chain ALREADY encodes distance bands per asset (min_dist/max_dist), so just trust the bands rather than picking a single threshold.
3. **First-part-only LOD** (KNOWN LIMITATION) — `resolve_did_degrade` only consults the first GfxObj part of a SetupModel. Multi-part entities with per-part degrade chains would only LOD their first part. Matches the statics pattern; not worth fixing now.
4. **Holtburg test coverage** (LOW) — per the visual-fidelity Wave 5 memory: "most Holtburg models don't have a degrade chain." Verify with a wider-ring test if Holtburg shows no degrade activity.

## Cross-references

- Parser: `external/holtburger/crates/holtburger-dat/src/file_type/degrade_info.rs`
- Wasm export: `external/holtburger/apps/holtburger-web/src/lib.rs::fetch_gfx_obj_degrade_info`
- JS runtime: `external/holtburger/apps/holtburger-web/ui/ac_lod.js`
- Diag surface: `external/holtburger/apps/holtburger-web/scene3d/diag/lod.js`
- Existing statics LOD: `external/holtburger/apps/holtburger-web/scene3d/statics.js:599-627` + `lib.rs::resolve_did_degrade` (~L4475)
- ACE reference: `external/ACE/Source/ACE.DatLoader/FileTypes/GfxObjDegradeInfo.cs`
- Acclient: `~/ac-headers/acclient.c:6789` (`GfxObjDegradeInfo::get_degrade(distance)`)
- Visual-fidelity context: `~/.claude/projects/-home-wbterminal/memory/project_visual_fidelity_wave1_done_2026-05-13.md`, `wave5_done`
