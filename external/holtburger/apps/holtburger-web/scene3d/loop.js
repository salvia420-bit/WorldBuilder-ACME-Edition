// Phase 7.3+ — render-loop tick helpers.
//
// Phase 7.3 wired `tickCellVisibility3D` so the wasm-side cell BFS
// (`getCurrentCellId / getRenderSet / isCurrentCellIndoor`) drives
// `Object3D.visible` flips on the per-cell groups + the outdoor batch.
// Phase 7.4b adds:
//   - mixer.update(dt) per entity via `EntityManager.tick`.
//   - drainEntityEvents3D — pulls `pollEntityUpdates()` and
//     dispatches kind=1/2/4/5 into the EntityManager. The 2D path's
//     `drainEvents` (`index.html:5723`) also calls
//     `pollEntityUpdates` — both paths run today because the 2D
//     drainEvents drives chat/local-player/etc, but
//     `pollEntityUpdates()` is a one-shot drain. To avoid double-
//     consumption, the 3D path subscribes via a hook installed on the
//     SessionHandle (see `attachEntityHook` below) instead of
//     re-calling `pollEntityUpdates` directly.
//
// Phase 7.5 (this commit) drives `cameraSwitcher.tick(dt)` first so
// the per-frame camera position update + WASD → setMovementInput
// dispatch happens BEFORE the entity tick. Order matters: the camera
// queries `getPlayerWorldPos()` which reads
// `entityManager.entityMap[localPlayerGuid].root.position`; the
// entity mixer advance in step 2 then updates that position for the
// NEXT frame's camera. Camera-first means the camera always reflects
// last-frame entity poses, never a half-stepped state.
//
// Phase 7.6 (this commit) wires `tickLightingForCellState(scene3d,
// sessionHandle)` after `tickCellVisibility3D` so the sun-off /
// ambient-up toggle reads the freshly-flipped indoor flag on the
// same frame. Per-SetupModel point/spot lights are DEFERRED to a
// follow-on (see `lighting.js` header comment for the deferred-work
// pointer); the distance-cull pass referenced in earlier comments
// only needs to land then.
//
// `init3D`'s render loop calls this once per requestAnimationFrame
// frame, BEFORE `renderer.render(scene, camera)`.

import { tickCellVisibility3D } from "./cells.js";
import { tickLightingForCellState } from "./lighting.js";

// Entity-update kind constants — mirror the wasm `ENTITY_UPDATE_KIND_*`
// constants from `crates/holtburger-session/src/lib.rs`. Listed here
// for readability of `drainEntityEvents3D`'s dispatch.
const KIND_POSITION = 0;
const KIND_SPAWN = 1;
const KIND_REMOVE = 2;
const KIND_META_REFRESH = 3;
const KIND_VELOCITY = 4;
const KIND_MOTION = 5;

/**
 * Per-rAF tick. Called from `init3D`'s render loop with the live
 * `scene3d` shape, the wasm `SessionHandle` (may be null pre-spawn),
 * and the per-frame delta time in seconds.
 *
 * Order matters:
 *   1. Cell visibility (cheap; gates the rest of the scene).
 *   2. EntityManager.tick(dt) — advances mixers BEFORE we apply pose
 *      updates so the visual matches the new wire state on the same
 *      frame.
 *   3. drainEntityEvents3D — applies any queued events to the
 *      manager. Spawn is async; setMotion is async; setPose is sync.
 *      The async ones get scheduled on a microtask and apply on the
 *      next tick.
 */
