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

import * as THREE from "three";
import {
  meshToGeometryGroups,
  surfacePixelsToTexture,
  acQuatToThree,
} from "./adapter.js";
import { AnimationCache, buildAnimationClip } from "./animation.js";
import { ensureNameplateForEntity } from "./nameplate_sprite.js";
import { materialCanCastShadow } from "./materials.js";

// AC InterpretedMotionCommand low-16 constants. The wasm export
// returns the full u32 (`0x4500_xxxx` for forward locomotion, etc.),
// so we compare full values. Mirrors `index.html:4377-4380`'s
// MOTION_CMD_* constants (those are u16; we extend to u32 here so
// the wasm-side full command code lines up cleanly).
//
// 0x4500_0005 = motion category 0x45 (NonCombat) + command 0x05
//   (WalkForward). 0x4400_0007 = combat-style RunForward. We accept
// either category for the same motion family — a creature's combat-
// stance walk forward (e.g. 0x4500_0006 / 0x4500_000a) all map to
// "walking" for cycle selection.
const MOTION_CMD_WALK_FORWARD_NC = 0x4500_0005;
const MOTION_CMD_RUN_FORWARD_NC = 0x4400_0007;
const MOTION_CMD_STOP_NC = 0x4500_0004;
// Bare command codes (low 16 bits) — used for category-agnostic
// classification. The wasm export packs the category into the high
// 16 bits; here we mask to compare against retail's
// InterpretedMotionCommand enum.
const CMD_LOW_STOP = 0x0004;
const CMD_LOW_WALK_FORWARD = 0x0005;
const CMD_LOW_WALK_BACKWARDS = 0x0006;
const CMD_LOW_RUN_FORWARD = 0x0007;

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
  return null;
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
    if (this.root.parent) this.root.parent.remove(this.root);
    for (const g of this.geometries) {
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
    this._worldParticleManager = null;
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
    const promise = this._spawnImpl(meta).catch((e) => {
      this.lastError = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn(`[phase7.4b] spawn(0x${guid.toString(16)}) failed:`, e);
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
    const setupId = (meta.modelId ?? meta.setupId ?? 0) >>> 0;
    if (!setupId) {
      // No real setup yet (PrivateUpdatePosition before ObjectCreate).
      // Skip — the next ObjectCreate will retry with a real setup_id.
      return null;
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
            const mat = new THREE.MeshStandardMaterial({
              map: tex,
              roughness: 0.9,
              metalness: 0.0,
              side: THREE.DoubleSide,
              transparent: false,
            });
            mat.name = `entity-${guid.toString(16)}-surface-${did.toString(16)}`;
            inst.registerOwnedTexture(tex);
            inst.registerOwnedMaterial(mat);
            entityMaterials.set(did, mat);
          }
          inst._entityMaterials = entityMaterials;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[phase7.4b] fetchEntitySurfacesPixels failed for entity ${guid.toString(16)}:`,
          e
        );
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
    this.entityMap.set(guid, inst);

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
      this._attachParticleChainForEntity(guid, root, pesId).catch((e) => {
        this._particleChainsAttached.delete(guid);
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/H2] particle chain walk for 0x${guid.toString(16)} (pes=0x${pesId.toString(16)}) threw:`,
          e
        );
      });
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
      this._sharedFallback = new THREE.MeshStandardMaterial({
        color: 0x888888,
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
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
      const tweenQ = new THREE.Quaternion().slerpQuaternions(
        tween.fromTilt,
        tween.toTilt,
        eased,
      );
      // Store as airborneTilt so setPose can re-apply on position
      // updates (read by `EntityInstance.setPose`).
      inst.airborneTilt = tweenQ.equals(new THREE.Quaternion())
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
    const cmd = (motionCommand >>> 0);
    const stance = (motionStance >>> 0);
    const cls = classifyMotionCommand(cmd);
    if (cls === "stop" || cls === null) {
      inst.fadeOutCurrent(CROSSFADE_S);
      return;
    }
    // Locomotion. Build the cache key the same way the spawn path did
    // (resolvedStance falls back to the entity's first-bake stance).
    const setupId =
      (inst.meta.modelId ?? inst.meta.setupId ?? 0) >>> 0;
    const mtableId = (inst.meta.mtableId ?? 0) >>> 0;
    const cacheKey = AnimationCache.makeKey(setupId, mtableId, cmd, stance);
    if (cacheKey === inst.currentActionKey) return; // already playing
    this.motionSwitchCount += 1;
    inst.actionLastUsedMs.set(cacheKey, performance.now());

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
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
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
   * Remove an entity by GUID. Tears down geometries, textures, mixer.
   */
  remove(guid) {
    const g = guid >>> 0;
    const inst = this.entityMap.get(g);
    if (!inst) return;
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
  async _attachParticleChainForEntity(guid, rig, pesId) {
    let ps;
    try {
      ps = await this.wasmExports.fetchPhysicsScript(pesId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[entities/H2] fetchPhysicsScript(0x${pesId.toString(16)}) failed:`,
        e
      );
      return;
    }
    const entries = ps.takeEntries();

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
    const Vector3 = THREE.Vector3;
    const Quaternion = THREE.Quaternion;

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

      const offset = {
        position: new Vector3(
          e.createParticleOffsetX,
          e.createParticleOffsetY,
          e.createParticleOffsetZ
        ),
        quaternion: new Quaternion(
          e.createParticleOffsetQX,
          e.createParticleOffsetQY,
          e.createParticleOffsetQZ,
          e.createParticleOffsetQW
        ),
      };

      const partIndex = (e.createParticlePartIndex === 0xffffffff)
        ? -1
        : (e.createParticlePartIndex | 0);

      try {
        const id = await this._worldParticleManager.addEmitter({
          emitterInfo,
          parent: rig,  // <-- the entity rig (THREE.Group); .position + .quaternion track the entity
          partIndex,
          parentOffset: offset,
        });
        if (id !== 0) {
          emitterIds.push(id);
          // Phase F.C — record successful emitter spawn. Position is
          // the rig's current world coord at add-time; offset is the
          // hook's createParticleOffset (applied by ParticleEmitter
          // internally — recorded in source_meta for the validator).
          if (pushEventRecord) {
            pushEventRecord({
              type: "particle",
              emitter_did: (emitterId >>> 0),
              parent_entity_guid: (guid >>> 0),
              world_pos: [+rig.position.x, +rig.position.y, +rig.position.z],
              t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
              source: "PhysicsScriptHook",
              source_meta: {
                entity_guid: (guid >>> 0),
                script_did: (pesId >>> 0),
                start_time_s: +e.startTime,
                hook_type: (e.hookType | 0),
                part_index: partIndex,
                offset_x: +e.createParticleOffsetX,
                offset_y: +e.createParticleOffsetY,
                offset_z: +e.createParticleOffsetZ,
              },
            });
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[entities/H2] addEmitter(0x${emitterId.toString(16)}) failed:`,
          err
        );
      }
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
   * Per-rAF tick. Advances every entity's mixer by dt seconds.
   * Called from loop.js#tickPerFrame.
   */
  tick(dt) {
    if (!(dt > 0)) return;
    for (const inst of this.entityMap.values()) {
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
    const action = inst.currentAction;
    if (!action) return;
    const key = inst.currentActionKey;
    if (!key) return;
    const timeline = inst.hookTimelines.get(key);
    if (!timeline || timeline.length === 0) return;

    // three.js exposes `AnimationAction.time` as time-in-clip
    // (seconds within the action's clip; for LoopRepeat actions, it
    // wraps to 0 at duration each pass). Clip duration is on the
    // bound AnimationClip.
    let currentTime = 0;
    let clipDuration = 0;
    try {
      currentTime = +action.time;
      const clip = action.getClip();
      clipDuration = clip ? +clip.duration : 0;
    } catch (_) {
      return;
    }
    if (!(clipDuration > 0)) return;

    let lastTime = inst.actionLastHookTime.get(key);
    if (lastTime === undefined) lastTime = 0;

    const audioMgr = this.scene3d?.audioManager ?? null;
    const cache = this.scene3d?.soundTableCache ?? null;

    if (currentTime >= lastTime) {
      // Common case: monotonic advance within one loop pass.
      this._fireHooksInRange(inst, timeline, lastTime, currentTime, audioMgr, cache);
    } else {
      // Wrap-around: the clip looped. Fire [lastTime, clipDuration)
      // then [0, currentTime]. We use clipDuration as the upper bound
      // (inclusive of hooks AT clipDuration — three.js's loop semantics
      // mean a hook at exactly duration would have been baked at the
      // last frame's time, but we include it to be safe; idempotent
      // since hook times come from `frame_index * (1/fps)` and the
      // last frame is at `(numFrames - 1) / fps < duration`).
      this._fireHooksInRange(inst, timeline, lastTime, clipDuration, audioMgr, cache);
      this._fireHooksInRange(inst, timeline, -Infinity, currentTime, audioMgr, cache);
    }

    inst.actionLastHookTime.set(key, currentTime);
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
