// 2026-05-21 — wire-agent mode (?wireframe=1) gate. Module-scope const
// matches the URL-parsing pattern other modules use. When true, the
// per-entity surface material at L977 swaps from MeshStandardMaterial
// (texture+PBR) to a shared MeshBasicMaterial({wireframe:true}) so
// entities render as wire silhouettes consistent with the rest of the
// scene in wire-agent mode.
const WIREFRAME_MODE = (() => {
  try {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("wireframe") === "1";
  } catch (_) { return false; }
})();

// Phase 7.4b — EntityManager: per-entity Object3D rig + AnimationMixer.
//
// Sister to the 2D path's `entityMap` + `tickEntityAnimations`
// (`index.html:3354 + 4483-4644`). Where the 2D path bakes pre-
// rasterized walk-cycle frames and swaps PIXI textures per rAF, the
// 3D path holds keyframes as `THREE.AnimationClip`s and runs one
// `AnimationMixer` per entity. Stance-keyed cycle map mirrors the 2D
// `EntityCycleSet`; cap of 4 actions per setup matches
// `MAX_BAKES_PER_SETUP = 4` (`index.html:2992`).
//
// Animations are rigid-body per-part (NOT skinned). The rig is a
// `THREE.Group` whose direct children are per-part `THREE.Group`s
// named `part_0..part_N` — those names match
// `AnimationCache.partNames` (Phase 7.4a) so each clip's
// `${partName}.position` / `${partName}.quaternion` tracks resolve.
// Per-part Mesh leaves (one per Surface DID, from
// `meshToGeometryGroups`) hang off their part Group so the animation
// translates the entire part as a unit — exactly how AC's wire format
// stores it.
//
// Spawn flow:
//   1. spawn(meta) is async — kicks `fetchEntityAnimationKeyframes`
//      via the AnimationCache. The cache returns rest-pose part
//      meshes + (optional) AnimationClip for the requested
//      (motionCommand, stance).
//   2. Build root Group at world coords (landblockId * 192 + meta.x);
//      build per-part Groups with Mesh children; resolve materials
//      via the shared MaterialCache. Stash on entityMap[guid].
//   3. If a clip resolved, mixer.clipAction(clip).play() — first cycle
//      starts immediately. STOP / 0 motion plays no clip (rest pose).
//
// Motion-switch flow (kind=5 UpdateMotion):
//   1. setMotion(guid, cmd, stance) — fire-and-forget async cache
//      lookup for the new (cmd, stance) key.
//   2. When the new clip resolves: crossFadeTo(newAction, 0.2) on the
//      currently playing action. If currentAction is null (was idle),
//      newAction.play() with a fadeIn(0.2). STOP transitions stop the
//      current action with a 0.2 s fade-out.
//   3. If the cache hits the per-setup cap of 4, the oldest unused
//      action is evicted (mixer.uncacheAction) before the new one
//      installs.
//
// Per-rAF tick(dt): walk every mixer, call mixer.update(dt). Cheap;
// the heavy lifting is in the keyframe interpolators inside
// AnimationMixer.
//
// ──────────────────────────────────────────────────────────────────────
// Perf B3 (2026-05-18) — `__disposable` material/geometry tag convention
// ──────────────────────────────────────────────────────────────────────
//
// B3, C5, and E3 all need to dispose cloned three.js Materials (and
// occasionally Geometries) without crashing future renders by freeing
// a shared cache reference. The convention:
//
//   - Every fresh Material / Geometry that is NOT installed into the
//     shared `MaterialCache` (e.g. `new THREE.MeshBasicMaterial(...)` /
//     `new THREE.TorusGeometry(...)` / `baseMaterial.clone()`) MUST be
//     tagged at construction:
//
//         mat.userData.__disposable = true;
//         geom.userData.__disposable = true;
//
//   - At dispose time, traverse the entity's root group with
//     `_disposeMeshChildren(this.root)`. The helper dispatches to
//     `_disposeMaterialIfOwned`, which:
//       * disposes when `userData.__disposable === true`
//       * asserts `userData.__cacheOwned !== true` (belt-and-braces —
//         a cache material that escaped onto an entity rig would
//         silently corrupt other entities; the assertion surfaces it
//         as a console error at the call site instead).
//       * else: no-op (assumed cache-owned / shared singleton).
//
// `MaterialCache._installFromPixels()` + the cache's `fallbackMaterial`
// constructor tag cache-resident materials with `__cacheOwned = true`
// so the assertion catches the corruption case. B3 introduces this
// convention; C5 (`buildings.js` unload path) and E3
// (`particles/particle_manager.js` clone site) build on it.
//
// Future material/geometry clone introductions inside entities.js MUST
// follow the same tag pattern or the dispose path will quietly leak
// them (under-dispose is preferable to over-dispose; the assertion
// catches the over-dispose case).
//
// FU3 (2026-05-18) — geometries returned from `AnimationCache.get()`
// are SHARED across all spawns of the same `setupId` (see
// animation.js:316-329: "Multiple spawns of the same setupId all see
// the SAME BufferGeometry refs"). Disposing them on the first entity's
// despawn would free GPU buffers that surviving entities still
// reference — those next render against a disposed geometry. The B3
// `_disposeMeshChildren` originally disposed unconditionally and
// shipped a CAVEAT to gate it; FU3 closes that gate. The helper now
// disposes geometry only when `userData.__disposable === true`,
// matching the material path. AnimationCache geometries stay untagged
// → never disposed by this helper; entity-owned geometries (selection
// ring TorusGeometry, etc.) carry the tag at their construction site.

import * as THREE from "three";
import {
  meshToGeometryGroups,
  surfacePixelsToTexture,
  acQuatToThree,
} from "./adapter.js";
import { AnimationCache } from "./animation.js";
import { ensureNameplateForEntity } from "./nameplate_sprite.js";
import { materialCanCastShadow } from "./materials.js";

// AC InterpretedMotionCommand low-16 constants — used for
// category-agnostic classification. The wasm export returns the full
// u32 (`0x4500_xxxx` NonCombat / `0x4400_xxxx` combat / etc.); we mask
// to the low 16 bits and compare against retail's
// InterpretedMotionCommand enum so any stance's walk/run/stop maps to
// the same locomotion family. Mirrors `index.html:4377-4380`'s
// MOTION_CMD_* constants.
const CMD_LOW_STOP = 0x0004;
const CMD_LOW_WALK_FORWARD = 0x0005;
const CMD_LOW_WALK_BACKWARDS = 0x0006;
const CMD_LOW_RUN_FORWARD = 0x0007;
// Ready (0x41000003 — low 0x0003) is the stance-aware base pose:
// "weapon stowed" in NonCombat, "fists up" in HandCombat, "drawn"
// in SwordCombat, etc. Each stance defines its own Ready cycle in
// `MotionTable.cycles[(stance, Ready)]`. ACE broadcasts an
// UpdateMotion with cmd=Ready when the player toggles combat
// stance from idle, so the rig needs to swap to the new stance's
// Ready cycle to show the weapon-drawn pose. Pre-fix this command
// fell through `classifyMotionCommand` → null → setMotion treated
// it as STOP → fadeOutCurrent, and the stance change was tracked
// statefully (UI label updated) but never visualized on the rig.
const CMD_LOW_READY = 0x0003;

// One-shot motion commands — attacks (melee/missile), magic casts,
// and the punch variants. ACE broadcasts these via UpdateMotion when
// the player or a creature swings/casts/shoots; the client plays the
// corresponding clip once and returns to the underlying locomotion
// loop. Pre-2026-05-17 `classifyMotionCommand` returned `null` for
// these, so they were silently dropped and combat used a vibe-coded
// triangle-wave arm tween instead of the real motion-table clip.
// Values come from `~/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs`.
const ATTACK_COMMANDS = new Set([
  // Thrust  low / mid / high
  0x0058, 0x0059, 0x005A,
  // Slash high / mid / low
  0x005B, 0x005C, 0x005D,
  // Backhand high / mid / low
  0x005E, 0x005F, 0x0060,
  // Missile shoot
  0x0061,
  // Unarmed (variants 1, 2, 3) high / mid / low
  0x0062, 0x0063, 0x0064,
  0x0065, 0x0066, 0x0067,
  0x0068, 0x0069, 0x006A,
  // Missile attack 1 / 2 / 3
  0x00D0, 0x00D1, 0x00D2,
  // Punch fast/slow high/mid/low
  0x018F, 0x0190, 0x0191,
  0x0192, 0x0193, 0x0194,
  // Jump + JumpCharging — same one-shot semantics as attacks.
  // Pre-2026-05-17 these were dropped at classifyMotionCommand and
  // `setAirbornePose` handled jump with a vibe-coded slerp; the real
  // MotionTable clip (now resolvable through `setMotion`) wins if
  // the entity's motion table has the entry.
  0x003B, 0x001D,
]);
const CAST_COMMANDS = new Set([
  // MagicBlast, MagicThrowMissile, MagicSelf* variants
  0x002B, 0x002C, 0x002D, 0x002E, 0x002F, 0x0030, 0x0031, 0x0032,
  // PowerUp01..10
  0x006F, 0x0070, 0x0071, 0x0072, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077, 0x0078,
  // CastSpell
  0x00D3,
]);

// Per swing-classification spec (`docs/swing-classification-spec-
// 2026-05-19.md`) §1, §8: swings + casts live in
// `MotionTable.links[(stance, Ready)][swingCmd]`, NOT in `cycles`.
// Validated across all 436 retail motion tables (5,455 entries;
// 100 % share `from_substate == Ready`). Routes through `_tryPlayLink`
// in `setMotion` when `classifyMotionCommand` returns `"attack"`/`"cast"`.
const READY_SUBSTATE = 0x0003;

// Same 4-bake-per-setup ceiling the 2D path enforces
// (`index.html:2992`). Without this, a creature flipping stances
// rapidly would accrete unbounded mixer actions; the cap evicts
// least-recently-used to bound memory.
const MAX_ACTIONS_PER_SETUP = 4;

// Cohere-B (2026-05-12): retail AC never crossfaded between motions.
// Each motion command (stance change, walk/run cycle swap, attack
// one-shot) was a hard cut — the next AnimSet's frame 0 replaced the
// previous AnimSet's last frame on the very next tick. PhatSDK
// PartArray.cpp:337-405 `advance_to_next_animation()` does an
// unconditional pointer swap with no blend state. Setting this to 0
// makes `crossFadeTo` and `fadeOutCurrent` short-circuit to a hard
// stop+play swap below, matching that retail behaviour. Per the dev
// dev chat 2026-05-12, "rotational interpolation never existed in
// retail. not on release, not at end of retail." — and the same is
// true of cycle-to-cycle blends.
const CROSSFADE_S = 0;

// Perf B1 (2026-05-18) — tick-radius gate for `entityManager.tick`.
// Entities further than `MAX_TICK_DIST` metres from the active camera
// (world-space, three.js frame) skip mixer.update / hook execution /
// tween processing. Local player and entities with active tweens are
// always ticked regardless of distance. 120 m matches AC's typical
// PVS visibility envelope for animated entities — beyond that, the
// animation snap on re-entry is below perceptual threshold and the
// time-budget win on Academy (~104 spawns) is the headline.
//
// TODO (B1 follow-on) — frustum culling. The MVP is distance-only;
// adding a per-frame Frustum + Box3 test would skip more entities but
// requires per-frame projection-matrix bookkeeping and per-entity
// bounding spheres. Distance-only is well-defined and load-bearing
// enough to ship first.
const MAX_TICK_DIST = 120;
const MAX_TICK_DIST_SQ = MAX_TICK_DIST * MAX_TICK_DIST; // 14400 m²
// Module-private scratch Vector3 for entity world-position lookup in
// `_shouldTickEntity`. Callers must NOT retain a reference — the next
// `tick(dt)` reuses it.
const _tickGateScratch = new THREE.Vector3();

// Perf B2 (2026-05-18) — module-private scratches for the jump-pose
// tween (`_tickJumpPoseTween`) and the particle-attach hook
// (`_attachParticleChainForEntity`). Same convention as
// `_tickGateScratch`: callers must NOT retain a reference.
//
// READ-ONLY: never mutate `_IDENTITY_QUAT`. It's the canonical (0,0,0,1)
// reference used as the right-hand side of `.equals()` in the
// generic-jump tilt-vs-identity test. Mutating it would silently break
// every comparison downstream.
const _IDENTITY_QUAT = new THREE.Quaternion();
// Scratch Vector3 + Quaternion for the particle-attach offset frame
// passed to `ParticleManager.addEmitter({ parentOffset })`. The manager
// `.copy()`s these into its own `parentOffset` (see
// `ParticleEmitter.setParenting`, particle_emitter.js:114-118). See the
// call site for a CAVEAT about the await window between `.set()` and
// `setParenting` across overlapping fire-and-forget chain walks.
const _particleAttachScratchVec3 = new THREE.Vector3();
const _particleAttachScratchQuat = new THREE.Quaternion();

// Perf B3 (2026-05-18) — dispose helpers for `Entity.dispose()` to walk
// the rig's mesh children and free Geometry/Material that aren't
// shared cache references. See the `__disposable` tag convention in
// the module docstring above. C5 + E3 consume the same tag.
//
// `_disposeMaterialIfOwned` disposes only when the material carries
// `userData.__disposable === true`. As a safety net it also asserts
// the material is NOT `__cacheOwned` — that combination indicates a
// missing-`__disposable`-tag bug at the clone site, which the
// assertion surfaces as a console error instead of producing a silent
// "next render crashes" bug elsewhere. Both arrays-of-materials and
// scalar materials are handled by the caller.
function _disposeMaterialIfOwned(mat) {
  if (!mat) return;
  const ud = mat.userData;
  if (!ud) return;
  if (ud.__cacheOwned === true && ud.__disposable === true) {
    // Programmer error: a cache material was tagged disposable at some
    // clone site that should have stayed cache-owned. Dispose would
    // free the shared GPU resource other entities still reference.
    // eslint-disable-next-line no-console
    console.error(
      "[entities/B3] _disposeMaterialIfOwned: material is BOTH __cacheOwned and __disposable —" +
        " refusing to dispose. Audit the clone site that produced it.",
      { name: mat.name, userData: ud }
    );
    return;
  }
  if (ud.__disposable !== true) return;
  try {
    mat.dispose();
  } catch (_) {}
}

// `_disposeMeshChildren` walks the rig with `.traverse()` and frees
// per-Mesh geometry + materials. FU3 (2026-05-18) — both dispose paths
// are now gated by `userData.__disposable === true`: geometry via an
// inline check (no shared "cache-owned" assertion needed because
// AnimationCache doesn't tag, so a missing tag is the expected
// "shared" signal), material via `_disposeMaterialIfOwned`. Call
// BEFORE `root.parent.remove(root)` so the traverse path is still
// intact.
function _disposeMeshChildren(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    // FU3: only dispose __disposable-tagged geometries to avoid
    // freeing shared cached geometries from AnimationCache.
    if (obj.geometry?.userData?.__disposable === true) {
      try {
        obj.geometry.dispose();
      } catch (_) {}
    }
    if (Array.isArray(obj.material)) {
      for (const m of obj.material) _disposeMaterialIfOwned(m);
    } else {
      _disposeMaterialIfOwned(obj.material);
    }
  });
}

// Convert AC's full motion command (u32) to a coarse category for
// cycle selection. Returns one of "walk", "run", "stop", or null
// (unknown / non-locomotion command). Matches the 2D path's gate at
// `index.html:4534-4541`.
function classifyMotionCommand(cmd) {
  const low = cmd & 0xffff;
  if (low === CMD_LOW_STOP) return "stop";
  if (low === CMD_LOW_WALK_FORWARD || low === CMD_LOW_WALK_BACKWARDS)
    return "walk";
  if (low === CMD_LOW_RUN_FORWARD) return "run";
  if (ATTACK_COMMANDS.has(low)) return "attack";
  if (CAST_COMMANDS.has(low)) return "cast";
  // Ready: stance-aware base pose. Caller (setMotion) treats this
  // exactly like "walk"/"run" — fetch the cycle and play LoopRepeat.
  // It's the cycle ACE broadcasts on combat-mode toggle so the rig
  // can show the weapon-drawn / fists-up pose for the new stance.
  if (low === CMD_LOW_READY) return "idle";
  return null;
}

// Wave 3.E (2026-05-19) — typed widening of `classifyMotionCommand`.
//
// **Purpose.** When the renderer plays a swing (`setMotion(guid, cmd,
// stance)` with `cls === "attack" || "cast"`), it currently routes
// through `_tryPlayLink` which calls the wasm
// `fetchEntityAnimationKeyframes` to bake a clip. That path resolves the
// link anim correctly but doesn't expose the anim spec (id, low, high,
// fps) — which `setSwingPoseFromMotion` needs to drive a one-shot
// AnimationAction with precise timing (e.g. for the charge-attack
// hold-at-peak-frame case).
//
// **What this does.** Calls the wasm export
// `SessionHandle::lookupMotionLinkForSwing(mtId, stance, cmd)` to walk
// `MotionTable.links[outer]` and return the typed link-anim spec. The
// wasm side mirrors the C# oracle at
// `WorldBuilder.Terminal/CommandEngine.MotionParity.cs::MotionClassifySwing`
// per spec §3.2; the JS-side caller (renderer) consumes the typed
// `{ kind, height, anim, animId, lowFrame, highFrame, framerate,
//   durationSec, resolvedCommand }` to drive `setSwingPoseFromMotion`.
//
// **Fallback.** When no session handle is wired (e.g. unit tests,
// offline cache misses, pre-spawn), returns a synthetic object whose
// `kind` mirrors the coarse 1-arg `classifyMotionCommand(cmd)` result.
// Existing 1-arg callers are untouched (they use the coarse string).
// New callers prefer this typed function and inspect `.kind`.
//
// **Cross-port parity status.** `validate_motion_pose.cjs --js-vs-cs`
// drives this same wasm export from Node (via the pkg-nodejs target)
// and diffs against the C# oracle. As of Wave 3.E ship (2026-05-19),
// 52/52 of the C# PASS rows additionally PASS on the JS side (22
// resolved-swing match + 30 BowCombat both-missing). Spec target was
// ≥30 of 52.
function classifyMotionCommandTyped(motionTableId, stance, motionCmd) {
  const wasmReady =
    typeof window !== "undefined" &&
    window.__sessionHandle &&
    typeof window.__sessionHandle.lookupMotionLinkForSwing === "function";
  if (wasmReady && motionTableId && stance && motionCmd) {
    try {
      const linkAnim = window.__sessionHandle.lookupMotionLinkForSwing(
        motionTableId >>> 0,
        stance >>> 0,
        motionCmd >>> 0
      );
      if (linkAnim) {
        // Typed result — caller can use `.anim`, `.durationSec`,
        // etc. to drive the AnimationMixer precisely.
        return {
          kind: linkAnim.kind, // "swing" | "cast" | "unknown"
          height: linkAnim.height || null, // "High" | "Medium" | "Low" | null
          anim: linkAnim.anim,
          animId: linkAnim.animId,
          lowFrame: linkAnim.lowFrame,
          highFrame: linkAnim.highFrame,
          framerate: linkAnim.framerate,
          durationSec: linkAnim.durationSec,
          resolvedCommand: linkAnim.resolvedCommand,
          source: "wasm-link",
        };
      }
      // Wasm returned None — either no link for this (stance, cmd) or
      // the motion table isn't in the cache yet. Fall through to coarse.
    } catch (err) {
      // Wasm threw — log once, fall through. Don't spam (rare path).
      if (!classifyMotionCommandTyped._loggedErrorOnce) {
        classifyMotionCommandTyped._loggedErrorOnce = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[entities/W3E] lookupMotionLinkForSwing threw; falling back to coarse",
          err
        );
      }
    }
  }
  // Fallback path — wrap the coarse string in a typed envelope so
  // callers see a consistent shape. `.kind` carries the coarse
  // category; `.anim`-shaped fields are null.
  const coarse = classifyMotionCommand(motionCmd);
  return {
    kind: coarse, // "stop"|"walk"|"run"|"attack"|"cast"|"idle"|null
    height: null,
    anim: null,
    animId: null,
    lowFrame: null,
    highFrame: null,
    framerate: null,
    durationSec: null,
    resolvedCommand: motionCmd >>> 0,
    source: "coarse-fallback",
  };
}

// Wave 3.E export hook — staged for the swing-pose driver wire-up
// (setSwingPoseFromMotion adoption) and for plugin authors to call
// directly. Per `project_w3e_done_2026-05-19` memory: 52/52 JS-vs-C#
// parity on the wasm path. Exposed via window so callers don't need
// to import this module.
if (typeof window !== "undefined") {
  window.__classifyMotionCommandTyped = classifyMotionCommandTyped;
}

/**
 * Per-entity instance: one Object3D rig + one AnimationMixer.
 *
 * Owned by EntityManager.entityMap. Holds:
 *   - root: THREE.Group rooted at the entity's world position; named
 *     `entity_${guidHex}`.
 *   - parts: array of per-part Group children (length = setup.parts).
 *     Their `.position` / `.quaternion` are the channels animation
 *     clips drive.
 *   - mixer: THREE.AnimationMixer(root)
 *   - actions: Map<cacheKey, AnimationAction>. cacheKey is
 *     `AnimationCache.makeKey(setupId, mtableId, command, stance)`.
 *   - currentAction: the action currently playing (or null = rest).
 *   - currentActionKey: matching cacheKey, for crossfade lookup.
 *   - lastUseMs per actionKey for LRU eviction.
 *   - meta: original spawn meta (modelId, paletteId, etc.) so motion
 *     switches re-fetch with the same substitutions.
 */
