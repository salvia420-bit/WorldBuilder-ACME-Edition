// CMT Wave 11 / Phase 34 (2026-05-26) — PlayEffect placeholder VFX.
// CMT Wave 12 / Phase 37 (2026-05-26) — extended coverage for the
// highest-impact remaining PlayScript IDs (Splatter, Spark, Health*,
// Shield*, Death/Destroy, Fizzle).
// CMT Wave 15 / Phase 47 (2026-05-26) — another batch of family
// coverage: Attrib* up/down (12 IDs), Skill* up/down (14 IDs incl
// SkillDownBlack + SkillDownVoid), Enchant* up/down (16 IDs incl
// Grey/White variants), Hide/UnHide/Hidden (3 IDs), PortalEntry/Exit/
// Storm (3 IDs), Camping Mastery/Ineptitude (2 IDs), LayingofHands
// (1 ID). 51 additional IDs → 101/174 shipped, ~73 still TODO.
//
// Self-registering Three.js module that subscribes to `playEffect`
// events on `window.__pluginClient.events` and spawns minimal
// geometry bursts at the target entity's position. Phase 34 covered:
//
//   - `PLAY_SCRIPT.Launch  (0x04)` — small additive-blend sphere,
//     blue-cyan, ~0.4m radius, fades over 500ms.
//   - `PLAY_SCRIPT.Explode (0x05)` — larger additive-blend sphere,
//     yellow-orange, ~1.2m radius, fades over 500ms.
//
// Phase 37 (Wave 12) extends with placeholder visuals for the
// combat-visible families (~48 additional IDs):
//
//   - Splatter family (0x5B-0x66, 12 IDs) — red sphere on hit.
//   - Spark family (0x67-0x72, 12 IDs) — tiny white sparkle.
//   - Health* family (0x1F-0x24 + 0xA7, 7 IDs) — green for *Up*
//     (heal), dim red for *Down*/*Void* (damage flash).
//   - Shield* family (0x2B-0x38, 14 IDs) — blue TorusGeometry ring
//     with rotation, for defensive-buff variety.
//   - Death (Destroy 0x59, DisappearDestroy 0x77) — large dark
//     purple expanding sphere.
//   - Fizzle (0x51) — brief gray puff for failed cast.
//
// All other (~122) PlayScript IDs continue to TODO-log via
// `console.debug` for future verticals. See `ui/ac_play_script.js`
// for the full 174-entry enum mirror, and the `VFX_COVERAGE` export
// below for the authoritative shipped-vs-TODO set.
//
// **Scope.** Real AC VFX uses `0x33 PhysicsScript` particle systems
// (see `scene3d/particles/particle.js` for the ACE-correct runtime
// already in the codebase). Phase 34 ships **placeholder visuals
// only** so the wire-to-render path is end-to-end verifiable. A
// future "PlayScript → PhysicsScript ID resolution + ParticleManager
// dispatch" vertical can swap the bursts here for the real
// retail-fidelity emitters.
//
// **Self-cleanup.** Each spawned burst tracks its own scale/opacity
// tween via `requestAnimationFrame`. On fade completion the mesh is
// removed from its parent group, the `THREE.SphereGeometry` and
// `THREE.MeshBasicMaterial` are `dispose()`-ed, and the active-bursts
// list entry is dropped. No memory leak even under sustained Launch/
// Explode storms.
//
// **Wire chain (proof of end-to-end connectivity):**
//
//   1. ACE broadcasts `GameMessageScript(target, script_id, speed)`
//      (opcode `0xF755 = PlayEffect`).
//   2. `crates/holtburger-protocol/src/messages/effects/types.rs`
//      decodes into `PlayEffectData`.
//   3. `crates/holtburger-world/src/handlers/system.rs:25` matches
//      on `GameMessage::PlayEffect(data)` and pushes
//      `WorldEvent::PlayEffect { target, script_id, speed }`.
//   4. `apps/holtburger-web/src/lib.rs` (WorldEvent dispatch arm —
//      paired with `EntityVisibilityChanged`) bridges to a
//      `ClientEvent { kind: 30 = CLIENT_EVENT_KIND_PLAY_EFFECT,
//      u32_payload: target, u32_payload_2: script_id, f32_payload:
//      speed }`.
//   5. `apps/holtburger-web/index.html`'s `drainEvents` loop dispatches
//      `evt.kind === 30` into `window.__pluginClient.events.emit(
//      "playEffect", { targetGuid, scriptId, speed })`.
//   6. This module's listener (registered on import below) resolves
//      the target entity's world position via
//      `liveScene3d.entityManager.entityMap.get(targetGuid)?.root?.position`
//      and spawns the burst mesh.

import * as THREE from "three";
import { PLAY_SCRIPT, playScriptName } from "../ui/ac_play_script.js";

// Default tween duration in ms (Launch/Explode). ~500ms keeps the
// visual on-screen long enough to be perceptible but short enough
// that high-rate scripts (e.g. Splatter family during sustained
// combat) don't visually overlap. Phase 37 added per-burst duration
// overrides on `_spawnBurst`/`_spawnRingBurst` for visuals that need
// to be shorter (Spark/Splatter — fire frequently) or longer (Death
// — major one-shot event).
const TWEEN_DURATION_MS = 500;

// =====================================================================
// Phase 37 — family ID sets.
// =====================================================================
// ACE's PlayScript enum carries family clusters (Splatter has 12 IDs
// for 4 quadrants × 3 heights; Shield has 14 IDs for 7 colors × up/
// down; etc.). Rather than write a switch arm per ID, we collapse each
// family into a single arm + a Set membership test. This keeps the
// dispatch concise + matches the placeholder-scope mandate (we don't
// distinguish e.g. SplatterLowLeftBack vs SplatterUpRightFront — both
// read as "damage hit"; the directional variants are a PhysicsScript-
// port concern, out of scope).

