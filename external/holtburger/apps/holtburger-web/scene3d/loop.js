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

import { tickCellVisibility3D, tickPvsLoadExpansion } from "./cells.js";
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

// Cohere-B follow-on (2026-05-12): the 2D path's academy-rubberband
// fix (`index.html:4191-4214`) explicitly skips syncing the local
// sprite to server `PublicUpdatePosition` / `PrivateUpdatePosition`
// broadcasts — the wasm integrator + JS prediction own the local
// sprite, and re-syncing on every UpdatePosition produces the visible
// "snaps back to starting spot when I move" the user reported (server
// pose lags client integration when, e.g., Run skill = 0). The 3D
// path was missing the equivalent guard at `em.setPose(localGuid,
// ...)` below. This helper centralises the local-player GUID lookup
// so both call sites (drainEntityEvents3D direct + dispatchOne shared
// hook) skip the snap consistently.
function isLocalPlayerGuid(g) {
  if (typeof window === "undefined") return false;
  try {
    const fn = window.getLocalPlayerGuid;
    if (typeof fn !== "function") return false;
    const lpg = fn();
    if (lpg === null || lpg === undefined) return false;
    return (g >>> 0) === (lpg >>> 0);
  } catch (_) {
    return false;
  }
}

// Cohere-B follow-on (2026-05-12): drive the local-player rig from the
// wasm integrator's `getLocalPlayerPose()` rather than from
// KIND_POSITION events. Mirrors the 2D path's per-rAF prediction tick
// (`index.html:6353-6420`) which writes `localEntry.sprite.x/.y`
// directly from keystate + dt; the 3D analogue reads the wasm
// integrator's authoritative pose (already integrator-smoothed; no
// server-pose blend that fights client prediction) and applies it to
// `inst.root.position/.quaternion`. Server-side reconciliation still
// happens INSIDE the wasm integrator silently — this layer just
// short-circuits the user-visible flash from late-arriving server
// poses landing as KIND_POSITION events on the local guid.
// Cohere-B follow-on v2 (2026-05-12): drive the local-player rig from
// Workstream B's `cameraSwitcher.predictedPlayerPos` instead of the
// wasm integrator's `getLocalPlayerPose()`. Mirrors the 2D path's
// architecture (`index.html:6353-6420` per-rAF prediction owns
// `sprite.x/.y`; the integrator pose is never read for the local
// sprite).
//
// Why the integrator-driven approach (v1) wasn't enough: ACE
// broadcasts `PublicUpdatePosition` at 5-10 Hz with the server's
// authoritative pose, which always lags client integration by a small
// amount (network latency + the server's slower physics tick + Run
// skill differences). The wasm integrator's internal reconcile pulls
// its pose backward on every broadcast and re-advances forward
// between broadcasts. `getLocalPlayerPose()` faithfully reports the
// oscillation; rendering it directly produces ~5-10 Hz visible jitter.
// A per-rAF rate limit (v1) can't smooth events arriving faster than
// the rate-limit horizon.
//
// `predictedPlayerPos` is exactly the smoothed alternative:
//   - Camera advances it by JS-side keystate × heading × dt (no
//     server-pose blend per frame).
//   - On fresh server pose arrival (via `__lastEntityWorldPos` ts
//     change), it starts a 150 ms lerp toward server pose. The lerp
//     completes well before the next broadcast lands, so the rendered
//     pose smoothly tracks server reality without visible per-
//     broadcast jitter.
//   - On large deltas (> 5 m), it snaps — preserves teleport feel.
//
// Heading is still sourced from the integrator's `getLocalPlayerPose`:
// turn rate is small (~1.5 rad/s × dt = 0.025 rad/frame) and doesn't
// oscillate visibly, so we don't need a prediction layer for it.
function applyLocalPlayerPoseFromIntegrator(scene3d, sessionHandle) {
  if (!scene3d?.entityManager) return;
  if (!scene3d?.cameraSwitcher) return;
  if (typeof window === "undefined") return;
  const fn = window.getLocalPlayerGuid;
  if (typeof fn !== "function") return;
  let lpg;
  try { lpg = fn(); } catch (_) { return; }
  if (lpg === null || lpg === undefined) return;
  const guid = lpg >>> 0;
  const inst = scene3d.entityManager.entityMap.get(guid);
  if (!inst || !inst.root) return;

  // Position source: X/Y from Workstream B predicted pose, Z from the
  // wasm integrator. Pre-spawn the predicted pose is null (no server-
  // pose anchor yet); the rig stays at its last applied position
  // until the first server pose lands — matches Workstream B's
  // camera behaviour, which falls through to a three-tier fallback
  // during the same window.
  //
  // Why split X/Y from Z: the reconcile flash that v1 was fighting is
  // a LATERAL phenomenon (server's slower run speed pulling the X/Y
  // pose backward along the heading axis). Z doesn't oscillate the
  // same way — terrain-following + gravity produces monotonic vertical
  // motion that the server-client integration agrees on. But
  // Workstream B's `_advancePrediction` only advances X and Y on WASD
  // (camera.js:953-954); predicted.z only updates via the 150 ms
  // reconcile lerp from each fresh server pose, so on hilly terrain
  // it LAGS the actual altitude. A lagging predicted.z would render
  // the rig (and its follow camera) below the terrain mesh on uphill
  // walks → terrain back-faced from below → INVISIBLE. Sourcing Z
  // straight from `getLocalPlayerPose().z` keeps the rig on the
  // ground at the integrator's authoritative altitude while X/Y still
  // benefit from the smoothed prediction.
  const predicted = scene3d.cameraSwitcher.predictedPlayerPos;
  if (!predicted) return;

  let posZ = predicted.z;
  let heading = 0;
  if (sessionHandle && typeof sessionHandle.getLocalPlayerPose === "function") {
    try {
      const pose = sessionHandle.getLocalPlayerPose();
      if (pose) {
        if (typeof pose.z === "number" && Number.isFinite(pose.z)) {
          posZ = pose.z;
        }
        if (typeof pose.heading === "number" && Number.isFinite(pose.heading)) {
          heading = pose.heading;
        }
      }
    } catch (_) {}
  }
  const qw = Math.cos(heading * 0.5);
  const qz = Math.sin(heading * 0.5);
  scene3d.entityManager.setPose(
    guid,
    predicted.x, predicted.y, posZ,
    qw, 0.0, 0.0, qz
  );
}

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
/**
 * Phase 2.2 — push the shared wall-clock seconds onto every terrain
 * ShaderMaterial's `uTime` uniform. Single time source means matched
 * wave motion across LB seams (water animations stay phase-locked at
 * neighbouring landblock boundaries).
 *
 * Reads `scene3d.frameTime.tsSec`, the per-frame wall-clock snapshot
 * stamped by the rAF callback in scene3d/index.js. Same numeric value
 * as a fresh `performance.now() * 0.001` but sourced from the shared
 * snapshot so we don't grow a multi-clock zoo (cf. "three time sources"
 * in INTERACTING_LAYERS_ANALYSIS.md). Fallback to a fresh now() lets
 * capture scripts and tests that call this outside the rAF loop still
 * work.
 *
 * No-op when the registry is empty (pre-buildHoltburgTerrain) or when
 * subdivLevel < 2 (the material was built with uDisplacementEnabled=0
 * already, but pushing uTime is still safe — non-water cells gate on
 * the same uniform inside the shader).
 */