export function tickPerFrame(scene3d, sessionHandle, dt) {
  tickCellVisibility3D(scene3d, sessionHandle);
  // Phase 7.6 — lighting tick AFTER cell visibility so it reads the
  // freshly-flipped indoor/outdoor state on the same frame. Wraps in
  // try/catch so a thrown isCurrentCellIndoor() never kills the tick.
  try {
    tickLightingForCellState(scene3d, sessionHandle);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._lightingTickWarned) {
      scene3d._lightingTickWarned = true;
      console.warn("[phase7.6] tickLightingForCellState threw:", e);
    }
  }
  // Workstream Sky-C — dynamic sky lighting (color + intensity +
  // position + fog) from wasm SkyState. Runs AFTER Phase 7.6's
  // tickLightingForCellState so the indoor/outdoor visible-flag is
  // already settled; Sky-C writes color/intensity/position WITHOUT
  // touching `.visible` so the two composers don't fight. No-op when
  // the controller hasn't been wired (e.g. setupSceneLighting was
  // skipped) or when `getSkyState()` returns null (pre-populator).
  if (scene3d?.skyLightingController) {
    try {
      scene3d.skyLightingController.tick(dt);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._skyLightingTickWarned) {
        scene3d._skyLightingTickWarned = true;
        console.warn("[sky-c] skyLightingController.tick threw:", e);
      }
    }
  }
  // Phase 7.5 — camera tick BEFORE entity tick. The switcher reads
  // last-frame entity poses for follow framing AND dispatches
  // setMovementInput (which the wasm side consumes asynchronously, so
  // the dispatch order vs the entity tick has no race).
  if (scene3d?.cameraSwitcher && typeof scene3d.cameraSwitcher.tick === "function") {
    try {
      scene3d.cameraSwitcher.tick(dt);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._cameraTickWarned) {
        scene3d._cameraTickWarned = true;
        console.warn("[phase7.5] cameraSwitcher.tick threw:", e);
      }
    }
  }
  if (scene3d?.entityManager) {
    scene3d.entityManager.tick(dt);
    drainEntityEvents3D(scene3d, sessionHandle);
  }
  // Follow-on #10 (3D port state doc) — DOM-projected nameplate overlay
  // tick. Runs AFTER entity tick so the per-rAF mixer.update has
  // already advanced the rig poses for THIS frame — the nameplate
  // projection then sees current-frame world positions, not stale ones.
  // AFTER cameraSwitcher.tick (above) so the camera's matrixWorldInverse
  // + projectionMatrix reflect the camera position we're about to
  // render with. Wrapped in try/catch so a thrown projection / DOM
  // write never kills the tick (one-time warn matches the
  // cameraSwitcher.tick guard above).
  if (scene3d?.nameplateLayer) {
    try {
      const activeCam =
        scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera;
      if (activeCam) scene3d.nameplateLayer.tick(activeCam);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._nameplateTickWarned) {
        scene3d._nameplateTickWarned = true;
        console.warn("[follow-on#10] nameplateLayer.tick threw:", e);
      }
    }
  }
}

/**
 * Snapshot the wasm-bindgen EntityUpdate into a plain JS object.
 *
 * EntityUpdate's getters are owned by the wasm-bindgen handle that
 * .free() is called on at the end of the drain (or by the parent
 * 2D drainEvents). For the async spawn path, the meta needs to
 * survive across `await`s — once free() is called, the getters
 * return garbage. This deep-copies every relevant field into a
 * plain object so the EntityManager can reference it later without
 * worrying about wasm lifetime.
 *
 * Mirrors `metaFromSpawn` (`index.html:3383`) for the spawn-only
 * fields, and adds the kind=0 / kind=1 wire-position fields the 3D
 * rig builder needs (the 2D path slots them in via
 * `landblockToWorldXY` outside metaFromSpawn).
 */
function toMeta(upd) {
  const modelChanges = upd.modelChanges;
  const textureChanges = upd.textureChanges;
  const subPalettes = upd.subPalettes;
  return {
    guid: (upd.guid >>> 0),
    modelId: (upd.modelId >>> 0),
    setupId: (upd.modelId >>> 0),
    landblockId: (upd.landblockId >>> 0),
    x: upd.x ?? 0,
    y: upd.y ?? 0,
    z: upd.z ?? 0,
    qw: upd.qw ?? 1,
    qx: upd.qx ?? 0,
    qy: upd.qy ?? 0,
    qz: upd.qz ?? 0,
    wcid: (upd.wcid >>> 0),
    itemType: (upd.itemType >>> 0),
    name: upd.name || "",
    iconId: (upd.iconId >>> 0),
    objScale: upd.objScale > 0 ? upd.objScale : 1.0,
    paletteId: (upd.paletteId >>> 0),
    mtableId: (upd.mtableId >>> 0),
    motionCommand: (upd.motionCommand ?? 0) >>> 0,
    motionStance: (upd.motionStance ?? 0) >>> 0,
    // Always copy typed arrays — wasm-bindgen Uint32Array views point
    // at linear memory that grows on subsequent allocations.
    modelChanges:
      modelChanges && modelChanges.length > 0
        ? Uint32Array.from(modelChanges)
        : new Uint32Array(0),
    textureChanges:
      textureChanges && textureChanges.length > 0
        ? Uint32Array.from(textureChanges)
        : new Uint32Array(0),
    subPalettes:
      subPalettes && subPalettes.length > 0
        ? Uint32Array.from(subPalettes)
        : new Uint32Array(0),
  };
}

