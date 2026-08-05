#!/usr/bin/env node
// harness/run-js-headless.mjs — pure-Node (NO browser) flag-harness runner.
//
// ============================================================================
// Runs the existing already-green Tier-1 JS unit tests PLUS the two NEW Tier-4
// tests, each as its own `node <file>` child (exit 0 = PASS), aggregates the
// outcomes into a flag|file|status table, prints a summary, and exits non-zero
// if ANY test FAILS. This is the host-JS leg of the flag harness — the SIBLING
// of harness/cargo-tests.mjs (native Rust coverage) and harness/playwright/
// drive.mjs (the in-browser leg). It needs neither a wasm rebuild nor a server:
// every listed file is a self-contained Node unit test (the .mjs ones import
// app modules with three-stub shims; the .cjs ones under tests/ are CommonJS).
//
// WHY A SEPARATE RUNNER: these are deterministic, dependency-free unit tests
// that assert JS-side flag logic (input funnel, hook windows/fire-queue,
// surface bitfield fold, script-manager queue, particle ownership/degrade,
// pre-create buffer, run-keys, root-motion, pursuit monitor, rig module,
// camera retail math, remote-interp ownership, jump-charge parity) and the two
// new Tier-4 blocking-particle / default-script-spawn tests. They run green
// today against the CURRENT pkg/; this runner is meant to be invoked AFTER the
// user's separate wasm rebuild as a fast regression gate, but it does not
// depend on that rebuild.
//
// IMPORTANT — cwd: each child is spawned with cwd = apps/holtburger-web (the
// app root) so the tests' RELATIVE imports (e.g. ./loop.js, ./_three_stub*.mjs,
// ../<module>) resolve exactly as they do when run by hand. File paths in the
// embedded list are relative to that same app root.
//
// MISSING-FILE TOLERANCE: the two Tier-4 files are authored in a parallel wave
// and may not exist yet when this runner is invoked. A missing file is reported
// as a distinct MISSING row (and, by default, does NOT fail the run) — never a
// crash. Use --strict-missing to treat a missing file as a failure (e.g. once
// the Tier-4 authors have landed their files and you want the gate to enforce
// their presence).
//
// USAGE
//   node harness/run-js-headless.mjs [--only=substr,substr] [--tier=1|4|all]
//                                    [--quiet] [--list] [--strict-missing]
//                                    [--timeout=MS] [--bail] [--allow-skips]
//
//   --only=...        Run only files whose path OR flag contains any listed
//                     substring (comma-separated, case-insensitive).
//   --tier=1|4|all    Restrict to Tier-1, Tier-4, or both (default: all).
//   --quiet           Suppress each child's own stdout/stderr on PASS (failures
//                     and MISSING always print their captured output).
//   --list            Print the resolved test plan (tier/flag/file/exists) and
//                     exit 0 without running anything.
//   --strict-missing  Treat a MISSING file as a FAIL (default: MISSING is
//                     tolerated and does not affect the exit code).
//   --timeout=MS      Per-test wall-clock timeout (default 120000). On timeout
//                     the test is a FAIL (killed).
//   --bail            Stop at the first FAIL (still prints the partial table).
//   --allow-skips     Tolerate a child that printed a SKIP banner and exited 0.
//                     OFF by default: such a child asserted NOTHING, so
//                     counting it as a pass is exactly the defect the
//                     2026-08-03 review found (F5).
//
// EXIT CODE: 0 unless at least one test FAILED, or a test SKIPPED (unless
// --allow-skips), or -- under --strict-missing -- a file was MISSING.
// MISSING alone (default) and an empty plan exit 0.
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// harness/ → apps/holtburger-web/ (the app root; child cwd + path base).
const APP_ROOT = path.resolve(HERE, "..");

// ---------------------------------------------------------------------------
// EMBEDDED TEST PLAN (authoritative). Paths are relative to APP_ROOT.
// `tier` 1 = already-green unit tests; `tier` 4 = new (may be MISSING).
// ---------------------------------------------------------------------------
const TIER1 = [
  { flag: "inputFunnel", file: "test_a14_i1_input_controller.mjs" },
  { flag: "inputFunnelV2", file: "test_input_funnel_v2.mjs" },
  { flag: "hookDrain", file: "test_hook_windows.mjs" },
  { flag: "hookDrain", file: "test_hook_fire_queue.mjs" },
  { flag: "surfaceUnified+surfaceParityV2", file: "test_f7_8_surface_bitfield.mjs" },
  { flag: "scriptQueue", file: "test_script_manager.mjs" },
  { flag: "particleOwner", file: "test_particle_owner.mjs" },
  { flag: "preCreateBuffer", file: "test_a8_m4_pre_create_buffer.mjs" },
  { flag: "retailRunKeys(JS)", file: "test_a14_i3_run_keys.mjs" },
  { flag: "particleDegrade(JS)", file: "test_a11_s4_particle_degrade.mjs" },
  { flag: "rootMotionObject(JS)", file: "test_a5_p3_root_motion.mjs" },
  { flag: "wasmPursuit(monitor)", file: "test_a14_i2_pursuit_monitor.mjs" },
  { flag: "rigModule", file: "test_a9_stage2_setup_rig.mjs" },
  { flag: "retailCamZoom+camStiffness+mouseSmooth", file: "tests/camera_retail_math.test.cjs" },
  { flag: "remoteInterp(JS)", file: "tests/remote_interp_ownership.test.cjs" },
  { flag: "jumpParity(JS)", file: "tests/jump_charge_parity.test.cjs" },
  { flag: "unifiedMotion(poser)", file: "test_motion_sequence.mjs" },
  // Exercises the REAL compiled wasm MotionSequence boundary (entities.js path);
  // SKIPs (exit 0) gracefully when pkg/ isn't built, so it's safe in the pure-JS tier.
  { flag: "unifiedMotion(wasm)", file: "test_motion_sequence_wasm_smoke.mjs" },
  // VFX (Visual-Behavior Suite) — tree-wind + the component system (2026-06-23).
  { flag: "treeWind(JS)", file: "test_wind_clip_gen.mjs" },
  { flag: "treeWindRig(JS)", file: "test_bbox_rig.mjs" },
  { flag: "treeWindOffFrozen(JS)", file: "test_wind_off_frozen.mjs" },
  { flag: "vfxComponent(JS)", file: "test_vfx_windbend.mjs" },
  { flag: "vfxMaterialSubstrate(JS)", file: "test_vfx_material_substrate.mjs" },
  { flag: "vfxCatalog(JS)", file: "test_vfx_catalog.mjs" },
  { flag: "vfxLegacySafety(JS)", file: "test_vfx_legacy_safety.mjs" },
  { flag: "vfxShadowPass(JS)", file: "test_vfx_shadow_pass.mjs" },
  { flag: "vfxOscillators(JS)", file: "test_vfx_oscillators.mjs" },
  { flag: "vfxPerInstanceHash(JS)", file: "test_vfx_per_instance_hash.mjs" },
  { flag: "vfxFragInstall(JS)", file: "test_vfx_frag_install.mjs" },
  { flag: "vfxVertexInstall(JS)", file: "test_vfx_vertex_install.mjs" }, // P2.1 MECH-B firewall
  { flag: "vfxTipFlex(JS)", file: "test_vfx_tipflex.mjs" },              // P2.2 deformation.tipFlex
  { flag: "vfxFragAttach(JS)", file: "test_vfx_frag_attach.mjs" },
  { flag: "vfxGlint(JS)", file: "test_vfx_glint.mjs" },
  { flag: "vfxMagicGlow(JS)", file: "test_vfx_magicglow.mjs" },
  { flag: "vfxEnchantShimmer(JS)", file: "test_vfx_enchantshimmer.mjs" },
  { flag: "vfxTarnish(JS)", file: "test_vfx_tarnish.mjs" },
  { flag: "vfxWetness(JS)", file: "test_vfx_wetness.mjs" },
  { flag: "vfxFrost(JS)", file: "test_vfx_frost.mjs" },
  { flag: "vfxFlameFlicker(JS)", file: "test_vfx_flameflicker.mjs" },
  { flag: "vfxWeatherInputs(JS)", file: "test_vfx_weather_inputs.mjs" },
  { flag: "vfxFlags(JS)", file: "test_vfx_flags.mjs" },
  { flag: "vfxCostModel(JS)", file: "test_vfx_cost_model.mjs" },
  { flag: "vfxFirewall(JS)", file: "test_vfx_firewall.mjs" },
].map((t) => ({ ...t, tier: 1 }));