class EntityInstance {
  constructor(guid, root, parts, mixer, meta) {
    this.guid = guid;
    this.root = root;
    this.parts = parts;
    this.mixer = mixer;
    this.actions = new Map();
    this.actionLastUsedMs = new Map();
    this.currentAction = null;
    this.currentActionKey = null;
    this.meta = meta;
    // Ownership of geometries + materials so dispose() can free them.
    // Materials are shared via materialCache; only geometries are
    // disposable per-entity.
    this.geometries = [];
    // Track which textures the entity owns (only when paletteSubs
    // were applied — fresh DataTextures, not shared with materialCache).
    this.ownedTextures = [];
    this.ownedMaterials = [];
    // Task E (2026-05-12) — AnimationMixer hook execution state.
    // The wasm `EntityAnimationData.takeHooks()` returns a
    // sorted-by-time list of `(time_in_clip_s, hook_type, hook_data)`
    // entries per resolved cycle (e.g. forge idle anim). We bake it on
    // first cache-miss for an action and re-bake on cache eviction.
    //
    // `hookTimelines`: cacheKey → Array<{time, hookType, soundWaveId,
    //   soundEnum, soundProbability, soundVolume, direction}>.
    //   Hooks beyond Sound (1) and SoundTable (2) are kept in the
    //   timeline so the per-frame executor can debug-log them, but
    //   only Sound/SoundTable land audio playback today (Task E
    //   scope — CreateParticle/SoundTweaked/etc. are follow-ons).
    // `actionLastHookTime`: actionKey → seconds-into-clip the
    //   per-tick executor last advanced past. Initialized to 0 on
    //   first play; reset to 0 when an action is .reset()'d. On wrap
    //   (currentTime < lastTime) the executor fires hooks in
    //   `[lastTime, clipDuration)` AND `[0, currentTime]`.
    /** @type {Map<string, Array<object>>} */
    this.hookTimelines = new Map();
    /** @type {Map<string, number>} */
    this.actionLastHookTime = new Map();
    // Cached SoundTable DID — read on spawn, used by every SoundTable
    // (hookType 2) hook fire. `0` when the entity has no SoundTable on
    // its weenie (most static placements + vanilla creatures). The
    // value is also propagated to `meta.soundTableDid` for spawn-meta
    // consumers, but kept in a flat field too so the executor doesn't
    // walk `this.meta` on every fire.
    this.soundTableDid = 0;
    // Bookkeeping for the diag-script's prewarm assertion. Counts how
    // many times `soundTableCache.get(soundTableDid)` was called from
    // this entity's spawn — should be exactly 1 for entities with a
    // non-zero SoundTable. Capture-script reads via inst._prewarmCount.
    this._prewarmCount = 0;
    // Airborne pose offset. Null when grounded; THREE.Quaternion when
    // airborne. Multiplied onto root.quaternion in setPose so the
    // jump tilt survives across position updates.
    this.airborneTilt = null;
  }

  registerGeometry(geom) {
    this.geometries.push(geom);
  }

  registerOwnedTexture(tex) {
    this.ownedTextures.push(tex);
  }

  registerOwnedMaterial(mat) {
    this.ownedMaterials.push(mat);
  }

  setPose(x, y, z, qw, qx, qy, qz) {
    this.root.position.set(x, y, z);
    this.root.quaternion.copy(acQuatToThree(qw, qx, qy, qz));
    // Re-apply airborne tilt offset if active. setAirborne(true)
    // stashes the tilt quaternion on the instance; this ensures
    // every position update preserves it instead of snapping the
    // entity back to upright mid-jump.
    if (this.airborneTilt) {
      this.root.quaternion.multiply(this.airborneTilt);
    }
  }

  /**
   * Promote `nextAction` to the currently-playing action with a
   * crossFade. `nextActionKey` is stamped so subsequent setMotion
   * calls can spot a no-op (same action already current).
   */
  crossFadeTo(nextAction, nextActionKey, durationS) {
    if (this.currentAction === nextAction) return;
    if (durationS <= 0) {
      // Cohere-B (2026-05-12): hard-cut path — retail had no blend
      // between motions. Stop the current action (drops it to weight 0
      // immediately) and start `nextAction` from wherever it was when
      // last stopped. Same shape as the catch-block fallback below,
      // but unconditional.
      //
      // Cohere-B follow-on (2026-05-12, "cycle-rewind"): deliberately
      // SKIP `nextAction.reset()`. three.js's `action.stop()`
      // preserves `.time`; `.reset()` zeroes it. The wasm integrator
      // currently overshoots the run target (Perf-B follow-on:
      // "25 m/s vs 4.5 m/s") and emits motion oscillation —
      // Walk → Stop → Walk → ... at sub-second cadence — even when
      // the player is holding W steady. Each transition hits this
      // hard-cut path; if we reset() the walk action's time on every
      // re-entry, the visible rig keeps rewinding to walk-cycle
      // frame 0, producing the "jutting back every 0.5-2 s" the user
      // reported. By preserving `.time`, a re-played action resumes
      // mid-cycle and the rig walks continuously across the
      // integrator's stutter. Brand-new actions have `.time = 0` by
      // construction so first-play is unaffected.
      if (this.currentAction) {
        try { this.currentAction.stop(); } catch (_) {}
      }
      nextAction.setEffectiveWeight(1.0);
      nextAction.setEffectiveTimeScale(1.0);
      nextAction.enabled = true;
      nextAction.play();
    } else if (this.currentAction) {
      // Live crossfade — fades current → new over `durationS`. Both
      // actions stay scheduled so the mixer interpolates between them
      // until the fade completes; then `currentAction` is .stop()'d
      // implicitly by its weight reaching 0. Retained for any future
      // caller that overrides the duration; current production path
      // uses `CROSSFADE_S = 0` and takes the hard-cut branch above.
      try {
        nextAction.reset();
        nextAction.setEffectiveWeight(1.0);
        nextAction.setEffectiveTimeScale(1.0);
        nextAction.enabled = true;
        nextAction.play();
        this.currentAction.crossFadeTo(nextAction, durationS, false);
      } catch (e) {
        // Fall back to a hard swap if crossFade hits an internal
        // assertion — usually means an action was uncached mid-flight.
        this.currentAction.stop();
        nextAction.reset();
        nextAction.play();
      }
    } else {
      // No action was playing — start fresh. Cohere-B follow-on:
      // skip `.reset()` for the same reason as the hard-cut path
      // above. Brand-new AnimationActions construct with `.time = 0`;
      // re-played actions resume from where they stopped, preventing
      // the walk-cycle rewind during integrator motion oscillation.
      if (durationS > 0) {
        nextAction.fadeIn(durationS);
      }
      nextAction.play();
    }
    this.currentAction = nextAction;
    this.currentActionKey = nextActionKey;
  }

  /**
   * Stop the current action with a fade-out. Sets `currentAction =
   * null`. Used on STOP commands and on respawn to reset to rest pose.
   */
  fadeOutCurrent(durationS) {
    if (!this.currentAction) return;
    if (durationS <= 0) {
      // Cohere-B (2026-05-12): hard-cut stop. Retail STOP commands
      // ended the current motion's cycle and held the rig at the
      // next-applicable default pose immediately. The PhatSDK
      // equivalent is to call `advance_to_next_animation()` to the
      // default (no fade-out state).
      try { this.currentAction.stop(); } catch (_) {}
    } else {
      try {
        this.currentAction.fadeOut(durationS);
        // Don't .stop() yet — fadeOut needs the mixer to keep the
        // action scheduled until weight hits 0. The mixer's tick will
        // implicitly stop it. Future reset() in crossFadeTo will reuse
        // the action.
      } catch (e) {
        try {
          this.currentAction.stop();
        } catch (_) {}
      }
    }
    this.currentAction = null;
    this.currentActionKey = null;
  }

  /**
   * Evict the least-recently-used cached action to keep the per-entity
   * action count under `MAX_ACTIONS_PER_SETUP`. Never evicts the
   * `currentActionKey` (mixer assertion would fire).
   */
  evictOldestUnused() {
    if (this.actions.size < MAX_ACTIONS_PER_SETUP) return;
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [key, ts] of this.actionLastUsedMs) {
      if (key === this.currentActionKey) continue;
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    const action = this.actions.get(oldestKey);
    if (action) {
      try {
        action.stop();
        this.mixer.uncacheAction(action.getClip(), this.root);
      } catch (_) {}
    }
    this.actions.delete(oldestKey);
    this.actionLastUsedMs.delete(oldestKey);
    // Task E (2026-05-12): drop the evicted action's hook timeline +
    // last-fire state. If the same (cmd, stance) is re-fetched later,
    // setMotion's cache-miss path will repopulate from the AnimationCache.
    this.hookTimelines.delete(oldestKey);
    this.actionLastHookTime.delete(oldestKey);
  }

  dispose() {
    try {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.root);
    } catch (_) {}
    // Perf B3 (2026-05-18) — walk the rig BEFORE detaching from the
    // scene graph so traverse() still has the part-Mesh subtree
    // attached. The helper disposes per-Mesh geometry + materials only
    // when tagged `userData.__disposable = true`. FU3 (2026-05-18)
    // closes the geometry gate too — see the `__disposable` convention
    // block in the module docstring. `inst.ownedMaterials` loop below
    // remains as a safety net (three.js `.dispose()` is idempotent so a
    // second pass is a no-op).
    _disposeMeshChildren(this.root);
    if (this.root.parent) this.root.parent.remove(this.root);
    // FU3 (2026-05-18) — `inst.geometries` holds the AnimationCache's
    // SHARED BufferGeometry refs (registerGeometry at the spawn site
    // pushes the cache's `g.geometry` directly). Disposing them here
    // would crash the next render of any surviving entity with the
    // same setupId. The traverse above already disposes any
    // entity-OWNED geometries that carry the `__disposable` tag (e.g.
    // the selection-ring TorusGeometry); the cache geometries stay
    // alive as long as the cache holds them.
    for (const g of this.geometries) {
      if (g?.userData?.__disposable !== true) continue;
      try {
        g.dispose();
      } catch (_) {}
    }
    for (const t of this.ownedTextures) {
      try {
        t.dispose();
      } catch (_) {}
    }
    for (const m of this.ownedMaterials) {
      try {
        m.dispose();
      } catch (_) {}
    }
    this.actions.clear();
    this.actionLastUsedMs.clear();
    // Task E (2026-05-12): drop hook timeline state alongside the
    // mixer + actions.
    this.hookTimelines.clear();
    this.actionLastHookTime.clear();
    this.currentAction = null;
    this.currentActionKey = null;
  }
}

/**
 * Entity manager: drives the per-entity rigs from the wasm
 * `pollEntityUpdates` stream.
 *
 * Created once per init3D and stored on
 * `liveScene3d.entityManager`. The render loop in `loop.js` calls
 * `tick(dt)` each rAF and `drainEntityEvents3D` consumes events into
 * spawn / setPose / setMotion / remove.
 */
export class EntityManager {
  constructor(scene3d, wasmExports) {
    this.scene3d = scene3d;
    this.wasmExports = wasmExports;
    // Wave 7.5 (2026-05-24) — opt-in applyAppearance hot-swap. When
    // `?clothingHotSwap=1` URL flag is set, applyAppearance attempts
    // to swap the entity's part-mesh contents in place (preserving
    // root + mixer + currently-playing action) instead of falling
    // through to W7.3's despawn+respawn. Falls back to despawn+
    // respawn when topology mismatch is detected OR when the hot-
    // swap path throws. Default off — needs manual A/B validation
    // under combat motion to prove visual parity.
    this._hotSwapAppearance = false;
    try {
      if (typeof window !== "undefined" && window.location) {
        const flag = new URLSearchParams(window.location.search).get("clothingHotSwap");
        this._hotSwapAppearance = (flag === "1");
      }
    } catch (_) {}
    /** @type {Map<number, EntityInstance>} */
    this.entityMap = new Map();
    /** @type {AnimationCache} */
    this.animationCache = new AnimationCache();
    this.materialCache = scene3d?.materialCache ?? null;
    /** @type {Map<number, Promise<EntityInstance|null>>} */
    this.spawnInFlight = new Map();
    // Diagnostics for capture scripts.
    this.spawnCount = 0;
    this.removeCount = 0;
    this.motionSwitchCount = 0;
    this.lastError = null;
    // H2 (2026-05-12): per-entity particle emitter bookkeeping. Each
    // entry tracks `(guid → [emitterId, …])` so removal can stop the
    // emitter(s) that belong to a despawning entity. The
    // `_worldParticleManager` is the world-side counterpart to
    // sky_dome's particle manager — it's lazily created on first
    // chain walk in `_attachParticleChainForEntity` once we have
    // both wasmExports + a materialCache. `_particleChainsAttached`
    // dedups per-guid attach attempts (idempotent against
    // re-Spawn / META_REFRESH flows).
    /** @type {Map<number, number[]>} */
    this._particleEmittersForGuid = new Map();
    /** H3-E1: pending sound-hook setTimeout IDs per entity GUID, so
     * the timers can be canceled when the entity despawns. */
    /** @type {Map<number, number[]>} */
    this._soundTimeoutsForGuid = new Map();
    /** @type {Set<number>} */
    this._particleChainsAttached = new Set();
    // F.D-fu3 (2026-05-20): per-guid promise that resolves when the
    // H2 chain walker has fully landed (including all `addEmitter`
    // awaits + setTimeout schedules for Sound hooks). Distinct from
    // `_particleChainsAttached` which fires synchronously at spawn-
    // dispatch time; this Map's promise resolves at the END of the
    // chain walk so validators can `await` the actual resolution
    // instead of guessing a settle time. Cleared on `remove(guid)`.
    /** @type {Map<number, Promise<{ok: boolean, emitterCount: number, soundHookCount: number, reason?: string}>>} */
    this._particleChainResolveForGuid = new Map();
    this._worldParticleManager = null;
    // B4 (2026-05-18): name → Set<guid> index so `findGuidByName` is
    // O(1) instead of an O(N) entityMap scan. Names aren't unique
    // (multiple "Drudge") so the value is a Set; callers that want
    // "first match" read `[...set][0]`. Maintained on spawn / remove
    // (the only two name-touching paths in this file — `inst.meta` is
    // set once at construction and never reassigned, so no rename
    // path exists in entities.js; re-spawn goes through remove() →
    // _spawnImpl() which naturally re-indexes).
    /** @type {Map<string, Set<number>>} */
    this._nameToGuid = new Map();
  }

  /**
   * Build the rig for a never-seen entity. Idempotent — re-spawn
   * with the same GUID first removes the existing instance.
   *
   * `meta` shape (mirrors `metaFromSpawn` at `index.html:3383` plus
   * the wire-position fields the 3D path needs):
   *   {
   *     guid, modelId / setupId,
   *     x, y, z, qw, qx, qy, qz,
   *     landblockId,
   *     modelChanges:   Uint32Array | null,
   *     textureChanges: Uint32Array | null,
   *     subPalettes:    Uint32Array | null,
   *     paletteId, mtableId,
   *     motionCommand: u32 — initial motion (typically 0 = idle),
   *     motionStance:  u32 — initial stance (0 = MotionTable.default).
   *   }
   *
   * The `setupId` field is the same value the 2D path calls `modelId`;
   * either name is accepted. (Phase 7.0–7.3 used both interchangeably
   * for buildings/statics; Phase 7.4 unifies on `modelId`.)
   */
  async spawn(meta) {
    if (!meta) return null;
    const guid = (meta.guid >>> 0) || 0;
    if (!guid) return null;
    if (this.spawnInFlight.has(guid)) {
      return this.spawnInFlight.get(guid);
    }
    if (this.entityMap.has(guid)) {
      // Re-spawn → tear down then rebuild. Mirrors
      // `ensureEntitySprite`'s `entry.modelId === 0` upgrade path.
      this.remove(guid);
    }
    // Diagnostic hook (always-on; cheap when __diag not installed). Fires
    // BEFORE any async work so the "spawn attempt observed" signal is
    // captured even if _spawnImpl never returns. See scene3d/diag.js.
    if (typeof window !== "undefined" && window.__diag?.onSpawnAttempted) {
      try {
        let isLocalPlayer = false;
        if (typeof window.getLocalPlayerGuid === "function") {
          const lpg = window.getLocalPlayerGuid();
          if (lpg !== null && lpg !== undefined && (lpg >>> 0) === guid) {
            isLocalPlayer = true;
          }
        }
        window.__diag.onSpawnAttempted({ ...meta, guid, isLocalPlayer });
      } catch (_) { /* diag must never break spawn */ }
    }
    const promise = this._spawnImpl(meta).catch((e) => {
      this.lastError = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn(`[phase7.4b] spawn(0x${guid.toString(16)}) failed:`, e);
      if (typeof window !== "undefined" && window.__diag?.onSpawnFailed) {
        try { window.__diag.onSpawnFailed(meta, e); } catch (_) {}
      }
      return null;
    });
    this.spawnInFlight.set(guid, promise);
    try {
      const inst = await promise;
      if (inst) this.spawnCount += 1;
      return inst;
    } finally {
      this.spawnInFlight.delete(guid);
    }
  }

  async _spawnImpl(meta) {
    const guid = meta.guid >>> 0;
    let setupId = (meta.modelId ?? meta.setupId ?? 0) >>> 0;
    if (!setupId) {
      // No real setup yet (PrivateUpdatePosition before ObjectCreate).
      // Skip — the next ObjectCreate will retry with a real setup_id.
      return null;
    }

    // Wave 7.4 (2026-05-24): spawn-time entity LOD. If the camera is
    // positioned + the setup has a GfxObjDegradeInfo chain + the
    // entity's distance lands in one of the chain's bands, substitute
    // setupId for the band's gfx_obj_id (0x01 prefix) BEFORE the
    // animationCache.get call so the rig builder bakes the LOD-N
    // mesh. fetch_entity_animation_keyframes already branches on
    // `setup_id >> 24 != 0x02` and takes the GfxObj direct path
    // (lib.rs:10840 region), so substituting a 0x01 prefix here is
    // safe + matches the statics LOD path. Distance frozen at spawn —
    // entities crossing the band threshold mid-game won't switch
    // (handoff-degrade-info-entity-lod-2026-05-24.md § shape-a).
    // Returns 0 when no chain / no band matches / no camera; on 0
    // we fall through to the original full-detail setup. The wasm
    // helper is fire-and-forget at the worst — failure to substitute
    // never breaks spawn, only foregoes the LOD optimization.
    const lodFetch = this.wasmExports?.fetch_entity_degrade_for_distance;
    if (typeof lodFetch === "function") {
      try {
        const cameraPos = window.liveScene3d?.camera?.position;
        if (cameraPos) {
          const lbId = (meta.landblockId ?? 0) >>> 0;
          const lbX = (lbId >>> 24) & 0xff;
          const lbY = (lbId >>> 16) & 0xff;
          const wx = lbX * 192 + (meta.x ?? 0);
          const wy = lbY * 192 + (meta.y ?? 0);
          const dx = cameraPos.x - wx;
          const dy = cameraPos.y - wy;
          const distance = Math.hypot(dx, dy);
          if (distance > 0) {
            const substitute = (await lodFetch(setupId, distance)) >>> 0;
            try {
              window.__diag?.lod?.onSpawnAttempt?.({
                guid,
                setupId,
                distance,
                substituted: substitute !== 0,
              });
            } catch (_) {}
            if (substitute !== 0) {
              try {
                window.__diag?.lod?.onSpawnSubstitution?.({
                  guid,
                  originalSetupId: setupId,
                  substituteSetupId: substitute,
                  distance,
                });
              } catch (_) {}
              setupId = substitute;
            }
          }
        }
      } catch (_) { /* spawn-time LOD must never break spawn */ }
    }

    const mtableId = (meta.mtableId ?? 0) >>> 0;
    const initialMotion = (meta.motionCommand ?? 0) >>> 0;
    const initialStance = (meta.motionStance ?? 0) >>> 0;
    const modelChanges = meta.modelChanges ?? new Uint32Array(0);
    const textureChanges = meta.textureChanges ?? new Uint32Array(0);
    const paletteId = (meta.paletteId ?? 0) >>> 0;
    const subPalettes = meta.subPalettes ?? new Uint32Array(0);

    // Step A: kick the keyframe + rest-pose-mesh fetch via the cache.
    // Cache key folds in motion + stance so the very first action a
    // freshly-spawned entity plays is the one the wire commanded
    // (most spawns arrive idle → key resolves to default-stance idle,
    // which the wasm side returns as 0-frame "rest pose only").
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") {
      // No animation export — skip this entity. The 2D fallback for
      // statically-placed objects is the building/statics path
      // (Phase 7.2), which doesn't go through EntityManager.
      throw new Error(
        "EntityManager: wasmExports.fetchEntityAnimationKeyframes missing"
      );
    }
    const animEntry = await this.animationCache.get(
      setupId,
      mtableId,
      initialMotion,
      initialStance,
      fetchKeyframes,
      {
        modelChanges,
        textureChanges,
        paletteId,
        paletteSubsFlat: subPalettes,
      }
    );
    // 2026-05-16 — `AnimationCache.get()` now returns `partGroups`
    // pre-converted to `{ groups: [{geometry, surfaceDid}], surfaceDids }`
    // and frees its wasm partMesh handles inside the cache. Multiple
    // spawns of the same setupId all see the SAME BufferGeometry refs
    // (THREE.Mesh tolerates shared geometry — N meshes with the same
    // geometry render correctly, each with its own transform/material).
    // Pre-2026-05-16 this loop did the conversion + free per spawn,
    // which caused the second-and-later spawns of any shared setupId
    // to render bodyless: the cached `partMeshes` array was shared, the
    // first spawn freed each handle, the next spawn's
    // meshToGeometryGroups got null-ptr wrappers + returned empty.
    // Back-compat: older animation.js builds (or wasm bundles) without
    // `partGroups` fall back to the legacy per-spawn convert+free path
    // for the SINGLE spawn of that key — the second-spawn race still
    // happens against an old cache, but doesn't crash.
    const partCount = animEntry.partCount;
    const initialClip = animEntry.clip;
    const resolvedStance = animEntry.resolvedStance >>> 0;
    const restOrigins = animEntry.restOrigins ?? new Float32Array(0);
    const restOrientations = animEntry.restOrientations ?? new Float32Array(0);
    const hasRestPose =
      restOrigins.length === partCount * 3 &&
      restOrientations.length === partCount * 4;

