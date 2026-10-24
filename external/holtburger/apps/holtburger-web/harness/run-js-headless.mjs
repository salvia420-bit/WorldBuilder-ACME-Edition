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
//                                    [--quiet] [--list] [--coverage]
//                                    [--strict-missing] [--timeout=MS]
//                                    [--bail] [--allow-skips]
//
//   --only=...        Run only files whose path OR flag contains any listed
//                     substring (comma-separated, case-insensitive).
//   --tier=1|4|all    Restrict to Tier-1, Tier-4, or both (default: all).
//   --quiet           Suppress each child's own stdout/stderr on PASS (failures
//                     and MISSING always print their captured output).
//   --list            Print the resolved test plan (tier/flag/file/exists) and
//                     exit 0 without running anything.
//   --coverage        Print only the coverage guard (QUARANTINED /
//                     NEEDS-TOOLCHAIN / NEEDS-BROWSER / UNREGISTERED) and exit
//                     1 iff a suite is UNREGISTERED. Runs nothing, takes no
//                     heavy lock.
//   --strict-missing  Treat a MISSING file as a FAIL (default: MISSING is
//                     tolerated and does not affect the exit code).
//   --timeout=MS      Per-test wall-clock timeout (default 120000). On timeout
//                     the test is a FAIL (killed).
//   --bail            Stop at the first FAIL (still prints the partial table).
//   --run-quarantined Also execute the QUARANTINE entries and tag each XFAIL
//                     (still broken) or XPASS (fixed — un-quarantine it).
//                     Informational only; never changes the exit code.
//   --strict-fixtures Treat a NO-FIXTURE row (a suite whose `requires` local
//                     data fixture is absent) as a FAIL. Default: reported,
//                     not run, no effect on the exit code.
//   --allow-skips     Tolerate a child that printed a SKIP banner and exited 0.
//                     OFF by default: such a child asserted NOTHING, so
//                     counting it as a pass is exactly the defect the
//                     2026-08-03 review found (F5).
//
// EXIT CODE: 0 unless at least one test FAILED, or a test SKIPPED (unless
// --allow-skips), or -- under --strict-missing -- a file was MISSING.
// MISSING alone (default) and an empty plan exit 0. 2 = the heavy-job lock /
// free-memory gate refused to start (see below).
//
// ONE HEAVY JOB PER MACHINE (2026-10-13): a run that executes anything first
// takes harness/lib/heavy_lock.mjs — a machine-wide lock (waits for the
// holder, naming it every 15 s) plus MemAvailable >= HB_MIN_FREE_MB (2560).
// The 2026-10-05 freeze was four of these runs at once. Children inherit
// HB_HEAVY_LOCK_HELD, so nothing they start waits on this run. Each child
// also gets --max-old-space-size=HB_TEST_HEAP_MB (1536; 0 = uncapped).
// Bypass: CI=true or HB_HEAVY_LOCK=0. `node <one test file>` takes no lock.
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHeavyLockSync, childHeapArgs } from "./lib/heavy_lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// harness/ → apps/holtburger-web/ (the app root; child cwd + path base).
const APP_ROOT = path.resolve(HERE, "..");
// Per-child V8 heap cap (HB_TEST_HEAP_MB): a runaway suite dies alone.
const CHILD_HEAP_ARGS = childHeapArgs();