// New files (authored in parallel). Referenced by path even if not present yet:
// the runner reports a missing file as a MISSING row, never a crash.
const TIER4 = [
  { flag: "blockingParticleParity", file: "test_a11_s0_blocking_particle.mjs" },
  { flag: "defaultScriptSpawn", file: "test_a11_s5_default_script_spawn.mjs" },
  { flag: "acWindowPositionMerge(R11)", file: "test_ac_window_position_merge.mjs" },
  { flag: "aliasSplit(JS)", file: "test_p1_alias_split.mjs" },
  // 2026-08-03 (R8#5) — the combat/gore cluster. limbs, blood_decals and
  // ragdoll_env were 2,400 lines of DEFAULT-ON code with no suite at all, and
  // the four pre-existing siblings below were never registered either: 522
  // assertions that nothing ran automatically. A test that no runner invokes
  // protects nothing, which is the same "exists but never executes" shape this
  // round keeps finding in the product code.
  { flag: "carnage(finisher)", file: "tests/carnage_finisher.test.mjs" },
  { flag: "carnage(hitGuard)", file: "tests/carnage_hit_guard.test.mjs" },
  { flag: "limbs", file: "tests/limbs.test.mjs" },
  { flag: "bloodDecals", file: "tests/blood_decals.test.mjs" },
  { flag: "ragdollEnv", file: "tests/ragdoll_env.test.mjs" },
  { flag: "ragdollEnergy", file: "tests/ragdoll_energy.test.mjs" },
  { flag: "killImpulse", file: "tests/kill_impulse.test.mjs" },
  { flag: "gfxRelief", file: "tests/gfx_relief.test.mjs" },
  { flag: "combatInstallGiveup", file: "tests/combat_install_giveup.test.mjs" },
].map((t) => ({ ...t, tier: 4 }));