function tickTerrainUTime(scene3d) {
  if (!scene3d?.terrainMaterials || scene3d.terrainMaterials.length === 0) {
    return;
  }
  const tSec =
    scene3d.frameTime?.tsSec ??
    ((typeof performance !== "undefined" && performance.now)
      ? performance.now() * 0.001
      : Date.now() * 0.001);
  for (const mat of scene3d.terrainMaterials) {
    if (mat?.uniforms?.uTime) {
      mat.uniforms.uTime.value = tSec;
    }
  }
}

/**
 * Push the live AC-z-up sun direction into all terrain ShaderMaterials.
 * Replaces the prior hardcoded literal in the terrain fragment shader so
 * cloud shadows + NdotL track the actual SkyState dirHeading/dirPitch
 * the rest of the atmosphere stack reads. Source of truth is
 * `skyLightingController._lastState`, the same snapshot
 * `atmosphereLights.tick` + `atmosphereSky.tick` already consume — no
 * second wasm getSkyState() call.
 *
 * No-op pre-populator (state null) or pre-buildHoltburgTerrain (empty
 * registry); the material uniform's default literal covers that frame.
 */
function tickTerrainSunDir(scene3d) {
  if (!scene3d?.terrainMaterials || scene3d.terrainMaterials.length === 0) {
    return;
  }
  const state = scene3d.skyLightingController?._lastState ?? null;
  if (!state) return;
  const heading = state.dirHeading;
  const pitch = state.dirPitch;
  if (!Number.isFinite(heading) || !Number.isFinite(pitch)) return;
  const DEG = Math.PI / 180;
  const cp = Math.cos(pitch * DEG);
  const sx = cp * Math.sin(heading * DEG);
  const sy = cp * Math.cos(heading * DEG);
  const sz = Math.sin(pitch * DEG);
  for (const mat of scene3d.terrainMaterials) {
    const v = mat?.uniforms?.uSunDir?.value;
    if (v && typeof v.set === "function") {
      v.set(sx, sy, sz);
    }
  }
}

