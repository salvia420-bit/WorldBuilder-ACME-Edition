// CMT Wave 11 / Phase 34 (2026-05-26) — PlayEffect placeholder VFX.
// CMT Wave 12 / Phase 37 (2026-05-26) — extended coverage for the
// highest-impact remaining PlayScript IDs (Splatter, Spark, Health*,
// Shield*, Death/Destroy, Fizzle).
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
      // Remaining ~122 PlayScript values — TODO for future verticals
      // (Attrib/Skill up/down, Enchant family, Regen family, Vitae,
      // Vision, SwapHealth, BreatheFlame/Frost/Acid/Lightning, Portal*,
      // SpecialState1-9/0/colour, LevelUp, Wedding, Dispel*, Aetheria*,
      // DirtyFighting*, etc.). Log so we can see what ACE is actually
      // broadcasting in real gameplay.
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
// for the Wave 11/12 acceptance traces.
export const __test = Object.freeze({
  spawnBurst: _spawnBurst,
  spawnRingBurst: _spawnRingBurst,
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
// Counts (as of Phase 37): shipped=50 (Launch + Explode + 48 from
// Phase 37). Total PLAY_SCRIPT enum size = 174 (0x00-0xAD). Remaining
// TODO ≈ 124 — the still-uncovered families list is documented in
// the comment above the catch-all `console.debug` in `_onPlayEffect`.
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