// ---------------------------------------------------------------------------
// TIER 5 — suites that existed but NO runner invoked (2026-08-03 round 9)
// ---------------------------------------------------------------------------
// A hand-maintained list is exactly the thing that rotted: 169 of the tree's
// 212 `test_*.mjs` files were registered nowhere, so ~4 out of every 5 suites
// were dead weight — written, passing, and protecting nothing. That is the
// same "exists but never executes" shape this review round keeps finding in
// product code, and it is why COVERAGE_GUARD below now makes the list
// self-maintaining: a new suite that nobody registers is a loud row, not a
// silent omission.
//
// Every entry here was executed first and exited 0. Hollow passes are NOT
// laundered by that: the runner's existing SKIP detection (exit 0 having
// asserted nothing — `--allow-skips`) still fails them, which is the correct
// outcome for the two suites that silently no-op when THREE_PATH is absent.
const TIER5 = [
  { tier: 5, flag: "xu7_transcode", file: "test_xu7_transcode.mjs" },
  { tier: 5, flag: "bc7_pre_phase", file: "test_bc7_pre_phase.mjs" },
  { tier: 5, flag: "atlas_bc7_pre_gate", file: "test_atlas_bc7_pre_gate.mjs" },
  { tier: 5, flag: "terrain_bc7_aniso", file: "test_terrain_bc7_aniso.mjs" },
  { tier: 5, flag: "r10_index_orchestrator", file: "test_r10_index_orchestrator.mjs" },
  { tier: 5, flag: "loading_screen_portal_event", file: "test_loading_screen_portal_event.mjs" },
  { tier: 5, flag: "c1_facing_camera", file: "tests/test_c1_facing_camera.cjs" },
  { tier: 5, flag: "cast_busy_clock", file: "tests/test_cast_busy_clock.mjs" },
  { tier: 5, flag: "cast_diag", file: "tests/test_cast_diag.mjs" },
  { tier: 5, flag: "drop_guard_item_tags", file: "tests/test_drop_guard_item_tags.mjs" },
  { tier: 5, flag: "ws01_note_gating", file: "tests/test_ws01_note_gating.mjs" },
  { tier: 5, flag: "ws01_windup_link_coverage", file: "tests/test_ws01_windup_link_coverage.mjs" },
  { tier: 5, flag: "ws02_cast_echo_dedup", file: "tests/test_ws02_cast_echo_dedup.mjs" },
  { tier: 5, flag: "ws04_magic_gesture_lengths", file: "tests/test_ws04_magic_gesture_lengths.mjs" },
  { tier: 5, flag: "ws05_spell_range", file: "tests/test_ws05_spell_range.mjs" },
  { tier: 5, flag: "ws06_cast_facing", file: "tests/test_ws06_cast_facing.mjs" },
  { tier: 5, flag: "ws07_remote_cast_links", file: "tests/test_ws07_remote_cast_links.mjs" },
  { tier: 5, flag: "ws08_cast_reject", file: "tests/test_ws08_cast_reject.mjs" },
  { tier: 5, flag: "ws09_formula_scale_parity", file: "tests/test_ws09_formula_scale_parity.mjs" },
  { tier: 5, flag: "ws09_play_effect_sound", file: "tests/test_ws09_play_effect_sound.mjs" },
  { tier: 5, flag: "ws10_projectile_impact_stop", file: "tests/test_ws10_projectile_impact_stop.mjs" },
  { tier: 5, flag: "ws11_cast_gesture_timing_parity", file: "tests/test_ws11_cast_gesture_timing_parity.mjs" },
  { tier: 5, flag: "ws12_cast_audio", file: "tests/test_ws12_cast_audio.mjs" },
  { tier: 5, flag: "ws13_spell_cast_sequence_vs_dat", file: "tests/test_ws13_spell_cast_sequence_vs_dat.cjs" },
  { tier: 5, flag: "allegiance_panel", file: "tests/allegiance_panel.test.cjs" },
  { tier: 5, flag: "allegiance_presence_event", file: "tests/allegiance_presence_event.test.mjs" },
  { tier: 5, flag: "blip_color", file: "tests/blip_color.test.mjs" },
  { tier: 5, flag: "buffs_hud", file: "tests/buffs_hud.test.cjs" },
  { tier: 5, flag: "bufftime_f1", file: "tests/bufftime_f1.test.mjs" },
  { tier: 5, flag: "character", file: "tests/character.test.cjs" },
  { tier: 5, flag: "character_creation", file: "tests/character_creation.test.cjs" },
  { tier: 5, flag: "character_creation_reopen", file: "tests/character_creation_reopen.test.mjs" },
  { tier: 5, flag: "character_info_tab_labels", file: "tests/character_info_tab_labels.test.mjs" },
  { tier: 5, flag: "col20_remote_turn_gate", file: "tests/col20_remote_turn_gate.test.cjs" },
  { tier: 5, flag: "combat_bar_skill_stride", file: "tests/combat_bar_skill_stride.test.mjs" },
  { tier: 5, flag: "combat_hud_power_ownership", file: "tests/combat_hud_power_ownership.test.mjs" },
  { tier: 5, flag: "contracts_panel", file: "tests/contracts_panel.test.cjs" },
  { tier: 5, flag: "corpse_loot_snapshot", file: "tests/corpse_loot_snapshot.test.mjs" },
  { tier: 5, flag: "dye_preview_dragover_throttle", file: "tests/dye_preview_dragover_throttle.test.mjs" },
  { tier: 5, flag: "emote_table", file: "tests/emote_table.test.cjs" },
  { tier: 5, flag: "entity_anim_targets", file: "tests/entity_anim_targets.test.cjs" },
  { tier: 5, flag: "hotbar_bind_sigil_guard", file: "tests/hotbar_bind_sigil_guard.test.mjs" },
  { tier: 5, flag: "indoor_nav_no_pose", file: "tests/indoor_nav_no_pose.test.mjs" },
  { tier: 5, flag: "inventory_paperdoll_helpers", file: "tests/inventory_paperdoll_helpers.test.cjs" },
  { tier: 5, flag: "keymap_manifest", file: "tests/keymap_manifest.test.cjs" },
  { tier: 5, flag: "layout_state_inheritance", file: "tests/layout_state_inheritance.test.cjs" },
  { tier: 5, flag: "plugin_facade_contract", file: "tests/plugin_facade_contract.test.cjs" },
  { tier: 5, flag: "plugin_loader", file: "tests/plugin_loader.test.cjs" },
  { tier: 5, flag: "plugin_query_wire", file: "tests/plugin_query_wire.test.cjs" },
  { tier: 5, flag: "rust_pose", file: "tests/rust_pose.test.cjs" },
  { tier: 5, flag: "soa_aos_parity", file: "tests/soa_aos_parity.test.cjs" },
  { tier: 5, flag: "spellbook_wasm_record", file: "tests/spellbook_wasm_record.test.cjs" },
  { tier: 5, flag: "target_cycle", file: "tests/target_cycle.test.cjs" },
  { tier: 5, flag: "test_ws14_cast_cooldown", file: "tests/test_ws14_cast_cooldown.test.mjs" },
  { tier: 5, flag: "test_ws14_ui_feedback", file: "tests/test_ws14_ui_feedback.test.cjs" },
  { tier: 5, flag: "unwedge_reflex", file: "tests/unwedge_reflex.test.mjs" },
  { tier: 5, flag: "vendor_profile", file: "tests/vendor_profile.test.cjs" },
  { tier: 5, flag: "vendor_queue_vendor_switch", file: "tests/vendor_queue_vendor_switch.test.mjs" },
  { tier: 5, flag: "world-state", file: "tests/world-state.test.cjs" },
  { tier: 5, flag: "world_object", file: "tests/world_object.test.cjs" },
  { tier: 5, flag: "world_object_property_dict", file: "tests/world_object_property_dict.test.cjs" },
  { tier: 5, flag: "world_objects_typed_hierarchy", file: "tests/world_objects_typed_hierarchy.test.cjs" },
  { tier: 5, flag: "ws15_dot_enchantment_label", file: "tests/ws15_dot_enchantment_label.test.cjs" },
  { tier: 5, flag: "ac_resize_anchor", file: "test_ac_resize_anchor.mjs" },
  { tier: 5, flag: "ac_font_render_retry", file: "test_ac_font_render_retry.mjs" },
  { tier: 5, flag: "ac_strings_no_latch", file: "test_ac_strings_no_latch.mjs" },
  { tier: 5, flag: "ac_dat_runtime_no_latch", file: "test_ac_dat_runtime_no_latch.mjs" },
  { tier: 5, flag: "graphics_settings_live_flags", file: "test_graphics_settings_live_flags.mjs" },
  { tier: 5, flag: "ac_dye_viewport_race", file: "test_ac_dye_viewport_race.mjs" },
  { tier: 5, flag: "bot_escape_rung", file: "rynth/test_bot_escape_rung.mjs" },
  { tier: 5, flag: "nav_frame_clamp", file: "rynth/test_nav_frame_clamp.mjs" },
  { tier: 5, flag: "webhost_pose_free", file: "rynth/test_webhost_pose_free.mjs" },
  { tier: 5, flag: "a15_q2_entity_update_clone", file: "test_a15_q2_entity_update_clone.mjs" },
  { tier: 5, flag: "a15_q4_renderer_neutral_core", file: "test_a15_q4_renderer_neutral_core.mjs" },
  { tier: 5, flag: "a8_m3_kind17_dispatch", file: "test_a8_m3_kind17_dispatch.mjs" },
  { tier: 5, flag: "ac_aim_level_for_velocity", file: "test_ac_aim_level_for_velocity.mjs" },
  { tier: 5, flag: "ac_attack_type_for_weapon", file: "test_ac_attack_type_for_weapon.mjs" },
  { tier: 5, flag: "ac_damage_rating", file: "test_ac_damage_rating.mjs" },
  { tier: 5, flag: "ac_floaty_frame", file: "test_ac_floaty_frame.mjs" },
  { tier: 5, flag: "ac_layout_strings", file: "test_ac_layout_strings.mjs" },
  { tier: 5, flag: "ac_spell_cast_sequence", file: "test_ac_spell_cast_sequence.mjs" },
  { tier: 5, flag: "ac_spell_shape", file: "test_ac_spell_shape.mjs" },
  { tier: 5, flag: "adapter_atlas_guard", file: "test_adapter_atlas_guard.mjs" },
  { tier: 5, flag: "adaptive_res_settle", file: "test_adaptive_res_settle.mjs" },
  { tier: 5, flag: "ambient_baked", file: "test_ambient_baked.mjs" },
  { tier: 5, flag: "ambient_frame", file: "test_ambient_frame.mjs" },
  { tier: 5, flag: "ambient_liveness", file: "test_ambient_liveness.mjs" },
  { tier: 5, flag: "animated_scenery", file: "test_animated_scenery.mjs" },
  { tier: 5, flag: "animated_scenery_park", file: "test_animated_scenery_park.mjs" },
  { tier: 5, flag: "atmosphere_pipeline_passes", file: "test_atmosphere_pipeline_passes.mjs" },
  { tier: 5, flag: "audio_optimistic", file: "test_audio_optimistic.mjs" },
  { tier: 5, flag: "bake_transfer", file: "test_bake_transfer.mjs" },
  { tier: 5, flag: "bake_worker_client_queue", file: "test_bake_worker_client_queue.mjs" },
  { tier: 5, flag: "bm_colortexture_fix", file: "test_bm_colortexture_fix.mjs" },
  { tier: 5, flag: "brazier_emit", file: "test_brazier_emit.mjs" },
  { tier: 5, flag: "cast_level8_windup", file: "test_cast_level8_windup.mjs" },
  { tier: 5, flag: "cast_overlay_guard", file: "test_cast_overlay_guard.mjs" },
  { tier: 5, flag: "cell_lights", file: "test_cell_lights.mjs" },
  { tier: 5, flag: "cloud_overlay_dispose", file: "test_cloud_overlay_dispose.mjs" },
  { tier: 5, flag: "cloud_storm_look", file: "test_cloud_storm_look.mjs" },
  { tier: 5, flag: "config_merge", file: "test_config_merge.mjs" },
  { tier: 5, flag: "decode_admission_flags", file: "test_decode_admission_flags.mjs" },
  { tier: 5, flag: "diag_combat_giveup", file: "test_diag_combat_giveup.mjs" },
  { tier: 5, flag: "diag_events_diff_lbfilter", file: "test_diag_events_diff_lbfilter.mjs" },
  { tier: 5, flag: "diag_spawn_classifier", file: "test_diag_spawn_classifier.mjs" },
  { tier: 5, flag: "f2_turn_to_align", file: "test_f2_turn_to_align.mjs" },
  { tier: 5, flag: "first_bake_batch_flags", file: "test_first_bake_batch_flags.mjs" },
  { tier: 5, flag: "fixed_grid", file: "test_fixed_grid.mjs" },
  { tier: 5, flag: "gemsparkle_emit", file: "test_gemsparkle_emit.mjs" },
  { tier: 5, flag: "ground_fog", file: "test_ground_fog.mjs" },
  { tier: 5, flag: "hotbar_fire", file: "test_hotbar_fire.mjs" },
  { tier: 5, flag: "init3d_idempotency_guard", file: "test_init3d_idempotency_guard.mjs" },
  { tier: 5, flag: "journal_panel", file: "test_journal_panel.mjs" },
  { tier: 5, flag: "landblock_lru_evict", file: "test_landblock_lru_evict.mjs" },
  { tier: 5, flag: "landblock_lru_geom_governor", file: "test_landblock_lru_geom_governor.mjs" },
  { tier: 5, flag: "landblock_lru_null_lb", file: "test_landblock_lru_null_lb.mjs" },
  { tier: 5, flag: "landblock_lru_park_storm", file: "test_landblock_lru_park_storm.mjs" },
  { tier: 5, flag: "landblock_lru_pool_scan", file: "test_landblock_lru_pool_scan.mjs" },
  { tier: 5, flag: "landblock_lru_sealed_keepring", file: "test_landblock_lru_sealed_keepring.mjs" },
  { tier: 5, flag: "landblock_lru_sealed_park", file: "test_landblock_lru_sealed_park.mjs" },
  { tier: 5, flag: "landblock_lru_server_urgency", file: "test_landblock_lru_server_urgency.mjs" },
  { tier: 5, flag: "landblock_lru_warmpark_dualstate", file: "test_landblock_lru_warmpark_dualstate.mjs" },
  { tier: 5, flag: "lb_objects_shared", file: "test_lb_objects_shared.mjs" },
  { tier: 5, flag: "leak01_bridge_index_prune", file: "test_leak01_bridge_index_prune.mjs" },
  { tier: 5, flag: "lifestone_popup", file: "test_lifestone_popup.mjs" },
  { tier: 5, flag: "light_pool", file: "test_light_pool.mjs" },
  { tier: 5, flag: "lore_panel", file: "test_lore_panel.mjs" },
  { tier: 5, flag: "lru_light_eviction", file: "test_lru_light_eviction.mjs" },
  { tier: 5, flag: "map_panel", file: "test_map_panel.mjs" },
  { tier: 5, flag: "materials_paletted_lru", file: "test_materials_paletted_lru.mjs" },
  { tier: 5, flag: "nameplate_font_gate", file: "test_nameplate_font_gate.mjs" },
  { tier: 5, flag: "nameplate_item_type", file: "test_nameplate_item_type.mjs" },
  { tier: 5, flag: "nameplate_lod_badge", file: "test_nameplate_lod_badge.mjs" },
  { tier: 5, flag: "p0_4_icon_cache", file: "test_p0_4_icon_cache.mjs" },
  { tier: 5, flag: "p43_leak02_precreate_promote", file: "test_p43_leak02_precreate_promote.mjs" },
  { tier: 5, flag: "p5_5_movement_gate", file: "test_p5_5_movement_gate.mjs" },
  { tier: 5, flag: "pal_budget_bytes", file: "test_pal_budget_bytes.mjs" },
  { tier: 5, flag: "park_usetime", file: "test_park_usetime.mjs" },
  { tier: 5, flag: "particle_billboard", file: "test_particle_billboard.mjs" },
  { tier: 5, flag: "particle_clock", file: "test_particle_clock.mjs" },
  { tier: 5, flag: "particle_null_slot_stall", file: "test_particle_null_slot_stall.mjs" },
  { tier: 5, flag: "particle_rp6_cull_authority", file: "test_particle_rp6_cull_authority.mjs" },
  { tier: 5, flag: "particle_single_pass", file: "test_particle_single_pass.mjs" },
  { tier: 5, flag: "particles", file: "test_particles.mjs" },
  { tier: 5, flag: "phase7_5_camera", file: "test_phase7_5_camera.mjs" },
  { tier: 5, flag: "portal_stencil_alloc", file: "test_portal_stencil_alloc.mjs" },
  { tier: 5, flag: "quality_preset", file: "test_quality_preset.mjs" },
  { tier: 5, flag: "remote_buffs", file: "test_remote_buffs.mjs" },
  { tier: 5, flag: "retail_sun", file: "test_retail_sun.mjs" },
  { tier: 5, flag: "review_lowsev_2026_08_03", file: "test_review_lowsev_2026_08_03.mjs" },
  { tier: 5, flag: "service_worker_bake_gate", file: "test_service_worker_bake_gate.mjs" },
  { tier: 5, flag: "shader_prewarm", file: "test_shader_prewarm.mjs" },
  { tier: 5, flag: "sky_birds", file: "test_sky_birds.mjs" },
  { tier: 5, flag: "spotlight_target", file: "test_spotlight_target.mjs" },
  { tier: 5, flag: "static_batch", file: "test_static_batch.mjs" },
  { tier: 5, flag: "static_batch_x", file: "test_static_batch_x.mjs" },
  { tier: 5, flag: "static_callpes", file: "test_static_callpes.mjs" },
  { tier: 5, flag: "stream_bake_guard", file: "test_stream_bake_guard.mjs" },
  { tier: 5, flag: "suite_assets", file: "test_suite_assets.mjs" },
  { tier: 5, flag: "surface_budget_flags", file: "test_surface_budget_flags.mjs" },
  { tier: 5, flag: "surface_single_pass", file: "test_surface_single_pass.mjs" },
  { tier: 5, flag: "synthesis4_leftovers", file: "test_synthesis4_leftovers.mjs" },
  { tier: 5, flag: "terrain_batch", file: "test_terrain_batch.mjs" },
  { tier: 5, flag: "terrain_detail_tex", file: "test_terrain_detail_tex.mjs" },
  { tier: 5, flag: "terrain_dirt", file: "test_terrain_dirt.mjs" },
  { tier: 5, flag: "terrain_families", file: "test_terrain_families.mjs" },
  { tier: 5, flag: "terrain_grass_scatter", file: "test_terrain_grass_scatter.mjs" },
  { tier: 5, flag: "terrain_grass_shader", file: "test_terrain_grass_shader.mjs" },
  { tier: 5, flag: "terrain_oracle", file: "test_terrain_oracle.mjs" },
  { tier: 5, flag: "terrain_palette", file: "test_terrain_palette.mjs" },
  { tier: 5, flag: "terrain_ring_batch", file: "test_terrain_ring_batch.mjs" },
  { tier: 5, flag: "terrain_rock", file: "test_terrain_rock.mjs" },
  { tier: 5, flag: "terrain_sand", file: "test_terrain_sand.mjs" },
  { tier: 5, flag: "terrain_scatter", file: "test_terrain_scatter.mjs" },
  { tier: 5, flag: "terrain_swamp", file: "test_terrain_swamp.mjs" },
  { tier: 5, flag: "terrain_texmerge", file: "test_terrain_texmerge.mjs" },
  { tier: 5, flag: "terrain_vfx_lifecycle", file: "test_terrain_vfx_lifecycle.mjs" },
  { tier: 5, flag: "terrain_vfx_promotion", file: "test_terrain_vfx_promotion.mjs" },
  { tier: 5, flag: "terrain_volcano", file: "test_terrain_volcano.mjs" },
  { tier: 5, flag: "terrain_water", file: "test_terrain_water.mjs" },
  { tier: 5, flag: "tradeskill", file: "test_tradeskill.mjs" },
  { tier: 5, flag: "trail_map", file: "test_trail_map.mjs" },
  { tier: 5, flag: "trail_map_stamp_falloff", file: "test_trail_map_stamp_falloff.mjs" },
  { tier: 5, flag: "train_skill", file: "test_train_skill.mjs" },
  { tier: 5, flag: "vertex_bake_flags", file: "test_vertex_bake_flags.mjs" },
  { tier: 5, flag: "vfx_emissive_compose", file: "test_vfx_emissive_compose.mjs" },
  { tier: 5, flag: "vfx_foliage", file: "test_vfx_foliage.mjs" },
  { tier: 5, flag: "vfx_item_fx", file: "test_vfx_item_fx.mjs" },
  { tier: 5, flag: "vfx_particle_install", file: "test_vfx_particle_install.mjs" },
  { tier: 5, flag: "vfx_review_lowsev", file: "test_vfx_review_lowsev.mjs" },
  { tier: 5, flag: "visfid_c4_program_cache_key", file: "test_visfid_c4_program_cache_key.mjs" },
  { tier: 5, flag: "visfid_p02_detail_material", file: "test_visfid_p02_detail_material.mjs" },
  { tier: 5, flag: "visfid_p11_normal_gate", file: "test_visfid_p11_normal_gate.mjs" },
  { tier: 5, flag: "visfid_p31_pom", file: "test_visfid_p31_pom.mjs" },
  { tier: 5, flag: "visfid_p33_csm", file: "test_visfid_p33_csm.mjs" },
  { tier: 5, flag: "walkin_instance_evict", file: "test_walkin_instance_evict.mjs" },
  { tier: 5, flag: "walkin_instance_guard", file: "test_walkin_instance_guard.mjs" },
  { tier: 5, flag: "weather_flags", file: "test_weather_flags.mjs" },
];