    // Step B: build the rig. Root holds the entity's world transform;
    // per-part children hold the rig-local transforms the AnimationClip
    // drives.
    const root = new THREE.Group();
    root.name = `entity_${guid.toString(16).padStart(8, "0")}`;
    // Validator-side identity. Mirrors the userData convention used
    // by scene3d/statics.js (modelId, landblockId on the InstancedMesh
    // node) and scene3d/buildings.js (modelId on the placementGroup)
    // so validate_landblock_completeness.cjs's walker can attribute
    // each entity to its expected manifest entry. Entities are matched
    // on wcid (weenie class id), not setupDid, so wcid goes into the
    // generic `modelId` field the walker reads. Without this block the
    // matcher reported `entities: matched=0` (every rendered entity
    // classified as "no modelId resolved" → invented).
    root.userData = {
      modelId: (meta?.wcid >>> 0) || 0,
      landblockId: (meta?.landblockId >>> 0) || 0,
      name: meta?.name ?? null,
    };
    const parts = [];

    // Resolve materials — first preload all unique surface DIDs across
    // all parts in one wasm round-trip, then synchronously paint via
    // getCached.
    const allSurfaceDids = new Set();
    let partGroups;
    if (Array.isArray(animEntry.partGroups)) {
      partGroups = animEntry.partGroups;
      for (const conv of partGroups) {
        if (!conv) continue;
        for (const did of conv.surfaceDids) allSurfaceDids.add(did >>> 0);
      }
    } else {
      // Legacy fallback — convert per-spawn + free.
      const partMeshes = animEntry.partMeshes ?? [];
      partGroups = [];
      for (let p = 0; p < partCount; p += 1) {
        const partMesh = partMeshes[p];
        if (!partMesh) { partGroups.push({ groups: [], surfaceDids: [] }); continue; }
        const conv = meshToGeometryGroups(partMesh);
        partGroups.push(conv);
        for (const did of conv.surfaceDids) allSurfaceDids.add(did >>> 0);
        if (typeof partMesh.free === "function") { try { partMesh.free(); } catch (_) {} }
      }
    }

    const inst = new EntityInstance(guid, root, parts, null, meta);

    // Material resolution. Two paths:
    //   1. Plain (no palette substitutions) — share the scene
    //      MaterialCache so two NPCs with the same setup share
    //      MeshStandardMaterial instances.
    //   2. paletteId or subPalettes set — fetch via
    //      fetchEntitySurfacesPixels which applies the palette
    //      substitutions. These textures are entity-owned (the same
    //      surface DID for a different entity will resolve to a
    //      different recoloured texture) and live on the entity until
    //      dispose.
    const hasPaletteSubs =
      paletteId !== 0 ||
      (subPalettes && subPalettes.length > 0);
    if (hasPaletteSubs && typeof this.wasmExports?.fetchEntitySurfacesPixels === "function") {
      try {
        const dids = new Uint32Array([...allSurfaceDids]);
        if (dids.length > 0) {
          // Wave 7.7 — dye observability. Fires for every spawn that
          // arrives with non-trivial palette overlays (W7.3 server-
          // pushed dyes + any local applyAppearance preview). Captures
          // the (guid, surfaceDids, paletteId, subPalettes) triple so
          // the diag harness can audit which entities ARE actually
          // paying the dye compositor cost vs spawning with empty
          // overlays. Fires BEFORE the wasm call so we observe even
          // when the call throws.
          try {
            window.__diag?.clothing?.onDyeApplication?.({
              guid,
              source: "spawn",
              surfaceDidCount: dids.length,
              paletteId,
              subPaletteTripleCount: (subPalettes.length / 3) | 0,
            });
          } catch (_) {}
          const results = await this.wasmExports.fetchEntitySurfacesPixels(
            dids,
            paletteId,
            subPalettes
          );
          // Build entity-owned materials keyed by DID, parallel to
          // dids[]. We DON'T install into materialCache (it's keyed
          // by surface DID alone, which would collide with non-
          // recoloured uses).
          const entityMaterials = new Map();
          for (let i = 0; i < dids.length; i += 1) {
            const did = dids[i] >>> 0;
            const sp = results[i];
            if (!sp || sp.width === 0 || sp.height === 0) {
              // Empty — fall back to scene-cache fallback. The cache
              // returns the shared fallbackMaterial in that case.
              entityMaterials.set(
                did,
                this.materialCache?.fallbackMaterial ??
                  this._fallbackMaterial()
              );
              if (sp && typeof sp.free === "function") sp.free();
              continue;
            }
            const tex = surfacePixelsToTexture(sp.pixels, sp.width, sp.height);
            if (typeof sp.free === "function") sp.free();
            let mat;
            if (WIREFRAME_MODE) {
              // 2026-05-22 — route through the shared MaterialCache so
              // the per-DID dominant-colour manifest applies AND the
              // material gets registered in `wireMatToFill`, which is
              // what `addFillCompanions` walks to attach the solid-fill
              // twin. Per-entity palette substitutions are irrelevant
              // here: in wire mode the colour comes from either the
              // manifest's dominant RGB or the 32-bucket HSL hash —
              // neither uses palette. Sharing materials across all
              // entities that touch the same surface DID is therefore
              // safe and gives fill coverage for the local player
              // (whose palette-driven branch previously minted unique
              // materials that bypassed the cache → bypassed the fill
              // companion walk → wire-only rig in screenshots).
              try { tex.dispose && tex.dispose(); } catch (_) {}
              mat = this.materialCache?._wireframeMaterialFor?.(did)
                ?? this._fallbackMaterial?.()
                ?? this.materialCache?.fallbackMaterial;
              if (!mat) {
                const hue = ((did >>> 0) % 32) / 32;
                mat = new THREE.MeshBasicMaterial({
                  color: new THREE.Color().setHSL(hue, 0.6, 0.65),
                  wireframe: true,
                  side: THREE.DoubleSide,
                  fog: true,
                });
                mat.userData = { __disposable: true };
                inst.registerOwnedMaterial(mat);
              }
              // Cache-owned materials don't get a per-entity name or
              // __disposable flag — MaterialCache owns their lifetime.
              entityMaterials.set(did, mat);
            } else {
              mat = new THREE.MeshStandardMaterial({
                map: tex,
                roughness: 0.9,
                metalness: 0.0,
                side: THREE.DoubleSide,
                transparent: false,
              });
              mat.name = `entity-${guid.toString(16)}-surface-${did.toString(16)}`;
              // Perf B3 (2026-05-18) — entity-owned recoloured surface
              // material. NOT shared with MaterialCache (keyed by
              // (entity, did) instead of just did). Free at entity
              // dispose; tag so `_disposeMaterialIfOwned` lets it
              // through.
              mat.userData = { ...(mat.userData || {}), __disposable: true };
              inst.registerOwnedTexture(tex);
              inst.registerOwnedMaterial(mat);
              entityMaterials.set(did, mat);
            }
          }
          inst._entityMaterials = entityMaterials;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[phase7.4b] fetchEntitySurfacesPixels failed for entity ${guid.toString(16)}:`,
          e
        );
        try { window.__diag?.assets?.onMaterialError?.({ guid, dids: allSurfaceDids, error: e, source: "surface" }); } catch (_) {}
      }
    } else if (allSurfaceDids.size > 0 && this.materialCache) {
      // Cache hit / miss flows through the shared cache. Preload via
      // the bulk path so all DIDs land in one wasm round-trip.
      try {
        await this.materialCache.preload(
          [...allSurfaceDids],
          this.wasmExports.fetch_surfaces_pixels
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[phase7.4b] materialCache.preload failed for entity ${guid.toString(16)}:`,
          e
        );
        try { window.__diag?.assets?.onMaterialError?.({ guid, dids: allSurfaceDids, error: e, source: "surface" }); } catch (_) {}
      }
    }

    // Build per-part Groups + per-surface Mesh leaves.
    for (let p = 0; p < partCount; p += 1) {
      const partGroup = new THREE.Group();
      partGroup.name = `part_${p}`;
      // Cohere-B (2026-05-12): apply the resolved rest-pose frame to
      // the partGroup. partMeshes ship part-LOCAL (no placement baked
      // in); the rest frame composes against the entity root the same
      // way PhatSDK's `CPartArray::UpdateParts` composes
      // `entity_world.combine(anim_frame[i])`. During cycle playback
      // the AnimationMixer overrides these values frame-by-frame with
      // the model-space cycle keyframes. With hasRestPose=false (old
      // wasm bundle without the getters), partGroup stays at identity
      // — matches pre-fix behaviour.
      if (hasRestPose) {
        partGroup.position.set(
          restOrigins[p * 3 + 0],
          restOrigins[p * 3 + 1],
          restOrigins[p * 3 + 2]
        );
        // AC wire order is (qw, qx, qy, qz); three.js wants
        // (qx, qy, qz, qw). Reorder at apply.
        const qw = restOrientations[p * 4 + 0];
        const qx = restOrientations[p * 4 + 1];
        const qy = restOrientations[p * 4 + 2];
        const qz = restOrientations[p * 4 + 3];
        partGroup.quaternion.set(qx, qy, qz, qw);
      }
      const conv = partGroups[p];
      for (const g of conv.groups) {
        const did = g.surfaceDid >>> 0;
        let mat = null;
        if (inst._entityMaterials && inst._entityMaterials.has(did)) {
          mat = inst._entityMaterials.get(did);
        } else if (this.materialCache) {
          mat = this.materialCache.getCached(did);
        } else {
          mat = this._fallbackMaterial();
        }
        const m = new THREE.Mesh(g.geometry, mat);
        m.name = `part_${p}_surface_${did.toString(16)}`;
        m.userData = { guid, partIndex: p, surfaceDid: did };
        // Visual-fidelity Phase 0.1 — entities cast shadows (NPCs +
        // local player rig). receiveShadow is false because the
        // entity rig is animated per-frame; receiving shadows on a
        // moving rig adds shimmer that's distracting without buying
        // much (entities are mostly self-shadowing internally).
        // Translucent / additive surfaces (ghosts, ethereal effects)
        // are skipped via the material-flag check.
        // Phase 3.3 — CSM path enables casting on the same meshes.
        if (this.scene3d?.shadowsEnabled || this.scene3d?.csmEnabled) {
          m.castShadow = materialCanCastShadow(mat);
        }
        partGroup.add(m);
        inst.registerGeometry(g.geometry);
      }
      parts.push(partGroup);
      root.add(partGroup);
    }

    // Step C: world-frame transform. Wire format gives us
    // (landblockId, x, y, z) where (x, y) are LB-local metres. Convert
    // to world coords the same way the 2D path does
    // (`landblockToWorldXY` at index.html:2777).
    const lbId = (meta.landblockId ?? 0) >>> 0;
    const lbX = (lbId >>> 24) & 0xff;
    const lbY = (lbId >>> 16) & 0xff;
    const wx = lbX * 192.0 + (meta.x ?? 0);
    const wy = lbY * 192.0 + (meta.y ?? 0);
    const wz = meta.z ?? 0;
    inst.setPose(wx, wy, wz, meta.qw ?? 1, meta.qx ?? 0, meta.qy ?? 0, meta.qz ?? 0);
    if (meta.objScale && meta.objScale > 0 && meta.objScale !== 1) {
      root.scale.setScalar(meta.objScale);
    }