/**
 * Pull pollEntityUpdates() results from the SessionHandle and dispatch
 * into the EntityManager. The 3D path's first-cut: when
 * `?renderer=3d` and the bootstrap skipped 2D `renderNeighbourhood`,
 * the 2D drainEvents loop is still running (it owns chat / local
 * player movement / etc). To avoid double-consumption, this function
 * is a no-op when `scene3d.useSharedDrain` is true (the default for
 * Phase 7.4b — the 2D drainEvents calls
 * `window.scene3dEntityHook(events)` to forward the entity-shaped
 * events without re-draining).
 *
 * **For the standalone capture path** (Phase 7.4b synthetic test +
 * any future renderer-only host), the EntityManager's drain calls
 * `sessionHandle.pollEntityUpdates()` directly; that's the same path
 * the 2D drainEvents uses, so as long as only one of the two is
 * active per frame, no double-consumption occurs.
 *
 * Currently always direct-drains. The 2D-coexistence story is a
 * Phase 7.5 wiring concern — when that lands, the 2D drainEvents
 * will gate its `pollEntityUpdates()` call on `!useRenderer3d` and
 * 3D will get the full stream uncontested.
 */
function drainEntityEvents3D(scene3d, sessionHandle) {
  if (!sessionHandle || typeof sessionHandle.pollEntityUpdates !== "function") {
    // Capture-script path: the EntityManager exposes a synthetic
    // injector window.__phase74_inject_event(upd) that capture
    // scripts can call to feed events without a live session. That
    // path doesn't go through here — it calls EntityManager methods
    // directly.
    return;
  }
  // Phase 7.4b coexistence shim: when the 2D drainEvents has already
  // consumed events this frame, scene3d.useSharedDrain is true and
  // each entity update was forwarded via window.__entitiesHook below.
  // Skip the wasm round-trip in that case.
  if (scene3d.useSharedDrain) return;
  let updates;
  try {
    updates = sessionHandle.pollEntityUpdates();
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._drainWarned) {
      scene3d._drainWarned = true;
      console.warn("[phase7.4b] pollEntityUpdates threw:", e);
    }
    return;
  }
  if (!updates || updates.length === 0) return;
  const em = scene3d.entityManager;
  for (const upd of updates) {
    try {
      const kind = upd.kind | 0;
      if (kind === KIND_SPAWN) {
        // Snapshot before async — the wasm-bindgen handle will be
        // .free()'d at the end of this loop iteration, but the spawn
        // is async + may await the keyframe fetch.
        const meta = toMeta(upd);
        em.spawn(meta);
      } else if (kind === KIND_REMOVE) {
        em.remove(upd.guid >>> 0);
      } else if (kind === KIND_POSITION) {
        // The 2D path translates LB-local → world; the 3D path's
        // setPose takes world coords already (rig.position is world,
        // not relative to entitiesGroup which is identity-rooted).
        const lbId = upd.landblockId >>> 0;
        const lbX = (lbId >>> 24) & 0xff;
        const lbY = (lbId >>> 16) & 0xff;
        const wx = lbX * 192.0 + (upd.x ?? 0);
        const wy = lbY * 192.0 + (upd.y ?? 0);
        em.setPose(
          upd.guid >>> 0,
          wx,
          wy,
          upd.z ?? 0,
          upd.qw ?? 1,
          upd.qx ?? 0,
          upd.qy ?? 0,
          upd.qz ?? 0
        );
      } else if (kind === KIND_VELOCITY) {
        // Keep velocity hints around for future extrapolation; not
        // currently consumed.
        em.setVelocity({
          guid: upd.guid >>> 0,
          vx: upd.vx ?? 0,
          vy: upd.vy ?? 0,
          vz: upd.vz ?? 0,
          omegaZ: upd.omegaZ ?? 0,
        });
      } else if (kind === KIND_MOTION) {
        em.setMotion(
          upd.guid >>> 0,
          (upd.motionCommand ?? 0) >>> 0,
          (upd.motionStance ?? 0) >>> 0
        );
      } else if (kind === KIND_META_REFRESH) {
        // Not yet consumed — Phase 7.5 will wire portal-destination
        // updates to nameplate / chip overlays.
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[phase7.4b] entity drain dispatch:", e);
    }
    if (typeof upd.free === "function") {
      try {
        upd.free();
      } catch (_) {}
    }
  }
}