// ---------------------------------------------------------------------------
// EMBEDDED TEST PLAN (authoritative). Paths are relative to APP_ROOT.
// `tier` 1 = already-green unit tests; `tier` 4 = new (may be MISSING).
// ---------------------------------------------------------------------------
const TIER1 = [
  { flag: "inputFunnel", file: "test_a14_i1_input_controller.mjs" },
  { flag: "inputFunnelV2", file: "test_input_funnel_v2.mjs" },
  { flag: "heldKeyRelease", file: "test_held_key_release.mjs" },
  { flag: "hookDrain", file: "test_hook_windows.mjs" },
  { flag: "surfaceUnified+surfaceParityV2", file: "test_f7_8_surface_bitfield.mjs" },
  { flag: "scriptQueue", file: "test_script_manager.mjs" },
  { flag: "moveTelemetry", file: "test_move_telemetry.mjs" },
  // SCRIPTMGR-RATE (2026-08-11): the A11-S1 SEAM, which test_script_manager.mjs
  // cannot see — it builds entries with `{startTime}` by hand, so it never
  // exercised the `time`-vs-`startTime` gap that collapsed the real queue's
  // schedule. This one lifts the shipped decoder out of entities.js.
  { flag: "scriptHookTime", file: "harness/test_script_hook_time.mjs" },
  { flag: "particleOwner", file: "test_particle_owner.mjs" },
  // HIDEFX (2026-10-07): the portal "pink bubbles" that never went away —
  // Hide/Hidden/UnHide emitter lifecycle against REAL client_portal.dat bytes
  // (pins the legacy leak on the =off arm, the retail stop on the =on arm).
  { flag: "playEffectLifecycle", file: "test_hidefx_lifecycle.mjs" },
  { flag: "preCreateBuffer", file: "test_a8_m4_pre_create_buffer.mjs" },
  { flag: "retailRunKeys(JS)", file: "test_a14_i3_run_keys.mjs" },
  { flag: "particleDegrade(JS)", file: "test_a11_s4_particle_degrade.mjs" },
  { flag: "rootMotionObject(JS)", file: "test_a5_p3_root_motion.mjs" },
  { flag: "wasmPursuit(monitor)", file: "test_a14_i2_pursuit_monitor.mjs" },
  { flag: "rigModule", file: "test_a9_stage2_setup_rig.mjs" },
  { flag: "retailCamZoom+camStiffness+mouseSmooth", file: "tests/camera_retail_math.test.cjs" },
  { flag: "remoteInterp(JS)", file: "tests/remote_interp_ownership.test.cjs" },
  { flag: "jumpParity(JS)", file: "tests/jump_charge_parity.test.cjs" },
  // Unified poser vs mixer-clip parity, incl. the in-place locomotion fix.
  { flag: "unifiedMotion(poser)", file: "test_motion_sequence.mjs" },
  // Exercises the REAL compiled wasm MotionSequence boundary (entities.js path);
  // Needs the (gitignored) pkg/ wasm build — see its `requires`.
  // `requires` the gitignored wasm build: absent → NO-FIXTURE, never a hollow PASS.
  { flag: "unifiedMotion(wasm)", file: "test_motion_sequence_wasm_smoke.mjs",
    requires: "pkg/holtburger_web_bg.wasm" },
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
  { flag: "weaponFx(JS)", file: "test_weapon_fx.mjs" },                   // 2026-10-10 per-weapon effects (?weaponFx)
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
  // Lives under harness/ (the plan used to name the app root → a permanent
  // MISSING row that `--strict-missing` would have failed).
  { flag: "aliasSplit(JS)", file: "harness/test_p1_alias_split.mjs" },
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
  { flag: "projectileLights+projectileLaunchClock+projectileTerrainStop+projectileEnvSweep", file: "tests/projectile_visual_fidelity.test.mjs" },
  { flag: "ragdollEnergy", file: "tests/ragdoll_energy.test.mjs" },
  // 2026-10-07 — ragdoll landing on a corpse must settle (jiggle report).
  { flag: "ragdollStackLive", file: "tests/ragdoll_stack.test.mjs" },
  // 2026-10-11 — a ragdoll rests when its DRAWN parts stop moving (shreth
  // placeholder parts, floor creep), frame-rate-independent, 6 s hard stop.
  { flag: "ragdollRest", file: "tests/ragdoll_rest.test.mjs" },
  { flag: "killImpulse", file: "tests/kill_impulse.test.mjs" },
  { flag: "gfxRelief", file: "tests/gfx_relief.test.mjs" },
  { flag: "combatInstallGiveup", file: "tests/combat_install_giveup.test.mjs" },
  { flag: "unifiedQueuePreempt", file: "tests/unified_queue_preempt.test.mjs" },
  { flag: "unifiedMotionAuthority", file: "tests/unified_motion_authority.test.mjs" },
  { flag: "signedMotionSpeed", file: "tests/turn_left_reverse.test.mjs" },
  { flag: "projectileAlignPath", file: "tests/projectile_align_path.test.mjs" },
  { flag: "projectileOmega+particleRotAce", file: "tests/projectile_spin.test.mjs" },
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
  // `requires`: a LOCAL data fixture outside the repo. Absent → NO-FIXTURE row
  // (not run, not a pass; fails only under --strict-fixtures). See runOne.
  { tier: 5, flag: "xu7_transcode", file: "test_xu7_transcode.mjs",
    requires: "/mnt/wbterminal2/xubc7-corpus/statics-lossless/0x06003789.ktx2" },
  // 2026-08-08 — the transcode BUDGET (`?xu7Budget`). Sibling of the above and
  // deliberately separate: that suite needs the real transcoder and the
  // /mnt corpus fixture, this one needs neither and pins the scheduler.
  { tier: 5, flag: "xu7_budget", file: "test_xu7_budget.mjs" },
  { tier: 5, flag: "bc7_pre_phase", file: "test_bc7_pre_phase.mjs" },
  { tier: 5, flag: "atlas_bc7_pre_gate", file: "test_atlas_bc7_pre_gate.mjs" },
  { tier: 5, flag: "terrain_bc7_aniso", file: "test_terrain_bc7_aniso.mjs" },
  // 2026-10-07 — CLIP-ALPHA guard (`?bc7ClipAlphaGuard`, the reed clumps drawn
  // as black quads): synthetic mechanics everywhere, plus the real reed record
  // (retail portal DAT + the served dist's tex-xu7/tex-bc7 records). Both
  // fixtures are external, so the real suite is NO-FIXTURE when either is
  // absent (HB_PORTAL_DAT / HB_CLIP_DIST override the paths).
  { tier: 5, flag: "bc7_clip_alpha_guard", file: "harness/test_bc7_clip_alpha_guard.mjs" },
  { tier: 5, flag: "bc7_clip_alpha_guard_real", file: "harness/test_bc7_clip_alpha_guard_real.mjs",
    requires: () => {
      const dat = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";
      const dist = (process.env.HB_CLIP_DIST || "/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2") + "/manifest/holtburger-tex-xu7.bin";
      return [dat, dist].find((p) => !existsSync(p)) || dist;
    } },
  { tier: 5, flag: "r10_index_orchestrator", file: "test_r10_index_orchestrator.mjs" },
  { tier: 5, flag: "portal_space_sequencer", file: "test_portal_space_sequencer.mjs" },
  { tier: 5, flag: "rig_indoor_layer", file: "test_rig_indoor_layer.mjs" },
  { tier: 5, flag: "c1_facing_camera", file: "tests/test_c1_facing_camera.cjs" },
  { tier: 5, flag: "cast_busy_clock", file: "tests/test_cast_busy_clock.mjs" },
  // 2026-10-08 — spell-cast parity: formula-untargeted rings/walls cast without
  // a selection (?formulaUntargeted); the local cast prediction gates on the
  // wasm outstanding-request count, retail m_cBusy (?castBusyCount).
  { tier: 5, flag: "formulaUntargeted", file: "tests/spell_target_type.test.mjs" },
  { tier: 5, flag: "castBusyCount", file: "tests/cast_busy_count.test.mjs" },
  // spellcast-3: retail target-compatibility pre-check + "Casting <spell>"
  // (?spellTargetPrecheck) and the kind=14 UseDone chain cancel (?castUseDoneCancels).
  { tier: 5, flag: "spellTargetPrecheck", file: "tests/spell_target_compat.test.mjs" },
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
  { tier: 5, flag: "c8_cast_combat_mode_gate", file: "tests/test_c8_cast_combat_mode_gate.mjs" },
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
  // NETSYNC (2026-10-07, Coldeve capture): __diag.remoteSync + the remote
  // motion-keep (Rust) / turn-gate-fix (JS) wiring.
  { tier: 5, flag: "netsync_remote_sync", file: "harness/test_netsync_remote_sync.mjs" },
  { tier: 5, flag: "combat_bar_skill_stride", file: "tests/combat_bar_skill_stride.test.mjs" },
  { tier: 5, flag: "combat_hud_power_ownership", file: "tests/combat_hud_power_ownership.test.mjs" },
  { tier: 5, flag: "hud_combat_status", file: "tests/hud_combat_status.test.mjs" },
  { tier: 5, flag: "contracts_panel", file: "tests/contracts_panel.test.cjs" },
  { tier: 5, flag: "corpse_loot_snapshot", file: "tests/corpse_loot_snapshot.test.mjs" },
  { tier: 5, flag: "corpse_loot_all_pacing", file: "tests/corpse_loot_all_pacing.test.mjs" },
  { tier: 5, flag: "attack_power_bar", file: "tests/attack_power_bar.test.mjs" },
  { tier: 5, flag: "localAutoMotion", file: "tests/local_auto_motion.test.mjs" },
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
  { tier: 5, flag: "soa_aos_parity", file: "tests/soa_aos_parity.test.cjs",
    requires: "/mnt/wbterminal2/holtburger-dist" },
  { tier: 5, flag: "spellbook_wasm_record", file: "tests/spellbook_wasm_record.test.cjs" },
  { tier: 5, flag: "target_cycle", file: "tests/target_cycle.test.cjs" },
  { tier: 5, flag: "test_ws14_cast_cooldown", file: "tests/test_ws14_cast_cooldown.test.mjs" },
  { tier: 5, flag: "test_ws14_ui_feedback", file: "tests/test_ws14_ui_feedback.test.cjs" },
  { tier: 5, flag: "unwedge_reflex", file: "tests/unwedge_reflex.test.mjs" },
  { tier: 5, flag: "vendor_profile", file: "tests/vendor_profile.test.cjs" },
  { tier: 5, flag: "vendor_queue_vendor_switch", file: "tests/vendor_queue_vendor_switch.test.mjs" },
  // 2026-10-07 bug 3: the vendor window closes at the vendor's own use radius
  // (retail Position::cylinder_distance), as OpenAC.
  { tier: 5, flag: "vendor_range_cylinder", file: "tests/vendor_range_cylinder.test.mjs" },
  // 2026-10-07 bug 6: the ragdolled creature waits for its corpse's claim.
  { tier: 5, flag: "death_hold", file: "tests/death_hold.test.mjs" },
  // 2026-10-07 bug 16: carnage slices/fractures run one per frame.
  { tier: 5, flag: "dismember_heavy_schedule", file: "tests/dismember_heavy_schedule.test.mjs" },
  // 2026-10-07 review: an expired corpse-dismember archive frees a despawned
  // corpse's stumps (they kept a dead parent and were never disposed).
  { tier: 5, flag: "dismember_archive", file: "tests/dismember_archive.test.mjs" },
  // 2026-10-07 bug 14: a held item's spawn is built at its attach, poseless.
  { tier: 5, flag: "held_attach_promote", file: "tests/held_attach_promote.test.mjs" },
  // 2026-10-07 bug 12: retail icon composites (no white key, type backgrounds).
  { tier: 5, flag: "icon_compose", file: "tests/icon_compose.test.mjs" },
  // 2026-10-07 bug 13: the paperdoll faces the viewer from retail's camera.
  { tier: 5, flag: "paperdoll_retail_framing", file: "tests/paperdoll_retail_framing.test.mjs" },
  // 2026-10-07 bug 5: 1 Hz terrain hole self-heal.
  { tier: 5, flag: "terrain_hole_audit", file: "tests/terrain_hole_audit.test.mjs" },
  { tier: 5, flag: "viewerCell", file: "tests/viewer_cell.test.mjs" },
  // 2026-10-08 round 2 — camera parity on the real CameraSwitcher: retail
  // viewer order, viewer sphere, scenery sweep, in-place turns, ViewCombatTarget.
  { tier: 5, flag: "cameraViewerStep", file: "tests/camera_viewer_step.test.mjs" },
  { tier: 5, flag: "motionLinkFidelity", file: "tests/motion_link_fidelity.test.mjs" },
  // 2026-10-17 missile-anim — aim and Reload as substates (MA-1..MA-5).
  { tier: 5, flag: "missileSubstate", file: "tests/missile_substate_motion.test.mjs" },
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
  { tier: 5, flag: "adaptive_res_gpu_check", file: "test_adaptive_res_gpu_check.mjs" },
  { tier: 5, flag: "ambient_baked", file: "test_ambient_baked.mjs" },
  { tier: 5, flag: "ambient_frame", file: "test_ambient_frame.mjs" },
  { tier: 5, flag: "animated_scenery", file: "test_animated_scenery.mjs" },
  { tier: 5, flag: "animated_scenery_park", file: "test_animated_scenery_park.mjs" },
  { tier: 5, flag: "atmosphere_pipeline_passes", file: "test_atmosphere_pipeline_passes.mjs" },
  { tier: 5, flag: "audio_optimistic", file: "test_audio_optimistic.mjs" },
  { tier: 5, flag: "bake_transfer", file: "test_bake_transfer.mjs" },
  { tier: 5, flag: "bake_worker_client_queue", file: "test_bake_worker_client_queue.mjs" },
  { tier: 5, flag: "bm_colortexture_fix", file: "test_bm_colortexture_fix.mjs" },
  { tier: 5, flag: "brazier_emit", file: "test_brazier_emit.mjs" },
  { tier: 5, flag: "cast_level8_windup", file: "test_cast_level8_windup.mjs" },
  { tier: 5, flag: "cell_lights", file: "test_cell_lights.mjs" },
  { tier: 5, flag: "cloud_overlay_dispose", file: "test_cloud_overlay_dispose.mjs" },
  { tier: 5, flag: "cloudsMainPass", file: "tests/clouds_main_pass.test.mjs" },
  // 2026-10-17 deterministic cloud boot order (the per-session bright/dark sky).
  { tier: 5, flag: "cloudsBootOrder", file: "tests/clouds_boot_order.test.mjs" },
  // 2026-10-07 particles drawn after the cloud + aerial composite (split post
  // chain; the -sky glow stays behind the clouds).
  { tier: 5, flag: "particlesOverClouds", file: "tests/particles_over_clouds.test.mjs" },
  { tier: 5, flag: "msaaWorldOnly", file: "tests/msaa_world.test.mjs" },
  // 2026-10-17 `?reversedZ=on` (opt-in): reversed-Z depth instead of the log buffer.
  { tier: 5, flag: "reversedZ", file: "tests/reversed_z.test.mjs" },
  // 2026-10-05 audio retail parity (voice pool, retail mixer, 0xF750, UI/portal sounds, volume 0).
  { tier: 5, flag: "audio_voice_pool", file: "tests/audio_voice_pool.test.mjs" },
  { tier: 5, flag: "audioRetailPan", file: "tests/audio_retail_mixer.test.mjs" },
  { tier: 5, flag: "audio_server_sound", file: "tests/audio_server_sound.test.mjs" },
  { tier: 5, flag: "audio_ui_click", file: "tests/audio_ui_click.test.mjs" },
  { tier: 5, flag: "audio_portal_sounds", file: "tests/audio_portal_sounds.test.mjs" },
  { tier: 5, flag: "audio_volume_zero", file: "tests/audio_volume_zero.test.mjs" },
  { tier: 5, flag: "audio_soundhook_slider_twice", file: "tests/audio_soundhook_slider_twice.test.mjs" },
  { tier: 5, flag: "audio_ambient_model", file: "tests/audio_ambient_model.test.mjs" },
  { tier: 5, flag: "audio_manager_retail+audioWhenInactive", file: "tests/audio_manager_retail.test.mjs" },
  { tier: 5, flag: "cloud_storm_look", file: "test_cloud_storm_look.mjs" },
  // 2026-10-07 horizon fog band + clouds-at-full-opacity AP blend.
  { tier: 5, flag: "horizonFog+cloudsFullOpacity", file: "test_fog_band.mjs" },
  // 2026-10-07 clouds lit by the sky's night-ramped sun (night clouds dark).
  { tier: 5, flag: "cloudNight", file: "tests/cloud_night_lighting.test.mjs" },
  // 2026-10-07 owner look pass on the 1070: ?tone / ?grade / ?lumNight /
  // ?adaptiveResBootGrace / ?swayShadow + the split-chain resolve, cloud depth
  // and CSM depth-texture fixes.
  { tier: 5, flag: "lookPass", file: "tests/look_pass.test.mjs" },
  // 2026-10-08 — ambient critters fly their retail SetOmega orbit; server movers
  // walk at their own clip tempo (?animSceneryOmega / ?creatureGait).
  { tier: 5, flag: "animSceneryOmega", file: "tests/animated_scenery_omega.test.mjs" },
  // 2026-10-17 cpuframe: instanced DAT-anim scenery posed in the vertex shader.
  { tier: 5, flag: "animSceneryGpu", file: "tests/anim_scenery_gpu.test.mjs" },
  { tier: 5, flag: "animSceneryBucketVis", file: "tests/anim_scenery_bucket_vis.test.mjs" },
  { tier: 5, flag: "creatureGaitRetail", file: "tests/creature_gait_retail.test.mjs" },
  // 2026-10-08 — playhead parity: retail hook timing on the real EntityManager
  // (?hookFrameExit; also pins the end-of-tick hook queue the retired
  // test_hook_fire_queue.mjs replica covered), cycle restart behind a one-shot
  // (?cycleRestartAfterAction), CallPES hooks owned by their object.
  { tier: 5, flag: "hookFrameExit", file: "tests/unified_hook_drain.test.mjs" },
  { tier: 5, flag: "cycleRestartAfterAction", file: "tests/unified_handback.test.mjs" },
  { tier: 5, flag: "animHookCallPes", file: "tests/anim_hook_callpes.test.mjs" },
  // 2026-10-07 moon nebula sheets as far-depth sky glows (the sky wedges) +
  // AerialPerspective takes the sky's sun (it was (0,0,0)).
  { tier: 5, flag: "skyGlow+aerialSun", file: "tests/sky_glow.test.mjs" },
  // 2026-10-07 additive particles unfogged like retail (D3DRS_FOGENABLE off for
  // the Additive bit) instead of three's mix toward fogColor (pale quads).
  { tier: 5, flag: "additiveFogBlack", file: "tests/additive_fog.test.mjs" },
  { tier: 5, flag: "particleFx", file: "test_particle_fx.mjs" },
  // 2026-10-10 tier-1 particle upgrade: FX lights + terrain lights, glow,
  // GPU children, distortion, smoke shading (scene3d/vfx/fx_tier1.js).
  { tier: 5, flag: "particleFxTier1", file: "test_particle_fx_tier1.mjs" },
  // 2026-10-10 tier-2 particle upgrade: velocity stretch + ribbons + swing
  // trails, analytic sprites, ground marks, ambient fields, sub-pixel clamp,
  // showcase set pieces (scene3d/vfx/fx_tier2.js).
  { tier: 5, flag: "particleFxTier2", file: "test_particle_fx_tier2.mjs" },
  // 2026-10-11 portal parity: every portal colour gets the purple portal's
  // treatment (generator portal tag by weenie type + ?portalFxLum).
  { tier: 5, flag: "portalFxLum", file: "test_portal_fx_parity.mjs" },
  // 2026-10-11 a wielded weapon's FX light never lights its wielder
  // (?heldFxLightSkip; retail weapons carry no light).
  { tier: 5, flag: "heldFxLightSkip", file: "test_held_fx_light.mjs" },
  // 2026-10-11 the lifestone glows instead of beaming: crystal materials, an
  // aura, a light carrier, no shaft / ring (?lifestoneFx, vfx/lifestone_fx.js).
  { tier: 5, flag: "lifestoneFx", file: "test_lifestone_fx.mjs" },
  { tier: 5, flag: "burstFx", file: "test_play_effect_burst_fx.mjs" },
  { tier: 5, flag: "config_merge", file: "test_config_merge.mjs" },
  { tier: 5, flag: "decode_admission_flags", file: "test_decode_admission_flags.mjs" },
  { tier: 5, flag: "diag_combat_giveup", file: "test_diag_combat_giveup.mjs" },
  { tier: 5, flag: "diag_events_diff_lbfilter", file: "test_diag_events_diff_lbfilter.mjs" },
  { tier: 5, flag: "diag_spawn_classifier", file: "test_diag_spawn_classifier.mjs" },
  { tier: 5, flag: "first_bake_batch_flags", file: "test_first_bake_batch_flags.mjs" },
  { tier: 5, flag: "fixed_grid", file: "test_fixed_grid.mjs" },
  { tier: 5, flag: "gemsparkle_emit", file: "test_gemsparkle_emit.mjs" },
  { tier: 5, flag: "ground_fog", file: "test_ground_fog.mjs" },
  { tier: 5, flag: "hotbar_fire", file: "test_hotbar_fire.mjs" },
  { tier: 5, flag: "toolbar_unified", file: "test_toolbar_unified.mjs" },
  { tier: 5, flag: "toolbar_mount_smoke", file: "test_toolbar_mount_smoke.mjs" },
  { tier: 5, flag: "radar_projection", file: "test_radar_projection.mjs" },
  { tier: 5, flag: "hud_scale", file: "test_hud_scale.mjs" },
  { tier: 5, flag: "chat_panel_layout", file: "test_chat_panel_layout.mjs" },
  { tier: 5, flag: "chat_panel_mount", file: "test_chat_panel_mount.mjs" },
  { tier: 5, flag: "social_panel", file: "tests/social_panel.test.mjs" },
  { tier: 5, flag: "social_panel_dom", file: "tests/social_panel_dom.test.mjs" },
  { tier: 5, flag: "optionsFellowshipExclusion", file: "tests/options_fellowship_exclusion.test.mjs" },
  { tier: 5, flag: "hud_popup_placement", file: "test_hud_popup_placement.mjs" },
  { tier: 5, flag: "examine_format", file: "test_examine_format.mjs" },
  { tier: 5, flag: "options_panel_helpers", file: "test_options_panel_helpers.mjs" },
  { tier: 5, flag: "hud_popups_dom_smoke", file: "test_hud_popups_dom_smoke.mjs" },
  { tier: 5, flag: "commerce_logic", file: "tests/commerce_logic.test.mjs" },
  { tier: 5, flag: "commerce_windows_smoke", file: "tests/commerce_windows_smoke.test.mjs" },
  { tier: 5, flag: "inventory_drag_rules", file: "tests/inventory_drag_rules.test.mjs" },
  { tier: 5, flag: "inventory_dnd_dom", file: "tests/inventory_dnd_dom.test.mjs" },
  // 2026-10-08 — item handling parity: retail UseObject routing for shortcut
  // keys / Use button (?hotbarActivate), per-item cooldown overlay
  // (?slotCooldown), shortcut follows a merge / no wcid re-bind
  // (?shortcutRetarget). PlaceInBackpack (?retailPickup) is pinned in
  // inventory_drag_rules [9].
  { tier: 5, flag: "hotbarActivate", file: "tests/item_primary_use.test.mjs" },
  { tier: 5, flag: "slotCooldown", file: "tests/item_cooldown_step.test.mjs" },
  { tier: 5, flag: "shortcutRetarget", file: "tests/hotbar_merge_retarget.test.mjs" },
  // items-4 JS half (?retailAutoWear: AutoWearIsLegal refusal + ready-slot
  // merge), toolbar Use → activateItem, vendor split-before-sell.
  { tier: 5, flag: "retailAutoWear", file: "tests/item_wear_plan.test.mjs" },
  { tier: 5, flag: "toolbarUseActivate", file: "tests/toolbar_use_activate.test.mjs" },
  { tier: 5, flag: "vendorSellSplit", file: "tests/vendor_sell_split.test.mjs" },
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
  { tier: 5, flag: "light_pool", file: "test_light_pool.mjs" },
  { tier: 5, flag: "light_guard", file: "test_light_guard.mjs" },
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
  // 2026-10-19 — waterfalls: ?rp6TravelReach (cull sphere = particle travel),
  // ?rp6DegradeCap (draw to the authored 392 m), the stretch teleport speed,
  // ?particleAlphaRetail states — real retail waterfall emitters.
  { tier: 5, flag: "particle_waterfall_reach", file: "test_particle_waterfall_reach.mjs" },
  // 2026-10-08 PLIFECYCLE-2/-5: retail degrade freeze for RP6-culled emitters;
  // static default_script hooks fire at their start_time.
  { tier: 5, flag: "particleCullFreeze", file: "tests/particle_cull_freeze.test.mjs" },
  // 2026-10-17 cpuframe: the static manager ticks once per frame (statics.js
  // loads twice → two _spLoop drivers), RP6 cadence kept.
  { tier: 5, flag: "particleTickOnce", file: "tests/particle_tick_once.test.mjs" },
  { tier: 5, flag: "particleCulledLean", file: "tests/particle_culled_lean.test.mjs" },
  { tier: 5, flag: "staticScriptHookTime", file: "tests/static_script_hooktime.test.mjs" },
  { tier: 5, flag: "particle_single_pass", file: "test_particle_single_pass.mjs" },
  { tier: 5, flag: "particles", file: "test_particles.mjs" },
  { tier: 5, flag: "phase7_5_camera", file: "test_phase7_5_camera.mjs" },
  { tier: 5, flag: "portal_stencil_alloc", file: "test_portal_stencil_alloc.mjs" },
  // 2026-08-14 (LANE A). Both suites existed and NO runner invoked either, so
  // the punch occlusion gate — the fix for "interiors visible through walls" —
  // was protected by nothing while its default was being argued about. The
  // GATE suite pins the MARK/PUNCH material invariants; the FLAG suite pins the
  // wiring, i.e. that the DEFAULT path still allocates no stencil attachment
  // and no packed depth-stencil texture (the 2026-08-13 distant-view blackout).
  { tier: 5, flag: "portal_punch_occlusion_gate", file: "tests/portal_punch_occlusion_gate.test.mjs" },
  { tier: 5, flag: "portal_punch_occlusion_flag", file: "tests/portal_punch_occlusion_flag.test.mjs" },
  { tier: 5, flag: "sealLogDepth", file: "tests/portal_seal_logdepth.test.mjs" },
  { tier: 5, flag: "sealLogDepth(retailOrder)", file: "tests/portal_seal_retail_order.test.mjs" },
  { tier: 5, flag: "portal_shader_decls", file: "tests/portal_shader_decls.test.mjs" },
  // …and the clip suite the punch FEED calls every frame (`clipAperturesForPunch`),
  // unregistered since it was written. 59 assertion groups, green.
  { tier: 5, flag: "portal_clip", file: "tests/portal_clip.test.mjs" },
  { tier: 5, flag: "portalPass2", file: "tests/portal_pass2.test.mjs" },
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
  // 2026-10-22 B10 / handoff P1d: the terrain batch program without gl_DrawID (?terrainNoDrawId, default on since 2026-10-23).
  { tier: 5, flag: "terrainNoDrawId", file: "tests/terrain_batch_no_drawid.test.mjs" },
  { tier: 5, flag: "terrain_detail_tex", file: "test_terrain_detail_tex.mjs" },
  { tier: 5, flag: "terrain_dirt", file: "test_terrain_dirt.mjs" },
  { tier: 5, flag: "terrain_families", file: "test_terrain_families.mjs" },
  { tier: 5, flag: "terrain_grass_scatter", file: "test_terrain_grass_scatter.mjs" },
  // 2026-10-07 — grass/pebbles off the painted road (?grassOffRoad): real-DAT road masks + Holtburg.
  { tier: 5, flag: "terrain_grass_offroad", file: "test_terrain_grass_offroad.mjs" },
  { tier: 5, flag: "terrain_grass_shader", file: "test_terrain_grass_shader.mjs" },
  // 2026-10-12 — grass LOD rings (?terrainGrassReach): same budget, 5x reach.
  { tier: 5, flag: "terrain_grass_lod", file: "test_terrain_grass_lod.mjs" },
  // 2026-10-23 — grass placement in the vertex shader (?terrainGrassGpu): terrain
  // field textures, interior-mask GPU mirror, placement GLSL + tile cull, and the
  // provider integration (real-DAT parity vs the CPU pools).
  { tier: 5, flag: "terrain_field_gpu", file: "test_terrain_field_gpu.mjs" },
  { tier: 5, flag: "grass_interior_mask_gpu", file: "test_grass_interior_mask_gpu.mjs" },
  { tier: 5, flag: "grass_gpu_place", file: "test_grass_gpu_place.mjs" },
  { tier: 5, flag: "terrain_grass_gpu", file: "test_terrain_grass_gpu.mjs" },
  { tier: 5, flag: "terrain_oracle", file: "test_terrain_oracle.mjs" },
  { tier: 5, flag: "terrain_palette", file: "test_terrain_palette.mjs" },
  { flag: "terrainCellFracClamp", file: "test_terrain_cell_frac_clamp.mjs" },
  // 2026-10-07 — terrain corner rounding: real-DAT deviation bound + crack-free seams.
  { tier: 5, flag: "terrain_round", file: "test_terrain_round.mjs" },
  // 2026-10-07 — terrain rounding step 3: objects drawn on the rounded ground (real DAT).
  { tier: 5, flag: "visual_ground", file: "test_visual_ground.mjs" },
  // 2026-10-07 — terrain fine detail (step 4): micro-relief maths, height blend,
  // gamma crossfade, mip-seam taps, sampler budget on the assembled program.
  { tier: 5, flag: "terrain_micro", file: "test_terrain_micro.mjs" },
  { tier: 5, flag: "terrainFarSimplify", file: "tests/terrain_far_simplify.test.mjs" },
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
  // 2026-10-19 — water flows downstream (?waterFlow) + banked swell (?waterBank):
  // real-DAT Marae Lassel dam decks, crack-free shores, the shipped flow table,
  // the real batched derivation, flag variants.
  { tier: 5, flag: "terrain_water_flow", file: "test_terrain_water_flow.mjs" },
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
  // 2026-10-05 — formerly UNREGISTERED suites; each executed and green.
  { tier: 5, flag: "bc7_record_budget", file: "test_bc7_record_budget.mjs" },
  { tier: 5, flag: "cam_moving_bench", file: "test_cam_moving_bench.mjs" },
  { tier: 5, flag: "dead_batch_skip", file: "test_dead_batch_skip.mjs" },
  { tier: 5, flag: "draw_sort_program", file: "test_draw_sort_program.mjs" },
  // 2026-10-06 1070 perf campaign (occlusion queries, async shader link guard,
  // hidden-subtree matrix skip, alpha particle instancing, NRA pack LUTs).
  { tier: 5, flag: "occlusion_cull", file: "test_occlusion_cull.mjs" },
  // 2026-10-17 outdoor fps wave 1 (interiors): no interior sun shadows while outdoors; interiors
  // drawn from outdoors only through an in-view door/window aperture.
  { tier: 5, flag: "interiorShadowCull", file: "tests/interior_shadow_cull.test.mjs" },
  { tier: 5, flag: "interiorApertureCull", file: "tests/interior_aperture_cull.test.mjs" },
  { tier: 5, flag: "async_link_guard", file: "test_async_link_guard.mjs" },
  { tier: 5, flag: "skip_hidden_matrix", file: "test_skip_hidden_matrix.mjs" },
  { tier: 5, flag: "particle_inst_alpha", file: "test_particle_inst_alpha.mjs" },
  { tier: 5, flag: "nra_pack_lut", file: "test_nra_pack_lut.mjs" },
  { tier: 5, flag: "batch_mat_variant_clone", file: "test_batch_mat_variant_clone.mjs" },
  // 2026-10-06 session 3 — first-turn hitch (point/spot light loops kept as loops), retail
  // per-part degrade, per-cell interior prop merge, the shared alpha particle bucket, and the
  // two suites the gate used to report UNREGISTERED.
  { tier: 5, flag: "light_loops", file: "test_light_loops.mjs" },
  { tier: 5, flag: "part_degrade", file: "test_part_degrade.mjs" },
  { tier: 5, flag: "cell_static_merge", file: "test_cell_static_merge.mjs" },
  { tier: 5, flag: "particle_shared_alpha", file: "test_particle_shared_alpha.mjs" },
  // 2026-10-07 code review: a transient PhysicsScriptTable failure is retried, not cached.
  { tier: 5, flag: "ac_physics_script_table", file: "test_ac_physics_script_table.mjs" },
  // 2026-10-06 remote-console fixes: the pre-3D entity backlog keeps state events;
  // the missing-link warning fires only for real swings / casts.
  { tier: 5, flag: "entity_backlog", file: "test_entity_backlog.mjs" },
  { tier: 5, flag: "motion_link_diag", file: "test_motion_link_diag.mjs" },
  { tier: 5, flag: "anim_cache_evict_dispose", file: "test_anim_cache_evict_dispose.mjs" },
  { tier: 5, flag: "particle_time_latch", file: "test_particle_time_latch.mjs" },
  { tier: 5, flag: "fog_probe_pbo_unbind", file: "test_fog_probe_pbo_unbind.mjs" },
  // 2026-10-17 cpuframe: far-fog probe read through a persistent PBO + fence, read a frame later.
  { tier: 5, flag: "farFogFence", file: "tests/far_fog_fence.test.mjs" },
  { tier: 5, flag: "frame_split_probe", file: "test_frame_split_probe.mjs" },
  { tier: 5, flag: "landblock_lru_frame_slot", file: "test_landblock_lru_frame_slot.mjs" },
  { tier: 5, flag: "mem_census", file: "test_mem_census.mjs" },
  { tier: 5, flag: "object_radius", file: "test_object_radius.mjs" },
  { tier: 5, flag: "paletted_dedup", file: "test_paletted_dedup.mjs" },
  { tier: 5, flag: "stall_probe", file: "test_stall_probe.mjs" },
  { tier: 5, flag: "stat_array_merge", file: "test_stat_array_merge.mjs" },
  { tier: 5, flag: "stat_batch_memo_slots", file: "test_stat_batch_memo_slots.mjs" },
  { tier: 5, flag: "stat_batch_runs", file: "test_stat_batch_runs.mjs" },
  { tier: 5, flag: "stat_batch_value_key", file: "test_stat_batch_value_key.mjs" },
  { tier: 5, flag: "stat_batch_walk", file: "test_stat_batch_walk.mjs" },
  // 2026-10-07 shadow/batch path trims (1070 ultra, CSM re-rastering every frame):
  // per-camera BatchedMesh indirect textures, one scene walk per shadow raster,
  // empty multidraws skip three's draw setup.
  { tier: 5, flag: "bm_indirect_per_camera", file: "test_bm_indirect_per_camera.mjs" },
  { tier: 5, flag: "shadow_caster_list", file: "test_shadow_caster_list.mjs" },
  // fps wave 1 (2026-10-17): the static-shadow gate re-rasters only the
  // cascades a rig change touches (hidden rigs are not casters).
  { tier: 5, flag: "shadowMoverScope", file: "tests/shadow_mover_scope.test.mjs" },
  // fps wave 1 (2026-10-17): cached static cascade depth + a dynamic-only
  // overlay pass (depth-content model over three's real WebGLShadowMap).
  { tier: 5, flag: "shadowStaticCache", file: "tests/shadow_static_cache.test.mjs" },
  // 2026-10-20 improvement hunt (shadows lane): caster list sorted by depth-program
  // kind (shadows-restore-6), CSM depth fit + texel bias (-7), off-screen rig casters
  // (-8), three r184's 2D PCF bias sign under reversed-Z (recent-render-diff-2).
  { tier: 5, flag: "shadowCasterSort+shadowProgramStats", file: "tests/shadow_caster_sort.test.mjs" },
  { tier: 5, flag: "csmBias+csmBiasTexels", file: "tests/csm_depth_fit.test.mjs" },
  { tier: 5, flag: "csmOffscreenCasters", file: "tests/csm_offscreen_casters.test.mjs" },
  { tier: 5, flag: "reversedZ(pcfShadowFix)", file: "tests/reversed_pcf_shadow.test.mjs" },
  { tier: 5, flag: "skip_empty_multidraw", file: "test_skip_empty_multidraw.mjs" },
  // 2026-10-19 fps review: an unsorted static bucket's repeated ranges drawn as per-geometry
  // instanced runs (ANGLE/D3D11 loops a multidraw range by range on CrGpuMain).
  { tier: 5, flag: "batchedRuns", file: "tests/batched_runs.test.mjs" },
  // 2026-10-22 P1a/F2: atlas buckets share geometry per (content, layer) so batchedRuns regroups them.
  { tier: 5, flag: "atlasGeomDedup", file: "tests/atlas_geom_dedup.test.mjs" },
  // 2026-10-22 B9/L1: sorted buckets as order-keeping consecutive runs; the O(1) compare skip for early-out buckets.
  { tier: 5, flag: "batchedRunsSorted", file: "tests/batched_runs_sorted.test.mjs" },
  { tier: 5, flag: "batchedRunsStable", file: "tests/batched_runs_stable.test.mjs" },
  // 2026-10-22 handoff P2 / L0 + B9a: opaque static + building buckets on three's BatchedMesh early-out (?staticEarlyOut, default on since 2026-10-23); building buckets marked for batchedRuns.
  { tier: 5, flag: "staticEarlyOut", file: "tests/static_early_out.test.mjs" },
  // 2026-10-22 handoff P4 spike (§6 L3, harness only, no flag): vertex pulling vs BatchedMesh runs, the CPU half
  // (three premises, the GLSL patch, both draws emulated corner by corner). GPU half: harness/glsl_smoke/vertex_pull_smoke.mjs.
  { tier: 5, flag: "vertexPullSpike", file: "tests/vertex_pull_spike.test.mjs" },
  // 2026-10-22 GPU-resident statics P0 prep: the page-side structure read
  // (scripts/perf-worker/structure-p0.eval.js), the laptop twin's URL contract and the P0 1070 queue entry.
  { tier: 5, flag: "p0StructureProbe", file: "tests/structure_p0_probe.test.mjs" },
  // 2026-10-19 fps review: reversed-Z default-on, and the terrain sorts after its occluders
  // when no doorway punch draws (early-Z skips covered terrain).
  { tier: 5, flag: "terrainLast", file: "tests/terrain_last.test.mjs" },
  { tier: 5, flag: "cloudResScale", file: "tests/cloud_res_scale.test.mjs" },
  // 2026-10-19 fps review: the DOM HUD rasters on Chrome's GPU-process main thread (the one that
  // executes WebGL) — minimap writes only on change, radar repaints only on change, the vitals
  // orbs' CSS loops follow the orb cadence instead of the display rate.
  { tier: 5, flag: "hud_map_marks", file: "tests/hud_map_marks.test.mjs" },
  { tier: 5, flag: "hud_radar_paint", file: "tests/hud_radar_paint.test.mjs" },
  { tier: 5, flag: "orbAnimSync", file: "tests/hud_orb_anim_sync.test.mjs" },
  // 2026-10-19 fps review: the scene-walk census (__skipHiddenMatrix.census) — what a static
  // container freeze could save (`forcedOnly`) before anyone builds one.
  { tier: 5, flag: "matrix_walk_census", file: "tests/matrix_walk_census.test.mjs" },
  // 2026-10-19 fps review, the three A/B arms (all default off): the frozen world containers
  // (exact vs three's cascade), a depth band ahead of the program key in the opaque sort, and
  // a canvas without a depth buffer (direct path + portal tunnel through an offscreen target).
  { tier: 5, flag: "freezeWorldRoots", file: "tests/freeze_world_roots.test.mjs" },
  { tier: 5, flag: "depthBandSort", file: "tests/depth_band_sort.test.mjs" },
  { tier: 5, flag: "canvasDepth", file: "tests/canvas_depth.test.mjs" },
  { tier: 5, flag: "static_atlas_growth", file: "test_static_atlas_growth.mjs" },
  { tier: 5, flag: "static_atlas_pages", file: "test_static_atlas_pages.mjs" },
  { tier: 5, flag: "static_geom_cache", file: "test_static_geom_cache.mjs" },
  { tier: 5, flag: "static_merge_projection", file: "test_static_merge_projection.mjs" },
  { tier: 5, flag: "surface_planes", file: "test_surface_planes.mjs" },
  { tier: 5, flag: "texture_census", file: "test_texture_census.mjs" },
  { tier: 5, flag: "texture_census_real_three", file: "test_texture_census_real_three.mjs" },
  { tier: 5, flag: "texture_rehydrate", file: "test_texture_rehydrate.mjs" },
  { tier: 5, flag: "texture_release", file: "test_texture_release.mjs" },
  { tier: 5, flag: "cmt_attack_type_collapse", file: "tests/cmt_attack_type_collapse.test.mjs" },
  { tier: 5, flag: "motion_pending_queue", file: "tests/motion_pending_queue.test.mjs" },
  { tier: 5, flag: "tradeskill_receiver", file: "tests/test_tradeskill_receiver.mjs" },
  // 2026-10-05 — harness/test_*.mjs suites: the coverage guard never scanned
  // harness/, so 25 of these 26 ran nowhere. Each executed and green.
  // Needs the (deliberately uncommitted) esbuild binary: $ESBUILD_BIN or the
  // scripts/build-shell.mjs ESBUILD_DEFAULT path.
  { tier: 5, flag: "harness_build_shell", file: "harness/test_build_shell.mjs",
    requires: () => process.env.ESBUILD_BIN || "/mnt/wbterminal2/reeng/T11/bin/esbuild" },
  { tier: 5, flag: "harness_cell_fusion", file: "harness/test_cell_fusion.mjs" },
  { tier: 5, flag: "harness_census_class", file: "harness/test_census_class.mjs" },
  { tier: 5, flag: "harness_console_allowlist", file: "harness/test_console_allowlist.mjs" },
  { tier: 5, flag: "harness_diag_schema", file: "harness/test_diag_schema.mjs" },
  { tier: 5, flag: "harness_draw_pools", file: "harness/test_draw_pools.mjs" },
  { tier: 5, flag: "harness_frame_phase_census", file: "harness/test_frame_phase_census.mjs" },
  { tier: 5, flag: "harness_frame_work", file: "harness/test_frame_work.mjs" },
  { tier: 5, flag: "harness_geom_bundles", file: "harness/test_geom_bundles.mjs" },
  // 2026-10-22 F7a / HBG1 v2: the ?negFace face-marker reader seam (descriptor fold, once-only warning).
  { tier: 5, flag: "geomBundlesNegFace", file: "tests/geom_bundles_negface.test.mjs" },
  { tier: 5, flag: "harness_moving_bench_boot", file: "harness/test_moving_bench_boot.mjs" },
  { tier: 5, flag: "harness_nra_derive", file: "harness/test_nra_derive.mjs" },
  { tier: 5, flag: "harness_pack_fetch_controller", file: "harness/test_pack_fetch_controller.mjs" },
  { tier: 5, flag: "harness_pack_fetch_region", file: "harness/test_pack_fetch_region.mjs",
    requires: "/mnt/wbterminal2/reeng/T10/ci-run1/manifest.json" },
  { tier: 5, flag: "harness_page_resample_texref", file: "harness/test_page_resample_texref.mjs" },
  { tier: 5, flag: "harness_report_v2", file: "harness/test_report_v2.mjs" },
  { tier: 5, flag: "harness_residency_grid", file: "harness/test_residency_grid.mjs" },
  { tier: 5, flag: "harness_rsid_marker", file: "harness/test_rsid_marker.mjs" },
  { tier: 5, flag: "harness_service_worker_v3", file: "harness/test_service_worker_v3.mjs" },
  { tier: 5, flag: "harness_slotgrid_lru_assert", file: "harness/test_slotgrid_lru_assert.mjs" },
  // Reads the deployed slice packs: absent dist → NO-FIXTURE (CI has no bake).
  { tier: 5, flag: "inventoryActionFailed(kind48)", file: "tests/rejection_feedback_kind48.test.mjs" },
  { tier: 5, flag: "framePose(cache)", file: "tests/frame_pose.test.mjs" },
  // 2026-10-05 — the ClientEvent dispatcher moved out of index.html into
  // app/client_events.js; pins the loop-control -> return conversion.
  { tier: 5, flag: "appClientEvents", file: "tests/app_client_events.test.mjs" },
  { tier: 5, flag: "attackableTarget", file: "tests/attackable_target.test.mjs" },
  { tier: 5, flag: "latencyDiag", file: "tests/latency_diag.test.mjs" },
  // OpenAC comparison 2026-10-04, remote motion D7: wasm/JS wiring of the
  // remote jump arc that lives in the Rust remote body (Rust unit tests
  // cover the physics).
  { tier: 5, flag: "remoteJumpArc", file: "tests/remote_jump_arc.test.mjs" },
  // Remote motion D6 regression pin: both sticky radii reach the wasm lane.
  { tier: 5, flag: "remoteStickyRadius", file: "tests/remote_sticky_radius.test.mjs" },
  // moveto-1 (2026-10-08): a sticky-bit remote MoveToObject sticks on arrival,
  // not at arm time (source pins over the wasm UpdateMotion arm).
  { tier: 5, flag: "remoteMoveToStickyArrival", file: "tests/remote_moveto_sticky_arrival.test.mjs" },
  { tier: 5, flag: "harness_terrain_tier_ladder", file: "harness/test_terrain_tier_ladder.mjs",
    requires: "../../dist/manifest.json" },
  // 2026-10-06 — slow-link boot (666 kbps measured on the 1070): bandwidth
  // tier, atmosphere LUT plan, parallel plugin manifests + bundled-plugin
  // registry, wasm preload stamp, proxy shell gate, regional cell catalogs.
  { tier: 5, flag: "bandwidth_tier", file: "test_bandwidth_tier.mjs" },
  { tier: 5, flag: "atmosphere_lut_plan", file: "test_atmosphere_lut_plan.mjs" },
  { tier: 5, flag: "plugin_manifest_parallel", file: "test_plugin_manifest_parallel.mjs" },
  { tier: 5, flag: "wasm_preload_stamp", file: "test_wasm_preload_stamp.mjs" },
  { tier: 5, flag: "harness_shell_gate", file: "harness/test_shell_gate.mjs" },
  { tier: 5, flag: "harness_catalog_regions", file: "harness/test_catalog_regions.mjs",
    requires: "/mnt/wbterminal2/holtburger-dist" },
  { tier: 5, flag: "harness_tex_compressed_only", file: "harness/test_tex_compressed_only.mjs" },
  { tier: 5, flag: "harness_texchan_decode", file: "harness/test_texchan_decode.mjs",
    requires: "/mnt/wbterminal2/holtburger-dist/suite/texchan-manifest.json" },
  { tier: 5, flag: "harness_texture_worker", file: "harness/test_texture_worker.mjs" },
  { tier: 5, flag: "harness_texture_worker_real", file: "harness/test_texture_worker_real.mjs",
    requires: "/mnt/wbterminal2/xubc7-corpus/statics-lossless/0x06003789.ktx2" },
  { tier: 5, flag: "harness_wind_fallback_peel", file: "harness/test_wind_fallback_peel.mjs" },
  // 2026-10-05 — un-QUARANTINED: each was repaired (stale assertion or rotted
  // loader — per-file comments carry the evidence) and now passes.
  { tier: 5, flag: "a15_q1_entity_buffer_caps", file: "test_a15_q1_entity_buffer_caps.mjs" },
  { tier: 5, flag: "a15_q3_dispatch_parity", file: "test_a15_q3_dispatch_parity.mjs" },
  { tier: 5, flag: "a1_o4_single_frame_driver", file: "test_a1_o4_single_frame_driver.mjs" },
  { tier: 5, flag: "a5_p2_tween_clock", file: "test_a5_p2_tween_clock.mjs" },
  { tier: 5, flag: "cast_motion_drains", file: "test_cast_motion_drains.mjs" },
  { tier: 5, flag: "diag_spawnfailed_lbkey", file: "test_diag_spawnfailed_lbkey.mjs" },
  { tier: 5, flag: "envcell_guard", file: "test_envcell_guard.mjs" },
  { tier: 5, flag: "examine_dye_preview", file: "test_examine_dye_preview.mjs" },
  { tier: 5, flag: "f10_hud_nameplate", file: "test_f10_hud_nameplate.mjs" },
  { tier: 5, flag: "fixed_grid_park", file: "test_fixed_grid_park.mjs" },
  { tier: 5, flag: "mat_budget_lru", file: "test_mat_budget_lru.mjs" },
  { tier: 5, flag: "per_vital_events", file: "test_per_vital_events.mjs" },
  { tier: 5, flag: "phase7_4a_animation_clip", file: "test_phase7_4a_animation_clip.mjs" },
  { tier: 5, flag: "phase7_4b_entity_pipeline", file: "test_phase7_4b_entity_pipeline.mjs" },
  { tier: 5, flag: "phase7_6_lighting", file: "test_phase7_6_lighting.mjs" },
  { tier: 5, flag: "phase7_batch7_omega_basescale", file: "test_phase7_batch7_omega_basescale.mjs" },
  { tier: 5, flag: "phase7_batch9_entity_lifecycle", file: "test_phase7_batch9_entity_lifecycle.mjs" },
  { tier: 5, flag: "picking_resolve", file: "test_picking_resolve.mjs" },
  { tier: 5, flag: "play_effect_resolver", file: "test_play_effect_resolver.mjs" },
  { tier: 5, flag: "plugin_index_gen", file: "test_plugin_index_gen.mjs" },
  { tier: 5, flag: "pure_smooth_prediction", file: "test_pure_smooth_prediction.mjs" },
  { tier: 5, flag: "recolor_escape_entmb", file: "test_recolor_escape_entmb.mjs" },
  { tier: 5, flag: "sky_lighting", file: "test_sky_lighting.mjs" },
  { tier: 5, flag: "stat_geom_dedup", file: "test_stat_geom_dedup.mjs" },
  { tier: 5, flag: "status_indicators", file: "test_status_indicators.mjs" },
  { tier: 5, flag: "terrain_dirt_shader", file: "test_terrain_dirt_shader.mjs" },
  { tier: 5, flag: "terrain_ice", file: "test_terrain_ice.mjs" },
  { tier: 5, flag: "terrain_sand_sparkle", file: "test_terrain_sand_sparkle.mjs" },
  { tier: 5, flag: "terrain_snow", file: "test_terrain_snow.mjs" },
  { tier: 5, flag: "terrain_volcano_shader", file: "test_terrain_volcano_shader.mjs" },
  // 2026-10-05 — appeared mid-session (concurrent shader work); executed, green.
  { tier: 5, flag: "shader_logdepth", file: "test_shader_logdepth.mjs" },
  // 2026-10-08 — physupd-2 retail exact ballistic arc (`?projectileExactArc`).
  { tier: 5, flag: "projectileExactArc", file: "tests/projectile_ballistic_arc.test.mjs" },
  // 2026-10-08 — A3-selection: combat auto-target / range exit / retail cycle
  // on a real EntityManager (`?autoTarget`), and the sphere pick fallback.
  { tier: 5, flag: "autoTarget", file: "tests/auto_target.test.mjs" },
  { tier: 5, flag: "pickSphereFallback", file: "tests/pick_math.test.mjs" },
  // 2026-10-08 — R-chat round 2: retail chat command routing (Turbine room
  // ids, @ / : / ; prefixes, verb aliases, inline *pose*, /reply strings).
  { tier: 5, flag: "slashCommands", file: "tests/slash_commands.test.mjs" },
  // 2026-10-08 — R-misc round 2 daytime-1: the moon/star date follows the
  // server-synced sky clock (`?skyServerClock`).
  { tier: 5, flag: "skyServerClock", file: "tests/sky_game_date.test.mjs" },
  // 2026-10-11 — "Always daylight outdoors" (CharacterOption 0x05) pins the
  // sky clock to Midsong (retail LScape::SetDay / GetLighting(0.5)).
  { tier: 5, flag: "alwaysDaylight", file: "tests/always_daylight.test.mjs" },
  // 2026-10-11 — moons: Alb'arel's clouds fill the disc (no fold-back), banded
  // brush streaks, sphere lighting with real phases (`?moonFx`, `?moonPhase`).
  { tier: 5, flag: "moonFx", file: "tests/ac_moons_fx.test.mjs" },
  // 2026-10-11 — the always-on slow-run detector (`__diag.slowRun`): a held run
  // that stays >10 % under its expected rate names the stage that lost it.
  { tier: 5, flag: "slowRunDiag", file: "tests/slow_run_diag.test.mjs" },
  // 2026-10-08 — A1-held round 2: held-item attachment parity on a real
  // EntityManager (wire spawn decides the parent, PickupEvent leave-world,
  // per-child attach generation, no mount without a holding location).
  { tier: 5, flag: "wieldLedgerAuthority", file: "tests/held_ledger_wire_spawn.test.mjs" },
  { tier: 5, flag: "pickupLeaveWorld", file: "tests/pickup_leave_world.test.mjs" },
  { tier: 5, flag: "attachGen", file: "tests/held_attach_generation.test.mjs" },
  { tier: 5, flag: "heldMountStrict", file: "tests/held_missing_location.test.mjs" },
  // 2026-10-08 — B2-use-items round 2: retail ItemHolder::UseObject world
  // rules (Stuck fixtures are Used, toolbar / radial pickups, non-useable
  // refusals), the shared 0.2 s use throttle, and the SoundTable row memo.
  { tier: 5, flag: "retailUseResult", file: "tests/world_use_result.test.mjs" },
  { tier: 5, flag: "retailUseThrottle", file: "tests/use_throttle.test.mjs" },
  { tier: 5, flag: "soundTableRowMemo", file: "tests/audio_sound_table_cache.test.mjs" },
  // 2026-10-08 — A2-death round 2: selection drop at the server delete of a
  // death-held rig, the local-player corpse-claim exclusion, the death-hold
  // test the local revive reads, and the unopened-corpse cycle.
  { tier: 5, flag: "deathSelectRelease", file: "tests/death_selection.test.mjs" },
  // 2026-10-11 — the corpse is lootable while the ragdoll still falls: the
  // claimed rig picks/selects as its corpse (`?handoffLoot`).
  { tier: 5, flag: "handoffLoot", file: "tests/corpse_handoff_loot.test.mjs" },
  // 2026-10-08 — A3-radar-audio round 2 audio-2: sounds on a wielded item play
  // at the hand's world position (real EntityManager + attachChildToParent).
  { tier: 5, flag: "attachedSoundPos", file: "tests/audio_attached_emitter.test.mjs" },
  // 2026-10-08 (follow-ups) — use-3 remainder: a UseDone move failure
  // (0x23/0x37/0x38/0x39) closes the open ground container, as retail
  // HandleFailureEvent's SetGroundObject(0, 1) does (`?moveFailCloseGround`).
  { tier: 5, flag: "moveFailCloseGround", file: "tests/use_fail_ground_object.test.mjs" },
  // 2026-10-08 (follow-ups, batch 2) — moveto-4: a remote MoveTo's clip
  // follows the Rust MoveToManager node (turn in place → walk/run → Ready),
  // ClientEvent kind 67 → applyRemoteMoveToPhase (`?remoteMoveToPhase`).
  { tier: 5, flag: "remoteMoveToPhase", file: "tests/remote_moveto_phase.test.mjs" },
  // 2026-10-08 (follow-ups, batch 3) — streaming-teleport-2: the TeleportArrived
  // edge clears the autorun key mirror the wasm teleport hook turned off
  // (`?teleportHook`).
  { tier: 5, flag: "teleportHook", file: "tests/teleport_hook_autorun.test.mjs" },
  // 2026-10-08 (round 3) — crafting / books / portal busy: the server
  // ConfirmationRequest dialog (crafting-1), the retail gmSalvageUI suitability
  // gate + result chat line (crafting-2/3), gmBookUI page rules + examine
  // inscriptions (books-journal-1..4), portal space as busy (streaming-teleport-5).
  { tier: 5, flag: "serverConfirmUi", file: "tests/server_confirm.test.mjs" },
  { tier: 5, flag: "salvageSuitable", file: "tests/salvage_suitable.test.mjs" },
  { tier: 5, flag: "bookRetailPages", file: "tests/book_retail_pages.test.mjs" },
  { tier: 5, flag: "portalBusy", file: "tests/portal_busy.test.mjs" },
  // 2026-10-08 (round 4) — training / social commands / character select:
  // Unusable-section skills train + retail confirm text + real attribute /
  // vital spent xp (training-1..3), retail /friends /squelch /filter
  // /messagetypes client commands (social-lists-1), CharacterError texts,
  // greyed character rows, log-off on teardown (login-1..3).
  { tier: 5, flag: "trainUnusable", file: "tests/train_unusable.test.mjs" },
  { tier: 5, flag: "retailSocialCmds", file: "tests/social_commands.test.mjs" },
  { tier: 5, flag: "retailCharErrors", file: "tests/login_retail_rules.test.mjs" },
  // 2026-10-08 (round 5) — external containers: only the requested ground
  // object opens the window, retail's 1 s range close, the locked-container
  // line (extcontainer-1/2/4); the character panel's PK status (pk-5).
  { tier: 5, flag: "groundObjectGate", file: "tests/ground_container_gate.test.mjs" },
  { tier: 5, flag: "characterInfoPkStatus", file: "tests/character_info_pk_status.test.mjs" },
  // 2026-10-09 — the retail character screen (gmCharacterManagementUI) and its
  // pre-Enter warm-up of the selected character's last spot.
  { tier: 5, flag: "charSelect", file: "tests/character_select.test.mjs" },
  { tier: 5, flag: "spawnPreview", file: "tests/spawn_preview.test.mjs" },
  // 2026-10-09 — the char-gen getters' serde Maps reach the wizard as objects.
  { tier: 5, flag: "chargenCatalogPlain", file: "tests/chargen_catalog_plain.test.mjs" },
  { tier: 5, flag: "envcellSkirtWait", file: "tests/envcell_skirt_wait.test.mjs" },
  { tier: 5, flag: "interiorHold", file: "tests/interior_hold.test.mjs" },
  { tier: 5, flag: "gpuTierProbeMemo", file: "tests/gpu_tier_probe_memo.test.mjs" },
  { tier: 5, flag: "farBakeCompileAsync", file: "tests/far_bake_compile_async.test.mjs" },
  // 2026-10-11 — the bake rig shares the live terrain textures (1070: the BC7 ladder swap failed).
  { tier: 5, flag: "farBakeSharedTextures", file: "tests/far_bake_shared_textures.test.mjs" },
  // 2026-10-11 — a T9 LOD respawn uses the tick's band and is no deselect (1070: attacks cancelled).
  { tier: 5, flag: "lodRespawnSelection", file: "tests/lod_respawn_selection.test.mjs" },
  // 2026-10-11 — spine rows carry their rotation (1070: a vendor turned 102 degrees in one frame).
  { tier: 5, flag: "remoteSpineHeading", file: "tests/remote_spine_heading.test.mjs" },
  // 2026-10-11 — the "Disable most weather effects" / "Disable distance fog" options did nothing.
  { tier: 5, flag: "visualOptions", file: "tests/visual_options.test.mjs" },
  { tier: 5, flag: "envcellStaticsOverlap", file: "tests/envcell_statics_overlap.test.mjs" },
  { tier: 5, flag: "entityParticleLayer", file: "tests/entity_particle_layer.test.mjs" },
  // 2026-10-09 cold-load structural pass (ultracode brief): A0/A1-lite interior record fetch,
  // C progressive HD textures, D login portal space + load-time main thread.
  { tier: 5, flag: "interiorStabBatch", file: "tests/interior_stab_batch.test.mjs" },
  { tier: 5, flag: "interiorEarlyBake", file: "tests/interior_early_bake.test.mjs" },
  { tier: 5, flag: "surfaceWalkLite", file: "tests/surface_walk_lite.test.mjs" },
  { tier: 5, flag: "texUpgradeQueue", file: "tests/tex_upgrade_queue.test.mjs" },
  { tier: 5, flag: "loginPortalSpace", file: "tests/login_portal_space.test.mjs" },
  { tier: 5, flag: "asyncLinkKeySig", file: "tests/async_link_key_sig.test.mjs" },
  { tier: 5, flag: "alphaMaskSlice", file: "tests/alpha_mask_slice.test.mjs" },
  { tier: 5, flag: "bakeSurfaceCoalesce", file: "tests/bake_surface_coalesce.test.mjs" },
  { tier: 5, flag: "interiorBuildShare", file: "tests/interior_build_share.test.mjs" },
  { tier: 5, flag: "shardFetchWorker", file: "tests/shard_fetch_worker.test.mjs" },
  { tier: 5, flag: "interiorWallsFirst", file: "tests/interior_walls_first.test.mjs" },
  // 2026-10-09 round 2: D2 (programs warmed during the tunnel, PMREM precompile, far patches in the
  // link guard) and A2 (pack path; effective under ?packSource only, except bakeUrgentReserve=all).
  { tier: 5, flag: "tunnelWorldWarm", file: "tests/tunnel_world_warm.test.mjs" },
  { tier: 5, flag: "packWorkerFetchShare", file: "tests/pack_worker_fetch_share.test.mjs" },
  { tier: 5, flag: "bakeUrgentReserve", file: "tests/bake_urgent_reserve.test.mjs" },
  { tier: 5, flag: "packRingHold", file: "tests/pack_ring_hold.test.mjs" },
  // 2026-10-12 RynthSuite update: the host seam vs the Oct client, the ?bot=1 /
  // HUD boot config (oracle vs the pre-move block), the HUD bridge view-model +
  // commands, and the HUD DOM smoke.
  { tier: 5, flag: "rynthWebhostSeam", file: "rynth/test_webhost_seam_update.mjs" },
  { tier: 5, flag: "rynthBootConfig", file: "tests/rynth_boot_config.test.mjs" },
  { tier: 5, flag: "rynthHudBridge", file: "tests/rynth_hud_bridge.test.mjs" },
  { tier: 5, flag: "rynthHudDom", file: "tests/rynth_hud_dom.test.mjs" },
  // 2026-10-12 RynthSuite VTank features, Wave 1 (rynth/vt/**, not yet wired into the bot):
  // expression engine, settings + profiles, meta engine, /rs commands, VT nav, monster list +
  // attack planner, host seam additions, support behaviours.
  { tier: 5, flag: "rynthVtExpr", file: "tests/rynth_vt_expr.test.mjs" },
  { tier: 5, flag: "rynthVtExprStdlib", file: "tests/rynth_vt_expr_stdlib.test.mjs" },
  { tier: 5, flag: "rynthVtSettings", file: "tests/rynth_vt_settings.test.mjs" },
  { tier: 5, flag: "rynthVtProfiles", file: "tests/rynth_vt_profiles.test.mjs" },
  { tier: 5, flag: "rynthVtMetaEngine", file: "tests/rynth_vt_meta_engine.test.mjs" },
  { tier: 5, flag: "rynthVtMetaConditions", file: "tests/rynth_vt_meta_conditions.test.mjs" },
  { tier: 5, flag: "rynthVtMetaViews", file: "tests/rynth_vt_meta_views.test.mjs" },
  { tier: 5, flag: "rynthVtRsCommands", file: "tests/rynth_vt_rs_commands.test.mjs" },
  { tier: 5, flag: "rynthVtHostFns", file: "tests/rynth_vt_host_fns.test.mjs" },
  { tier: 5, flag: "rynthVtNavModel", file: "tests/rynth_vt_nav_model.test.mjs" },
  { tier: 5, flag: "rynthVtActiveNav", file: "tests/rynth_vt_active_nav.test.mjs" },
  { tier: 5, flag: "rynthVtMonsters", file: "tests/rynth_vt_monsters.test.mjs" },
  { tier: 5, flag: "rynthVtPlanner", file: "tests/rynth_vt_planner.test.mjs" },
  { tier: 5, flag: "rynthVtSpellTables", file: "tests/rynth_vt_spell_tables.test.mjs" },
  { tier: 5, flag: "rynthWebhostVtSeam", file: "rynth/test_webhost_vt_seam.mjs" },
  { tier: 5, flag: "rynthVtHostSignals", file: "tests/rynth_vt_host_signals.test.mjs" },
  { tier: 5, flag: "rynthVtPageSeams", file: "tests/rynth_vt_page_seams.test.mjs" },
  { tier: 5, flag: "rynthVtSupportVitals", file: "tests/rynth_vt_support_vitals.test.mjs" },
  { tier: 5, flag: "rynthVtSupportInventory", file: "tests/rynth_vt_support_inventory.test.mjs" },
  { tier: 5, flag: "rynthVtSupportMisc", file: "tests/rynth_vt_support_misc.test.mjs" },
  // Wave 1, last two packages: .met / .af / view XML / .utl formats, and the VT bridge + panel.
  { tier: 5, flag: "rynthVtFormatsMeta", file: "tests/rynth_vt_formats_meta.test.mjs" },
  { tier: 5, flag: "rynthVtFormatsUtl", file: "tests/rynth_vt_formats_utl.test.mjs" },
  { tier: 5, flag: "rynthVtBridge", file: "tests/rynth_vt_bridge.test.mjs" },
  { tier: 5, flag: "rynthVtPanelDom", file: "tests/rynth_vt_panel_dom.test.mjs" },
  // Wave 2 (wiring): INT-1 kernel aux ladder (T-K1 frozen oracle, T-K2 64-case equivalence) + loop-hook goldens.
  { tier: 5, flag: "rynthVtKernelAux", file: "tests/rynth_vt_kernel_aux.test.mjs" },
  { tier: 5, flag: "rynthVtLoopHooks", file: "tests/rynth_vt_loop_hooks.test.mjs" },
  // INT-2 composition root + bot wiring, and T-P1: the Default layer vs config.vt=false, identical traces.
  { tier: 5, flag: "rynthVtLayer", file: "tests/rynth_vt_layer.test.mjs" },
  { tier: 5, flag: "rynthVtWiring", file: "tests/rynth_vt_wiring.test.mjs" },
  { tier: 5, flag: "rynthVtParity", file: "tests/rynth_vt_parity.test.mjs" },
  // INT-3 page entry: the /rs /vt /ra /mt /ub chat branch (never reaches ACE) and the HUD VT button / provider.
  { tier: 5, flag: "rynthVtSlash", file: "tests/rynth_vt_slash.test.mjs" },
  { tier: 5, flag: "rynthVtHudIntegration", file: "tests/rynth_vt_hud_integration.test.mjs" },
  // 2026-10-13 — WebAC comparison suites (docs/webac-comparison-2026-10-13/FINDINGS.md).
  { tier: 5, flag: "movementKeysByCode", file: "tests/movement_key_of.test.mjs" },
  { tier: 5, flag: "cameraFollowDragRelease", file: "tests/camera_follow_drag_release.test.mjs" },
  { tier: 5, flag: "netPumpBeat", file: "tests/net_pump_beat.test.mjs" },
  { tier: 5, flag: "audioUrgentFetch", file: "tests/audio_urgent_fetch.test.mjs" },
  { tier: 5, flag: "wavePrefetch", file: "tests/audio_wave_prefetch.test.mjs" },
  { tier: 5, flag: "audio_retail_ui_sounds", file: "tests/audio_retail_ui_sounds.test.mjs" },
  { tier: 5, flag: "audioRetailPan_setpan", file: "tests/audio_retail_setpan.test.mjs" },
  { tier: 5, flag: "audio_mp3_wave_bytes", file: "tests/audio_mp3_wave_bytes.test.mjs" },
  { tier: 5, flag: "audio_sound_prefs", file: "tests/audio_sound_prefs.test.mjs" },
  { tier: 5, flag: "options_sound_prefs", file: "tests/options_sound_prefs.test.mjs" },
  { tier: 4, flag: "combatFxBus", file: "tests/combat_fx_bus_detail.test.mjs" },
  { tier: 5, flag: "rigCellGate", file: "tests/entity_cell_cull.test.mjs" },
  { tier: 5, flag: "indoorLandscapeGate", file: "tests/indoor_landscape_gate.test.mjs" },
  { tier: 5, flag: "portalFovFade", file: "tests/portal_fov_fade.test.mjs" },
  { tier: 5, flag: "portalDrone", file: "tests/portal_drone.test.mjs" },
  { tier: 5, flag: "retailSilentFailures", file: "tests/retail_silent_failures.test.mjs" },
  { tier: 5, flag: "retailFailureText", file: "tests/weenie_error_messages_delegate.test.mjs" },
  { tier: 5, flag: "rangedSpeechGate", file: "tests/ranged_speech_gate.test.mjs" },
  { tier: 5, flag: "buffExpiryLine", file: "tests/buff_expiry_line.test.mjs" },
  { tier: 5, flag: "inventoryActionFailed(pairedLine)", file: "tests/rejection_feedback_paired_line.test.mjs" },
  { tier: 5, flag: "spewBox", file: "tests/chat_log_errors_filter.test.mjs" },
  { tier: 5, flag: "spewBox", file: "tests/rejection_toast_stack.test.mjs" },
  { tier: 5, flag: "popupDialog", file: "tests/popup_string_dialog.test.mjs" },
  { tier: 5, flag: "modalDialogOkOnly", file: "tests/modal_dialog_ok_only.test.mjs" },
  { tier: 5, flag: "retailStatusCmds", file: "tests/slash_age_birth.test.mjs" },
  { tier: 5, flag: "attack_repeat_state", file: "tests/attack_repeat_state.test.mjs" },
  { tier: 5, flag: "combatHitChatLines", file: "tests/combat_hit_chat_lines.test.mjs" },
  { tier: 5, flag: "escapeAction", file: "tests/escape_action.test.mjs" },
  { tier: 5, flag: "combatModePark", file: "tests/combat_mode_pending.test.mjs" },
  { tier: 5, flag: "surfaceAnim", file: "tests/surface_anim_flag.test.mjs" },
  { tier: 5, flag: "examineWieldRequirements", file: "tests/examine_wield_requirements.test.mjs" },
  { tier: 5, flag: "buffs_hud_stat_labels", file: "tests/buffs_hud_stat_labels.test.cjs" },
  { tier: 5, flag: "examine_text_rows", file: "tests/examine_text_rows.test.mjs" },
  { tier: 5, flag: "examineSpellBook", file: "tests/examine_spell_book.test.mjs" },
  { tier: 5, flag: "appraisal_text", file: "tests/appraisal_text.test.mjs" },
  { tier: 5, flag: "appraisal_special_properties", file: "tests/appraisal_special_properties.test.mjs" },
  { tier: 5, flag: "examineCharacterMisc", file: "tests/examine_character_misc.test.mjs" },
  { tier: 5, flag: "characterInfoReport", file: "tests/character_info_report.test.mjs" },
  { tier: 5, flag: "characterInfoInfoTab", file: "tests/character_info_info_tab.test.mjs" },
  { tier: 5, flag: "house_panel_text", file: "tests/house_panel_text.test.mjs" },
  { tier: 5, flag: "house_panel_dom", file: "tests/house_panel_dom.test.mjs" },
  { tier: 5, flag: "icon_blit_ops", file: "tests/icon_blit_ops.test.mjs" },
  { tier: 5, flag: "commerce_slot_icon", file: "tests/commerce_slot_icon.test.mjs" },
  { tier: 5, flag: "houseQueryAtLogin", file: "tests/house_query_login.test.mjs" },
  { tier: 5, flag: "trade_add_plan", file: "tests/trade_add_plan.test.mjs" },
  { tier: 5, flag: "selectionBracketsDisplayOption", file: "tests/selection_brackets_display_option.test.mjs" },
  { tier: 5, flag: "portal_storm_notices", file: "tests/portal_storm_notices.test.mjs" },
  { tier: 5, flag: "spellbarEndowment", file: "tests/spellbar_endowment.test.mjs" },
  { tier: 5, flag: "spellbarEndowmentStrip", file: "tests/spellbar_endowment_strip.test.mjs" },
  { tier: 5, flag: "hudKeyActivation", file: "tests/hud_key_activation.test.mjs" },
  { tier: 5, flag: "hudFocusHotbar", file: "tests/hud_focus_hotbar.test.mjs" },
  { tier: 5, flag: "spellbarServerSync", file: "tests/spellbar_server_sync.test.mjs" },
  { tier: 5, flag: "retailQuickslotMods", file: "tests/hotbar_ctrl_alias.test.mjs" },
  { tier: 5, flag: "uiLockGlobal", file: "tests/ui_lock_global.test.mjs" },
  { tier: 5, flag: "uiLockOptions", file: "tests/ui_lock_options.test.mjs" },
  { tier: 5, flag: "emote_keys", file: "tests/emote_keys.test.mjs" },
  { tier: 5, flag: "keysPageLiveRows", file: "tests/keys_page_live_rows.test.mjs" },
  { tier: 5, flag: "selectionKeys", file: "tests/selection_keys.test.mjs" },
  { tier: 5, flag: "nativeContextMenu", file: "tests/context_menu_suppress.test.mjs" },
  { tier: 5, flag: "retailWieldLegal", file: "tests/retail_autowield_legal.test.mjs" },
  { tier: 5, flag: "hotbarPerChar", file: "tests/hotbar_per_character.test.mjs" },
  { tier: 5, flag: "place_in_3d_retail", file: "tests/place_in_3d_retail.test.mjs" },
  { tier: 5, flag: "vendorSell3dDrop", file: "tests/vendor_sell_3d_drop.test.mjs" },
  { tier: 5, flag: "hudLogoffButton", file: "tests/status_indicators_logoff.test.mjs" },
  { tier: 5, flag: "accountBoot", file: "tests/account_boot.test.mjs" },
  { tier: 5, flag: "corpseCommand", file: "tests/corpse_command.test.mjs" },
  { tier: 5, flag: "fadeAlphaParity", file: "tests/fade_alpha_state.test.mjs" },
  { tier: 5, flag: "lumCloneAdopt", file: "tests/luminous_night_clone.test.mjs" },
  { tier: 5, flag: "additiveObjFog", file: "tests/additive_obj_fog.test.mjs" },
  { tier: 5, flag: "luminousHook", file: "tests/luminous_hook.test.mjs" },
  { tier: 5, flag: "selectionFlash", file: "tests/selection_lighting.test.mjs" },
  { tier: 5, flag: "envDetailTex", file: "tests/env_detail_patch.test.mjs" },
  { tier: 5, flag: "barber_panel", file: "tests/barber_panel.test.mjs" },
  { tier: 5, flag: "retailCharErrorsWebAC", file: "tests/chargen_errors.test.mjs" },
  { tier: 5, flag: "character_creation_colors", file: "tests/character_creation_colors.test.mjs" },
  { tier: 5, flag: "character_creation_attr_balance", file: "tests/character_creation_attr_balance.test.mjs" },
  { tier: 5, flag: "map_house_marker", file: "tests/map_house_marker.test.mjs" },
  { tier: 5, flag: "inventoryActionFailed(attemptFailedLine)", file: "tests/rejection_feedback_attempt_failed.test.mjs" },
  { tier: 5, flag: "house_slumlord_range", file: "tests/house_slumlord_range.test.mjs" },
  { tier: 5, flag: "camFadeHier", file: "tests/cam_fade_hierarchical.test.mjs" },
  { tier: 5, flag: "retailFov", file: "tests/retail_fov.test.mjs" },
  { tier: 5, flag: "paperdoll_held_flag", file: "tests/paperdoll_held_flag.test.mjs" },
  { tier: 5, flag: "remoteRootScale", file: "tests/remote_root_scale.test.mjs" },
  { tier: 5, flag: "remoteLeash", file: "tests/remote_leash.test.mjs" },
  { tier: 5, flag: "netWorkerDisconnect", file: "tests/net_worker_disconnect_kind.test.mjs" },
  { tier: 5, flag: "linkStatusPacketLoss", file: "tests/link_status_packet_loss.test.mjs" },
  { tier: 4, flag: "defaultScriptAtSpawn", file: "tests/default_script_no_spawn_play.test.mjs" },
  { tier: 5, flag: "defaultScriptPartChild", file: "tests/default_script_part_child.test.mjs" },
  { tier: 5, flag: "particleCellGate", file: "tests/particle_cell_gate.test.mjs" },
  { tier: 5, flag: "particleSlotCarrier", file: "tests/particle_slot_carrier.test.mjs" },
  // 2026-10-20 A14: ?particleUploadRange (default on, =off escape) uploads only [0, n) of the buckets.
  { tier: 5, flag: "particleUploadRange", file: "tests/particle_upload_range.test.mjs" },
  { tier: 5, flag: "particleInitFrameAce", file: "tests/particle_init_frame.test.mjs" },
  { flag: "missileObjSweep", file: "tests/projectile_object_sweep.test.mjs" },
  { tier: 5, flag: "projectileScenerySweep", file: "tests/projectile_scenery_sweep.test.mjs" },
  { tier: 5, flag: "projectileTerrainCrossing", file: "tests/projectile_terrain_crossing.test.mjs" },
  { tier: 5, flag: "missileImpactScript", file: "tests/projectile_collision_script.test.mjs" },
  { tier: 5, flag: "programRetain", file: "tests/program_retention.test.mjs" },
  { tier: 5, flag: "dynLodChainGate", file: "tests/dyn_lod_tick.test.mjs" },
  { tier: 5, flag: "statics_retail_degrade", file: "tests/statics_retail_degrade.test.mjs" },
  { tier: 5, flag: "deg_mul_retail", file: "tests/deg_mul_retail.test.mjs" },
  { tier: 5, flag: "lodCollapseDup", file: "tests/lod_collapse_dup.test.mjs" },
  // 2026-10-16 statics LOD bands keep the Setup's part pose (signs/props stop
  // sinking or sliding at a band switch; billboard bands pivot on the part).
  { tier: 5, flag: "degradePose", file: "tests/statics_degrade_pose.test.mjs" },
  // 2026-10-17 cpuframe: one billboard walk per frame, skipped while nothing moved.
  { tier: 5, flag: "billboardTickGate", file: "tests/statics_billboard_gate.test.mjs" },
  { tier: 5, flag: "staticsCullGate", file: "tests/statics_cull_gate.test.mjs" },
  // 2026-10-16 every portal gets the purple portal's set piece; the portal
  // "pop" root causes: static part anchors + the true cull sphere, lights in
  // the object frame, a re-sent portal create applied in place.
  { tier: 5, flag: "portalSetPiece", file: "tests/portal_set_piece.test.mjs" },
  { tier: 5, flag: "staticPartAnchor+rp6TrueSphere", file: "tests/portal_particle_anchor.test.mjs" },
  { tier: 5, flag: "lightObjectFrame", file: "tests/light_object_frame.test.mjs" },
  { tier: 5, flag: "portalRecreateInPlace", file: "tests/portal_recreate_in_place.test.mjs" },
  { tier: 5, flag: "lodPartSwapOrder", file: "tests/lod_part_swap_order.test.mjs" },
  { tier: 5, flag: "rynthVtFormatsMetLf", file: "tests/rynth_vt_formats_met_lf.test.mjs" },
  { tier: 5, flag: "rynthVtFormatsComma", file: "tests/rynth_vt_formats_comma.test.mjs" },
  { tier: 5, flag: "rynthVtFormatsAfXf", file: "tests/rynth_vt_formats_af_xf.test.mjs" },
  { tier: 5, flag: "rynthVtFormatsUsd", file: "tests/rynth_vt_formats_usd.test.mjs" },
  { tier: 5, flag: "rynthVtPresetLabel", file: "tests/rynth_vt_preset_label.test.mjs" },
  { tier: 5, flag: "rynthBuffTierLock", file: "tests/rynth_buff_tier_lock.test.mjs" },
  { tier: 5, flag: "rynthLootCorpseDenial", file: "tests/rynth_loot_corpse_denial.test.mjs" },
  { tier: 5, flag: "rynthVitalsProgress", file: "tests/rynth_vitals_progress.test.mjs" },
  { tier: 5, flag: "rynthSkillCap", file: "tests/rynth_skill_cap.test.mjs" },
  { tier: 5, flag: "rynthPortalHazards", file: "tests/rynth_portal_hazards.test.mjs" },
  { tier: 5, flag: "rynthSelclockDetail", file: "tests/rynth_selclock_detail.test.mjs" },
  { tier: 5, flag: "stormScan", file: "tests/daygroup_weather_scan.test.mjs" },
  { tier: 5, flag: "environOverride", file: "tests/environ_override.test.mjs" },
  { tier: 5, flag: "radialFog", file: "tests/radial_fog.test.mjs" },
  { tier: 5, flag: "lightTickReset", file: "tests/retail_light_tick.test.mjs" },
  { tier: 5, flag: "skyObjectFree", file: "tests/sky_object_free.test.mjs" },
  { tier: 5, flag: "aceObjMaint", file: "tests/ace_obj_maint.test.mjs" },
  { tier: 5, flag: "shardBudgetSoftCap", file: "tests/shard_budget_soft_cap.test.mjs" },
  { tier: 5, flag: "provenAbsentExempt", file: "tests/proven_absent_miss.test.mjs" },
  { tier: 5, flag: "service_worker_cas_verify", file: "tests/service_worker_cas_verify.test.mjs" },
  { tier: 5, flag: "shardFetchWorker_reload", file: "tests/shard_fetch_worker_reload.test.mjs" },
  { tier: 5, flag: "gateBrowserSmokes", file: "harness/test_gate_browser_smokes.mjs" },
  { tier: 5, flag: "heavy_lock", file: "harness/test_heavy_lock.mjs" },
  { tier: 5, flag: "wireIntegrity", file: "tests/diag_wire_integrity.test.mjs" },
  { tier: 5, flag: "linkProbeLedger", file: "tests/link_probe_ledger.test.mjs" },
  { tier: 5, flag: "lintEventConsumers", file: "tests/lint_event_consumers.test.mjs" },
  { tier: 5, flag: "harness_suite_hygiene", file: "harness/test_suite_hygiene.mjs" },
  { tier: 5, flag: "harness_perf_ratchet", file: "harness/test_perf_ratchet.mjs" },
  { tier: 5, flag: "sceneryBakeFlag", file: "tests/scenery_bake_flag.test.mjs" },
  // 2026-10-17 Linvak Tukal fps: frozen static script anchors + the static emitter radius.
  { tier: 5, flag: "staticAnchorRadius", file: "tests/static_anchor_radius.test.mjs" },
  { tier: 5, flag: "combatModePendingProxy", file: "tests/combat_mode_pending_proxy.test.mjs" },
  { tier: 5, flag: "rynthVtSkillCapWiring", file: "tests/rynth_vt_skill_cap_wiring.test.mjs" },
  // 2026-10-19 buff scroll ladder: canonical families (a dev character never gets Zongo's Fist) + the VT list migration.
  { tier: 5, flag: "rynthBuffCanonical", file: "tests/rynth_buff_canonical.test.mjs" },
  { tier: 5, flag: "rynthVtBuffSpecMigration", file: "tests/rynth_vt_buff_spec_migration.test.mjs" },
  // 2026-10-19 the VTank route drawn in the world (scene3d/route_overlay.js; Route tab › Show path).
  { tier: 5, flag: "rynthRouteOverlay", file: "tests/route_overlay.test.mjs" },
  // 2026-10-19 the former "Not on web" VTank options made live (panel homes; behaviour suites below as they land).
  { tier: 5, flag: "rynthVtPanelLiveOptions", file: "tests/rynth_vt_panel_live_options.test.mjs" },
  { tier: 5, flag: "rynthVtSupportHelpers", file: "tests/rynth_vt_support_helpers.test.mjs" },
  { tier: 5, flag: "rynthVtSupportAmmo", file: "tests/rynth_vt_support_ammo.test.mjs" },
  { tier: 5, flag: "rynthLootVtOptions", file: "tests/rynth_loot_vt_options.test.mjs" },
  { tier: 5, flag: "rynthVtSupportLoot", file: "tests/rynth_vt_support_loot.test.mjs" },
  { tier: 5, flag: "rynthBuffWornArmor", file: "tests/rynth_buff_worn_armor.test.mjs" },
  { tier: 5, flag: "rynthBuffBatchComplete", file: "tests/rynth_buff_batch_complete.test.mjs" },
  { tier: 5, flag: "rynthFrameCap", file: "tests/frame_cap.test.mjs" },
  { tier: 5, flag: "rynthPassabilityOverlay", file: "tests/passability_overlay.test.mjs" },
  { tier: 5, flag: "rynthVtDisplay", file: "tests/rynth_vt_display.test.mjs" },
  { tier: 5, flag: "rynthStartOnLogin", file: "tests/rynth_start_on_login.test.mjs" },
  { tier: 5, flag: "rynthIndoorDoorways", file: "tests/rynth_indoor_doorways.test.mjs" },  // Film mode (2026-10-13, ?filmMode=on, DEFAULT OFF): scene3d/film/** + tools/film/** suites (SPEC scene3d/film/SPEC.md).
  { tier: 5, flag: "filmMode(audio_lyrics)", file: "tests/film_audio_lyrics.test.mjs" },
  { tier: 5, flag: "filmMode(audio_structure)", file: "tests/film_audio_structure.test.mjs" },
  { tier: 5, flag: "filmMode(audio_tempo)", file: "tests/film_audio_tempo.test.mjs" },
  { tier: 5, flag: "filmMode(cli)", file: "tests/film_cli.test.mjs" },
  { tier: 5, flag: "filmMode(cli_session)", file: "tests/film_cli_session.test.mjs" },
  { tier: 5, flag: "filmMode(core_math)", file: "tests/film_core_math.test.mjs" },
  { tier: 5, flag: "filmMode(flight_model)", file: "tests/film_flight_model.test.mjs" },
  { tier: 5, flag: "filmMode(framing)", file: "tests/film_framing.test.mjs" },
  { tier: 5, flag: "filmMode(fx_clock)", file: "tests/film_fx_clock.test.mjs" },
  { tier: 5, flag: "filmMode(fpv_tricks)", file: "tests/film_fpv_tricks.test.mjs" },
  { tier: 5, flag: "filmMode(gimbal)", file: "tests/film_gimbal.test.mjs" },
  { tier: 5, flag: "filmMode(hooks)", file: "tests/film_hooks.test.mjs" },
  { tier: 5, flag: "filmMode(install_claude)", file: "tests/film_install_claude.test.mjs" },
  { tier: 5, flag: "filmMode(jev_broker)", file: "tests/film_jev_broker.test.mjs" },
  { tier: 5, flag: "filmMode(jev_client)", file: "tests/film_jev_client.test.mjs" },
  { tier: 5, flag: "filmMode(jev_pass_plan)", file: "tests/film_jev_pass_plan.test.mjs" },
  { tier: 5, flag: "filmMode(pilot_loop)", file: "tests/film_pilot_loop.test.mjs" },
  { tier: 5, flag: "filmMode(pilot_policy)", file: "tests/film_pilot_policy.test.mjs" },
  { tier: 5, flag: "filmMode(pilot_words)", file: "tests/film_pilot_words.test.mjs" },
  { tier: 5, flag: "filmMode(plan_compile)", file: "tests/film_plan_compile.test.mjs" },
  { tier: 5, flag: "filmMode(plan_schema)", file: "tests/film_plan_schema.test.mjs" },
  { tier: 5, flag: "filmMode(registry)", file: "tests/film_registry.test.mjs" },
  { tier: 5, flag: "filmMode(scene_dungeon)", file: "tests/film_scene_dungeon.test.mjs" },
  { tier: 5, flag: "filmMode(scene_los)", file: "tests/film_scene_los.test.mjs" },
  { tier: 5, flag: "filmMode(scene_solver)", file: "tests/film_scene_solver.test.mjs" },
  { tier: 5, flag: "filmMode(shots_classic)", file: "tests/film_shots_classic.test.mjs" },
  { tier: 5, flag: "filmMode(shots_drone)", file: "tests/film_shots_drone.test.mjs" },
  { tier: 5, flag: "filmMode(shots_fpv_run)", file: "tests/film_shots_fpv_run.test.mjs" },
  { tier: 5, flag: "filmMode(sites)", file: "tests/film_sites.test.mjs" },
  { tier: 5, flag: "filmMode(spline)", file: "tests/film_spline.test.mjs" },
  { tier: 5, flag: "filmMode(trajectory)", file: "tests/film_trajectory.test.mjs" },
  { tier: 5, flag: "filmMode(api)", file: "tests/film_api.test.mjs" },
  { tier: 5, flag: "filmMode(perception)", file: "tests/film_perception.test.mjs" },
  { tier: 5, flag: "filmMode(runtime_camera)", file: "tests/film_runtime_camera.test.mjs" },
  { tier: 5, flag: "filmMode(runtime_capture)", file: "tests/film_runtime_capture.test.mjs" },
  { tier: 5, flag: "filmMode(runtime_overlay)", file: "tests/film_runtime_overlay.test.mjs" },
  { tier: 5, flag: "filmMode(runtime_world)", file: "tests/film_runtime_world.test.mjs" },
  { tier: 5, flag: "filmMode(terrain_corridor)", file: "tests/film_terrain_corridor.test.mjs" },
  // 2026-10-17 fps wave 2 (card "binds"): texture-unit pins + light upload memo,
  // proven exact on three r184's real renderer over tests/helpers/fake_webgl2.mjs.
  { tier: 5, flag: "texUnitPin+lightUploadOnce", file: "tests/uniform_bind_patch.test.mjs" },
  // 2026-10-17 fps wave 3 (card "atlas"): building surfaces batched per (landblock,
  // material) through their own material — routing, geometry/transform identity and
  // GL-level shader/uniform/state identity in both depth modes, LRU lifecycle.
  { tier: 5, flag: "buildingMatBatch", file: "tests/building_mat_batch.test.mjs" },
  // 2026-10-18 owner-bug lanes. usetarget: target-mode clicks in the inventory views
  // (?useTargetGrid), the main pack as a shortcut to yourself (?selfShortcut), shortcut
  // presses in target mode (?shortcutTargetMode), the 3D self pick for a self-usable item
  // (?useTargetSelfPick).
  { tier: 5, flag: "useTargetGrid", file: "tests/use_target_inventory.test.mjs" },
  { tier: 5, flag: "selfShortcut", file: "tests/hotbar_self_shortcut.test.mjs" },
  { tier: 5, flag: "useTargetSelfPick", file: "tests/use_target_self_pick.test.mjs" },
  // melee: the swing sticky lives as long as retail's (?retailUnstick).
  { tier: 5, flag: "retailUnstick", file: "tests/retail_unstick.test.mjs" },
  // sneak: the Sneak Attack cue inside the combat HUD / spell strip (no flag; HUD).
  { tier: 5, flag: "sneakAttackCue", file: "tests/sneak_attack_cue.test.mjs" },
  // spawnz: a creature the server left floating falls onto the floor (?remoteSettle).
  { tier: 5, flag: "remoteSettle", file: "tests/remote_settle.test.mjs" },
  // hop: the always-on hop detector (`__diag.hop`): a grounded local slice that left the
  // ground or rose against the drawn terrain, with a cause (?clampReplant / ?waterQuadrantRetail
  // are wasm-side and covered by the holtburger-core terrain_hop_real_* suites).
  { tier: 5, flag: "hopDiag", file: "tests/hop_diag.test.mjs" },
  // 2026-10-18 systematic-review fix pass (docs/2026-10-18-systematic-code-review.md).
  // RUSTNET-1: a superseded ?netWorker connect gives up instead of logging in directly.
  { tier: 5, flag: "netWorker", file: "tests/net_worker_superseded.test.mjs" },
  // STREAM-TERRAIN-2: a failed HD record fetch is retried, only proven absence latches.
  { tier: 5, flag: "texBc7", file: "tests/bc7_fetch_failure_retry.test.mjs" },
  // PLUGINS-A-1/2, PLUGINSB-1/3/4: plugins mounted before login (bar client null) bind
  // their bus listeners once the client is ready, exactly once.
  { tier: 5, flag: "plugins_late_client_bind", file: "tests/plugins_late_client_bind.test.mjs" },
  // PLUGINSB-2: vendor-ui reads the live SessionHandle after a reconnect.
  { tier: 5, flag: "vendor_ui_handle_reconnect", file: "tests/vendor_ui_handle_reconnect.test.mjs" },
  // PLUGINSB-5: a failed WorldObjectManager.load() stops queueing spawns.
  { tier: 5, flag: "world_object_manager_load_fail", file: "tests/world_object_manager_load_fail.test.mjs" },
  // PLUGINS-A-4 class: the item icon lookup frees its playerInventory() boxes.
  { tier: 5, flag: "entityIconInventoryFree", file: "tests/entity_icon_inventory_free.test.mjs" },
  // Same class: a toolbar disposed before login never binds its bus listeners.
  { tier: 5, flag: "targetBarLateBind", file: "tests/target_bar_late_bind.test.mjs" },
  // ENTITIES-1..4: a same-guid respawn is no deselect, keeps prevSelectedID, and stale
  // bakes / hooks skip the old rig.
  { tier: 5, flag: "sameGuidRespawn", file: "tests/same_guid_respawn.test.mjs" },
  // ENTITIES-5: AnimationCache frees the EntityAnimationData box after copying it.
  { tier: 5, flag: "animCacheBoxFree", file: "tests/anim_cache_box_free.test.mjs" },
  // RENDER-1/2 + draw-sort: the render patches survive a WebGL context restore.
  { tier: 5, flag: "asyncLink+texUnitPin+unitLimit+drawSortProgram", file: "tests/webgl_restore_render_patches.test.mjs" },
  // RENDER-3: occlusion proxies reset on a context restore.
  { tier: 5, flag: "occlusionCull", file: "tests/occlusion_cull_restore.test.mjs" },
  // RENDER-4: ?farFogFence re-arms after a restore; a dead probe falls back to the authored hex.
  { tier: 5, flag: "farFogFence", file: "tests/far_fog_fence_restore.test.mjs" },
  // RENDER-5: requestShadowRaster re-rasters the managed lights under the mover-scope gate.
  { tier: 5, flag: "interiorShadowCull", file: "tests/interior_shadow_raster_scope.test.mjs" },
  // RENDER-6: the adaptive-res boot grace ends without a 'ready'.
  { tier: 5, flag: "adaptiveResBootGrace", file: "tests/adaptive_res_boot_grace_cap.test.mjs" },
  // SKY-1/3/5: the late haze runs before the late particles, on every camera.
  { tier: 5, flag: "layerHaze", file: "tests/sky_late_haze_camera.test.mjs" },
  // 2026-10-20 A7: ?postFuse (default on, =off escape) folds the first scrub and the haze
  // into the split chain's atmosphere pass — two full-screen passes fewer.
  { tier: 5, flag: "postFuse", file: "tests/post_fuse.test.mjs" },
  // 2026-10-20 improvement hunt wave 1 (docs/2026-10-20-improvement-hunt.md §3).
  { tier: 5, flag: "bakedDirectOut", file: "tests/baked_direct_out.test.mjs" },
  { tier: 5, flag: "hdSwapBump", file: "tests/hd_swap_no_bump.test.mjs" },
  { tier: 5, flag: "csm(receiverWorldPos+textureLod)", file: "tests/csm_receiver_worldpos.test.mjs" },
  { tier: 5, flag: "csm(clone receivers)", file: "tests/clone_csm_receiver.test.mjs" },
  { tier: 5, flag: "swayShadow(depth variants)", file: "tests/sway_shadow_depth_variants.test.mjs" },
  { tier: 5, flag: "csmStable", file: "tests/csm_stable.test.mjs" },
  { tier: 5, flag: "csmSunFade+csmDirectOnly", file: "tests/csm_sun_fade.test.mjs" },
  { tier: 5, flag: "lightRangeSkip", file: "tests/light_range_skip.test.mjs" },
  { tier: 5, flag: "csmDeadLights", file: "tests/csm_dead_lights.test.mjs" },
  { tier: 5, flag: "frozenPartFast+rp6Stagger", file: "tests/frozen_part_fast.test.mjs" },
  { tier: 5, flag: "lateFxWarm", file: "tests/late_fx_warm.test.mjs" },
  { tier: 5, flag: "cloudShadowEvery", file: "tests/cloud_shadow_cadence.test.mjs" },
  { tier: 5, flag: "bulkChildRemove", file: "tests/bulk_child_remove.test.mjs" },
  { tier: 5, flag: "iblStableEnv", file: "tests/ibl_stable_env.test.mjs" },
  { tier: 5, flag: "paperdollPersist", file: "tests/paperdoll_persist_viewport.test.mjs" },
  { tier: 5, flag: "nraSourceRes", file: "tests/nra_source_res.test.mjs" },
  // SKY-2: the SAO sky sentinel fits a half-float target.
  { tier: 5, flag: "ssao", file: "tests/sky2_ssao_sky_sentinel.test.mjs" },
  // SKY-4: the cloud look stops overwriting a knob-set coverage.
  { tier: 5, flag: "cloudCoverage", file: "tests/sky4_cloud_coverage_knob.test.mjs" },
  // SKY-6: the color-grade blend allocates nothing per frame.
  { tier: 5, flag: "grade", file: "tests/sky6_color_grade_alloc.test.mjs" },
  // SKY-7: the dirt footfall rate-limit map is swept.
  { tier: 5, flag: "terrainDirt", file: "tests/sky7_dirt_footfall_sweep.test.mjs" },
  // SHELL-1/2/7: escaped char-select names, CharacterError releases the spawn latch.
  { tier: 5, flag: "charSelectSpawn", file: "tests/shell_charselect_spawn.test.mjs" },
  // SHELL-3: /logout keeps the bridge + server endpoint.
  { tier: 5, flag: "logoutEndpoint", file: "tests/shell_logout_endpoint.test.mjs" },
  // SHELL-4/5: the remote-sync and motion diag guid maps are LRU-capped.
  { tier: 5, flag: "diagGuidCaps", file: "tests/shell_diag_guid_caps.test.mjs" },
  // FILM-1..5: dungeon cell carry, sub-10fps stepping, encoder close, look restore, nameplate mask.
  { tier: 5, flag: "filmMode(review_film1_5)", file: "tests/film_review_film1_5.test.mjs" },
  // VFXAUDIO-1/2/3: evicted flashes leave activeLights, far lights skip the dedupe scan, interior scope.
  { tier: 5, flag: "fxLights", file: "tests/fx_lights_vfxaudio.test.mjs" },
  // VFXAUDIO-5: fx_distort reads the film clock.
  { tier: 5, flag: "fxDistort(fx_clock)", file: "tests/fx_distort_film_clock.test.mjs" },
  // VFXAUDIO-4: portal anchors are swept on registration.
  { tier: 5, flag: "portalSetPiece", file: "tests/portal_registry_sweep.test.mjs" },
  // RYNTH-1..4: meta disable releases keys, truncated .nav / .met rows rejected, jump abort.
  { tier: 5, flag: "rynthMetaDisable", file: "tests/rynth_meta_disable_release.test.mjs" },
  { tier: 5, flag: "rynthNavTruncated", file: "tests/rynth_nav_truncated.test.mjs" },
  { tier: 5, flag: "rynthMetRowBound", file: "tests/rynth_met_row_bound.test.mjs" },
  { tier: 5, flag: "rynthJumpAbort", file: "tests/rynth_jump_abort.test.mjs" },
  // RYNTH-4 leftover: a /rs jump stops when its slot leaves or ActiveNav is disposed.
  { tier: 5, flag: "rynthRsJumpCancel", file: "tests/rynth_rs_jump_cancel.test.mjs" },
  // STREAM-STATICS-1/2: a radius crossing mid-attach neither doubles nor leaks chains.
  { tier: 5, flag: "staticScriptRadius(race)", file: "tests/static_script_radius_race.test.mjs" },
  // STREAM-STATICS-4: the whole cell subtree is matrix-frozen.
  { tier: 5, flag: "freezeStaticMatrix", file: "tests/cell_freeze_subtree.test.mjs" },
  // STREAM-STATICS-3: statics.js / buildings.js evaluate once.
  { tier: 5, flag: "staticsSingleInstance", file: "tests/statics_single_instance.test.mjs" },
  // STREAM-TERRAIN-1: the LOD rebake drain skips evicted / parked landblocks.
  { tier: 5, flag: "lodRebake", file: "tests/terrain_lod_rebake.test.mjs" },
  // STREAM-TERRAIN-3: an eviction mid-build does not mark the landblock populated.
  { tier: 5, flag: "interiorBuildShare", file: "tests/cell_containers_evict.test.mjs" },
  // STREAM-TERRAIN-4: the tex-upgrade protocol probe falls back to the navigation entry.
  { tier: 5, flag: "texUpgradeQueue", file: "tests/tex_upgrade_queue_proto.test.mjs" },
  // 2026-10-18 follow-up pass (the review doc's §10.5 "Still open" and §7 items).
  // SHELL-3 residual: autoSpawn=select is a person's page unless the /logout came from an
  // agent-mode page (the return keeps that page's layout).
  { tier: 5, flag: "agentModeSelect", file: "tests/shell_agent_mode_select.test.mjs" },
  // index.html retries a failed WorldObjectManager.load (2 s / 5 s / 15 s).
  { tier: 5, flag: "womLoadRetry", file: "tests/shell_wom_load_retry.test.mjs" },
  // Render restore gap: ?shadowCasterList / ?shadowStaticCache re-wrap the shadow map a
  // context restore builds.
  { tier: 5, flag: "shadowCasterList+shadowStaticCache(restore)", file: "tests/shadow_caster_list_restore.test.mjs" },
  // §7 stream-terrain: the ?farDiag radius policy holds after a walk or a teleport; the far
  // ring forgets the landblocks of retired patches.
  { tier: 5, flag: "farDiag", file: "tests/far_radius_policy.test.mjs" },
  // §7 stream-statics: a superseded envcell build leaves the LB's pooled cells to the newer one.
  { tier: 5, flag: "drawPools(cancelGen)", file: "tests/envcell_pool_cancel_gen.test.mjs" },
  // 2026-10-22 handoff F1: opaque pools drawn as batchedRuns runs, content-keyed pool geometry,
  // and the HEAD pool fixes (node bounds, one feed list per tile, band swaps under the early-out).
  { tier: 5, flag: "drawPools(poolRuns)", file: "tests/pool_runs.test.mjs" },
  // SKY-1 remainder: ?particlesOverHaze (default on, =off escape) draws the unsplit chain's
  // particles after the layered haze, exactly once, at no new target.
  { tier: 5, flag: "particlesOverHaze", file: "tests/sky1_particles_over_haze.test.mjs" },
  // FILM-5 remainder: nameplates made or re-stamped during a clean take stay hidden.
  { tier: 5, flag: "film5Remainder", file: "tests/film5_nameplate_take.test.mjs" },
  // Rynth: a non-numeric waypoint position is refused, never a waypoint at 0N 0E.
  { tier: 5, flag: "rynthRoutePointNaN", file: "tests/rynth_route_point_nan.test.mjs" },
  // ?eagerDungeons: every static ParticleManager ticks once per frame; overlapping first
  // attaches share one manager.
  { tier: 5, flag: "staticParticleManagers", file: "tests/static_particle_managers_tick.test.mjs" },
  // The building / static / scenery collider populate stops for an evicted landblock (JS),
  // and the eviction drops what it already staged (wasm, source pins).
  { tier: 5, flag: "colliderPopulateEvict", file: "tests/collider_populate_evict.test.mjs" },
  // §7 plugins-b: rejection tracking re-wraps the SessionHandle a reconnect builds.
  { tier: 5, flag: "rejectionFeedbackReconnect", file: "tests/rejection_feedback_reconnect.test.mjs" },
  // §7 entities: remove() drops the motions stashed for a spawn that never committed.
  { tier: 5, flag: "spawnMotionStash", file: "tests/spawn_motion_stash_remove.test.mjs" },
];