    // Step D: AnimationMixer + initial action.
    const mixer = new THREE.AnimationMixer(root);
    inst.mixer = mixer;
    // Task E (2026-05-12): cache the entity's SoundTable DID on the
    // instance. The wire field is `EntityUpdate.soundTableDid` (backed
    // by `ObjectDescription.stable_id` = `PropertyDataId::SoundTable`
    // (3)). Used by the per-frame hook executor when a SoundTable
    // (hookType 2) hook fires; the executor resolves the carried
    // Sound enum via `soundTableCache.resolveSound(inst.soundTableDid,
    // soundEnum)`. `0` means "entity has no SoundTable" — SoundTable
    // hooks fired on such an entity silently no-op (not an error;
    // many static placements have animation hooks but no SoundTable).
    inst.soundTableDid = (meta.soundTableDid ?? 0) >>> 0;
    if (initialClip) {
      const cacheKey = AnimationCache.makeKey(
        setupId,
        mtableId,
        initialMotion,
        resolvedStance || initialStance
      );
      const action = mixer.clipAction(initialClip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.enabled = true;
      inst.actions.set(cacheKey, action);
      inst.actionLastUsedMs.set(cacheKey, performance.now());
      // Task E (2026-05-12): stash the cycle's hook timeline alongside
      // the action. The animation cache already snapshotted hooks to
      // plain POJOs and `animEntry.hooks` is sorted-by-time-asc.
      // Reused across mixers (multiple entities sharing this clip see
      // the same timeline array — safe, the executor's state lives
      // per-entity in `actionLastHookTime`).
      if (Array.isArray(animEntry.hooks) && animEntry.hooks.length > 0) {
        inst.hookTimelines.set(cacheKey, animEntry.hooks);
        inst.actionLastHookTime.set(cacheKey, 0);
      }
      // Only auto-play if the spawned motion is a locomotion command.
      // Spawning an entity in idle (motion=0) leaves the rig at rest
      // pose; the first kind=5 walk/run will start the clip.
      const cls = classifyMotionCommand(initialMotion);
      if (cls === "walk" || cls === "run") {
        action.play();
        inst.currentAction = action;
        inst.currentActionKey = cacheKey;
      }
    }

    // Step E: parent under entitiesGroup + register.
    if (this.scene3d?.entitiesGroup) {
      this.scene3d.entitiesGroup.add(root);
    }
    // 2026-05-22 — wire-agent: walk THIS entity's subtree and add solid-
    // fill companion meshes for every wire-bucket-materialed
    // Mesh/InstancedMesh, so NPCs/monsters/players render with the
    // per-bucket HSL fill colour visible between the wire lines instead
    // of empty transparency. Scoped to the entity's `root` (not the
    // entire entitiesGroup) so the walk is O(per-entity verts) on each
    // spawn instead of O(all-entity verts).
    if (
      this.scene3d?.wireframeMode &&
      this.scene3d.materialCache &&
      typeof this.scene3d.materialCache.addFillCompanions === "function"
    ) {
      this.scene3d.materialCache.addFillCompanions(root);
    }
    // Phase 5 PView render-order fix (2026-05-25): entities live on layer 1
    // (RENDER_LAYER_INDOOR) alongside EnvCells so the depth-clear split in
    // atmosphere_pipeline.js draws cells + entities AFTER terrain when the
    // camera is inside a cottage. Three.js layer masks are per-object so we
    // walk the entity subtree after every child (model + nameplate + wire-
    // companion fills) is attached to ensure no node sits on layer 0.
    if (this.scene3d?.entitiesGroup) {
      root.traverse((o) => o.layers.set(1));
    }
    this.entityMap.set(guid, inst);
    // Diagnostic hook (always-on; cheap when __diag not installed). Fires
    // AFTER the entity is committed to the live scene graph so observed
    // position is the final post-bake value, not the spawn-time meta.
    if (typeof window !== "undefined" && window.__diag?.onSpawnSucceeded) {
      try { window.__diag.onSpawnSucceeded(guid, inst); } catch (_) {}
    }
    // B4 (2026-05-18): index `name → Set<guid>` for O(1) lookup in
    // `findGuidByName`. Only adds when the entity carries a non-empty
    // string name (matches the nameplate-attach guard just below).
    if (
      inst.meta &&
      typeof inst.meta.name === "string" &&
      inst.meta.name.length > 0
    ) {
      const nm = inst.meta.name;
      let bucket = this._nameToGuid.get(nm);
      if (!bucket) {
        bucket = new Set();
        this._nameToGuid.set(nm, bucket);
      }
      bucket.add(guid);
    }

    // Task E (2026-05-12): prewarm the SoundTableCache for this entity.
    // The first cache.get() per DID kicks the wasm fetchSoundTable; we
    // do it now (spawn time, off the rAF tick) so that when a
    // SoundTable hook fires, `cache.resolveSound(...)` is already a
    // synchronous-in-practice (await on a settled Promise) operation.
    // Fire-and-forget — failures here are logged inside the cache
    // implementation; the per-hook executor falls through silently when
    // resolveSound returns null.
    //
    // Pattern choice rationale: the alternative is fire-and-forget per
    // hook with no prewarm. That makes first-hit per entity stutter
    // (wasm fetch + parse on a tick boundary) while subsequent hooks
    // are immediate. Prewarming amortizes the fetch onto the spawn
    // path where the entity is already async, and from-then-on every
    // hook fires through a warm cache. Spawn-time prewarm is the
    // documented choice in `docs/ambient-sounds-chain-2026-05-12.md`
    // task-E section "Pick prewarm-on-spawn."
    const stbDid = inst.soundTableDid;
    if (stbDid !== 0 && this.scene3d?.soundTableCache) {
      inst._prewarmCount += 1;
      this.scene3d.soundTableCache.get(stbDid).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/task-E] prewarm SoundTable 0x${stbDid.toString(16)} ` +
          `for entity 0x${guid.toString(16)} failed:`,
          e
        );
      });
    }

    // Step E.5 — H2 (2026-05-12): if the entity carries a PhysicsScript
    // DID, walk the CreateParticleHook chain and attach emitters
    // anchored on the entity's rig. Fire-and-forget — particle attach
    // doesn't block the spawn return; the manager's `tick()` picks up
    // emitters as they resolve. Reuses the Sky-J P4 ParticleManager
    // runtime + Sky-J P3 wasm exports.
    const pesId = (meta.physicsScriptDid >>> 0);
    if (
      pesId !== 0 &&
      !this._particleChainsAttached.has(guid) &&
      this.wasmExports &&
      typeof this.wasmExports.fetchPhysicsScript === "function" &&
      typeof this.wasmExports.fetchParticleEmitter === "function" &&
      typeof this.wasmExports.fetchBuildingPlacement === "function"
    ) {
      this._particleChainsAttached.add(guid);
      // F.D-fu3 (2026-05-20): record the resolve promise so validators
      // (and any caller via `awaitParticleChainResolution(guid)`) can
      // wait for the H2 chain to actually finish landing emitters +
      // scheduling Sound hooks before snapshotting state. The promise
      // resolves to a small descriptor regardless of success/failure
      // so the caller can branch on `result.ok` instead of catching.
      const resolvePromise = this._attachParticleChainForEntity(guid, root, pesId)
        .then((descriptor) => descriptor ?? { ok: true, emitterCount: 0, soundHookCount: 0 })
        .catch((e) => {
          this._particleChainsAttached.delete(guid);
          // eslint-disable-next-line no-console
          console.warn(
            `[entities/H2] particle chain walk for 0x${guid.toString(16)} (pes=0x${pesId.toString(16)}) threw:`,
            e
          );
          return {
            ok: false,
            emitterCount: 0,
            soundHookCount: 0,
            reason: String(e?.message ?? e),
          };
        });
      this._particleChainResolveForGuid.set(guid, resolvePromise);
    }
    // Follow-on #10 (3D port state doc) — DOM nameplate overlay. Skip
    // the local player (matches the 2D path's `ensureNameplate` skip at
    // index.html:3467 — your own head doesn't need a tag above it). The
    // local player check goes through `window.getLocalPlayerGuid` like
    // the 2D path does; pre-spawn the function returns null/undefined,
    // matching the 2D ensureNameplate skip on guid mismatch.
    if (
      this.scene3d?.nameplateLayer &&
      meta &&
      typeof meta.name === "string" &&
      meta.name.length > 0
    ) {
      let isLocalPlayer = false;
      // eslint-disable-next-line no-undef
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        try {
          const lpg = window.getLocalPlayerGuid();
          if (lpg !== null && lpg !== undefined) {
            isLocalPlayer = (lpg >>> 0) === guid;
          }
        } catch (_) {}
      }
      if (!isLocalPlayer) {
        try {
          this.scene3d.nameplateLayer.setNameplate(guid, meta.name, root);
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._nameplateWarned) {
            this._nameplateWarned = true;
            console.warn("[follow-on#10] setNameplate threw:", e);
          }
        }
      }
    }
    // Task #13 (2026-05-13) — in-world THREE.Sprite nameplate, parented
    // to the entity's root Group so it auto-follows the rig via the
    // standard matrixWorld walk. Coexists with the DOM overlay above
    // (the DOM path is the fallback / capture-script-friendly overlay;
    // the sprite path is the visible-in-3D layer that depth-tests
    // against world geometry). The sprite module handles its own
    // local-player + inventory-item skip + category-coloured text bake,
    // so callers here pass through without further filtering.
    try {
      ensureNameplateForEntity(inst, this.scene3d);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!this._nameplateSpriteWarned) {
        this._nameplateSpriteWarned = true;
        console.warn("[task-13] ensureNameplateForEntity threw:", e);
      }
    }
    return inst;
  }

  _fallbackMaterial() {
    if (this.materialCache?.fallbackMaterial) {
      return this.materialCache.fallbackMaterial;
    }
    // Standalone / test mode — synthesize a one-off fallback.
    if (!this._sharedFallback) {
      this._sharedFallback = WIREFRAME_MODE
        ? new THREE.MeshBasicMaterial({
            color: 0x888888, wireframe: true, side: THREE.DoubleSide,
          })
        : new THREE.MeshStandardMaterial({
            color: 0x888888,
            roughness: 0.9,
            metalness: 0.0,
            side: THREE.DoubleSide,
          });
      // Perf B3 (2026-05-18) — manager-owned singleton (lifecycle =
      // EntityManager.dispose at the bottom of this file). Mark as
      // cache-owned so per-entity dispose chains skip it. See the
      // `__disposable` convention block in the module docstring.
      this._sharedFallback.userData = {
        ...(this._sharedFallback.userData || {}),
        __cacheOwned: true,
      };
    }
    return this._sharedFallback;
  }

  /**
   * Update transform from PositionUpdate. No animation switch.
   */
  setPose(guid, x, y, z, qw, qx, qy, qz) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return;
    inst.setPose(x, y, z, qw, qx, qy, qz);
  }

  /**
   * Toggle the entity's render visibility. Called from the kind=17
   * EntityVisibilityChanged ClientEvent drain in index.html when the
   * wasm side detects that `Entity::should_draw()` flipped — driven
   * by `PhysicsState::HIDDEN`, `NO_DRAW`, or `CLOAKED` changes on a
   * `SetState` packet, or by an entity's initial spawn already in
   * one of those states. Mirrors the bits ACE checks at the
   * `PhysicsObj.cs` draw gates (17 references to `Hidden`, 11 to
   * `NoDraw`, 8 to `Cloaked` in `ACE.Server/Physics/`).
   *
   * THREE.js skips children of an invisible group automatically, so
   * toggling the root is sufficient — no per-part walk needed.
   * No-op when the entity isn't in `entityMap` yet (race with the
   * spawn pipeline; the spawn-time visibility event reaches JS after
   * the EntityInstance is built).
   */
  setVisibility(guid, visible) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst || !inst.root) return;
    inst.root.visible = !!visible;
  }

  /**
   * Apply or clear an "airborne" jump pose on the entity's rig.
   * Called from the kind=18 EntityAirborneChanged ClientEvent drain
   * in index.html. Local player fires on Jump cmd (true) and on
   * landing-detected via the integrator's airborne→grounded
   * transition (false); remote players fire from the recv loop's
   * Z-velocity heuristic.
   *
   * **Retail-ish per-part pose** for entities with the human
   * SetupModel layout (>= 16 parts). Part-index map from community
   * tools (parts[10/13] = upper arms, parts[1/5] = upper legs):
   *
   *     0 ABDOMEN          17-20 TAIL_SEG1..4
   *     1 LEFT_UPPER_LEG   21 HEAD_HAIR
   *     2 LEFT_LOWER_LEG   22 HEAD_HELMET
   *     3 LEFT_FOOT        23/24 SHOULDER_L/R
   *     4 LEFT_TOE         25/26 KNEE_L/R
   *     5 RIGHT_UPPER_LEG  27/28 ELBOW_L/R
   *     6 RIGHT_LOWER_LEG  29-33 CLOAK_SEG1..5
   *     7 RIGHT_FOOT
   *     8 RIGHT_TOE
   *     9 CHEST
   *    10 LEFT_UPPER_ARM
   *    11 LEFT_LOWER_ARM
   *    12 LEFT_HAND
   *    13 RIGHT_UPPER_ARM
   *    14 RIGHT_LOWER_ARM
   *    15 RIGHT_HAND
   *    16 HEAD
   *
   * Pose recipe:
   *   - Upper arms (10, 13) rotated ±90° outward → arms horizontal
   *   - Upper legs (1, 5) rotated ±15° outward → legs slightly spread
   *   - Animation mixer paused so the walk-cycle doesn't fight our
   *     rotations; resumed on landing
   *
   * Rotation axis is the part's local X — this is the best-guess
   * forward-axis convention for AC's Z-up frame. If the in-game
   * pose looks wrong (arms point forward/back instead of sideways),
   * swap to Y or Z in the calls below and re-test. Easy to tune.
   *
   * Equipped gear is rendered via SetupModel part substitution
   * (`fetch_entity_model_render`'s `model_changes` pairs), so a
   * sword bound to parts[15] rotates with the right-hand rotation.
   *
   * Non-human entities (rats, golems, anything with < 16 parts)
   * fall back to body-level tilt + stretch — same effect as before.
   */
  setAirborne(guid, airborne) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst || !inst.root) return;
    const wantAirborne = !!airborne;
    const currentlyAirborne = !!inst._isAirborne;
    if (wantAirborne === currentlyAirborne) return; // idempotent
    inst._isAirborne = wantAirborne;

    const isHumanShape = inst.parts && inst.parts.length >= 16;

    if (wantAirborne) {
      if (isHumanShape) {
        this._applyHumanJumpPose(inst);
      } else {
        this._applyGenericJumpPose(inst);
      }
    } else {
      if (inst._jumpPoseStash) {
        this._clearHumanJumpPose(inst);
      } else if (inst.airborneTilt) {
        this._clearGenericJumpPose(inst);
      }
    }
  }

  /**
   * Per-part jump pose for humanoid SetupModels. Sets up a 200ms
   * slerp tween from current pose → outstretched pose; the per-frame
   * `_tickJumpPoseTween` in `tick(dt)` advances it. The animation
   * mixer is paused at tween-complete (not at tween-start) so the
   * limbs ease into the airborne pose smoothly instead of snapping.
   */
  _applyHumanJumpPose(inst) {
    const X = new THREE.Vector3(1, 0, 0);
    const HUMAN_AIRBORNE_OFFSETS = [
      // [partIndex, axis, angle]
      [10, X, -Math.PI / 2],  // LEFT_UPPER_ARM   — horizontal
      [13, X, Math.PI / 2],   // RIGHT_UPPER_ARM  — horizontal
      [1,  X, -Math.PI / 12], // LEFT_UPPER_LEG   — slight out
      [5,  X, Math.PI / 12],  // RIGHT_UPPER_LEG  — slight out
    ];
    const from = new Map();
    const to = new Map();
    for (const [partIdx, axis, angle] of HUMAN_AIRBORNE_OFFSETS) {
      const p = inst.parts && inst.parts[partIdx];
      if (!p) continue;
      const orig = p.quaternion.clone();
      from.set(partIdx, orig);
      const offset = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      to.set(partIdx, orig.clone().multiply(offset));
    }
    // Stash the pre-airborne quaternions so landing can tween back
    // to them (and so a paranoid mixer-unpause restores to a known
    // frame instead of whatever clip-time happens to be).
    inst._jumpPoseStash = from;
    inst._jumpPoseTween = {
      startMs: performance.now(),
      durationMs: 200,
      from,
      to,
      isLanding: false,
      kind: "human",
    };
  }

  _clearHumanJumpPose(inst) {
    if (!inst._jumpPoseStash) return;
    // Reverse tween: from current (possibly mid-arc-pose) → stashed
    // pre-airborne quaternions. `_jumpPoseStash` doubles as the
    // landing target.
    const from = new Map();
    for (const [partIdx, _origQ] of inst._jumpPoseStash) {
      const p = inst.parts && inst.parts[partIdx];
      if (p) from.set(partIdx, p.quaternion.clone());
    }
    inst._jumpPoseTween = {
      startMs: performance.now(),
      durationMs: 200,
      from,
      to: inst._jumpPoseStash,
      isLanding: true,
      kind: "human",
    };
    // `_jumpPoseStash` cleared and mixer resumed at tween-complete
    // in `_tickJumpPoseTween`, not here.
  }

  /**
   * Body-level fallback for non-human entities. Same shape as the
   * human tween (slerps root.quaternion offset + lerps root.scale.z)
   * so the per-frame tick can handle both paths uniformly.
   */
  _applyGenericJumpPose(inst) {
    const tilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      -Math.PI / 15, // ~12°
    );
    inst._jumpPoseTween = {
      startMs: performance.now(),
      durationMs: 200,
      fromTilt: new THREE.Quaternion(), // identity
      toTilt: tilt,
      fromScale: 1.0,
      toScale: 1.08,
      isLanding: false,
      kind: "generic",
    };
  }

  _clearGenericJumpPose(inst) {
    // Reverse: tween back to identity tilt + scale 1.0.
    inst._jumpPoseTween = {
      startMs: performance.now(),
      durationMs: 200,
      fromTilt: inst.airborneTilt
        ? inst.airborneTilt.clone()
        : new THREE.Quaternion(),
      toTilt: new THREE.Quaternion(), // identity
      fromScale: inst.root.scale.z,
      toScale: 1.0,
      isLanding: true,
      kind: "generic",
    };
  }

  /**
   * Phase D — lookup the entity GUID for a given display name. Case-
   * sensitive. Returns 0 (a never-used GUID since ACE GUIDs are 32-bit
   * and skip 0) when no match. Used by the recv-loop damageTaken /
   * evadedAttacker dispatch to play setSwingPose on the attacker's
   * rig.
   *
   * B4 (2026-05-18) — O(1) via the `_nameToGuid` index maintained on
   * spawn/remove. Names aren't unique (e.g. multiple "Drudge"), so the
   * index holds a Set<guid> per name; we return the first guid via
   * iterator (matches the previous "first match wins" semantics — the
   * old linear scan stopped at the first hit too). Iterator order is
   * insertion order, so the oldest still-alive entity with that name
   * wins, which is what the linear scan over an insertion-ordered Map
   * also did.
   */
  findGuidByName(name) {
    if (typeof name !== "string" || name.length === 0) return 0;
    const bucket = this._nameToGuid.get(name);
    if (!bucket || bucket.size === 0) return 0;
    // Set iteration is insertion-order — first value is the
    // oldest-still-alive guid with this name.
    const first = bucket.values().next().value;
    return (first >>> 0) || 0;
  }

  /**
   * Wave 1 Phase 3 (CMT fixes plan 2026-05-26): expose the equipped
   * primary weapon for an entity so the CombatManeuverTable lookup in
   * `scene3d/picking.js:441` can infer the AttackType from the wielded
   * item instead of hardcoding Slash.
   *
   * Returns a minimal weapon record consumed by
   * `ui/ac_attack_type_for_weapon.js#inferAttackTypeForWeapon`:
   * `{ guid, wcid, itemType, equipMask, name }` or `null` when the
   * entity is unarmed / unknown.
   *
   * ## Current data source (local player only)
   *
   * Equipped weapons live in the wasm-side `latest_inventory` snapshot
   * — see `apps/holtburger-web/src/lib.rs:13991 InventoryItem`. Each
   * inventory entry carries an `equipMask` bitfield; items with
   * `equipMask & (MELEE_WEAPON | MISSILE_WEAPON | TWO_HANDED | CASTER)`
   * are wielded. We pick the first such entry — there's at most one
   * primary weapon at a time per ACE's `wield_item` semantics
   * (`crates/holtburger-world/src/player/types.rs:471`).
   *
   * The snapshot is read via `window.__sessionHandle.playerInventory()`
   * (the global handle is exposed by `index.html` at the top of
   * `start_session`). EntityManager doesn't get the handle injected
   * at construction time, so the lookup goes through the global —
   * matches the existing `window.getLocalPlayerGuid()` pattern used
   * elsewhere in this file (see line ~837).
   *
   * ## Non-local entities (Wave 2 / Phase 5, 2026-05-26)
   *
   * For non-local GUIDs we consult the wasm `entityEquippedWeapon`
   * getter, which is populated by the recv loop's
   * `apply_inventory_object_create` whenever an `ObjectCreate` arrives
   * carrying a `WielderId` that is NOT the local player (see
   * `apps/holtburger-web/src/lib.rs:apply_inventory_object_create`).
   * The wasm side maintains a `wielder_index: HashMap<u32, Vec<...>>`
   * keyed by wielder GUID; this accessor just unions the local +
   * remote channels into the same `{guid, wcid, itemType, equipMask,
   * name}` shape. Returns `null` when the wielder isn't in the index
   * (the entity hasn't been observed yet) OR when the entity is
   * currently unarmed.
   *
   * ## Wave 6 / Phase 15 (2026-05-26): `W_AttackType` now on the wire
   *
   * `PropertyInt::AttackType = 47` is surfaced on both the local
   * (`InventoryItem.attackType`) and non-local (`EquippedWeaponJs
   * .attackType`) wasm structs — see
   * `apps/holtburger-web/src/lib.rs:apply_inventory_object_create`
   * and `publish_player_inventory_snapshot`. The returned record
   * now carries `attackType` so `inferAttackTypeForWeapon` can
   * prefer it over the equip-slot heuristic and resolve two-handed
   * spears to Thrust, swords to Thrust|Slash, etc. (closing the
   * Phase 13 documented limitation).
   *
   * ## Wave 8 / Phase 25 (2026-05-26): `MaximumVelocity` now on the wire
   *
   * `PropertyFloat::MaximumVelocity = 26` is surfaced on both the local
   * (`InventoryItem.maximumVelocity`) and non-local
   * (`EquippedWeaponJs.maximumVelocity`) wasm structs — see
   * `apps/holtburger-web/src/lib.rs:apply_inventory_object_create` and
   * `publish_player_inventory_snapshot`. The returned record now
   * carries `maximumVelocity` so `scene3d/picking.js`'s missile
   * branch can pass per-weapon projectile speed to
   * `getAimLevelForBallisticArc` (replacing Phase 19's hardcoded
   * 20 m/s default). Fallback `20.0` matches ACE
   * `Creature_Missile.cs:208 DefaultProjectileSpeed`.
   *
   * @param {number} guid — entity GUID to query
   * @returns {{ guid: number, wcid: number, itemType: number,
   *             equipMask: number, attackType: number,
   *             maximumVelocity: number,
   *             name: string } | null}
   */
  getEquippedWeapon(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return null;

    // Resolve the local player guid via the same global pattern the
    // rest of this file uses (`isLocalPlayer` at ~line 837).
    let localGuid = 0;
    try {
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        const lpg = window.getLocalPlayerGuid();
        if (lpg !== null && lpg !== undefined) localGuid = (lpg >>> 0);
      }
    } catch (_) { /* never break callers */ }

    // CMT Wave 2 / Phase 5 (2026-05-26): non-local entities consult
    // the wasm-side wielder index via `entityEquippedWeapon(guid)`.
    // Returns `EquippedWeaponJs` (with the same shape this accessor
    // emits) or `undefined` when the entity isn't a wielder we've
    // observed. We map `undefined` → `null` to keep the contract
    // stable with the local path.
    if (g !== localGuid) {
      try {
        if (typeof window !== "undefined" && window.__sessionHandle
            && typeof window.__sessionHandle.entityEquippedWeapon === "function") {
          const w = window.__sessionHandle.entityEquippedWeapon(g);
          if (!w) return null;
          // wasm-bindgen returns a struct with getters; mirror it into
          // a plain object so the caller doesn't have to worry about
          // wasm-bindgen handle lifetimes (the struct here is cheap —
          // 6 fields, no per-call .free() responsibility).
          // CMT Wave 6 / Phase 15 (2026-05-26): `attackType` is
          // PropertyInt 47 (`W_AttackType`); `inferAttackTypeForWeapon`
          // prefers it over the EquipMask heuristic when non-zero.
          // CMT Wave 8 / Phase 25 (2026-05-26): `maximumVelocity` is
          // PropertyFloat 26 (m/s) — picking.js's missile branch passes
          // it to `getAimLevelForBallisticArc` for per-weapon gravity
          // arcs. `20.0` fallback mirrors ACE `Creature_Missile.cs:208
          // DefaultProjectileSpeed` and Phase 19's `BOW_DEFAULT_SPEED_MPS`.
          const result = {
            guid:     (w.guid ?? 0) >>> 0,
            wcid:     (w.wcid ?? 0) >>> 0,
            itemType: (w.itemType ?? 0) >>> 0,
            equipMask: (w.equipMask ?? 0) >>> 0,
            attackType: (w.attackType ?? 0) >>> 0,
            maximumVelocity: Number.isFinite(w.maximumVelocity) ? w.maximumVelocity : 20.0,
            name:     typeof w.name === "string" ? w.name : "",
          };
          // wasm-bindgen-constructed structs need explicit .free()
          // unless we relinquish the borrow. We've copied the fields
          // above, so we can release the handle here.
          if (typeof w.free === "function") {
            try { w.free(); } catch (_) {}
          }
          return result;
        }
      } catch (_) { /* never break callers */ }
      return null;
    }

    // Pull the latest inventory snapshot. `window.__sessionHandle` is
    // the wasm-bound session handle; `playerInventory()` returns
    // `Array<InventoryItem>` (see `src/lib.rs:16160`). Each item's
    // `equipMask` is a u32 bitfield from
    // `holtburger_common::properties::EquipMask`.
    let inventory = null;
    try {
      if (typeof window !== "undefined" && window.__sessionHandle
          && typeof window.__sessionHandle.playerInventory === "function") {
        inventory = window.__sessionHandle.playerInventory();
      }
    } catch (_) { /* never break callers */ }
    if (!Array.isArray(inventory) || inventory.length === 0) return null;

    // EquipMask bits that mark a "primary weapon" — what `picking.js`'s
    // melee branch cares about. Order of preference for multi-bit cases
    // is irrelevant because no item carries more than one of these.
    const PRIMARY_WEAPON_BITS =
        0x00100000 /* MELEE_WEAPON */
      | 0x00400000 /* MISSILE_WEAPON */
      | 0x01000000 /* CASTER */
      | 0x02000000 /* TWO_HANDED */;

    for (const item of inventory) {
      const mask = (item?.equipMask ?? 0) >>> 0;
      if ((mask & PRIMARY_WEAPON_BITS) === 0) continue;
      // First (and only) primary wielded weapon wins.
      // CMT Wave 6 / Phase 15 (2026-05-26): `attackType` is
      // PropertyInt 47 (`W_AttackType`), surfaced on the local-player
      // InventoryItem alongside the non-local EquippedWeaponJs path.
      // Drives `inferAttackTypeForWeapon`'s new wire-prefers-heuristic
      // precedence (closes Phase 13's two-handed limitation).
      // CMT Wave 8 / Phase 25 (2026-05-26): `maximumVelocity` is
      // PropertyFloat 26 (m/s) — picking.js's missile branch reads it
      // for the gravity-arc resolver. `20.0` fallback mirrors ACE
      // `Creature_Missile.cs:208 DefaultProjectileSpeed` and Phase 19's
      // `BOW_DEFAULT_SPEED_MPS`.
      return {
        guid:     (item.guid ?? 0) >>> 0,
        wcid:     (item.wcid ?? 0) >>> 0,
        itemType: (item.itemType ?? 0) >>> 0,
        equipMask: mask,
        attackType: (item.attackType ?? 0) >>> 0,
        maximumVelocity: Number.isFinite(item.maximumVelocity) ? item.maximumVelocity : 20.0,
        name:     typeof item.name === "string" ? item.name : "",
      };
    }
    // No primary weapon slot occupied — unarmed. Caller will see
    // `null` and infer Punch.
    return null;
  }

  /**
   * CMT Wave 8 / Phase 23 (2026-05-26): dual-wield detection for the
   * Phase 21 `inferAttackTypeForWeapon(weapon, opts)` call site in
   * `scene3d/picking.js` melee branch. Returns `true` iff the entity
   * has BOTH a primary weapon (MELEE_WEAPON / TWO_HANDED — the kinds
   * that the unarmed Kick logic in ACE's `Player_Melee.cs:462` cares
   * about) AND a non-shield item in the offhand slot.
   *
   * ## ACE's offhand model
   *
   * AC has NO distinct "OffhandWeapon" EquipMask bit. Verified against
   * `~/ace-server/Source/ACE.Entity/Enum/EquipMask.cs` and
   * `crates/holtburger-common/src/properties/inventory.rs:158-191` —
   * the EquipMask bitfield jumps from `MELEE_WEAPON = 0x00100000`
   * straight to `SHIELD = 0x00200000` then `MISSILE_WEAPON =
   * 0x00400000`, with no offhand-weapon slot in between.
   *
   * Instead, retail / ACE encodes dual-wielding by placing a non-shield
   * weapon in the `Shield` equip slot — see
   * `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Equipment.cs:133
   * GetDualWieldWeapon()`:
   *
   *     return EquippedObjects.Values.FirstOrDefault(
   *         e => !e.IsShield && e.CurrentWieldedLocation == EquipMask.Shield);
   *
   * The `!e.IsShield` clause is the discriminator: an item equipped in
   * the SHIELD slot that is itself not a shield = offhand weapon. We
   * approximate `IsShield` here with `equipMask == SHIELD` exactly
   * (shields carry only that bit; offhand weapons carry SHIELD plus
   * other context the wire doesn't always surface). The closest proxy
   * we have on the wire is `itemType` — `ItemType::MeleeWeapon = 1`
   * vs `ItemType::Armor = 2` (shield is Armor). If itemType is a
   * weapon-family type, treat the SHIELD-slot occupant as an offhand
   * weapon. Otherwise treat it as a real shield.
   *
   * ## Local player
   *
   * Walks `window.__sessionHandle.playerInventory()` (the wasm-bound
   * snapshot — see `src/lib.rs:16426 player_inventory`) looking for:
   *
   *   1. A primary weapon: `equipMask & (MELEE_WEAPON | TWO_HANDED)`
   *      non-zero. Two-handed is included because retail technically
   *      can't dual-wield with a two-hander, but the wire could carry
   *      a transient state during a swap; the helper's `isDualWield`
   *      clause only matters for unarmed Kick logic anyway and a
   *      two-hander already short-circuits the unarmed branch upstream.
   *   2. A SHIELD-slot non-shield item: `equipMask & SHIELD` non-zero
   *      AND `itemType !== ITEM_TYPE_ARMOR (2)`. Mirrors
   *      `Creature_Equipment.cs:135` `!e.IsShield`.
   *
   * Returns `true` iff BOTH are present.
   *
   * ## Non-local entities — limitation
   *
   * The wasm `wielder_index` (see `src/lib.rs:15533`) DOES accumulate
   * every wielded item ObjectCreate per wielder (primary + offhand
   * shield-slot occupant both land in the index), but the public
   * accessor `entity_equipped_weapon` (line 16451) iterates and
   * returns ONLY the first primary-weapon hit. Surfacing the offhand
   * for non-local entities would require either (a) a new wasm getter
   * that returns the full per-wielder list, or (b) extending
   * `entity_equipped_weapon` to return primary + offhand as a tuple.
   *
   * Per Phase 23's hard constraint, we keep this scope-bounded: return
   * `false` for non-local entities for now. TODO: extend
   * `wielder_index` consumer at `src/lib.rs:15421` (apply_inventory_object_create
   * dispatch comment) — wire a separate `entity_offhand_weapon(guid)`
   * getter so this accessor can match the local-player behaviour for
   * remote dual-wielders.
   *
   * ## Defensive contract
   *
   * Returns `false` whenever data isn't available (pre-login,
   * `playerInventory()` throws, snapshot empty). Never throws —
   * matches the `getEquippedWeapon` pattern.
   *
   * @param {number} guid — entity GUID to query
   * @returns {boolean}
   */
  isDualWield(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return false;

    // Resolve the local player guid via the same global pattern the
    // sibling `getEquippedWeapon` accessor uses (`getLocalPlayerGuid`
    // at ~line 837).
    let localGuid = 0;
    try {
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        const lpg = window.getLocalPlayerGuid();
        if (lpg !== null && lpg !== undefined) localGuid = (lpg >>> 0);
      }
    } catch (_) { /* never break callers */ }

    // Non-local entities — limitation documented above. TODO once the
    // wielder index gains an offhand-aware accessor at
    // `src/lib.rs:15421` (apply_inventory_object_create / wielder_index
    // population), mirror the local-player logic below.
    if (g !== localGuid) return false;

    // Local player path. Pull the latest inventory snapshot from the
    // wasm-bound session handle. Returns `Vec<InventoryItem>` —
    // `src/lib.rs:16426 player_inventory`. Each item carries a u32
    // `equipMask` from `holtburger_common::properties::EquipMask`.
    let inventory = null;
    try {
      if (typeof window !== "undefined" && window.__sessionHandle
          && typeof window.__sessionHandle.playerInventory === "function") {
        inventory = window.__sessionHandle.playerInventory();
      }
    } catch (_) { /* never break callers */ }
    if (!Array.isArray(inventory) || inventory.length === 0) return false;

    // EquipMask bits — see ACE.Entity/Enum/EquipMask.cs +
    // crates/holtburger-common/src/properties/inventory.rs:158.
    // `MELEE_WEAPON | TWO_HANDED` mark the primary; `SHIELD` is the
    // offhand slot. Two-handed is included for completeness even
    // though dual-wielding a two-hander is invalid in retail — keeps
    // the predicate honest if the wire ever shows a transient state.
    const PRIMARY_BITS = 0x00100000 /* MELEE_WEAPON */ | 0x02000000 /* TWO_HANDED */;
    const SHIELD_BIT   = 0x00200000;
    // ItemType::Armor = 2 — shields are ItemType=Armor in AC. Anything
    // else in the SHIELD slot is an offhand weapon per ACE's
    // `Creature_Equipment.cs:135` `!e.IsShield` discriminator.
    const ITEM_TYPE_ARMOR = 2;

    let hasPrimary = false;
    let hasOffhandWeapon = false;
    for (const item of inventory) {
      const mask = (item?.equipMask ?? 0) >>> 0;
      if ((mask & PRIMARY_BITS) !== 0) {
        hasPrimary = true;
      }
      if ((mask & SHIELD_BIT) !== 0) {
        const itemType = (item?.itemType ?? 0) >>> 0;
        if (itemType !== ITEM_TYPE_ARMOR) {
          hasOffhandWeapon = true;
        }
      }
      if (hasPrimary && hasOffhandWeapon) return true;
    }
    return hasPrimary && hasOffhandWeapon;
  }

