// scene3d/vehicle/index.js — holtburger vehicles (HBV1), the capable client (vehicles DESIGN.md §6).
//
// Flag `?vehicles=on`, DEFAULT OFF (exact match). Loaded by scene3d/index.js through a dynamic import only under the
// flag; without it nothing here loads and the session never announces the capability, so the server never sends it a
// vehicle message (it stays a standard client). With it:
//   * after entering the world the session sends ClientCapabilities{observe, pilot};
//   * every vehicle message is drained from the wasm inbox once per frame (SessionHandle.drainVehicleMessages);
//   * a vehicle the server created (a standard object with the retail stand-in Setup) is drawn at the vehicle pose —
//     the pilot's own vehicle at the PREDICTED pose (predictor.js), others interpolated ~120 ms behind;
//   * while seated: the input lock (controls.js), 30 Hz VehicleInput with two redundant frames, the local body slaved
//     to the predicted seat (SessionHandle.setVehicleSeat), the chase / cockpit camera through film's camera owner,
//     the OSD, and the client streaming load point fed ahead of the aircraft (velocity × the profile's lead seconds).
//   * after a bail: the fall twin (fall_model.js) under the fall camera, the canopy (chute.js) and the body's pose —
//     retail Falling, the canopy grip, the parachute pack (fall_pose.js, `?vehicleFallAnim`) — for observed fallers too.
// `liveScene3d.vehicles.afterTick(ts, dt)` runs every frame after tickPerFrame (scene3d/index.js), so the transforms
// written here are the last word before render.
//
// Debug / bench surface: `window.__vehicles` (status, board, exit, setSticks, spawn, despawn, ...).

import * as FM from "./flight_model.js";
import * as GM from "./ground_model.js";
import { createObserverTrack, createPilotPredictor, stateFromMsg, OBSERVER_DELAY_S } from "./predictor.js";
import { createVehicleControls } from "./controls.js";
import { createVehicleOsd } from "./osd.js";
import { createWeaponsFx, predictImpact } from "./weapons.js";
import { airframeEnabled, createAirframes, hasComposite, kindOrdinal } from "./airframe.js";
import { aeroFxEnabled, createAeroFx } from "./aero_fx.js";
import { createPilotCameraRig, VIEW_MODES, COCKPIT_EYE, HOOD_EYE } from "./camera_rig.js";
import { createVehicleAudio, createGroundVehicleAudio, vehicleAudioEnabled, threeToAcPos, createLogisticsAudio } from "./audio.js";
import { stepFall } from "./fall_model.js";
import { boardAnimEnabled, headingOfQuat, hopDuration, hopHeading, hopPoint, HOP } from "./board_hop.js";
import { chuteEnabled, createChutes } from "./chute.js";
import { createFallPose, fallAnimEnabled, fallTimeoutSec } from "./fall_pose.js";
import { portalSpaceOwnsFrame } from "../portal_space.js";
import { wireframeFlagOn } from "../wireframe_flag.js";
import { createCameraOwner } from "../film/runtime/camera_owner.js";
import { rlogEvent, RLOG } from "../residency_log.js";
import { flightResidencyEnabled, setFlightHint, clearFlightHint } from "../residency.js";
import { buildDeployable, DEPLOYABLE_WCID, DEPLOYABLE_KINDS } from "./deployable_models.js";
import { buildDeployedRadar } from "./radar_model.js";
import { buildProceduralJeep } from "./jeep_model.js";
import { buildSemiTruck } from "./semi_truck_model.js";
import { buildSemiTrailer, resolveTrailerKind, TRAILER_WCID, isSidelifterKind } from "./trailer_models.js";
import { buildSidelifterTrailer, SIDELIFTER_WCID } from "./sidelifter_model.js";
import * as SK from "./sidelifter_kinematics.js";
import { worldGroundHeight } from "../world_terrain.js";
import { buildPalletJack, PALLET_JACK_WCID } from "./pallet_jack_model.js";
import * as CL from "./container_logistics.js";
import { createPalletJackController, PALLET_JACK_ACTION, inOpenModal } from "./pallet_jack_controller.js";
import { isTypingTarget } from "../drone/controls.js";
import * as TK from "./trailer_kinematics.js";
import {
  buildIsoContainer,
  buildContainer,
  ISO_CONTAINER_SPECS,
  CONTAINER_WCID,
  DEPLOYABLE_KIND,
  CONTAINER_KINDS,
  CONTAINER_LIVERIES,
} from "./container_models.js";
import { requestShadowRaster } from "../interior_shadow_cull.js";
import { createGroundFx } from "./ground_fx.js";
import { applySeatPoseToEntity, getSeatOffset, interpolateSeatHotSwap } from "./seat_poses.js";
import { createDeployableCombatVfx } from "./deployable_vfx.js";
import { DeployableAudioManager } from "./deployable_audio.js";
import { createWarehouseManager } from "./warehouse_manager.js";
import { createPortAudio, portAudioEnabled } from "./port_audio.js";
import { createPortTerminalManager } from "./port_terminal_manager.js";
import { createShipManager } from "./ship_manager.js";
import { PORT_ORIGIN, WAREHOUSE_PORT_ORIGIN } from "./port_specs.js";
import { RadarScopeHud } from "./radar_scope.js";

export { vehicleAudioEnabled };
export const CAP_OBSERVE = 0x1;
export const CAP_PILOT = 0x2;
export const BOARD_RANGE_M = 8;
export const CHASE = Object.freeze({
  back: 16, up: 4.5, lookAhead: 30, pitch: -0.12, fov: 70,
  headingTau: 0.25, pitchTau: 0.14, rollTau: 0.14,
  groundClear: 2, groundAttackTau: 0.06, groundReleaseTau: 0.28,
});
// Aligned through the F6F armored windscreen and Mk 8 Reflector Gunsight (seat z 2.34 + 1.24 = 3.58 m)
export const COCKPIT = Object.freeze({ up: COCKPIT_EYE.up, forward: COCKPIT_EYE.forward, fov: COCKPIT_EYE.fov });
export const HOOD = Object.freeze({ up: HOOD_EYE.up, forward: HOOD_EYE.forward, fov: HOOD_EYE.fov });
/** The bomb release adds this downward speed (m/s) to the aircraft's velocity (the server's BombEjectSpeed). */
export const BOMB_EJECT = 1.5;
/** Seconds between two bomb-pipper solutions (the ballistic walk samples the terrain): 3.5 m of travel at 250 km/h — at
 *  0.1 s the pipper lagged ~7 m and a release on it landed ~11 m long (bench armament-a). */
export const PIPPER_SEC = 0.05;
/** Camera while falling after a bail-out: behind and a little above the body, so the canopy is in frame. */
// landHoldSec: after the Touchdown the fall camera keeps its last pose this long before the follow camera takes over —
// the landing link and the canopy's 0.7 s collapse play in the descent's own framing (released at once it cut to a
// close follow view of the grass: film take D2 / D2-2)
export const FALL_CAM = Object.freeze({ back: 12, up: 3.5, pitch: -0.08, fov: 70, headingTau: 0.6, landHoldSec: 3 });
// The bail hand-off. ACE's VehicleBailout.Bail releases the seat (VehicleSeat Empty) and THEN broadcasts the Bail
// event; the two can reach the client 1-4 frames apart. Before, the seat release stopped piloting at once: the pilot
// camera was released (the follow camera drew those frames) and the aircraft fell back to its observer track, whose
// only samples were the parked ones from before boarding (drawn at the spawn, km away) — film takes D2 / D2-t2 /
// D2-2-t1 / D2-2: the Hellcat vanished for 1-4 frames at the bail and the camera jumped ~32 px. Now a seat released
// in the air starts a hand-off: the camera stays owned, the aircraft is dead-reckoned from the pilot's predictor
// (neutral input) until its fresh track has `trackSnaps` samples, then eases onto the track (`vehicleClose`); the body
// rides the dead-reckoned seat. The Bail event adopts the camera and blends the chase framing into the fall camera
// over `camBlendSec` (in the body's moving frame), and the fall twin's drawn body eases from the predicted seat to the
// server's bail point (the predictor runs ahead of the server by the prediction lead, measured up to 37 m). No Bail
// within `maxSec` (or a teleport: ACE's OnPlayerTeleport releases the seat in the air too, with no Bail — ended at its
// PlayerTeleport, onTeleport, or before the movement tick when its destination landed first, beforeMovement): the
// camera is released as before.
// The eases are smoothsteps whose peak closing speed is at most `bodyClose` / `vehicleClose` of the speed (and at least
// `bodyMinSec` / `vehicleMinSec` long): an exponential over a fixed 0.3 s closed a 37 m lead at 123 m/s, faster than
// the body flew, and the body, the fall camera and the aircraft went BACKWARD for several frames after the Bail (film
// take D2-3). The dead-reckoned aircraft keeps at least its bail speed and sheds the lead together with the body, so it
// never moves backward relative to it; its hand-over onto the (~0.12 s delayed) observer track eases the rest slowly.
// snapM: a teleport's destination landed while the hand-off holds the body (beforeMovement): the body the wasm
// publishes is more than this (+ the aircraft's speed × the time since the last lock) from every recent lock.
export const BAIL_HANDOFF = Object.freeze({ maxSec: 1.5, trackSnaps: 3, reckonMaxSec: 2.5, vehicleMinSec: 0.45, vehicleClose: 0.04, camBlendSec: 1.2,
  bodyMinSec: 0.3, bodyClose: 0.5, maxOffsetM: 80, snapM: 25, trailLen: 4 });
/** A bail ease's remaining fraction at u = elapsed / length: 1 → 0 along a smoothstep (no velocity step at either end). */
function easeLeft(u) {
  return u >= 1 ? 0 : u <= 0 ? 1 : 1 - u * u * (3 - 2 * u);
}
/** A bail ease's length for `offM` metres: its peak closing speed (1.5·offM / length) at most `frac` of the speed. */
function easeSec(offM, speed, frac, minSec) {
  return Math.max(minSec, (1.5 * offM) / (frac * Math.max(10, speed)));
}
/** The seat locks set lately (the wasm movement tick snaps the body to one of them): {x, y, z, t}, newest last. */
function pushTrail(trail, seat, t) {
  trail.push({ x: seat.x, y: seat.y, z: seat.z, t });
  if (trail.length > BAIL_HANDOFF.trailLen) trail.shift();
}
export const EVENT_NAMES = Object.freeze({
  1: "takeoff", 2: "landed", 3: "crashed", 4: "despawn", 5: "bail", 6: "chute", 7: "touchdown", 8: "hit",
  9: "bombRelease", 10: "explosion", 11: "rearmed",
  12: "horn", 13: "headlights", 14: "scrape", 15: "cargoDeployed", 16: "cargoPacked",
  17: "ramHit", 18: "radarAlert",
  19: "trailerHitched", 20: "trailerUnhitched", 21: "twistlockToggled",
  22: "sideliftStarted", 23: "sideliftComplete", 24: "sideliftRefused", 25: "palletJackEvent",
});
export const TRAILER_ACTION = Object.freeze({
  None: 0,
  Hitch: 1,
  Unhitch: 2,
  ToggleTwistlock: 3,
  MountContainer: 4,
  UnmountContainer: 5,
  DeployOutriggers: 6,
  RetractOutriggers: 7,
  SideliftOffload: 8,
  SideliftLoad: 9,
  StowPalletJack: 10,
  DeployPalletJack: 11,
  CancelSidelift: 12,
  AutoOffload: 13,
  AutoLoad: 14,
});
export { PALLET_JACK_ACTION };
export const SIDELIFT_REFUSAL_REASONS = Object.freeze({
  0: "ISO 3874: Sidelift refused",
  1: "ISO 3874: Close container doors before sidelift",
  2: "ISO 3874: Unlock container twistlocks before sidelift",
  3: "ISO 3874: Terrain cross-slope exceeds 6° limit for outriggers",
  4: "ISO 3874: Park tractor completely (speed 0) before operating sidelifter",
  5: "ISO 3874: Deploy stabilizing outriggers before lifting",
  6: "ISO 3874: Container or ground landing zone obstructed",
  7: "ISO 3874: Sidelift sequence already in progress",
});
export const PALLET_JACK_EVENT_REASONS = Object.freeze({
  0: "ISO 3691-5: Pallet jack action completed",
  1: "ISO 3691-5: Pallet jack grabbed",
  2: "ISO 3691-5: Pallet jack released",
  3: "ISO 3691-5: Stow/unpower deployable before pallet pickup",
  4: "ISO 6780 LIFO: Bay slot blocked by forward pallets",
  5: "ISO 3691-5: Container doors must be open before pallet access",
  6: "ISO 3691-5: Move within range and align forks with pallet",
  7: "ISO 3691-5: Pallet jack already operated by another player",
});
export const TRAILER_FLAG = Object.freeze({
  COUPLED: 0x01,
  TWISTLOCKS_LOCKED: 0x02,
  GEAR_RETRACTED: 0x04,
  BRAKE_LIGHTS: 0x08,
});

function isSemiProfile(p) {
  return Boolean(p && (p.profileKey === "semi-379" || p.vehicleClass === 3));
}
function isSemiVehicle(v) {
  return Boolean(v && (isSemiProfile(v.profile) || isSemiProfile(v.params)));
}
function isGroundVehicle(v) {
  return Boolean(v && (v.locomotion === 2 || v.profile?.locomotion === 2 || v.profile?.profileKey === "jeep-mb" || isSemiVehicle(v) || v.params?.locomotion === 2));
}
function maxSeatsOf(v) {
  if (Array.isArray(v?.profile?.seats) && v.profile.seats.length > 0) return v.profile.seats.length;
  return isSemiVehicle(v) ? 2 : (isGroundVehicle(v) ? 4 : 1);
}
/** Retail motion commands the pilot's rig holds (the server shows the same Sitting to every client). */
export const MOTION = Object.freeze({ SITTING: 0x41000013, READY: 0x41000003, NONCOMBAT: 0x8000003d });
const NEUTRAL_INPUT = Object.freeze({ throttle: 0, pitch: 0, roll: 0, yaw: 0, boost: false, fire: false, land: false });
// ?flightResidency (flight experience Phase 1, residency.js): publish the aircraft state as the residency centre
// instead of feeding the world streamer a second load point.
const FLIGHT_RESIDENCY = flightResidencyEnabled();
export const REFUSAL = Object.freeze(["", "too far", "seat taken", "not parked", "indoors", "leave combat mode first", "no capability", "busy", "vehicles are disabled on this server"]);

