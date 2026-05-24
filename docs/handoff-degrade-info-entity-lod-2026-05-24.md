# Handoff: GfxObjDegradeInfo (DAT 0x11) entity-side LOD integration

**For:** next agent picking up entity LOD wiring.
**Status: parser + wasm export + JS reader shipped in Wave 7.1; entity-spawn integration NOT shipped.** This is the most contained of the three deferred items (~6 hours per the explore report). Statics + buildings already have a parallel LOD path via `resolve_did_degrade`; this handoff carries the mirror integration to entities.

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