  /**
   * CMT Wave 2 / Phase 5 (2026-05-26): per-entity MotionStance accessor.
   *
   * Returns the entity's last-observed `MotionStance` (one of
   * `holtburger_common::motion::MotionStance` — HandCombat,
   * SwordCombat, BowCombat, MagicCombat, NonCombat, etc.). The value
   * is stamped on every kind=5 `UpdateMotion` from ACE — see
   * `setMotion(...)` at the top of this file where both
   * `inst.lastStance` and `inst.currentStance` are written. Returns
   * `0` for entities that have never received an UpdateMotion (the
   * spawn meta's `motionStance` is also checked as a fallback).
   *
   * Used by the `damageTaken` / `evadedAttacker` handlers in
   * `index.html` (~line 8612) to drive the CMT lookup for remote-
   * player swings.
   *
   * @param {number} guid — entity GUID to query
   * @returns {number} u32 MotionStance, or 0 if unknown
   */
  getStance(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return 0;
    const inst = this.entityMap.get(g);
    if (!inst) return 0;
    // Prefer currentStance (resolved with stance=0 fallback inside
    // setMotion); fall back to lastStance and then the spawn meta.
    const s = (inst.currentStance ?? inst.lastStance ?? inst.meta?.motionStance ?? 0) >>> 0;
    return s;
  }

  /**
   * Phase D — persistent selection indicator on the currently targeted
   * entity. A flat ring is parented under the entity's root so it
   * follows position/rotation automatically and is GC'd when the
   * entity is removed from the scene. `guid = 0` (or any unknown
   * GUID) clears the indicator.
   */
  getSelectedTarget() {
    return (this._selectedGuid ?? 0) >>> 0;
  }

  setSelectedTarget(guid) {
    const next = (guid >>> 0) || 0;
    // Tear down the previous selection ring even if it's on the same
    // entity — keeps the path idempotent.
    if (this._selectedGuid && this._selectedGuid !== next) {
      const prev = this.entityMap.get(this._selectedGuid);
      if (prev?._selectionRing) {
        prev.root.remove(prev._selectionRing);
        prev._selectionRing.geometry.dispose();
        prev._selectionRing.material.dispose();
        prev._selectionRing = null;
      }
    }
    this._selectedGuid = next;
    if (next === 0) return;
    const inst = this.entityMap.get(next);
    if (!inst || !inst.root) {
      this._selectedGuid = 0;
      return;
    }
    if (inst._selectionRing) return; // already ringed
    // 0.6m flat torus at the entity's feet, tilted so the ring lies
    // in the local XY (AC ground) plane. Bright red, slight emissive
    // hint so it reads even in shadow.
    const ringGeom = new THREE.TorusGeometry(0.55, 0.06, 6, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff3322,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    // Perf B3 (2026-05-18) — selection-ring resources are fresh per
    // selection; tag both geometry + material so the
    // `_disposeMeshChildren` traverse frees them when the entity is
    // despawned WHILE selected (otherwise the explicit dispose at the
    // setSelected swap-path above handles them).
    ringGeom.userData = { ...(ringGeom.userData || {}), __disposable: true };
    ringMat.userData = { ...(ringMat.userData || {}), __disposable: true };
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0, 0.02);
    ring.renderOrder = 10;
    ring.name = "selection-ring";
    inst._selectionRing = ring;
    inst.root.add(ring);
  }