/**
 * Install a shared-drain hook on the page that the 2D drainEvents
 * forwards to. When ?renderer=3d is active AND the 2D drainEvents
 * is also running (current state per Phase 7.0–7.3), the 2D path
 * already consumes pollEntityUpdates(); this hook lets it forward
 * the full event objects (before .free()) into the 3D path.
 *
 * The 2D drainEvents already does its work; we only need it to copy
 * the relevant fields into a plain JS object and pass to the
 * EntityManager. To keep coupling minimal, this exposes a single
 * window-level callback that index.html can call inside its
 * drainEvents loop.
 *
 * Called from init3D after EntityManager is constructed.
 */
export function installSharedDrainHook(scene3d) {
  if (!scene3d?.entityManager) return;
  scene3d.useSharedDrain = true;
  // Window-level hook the 2D path can call. Phase 7.5 accepts EITHER
  // a single EntityUpdate OR an array of them — the 2D drainEvents at
  // index.html:6021 now passes the whole `entityUpdates` array in one
  // call after pollEntityUpdates() returns, while older capture
  // scripts (capture_phase7_4_entities.cjs mode 2) still call once per
  // event. Both forms are accepted; the array form is more efficient
  // (one hook call per drain instead of N). Each event is read but
  // NOT freed — the 2D loop owns the lifetime; we just observe.
  const em = scene3d.entityManager;
  // eslint-disable-next-line no-undef
  if (typeof window !== "undefined") {
    function dispatchOne(upd) {
      if (!upd) return;
      try {
        const kind = upd.kind | 0;
        if (kind === KIND_SPAWN) {
          em.spawn(toMeta(upd));
        } else if (kind === KIND_REMOVE) {
          em.remove(upd.guid >>> 0);
        } else if (kind === KIND_POSITION) {
          const lbId = upd.landblockId >>> 0;
          const lbX = (lbId >>> 24) & 0xff;
          const lbY = (lbId >>> 16) & 0xff;
          const wx = lbX * 192.0 + (upd.x ?? 0);
          const wy = lbY * 192.0 + (upd.y ?? 0);
          const wz = upd.z ?? 0;
          const g = upd.guid >>> 0;
          // Always stash the latest world-space position per guid, even
          // when the 3D EntityManager has no rig for this guid yet (the
          // wasm-side eager-WorldState path suppresses KIND_SPAWN for
          // the local player on SelectCharacter, so `em.setPose` below
          // is a no-op for that guid). `getLocalPlayerWorldPos` uses
          // this as its last-resort fallback so the camera tracks the
          // server pose regardless of whether a rig ever spawned.
          //
          // Workstream B (2026-05-11): `ts` is the rAF wall-clock when
          // this server-authoritative pose landed. The cameraSwitcher's
          // client-side prediction reads (x, y, z, ts) on each rAF: a
          // changed `ts` means a fresh KIND_POSITION arrived from ACE
          // since the last reconcile, so the prediction can snap-or-lerp
          // toward the new authoritative pose. Without the timestamp the
          // prediction would re-reconcile on every rAF and never let the
          // client-side integration breathe.
          if (!window.__lastEntityWorldPos) {
            window.__lastEntityWorldPos = new Map();
          }
          window.__lastEntityWorldPos.set(g, {
            x: wx, y: wy, z: wz,
            ts: (typeof performance !== "undefined" && performance.now)
              ? performance.now()
              : Date.now(),
          });
          em.setPose(
            g,
            wx, wy, wz,
            upd.qw ?? 1, upd.qx ?? 0, upd.qy ?? 0, upd.qz ?? 0
          );
        } else if (kind === KIND_VELOCITY) {
          em.setVelocity({
            guid: upd.guid >>> 0,
            vx: upd.vx ?? 0,
            vy: upd.vy ?? 0,
            vz: upd.vz ?? 0,
            omegaZ: upd.omegaZ ?? 0,
          });
        } else if (kind === KIND_MOTION) {
          em.setMotion(
            upd.guid >>> 0,
            (upd.motionCommand ?? 0) >>> 0,
            (upd.motionStance ?? 0) >>> 0
          );
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[phase7.4b] shared-drain hook dispatch:", e);
      }
    }
    // eslint-disable-next-line no-undef
    window.__scene3dEntityHook = function entityHook(updOrArray) {
      if (!updOrArray) return;
      // Array form (Phase 7.5 — 2D drainEvents passes the whole
      // pollEntityUpdates() array in one call). Iterate read-only;
      // the 2D loop owns the `.free()` lifetime.
      if (typeof updOrArray.length === "number" && typeof updOrArray !== "string") {
        for (let i = 0; i < updOrArray.length; i += 1) {
          dispatchOne(updOrArray[i]);
        }
        return;
      }
      // Single-event form (Phase 7.4b — capture_phase7_4_entities.cjs
      // mode 2 still calls the hook once per event).
      dispatchOne(updOrArray);
    };

    // Workstream E (3D camera/game-feel fix): drain the pre-init3D
    // backlog now that the real dispatcher is wired. The buffering
    // stub installed at index.html module-init pushed cloned events
    // into `window.__scene3dEntityBacklog` for every drainEvents tick
    // that fired before init3D resolved. Replay those events through
    // the real dispatcher so the local player's KIND_SPAWN (emitted
    // ~+2 s post-SelectCharacter by Workstream A) builds a rig instead
    // of being silently dropped. Idempotent — splice(0) drains the
    // array; a second call (renderer hot-swap) sees an empty backlog.
    //
    // Each entry is a plain-JS clone produced by
    // `__scene3dCloneEntityUpdate`; `dispatchOne` reads the same
    // properties (kind, guid, modelId, etc.) so the clone IS the wire
    // shape from the dispatcher's perspective. `toMeta(clone)` works
    // identically on the wasm-bindgen handle and the plain-JS clone
    // because both expose the same numeric / array getters.
    //
    // Replay ordering: the backlog often contains ~80-90 NPC SPAWNs +
    // 1 local-player SPAWN intermixed. `em.spawn()` is async and
    // serialized on the wasm-bindgen single-threaded
    // fetchEntityAnimationKeyframes round-trip (≈150 ms per spawn);
    // 90 spawns = ~13 s wall-clock to complete. To make the local
    // player's rig visible quickly (so the camera follow can latch
    // onto it without a 13-s "no rig" gap), we PRIORITISE the local
    // player's SPAWN to the front of the dispatch queue. Other event
    // kinds (POSITION / MOTION / VELOCITY) for the local player also
    // float to the front so their first KIND_POSITION reconcile lands
    // immediately. The remaining NPC spawns dispatch in original
    // arrival order behind the local-player batch.
    // eslint-disable-next-line no-undef
    const backlog = window.__scene3dEntityBacklog;
    if (Array.isArray(backlog) && backlog.length > 0) {
      const queued = backlog.splice(0);
      // eslint-disable-next-line no-undef
      let localGuid = null;
      // eslint-disable-next-line no-undef
      if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
        try {
          const g = window.getLocalPlayerGuid();
          if (g !== null && g !== undefined) localGuid = g >>> 0;
        } catch (_) {}
      }
      // Partition: local-player events first (stable order within),
      // then everything else (stable order within).
      const localEvents = [];
      const otherEvents = [];
      for (const upd of queued) {
        if (localGuid !== null && (upd.guid >>> 0) === localGuid) {
          localEvents.push(upd);
        } else {
          otherEvents.push(upd);
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[workstream-E] replaying ${queued.length} pre-init3D entity events ` +
        `(kinds=${
          (() => {
            const counts = {};
            for (const e of queued) counts[e.kind] = (counts[e.kind] || 0) + 1;
            return Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(",");
          })()
        }, localGuid=${localGuid !== null ? "0x" + localGuid.toString(16) : "null"}, ` +
        `local=${localEvents.length}, other=${otherEvents.length}) through 3D EntityManager`
      );
      for (const upd of localEvents) {
        dispatchOne(upd);
      }
      for (const upd of otherEvents) {
        dispatchOne(upd);
      }
    }
  }
}