// Splatter family — 12 IDs, 0x5B-0x66 contiguous.
// Visual: red sphere on the damaged entity (universal damage cue).
const _SPLATTER_IDS = new Set([
  PLAY_SCRIPT.SplatterLowLeftBack, PLAY_SCRIPT.SplatterLowLeftFront,
  PLAY_SCRIPT.SplatterLowRightBack, PLAY_SCRIPT.SplatterLowRightFront,
  PLAY_SCRIPT.SplatterMidLeftBack, PLAY_SCRIPT.SplatterMidLeftFront,
  PLAY_SCRIPT.SplatterMidRightBack, PLAY_SCRIPT.SplatterMidRightFront,
  PLAY_SCRIPT.SplatterUpLeftBack, PLAY_SCRIPT.SplatterUpLeftFront,
  PLAY_SCRIPT.SplatterUpRightBack, PLAY_SCRIPT.SplatterUpRightFront,
]);

// Spark family — 12 IDs, 0x67-0x72 contiguous. Same directional
// taxonomy as Splatter but represents minor/mana cues (small white).
const _SPARK_IDS = new Set([
  PLAY_SCRIPT.SparkLowLeftBack, PLAY_SCRIPT.SparkLowLeftFront,
  PLAY_SCRIPT.SparkLowRightBack, PLAY_SCRIPT.SparkLowRightFront,
  PLAY_SCRIPT.SparkMidLeftBack, PLAY_SCRIPT.SparkMidLeftFront,
  PLAY_SCRIPT.SparkMidRightBack, PLAY_SCRIPT.SparkMidRightFront,
  PLAY_SCRIPT.SparkUpLeftBack, PLAY_SCRIPT.SparkUpLeftFront,
  PLAY_SCRIPT.SparkUpRightBack, PLAY_SCRIPT.SparkUpRightFront,
]);

// Health* heal scripts ("Up" — gaining HP / healing applied). Cyan-
// green is the universal healing color (matches retail UI's HP-bar
// recovery flash + standard fantasy-RPG convention).
const _HEALTH_UP_IDS = new Set([
  PLAY_SCRIPT.HealthUpRed, PLAY_SCRIPT.HealthUpBlue, PLAY_SCRIPT.HealthUpYellow,
]);

// Health* damage scripts ("Down" — losing HP / damage tick). Dim red
// instead of bright red so it's distinct from Splatter (which is the
// per-hit splash) — Down* often fires for ongoing DoT effects.
// HealthDownVoid (0xA7) is in the late-additions cluster but has the
// same gameplay semantic, so it gets the same color.
const _HEALTH_DOWN_IDS = new Set([
  PLAY_SCRIPT.HealthDownRed, PLAY_SCRIPT.HealthDownBlue,
  PLAY_SCRIPT.HealthDownYellow, PLAY_SCRIPT.HealthDownVoid,
]);

// Shield family — 14 IDs, 0x2B-0x38 (Red/Orange/Yellow/Green/Blue/
// Purple/Grey × Up/Down). All collapsed to one blue ring; per-color
// fidelity is a PhysicsScript port concern.
const _SHIELD_IDS = new Set([
  PLAY_SCRIPT.ShieldUpRed, PLAY_SCRIPT.ShieldDownRed,
  PLAY_SCRIPT.ShieldUpOrange, PLAY_SCRIPT.ShieldDownOrange,
  PLAY_SCRIPT.ShieldUpYellow, PLAY_SCRIPT.ShieldDownYellow,
  PLAY_SCRIPT.ShieldUpGreen, PLAY_SCRIPT.ShieldDownGreen,
  PLAY_SCRIPT.ShieldUpBlue, PLAY_SCRIPT.ShieldDownBlue,
  PLAY_SCRIPT.ShieldUpPurple, PLAY_SCRIPT.ShieldDownPurple,
  PLAY_SCRIPT.ShieldUpGrey, PLAY_SCRIPT.ShieldDownGrey,
]);

// Death — the AC enum has no literal `Death` entry; the canonical
// "entity is dying/being destroyed" cue is `Destroy (0x59)`. The
// adjacent `DisappearDestroy (0x77)` is a related "vanish + destroy"
// flavor (often used for despawn after timeout). Both get the dark-
// purple expanding sphere so the player gets visual closure when a
// remote entity drops.
const _DEATH_IDS = new Set([
  PLAY_SCRIPT.Destroy, PLAY_SCRIPT.DisappearDestroy,
]);

// =====================================================================
// Phase 47 — additional family ID sets (Wave 15).
// =====================================================================
// Same Set-membership pattern as Phase 37. Each cluster maps a color/
// up-down semantic to a single visual treatment; per-color (Red/Orange/
// Yellow/...) directional fidelity is a PhysicsScript port concern and
// stays out of scope here.

// AttribUp family (0x06-0x10 every-other-even) — buff applied to a
// primary attribute (Strength/Endurance/Coordination/Quickness/Focus/
// Self). Six color variants in ACE but all read as "stat buff" — green-
// yellow `0xc8ff44` is the positive-change cue (matches HUD level-up
// flash convention; green = beneficial in nearly every RPG).
const _ATTRIB_UP_IDS = new Set([
  PLAY_SCRIPT.AttribUpRed, PLAY_SCRIPT.AttribUpOrange,
  PLAY_SCRIPT.AttribUpYellow, PLAY_SCRIPT.AttribUpGreen,
  PLAY_SCRIPT.AttribUpBlue, PLAY_SCRIPT.AttribUpPurple,
]);

