// CMT Wave 11 / Phase 34 (2026-05-26) — PlayEffect placeholder VFX.
//
// Self-registering Three.js module that subscribes to `playEffect`
// events on `window.__pluginClient.events` and spawns minimal
// particle bursts at the target entity's position for the two
// most-common PlayScript IDs:
//
//   - `PLAY_SCRIPT.Launch  (0x04)` — small additive-blend sphere,
//     blue-cyan, ~0.4m radius, fades over 500ms.
//   - `PLAY_SCRIPT.Explode (0x05)` — larger additive-blend sphere,
//     yellow-orange, ~1.2m radius, fades over 500ms.
//
// All other PlayScript IDs are TODO-logged via `console.debug` for
// future agents (see `ui/ac_play_script.js` for the full 174-entry
// enum mirror).
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

// Tween duration in ms. ~500ms keeps the visual on-screen long enough
// to be perceptible but short enough that high-rate scripts (e.g.
// Splatter family during sustained combat) don't visually overlap.
const TWEEN_DURATION_MS = 500;

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
    const t = (now - burst.startMs) / TWEEN_DURATION_MS;
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
 * `scaleTo` and opacity from 1.0 to 0.0 over `TWEEN_DURATION_MS`,
 * then auto-disposes.
 *
 * @param {import("three").Object3D} parent
 * @param {import("three").Vector3} position
 * @param {number} scaleFrom - starting radius scalar (THREE.Mesh.scale)
 * @param {number} scaleTo - ending radius scalar
 * @param {number} color - 0xRRGGBB
 */
function _spawnBurst(parent, position, scaleFrom, scaleTo, color) {
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
      // All other 172 PlayScript values — TODO for future verticals
      // (debuff stings, level-up flash, attribute up/down, portal
      // entry/exit, etc.). Log so we can see what ACE is actually
      // broadcasting in real gameplay.
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
// for the Wave 11 acceptance trace.
export const __test = Object.freeze({
  spawnBurst: _spawnBurst,
  resolveTargetPlacement: _resolveTargetPlacement,
  onPlayEffect: _onPlayEffect,
  activeBurstCount: () => _activeBursts.size,
});