// Registered but KNOWN-FAILING. Listed so they are visible as QUARANTINED
// rows instead of being quietly left out of the plan — an omitted failure
// reads as "we have no test", which is how several of these got lost.
// Clearing this list is task #156.
const QUARANTINE = [
  { file: "tests/test_ws03_cast_overlay_guard.mjs", why: "pre-existing: static-shape regexes drifted vs scene3d/entities.js (untouched vs HEAD)" },
  { file: "test_a15_q1_entity_buffer_caps.mjs", why: "unclassified — see task #156" },
  { file: "test_a15_q3_dispatch_parity.mjs", why: "unclassified — see task #156" },
  { file: "test_a1_o4_single_frame_driver.mjs", why: "unclassified — see task #156" },
  { file: "test_a5_p2_tween_clock.mjs", why: "unclassified — see task #156" },
  { file: "test_ac_cast_over_locomotion.mjs", why: "unclassified — see task #156" },
  { file: "test_ac_jump_clip_plays.mjs", why: "unclassified — see task #156" },
  { file: "test_ac_locomotion_dispatch.mjs", why: "unclassified — see task #156" },
  { file: "test_ac_locomotion_per_stance.mjs", why: "unclassified — see task #156" },
  { file: "test_ac_motion_inventory.mjs", why: "unclassified — see task #156" },
  { file: "test_cast_motion_drains.mjs", why: "unclassified — see task #156" },
  { file: "test_diag_spawnfailed_lbkey.mjs", why: "harness stripExports gap: _attachCast is not defined (R8)" },
  { file: "test_envcell_guard.mjs", why: "STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT gap (documented R8)" },
  { file: "test_examine_dye_preview.mjs", why: "unclassified — see task #156" },
  { file: "test_f10_hud_nameplate.mjs", why: "unclassified — see task #156" },
  { file: "test_fixed_grid_park.mjs", why: "pre-existing, byte-identical FAIL set vs HEAD (R8)" },
  { file: "test_mat_budget_lru.mjs", why: "unclassified — see task #156" },
  { file: "test_per_vital_events.mjs", why: "unclassified — see task #156" },
  { file: "test_phase7_4a_animation_clip.mjs", why: "unclassified — see task #156" },
  { file: "test_phase7_4b_entity_pipeline.mjs", why: "unclassified — see task #156" },
  { file: "test_phase7_6_lighting.mjs", why: "unclassified — see task #156" },
  { file: "test_phase7_batch7_omega_basescale.mjs", why: "unclassified — see task #156" },
  { file: "test_phase7_batch9_entity_lifecycle.mjs", why: "unclassified — see task #156" },
  { file: "test_picking_resolve.mjs", why: "unclassified — see task #156" },
  { file: "test_play_effect_resolver.mjs", why: "unclassified — see task #156" },
  { file: "test_plugin_index_gen.mjs", why: "unclassified — see task #156" },
  { file: "test_pure_smooth_prediction.mjs", why: "unclassified — see task #156" },
  { file: "test_recolor_escape_entmb.mjs", why: "unclassified — see task #156" },
  { file: "test_sky_assets.mjs", why: "unclassified — see task #156" },
  { file: "test_sky_dome.mjs", why: "unclassified — see task #156" },
  { file: "test_sky_lighting.mjs", why: "unclassified — see task #156" },
  { file: "test_stat_geom_dedup.mjs", why: "unclassified — see task #156" },
  { file: "test_status_indicators.mjs", why: "unclassified — see task #156" },
  { file: "test_terrain_dirt_shader.mjs", why: "pre-existing GLSL byte-identity drift (documented R7)" },
  { file: "test_terrain_ice.mjs", why: "pre-existing GLSL byte-identity drift (documented R7)" },
  { file: "test_terrain_sand_sparkle.mjs", why: "pre-existing GLSL byte-identity drift (documented R7)" },
  { file: "test_terrain_snow.mjs", why: "pre-existing GLSL byte-identity drift (documented R7)" },
  { file: "test_terrain_visual_z.mjs", why: "unclassified — see task #156" },
  { file: "test_terrain_volcano_shader.mjs", why: "pre-existing GLSL byte-identity drift (documented R7)" },
  { file: "test_workstream_b_prediction.mjs", why: "unclassified — see task #156" },
  { file: "test_workstream_d_camera_relative.mjs", why: "unclassified — see task #156" },
];
const QUARANTINED = new Set(QUARANTINE.map((q) => q.file));