// AttribDown family (0x07-0x11 every-other-odd) — debuff applied to a
// primary attribute. Six color variants collapse to red-orange
// `0xff6633` (negative-change cue; distinct from Splatter's brighter
// pure-red and HealthDown's dim red so the player can tell "your stat
// was reduced" from "you took a hit").
const _ATTRIB_DOWN_IDS = new Set([
  PLAY_SCRIPT.AttribDownRed, PLAY_SCRIPT.AttribDownOrange,
  PLAY_SCRIPT.AttribDownYellow, PLAY_SCRIPT.AttribDownGreen,
  PLAY_SCRIPT.AttribDownBlue, PLAY_SCRIPT.AttribDownPurple,
]);

// SkillUp family (0x12-0x1C every-other-even) — buff applied to a
// skill. Same green-yellow palette as Attrib so the player learns one
// "stat went up" color, but uses a small cube (via _spawnCubeBurst) so
// they get geometric distinction between attribute vs skill changes —
// attributes are "core" (sphere), skills are "trained" (cube).
const _SKILL_UP_IDS = new Set([
  PLAY_SCRIPT.SkillUpRed, PLAY_SCRIPT.SkillUpOrange,
  PLAY_SCRIPT.SkillUpYellow, PLAY_SCRIPT.SkillUpGreen,
  PLAY_SCRIPT.SkillUpBlue, PLAY_SCRIPT.SkillUpPurple,
]);

// SkillDown family — debuff applied to a skill. Includes the two extra
// late-additions in the enum: `SkillDownBlack (0x1E)` (the seventh
// "color" — only present in Down direction, no SkillUpBlack exists)
// and `SkillDownVoid (0xA9)` from the Void cluster (gameplay-equivalent
// to the regular skill debuff per ACE source). All collapse to the red-
// orange Attrib-down color.
const _SKILL_DOWN_IDS = new Set([
  PLAY_SCRIPT.SkillDownRed, PLAY_SCRIPT.SkillDownOrange,
  PLAY_SCRIPT.SkillDownYellow, PLAY_SCRIPT.SkillDownGreen,
  PLAY_SCRIPT.SkillDownBlue, PLAY_SCRIPT.SkillDownPurple,
  PLAY_SCRIPT.SkillDownBlack, PLAY_SCRIPT.SkillDownVoid,
]);

// EnchantUp family — enchantment applied (spell buff). 0x39-0x43
// covers the 6 color cycle; 0x8B (EnchantUpGrey) and 0x8E
// (EnchantUpWhite) are late-additions for two additional palette
// slots ACE added for late-Throne-of-Destiny enchantments. All collapse
// to a gold `0xffd966` brief flash (gold = magical-aura convention).
const _ENCHANT_UP_IDS = new Set([
  PLAY_SCRIPT.EnchantUpRed, PLAY_SCRIPT.EnchantUpOrange,
  PLAY_SCRIPT.EnchantUpYellow, PLAY_SCRIPT.EnchantUpGreen,
  PLAY_SCRIPT.EnchantUpBlue, PLAY_SCRIPT.EnchantUpPurple,
  PLAY_SCRIPT.EnchantUpGrey, PLAY_SCRIPT.EnchantUpWhite,
]);

// EnchantDown family — enchantment expired / dispelled. Same 8-color
// layout as EnchantUp. Muted purple `0x9966dd` (de-magic / fade-out
// convention; distinct from EnchantUp's gold so dispel reads
// differently from apply at a glance).
const _ENCHANT_DOWN_IDS = new Set([
  PLAY_SCRIPT.EnchantDownRed, PLAY_SCRIPT.EnchantDownOrange,
  PLAY_SCRIPT.EnchantDownYellow, PLAY_SCRIPT.EnchantDownGreen,
  PLAY_SCRIPT.EnchantDownBlue, PLAY_SCRIPT.EnchantDownPurple,
  PLAY_SCRIPT.EnchantDownGrey, PLAY_SCRIPT.EnchantDownWhite,
]);

// Camping family — `CampingMastery (0x90)` + `CampingIneptitude (0x91)`.
// "Camping" in AC = the temporary "resting" buff/debuff when standing
// still long enough (skill-grade affects which side fires). Gentle
// cyan slow pulse (`_CALM_COLOR` 0x88ddff) — peaceful / restful cue.
const _CAMPING_IDS = new Set([
  PLAY_SCRIPT.CampingMastery, PLAY_SCRIPT.CampingIneptitude,
]);

// Portal family — PortalEntry (0x52) / PortalExit (0x53) / PortalStorm
// (0x73). PortalStorm is the "you got recalled" atmospheric flash; the
// other two are per-traversal cues. All three get the bright purple
// expanding-sphere treatment, with per-script scale/duration tuning in
// the dispatch (Entry: expanding 0.3→2.0/600ms, Exit: contracting
// 2.0→0.3/600ms, Storm: bright white burst 0.5→1.5/500ms).
//
// Storm is grouped here because it's portal-related semantically, but
// we don't bundle it into a single arm — see the dispatch for per-ID
// branching.
const _PORTAL_FAMILY_IDS = new Set([
  PLAY_SCRIPT.PortalEntry, PLAY_SCRIPT.PortalExit, PLAY_SCRIPT.PortalStorm,
]);

// Active burst registry — drives both per-frame tween updates and
// the cleanup on completion. Each entry holds the mesh + start time
// + scale-from/to + parent group reference so we can detach + dispose
// when the tween finishes.
//
// Keyed by an opaque numeric handle so cleanup can skip-iterate. We
// don't need ordered iteration; a Map keeps insert/delete O(1).
const _activeBursts = new Map();
let _nextHandle = 1;