// Registered but KNOWN-FAILING because the APP is wrong (a real bug, named
// with file:line). Not run by default (they would fail), but printed every run
// and executable with `--run-quarantined` (XFAIL/XPASS, never affects the exit
// code) so a fix is noticed the moment it lands. A STALE test does not belong
// here — fix the test. Cleared of the "unclassified — see task #156" backlog
// on 2026-10-05; every entry must name the bug.
const QUARANTINE = [];

// Not JS-headless suites: Node wrappers that shell out to `cargo run/test`
// (holtburger-dat examples / holtburger-core movement tests) against the real
// DATs in ~/ac_base_dats. They need the Rust toolchain + a BUILD + licensed
// data, none of which a pure-Node CI leg has (and builds are out of scope for
// this runner). Listed so they are visible and not "unregistered"; their
// status was NOT verified on 2026-10-05 (running them would build). Home:
// harness/cargo-tests.mjs (the Rust leg).
const NEEDS_TOOLCHAIN = [
  { file: "test_ac_cast_over_locomotion.mjs", why: "cargo run -p holtburger-dat --example cast_over_locomotion + ~/ac_base_dats" },
  { file: "test_ac_jump_clip_plays.mjs", why: "cargo run -p holtburger-dat --example jump_clip_data_check + ~/ac_base_dats" },
  { file: "test_ac_locomotion_dispatch.mjs", why: "cargo test -p holtburger-core --lib movement::" },
  { file: "test_ac_locomotion_per_stance.mjs", why: "cargo run -p holtburger-dat --example player_mt_stance_coverage + ~/ac_base_dats" },
  { file: "test_ac_motion_inventory.mjs", why: "cargo run -p holtburger-dat --example wave_8_motion_inventory + ~/ac_base_dats" },
];
const QUARANTINED = new Set([...QUARANTINE, ...NEEDS_TOOLCHAIN].map((q) => q.file));