// COVERAGE GUARD — every `test_*.mjs` in the tree must be in a tier or in
// QUARANTINE. Unlisted files are reported so the registration list can never
// silently rot again.
function unregisteredSuites() {
  const seen = new Set([...TIER1, ...TIER4, ...TIER5].map((p) => p.file));
  const out = [];
  // Two naming conventions, and MISSING THE SECOND ONE was this guard's own
  // first bug (2026-08-03): app-root and rynth/ use `test_*.mjs`, while
  // tests/ uses `*.test.mjs` / `*.test.cjs`. Scanning only the first pattern
  // left 39 suites under tests/ invisible to the very check written to make
  // invisible suites impossible. Caught by the plugins reviewer, not by me.
  const SCAN = [
    { dir: "", match: (n) => n.startsWith("test_") && n.endsWith(".mjs") },
    { dir: "rynth", match: (n) => n.startsWith("test_") && n.endsWith(".mjs") },
    { dir: "tests", match: (n) => /\.(test\.)?(mjs|cjs)$/.test(n) && (n.startsWith("test_") || n.includes(".test.")) },
  ];
  for (const { dir, match } of SCAN) {
    let names = [];
    try { names = readdirSync(path.join(APP_ROOT, dir)); } catch (_) { continue; }
    for (const n of names) {
      if (!match(n)) continue;
      const rel = dir ? `${dir}/${n}` : n;
      if (!seen.has(rel) && !QUARANTINED.has(rel)) out.push(rel);
    }
  }
  return out.sort();
}