// Single shared rAF loop for ALL active bursts. Idle when the map is
// empty; resumes on next spawn. Avoids one rAF callback per burst.
let _rafId = 0;
function _tickAllBursts() {
  _rafId = 0;
  if (_activeBursts.size === 0) return;
  const now = performance.now();
  // Iterate snapshot — _disposeBurst() mutates the map. `Array.from`
  // is cheap at the size we expect (<50 bursts in any realistic
  // combat scenario).
  for (const [handle, burst] of Array.from(_activeBursts.entries())) {
    // Per-burst durationMs override (Phase 37). Defaults to the
    // module-wide TWEEN_DURATION_MS for legacy Launch/Explode arms.
    const duration = burst.durationMs || TWEEN_DURATION_MS;
    const t = (now - burst.startMs) / duration;
    if (t >= 1.0) {
      _disposeBurst(handle, burst);
      continue;
    }
    // Ease-out — fast initial expansion, slow tail. `1 - (1-t)^3` is
    // the classic cubic ease-out and reads as "pop and settle".
    const inv = 1 - t;
    const ease = 1 - inv * inv * inv;
    const scale = burst.scaleFrom + (burst.scaleTo - burst.scaleFrom) * ease;
    burst.mesh.scale.setScalar(scale);
    // Opacity fades linearly from full-on to zero so the tail is
    // smooth even after the scale ease saturates.
    burst.material.opacity = (1 - t) * burst.opacityFrom;
    // Phase 37 — Shield rings spin a full 360° over the burst lifetime
    // for visual interest beyond pulse+fade. `rotateRadians` is set at
    // spawn (Math.PI * 2 for one rotation, 0 for static bursts). Axis
    // is Z (the torus's normal axis post-construction) so the ring
    // remains face-on to the camera if it was oriented that way.
    if (burst.rotateRadians) {
      burst.mesh.rotation.z = burst.rotateRadians * t;
    }
  }
  if (_activeBursts.size > 0 && typeof requestAnimationFrame === "function") {
    _rafId = requestAnimationFrame(_tickAllBursts);
  }
}

function _ensureRafRunning() {
  if (_rafId !== 0) return;
  if (typeof requestAnimationFrame !== "function") return;
  _rafId = requestAnimationFrame(_tickAllBursts);
}

function _disposeBurst(handle, burst) {
  try {
    if (burst.parent && burst.mesh && burst.mesh.parent === burst.parent) {
      burst.parent.remove(burst.mesh);
    }
    if (burst.geometry && typeof burst.geometry.dispose === "function") {
      burst.geometry.dispose();
    }
    if (burst.material && typeof burst.material.dispose === "function") {
      burst.material.dispose();
    }
  } catch (e) {
    // Never let a disposal error kill the rAF loop or leak the
    // registry entry. The map.delete below still fires.
    // eslint-disable-next-line no-console
    console.warn("[play-effect-vfx] burst cleanup threw:", e);
  }
  _activeBursts.delete(handle);
}

/**
 * Resolve a target entity's three.js world position by GUID. Returns
 * `null` when the entity isn't currently in the entity map (race with
 * ObjectCreate, post-despawn PlayEffect, etc.) — the caller logs +
 * skips the burst.
 *
 * Reads through `window.liveScene3d.entityManager.entityMap` — the
 * canonical entity registry populated by `scene3d/entities.js`. Pose
 * is `inst.root.position` (a `THREE.Vector3`); see entities.js:455
 * for the assignment.
 *
 * @param {number} targetGuid
 * @returns {{ position: import("three").Vector3, parent: import("three").Object3D } | null}
 */