// Not JS-headless suites either (test-tooling-1, 2026-10-13): GPU/shader
// smokes that serve the app on a loopback port and drive ONE headless
// Chromium tab (playwright-core + /usr/bin/chromium, SwiftShader WebGL2). A
// shader or GL regression in these paths is caught by nothing else, but a
// browser is out of scope here (and in CI's js job). Each is a HEAVY job under
// ~/CLAUDE.md: orchestrator only, `capped-build node <file>`, one at a time.
// Listed so the COVERAGE GUARD sees them — a new `test_*.cjs` smoke at the app
// root, or a new harness/glsl_smoke/*_smoke.mjs, that is not listed here is
// UNREGISTERED. Deliberately NOT in QUARANTINE: `--run-quarantined` must never
// launch a browser.
const BROWSER_WHY = "headless Chromium (SwiftShader); capped-build, one tab";
const NEEDS_BROWSER = [
  { file: "test_far_bake_shared_textures_gpu.cjs", why: `far-bake shared textures — ${BROWSER_WHY}` },
  { file: "test_fx_decal_gpu.cjs", why: `fxDecals / fxDecalSmooth — ${BROWSER_WHY}` },
  { file: "test_lifestone_fx_gpu.cjs", why: `lifestoneFx — ${BROWSER_WHY}` },
  { file: "test_moon_fx_gpu.cjs", why: `moonFx — ${BROWSER_WHY}` },
  { file: "test_particle_fx_gpu.cjs", why: `particleFx — ${BROWSER_WHY}` },
  { file: "test_particle_fx_tier1_gpu.cjs", why: `particle FX tier 1 — ${BROWSER_WHY}` },
  { file: "test_particle_fx_tier2_gpu.cjs", why: `particle FX tier 2 — ${BROWSER_WHY}` },
  { file: "test_weapon_fx_gpu.cjs", why: `weapon FX — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/light_loops_smoke.mjs", why: `lightLoops — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/batched_runs_smoke.mjs", why: `batchedRuns — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/atlas_geom_dedup_smoke.mjs", why: `atlasGeomDedup — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/batched_runs_sorted_smoke.mjs", why: `batchedRunsSorted / batchedRunsStable — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/pool_runs_smoke.mjs", why: `poolRuns — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/static_early_out_smoke.mjs", why: `staticEarlyOut / B9a building runs — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/vertex_pull_smoke.mjs", why: `vertexPullSpike (handoff P4, harness only) — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/terrain_no_drawid_smoke.mjs", why: `terrainNoDrawId — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/fps_arms_smoke.mjs", why: `canvasDepth / depthBandSort / freezeWorldRoots — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/reversed_z_smoke.mjs", why: `reversedZ — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/water_flow_smoke.mjs", why: `waterFlow / waterBank — ${BROWSER_WHY}` },
  { file: "harness/glsl_smoke/grass_gpu_smoke.mjs", why: `terrainGrassGpu (GPU readback vs CPU grass; writes grass_gpu_smoke.stamp.json on PASS) — ${BROWSER_WHY}` },
];
const BROWSER_ONLY = new Set(NEEDS_BROWSER.map((q) => q.file));

// COVERAGE GUARD — every `test_*.mjs` in the tree must be in a tier or in
// QUARANTINE (or listed in NEEDS_TOOLCHAIN / NEEDS_BROWSER). Unlisted files are
// reported so the registration list can never silently rot again.
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
    // 2026-10-05: harness/ carries 26 `test_*.mjs` suites of its own; only one
    // was registered and the guard never looked, so 25 ran nowhere.
    { dir: "harness", match: (n) => n.startsWith("test_") && n.endsWith(".mjs") },
    { dir: "tests", match: (n) => /\.(test\.)?(mjs|cjs)$/.test(n) && (n.startsWith("test_") || n.includes(".test.")) },
    // 2026-10-13 (test-tooling-1): the browser smokes — root `test_*.cjs` and
    // harness/glsl_smoke/ — were outside every pattern, so 9 shader smokes ran
    // nowhere and nothing said so. They belong in NEEDS_BROWSER, never a tier.
    { dir: "", match: (n) => n.startsWith("test_") && n.endsWith(".cjs") },
    { dir: "harness/glsl_smoke", match: (n) => n.endsWith("_smoke.mjs") },
  ];
  for (const { dir, match } of SCAN) {
    let names = [];
    try { names = readdirSync(path.join(APP_ROOT, dir)); } catch (_) { continue; }
    for (const n of names) {
      if (!match(n)) continue;
      const rel = dir ? `${dir}/${n}` : n;
      if (!seen.has(rel) && !QUARANTINED.has(rel) && !BROWSER_ONLY.has(rel)) out.push(rel);
    }
  }
  return out.sort();
}