export function tickPerFrame(scene3d, sessionHandle, dt) {
  tickCellVisibility3D(scene3d, sessionHandle);
  // 2026-05-16 — PVS-driven scenery + buildings expansion (paired with
  // STATICS_RING_RADIUS=2 and BUILDINGS_RING_RADIUS=2 boot rings in
  // index.js). Reads the wasm renderSet and triggers
  // `loadStaticsForLandblock` + `loadBuildingsForLandblock` for any LB
  // the player can see but hasn't entered yet. Both hooks are
  // idempotent + cheap.
  tickPvsLoadExpansion(scene3d, sessionHandle);
  // Phase 2.2 — water/lava vertex displacement clock. Runs FIRST so the
  // displacement is current before any code reads terrain positions
  // this frame (e.g. nameplate projection sampling terrain Y). Wrapped
  // in try/catch + one-shot warn so a thrown push never kills the tick.
  try {
    tickTerrainUTime(scene3d);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._terrainUTimeTickWarned) {
      scene3d._terrainUTimeTickWarned = true;
      console.warn("[phase2.2] tickTerrainUTime threw:", e);
    }
  }
  try {
    tickTerrainSunDir(scene3d);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._terrainSunDirTickWarned) {
      scene3d._terrainSunDirTickWarned = true;
      console.warn("[terrain-sun] tickTerrainSunDir threw:", e);
    }
  }
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
  // Sky-K.3 — physical sun + sky probe. Reads heading/pitch from the
  // SAME SkyState that skyLightingController just snapshotted (its
  // _lastState), so the two stay in sync without a second wasm
  // getSkyState() call. The probe tracks the active camera so its
  // SH-irradiance computation reflects the camera's altitude in the
  // atmosphere.
  if (scene3d?.atmosphereLights) {
    try {
      const state = scene3d.skyLightingController?._lastState ?? null;
      const cam = scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera;
      scene3d.atmosphereLights.tick(state, cam?.position);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._atmosphereLightsTickWarned) {
        scene3d._atmosphereLightsTickWarned = true;
        console.warn("[sky-k.3] atmosphereLights.tick threw:", e);
      }
    }
  }
  // Sky-K.4 — takram SkyMaterial + stars. Same SkyState source as the
  // physical lights so sun position in the sky matches the sunlight
  // direction. Stars are a fixed celestial backdrop (no per-frame
  // motion); only sun direction needs updating.
  if (scene3d?.atmosphereSky) {
    try {
      const state = scene3d.skyLightingController?._lastState ?? null;
      scene3d.atmosphereSky.tick(state);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._atmosphereSkyTickWarned) {
        scene3d._atmosphereSkyTickWarned = true;
        console.warn("[sky-k.4] atmosphereSky.tick threw:", e);
      }
    }
  }
  // Workstream Sky-D — sky dome + celestial body renderer. Runs AFTER
  // Sky-C so the freshly-written `skyBackgroundColor` (Sky-C's horizon
  // color sink) + `skyLightingController._lastState.ambColorArgb`
  // (zenith color source) land on the dome's shader uniforms in the
  // same frame. Camera-parented; reads `cameraSwitcher.activeCamera`
  // (Phase 7.5) so the dome translates with whichever camera the
  // user has toggled to. No-op pre-construction or pre-populate.
  if (scene3d?.skyDome) {
    try {
      const activeCam =
        scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera;
      scene3d.skyDome.tick(dt, activeCam);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._skyDomeTickWarned) {
        scene3d._skyDomeTickWarned = true;
        console.warn("[sky-d] skyDome.tick threw:", e);
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
    // Cohere-B follow-on (2026-05-12): drive the local-player rig
    // from the wasm integrator's authoritative pose each rAF. Runs
    // AFTER drainEntityEvents3D so any KIND_SPAWN for the local guid
    // has had a chance to build the rig (which the helper guards on
    // via `entityMap.has`). The KIND_POSITION snap for the local guid
    // is disabled inside drainEntityEvents3D + the shared-hook
    // dispatchOne — this is the replacement source.
    try {
      applyLocalPlayerPoseFromIntegrator(scene3d, sessionHandle);
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._localPlayerPoseTickWarned) {
        scene3d._localPlayerPoseTickWarned = true;
        console.warn("[cohere-b] applyLocalPlayerPoseFromIntegrator threw:", e);
      }
    }
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
    // H2 (2026-05-12): entity's PhysicsScript DID for in-world particle
    // effects. Used by entities.js::_spawnImpl to walk the Sky-J chain
    // and attach a per-entity ParticleManager emitter.
    physicsScriptDid: (upd.physicsScriptDid ?? 0) >>> 0,
    // Task E (2026-05-12): entity's SoundTable DID (0x20xxxxxx). Used
    // by entities.js::_spawnImpl to prewarm the SoundTableCache AND
    // by the per-frame hook executor to resolve SoundTable (hookType
    // 2) hooks via `soundTableCache.resolveSound(soundTableDid,
    // soundEnum)`. `0` for entities without a SoundTable property.
    soundTableDid: (upd.soundTableDid ?? 0) >>> 0,
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
        const g = upd.guid >>> 0;
        // Cohere-B follow-on (2026-05-12): skip the snap-to-server for
        // the local player. `applyLocalPlayerPoseFromIntegrator` runs
        // every rAF and reads the wasm integrator's pose directly, so
        // KIND_POSITION events for the local guid would just fight that
        // (the server pose lags client integration when, e.g., Run skill
        // is low). Non-local entities still snap as authoritative.
        if (!isLocalPlayerGuid(g)) {
          em.setPose(
            g,
            wx,
            wy,
            upd.z ?? 0,
            upd.qw ?? 1,
            upd.qx ?? 0,
            upd.qy ?? 0,
            upd.qz ?? 0
          );
        }
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
          // Cohere-B follow-on (2026-05-12): skip the snap-to-server
          // for the local player here too — the per-rAF integrator
          // sync in `applyLocalPlayerPoseFromIntegrator` owns the
          // local rig's pose. KIND_POSITION still updates
          // `__lastEntityWorldPos` (above) so the camera's Workstream
          // B reconciliation gate sees the fresh `ts` and behaves
          // correctly.
          if (!isLocalPlayerGuid(g)) {
            em.setPose(
              g,
              wx, wy, wz,
              upd.qw ?? 1, upd.qx ?? 0, upd.qy ?? 0, upd.qz ?? 0
            );
          }
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
