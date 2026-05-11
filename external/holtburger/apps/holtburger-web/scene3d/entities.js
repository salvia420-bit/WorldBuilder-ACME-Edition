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

// Crossfade duration (seconds) when switching from one action to
// another. 0.2 s is short enough to feel snappy and long enough to
// avoid pose-pop on tightly-cycled stance flips.
const CROSSFADE_S = 0.2;

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
  }

  /**
   * Promote `nextAction` to the currently-playing action with a
   * crossFade. `nextActionKey` is stamped so subsequent setMotion
   * calls can spot a no-op (same action already current).
   */
  crossFadeTo(nextAction, nextActionKey, durationS) {
    if (this.currentAction === nextAction) return;
    if (this.currentAction) {
      // Live crossfade — fades current → new over `durationS`. Both
      // actions stay scheduled so the mixer interpolates between them
      // until the fade completes; then `currentAction` is .stop()'d
      // implicitly by its weight reaching 0.
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
      // No action was playing — fade-in only.
      nextAction.reset();
      nextAction.fadeIn(durationS);
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
    const partMeshes = animEntry.partMeshes;
    const partCount = animEntry.partCount;
    const initialClip = animEntry.clip;
    const resolvedStance = animEntry.resolvedStance >>> 0;

    // Step B: build the rig. Root holds the entity's world transform;
    // per-part children hold the rig-local transforms the AnimationClip
    // drives.
    const root = new THREE.Group();
    root.name = `entity_${guid.toString(16).padStart(8, "0")}`;
    const parts = [];

    // Resolve materials — first preload all unique surface DIDs across
    // all parts in one wasm round-trip, then synchronously paint via
    // getCached. Without this preload, every per-part part walk would
    // serialize its own fetch_surfaces_pixels round-trip.
    const allSurfaceDids = new Set();
    const partGroups = []; // parallel to partMeshes — { groups, surfaceDids }
    for (let p = 0; p < partCount; p += 1) {
      const partMesh = partMeshes[p];
      if (!partMesh) {
        partGroups.push({ groups: [], surfaceDids: [] });
        continue;
      }
      const conv = meshToGeometryGroups(partMesh);
      partGroups.push(conv);
      for (const did of conv.surfaceDids) allSurfaceDids.add(did >>> 0);
      // Free the wasm-side mesh after we've copied its arrays.
      if (typeof partMesh.free === "function") {
        try {
          partMesh.free();
        } catch (_) {}
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
      // Place the part at the rest-pose origin. The AnimationClip's
      // first frame may overwrite this immediately, but if no clip is
      // playing the rest pose IS the visual.
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
    }
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
