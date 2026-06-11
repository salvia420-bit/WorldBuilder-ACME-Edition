# A9 part-array-setup — unification survey

Date: 2026-06-11 · Agent: A9 · Status: survey complete (read-only)
Scope: `CSetup` / `CPartArray` / `CPhysicsPart` / `CGfxObj` — part placement frames, setup
hierarchy, scale, palette/texture/anim-part swaps (obj-desc changes) vs our setup→Object3D
construction (Rust `walk_setup_parts` + JS `scene3d/*` consumers).

## 1. Retail map

Retail funnels EVERY visible object — creature, item, static, building part, particle — through
one class pair: `CPartArray` (owner: parts + sequence + scale + pals + lights) over `CSetup`
(immutable DAT template). Call order, all cited:

| step | function | acclient.c | behavior |
|---|---|---|---|
| R1 | `CPartArray::CreateSetup` / `SetSetupID` | 326779 | load `CSetup` by DID, `DestroyPals/Lights/Parts`, swap `setup`, then `InitParts` → `InitLights` → `InitDefaults` (326806–326812) |
| R2 | `CPartArray::InitParts` | 325274 | one `CPhysicsPart::makePhysicsPart(setup->parts[i])` per part; back-pointer `physobj`/`physobj_index`; copies `setup->default_scale[i]` into each part's `gfxobj_scale` (loop near 325330) |
| R3 | `CPhysicsObj::InitObjectEnd` | 317293–317309 | **default placement id 0x65 (Resting)**: `CPartArray::SetPlacementFrame(v2, 0x65u)` at 317303, then `SetFrame(&m_position.frame)` |
| R4 | `CPhysicsObj::SetPlacementFrame(frame_id)` | 318540–318562 | wire/server-driven placement id → `CPartArray::SetPlacementFrame` (318554) → `SetFrame` re-poses parts immediately (318560) |
| R5 | `CPartArray::SetPlacementFrame` | 326818 | hash lookup `setup->placement_frames[placement_id]`; **fallback is placement id 0** (the LABEL_4 path searches for `id == 0`, 326845–326860); feeds `CSequence::set_placement_frame` |
| R6 | `CPartArray::SetFrame` → `UpdateParts` | 326766 → 326601 | per frame: `Frame::combine(parts[i].pos.frame, world_frame, animframe.frame[i], &scale)` — anim frames are MODEL-SPACE per part (flat, no runtime parent chain); `scale` folded into combine |
| R7 | `CPartArray::SetScaleInternal` | 326182 | object-scale change recomputes every part's `gfxobj_scale = default_scale[i] * scale` in place, no part rebuild |
| R8 | `CPartArray::DoObjDescChanges` | 326699 | obj-desc deltas in place: `SetPart` (AnimPartChange → `CPhysicsPart::SetPart` 315525 gfxobj swap), `SetTextureMap` (→ 314978), `SetPalette` (326448 → `UsePalette` 315016), then `InitObjDescChanges` |
| R9 | `CPartArray::DoObjDescChangesFromDefault` | 326868 | reset path: per-part `RestorePalette`, `DestroyPals`, then R8 — i.e. appearance change is an IN-PLACE mutation of the live part array, never a rebuild |
| R10 | `CPartArray::AddLightsToCell` / `InitLights` | 325211 / 326321 | setup lights always instantiated (R1 calls InitLights unconditionally) and registered with the cell |
| R11 | `CPhysicsPart::UpdateViewerDistance` / degrade | 6280–6282 (protos), `GetMaxDegradeDistance` 6258 | per-PART degrade-level selection per view distance; parts swap gfxobj LOD individually, object stays alive |
| R12 | `CSetup.parent_index` | 334623 | consumed only in pack-size/serialize code — NOT used for runtime hierarchy (anim frames already model-space, see R6) |

Struct ground truth: `CSetup` (acclient.h:31119–31147: parts, parent_index, default_scale,
placement_frames, holding_locations, connection_points, lights, anim_scale, default_* DIDs),
`CPartArray` (acclient.h:30762–30773), `CPhysicsPart` (acclient.h:31151–31173: gfxobj_scale,
degrades, surfaces, shiftPal).

## 2. Ours map

The Rust DAT/walk layer is unified; the JS consumption layer is not.