function nowSec() {
  return (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function cellToLandblockId(cell) {
  const raw = cell >>> 0;
  return ((raw & 0x8000) !== 0 && (raw & 0x7fff) < 0x0100)
    ? ((raw & 0xffff8000) >>> 0)
    : (((raw >>> 16) << 16) >>> 0);
}

export function initVehicles(liveOrDeps = {}, opts = {}) {
  if (liveOrDeps && liveOrDeps.liveScene3d) {
    return installVehicles(liveOrDeps);
  }
  return installVehicles({
    liveScene3d: liveOrDeps,
    THREE: opts.THREE ?? null,
    window: opts.window ?? (typeof window !== "undefined" ? window : null),
    ...opts,
  });
}

export function installVehicles(deps = {}) {
  const live = deps.liveScene3d;
  const THREE = deps.THREE ?? null;
  const win = deps.window ?? (typeof window !== "undefined" ? window : null);
  if (!live || !win) throw new Error("installVehicles: liveScene3d and window are required");
  if (win.__vehicles && typeof win.__vehicles.dispose === "function") win.__vehicles.dispose();

  const sh = () => win.__sessionHandle ?? live.sessionHandle ?? null;
  const localGuid = () => {
    try { return typeof win.getLocalPlayerGuid === "function" ? (win.getLocalPlayerGuid() >>> 0) : 0; } catch (_) { return 0; }
  };
  const em = () => live.entityManager ?? null;
  const ground = (x, y) => {
    const h = sh();
    if (h && typeof h.terrainHeightAt === "function") {
      const z = h.terrainHeightAt(x, y);
      if (z !== undefined && z !== null && Number.isFinite(z)) return z;
    }
    const wg = worldGroundHeight(x, y);
    return wg !== null && wg !== undefined && Number.isFinite(wg) ? wg : NaN;
  };

  const vehicles = new Map(); // guid → {guid, profile, params, seats:[], last, track}
  const caps = { handle: null, sentAt: 0, tries: 0, granted: null, ackAt: 0 };
  const events = []; // recent vehicle events (bench)
  const stats = { frames: 0, msgs: 0, states: 0, profiles: 0, fires: 0, events: 0, parseErrors: 0, inputsSent: 0, sendErrors: 0, boardRefusals: 0, lastRefusal: null, pruned: 0,
    handoffs: 0, lastHandoff: null };
  const osd = createVehicleOsd({
    document: win.document,
    onSeatClick: (seatIdx) => {
      const v = pilot ? pilot.vehicle : (passenger ? passenger.vehicle : null);
      if (!v) return;
      if (Number.isInteger(seatIdx) && seatIdx >= 0 && seatIdx < maxSeatsOf(v)) {
        requestSeatHotSwap(v, seatIdx);
      }
    },
  });
  const search = win.location?.search ?? "";
  const audioOn = vehicleAudioEnabled(search) && !live?.nullRender;
  const vehicleAudio = audioOn
    ? createVehicleAudio({
      bus: () => live.audioManager?.getEffectBus?.() ?? null,
      audioManager: live.audioManager,
      liveScene3d: live,
      isActive: () => live.audioManager?.isActive?.() !== false,
      volume: () => 0.85,
    })
    : null;
  const groundAudio = audioOn
    ? createGroundVehicleAudio({
      bus: () => live.audioManager?.getEffectBus?.() ?? null,
      audioManager: live.audioManager,
      liveScene3d: live,
      search,
      volume: () => 0.85,
    })
    : null;
  function listenerAcPos() {
    if (pilot && pilot.predictor) {
      const s = pilot.predictor.state;
      return [s.x, s.y, s.z];
    }
    if (passenger && passenger.vehicle) {
      const v = passenger.vehicle;
      const s = v.last ? stateFromMsg(v.last) : null;
      if (s) return [s.x, s.y, s.z];
    }
    if (fall) return [fall.rx, fall.ry, fall.rz];
    if (live.camera?.position) return threeToAcPos(live.camera.position);
    const me = em()?.entityMap?.get(localGuid());
    if (me?.root?.position) return [me.root.position.x, me.root.position.y, me.root.position.z];
    return null;
  }
  function listenerAcVel() {
    if (pilot && pilot.predictor && pilot.vehicle?.params) return FM.velocity(pilot.predictor.state, pilot.vehicle.params);
    if (passenger && passenger.vehicle) {
      const v = passenger.vehicle;
      if (v.last && Number.isFinite(v.last.speed) && Number.isFinite(v.last.heading)) {
        const spd = v.last.speed, h = v.last.heading;
        return [spd * Math.sin(h), spd * Math.cos(h), 0];
      }
    }
    if (fall) return [fall.vx, fall.vy, fall.vz];
    return [0, 0, 0];
  }
  // the armament's looks (quarrels, rail flashes, falling bombs, explosions) and the composite airframe (airframe.js)
  const fx = createWeaponsFx({
    liveScene3d: live, THREE, ground,
    onExplode: (at, lb) => { try { vehicleAudio?.explosion({ pos: at, lb, listenerPos: listenerAcPos() }); } catch (_) {} },
  });
  const deployableVfx = THREE ? createDeployableCombatVfx({
    liveScene3d: live,
    THREE,
    ground,
    getTargetPos: (guid) => {
      const g = guid >>> 0;
      if (!g) return null;
      if (pilot && pilot.vehicle?.guid === g && pilot.predictor?.state) {
        const s = pilot.predictor.state;
        return [s.x, s.y, s.z];
      }
      const gmPos = groundModels.get(g)?.root?.position;
      if (gmPos) return [gmPos.x, gmPos.y, gmPos.z];
      const afPos = airframes?.get?.(g)?.root?.position;
      if (afPos) return [afPos.x, afPos.y, afPos.z];
      const emPos = em()?.entityMap?.get(g)?.root?.position;
      if (emPos) return [emPos.x, emPos.y, emPos.z];
      const v = vehicles.get(g);
      if (v?.last && v.last.cell) return FM.toGlobal(v.last.cell, v.last.x, v.last.y, v.last.z);
      return null;
    },
  }) : null;
  const deployableAudio = audioOn ? new DeployableAudioManager(live.audioManager?.getEffectBus?.() ?? null, { enabled: true }) : null;
  const logisticsAudio = audioOn
    ? createLogisticsAudio({
      bus: () => live.audioManager?.getEffectBus?.() ?? null,
      audioManager: live.audioManager,
      liveScene3d: live,
      search,
    })
    : null;
  const radarScope = new RadarScopeHud({ width: 236, height: 236, mode: "combined" });
  const deployables = new Map(); // guid -> { guid, kind, wcid, model, last, lastSeenAt, standInHidden }
  const containers = new Map(); // guid -> { guid, kind, wcid, model, last, cell, rawPos, heading, targetDoorProgress, currentDoorProgress, lastDoorOpen, lastSeenAt, standInHidden, liveryId, serialNumber, slots }
  const trailers = new Map(); // guid -> { guid, kind, specKind, wcid, model, last, cell, rawPos, worldPos, heading, pitch, bank, coupledTractorGuid, mountedContainerGuid, containerSlot, trailerFlags, ownerGuid, coupledKinState, renderedPose, lastSeenAt, standInHidden, isSidelifter, ...v7 }
  const palletJacks = new Map(); // guid -> { guid, model, operatorGuid, stowedOnTrailerGuid, cell, rawPos, worldPos, heading, tillerAngle, forkHeightM, forkState, carriedPalletSize, flags, carriedWcid, ownerGuid, last, lastSeenAt, standInHidden }
  let palletJackController = null;
  const groundModels = new Map(); // guid -> procedural jeep or semi-379 instance
  const jeepModels = groundModels; // backward compatibility alias
  const groundFx = THREE ? createGroundFx({ THREE, root: live.worldRoot, liveScene3d: live }) : null;

  function ensureGroundModel(v) {
    if (!THREE || !live?.worldRoot) return null;
    const g = v.guid >>> 0;
    const wantSemi = isSemiVehicle(v);
    const wantLivery = v.profile?.liveryId;
    let model = groundModels.get(g);
    if (model) {
      const isCurrentlySemi = model.root?.userData?.profileKey === "semi-379";
      const liveryMismatch = wantSemi && wantLivery !== undefined && model.livery?.id !== (wantLivery | 0);
      if (isCurrentlySemi !== wantSemi || liveryMismatch) {
        try {
          if (model.root?.parent) model.root.parent.remove(model.root);
          model.dispose?.();
        } catch (_) {}
        groundModels.delete(g);
        model = null;
      }
    }
    if (!model) {
      model = wantSemi
        ? buildSemiTruck(THREE, v.profile || {}, {
          liveScene3d: live,
          csmState: live.csmState,
          liveryId: wantLivery ?? 0,
        })
        : buildProceduralJeep(THREE, v.profile || {}, { liveScene3d: live });
      live.worldRoot.add(model.root);
      groundModels.set(g, model);
      const inEm = em()?.entityMap?.get(g);
      if (inEm && (!v.standInHidden || inEm._filmHidden !== true)) {
        try { if (em()?.setFilmHidden?.(g, true)) v.standInHidden = true; } catch (_) {}
      }
    }
    return model;
  }
  let latestAirContacts = [];
  let latestGroundContacts = [];
  let scopeMounted = false;

  const KIND_TO_WCID = Object.freeze({
    [DEPLOYABLE_KINDS.FluxPod]: DEPLOYABLE_WCID.FluxPod,
    [DEPLOYABLE_KINDS.SolarPanels]: DEPLOYABLE_WCID.SolarPanels,
    [DEPLOYABLE_KINDS.PowerGenerator]: DEPLOYABLE_WCID.PowerGenerator,
    [DEPLOYABLE_KINDS.BatteryUnit]: DEPLOYABLE_WCID.BatteryUnit,
    [DEPLOYABLE_KINDS.MissileTurret]: DEPLOYABLE_WCID.MissileTurret,
    [DEPLOYABLE_KINDS.GroundRadar]: DEPLOYABLE_WCID.GroundRadar,
    [DEPLOYABLE_KINDS.MortarTurret]: DEPLOYABLE_WCID.MortarTurret,
    [DEPLOYABLE_KINDS.HeavyLaserTurret]: DEPLOYABLE_WCID.HeavyLaserTurret,
  });

  function ensureDeployableEntry(guid, kindOrWcid, initialFlags = 0) {
    if (!THREE || !live?.worldRoot) return null;
    const g = guid >>> 0;
    let entry = deployables.get(g);
    const wcid = kindOrWcid >= 4000000 ? kindOrWcid : (KIND_TO_WCID[kindOrWcid] || (kindOrWcid === 1 ? 4000002 : 0));
    if (!wcid) return null;
    if (entry && entry.wcid !== wcid) {
      try { if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root); entry.model?.dispose?.(); } catch (_) {}
      deployables.delete(g);
      entry = null;
    }
    if (!entry) {
      const stowed = Boolean(initialFlags & 0x10);
      const model = wcid === 4000002
        ? buildDeployedRadar(THREE, { csmState: live.csmState, stowed })
        : buildDeployable(THREE, wcid, { csmState: live.csmState, stowed });
      live.worldRoot.add(model.root);
      const now = nowSec();
      entry = {
        guid: g,
        wcid,
        model,
        last: null,
        lastSeenAt: now,
        lastMsgAt: now,
        standInHidden: false,
        seenInEm: Boolean(em()?.entityMap?.get(g)),
        localOnly: false,
      };
      deployables.set(g, entry);
    }
    return entry;
  }

  function removeDeployableEntry(guid) {
    const g = guid >>> 0;
    const entry = deployables.get(g);
    try { deployableAudio?.stopGeneratorHum?.(g); } catch (_) {}
    if (!entry) return;
    try { if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root); entry.model?.dispose?.(); } catch (_) {}
    if (entry.standInHidden) {
      try { em()?.setFilmHidden?.(g, false); } catch (_) {}
    }
    deployables.delete(g);
  }

  const CONTAINER_KIND_TO_WCID = Object.freeze({
    10: 4000020,
    11: 4000021,
    12: 4000022,
    [CONTAINER_WCID?.IsoContainer20 ?? 4000020]: 4000020,
    [CONTAINER_WCID?.IsoContainer40 ?? 4000021]: 4000021,
    [CONTAINER_WCID?.IsoContainer40HC ?? 4000022]: 4000022,
  });

  const CONTAINER_WCID_TO_KIND = Object.freeze({
    4000020: 10,
    4000021: 11,
    4000022: 12,
    10: 10,
    11: 11,
    12: 12,
  });

  function isSideliftTransferActive(tr) {
    const ph = tr?.sideliftPhase ?? 0;
    return Boolean(tr && tr.isSidelifter && ph >= SK.SIDELIFT_PHASE.CranesPositioning && ph <= SK.SIDELIFT_PHASE.Releasing);
  }

  function isSideliftColliderSuppressed(tr) {
    const ph = tr?.sideliftPhase ?? 0;
    return Boolean(tr && tr.isSidelifter && ph >= SK.SIDELIFT_PHASE.CranesPositioning && ph <= SK.SIDELIFT_PHASE.CranesStowing);
  }

  function findClaimingTrailer(cGuid) {
    const g = cGuid >>> 0;
    if (!g) return null;
    for (const tr of trailers.values()) {
      if ((tr.mountedContainerGuid >>> 0) === g) return tr;
      if (tr.isSidelifter && (tr.transferContainerGuid >>> 0) === g && isSideliftColliderSuppressed(tr)) {
        return tr;
      }
    }
    return null;
  }

  function ensureContainerEntry(guid, kindOrWcid, initialMsg = {}) {
    if (!THREE || !live?.worldRoot) return null;
    const g = guid >>> 0;
    let entry = containers.get(g);
    const kind = CONTAINER_WCID_TO_KIND[kindOrWcid] ?? 10;
    const wcid = CONTAINER_KIND_TO_WCID[kindOrWcid] ?? 4000020;

    if (entry && entry.kind !== kind) {
      try {
        if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root);
        entry.model?.dispose?.();
      } catch (_) {}
      containers.delete(g);
      entry = null;
    }

    if (!entry) {
      const initProgress = Number.isFinite(initialMsg.doorProgress)
        ? initialMsg.doorProgress
        : (initialMsg.doorState === 2 ? 1.0 : 0.0);
      const model = buildIsoContainer(THREE, wcid, {
        csmState: live.csmState,
        liveryId: initialMsg.liveryId ?? 0,
        serialNumber: initialMsg.serialNumber ?? 0,
        doorProgress: initProgress,
      });
      live.worldRoot.add(model.root);
      const rawPos = Array.isArray(initialMsg.position)
        ? initialMsg.position
        : [initialMsg.x ?? 0, initialMsg.y ?? 0, initialMsg.z ?? 0];
      const cell = initialMsg.cell ?? 0;
      const heading = Number.isFinite(initialMsg.heading) ? initialMsg.heading : 0;
      const isDoorOpen = initProgress >= 0.5;
      entry = {
        guid: g,
        kind,
        wcid,
        model,
        last: null,
        cell,
        rawPos,
        heading,
        targetDoorProgress: initProgress,
        currentDoorProgress: initProgress,
        lastDoorOpen: null,
        lastSeenAt: nowSec(),
        lastMsgAt: nowSec(),
        standInHidden: false,
        seenInEm: Boolean(em()?.entityMap?.get(g)),
        localOnly: false,
        liveryId: initialMsg.liveryId ?? 0,
        serialNumber: initialMsg.serialNumber ?? 0,
        slots: Array.isArray(initialMsg.slots) ? initialMsg.slots : [],
      };
      containers.set(g, entry);

      // Immediately register dynamic physical building collider in WASM physics on initial spawn (unless already claimed by a trailer)
      const claimedByTrailer = Boolean(findClaimingTrailer(g));
      if (!claimedByTrailer) {
        try {
          sh()?.upsertContainerCollider(g, cell, rawPos[0], rawPos[1], rawPos[2], heading, kind, isDoorOpen);
          entry.colliderActive = true;
        } catch (_) {}
      } else {
        entry.colliderActive = false;
      }

      // Invalidate static shadow cache on spawn so container casts dynamic sun shadows
      try { requestShadowRaster(live.renderer, live); } catch (_) {}
    }
    return entry;
  }

  function removeContainerEntry(guid) {
    const g = guid >>> 0;
    const entry = containers.get(g);
    if (!entry) return;
    if (entry.mountedOnTrailerGuid) {
      const host = trailers.get(entry.mountedOnTrailerGuid >>> 0);
      if (host) {
        try { host.model?.detachContainer?.(); } catch (_) {}
        if (host._attachedContainerGuid === g) host._attachedContainerGuid = 0;
        if ((host.mountedContainerGuid >>> 0) === g) host.mountedContainerGuid = 0;
        if ((host.transferContainerGuid >>> 0) === g) host.transferContainerGuid = 0;
      }
      entry.mountedOnTrailerGuid = 0;
    }
    for (const tr of trailers.values()) {
      if ((tr.transferContainerGuid >>> 0) === g) tr.transferContainerGuid = 0;
    }
    try {
      if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root);
      entry.model?.dispose?.();
    } catch (_) {}
    if (entry.standInHidden) {
      try { em()?.setFilmHidden?.(g, false); } catch (_) {}
    }
    try { sh()?.removeContainerCollider(g); } catch (_) {}
    try { requestShadowRaster(live.renderer, live); } catch (_) {}
    containers.delete(g);
  }

  function containerSlotToOpt(slot) {
    if (slot === 1 || slot === "front") return "front";
    if (slot === 2 || slot === "rear") return "rear";
    return "auto";
  }

  function unmountContainerFromTrailer(entry, cGuid) {
    const cg = cGuid >>> 0;
    try { entry.model?.detachContainer?.(); } catch (_) {}
    if (entry._attachedContainerGuid === cg) entry._attachedContainerGuid = 0;
    if (!cg) return;
    const cEntry = containers.get(cg);
    if (!cEntry) return;
    cEntry.mountedOnTrailerGuid = 0;
    cEntry._lastColliderSig = null;
    if (cEntry.model?.root) {
      if (live?.worldRoot && cEntry.model.root.parent !== live.worldRoot) {
        live.worldRoot.add(cEntry.model.root);
      }
      cEntry.model.root.quaternion.set(0, 0, 0, 1);
      const rp = cEntry.rawPos || [0, 0, 0];
      const [wx, wy, wz] = cEntry.cell ? FM.toGlobal(cEntry.cell, rp[0], rp[1], rp[2]) : [rp[0], rp[1], rp[2]];
      cEntry.model.root.position.set(wx, wy, wz);
      cEntry.model.root.rotation.z = -(cEntry.heading || 0);
      const doorOpen = cEntry.currentDoorProgress >= 0.5;
      try {
        sh()?.upsertContainerCollider?.(cEntry.guid, cEntry.cell, rp[0], rp[1], rp[2], cEntry.heading || 0, cEntry.kind, doorOpen);
        cEntry.colliderActive = true;
      } catch (_) {}
      try { requestShadowRaster(live.renderer, live); } catch (_) {}
    }
  }

  function syncTrailerContainerMount(entry) {
    if (!entry || !entry.model) return;
    if (isSideliftTransferActive(entry)) {
      if (entry._attachedContainerGuid) {
        try { entry.model?.detachContainer?.(); } catch (_) {}
        const detachedGuid = entry._attachedContainerGuid;
        entry._attachedContainerGuid = 0;
        const cDet = containers.get(detachedGuid);
        if (cDet?.model?.root && live?.worldRoot && cDet.model.root.parent !== live.worldRoot) {
          live.worldRoot.add(cDet.model.root);
        }
      }
      return;
    }
    const cGuid = (entry.mountedContainerGuid ?? 0) >>> 0;
    if (entry._attachedContainerGuid && entry._attachedContainerGuid !== cGuid) {
      unmountContainerFromTrailer(entry, entry._attachedContainerGuid);
    }
    if (cGuid === 0) {
      if (!isSideliftColliderSuppressed(entry)) {
        for (const cEntry of containers.values()) {
          if (cEntry.mountedOnTrailerGuid === entry.guid) {
            unmountContainerFromTrailer(entry, cEntry.guid);
          }
        }
      }
      return;
    }
    const cEntry = containers.get(cGuid);
    if (!cEntry || !cEntry.model) return;
    const slotOpt = containerSlotToOpt(entry.containerSlot);
    if (cEntry.mountedOnTrailerGuid !== entry.guid || entry.model.mountedContainer !== cEntry.model || entry._attachedContainerSlot !== slotOpt) {
      if (cEntry.mountedOnTrailerGuid && cEntry.mountedOnTrailerGuid !== entry.guid) {
        const prevHost = trailers.get(cEntry.mountedOnTrailerGuid >>> 0);
        if (prevHost) unmountContainerFromTrailer(prevHost, cGuid);
      }
      entry.model.attachContainer(cEntry.model, { position: slotOpt });
      cEntry.mountedOnTrailerGuid = entry.guid;
      cEntry._lastColliderSig = null;
      entry._attachedContainerGuid = cGuid;
      entry._attachedContainerSlot = slotOpt;
      try { requestShadowRaster(live.renderer, live); } catch (_) {}
    }
  }

  function ensureTrailerEntry(guid, kindOrWcid, initialMsg = {}) {
    if (!THREE || !live?.worldRoot) return null;
    const g = guid >>> 0;
    const isSidelifter = isSidelifterKind(kindOrWcid) || Boolean((initialMsg.sideliftFlags ?? 0) & 0x01);
    const specKind = resolveTrailerKind(isSidelifter ? 15 : kindOrWcid);
    const wireKind = isSidelifter ? 15 : (specKind === "40ft" ? 14 : 13);
    const wcid = isSidelifter
      ? (SIDELIFTER_WCID ?? 4000032)
      : (specKind === "40ft" ? (TRAILER_WCID?.Chassis40ft ?? 4000031) : (TRAILER_WCID?.Chassis20ft ?? 4000030));
    let entry = trailers.get(g);
    if (entry && (entry.specKind !== specKind || Boolean(entry.isSidelifter) !== isSidelifter)) {
      if (entry._attachedContainerGuid) unmountContainerFromTrailer(entry, entry._attachedContainerGuid);
      try {
        if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root);
        entry.model?.dispose?.();
      } catch (_) {}
      trailers.delete(g);
      entry = null;
    }
    if (!entry) {
      const flags = initialMsg.trailerFlags ?? 0;
      const slFlags = initialMsg.sideliftFlags ?? 0;
      const slPhase = initialMsg.sideliftPhase ?? 0;
      const slSide = initialMsg.sideliftSide ?? 1;
      const outProg = initialMsg.outriggerProgress ?? 0;
      const slProg = initialMsg.sideliftProgress ?? 0;
      const spanY = initialMsg.craneSpanY || SK.CRANE_SPAN_Y_40FT;
      const modelOpts = {
        csmState: live.csmState,
        twistlockState: (flags & TRAILER_FLAG.TWISTLOCKS_LOCKED) ? 1 : 0,
        landingGearRetracted: Boolean((flags & TRAILER_FLAG.GEAR_RETRACTED) || (initialMsg.coupledTractorGuid >>> 0)),
        brakeLights: Boolean(flags & TRAILER_FLAG.BRAKE_LIGHTS),
      };
      const model = isSidelifter
        ? buildSidelifterTrailer(THREE, {
          ...modelOpts,
          hasStowedPalletJack: Boolean((slFlags & 0x08) || (initialMsg.stowedPalletJackGuid >>> 0)),
          craneSpanY: spanY,
          sideliftPhase: slPhase,
          sideliftSide: slSide,
          outriggerProgress: outProg,
          sideliftProgress: slProg,
        })
        : buildSemiTrailer(THREE, specKind, modelOpts);
      const rawPos = Array.isArray(initialMsg.position)
        ? initialMsg.position
        : [initialMsg.x ?? 0, initialMsg.y ?? 0, initialMsg.z ?? 0];
      const cell = (initialMsg.cell ?? 0) >>> 0;
      const worldPos = cell ? FM.toGlobal(cell, rawPos[0], rawPos[1], rawPos[2]) : [rawPos[0], rawPos[1], rawPos[2]];
      const heading = Number.isFinite(initialMsg.heading) ? initialMsg.heading : 0;
      const pitch = Number.isFinite(initialMsg.pitch) ? initialMsg.pitch : 0;
      const bank = Number.isFinite(initialMsg.bank) ? initialMsg.bank : 0;
      const qInit = FM.orientation(heading, pitch, bank);
      model.root.position.set(worldPos[0], worldPos[1], worldPos[2]);
      model.root.quaternion.set(qInit[1], qInit[2], qInit[3], qInit[0]);
      live.worldRoot.add(model.root);
      entry = {
        guid: g,
        kind: wireKind,
        specKind,
        isSidelifter,
        wcid,
        model,
        last: null,
        cell,
        rawPos,
        worldPos,
        heading,
        pitch,
        bank,
        coupledTractorGuid: (initialMsg.coupledTractorGuid ?? 0) >>> 0,
        mountedContainerGuid: (initialMsg.mountedContainerGuid ?? 0) >>> 0,
        containerSlot: initialMsg.containerSlot ?? 0,
        trailerFlags: flags,
        ownerGuid: (initialMsg.ownerGuid ?? 0) >>> 0,
        sideliftPhase: slPhase,
        sideliftSide: slSide,
        sideliftFlags: slFlags,
        sideliftProgress: slProg,
        outriggerProgress: outProg,
        craneSpanY: spanY,
        stowedPalletJackGuid: (initialMsg.stowedPalletJackGuid ?? 0) >>> 0,
        transferContainerGuid: (initialMsg.transferContainerGuid ?? 0) >>> 0,
        _smoothSideliftProgress: slProg,
        _smoothOutriggerProgress: outProg,
        _lastSideliftPhase: slPhase,
        _lastAudioPhase: slPhase,
        coupledKinState: {
          x: worldPos[0], y: worldPos[1], z: worldPos[2],
          heading, pitch, bank, articulationRad: 0,
        },
        renderedPose: { x: worldPos[0], y: worldPos[1], z: worldPos[2], heading, pitch, bank },
        lastSeenAt: nowSec(),
        lastMsgAt: nowSec(),
        standInHidden: false,
        seenInEm: Boolean(em()?.entityMap?.get(g)),
        localOnly: false,
        _attachedContainerGuid: 0,
        _attachedContainerSlot: "auto",
        _wasCoupledTo: 0,
        _posedFrame: -1,
        _tractorSpeed: 0,
        _tractorMode: FM.MODE.PARKED,
      };
      trailers.set(g, entry);
      try { requestShadowRaster(live.renderer, live); } catch (_) {}
    }
    return entry;
  }

  function removeTrailerEntry(guid) {
    const g = guid >>> 0;
    const entry = trailers.get(g);
    if (!entry) return;
    try { logisticsAudio?.stopSidelifter?.(g); } catch (_) {}
    if (entry._attachedContainerGuid || entry.mountedContainerGuid) {
      unmountContainerFromTrailer(entry, entry._attachedContainerGuid || entry.mountedContainerGuid);
    }
    try {
      if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root);
      entry.model?.dispose?.();
    } catch (_) {}
    if (entry.standInHidden) {
      try { em()?.setFilmHidden?.(g, false); } catch (_) {}
    }
    try { requestShadowRaster(live.renderer, live); } catch (_) {}
    trailers.delete(g);
    const coupledTractorGuid = (entry.coupledTractorGuid ?? 0) >>> 0;
    for (const v of vehicles.values()) {
      const hitched = (v.last?.hitchedTrailerGuid ?? 0) >>> 0;
      if (hitched === g || (coupledTractorGuid !== 0 && (v.guid >>> 0) === coupledTractorGuid)) {
        if (v.last && hitched === g) v.last.hitchedTrailerGuid = 0;
        v._coupledTrailerKind = null;
        v._coupledArticulationRad = 0;
        v._coupledTrailerPitch = 0;
        v._coupledTwistlocksLocked = false;
        v._coupledTrailerFlags = 0;
        if (v.params) {
          const mul = computeTowMassMul(v);
          v.params.towMassMul = mul;
          if (pilot && pilot.vehicle === v && pilot.predictor?.state) {
            pilot.predictor.state.towMassMul = mul;
          }
        }
      }
    }
  }

  function currentHitchedTrailerGuid(v) {
    if (!v) return 0;
    const fromState = (v.last?.hitchedTrailerGuid ?? 0) >>> 0;
    if (fromState !== 0) return fromState;
    for (const tr of trailers.values()) {
      if ((tr.coupledTractorGuid >>> 0) === (v.guid >>> 0)) return tr.guid;
    }
    return 0;
  }

  function computeTowMassMul(v) {
    const hGuid = currentHitchedTrailerGuid(v);
    if (!hGuid) return TK.TOW_MASS_MUL.BOBTAIL;
    const tr = trailers.get(hGuid);
    if (tr && (tr.mountedContainerGuid >>> 0) !== 0) return TK.TOW_MASS_MUL.LOADED_40FT;
    return TK.TOW_MASS_MUL.EMPTY_CHASSIS;
  }

  function findNearestUnhitchedTrailer(v, maxDistM = 3.5) {
    if (!v) return null;
    let pose = null;
    if (pilot && pilot.vehicle === v && pilot.predictor) {
      pose = pilot.predictor.state;
    } else if (v.last) {
      pose = stateFromMsg(v.last);
    }
    if (!pose) return null;
    const hitchY = (Number.isFinite(v.profile?.fifthWheelOffsetY) && v.profile.fifthWheelOffsetY !== 0)
      ? v.profile.fifthWheelOffsetY
      : -2.01;
    const hitchZ = (Number.isFinite(v.profile?.fifthWheelOffsetZ) && v.profile.fifthWheelOffsetZ !== 0)
      ? v.profile.fifthWheelOffsetZ
      : 0.96;
    const fw = TK.computeFifthWheelPose(pose, hitchY, hitchZ);
    let best = null;
    let bestD = maxDistM;
    for (const tr of trailers.values()) {
      if ((tr.coupledTractorGuid >>> 0) !== 0) continue;
      const spec = TK.resolveTrailerSpec(tr.specKind);
      const qTr = FM.orientation(tr.heading || 0, tr.pitch || 0, tr.bank || 0);
      const kpOff = FM.rotate(qTr, [0, spec.kpY, spec.kingpinZ]);
      const kpX = tr.worldPos[0] + kpOff[0];
      const kpY = tr.worldPos[1] + kpOff[1];
      const d = Math.hypot(kpX - fw.x, kpY - fw.y);
      if (d <= bestD) {
        bestD = d;
        best = tr;
      }
    }
    return best;
  }

  function syncTractorCoupledTrailer(v, pose, dt, isLocalPilot, opts = {}) {
    if (!v || !pose) return null;
    const hGuid = currentHitchedTrailerGuid(v);
    if (!hGuid) {
      v._coupledTrailerPitch = 0;
      v._coupledTrailerKind = null;
      v._coupledArticulationRad = 0;
      v._coupledTwistlocksLocked = false;
      v._coupledTrailerFlags = 0;
      return null;
    }
    const tr = trailers.get(hGuid);
    if (!tr) {
      v._coupledTrailerKind = null;
      v._coupledArticulationRad = 0;
      v._coupledTrailerPitch = (v.last?.trailerPitch ?? 0) - (pose.pitch || 0);
      v._coupledTrailerFlags = v.last?.trailerFlags ?? 0;
      v._coupledTwistlocksLocked = Boolean(v._coupledTrailerFlags & TRAILER_FLAG.TWISTLOCKS_LOCKED);
      return null;
    }

    if (tr._wasCoupledTo !== v.guid) {
      tr.coupledKinState.heading = (v.last?.hitchedTrailerGuid === hGuid && Number.isFinite(v.last?.trailerHeading))
        ? v.last.trailerHeading
        : (Number.isFinite(tr.heading) ? tr.heading : (pose.heading ?? 0));
      tr._wasCoupledTo = v.guid;
    }

    const hitchY = (Number.isFinite(v.profile?.fifthWheelOffsetY) && v.profile.fifthWheelOffsetY !== 0)
      ? v.profile.fifthWheelOffsetY
      : -2.01;
    const fifthWheelZ = (Number.isFinite(v.profile?.fifthWheelOffsetZ) && v.profile.fifthWheelOffsetZ !== 0)
      ? v.profile.fifthWheelOffsetZ
      : 0.96;
    const tractorState = {
      x: pose.x,
      y: pose.y,
      z: pose.z,
      heading: pose.heading || 0,
      pitch: pose.pitch || 0,
      speed: pose.speed || 0,
      steerAngle: pose.steerAngle || 0,
      wheelbase: v.params?.wheelbase ?? v.profile?.wheelbase ?? 4.66,
      fifthWheelOffsetZ: fifthWheelZ,
      muLat: GM.SURFACE_FAMILIES[pose.surfaceFamily ?? 0]?.muLat ?? 1.0,
    };

    const stepDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    let trPose = TK.stepCoupledTrailer(tractorState, tr.coupledKinState, hitchY, tr.specKind, ground, stepDt);

    const srvHeading = (v.last?.hitchedTrailerGuid === hGuid && Number.isFinite(v.last?.trailerHeading))
      ? v.last.trailerHeading
      : tr.heading;
    if (Number.isFinite(srvHeading)) {
      const diff = angleDiff(srvHeading, tr.coupledKinState.heading);
      if (!isLocalPilot) {
        if (Math.abs(diff) > 0.6 || stepDt <= 0) {
          tr.coupledKinState.heading = srvHeading;
        } else {
          const alpha = 1 - Math.exp(-stepDt / 0.15);
          tr.coupledKinState.heading = FM.wrapHeading(tr.coupledKinState.heading + diff * alpha);
        }
        trPose = TK.stepCoupledTrailer(tractorState, tr.coupledKinState, hitchY, tr.specKind, ground, 0);
      } else if (Math.abs(pose.speed || 0) < 0.25 || Math.abs(diff) > 0.25) {
        if (Math.abs(diff) > 0.7) {
          tr.coupledKinState.heading = srvHeading;
        } else if (stepDt > 0) {
          const alpha = 1 - Math.exp(-stepDt / 0.35);
          tr.coupledKinState.heading = FM.wrapHeading(tr.coupledKinState.heading + diff * alpha);
        }
        trPose = TK.stepCoupledTrailer(tractorState, tr.coupledKinState, hitchY, tr.specKind, ground, 0);
      }
    }

    const qTr = FM.orientation(trPose.heading, trPose.pitch, trPose.bank);
    tr.model.root.position.set(trPose.x, trPose.y, trPose.z);
    tr.model.root.quaternion.set(qTr[1], qTr[2], qTr[3], qTr[0]);
    writeEntity(tr.guid, trPose.x, trPose.y, trPose.z, qTr, true);

    const tFlags = (v.last?.hitchedTrailerGuid === hGuid && v.last?.trailerFlags !== undefined)
      ? v.last.trailerFlags
      : tr.trailerFlags;
    const twistlockState = (tFlags & TRAILER_FLAG.TWISTLOCKS_LOCKED) ? 1 : 0;
    const brakeLights = Boolean((tFlags & TRAILER_FLAG.BRAKE_LIGHTS) || opts.braking);
    const bogieSpeed = (pose.speed || 0) * Math.cos(trPose.articulationRad || 0);
    try {
      tr.model.update(stepDt, {
        twistlockState,
        landingGearRetracted: true,
        brakeLights,
        speed: bogieSpeed,
      });
    } catch (_) {}

    tr._posedFrame = stats.frames;
    tr._tractorSpeed = pose.speed || 0;
    tr._tractorMode = pose.mode ?? FM.MODE.PARKED;
    tr.renderedPose = trPose;

    v._coupledTrailerPitch = trPose.pitch - (pose.pitch || 0);
    v._coupledTrailerKind = tr.specKind;
    v._coupledArticulationRad = trPose.articulationRad;
    v._coupledTwistlocksLocked = Boolean(tFlags & TRAILER_FLAG.TWISTLOCKS_LOCKED);
    v._coupledTrailerFlags = tFlags;
    return trPose;
  }

  function ensurePalletJackEntry(guid, initialMsg = {}) {
    if (!THREE || !live?.worldRoot) return null;
    const g = guid >>> 0;
    if (!g) return null;
    let entry = palletJacks.get(g);
    if (!entry) {
      const stowed = Boolean((initialMsg.stowedOnTrailerGuid ?? 0) !== 0 || ((initialMsg.flags ?? 0) & 0x04));
      const model = buildPalletJack(THREE, {
        csmState: live.csmState,
        forkHeightM: initialMsg.forkHeightM ?? 0.085,
        tillerAngle: initialMsg.tillerAngle ?? 0,
        carriedWcid: initialMsg.carriedWcid ?? 0,
        stowed,
      });
      const rawPos = Array.isArray(initialMsg.position)
        ? initialMsg.position
        : [initialMsg.x ?? 0, initialMsg.y ?? 0, initialMsg.z ?? 0];
      const cell = (initialMsg.cell ?? 0) >>> 0;
      const worldPos = cell ? FM.toGlobal(cell, rawPos[0], rawPos[1], rawPos[2]) : [rawPos[0], rawPos[1], rawPos[2]];
      const heading = Number.isFinite(initialMsg.heading) ? initialMsg.heading : 0;
      const qInit = FM.orientation(heading, 0, 0);
      model.root.position.set(worldPos[0], worldPos[1], worldPos[2]);
      model.root.quaternion.set(qInit[1], qInit[2], qInit[3], qInit[0]);
      if (!stowed) {
        live.worldRoot.add(model.root);
      }
      entry = {
        guid: g,
        wcid: PALLET_JACK_WCID,
        model,
        operatorGuid: (initialMsg.operatorGuid ?? 0) >>> 0,
        stowedOnTrailerGuid: (initialMsg.stowedOnTrailerGuid ?? 0) >>> 0,
        cell,
        rawPos,
        worldPos,
        heading,
        tillerAngle: Number.isFinite(initialMsg.tillerAngle) ? initialMsg.tillerAngle : 0,
        forkHeightM: Number.isFinite(initialMsg.forkHeightM) ? initialMsg.forkHeightM : 0.085,
        forkState: initialMsg.forkState ?? 0,
        carriedPalletSize: initialMsg.carriedPalletSize ?? 0,
        flags: initialMsg.flags ?? 0,
        carriedWcid: (initialMsg.carriedWcid ?? 0) >>> 0,
        ownerGuid: (initialMsg.ownerGuid ?? 0) >>> 0,
        last: null,
        lastSeenAt: nowSec(),
        lastMsgAt: nowSec(),
        standInHidden: false,
        seenInEm: Boolean(em()?.entityMap?.get(g)),
        localOnly: false,
      };
      palletJacks.set(g, entry);
      try { requestShadowRaster(live.renderer, live); } catch (_) {}
    }
    return entry;
  }

  function removePalletJackEntry(guid) {
    const g = guid >>> 0;
    const entry = palletJacks.get(g);
    if (!entry) return;
    if (palletJackController?.activeGuid === g) {
      try { palletJackController.stop("despawn"); } catch (_) {}
    }
    try { logisticsAudio?.stopWheelRoll?.(g); } catch (_) {}
    try {
      if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root);
      entry.model?.dispose?.();
    } catch (_) {}
    if (entry.standInHidden) {
      try { em()?.setFilmHidden?.(g, false); } catch (_) {}
    }
    palletJacks.delete(g);
  }

  function tickPalletJacks(dt) {
    for (const entry of palletJacks.values()) {
      const inEm = em()?.entityMap?.get(entry.guid);
      if (inEm) {
        entry.seenInEm = true;
        if (!entry.standInHidden || inEm._filmHidden !== true) {
          try { if (em()?.setFilmHidden?.(entry.guid, true)) entry.standInHidden = true; } catch (_) {}
        }
      }
      if (palletJackController?.activeGuid === entry.guid) continue;
      const stowed = Boolean(entry.stowedOnTrailerGuid !== 0 || (entry.flags & 0x04));
      if (stowed) {
        if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root);
        continue;
      }
      if (entry.model?.root && live?.worldRoot && entry.model.root.parent !== live.worldRoot) {
        live.worldRoot.add(entry.model.root);
      }
      const [wx, wy, wz] = entry.worldPos;
      const qPj = FM.orientation(entry.heading || 0, 0, 0);
      entry.model?.root?.position?.set(wx, wy, wz);
      entry.model?.root?.quaternion?.set(qPj[1], qPj[2], qPj[3], qPj[0]);
      try {
        entry.model?.update?.({
          forkHeightM: entry.forkHeightM,
          tillerAngle: entry.tillerAngle,
          pumpStroke: 0,
          carriedWcid: entry.carriedWcid,
          stowed: false,
        });
      } catch (_) {}
      writeEntity(entry.guid, wx, wy, wz, qPj, true);
    }
  }

  function updateSidelifterKinematicsAndPose(entry, dt, stepDt) {
    if (!entry || !entry.isSidelifter) return;
    const ph = entry.sideliftPhase ?? 0;
    if (entry._lastSideliftPhase !== ph) {
      entry._lastSideliftPhase = ph;
      entry._smoothSideliftProgress = entry.sideliftProgress ?? 0;
    } else if (stepDt > 0) {
      const dur = SK.getPhaseDuration(ph);
      if (dur > 0) {
        entry._smoothSideliftProgress = Math.min(1.0, (entry._smoothSideliftProgress ?? 0) + stepDt / dur);
      } else {
        entry._smoothSideliftProgress = entry.sideliftProgress ?? 0;
      }
      if (Number.isFinite(entry.sideliftProgress)) {
        entry._smoothSideliftProgress = Math.max(entry._smoothSideliftProgress, entry.sideliftProgress);
      }
    }
    if (ph === SK.SIDELIFT_PHASE.OutriggersDeploying) {
      entry._smoothOutriggerProgress = entry._smoothSideliftProgress;
    } else if (ph === SK.SIDELIFT_PHASE.OutriggersRetracting) {
      entry._smoothOutriggerProgress = 1.0 - entry._smoothSideliftProgress;
    } else if (ph >= SK.SIDELIFT_PHASE.OutriggersPlanted && ph <= SK.SIDELIFT_PHASE.CranesStowing) {
      entry._smoothOutriggerProgress = 1.0;
    } else {
      entry._smoothOutriggerProgress = entry.outriggerProgress ?? 0;
    }

    if (entry._lastAudioPhase !== ph) {
      entry._lastAudioPhase = ph;
      if (ph === SK.SIDELIFT_PHASE.OutriggersPlanted) {
        try { logisticsAudio?.outriggerThud?.({ pos: entry.worldPos }); } catch (_) {}
      }
    }
    try {
      logisticsAudio?.updateSidelifter?.(entry.guid, {
        phase: ph,
        sideliftPhase: ph,
        pos: entry.worldPos,
      });
      logisticsAudio?.setSwingWarning?.(
        entry.guid,
        ph >= SK.SIDELIFT_PHASE.Hoisting && ph <= SK.SIDELIFT_PHASE.Lowering,
        { pos: entry.worldPos }
      );
    } catch (_) {}

    const prog = entry._smoothSideliftProgress ?? entry.sideliftProgress ?? 0;
    const outProg = entry._smoothOutriggerProgress ?? entry.outriggerProgress ?? 0;
    const side = entry.sideliftSide < 0 ? -1 : 1;
    const slFlags = entry.sideliftFlags ?? 0;
    const isLoad = Boolean(slFlags & 0x10);
    const slotOpt = containerSlotToOpt(entry.containerSlot);
    const xferGuid = (entry.transferContainerGuid || entry.mountedContainerGuid) >>> 0;
    const xferC = xferGuid ? containers.get(xferGuid) : null;
    const cLen = xferC?.model?.spec?.external?.length ?? 12.192;
    const slotY = cLen < 7 ? (slotOpt === "front" ? 2.9295 : -2.9295) : 0.0;
    const trPose = entry.renderedPose ?? {
      x: entry.worldPos[0], y: entry.worldPos[1], z: entry.worldPos[2],
      heading: entry.heading || 0,
    };
    const trH = trPose.heading || 0;
    const cosH = Math.cos(trH);
    const sinH = Math.sin(trH);
    const sideX = side * SK.SIDELIFTER_OUTREACH_X;
    const sideWorldX = trPose.x + sideX * cosH + slotY * sinH;
    const sideWorldY = trPose.y - sideX * sinH + slotY * cosH;
    const gZ = ground(sideWorldX, sideWorldY);
    const groundLocalZ = Number.isFinite(gZ) ? (gZ - trPose.z) : 0.0;
    const lp = SK.evaluateContainerLocalPose(ph, prog, side, isLoad ? "load" : "offload", SK.CHASSIS_DECK_Z, groundLocalZ, slotY);
    entry._lastLocalPose = lp;

    return {
      sideliftPhase: ph,
      sideliftSide: side,
      sideliftFlags: slFlags,
      sideliftProgress: prog,
      outriggerProgress: outProg,
      craneSpanY: entry.craneSpanY || SK.CRANE_SPAN_Y_40FT,
      craneCenterY: slotY,
      hasStowedPalletJack: Boolean((slFlags & 0x08) || entry.stowedPalletJackGuid),
      isLoadDirection: isLoad,
    };
  }

  function tickTrailers(dt) {
    const stepDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    for (const entry of trailers.values()) {
      const inEm = em()?.entityMap?.get(entry.guid);
      if (inEm) {
        entry.seenInEm = true;
        if (!entry.standInHidden || inEm._filmHidden !== true) {
          try { if (em()?.setFilmHidden?.(entry.guid, true)) entry.standInHidden = true; } catch (_) {}
        }
      }

      const slPatch = entry.isSidelifter ? updateSidelifterKinematicsAndPose(entry, dt, stepDt) : null;

      if (entry._posedFrame !== stats.frames) {
        const coupled = (entry.coupledTractorGuid >>> 0) !== 0;
        if (!coupled) {
          entry._wasCoupledTo = 0;
          entry._tractorSpeed = 0;
          entry._tractorMode = FM.MODE.PARKED;
        }
        const [wx, wy, wz] = entry.worldPos;
        const qTr = FM.orientation(entry.heading || 0, entry.pitch || 0, entry.bank || 0);
        entry.model.root.position.set(wx, wy, wz);
        entry.model.root.quaternion.set(qTr[1], qTr[2], qTr[3], qTr[0]);
        writeEntity(entry.guid, wx, wy, wz, qTr, true);
        entry.renderedPose = { x: wx, y: wy, z: wz, heading: entry.heading || 0, pitch: entry.pitch || 0, bank: entry.bank || 0 };
        const updState = {
          twistlockState: (entry.trailerFlags & TRAILER_FLAG.TWISTLOCKS_LOCKED) ? 1 : 0,
          landingGearRetracted: Boolean((entry.trailerFlags & TRAILER_FLAG.GEAR_RETRACTED) || coupled),
          brakeLights: Boolean(entry.trailerFlags & TRAILER_FLAG.BRAKE_LIGHTS),
          speed: 0,
          ...(slPatch || {}),
        };
        try { entry.model.update(dt, updState); } catch (_) {}
      } else if (slPatch) {
        try { entry.model.update(0, slPatch); } catch (_) {}
      }

      syncTrailerContainerMount(entry);

      const xferGuid = (entry.transferContainerGuid || entry.mountedContainerGuid) >>> 0;
      if (entry.isSidelifter && isSideliftColliderSuppressed(entry) && xferGuid !== 0) {
        const cEntry = containers.get(xferGuid);
        if (cEntry) {
          if (cEntry.colliderActive !== false) {
            try { sh()?.removeContainerCollider?.(cEntry.guid); } catch (_) {}
            cEntry.colliderActive = false;
            cEntry._lastColliderSig = null;
          }
          if (isSideliftTransferActive(entry) && entry._lastLocalPose && cEntry.model?.root) {
            const trPose = entry.renderedPose ?? {
              x: entry.worldPos[0], y: entry.worldPos[1], z: entry.worldPos[2],
              heading: entry.heading || 0, pitch: entry.pitch || 0, bank: entry.bank || 0,
            };
            const qTr = FM.orientation(trPose.heading || 0, trPose.pitch || 0, trPose.bank || 0);
            const lp = entry._lastLocalPose;
            const wOff = FM.rotate(qTr, [lp.x, lp.y, lp.z]);
            const cx = trPose.x + wOff[0];
            const cy = trPose.y + wOff[1];
            const cz = trPose.z + wOff[2];
            if (live?.worldRoot && cEntry.model.root.parent !== live.worldRoot) {
              live.worldRoot.add(cEntry.model.root);
            }
            cEntry.model.root.position.set(cx, cy, cz);
            cEntry.model.root.quaternion.set(qTr[1], qTr[2], qTr[3], qTr[0]);
            writeEntity(cEntry.guid, cx, cy, cz, qTr, true);
          }
        }
        continue;
      }

      const cGuid = entry.mountedContainerGuid >>> 0;
      if (cGuid !== 0) {
        const cEntry = containers.get(cGuid);
        if (cEntry) {
          const isMoving = (entry.coupledTractorGuid >>> 0) !== 0 &&
            (Math.abs(entry._tractorSpeed || 0) > 0.08 || entry._tractorMode === FM.MODE.DRIVING);
          if (isMoving) {
            if (cEntry.colliderActive !== false) {
              try { sh()?.removeContainerCollider?.(cEntry.guid); } catch (_) {}
              cEntry.colliderActive = false;
              cEntry._lastColliderSig = null;
            }
          } else {
            const trPose = entry.renderedPose ?? {
              x: entry.worldPos[0], y: entry.worldPos[1], z: entry.worldPos[2],
              heading: entry.heading || 0, pitch: entry.pitch || 0, bank: entry.bank || 0,
            };
            const cLen = cEntry.model?.spec?.external?.length ?? 6.058;
            const slotOpt = containerSlotToOpt(entry.containerSlot);
            const cPose = TK.computeMountedContainerPose(trPose, entry.specKind, cLen, slotOpt);
            const cl = FM.toCellLocal(cPose.x, cPose.y, cPose.z);
            const doorOpen = cEntry.currentDoorProgress >= 0.5;
            const sig = `${cl.cell}:${Math.round(cl.x * 50)}:${Math.round(cl.y * 50)}:${Math.round(cl.z * 50)}:${Math.round(cPose.heading * 200)}:${doorOpen ? 1 : 0}`;
            if (cEntry.colliderActive === false || cEntry._lastColliderSig !== sig) {
              try {
                sh()?.upsertContainerCollider?.(cEntry.guid, cl.cell, cl.x, cl.y, cl.z, cPose.heading, cEntry.kind, doorOpen);
                cEntry.colliderActive = true;
                cEntry._lastColliderSig = sig;
              } catch (_) {}
            }
            writeEntity(cEntry.guid, cPose.x, cPose.y, cPose.z, FM.orientation(cPose.heading, cPose.pitch, cPose.bank), true);
          }
        }
      }
    }
  }

  function tickContainers(dt) {
    const DOOR_SPEED = 1.0 / 1.2;
    const maxStep = (dt > 0 ? dt : 1 / 60) * DOOR_SPEED;

    for (const entry of containers.values()) {
      const inEm = em()?.entityMap?.get(entry.guid);
      if (inEm) {
        entry.seenInEm = true;
        if (!entry.standInHidden || inEm._filmHidden !== true) {
          try { if (em()?.setFilmHidden?.(entry.guid, true)) entry.standInHidden = true; } catch (_) {}
        }
      }

      if (Math.abs(entry.currentDoorProgress - entry.targetDoorProgress) > 1e-4) {
        if (entry.currentDoorProgress < entry.targetDoorProgress) {
          entry.currentDoorProgress = Math.min(entry.targetDoorProgress, entry.currentDoorProgress + maxStep);
        } else {
          entry.currentDoorProgress = Math.max(entry.targetDoorProgress, entry.currentDoorProgress - maxStep);
        }

        // Static shadow cache invalidation during door motion so CSM shadow streams inside!
        try { requestShadowRaster(live.renderer, live); } catch (_) {}

        // Check doorOpen threshold crossing for dynamic collider update (skip if mounted on trailer; tickTrailers manages it)
        const doorOpen = entry.currentDoorProgress >= 0.5;
        if (doorOpen !== entry.lastDoorOpen) {
          entry.lastDoorOpen = doorOpen;
          if (entry.rawPos && !entry.mountedOnTrailerGuid && !findClaimingTrailer(entry.guid)) {
            try {
              sh()?.upsertContainerCollider(
                entry.guid,
                entry.cell,
                entry.rawPos[0],
                entry.rawPos[1],
                entry.rawPos[2],
                entry.heading,
                entry.kind,
                doorOpen
              );
              entry.colliderActive = true;
            } catch (_) {}
          }
        }
      }

      // Re-upsert grounded container collider if a sidelifter released claim (phase 9 -> 10/0) without a trailing container_state
      if (!entry.mountedOnTrailerGuid && entry.colliderActive === false && entry.rawPos && !findClaimingTrailer(entry.guid)) {
        const doorOpen = entry.currentDoorProgress >= 0.5;
        if (entry.model?.root) {
          if (live?.worldRoot && entry.model.root.parent !== live.worldRoot) {
            live.worldRoot.add(entry.model.root);
          }
          const [wx, wy, wz] = entry.cell
            ? FM.toGlobal(entry.cell, entry.rawPos[0], entry.rawPos[1], entry.rawPos[2])
            : [entry.rawPos[0], entry.rawPos[1], entry.rawPos[2]];
          entry.model.root.position.set(wx, wy, wz);
          entry.model.root.quaternion.set(0, 0, 0, 1);
          entry.model.root.rotation.z = -(entry.heading || 0);
        }
        try {
          sh()?.upsertContainerCollider(
            entry.guid,
            entry.cell,
            entry.rawPos[0],
            entry.rawPos[1],
            entry.rawPos[2],
            entry.heading || 0,
            entry.kind,
            doorOpen
          );
          entry.colliderActive = true;
          entry.lastDoorOpen = doorOpen;
        } catch (_) {}
      }

      try {
        if (typeof entry.model.update === "function") {
          entry.model.update(dt, {
            doorProgress: entry.currentDoorProgress,
            liveryId: entry.liveryId,
          });
        } else if (typeof entry.model.setDoorProgress === "function") {
          entry.model.setDoorProgress(entry.currentDoorProgress);
        }
      } catch (_) {}
    }
  }

  function tickDeployables(dt) {
    const simT = nowSec();
    const sky = live.skyLightingController?._lastState ?? null;
    const sunPitchRad = sky && Number.isFinite(sky.dirPitch) ? (sky.dirPitch * Math.PI) / 180 : 0.78;
    const sunHeadingRad = sky && Number.isFinite(sky.dirHeading) ? (sky.dirHeading * Math.PI) / 180 : 1.57;

    let hasActiveAirRadar = false;
    let hasActiveGroundRadar = false;
    for (const entry of deployables.values()) {
      const inEm = em()?.entityMap?.get(entry.guid);
      if (inEm) {
        entry.seenInEm = true;
        if (!entry.standInHidden || inEm._filmHidden !== true) {
          try { if (em()?.setFilmHidden?.(entry.guid, true)) entry.standInHidden = true; } catch (_) {}
        }
      }
      const st = entry.last || {};
      const isStowed = Boolean((st.onlineFlags ?? 0) & 0x10);
      if (entry.wcid === 4000002) {
        if (!isStowed) hasActiveAirRadar = true;
      } else if (entry.wcid === DEPLOYABLE_WCID.GroundRadar) {
        const isOnline = st.onlineFlags !== undefined ? Boolean(st.onlineFlags & 1) : (st.online !== false);
        if (!isStowed && isOnline) hasActiveGroundRadar = true;
      }
      try {
        if (entry.wcid === 4000002) {
          entry.model.update({ simTimeSec: simT, stowed: isStowed });
        } else {
          entry.model.update({
            dt,
            simTimeSec: simT,
            stowed: isStowed,
            sunPitch: st.sunPitch !== undefined ? st.sunPitch : sunPitchRad,
            sunHeading: st.sunHeading !== undefined ? st.sunHeading : sunHeadingRad,
            fuelSecondsRemaining: st.fuelSec ?? st.fuelSecondsRemaining ?? 0,
            online: st.onlineFlags ? Boolean(st.onlineFlags & 1) : Boolean(st.online),
            capacitorJoules: st.energyJoules ?? st.capacitorJoules ?? 0,
            deployElevation: st.elevation ?? st.deployElevation,
            riseTimeSec: st.riseTimeSec,
            yawRad: st.yaw ?? st.yawRad,
            pitchRad: st.pitch ?? st.pitchRad,
            rollRad: st.roll ?? st.rollRad,
            ammoCount: st.ammo ?? st.ammoCount,
            recoilSec: st.recoilSec ?? 0,
          });
        }
      } catch (_) {}
    }

    deployableVfx?.update(dt);

    if (!hasActiveAirRadar) latestAirContacts = [];
    if (!hasActiveGroundRadar) latestGroundContacts = [];
    const showScope = hasActiveAirRadar || hasActiveGroundRadar;
    if (showScope && !scopeMounted && win?.document?.body) {
      radarScope.mount(win.document.body);
      scopeMounted = true;
    }
    if (scopeMounted) {
      radarScope.update({
        simTimeSec: simT,
        airContacts: latestAirContacts,
        groundContacts: latestGroundContacts,
        visible: showScope,
      });
    }
  }
  const airframes = airframeEnabled(search) ? createAirframes({ liveScene3d: live, THREE, search }) : null;
  const aeroFx = aeroFxEnabled(search) ? createAeroFx({ liveScene3d: live, THREE, ground }) : null;
  const wireframe = (() => { try { return wireframeFlagOn(search); } catch (_) { return false; } })();
  // parachute canopies (chute.js) over every body whose Chute event arrived; `?vehicleChute=off` draws none
  const chutes = chuteEnabled(search) ? createChutes({ liveScene3d: live, THREE, wireframe }) : null;
  // the falling body's pose (fall_pose.js): retail Falling in free fall, the canopy grip under the chute, the parachute
  // pack — the local faller and observed players; `?vehicleFallAnim=off` keeps the old pose
  const fallPose = fallAnimEnabled(search)
    ? createFallPose({
      liveScene3d: live, THREE, wireframe, ground,
      onChute: (g) => chutes?.open(g), // a chute inferred from an observed body's sink rate (its event never came)
      onLanded: (g) => chutes?.close(g), // an observed body on the ground without a Touchdown event
    })
    : null;
  let pilot = null; // active piloting session
  let passenger = null; // active passenger riding session (Seats 1..3)
  let fall = null; // bail-out freefall of the local player (server-owned body, predicted here)
  let pendingBoard = null;
  let disposed = false;
  let exitHop = null; // the local rig going back down from the seat to the exit placement (board_hop.js)
  // the piloted vehicle's velocity when its session ended: ACE's bail (VehicleBailout.Bail) releases the seat
  // (VehicleSeat state 0 → stopPiloting) BEFORE it broadcasts the Bail event, so startFall usually finds no pilot
  let lastPilotKin = null; // {vehicle, vel: [vx, vy, vz], at}
  let landingCam = null; // {camera, timer}: the fall camera held after a touchdown (FALL_CAM.landHoldSec)
  // the bail hand-off (BAIL_HANDOFF): {v, seat, camera, camHeading, lastSeat, startedAt} from a seat released in the air
  // until the Bail event (startFall adopts the camera) or maxSec
  let handoff = null;
  let teleportAt = -1e9; // the last PlayerTeleport (onTeleport)
  /** A teleport is under way: its PlayerTeleport within BAIL_HANDOFF.maxSec, or portal space owns the frame. */
  function teleportUnderWay() {
    return nowSec() - teleportAt < BAIL_HANDOFF.maxSec || portalSpaceOwnsFrame();
  }
  function releaseLandingCam() {
    const h = landingCam;
    if (!h) return;
    landingCam = null;
    try { clearTimeout(h.timer); } catch (_) {}
    try { h.camera.release(); h.camera.dispose(); } catch (_) {}
  }

  // one tracked timer for every transient prompt (refusal, bail hints, bomb away, rearmed): cleared on dispose; when it
  // expires the board prompt is re-evaluated (tickPrompt only rewrites on a change of the nearest vehicle)
  let promptTimer = null;
  let promptVehicle = null;
  let promptText = null;

  function teardownSession(why) {
    if (pilot) stopPiloting(why);
    if (passenger) stopRiding(why);
    if (palletJackController?.isActive?.()) {
      try { palletJackController.stop(why); } catch (_) {}
    }
    endHandoff(why);
    if (fall) { chutes?.close(localGuid()); stopFall(why); }
    releaseLandingCam();
    try { clearTimeout(promptTimer); } catch (_) {}
    promptTimer = null;
    promptVehicle = null;
    promptText = null;
    try { osd.prompt(null); osd.hide(); } catch (_) {}
    latestAirContacts = [];
    latestGroundContacts = [];
    try {
      radarScope.update({ simTimeSec: nowSec(), airContacts: [], groundContacts: [], visible: false });
    } catch (_) {}
    try {
      vehicleAudio?.stop({ fadeSec: 0 });
      vehicleAudio?.dispose();
      groundAudio?.stop({ fadeSec: 0 });
      groundAudio?.dispose();
      logisticsAudio?.stop?.();
      if (why === "dispose") logisticsAudio?.dispose?.();
      if (deployableAudio?.generators?.keys) {
        for (const g of [...deployableAudio.generators.keys()]) {
          deployableAudio.stopGeneratorHum(g);
        }
      }
      if (why === "dispose") deployableAudio?.dispose?.();
      try { warehouseManager?.stopScenarios?.(); } catch (_) {}
      try { portTerminalManager?.stopScenarios?.(); } catch (_) {}
      try { shipManager?.exit?.(); } catch (_) {}
      try { portAudio?.stop?.(); if (why === "dispose") portAudio?.dispose?.(); } catch (_) {}
    } catch (_) {}
    try {
      sh()?.clearVehicleSeat?.();
    } catch (_) {}
    try {
      if (win?.__inputFunnel && typeof win.__inputFunnel.unpoison === "function") {
        win.__inputFunnel.unpoison();
      }
      if (win?.__inputFunnel && typeof win.__inputFunnel.releaseHeld === "function") {
        win.__inputFunnel.releaseHeld("vehicle");
      }
    } catch (_) {}
    unfadeAvatar();
  }

  let lastDiscTs = 0;
  function isSessionLost() {
    if (!win) return false;
    if (win.__hbLoggingOff === true || win.__hbLoggedOff === true) return true;
    const d = win.__lastDisconnect;
    if (d && Number.isFinite(d.ts) && d.ts !== lastDiscTs) {
      lastDiscTs = d.ts;
      return true;
    }
    const s = win.__bootState;
    if (s && s !== "in-world" && s !== "ready") return true;
    const h = sh();
    if (caps.handle && h && h !== caps.handle) return true;
    return false;
  }

  const canvasEl = deps.canvas ?? (live.renderer?.domElement ?? (win?.document?.querySelector?.("canvas") ?? null));
  const onContextLost = () => {
    console.log("[vehicles] webglcontextlost — tearing down vehicle session");
    teardownSession("context-loss");
  };
  const onPageHide = () => { teardownSession("disconnect"); };
  const onLogoutEvt = () => { teardownSession("logout"); };
  try {
    canvasEl?.addEventListener?.("webglcontextlost", onContextLost, false);
  } catch (_) {}
  try {
    win?.addEventListener?.("pagehide", onPageHide, false);
    win?.addEventListener?.("beforeunload", onPageHide, false);
    win?.addEventListener?.("hb-logged-out", onLogoutEvt, false);
    win?.addEventListener?.("hb-disconnected", onPageHide, false);
  } catch (_) {}
  const hopsOn = boardAnimEnabled(win.location?.search);
  let bailArmedAt = -1e9;
  function flashPrompt(text, ms) {
    osd.prompt(text);
    try { clearTimeout(promptTimer); } catch (_) {}
    promptTimer = setTimeout(() => {
      promptTimer = null;
      if (disposed) return;
      osd.prompt(null);
      promptVehicle = null;
    }, ms);
  }

  const warehouseManager = createWarehouseManager({
    THREE,
    liveScene3d: live,
    containers,
    deployables,
    palletJacks,
    trailers,
    logisticsAudio,
    sh,
  });

  const portAudio = (audioOn && portAudioEnabled(search))
    ? createPortAudio({
      bus: () => live.audioManager?.getEffectBus?.() ?? null,
      audioManager: live.audioManager,
      liveScene3d: live,
      isActive: () => live.audioManager?.isActive?.() !== false,
      volume: () => 0.85,
    })
    : null;

  const portTerminalManager = createPortTerminalManager({
    THREE,
    liveScene3d: live,
    containers,
    deployables,
    trailers,
    warehouseManager,
    portAudio,
    sh,
    spawnLocalContainer: (guid, kind, worldPos, heading, state) => api.containers.spawnLocal(guid, kind, worldPos, heading, state),
    removeLocalContainer: (guid) => api.containers.removeLocal(guid),
  });

  const shipManager = createShipManager({
    THREE,
    liveScene3d: live,
    window: win,
    document: win.document,
    portAudio,
    terminalManager: portTerminalManager,
    sh,
    getLocalPlayerPos: () => {
      const me = em()?.entityMap?.get(localGuid());
      if (me?.root?.position) return [me.root.position.x, me.root.position.y, me.root.position.z];
      return null;
    },
    isOtherVehicleOccupied: () => Boolean(pilot || passenger || fall || handoff || palletJackController?.isActive?.()),
  });
  portTerminalManager.linkShipManager(shipManager);

  palletJackController = createPalletJackController({
    liveScene3d: live,
    THREE,
    window: win,
    sh,
    em,
    localGuid,
    ground,
    containers,
    deployables,
    palletJacks,
    osd,
    flashPrompt,
    logisticsAudio,
    writeEntity,
    nowSec,
    warehouseManager,
  });

  // ---------------------------------------------------------------- inbox

  function vehicleOf(guid) {
    let v = vehicles.get(guid >>> 0);
    if (!v) {
      v = { guid: guid >>> 0, profile: null, params: null, seats: [], last: null, track: createObserverTrack(), firstSeen: nowSec(), lastMsgAt: nowSec(),
        spent: new Set(), standInHidden: false };
      vehicles.set(v.guid, v);
    }
    return v;
  }

  /** A vehicle leaves this client (despawn, prune, dispose): its airframe goes, its stand-in guid is no longer hidden
   *  (ACE recycles dynamic guids: a later object with the same guid must not come back hidden). */
  function groundParamsFromProfile(p) {
    if (typeof GM.paramsFromProfile === "function") return GM.paramsFromProfile(p);
    return {
      ...GM.PARAMS,
      locomotion: 2,
      vMax: p?.vMax || GM.PARAMS.vMaxRoad,
      vCruise: p?.vCruise || GM.PARAMS.vMaxRoad * 0.75,
      vMin: p?.vMin || 0,
      accel: p?.accel || GM.PARAMS.launchAccel,
      decel: p?.decel || GM.PARAMS.normalBrake,
      leadSeconds: p?.leadSeconds || 4,
      ...(p || {}),
    };
  }

  function forgetVehicle(v) {
    if (!v) return;
    for (const tr of trailers.values()) {
      if ((tr.coupledTractorGuid >>> 0) === (v.guid >>> 0)) {
        tr.coupledTractorGuid = 0;
        tr._wasCoupledTo = 0;
        tr.trailerFlags &= ~(TRAILER_FLAG.COUPLED | TRAILER_FLAG.GEAR_RETRACTED | TRAILER_FLAG.BRAKE_LIGHTS);
        try { tr.model?.setLandingGearRetracted?.(false); } catch (_) {}
      }
    }
    try { airframes?.remove(v.guid); } catch (_) { /* gone */ }
    try { aeroFx?.forgetVehicle(v.guid); } catch (_) { /* gone */ }
    const gm = groundModels.get(v.guid >>> 0);
    if (gm) {
      try {
        if (gm.root?.parent) gm.root.parent.remove(gm.root);
        gm.dispose?.();
      } catch (_) {}
      groundModels.delete(v.guid >>> 0);
    }
    if (v.standInHidden) {
      v.standInHidden = false;
      try { em()?.setFilmHidden?.(v.guid, false); } catch (_) { /* gone */ }
    }
  }

  /**
   * Draw a vehicle at a pose: the composite airframe when its template is ready (the retail stand-in hidden, render-only),
   * else the stand-in entity itself. The stand-in entity is posed in both cases (the reaper / cell bookkeeping).
   */
  function drawVehicle(v, pose, q, opts = {}) {
    writeEntity(v.guid, pose.x, pose.y, pose.z, q, true);
    const isGround = isGroundVehicle(v);
    if (isGround) {
      const inEm = em()?.entityMap?.get(v.guid);
      if (!v.standInHidden || (inEm && inEm._filmHidden !== true)) {
        try { if (em()?.setFilmHidden?.(v.guid, true)) v.standInHidden = true; } catch (_) {}
      }
      const model = ensureGroundModel(v);
      const gFlags = opts.groundFlags ?? pose.groundFlags ?? v.last?.groundFlags ?? v.last?.ground_flags ?? 0;
      const surfFam = opts.surfaceFamily ?? pose.surfaceFamily ?? v.last?.surfaceFamily ?? v.last?.surface_family ?? 0;
      const lights = opts.headlights !== undefined ? opts.headlights : Boolean(gFlags & 0x10);
      const braking = opts.braking !== undefined ? opts.braking : (opts.handbrake !== undefined ? opts.handbrake : Boolean(gFlags & 0x02));
      const boost = opts.boost !== undefined ? opts.boost : Boolean(gFlags & 0x04);
      const hitchedGuid = opts.hitchedTrailerGuid ?? currentHitchedTrailerGuid(v);
      const coupled = opts.coupled !== undefined ? opts.coupled : (hitchedGuid !== 0);
      const trailerPitch = opts.trailerPitch ?? v._coupledTrailerPitch ?? (v.last?.trailerPitch ?? 0);
      if (model) {
        model.root.position.set(pose.x, pose.y, pose.z);
        model.root.quaternion.set(q[1], q[2], q[3], q[0]);
        const speed = opts.speed ?? pose.speed ?? 0;
        const steer = opts.steerAngle ?? pose.steerAngle ?? opts.yaw ?? 0;
        const windscreen = opts.windscreenFolded !== undefined ? opts.windscreenFolded : (v.windscreenFolded ?? false);
        const accel = opts.accel !== undefined ? opts.accel : ((opts.throttle ?? 0) * (v.params?.launchAccel ?? 11.2) - (braking ? (v.params?.normalBrake ?? 14.0) : 0));

        model.update({
          dt: opts.dt ?? 1 / 60,
          speed,
          steerAngle: steer,
          accel,
          headlights: lights,
          braking,
          brakeLights: braking,
          boost,
          windscreenFolded: windscreen,
          coupled,
          hitchedTrailerGuid: hitchedGuid,
          trailerPitch,
          suspensionFL: opts.suspensionFL,
          suspensionFR: opts.suspensionFR,
          suspensionRL: opts.suspensionRL,
          suspensionRR: opts.suspensionRR,
        }, opts.dt ?? 1 / 60);
      }
      try {
        groundFx?.update(v.guid, pose, {
          speed: opts.speed ?? pose.speed ?? 0,
          steerAngle: opts.steerAngle ?? pose.steerAngle ?? 0,
          handbrake: braking,
          throttle: opts.throttle ?? (pose.mode === 0 ? 0 : 0.72),
          boost,
          groundFlags: gFlags,
          surfaceFamily: surfFam,
          isBridge: !!opts.isBridge,
          profileKey: v.profile?.profileKey ?? v.params?.profileKey ?? "",
          vehicleClass: v.profile?.vehicleClass ?? v.params?.vehicleClass ?? 0,
          dt: opts.dt ?? 1 / 60,
        }, opts.dt ?? 1 / 60);
      } catch (_) {}
      return true;
    }

    const g = ground(pose.x, pose.y);
    const agl = Number.isNaN(g) ? undefined : pose.z - g;
    try {
      aeroFx?.updateVehicle(v.guid, pose, q, {
        dt: opts.dt ?? 1 / 60,
        throttle: opts.throttle ?? (pose.mode === FM.MODE.PARKED ? 0 : 0.72),
        boost: !!opts.boost,
        gLoad: opts.gLoad,
        agl: agl ?? null,
        inOcean: pose.y >= 48960.0 && pose.y < 68928.0,
      });
    } catch (_) { /* VFX never breaks flight */ }
    const inst = airframes && v.profile ? airframes.ensure(v) : null;
    if (!inst) return false;
    const inEm = em()?.entityMap?.get(v.guid);
    if (!v.standInHidden || (inEm && inEm._filmHidden !== true)) {
      try { if (em()?.setFilmHidden?.(v.guid, true)) v.standInHidden = true; } catch (_) { /* never fatal */ }
    }
    const last = v.last;
    // the pilot's "fired" marks hide a rail / station at once; dropped when the server's mask agrees (or it was rearmed)
    if (v.spent.size && last) {
      for (const w of [...v.spent]) {
        const { kind, ordinal } = kindOrdinal(v.profile, w);
        const mask = kind === 2 ? last.missileMask : kind === 3 ? last.bombMask : undefined;
        if (Number.isFinite(mask) && ((mask >>> ordinal) & 1) === 0) v.spent.delete(w);
      }
    }
    airframes.pose(inst, pose, {
      q, dt: opts.dt ?? 1 / 60, throttle: opts.throttle, agl, cockpit: !!opts.cockpit, hideWindscreen: !!opts.hideWindscreen,
      pitch: opts.pitch, roll: opts.roll, yaw: opts.yaw, boost: opts.boost, land: opts.land,
      missileMask: last?.missileMask, bombMask: last?.bombMask, localSpent: v.spent,
    });
    return true;
  }

  function syncRigVisibility(p, v, firstPerson, composite) {
    const wantHidden = !!firstPerson;
    if (wantHidden !== !!p.rigHidden || composite !== p.rigComposite) {
      try {
        em()?.setFilmHidden?.(localGuid(), wantHidden);
        if (!composite) em()?.setFilmHidden?.(v.guid, wantHidden);
        p.rigHidden = wantHidden;
        p.rigComposite = composite;
      } catch (_) { /* never fatal */ }
    }
  }

  function handleMsg(m) {
    stats.msgs++;
    switch (m.type) {
      case "ack":
        caps.granted = m.granted >>> 0;
        caps.ackAt = nowSec();
        break;
      case "profile": {
        const v = vehicleOf(m.vehicle);
        v.profile = m;
        v.lastMsgAt = nowSec();
        if (m.locomotion === 2 || m.profileKey === "jeep-mb" || isSemiProfile(m)) {
          v.locomotion = 2;
          v.params = groundParamsFromProfile(m);
          v.params.towMassMul = computeTowMassMul(v);
          if (THREE) ensureGroundModel(v);
        } else {
          v.locomotion = 1;
          v.params = FM.paramsFromProfile(m);
          if (airframes && hasComposite(m)) { try { airframes.ensure(v); } catch (_) { /* stand-in */ } }
        }
        stats.profiles++;
        if (live?.renderer) {
          try { if (m.weapons?.length) fx.warm?.(); chutes?.warm?.(); aeroFx?.warm?.(); } catch (_) { /* best effort */ }
        }
        if (!pilot && !passenger) {
          const me = localGuid();
          if (me) {
            if ((v.seats[0] >>> 0) === me) {
              startPiloting(v, 0);
            } else {
              for (let s = 1; s < v.seats.length; s++) {
                if ((v.seats[s] >>> 0) === me) {
                  startRiding(v, s);
                  break;
                }
              }
            }
          }
        }
        break;
      }
      case "seat": {
        const v = vehicleOf(m.vehicle);
        v.lastMsgAt = nowSec();
        if (m.state === 1 && (m.occupant >>> 0)) fallPose?.end(m.occupant, "seated");
        if (m.state === 1) v.seats[m.seat] = m.occupant >>> 0;
        else if (m.state === 0) v.seats[m.seat] = 0;
        if (m.state === 2) {
          stats.boardRefusals++;
          stats.lastRefusal = REFUSAL[m.reason] ?? `reason ${m.reason}`;
          pendingBoard = null;
          v.hotSwapTarget = null;
          v.hotSwapFrom = null;
          flashPrompt(`Cannot board: ${stats.lastRefusal}`, 2500);
        } else if (m.state === 1 && (m.occupant >>> 0) === localGuid()) {
          pendingBoard = null;
          const fromSeat = (v.hotSwapTarget === m.seat && v.hotSwapFrom !== undefined && v.hotSwapFrom !== null)
            ? v.hotSwapFrom
            : (pilot ? pilot.seat : (passenger ? passenger.seat : null));
          v.hotSwapTarget = null;
          v.hotSwapFrom = null;

          if (m.seat === 0) {
            startPiloting(v, 0, fromSeat);
          } else {
            startRiding(v, m.seat, fromSeat);
          }
        } else if (m.state === 0) {
          const activeSeat = pilot ? pilot.seat : (passenger ? passenger.seat : null);
          const isMyVehicle = (pilot && pilot.vehicle === v) || (passenger && passenger.vehicle === v);
          const isMySeat = isMyVehicle && activeSeat === m.seat;
          const isHotSwapping = (v.hotSwapTarget !== null && v.hotSwapTarget !== undefined && (nowSec() - (v.hotSwapRequestedAt || 0) < 2.0));

          if (isMySeat && !isHotSwapping) {
            if (pilot) stopPiloting("seat released");
            if (passenger) stopRiding("seat released");
          }
        }
        break;
      }
      case "state": {
        const v = vehicleOf(m.vehicle);
        v.last = m;
        v.lastMsgAt = nowSec();
        stats.states++;
        if (v.params && isGroundVehicle(v)) {
          const mul = computeTowMassMul(v);
          v.params.towMassMul = mul;
          if (pilot && pilot.vehicle === v && pilot.predictor?.state) {
            pilot.predictor.state.towMassMul = mul;
          }
        }
        if (pilot && pilot.vehicle === v && (m.flags & 0x01)) {
          if (!pilot.predictor) pilot.predictor = makePredictor(v, m);
          else {
            pilot.predictor.reconcile(m);
            if (v.params && isGroundVehicle(v) && pilot.predictor.state) {
              pilot.predictor.state.towMassMul = v.params.towMassMul;
            }
          }
          pilot.lastServer = m;
        } else {
          v.track.push(m, nowSec());
        }
        break;
      }
      case "fire": {
        stats.fires++;
        const v = vehicles.get(m.vehicle >>> 0);
        if (!v) break;
        const w = v.profile?.weapons?.[m.mount];
        if (w && w.kind === 2) v.spent.add(m.mount >>> 0); // the rail's wand empties now
        const isMine = !!(pilot && pilot.vehicle === v && pilot.predictor);
        let muzzlePos = null;
        if (isMine) {
          // the pilot's own guns: the quarrels leave the PREDICTED muzzles (the server's are ~RTT/2 behind)
          const s = pilot.predictor.state;
          const q = FM.orientation(s.heading, s.pitch, s.bank);
          const r = FM.rotate(q, w?.muzzle ?? [0, 4, 0.5]);
          muzzlePos = [s.x + r[0], s.y + r[1], s.z + r[2]];
          fx.fire(m, v, s, muzzlePos, v.params ? FM.velocity(s, v.params) : null);
          if (w?.kind === 1) pilot.lastFireAt = nowSec();
        } else {
          const stObs = v.last ? stateFromMsg(v.last) : null;
          const vel = stObs && v.params ? FM.velocity(stObs, v.params) : null;
          if (stObs) muzzlePos = [stObs.x, stObs.y, stObs.z];
          fx.fire(m, v, v.last ? { heading: v.last.heading, pitch: v.last.pitch, bank: v.last.bank } : null, undefined, vel);
        }
        try {
          if (w?.kind === 1) {
            if (v._lastGunAudioStep !== m.step) {
              v._lastGunAudioStep = m.step;
              vehicleAudio?.fireGun({ pos: muzzlePos, mine: isMine, fpv: isMine && pilot.view === "cockpit" });
            }
          } else if (w?.kind === 2) {
            vehicleAudio?.fireRocket({ pos: muzzlePos, mine: isMine, fpv: isMine && pilot.view === "cockpit" });
          }
        } catch (_) {}
        break;
      }
      case "event": {
        stats.events++;
        events.push({ t: nowSec(), name: EVENT_NAMES[m.kind] ?? m.kind, ...m });
        if (events.length > 200) events.shift();
        const v = vehicles.get(m.vehicle >>> 0);
        const mine = (m.subject >>> 0) === localGuid();
        const myVehicle = !!(pilot && pilot.vehicle === v);
        if (m.kind === 4) { // despawn
          if (pilot && pilot.vehicle === v) stopPiloting("despawned");
          if (passenger && passenger.vehicle === v) stopRiding("despawned");
          if (handoff && handoff.v === v) endHandoff("despawned");
          forgetVehicle(v);
          vehicles.delete(m.vehicle >>> 0);
          removeTrailerEntry(m.vehicle >>> 0);
          if (m.subject) removeTrailerEntry(m.subject >>> 0);
          removeContainerEntry(m.vehicle >>> 0);
          if (m.subject) removeContainerEntry(m.subject >>> 0);
          removePalletJackEntry(m.vehicle >>> 0);
          if (m.subject) removePalletJackEntry(m.subject >>> 0);
          removeDeployableEntry(m.vehicle >>> 0);
          if (m.subject) removeDeployableEntry(m.subject >>> 0);
        } else if (m.kind === 19) { // trailerHitched
          if (myVehicle || (passenger && passenger.vehicle === v)) {
            try { groundAudio?.airBrakeHiss?.({ kind: "hitch" }); } catch (_) {}
            flashPrompt("Trailer coupled — air lines connected", 1600);
          }
        } else if (m.kind === 20) { // trailerUnhitched
          if (myVehicle || (passenger && passenger.vehicle === v)) {
            try { groundAudio?.airBrakeHiss?.({ kind: "unhitch" }); } catch (_) {}
            flashPrompt("Trailer unhitched — landing gear lowered", 1600);
          }
        } else if (m.kind === 21) { // twistlockToggled
          const tr = trailers.get(m.vehicle >>> 0) ?? trailers.get(m.subject >>> 0) ?? (m.aux > 1 ? trailers.get(m.aux >>> 0) : undefined);
          const locked = Number.isFinite(m.value) ? (m.value !== 0) : Boolean(m.aux);
          try {
            logisticsAudio?.twistlockClank?.({
              pos: tr?.worldPos ?? (m.cell ? FM.toGlobal(m.cell, m.x, m.y, m.z) : null),
              locked,
            });
          } catch (_) {}
          if (myVehicle || (passenger && passenger.vehicle === v) || tr) {
            flashPrompt(locked ? "Twistlocks LOCKED" : "Twistlocks UNLOCKED", 1400);
          }
        } else if (m.kind === 22) { // sideliftStarted
          flashPrompt("ISO 3874: Sidelift sequence started", 1800);
        } else if (m.kind === 23) { // sideliftComplete
          flashPrompt("ISO 3874: Sidelift sequence complete", 1800);
        } else if (m.kind === 24) { // sideliftRefused
          const code = Number.isFinite(m.aux) ? (m.aux >>> 0) : 0;
          const msg = m.reason || SIDELIFT_REFUSAL_REASONS[code] || SIDELIFT_REFUSAL_REASONS[0];
          flashPrompt(msg, 2600);
        } else if (m.kind === 25) { // palletJackEvent
          const code = Number.isFinite(m.aux) ? (m.aux >>> 0) : 0;
          const msg = m.reason || PALLET_JACK_EVENT_REASONS[code] || PALLET_JACK_EVENT_REASONS[0];
          flashPrompt(msg, 2200);
        } else if (m.kind === 2) { // aircraft landed
          try {
            const p0 = Number.isFinite(m.cell) && m.cell ? FM.toGlobal(m.cell, m.x, m.y, m.z) : (v?.last ? stateFromMsg(v.last) : null);
            vehicleAudio?.touchdown({ pos: p0, speed: Math.abs(m.value || 3), chute: false, mine: myVehicle, fpv: myVehicle && pilot.view === "cockpit" });
          } catch (_) {}
        } else if (m.kind === 3) { // crashed: derelict aircraft struck terrain → 2,000 lb fireball + smoke column
          fx.explosionEvent({ ...m, aux: 99, value: m.value || 2000 });
        } else if (m.kind === 8) { // target hit confirmation
          if (myVehicle) {
            const dmg = Math.max(1, Math.round(m.value || 0));
            osd.hit({ damage: dmg });
            try { vehicleAudio?.hit({ damage: dmg }); } catch (_) {}
          }
        } else if (m.kind === 17) { // ramHit: bumper impact with creature (Monster Ramming Combat)
          if (myVehicle) {
            const spd = Math.abs(m.value || 0);
            const dmg = m.aux || Math.round(18 + 0.42 * spd * spd);
            try { vehicleAudio?.hit?.({ damage: dmg }); } catch (_) {}
            if (pilot?.camRig) {
              try {
                const joltScale = Math.min(1.5, 0.4 + (spd / 29.0) * 0.8);
                pilot.camRig.triggerJolt?.(joltScale);
              } catch (_) {}
            }
            osd?.hit?.({ damage: dmg });
            flashPrompt(`Ram hit! ${dmg} bludgeon (${spd.toFixed(1)} m/s)`, 1500);
          }
        } else if (m.kind === 9) { // a bomb left its station: fly it with the server's model (fall_model stepBomb)
          if (v) {
            const aux = m.aux >>> 0;
            v.spent.add(aux);
            const mine = pilot && pilot.vehicle === v;
            // the pilot runs ahead of the server by its prediction lead: the bomb starts that many steps into its fall;
            // observers draw the aircraft OBSERVER_DELAY_S late: the bomb waits as long
            const lead = mine && pilot.predictor && pilot.lastServer ? Math.max(0, ((pilot.predictor.seq - 1) - (pilot.lastServer.ack >>> 0)) | 0) : 0;
            fx.releaseBomb(m, {
              meshes: airframes ? airframes.ordnanceMeshes(v.guid, aux) : [],
              muzzle: v.profile?.weapons?.[aux]?.muzzle, terminal: v.profile?.weaponExt?.[aux]?.dragTerminal,
              advanceSteps: Math.min(30, lead), delaySec: mine ? 0 : OBSERVER_DELAY_S,
            });
            try {
              const p0 = Number.isFinite(m.cell) && m.cell ? FM.toGlobal(m.cell, m.x, m.y, m.z) : (v.last ? stateFromMsg(v.last) : null);
              vehicleAudio?.bombRelease({ pos: p0, mine: !!mine, fpv: !!(mine && pilot?.view === "cockpit") });
            } catch (_) {}
            if (mine) flashPrompt(`Bomb away — ${Math.round(m.value)} lb`, 1800);
          }
        } else if (m.kind === 10) { // explosion (also for bombs whose vehicle is gone / out of our sight)
          fx.explosionEvent(m);
        } else if (m.kind === 11) { // rearmed on the ground
          if (v) {
            v.spent.clear();
            try { vehicleAudio?.rearm({ pos: v.last ? stateFromMsg(v.last) : null, mine: myVehicle }); } catch (_) {}
            if (pilot && pilot.vehicle === v) flashPrompt("Rearmed: quarrels, lightning bolts and bombs", 2500);
          }
        } else if (m.kind === 5 && mine) { // bail: the server now owns our falling body
          startFall(m, v);
        } else if (m.kind === 6 && mine && fall) { // chute: re-anchor on the server's opening point
          const [x, y, z] = FM.toGlobal(m.cell, m.x, m.y, m.z);
          // the step history one step back along the velocity (as startFall): none stalled the drawn body a step
          Object.assign(fall, { x, y, z, px: x - fall.vx * FM.DT, py: y - fall.vy * FM.DT, pz: z - m.value * FM.DT, vz: m.value, chute: true });
        } else if (m.kind === 7 && mine) { // touchdown (exit placement / landing): back on foot
          if (pilot) stopPiloting("touchdown");
          if (handoff) endHandoff("touchdown");
          if (fall) stopFall(m.cell ? "touchdown" : "teleport"); // cell 0: the server cancelled the fall (a teleport)
        }
        // canopies: open over any body whose chute opened (ours or an observed player's), fold at its touchdown
        if (m.kind === 6 && m.subject) {
          chutes?.open(m.subject);
          try {
            const p0 = Number.isFinite(m.cell) && m.cell ? FM.toGlobal(m.cell, m.x, m.y, m.z) : null;
            vehicleAudio?.chuteOpen({ pos: p0, mine });
          } catch (_) {}
        } else if (m.kind === 7 && m.subject) {
          chutes?.close(m.subject);
          if (m.cell) {
            try {
              vehicleAudio?.touchdown({ pos: FM.toGlobal(m.cell, m.x, m.y, m.z), speed: Math.abs(m.value || 5), chute: true, mine });
            } catch (_) {}
          }
        }
        // the fall pose (ours from startFall / stopFall): observed bodies fall at their Bail, every canopy pose starts at
        // its Chute, and any Touchdown hands the body back (idempotent)
        if (fallPose && m.subject) {
          if (m.kind === 5 && !mine) fallPose.begin(m.subject);
          else if (m.kind === 6 && (!mine || fall)) fallPose.chute(m.subject, { local: mine });
          else if (m.kind === 7) fallPose.end(m.subject, m.cell ? "touchdown" : "teleport");
        }
        if (m.kind === 15 && m.aux) { // CargoDeployed (Air Radar or Pallet unit)
          const [wx, wy, wz] = m.cell ? FM.toGlobal(m.cell, m.x, m.y, m.z) : [m.x, m.y, m.z];
          const entry = ensureDeployableEntry(m.aux >>> 0, 4000002);
          if (entry) {
            entry.model.root.position.set(wx, wy, wz);
            entry.lastMsgAt = nowSec();
            if (em()?.entityMap?.get(entry.guid)) entry.seenInEm = true;
          }
        } else if (m.kind === 16 && m.aux) { // CargoPacked
          removeDeployableEntry(m.aux >>> 0);
          removeContainerEntry(m.aux >>> 0);
        }
        break;
      }
      case "radar_contacts": {
        latestAirContacts = Array.isArray(m.contacts) ? m.contacts : [];
        if (m.radar && Array.isArray(m.radarPos) && m.radarPos.length >= 3) {
          const entry = ensureDeployableEntry(m.radar >>> 0, 4000002);
          if (entry) {
            entry.model.root.position.set(m.radarPos[0], m.radarPos[1], m.radarPos[2]);
            entry.lastMsgAt = nowSec();
            if (em()?.entityMap?.get(entry.guid)) entry.seenInEm = true;
          }
        }
        break;
      }
      case "ground_contacts": {
        latestGroundContacts = Array.isArray(m.contacts) ? m.contacts : [];
        break;
      }
      case "deployable_state": {
        const entry = ensureDeployableEntry(m.deployable >>> 0, m.kind, m.onlineFlags ?? 0);
        if (entry) {
          const [wx, wy, wz] = m.cell ? FM.toGlobal(m.cell, m.x, m.y, m.z) : [m.x, m.y, m.z];
          entry.model.root.position.set(wx, wy, wz);
          if (Number.isFinite(m.heading)) entry.model.root.rotation.z = -m.heading;
          entry.last = m;
          const tNow = nowSec();
          entry.lastSeenAt = tNow;
          entry.lastMsgAt = tNow;
          if (em()?.entityMap?.get(entry.guid)) entry.seenInEm = true;
          try { entry.model?.setStowed?.(Boolean((m.onlineFlags ?? 0) & 0x10)); } catch (_) {}
          if (m.kind === DEPLOYABLE_KINDS.PowerGenerator && deployableAudio) {
            try {
              const running = (m.fuelSec || 0) > 0 && Boolean((m.onlineFlags ?? 0) & 1) && !((m.onlineFlags ?? 0) & 0x10);
              if (running) {
                if (!deployableAudio.generators?.has?.(entry.guid)) {
                  deployableAudio.createGeneratorHum(entry.guid, [wx, wy, wz]);
                }
                deployableAudio.updateGeneratorFuel(entry.guid, m.fuelSec || 0);
              } else {
                deployableAudio.stopGeneratorHum(entry.guid);
              }
            } catch (_) {}
          }
        }
        break;
      }
      case "deployable_fire": {
        const mz = m.cell && Array.isArray(m.muzzle)
          ? FM.toGlobal(m.cell, m.muzzle[0], m.muzzle[1], m.muzzle[2])
          : m.muzzle;
        deployableVfx?.handleFireEvent({ ...m, muzzle: mz });
        try {
          if (m.weaponKind === 1) deployableAudio?.playSamLaunch?.(mz);
          else if (m.weaponKind === 2) deployableAudio?.playMortarLaunch?.(mz);
          else if (m.weaponKind === 3) deployableAudio?.playLaserDischarge?.(mz);
        } catch (_) {}
        break;
      }
      case "container_state": {
        const guid = (m.containerGuid ?? m.guid ?? m.container) >>> 0;
        if (!guid) break;
        const kind = (m.containerKind ?? m.kind ?? 10) >>> 0;
        const pos = Array.isArray(m.position) ? m.position : [m.x ?? 0, m.y ?? 0, m.z ?? 0];
        const cell = (m.cell ?? 0) >>> 0;
        const heading = Number.isFinite(m.heading) ? m.heading : 0;
        const doorProgress = Number.isFinite(m.doorProgress)
          ? m.doorProgress
          : (Number.isFinite(m.door_progress) ? m.door_progress : (m.doorState === 2 ? 1.0 : 0.0));
        const doorState = m.doorState ?? 0;
        const liveryId = m.liveryId ?? 0;
        const serialNumber = m.serialNumber ?? 0;
        const slots = Array.isArray(m.slots) ? m.slots : [];

        const entry = ensureContainerEntry(guid, kind, m);
        if (entry) {
          let hostTrailer = findClaimingTrailer(guid);
          if (!hostTrailer && entry.mountedOnTrailerGuid) {
            const prevHost = trailers.get(entry.mountedOnTrailerGuid >>> 0);
            if (prevHost && ((prevHost.mountedContainerGuid >>> 0) === guid || isSideliftColliderSuppressed(prevHost))) {
              hostTrailer = prevHost;
            }
          }

          entry.last = m;
          const tNow = nowSec();
          entry.lastSeenAt = tNow;
          entry.lastMsgAt = tNow;
          if (em()?.entityMap?.get(guid)) entry.seenInEm = true;
          entry.targetDoorProgress = doorProgress;
          entry.cell = cell;
          entry.rawPos = pos;
          entry.heading = heading;
          entry.kind = kind;
          entry.liveryId = liveryId;
          entry.serialNumber = serialNumber;

          if (hostTrailer) {
            if (isSideliftColliderSuppressed(hostTrailer)) {
              if (entry.colliderActive !== false) {
                try { sh()?.removeContainerCollider?.(guid); } catch (_) {}
                entry.colliderActive = false;
                entry._lastColliderSig = null;
              }
            } else {
              syncTrailerContainerMount(hostTrailer);
            }
          } else {
            entry.mountedOnTrailerGuid = 0;
            if (live?.worldRoot && entry.model?.root && entry.model.root.parent !== live.worldRoot) {
              live.worldRoot.add(entry.model.root);
            }
            const [wx, wy, wz] = cell ? FM.toGlobal(cell, pos[0], pos[1], pos[2]) : [pos[0], pos[1], pos[2]];
            entry.model.root.position.set(wx, wy, wz);
            entry.model.root.quaternion.set(0, 0, 0, 1);
            entry.model.root.rotation.z = -heading;

            const posChanged = !entry._lastUpsertPos || entry._lastUpsertPos[0] !== pos[0] || entry._lastUpsertPos[1] !== pos[1] || entry._lastUpsertPos[2] !== pos[2] || entry._lastUpsertCell !== cell || entry._lastUpsertHeading !== heading;
            const doorOpen = entry.currentDoorProgress >= 0.5 || doorState === 1 || doorState === 2;
            if (doorOpen !== entry.lastDoorOpen || posChanged || entry.lastDoorOpen === null || entry.colliderActive === false) {
              entry.lastDoorOpen = doorOpen;
              entry._lastUpsertCell = cell;
              entry._lastUpsertPos = [pos[0], pos[1], pos[2]];
              entry._lastUpsertHeading = heading;
              try {
                sh()?.upsertContainerCollider(guid, cell, pos[0], pos[1], pos[2], heading, kind, doorOpen);
                entry.colliderActive = true;
              } catch (_) {}
            }
          }

          if (Array.isArray(m.slots)) {
            entry.slots = slots;
            try { entry.model?.syncSlots?.(slots); } catch (_) {}
          }
        }
        break;
      }
      case "trailer_state": {
        const guid = (m.trailerGuid ?? m.guid) >>> 0;
        if (!guid) break;
        const pos = Array.isArray(m.position) ? m.position : [m.x ?? 0, m.y ?? 0, m.z ?? 0];
        const cell = (m.cell ?? 0) >>> 0;
        const [wx, wy, wz] = cell ? FM.toGlobal(cell, pos[0], pos[1], pos[2]) : [pos[0], pos[1], pos[2]];
        const entry = ensureTrailerEntry(guid, m.kind ?? 14, m);
        if (entry) {
          entry.cell = cell;
          entry.rawPos = pos;
          entry.worldPos = [wx, wy, wz];
          entry.heading = Number.isFinite(m.heading) ? m.heading : 0;
          entry.pitch = Number.isFinite(m.pitch) ? m.pitch : 0;
          entry.bank = Number.isFinite(m.bank) ? m.bank : 0;
          entry.coupledTractorGuid = (m.coupledTractorGuid ?? 0) >>> 0;
          entry.mountedContainerGuid = (m.mountedContainerGuid ?? 0) >>> 0;
          entry.containerSlot = m.containerSlot ?? 0;
          entry.trailerFlags = m.trailerFlags ?? 0;
          entry.ownerGuid = (m.ownerGuid ?? 0) >>> 0;
          if (m.sideliftPhase !== undefined) {
            const nextPhase = m.sideliftPhase | 0;
            if (nextPhase !== entry.sideliftPhase) {
              entry._lastSideliftPhase = nextPhase;
              entry._smoothSideliftProgress = Number.isFinite(m.sideliftProgress) ? m.sideliftProgress : 0;
            }
            entry.sideliftPhase = nextPhase;
          }
          if (m.sideliftSide !== undefined) entry.sideliftSide = m.sideliftSide;
          if (m.sideliftFlags !== undefined) entry.sideliftFlags = m.sideliftFlags;
          if (Number.isFinite(m.sideliftProgress)) {
            entry.sideliftProgress = m.sideliftProgress;
            entry._smoothSideliftProgress = Math.max(entry._smoothSideliftProgress ?? 0, m.sideliftProgress);
          }
          if (Number.isFinite(m.outriggerProgress)) {
            entry.outriggerProgress = m.outriggerProgress;
            entry._smoothOutriggerProgress = m.outriggerProgress;
          }
          if (Number.isFinite(m.craneSpanY) && m.craneSpanY > 0) entry.craneSpanY = m.craneSpanY;
          if (m.stowedPalletJackGuid !== undefined) entry.stowedPalletJackGuid = m.stowedPalletJackGuid >>> 0;
          if (m.transferContainerGuid !== undefined) entry.transferContainerGuid = m.transferContainerGuid >>> 0;
          entry.last = m;
          const tNow = nowSec();
          entry.lastSeenAt = tNow;
          entry.lastMsgAt = tNow;

          const inEm = em()?.entityMap?.get(guid);
          if (inEm) {
            entry.seenInEm = true;
            if (!entry.standInHidden || inEm._filmHidden !== true) {
              try { if (em()?.setFilmHidden?.(guid, true)) entry.standInHidden = true; } catch (_) {}
            }
          }

          if (entry.coupledTractorGuid === 0) {
            entry._wasCoupledTo = 0;
            Object.assign(entry.coupledKinState, {
              x: wx, y: wy, z: wz,
              heading: entry.heading,
              pitch: entry.pitch,
              bank: entry.bank,
              articulationRad: 0,
            });
            entry.renderedPose = {
              x: wx, y: wy, z: wz,
              heading: entry.heading,
              pitch: entry.pitch,
              bank: entry.bank,
            };
            const qTr = FM.orientation(entry.heading, entry.pitch, entry.bank);
            entry.model.root.position.set(wx, wy, wz);
            entry.model.root.quaternion.set(qTr[1], qTr[2], qTr[3], qTr[0]);
            writeEntity(guid, wx, wy, wz, qTr, true);
            const upd = {
              twistlockState: (entry.trailerFlags & TRAILER_FLAG.TWISTLOCKS_LOCKED) ? 1 : 0,
              landingGearRetracted: Boolean(entry.trailerFlags & TRAILER_FLAG.GEAR_RETRACTED),
              brakeLights: Boolean(entry.trailerFlags & TRAILER_FLAG.BRAKE_LIGHTS),
              speed: 0,
            };
            if (entry.isSidelifter) {
              Object.assign(upd, {
                sideliftPhase: entry.sideliftPhase,
                sideliftSide: entry.sideliftSide,
                sideliftFlags: entry.sideliftFlags,
                sideliftProgress: entry.sideliftProgress,
                outriggerProgress: entry.outriggerProgress,
                craneSpanY: entry.craneSpanY,
                hasStowedPalletJack: Boolean((entry.sideliftFlags & 0x08) || entry.stowedPalletJackGuid),
                isLoadDirection: Boolean(entry.sideliftFlags & 0x10),
              });
            }
            try { entry.model.update(0, upd); } catch (_) {}
          } else {
            const tractor = vehicles.get(entry.coupledTractorGuid);
            if (tractor && tractor.params) {
              const mul = computeTowMassMul(tractor);
              tractor.params.towMassMul = mul;
              if (pilot && pilot.vehicle === tractor && pilot.predictor?.state) {
                pilot.predictor.state.towMassMul = mul;
              }
            }
          }

          syncTrailerContainerMount(entry);
        }
        break;
      }
      case "pallet_jack_state": {
        const guid = (m.palletJackGuid ?? m.guid) >>> 0;
        if (!guid) break;
        const pos = Array.isArray(m.position) ? m.position : [m.x ?? 0, m.y ?? 0, m.z ?? 0];
        const cell = (m.cell ?? 0) >>> 0;
        const [wx, wy, wz] = cell ? FM.toGlobal(cell, pos[0], pos[1], pos[2]) : [pos[0], pos[1], pos[2]];
        const entry = ensurePalletJackEntry(guid, m);
        if (entry) {
          entry.operatorGuid = (m.operatorGuid ?? 0) >>> 0;
          entry.stowedOnTrailerGuid = (m.stowedOnTrailerGuid ?? 0) >>> 0;
          entry.cell = cell;
          entry.rawPos = pos;
          entry.worldPos = [wx, wy, wz];
          entry.heading = Number.isFinite(m.heading) ? m.heading : 0;
          entry.tillerAngle = Number.isFinite(m.tillerAngle) ? m.tillerAngle : 0;
          entry.forkHeightM = Number.isFinite(m.forkHeightM) ? m.forkHeightM : 0.085;
          entry.forkState = m.forkState ?? 0;
          entry.carriedPalletSize = m.carriedPalletSize ?? 0;
          entry.flags = m.flags ?? 0;
          entry.carriedWcid = (m.carriedWcid ?? 0) >>> 0;
          entry.ownerGuid = (m.ownerGuid ?? 0) >>> 0;
          entry.last = m;
          const tNow = nowSec();
          entry.lastSeenAt = tNow;
          entry.lastMsgAt = tNow;
          if (em()?.entityMap?.get(guid)) entry.seenInEm = true;

          const stowed = Boolean(entry.stowedOnTrailerGuid !== 0 || (entry.flags & 0x04));
          if (stowed) {
            if (entry.model?.root?.parent) entry.model.root.parent.remove(entry.model.root);
          } else if (entry.model?.root && live?.worldRoot && entry.model.root.parent !== live.worldRoot) {
            live.worldRoot.add(entry.model.root);
          }

          try { palletJackController?.onServerState?.(m, entry); } catch (_) {}

          if (palletJackController?.activeGuid !== guid) {
            const qPj = FM.orientation(entry.heading, 0, 0);
            entry.model?.root?.position?.set(wx, wy, wz);
            entry.model?.root?.quaternion?.set(qPj[1], qPj[2], qPj[3], qPj[0]);
            try {
              entry.model?.update?.({
                forkHeightM: entry.forkHeightM,
                tillerAngle: entry.tillerAngle,
                pumpStroke: 0,
                carriedWcid: entry.carriedWcid,
                stowed,
              });
            } catch (_) {}
            if (!stowed) writeEntity(guid, wx, wy, wz, qPj, true);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  function drainInbox() {
    const h = sh();
    if (!h || typeof h.drainVehicleMessages !== "function") return;
    let arr;
    try {
      arr = JSON.parse(h.drainVehicleMessages());
    } catch (_) {
      stats.parseErrors++;
      return;
    }
    for (const m of arr) handleMsg(m);
  }

  function handshake() {
    const h = sh();
    if (!h || typeof h.vehicleCapabilities !== "function" || !localGuid()) return;
    const t = nowSec();
    if (caps.handle !== h) {
      caps.handle = h;
      caps.tries = 0;
      caps.granted = null;
      caps.sentAt = 0;
    }
    if (caps.granted !== null) return;
    if (caps.tries >= 4 || t - caps.sentAt < 5) return;
    try {
      h.vehicleCapabilities(CAP_OBSERVE | CAP_PILOT);
      caps.sentAt = t;
      caps.tries++;
    } catch (_) { /* session not ready */ }
  }

  // ---------------------------------------------------------------- piloting

  /**
   * The follow camera fades the local avatar out as its eye closes on the player (camera.js A12-C2 near-fade), and the
   * film camera owner freezes that fade while it owns the camera. Released for a frame at the bail, the follow camera
   * collapsed onto the body and the fall was flown with an invisible avatar under the canopy (1070 tour D): our own
   * cameras always keep the avatar opaque.
   */
  function unfadeAvatar() {
    try {
      const cs = live.cameraSwitcher;
      if (cs && typeof cs._applyCameraPlayerFade === "function") {
        cs._camFadeLastOpacity = undefined; // past the dedupe cache
        cs._applyCameraPlayerFade(1);
      }
    } catch (_) { /* cosmetic */ }
  }

  function makePredictor(v, m) {
    const isGround = v.locomotion === 2 || v.profile?.locomotion === 2 || m?.locomotion === 2;
    return createPilotPredictor({
      params: v.params,
      ground,
      initial: stateFromMsg(m),
      vCap: m.vCap,
      startSeq: 1,
      locomotion: isGround ? 2 : 1,
    });
  }

  function requestSeatHotSwap(v, newSeat) {
    const curSeat = pilot ? pilot.seat : (passenger ? passenger.seat : -1);
    if (curSeat === newSeat) return;
    v.hotSwapTarget = newSeat;
    v.hotSwapFrom = curSeat;
    v.hotSwapRequestedAt = nowSec();
    try { sh()?.vehicleBoard?.(v.guid, newSeat); } catch (_) {}
  }

  function requestPassengerExit(mode = 0) {
    if (!passenger) return;
    const vActive = passenger.vehicle;
    if (vActive) {
      vActive.hotSwapTarget = null;
      vActive.hotSwapFrom = null;
      vActive.hotSwapRequestedAt = 0;
    }
    try { sh().vehicleExit(passenger.vehicle.guid, mode); } catch (_) {}
  }

  function startPiloting(v, seat, hotSwapFrom = null) {
    if (palletJackController?.isActive?.()) {
      const pjGuid = palletJackController.activeGuid;
      if (pjGuid) {
        try { sh()?.vehiclePalletJackAction?.(pjGuid, PALLET_JACK_ACTION.Release, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); } catch (_) {}
      }
      palletJackController.stop("board-vehicle");
    }
    let camera = null;
    let camRig = null;
    let prevRigHidden = false;
    let prevRigComposite;
    if (passenger) {
      camera = passenger.camera;
      camRig = passenger.camRig;
      prevRigHidden = !!passenger.rigHidden;
      prevRigComposite = passenger.rigComposite;
      stopRiding("pilot transition", true /* keepCamera */);
    } else if (pilot) {
      camera = pilot.camera;
      camRig = pilot.camRig;
      prevRigHidden = !!pilot.rigHidden;
      prevRigComposite = pilot.rigComposite;
      stopPiloting("re-seat", true /* keepCamera */);
    }
    endHandoff("re-seat");
    releaseLandingCam();
    if (!v.params) {
      try { camera?.release?.(); camera?.dispose?.(); } catch (_) {}
      if (prevRigHidden) {
        try { em()?.setFilmHidden?.(localGuid(), false); } catch (_) {}
      }
      try { sh()?.clearVehicleSeat?.(); } catch (_) {}
      try { em()?.setMotion?.(localGuid(), MOTION.READY, MOTION.NONCOMBAT, 1.0); } catch (_) {}
      try { groundAudio?.stop?.({ fadeSec: 0 }); vehicleAudio?.stop?.({ fadeSec: 0 }); } catch (_) {}
      return;
    }

    const isGround = isGroundVehicle(v);
    const controls = createVehicleControls({
      window: win,
      canvas: live.renderer?.domElement ?? null,
      cameraSwitcher: live.cameraSwitcher ?? null,
      locomotion: isGround ? 2 : 1,
      seatIndex: 0,
      vehicleClass: v.profile?.vehicleClass ?? 0,
      profileKey: v.profile?.profileKey ?? "",
      maxSeats: maxSeatsOf(v),
    });
    controls.lock();
    controls.throttle = 0;

    if (!camera) {
      try {
        camera = createCameraOwner({ liveScene3d: live, THREE, window: win, get sessionHandle() { return sh(); } });
        camera.own();
        unfadeAvatar();
      } catch (e) {
        camera = null;
        console.warn("[vehicles] camera owner unavailable:", e && e.message ? e.message : e);
      }
    }
    if (!camRig) {
      camRig = createPilotCameraRig({
        ground,
        chaseCfg: isGround ? undefined : CHASE,
        initialView: "chase",
        locomotion: isGround ? 2 : 1,
        seatIndex: 0,
        vehicleClass: v.profile?.vehicleClass ?? 0,
        profileKey: v.profile?.profileKey ?? "",
      });
    } else {
      camRig.setSeatIndex?.(0);
    }

    try { em()?.setMotion?.(localGuid(), MOTION.SITTING, MOTION.NONCOMBAT, 1.0); } catch (_) { /* never fatal */ }
    if (isGround) {
      try { groundAudio?.start(); } catch (_) {}
    } else {
      try {
        vehicleAudio?.start();
        vehicleAudio?.canopy({ open: false, pos: v.last ? stateFromMsg(v.last) : null, mine: true, fpv: false });
      } catch (_) {}
    }

    let hop = null;
    exitHop = null;
    const rig = em()?.entityMap?.get(localGuid());
    if (hopsOn && rig?.root && (hotSwapFrom === null || hotSwapFrom === undefined)) {
      const r = rig.root;
      hop = { from: { x: r.position.x, y: r.position.y, z: r.position.z }, h0: headingOfQuat([r.quaternion.w, r.quaternion.x, r.quaternion.y, r.quaternion.z]), t: 0, dur: 0 };
    }

    let hotSwap = null;
    if (hotSwapFrom !== null && hotSwapFrom !== undefined && hotSwapFrom !== seat) {
      hotSwap = { fromSeat: hotSwapFrom, toSeat: seat, startTime: nowSec(), duration: 0.35 };
    }

    pilot = {
      audio: isGround ? groundAudio : vehicleAudio,
      hop,
      camRig,
      hotSwap,
      vehicle: v,
      seat,
      controls,
      camera,
      acc: 0,
      predictor: v.last ? makePredictor(v, v.last) : null,
      startedAt: nowSec(),
      view: camRig?.getView ? camRig.getView() : "chase",
      rigHidden: prevRigHidden,
      rigComposite: prevRigComposite,
      camHeading: null,
      camPitch: null,
      camRoll: null,
      camLift: 0,
      lastServer: v.last,
      ownLb: -1,
      leadLb: -1,
      sent: 0,
      unsub: null,
      lastSeat: null,
      trail: [],
      gLoad: 1.0,
      lastGearDown: true,
      lastFireAt: -10,
    };

    pilot.unsub = controls.onAction((a) => {
      if (a.type === "camera") {
        pilot.view = pilot.camRig.cycleView();
        pilot.camHeading = null;
        pilot.camPitch = null;
        pilot.camRoll = null;
        pilot.camLift = 0;
        try {
          if (!isGround) vehicleAudio?.canopy({ open: pilot.view === "chase", mine: true, fpv: pilot.view === "cockpit" });
        } catch (_) {}
      } else if (a.type === "mouseAim") {
        const nextAim = !controls.mouseAim;
        controls.setMouseAim(nextAim, pilot.predictor?.state ?? null);
        flashPrompt(nextAim ? "Mouse-Aim Instructor ON" : "Mouse-Aim OFF", 1200);
      } else if (a.type === "seat") {
        if (Number.isFinite(a.seatIndex) && a.seatIndex >= 0 && a.seatIndex < maxSeatsOf(v)) {
          requestSeatHotSwap(v, a.seatIndex);
        }
      } else if (a.type === "trailerHitch") {
        const hitchedGuid = currentHitchedTrailerGuid(v);
        if (hitchedGuid !== 0) {
          try { sh()?.vehicleTrailerAction?.(hitchedGuid, v.guid, 0, TRAILER_ACTION.Unhitch, 0); } catch (_) {}
        } else {
          const best = findNearestUnhitchedTrailer(v, 3.5);
          if (best) {
            try { sh()?.vehicleTrailerAction?.(best.guid, v.guid, 0, TRAILER_ACTION.Hitch, 0); } catch (_) {}
          } else {
            flashPrompt("Move within 3.5 m of trailer kingpin to hitch", 1500);
          }
        }
      } else if (a.type === "windscreen") {
        if (!isSemiVehicle(v)) {
          v.windscreenFolded = !v.windscreenFolded;
          flashPrompt(v.windscreenFolded ? "Windscreen folded" : "Windscreen raised", 1200);
        }
      } else if (a.type === "hideHud") osd.toggleHidden();
      else if (a.type === "exit") requestExit();
    });
    osd.prompt(null);
    console.log(`[vehicles] piloting 0x${v.guid.toString(16)} seat ${seat}`);
  }

  function startRiding(v, seat, hotSwapFrom = null) {
    if (palletJackController?.isActive?.()) {
      const pjGuid = palletJackController.activeGuid;
      if (pjGuid) {
        try { sh()?.vehiclePalletJackAction?.(pjGuid, PALLET_JACK_ACTION.Release, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); } catch (_) {}
      }
      palletJackController.stop("board-vehicle");
    }
    let camera = null;
    let camRig = null;
    let prevRigHidden = false;
    let prevRigComposite;
    if (pilot) {
      camera = pilot.camera;
      camRig = pilot.camRig;
      prevRigHidden = !!pilot.rigHidden;
      prevRigComposite = pilot.rigComposite;
      stopPiloting("passenger transition", true /* keepCamera */);
    } else if (passenger) {
      camera = passenger.camera;
      camRig = passenger.camRig;
      prevRigHidden = !!passenger.rigHidden;
      prevRigComposite = passenger.rigComposite;
      stopRiding("re-seat", true /* keepCamera */);
    }
    endHandoff("re-seat");
    releaseLandingCam();
    if (!v.params) {
      try { camera?.release?.(); camera?.dispose?.(); } catch (_) {}
      if (prevRigHidden) {
        try { em()?.setFilmHidden?.(localGuid(), false); } catch (_) {}
      }
      try { sh()?.clearVehicleSeat?.(); } catch (_) {}
      try { em()?.setMotion?.(localGuid(), MOTION.READY, MOTION.NONCOMBAT, 1.0); } catch (_) {}
      try { groundAudio?.stop?.({ fadeSec: 0 }); vehicleAudio?.stop?.({ fadeSec: 0 }); } catch (_) {}
      return;
    }

    const controls = createVehicleControls({
      window: win,
      canvas: live.renderer?.domElement ?? null,
      cameraSwitcher: live.cameraSwitcher ?? null,
      locomotion: 2,
      seatIndex: seat,
      vehicleClass: v.profile?.vehicleClass ?? 0,
      profileKey: v.profile?.profileKey ?? "",
      maxSeats: maxSeatsOf(v),
    });
    controls.lock();

    if (!camera) {
      try {
        camera = createCameraOwner({ liveScene3d: live, THREE, window: win, get sessionHandle() { return sh(); } });
        camera.own();
        unfadeAvatar();
      } catch (e) {
        camera = null;
        console.warn("[vehicles] camera owner unavailable:", e && e.message ? e.message : e);
      }
    }
    if (!camRig) {
      camRig = createPilotCameraRig({
        ground,
        chaseCfg: undefined,
        initialView: "chase",
        locomotion: 2,
        seatIndex: seat,
        vehicleClass: v.profile?.vehicleClass ?? 0,
        profileKey: v.profile?.profileKey ?? "",
      });
    } else {
      camRig.setSeatIndex?.(seat);
    }

    try { em()?.setMotion?.(localGuid(), MOTION.SITTING, MOTION.NONCOMBAT, 1.0); } catch (_) {}
    try { groundAudio?.start(); } catch (_) {}

    let hotSwap = null;
    if (hotSwapFrom !== null && hotSwapFrom !== undefined && hotSwapFrom !== seat) {
      hotSwap = { fromSeat: hotSwapFrom, toSeat: seat, startTime: nowSec(), duration: 0.35 };
    }

    passenger = {
      audio: groundAudio,
      camRig,
      hotSwap,
      vehicle: v,
      seat,
      controls,
      camera,
      startedAt: nowSec(),
      view: camRig?.getView ? camRig.getView() : "chase",
      rigHidden: prevRigHidden,
      rigComposite: prevRigComposite,
      unsub: null,
      lastSeat: null,
      trail: [],
    };

    passenger.unsub = controls.onAction((a) => {
      if (a.type === "camera") {
        passenger.view = passenger.camRig.cycleView();
      } else if (a.type === "seat") {
        if (Number.isFinite(a.seatIndex) && a.seatIndex >= 0 && a.seatIndex < maxSeatsOf(v)) {
          requestSeatHotSwap(v, a.seatIndex);
        }
      } else if (a.type === "windscreen") {
        if (!isSemiVehicle(v)) {
          v.windscreenFolded = !v.windscreenFolded;
          flashPrompt(v.windscreenFolded ? "Windscreen folded" : "Windscreen raised", 1200);
        }
      } else if (a.type === "hideHud") {
        osd.toggleHidden();
      } else if (a.type === "exit") {
        requestPassengerExit();
      }
    });

    osd.prompt(null);
    console.log(`[vehicles] riding 0x${v.guid.toString(16)} seat ${seat}`);
  }

  function stopRiding(why, keepCamera = false) {
    if (!passenger) return;
    const p = passenger;
    passenger = null;
    try { p.unsub?.(); } catch (_) {}
    try { p.controls?.dispose(); } catch (_) {}
    if (!keepCamera) {
      try { p.camera?.release(); p.camera?.dispose(); } catch (_) {}
      try { sh()?.clearVehicleSeat?.(); } catch (_) {}
      try { em()?.setMotion?.(localGuid(), MOTION.READY, MOTION.NONCOMBAT, 1.0); } catch (_) {}
      try { groundAudio?.stop({ fadeSec: 0.25 }); } catch (_) {}
      if (p.rigHidden) {
        try {
          em()?.setFilmHidden?.(localGuid(), false);
          if (p.rigComposite === false) em()?.setFilmHidden?.(p.vehicle.guid, false);
        } catch (_) { /* */ }
      }
    }
    try {
      if (win?.__inputFunnel && typeof win.__inputFunnel.unpoison === "function") {
        win.__inputFunnel.unpoison();
      }
      if (win?.__inputFunnel && typeof win.__inputFunnel.releaseHeld === "function") {
        win.__inputFunnel.releaseHeld("vehicle");
      }
    } catch (_) {}
    osd.update(null);
    console.log(`[vehicles] stopped riding (${why})`);
  }

  function stopPiloting(why, keepCamera = false) {
    if (!pilot) return;
    const p = pilot;
    pilot = null; if (FLIGHT_RESIDENCY) clearFlightHint();
    try {
      lastPilotKin = p.predictor && p.vehicle?.params
        ? { vehicle: p.vehicle.guid >>> 0, vel: FM.velocity(p.predictor.state, p.vehicle.params), at: nowSec() } : null;
    } catch (_) { lastPilotKin = null; }
    const mode = p.predictor?.state?.mode;
    const v = p.vehicle;
    const flying = !disposed && p.predictor && v?.params && vehicles.get(v.guid) === v && mode !== FM.MODE.PARKED && mode !== FM.MODE.CRASHED;
    const isTeardown = why === "disconnect" || why === "context-loss" || why === "logout" || why === "dispose";
    const inAir = !isTeardown && !keepCamera && why === "seat released" && flying && !teleportUnderWay();
    try { p.unsub?.(); } catch (_) {}
    try { p.controls.dispose(); } catch (_) {}
    if (!keepCamera) {
      if (!inAir) { try { p.camera?.release(); p.camera?.dispose(); } catch (_) {} }
      try { sh()?.clearVehicleSeat?.(); } catch (_) {}
      try {
        vehicleAudio?.stop({ fadeSec: (inAir && !isTeardown) ? 0.25 : 0 });
        if (!inAir && why === "seat released") vehicleAudio?.canopy({ open: true, mine: true, fpv: false });
        if (isTeardown) vehicleAudio?.dispose();
        groundAudio?.stop({ fadeSec: 0.25 });
        if (isTeardown) groundAudio?.dispose();
      } catch (_) {}
    }
    try {
      if (win?.__inputFunnel && typeof win.__inputFunnel.unpoison === "function") {
        win.__inputFunnel.unpoison();
      }
      if (win?.__inputFunnel && typeof win.__inputFunnel.releaseHeld === "function") {
        win.__inputFunnel.releaseHeld("vehicle");
      }
    } catch (_) {}
    if (!keepCamera) {
      if (!inAir) { try { em()?.setMotion?.(localGuid(), MOTION.READY, MOTION.NONCOMBAT, 1.0); } catch (_) {} }
      if (p.rigHidden) {
        try {
          em()?.setFilmHidden?.(localGuid(), false);
          if (p.rigComposite === false) em()?.setFilmHidden?.(p.vehicle.guid, false);
        } catch (_) { /* */ }
      }
    }
    if (v && vehicles.get(v.guid) === v) {
      v.track = createObserverTrack();
      v.blend = null;
      v.reckon = flying
        ? { predictor: p.predictor, speed: p.predictor.state.speed, acc: p.acc ?? 0, lastWall: p.lastWall ?? nowSec(), startedAt: nowSec(), pose: null, shift: null }
        : null;
    }
    if (inAir) startHandoff(p);
    else if (hopsOn && p.lastSeat && (why === "seat released" || why === "touchdown")) exitHop = { from: p.lastSeat, h: p.lastSeat.heading, t: 0, dur: HOP.exitSec };
    osd.update(null);
    console.log(`[vehicles] stopped piloting (${why}${inAir ? ", in the air: bail hand-off" : ""})`);
  }

  // ---------------------------------------------------------------- the bail hand-off (BAIL_HANDOFF)

  function startHandoff(p) {
    endHandoff("restart");
    // the aircraft is dead-reckoned already (stopPiloting: v.reckon)
    handoff = { v: p.vehicle, seat: p.seat, camera: p.camera && p.camera.owned ? p.camera : null, camHeading: p.camHeading, camPitch: p.camPitch, camRoll: p.camRoll, camLift: p.camLift ?? 0, lastSeat: p.lastSeat, startedAt: nowSec(),
      trail: Array.isArray(p.trail) ? p.trail.slice() : [], onLock: !!p.onLock }; // the pilot's last locks: the body sits on one (beforeMovement)
    if (p.camera && !handoff.camera) { try { p.camera.release(); p.camera.dispose(); } catch (_) {} }
    stats.handoffs++;
  }

  /** End the hand-off. keepCamera: the caller (startFall) takes the still-owned camera; returns the hand-off. */
  function endHandoff(why, keepCamera = false) {
    const ho = handoff;
    if (!ho) return null;
    handoff = null;
    stats.lastHandoff = { why, ms: Math.round((nowSec() - ho.startedAt) * 1000) };
    if (!keepCamera) {
      try { ho.camera?.release(); ho.camera?.dispose(); } catch (_) {}
      // no bail followed: the body is the player's again (the seat release's Ready, deferred). On dispose too, as
      // stopPiloting / stopFall: the lock tickHandoff set is keyed on the PLAYER, and the server's seat release only
      // clears a lock keyed on the vehicle — left set, every movement tick held the body in the sky
      try { sh()?.clearVehicleSeat?.(); } catch (_) {}
      try { em()?.setMotion?.(localGuid(), MOTION.READY, MOTION.NONCOMBAT, 1.0); } catch (_) {}
    }
    return ho;
  }

  /**
   * PlayerTeleport (app/client_events.js, kind 33 — dispatched before this frame's vehicle tick, after the seat release
   * if it came first). ACE's OnPlayerTeleport releases the seat in the air with NO Bail and no Touchdown, and cancels
   * a fall: end piloting, the hand-off and the fall at once. Left running, each re-sets the seat lock every frame, and
   * the wasm movement tick snaps the body to the lock — over the teleport's destination, which nothing re-sends.
   */
  function onTeleport() {
    teleportAt = nowSec();
    if (pilot) stopPiloting("teleport");
    if (passenger) stopRiding("teleport");
    if (palletJackController?.isActive?.()) {
      try { palletJackController.onTeleport(); } catch (_) {}
    }
    try { shipManager?.onTeleport?.(); } catch (_) {}
    endHandoff("teleport");
    if (fall) { chutes?.close(localGuid()); stopFall("teleport"); }
    const map = em()?.entityMap;
    if (map) {
      pruneLogisticsEntries(map, teleportAt, true);
    }
  }

  /**
   * Just before the wasm movement tick (scene3d/index.js syncTickHop, ahead of tickMovement), while the hand-off holds
   * the body. ACE sends the seat release (UIQueue bundle) and PlayerTeleport + the destination UpdatePosition
   * (SmartboxQueue bundle) in separate datagrams >= 5 ms apart (NetworkSession: one bundle per pass), and with a fog
   * reset 1 s apart: with a frame boundary between them, the hand-off locked the body in that frame's afterTick, the
   * recv loop applied the destination between frames, and the next movement tick snapped the body back onto the lock
   * at the old site BEFORE the kind-33 dispatch (onTeleport) could run. The recv loop publishes the destination pose at
   * once (getLocalPlayerPose), and nothing else moves the body under the lock (the server never sends a faller or a
   * pilot its own position: EnqueueBroadcast(false)): a body far from every recent lock = the destination landed — end
   * the hand-off (clears the lock) so the movement tick keeps it.
   */
  function beforeMovement() {
    // armed (`onLock`) once the body has been seen ON a moving lock (the pilot's or the hand-off's): a client whose
    // wasm does not slave the body (a stale pkg) never takes its body for a teleport's destination
    const holder = handoff ?? pilot;
    if (disposed || !holder || !holder.trail || !holder.trail.length || (holder === pilot && holder.onLock)) return;
    let g = null;
    try {
      const pp = sh()?.getLocalPlayerPose?.();
      if (pp) {
        g = FM.toGlobal(pp.landblockId >>> 0, pp.x, pp.y, pp.z);
        try { pp.free?.(); } catch (_) { /* a plain object */ }
      }
    } catch (_) { g = null; }
    if (!g || !g.every(Number.isFinite) || !(g[0] || g[1])) return;
    const tr = holder.trail, last = tr[tr.length - 1];
    let near = Infinity, speed = 0;
    for (let i = 0; i < tr.length; i++) {
      near = Math.min(near, Math.hypot(g[0] - tr[i].x, g[1] - tr[i].y, g[2] - tr[i].z));
      if (i > 0 && tr[i].t > tr[i - 1].t) speed = Math.max(speed, Math.hypot(tr[i].x - tr[i - 1].x, tr[i].y - tr[i - 1].y, tr[i].z - tr[i - 1].z) / (tr[i].t - tr[i - 1].t));
    }
    if (near <= 1 && Math.hypot(last.x - tr[0].x, last.y - tr[0].y, last.z - tr[0].z) > 1) holder.onLock = true;
    if (holder !== handoff || !holder.onLock) return;
    // slack: the first hand-off frame's movement tick ran unlocked (the server released the pilot's lock) from a lock
    const gap = Math.min(1, Math.max(0, nowSec() - last.t));
    if (near > BAIL_HANDOFF.snapM + speed * gap) {
      teleportAt = nowSec();
      endHandoff("teleport");
    }
  }

  /**
   * The drawn pose of a vehicle nobody here pilots, once per frame: its observer track; after a bail hand-off first
   * the dead-reckoned predictor, then the track plus the hand-over difference easing out (vehicleClose).
   */
  function observedPose(v, t) {
    if (v.drawFrame === stats.frames) return v.drawPose;
    let pose = null;
    const rk = v.reckon;
    if (rk) {
      // the dead reckoning, advanced to t first: this frame's pose is also the hand-over's reference (last frame's
      // made the aircraft stand still for the hand-over frame)
      let dt = t - rk.lastWall;
      rk.lastWall = t;
      if (!(dt >= 0)) dt = 0;
      if (dt > 1) dt = 1;
      rk.acc += dt;
      let n = 0;
      while (rk.acc >= FM.DT && n < 30) {
        rk.acc -= FM.DT;
        rk.predictor.stepLocal(NEUTRAL_INPUT);
        n++;
        // at least the bail speed: idle throttle slowed it below the falling body (it fell behind the body)
        const st = rk.predictor.state;
        if (st.mode === FM.MODE.FLIGHT && st.speed < rk.speed) st.speed = rk.speed;
      }
      if (n >= 30) rk.acc = 0;
      rk.predictor.decay(dt);
      pose = rk.predictor.renderPose(rk.acc / FM.DT);
      const sh = rk.shift; // after the Bail: the lead the body has shed so far (startFall)
      const ks = sh ? easeLeft((t - sh.at) / sh.sec) : 0;
      if (sh) { pose.x -= sh.off[0] * (1 - ks); pose.y -= sh.off[1] * (1 - ks); pose.z -= sh.off[2] * (1 - ks); }
      rk.pose = pose;
      if (v.track.count >= BAIL_HANDOFF.trackSnaps || t - rk.startedAt > BAIL_HANDOFF.reckonMaxSec) {
        v.reckon = null;
        const tp = v.track.count ? v.track.pose(t) : null;
        if (tp) {
          // drawn = the track + the lead the body is still shedding (`shift`, its own ease) + the rest (`d`: mostly
          // the track's ~0.12 s observer delay), eased slowly — closed in 0.45 s, the aircraft fell back past the body
          const d = { at: t, x: pose.x - tp.x - (sh ? sh.off[0] * ks : 0), y: pose.y - tp.y - (sh ? sh.off[1] * ks : 0), z: pose.z - tp.z - (sh ? sh.off[2] * ks : 0),
            heading: angleDiff(pose.heading, tp.heading), pitch: pose.pitch - tp.pitch, bank: pose.bank - tp.bank, shift: sh ?? null };
          const dm = Math.hypot(d.x, d.y, d.z);
          d.sec = easeSec(dm, tp.speed, BAIL_HANDOFF.vehicleClose, BAIL_HANDOFF.vehicleMinSec);
          v.blend = dm < BAIL_HANDOFF.maxOffsetM ? d : null;
          pose = null; // from the track + the blend below (= this frame's dead-reckoned pose)
        }
      }
    }
    if (!pose && v.track.count) {
      pose = v.track.pose(t);
      const b = v.blend;
      if (pose && b) {
        const k = easeLeft((t - b.at) / b.sec);
        const ks = b.shift ? easeLeft((t - b.shift.at) / b.shift.sec) : 0;
        if (k <= 0 && ks <= 0) v.blend = null;
        else {
          if (ks > 0) { pose.x += b.shift.off[0] * ks; pose.y += b.shift.off[1] * ks; pose.z += b.shift.off[2] * ks; }
          pose.x += b.x * k; pose.y += b.y * k; pose.z += b.z * k;
          pose.heading = FM.wrapHeading(pose.heading + b.heading * k); pose.pitch += b.pitch * k; pose.bank += b.bank * k;
        }
      }
    }
    v.drawFrame = stats.frames;
    v.drawPose = pose;
    return pose;
  }

  // bench / film: {yaw (rad, around the aircraft), back (m), up (m)} — the chase camera orbits the seat by `yaw`
  let camTweak = null;
  /** The chase camera's pose for a seat on a vehicle pose (camHeading already smoothed). */
  function chaseCamPose(seat, pose, ch0, dt = 0, st = null) {
    const ch = ch0 + (camTweak?.yaw ?? 0);
    const back = camTweak?.back ?? CHASE.back, up = camTweak?.up ?? CHASE.up;
    const ex = seat.x - Math.sin(ch) * back;
    const ey = seat.y - Math.cos(ch) * back;
    let ez = seat.z + up;
    const g = ground(ex, ey);
    const wantLift = Number.isFinite(g) ? Math.max(0, (g + CHASE.groundClear) - ez) : 0;
    if (st) {
      const prevLift = Number.isFinite(st.camLift) ? st.camLift : 0;
      const tau = wantLift > prevLift ? CHASE.groundAttackTau : CHASE.groundReleaseTau;
      const aLift = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
      st.camLift = prevLift + (wantLift - prevLift) * aLift;
      ez += st.camLift;
      if (Number.isFinite(g) && ez < g + CHASE.groundClear * 0.5) ez = g + CHASE.groundClear * 0.5;
    } else if (Number.isFinite(g) && ez < g + CHASE.groundClear) {
      ez = g + CHASE.groundClear;
    }
    const rawPitch = Number.isFinite(pose.pitch) ? pose.pitch : 0;
    const rawRoll = Number.isFinite(pose.bank) ? pose.bank : 0;
    let pitch = rawPitch;
    let roll = rawRoll;
    if (st) {
      const aPitch = dt > 0 ? 1 - Math.exp(-dt / CHASE.pitchTau) : 1;
      const aRoll = dt > 0 ? 1 - Math.exp(-dt / CHASE.rollTau) : 1;
      st.camPitch = Number.isFinite(st.camPitch) ? st.camPitch + (rawPitch - st.camPitch) * aPitch : rawPitch;
      st.camRoll = Number.isFinite(st.camRoll) ? st.camRoll + (rawRoll - st.camRoll) * aRoll : rawRoll;
      pitch = st.camPitch;
      roll = st.camRoll;
    }
    // a tweaked orbit looks at the seat (the default chase framing looks a little down along the flight path)
    const pc = camTweak ? (camTweak.pitch ?? -Math.atan2(ez - seat.z, back)) : CHASE.pitch + pitch * 0.4;
    const rl = camTweak ? (camTweak.roll ?? 0) : roll * 0.25;
    return { pos: [ex, ey, ez], h: ch, p: pc, r: rl, fov: camTweak?.fov ?? CHASE.fov };
  }

  /** Between the seat release and the Bail event: the body rides the dead-reckoned seat under the chase camera. */
  function tickHandoff(dt) {
    const ho = handoff;
    const t = nowSec();
    // a teleport (its PlayerTeleport, or portal space): never re-lock the body to the old site (see onTeleport)
    if (teleportUnderWay()) { endHandoff("teleport"); return; }
    if (t - ho.startedAt > BAIL_HANDOFF.maxSec || vehicles.get(ho.v.guid) !== ho.v) { endHandoff(t - ho.startedAt > BAIL_HANDOFF.maxSec ? "timeout" : "gone"); return; }
    const pose = observedPose(ho.v, t);
    if (!pose) return;
    const seat = seatOf(ho.v, pose, ho.seat);
    const cl = FM.toCellLocal(seat.x, seat.y, seat.z);
    // the seat lock keyed on the player (= the fall's; the server released the vehicle's)
    try { sh().setVehicleSeat(localGuid(), cl.cell, cl.x, cl.y, cl.z, pose.heading); } catch (_) {}
    writeEntity(localGuid(), seat.x, seat.y, seat.z, seat.q);
    ho.lastSeat = { x: seat.x, y: seat.y, z: seat.z, heading: pose.heading, t };
    pushTrail(ho.trail, seat, t);
    if (ho.camera && ho.camera.owned) {
      if (ho.camHeading === null || ho.camHeading === undefined) ho.camHeading = pose.heading;
      ho.camHeading = FM.wrapHeading(ho.camHeading + angleDiff(pose.heading, ho.camHeading) * (1 - Math.exp(-dt / CHASE.headingTau)));
      ho.camera.write(chaseCamPose(seat, pose, ho.camHeading, dt, ho));
    }
  }

  // ---------------------------------------------------------------- bail-out fall

  function startFall(m, v) {
    let vel = pilot && pilot.predictor && v?.params ? FM.velocity(pilot.predictor.state, v.params) : null;
    // the seat was released first (the usual order, see lastPilotKin): the velocity kept then. Without it the twin fell
    // straight down while the server's body carried the aircraft's speed (~440 m of drift from a 400 km/h bail) and the
    // Chute event's re-anchor jumped the body that far in one frame (film take D2, 2026-11-02)
    if (!vel && lastPilotKin && lastPilotKin.vehicle === (m.vehicle >>> 0) && nowSec() - lastPilotKin.at < 3) vel = lastPilotKin.vel;
    if (!vel) vel = [0, 0, 0];
    // BAIL_HANDOFF: where the body and the camera were drawn the frame before (the seat released first: the hand-off;
    // the Bail first: the pilot session) — the fall continues from there instead of cutting
    let drawnSeat = null, camFrom = null, camera = null;
    if (pilot) {
      drawnSeat = pilot.lastSeat;
      try { camFrom = pilot.camera && pilot.camera.owned ? pilot.camera.currentPose() : null; } catch (_) { camFrom = null; }
      stopPiloting("bail");
    }
    const ho = endHandoff("bail", true);
    if (ho) {
      drawnSeat = ho.lastSeat ?? drawnSeat;
      camera = ho.camera && ho.camera.owned ? ho.camera : null;
      if (ho.camera && !camera) { try { ho.camera.release(); ho.camera.dispose(); } catch (_) {} }
      try { camFrom = camera ? camera.currentPose() : camFrom; } catch (_) { /* keep */ }
      try { em()?.setMotion?.(localGuid(), MOTION.READY, MOTION.NONCOMBAT, 1.0); } catch (_) {} // the seat release's Ready (deferred), then Falling
    }
    lastPilotKin = null;
    releaseLandingCam();
    exitHop = null; // the seat may have been released (VehicleSeat) before the Bail event: no hop down from altitude
    const [x, y, z] = FM.toGlobal(m.cell, m.x, m.y, m.z);
    const controls = createVehicleControls({ window: win });
    controls.lock();
    // the camera follows the falling body (the follow camera would stay where the body was last placed on the ground —
    // the server owns the fall and never echoes our own position)
    if (!camera) {
      try {
        camera = createCameraOwner({ liveScene3d: live, THREE, window: win, get sessionHandle() { return sh(); } });
        camera.own();
      } catch (_) { camera = null; }
    }
    if (camera) unfadeAvatar();
    // the drawn body eases from the predicted seat onto the server's bail point (BAIL_HANDOFF bodyClose); the camera
    // blends from the chase framing (relative to the drawn body) into the fall camera (camBlendSec)
    // (the seat as drawn last frame, carried on by the time since: the body keeps moving on the bail frame)
    // The twin draws one step behind its state (tickFall), so its history starts one step back along the start
    // velocity: seeded with none (px = x) the drawn body stood still for a step and, with the ease, went BACKWARD.
    const p0 = [x - vel[0] * FM.DT, y - vel[1] * FM.DT, z - vel[2] * FM.DT];
    let off = null, seatAt = null;
    if (drawnSeat && [drawnSeat.x, drawnSeat.y, drawnSeat.z].every(Number.isFinite)) {
      seatAt = [drawnSeat.x, drawnSeat.y, drawnSeat.z];
      const adv = Number.isFinite(drawnSeat.t) ? Math.min(0.2, Math.max(0, nowSec() - drawnSeat.t)) : 0;
      const o = [drawnSeat.x + vel[0] * adv - p0[0], drawnSeat.y + vel[1] * adv - p0[1], drawnSeat.z + vel[2] * adv - p0[2]];
      if (Math.hypot(o[0], o[1], o[2]) < BAIL_HANDOFF.maxOffsetM) off = o;
    }
    const bodyAt = off ? [p0[0] + off[0], p0[1] + off[1], p0[2] + off[2]] : p0;
    const offSec = off ? easeSec(Math.hypot(off[0], off[1], off[2]), Math.hypot(vel[0], vel[1], vel[2]), BAIL_HANDOFF.bodyClose, BAIL_HANDOFF.bodyMinSec) : 0;
    // the camera's offset from the body as drawn WITH it last frame (camFrom is that frame's write, seatAt its seat;
    // both carried on together)
    const ref = seatAt ?? bodyAt;
    const camBlend = camFrom && Array.isArray(camFrom.pos) && [camFrom.h, camFrom.p].every(Number.isFinite)
      ? { rel: [camFrom.pos[0] - ref[0], camFrom.pos[1] - ref[1], camFrom.pos[2] - ref[2]], h: camFrom.h, p: camFrom.p, r: Number.isFinite(camFrom.r) ? camFrom.r : 0, fov: Number.isFinite(camFrom.fov) ? camFrom.fov : FALL_CAM.fov }
      : null;
    // px/py/pz = the state before the newest step, rx/ry/rz = the drawn pose between the two (see tickFall)
    fall = { x, y, z, px: p0[0], py: p0[1], pz: p0[2], rx: bodyAt[0], ry: bodyAt[1], rz: bodyAt[2], vx: vel[0], vy: vel[1], vz: vel[2], heading: m.value, chute: false, acc: 0, controls, camera, camHeading: m.value, vehicle: m.vehicle >>> 0, startedAt: nowSec(), lastWall: undefined,
      off, offSec, camBlend, handoffMs: ho ? Math.round((nowSec() - ho.startedAt) * 1000) : null };
    // the dead-reckoned aircraft sheds the same lead along the same ease (observedPose), so it keeps its place
    // relative to the body instead of falling behind it when its track takes over
    if (off && v && v.reckon) v.reckon.shift = { off, sec: offSec, at: fall.startedAt };
    // the last-resort bound (the real ends: Touchdown, a teleport, dispose): the slowest descent from here — a chute
    // opened at once sinks 5 m/s, so ~20 min from a 5 km bail (fall_pose.js fallTimeoutSec)
    fall.maxSec = fallTimeoutSec(z, ground(x, y));
    // the body: retail Falling + the parachute pack (fall_pose.js)
    fallPose?.begin(localGuid(), { local: true });
    try { vehicleAudio?.bailout({ pos: [x, y, z] }); } catch (_) {}
    fall.unsub = controls.onAction((a) => {
      if (a.type === "exit" && fall && !fall.chute) {
        try { sh().vehicleExit(fall.vehicle, 2); } catch (_) { /* */ }
      }
    });
    flashPrompt("Bailed out — X (or Back) opens the parachute (it opens by itself at 150 m)", 3000);
    console.log("[vehicles] bail-out: falling");
  }

  function stopFall(why) {
    if (!fall) return;
    const f = fall;
    fall = null;
    try { f.unsub?.(); } catch (_) {}
    try { f.controls.dispose(); } catch (_) {}
    try { vehicleAudio?.stopFall({ fadeSec: 0.25 }); } catch (_) {}
    releaseLandingCam();
    if (why === "touchdown" && f.camera && f.camera.owned && FALL_CAM.landHoldSec > 0 && !disposed) {
      const camera = f.camera;
      landingCam = { camera, timer: setTimeout(() => { if (landingCam && landingCam.camera === camera) releaseLandingCam(); }, FALL_CAM.landHoldSec * 1000) };
    } else {
      try { f.camera?.release(); f.camera?.dispose(); } catch (_) {}
    }
    try { sh()?.clearVehicleSeat?.(); } catch (_) {}
    fallPose?.end(localGuid(), why); // the canopy clip off, Ready (the landing link), the pack removed
    console.log(`[vehicles] fall ended (${why}) after ${(nowSec() - f.startedAt).toFixed(1)} s`);
  }

  function tickFall() {
    const f = fall;
    const wallNow = nowSec();
    // the gamepad's Back opens the chute: its edges are read only by polling (the fall steps no vehicle)
    try { f.controls.pollEdges?.(); } catch (_) { /* no pad */ }
    let wallDt = f.lastWall === undefined ? 0 : wallNow - f.lastWall;
    f.lastWall = wallNow;
    f.acc += Math.min(1, Math.max(0, wallDt));
    while (f.acc >= FM.DT) {
      f.acc -= FM.DT;
      f.px = f.x; f.py = f.y; f.pz = f.z;
      stepFall(f, FM.DT);
      const g = ground(f.x, f.y);
      if (!Number.isNaN(g)) {
        if (f.z < g) f.z = g; // the server's Touchdown ends the fall
      }
    }
    // draw BETWEEN the last two 30 Hz steps (= the pilot's predictor.renderPose): the raw stepped state jerked — at a
    // ~30 fps render with vsync jitter some frames run 0 steps and the next 2, so near the ground the body and the fall
    // camera stood still on alternate frames (film take D2-2: 25 % of the last 9 s before touchdown)
    const a = Math.min(1, Math.max(0, f.acc / FM.DT));
    f.rx = f.px + (f.x - f.px) * a; f.ry = f.py + (f.y - f.py) * a; f.rz = f.pz + (f.z - f.pz) * a;
    // BAIL_HANDOFF: the predicted seat → the server's bail point, easing (the twin itself starts at the server's)
    if (f.off) {
      const k = easeLeft((wallNow - f.startedAt) / f.offSec);
      if (k <= 0) f.off = null;
      else { f.rx += f.off[0] * k; f.ry += f.off[1] * k; f.rz += f.off[2] * k; }
    }
    const cl = FM.toCellLocal(f.rx, f.ry, f.rz);
    // keyed on the player (the vehicle's seat was released by the server)
    try { sh().setVehicleSeat(localGuid(), cl.cell, cl.x, cl.y, cl.z, f.heading); } catch (_) {}
    writeEntity(localGuid(), f.rx, f.ry, f.rz, FM.orientation(f.heading, 0, 0));
    try {
      vehicleAudio?.updateFall({ speed: Math.hypot(f.vx, f.vy, f.vz), chute: !!f.chute, pos: [f.rx, f.ry, f.rz] });
    } catch (_) {}
    if (f.camera && f.camera.owned) {
      // chase the body: heading of the horizontal motion (the glide under the chute), smoothed
      const hv = Math.hypot(f.vx, f.vy);
      const want = hv > 0.5 ? Math.atan2(f.vx, f.vy) : f.camHeading;
      f.camHeading = FM.wrapHeading(f.camHeading + angleDiff(want, f.camHeading) * (1 - Math.exp(-Math.max(0, wallDt) / FALL_CAM.headingTau)));
      const ch = f.camHeading + (camTweak?.yaw ?? 0);
      const back = camTweak?.back ?? FALL_CAM.back;
      const up = camTweak?.up ?? FALL_CAM.up;
      let ez = f.rz + up;
      let ex = f.rx - Math.sin(ch) * back, ey = f.ry - Math.cos(ch) * back;
      const cam = { h: ch, p: camTweak?.pitch ?? FALL_CAM.pitch, r: camTweak?.roll ?? 0, fov: camTweak?.fov ?? FALL_CAM.fov };
      // BAIL_HANDOFF: the chase framing → the fall framing (smoothstep), the offset taken relative to the drawn body
      const cb = f.camBlend;
      if (cb) {
        const u = (wallNow - f.startedAt) / BAIL_HANDOFF.camBlendSec;
        if (u >= 1) f.camBlend = null;
        else {
          const s = u <= 0 ? 0 : u * u * (3 - 2 * u);
          ex = f.rx + cb.rel[0] + (ex - f.rx - cb.rel[0]) * s;
          ey = f.ry + cb.rel[1] + (ey - f.ry - cb.rel[1]) * s;
          ez = f.rz + cb.rel[2] + (ez - f.rz - cb.rel[2]) * s;
          cam.h = FM.wrapHeading(cb.h + angleDiff(ch, cb.h) * s);
          cam.p = cb.p + (cam.p - cb.p) * s;
          cam.r = cb.r * (1 - s);
          cam.fov = cb.fov + (cam.fov - cb.fov) * s;
        }
      }
      const g = ground(ex, ey);
      if (!Number.isNaN(g) && ez < g + 2) ez = g + 2;
      let pos = [ex, ey, ez];
      const shake = fx.shakeAt(pos);
      if (shake > 0.01) {
        pos = [pos[0] + (Math.random() - 0.5) * shake, pos[1] + (Math.random() - 0.5) * shake, pos[2] + (Math.random() - 0.5) * shake];
        cam.p += (Math.random() - 0.5) * shake * 0.01;
        cam.r += (Math.random() - 0.5) * shake * 0.01;
      }
      f.camera.write({ pos, ...cam });
    }
    // never stuck — the fall ends on Touchdown (also the server's teleport cancel: Touchdown with cell 0) or here: a
    // teleport's portal space, or the bound (fallTimeoutSec: a 5 km bail free-falls ~2 min and a chute opened high
    // drifts for many minutes, so the old fixed 120 s cut long falls short)
    if (portalSpaceOwnsFrame()) { chutes?.close(localGuid()); stopFall("teleport"); }
    else if (wallNow - f.startedAt > f.maxSec) { chutes?.close(localGuid()); stopFall("timeout"); } // the server places the body anyway
  }

  function requestExit(mode) {
    if (!pilot) return;
    const h = sh();
    const st = pilot.predictor ? pilot.predictor.state : null;
    const parked = st ? st.mode === FM.MODE.PARKED : true;
    let m = mode;
    if (m === undefined) {
      if (parked) m = 0;
      else {
        const t = nowSec();
        if (t - bailArmedAt > 1.5) {
          bailArmedAt = t;
          flashPrompt("Press X again to bail out", 1500);
          return;
        }
        m = 1;
      }
    }
    const vActive = pilot.vehicle;
    if (vActive) {
      vActive.hotSwapTarget = null;
      vActive.hotSwapFrom = null;
      vActive.hotSwapRequestedAt = 0;
    }
    try { h.vehicleExit(pilot.vehicle.guid, m); } catch (_) {}
  }

  const _inputBuf1 = new Int32Array(6);
  const _inputBuf2 = new Int32Array(12);
  const _inputBuf3 = new Int32Array(18);
  function sendInput(p) {
    const frames = p.predictor.recentFrames(3);
    const len = frames.length;
    if (!len) return;
    const flat = len === 3 ? _inputBuf3 : len === 2 ? _inputBuf2 : len === 1 ? _inputBuf1 : new Int32Array(len * 6);
    for (let i = 0; i < len; i++) {
      const f = frames[i], o = i * 6;
      flat[o] = f.seq; flat[o + 1] = f.throttle; flat[o + 2] = f.pitch;
      flat[o + 3] = f.roll; flat[o + 4] = f.yaw; flat[o + 5] = f.buttons;
    }
    try {
      sh().vehicleInput(p.vehicle.guid, flat);
      stats.inputsSent++;
      p.sent++;
    } catch (_) {
      stats.sendErrors++;
    }
  }

  /**
   * Seat world position + orientation for a vehicle pose. With a composite airframe the parked aircraft sits tail-down
   * on its wheels (airframe.js GEAR_PITCH about the main wheels' contact line): the seat rides that tilt too.
   */
  function currentHotSwapSeat(v, pose, hs) {
    const wallNow = nowSec();
    const u = Math.min(1.0, Math.max(0.0, (wallNow - hs.startTime) / (hs.duration || 0.35)));
    const hotSwapOffset = interpolateSeatHotSwap(hs.fromSeat, hs.toSeat, u, v.profile);
    let q = FM.orientation(pose.heading, pose.pitch, pose.bank);
    const r = FM.rotate(q, hotSwapOffset);
    if (u >= 1.0) {
      if (pilot && pilot.hotSwap === hs) pilot.hotSwap = null;
      if (passenger && passenger.hotSwap === hs) passenger.hotSwap = null;
    }
    return { x: pose.x + r[0], y: pose.y + r[1], z: pose.z + r[2], q };
  }

  /**
   * Seat world position + orientation for a vehicle pose. With a composite airframe the parked aircraft sits tail-down
   * on its wheels (airframe.js GEAR_PITCH about the main wheels' contact line): the seat rides that tilt too.
   */
  function seatOf(v, pose, seat) {
    let q = FM.orientation(pose.heading, pose.pitch, pose.bank);
    let off = v.profile?.seats?.[seat]?.offset;
    if ((!off || (off[0] === 0 && off[1] === 0 && off[2] === 0)) && isGroundVehicle(v)) {
      try { off = getSeatOffset(seat, v.profile); } catch (_) {}
    }
    if (!off) off = [0, 0, 0];
    const tilt = airframes ? airframes.tiltOf(v.guid) : 0;
    if (tilt) {
      const inst = airframes.get(v.guid);
      const py = inst?.t?.pivotY ?? 0;
      const c = Math.cos(tilt), s2 = Math.sin(tilt);
      const y = off[1] - py, z = off[2];
      off = [off[0], py + y * c - z * s2, y * s2 + z * c];
      const h = Math.sin(tilt / 2);
      const qt = [Math.cos(tilt / 2), h, 0, 0]; // about the vehicle's x (nose up)
      q = [
        q[0] * qt[0] - q[1] * qt[1] - q[2] * qt[2] - q[3] * qt[3],
        q[0] * qt[1] + q[1] * qt[0] + q[2] * qt[3] - q[3] * qt[2],
        q[0] * qt[2] - q[1] * qt[3] + q[2] * qt[0] + q[3] * qt[1],
        q[0] * qt[3] + q[1] * qt[2] - q[2] * qt[1] + q[3] * qt[0],
      ];
    }
    const r = FM.rotate(q, off);
    return { x: pose.x + r[0], y: pose.y + r[1], z: pose.z + r[2], q };
  }

  /**
   * Pose an entity rig (after the entity tick: last write wins). `stampCell` keeps the entity's current-cell
   * bookkeeping on the pose we draw — the entity reaper (entities.js reapStaleEntities) and the cell gates read
   * `_wireCellId`; without it a vehicle that flew > 8 landblocks from where it spawned was reaped ~30 s later
   * while beside its pilot (1070 tour 2026-11-01). Not for the local player (its cell is managed elsewhere).
   */
  function writeEntity(guid, x, y, z, q, stampCell = false) {
    const inst = em()?.entityMap?.get(guid >>> 0);
    if (!inst || !inst.root) return false;
    inst.root.position.set(x, y, z);
    inst.root.quaternion.set(q[1], q[2], q[3], q[0]);
    if (stampCell) {
      const cell = FM.toCellLocal(x, y, z).cell >>> 0;
      inst._wireCellId = cell;
      inst._wireCellIdx = cell & 0xffff;
    }
    return true;
  }

  function tickPilot(dt) {
    const p = pilot;
    const v = p.vehicle;
    if (!p.predictor) {
      if (v.last) p.predictor = makePredictor(v, v.last);
      else return;
    }
    // Fixed 30 Hz steps on the WALL clock (the frame loop's dt is capped at 100 ms, and a slow frame must not
    // slow the simulation: the server steps on our inputs and would stall waiting for them). One input packet per
    // step (newest + 2 redundant frames).
    const wallNow = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
    let wallDt = p.lastWall === undefined ? dt : wallNow - p.lastWall;
    p.lastWall = wallNow;
    if (!(wallDt >= 0)) wallDt = 0;
    if (wallDt > 1.0) wallDt = 1.0;
    const isGround = isGroundVehicle(v);
    if (v.params && isGround) {
      const mul = computeTowMassMul(v);
      v.params.towMassMul = mul;
      if (p.predictor?.state) p.predictor.state.towMassMul = mul;
    }
    const coupledTr = isGround ? trailers.get(currentHitchedTrailerGuid(v)) : null;
    const sideliftDriveLocked = Boolean(coupledTr && (coupledTr.sideliftPhase ?? 0) !== 0);
    p.acc += wallDt;
    let n = 0;
    const hopping = !!p.hop; // boarding hop in progress: the vehicle stays parked
    while (p.acc >= FM.DT && n < 30) {
      p.acc -= FM.DT;
      const raw = p.controls.poll(FM.DT, p.predictor.state, v.params); // polled while hopping too: the throttle lever keeps its travel
      if (sideliftDriveLocked) {
        if (Math.abs(raw.throttle || 0) > 0.05 && (wallNow - (p._lastSideliftWarnAt || 0) > 1.8)) {
          p._lastSideliftWarnAt = wallNow;
          flashPrompt("ISO 3874: Retract sidelifter outriggers and cranes before driving", 1800);
        }
        raw.throttle = 0;
        raw.handbrake = true;
        raw.boost = false;
      }
      p.predictor.stepLocal(hopping ? { ...NEUTRAL_INPUT, horn: !!raw.horn, headlights: !!raw.headlights } : raw);
      sendInput(p);
      n++;
    }
    if (n >= 30) p.acc = 0;
    p.stepsLastFrame = n;
    p.predictor.decay(wallDt);
    const pose = p.predictor.renderPose(p.acc / FM.DT);
    const h = sh();

    const ctrl = p.controls.status();
    const isBraking = Boolean(ctrl.handbrake || ((pose.groundFlags ?? 0) & 0x02));
    if (isGround) {
      syncTractorCoupledTrailer(v, pose, dt, true, { braking: isBraking });
    }

    // the local body rides the seat (wasm: no local physics while locked)
    const seat = p.hotSwap ? currentHotSwapSeat(v, pose, p.hotSwap) : seatOf(v, pose, p.seat);
    const cl = FM.toCellLocal(seat.x, seat.y, seat.z);
    try { h.setVehicleSeat(v.guid, cl.cell, cl.x, cl.y, cl.z, pose.heading); } catch (_) {}

    const firingNow = !!(ctrl.fire || (wallNow - (p.lastFireAt ?? -10) < 0.22));
    const camStep = p.camRig.step({
      seat,
      pose,
      params: v.params,
      controlsStatus: ctrl,
      dt,
      firing: firingNow,
      explosionShake: fx.shakeAt([seat.x, seat.y, seat.z]),
      camTweak,
      hitchedTrailerKind: v._coupledTrailerKind ?? null,
      vehicleClass: v.profile?.vehicleClass,
      profileKey: v.profile?.profileKey,
    });
    p.gLoad = camStep.gLoad;
    p.view = camStep.view;

    // draw: the vehicle and the pilot's rig at the predicted pose (after the entity tick → last write wins)
    const q = FM.orientation(pose.heading, pose.pitch, pose.bank);
    const firstPerson = p.view === "cockpit" || p.view === "hood";
    const composite = drawVehicle(v, pose, q, {
      dt, throttle: ctrl.throttle, cockpit: firstPerson, hideWindscreen: p.view === "hood",
      pitch: ctrl.sticks.pitch, roll: ctrl.sticks.roll, yaw: ctrl.sticks.yaw,
      boost: ctrl.boost, land: ctrl.land, gLoad: p.gLoad,
      braking: isBraking,
      headlights: !!ctrl.headlights,
      hitchedTrailerGuid: currentHitchedTrailerGuid(v),
      trailerPitch: v._coupledTrailerPitch ?? 0,
    });
    p.lastSeat = { x: seat.x, y: seat.y, z: seat.z, heading: pose.heading, t: wallNow };
    pushTrail(p.trail, seat, wallNow);
    if (p.hop) {
      // boarding hop: the rig arcs from where it stood into the seat; the vehicle is parked meanwhile (neutral input)
      const hp = p.hop;
      if (hp.dur === 0) hp.dur = hopDuration(Math.hypot(seat.x - hp.from.x, seat.y - hp.from.y, seat.z - hp.from.z));
      hp.t += dt;
      const u = hp.t / hp.dur;
      if (u >= 1) {
        p.hop = null;
        writeEntity(localGuid(), seat.x, seat.y, seat.z, seat.q);
      } else {
        const at = hopPoint(hp.from, seat, u);
        writeEntity(localGuid(), at.x, at.y, at.z, FM.orientation(hopHeading(hp.h0, pose.heading, u), 0, 0));
      }
    } else {
      writeEntity(localGuid(), seat.x, seat.y, seat.z, seat.q);
    }

    // Pose seated avatars (0..maxSeats-1) with 34-part IK
    const maxSeats = maxSeatsOf(v);
    const driverSteer = ctrl.steer ? ctrl.steer : (pose.steerAngle || 0);
    const driverAccelLong = isGround ? ((ctrl.throttle ?? 0) * (v.params?.launchAccel ?? 11.2) - (ctrl.handbrake ? 22.0 : 0)) : 0;
    const driverAccelLat = isGround ? (driverSteer * (pose.speed || 0)) : 0;
    const kin = {
      steerAngle: driverSteer,
      speed: pose.speed || 0,
      accelLong: driverAccelLong,
      accelLat: driverAccelLat,
      yawRate: 0,
      profile: v.profile,
    };

    for (let s = 0; s < maxSeats; s++) {
      const occ = v.seats[s] >>> 0;
      if (occ && v.profile) {
        const isLocal = occ === localGuid();
        const sPos = isLocal && p.hotSwap ? currentHotSwapSeat(v, pose, p.hotSwap) : seatOf(v, pose, s);
        if (!isLocal) {
          writeEntity(occ, sPos.x, sPos.y, sPos.z, sPos.q, true);
        } else if (!p.hop) {
          writeEntity(localGuid(), sPos.x, sPos.y, sPos.z, sPos.q);
        }
        const entityInst = em()?.entityMap?.get(occ);
        if (entityInst && isGround) {
          try { applySeatPoseToEntity(entityInst, s, pose, kin, dt); } catch (_) {}
        }
      }
    }

    // cockpit/hood view: the eye sits where the seated pilot's head is (or on the cowling), and the retail stand-in has
    // no interior — hide our own rig AND our vehicle's stand-in model there (render-only, local: everyone else still sees
    // both); shown again in chase view and on leaving the seat. With the composite airframe, cockpit/hood keeps the aircraft.
    syncRigVisibility(p, v, firstPerson, composite);

    // camera (3-mode fighter rig: spring-lag chase, gunsight-aligned cockpit, nose hood-cam + speed FOV + harmonic shake)
    if (p.camera && p.camera.owned) {
      p.camera.write(camStep.cam);
    }

    // client streaming. ?flightResidency (flight experience Phase 1): ONE residency centre — publish the aircraft's
    // state and let residency.js lead the slot grid + object window along the velocity (no second load point, no
    // noteServerLb / landblockChanged per lead change). Off: the load point leads the aircraft by velocity × lead
    // seconds through the world streamer (DESIGN §6.3).
    if (FLIGHT_RESIDENCY) {
      try {
        const vel = FM.velocity(pose, v.params);
        const gz = ground(pose.x, pose.y);
        setFlightHint({ x: pose.x, y: pose.y, z: pose.z, vx: vel[0], vy: vel[1], vz: vel[2], agl: Number.isNaN(gz) ? null : pose.z - gz });
        // ONE centre: the server never echoes the pilot's own position, so feed the world streamer the AIRCRAFT's
        // landblock on each crossing (noteServerLb / landblockChanged / the collision 3x3 then mean what they say)
        const own = cellToLandblockId(cl.cell);
        const inOcean = pose.y >= 48960.0 && pose.y < 68928.0;
        if ((own !== p.ownLb || inOcean !== p.inOcean) && win.__worldStreamer && typeof win.__worldStreamer.onPositionUpdate === "function") {
          p.ownLb = own;
          p.inOcean = inOcean;
          win.__worldStreamer.onPositionUpdate({
            guid: localGuid(),
            landblockId: cl.cell,
            x: cl.x,
            y: cl.y,
            gy: pose.y,
            continent: cl.continent,
            isOceanCorridor: inOcean,
          });
        }
        // and keep the wasm COLLISION terrain (terrainHeightAt, the predictor's floor) resident ahead: the 3x3
        // around the lead point only — no second residency centre
        const lead = Number.isFinite(v.profile.leadSeconds) ? v.profile.leadSeconds : 6;
        const lp = FM.toCellLocal(pose.x + vel[0] * lead, pose.y + vel[1] * lead, pose.z);
        const lb = cellToLandblockId(lp.cell);
        const leadGy = pose.y + vel[1] * lead;
        const leadInOcean = leadGy >= 48960.0 && leadGy < 68928.0;
        if (!leadInOcean && lb !== p.leadLb && typeof win.__ensureCollisionTerrain === "function") {
          rlogEvent(RLOG.LEAD, lb, p.leadLb | 0, 1);
          p.leadLb = lb;
          try { const r = win.__ensureCollisionTerrain(lb >>> 0); if (r && typeof r.catch === "function") r.catch(() => {}); } catch (_) { /* hint only */ }
        }
      } catch (_) { /* streaming hint only */ }
    } else try {
      const vel = FM.velocity(pose, v.params);
      const lead = Number.isFinite(v.profile.leadSeconds) ? v.profile.leadSeconds : 6;
      const lp = FM.toCellLocal(pose.x + vel[0] * lead, pose.y + vel[1] * lead, pose.z);
      const lb = cellToLandblockId(lp.cell);
      const leadGy = pose.y + vel[1] * lead;
      const inOcean = leadGy >= 48960.0 && leadGy < 68928.0;
      if ((lb !== p.leadLb || inOcean !== p.inOcean) && win.__worldStreamer && typeof win.__worldStreamer.onPositionUpdate === "function") {
        rlogEvent(RLOG.LEAD, lb, p.leadLb | 0, 0);
        p.leadLb = lb;
        p.inOcean = inOcean;
        win.__worldStreamer.onPositionUpdate({
          guid: localGuid(),
          landblockId: lp.cell,
          x: lp.x,
          y: lp.y,
          gy: leadGy,
          continent: lp.continent,
          isOceanCorridor: inOcean,
        });
      }
    } catch (_) { /* streaming hint only */ }

    if (isGround) {
      const hitchedGuid = currentHitchedTrailerGuid(v);
      const gFlags = v.last?.groundFlags ?? v.last?.ground_flags ?? 0;
      const surfFam = pose.surfaceFamily ?? v.last?.surfaceFamily ?? v.last?.surface_family ?? 0;
      try {
        groundAudio?.update({
          speed: pose.speed,
          throttle: ctrl.throttle,
          steer: driverSteer,
          handbrake: !!ctrl.handbrake,
          horn: !!ctrl.horn,
          boost: !!ctrl.boost,
          surfaceFamily: surfFam,
          pos: [pose.x, pose.y, pose.z],
          fpv: p.view === "cockpit",
          vehicleClass: v.profile?.vehicleClass ?? 0,
          profileKey: v.profile?.profileKey ?? "",
          hitchedTrailerGuid: hitchedGuid,
          dt,
        });
        if (ctrl.horn !== undefined) groundAudio?.horn?.(!!ctrl.horn);
      } catch (_) {}

      osd.update({
        locomotion: 2,
        name: v.profile?.displayName,
        profileKey: v.profile?.profileKey,
        vehicleClass: v.profile?.vehicleClass,
        vMaxRoad: v.params?.vMaxRoad,
        speed: pose.speed,
        heading: pose.heading,
        seatIndex: 0,
        seats: v.seats,
        groundFlags: gFlags,
        surfaceFamily: surfFam,
        boost: !!ctrl.boost,
        headlights: !!ctrl.headlights,
        handbrake: !!ctrl.handbrake,
        horn: !!ctrl.horn,
        passenger: false,
        throttle: ctrl.throttle,
        steerAngle: driverSteer,
        hitchedTrailerGuid: hitchedGuid,
        trailerKind: v._coupledTrailerKind,
        trailerFlags: v._coupledTrailerFlags ?? v.last?.trailerFlags ?? 0,
        twistlocksLocked: v._coupledTwistlocksLocked,
        trailerArticulationRad: v._coupledArticulationRad ?? 0,
        sideliftPhase: coupledTr?.sideliftPhase ?? 0,
      });
      osd.sights(null, null, "");
    } else {
      // R-2800 Double Wasp radial, 3-blade prop chop/tip buzz, supercharger, slipstream, dive howl, buffet & gear cues
      try {
        const gearDown = pose.mode === FM.MODE.PARKED || pose.mode === FM.MODE.TAKEOFF || pose.mode === FM.MODE.LANDING;
        if (gearDown !== p.lastGearDown) {
          p.lastGearDown = gearDown;
          p.audio?.gear({ deploying: gearDown, pos: [pose.x, pose.y, pose.z], mine: true, fpv: p.view === "cockpit" });
        }
        p.audio?.update({
          throttle: ctrl.throttle,
          speed: pose.speed,
          mode: pose.mode,
          boost: ctrl.boost,
          pitch: pose.pitch,
          bank: pose.bank,
          gLoad: p.gLoad,
          vMin: v.params?.vMin ?? 30,
          backPressure: !!(p.lastServer && (p.lastServer.flags & 0x04)),
          level: pose.mode === FM.MODE.PARKED && ctrl.throttle < 0.05 ? 0.45 : 1,
          fpv: p.view === "cockpit",
          pos: [pose.x, pose.y, pose.z],
          dt,
        });
      } catch (_) { /* audio never breaks flight */ }

      // Fighter HUD + sights
      const g0 = ground(pose.x, pose.y);
      const st = p.predictor.stats();
      const velNow = v.params ? FM.velocity(pose, v.params) : [0, 0, 0];
      osd.update({
        name: v.profile?.displayName, speed: pose.speed,
        agl: Number.isNaN(g0) ? 0 : pose.z - g0, msl: pose.z, vsi: velNow[2],
        heading: pose.heading, pitch: pose.pitch, bank: pose.bank, gLoad: p.gLoad,
        throttle: ctrl.throttle, mode: pose.mode, vCap: p.predictor.vCap,
        vMin: v.params?.vMin, vMax: v.params?.vMax, ceilingAgl: v.params?.ceilingAgl,
        boost: !!ctrl.boost, land: !!ctrl.land, mouseAim: !!ctrl.mouseAim, pitchTrim: ctrl.pitchTrim ?? 0,
        corr: `corr ${st.corrections} (last ${st.lastCorrectionM.toFixed(2)} m)`,
        warn: p.lastServer && (p.lastServer.flags & 0x04),
        arms: armament(v, p.lastServer),
      });
      tickSights(p, v, pose, q, wallNow, ctrl, velNow);
    }
  }

  function tickPassenger(dt) {
    const p = passenger;
    if (!p) return;
    const v = p.vehicle;
    const wallNow = nowSec();
    let pose = observedPose(v, wallNow);
    if (!pose && v.last) pose = stateFromMsg(v.last);
    if (!pose) return;

    const isGround = isGroundVehicle(v);
    const paxGroundFlags = v.last?.groundFlags ?? v.last?.ground_flags ?? 0;
    const paxSurfFam = pose.surfaceFamily ?? v.last?.surfaceFamily ?? v.last?.surface_family ?? 0;
    if (isGround) {
      syncTractorCoupledTrailer(v, pose, dt, false, { braking: Boolean(paxGroundFlags & 0x02) });
    }

    const seat = p.hotSwap ? currentHotSwapSeat(v, pose, p.hotSwap) : seatOf(v, pose, p.seat);
    const cl = FM.toCellLocal(seat.x, seat.y, seat.z);
    try { sh().setVehicleSeat(v.guid, cl.cell, cl.x, cl.y, cl.z, pose.heading); } catch (_) {}
    p.lastSeat = { x: seat.x, y: seat.y, z: seat.z, heading: pose.heading, t: wallNow };
    pushTrail(p.trail, seat, wallNow);

    const raw = p.controls.poll(dt, pose, v.params);
    const ctrl = p.controls.status();

    const camStep = p.camRig.step({
      seat,
      pose,
      params: v.params,
      controlsStatus: ctrl,
      dt,
      seatIndex: p.seat,
      firing: false,
      camTweak,
      hitchedTrailerKind: v._coupledTrailerKind ?? null,
      vehicleClass: v.profile?.vehicleClass,
      profileKey: v.profile?.profileKey,
    });
    p.view = camStep.view;
    if (p.camera && p.camera.owned) {
      p.camera.write(camStep.cam);
    }

    const hitchedGuid = currentHitchedTrailerGuid(v);
    const q = FM.orientation(pose.heading, pose.pitch, pose.bank);
    const firstPerson = p.view === "cockpit" || p.view === "hood";
    const composite = drawVehicle(v, pose, q, {
      dt,
      cockpit: firstPerson,
      hideWindscreen: p.view === "hood",
      speed: pose.speed,
      steerAngle: pose.steerAngle,
      groundFlags: paxGroundFlags,
      surfaceFamily: paxSurfFam,
      throttle: 0,
      headlights: Boolean(paxGroundFlags & 0x10),
      braking: Boolean(paxGroundFlags & 0x02),
      boost: Boolean(paxGroundFlags & 0x04),
      windscreenFolded: v.windscreenFolded ?? false,
      hitchedTrailerGuid: hitchedGuid,
      trailerPitch: v._coupledTrailerPitch ?? 0,
    });
    syncRigVisibility(p, v, firstPerson, composite);

    const maxSeats = maxSeatsOf(v);
    const kin = {
      steerAngle: pose.steerAngle || 0,
      speed: pose.speed || 0,
      accelLong: 0,
      accelLat: (pose.steerAngle || 0) * (pose.speed || 0),
      yawRate: 0,
      profile: v.profile,
    };

    for (let s = 0; s < maxSeats; s++) {
      const occ = v.seats[s] >>> 0;
      if (occ && v.profile) {
        const isLocal = occ === localGuid();
        const sPos = isLocal && p.hotSwap ? currentHotSwapSeat(v, pose, p.hotSwap) : seatOf(v, pose, s);
        if (!isLocal) {
          writeEntity(occ, sPos.x, sPos.y, sPos.z, sPos.q, true);
        } else {
          writeEntity(localGuid(), sPos.x, sPos.y, sPos.z, sPos.q);
        }
        const entityInst = em()?.entityMap?.get(occ);
        if (entityInst && isGround) {
          try { applySeatPoseToEntity(entityInst, s, pose, kin, dt); } catch (_) {}
        }
      }
    }

    osd.update({
      locomotion: 2,
      name: v.profile?.displayName,
      profileKey: v.profile?.profileKey,
      vehicleClass: v.profile?.vehicleClass,
      vMaxRoad: v.params?.vMaxRoad,
      speed: pose.speed,
      heading: pose.heading,
      seatIndex: p.seat,
      seats: v.seats,
      groundFlags: paxGroundFlags,
      surfaceFamily: paxSurfFam,
      boost: Boolean(paxGroundFlags & 0x04),
      headlights: Boolean(paxGroundFlags & 0x10),
      handbrake: Boolean(paxGroundFlags & 0x02),
      horn: Boolean(paxGroundFlags & 0x20),
      passenger: true,
      hitchedTrailerGuid: hitchedGuid,
      trailerKind: v._coupledTrailerKind,
      trailerFlags: v._coupledTrailerFlags ?? v.last?.trailerFlags ?? 0,
      twistlocksLocked: v._coupledTwistlocksLocked,
      trailerArticulationRad: v._coupledArticulationRad ?? 0,
    });

    try {
      groundAudio?.update({
        speed: pose.speed,
        throttle: 0,
        steer: 0,
        handbrake: Boolean(paxGroundFlags & 0x02),
        horn: Boolean(paxGroundFlags & 0x20),
        boost: Boolean(paxGroundFlags & 0x04),
        surfaceFamily: paxSurfFam,
        pos: [pose.x, pose.y, pose.z],
        fpv: p.view === "cockpit",
        vehicleClass: v.profile?.vehicleClass ?? 0,
        profileKey: v.profile?.profileKey ?? "",
        hitchedTrailerGuid: hitchedGuid,
        dt,
      });
    } catch (_) {}
  }

  /** The OSD's armament block from the profile and the last pilot state. */
  function armament(v, last) {
    const ws = v.profile?.weapons || [];
    if (!ws.length) return null;
    if (v._armProfile !== v.profile) {
      const ext = v.profile?.weaponExt || [];
      let guns = 0, rails = 0;
      const bombs = [];
      for (let i = 0; i < ws.length; i++) {
        if (ws[i].kind === 1) guns++;
        else if (ws[i].kind === 2) rails++;
        else if (ws[i].kind === 3) bombs.push(Math.round((ext[i]?.massKg ?? 0) * 2.20462 / 100) * 100 || "?");
      }
      v._armProfile = v.profile;
      v._armStatic = { guns, rails, bombs };
    }
    const { guns, rails, bombs } = v._armStatic;
    let missileMask = last?.missileMask, bombMask = last?.bombMask;
    // the pilot's own fired marks show at once (the server's mask follows within a state)
    for (const w of v.spent) {
      const { kind, ordinal } = kindOrdinal(v.profile, w);
      if (kind === 2 && Number.isFinite(missileMask)) missileMask &= ~(1 << ordinal);
      if (kind === 3 && Number.isFinite(bombMask)) bombMask &= ~(1 << ordinal);
    }
    return { guns, quarrels: last?.ammo ?? 0, rails, missileMask: missileMask ?? 0, bombs, bombMask: bombMask ?? 0 };
  }

  /** The next bomb station the server will release (its BombOrder: heaviest first, then left before right), or -1. */
  function nextBomb(v, last) {
    const ws = v.profile?.weapons || [];
    const bm = Number.isFinite(last?.bombMask) ? last.bombMask : -1;
    const key = `${bm}:${v.spent.size}`;
    if (v._nextBombProfile === v.profile && v._nextBombKey === key) return v._nextBombIdx;
    const ext = v.profile?.weaponExt || [];
    const cands = [];
    for (let i = 0; i < ws.length; i++) {
      if (ws[i].kind !== 3) continue;
      const { ordinal } = kindOrdinal(v.profile, i);
      const loaded = bm >= 0 ? ((bm >>> ordinal) & 1) === 1 : true;
      if (loaded && !v.spent.has(i)) cands.push(i);
    }
    cands.sort((a, b) => ((ext[b]?.massKg ?? 0) - (ext[a]?.massKg ?? 0)) || ((ws[a].muzzle?.[0] ?? 0) - (ws[b].muzzle?.[0] ?? 0)));
    v._nextBombProfile = v.profile;
    v._nextBombKey = key;
    v._nextBombIdx = cands.length ? cands[0] : -1;
    return v._nextBombIdx;
  }

  const _proj = THREE ? new THREE.Vector3() : null;
  /** AC world point → CSS px on the canvas, or null (behind the camera / no camera). */
  function project(pt, camera) {
    const cam = camera ?? live.camera;
    if (!_proj || !cam || !live.worldRoot) return null;
    try {
      cam.updateMatrixWorld?.();
      _proj.set(pt[0], pt[1], pt[2]).applyMatrix4(live.worldRoot.matrixWorld).project(cam);
      if (!(_proj.z > -1 && _proj.z < 1) || Math.abs(_proj.x) > 1.2 || Math.abs(_proj.y) > 1.2) return null;
      const el = live.renderer?.domElement;
      const w = el?.clientWidth || win.innerWidth || 0, h = el?.clientHeight || win.innerHeight || 0;
      return { x: (_proj.x * 0.5 + 0.5) * w, y: (-_proj.y * 0.5 + 0.5) * h };
    } catch (_) { return null; }
  }

  /** Gunsight at convergence, flight-path velocity vector (fpm), mouse-aim ring, and 20 Hz ballistic bomb pipper. */
  function tickSights(p, v, pose, q, t, ctrl = null, velVec = null) {
    const airborne = pose.mode === FM.MODE.FLIGHT || pose.mode === FM.MODE.LANDING;
    const ws = v.profile?.weapons || [];
    const cam = p.camera && p.camera.owned && typeof p.camera.camera === "function" ? p.camera.camera() : null;
    let ret = null, pip = null, fpm = null, aim = null, label = "";
    if (!airborne) p.pipper = null;
    if (airborne) {
      const g = ws.findIndex((w) => w.kind === 1);
      if (g >= 0 && cam) {
        const conv = v.profile?.weaponExt?.[g]?.convergence || 110;
        const m = ws[g].muzzle ?? [0, 0, 0];
        const r = FM.rotate(q, [0, m[1] + conv, m[2]]);
        ret = project([pose.x + r[0], pose.y + r[1], pose.z + r[2]], cam);
      }
      if (cam && velVec && pose.speed > 5) {
        const inv = 150 / Math.max(5, Math.hypot(velVec[0], velVec[1], velVec[2]));
        fpm = project([pose.x + velVec[0] * inv, pose.y + velVec[1] * inv, pose.z + velVec[2] * inv], cam);
      }
      if (cam && ctrl?.mouseAim && ctrl.aimWorld) {
        const ah = ctrl.aimWorld.heading ?? pose.heading;
        const ap = ctrl.aimWorld.pitch ?? pose.pitch;
        const cp = Math.cos(ap);
        aim = project([pose.x + Math.sin(ah) * cp * 150, pose.y + Math.cos(ah) * cp * 150, pose.z + Math.sin(ap) * 150], cam);
      }
      const b = nextBomb(v, p.lastServer);
      if (b >= 0) {
        if (!p.pipper || t - p.pipper.at >= PIPPER_SEC) {
          const m = ws[b].muzzle ?? [0, 0, 0];
          const r = FM.rotate(q, m);
          const vel = velVec ?? FM.velocity(pose, v.params);
          const start = { x: pose.x + r[0], y: pose.y + r[1], z: pose.z + r[2], vx: vel[0], vy: vel[1], vz: vel[2] - BOMB_EJECT,
            terminal: v.profile?.weaponExt?.[b]?.dragTerminal || 280 };
          const hit = predictImpact(start, ground);
          const lb = Math.round((v.profile?.weaponExt?.[b]?.massKg ?? 0) * 2.20462 / 100) * 100;
          p.pipper = { at: t, hit, label: hit ? `${lb} lb  ${hit.t.toFixed(1)} s` : "" };
        }
        if (p.pipper.hit && cam) { pip = project([p.pipper.hit.x, p.pipper.hit.y, p.pipper.hit.z], cam); label = p.pipper.label; }
      } else p.pipper = null;
    }
    osd.sights(ret, pip, label, { fpm, aim });
  }

  /** Exit hop: the rig goes from the seat down to where the entity tick now places the body (the server's exit spot). */
  function tickExitHop(dt) {
    const h = exitHop;
    const inst = em()?.entityMap?.get(localGuid());
    if (!inst || !inst.root) { exitHop = null; return; }
    h.t += dt;
    const u = h.t / h.dur;
    if (u >= 1) { exitHop = null; return; } // the entity tick owns the rig again
    const r = inst.root.position;
    // a hop only bridges the seat → exit spot beside the vehicle; anything farther (a teleport, a missed bail) snaps
    if (Math.hypot(r.x - h.from.x, r.y - h.from.y, r.z - h.from.z) > 30) { exitHop = null; return; }
    const at = hopPoint(h.from, { x: r.x, y: r.y, z: r.z }, u, HOP.arcM);
    const hq = inst.root.quaternion;
    writeEntity(localGuid(), at.x, at.y, at.z, FM.orientation(hopHeading(h.h, headingOfQuat([hq.w, hq.x, hq.y, hq.z]), u), 0, 0));
  }

  // ---------------------------------------------------------------- observers + board prompt

  let frameDt = 1 / 60;
  const _obsAudioList = [];
  const _groundObsAudioList = [];
  function tickObservers() {
    const t = nowSec();
    _obsAudioList.length = 0;
    _groundObsAudioList.length = 0;
    for (const v of vehicles.values()) {
      if ((pilot && pilot.vehicle === v) || (passenger && passenger.vehicle === v)) continue;
      if (!v.track.count && !v.reckon) continue;
      const pose = observedPose(v, t);
      if (!pose) continue;
      const isGround = isGroundVehicle(v);
      const obsGroundFlags = v.last?.groundFlags ?? v.last?.ground_flags ?? 0;
      const obsSurfFam = pose.surfaceFamily ?? v.last?.surfaceFamily ?? v.last?.surface_family ?? 0;
      if (isGround) {
        syncTractorCoupledTrailer(v, pose, frameDt, false, { braking: Boolean(obsGroundFlags & 0x02) });
      }
      const q = FM.orientation(pose.heading, pose.pitch, pose.bank);
      drawVehicle(v, pose, q, {
        dt: frameDt,
        throttle: pose.mode === FM.MODE.PARKED ? 0 : undefined,
        groundFlags: obsGroundFlags,
        surfaceFamily: obsSurfFam,
        hitchedTrailerGuid: currentHitchedTrailerGuid(v),
        trailerPitch: v._coupledTrailerPitch ?? 0,
      });
      if (isGround) {
        if (groundAudio) {
          _groundObsAudioList.push({
            id: v.guid,
            pos: [pose.x, pose.y, pose.z],
            vel: v.params ? FM.velocity(pose, v.params) : [0, 0, 0],
            speed: pose.speed ?? 0,
            mode: pose.mode,
            throttle: pose.mode === FM.MODE.PARKED ? 0 : 0.72,
            rpm: pose.rpm ?? (pose.mode === FM.MODE.PARKED ? 600 : 1800),
            gear: pose.gear ?? 1,
            surface: obsSurfFam,
            vehicleClass: v.profile?.vehicleClass ?? 0,
            profileKey: v.profile?.profileKey ?? "",
          });
        }
      } else {
        if (vehicleAudio) {
          _obsAudioList.push({
            id: v.guid,
            pos: [pose.x, pose.y, pose.z],
            vel: v.params ? FM.velocity(pose, v.params) : [0, 0, 0],
            speed: pose.speed,
            mode: pose.mode,
            throttle: pose.mode === FM.MODE.PARKED ? 0 : 0.72,
          });
        }
      }
      const maxSeats = maxSeatsOf(v);
      const obsSteer = pose.steerAngle ?? 0;
      const obsSpeed = pose.speed ?? 0;
      const kin = {
        speed: obsSpeed,
        steerAngle: obsSteer,
        lateralG: pose.lateralG ?? 0,
        accelLat: pose.accelLat ?? (obsSteer * obsSpeed),
        accelLong: pose.accelLong ?? ((obsGroundFlags & 0x02) && obsSpeed > 1.0 ? -8.5 : 0),
        bumpZ: pose.suspensionCompression ? (pose.suspensionCompression[0] || 0) : 0,
        profile: v.profile,
      };
      for (let s = 0; s < maxSeats; s++) {
        const occ = v.seats[s] >>> 0;
        if (occ && occ !== localGuid() && v.profile) {
          const seat = seatOf(v, pose, s);
          writeEntity(occ, seat.x, seat.y, seat.z, seat.q, true);
          if (isGround) {
            const inst = em()?.entityMap?.get(occ);
            if (inst) {
              try { applySeatPoseToEntity(inst, s, pose, kin, frameDt); } catch (_) {}
            }
          }
        }
      }
    }
    try {
      vehicleAudio?.updateObservers(_obsAudioList, listenerAcPos(), listenerAcVel(), frameDt);
    } catch (_) { /* observer audio never breaks world tick */ }
    try {
      groundAudio?.updateObservers(_groundObsAudioList, listenerAcPos(), listenerAcVel(), frameDt);
    } catch (_) { /* observer audio never breaks world tick */ }
  }

  // A vehicle we stopped tracking (out of sight, or the server deleted it from our view) never gets its despawn event:
  // drop it once its entity is gone AND no state has arrived for 5 s (states come at 10 Hz while the server tracks it
  // for us; the entity alone is not enough — the client may cull a far entity the server still sends).
  function pruneLogisticsEntries(map, t, immediate = false) {
    if (!map) return;
    for (const [g, entry] of [...trailers]) {
      if (entry.localOnly || !entry.seenInEm || map.has(g)) continue;
      const ct = entry.coupledTractorGuid >>> 0;
      if (ct && ((pilot && (pilot.vehicle.guid >>> 0) === ct) || (passenger && (passenger.vehicle.guid >>> 0) === ct))) continue;
      if (!immediate && t - (entry.lastMsgAt ?? entry.lastSeenAt ?? 0) < 5) continue;
      removeTrailerEntry(g);
    }
    for (const [g, entry] of [...containers]) {
      if (entry.localOnly || !entry.seenInEm || map.has(g)) continue;
      if ((entry.mountedOnTrailerGuid && trailers.has(entry.mountedOnTrailerGuid >>> 0)) || findClaimingTrailer(g)) continue;
      if (!immediate && t - (entry.lastMsgAt ?? entry.lastSeenAt ?? 0) < 5) continue;
      removeContainerEntry(g);
    }
    for (const [g, entry] of [...deployables]) {
      if (entry.localOnly || !entry.seenInEm || map.has(g)) continue;
      if (!immediate && t - (entry.lastMsgAt ?? entry.lastSeenAt ?? 0) < 5) continue;
      removeDeployableEntry(g);
    }
    for (const [g, entry] of [...palletJacks]) {
      if (entry.localOnly || !entry.seenInEm || map.has(g)) continue;
      if (palletJackController?.activeGuid === g) continue;
      if (entry.stowedOnTrailerGuid && trailers.has(entry.stowedOnTrailerGuid >>> 0)) continue;
      if (!immediate && t - (entry.lastMsgAt ?? entry.lastSeenAt ?? 0) < 5) continue;
      removePalletJackEntry(g);
    }
  }

  let lastPrune = 0;
  function pruneVehicles() {
    const t = nowSec();
    if (t - lastPrune < 1) return;
    lastPrune = t;
    const map = em()?.entityMap;
    if (!map) return;
    const me = localGuid();
    for (const [guid, v] of vehicles) {
      if (pilot && pilot.vehicle === v) continue;
      if (passenger && passenger.vehicle === v) continue;
      if (pendingBoard?.guid === guid) continue;
      if (me && v.seats.some((occ) => (occ >>> 0) === me)) continue;
      if (map.has(guid) || t - (v.lastMsgAt ?? 0) < 5) continue;
      forgetVehicle(v);
      vehicles.delete(guid);
      stats.pruned++;
    }
    pruneLogisticsEntries(map, t, false);
  }

  const SEAT_LABELS = Object.freeze(["Driver", "Front Passenger", "Rear Left", "Rear Right"]);

  function firstOpenSeat(v) {
    if (!v || !v.seats) return -1;
    const max = maxSeatsOf(v);
    for (let s = 0; s < max; s++) {
      if (!(v.seats[s] >>> 0)) return s;
    }
    return -1;
  }

  function seatOccupancyCount(v) {
    if (!v || !v.seats) return 0;
    const max = maxSeatsOf(v);
    let count = 0;
    for (let s = 0; s < max; s++) {
      if (v.seats[s] >>> 0) count++;
    }
    return count;
  }

  function nearestBoardable() {
    const me = localGuid();
    const inst = em()?.entityMap?.get(me);
    if (!inst || !inst.root) return null;
    const px = inst.root.position.x, py = inst.root.position.y, pz = inst.root.position.z;
    let best = null;
    let bestD = BOARD_RANGE_M;
    for (const v of vehicles.values()) {
      if (!v.profile || !v.last) continue;
      const isGround = isGroundVehicle(v);
      if (isGround) {
        const speed = v.last.speed ?? 0;
        const validMovement = (v.last.mode === FM.MODE.PARKED) || (speed <= 1.5);
        if (!validMovement) continue;
        if (firstOpenSeat(v) < 0) continue;
      } else {
        if (v.last.mode !== FM.MODE.PARKED || (v.seats[0] >>> 0)) continue;
      }
      const s = stateFromMsg(v.last);
      const d = Math.hypot(s.x - px, s.y - py, s.z - pz);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  function localPlayerPos() {
    try {
      const pp = sh()?.getLocalPlayerPose?.();
      if (pp && (pp.landblockId >>> 0) !== 0) {
        const g = FM.toGlobal(pp.landblockId >>> 0, pp.x, pp.y, pp.z);
        try { pp.free?.(); } catch (_) {}
        return g;
      }
      try { pp?.free?.(); } catch (_) {}
    } catch (_) {}
    const me = localGuid();
    const inst = em()?.entityMap?.get(me);
    if (inst?.root?.position) {
      return [inst.root.position.x, inst.root.position.y, inst.root.position.z];
    }
    return null;
  }

  function nearestSidelifter(maxDistM = 12.0) {
    const p = localPlayerPos();
    if (!p) return null;
    let best = null;
    let bestD = maxDistM;
    for (const tr of trailers.values()) {
      if (!tr.isSidelifter) continue;
      const tp = tr.renderedPose ?? {
        x: tr.worldPos[0], y: tr.worldPos[1], z: tr.worldPos[2],
        heading: tr.heading || 0,
      };
      const d = Math.hypot(tp.x - p[0], tp.y - p[1], tp.z - p[2]);
      if (d <= bestD) {
        bestD = d;
        best = tr;
      }
    }
    return best;
  }

  function nearestGroundedContainer(maxDistM = 4.0) {
    const p = localPlayerPos();
    if (!p) return null;
    let best = null;
    let bestObb = maxDistM;
    let bestCenter = Infinity;
    for (const cEntry of containers.values()) {
      if (cEntry.mountedOnTrailerGuid) continue;
      const rp = cEntry.model?.root?.position;
      const cx = rp ? rp.x : (cEntry.rawPos?.[0] ?? 0);
      const cy = rp ? rp.y : (cEntry.rawPos?.[1] ?? 0);
      const cz = rp ? rp.z : (cEntry.rawPos?.[2] ?? 0);
      const spec = CL.resolveContainerLogisticsSpec(cEntry.kind);
      const halfW = spec?.interior?.halfW ?? 1.176;
      const halfL = spec?.interior?.halfL ?? 2.949;
      const rampLen = 0.85;
      const h = cEntry.heading || 0;
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      const cosH = Math.cos(h);
      const sinH = Math.sin(h);
      const lx = dx * cosH - dy * sinH;
      const ly = dx * sinH + dy * cosH;
      const dxBox = Math.max(0, Math.abs(lx) - halfW);
      const dyBox = ly < -(halfL + rampLen)
        ? -(halfL + rampLen) - ly
        : (ly > halfL ? ly - halfL : 0);
      const dzBox = Math.max(0, Math.abs(cz - p[2]) - 1.5);
      const dObb = Math.hypot(dxBox, dyBox, dzBox);
      const dCenter = Math.hypot(cx - p[0], cy - p[1], cz - p[2]);
      if (dObb < bestObb - 1e-6 || (Math.abs(dObb - bestObb) <= 1e-6 && dObb <= maxDistM && dCenter < bestCenter)) {
        bestObb = dObb;
        bestCenter = dCenter;
        best = cEntry;
      }
    }
    return best;
  }

  function nearestGroundDeployable(maxDistM = 3.5) {
    const p = localPlayerPos();
    if (!p) return null;
    let best = null;
    let bestD = maxDistM;
    for (const dEntry of deployables.values()) {
      const rp = dEntry?.model?.root?.position;
      if (!rp) continue;
      const d = Math.hypot(rp.x - p[0], rp.y - p[1], rp.z - p[2]);
      if (d <= bestD) {
        bestD = d;
        best = dEntry;
      }
    }
    return best;
  }

  function nearestPalletJack(maxDistM = 3.0) {
    const p = localPlayerPos();
    if (!p) return null;
    let best = null;
    let bestD = maxDistM;
    for (const pj of palletJacks.values()) {
      if (pj.stowedOnTrailerGuid !== 0 || (pj.flags & 0x04)) continue;
      if (pj.operatorGuid !== 0) continue;
      const wp = pj.worldPos || [0, 0, 0];
      const d = Math.hypot(wp[0] - p[0], wp[1] - p[1], wp[2] - p[2]);
      if (d <= bestD) {
        bestD = d;
        best = pj;
      }
    }
    return best;
  }

  function tickPrompt() {
    if (promptTimer) return; // a transient prompt is showing
    // never while falling / in the bail hand-off / walking a pallet jack
    if (pilot || passenger || fall || handoff || palletJackController?.isActive?.() || caps.granted === null || !(caps.granted & CAP_PILOT)) {
      if (promptVehicle || promptText) { promptVehicle = null; promptText = null; osd.prompt(null); }
      return;
    }
    const v = nearestBoardable();
    const pj = nearestPalletJack(3.0);
    const sl = nearestSidelifter(12.0);
    const cont = nearestGroundedContainer(4.0);
    const dep = nearestGroundDeployable(3.5);

    const parts = [];
    if (pj) {
      parts.push("[B] Grab Pallet Jack");
    } else if (v) {
      const isGround = isGroundVehicle(v);
      if (isGround) {
        const s = firstOpenSeat(v);
        const seatLabel = isSemiVehicle(v) && s === 1 ? "Co-Driver" : (SEAT_LABELS[s] ?? `Seat ${s}`);
        const occ = seatOccupancyCount(v);
        const maxSeats = maxSeatsOf(v);
        parts.push(`Press B to board ${v.profile.displayName} — ${seatLabel} (${occ}/${maxSeats} occupied)`);
      } else {
        parts.push(`Press B to board the ${v.profile.displayName}`);
      }
    }
    if (sl) {
      const outPlanted = Boolean((sl.sideliftFlags & 0x02) || sl.sideliftPhase >= 2);
      const hasJack = Boolean((sl.sideliftFlags & 0x08) || sl.stowedPalletJackGuid);
      const hasMounted = (sl.mountedContainerGuid >>> 0) !== 0;
      parts.push(`[J] ${outPlanted ? "Retract" : "Deploy"} Outriggers · [K] Twistlocks · [L] ${hasMounted ? "Offload" : "Load"} · [Shift+L] Auto · [U] ${hasJack ? "Deploy" : "Stow"} Jack`);
    }
    if (cont) {
      const isOpen = cont.currentDoorProgress >= 0.5;
      parts.push(`[E] ${isOpen ? "Close" : "Open"} Container Doors`);
    }
    if (dep) {
      const stowed = Boolean((dep.last?.onlineFlags ?? 0) & 0x10);
      parts.push(`[R] ${stowed ? "Unstow" : "Stow"} Deployable`);
    }

    const text = parts.length > 0 ? parts.join(" | ") : null;
    if (!text) {
      if (promptVehicle || promptText) {
        promptVehicle = null;
        promptText = null;
        osd.prompt(null);
      }
      return;
    }
    if (v !== promptVehicle || text !== promptText) {
      promptVehicle = v;
      promptText = text;
      osd.prompt(text);
    }
  }

  const onLogisticsKeyDown = (ev) => {
    if (!ev || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (isTypingTarget(ev, win.document) || inOpenModal(ev, win.document, win)) return;
    if (pilot || passenger || fall || handoff || palletJackController?.isActive?.()) return;
    if (caps.granted !== null && !(caps.granted & CAP_PILOT)) return;

    const code = ev.code;
    const h = sh();

    if (code === "KeyB") {
      const pj = nearestPalletJack(3.0);
      if (pj) {
        ev.preventDefault?.();
        ev.stopImmediatePropagation?.();
        try { live.audioManager?.notifyUserGesture?.(); } catch (_) {}
        const cl = FM.toCellLocal(pj.worldPos[0], pj.worldPos[1], pj.worldPos[2]);
        try {
          h?.vehiclePalletJackAction?.(
            pj.guid, PALLET_JACK_ACTION.Grab, 0, 0, 0, 0,
            cl.cell, cl.x, cl.y, cl.z, pj.heading || 0, pj.tillerAngle || 0
          );
        } catch (_) {}
        return;
      }
      const v = nearestBoardable();
      if (v) {
        ev.preventDefault?.();
        ev.stopImmediatePropagation?.();
        try { live.audioManager?.notifyUserGesture?.(); } catch (_) {}
        const isGround = isGroundVehicle(v);
        const targetSeat = isGround ? firstOpenSeat(v) : 0;
        if (targetSeat >= 0) api.board(v.guid, targetSeat);
      }
      return;
    }

    if (code === "KeyJ" || code === "KeyK" || code === "KeyL" || code === "KeyU") {
      const sl = nearestSidelifter(12.0);
      if (!sl) return;
      ev.preventDefault?.();
      ev.stopImmediatePropagation?.();
      try { live.audioManager?.notifyUserGesture?.(); } catch (_) {}
      const sideFlags = 0x02; // auto-detect side on load; server defaults/preserves active side on outriggers/offload
      if (code === "KeyJ") {
        const planted = Boolean((sl.sideliftFlags & 0x02) || (sl.sideliftPhase >= 2 && sl.sideliftPhase <= 9));
        const act = planted ? TRAILER_ACTION.RetractOutriggers : TRAILER_ACTION.DeployOutriggers;
        try { h?.vehicleTrailerAction?.(sl.guid, 0, 0, act, 0, sideFlags); } catch (_) {}
      } else if (code === "KeyK") {
        try { h?.vehicleTrailerAction?.(sl.guid, 0, 0, TRAILER_ACTION.ToggleTwistlock, 0, 0); } catch (_) {}
      } else if (code === "KeyL") {
        const hasMounted = (sl.mountedContainerGuid >>> 0) !== 0;
        const act = ev.shiftKey
          ? (hasMounted ? TRAILER_ACTION.AutoOffload : TRAILER_ACTION.AutoLoad)
          : (hasMounted ? TRAILER_ACTION.SideliftOffload : TRAILER_ACTION.SideliftLoad);
        try { h?.vehicleTrailerAction?.(sl.guid, 0, 0, act, 0, sideFlags); } catch (_) {}
      } else if (code === "KeyU") {
        const hasJack = Boolean((sl.sideliftFlags & 0x08) || sl.stowedPalletJackGuid);
        const act = hasJack ? TRAILER_ACTION.DeployPalletJack : TRAILER_ACTION.StowPalletJack;
        try { h?.vehicleTrailerAction?.(sl.guid, 0, sl.stowedPalletJackGuid || 0, act, 0, 0); } catch (_) {}
      }
      return;
    }

    if (code === "KeyE") {
      const cont = nearestGroundedContainer(4.0);
      if (!cont) return;
      ev.preventDefault?.();
      ev.stopImmediatePropagation?.();
      try { live.audioManager?.notifyUserGesture?.(); } catch (_) {}
      const isOpen = cont.currentDoorProgress >= 0.5 || cont.last?.doorState === 2;
      const doorAction = isOpen ? 2 : 1; // 1 = OpenDoors, 2 = CloseDoors
      try { h?.vehicleContainerAction?.(cont.guid, doorAction, 0, 0, 0); } catch (_) {}
      return;
    }

    if (code === "KeyR") {
      const dep = nearestGroundDeployable(3.5);
      if (!dep) return;
      ev.preventDefault?.();
      ev.stopImmediatePropagation?.();
      try { live.audioManager?.notifyUserGesture?.(); } catch (_) {}
      const p = dep.model?.root?.position;
      const cl = p ? FM.toCellLocal(p.x, p.y, p.z) : { cell: 0, x: 0, y: 0, z: 0 };
      try {
        h?.vehiclePalletJackAction?.(
          0, PALLET_JACK_ACTION.ToggleDeployableStow, 0, 0, 0, dep.guid,
          cl.cell, cl.x, cl.y, cl.z, 0, 0
        );
      } catch (_) {}
    }
  };
  win.addEventListener("keydown", onLogisticsKeyDown, true);

  // ---------------------------------------------------------------- frame hook

  function afterTick(ts, dtMs) {
    if (disposed) return;
    if (isSessionLost()) {
      teardownSession("disconnect");
      return;
    }
    const dt = Number.isFinite(dtMs) ? (dtMs > 5 ? dtMs / 1000 : dtMs) : 1 / 60;
    frameDt = dt;
    stats.frames++;
    handshake();
    drainInbox();
    if (pilot) tickPilot(dt);
    else if (passenger) tickPassenger(dt);
    else if (palletJackController?.isActive?.()) palletJackController.tick(dt);
    else if (fall) tickFall();
    else if (handoff) tickHandoff(dt);
    else if (exitHop) tickExitHop(dt);
    tickObservers();
    fallPose?.tick(dt, nowSec()); // after the rig writes, before the canopies (they read the riser grips)
    pruneVehicles();
    tickPrompt();
    fx.tick(dt);
    tickDeployables(dt);
    tickTrailers(dt);
    tickContainers(dt);
    tickPalletJacks(dt);
    try { warehouseManager?.tick?.(dt, listenerAcPos()); } catch (_) {}
    try { portTerminalManager?.tick?.(dt, listenerAcPos()); } catch (_) {}
    try { shipManager?.tick?.(dt, listenerAcPos()); } catch (_) {}
    aeroFx?.tick(dt);
    if (!pilot && !passenger) osd.sights(null, null, "");
    chutes?.tick(dt, chutePose);
  }

  /**
   * The body under a canopy: the local fall twin while we fall, else the entity rig (observed players, landing); with
   * the rig's root scale (the heritage's CharGen scale) and, under the canopy pose, the riser grips (fall_pose.js).
   */
  function chutePose(guid) {
    const inst = em()?.entityMap?.get(guid >>> 0);
    const scale = inst?.root?.scale?.x ?? 1;
    const risers = fallPose ? fallPose.risers(guid) : null;
    if (fall && guid === localGuid()) return { x: fall.rx, y: fall.ry, z: fall.rz, heading: fall.heading, scale, risers };
    if (!inst || !inst.root) return null;
    const r = inst.root, q = r.quaternion;
    return { x: r.position.x, y: r.position.y, z: r.position.z, heading: headingOfQuat([q.w, q.x, q.y, q.z]), scale, risers };
  }

  live.vehicles = { afterTick, onTeleport, beforeMovement };

  // ---------------------------------------------------------------- debug / bench API

  const api = {
    version: 1,
    status() {
      let wire = null;
      try { wire = JSON.parse(sh()?.vehicleWireStats?.() ?? "null"); } catch (_) {}
      return {
        caps: { granted: caps.granted, tries: caps.tries },
        stats: { ...stats },
        vehicles: [...vehicles.values()].map((v) => ({
          guid: v.guid, key: v.profile?.profileKey ?? null, seats: v.seats.slice(), mode: v.last?.mode ?? null,
          speed: v.last?.speed ?? null, cell: v.last?.cell ?? null, step: v.last?.step ?? null,
          pos: v.last ? stateFromMsg(v.last) : null,
          ammo: v.last?.ammo ?? null, missileMask: v.last?.missileMask ?? null, bombMask: v.last?.bombMask ?? null,
          airframe: airframes ? airframes.status(v.profile) : "off", standInHidden: !!v.standInHidden,
        })),
        fall: fall ? { x: fall.x, y: fall.y, z: fall.z, vz: fall.vz, chute: fall.chute, agl: fall.z - ground(fall.x, fall.y), sec: nowSec() - fall.startedAt, maxSec: fall.maxSec,
          handoffMs: fall.handoffMs, offsetM: fall.off ? Math.hypot(fall.off[0], fall.off[1], fall.off[2]) : 0, camBlend: !!fall.camBlend } : null,
        handoff: handoff ? { vehicle: handoff.v.guid, ms: Math.round((nowSec() - handoff.startedAt) * 1000), camera: !!handoff.camera } : null,
        fallPose: fallPose ? fallPose.status() : { enabled: false },
        pilot: pilot ? {
          vehicle: pilot.vehicle.guid, seat: pilot.seat, view: pilot.view, gLoad: pilot.gLoad ?? 1.0, sent: pilot.sent,
          state: pilot.predictor ? { ...pilot.predictor.state } : null,
          seq: pilot.predictor?.seq ?? null, vCap: pilot.predictor?.vCap ?? null,
          predictor: pilot.predictor?.stats() ?? null, controls: pilot.controls.status(),
          server: pilot.lastServer ? { step: pilot.lastServer.step, ack: pilot.lastServer.ack, mode: pilot.lastServer.mode, speed: pilot.lastServer.speed } : null,
        } : null,
        passenger: passenger ? {
          vehicle: passenger.vehicle.guid, seat: passenger.seat, view: passenger.view,
          controls: passenger.controls?.status?.() ?? null,
        } : null,
        wire,
        weapons: fx.stats(),
        tracers: (() => { const w = fx.stats(); return { live: w.liveQuarrels, added: w.quarrels }; })(),
        airframes: airframes ? airframes.stats() : { enabled: false },
        groundFx: groundFx ? (typeof groundFx.stats === "function" ? groundFx.stats() : { enabled: true, activeParticles: groundFx.getActiveCount?.() ?? 0 }) : { enabled: false },
        groundAudio: groundAudio ? groundAudio.stats : { enabled: false },
        groundModels: groundModels.size,
        aeroFx: aeroFx ? aeroFx.stats() : { enabled: false },
        audio: vehicleAudio ? vehicleAudio.stats() : { enabled: false },
        chutes: chutes ? chutes.stats() : null,
      };
    },
    vehicles: () => [...vehicles.values()],
    /** Allocation-free membership test (entities.js: the flight entity horizon never culls a vehicle). */
    isVehicle: (guid) => vehicles.has(guid >>> 0),
    events: () => events.slice(),
    nearest: () => nearestBoardable()?.guid ?? null,
    board(guid, seatIndex) {
      if (pilot || passenger || fall || handoff || palletJackController?.isActive?.()) return { ok: false, reason: "busy" };
      const v = guid ? vehicles.get(guid >>> 0) : nearestBoardable();
      const g = (v?.guid ?? (guid >>> 0) ?? [...vehicles.keys()][0]) >>> 0;
      if (!g) return { ok: false, reason: "no vehicle" };
      const veh = vehicles.get(g);
      const isGround = isGroundVehicle(veh);
      const s = Number.isInteger(seatIndex) && seatIndex >= 0
        ? seatIndex
        : (isGround && veh ? Math.max(0, firstOpenSeat(veh)) : 0);
      pendingBoard = { guid: g, seat: s, t: nowSec() };
      try { sh().vehicleBoard(g, s); } catch (e) { return { ok: false, reason: String(e) }; }
      return { ok: true, guid: g, seat: s };
    },
    exit(mode) {
      if (passenger) {
        requestPassengerExit(mode);
        return { ok: true, role: "passenger" };
      }
      requestExit(mode);
      return { ok: !!pilot, role: "pilot" };
    },
    /** Bench: drive the analog input (throttle, pitch, roll, yaw, boost, fire, land) for `ms`. */
    setSticks(axes, ms) { if (!pilot) return false; pilot.controls.setOverride(axes, ms); return true; },
    clearSticks() { pilot?.controls.clearOverride(); },
    setView(view) {
      const s = pilot || passenger;
      if (s) {
        const next = VIEW_MODES.includes(view) ? view : "chase";
        s.view = s.camRig ? s.camRig.setView(next) : next;
        s.camHeading = null;
        s.camPitch = null;
        s.camRoll = null;
        s.camLift = 0;
      }
    },
    setMouseAim(on) {
      if (!pilot) return false;
      pilot.controls.setMouseAim(!!on, pilot.predictor?.state ?? null);
      return pilot.controls.mouseAim;
    },
    corrections: () => pilot?.predictor?.corrections() ?? [],
    /** Bench / film: orbit the chase camera ({yaw, back, up}; null = the default chase framing). */
    setCameraTweak(t) { camTweak = t && typeof t === "object" ? { ...t } : null; return true; },
    /** The bomb pipper's solution for the next station: {x, y, z, t} (AC world, seconds to impact), or null. */
    pipper: () => (pilot?.pipper?.hit ? { ...pilot.pipper.hit } : null),
    /** Bench / debug: draw an explosion (lb) at an AC world point (client-side only). */
    debugExplode(at, lb = 2000) { fx.debugExplode(at, lb); return true; },
    spawn(profile) { try { sh().sendChat(`@vehicle spawn ${profile ?? ""}`.trim()); return true; } catch (_) { return false; } },
    despawn(all) { try { sh().sendChat(all ? "@vehicle despawn all" : "@vehicle despawn"); return true; } catch (_) { return false; } },
    get piloting() { return !!pilot; },
    get riding() { return !!passenger; },
    get passenger() { return !!passenger; },
    get falling() { return !!fall; },
    get groundModels() { return groundModels; },
    get groundFx() { return groundFx; },
    get groundAudio() { return groundAudio; },
    openChute() { if (fall) { try { sh().vehicleExit(fall.vehicle, 2); } catch (_) {} return true; } return false; },
    deployables: {
      list: () => [...deployables.values()].map((d) => ({
        guid: d.guid, wcid: d.wcid,
        pos: [d.model.root.position.x, d.model.root.position.y, d.model.root.position.z],
        last: d.last,
      })),
      spawnLocal(guid, wcidOrKind, worldPos, heading = 0, state = {}) {
        const entry = ensureDeployableEntry(guid, wcidOrKind);
        if (!entry) return null;
        entry.localOnly = true;
        entry.model.root.position.set(worldPos[0], worldPos[1], worldPos[2]);
        entry.model.root.rotation.z = -heading;
        entry.last = { ...state };
        return entry;
      },
      spawnJeepLocal(guid, worldPos, heading = 0, cargoState = {}) {
        if (!THREE || !live?.worldRoot) return null;
        let j = jeepModels.get(guid >>> 0);
        if (!j) {
          j = buildProceduralJeep(THREE, {}, { liveScene3d: live });
          live.worldRoot.add(j.root);
          jeepModels.set(guid >>> 0, j);
        }
        j.root.position.set(worldPos[0], worldPos[1], worldPos[2]);
        j.root.rotation.z = -heading;
        j.update(cargoState);
        return j;
      },
      fireLocal(weaponKind, muzzle, targetPos, velocity) {
        deployableVfx?.handleFireEvent({ weaponKind, muzzle, targetPos, velocity });
      },
      setContacts({ air = [], ground = [] } = {}) {
        latestAirContacts = air;
        latestGroundContacts = ground;
      },
      vfx: deployableVfx,
      scope: radarScope,
    },
    containers: {
      list: () => [...containers.values()].map((c) => ({
        guid: c.guid,
        kind: c.kind,
        pos: [c.model.root.position.x, c.model.root.position.y, c.model.root.position.z],
        doorProgress: c.currentDoorProgress,
        targetDoorProgress: c.targetDoorProgress,
        doorOpen: c.currentDoorProgress >= 0.5,
        last: c.last,
      })),
      get: (guid) => containers.get(guid >>> 0) ?? null,
      spawnLocal(guid, kind, worldPos, heading = 0, state = {}) {
        const entry = ensureContainerEntry(guid, kind, { ...state, cell: 0, position: worldPos, heading });
        if (!entry) return null;
        entry.localOnly = true;
        entry.model.root.position.set(worldPos[0], worldPos[1], worldPos[2]);
        entry.model.root.rotation.z = -heading;
        entry.rawPos = [worldPos[0], worldPos[1], worldPos[2]];
        entry.heading = heading;
        entry.currentDoorProgress = state.doorProgress ?? (state.doorState === 2 ? 1.0 : 0.0);
        entry.targetDoorProgress = entry.currentDoorProgress;
        entry.last = { ...state };
        if (Array.isArray(entry.slots) && entry.slots.length > 0) {
          try { entry.model?.syncSlots?.(entry.slots); } catch (_) {}
        }
        const doorOpen = entry.currentDoorProgress >= 0.5;
        try {
          sh()?.upsertContainerCollider(guid >>> 0, 0, worldPos[0], worldPos[1], worldPos[2], heading, kind, doorOpen);
        } catch (_) {}
        try { requestShadowRaster(live.renderer, live); } catch (_) {}
        return entry;
      },
      removeLocal(guid) {
        removeContainerEntry(guid);
      },
      action(containerGuid, action, slotIndex = 0, subSlot = 0, cargoWcid = 0) {
        try {
          sh()?.vehicleContainerAction?.(containerGuid >>> 0, action, slotIndex, subSlot, cargoWcid);
          return true;
        } catch (_) {
          return false;
        }
      },
    },
    trailers: {
      list: () => [...trailers.values()].map((tr) => ({
        guid: tr.guid,
        kind: tr.specKind,
        wireKind: tr.kind,
        wcid: tr.wcid,
        isSidelifter: Boolean(tr.isSidelifter),
        pos: tr.model?.root?.position
          ? [tr.model.root.position.x, tr.model.root.position.y, tr.model.root.position.z]
          : tr.worldPos.slice(),
        heading: tr.renderedPose?.heading ?? tr.heading,
        pitch: tr.renderedPose?.pitch ?? tr.pitch,
        bank: tr.renderedPose?.bank ?? tr.bank,
        coupledTractorGuid: tr.coupledTractorGuid,
        mountedContainerGuid: tr.mountedContainerGuid,
        containerSlot: tr.containerSlot,
        twistlockLocked: Boolean(tr.trailerFlags & TRAILER_FLAG.TWISTLOCKS_LOCKED),
        landingGearRetracted: Boolean(tr.model?.landingGearRetracted ?? (tr.trailerFlags & TRAILER_FLAG.GEAR_RETRACTED)),
        brakeLights: Boolean(tr.model?.brakeLights ?? (tr.trailerFlags & TRAILER_FLAG.BRAKE_LIGHTS)),
        trailerFlags: tr.trailerFlags,
        sideliftPhase: tr.sideliftPhase ?? 0,
        sideliftSide: tr.sideliftSide ?? 1,
        sideliftFlags: tr.sideliftFlags ?? 0,
        sideliftProgress: tr.sideliftProgress ?? 0,
        outriggerProgress: tr.outriggerProgress ?? 0,
        craneSpanY: tr.craneSpanY ?? SK.CRANE_SPAN_Y_40FT,
        stowedPalletJackGuid: tr.stowedPalletJackGuid ?? 0,
        transferContainerGuid: tr.transferContainerGuid ?? 0,
        last: tr.last,
      })),
      get: (guid) => trailers.get(guid >>> 0) ?? null,
      hitch(trailerGuid = 0, vehicleGuid = 0) {
        const vGuid = (vehicleGuid >>> 0) || (pilot?.vehicle?.guid ?? 0);
        const v = vGuid ? vehicles.get(vGuid) : null;
        let tGuid = trailerGuid >>> 0;
        if (!tGuid && v) tGuid = findNearestUnhitchedTrailer(v, 3.5)?.guid ?? 0;
        try {
          sh()?.vehicleTrailerAction?.(tGuid, vGuid, 0, TRAILER_ACTION.Hitch, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      unhitch(trailerGuid = 0, vehicleGuid = 0) {
        const vGuid = (vehicleGuid >>> 0) || (pilot?.vehicle?.guid ?? 0);
        const v = vGuid ? vehicles.get(vGuid) : null;
        const tGuid = (trailerGuid >>> 0) || (v ? currentHitchedTrailerGuid(v) : 0);
        try {
          sh()?.vehicleTrailerAction?.(tGuid, vGuid, 0, TRAILER_ACTION.Unhitch, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      toggleTwistlock(trailerGuid = 0, vehicleGuid = 0) {
        const vGuid = (vehicleGuid >>> 0) || (pilot?.vehicle?.guid ?? 0);
        try {
          sh()?.vehicleTrailerAction?.(trailerGuid >>> 0, vGuid, 0, TRAILER_ACTION.ToggleTwistlock, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      mountContainer(trailerGuid, containerGuid, slot = 0) {
        try {
          sh()?.vehicleTrailerAction?.(trailerGuid >>> 0, 0, containerGuid >>> 0, TRAILER_ACTION.MountContainer, slot | 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      unmountContainer(trailerGuid, containerGuid = 0) {
        try {
          sh()?.vehicleTrailerAction?.(trailerGuid >>> 0, 0, containerGuid >>> 0, TRAILER_ACTION.UnmountContainer, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      action(trailerGuid, action, vehicleGuid = 0, containerGuid = 0, slot = 0, flags = 0) {
        try {
          sh()?.vehicleTrailerAction?.(trailerGuid >>> 0, vehicleGuid >>> 0, containerGuid >>> 0, action | 0, slot | 0, flags | 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      sidelift(trailerGuid, mode = "offload", side = "right") {
        const tGuid = trailerGuid >>> 0;
        const tr = trailers.get(tGuid);
        const m = typeof mode === "string" ? mode.trim().toLowerCase() : "";
        let act = TRAILER_ACTION.SideliftOffload;
        if (m === "load") act = TRAILER_ACTION.SideliftLoad;
        else if (m === "autooffload" || m === "auto_offload" || m === "auto-offload") act = TRAILER_ACTION.AutoOffload;
        else if (m === "autoload" || m === "auto_load" || m === "auto-load") act = TRAILER_ACTION.AutoLoad;
        else if (m === "auto") act = (tr && (tr.mountedContainerGuid >>> 0) !== 0) ? TRAILER_ACTION.AutoOffload : TRAILER_ACTION.AutoLoad;
        else if (m === "cancel") act = TRAILER_ACTION.CancelSidelift;
        const flags = (side === "auto" || side === 0 || side === 2)
          ? 0x02
          : ((side === "left" || side === -1) ? 0x01 : 0x00);
        try {
          const h = sh();
          if (!h || typeof h.vehicleTrailerAction !== "function") return false;
          h.vehicleTrailerAction(tGuid, 0, 0, act, 0, flags);
          return true;
        } catch (_) {
          return false;
        }
      },
      deployOutriggers(trailerGuid, side = "right") {
        const flags = (side === "auto" || side === 0 || side === 2)
          ? 0x02
          : ((side === "left" || side === -1) ? 0x01 : 0x00);
        try {
          const h = sh();
          if (!h || typeof h.vehicleTrailerAction !== "function") return false;
          h.vehicleTrailerAction(trailerGuid >>> 0, 0, 0, TRAILER_ACTION.DeployOutriggers, 0, flags);
          return true;
        } catch (_) {
          return false;
        }
      },
      retractOutriggers(trailerGuid) {
        try {
          const h = sh();
          if (!h || typeof h.vehicleTrailerAction !== "function") return false;
          h.vehicleTrailerAction(trailerGuid >>> 0, 0, 0, TRAILER_ACTION.RetractOutriggers, 0, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      deployPalletJack(trailerGuid) {
        try {
          const h = sh();
          if (!h || typeof h.vehicleTrailerAction !== "function") return false;
          h.vehicleTrailerAction(trailerGuid >>> 0, 0, 0, TRAILER_ACTION.DeployPalletJack, 0, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      stowPalletJack(trailerGuid, jackGuid = 0) {
        try {
          const h = sh();
          if (!h || typeof h.vehicleTrailerAction !== "function") return false;
          h.vehicleTrailerAction(trailerGuid >>> 0, 0, jackGuid >>> 0, TRAILER_ACTION.StowPalletJack, 0, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      spawnLocal(guid, kind = "40ft", worldPos = [0, 0, 0], heading = 0, state = {}) {
        const entry = ensureTrailerEntry(guid, kind, { ...state, cell: 0, position: worldPos, heading });
        if (!entry) return null;
        entry.localOnly = true;
        entry.worldPos = [worldPos[0], worldPos[1], worldPos[2]];
        entry.heading = heading;
        entry.model.root.position.set(worldPos[0], worldPos[1], worldPos[2]);
        entry.model.root.rotation.z = -heading;
        entry.model.update(0, state);
        entry.last = { ...state };
        return entry;
      },
      removeLocal(guid) {
        removeTrailerEntry(guid);
      },
    },
    palletJacks: {
      list: () => [...palletJacks.values()].map((pj) => ({
        guid: pj.guid,
        palletJackGuid: pj.guid,
        operatorGuid: pj.operatorGuid,
        stowedOnTrailerGuid: pj.stowedOnTrailerGuid,
        cell: pj.cell,
        pos: pj.model?.root?.position
          ? [pj.model.root.position.x, pj.model.root.position.y, pj.model.root.position.z]
          : pj.worldPos.slice(),
        rawPos: pj.rawPos ? pj.rawPos.slice() : [0, 0, 0],
        heading: pj.heading,
        tillerAngle: pj.tillerAngle,
        forkHeightM: pj.forkHeightM,
        forkState: pj.forkState,
        carriedPalletSize: pj.carriedPalletSize,
        flags: pj.flags,
        carriedWcid: pj.carriedWcid,
        ownerGuid: pj.ownerGuid,
        last: pj.last,
      })),
      get: (guid) => {
        const pj = palletJacks.get(guid >>> 0);
        if (!pj) return null;
        return {
          guid: pj.guid,
          palletJackGuid: pj.guid,
          operatorGuid: pj.operatorGuid,
          stowedOnTrailerGuid: pj.stowedOnTrailerGuid,
          cell: pj.cell,
          pos: pj.model?.root?.position
            ? [pj.model.root.position.x, pj.model.root.position.y, pj.model.root.position.z]
            : pj.worldPos.slice(),
          rawPos: pj.rawPos ? pj.rawPos.slice() : [0, 0, 0],
          heading: pj.heading,
          tillerAngle: pj.tillerAngle,
          forkHeightM: pj.forkHeightM,
          forkState: pj.forkState,
          carriedPalletSize: pj.carriedPalletSize,
          flags: pj.flags,
          carriedWcid: pj.carriedWcid,
          ownerGuid: pj.ownerGuid,
          last: pj.last,
          model: pj.model,
        };
      },
      grab(guid) {
        const g = guid >>> 0;
        const entry = palletJacks.get(g);
        if (!entry) return false;
        try {
          const h = sh();
          if (!h || typeof h.vehiclePalletJackAction !== "function") return false;
          const cl = FM.toCellLocal(entry.worldPos[0], entry.worldPos[1], entry.worldPos[2]);
          h.vehiclePalletJackAction(g, PALLET_JACK_ACTION.Grab, 0, 0, 0, 0, cl.cell, cl.x, cl.y, cl.z, entry.heading || 0, entry.tillerAngle || 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      release(guid = 0) {
        const g = (guid >>> 0) || (palletJackController?.activeGuid ?? 0);
        if (!g) return false;
        try {
          const h = sh();
          if (!h || typeof h.vehiclePalletJackAction !== "function") return false;
          const st = palletJackController?.state;
          const cl = st ? FM.toCellLocal(st.x, st.y, st.z) : { cell: 0, x: 0, y: 0, z: 0 };
          h.vehiclePalletJackAction(g, PALLET_JACK_ACTION.Release, 0, 0, 0, 0, cl.cell, cl.x, cl.y, cl.z, st?.heading ?? 0, st?.tillerAngle ?? 0);
          palletJackController?.stop?.("api-release");
          return true;
        } catch (_) {
          return false;
        }
      },
      raise(guid = 0) {
        const g = (guid >>> 0) || (palletJackController?.activeGuid ?? 0);
        if (!g || !palletJacks.has(g)) return false;
        try {
          const h = sh();
          if (!h || typeof h.vehiclePalletJackAction !== "function") return false;
          h.vehiclePalletJackAction(g, PALLET_JACK_ACTION.RaiseForks, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      lower(guid = 0) {
        const g = (guid >>> 0) || (palletJackController?.activeGuid ?? 0);
        if (!g || !palletJacks.has(g)) return false;
        try {
          const h = sh();
          if (!h || typeof h.vehiclePalletJackAction !== "function") return false;
          h.vehiclePalletJackAction(g, PALLET_JACK_ACTION.LowerForks, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      pickGround(deployableGuid, jackGuid = 0) {
        const g = (jackGuid >>> 0) || (palletJackController?.activeGuid ?? 0);
        if (!g || !palletJacks.has(g)) return false;
        try {
          const h = sh();
          if (!h || typeof h.vehiclePalletJackAction !== "function") return false;
          h.vehiclePalletJackAction(g, PALLET_JACK_ACTION.PickGroundDeployable, 0, 0, 0, deployableGuid >>> 0, 0, 0, 0, 0, 0, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      dropGround(jackGuid = 0) {
        const g = (jackGuid >>> 0) || (palletJackController?.activeGuid ?? 0);
        if (!g || !palletJacks.has(g)) return false;
        try {
          const h = sh();
          if (!h || typeof h.vehiclePalletJackAction !== "function") return false;
          const st = palletJackController?.state;
          const cl = st ? FM.toCellLocal(st.x, st.y, st.z) : { cell: 0, x: 0, y: 0, z: 0 };
          h.vehiclePalletJackAction(g, PALLET_JACK_ACTION.DropToGround, 0, 0, 0, 0, cl.cell, cl.x, cl.y, cl.z, st?.heading ?? 0, st?.tillerAngle ?? 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      pickContainer(containerGuid, slotIndex = 0, subSlot = 0, jackGuid = 0) {
        const g = (jackGuid >>> 0) || (palletJackController?.activeGuid ?? 0);
        if (!g || !palletJacks.has(g)) return false;
        try {
          const h = sh();
          if (!h || typeof h.vehiclePalletJackAction !== "function") return false;
          h.vehiclePalletJackAction(g, PALLET_JACK_ACTION.PickContainerSlot, slotIndex | 0, subSlot | 0, 0, containerGuid >>> 0, 0, 0, 0, 0, 0, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      loadContainer(containerGuid, slotIndex = 0, subSlot = 0, jackGuid = 0) {
        const g = (jackGuid >>> 0) || (palletJackController?.activeGuid ?? 0);
        if (!g || !palletJacks.has(g)) return false;
        try {
          const h = sh();
          if (!h || typeof h.vehiclePalletJackAction !== "function") return false;
          h.vehiclePalletJackAction(g, PALLET_JACK_ACTION.LoadContainerSlot, slotIndex | 0, subSlot | 0, 0, containerGuid >>> 0, 0, 0, 0, 0, 0, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      toggleDeployableStow(deployableGuid) {
        const dGuid = deployableGuid >>> 0;
        if (!dGuid) return false;
        try {
          const h = sh();
          if (!h || typeof h.vehiclePalletJackAction !== "function") return false;
          h.vehiclePalletJackAction(palletJackController?.activeGuid ?? 0, PALLET_JACK_ACTION.ToggleDeployableStow, 0, 0, 0, dGuid, 0, 0, 0, 0, 0, 0);
          return true;
        } catch (_) {
          return false;
        }
      },
      get active() { return palletJackController?.isActive?.() ? palletJackController.activeGuid : null; },
    },
    semi: {
      list: () => [...vehicles.values()].filter((v) => isSemiVehicle(v)).map((v) => {
        const hGuid = currentHitchedTrailerGuid(v);
        return {
          guid: v.guid,
          liveryId: v.profile?.liveryId ?? 0,
          livery: groundModels.get(v.guid)?.livery?.key ?? null,
          coupled: hGuid !== 0,
          hitchedTrailerGuid: hGuid,
          trailerPitch: v._coupledTrailerPitch ?? v.last?.trailerPitch ?? 0,
          trailerHeading: v.last?.trailerHeading ?? null,
          trailerFlags: v._coupledTrailerFlags ?? v.last?.trailerFlags ?? 0,
          towMassMul: v.params?.towMassMul ?? computeTowMassMul(v),
          pos: v.last ? stateFromMsg(v.last) : null,
          model: groundModels.get(v.guid) ?? null,
        };
      }),
      get: (guid) => {
        const v = vehicles.get(guid >>> 0);
        if (v && !isSemiVehicle(v)) return null;
        const gm = groundModels.get(guid >>> 0) ?? null;
        return gm && gm.root?.userData?.profileKey === "semi-379" ? gm : null;
      },
      spawnLocal(guid, worldPos = [0, 0, 0], heading = 0, opts = {}) {
        if (!THREE || !live?.worldRoot) return null;
        const g = guid >>> 0;
        const existing = groundModels.get(g);
        if (existing) {
          try {
            if (existing.root?.parent) existing.root.parent.remove(existing.root);
            existing.dispose?.();
          } catch (_) {}
          groundModels.delete(g);
        }
        const m = buildSemiTruck(THREE, { profileKey: "semi-379", vehicleClass: 3, liveryId: opts.liveryId ?? 0 }, {
          liveScene3d: live,
          csmState: live.csmState,
          liveryId: opts.liveryId ?? 0,
        });
        live.worldRoot.add(m.root);
        m.root.position.set(worldPos[0], worldPos[1], worldPos[2]);
        m.root.rotation.z = -heading;
        m.update(opts, 0);
        groundModels.set(g, m);
        return m;
      },
      removeLocal(guid) {
        const g = guid >>> 0;
        const gm = groundModels.get(g);
        if (!gm) return;
        try {
          if (gm.root?.parent) gm.root.parent.remove(gm.root);
          gm.dispose?.();
        } catch (_) {}
        groundModels.delete(g);
      },
      active: () => {
        if (pilot && isSemiVehicle(pilot.vehicle)) return pilot.vehicle.guid;
        if (passenger && isSemiVehicle(passenger.vehicle)) return passenger.vehicle.guid;
        return null;
      },
    },
    warehouse: warehouseManager,
    terminal: portTerminalManager,
    ship: shipManager,
    dispose() {
      disposed = true;
      teardownSession("dispose");
      try { canvasEl?.removeEventListener?.("webglcontextlost", onContextLost, false); } catch (_) {}
      try { win?.removeEventListener?.("pagehide", onPageHide, false); } catch (_) {}
      try { win?.removeEventListener?.("beforeunload", onPageHide, false); } catch (_) {}
      try { win?.removeEventListener?.("hb-logged-out", onLogoutEvt, false); } catch (_) {}
      try { win?.removeEventListener?.("hb-disconnected", onPageHide, false); } catch (_) {}
      try { win?.removeEventListener?.("keydown", onLogisticsKeyDown, true); } catch (_) {}
      try { clearTimeout(promptTimer); } catch (_) {}
      promptTimer = null;
      try { palletJackController?.dispose?.(); } catch (_) {}
      for (const v of vehicles.values()) forgetVehicle(v);
      for (const g of [...trailers.keys()]) removeTrailerEntry(g);
      trailers.clear();
      for (const g of [...palletJacks.keys()]) removePalletJackEntry(g);
      palletJacks.clear();
      for (const g of [...deployables.keys()]) removeDeployableEntry(g);
      for (const g of [...containers.keys()]) removeContainerEntry(g);
      containers.clear();
      for (const j of jeepModels.values()) {
        try { if (j.root.parent) j.root.parent.remove(j.root); j.dispose(); } catch (_) {}
      }
      jeepModels.clear();
      for (const j of groundModels.values()) {
        try { if (j.root.parent) j.root.parent.remove(j.root); j.dispose?.(); } catch (_) {}
      }
      groundModels.clear();
      if (typeof live?.worldRoot?.traverse === "function") {
        live.worldRoot.traverse((o) => {
          if (o.isSprite && o.geometry) {
            try { o.geometry.dispose?.(); } catch (_) {}
          }
        });
      }
      groundFx?.dispose?.();
      groundAudio?.dispose?.();
      try { shipManager?.dispose?.(); } catch (_) {}
      try { portTerminalManager?.dispose?.(); } catch (_) {}
      try { portAudio?.dispose?.(); } catch (_) {}
      try { warehouseManager?.dispose?.(); } catch (_) {}
      logisticsAudio?.dispose?.();
      deployableVfx?.dispose();
      deployableAudio?.dispose();
      radarScope.dispose();
      osd.dispose();
      fx.dispose();
      aeroFx?.dispose();
      vehicleAudio?.dispose();
      airframes?.dispose();
      fallPose?.dispose();
      chutes?.dispose();
      if (live.vehicles && live.vehicles.afterTick === afterTick) delete live.vehicles;
      if (win.__port && win.__port.terminal === portTerminalManager) delete win.__port;
      if (win.__vehicles === api) delete win.__vehicles;
    },
  };
  win.__vehicles = api;
  win.__port = {
    terminal: portTerminalManager,
    ship: shipManager,
    warehouse: warehouseManager,
    buildPortAndWarehouse(opts = {}) {
      const origin = Array.isArray(opts.origin) ? opts.origin : PORT_ORIGIN;
      const layout = portTerminalManager.buildTerminal({
        origin,
        populateYard: opts.populateYard !== false,
        yardDensity: opts.yardDensity,
      });
      const whOrigin = layout?.warehouseOrigin || WAREHOUSE_PORT_ORIGIN;
      warehouseManager.buildHub({
        origin: whOrigin,
        populateDemoCargo: opts.populateDemoCargo !== false,
      });
      if (opts.spawnShip !== false && shipManager.list().length === 0) {
        shipManager.spawnShip(opts.shipId || "MV-DERETH-1", {
          origin: layout.origin,
          spawnAtBerth: opts.spawnAtBerth || "B1",
          moored: opts.moored !== false,
          populateCargo: opts.populateCargo !== false,
        });
      }
      return { layout, warehouseOrigin: whOrigin };
    },
    runFullDemo(opts = {}) {
      if (!portTerminalManager.stats.built) {
        win.__port.buildPortAndWarehouse(opts);
      }
      const shipId = opts.shipId || "MV-DERETH-1";
      if (!shipManager.get(shipId)) {
        shipManager.spawnShip(shipId, {
          origin: portTerminalManager.getLayout()?.origin || PORT_ORIGIN,
          spawnAtBerth: "B1",
          moored: true,
          populateCargo: true,
        });
      }
      return portTerminalManager.runScenario("port-import-to-warehouse", { shipId, padId: opts.padId || "C1" });
    },
    clearAll() {
      try { shipManager.exit(); } catch (_) {}
      for (const s of shipManager.list()) {
        try { shipManager.removeShip(s.id); } catch (_) {}
      }
      try { portTerminalManager.clearTerminal(); } catch (_) {}
      try { warehouseManager.clearHub(); } catch (_) {}
    },
    getState() {
      return {
        terminal: portTerminalManager.getState(),
        ship: shipManager.getState(),
        warehouse: warehouseManager.getState(),
      };
    },
  };
  console.log("[vehicles] installed (?vehicles=on): capability handshake after entering the world");
  return api;
}