function _resolveTargetPlacement(targetGuid) {
  try {
    if (typeof window === "undefined") return null;
    const ls = window.liveScene3d;
    if (!ls) return null;
    const em = ls.entityManager;
    if (!em || !em.entityMap || typeof em.entityMap.get !== "function") {
      return null;
    }
    const inst = em.entityMap.get(targetGuid >>> 0);
    if (!inst || !inst.root) return null;
    return {
      position: inst.root.position,
      // Add bursts to entitiesGroup so they inherit worldRoot's AC→three
      // rotation. entitiesGroup is the parent of all entity rigs; see
      // scene3d/entities.js:1299 and scene3d/index.js:551.
      parent: ls.entitiesGroup ?? inst.root.parent ?? null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Spawn a placeholder additive-blend sphere burst at `position`,
 * parented to `parent`. The burst tweens scale from `scaleFrom` to
 * `scaleTo` and opacity from 1.0 to 0.0 over `durationMs` (default
 * `TWEEN_DURATION_MS`), then auto-disposes.
 *
 * @param {import("three").Object3D} parent
 * @param {import("three").Vector3} position
 * @param {number} scaleFrom - starting radius scalar (THREE.Mesh.scale)
 * @param {number} scaleTo - ending radius scalar
 * @param {number} color - 0xRRGGBB
 * @param {number} [durationMs] - per-burst duration override (Phase 37);
 *   omit to inherit the module default of 500ms.
 */
function _spawnBurst(parent, position, scaleFrom, scaleTo, color, durationMs) {
  if (!parent) return;
  // Unit sphere (radius 1) — actual size driven by mesh.scale. Reusing
  // a shared baseline geometry would save allocations but each burst
  // can dispose its own geometry cleanly on completion without
  // refcounting. At realistic spawn rates this is fine.
  const geometry = new THREE.SphereGeometry(1.0, 16, 12);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "playEffectBurst";
  mesh.position.copy(position);
  mesh.scale.setScalar(scaleFrom);
  // Render slightly above terrain/entities so it's visible against
  // dense rigs (drudge body, etc.). depthWrite:false above already
  // means we don't occlude later geometry.
  mesh.renderOrder = 950;
  parent.add(mesh);

  const handle = _nextHandle++;
  _activeBursts.set(handle, {
    mesh,
    geometry,
    material,
    parent,
    startMs: performance.now(),
    scaleFrom,
    scaleTo,
    opacityFrom: 1.0,
    durationMs: durationMs || 0, // 0 = inherit TWEEN_DURATION_MS in the tick loop
  });
  _ensureRafRunning();
}

/**
 * Spawn a placeholder additive-blend torus (ring) burst at `position`,
 * parented to `parent`. Tweens scale + opacity like `_spawnBurst` but
 * uses a `THREE.TorusGeometry` for distinct silhouette (Phase 37 —
 * Shield family). Optionally rotates a full `rotateRadians` over the
 * burst lifetime; pass `Math.PI * 2` for one rotation.
 *
 * Shield family is rotated face-on (XY plane) so the ring reads as a
 * "ward" around the target rather than a sphere — visual contrast vs
 * the sphere bursts used by the other families.
 *
 * @param {import("three").Object3D} parent
 * @param {import("three").Vector3} position
 * @param {number} scaleFrom
 * @param {number} scaleTo
 * @param {number} color - 0xRRGGBB
 * @param {number} durationMs
 * @param {number} [rotateRadians=0] - total rotation about Z over the
 *   burst lifetime; 0 = static. Default 0 keeps the helper general.
 */
function _spawnRingBurst(
  parent,
  position,
  scaleFrom,
  scaleTo,
  color,
  durationMs,
  rotateRadians = 0,
) {
  if (!parent) return;
  // Torus parameters per Phase 37 plan: outer radius 0.5, tube
  // thickness 0.05, 12 radial segments, 24 tubular segments. Cheap
  // (288 tris) and reads cleanly as a "shield ring" silhouette.
  const geometry = new THREE.TorusGeometry(0.5, 0.05, 12, 24);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Rings are thin; DoubleSide ensures visibility regardless of
    // camera angle relative to the torus's XY plane.
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "playEffectRing";
  mesh.position.copy(position);
  mesh.scale.setScalar(scaleFrom);
  mesh.renderOrder = 950;
  parent.add(mesh);

  const handle = _nextHandle++;
  _activeBursts.set(handle, {
    mesh,
    geometry,
    material,
    parent,
    startMs: performance.now(),
    scaleFrom,
    scaleTo,
    opacityFrom: 1.0,
    durationMs: durationMs || 0,
    rotateRadians,
  });
  _ensureRafRunning();
}

/**
 * Spawn a placeholder additive-blend cube burst at `position` (Phase
 * 47). Geometric distinction from `_spawnBurst` (sphere) so the player
 * can differentiate attribute changes (sphere = core stat) vs skill
 * changes (cube = trained ability) at a glance even with identical
 * color palettes.
 *
 * Cube is `BoxGeometry(1,1,1)` driven by `mesh.scale`. Rotates 90°
 * over the burst lifetime for visual life — feels like a "trained
 * skill ticked up" vs a static pulse.
 *
 * @param {import("three").Object3D} parent
 * @param {import("three").Vector3} position
 * @param {number} scaleFrom
 * @param {number} scaleTo
 * @param {number} color
 * @param {number} durationMs
 */
function _spawnCubeBurst(
  parent,
  position,
  scaleFrom,
  scaleTo,
  color,
  durationMs,
) {
  if (!parent) return;
  // Box(1,1,1) — 12 tris, cheaper than the sphere. Scale-driven sizing
  // matches the other burst helpers' invariants.
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "playEffectCube";
  mesh.position.copy(position);
  mesh.scale.setScalar(scaleFrom);
  mesh.renderOrder = 950;
  parent.add(mesh);

  const handle = _nextHandle++;
  _activeBursts.set(handle, {
    mesh,
    geometry,
    material,
    parent,
    startMs: performance.now(),
    scaleFrom,
    scaleTo,
    opacityFrom: 1.0,
    durationMs: durationMs || 0,
    // Quarter-turn over the burst lifetime — drives the same Z-rotation
    // path the ring uses (rAF tick reads `rotateRadians` if present).
    rotateRadians: Math.PI * 0.5,
  });
  _ensureRafRunning();
}

/**
 * Event handler for `playEffect` on the plugin event bus.
 *
 * @param {CustomEvent<{ targetGuid: number, scriptId: number, speed: number }>} evt
 */
function _onPlayEffect(evt) {
  const detail = evt?.detail ?? {};
  const targetGuid = (detail.targetGuid >>> 0) || 0;
  const scriptId = (detail.scriptId >>> 0) || 0;
  // speed is a wire field (typically 1.0); we don't use it for the
  // placeholder visuals but accept it so we don't drop it on the
  // floor — future PhysicsScript integration will respect playback
  // rate.
  const speed = Number.isFinite(detail.speed) ? detail.speed : 1.0;
  void speed; // touched so eslint no-unused-vars stays happy

  if (targetGuid === 0) {
    // eslint-disable-next-line no-console
    console.debug("[play-effect-vfx] skipped: targetGuid=0");
    return;
  }

  const placement = _resolveTargetPlacement(targetGuid);

  switch (scriptId) {
    case PLAY_SCRIPT.Launch: {
      // Small blue-cyan additive burst at the projectile's spawn
      // position. Mirrors retail's "spell-projectile leaving caster"
      // visual cue.
      if (!placement) {
        // eslint-disable-next-line no-console
        console.debug(
          `[play-effect-vfx] Launch target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
        );
        return;
      }
      _spawnBurst(placement.parent, placement.position, 0.1, 0.45, 0x4abcff);
      return;
    }
    case PLAY_SCRIPT.Explode: {
      // Larger yellow-orange burst at the impact target. Mirrors
      // retail's projectile-collision splash.
      if (!placement) {
        // eslint-disable-next-line no-console
        console.debug(
          `[play-effect-vfx] Explode target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
        );
        return;
      }
      _spawnBurst(placement.parent, placement.position, 0.2, 1.2, 0xffa733);
      return;
    }
    default: {
      // ---------------------------------------------------------------
      // Phase 37 — extended family coverage. Each block below maps an
      // ACE PlayScript family (Set membership) to a placeholder visual.
      // We check Sets here (rather than adding 48 explicit switch arms)
      // to keep the dispatch compact + keep family semantics colocated.
      // ---------------------------------------------------------------

      // Splatter (0x5B-0x66) — generic damage hit. Red `0xff3030` is
      // the universal "damage taken" cue (matches HP-bar drops, retail
      // floating-damage numbers, and standard combat-feedback color
      // conventions across the genre). Short 300ms duration since
      // sustained combat fires Splatter on every hit.
      if (_SPLATTER_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Splatter target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 0.4, 0xff3030, 300);
        return;
      }

      // Spark (0x67-0x72) — minor cast / mana fizz. White `0xffffff` is
      // the canonical "magical micro-effect" color (mana shimmer, cast
      // spark) — visually neutral, doesn't compete with combat reds/
      // greens. Tiny scale (0.05-0.15) + brief 200ms = "blink and
      // you'll miss it" appropriate for a minor cue.
      if (_SPARK_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Spark target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.05, 0.15, 0xffffff, 200);
        return;
      }

      // Health* (Up) — heal applied. Cyan-green `0x40ff80` is the
      // universal "healing / vitality restored" color (matches HP
      // recovery in nearly every RPG; biological-green associations).
      // 400ms is mid-duration — perceptible recovery but doesn't
      // linger on long-running heal effects.
      if (_HEALTH_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] HealthUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.15, 0.5, 0x40ff80, 400);
        return;
      }

      // Health* (Down/Void) — damage indicator / DoT tick. Dim red
      // `0xa03030` (instead of Splatter's bright `0xff3030`) so the
      // player can distinguish a one-shot hit (Splatter — bright) from
      // ongoing health loss like a poison/bleed tick (Down — dim).
      if (_HEALTH_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] HealthDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.15, 0.5, 0xa03030, 400);
        return;
      }

      // Shield family (0x2B-0x38) — defensive buff. Blue `0x4080ff` is
      // the universal "ward / protection / barrier" color (sky blue =
      // defensive in fantasy convention; matches Three.js demos of
      // shield bubble effects). Uses TorusGeometry instead of a sphere
      // for clear visual distinction from damage/heal bursts — this
      // pops as a ring around the defended entity. Rotates 360° over
      // 600ms for added visual interest.
      if (_SHIELD_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Shield target 0x${targetGuid.toString(16)} not in entityMap — skipping ring`,
          );
          return;
        }
        _spawnRingBurst(
          placement.parent, placement.position,
          1.0, 1.5, 0x4080ff, 600, Math.PI * 2,
        );
        return;
      }

      // Death (Destroy / DisappearDestroy) — entity is dying. Dark
      // purple `0x6b1a8a` carries the "death / void / final" semantic
      // (purple = death in many fantasy contexts; AC itself uses dark
      // purple for vitae/death portals). Long 800ms + large scale
      // (0.3→1.5) since death is a major, infrequent event — gets to
      // dominate visually.
      if (_DEATH_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Death target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.3, 1.5, 0x6b1a8a, 800);
        return;
      }

      // Fizzle (0x51) — spell cast failed. Gray `0x808080` reads as
      // "nothing happened / dud" — visually muted on purpose since a
      // failed cast deserves a small acknowledgment but shouldn't
      // compete with successful-cast visuals. 350ms brief puff.
      if (scriptId === PLAY_SCRIPT.Fizzle) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Fizzle target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 0.3, 0x808080, 350);
        return;
      }

      // ---------------------------------------------------------------
      // Phase 47 (Wave 15) — extended family coverage continued.
      // ---------------------------------------------------------------

      // AttribUp (0x06,0x08,0x0A,0x0C,0x0E,0x10) — attribute buff. Green-
      // yellow `0xc8ff44` sphere; positive stat-change cue. 400ms reads
      // as "your stat went up" — long enough to register but doesn't
      // linger when multiple buffs land in rapid succession.
      if (_ATTRIB_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] AttribUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.15, 0.5, 0xc8ff44, 400);
        return;
      }

      // AttribDown (0x07,0x09,0x0B,0x0D,0x0F,0x11) — attribute debuff.
      // Red-orange `0xff6633` sphere (distinct from Splatter/HealthDown
      // so the player learns three distinct red cues: bright = hit,
      // dim = HP loss, orange = stat debuff).
      if (_ATTRIB_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] AttribDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.15, 0.5, 0xff6633, 400);
        return;
      }

      // SkillUp (0x12,0x14,0x16,0x18,0x1A,0x1C) — skill buff. Same
      // green-yellow palette as AttribUp but via the cube helper for
      // geometric distinction (attribute = sphere, skill = cube).
      if (_SKILL_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] SkillUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnCubeBurst(placement.parent, placement.position, 0.1, 0.4, 0xc8ff44, 400);
        return;
      }

      // SkillDown (0x13,0x15,0x17,0x19,0x1B,0x1D,0x1E,0xA9) — skill
      // debuff. Red-orange cube. 0x1E = SkillDownBlack (the 7th color
      // unique to Down direction); 0xA9 = SkillDownVoid (Void-cluster
      // late-addition; gameplay-equivalent to a normal skill debuff).
      if (_SKILL_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] SkillDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnCubeBurst(placement.parent, placement.position, 0.1, 0.4, 0xff6633, 400);
        return;
      }

      // EnchantUp (0x39-0x43 cycle + 0x8B Grey + 0x8E White) — enchant
      // applied. Gold `0xffd966` brief flash (300ms; magical-aura
      // convention — gold pulses around an entity gaining a spell
      // effect). Smaller scale than Attrib/Skill since enchants land
      // frequently in combat (every spell cast on you).
      if (_ENCHANT_UP_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] EnchantUp target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 0.4, 0xffd966, 300);
        return;
      }

      // EnchantDown (0x3A-0x44 cycle + 0x8C Grey + 0x8F White) — enchant
      // expired/dispelled. Muted purple `0x9966dd` — visually contrasts
      // with EnchantUp's gold so the two read as opposite events at a
      // glance.
      if (_ENCHANT_DOWN_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] EnchantDown target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.1, 0.4, 0x9966dd, 300);
        return;
      }

      // Hide (0x74) — stealth engaged. Gray `0x666666` sphere fades-IN
      // (scaleFrom > scaleTo so the visual shrinks/dissolves as the
      // caster "vanishes"). Long-ish 500ms to telegraph the state
      // change.
      if (scriptId === PLAY_SCRIPT.Hide) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Hide target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        // scaleFrom=0.8 → scaleTo=0.2 (contracting) reads as "fading
        // into stealth". Opacity tween in the rAF loop also fades to
        // zero so the net effect is "shrinks and disappears".
        _spawnBurst(placement.parent, placement.position, 0.8, 0.2, 0x666666, 500);
        return;
      }

      // UnHide (0x75) — stealth dropped. Reverse: gray sphere expands
      // outward (scaleFrom < scaleTo) as the caster reappears.
      if (scriptId === PLAY_SCRIPT.UnHide) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] UnHide target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.2, 0.8, 0x666666, 500);
        return;
      }

      // Hidden (0x76) — passive "still in stealth" cue. Very brief
      // (150ms), tiny (0.05→0.1), barely visible — just enough to mark
      // the state without polluting the visual field. Used when ACE
      // broadcasts a periodic stealth confirmation.
      if (scriptId === PLAY_SCRIPT.Hidden) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Hidden target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.05, 0.1, 0x666666, 150);
        return;
      }

      // PortalEntry (0x52) — entering a portal. Bright purple
      // `0xcc44ff` expanding sphere 0.3→2.0 over 600ms — large
      // signature for an important traversal event.
      if (scriptId === PLAY_SCRIPT.PortalEntry) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] PortalEntry target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.3, 2.0, 0xcc44ff, 600);
        return;
      }

      // PortalExit (0x53) — exiting a portal at the destination.
      // Reverse-shape vs Entry: contracting sphere 2.0→0.3 — reads as
      // "materializing at destination". Same purple palette so the
      // entry/exit pair feel connected.
      if (scriptId === PLAY_SCRIPT.PortalExit) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] PortalExit target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 2.0, 0.3, 0xcc44ff, 600);
        return;
      }

      // PortalStorm (0x73) — atmospheric "you got recalled" or
      // "portal storm hit" flash. The closest semantic to a
      // "PortalSending" cue in the enum (no literal PortalSending
      // exists). White `0xffffff` burst 0.5→1.5/500ms — bright,
      // unambiguous "something portal-y just happened to you".
      if (scriptId === PLAY_SCRIPT.PortalStorm) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] PortalStorm target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.5, 1.5, 0xffffff, 500);
        return;
      }

      // Camping (0x90 Mastery / 0x91 Ineptitude) — resting buff/debuff
      // tick. Soft cyan `0x88ddff` slow pulse 0.4→0.9/800ms — gentle
      // peaceful vibe matches the "resting at a campsite" semantic.
      // No up/down color distinction here since both variants share
      // the same gameplay context (you're resting; mastery vs
      // ineptitude is about skill grade, not stat polarity).
      if (_CAMPING_IDS.has(scriptId)) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] Camping target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.4, 0.9, 0x88ddff, 800);
        return;
      }

      // LayingofHands (0x9B) — Paladin self-heal-or-touch-heal special.
      // Same calm cyan palette as Camping (peaceful / restorative) but
      // a touch brighter & faster (0.3→1.0/700ms) since it's a
      // discrete event vs Camping's ambient tick.
      if (scriptId === PLAY_SCRIPT.LayingofHands) {
        if (!placement) {
          // eslint-disable-next-line no-console
          console.debug(
            `[play-effect-vfx] LayingofHands target 0x${targetGuid.toString(16)} not in entityMap — skipping burst`,
          );
          return;
        }
        _spawnBurst(placement.parent, placement.position, 0.3, 1.0, 0x88ddff, 700);
        return;
      }

      // ---------------------------------------------------------------
      // Remaining ~73 PlayScript values — TODO for future verticals
      // (Regen family, Vitae*, Vision*, SwapHealth*, Trans*,
      // BreatheFlame/Frost/Acid/Lightning, Create, ProjectileCollision,
      // SpecialState1-9/0/colour, LevelUp, Wedding* (Bliss/Steele),
      // Dispel*, Bunny/BaelZharon, Restriction*, Augmentation*,
      // BlackMadness, Aetheria*, RegenDownVoid, DirtyFighting*).
      // Log so we can see what ACE is actually broadcasting in real
      // gameplay.
      // ---------------------------------------------------------------
      // eslint-disable-next-line no-console
      console.debug(
        `[play-effect-vfx] TODO: scriptId=0x${scriptId.toString(16)} (${playScriptName(scriptId)}) target=0x${targetGuid.toString(16)}`,
      );
      return;
    }
  }
}

// =====================================================================
// Self-registration on import.
// =====================================================================
//
// The plugin event bus is built inside `plugins/api.js` and only
// becomes reachable once `createClient(sessionHandle)` runs (after
// successful login). Importing this module at page load doesn't
// guarantee `window.__pluginClient` exists yet — so we poll briefly
// for it, then bind. The same pattern is used by other one-shot
// listener modules (e.g. compass-hud's plugin-style auto-mount).
//
// Idempotency: a `__playEffectVfxBound` flag on `window` prevents
// double-binding if this module is re-evaluated (Firefox ES-module
// cache trap from a `?v=` rebust, dev hot-reload, etc.).

function _tryBind() {
  if (typeof window === "undefined") return true;
  if (window.__playEffectVfxBound === true) return true;
  const pc = window.__pluginClient;
  if (!pc || !pc.events || typeof pc.events.on !== "function") return false;
  pc.events.on("playEffect", _onPlayEffect);
  window.__playEffectVfxBound = true;
  // eslint-disable-next-line no-console
  console.log("[play-effect-vfx] bound to __pluginClient.events");
  return true;
}

(function _autoBind() {
  if (typeof window === "undefined") return;
  if (_tryBind()) return;
  // Plugin client not ready yet — poll every 200ms for up to 30s
  // (post-login bootstrap on weak hardware can take ~20s in cold
  // boot per the Wave 10/11 plan §"Wave 11 enablement"). 150 ticks
  // is a hard ceiling; we stop after that to avoid leaking a setInterval
  // on a session that never completes login.
  let ticks = 0;
  const MAX_TICKS = 150;
  const iv = setInterval(() => {
    ticks++;
    if (_tryBind() || ticks >= MAX_TICKS) {
      clearInterval(iv);
      if (ticks >= MAX_TICKS && (typeof window === "undefined" || !window.__playEffectVfxBound)) {
        // eslint-disable-next-line no-console
        console.warn("[play-effect-vfx] gave up waiting for __pluginClient after 30s");
      }
    }
  }, 200);
})();

// Re-exports for diag/testing — call these directly to verify the
// burst pipeline works without needing a live server event. Useful
// for the Wave 11/12/15 acceptance traces.
export const __test = Object.freeze({
  spawnBurst: _spawnBurst,
  spawnRingBurst: _spawnRingBurst,
  spawnCubeBurst: _spawnCubeBurst,
  resolveTargetPlacement: _resolveTargetPlacement,
  onPlayEffect: _onPlayEffect,
  activeBurstCount: () => _activeBursts.size,
});

// =====================================================================
// VFX_COVERAGE — authoritative manifest of which PlayScript IDs ship
// placeholder visuals vs which still TODO-log. Useful for diag
// dashboards and future agents (Wave 13+) to know what's already
// painted vs what still needs a vertical.
// =====================================================================
//
// `shipped` is a frozen Set of every numeric PlayScript ID that has a
// real visual treatment (the dispatch arm returns a `_spawnBurst` /
// `_spawnRingBurst` and does NOT fall through to the TODO log).
//
// `families` maps the human-readable family label to the IDs in it.
// Iteration order matches the dispatch order in `_onPlayEffect`.
//
// Counts (as of Phase 47): shipped=101 (Launch + Explode + 48 from
// Phase 37 + 51 from Phase 47). Total PLAY_SCRIPT enum size = 174
// (0x00-0xAD). Remaining TODO ≈ 73 — the still-uncovered families
// list is documented in the comment above the catch-all
// `console.debug` in `_onPlayEffect`.
const _COVERAGE_FAMILIES = Object.freeze({
  Launch: [PLAY_SCRIPT.Launch],
  Explode: [PLAY_SCRIPT.Explode],
  Splatter: Array.from(_SPLATTER_IDS),
  Spark: Array.from(_SPARK_IDS),
  HealthUp: Array.from(_HEALTH_UP_IDS),
  HealthDown: Array.from(_HEALTH_DOWN_IDS),
  Shield: Array.from(_SHIELD_IDS),
  Death: Array.from(_DEATH_IDS),
  Fizzle: [PLAY_SCRIPT.Fizzle],
  // Phase 47 additions (Wave 15).
  AttribUp: Array.from(_ATTRIB_UP_IDS),
  AttribDown: Array.from(_ATTRIB_DOWN_IDS),
  SkillUp: Array.from(_SKILL_UP_IDS),
  SkillDown: Array.from(_SKILL_DOWN_IDS),
  EnchantUp: Array.from(_ENCHANT_UP_IDS),
  EnchantDown: Array.from(_ENCHANT_DOWN_IDS),
  Hide: [PLAY_SCRIPT.Hide],
  UnHide: [PLAY_SCRIPT.UnHide],
  Hidden: [PLAY_SCRIPT.Hidden],
  Portal: Array.from(_PORTAL_FAMILY_IDS),
  Camping: Array.from(_CAMPING_IDS),
  LayingofHands: [PLAY_SCRIPT.LayingofHands],
});

const _COVERAGE_SHIPPED_SET = new Set();
for (const ids of Object.values(_COVERAGE_FAMILIES)) {
  for (const id of ids) _COVERAGE_SHIPPED_SET.add(id);
}

export const VFX_COVERAGE = Object.freeze({
  shipped: _COVERAGE_SHIPPED_SET,
  families: _COVERAGE_FAMILIES,
  // Total enum size (PLAY_SCRIPT has 174 entries: 0x00-0xAD inclusive).
  // Kept as a hard-coded mirror so a diag consumer can compute the
  // TODO count without re-importing PLAY_SCRIPT.
  enumTotal: 174,
  shippedCount: _COVERAGE_SHIPPED_SET.size,
  todoCount: 174 - _COVERAGE_SHIPPED_SET.size,
});