| concern | Rust | JS |
|---|---|---|
| Setup parse | `crates/holtburger-dat/src/file_type/setup_model.rs:328–345` (full struct: parts, parent_index, default_scale, placement_frames, holding/connection points) | — |
| Part walk + pose priority | `apps/holtburger-web/src/lib.rs:4697–4814 walk_setup_parts` (pose_override → idle anim → placement `0→1→first`; default_scale baked into vertices at 4792–4807) | — |
| Entity rig build | per-part tris + rest pose `lib.rs:4629–4687` | `scene3d/entities.js:2729–2786` (THREE.Group root + `part_${p}` Groups, rest pose 2741–2753) |
| Static objects | fused `triangulate_setup_model_at_frame` `lib.rs:4546` | `scene3d/statics.js:556/573` via `fetch_model_meshes` |
| EnvCell statics | same fused path | `scene3d/cells.js:345` |
| Buildings | `fetchBuildingPlacement` per-part container (`lib.rs:1281–1284`) | `scene3d/buildings.js:10/302–361` (own per-part hingeWrapper convention) |
| Portal-space | fused | `scene3d/portal_space.js:120–123` |
| Spawn injector | wcid→setup lookup | `scene3d/spawns.js:40–216` (routes into entities path) |
| Object scale (wire ObjScale) | sentinel-passed on UpdateObject | `entities.js:2852–2855` `root.scale.setScalar`; runtime change = respawn (`RUNTIME_OBJSCALE_ON` entities.js:620, merge at 6545) |
| Obj-desc change (dye/equip) | palette compositor `fetchEntitySurfacesPixels` | `entities.js:6527 applyAppearance` = **despawn+respawn V1**; in-place hot-swap exists behind `?clothingHotSwap=1` (entities.js:2026, `_applyAppearanceHotSwap` 6634) |
| Placement frames (attach/grip) | `lib.rs:9494 collect_setup_placement_frames`, `9574 fetch_setup_placement_frames` | `entities.js:3905 _applyChildPlacementFrames` (B5, shipped) |
| Holding locations | `lib.rs:9395/9438` | `entities.js:3853 _resolveHoldingLocation`, `attachChildToParent` 3706, pending-attach 2195–2200 |
| Setup lights | `lib.rs collect_setup_model_lights` (per lighting.js:98) | `entities.js:6983 _attachEntityLights` — **URL-flag-gated** (readEntityLightsFlag :32) + preset cap 8 (:257–263) |
| Degrade/LOD | `lib.rs:8051 fetch_entity_degrade_for_distance` | `entities.js:592–604 DYN_LOD` (default per flag), `_tickDynamicLod` :8513 — band crossing → **whole-entity respawn**, 0.5 s throttle |

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|---|---|---|---|---|---|
| 1 | Wire/initial placement id never applied to free-standing entities; fallback order wrong. Retail: server `frame_id` → `SetPlacementFrame` (R4) and default **0x65 Resting** at init (R3); fallback id 0 (R5). Ours resolve placement `0 → 1 → first` and consume `PhysicsDesc.animation_frame` ONLY as the wielded-attach grip key | acclient.c:317303, 318554, 326845 | lib.rs:4732–4736 (and 9061–9064, 9511–9515); animation_frame → motion_stance only at lib.rs:32730 | MISSING | chests/corpses/levers/any object whose rest pose is selected by placement id render in Default(0) pose instead of the wire-commanded one | untracked |
| 2 | Setup→scene construction split across ~5 JS sites where retail has ONE CPartArray pipeline for every object kind | acclient.c:326779 (SetSetupID), 325274 (InitParts), protos 6646–6648 | entities.js:2729–2786; statics.js:556/573; cells.js:345; buildings.js:302–361 (+lib.rs:1281–1284); portal_space.js:120–123 | SPLIT-BRAIN (5 sites) | a fix to part transforms/material wiring in one path doesn't reach the others (e.g. sortCenter, TextureVelocity, lights all entity-only) | partially: unsurfaced-audit G1/G9 note statics non-consumption |
| 3 | Appearance (obj-desc) change is in-place part/texture/palette mutation in retail; ours despawn+respawns the rig (hot-swap exists but is flag-gated OFF) | acclient.c:326868, 326699, 315525 | entities.js:6527 (respawn V1, rationale comment 6504–6512), hot-swap gated at 2026/6558 | DIFF-ALGO | 1-frame flicker + animation restart on every equip/dye/ghost change; pose preserved but action state rebuilt | Wave 7.5 (clothingHotSwap), unsurfaced-audit "gated OFF" theme |
| 4 | LOD/degrade: retail selects degrade level PER PART per frame, object stays alive; ours re-fetches a band per entity (0.5 s) and respawns the whole rig on crossing | acclient.c:6258/6280–6282 (CPhysicsPart degrade surface), 316326 (UpdateViewerDistance fan-out) | entities.js:592–604, 8513–8560; lib.rs:8051 | DIFF-ALGO | respawn hitch + mixer restart at LOD boundaries; statics use only bands[0] | G2 (multi-band degrade, statics.js:598) |
| 5 | Setup lights: retail unconditional `InitLights` + cell registration on every setup; ours entity-path only, URL-flag-gated with cap 8, statics/buildings get none from this path | acclient.c:326811, 325211, 326321 | entities.js:32–47 (flag), 257–263 (cap), 6983, 7040–7059 | DIFF-ALGO (gated) | lamp/brazier setups don't emit light unless flag on; cap drops lights on light-heavy setups | unsurfaced-audit "shipped but gated OFF" theme |
| 6 | Object-scale change at runtime: retail `SetScaleInternal` recomputes part scales in place; ours respawns (scale is baked into vertices + root.scale) | acclient.c:326182, 319020/320657 (call sites) | lib.rs:4792–4807 (vertex bake); entities.js:620, 6545 (respawn merge) | DIFF-ALGO | growth/shrink spells flicker via respawn instead of smooth in-place rescale (tween exists at entities.js:10107 for the anim itself) | untracked (R7 runtimeObjScale shipped the data path) |
| 7 | `connection_points` parsed but never exported/consumed | acclient.h:31141 (field; serialize-only in .c) | setup_model.rs:335; no `fetchSetupConnectionPoints` in lib.rs | MISSING (low) | none known — retail runtime use not located either (see §6) | G9 |
| 8 | Flat part hierarchy, model-space anim frames, `parent_index` unused at runtime; per-part `default_scale`; holding-location attach + grip placement frames | acclient.c:326601 (UpdateParts model-space combine), 334623 (parent_index serialize-only) | entities.js:2741–2753 + lib.rs:4664–4684 (rest pose), 4792 (default_scale); entities.js:3706/3853/3905 (attach + grip, B5 shipped) | PARITY | — | G8 ("no gaps"), G9 row 12 now SHIPPED by B5 |