const PLAN = [...TIER1, ...TIER4, ...TIER5];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    only: null,
    tier: "all",
    quiet: false,
    list: false,
    strictMissing: false,
    // F5: a SKIP (exit 0 but nothing asserted) fails the run by default.
    allowSkips: false,
    timeoutMs: 120000,
    bail: false,
    help: false,
  };
  for (const a of argv) {
    if (a === "--quiet") opts.quiet = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--strict-missing") opts.strictMissing = true;
    else if (a === "--allow-skips") opts.allowSkips = true;
    else if (a === "--bail") opts.bail = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("--only=")) {
      opts.only = a
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (opts.only.length === 0) opts.only = null;
    } else if (a.startsWith("--tier=")) {
      const v = a.slice("--tier=".length).trim().toLowerCase();
      if (v === "1" || v === "4" || v === "all") opts.tier = v;
      else console.warn(`[run-js-headless] --tier: expected 1|4|all, got ${v} — ignoring`);
    } else if (a.startsWith("--timeout=")) {
      const n = Number(a.slice("--timeout=".length));
      if (Number.isFinite(n) && n > 0) opts.timeoutMs = n;
      else console.warn(`[run-js-headless] --timeout: expected a positive number — ignoring ${a}`);
    } else {
      console.warn(`[run-js-headless] ignoring unknown arg: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// plan selection
// ---------------------------------------------------------------------------
function selectPlan(opts) {
  let plan = PLAN.slice();
  if (opts.tier !== "all") {
    const t = Number(opts.tier);
    plan = plan.filter((p) => p.tier === t);
  }
  if (opts.only) {
    plan = plan.filter((p) => {
      const hay = `${p.file} ${p.flag}`.toLowerCase();
      return opts.only.some((sub) => hay.includes(sub));
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// rendering helpers
// ---------------------------------------------------------------------------
const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  SKIP: "SKIP",
  MISSING: "MISSING",
});

// A child that prints a SKIP banner and exits 0 asserted NOTHING (2026-08-03
// review, finding F5). The runner used to classify purely on `status === 0`,
// so six suites whose `locateThree()` exit-0'd were tabulated PASS and counted
// in the "N passed" line. run-all.mjs's own skip detector could not see them
// either: its SKIP_MARKERS list only covers TIER-level banners (SERVER_DOWN /
// PLAYWRIGHT_MISSING / cargo-absent), not per-test ones.
//
// Matches the banner forms actually in use, all of which put SKIP in caps
// followed by a delimiter:
//     "paletted-LRU ESM test: SKIP (three not located)."
//     "Phase 7.5 camera ESM test: SKIP (OrbitControls.js not found ...)."
//     "SKIP: cannot locate three.module.js — set THREE_PATH."
//     "A11-S5: SKIP — could not extract genuine pickScriptEntry ..."
// Deliberately case-sensitive on SKIP + requires a delimiter, so ordinary
// assertion text ("[OK] ... is skipped", "parkSkippedInEntriesMiss") is not
// mistaken for a banner.
const SKIP_BANNER = [
  /^[^\n]*:[ \t]*SKIP[ \t]*[(—:-]/m,
  /^[ \t]*SKIP[ \t]*[(—:-]/m,
];

function looksSkipped(output) {
  return SKIP_BANNER.some((re) => re.test(output));
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function renderTable(rows) {
  const flagW = Math.max(4, ...rows.map((r) => r.flag.length));
  const fileW = Math.max(4, ...rows.map((r) => r.file.length));
  const statW = Math.max(6, ...rows.map((r) => r.status.length));
  const line = (a, b, c) => `  ${pad(a, flagW)}  ${pad(b, fileW)}  ${pad(c, statW)}`;
  const out = [];
  out.push(line("flag", "file", "status"));
  out.push("  " + "-".repeat(flagW + fileW + statW + 4));
  for (const r of rows) {
    let mark = r.status;
    if (r.status === STATUS.FAIL) mark += r.detail ? ` (${r.detail})` : "";
    out.push(line(r.flag, r.file, mark));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// run one test file
// ---------------------------------------------------------------------------
function runOne(entry, opts) {
  const abs = path.resolve(APP_ROOT, entry.file);
  if (!existsSync(abs)) {
    return { ...entry, status: STATUS.MISSING, code: null, detail: "file not present", output: "" };
  }
  const run = spawnSync(process.execPath, [entry.file], {
    cwd: APP_ROOT,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  // spawnSync sets .error (e.g. ETIMEDOUT) and/or .signal on a kill.
  const timedOut = run.error && run.error.code === "ETIMEDOUT";
  const killed = !!run.signal;
  const ok = !run.error && !killed && run.status === 0;
  const output = [run.stdout || "", run.stderr || ""].join("");
  let detail = "";
  if (!ok) {
    if (timedOut) detail = `timeout ${opts.timeoutMs}ms`;
    else if (run.error) detail = run.error.message;
    else if (killed) detail = `signal ${run.signal}`;
    else detail = `exit ${run.status}`;
  }
  // F5: exit 0 + a SKIP banner is NOT a pass — the suite asserted nothing.
  let status;
  if (!ok) status = STATUS.FAIL;
  else if (looksSkipped(output)) {
    status = STATUS.SKIP;
    const line = output.split("\n").find((l) => looksSkipped(l));
    detail = (line || "skipped").trim().slice(0, 100);
  } else status = STATUS.PASS;
  return { ...entry, status, code: run.status, detail, output };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "usage: node harness/run-js-headless.mjs [--only=substr,...] [--tier=1|4|all] " +
        "[--quiet] [--list] [--strict-missing] [--timeout=MS] [--bail]"
    );
    process.exit(0);
  }

  const plan = selectPlan(opts);

  console.log("");
  console.log("=".repeat(76));
  console.log("  run-js-headless — host-JS flag harness (Tier-1 green + Tier-4 new)");
  console.log("=".repeat(76));
  console.log(`  app root  : ${APP_ROOT}`);
  console.log(`  node      : ${process.version}`);
  console.log(`  selected  : ${plan.length} test(s)` +
    (opts.tier !== "all" ? ` (tier=${opts.tier})` : "") +
    (opts.only ? ` (only~[${opts.only.join(", ")}])` : ""));
  console.log(`  missing   : ${opts.strictMissing ? "STRICT (counts as FAIL)" : "tolerated (no effect on exit)"}`);
  console.log(`  skips     : ${opts.allowSkips ? "tolerated (--allow-skips)" : "count as FAIL (a SKIP asserts nothing)"}`);
  console.log("=".repeat(76));

  // --list: print the plan (with existence) and exit 0.
  if (opts.list) {
    const rows = plan.map((p) => ({
      flag: p.flag,
      file: p.file,
      status: existsSync(path.resolve(APP_ROOT, p.file)) ? `tier${p.tier}` : `tier${p.tier} MISSING`,
    }));
    console.log("");
    console.log(rows.length ? renderTable(rows) : "  (no tests selected)");
    console.log("");
    process.exit(0);
  }

  if (plan.length === 0) {
    console.log("\n[run-js-headless] no tests selected — nothing to do (exit 0).");
    process.exit(0);
  }

  const results = [];
  for (const entry of plan) {
    process.stdout.write(`\n----- [tier${entry.tier}] ${entry.flag} :: ${entry.file} -----\n`);
    const res = runOne(entry, opts);
    results.push(res);

    const showOutput =
      res.status === STATUS.FAIL ||
      (res.status === STATUS.MISSING && opts.strictMissing) ||
      !opts.quiet;
    if (res.status === STATUS.MISSING) {
      console.log(`  MISSING: ${entry.file} not present at ${APP_ROOT}` +
        (opts.strictMissing ? " (STRICT → counts as FAIL)" : " (tolerated)"));
    } else {
      if (showOutput && res.output.trim()) {
        // Indent child output for readability.
        process.stdout.write(
          res.output
            .replace(/\n$/, "")
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n") + "\n"
        );
      }
      console.log(`  → ${res.status}` + (res.detail ? ` (${res.detail})` : ""));
    }

    const isFailNow =
      res.status === STATUS.FAIL ||
      (res.status === STATUS.SKIP && !opts.allowSkips) ||
      (res.status === STATUS.MISSING && opts.strictMissing);
    if (opts.bail && isFailNow) {
      console.log("\n[run-js-headless] --bail: stopping at first failure.");
      break;
    }
  }

  // Tabulate.
  const tableRows = results.map((r) => ({ flag: r.flag, file: r.file, status: r.status, detail: r.detail }));
  console.log("\n" + "=".repeat(76));
  console.log("  RESULTS");
  console.log("=".repeat(76));
  console.log(renderTable(tableRows));

  const passed = results.filter((r) => r.status === STATUS.PASS);
  const failed = results.filter((r) => r.status === STATUS.FAIL);
  const missing = results.filter((r) => r.status === STATUS.MISSING);
  const skipped = results.filter((r) => r.status === STATUS.SKIP);

  console.log("\n" + "=".repeat(76));
  console.log(
    `[run-js-headless] ${passed.length} passed, ${failed.length} failed, ` +
      `${missing.length} missing  (of ${results.length} run` +
      (plan.length !== results.length ? `; ${plan.length - results.length} skipped by --bail` : "") +
      ")"
  );
  for (const r of failed) {
    console.log(`  FAIL    : ${r.file}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  for (const r of missing) {
    console.log(`  MISSING : ${r.file}${opts.strictMissing ? " (STRICT → FAIL)" : ""}`);
  }
  console.log("=".repeat(76));

  for (const r of skipped) {
    console.log(`  SKIP    : ${r.file} — ${r.detail}` +
      (opts.allowSkips ? " (tolerated)" : " (asserts nothing → FAIL)"));
  }

  // Known-failing, deliberately out of the plan. Printed rather than omitted:
  // a failure nobody lists is indistinguishable from a test that was never
  // written, which is how several of these were lost in the first place.
  for (const q of QUARANTINE) {
    console.log(`  QUARANTINED: ${q.file} — ${q.why}`);
  }

  // Coverage guard. A suite in neither a tier nor QUARANTINE is invisible —
  // the failure mode that left 169 of 212 suites unrun until 2026-08-03.
  // Only meaningful on a full run; a filtered plan says nothing about coverage.
  const unregistered = (opts.only || opts.tier !== "all") ? [] : unregisteredSuites();
  for (const f of unregistered) {
    console.log(`  UNREGISTERED: ${f} — in no tier and not quarantined; nothing runs it`);
  }

  const missingCountsAsFail = opts.strictMissing ? missing.length : 0;
  const skipCountsAsFail = opts.allowSkips ? 0 : skipped.length;
  const exitNonZero =
    failed.length > 0 || missingCountsAsFail > 0 || skipCountsAsFail > 0 ||
    unregistered.length > 0;
  process.exit(exitNonZero ? 1 : 0);
}

main();
