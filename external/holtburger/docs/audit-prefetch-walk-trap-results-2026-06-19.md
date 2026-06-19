# Results — prefetch-walk resolver-mirroring trap audit

**Date:** 2026-06-19 · **Method:** 17-agent ultracode workflow (9 site-block audit + 5 flag-family audit, concurrent → adversarial per-GAP verify → synthesis).
**Input handoff:** [`handoff-prefetch-walk-trap-audit-2026-06-19.md`](./handoff-prefetch-walk-trap-audit-2026-06-19.md)
**Scope:** all 45 real `ensure_walk_prefetched[_keyed]` call sites in `apps/holtburger-web/src/lib.rs` (the handoff's "56" includes 11 comment/log-string grep hits) + 11 candidate URL flags.
**Outcome:** **2 confirmed GAPs, 0 refuted, all 11 flags MIRROR/N-A.** Seed fix `a0e0a0c1` verified present + correct at `lib.rs:16329`.

---

## Summary

This audit examined 45 prefetch-walk / sync-bake sites and 11 feature flags in `apps/holtburger-web/src/lib.rs` for the "prefetch-walk resolver-mirroring trap" (the same class of bug fixed in a0e0a0c1, where an async prefetch walk follows fewer record resolvers than the synchronous bake reads via cache-only `get_file_by_key`, causing silent record drops). Of the 45 sites, 2 were flagged as candidate GAPs and **both were confirmed by adversarial verify** (confirmedGap=true): `lib.rs:7367` (`fetch_surface_anim_frames`) and `lib.rs:8673` (`fetch_entity_degrade_for_distance`). All 11 flags MIRROR or are N/A — no flag introduces an un-walked record class; the a0e0a0c1 link-frame walk fix is present and correct at `lib.rs:16329`. Headline finding: **2 confirmed silent-drop gaps remain, both caused by empty (`|_| {}`) walk closures whose `initial` key list fails to cover a sub-record the sync bake derives and reads at bake time** (per-frame RenderSurfaces/palettes at 7367; the single-part `parts[0]` GfxObj at 8673). Zero refuted/false-positive candidates.

## Site table

| site (file:line) | enclosing fn | bake fn | bake resolvers | walk mirrors? | gap detail |
|---|---|---|---|---|---|
| lib.rs:7367 | fetch_surface_anim_frames | collect_surface_anim_frames | Surface 0x08; SurfaceTexture 0x05; Texture 0x06 for EVERY entry in surf_tex.textures; Palette per frame | **GAP** | Empty closure + initial=[0x08 surface] never prefetches the SurfaceTexture (0x05) NOR the per-frame RenderSurfaces (0x06) NOR their palettes. Prior `fetch_surface_pixels` warming only fetched `highest_res()` (the LAST 0x06); every non-last frame + palette is uncached -> bake bails on first un-cached frame -> frame_count 0 -> animated surfaces (water/lava/effects, ~2284 records) render frozen. |
| lib.rs:8673 | fetch_entity_degrade_for_distance | resolve_did_degrade(setup_id) | get_file_by_key(setup_id) [0x02 SetupModel]; get_file_by_key(first_part) [0x01 GfxObj parts[0]] | **GAP** | resolve_did_degrade's 0x02 branch reads a SECOND record (parts[0] GfxObj) whose id is derived at bake time and is NOT in initial=[setup_id]; empty closure discovers nothing, prefetch pulls only exact keys. Triggers for single-part 0x02 setups whose parts[0] has a real degrade chain -> read misses -> returns 0 -> no LOD substitution. |
| lib.rs:4334 | fetch_object_colours | resolve_model_color (loop) | resolve_model_color; walk_setup_model; walk_gfx_obj; lookup_surface_color; SurfaceTexture/Texture/Palette chasers | MIRRORS | — |
| lib.rs:7391 | fetch_surface_pixels | fetch_surface_pixels_impl | Surface 0x08; SurfaceTexture 0x05; Texture 0x06 (highest_res); Palette | MIRRORS | — |
| lib.rs:7475 | fetch_icon_pixels | fetch_icon_pixels_impl | Texture 0x06 (icon_did); Palette via to_rgba8 | MIRRORS | — |
| lib.rs:7505 | fetch_surfaces_pixels | fetch_surface_pixels_impl (loop) | Surface/SurfaceTexture/Texture(highest_res)/Palette per did | MIRRORS | — |
| lib.rs:7687 | fetch_font | fetch_font_impl | Font; decode_atlas(fg surface) Texture+to_rgba8; decode_atlas(bg surface) Texture+to_rgba8 | MIRRORS | — |
| lib.rs:7708 | fetch_string_table | none | StringTable::unpack (inline, no sub-record chase) | N/A | — |
| lib.rs:7760 | fetch_language_string | none | LanguageString::unpack (no sub-record chase) | N/A | — |
| lib.rs:7787 | fetch_action_map | none | ActionMap::unpack (string_table id serialized only, not fetched) | N/A | — |
| lib.rs:7912 | fetch_layout | none (inline) | LayoutDesc; MasterProperty 0x39000001; emit_element serializes media DataIds without fetching | MIRRORS | — |
| lib.rs:8079 | fetch_key_map | none | KeyMap::unpack (no sub-record chase) | N/A | — |
| lib.rs:8152 | fetch_combat_maneuver_table | CombatManeuverTable::unpack | get_file_by_key(table_id) [initial itself] | N/A | — |
| lib.rs:8195 | fetch_palette_set | PaletteSet::unpack | get_file_by_key(set_id) [initial itself] | N/A | — |
| lib.rs:8268 | fetch_clothing_table | ClothingTable::unpack | get_file_by_key(clothing_id) [initial itself] | N/A | — |
| lib.rs:8356 | fetch_dye_preview_pixels | SurfaceTexture->Texture->to_rgba8 compositor | SurfaceTexture; highest_res Texture; base intrinsic Palette; per-triple sub Palette | MIRRORS | — |
| lib.rs:8450 | fetch_palette | Palette::unpack | get_file_by_key(palette_id) [initial itself] | N/A | — |
| lib.rs:8495 | fetch_gfx_obj_degrade_info | GfxObjDegradeInfo::unpack | get_file_by_key(degrade_id) [0x11] | N/A | — |
| lib.rs:8620 | fetch_particle_degrade_distance | resolve_did_degrade(hw_gfx_obj_id) | get_file_by_key(hw_gfx_obj_id) [0x01 -> did_degrade] | MIRRORS | — |
| lib.rs:8627 | fetch_particle_degrade_distance | GfxObjDegradeInfo::unpack | get_file_by_key(degrade_id) [0x11] | N/A | — |
| lib.rs:8681 | fetch_entity_degrade_for_distance | GfxObjDegradeInfo::unpack | get_file_by_key(degrade_id) [0x11] | N/A | — |
| lib.rs:8920 | fetch_entity_surfaces_pixels | fetch_entity_surface_pixels_impl | Surface/SurfaceTexture/Texture(highest_res)/base+intrinsic Palette/sub-palettes | MIRRORS | — |
| lib.rs:9179 | fetch_entity_surfaces_pixels_batch | fetch_entity_surface_pixels_impl (per group) | Surface/SurfaceTexture/Texture/base Palette/sub-palettes | MIRRORS | — |
| lib.rs:9270 | collect_surface_dids_for_setups | post-await DID collection | GfxObj 0x01 (ids only); SetupModel 0x02; per-part GfxObj (ids only) | MIRRORS | — |
| lib.rs:9409 | fetch_model_mesh | triangulate_model + resolve_did_degrade | triangulate_model (GfxObj/SetupModel/MotionTable/Animation/part GfxObjs); resolve_did_degrade reach is strict subset | MIRRORS | — |
| lib.rs:9445 | fetch_model_did_degrades | resolve_did_degrade (loop) | resolve_did_degrade per id (same resolver) | MIRRORS | — |
| lib.rs:9473 | fetch_model_meshes | triangulate_model + resolve_did_degrade per id | triangulate_model reach; resolve_did_degrade subset | MIRRORS | — |
| lib.rs:9630 | fetch_building_placement | triangulate_model_per_part_buckets + compute_hinge_frames | SetupModel; per-part GfxObj; idle MotionTable+Animation; hinge re-reads SetupModel | MIRRORS | — |
| lib.rs:9843 | fetch_setup_model_lights | collect_setup_model_lights | SetupModel 0x02 (setup.lights inline, no sub-record) | MIRRORS | — |
| lib.rs:10063 | fetch_setup_holding_locations | collect_setup_holding_locations | SetupModel 0x02 (holding_locations inline) | MIRRORS | — |
| lib.rs:10200 | fetch_setup_placement_frames | collect_setup_placement_frames | SetupModel 0x02 (placement_frames inline) | MIRRORS | — |
| lib.rs:10308 | fetch_setup_part_sort_centers | collect_setup_part_sort_centers | GfxObj 0x01 OR SetupModel+per-part GfxObj + idle MotionTable/Animation | MIRRORS | — |
| lib.rs:11484 | populate_building_aabbs_for_landblock_impl (0x02) | walk_setup_parts_with_geom_and_physics | SetupModel; per-part GfxObj; idle MotionTable+Animation | MIRRORS | — |
| lib.rs:11787 | populate_statics_aabbs_for_landblock_impl (0x02) | walk_setup_parts_with_geom | SetupModel; per-part GfxObj; idle MotionTable+Animation | MIRRORS | — |
| lib.rs:14641 | fetch_entity_model_render | triangulate_model_with_substitutions_and_mtable | GfxObj OR SetupModel+per-part GfxObj(subs)+idle MotionTable/Animation; setup re-read for collision radius | MIRRORS | — |
| lib.rs:14851 | fetch_entity_cycle_frames | bake_cycle(WALK)+bake_cycle(RUN) | try_resolve_cycle_frames (MotionTable+Animation) + triangulate_setup_model_at_frame; no link resolver in path | MIRRORS | — |
| lib.rs:16277 | fetch_entity_animation_keyframes (raw-GfxObj branch) | build_entity_animation_data_inner_v2 (non-0x02) | triangulate_model_per_part_buckets (single GfxObj) | MIRRORS | — |
| lib.rs:16329 | fetch_entity_animation_keyframes (0x02 path) | build_entity_animation_data_inner_v2 (0x02) | triangulate_setup_model_per_part(setup+parts+idle+MotionTable); try_resolve_link_frames when from_motion_command!=0; else try_resolve_cycle_frames; Animation 0x03 chains | MIRRORS | a0e0a0c1 fix present: walk calls try_resolve_link_frames guarded by from_motion_command!=0 — correct |
| lib.rs:16507 | fetch_entity_animation_keyframes_batch | build_entity_animation_data_inner (from_motion_command=0) | raw: single GfxObj; 0x02: setup+parts+idle + try_resolve_cycle_frames (link not reached, fmc==0) | MIRRORS | — |
| lib.rs:42738 | fetch_physics_script | PhysicsScript::unpack | get_file_by_key(did) [initial itself] | N/A | — |
| lib.rs:42773 | fetch_particle_emitter | ParticleEmitter::unpack | get_file_by_key(did) [initial itself] | N/A | — |
| lib.rs:42861 | fetch_physics_script_table | PhysicsScriptTable::unpack | get_file_by_key(did) [initial itself] | N/A | — |
| lib.rs:42973 | fetch_wave | Wave::unpack | get_file_by_key(did) [initial itself] | N/A | — |
| lib.rs:43153 | fetch_sound_table | SoundTable::unpack | get_file_by_key(did) [initial itself] | N/A | — |
| lib.rs:43450 | fetch_region | Region::unpack | get_file_by_key(did) [initial itself] | N/A | — |

## Flag table

| flag | category | routes through bake? | adds record-need? | walk covers? | verdict | gap detail |
|---|---|---|---|---|---|---|
| unifiedMotion | default-on | yes | no | yes | MIRRORS | JS-side player selector; changes how baked keyframes are PLAYED, not which records fetched. All classes (attack/cast/door/missile/death/locomotion) route through fetch_entity_animation_keyframes; link classes hit try_resolve_link_frames warmed by a0e0a0c1 walk; cycle classes warmed by always-present cycle walk. No new bake, no un-walked record class. |
| getLink | default-off | yes | no | yes | MIRRORS | Only flips WHICH link-resolution hop runs inside try_resolve_link_frames (two-hop get_link vs single-hop motion_data_for_link); both reference MotionData already in the cached MotionTable record. Consumed in the SHARED resolver so walk and bake stay symmetric for both flag states; no additional record fetched. |
| surfaceUnified | default-off | no | no | n/a | N/A | JS render-layer flag; reroutes blend/emissive decode ladder through applySurfaceRenderState using already-decoded wasm inputs + already-fetched diffuse texture. Reads zero additional DAT records; no prefetch-walk gap possible. |
| forceDetail | default-off | no | no | n/a | N/A | JS render-layer flag; loads 5 static grayscale PNG assets via THREE.TextureLoader outside the wasm get_file_by_key cache. Adds no Surface/Texture/SurfaceTexture DAT record-need to any sync bake. |
| forcePom | default-off | no | no | n/a | N/A | JS render-layer flag; installs parallax-occlusion shader patch hard-gated on height/normal/diffuse textures already supplied from the wasm surface decode. Reads no new id, chases no sub-record; not on the prefetch-walk path. |
| dynLod | default-on | yes | no | yes | MIRRORS | fetch_entity_degrade_for_distance returns a substitute 0x01 GfxObj id (bakes no mesh); JS re-feeds it into the raw-GfxObj branch whose walk warms triangulate_model_per_part_buckets — the exact reach of that bake. A 0x01 LOD substitute collapses to single-part rig (no MotionTable/Animation chain). Changes WHICH setupId is baked, not its self-consistent walk. |
| rigModule | default-on | no | no | n/a | N/A | Pure JS transform-semantics refactor downstream of the wasm bake; reads no DAT record, makes no material decisions. Cannot add a record-need to any wasm prefetch walk. |
| entityLights | default-off | yes | no | yes | MIRRORS | collect_setup_model_lights reads exactly ONE record (SetupModel setup_id), same key the walk seeds and touches. LightInfo is parsed INLINE from the SetupModel reader (setup.lights HashMap) — no separate PointLight/EnvCell DAT record. Walk fully covers the bake's reach; the EnvCell-record hypothesis is false here. |
| wieldedSpawn | url-flag | yes | no | yes | N/A | Does NOT own a sync-bake-after-walk; only un-suppresses/synthesizes a KIND_SPAWN EntityUpdate carrying cached setup_did+mtable_id. Downstream mesh+anim bake is the SAME per-spawn fetch_entity_animation_keyframes call (walk warms cycle + link frames). Synthesized spawn is deliberately lossy (REDUCES record reach), never expands past the walk. |
| placementId | url-flag | yes | no | yes | MIRRORS | Routes through build_entity_animation_data_inner_v2 but only changes static rest-pose FRAME SELECTION ORDER in resolve_static_placement_frame, which reads ONLY setup.placement_frames (in-memory map on the already-warmed SetupModel). Chosen index is into that map, not a DAT id; no get_file_by_key for any new record. Bake reach identical to flag-off. |
| skipContainedSpawn | always-on | no | no | n/a | N/A | Integrated always-on; sole effect is to SUPPRESS the KIND_SPAWN EntityUpdate for a contained pack item, so the per-spawn anim/setup bake for that item never runs. Removes a bake invocation; cannot add an un-walked record-need. (Created the wieldedSpawn re-synthesis case, assessed under that flag.) |

## Confirmed GAPs (ranked by user-visibility)

### 1. lib.rs:7367 — fetch_surface_anim_frames (visibility: medium)
- **Trigger condition:** A SurfaceTexture (0x05) whose `textures` vec holds >=2 distinct same-dimension RenderSurface (0x06) DIDs (a genuine animated surface: water/lava/effect), when the JS material builder calls `_maybeSetupSurfaceAnimation -> fetchSurfaceAnimFrames(did)`. Single-frame/identical/differing-dim surfaces hit the gate at lib.rs:7320 and return `none` harmlessly. Prior `fetch_surface_pixels` warming only fetched `highest_res()` (the LAST 0x06), so every non-last frame + palette is uncached at bake time and `collect_surface_anim_frames` bails -> frame_count 0 -> ~2284 animated surfaces render frozen.
- **One-line warm fix (mirrors a0e0a0c1):** replace `|_| {}` at lib.rs:7367 with `|s| { let _ = collect_surface_anim_frames(s, surface_did); }` so the walk closure touches every 0x06 frame + palette the sync bake reads.
- **Visibility:** medium.

### 2. lib.rs:8673 — fetch_entity_degrade_for_distance (visibility: low)
- **Trigger condition:** A 0x02 SetupModel `setup_id` where `setup.parts.len()==1` and `parts[0]` is a 0x01 GfxObj that carries `did_degrade` (a real LOD chain) and was not boot-packed/otherwise prefetched. Called at entity spawn (entities.js:2825) and on tick (entities.js:10079) for every positioned entity; the bake's 0x02 branch derives `parts[0]` at bake time and does a SECOND `get_file_by_key(first_part)` not seeded in `initial=[setup_id]` -> miss -> returns 0 -> no LOD substitution for entities that should get one.
- **One-line warm fix (mirrors a0e0a0c1):** replace the empty closure at lib.rs:8673 with `|s| { let _ = resolve_did_degrade(s, setup_id); }` (touches parts[0] GfxObj); mirror at fetch_particle_degrade_distance's sibling 0x02 path if any.
- **Visibility:** low.

## GAP counts

| flag category | confirmed gaps |
|---|---|
| default-on | 0 |
| default-off | 0 |
| url-flag | 0 |
| always-on | 0 |
| site-level (not flag-owned) | 2 |
| **total confirmed gaps** | **2** |
| refuted / false-positive candidates | 0 |

Note: both confirmed gaps are site-level fetch-fn walk gaps (`fetch_surface_anim_frames`, `fetch_entity_degrade_for_distance`); neither is owned by any of the 11 audited flags, so all flag categories score 0.

## Refuted candidates

None. Both adversarial-verify candidates (lib.rs:7367 and lib.rs:8673) returned confirmedGap=true with no false-positive reason. No audit-flagged gap was refuted by verify, so there are no false positives to exclude from future investigation.
