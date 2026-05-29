# Holtburger-Web 3D Render — Fidelity Audit vs Canonical AC Sources

Date: 2026-05-28. Five parallel agents cross-referenced the renderer against the canonical
AC sources — acclient decomp (`~/ac-headers/acclient.c|.h|.txt`), melt, chorizite,
DatReaderWriter, and ACE — looking for **fidelity gaps vs retail**, not internal code bugs.
(That latter lens was the separate `3d-render-debug-findings-2026-05-28.md` sweep.)
Every headline finding below was independently re-verified against source by the lead
before inclusion. File paths are relative to `apps/holtburger-web/`.

## Headline theme

**The DAT-decode layer is faithful; the render-*consumption* layer drops fidelity.**
A striking number of gaps are "the data is already parsed in Rust but the renderer never
reads it." This means most fixes are wiring + a shader/material tweak, not new parsers —
low risk, high payoff. (Echoes the community note in memory: *"the code is in there, they
never used it."*)

Orphaned-but-decoded data confirmed by grep:
- Terrain alpha masks (`TerrainAlphaMask` structs + `take_corner/side/road`, `lib.rs:931-996`) — **0 JS callers**
- SetupModel `default_scale` (`setup_model.rs:302`) — only ever constructed empty in `lib.rs`, never applied
- Authored per-vertex normals (`SWVertex.normal`) — `lib.rs` triangulator only emits computed `tri_normal` (`:3573,:4825`)
- Multi-segment motion sequences — resolvers take `motion_data.anims.first()` only (`lib.rs:4164,4247,4405`)
- Wire sub-palette `offset`/`length` — applied raw, no `×8`, wrong source index (`lib.rs:6320-6327`)

---

## TIER 1 — high impact, mostly surgical

### T1 · Terrain TexMerge alpha-mask blend is decoded in Rust but never wired (HIGH, effort L)
- **holtburger:** terrain fragment shader does a 4-corner **bilinear cross-dissolve** of atlas color samples (`scene3d/terrain.js:845-855`). The full corner/side/road A8 alpha-mask decode exists (`src/lib.rs:931-996`, `fetch_terrain_alpha_masks`) with **zero JS callers**.
- **canonical:** `acclient.c` `TexMerge::FillTempTexBuffer`/`Merge`/`FindRoadAlpha`; `ACE/.../Physics/Common/TexMerge.cs:108-141,292-376`; chorizite `TextureMergeInfo.cs` + `VertexLandscape.cs`.
- **gap:** AC's defining terrain look — sharp, hand-authored, PRNG-varied + 90°-rotated transition masks between biomes — is absent; transitions are soft 24 m diamond gradients. The bilinear path is *documented as intentional* (terrain.js:1-22) but it's an approximation, not retail.
- **fix:** Wire `fetch_terrain_alpha_masks()` into the atlas/vertex build; port `FindTerrainAlpha` PRNG+rotation selection (TexMerge.cs:308); replace the corner lerp with `base + mix(base, overlay, alpha)`. Subsumes T2 (road). Adopt chorizite `VertexLandscape` packed-overlay layout.

### T2 · GfxObj polygons forced `DoubleSide`; retail single-sides ~83% (HIGH cull-rule / MED winding, effort M)
- **holtburger:** `scene3d/materials.js` hardcodes `side: THREE.DoubleSide` at 7 object/building sites (1050,1056,1185,1192,1217,1236,1442). The comment (1395-1402) claims "AC has no per-poly cull bit."
- **canonical:** `acclient.c:455346` — `if (sides_type == 1) CULLMODE_NONE; else CULLMODE_CW`. The polygon `sides_type` **is** the per-poly cull bit; only `==1` is two-sided. Census (real portal.dat): 83.5% of draw polys are single-sided.
- **gap:** Back faces of solid props show through alpha/translucent surfaces (windows, foliage, robes), light/shadow bleed-through, 2× transparent overdraw.
- **fix:** Carry `sides_type` per-triangle out of the Rust triangulator; `side = sides_type===1 ? DoubleSide : FrontSide`. Needs a winding-correction pass for FrontSide groups — **eye-test the front-face sign on a known solid first** (the only MED-confidence part).

### T3 · Wire sub-palette offset/length wrong → skin/hair/eyes/dyes mis-colored (HIGH, effort S)
- **holtburger:** `src/lib.rs:6320-6327` applies `off = offset` (no `×8`) and copies `sp.colors[i]` (source index from 0). Build sites `lib.rs:27097,27310`.
- **canonical:** `acclient.c:471761` `offset = 8 * v7`, numcolors `(==0?256:n)*8`; `Palette::Modify` (365117) copies `dst[i]=src[i]` over the **absolute** range `[offset, offset+numcolors)`. melt `SubPalette.cs:15-21` identical.
- **gap:** Two bugs compound. (a) Missing `×8`: a range meant for palette index 512 lands at 64, and only `len` (not `len×8`) entries recolor. (b) Wrong source: copies `src[0..len]` instead of `src[off..off+len]`. Affects **all** server-pushed coloring (skin tone, hair, eyes, dyed armor).
- **fix:** Push `offset*8` and `(length==0?256:length)*8` at the two EntityUpdate build sites (widen the triple from u8 to u16/u32 to hold ≤2048); change the copy to `composed.colors[off+i] = sp.colors[off+i]`.

### T4 · Multi-AnimData motions truncated to segment 0; reverse-framerate plays nothing (HIGH, effort L)
- **holtburger:** `src/lib.rs:4164,4247,4405` resolve only `motion_data.anims.first()`. `scene3d/animation.js:75` rejects `framerate <= 0` → null clip → `_tryPlayLink` (`entities.js:4353`) silently no-ops.
- **canonical:** `ACE/.../Sequence.cs:203-216,438` chains **all** AnimData via `AnimSequenceNode` list; `AnimSequenceNode.cs:33-37,72-78` + `Sequence.cs:393-421` play negative-framerate segments **in reverse** (legal; melt `MotionTable.cs:181`).
- **gap:** Empirical scan of all 436 retail MTs: **23%** of MotionData have >1 AnimData; **22%** of AnimData are negative-framerate. The player MT alone has 447 multi-anim + 430 reverse links → **every combat swing/cast and movement transition** plays only its first ~quarter, or not at all.
- **fix:** Concatenate frames across all `motion_data.anims` into one clip with a per-segment `times[]` array; reverse keyframe order + use `abs(framerate)` for negative segments; mark the cyclic-loop boundary so one-shot links precede the looping tail. (Subsumes the related zero-duration `high=-1` swing-timing trap — resolve `-1` via the Animation's `NumFrames` like melt `MotionTable.cs:162-182`.)

---

## TIER 2 — meaningful, scoped

### T5 · SetupModel per-part `default_scale` (flag 0x02) parsed but never applied (HIGH, effort S)
- `setup_model.rs:302` parses it; `lib.rs` only ever inits it empty. ACE `PartArray.cs:349-352,538-539` applies `GfxObjScale = DefaultScale[i] * objScale`. ~5% of setups (308 non-unit, 30 non-uniform) render at wrong proportions. Apply `vert.origin * scale` before part rotation in `walk_setup_parts`.

### T6 · Authored per-vertex normals discarded → faceted shading (HIGH parsed-unused / MED visual, effort M)
- `SWVertex.normal` is parsed but never read; the Rust triangulator broadcasts a computed face normal (`lib.rs:3573,4825`). Curved geometry (heads, pottery, trunks, creature bodies) renders faceted under `MeshStandardMaterial`. Carry `vert.normal` (rotated by part frame) through to per-vertex normals; fall back to face normal only when authored normal is zero-length.

### T7 · Terrain detail texture (GetDetailTex/GetDetailTiling) omitted (MED, effort M)
- No close-range diffuse detail texture; the "detail" layer is a synthetic 5-slice normal map only. `region.rs:547-549` already parses `detail_texture_id` + tiling. acclient `GetDetailTex(0)`/`GetDetailTiling(0)` apply one landscape detail tex globally. Fetch + modulate near-camera at `vGridUv * tiling`.

### T8 · "Terrain palette" tint uses the minimap/radar color, not PalShiftTerrainPal (HIGH mislabel / MED, effort S–M)
- `terrain.js:867-875` tints by `TerrainType.terrain_color`, which `region.rs:652-653` documents as **the radar/minimap color** — wrong source; at strength 0.25 it biases every biome toward its garish map hue. Real per-type differentiation (`PalShiftTerrainPal`, a 256-entry palette swap of a shared base texture; codes 0/24/31 all share `0x0500145C`) is unimplemented. Relabel/remove the minimap tint, or implement the per-type palette override at decode. (Aligns with the existing "terrain modulation is opt-in / sat-hue deferred" memory.)

### T9 · Entity LOD frozen at spawn distance (HIGH, effort M)
- `entities.js:1291-1343` picks the degrade band once at spawn (documented limitation). Statics already use a distance-dynamic `THREE.LOD` (`statics.js:533-642`). Wrap entity meshes the same way, baking each band once via the existing `fetch_entity_degrade_for_distance` export.

---

## TIER 3 — small correctness

### T10 · InvAlpha (0x200) surfaces render opaque (HIGH unhandled / MED impact, effort S–M)
- `materials.js:88` (`materialCanCastShadow`) already treats 0x200 as transparent, but `_materialFromFlags` (1446-1487) has no InvAlpha branch → renders opaque. Internal inconsistency. acclient `D3DPolyRender::SetSurface` (~454478) sets inverse SRCALPHA/INVSRCALPHA blend. First cut: route through the alpha-blend branch (treat as Alpha). Confirm retail occurrence count before investing in exact inverse blend.

### T11 · Velocity-scaled locomotion cycle speed (MED, effort M)
- Walk/run cycles play at fixed timeScale 1.0; retail scales cycle framerate by actual movement speed (`ACE AnimData.cs:17`, `MotionInterp.cs:525-558`). Produces "ice-skating" when speed ≠ base. `MotionData.velocity` already decoded. Apply `setEffectiveTimeScale(speedFactor)` on walk/run actions.

### T12 · `pickPaletteForShade` rounding off-by-one (HIGH / LOW, effort S)
- `ui/ac_palette_set.js:90-95` uses `floor(shade*len)`; AC uses `floor((len - 0.000001) * shade)` (acclient `PalSet::GetPaletteID` 470493; melt `PaletteSet.cs:43`). Off-by-one variant at exact shade boundaries (UI/dye-preview only — server resolves the Palette DID for spawns).

---

## Confirmed CORRECT (rejected as non-findings, to avoid re-litigating)

- Surface→material: ClipMap (alphaTest cutout), Translucent (opacity+depthWrite off), Luminous (emissive), Diffuse-as-albedo (documented approx), solid ColorValue (ARGB order), Additive, two-sidedness-on-polygon-not-surface — all retail-faithful.
- GfxObj: flat part placement (matches ACE — `parent_index` is physics metadata, not a visual parent), per-poly UV indexing, object-level scalar scale, Z-up→Y-up handedness (det=+1).
- Animation: `InterpolateDiscrete` keyframe snapping is correct (retail floors the frame, never lerps); MotionDataFlags `bitfield` bit0 is a state-composition flag, not a clip-playback gap.
- Palette: per-part GfxObj model swaps + old→new texture overrides applied correctly; dye-preview ClothingTable ranges are correctly raw (the `×8` is wire-path only).

---

## Suggested ordering (impact × inverse-cost)

1. **T3** sub-palette offset/length — tiny fix, fixes all character coloring, unit-testable.
2. **T5** default_scale — tiny fix, wrong proportions on multi-part objects.
3. **T10** InvAlpha — small, removes a live inconsistency.
4. **T4** multi-anim + reverse framerate — large but fixes ~every swing/cast/transition.
5. **T2** per-poly culling — corrects a baked-in misconception; needs one eye-test for winding sign.
6. **T6** authored vertex normals — broad smooth-shading win.
7. **T1** terrain TexMerge — biggest visual transform; the asset decode is already done.
8. T7, T8, T9, T11, T12 as follow-ons.

Many of T3/T4/T5/T10/T11/T12 are validatable via existing node tests
(`test_f7_8_surface_bitfield`, `test_ac_locomotion_*`, `test_terrain_palette`,
`test_examine_dye_preview`) — i.e. **without** visual testing.

---

# Fix log (2026-05-28) — test-validatable batch

Four fixes applied and validated without visual testing.

### T10 · InvAlpha (0x200) now alpha-blends (was opaque) — DONE
- `scene3d/materials.js` `_materialFromFlags`: added `isInvAlpha`, folded into the
  `isTranslucent || isAlpha` branch (transparent + depthWrite off), per acclient
  `D3DPolyRender::SetSurface @454478`. First cut treats it like Alpha; true inverse
  blend (`1 - texAlpha`) deferred until a retail count justifies a custom blend.
- **Validated:** `test_f7_8_surface_bitfield.mjs` — added an InvAlpha assertion; full
  suite green.

### T3 · Sub-palette offset/length + source index — DONE
- New canonical helper `Palette::splice_from(src, offset, count)` in
  `crates/holtburger-dat/src/file_type/palette.rs` — copies `dst[i]=src[i]` over the
  absolute range `[offset, offset+count)`, rejecting out-of-range wholesale (mirrors
  `Palette::Modify` + the `offset+numcolors <= num_colors` guard).
- **Entity (wire) path** `src/lib.rs` `fetch_entity_surface_pixels_impl`: offset/length
  now `×8` (`Subpalette::UnPack`: `offset = byte*8`, `numColors = (byte==0?256:byte)*8`)
  and copied via `splice_from` (absolute source index). Covers the batch path too (it
  delegates to `_impl`). Verified protocol reads raw `/8` bytes — no double-scale.
- **Dye-preview path** `fetch_dye_preview_pixels`: triple widened `(u32,u8,u8)`→
  `(u32,u32,u32)` (CloSubPaletteRange offsets are absolute uint32, were `u8`-truncated)
  and copied via `splice_from` (no ×8 — ClothingTable ranges are already absolute, per
  `ClothingTable::BuildObjDesc`).
- **Validated:** 4 new `splice_from` unit tests (dat crate, 230/230); 2 existing
  entity-compositor tests rewritten to canonical semantics and now actively catch both
  the ×8 and source-index bugs; `test_examine_dye_preview` (21/21) + `test_terrain_palette`
  (22/22) still green. **Eye-test caveat:** entity (skin/hair/eyes/dye) and dye-preview
  colours change vs before — verify on the 1070 after a wasm rebuild.

### T5 · SetupModel per-part `default_scale` (flag 0x02) now applied — DONE
- `src/lib.rs` `walk_setup_parts`: scales the part GfxObj's vertices in part-local space
  (before the placement frame) when a non-unit `default_scale[pi]` is present — matches
  ACE `PartArray` `GfxObjScale = DefaultScale[i]` + `AFrame.Combine` ordering. Confined to
  `walk_setup_parts` via a scoped scaled clone (no `on_part` signature change; covers all
  callers incl. AABB walkers). Face normals are recomputed post-transform, so positions
  suffice.
- **Validated:** new `default_scale_applies_to_part_geometry` unit test (web lib, 71/71).

### T12 · `pickPaletteForShade` rounding — DONE
- `ui/ac_palette_set.js`: `floor((count - 0.000001) * shade)` (exact port of
  `PaletteSet.cs:43` / `PalSet::GetPaletteID`), biasing exact boundaries to the lower
  bucket. **Validated:** boundary check vs the melt formula passes.

**Build:** `cargo check -p holtburger-web --target wasm32-unknown-unknown` clean. The
Rust fixes (T3, T5) require a `wasm-pack` rebuild of `pkg/` to go live at runtime.

### T4 · Multi-AnimData concatenation + reverse-framerate playback — DONE
The biggest gameplay-fidelity gap. Previously the resolve helpers used only
`motion_data.anims.first()` and the JS clip builder rejected `framerate <= 0` to a
null clip — so ~every multi-segment swing/cast/transition (23% of retail MotionData)
played only its first segment, and reverse segments (~22% of AnimData) didn't play.
- **New helper** `build_concatenated_motion_frames` (`src/lib.rs`): chains ALL
  `motion_data.anims` into one keyframe sequence with a per-frame **absolute time**
  array; each segment plays `[low, high]` inclusive (`high==-1` → to end), REVERSED
  when `framerate < 0`, timed at `1/|framerate|`. Mirrors ACE `Sequence` /
  `AnimSequenceNode` chaining + reverse playback.
- `try_resolve_cycle_frames` / `try_resolve_link_frames` now return
  `(frames, frame_times, duration, stance)` via the helper. The 2D sprite bake derives
  an effective uniform framerate from `duration` (exact for single-AnimData walk/run).
- 3D path: `EntityAnimationData`/inner gained `frameTimes` + `duration` (wasm getters);
  hooks are now timed off the per-segment cumulative time, not uniform `i/framerate`.
- JS `buildAnimationClip` (`scene3d/animation.js`): uses `frameTimes` for KeyframeTrack
  times + `duration` for clip length when present; falls back to uniform `i/framerate`
  for legacy/plain data. Removed the blanket `framerate<=0` null-return.
- **Validated:** new `motion_frames_concatenate_segments_and_reverse` Rust unit test
  (5-frame 2-segment concat with non-uniform per-segment times + reverse high→low) —
  web lib **72/72**; `test_phase7_4a_animation_clip.mjs` fixed (now strips the
  `./adapter.js` import so it actually runs) + new `frameTimes`/`duration` assertions,
  all green; `test_ac_locomotion_dispatch` 17/17, `test_ac_locomotion_per_stance` 7/7
  (no regression). Needs `wasm-pack` rebuild + 1070 eye-test to confirm visually.
- **Not included (follow-ons):** the swing-classifier `high==-1` zero-duration timing
  (`classify_motion_link_for_swing`, separate combat-bar path) and ACE `FirstCyclic`
  loop-tail marking for multi-segment *cycles* (rare; whole clip currently loops).

### T6 · Authored per-vertex normals → smooth shading (was faceted) — DONE
The triangulator computed ONE face normal per tri and broadcast it to all 3 vertices;
the authored `SWVertex.normal` (parsed, `graphics.rs`) was never read — so all curved
geometry (heads, pottery, trunks, creature bodies) rendered faceted under
`MeshStandardMaterial`.
- `Tri.normal: [f32;3]` → `Tri.normals: [[f32;3];3]` (per-vertex). The GfxObj appender
  (`append_gfx_tris_with_tex_swaps`) now carries the authored normal rotated by the part
  frame (direction-only), normalised, **falling back to the computed face normal per
  vertex when the authored normal is zero-length**. Back-face tris negate per-vertex.
  The Environment (EnvCell) triangulator broadcasts the face normal (unchanged behaviour).
- `pack_model_mesh` emits per-vertex normals (`triCount*9`, was `*3`); `meshToGeometryGroups`
  + `meshToFusedGeometry` (`scene3d/adapter.js`) copy them verbatim instead of broadcasting.
- T5 interaction: the `default_scale` clone now also inverse-scales the authored normal
  (component-wise reciprocal = inverse-transpose for a diagonal scale) so normals stay
  correct on non-uniform-scaled parts.
- **Validated:** new Rust `appender_uses_authored_vertex_normals` test (authored +X normal
  wins over the +Z face normal on all 3 verts; zero normal falls back to +Z) — web lib
  **73/73**; focused JS check confirms `meshToGeometryGroups` passes 3 distinct per-vertex
  normals through verbatim (no broadcast); `cargo check` wasm32 clean. `test_phase7_4b`
  fake-mesh normals updated 3→9 floats + harness `export async function` strip added, but
  that test remains non-running due to a separate pre-existing harness limitation (its
  `loadModule` import-strip predates entities.js's current imports) — out of T6 scope.
  Needs `wasm-pack` rebuild + 1070 eye-test to confirm visually.

### T1 · Terrain TexMerge selection core — DONE (composite/wiring = eye-test follow-on)
T1's payoff is purely visual (the iconic mask-driven biome boundaries), so it can't be
*fully* validated under "no visual testing". The split: the **deterministic selection**
(`pcode → base + alpha-masked overlays + per-overlay mask index + rotation + road
overlays`) is fully specified and unit-testable; the **pixel composite** + atlas/shader
wiring is convention-sensitive and needs eyes. I landed the former, complete and tested.
- New pure module `crates/holtburger-dat/src/terrain_merge.rs` — faithful port of ACE
  `TexMerge` (`GetTerrain`/`BuildTCodes`/`GetRoadCode`/`FindTerrainAlpha`/`FindRoadAlpha`)
  with **one correction from the retail decompile**: the index PRNG
  `1379576222 * pcode - 1372186442` is **32-bit unsigned wrapping** (`acclient.c:304712,
  304781,304804`), not ACE's 64-bit `long` — the wrapping form is what yields a
  distributed index in `[0,num)`. acclient is canonical here (matches the "trust acclient
  over ACE/DRW" memory).
- **Validated:** 9 unit tests — corner extraction, the wrap-PRNG (recomputed independently
  + a guard asserting it diverges from ACE's `long` form for large pcodes), `GetTerrain`
  single/two/all-distinct cases, corner + side rotation cycles (8→1→2→4 / 9→3→6→12),
  road codes, and end-to-end `texture_merge_info`. dat suite **239/239**; web wasm clean.
- **Remaining (needs eye-test):** (1) the pixel composite (`TexMerge::Merge` /
  `FillTempTexBuffer` / `ImgTex::MergeTexture`) — acclient-only (ACE's are server stubs),
  tiling + mask-rotation pixel conventions want visual confirmation; (2) wiring the merge
  into the atlas/shader and per-cell `pcode` data; (3) replacing the current bilinear
  cross-dissolve behind an opt-in flag, then the 1070 eye-test. The hard, ambiguous-until-
  now selection logic (incl. the PRNG correction) is the foundation those build on.

### T2 · Per-polygon back-face culling — DONE behind `?perPolyCull=on` (default off)
Objects were forced `DoubleSide` everywhere on the mistaken premise "AC has no per-poly
cull bit". acclient `D3DPolyRender` @455346 shows the polygon `sides_type` IS that bit
(`==1` → CULLMODE_NONE/two-sided; else CULLMODE_CW/single-sided), and ~83.5% of retail
draw polys are single-sided → DoubleSide causes see-through back faces on transparents,
2× transparent overdraw, light/shadow bleed.
- **Plumbed `sides_type` per-triangle** Rust→JS: `Tri.sides_type` (front/back/env set it)
  → `pack_model_mesh` (per-tri `sides_types` buffer) → `ModelMesh.sidesTypes` getter.
  Unit-tested (two-sided test asserts `sides_type==2`; appender test asserts `==1`).
- **`meshToGeometryGroups`** (`scene3d/adapter.js`): behind `?perPolyCull=on`, groups by
  `(surfaceIndex, cullMode)`, and renders single-sided polys FrontSide with **reversed
  winding** (output vertex order 0,2,1) — the exact convention terrain proved in F#27
  (AC emits CW-from-+Z; THREE FrontSide wants it reversed after `rotation.x=-π/2`). Each
  group is tagged `doubleSided`. `MaterialCache.getCached(did, doubleSided)` returns a
  cached FrontSide clone (shares textures) when single-sided. Entity consumers pass
  `g.doubleSided`. URL flag parsed in `scene3d/index.js`.
- **Default OFF = byte-identical to before** (one group/surface, DoubleSide, verbatim
  winding). Statics (fused path) + buildings/EnvCell (sides_type forced 1) intentionally
  stay DoubleSide this pass.
- **Validated:** focused JS test (OFF unchanged; ON splits by cull + reverses winding for
  single-sided + correct `doubleSided`) + getCached FrontSide-variant test + Rust
  plumbing tests; web lib **73/73**; wasm clean; `test_f7_8` regression PASS.
- **Eye-test gate:** objects have NEVER been winding-tested (always DoubleSide). The
  reversal mirrors terrain's proven convention, but confirm on the 1070 (`?perPolyCull=on`)
  that front faces show — if back-faces appear instead, flip the `order` reversal — before
  defaulting on.

### T11 · Velocity-scaled cycle speed — foundation only (blocked on speed source + eye-test)
Walk/run cycles play at fixed `timeScale 1.0`; retail scales the cycle framerate by
actual ground speed / authored cycle speed (`|MotionData.velocity|`) → "ice-skating" when
they differ. **This one can't be completed test-free this turn:** (a) the ACE
`AnimData`/`MotionInterp` refs aren't in this checkout, (b) entities.js exposes no
per-entity *linear* ground speed at the anim tick (only angular velocity / projectile
speed), and (c) the symptom is purely visual. Rather than ship inert wiring, I landed the
one non-dead, testable artifact:
- **`cycleTimeScale(actualSpeed, baseSpeed)`** pure helper (`scene3d/animation.js`):
  `|actual|/base`, clamped [0.25, 4.0], no-op (1.0) on zero/invalid base. Unit-tested
  (`test_phase7_4a`: 1×/2×/0.5×/clamps/no-op).
- **Remaining (needs eye-test):** surface `MotionData.velocity` magnitude to JS as the
  cycle `baseSpeed` (same pattern as T4's `duration`); wire a per-entity actual ground
  speed into the anim tick; apply `action.setEffectiveTimeScale(cycleTimeScale(...))` on
  walk/run actions; then eye-test the gait on the 1070.

### T8 · "Terrain palette" tint mislabeled + on-by-default → opt-in — DONE
The Wave 2.A per-biome tint was ON by default at 0.25 (`resolveTerrainRingOpts`) and the
shader/LUT comments claimed it applied "the canonical retail per-biome / retail-authored
palette colour." It actually samples `TerrainType.terrain_color`, which the DAT parser
documents as the **radar/minimap colour** (`region.rs:653`) — an approximation, not the
retail terrain tint. (The audit's "PalShiftTerrainPal" framing was off: `TerrainTex` has
no palette field — the retail per-biome differentiation for shared-base-texture codes is
the per-type **vertex bright/sat/hue modulation** `TerrainTex.{max,min}_vert_*`, i.e. the
existing opt-in `?terrainMod` path, with sat/hue deliberately deferred pending eye-test.)
- `scene3d/terrain.js`: the minimap-colour tint is now **opt-in via `?terrainPalette=on`
  (default off)** — `terrainPaletteStrength` resolves to 0 unless the flag is set
  (`readTerrainPaletteFlag`). Removes a non-faithful biome tint from the default render and
  aligns with the `?terrainMod` deferral intent. The misleading shader + LUT comments are
  corrected to name the real source (minimap colour) and the real mechanism (vert modulation).
- **Validated:** `test_terrain_palette` 22/22 (LUT + const unchanged; terrain.js parses).
  The default flips from tinted→untinted, so confirm on the 1070 (`?terrainPalette=on` for
  the old A/B) — but untinted = raw atlas = strictly more faithful, so default-off is the
  safe direction.

## Eye-test-gated tail (T1 composite, T7, T9 + the deferred apply/confirm of T2/T11)

The session has reached the boundary where the remaining audit items are **visual-outcome
changes that can't be validated without the 1070** — not a coincidence, but the natural
point where the deterministic, logic-level fidelity gaps are exhausted and what's left is
"does it look right" tuning. These should be done as one eye-test pass (rebuild pkg +
1070), not shipped blind:
- **T7 — terrain detail texture.** Data is available (`TerrainTex.detail_texture_id` +
  `detail_tex_tiling`, parsed) but never fetched/sampled. Doable as an opt-in
  (`?terrainDetailTex=on`) like T2 — fetch the landscape detail tex (acclient `GetDetailTex(0)`
  / `GetDetailTiling(0)`, one tex for the whole landscape) + a shader sampler with
  near-camera modulation — but the tiling rate / blend strength / fade distance are
  eye-test-tuned, so it's deferred to the eye-test pass.
- **T9 — dynamic entity LOD.** NOT a simple mirror of the statics `THREE.LOD` pattern:
  statics are non-animated, but an entity rig is driven by an `AnimationMixer` bound to
  specific per-part meshes — swapping LOD bands at runtime means rebinding the mixer, which
  is why the current code freezes the band at spawn (`entities.js:1291`). Effort-L +
  eye-test; deferred to a dedicated session.
- **Also gated:** T1 composite + atlas/shader wiring, T2 winding confirm + statics/buildings,
  T11 speed-source wire + apply.

**Recommendation:** run `wasm-pack build --target web --out-dir pkg --release` and an
eye-test pass on the 1070 to validate the shipped visual changes (T3/T4/T6 look, T8 default,
the `?perPolyCull`/`?terrainPalette` flags) before taking on more blind visual work.

---

# Headless eye-test pass (2026-05-28, evening)

Built a **headless GPU validation pipeline** so visual changes can be checked without
disturbing the user's visible browser: a dedicated off-screen Chrome (own port 9333 +
profile, `--window-position=-2400,-2400`, occlusion/throttle disabled so rAF + GPU keep
running) launched in the interactive Session 1 via Task Scheduler (`-LogonType Interactive`)
— SSH-launched Chrome dies in Session 0 with no GPU. Confirmed real GPU:
`ANGLE (NVIDIA GeForce GTX 1070, D3D11)`, not SwiftShader. Captures via
`__renderOnce()` + `canvas.toDataURL()` in one eval (plain `page.screenshot` is black —
WebGL `preserveDrawingBuffer=false`), scp'd back. Drove autoLogin → `@telepoi Holtburg`
(`handle.sendChat`) for a fully-baked outdoor scene (169 LBs, 69 entities).

**Results — wasm rebuilt with all 10 fixes, validated at Holtburg:**
- **T3 (sub-palette)** — character skin/hair/armor/shorts render with correct colours. ✓
- **T6 (authored normals)** — player + NPC bodies smooth-shaded (not faceted). ✓
- **T8 (terrain palette default-off)** — grass reads as natural green, not pushed toward the
  garish radar hue. ✓ (default-off is the more faithful render.)
- **T2 (per-poly cull) — WINDING CONFIRMED.** With `?perPolyCull=on`, Holtburg buildings,
  the character, 69 NPCs, and the lifestone all render **solid and correct** — no inside-out
  faces, no missing geometry, no see-through walls. The terrain-mirrored winding reversal is
  right → **T2 flipped to default ON** (`scene3d/index.js`; disable with `?perPolyCull=off`).
- Buildings, statics, terrain, Bruneton sky + clouds all render cleanly together.

**Pipeline is reusable** (scripts in `/mnt/wbterminal1/tmp/claude-scratch/eyetest/` + on the
1070 `C:\Temp\`): launch_eyetest_s1.ps1, tp3.mjs (teleport+composited shot), full-cull.mjs.

**Still pending (implementation, now unblocked by the working eye-test loop):** T1 composite
+ atlas/shader wiring, T7 detail texture, T9 dynamic entity LOD, T11 speed-source wire — each
can now be implemented and visually confirmed through this loop.

---

# T7 — terrain detail texture — DONE + eye-test-confirmed (2026-05-28, late)

Shipped behind `?terrainDetailTex=on` (default off → render byte-identical).

**Grounding (real retail data, `dump_detail_textures` example).** `GetDetailTex` is
**per-terrain-type** (`terrain_desc[n].detail_tex_gid`, acclient.c:304939), NOT one global
texture as the audit framing assumed — but retail authors only **3 distinct** detail textures
across the 33 codes: `0x050012AF` (64×64, 29 codes — the shared landscape detail),
`0x05001786` + `0x05001787` (256×256, the rock/grass/ice outliers codes 0/1/2/3). Per-code
`detail_tex_tiling` is mostly 1, with 2/4/8 outliers. So the shader binds a 3-layer
`sampler2DArray` + a `code→slice` LUT (mirrors the existing detail-NORMAL `uCodeToSlice`
pattern), NOT 33 layers.

**Implementation.**
- **Rust** `fetch_terrain_detail_textures()` (`src/lib.rs`) → `TerrainDetailTextures`
  {`slices` (unique decoded, terrainType = slice idx), `code_to_slice[33]` (255 = none),
  `code_tiling[33]`}. Pure host-testable `build_detail_texture_luts()` does the dedup. Decode
  pipeline mirrors `fetch_terrain_textures` (SurfaceTexture → highest-res Texture → palette).
- **adapter.js** `buildTerrainDetailArrayBytes()` packs the unique slices into a
  `DataArrayTexture` block (uniform 256² layers; byte-exact fast path, canvas resample for the
  64² slice).
- **terrain.js** binds the array + LUTs as `int[33]`/`sampler2DArray` uniforms; fragment does a
  **MODULATE2X** modulation of the merged base colour by the provoking-vertex code's detail
  slice (sampled at `vGridUv * tiling * baseScale`), with a `vViewDepth` distance fade
  (`DEFAULT_DETAIL_TEX_*` constants: baseScale 8, strength 0.5, fade 18→75 m). Mid-grey detail
  (0.5) → 1.0 neutral, so the base tile's mean brightness is preserved; far fragments fade to
  neutral. Built once + cached on `scene3d.terrainDetailTexState` (reused across ring rebuilds /
  lazy LB adds). **Plumb-through:** the export had to be added to the curated `init3D` wasmExports
  opts object in `index.html` (the Sky-J/H2/H3 trap — without it the flag silently no-ops).
- **Validated:** Rust host test `detail_texture_luts_dedup_and_map` (web 74/74); dat 239/239;
  JS `test_terrain_detail_tex.mjs` 17/17 (builder placement + MODULATE2X/fade contract).
  **1070 eye-test:** A/B at Holtburg (`t7-detail-off` vs `t7-detail-on2`, foreground crop in
  `eyetest/t7-compare-foreground.png`) — detail-ON adds clear grass-blade-scale grain near the
  camera, mean colour preserved, no tiling seams/aliasing, distant terrain unaffected (fade
  works). Materials confirmed `uDetailTexEnabled=1`, `uDetailTexSliceCount=3`, texture bound.
- **Remaining tuning (optional):** strength/baseScale/fade are JS constants (live-editable, no
  rebuild). 0.5 is a tasteful default; could push higher for the rock/grass tiling=4 codes.

**Infra note:** the no-cache dev server (`/tmp/nocache-server.py`) was a single-threaded
`HTTPServer` and wedged when the 3.6 MB wasm was pulled over the 1070 reverse tunnel (one slow
client stalled the only worker). Upgraded to `ThreadingHTTPServer`.

---

# T1 composite — DONE + eye-test-confirmed (2026-05-28, late) behind `?texMerge=on`

The biggest visual transform: AC's landscape does NOT bilinear-blend between cells — each 24 m
cell picks a base terrain tile + up to 3 alpha-masked overlays (one per differing corner),
composited with hand-authored A8 masks that are PRNG-selected + 90°-rotated per cell. That
mask-driven compositing is the iconic AC boundary look a 4-corner cross-dissolve can't reproduce.
The **selection core** (`terrain_merge.rs`, shipped earlier) is now wired through to the GPU.

**Implementation (full pipeline).**
- **Rust** (`terrain_merge.rs`): `pack_pcode(corners, road)` builds a cell pcode in acclient's
  layout (corners at bits 15/10/5/0 in order `[NW,NE,SE,SW]` per the tcode-bit authoring; road
  2-bit fields at 26/24/22/20). `pack_merge_record(info)` packs a `TextureMergeInfo` into 6 GPU
  slots `[base, overlay×3, road×2]`, each `[atlas_layer, alpha_mask_index, rotation, valid]`.
- **Rust** (`lib.rs`): `build_terrain_merge_data()` runs per LB in `build_mesh`, producing the
  48×8 RGBA8 `DataTexture` bytes (8 EW cells × 6 slots, row = NS cell), exposed via
  `LandblockMesh.terrainMergeData`. A merge that can't resolve degrades to a base-only slot.
- **adapter.js** `buildAlphaMaskArrayBytes()` packs the ordered masks `[corner0..3, side0,
  road0..2]` into a `DataArrayTexture` (layer index == the selection core's `alpha_index`).
- **terrain.js**: per-LB 48×8 merge `DataTexture` (NearestFilter) + shared 8-layer mask array
  (NoColorSpace — masks are weights, not colour). Fragment shader behind `uTexMergeEnabled`:
  samples base atlas layer, then for each terrain overlay samples the (rotation-baked) alpha
  mask and `mix()`es the overlay layer over the accumulator. `rotateCellUv()` does the 90°
  steps. `index.html`: both new exports threaded through the curated `init3D` opts (the
  plumb-through trap, again).
- **Roads this pass:** the merge data carries road slots 4–5, but the shader stops at terrain
  overlays — the **legacy in-shader road painter still owns roads** so the new variable (biome
  boundaries) is isolated for eye-test. Folding roads into the merge (and water UV-scroll under
  merge) are follow-ons.
- **Validated:** Rust `terrain_merge` 11/11 (incl. `pack_pcode_round_trips`,
  `pack_merge_record_*`), web 74/74, JS `test_terrain_texmerge.mjs` 19/19 (alpha-mask ordering +
  `rotateCellUv` contract). **1070 eye-test at Holtburg** (`eyetest/t1-compare.png`: bilinear
  top vs texMerge bottom): texMerge renders **cleanly** — buildings/character/69 NPCs/terrain
  all intact — with sharper, more granular tile variation vs the soft diamond cross-dissolve,
  and NO cell-grid-aligned seams or inverted patches (which would betray a wrong
  rotation/corner convention). Probe confirms `uTexMergeEnabled=1`, merge tex 48×8, mask array
  256²×8.
- **Caveat / follow-on tuning:** Holtburg's terrain is nearly uniform (LushGrass / Grassland /
  PatchyGrassland / SemiBarrenRock), so the composite reads as added variation rather than
  dramatic biome borders — the rotation-SIGN + corner-order conventions (best-guessed from the
  tcode bit semantics) render coherently here but would be definitively pinned at a
  grass↔dirt↔water biome edge. `rotateCellUv` 90°/270° branches and the `[NW,NE,SE,SW]` corner
  order are the two knobs to flip if a dramatic edge shows misplaced overlays.

---

# T11 — velocity-scaled cycle speed — PREMISE FALSIFIED (2026-05-28, late)

**The audit's T11 spec is wrong: retail does NOT author locomotion-cycle ground speed on
`MotionData.velocity`.** Grounded against the real `client_portal.dat`
(`dump_cycle_velocity` example): the player MotionTable `0x09000001` has **0 of 366 cycles**
with `HAS_VELOCITY` (and 0 of 962 links); only **1 of 8 modifiers** carries velocity — which
proves the parser reads velocity correctly when present, so the cycles genuinely lack it. A
creature MT (`0x09000115`) is the same. So `baseSpeed = |MotionData.velocity|` is **always 0**
for walk/run cycles → `cycleTimeScale` always returns 1.0 (no-op). Confirmed live on the 1070:
a probe drove the player forward — the EMA ground-speed signal ramped correctly (0 → ~1 m/s),
but `cycleBaseSpeed(playerMT, stance, RunForward) == 0`, so the applied timeScale stayed 1.0.

**What retail actually does** (`acclient.c`): `change_cycle_speed` (@337269) scales the cyclic
framerate by `new_speed / old_speed` via `CSequence::multiply_cyclic_animation_fr`, where
`speed` is the character's **run-rate-adjusted movement speed** from
`CMotionInterp::apply_run_to_command` (@343439 — multiplies the command speed by the weenie's
run_factor, and converts WalkForward to RunForward when speed > 0). It's a RELATIVE ratio with
no absolute authored base speed: the cycle's framerate starts at the AnimData rate at
first-play and tracks subsequent speed changes proportionally. There is no
`|MotionData.velocity|` baseline to divide by.

**What shipped (inert + documented), behind `?velScale=on` (default off):**
- `cycleTimeScale(actual, base)` helper (pre-existing, unit-tested) + Rust
  `motion_cycle_base_speed` + `cycleBaseSpeed` wasm export (returns `|MotionData.velocity|` —
  correct, but 0 for all real cycles) + a JS per-frame EMA ground-speed tick that applies
  `setEffectiveTimeScale(cycleTimeScale(...))` to the active loco cycle. The ground-speed infra
  + the export are a reusable foundation; the apply is a verified no-op until a real base-speed
  source exists. Tests: web 75/75 (`motion_cycle_base_speed_reads_velocity_magnitude`), dat
  11/11 (terrain_merge), JS contracts green.
- **To make T11 actually work** needs one of: (a) the faithful retail relative-ratio (track
  speed-at-play-start, scale by `current/initial`), or (b) a hardcoded per-cycle reference run
  speed (AC's known base speeds), eye-test-tuned. Both are beyond the audit's "surface velocity
  + apply" framing. **Recommendation: re-scope or defer T11** — the inert mechanism is harmless
  and the finding is the deliverable.