const PLAN = [...TIER1, ...TIER4, ...TIER5];

// Listed suites this runner never executes, and why (printed every full run
// and by --coverage).
function printNotRunHere() {
  for (const q of NEEDS_TOOLCHAIN) {
    console.log(`  NEEDS-TOOLCHAIN (not run here): ${q.file} — ${q.why}`);
  }
  for (const q of NEEDS_BROWSER) {
    console.log(`  NEEDS-BROWSER (not run here): ${q.file} — ${q.why}`);
  }
}

function printUnregistered(unregistered) {
  for (const f of unregistered) {
    console.log(`  UNREGISTERED: ${f} — in no tier and not quarantined; nothing runs it`);
  }
}

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
    runQuarantined: false,
    strictFixtures: false,
    coverage: false,
    help: false,
  };
  for (const a of argv) {
    if (a === "--quiet") opts.quiet = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--coverage") opts.coverage = true;
    else if (a === "--strict-missing") opts.strictMissing = true;
    else if (a === "--allow-skips") opts.allowSkips = true;
    else if (a === "--bail") opts.bail = true;
    else if (a === "--run-quarantined") opts.runQuarantined = true;
    else if (a === "--strict-fixtures") opts.strictFixtures = true;
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
  NOFIXTURE: "NO-FIXTURE",
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
  // 2026-10-05: a suite that needs a LOCAL data fixture (an external mount)
  // is not run where the fixture is absent (a CI box) — reported as its own
  // NO-FIXTURE row, never as a PASS. `--strict-fixtures` makes it a failure.
  const need = typeof entry.requires === "function" ? entry.requires() : entry.requires;
  if (need && !existsSync(path.resolve(APP_ROOT, need))) {
    return { ...entry, status: STATUS.NOFIXTURE, code: null, detail: `fixture absent: ${need}`, output: "" };
  }
  const run = spawnSync(process.execPath, [...CHILD_HEAP_ARGS, entry.file], {
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
        "[--quiet] [--list] [--coverage] [--strict-missing] [--timeout=MS] [--bail]"
    );
    process.exit(0);
  }

  // --coverage: the COVERAGE GUARD alone. A readdir of the tree — runs no
  // suite, takes no heavy lock — so it is safe beside anything. Exits 1 iff
  // a suite is UNREGISTERED, as a full run would; ignores --only / --tier.
  if (opts.coverage) {
    console.log(`[run-js-headless] --coverage: ${PLAN.length} registered, ` +
      `${QUARANTINE.length} quarantined, ${NEEDS_TOOLCHAIN.length} needs-toolchain, ` +
      `${NEEDS_BROWSER.length} needs-browser`);
    for (const q of QUARANTINE) console.log(`  QUARANTINED: ${q.file} — ${q.why}`);
    printNotRunHere();
    const unregistered = unregisteredSuites();
    printUnregistered(unregistered);
    console.log(`[run-js-headless] --coverage: ${unregistered.length} unregistered`);
    process.exit(unregistered.length > 0 ? 1 : 0);
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

  // One heavy job per machine (~/CLAUDE.md, 2026-10-05). Released on exit; a
  // run killed by a signal leaves a dead-pid lock the next run reclaims.
  try {
    const lock = acquireHeavyLockSync({ label: `run-js-headless ${process.argv.slice(2).join(" ")}`.trim() });
    console.log(`  heavy-lock: ${lock.bypassed ? `bypassed (${lock.bypassed})` : lock.dir}` +
      `  child heap: ${CHILD_HEAP_ARGS.join(" ") || "uncapped (HB_TEST_HEAP_MB=0)"}`);
  } catch (e) {
    if (!String(e && e.code).startsWith("HB_HEAVY_LOCK")) throw e;
    console.error(`\n${e.message}`);
    process.exit(2);
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
      (res.status === STATUS.MISSING && opts.strictMissing) ||
      (res.status === STATUS.NOFIXTURE && opts.strictFixtures);
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
  const noFixture = results.filter((r) => r.status === STATUS.NOFIXTURE);

  console.log("\n" + "=".repeat(76));
  console.log(
    `[run-js-headless] ${passed.length} passed, ${failed.length} failed, ` +
      `${skipped.length} skipped, ${missing.length} missing, ${noFixture.length} no-fixture, ` +
      `${QUARANTINE.length} quarantined  (of ${results.length} run` +
      (plan.length !== results.length ? `; ${plan.length - results.length} skipped by --bail` : "") +
      ")"
  );
  for (const r of failed) {
    console.log(`  FAIL    : ${r.file}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  for (const r of missing) {
    console.log(`  MISSING : ${r.file}${opts.strictMissing ? " (STRICT → FAIL)" : ""}`);
  }
  for (const r of noFixture) {
    console.log(`  NO-FIXTURE: ${r.file} — ${r.detail}${opts.strictFixtures ? " (STRICT → FAIL)" : " (not run; not a pass)"}`);
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
    let tag = "";
    if (opts.runQuarantined) {
      // XFAIL = still failing as recorded; XPASS = the bug looks fixed →
      // move the file back into a tier. Never affects the exit code.
      const r = runOne({ ...q, flag: "quarantined", tier: 0 }, opts);
      tag = r.status === STATUS.PASS ? " [XPASS — un-quarantine it]" : ` [XFAIL ${r.detail || r.status}]`;
    }
    console.log(`  QUARANTINED: ${q.file}${tag} — ${q.why}`);
  }
  printNotRunHere();

  // Coverage guard. A suite in neither a tier nor QUARANTINE is invisible —
  // the failure mode that left 169 of 212 suites unrun until 2026-08-03.
  // Only meaningful on a full run; a filtered plan says nothing about coverage.
  const unregistered = (opts.only || opts.tier !== "all") ? [] : unregisteredSuites();
  printUnregistered(unregistered);

  const missingCountsAsFail = opts.strictMissing ? missing.length : 0;
  const skipCountsAsFail = opts.allowSkips ? 0 : skipped.length;
  const fixtureCountsAsFail = opts.strictFixtures ? noFixture.length : 0;
  const exitNonZero =
    failed.length > 0 || missingCountsAsFail > 0 || skipCountsAsFail > 0 || fixtureCountsAsFail > 0 ||
    unregistered.length > 0;
  process.exit(exitNonZero ? 1 : 0);
}

main();