  /**
   * Phase C — one-shot melee swing pose. Right upper arm sweeps
   * forward and back over ~300ms (triangle wave: 0→1→0 in part
   * rotation amplitude). Restarting before completion replaces the
   * tween. Only animates humanoid rigs (16+ parts); other shapes
   * are no-ops (an animated swing on a drudge would need a per-
   * shape part-index map and isn't worth Phase C scope).
   */
  setSwingPose(guid) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst || !inst.root) return;
    const isHuman = inst.parts && inst.parts.length >= 16;
    if (!isHuman) return;
    const armIdx = 13; // RIGHT_UPPER_ARM (same index as jump pose)
    const arm = inst.parts[armIdx];
    if (!arm) return;
    const baseQ = arm.quaternion.clone();
    const swingQ = baseQ.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        -Math.PI / 2,
      ),
    );
    inst._swingTween = {
      startMs: performance.now(),
      durationMs: 300,
      armIdx,
      baseQ,
      swingQ,
    };
  }

  async setSwingMotion(guid, motionCmd) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return;
    const stance =
      ((inst.currentStance ?? inst.lastStance ?? (typeof window !== "undefined" ? window.__getCurrentStanceLow?.() : 0)) ?? 0) >>> 0;
    const setupId = (inst.meta?.modelId ?? inst.meta?.setupId ?? 0) >>> 0;
    const mtableId = (inst.meta?.mtableId ?? 0) >>> 0;
    const result = classifyMotionCommandTyped(mtableId, stance, motionCmd >>> 0);
    // CMT Wave 2 / Phase 5 (2026-05-26): removed the `isHuman` gate
    // that previously short-circuited non-human rigs to the
    // setSwingPose tween (which itself early-returns on non-humans →
    // drudges silently played nothing). The motion-table classifier
    // (`classifyMotionCommandTyped`) works for any rig — monster
    // motion tables expose swings under NonCombat stance and the
    // wasm-side `lookupMotionLinkForSwing` returns the same
    // typed-anim envelope regardless of rig topology. The downstream
    // `animationCache.get` path also accepts any setupId, so once a
    // valid `swing/cast` clip resolves we play it on whatever rig
    // the entity has. setSwingPose is still the fallback for the
    // (rare) case where the motion table has no link entry for the
    // requested (stance, cmd) — humanoids get the legacy tween,
    // non-humans silently no-op which preserves prior behaviour.
    // See `docs/swing-classification-spec-2026-05-19.md` §8.2.
    const canPlayReal =
      result &&
      (result.kind === "swing" || result.kind === "cast") &&
      (result.resolvedCommand >>> 0) !== 0 &&
      result.source === "wasm-link";
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (!canPlayReal || typeof fetchKeyframes !== "function") {
      this.setSwingPose(g);
      return;
    }
    const resolvedCmd = result.resolvedCommand >>> 0;
    let entry;
    try {
      entry = await this.animationCache.get(
        setupId,
        mtableId,
        resolvedCmd,
        stance,
        fetchKeyframes,
        {
          modelChanges: inst.meta?.modelChanges ?? new Uint32Array(0),
          textureChanges: inst.meta?.textureChanges ?? new Uint32Array(0),
          paletteId: (inst.meta?.paletteId ?? 0) >>> 0,
          paletteSubsFlat: inst.meta?.subPalettes ?? new Uint32Array(0),
          fromMotion: READY_SUBSTATE,
        },
      );
    } catch (_) {
      this.setSwingPose(g);
      return;
    }
    if (!this.entityMap.has(g)) return;
    const clip = entry?.clip;
    if (!clip) {
      this.setSwingPose(g);
      return;
    }
    const swingKey = `swing:${resolvedCmd.toString(16)}:${stance.toString(16)}`;
    let action = inst.actions.get(swingKey);
    if (!action) {
      inst.evictOldestUnused?.();
      action = inst.mixer.clipAction(clip);
      inst.actions.set(swingKey, action);
    }
    inst.actionLastUsedMs.set(swingKey, performance.now());
    if (Array.isArray(entry.hooks) && entry.hooks.length > 0) {
      inst.hookTimelines.set(swingKey, entry.hooks);
    }
    inst.actionLastHookTime.set(swingKey, 0);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.enabled = true;
    const dur = +result.durationSec;
    if (Number.isFinite(dur) && dur > 0 && Number.isFinite(clip.duration) && clip.duration > 0) {
      action.setEffectiveTimeScale(clip.duration / dur);
    } else {
      action.setEffectiveTimeScale(1.0);
    }
    action.setEffectiveWeight(1.0);
    action.reset();
    action.play();
    const prior = inst.currentAction;
    if (prior && prior !== action) {
      try { action.crossFadeFrom(prior, 0.1, false); } catch (_) {}
    }
    inst._swingTween = null;
    inst.currentAction = action;
    inst.currentActionKey = swingKey;
    if (inst._swingRestoreTimer) clearTimeout(inst._swingRestoreTimer);
    const restoreDelayMs = Math.max(
      80,
      Math.round(((Number.isFinite(dur) && dur > 0) ? dur : (clip.duration || 0.4)) * 1000),
    );
    inst._swingRestoreTimer = setTimeout(() => {
      inst._swingRestoreTimer = null;
      if (!this.entityMap.has(g)) return;
      if (inst.currentActionKey !== swingKey) return;
      this.setMotion(g, CMD_LOW_READY, stance);
    }, restoreDelayMs);
    console.log(
      "[entities/swingMotion] guid=0x" + g.toString(16) +
      " cmd=0x" + (motionCmd >>> 0).toString(16) +
      " anim=" + result.animId +
      " dur=" + (Number.isFinite(dur) ? dur.toFixed(2) : "0.00") + "s",
    );
  }

  _tickSwingTween(inst, nowMs) {
    const tw = inst._swingTween;
    if (!tw) return;
    const t = (nowMs - tw.startMs) / tw.durationMs;
    const p = inst.parts && inst.parts[tw.armIdx];
    if (!p) {
      inst._swingTween = null;
      return;
    }
    if (t >= 1) {
      p.quaternion.copy(tw.baseQ);
      inst._swingTween = null;
      return;
    }
    const clampedT = Math.max(0, t);
    // Triangle wave: 0→1 over t=[0,0.5], then 1→0 over t=[0.5,1].
    const triangle = clampedT < 0.5 ? clampedT * 2 : (1 - clampedT) * 2;
    p.quaternion.slerpQuaternions(tw.baseQ, tw.swingQ, triangle);
  }

  /**
   * Per-frame advance of the jump-pose tween. Called from `tick`
   * after `mixer.update` so our slerp wins for the locked parts.
   * Ease-out cubic on the human path (snaps quickly out of walking
   * pose, settles into airborne); same easing on generic for
   * consistency.
   */
  _tickJumpPoseTween(inst, nowMs) {
    const tween = inst._jumpPoseTween;
    if (!tween) return;
    const t = (nowMs - tween.startMs) / tween.durationMs;
    const clampedT = Math.max(0, Math.min(1, t));
    // Ease-out cubic: 1 - (1-t)^3. Snappier than linear, gentler
    // than ease-out quintic.
    const eased = 1 - (1 - clampedT) * (1 - clampedT) * (1 - clampedT);

    if (tween.kind === "human") {
      for (const [partIdx, fromQ] of tween.from) {
        const toQ = tween.to.get(partIdx);
        if (!toQ) continue;
        const p = inst.parts && inst.parts[partIdx];
        if (p) p.quaternion.slerpQuaternions(fromQ, toQ, eased);
      }
    } else if (tween.kind === "generic") {
      // Tilt: slerp identity quat ↔ tilt quat, multiply into root.
      // We re-derive root.quaternion from the position-frame quat
      // every setPose call, so apply the tween every tick.
      //
      // Perf B2 (2026-05-18): `tweenQ` is NOT pooled — it's assigned
      // directly to `inst.airborneTilt` and read by `setPose` on every
      // subsequent position update until the tween ends or the entity
      // lands. Pooling the slerp result would corrupt the stored tilt
      // the moment any other entity's tween advanced. The identity
      // sentinel on the next line IS pooled (`_IDENTITY_QUAT`,
      // read-only) since `.equals(...)` only reads it.
      const tweenQ = new THREE.Quaternion().slerpQuaternions(
        tween.fromTilt,
        tween.toTilt,
        eased,
      );
      // Store as airborneTilt so setPose can re-apply on position
      // updates (read by `EntityInstance.setPose`).
      inst.airborneTilt = tweenQ.equals(_IDENTITY_QUAT)
        ? null
        : tweenQ;
      if (inst.airborneTilt) {
        inst.root.quaternion.multiply(tweenQ);
      }
      // Scale: simple lerp.
      const scaleZ = tween.fromScale + (tween.toScale - tween.fromScale) * eased;
      inst.root.scale.set(1.0, 1.0, scaleZ);
    }

    if (clampedT >= 1) {
      if (tween.isLanding) {
        if (tween.kind === "human") {
          inst._jumpPoseStash = null;
          if (inst.currentAction) inst.currentAction.paused = false;
        } else {
          inst.airborneTilt = null;
        }
      } else {
        // Tween-in complete. Lock the mixer for human path so the
        // walk-cycle doesn't drift the parts while airborne.
        if (tween.kind === "human") {
          if (inst.currentAction) inst.currentAction.paused = true;
        } else {
          inst.airborneTilt = tween.toTilt.clone();
        }
      }
      inst._jumpPoseTween = null;
    }
  }

  /**
   * Update motion command/stance. Triggers async fetch + crossFade
   * to a new action when needed. Idempotent: already-playing
   * (cmd, stance) is a no-op.
   *
   * STOP / non-locomotion commands fade out the current action, leaving
   * the rig at rest pose.
   */
  async setMotion(guid, motionCommand, motionStance) {
    const inst = this.entityMap.get(guid >>> 0);
    if (!inst) return;
    // ACE broadcasts cmd=Stop (0x0004) or cmd=Invalid (0x0000) when a
    // moving entity comes to rest. With no override we'd fall through
    // classifyMotionCommand → null → fadeOutCurrent → bare SetupModel
    // rest pose, dropping the stance-aware idle (combat pose
    // disappears on releasing W). Substitute to Ready (0x0003) so the
    // locomotion-cache path fetches `cycles[(stance, Ready)]` — the
    // weapons-drawn pose for HandCombat, normal stand for NonCombat,
    // etc. Preserve the high bits of the wire u32 so MotionTable's
    // cycle_key masking is unchanged.
    let cmd = (motionCommand >>> 0);
    const cmdLow = cmd & 0xFFFF;
    if (cmdLow === CMD_LOW_STOP || cmdLow === 0x0000) {
      cmd = (cmd & 0xFFFF0000) | CMD_LOW_READY;
    }
    let stance = (motionStance >>> 0);
    // ACE emits UpdateMotion with stance=0 for "motion-only" broadcasts
    // (the wire shorthand for "keep current stance"). Without
    // substitution our cycle_key resolves to `MotionTable.default_style`
    // (NonCombat for humans), so e.g. a HandCombat-stanced player who
    // starts walking would visibly drop out of the combat pose and
    // play the NonCombat walk cycle. `applyConfirmedStance` in
    // index.html already preserves the last label on stance=0; mirror
    // that behaviour here for the rig pose.
    if (stance === 0 && inst.lastStance) {
      stance = inst.lastStance;
    } else if (stance !== 0) {
      inst.lastStance = stance;
    }
    // CMT Wave 2 / Phase 5 (2026-05-26): mirror the resolved stance
    // onto `inst.currentStance` so `getStance(guid)` (and downstream
    // CMT-driven swing dispatch for remote players) can read it
    // without re-deriving stance=0 fallback semantics. Mirrors the
    // existing read pattern in `setSwingMotion` at line ~1942 which
    // already checks `inst.currentStance ?? inst.lastStance ?? …`.
    inst.currentStance = stance;
    const cls = classifyMotionCommand(cmd);
    if (cls === "stop" || cls === null) {
      inst.fadeOutCurrent(CROSSFADE_S);
      // Remember the last non-stop command we played so a follow-up
      // setMotion(...) can ask the wasm side for a link clip from
      // the previous cycle into the next one.
      // (`lastMotionCommand` stays sticky across STOP so e.g.
      //  Walk → Stop → Walk replays the original link.)
      return;
    }
    const setupId =
      (inst.meta.modelId ?? inst.meta.setupId ?? 0) >>> 0;
    const mtableId = (inst.meta.mtableId ?? 0) >>> 0;

    // Swings + magic casts live in `MotionTable.links[(stance,
    // Ready)][swingCmd]` — never in `cycles[(stance, swingCmd)]`.
    // Empirically validated across all 436 retail motion tables
    // (5,455 link entries, 0 cycle entries) — see
    // `docs/swing-classification-spec-2026-05-19.md` §1, §8.
    //
    // Route attack/cast through `_tryPlayLink` with from = Ready =
    // 0x0003 and OVERLAY the swing on top of the active locomotion
    // cycle (no crossFadeTo). The walk/run continues to animate the
    // legs while the swing animates the arms; when LoopOnce ends
    // with `clampWhenFinished=false`, the swing weight drops to 0
    // and the cycle resumes the affected parts.
    //
    // Stance-agnostic per spec §8.2 finding A — monster motion
    // tables put swings in `NonCombat`; the link lookup either has
    // an entry or it doesn't, we pass `stance` straight through.
    //
    // Pre-fix: attack/cast went through the cycle path, which
    // returned a null clip (swings aren't in cycles) and the
    // `if (!clip) fadeOutCurrent` branch then silently faded out
    // the underlying locomotion. Net effect: no swing visible AND
    // the walk cycle stopped.
    if (cls === "attack" || cls === "cast") {
      // Clear any in-flight vibe-coded tween (`setSwingPose`'s
      // triangle wave). It applies in `_tickSwingTween` AFTER
      // `mixer.update`, so it would otherwise overwrite the real
      // motion-table clip's arm pose for the ~300ms tween duration.
      inst._swingTween = null;
      this._tryPlayLink(inst, setupId, mtableId, READY_SUBSTATE, cmd, stance);
      // Don't update `lastMotionCommand` — the next locomotion
      // broadcast should resolve its link transition from the
      // PREVIOUS locomotion cmd, not from this swing.
      return;
    }
    // Locomotion. Build the cache key the same way the spawn path did
    // (resolvedStance falls back to the entity's first-bake stance).
    const cacheKey = AnimationCache.makeKey(setupId, mtableId, cmd, stance);
    if (cacheKey === inst.currentActionKey) return; // already playing
    this.motionSwitchCount += 1;
    inst.actionLastUsedMs.set(cacheKey, performance.now());

    // 2026-05-18 motion-link experiment. When we're transitioning
    // from a known previous motion command (not the very first
    // setMotion for this entity), ask the MotionTable for a link
    // transition clip via `opts.fromMotion`. If one exists, play it
    // once with LoopOnce + clampWhenFinished, then schedule the
    // destination cycle as a follow-up so the rig flows
    // (prev cycle frames) → (link clip frames once) → (next cycle).
    const fromMotion = (inst.lastMotionCommand ?? 0) >>> 0;
    if (
      fromMotion !== 0 &&
      fromMotion !== cmd &&
      cls !== "attack" &&
      cls !== "cast"
    ) {
      // Don't await — kick off the link fetch but immediately also
      // start fetching the destination cycle below. If the link
      // resolves we'll insert it as a quick overlay; if not (no
      // link entry for this transition) we just play the cycle as
      // before. Failure is silent — same visual as today.
      this._tryPlayLink(inst, setupId, mtableId, fromMotion, cmd, stance);
    }
    inst.lastMotionCommand = cmd;

    let action = inst.actions.get(cacheKey);
    if (!action) {
      // Cache miss → fetch the clip. Substitutions reuse the spawn
      // meta's entries (NPC outfit doesn't change mid-walk).
      const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
      if (typeof fetchKeyframes !== "function") return;
      let entry;
      try {
        entry = await this.animationCache.get(
          setupId,
          mtableId,
          cmd,
          stance,
          fetchKeyframes,
          {
            modelChanges: inst.meta.modelChanges ?? new Uint32Array(0),
            textureChanges: inst.meta.textureChanges ?? new Uint32Array(0),
            paletteId: (inst.meta.paletteId ?? 0) >>> 0,
            paletteSubsFlat: inst.meta.subPalettes ?? new Uint32Array(0),
          }
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[phase7.4b] setMotion fetch failed for entity ${guid.toString(16)}:`,
          e
        );
        return;
      }
      // Re-check — the entity may have been removed between the
      // cache hit and now.
      if (!this.entityMap.has(guid >>> 0)) return;
      const clip = entry.clip;
      if (!clip) {
        // No animation resolved for this (cmd, stance). Treat as STOP
        // — fade out the current action.
        inst.fadeOutCurrent(CROSSFADE_S);
        return;
      }
      // Don't exceed the per-entity action cap. Evict before install.
      inst.evictOldestUnused();
      action = inst.mixer.clipAction(clip);
      // One-shot (attack / cast) — play once + return to the rest
      // pose; the surrounding locomotion will re-resume on the next
      // STOP / WalkForward / RunForward broadcast from ACE. Pre-2026-
      // 05-17 these commands were dropped at `classifyMotionCommand`,
      // so combat used a vibe-coded triangle-wave arm tween in
      // `setSwingPose`. Now the real MotionTable clip plays for any
      // attack-family or cast-family command. Clear the vibe-tween
      // so the real clip wins (the tween's per-tick slerp runs AFTER
      // mixer.update and would otherwise overwrite the clip's pose).
      if (cls === "attack" || cls === "cast") {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = false;
        inst._swingTween = null;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
      action.enabled = true;
      inst.actions.set(cacheKey, action);
      // Task E (2026-05-12): same hook-timeline stash as the spawn
      // path. The cache entry already has hooks drained + snapshotted
      // to plain JS POJOs; multiple entities sharing this clip share
      // the same timeline array (per-entity firing state in
      // `actionLastHookTime` keeps them independent).
      if (Array.isArray(entry.hooks) && entry.hooks.length > 0) {
        inst.hookTimelines.set(cacheKey, entry.hooks);
        inst.actionLastHookTime.set(cacheKey, 0);
      }
    }
    inst.crossFadeTo(action, cacheKey, CROSSFADE_S);
    try { window.__diag?.motion?.onMotionApplied?.(guid, inst); } catch (_) {}
  }

  /**
   * Optional VectorUpdate (kind=4) handler. The 2D path stamps
   * vel/omega for extrapolation; the 3D path doesn't extrapolate yet
   * (pose updates are server-authoritative). Surfaced here so
   * loop.js's drainEntityEvents3D has somewhere to call without an
   * undefined-method crash.
   */
  setVelocity(upd) {
    const inst = this.entityMap.get((upd.guid >>> 0));
    if (!inst) return;
    inst.lastVel = {
      vx: upd.vx ?? 0,
      vy: upd.vy ?? 0,
      vz: upd.vz ?? 0,
      omegaZ: upd.omegaZ ?? 0,
    };
  }

  /**
   * Wave 7.3 (2026-05-24): mid-game equip change. The wasm UpdateObject
   * arm (lib.rs::GameMessage::UpdateObject) packs the four substitution-
   * relevant fields (modelChanges / textureChanges / subPalettes /
   * paletteId) into an `ENTITY_UPDATE_KIND_APPEARANCE` event; loop.js
   * routes it here.
   *
   * V1 strategy: despawn + respawn. Hot-swap (preserve mixer + actions
   * + bone state, replace only parts + materials) would avoid the
   * brief flicker but would require careful animation-state sync that
   * deserves its own validation. Despawn+respawn is robust + cheap +
   * the next KIND_POSITION re-syncs the entity to its current pose,
   * so the flicker is bounded to one frame in steady state.
   *
   * Pose preservation: read the current world pose off `inst.root`
   * (entity-instance positions are stored in AC world-frame per the
   * `picking.js::entityAcPosition` comment), convert back to LB-local
   * for the spawn meta, and pass it through so the respawn lands at
   * the current pose instead of the original spawn-time pose.
   *
   * Diag: fires `__diag.clothing.onAppearanceChange` with substitution
   * counts BEFORE the despawn, so the observation lands even if the
   * subsequent spawn errors.
   *
   * @param {number} guid
   * @param {{modelChanges?: Uint32Array, textureChanges?: Uint32Array,
   *          subPalettes?: Uint32Array, paletteId?: number}} opts
   * @returns {Promise<boolean>} true if dispatched, false if no entity
   *   existed for the guid.
   */
  async applyAppearance(guid, opts) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return false;

    const oldMeta = inst.meta || {};
    const newMeta = { ...oldMeta };
    if (opts?.modelChanges) newMeta.modelChanges = opts.modelChanges;
    if (opts?.textureChanges) newMeta.textureChanges = opts.textureChanges;
    if (opts?.subPalettes) newMeta.subPalettes = opts.subPalettes;
    if (opts?.paletteId !== undefined) newMeta.paletteId = (opts.paletteId >>> 0);

    // Wave 7.5 — try hot-swap when the URL flag is on. Hot-swap
    // preserves root + mixer + currently-playing action; only the
    // child Mesh contents of each inst.parts[p] Group get replaced.
    // On topology mismatch or any error, falls through to the W7.3
    // despawn+respawn path so the equip change still propagates.
    if (this._hotSwapAppearance) {
      try {
        const swapped = await this._applyAppearanceHotSwap(inst, newMeta, g);
        if (swapped) return true;
        // swapped=false → topology mismatch or unhandled fallback;
        // fall through to despawn+respawn.
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[applyAppearance] hot-swap threw on 0x${g.toString(16)}, falling back to despawn+respawn:`, e);
      }
    }

    // Preserve current world pose. `inst.root.position` is already in
    // AC world-frame (lbX*192 + local_x, etc); recompute LB-local so
    // the spawn path's `wx = lbX*192 + meta.x` rebuilds the same world
    // coords. Falls through to spawn-time pose if any field is missing.
    const root = inst.root;
    if (root?.position) {
      const lbId = (oldMeta.landblockId ?? 0) >>> 0;
      const lbX = (lbId >>> 24) & 0xff;
      const lbY = (lbId >>> 16) & 0xff;
      newMeta.x = root.position.x - lbX * 192;
      newMeta.y = root.position.y - lbY * 192;
      newMeta.z = root.position.z;
    }
    if (root?.quaternion) {
      newMeta.qw = root.quaternion.w;
      newMeta.qx = root.quaternion.x;
      newMeta.qy = root.quaternion.y;
      newMeta.qz = root.quaternion.z;
    }

    try {
      window.__diag?.clothing?.onAppearanceChange?.({
        guid: g,
        source: "wire-update-object",
        modelChangesCount: (opts?.modelChanges?.length ?? 0) / 2 | 0,
        textureChangesCount: (opts?.textureChanges?.length ?? 0) / 3 | 0,
        subPalettesCount: (opts?.subPalettes?.length ?? 0) / 3 | 0,
        paletteId: newMeta.paletteId ?? 0,
      });
    } catch (_) {}

    this.remove(g);
    await this.spawn(newMeta);
    return true;
  }

  /**
   * Wave 7.5 (2026-05-24): hot-swap variant of applyAppearance.
   * Preserves `inst.root` + `inst.mixer` + currently-playing
   * `inst.currentAction` — only the child Mesh contents of each
   * `inst.parts[p]` Group get replaced. The mixer continues driving
   * `parts[p].position` / `parts[p].quaternion` against the same
   * clip (cache returns a fresh animEntry post-W7.5 substitution-
   * aware cache key fix, but the clip's track NAMES match the old
   * one because partGroup naming `part_${p}` is identical for same
   * setupId).
   *
   * Returns true when the swap succeeded. Returns false when:
   *  - new animEntry.partGroups.length !== inst.parts.length
   *    (rig topology changed — caller should despawn+respawn)
   *  - any other recoverable mismatch
   * Throws on unexpected errors — caller's try/catch handles fallback.
   *
   * @private
   */
  async _applyAppearanceHotSwap(inst, newMeta, guid) {
    const setupId = (newMeta.modelId ?? newMeta.setupId ?? 0) >>> 0;
    if (!setupId) return false;
    const mtableId = (newMeta.mtableId ?? 0) >>> 0;
    // Use the entity's CURRENT motion/stance (mid-animation continuity),
    // falling back to spawn-time defaults if currentAction is null.
    const motion = (inst.currentMotion ?? newMeta.motionCommand ?? 0) >>> 0;
    const stance = (inst.currentStance ?? newMeta.motionStance ?? 0) >>> 0;
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return false;

    const animEntry = await this.animationCache.get(
      setupId, mtableId, motion, stance, fetchKeyframes,
      {
        modelChanges: newMeta.modelChanges ?? new Uint32Array(0),
        textureChanges: newMeta.textureChanges ?? new Uint32Array(0),
        paletteId: (newMeta.paletteId ?? 0) >>> 0,
        paletteSubsFlat: newMeta.subPalettes ?? new Uint32Array(0),
      }
    );

    const newPartGroups = Array.isArray(animEntry.partGroups)
      ? animEntry.partGroups
      : null;
    if (!newPartGroups) return false;
    if (newPartGroups.length !== inst.parts.length) {
      // Topology mismatch — caller despawn+respawn.
      return false;
    }

    // Collect new surface DIDs + decide entity-owned-materials vs cache.
    const allSurfaceDids = new Set();
    for (const pg of newPartGroups) {
      if (!pg) continue;
      for (const did of pg.surfaceDids) allSurfaceDids.add(did >>> 0);
    }
    const paletteId = (newMeta.paletteId ?? 0) >>> 0;
    const subPalettes = newMeta.subPalettes ?? new Uint32Array(0);
    const hasPaletteSubs = paletteId !== 0 || subPalettes.length > 0;

    let entityMaterials = null;
    if (hasPaletteSubs && typeof this.wasmExports?.fetchEntitySurfacesPixels === "function") {
      const dids = new Uint32Array([...allSurfaceDids]);
      if (dids.length > 0) {
        // Wave 7.7 — dye observability on the hot-swap path too.
        try {
          window.__diag?.clothing?.onDyeApplication?.({
            guid,
            source: "hot-swap",
            surfaceDidCount: dids.length,
            paletteId,
            subPaletteTripleCount: (subPalettes.length / 3) | 0,
          });
        } catch (_) {}
        const results = await this.wasmExports.fetchEntitySurfacesPixels(dids, paletteId, subPalettes);
        entityMaterials = new Map();
        const newOwnedMaterials = [];
        const newOwnedTextures = [];
        for (let i = 0; i < dids.length; i += 1) {
          const did = dids[i] >>> 0;
          const sp = results[i];
          if (!sp || sp.width === 0 || sp.height === 0) {
            entityMaterials.set(did, this.materialCache?.fallbackMaterial ?? this._fallbackMaterial());
            if (sp && typeof sp.free === "function") sp.free();
            continue;
          }
          const tex = surfacePixelsToTexture(sp.pixels, sp.width, sp.height);
          if (typeof sp.free === "function") sp.free();
          const mat = new THREE.MeshStandardMaterial({
            map: tex, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, transparent: false,
          });
          mat.name = `entity-${guid.toString(16)}-surface-${did.toString(16)}`;
          mat.userData = { ...(mat.userData || {}), __disposable: true };
          newOwnedMaterials.push(mat);
          newOwnedTextures.push(tex);
          entityMaterials.set(did, mat);
        }
        // Swap owned-asset bookkeeping. Old materials/textures get
        // disposed below after we detach the meshes referencing them.
        inst._pendingOwnedMaterials = newOwnedMaterials;
        inst._pendingOwnedTextures = newOwnedTextures;
      }
    } else if (allSurfaceDids.size > 0 && this.materialCache) {
      try {
        await this.materialCache.preload([...allSurfaceDids], this.wasmExports.fetch_surfaces_pixels);
      } catch (e) {
        try { window.__diag?.assets?.onMaterialError?.({ guid, dids: allSurfaceDids, error: e, source: "hot-swap" }); } catch (_) {}
      }
    }

    // Capture old owned assets for disposal AFTER we've detached the
    // meshes that hold material/geometry refs.
    const oldOwnedMaterials = inst.ownedMaterials.slice();
    const oldOwnedTextures = inst.ownedTextures.slice();

    // Detach all child Meshes of each inst.parts[p], then attach
    // new ones built from newPartGroups[p].
    for (let p = 0; p < inst.parts.length; p += 1) {
      const partGroup = inst.parts[p];
      // remove existing child meshes
      const oldChildren = partGroup.children.slice();
      for (const child of oldChildren) {
        partGroup.remove(child);
      }
      const conv = newPartGroups[p];
      if (!conv) continue;
      for (const grp of conv.groups) {
        const did = grp.surfaceDid >>> 0;
        let mat = null;
        if (entityMaterials && entityMaterials.has(did)) {
          mat = entityMaterials.get(did);
        } else if (this.materialCache) {
          mat = this.materialCache.getCached(did);
        } else {
          mat = this._fallbackMaterial();
        }
        const m = new THREE.Mesh(grp.geometry, mat);
        m.name = `part_${p}_surface_${did.toString(16)}`;
        m.userData = { guid, partIndex: p, surfaceDid: did };
        if (this.scene3d?.shadowsEnabled || this.scene3d?.csmEnabled) {
          m.castShadow = materialCanCastShadow(mat);
        }
        partGroup.add(m);
        inst.registerGeometry(grp.geometry);
      }
    }

    // Commit new owned-asset registry; dispose old ones now that
    // nothing references them.
    if (inst._pendingOwnedMaterials) {
      inst.ownedMaterials.length = 0;
      for (const m of inst._pendingOwnedMaterials) inst.ownedMaterials.push(m);
      delete inst._pendingOwnedMaterials;
    }
    if (inst._pendingOwnedTextures) {
      inst.ownedTextures.length = 0;
      for (const t of inst._pendingOwnedTextures) inst.ownedTextures.push(t);
      delete inst._pendingOwnedTextures;
    }
    inst._entityMaterials = entityMaterials;
    for (const m of oldOwnedMaterials) {
      try { m.dispose(); } catch (_) {}
    }
    for (const t of oldOwnedTextures) {
      try { t.dispose(); } catch (_) {}
    }

    // Update meta with new substitutions so future operations see
    // current state.
    inst.meta = newMeta;

    try {
      window.__diag?.clothing?.onAppearanceChange?.({
        guid,
        source: "hot-swap",
        modelChangesCount: ((newMeta.modelChanges?.length ?? 0) / 2) | 0,
        textureChangesCount: ((newMeta.textureChanges?.length ?? 0) / 3) | 0,
        subPalettesCount: ((newMeta.subPalettes?.length ?? 0) / 3) | 0,
        paletteId: (newMeta.paletteId ?? 0) >>> 0,
      });
    } catch (_) {}

    return true;
  }

  /**
   * Remove an entity by GUID. Tears down geometries, textures, mixer.
   */
  remove(guid) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return;
    // B4 (2026-05-18): drop the name→guid index entry BEFORE dispose
    // so we still have access to `inst.meta.name`. Removes the bucket
    // entirely once empty to avoid a long-session leak of empty Sets.
    if (inst.meta && typeof inst.meta.name === "string" && inst.meta.name.length > 0) {
      const bucket = this._nameToGuid.get(inst.meta.name);
      if (bucket) {
        bucket.delete(g);
        if (bucket.size === 0) this._nameToGuid.delete(inst.meta.name);
      }
    }
    inst.dispose();
    this.entityMap.delete(g);
    this.removeCount += 1;
    // Follow-on #10 (3D port state doc) — drop the DOM nameplate too.
    // Idempotent on the layer side (silent no-op for unknown GUIDs)
    // so a re-spawn that already removed its nameplate doesn't error.
    if (this.scene3d?.nameplateLayer) {
      try {
        this.scene3d.nameplateLayer.removeNameplate(g);
      } catch (_) {}
    }
    // H2 (2026-05-12): stop + destroy any particle emitters attached
    // to this entity. Without this, fireworks rocket emitters from
    // despawned rockets would keep spawning particles for their full
    // lifespan after the rocket disappeared.
    const emitterIds = this._particleEmittersForGuid.get(g);
    if (emitterIds && this._worldParticleManager) {
      for (const eId of emitterIds) {
        try {
          this._worldParticleManager.destroyParticleEmitter(eId);
        } catch (_) {}
      }
      this._particleEmittersForGuid.delete(g);
    }
    // H3-E1 (2026-05-12): cancel any pending Sound / SoundTweaked
    // setTimeout schedules. If we didn't, a sound queued at start_time
    // = 30s would fire 30s after the rocket already despawned.
    const timeouts = this._soundTimeoutsForGuid.get(g);
    if (timeouts) {
      for (const tid of timeouts) {
        try { clearTimeout(tid); } catch (_) {}
      }
      this._soundTimeoutsForGuid.delete(g);
    }
    this._particleChainsAttached.delete(g);
    // F.D-fu3: also drop the resolve-promise entry so a re-spawn
    // with the same GUID gets a fresh promise. The old promise has
    // already resolved by now in the common case (chain walks are
    // fast vs entity lifetime); we don't need to await it before
    // dropping the reference.
    this._particleChainResolveForGuid.delete(g);
  }

  /**
   * H2 (2026-05-12): walk an entity's PhysicsScript chain and attach
   * a ParticleManager emitter per CreateParticleHook (hookType 13 or
   * 26). Mirrors `sky_dome.js::_attachParticleChainFromState` but
   * anchors emitters on the entity's rig instead of the sky-cell
   * origin, so particles follow the entity if it moves (e.g. firework
   * rockets in flight).
   *
   * Chain: entity.physicsScriptDid (0x33..) → fetchPhysicsScript →
   * each CreateParticleHook → fetchParticleEmitter → addEmitter with
   * parent=entity.rig.
   *
   * Lazily creates `this._worldParticleManager` on first call. The
   * manager's scene is `entitiesGroup` so per-particle THREE.Meshes
   * are siblings of the entity rigs.
   */
  /**
   * 2026-05-18 motion-link experiment. Fetch a transition clip from
   * the MotionTable's Links table for `(stance, fromCmd → toCmd)`.
   * On hit, play it once (LoopOnce, clampWhenFinished=false) so the
   * rig animates the transition before the destination cycle takes
   * over. On miss, no-op — caller's existing crossfade-to-cycle
   * path runs unchanged.
   */
  async _tryPlayLink(inst, setupId, mtableId, fromCmd, toCmd, stance) {
    const fetchKeyframes = this.wasmExports?.fetchEntityAnimationKeyframes;
    if (typeof fetchKeyframes !== "function") return;
    let entry;
    try {
      entry = await this.animationCache.get(
        setupId,
        mtableId,
        toCmd,
        stance,
        fetchKeyframes,
        {
          modelChanges: inst.meta.modelChanges ?? new Uint32Array(0),
          textureChanges: inst.meta.textureChanges ?? new Uint32Array(0),
          paletteId: (inst.meta.paletteId ?? 0) >>> 0,
          paletteSubsFlat: inst.meta.subPalettes ?? new Uint32Array(0),
          fromMotion: fromCmd,
        },
      );
    } catch (_) {
      return;
    }
    if (!this.entityMap.has(inst.guid >>> 0)) return;
    const clip = entry?.clip;
    if (!clip) return; // No link registered for this transition.
    // Use a stable cache key so repeated transitions reuse the same
    // AnimationAction (mixer-bound bindings live per-entity).
    const linkKey = `link:${fromCmd.toString(16)}->${toCmd.toString(16)}:${stance.toString(16)}`;
    let action = inst.actions?.get(linkKey);
    if (!action) {
      inst.evictOldestUnused?.();
      action = inst.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = false;
      action.enabled = true;
      inst.actions?.set(linkKey, action);
    }
    // Register / refresh the hook timeline for this overlay clip so
    // `_tickAnimationHooks` fires Sound (sword swoosh, magic chime),
    // SoundTable, CreateParticle, and AttackHook strike-frame events
    // during the swing/cast. Without this the hook executor would
    // skip the overlay (it walks every running action, but `get(key)`
    // misses if no timeline was registered).
    //
    // Reset `actionLastHookTime` to 0 on every play() so a rapid
    // replay (spam-click attack) fires hooks from the top — the
    // following `action.reset()` rewinds `.time` to 0, and without
    // matching the lastTime reset the first tick would see
    // `currentTime=0 < lastTime=high` and trigger the wrap-around
    // re-fire branch.
    if (Array.isArray(entry.hooks) && entry.hooks.length > 0) {
      inst.hookTimelines.set(linkKey, entry.hooks);
    }
    inst.actionLastHookTime.set(linkKey, 0);
    try {
      action.reset();
      action.play();
      console.log(
        `[motion-link] 0x${(inst.guid >>> 0).toString(16)} ${fromCmd.toString(16)}→${toCmd.toString(16)} stance=${stance.toString(16)} (link clip played, ${entry.hooks?.length ?? 0} hooks)`,
      );
      // Follow-on hook for __diag.motion combat-swing observation.
      // The locomotion crossFadeTo path at L~2005 already lands on
      // onMotionApplied; this site is the link-clip path (attacks,
      // casts, gesture loops) which raw-plays without touching
      // inst.currentActionKey. Fires a SEPARATE link-played event so
      // the diag surface can tell "swung" apart from "transitioned
      // motion state" without one event blocking the other.
      if (typeof window !== "undefined" && window.__diag?.motion?.onMotionLinkPlayed) {
        try {
          window.__diag.motion.onMotionLinkPlayed({
            guid: inst.guid >>> 0,
            name: inst.meta?.name ?? "",
            fromCmd: fromCmd >>> 0,
            toCmd: toCmd >>> 0,
            stance: stance >>> 0,
            hookCount: entry.hooks?.length ?? 0,
            linkKey,
          });
        } catch (_) { /* never block the play path */ }
      }
    } catch (e) {
      console.warn(`[motion-link] play failed: ${e?.message ?? e}`);
    }
  }

  async _attachParticleChainForEntity(guid, rig, pesId) {
    // F.D-fu (2026-05-20): emit a chain-walker entry log so validators
    // (and devs eyeballing console) can correlate spawn dispatch with
    // chain-walker firing. Critical for diagnosing "no PhysicsScriptHook
    // events observed" — without this, a silent fetchPhysicsScript hang
    // (no throw, no resolve) is invisible.
    // eslint-disable-next-line no-console
    console.log(
      `[entities/H2] chain walker entered for guid=0x${guid.toString(16)} pes=0x${pesId.toString(16)}`
    );
    let ps;
    try {
      ps = await this.wasmExports.fetchPhysicsScript(pesId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[entities/H2] fetchPhysicsScript(0x${pesId.toString(16)}) failed:`,
        e
      );
      // F.D-fu3 — return a descriptor so callers can distinguish a
      // hard fetch failure from "no hooks found".
      return {
        ok: false,
        emitterCount: 0,
        soundHookCount: 0,
        reason: `fetchPhysicsScript_failed:${String(e?.message ?? e)}`,
      };
    }
    const entries = ps.takeEntries();
    // eslint-disable-next-line no-console
    console.log(
      `[entities/H2] chain walker fetched PS=0x${pesId.toString(16)} entries=${entries.length} for guid=0x${guid.toString(16)}`
    );

    // Lazy-create the world-side ParticleManager on first chain walk.
    // Imported here (not at top of file) so the test_phase7_4* harness
    // doesn't need the particles module in its composite source.
    if (!this._worldParticleManager) {
      const { ParticleManager } = await import("./particles/index.js");
      const adapter = await import("./adapter.js");
      const meshToGeometryGroups = adapter.meshToGeometryGroups;
      const materialCache = this.materialCache;
      const ents_wasm = this.wasmExports;
      // H3-bugfix (2026-05-12): same fix as sky_dome.js — must run
      // wasm-side mesh through meshToGeometryGroups to get a real
      // THREE.BufferGeometry. Otherwise new THREE.Mesh crashes with
      // "Cannot read properties of null (reading 'morphAttributes')".
      const resolveGfxObj = async (hwGfxObjId) => {
        if (!ents_wasm || typeof ents_wasm.fetchBuildingPlacement !== "function") {
          return null;
        }
        let bundle;
        try {
          bundle = await ents_wasm.fetchBuildingPlacement(hwGfxObjId);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            `[entities/H2] fetchBuildingPlacement(0x${hwGfxObjId.toString(16)}) failed:`,
            e
          );
          return null;
        }
        if ((bundle.partCount | 0) === 0) {
          if (typeof bundle.free === "function") bundle.free();
          return null;
        }
        const meshes = bundle.takePartMeshes();
        if (typeof bundle.free === "function") bundle.free();
        const wasmMesh = meshes[0];
        if (!wasmMesh) return null;
        const { groups, surfaceDids } = meshToGeometryGroups(wasmMesh);
        if (typeof wasmMesh.free === "function") wasmMesh.free();
        if (!groups || groups.length === 0) return null;
        return {
          geometry: groups[0].geometry,
          surfaceDid: groups[0].surfaceDid || surfaceDids[0] || 0,
        };
      };
      this._worldParticleManager = new ParticleManager({
        scene: this.scene3d?.entitiesGroup ?? rig.parent,
        geometryFactory: async (hwGfxObjId) => {
          const r = await resolveGfxObj(hwGfxObjId);
          return r?.geometry ?? null;
        },
        materialFactory: async (hwGfxObjId) => {
          if (!materialCache) return null;
          const r = await resolveGfxObj(hwGfxObjId);
          if (!r?.surfaceDid) return null;
          try {
            return await materialCache.get(
              r.surfaceDid,
              ents_wasm.fetch_surfaces_pixels
            );
          } catch (_) {
            return null;
          }
        },
      });
    }

    const THREE = (await import("three")).default ?? (await import("three"));
    // B2 (perf plan 2026-05-18): the per-hook `new Vector3(...)` /
    // `new Quaternion(...)` allocations these locals used to back are
    // now pooled into module-scope `_particleAttachScratch*` — the
    // dynamic import stays in case future hook arms need a fresh
    // class reference, but the locals it produced are no longer
    // referenced anywhere in this function.
    void THREE;

    const emitterIds = [];
    const timeoutIds = [];
    // Phase F.C — runtime event log probe (shared across the H2 walker's
    // Sound hook + CreateParticle hook arms).
    const pushEventRecord = this.scene3d?._pushEventRecord;
    for (const e of entries) {
      // H3-E1 (2026-05-12): Sound + SoundTweaked hooks fire WAVE
      // playback at `start_time` seconds after script attach. Wired
      // via the AudioManager when one is attached to scene3d.
      const audioMgr = this.scene3d?.audioManager;
      if ((e.hookType === 1 || e.hookType === 21) && audioMgr) {
        const waveId = e.soundWaveId >>> 0;
        if (waveId !== 0) {
          const probability = e.soundProbability;
          const volume = e.soundVolume > 0 ? e.soundVolume : 1.0;
          const delayMs = Math.max(0, e.startTime * 1000);
          const hookStartTime = +e.startTime;
          // Coin-flip on probability (only SoundTweaked has !=1.0).
          if (probability >= 1.0 || Math.random() < probability) {
            const tid = setTimeout(() => {
              // Read the entity's current world position at fire-time.
              // The rig was passed in; .position tracks the entity if
              // it has moved between attach + fire.
              const pos = {
                x: rig.position.x,
                y: rig.position.y,
                z: rig.position.z,
              };
              // Phase F.C — record the actual fire moment (after the
              // setTimeout delay), not the schedule moment. F.D's
              // validator time-correlates against the PhysicsScript
              // start_time + the attach instant.
              if (pushEventRecord) {
                pushEventRecord({
                  type: "sound",
                  wave_did: waveId,
                  parent_entity_guid: (guid >>> 0),
                  world_pos: [+pos.x, +pos.y, +pos.z],
                  t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
                  source: "PhysicsScriptHook",
                  source_meta: {
                    entity_guid: (guid >>> 0),
                    script_did: (pesId >>> 0),
                    start_time_s: hookStartTime,
                    hook_type: (e.hookType | 0),
                    gain: volume,
                  },
                });
              }
              audioMgr.play(waveId, pos, { gain: volume }).catch(() => {});
            }, delayMs);
            timeoutIds.push(tid);
          }
        }
        continue; // hook handled; don't fall through to emitter check
      }

      if (e.hookType !== 13 && e.hookType !== 26) continue;
      const emitterId = (e.createParticleEmitterId >>> 0);
      if (emitterId === 0) continue;

      let emitterInfo;
      try {
        emitterInfo = await this.wasmExports.fetchParticleEmitter(emitterId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/H2] fetchParticleEmitter(0x${emitterId.toString(16)}) failed:`,
          err
        );
        continue;
      }

      // Perf B2 (2026-05-18): scratch-pool the offset frame.
      // `ParticleManager.addEmitter` eventually calls
      // `ParticleEmitter.setParenting(partIdx, offsetFrame)` which
      // `.copy()`s position + quaternion into the emitter's persistent
      // `parentOffset` (particle_emitter.js:114-118). Within a single
      // `_attachParticleChainForEntity` call the for-loop awaits each
      // `addEmitter` before iterating, so the scratches are safe to
      // reuse across hook entries in the same chain walk.
      //
      // CAVEAT: addEmitter is async and has multiple awaits
      // (geometryFactory, materialFactory, setInfo) BEFORE setParenting
      // runs. If two `_attachParticleChainForEntity` calls overlap (the
      // outer call site is fire-and-forget at entities.js:912), caller
      // B can overwrite the scratch values between caller A's `.set()`
      // here and caller A's eventual `setParenting`. The race window
      // is narrow and the visual effect is a wrong particle offset on
      // one emitter — not catastrophic, but worth a follow-on if
      // overlapping bulk spawns produce visible artifacts. A safer
      // long-term fix would be a per-call scratch pair or changing the
      // `addEmitter` contract to consume the offset synchronously.
      _particleAttachScratchVec3.set(
        e.createParticleOffsetX,
        e.createParticleOffsetY,
        e.createParticleOffsetZ,
      );
      _particleAttachScratchQuat.set(
        e.createParticleOffsetQX,
        e.createParticleOffsetQY,
        e.createParticleOffsetQZ,
        e.createParticleOffsetQW,
      );
      const offset = {
        position: _particleAttachScratchVec3,
        quaternion: _particleAttachScratchQuat,
      };

      const partIndex = (e.createParticlePartIndex === 0xffffffff)
        ? -1
        : (e.createParticlePartIndex | 0);

      // F.D-fu (2026-05-20): record the CreateParticle hook FIRING (the
      // contract-level event per docs/event-completeness-method.md
      // §P1 — entity-anchored PhysicsScript hooks) IMMEDIATELY at hook-
      // iteration time, BEFORE the slow addEmitter await. The
      // contract's "did this event fire?" is satisfied when the chain
      // walker DISPATCHES the hook (the emitterId is resolved from
      // the script entry, partIndex is determined, the chain walker
      // has reached the addEmitter call site). Whether addEmitter
      // succeeds at building the visual is QoS downstream of the
      // contract — setInfo can return 0 when the emitter's hwGfxObjId
      // yields a 0-part building bundle, and the wasm geometry/
      // material fetches addEmitter awaits internally can take ~30+s
      // each under headless software-GL. Under those conditions a
      // validator snapshot at +60s would see 0 fires; pushing the
      // record at dispatch time surfaces the contract-level event
      // immediately. The `visual_landed` field stays `false` here;
      // production observers that care about visual landing should
      // consult `_particleEmittersForGuid.get(guid)` separately.
      const firePos = {
        x: rig.position.x,
        y: rig.position.y,
        z: rig.position.z,
      };
      const fireMeta = {
        entity_guid: (guid >>> 0),
        script_did: (pesId >>> 0),
        start_time_s: +e.startTime,
        hook_type: (e.hookType | 0),
        part_index: partIndex,
        offset_x: +e.createParticleOffsetX,
        offset_y: +e.createParticleOffsetY,
        offset_z: +e.createParticleOffsetZ,
      };
      if (pushEventRecord) {
        pushEventRecord({
          type: "particle",
          emitter_did: (emitterId >>> 0),
          parent_entity_guid: (guid >>> 0),
          world_pos: [+firePos.x, +firePos.y, +firePos.z],
          t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
          source: "PhysicsScriptHook",
          source_meta: { ...fireMeta, visual_landed: false, dispatched: true },
        });
      }
      // F.D-fu (2026-05-20): fire-and-forget the visual addEmitter so
      // the for-loop iteration doesn't block on per-emitter wasm
      // geometry/material fetches. Under headless software-GL each
      // addEmitter can take ~30+s for a fresh hwGfxObjId pair (the
      // takram bake + GPU stall path); serial-await across 3 entries
      // pushed total chain walk past validator snapshot windows.
      // Visual rendering completes in the background; emitterIds
      // collects as each promise resolves so `_particleEmittersForGuid`
      // eventually contains the right set. Behaviour-wise this means
      // emitterIds order can differ from manifest order on slow-
      // emitter cases, but no caller asserts ordering on that map.
      const emitterIdForCatch = (emitterId >>> 0);
      this._worldParticleManager.addEmitter({
        emitterInfo,
        parent: rig,  // <-- the entity rig (THREE.Group); .position + .quaternion track the entity
        partIndex,
        parentOffset: offset,
      })
        .then((id) => {
          if (id !== 0) {
            emitterIds.push(id);
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[entities/H2] addEmitter(0x${emitterIdForCatch.toString(16)}) failed:`,
            err
          );
        });
    }
    if (emitterIds.length > 0) {
      this._particleEmittersForGuid.set(guid, emitterIds);
      // eslint-disable-next-line no-console
      console.log(
        `[entities/H2] attached ${emitterIds.length} particle emitters ` +
          `for entity 0x${guid.toString(16)} (PES 0x${pesId.toString(16)})`
      );
    }
    if (timeoutIds.length > 0) {
      this._soundTimeoutsForGuid.set(guid, timeoutIds);
      // eslint-disable-next-line no-console
      console.log(
        `[entities/H3-E1] scheduled ${timeoutIds.length} sound hooks ` +
          `for entity 0x${guid.toString(16)} (PES 0x${pesId.toString(16)})`
      );
    }
    // F.D-fu3 (2026-05-20): return a descriptor so callers can
    // observe what actually landed without polling the internal Maps.
    return {
      ok: true,
      emitterCount: emitterIds.length,
      soundHookCount: timeoutIds.length,
    };
  }

  /**
   * F.D-fu3 (2026-05-20) — await the H2 particle chain walker's
   * resolution for `guid`. Returns the descriptor produced by
   * `_attachParticleChainForEntity` (with `ok`, `emitterCount`,
   * `soundHookCount`, optional `reason`), or `null` if the entity
   * never had a PhysicsScript DID + thus never started a chain walk
   * (which is the common case for most weenies).
   *
   * Used by validators (Phase F.D) to wait for the chain to land
   * BEFORE snapshotting the event log, instead of guessing a settle
   * time. Mirrors the `spawnInFlight` pattern at line 786 — the
   * promise is created at chain-walk dispatch time and stays in
   * the Map across the walker's `fetchPhysicsScript` → loop →
   * `fetchParticleEmitter` → `addEmitter` chain.
   *
   * @param {number} guid
   * @returns {Promise<{ok: boolean, emitterCount: number, soundHookCount: number, reason?: string}|null>}
   */
  async awaitParticleChainResolution(guid) {
    const g = (guid >>> 0);
    const p = this._particleChainResolveForGuid.get(g);
    if (!p) return null;
    return p;
  }

  /**
   * F.D-fu3 (2026-05-20) — await the SPAWN resolution for `guid`.
   * Returns the `EntityInstance` once the `_spawnImpl` async chain
   * has fully resolved (rig built, meta populated, prewarm fired),
   * or `null` if the entity isn't currently in-flight AND not in
   * the entityMap. If the entity is already fully spawned, returns
   * the existing instance synchronously (Promise resolves on next
   * tick). If a spawn IS in flight, returns the in-flight promise.
   *
   * Validators call this BEFORE `awaitParticleChainResolution` so
   * they wait for the spawn → chain dispatch BEFORE waiting on
   * the chain itself. (Chain dispatch only happens once the
   * spawn's `_spawnImpl` reaches line ~1187.)
   *
   * @param {number} guid
   * @returns {Promise<object|null>}
   */
  async awaitSpawnResolution(guid) {
    const g = (guid >>> 0);
    const inFlight = this.spawnInFlight.get(g);
    if (inFlight) return inFlight;
    const inst = this.entityMap.get(g);
    if (inst) return inst;
    return null;
  }

  /**
   * Phase 7.5 — local player world-position resolver for the camera
   * switcher. Returns AC world coordinates `{x, y, z}` for the entity
   * whose GUID matches `getLocalPlayerGuid()` if exposed on window, or
   * null when no local player is identified yet.
   *
   * Mirrors the 2D path's `centreOnPlayer` localPlayerGuid lookup at
   * `index.html:5597-5603` so the 3D follow camera tracks the same
   * sprite the 2D path centres on. The 2D path stores sprite.x /
   * sprite.y in world AC metres; the 3D path stores root.position
   * with the same convention, so the two converge on identical
   * coordinates when both renderers consume the same entity stream.
   *
   * Falls back to null when no local player is known; the caller
   * (CameraSwitcher._safePlayerPos) then falls back to the Holtburg
   * centre. That keeps the camera framed before the first PUP lands.
   */
  getLocalPlayerWorldPos() {
    // eslint-disable-next-line no-undef
    if (typeof window === "undefined") return null;
    // Workstream B (2026-05-11) — prefer the cameraSwitcher's
    // client-side predicted pose if it's been seeded. The predicted
    // pose advances every rAF along the WASD intent vector + reconciles
    // against the 30 Hz authoritative KIND_POSITION emit, giving the
    // follow camera a smooth 60 FPS player track instead of the
    // discrete server-step jitter the bare `__lastEntityWorldPos` read
    // produces. Falls through to the original three-tier resolution
    // pre-spawn (predictedPlayerPos is null until the first server pose
    // arrives) or in the unit-test path (no liveScene3d on window).
    //
    // eslint-disable-next-line no-undef
    const cs = window.liveScene3d?.cameraSwitcher;
    if (cs && typeof cs.getPredictedPlayerWorldPos === "function") {
      const predicted = cs.getPredictedPlayerWorldPos();
      if (predicted) return predicted;
    }
    // eslint-disable-next-line no-undef
    const lpgFn = window.getLocalPlayerGuid;
    let guid = (typeof lpgFn === "function") ? lpgFn() : null;
    // GUID-prefix fallback: the wasm-side eager-WorldState path on
    // SelectCharacter suppresses the kind=1/kind=7 ClientEvents, so
    // setLocalPlayerGuid is never called and the page-level lookup
    // returns null. AC's 32-bit GUIDs are namespaced — 0x5xxxxxxx is
    // the player-character tier, 0x8xxxxxxx is dynamic spawn (NPCs),
    // 0x7xxxxxxx is world-static. The KIND_POSITION stream in
    // __lastEntityWorldPos still carries the player's pose; scan for
    // the first 0x5-prefix key as a fallback identifier. If none is
    // present yet (pre-spawn frames), fall through to a null return.
    if ((guid === null || guid === undefined)
      // eslint-disable-next-line no-undef
      && window.__lastEntityWorldPos) {
      // eslint-disable-next-line no-undef
      for (const k of window.__lastEntityWorldPos.keys()) {
        if (((k >>> 0) & 0xF0000000) === 0x50000000) {
          guid = k >>> 0;
          break;
        }
      }
    }
    if (guid === null || guid === undefined) return null;
    const guidU32 = guid >>> 0;
    const inst = this.entityMap.get(guidU32);
    if (inst && inst.root) {
      return {
        x: inst.root.position.x,
        y: inst.root.position.y,
        z: inst.root.position.z,
      };
    }
    // Fallback: the wasm-side's eager-WorldState path on SelectCharacter
    // suppresses the KIND_SPAWN entity-update for the local player, so
    // the 3D EntityManager never builds a rig. The 2D path's entityMap
    // (`window.entityMap`, exposed at index.html:2430) is seeded by the
    // same ObjectCreate flow and tracks the player's authoritative
    // world position in `sprite.x` / `sprite.y` (AC world metres). Use
    // the 2D entry as the camera-follow source until the wasm-side
    // gains a local-player KIND_SPAWN emission.
    // eslint-disable-next-line no-undef
    const twoDMap = window.entityMap;
    const twoDEntry = twoDMap && typeof twoDMap.get === "function"
      ? twoDMap.get(guidU32)
      : null;
    if (twoDEntry && twoDEntry.sprite) {
      return {
        x: twoDEntry.sprite.x,
        y: twoDEntry.sprite.y,
        // 2D sprites don't carry world-Z; the wasm-side authoritative
        // pose isn't directly readable, but `__predLastPos` reflects
        // the last predicted Z when one was set. Default to 80 (typical
        // Holtburg outdoor Z) to keep the camera at eye-height — the
        // follow-camera's vertical framing tolerates ±a few metres.
        z: 80,
      };
    }
    // Third-tier fallback: every KIND_POSITION drained by the shared
    // hook is stashed in `window.__lastEntityWorldPos` regardless of
    // whether either entityMap ever spawned a rig. Even with both
    // upstream maps missing the player, this carries the wasm-side
    // pose (the same one the heartbeat trace prints) so the camera
    // tracks teleports + walks without requiring a wasm rebuild to
    // emit KIND_SPAWN for the eager-WorldState path.
    // eslint-disable-next-line no-undef
    const lastMap = window.__lastEntityWorldPos;
    if (lastMap && typeof lastMap.get === "function") {
      const p = lastMap.get(guidU32);
      if (p) {
        return { x: p.x, y: p.y, z: p.z };
      }
    }
    return null;
  }

  /**
   * Follow-on #2 (2026-05-10) — local player's facing in the
   * CameraSwitcher.followYaw convention (clockwise-from-north). Used by
   * `computeMovementFromKeys` in follow mode to compute a heading-error
   * `turn` delta so WASD direction in world space converges on
   * camera-facing even before the player's heading has aligned.
   *
   * Convention bridge:
   *   - `acQuatToThree` reorders (qw,qx,qy,qz) → three (qx,qy,qz,qw)
   *     and `setPose` writes that onto `inst.root.quaternion`.
   *   - Three's Quaternion stores (x, y, z, w) so the AC w lives at
   *     `.w` and the AC z (the yaw axis for an upright body) lives at
   *     `.z`. The yaw extraction below uses the same formula as the
   *     2D path's `quaternionToYaw` (`index.html:2757-2762`).
   *   - The raw yaw is a counter-clockwise rotation around +Z (the
   *     right-hand rule convention three.js + the AC quaternion
   *     family share). `followYaw` is a clockwise-from-+Y-north
   *     compass-bearing convention (camera.js header: yaw=0 → north,
   *     yaw=π/2 → east). The two differ by sign, so we NEGATE.
   *
   * Returns 0 when no local player is known so `headingError = followYaw`
   * → behaviour collapses to "rotate to camera-facing", which is the
   * sensible pre-spawn default (no walking happens pre-EnteredWorld
   * anyway, so the turn delta is harmless).
   */
  getLocalPlayerHeading() {
    // eslint-disable-next-line no-undef
    if (typeof window === "undefined") return 0;
    // eslint-disable-next-line no-undef
    const lpgFn = window.getLocalPlayerGuid;
    if (typeof lpgFn !== "function") return 0;
    const guid = lpgFn();
    if (guid === null || guid === undefined) return 0;
    const inst = this.entityMap.get((guid >>> 0));
    if (!inst || !inst.root) return 0;
    // three.js Quaternion has (x, y, z, w); after acQuatToThree, .z is
    // the AC z-axis component and .w is the AC w. Yaw extraction
    // matches the 2D path's quaternionToYaw exactly.
    const q = inst.root.quaternion;
    const qw = q.w;
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    const rawYaw = Math.atan2(
      2 * (qw * qz + qx * qy),
      1 - 2 * (qy * qy + qz * qz)
    );
    // Convert CCW-around-+Z (raw quaternion yaw) → CW-from-+Y-north
    // (followYaw convention) by negation. Verified against
    // `from_heading` in `holtburger_common::math::Quaternion` for the
    // four cardinals: N→0, E→π/2, S→π, W→-π/2.
    return -rawYaw;
  }

  /**
   * Wave 5 / Phase 9 (2026-05-26) — defender heading accessor for
   * Sneak Attack prediction. Returns the entity's raw yaw in radians
   * (CCW-around-+Z math convention, same shape as
   * `LocalPlayerPose::heading` from `src/lib.rs:20535-20537` and the
   * wire-side quaternion's `atan2(2(qw·qz + qx·qy), 1 - 2(qy² + qz²))`
   * extraction). NOT negated — unlike `getLocalPlayerHeading()` which
   * converts to the followYaw camera convention, this getter returns
   * the raw yaw so it can be passed directly into
   * `ui/ac_sneak_attack_predict.js::isAttackerBehindDefender` whose
   * AC-forward derivation is `(-sin h, cos h, 0)`.
   *
   * Returns `null` when the entity is unknown OR its rig has not yet
   * been built (no `inst.root.quaternion` available). Callers MUST
   * gate the predictor call on a non-null return — the helper is
   * conservative on `null` headings but skipping the call avoids the
   * cost of building the `pose` object only to throw it away.
   *
   * @param {number} guid — entity GUID to query
   * @returns {number | null} raw yaw in radians, or null if unknown
   */
  getHeading(guid) {
    const g = (guid >>> 0) || 0;
    if (g === 0) return null;
    const inst = this.entityMap.get(g);
    if (!inst || !inst.root || !inst.root.quaternion) return null;
    const q = inst.root.quaternion;
    // Same `atan2(siny_cosp, cosy_cosp)` extraction as
    // `getLocalPlayerHeading()` above + `publish_local_player_pose`
    // in `src/lib.rs`. Note three's `Quaternion` stores `(x, y, z, w)`
    // and `acQuatToThree` re-orders the AC `(qw, qx, qy, qz)` wire
    // tuple into that slot, so `.w` and `.z` here are the AC w / z
    // components directly.
    const qw = q.w;
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    return Math.atan2(
      2 * (qw * qz + qx * qy),
      1 - 2 * (qy * qy + qz * qz),
    );
  }

  /**
   * Perf B1 (2026-05-18) — gate predicate for `tick(dt)`. Returns
   * `true` when the entity should run its full per-frame update
   * (mixer.update + hook fire + jump/swing tween advance), `false`
   * when it can be safely skipped this tick.
   *
   * Force-tick exceptions (always returns `true`):
   *   1. Local player — `window.getLocalPlayerGuid()` matches the
   *      entity's guid. The local rig is visible to the user even in
   *      top-down/free cams where the camera is far from the body, so
   *      we never skip its mixer. Handles the function-missing case
   *      (pre-spawn frames, unit-test path with no window) gracefully
   *      by treating it as "not the local player" and falling through
   *      to the distance check.
   *   2. Active jump-pose tween — `inst._jumpPoseTween` truthy. The
   *      tween needs every tick to complete its triangle-wave slerp;
   *      pausing mid-air would leave the rig locked in the airborne
   *      pose after landing.
   *   3. Active swing-pose tween — `inst._swingTween` truthy. Same
   *      reason: the 300 ms slerp needs every tick or the arm sticks
   *      out after the visible swing window has passed.
   *   4. Within tick radius — entity world-space position is within
   *      `MAX_TICK_DIST` metres of the active camera.
   *
   * TODO (B1 follow-on) — additional "currently active" predicates:
   *   - particle-attach hooks fired on this entity (need a hook-fire
   *     timestamp on `inst`; the file doesn't track one today),
   *   - spell-effect bind to a remote target (currently lives on the
   *     particle runtime, not the entity),
   *   - targeted-by-local-player (the picking layer holds the
   *     selection guid; threading it through scene3d would let us
   *     keep a stalker target ticking off-screen).
   *   Each of these is a separate PR — the MVP keeps the predicate
   *   coupled to state already on `inst`.
   */
  _shouldTickEntity(inst) {
    // (1) Local player — always tick.
    let localPlayerGuid = null;
    try {
      // eslint-disable-next-line no-undef
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        // eslint-disable-next-line no-undef
        const lpg = window.getLocalPlayerGuid();
        if (lpg !== null && lpg !== undefined) {
          localPlayerGuid = lpg >>> 0;
        }
      }
    } catch (_) {
      // Function exists but threw — treat as "no local player resolved"
      // and fall through to the other gates.
    }
    if (localPlayerGuid !== null && (inst.guid >>> 0) === localPlayerGuid) {
      return true;
    }
    // (2) Active jump-pose tween — always tick to finish the slerp.
    if (inst._jumpPoseTween) return true;
    // (3) Active swing-pose tween — always tick to finish the slerp.
    if (inst._swingTween) return true;
    // (4) Distance gate — same camera-resolution convention as
    // `capActiveLightsByDistance` in lighting.js (Phase 7.5 switcher
    // first, fall back to `.camera`). Bail open (return `true` —
    // preserve original behaviour) when no camera is resolvable so
    // pre-camera-init frames don't silently freeze every animation.
    const camera =
      this.scene3d?.cameraSwitcher?.activeCamera ??
      this.scene3d?.camera ??
      null;
    if (!camera || !camera.position || !inst.root) {
      return true;
    }
    // Entity rigs live under worldRoot (which is rotated -π/2 around
    // X) so we need the WORLD-space position — matches the lighting
    // pattern at lighting.js:549-555. Use the scratch Vector3 so we
    // don't allocate per-entity per-frame.
    if (typeof inst.root.getWorldPosition === "function") {
      inst.root.getWorldPosition(_tickGateScratch);
    } else if (inst.root.position) {
      _tickGateScratch.set(
        inst.root.position.x,
        inst.root.position.y,
        inst.root.position.z
      );
    } else {
      // No position to compare — bail open.
      return true;
    }
    const dx = _tickGateScratch.x - camera.position.x;
    const dy = _tickGateScratch.y - camera.position.y;
    const dz = _tickGateScratch.z - camera.position.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    return distSq <= MAX_TICK_DIST_SQ;
  }

  /**
   * Per-rAF tick. Advances every entity's mixer by dt seconds.
   * Called from loop.js#tickPerFrame.
   */
  tick(dt) {
    if (!(dt > 0)) return;
    for (const inst of this.entityMap.values()) {
      // Perf B1 (2026-05-18) — distance + local-player + active-tween
      // gate. When false, skip mixer.update, hook execution, and the
      // jump/swing tween advances entirely. `inst.root.position`,
      // `inst.lastVel`, etc., are written by setPose / setVelocity
      // (not by tick), so skipping the tick body leaves them
      // readable for downstream consumers. Animation snap on
      // re-entry is the documented MVP trade.
      if (!this._shouldTickEntity(inst)) continue;
      try {
        inst.mixer.update(dt);
      } catch (e) {
        // Don't let one bad mixer kill the whole tick.
        // eslint-disable-next-line no-console
        if (!this._mixerWarned) {
          this._mixerWarned = true;
          console.warn("[phase7.4b] mixer.update threw:", e);
        }
      }
      // Task E (2026-05-12): AnimationMixer hook execution.
      // After advancing the mixer, fire any baked-cycle hooks whose
      // time-in-clip we crossed this tick. Wrapped in try/catch so a
      // bad single-entity hook doesn't tank the whole tick.
      try {
        this._tickAnimationHooks(inst);
      } catch (e) {
        // eslint-disable-next-line no-console
        if (!this._hookTickWarned) {
          this._hookTickWarned = true;
          console.warn(
            `[entities/task-E] hook tick failed for entity 0x${inst.guid.toString(16)}:`,
            e
          );
        }
      }
      // Jump-pose tween advance. Runs AFTER mixer.update so our
      // per-part slerp wins on the locked-out arm/leg quaternions
      // for the duration of the airborne tween. No-op when no
      // tween is active.
      if (inst._jumpPoseTween) {
        try {
          this._tickJumpPoseTween(inst, performance.now());
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._jumpTweenWarned) {
            this._jumpTweenWarned = true;
            console.warn(
              `[entities/jump-tween] tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
        }
      }
      // Phase C — swing-pose tween. Same post-mixer ordering as the
      // jump pose so the arm rotation wins for the swing duration.
      if (inst._swingTween) {
        try {
          this._tickSwingTween(inst, performance.now());
        } catch (e) {
          // eslint-disable-next-line no-console
          if (!this._swingTweenWarned) {
            this._swingTweenWarned = true;
            console.warn(
              `[entities/swing-tween] tick failed for entity 0x${inst.guid.toString(16)}:`,
              e
            );
          }
        }
      }
    }
    // H2 (2026-05-12): advance the world-side particle runtime. The
    // ParticleManager is lazily created on the first attach; tick is
    // a no-op when null.
    if (this._worldParticleManager) {
      try {
        this._worldParticleManager.tick();
      } catch (e) {
        // eslint-disable-next-line no-console
        if (!this._particleTickWarned) {
          this._particleTickWarned = true;
          console.warn("[entities/H2] worldParticleManager.tick threw:", e);
        }
      }
    }
  }

  /**
   * Task E (2026-05-12) — fire any AnimationHook entries whose
   * time-in-clip the current action just crossed.
   *
   * Algorithm:
   *   1. Resolve the currently-playing action + its cacheKey.
   *      Bail if no action (rest pose) or no timeline registered for
   *      the current action.
   *   2. Read `action.time` (three.js's per-action playback time,
   *      seconds since the action started or was last `.reset()`'d;
   *      monotonically increasing within a loop pass, wraps to 0
   *      when the clip loops).
   *   3. Read `lastTime = inst.actionLastHookTime.get(cacheKey)` —
   *      where we left off last tick. Initialised to 0 in
   *      `_spawnImpl` / `setMotion` when the timeline is first
   *      stashed.
   *   4. Walk the sorted hook list:
   *      - Normal case (`currentTime >= lastTime`): fire each hook
   *        with `lastTime < hook.time <= currentTime`.
   *      - Wrap case (`currentTime < lastTime`): the clip looped.
   *        Fire hooks in `(lastTime, clipDuration]` AND `[0, currentTime]`.
   *        Both branches respect the sorted order; the wrap branch
   *        walks the tail of the list then the head.
   *   5. Save `currentTime` as the new `lastTime`.
   *
   * Hook handlers (this task lands Sound + SoundTable only):
   *   - hookType 1 (Sound): hook.soundWaveId is the Wave DID to play.
   *     Call `audioManager.play(waveId, entity.position)`.
   *   - hookType 2 (SoundTable): hook.soundEnum is the Sound enum to
   *     resolve through the entity's SoundTable.
   *     `await soundTableCache.resolveSound(inst.soundTableDid,
   *     soundEnum)` returns `{waveDid, ...}` or null. Fire-and-forget
   *     — the prewarm in `_spawnImpl` makes the await effectively
   *     synchronous after the first frame.
   *   - hookType 13 (CreateParticle), 21 (SoundTweaked), others —
   *     TODO debug-stub. Counts via `inst._unhandledHookFires` so
   *     the diag script can verify the handler reaches them.
   */
  _tickAnimationHooks(inst) {
    // Walk EVERY running action on the mixer — `inst.currentAction`
    // (the locomotion cycle) AND any one-shot overlay actions like
    // the swing/cast link clips played via `_tryPlayLink`. The
    // pre-fix version only inspected `currentAction`, so combat
    // overlays' hooks (sword swoosh on type=1 Sound, magic chime
    // resolved through type=2 SoundTable, future AttackHook
    // strike-frame events) never fired.
    //
    // For an action that finished (LoopOnce past duration,
    // `isRunning() === false`) we skip — three.js stops advancing
    // `.time` so re-firing trailing hooks would be a bug.
    if (!inst.actions || inst.actions.size === 0) return;
    const audioMgr = this.scene3d?.audioManager ?? null;
    const cache = this.scene3d?.soundTableCache ?? null;
    for (const [key, action] of inst.actions) {
      if (!action || !action.isRunning()) continue;
      const timeline = inst.hookTimelines.get(key);
      if (!timeline || timeline.length === 0) continue;
      // three.js exposes `AnimationAction.time` as time-in-clip
      // (seconds within the action's clip; for LoopRepeat actions, it
      // wraps to 0 at duration each pass).
      let currentTime = 0;
      let clipDuration = 0;
      try {
        currentTime = +action.time;
        const clip = action.getClip();
        clipDuration = clip ? +clip.duration : 0;
      } catch (_) {
        continue;
      }
      if (!(clipDuration > 0)) continue;
      let lastTime = inst.actionLastHookTime.get(key);
      if (lastTime === undefined) lastTime = 0;
      if (currentTime >= lastTime) {
        // Common case: monotonic advance within one loop pass.
        this._fireHooksInRange(inst, timeline, lastTime, currentTime, audioMgr, cache);
      } else {
        // Wrap-around: a LoopRepeat cycle wrapped past clip end. Fire
        // (lastTime, clipDuration] then (-Inf, currentTime]. LoopOnce
        // overlays don't wrap, so this branch fires for locomotion only.
        this._fireHooksInRange(inst, timeline, lastTime, clipDuration, audioMgr, cache);
        this._fireHooksInRange(inst, timeline, -Infinity, currentTime, audioMgr, cache);
      }
      inst.actionLastHookTime.set(key, currentTime);
    }
  }

  /**
   * Walk a sorted-by-time hook list and fire those in
   * `(lowExclusive, highInclusive]`. Sound (1) + SoundTable (2)
   * land audio playback; other hook types increment a debug counter
   * so the diag-script can assert the executor reached them.
   *
   * Called by `_tickAnimationHooks` — split out so the wrap-around
   * branch can reuse the same range walker for both halves of the
   * looped range.
   */
  _fireHooksInRange(inst, timeline, lowExclusive, highInclusive, audioMgr, cache) {
    // Binary search would be faster for very long timelines, but
    // retail clips have 0-20 hooks max so linear scan is fine and
    // simpler to verify.
    for (let i = 0; i < timeline.length; i += 1) {
      const h = timeline[i];
      const t = h.time;
      if (t <= lowExclusive) continue;
      if (t > highInclusive) break; // sorted asc — no later entries match
      this._fireHook(inst, h, audioMgr, cache);
    }
  }

  /**
   * Dispatch one hook to the appropriate handler.
   * Sound (1) + SoundTable (2) play audio via the AudioManager;
   * CreateParticle (13) + SoundTweaked (21) + others are debug-counted
   * (Task E scope is Sound + SoundTable; the rest are follow-ons).
   */
  _fireHook(inst, hook, audioMgr, cache) {
    const hookType = hook.hookType | 0;
    const pos = inst.root.position;
    // Phase F.C — runtime event log probe. Same no-op stub shape as
    // every other source; reading via the scene3d ref is cheap.
    const pushEventRecord = this.scene3d?._pushEventRecord;
    if (hookType === 1) {
      // Sound — payload is a Wave DID. Play directly.
      const waveId = hook.soundWaveId >>> 0;
      if (waveId === 0 || !audioMgr) return;
      // Position is read at fire-time so the panner pans to the
      // entity's current location (matches PhatSDK retail behaviour
      // — sound positions update with the body during animation).
      if (pushEventRecord) {
        pushEventRecord({
          type: "sound",
          wave_did: waveId,
          parent_entity_guid: (inst.guid >>> 0),
          world_pos: [+pos.x, +pos.y, +pos.z],
          t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
          source: "AnimationHook",
          source_meta: {
            entity_guid: (inst.guid >>> 0),
            motion_command: (inst.currentActionKey ?? null),
            // stance is folded into currentActionKey; no separate field
            // on EntityInstance (the (cmd, stance) tuple is the cache key).
            hook_type: 1,
            hook_time: +hook.time,
          },
        });
      }
      audioMgr
        .play(waveId, { x: pos.x, y: pos.y, z: pos.z })
        .catch(() => {});
      this._soundHookFires = (this._soundHookFires | 0) + 1;
      return;
    }
    if (hookType === 2) {
      // SoundTable — payload is a Sound enum. Resolve via the entity's
      // SoundTable to get a Wave DID + per-row volume.
      const soundEnum = hook.soundEnum >>> 0;
      if (soundEnum === 0 || !cache || !audioMgr) return;
      const stbDid = inst.soundTableDid >>> 0;
      if (stbDid === 0) {
        // No SoundTable on this entity's weenie. Silent no-op — this
        // is a normal outcome for entities whose animations carry
        // SoundTable hooks but whose weenie has no SoundTable property
        // (e.g. shared rig + non-vocal subclass). No log spam.
        return;
      }
      // Fire-and-forget: the prewarm in `_spawnImpl` warms the cache
      // by the second frame, so by the time hooks fire (cycle frame
      // count typically > 1) the await on `resolveSound` is on a
      // settled Promise.
      cache
        .resolveSound(stbDid, soundEnum)
        .then((entry) => {
          if (!entry) return; // soft null — Sound enum not in this STB
          const gain = entry.volume > 0 ? entry.volume : 1.0;
          // Snapshot pos again at await-resolution time so a moving
          // entity's audio lands at its current location, not where
          // it was at hook-fire time. (For instant-resolve from a
          // warm cache the two are identical.)
          const px = inst.root.position.x;
          const py = inst.root.position.y;
          const pz = inst.root.position.z;
          // Phase F.C — emit event log record BEFORE play(). Source
          // is still "AnimationHook" (the hook is the trigger; the
          // SoundTable resolve is just the lookup mechanism). The
          // hookType field disambiguates from raw Sound (1) hooks.
          if (pushEventRecord) {
            pushEventRecord({
              type: "sound",
              wave_did: (entry.waveDid >>> 0),
              parent_entity_guid: (inst.guid >>> 0),
              world_pos: [+px, +py, +pz],
              t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
              source: "AnimationHook",
              source_meta: {
                entity_guid: (inst.guid >>> 0),
                motion_command: (inst.currentActionKey ?? null),
                // stance is folded into currentActionKey; no separate field
            // on EntityInstance (the (cmd, stance) tuple is the cache key).
                hook_type: 2,
                sound_enum: soundEnum,
                stb_did: stbDid,
                gain,
              },
            });
          }
          audioMgr.play(entry.waveDid, { x: px, y: py, z: pz }, { gain }).catch(() => {});
        })
        .catch(() => {});
      this._soundTableHookFires = (this._soundTableHookFires | 0) + 1;
      return;
    }
    if (hookType === 3) {
      // AttackHook — retail's strike-frame trigger. The DAT payload
      // carries an AttackCone (part_index, left/right Vec2D, radius,
      // height) and acclient.c:342282 (`AttackHook::Execute`) calls
      // `CPhysicsObj::attack` to do hit-detection. Server is the
      // authority for hit/damage resolution on our side (see ACE
      // `Player_Melee.cs:51` → `Attack(target)` → damage), so the
      // client just needs the *timing* to sync visual feedback (UI
      // pulse, future hit-marker, future impact-sound boost) to the
      // strike moment instead of swing-start.
      //
      // Emit a `combatStrikeFrame` event carrying the attacker's
      // entity GUID + the hook time-in-clip. Plugins (combat-bar
      // pulse, damage-feed timing) subscribe via
      // `client.events.on("combatStrikeFrame", ...)`.
      try {
        window.__pluginClient?.events?.emit?.("combatStrikeFrame", {
          attackerGuid: (inst.guid >>> 0),
          hookTimeInClipS: +hook.time,
        });
      } catch (_) {}
      // Phase F.C — runtime event log probe symmetry with sound hooks.
      if (pushEventRecord) {
        pushEventRecord({
          type: "combat_strike_frame",
          parent_entity_guid: (inst.guid >>> 0),
          world_pos: [+pos.x, +pos.y, +pos.z],
          t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
          source: "AnimationHook",
          source_meta: {
            entity_guid: (inst.guid >>> 0),
            motion_command: (inst.currentActionKey ?? null),
            hook_type: 3,
            hook_time: +hook.time,
          },
        });
      }
      this._attackHookFires = (this._attackHookFires | 0) + 1;
      return;
    }
    // Other hook types — debug-log + count, leave handler as TODO.
    // The user will likely want CreateParticle (13) on entity idle
    // animations to land particle attaches (forge embers, lantern
    // sparks). The current path through `_attachParticleChainForEntity`
    // walks `physicsScriptDid` — animation-anchored particle hooks are
    // a follow-on item.
    if (hookType === 13 || hookType === 21) {
      // eslint-disable-next-line no-console
      if (!inst._unhandledHookDebugged) {
        inst._unhandledHookDebugged = true;
        console.debug(
          `[entities/task-E] TODO: hookType=${hookType} fired on entity ` +
          `0x${inst.guid.toString(16)} — handler not implemented yet`
        );
      }
    }
    this._unhandledHookFires = (this._unhandledHookFires | 0) + 1;
  }

  /**
   * Drop every entity + clear the animation cache. Called on scene
   * teardown.
   */
  dispose() {
    for (const inst of this.entityMap.values()) {
      inst.dispose();
    }
    this.entityMap.clear();
    // B4 (2026-05-18): drop the name→guid index in lockstep with
    // entityMap so a re-init starts from a clean state.
    this._nameToGuid.clear();
    this.spawnInFlight.clear();
    this.animationCache.dispose();
    if (this._sharedFallback) {
      try {
        this._sharedFallback.dispose();
      } catch (_) {}
      this._sharedFallback = null;
    }
  }
}