Count: 2 MISSING, 4 DIFF-ALGO, 1 SPLIT-BRAIN, 1 PARITY.

## 4. Staged unification plan

The Rust side already has the single-owner shape (everything funnels through
`walk_setup_parts`); the gaps are (a) placement-id input parity, (b) the JS consumption split,
(c) in-place mutation vs respawn. Stages ordered cheapest-leverage first; each independently
flag-gated and rollback = flag off.

**Stage 1 — placement-id parity (fixes #1).**
Scope: thread `PhysicsDesc.animation_frame` into spawn meta (`EntityUpdate`) and extend the
pose-priority chain in `walk_setup_parts` / `collect_setup_placement_frames` to
`wire placement → 0x65 → 0 → first` (retail R3/R5 order; keep idle-anim above placement as
today — retail's sequence also prefers a live anim).
Files: `apps/holtburger-web/src/lib.rs` (4732–4736, 9061–9064, 9511–9515, EntityUpdate emit),
`scene3d/entities.js` spawn meta plumb.
Flag: `?placementId=on` (default-off, url-flags.md style). wasm-rebuild.
Tests: headless-now — unit test pinning resolved frame for a setup with both 0 and 0x65
placements; 1070-gated — chest/corpse pose eye-check.

**Stage 2 — one JS rig-constructor module (fixes #2, enables 3).**
Scope: extract entities.js:2729–2786 (+ material resolution + partFrames proxy) into
`scene3d/setup_rig.js` with a `buildRig(partGroups, restPose, materials)` API; route
`_applyAppearanceHotSwap` and the attach/grip re-pose through it. Statics/buildings/portal-space
keep their fused fast paths but the per-part container variant (buildings hinge wrappers,
lib.rs:1281–1284) adopts the same module so part-transform semantics live in one place.
Files: new `scene3d/setup_rig.js`; `entities.js`; `buildings.js`.
Flag: `?rigModule=off` escape hatch (default-on once landed — pure refactor, byte-identical
transforms is the acceptance bar). JS-live.
Tests: headless-now — existing validate_landblock_completeness.cjs walker still matches;
transform-equality assertion old-vs-new on a fixture setup.

**Stage 3 — in-place obj-desc changes default-ON (fixes #3, subsumes Wave 7.5 flag).**
Scope: promote `_applyAppearanceHotSwap` to default with respawn as automatic fallback on
topology mismatch (it already falls through, entities.js:6558–6562) — this is retail R8/R9
semantics. Extend the same in-place path to runtime ObjScale (#6): apply
`root.scale` mutation instead of respawn when ONLY scale changed (retail R7 is in-place).
Files: `entities.js` (6527–6634 region).
Flag: rename/flip `?clothingHotSwap` → `?inPlaceObjDesc` default-on. JS-live.
Tests: headless-now — hot-swap unit path already validated per Wave 7.5 notes; 1070-gated —
equip/dye/ghost flicker eye-check, growth-spell smoothness.

**Stage 4 — per-part degrade (fixes #4) — OPTIONAL / lowest priority.**
Scope: replace band-crossing respawn with per-part gfxobj swap inside the Stage-2 rig module
(retail R11). Requires per-part degrade chains surfaced from Rust (`GfxObjDegradeInfo`
equivalent per part, today only whole-setup substitution).
Flag: `?perPartLod=on`. wasm-rebuild + JS.
Tests: 1070-gated (visual LOD pops). Defer until G2 statics multi-band work is scheduled —
same data plumbing, do together.

## 5. Scores

- Leverage: subsumes/retires **G9 row 12** (already shipped by B5 — confirm + close),
  **Wave 7.5 clothingHotSwap** (Stage 3 promotes it), **G2** (Stage 4 shares plumbing),
  unsurfaced-audit "entity lights gated OFF" is adjacent (#5, owned by A10/lighting seam — flagged, not planned here).
- Regression-risk reduction: **M-H** — Stage 2 collapses the 5-site split that caused the
  entity-only consumption pattern (sortCenter/TextureVelocity/lights); Stage 3 removes a whole
  class of respawn-ordering races (despawn+respawn vs concurrent KIND_POSITION).
- Impl risk: Stage 1 **L** (additive fallback chain), Stage 2 **M** (pure refactor, big file),
  Stage 3 **M** (animation-state sync already built, just default flip + scale arm),
  Stage 4 **H** (new data plumbing + visual tuning).
- 1070-dependency: Stage 1 partial (unit-testable headless, pose eye-check gated); Stage 2 **N**;
  Stages 3–4 **Y** for final sign-off.
- Depends-on: none on Stage-1-movement eye-test (this subsystem is render-side of the part
  pipeline). Seams: A5 owns the per-frame playback that DRIVES the partGroups Stage 2 creates
  (coordinate module API); A10 owns material/Surface decisions inside the rig module; A11
  consumes `root.partFrames` (Stage 2 must preserve that contract, entities.js:2804–2835).

## 6. SPECULATIVE / UNRESOLVED

- **`CSetup.anim_scale` consumer**: all acclient.c hits (334408–336087) are in the CSetup
  serialize/destroy region; I found no runtime consumer, and ours doesn't parse the field —
  likely PARITY-by-irrelevance, but unproven. Greps tried: `anim_scale` over acclient.c (9 hits,
  all serialize), over crates/ (0 hits).
- **`connection_points` retail runtime use**: only 7 acclient.c hits, all in CSetup
  pack/unpack/destroy — divergence #7 may be a non-gap on both sides. Single-cited; left at
  low confidence in the table per G9 precedent.
- **`CPartArray::MorphToExistingObject`** (acclient.c:326632 region, call at 316894): no
  holtburger equivalent found (`grep -ri morph scene3d/ crates/` → 0 relevant). Cannot cite a
  player-visible symptom (used by retail object-substitution flows I could not trace to a wire
  message in budget) — recorded here rather than the table.
- **Dedupe limitation**: `~/out/bughunt86-combat-render-loop-items-2026-06-09.md` and
  `~/out/grind-loop-2026-06-11.md` do not exist on this machine (they are laptop docs per §3.3);
  F-item/B-item/G-item dedupe was done against
  `~/out/holtburger-unsurfaced-render-audit-2026-06-09.md` only. Divergences #1 and #6 may
  collide with untransferred backlog items.
- **`CPhysicsPart::calc_draw_frame`** (acclient.c:315066) draw-pos offset semantics vs our
  direct partGroup transforms: not compared in budget (suspect PARITY via three.js world-matrix
  composition, unverified).
