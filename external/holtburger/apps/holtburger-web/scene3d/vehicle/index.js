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
import { createObserverTrack, createPilotPredictor, stateFromMsg, OBSERVER_DELAY_S } from "./predictor.js";
import { createVehicleControls } from "./controls.js";
import { createVehicleOsd } from "./osd.js";
import { createWeaponsFx, predictImpact } from "./weapons.js";
import { airframeEnabled, createAirframes, hasComposite, kindOrdinal } from "./airframe.js";
import { stepFall } from "./fall_model.js";
import { boardAnimEnabled, headingOfQuat, hopDuration, hopHeading, hopPoint, HOP } from "./board_hop.js";
import { chuteEnabled, createChutes } from "./chute.js";
import { createFallPose, fallAnimEnabled, fallTimeoutSec } from "./fall_pose.js";
import { portalSpaceOwnsFrame } from "../portal_space.js";
import { wireframeFlagOn } from "../wireframe_flag.js";
import { createCameraOwner } from "../film/runtime/camera_owner.js";
import { createDroneAudio } from "../drone/audio.js";
import { rlogEvent, RLOG } from "../residency_log.js";
import { flightResidencyEnabled, setFlightHint, clearFlightHint } from "../residency.js";

export const CAP_OBSERVE = 0x1;
export const CAP_PILOT = 0x2;
export const BOARD_RANGE_M = 8;
export const CHASE = Object.freeze({ back: 16, up: 4.5, lookAhead: 30, pitch: -0.12, fov: 70, headingTau: 0.25 });
// up 1.25: the eye over the Hellcat's long nose (at 1.0 the cowling filled the lower third of the view, 1070 2026-11-02)
export const COCKPIT = Object.freeze({ up: 1.68, forward: 0.15, fov: 78 });
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
export const EVENT_NAMES = Object.freeze({ 1: "takeoff", 2: "landed", 3: "crashed", 4: "despawn", 5: "bail", 6: "chute", 7: "touchdown", 8: "hit",
  9: "bombRelease", 10: "explosion", 11: "rearmed" });
/** Retail motion commands the pilot's rig holds (the server shows the same Sitting to every client). */
export const MOTION = Object.freeze({ SITTING: 0x41000013, READY: 0x41000003, NONCOMBAT: 0x8000003d });
/** `?vehicleAudio=off` (exact) builds no engine hum. */
export function vehicleAudioEnabled(search) {
  try { return new URLSearchParams(search || "").get("vehicleAudio") !== "off"; } catch (_) { return true; }
}
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
    if (!h || typeof h.terrainHeightAt !== "function") return NaN;
    const z = h.terrainHeightAt(x, y);
    return z === undefined || z === null ? NaN : z;
  };

  const vehicles = new Map(); // guid → {guid, profile, params, seats:[], last, track}
  const caps = { handle: null, sentAt: 0, tries: 0, granted: null, ackAt: 0 };
  const events = []; // recent vehicle events (bench)
  const stats = { frames: 0, msgs: 0, states: 0, profiles: 0, fires: 0, events: 0, parseErrors: 0, inputsSent: 0, sendErrors: 0, boardRefusals: 0, lastRefusal: null, pruned: 0,
    handoffs: 0, lastHandoff: null };
  const osd = createVehicleOsd({ document: win.document });
  // the armament's looks (quarrels, rail flashes, falling bombs, explosions) and the composite airframe (airframe.js)
  const fx = createWeaponsFx({ liveScene3d: live, THREE, ground });
  const search = win.location?.search ?? "";
  const airframes = airframeEnabled(search) ? createAirframes({ liveScene3d: live, THREE }) : null;
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
  const hopsOn = boardAnimEnabled(win.location?.search);
  let bailArmedAt = -1e9;
  // one tracked timer for every transient prompt (refusal, bail hints, bomb away, rearmed): cleared on dispose; when it
  // expires the board prompt is re-evaluated (tickPrompt only rewrites on a change of the nearest vehicle)
  let promptTimer = null;
  let promptVehicle = null;
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
  function forgetVehicle(v) {
    if (!v) return;
    try { airframes?.remove(v.guid); } catch (_) { /* gone */ }
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
    const inst = airframes && v.profile ? airframes.ensure(v) : null;
    if (!inst) return false;
    const inEm = em()?.entityMap?.get(v.guid);
    if (!v.standInHidden || (inEm && inEm._filmHidden !== true)) {
      try { if (em()?.setFilmHidden?.(v.guid, true)) v.standInHidden = true; } catch (_) { /* never fatal */ }
    }
    const g = ground(pose.x, pose.y);
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
      q, dt: opts.dt ?? 1 / 60, throttle: opts.throttle, agl: Number.isNaN(g) ? undefined : pose.z - g, cockpit: !!opts.cockpit,
      missileMask: last?.missileMask, bombMask: last?.bombMask, localSpent: v.spent,
    });
    return true;
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
        v.params = FM.paramsFromProfile(m);
        stats.profiles++;
        // start decoding the composite airframe now (the stand-in stays until it is ready)
        if (airframes && hasComposite(m)) { try { airframes.ensure(v); } catch (_) { /* stand-in */ } }
        if (live?.renderer) {
          try { if (m.weapons?.length) fx.warm?.(); chutes?.warm?.(); } catch (_) { /* best effort */ }
        }
        // The pilot's model is the stand-in object itself in v1 (profile.parts = [the stand-in]); it stays visible
        // and is posed by afterTick. A composite airframe would hide the stand-in here (setFilmHidden).
        break;
      }
      case "seat": {
        const v = vehicleOf(m.vehicle);
        if (m.state === 1 && (m.occupant >>> 0)) fallPose?.end(m.occupant, "seated");
        if (m.state === 1) v.seats[m.seat] = m.occupant >>> 0;
        else if (m.state === 0) v.seats[m.seat] = 0;
        if (m.state === 2) {
          stats.boardRefusals++;
          stats.lastRefusal = REFUSAL[m.reason] ?? `reason ${m.reason}`;
          pendingBoard = null;
          flashPrompt(`Cannot board: ${stats.lastRefusal}`, 2500);
        } else if (m.state === 1 && (m.occupant >>> 0) === localGuid()) {
          pendingBoard = null;
          startPiloting(v, m.seat);
        } else if (m.state === 0 && pilot && pilot.vehicle === v) {
          stopPiloting("seat released");
        }
        break;
      }
      case "state": {
        const v = vehicleOf(m.vehicle);
        v.last = m;
        v.lastMsgAt = nowSec();
        stats.states++;
        if (pilot && pilot.vehicle === v && (m.flags & 0x01)) {
          if (!pilot.predictor) pilot.predictor = makePredictor(v, m);
          else pilot.predictor.reconcile(m);
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
        if (pilot && pilot.vehicle === v && pilot.predictor) {
          // the pilot's own guns: the quarrels leave the PREDICTED muzzles (the server's are ~RTT/2 behind)
          const s = pilot.predictor.state;
          const q = FM.orientation(s.heading, s.pitch, s.bank);
          const r = FM.rotate(q, w?.muzzle ?? [0, 4, 0.5]);
          fx.fire(m, v, s, [s.x + r[0], s.y + r[1], s.z + r[2]], v.params ? FM.velocity(s, v.params) : null);
        } else {
          const vel = v.last && v.params ? FM.velocity(stateFromMsg(v.last), v.params) : null;
          fx.fire(m, v, v.last ? { heading: v.last.heading, pitch: v.last.pitch, bank: v.last.bank } : null, undefined, vel);
        }
        break;
      }
      case "event": {
        stats.events++;
        events.push({ t: nowSec(), name: EVENT_NAMES[m.kind] ?? m.kind, ...m });
        if (events.length > 200) events.shift();
        const v = vehicles.get(m.vehicle >>> 0);
        const mine = (m.subject >>> 0) === localGuid();
        if (m.kind === 4) { // despawn
          if (pilot && pilot.vehicle === v) stopPiloting("despawned");
          if (handoff && handoff.v === v) endHandoff("despawned");
          forgetVehicle(v);
          vehicles.delete(m.vehicle >>> 0);
        } else if (m.kind === 3) { // crashed: derelict aircraft struck terrain → 2,000 lb fireball + smoke column
          fx.explosionEvent({ ...m, aux: 99, value: m.value || 2000 });
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
            if (mine) flashPrompt(`Bomb away — ${Math.round(m.value)} lb`, 1800);
          }
        } else if (m.kind === 10) { // explosion (also for bombs whose vehicle is gone / out of our sight)
          fx.explosionEvent(m);
        } else if (m.kind === 11) { // rearmed on the ground
          if (v) {
            v.spent.clear();
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
        if (m.kind === 6 && m.subject) chutes?.open(m.subject);
        else if (m.kind === 7 && m.subject) chutes?.close(m.subject);
        // the fall pose (ours from startFall / stopFall): observed bodies fall at their Bail, every canopy pose starts at
        // its Chute, and any Touchdown hands the body back (idempotent)
        if (fallPose && m.subject) {
          if (m.kind === 5 && !mine) fallPose.begin(m.subject);
          else if (m.kind === 6 && (!mine || fall)) fallPose.chute(m.subject, { local: mine });
          else if (m.kind === 7) fallPose.end(m.subject, m.cell ? "touchdown" : "teleport");
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
    return createPilotPredictor({ params: v.params, ground, initial: stateFromMsg(m), vCap: m.vCap, startSeq: 1 });
  }

  function startPiloting(v, seat) {
    if (pilot) stopPiloting("re-seat");
    endHandoff("re-seat");
    releaseLandingCam();
    if (!v.params) return;
    const controls = createVehicleControls({ window: win });
    controls.lock();
    controls.throttle = 0;
    let camera = null;
    try {
      camera = createCameraOwner({ liveScene3d: live, THREE, window: win, get sessionHandle() { return sh(); } });
      camera.own();
      unfadeAvatar();
    } catch (e) {
      camera = null;
      console.warn("[vehicles] camera owner unavailable:", e && e.message ? e.message : e);
    }
    // M5: the rig sits (retail Sitting, held) and the engine hums on the effects bus
    try { em()?.setMotion?.(localGuid(), MOTION.SITTING, MOTION.NONCOMBAT, 1.0); } catch (_) { /* never fatal */ }
    let audio = null;
    if (vehicleAudioEnabled(win.location?.search)) {
      try {
        audio = createDroneAudio({ bus: () => live.audioManager?.getEffectBus?.() ?? null, volume: () => 0.8 });
        audio.start();
      } catch (_) { audio = null; }
    }
    // M5 boarding hop: from where the rig stands now up to the seat (local presentation; board_hop.js)
    let hop = null;
    exitHop = null;
    const rig = em()?.entityMap?.get(localGuid());
    if (hopsOn && rig?.root) {
      const r = rig.root;
      hop = { from: { x: r.position.x, y: r.position.y, z: r.position.z }, h0: headingOfQuat([r.quaternion.w, r.quaternion.x, r.quaternion.y, r.quaternion.z]), t: 0, dur: 0 };
    }
    pilot = {
      audio, hop,
      vehicle: v, seat, controls, camera, acc: 0, predictor: v.last ? makePredictor(v, v.last) : null,
      startedAt: nowSec(), view: "chase", camHeading: null, lastServer: v.last, leadLb: 0, sent: 0,
      unsub: null, lastSeat: null, trail: [],
    };
    pilot.unsub = controls.onAction((a) => {
      if (a.type === "camera") pilot.view = pilot.view === "chase" ? "cockpit" : "chase";
      else if (a.type === "hideHud") osd.toggleHidden();
      else if (a.type === "exit") requestExit();
    });
    osd.prompt(null);
    console.log(`[vehicles] piloting 0x${v.guid.toString(16)} seat ${seat}`);
  }

  function stopPiloting(why) {
    if (!pilot) return;
    const p = pilot;
    pilot = null; if (FLIGHT_RESIDENCY) clearFlightHint();
    try {
      lastPilotKin = p.predictor && p.vehicle?.params
        ? { vehicle: p.vehicle.guid >>> 0, vel: FM.velocity(p.predictor.state, p.vehicle.params), at: nowSec() } : null;
    } catch (_) { lastPilotKin = null; }
    // a seat released in the air = the bail's first half (BAIL_HANDOFF): keep the camera, the aircraft and the body
    // where they were drawn until the Bail event arrives — unless a teleport released it (ACE OnPlayerTeleport: no Bail
    // follows, and the hand-off's seat lock would hold the body at the old site over the teleport's destination)
    const mode = p.predictor?.state?.mode;
    const v = p.vehicle;
    const flying = !disposed && p.predictor && v?.params && vehicles.get(v.guid) === v && mode !== FM.MODE.PARKED && mode !== FM.MODE.CRASHED;
    const inAir = why === "seat released" && flying && !teleportUnderWay();
    try { p.unsub?.(); } catch (_) {}
    try { p.controls.dispose(); } catch (_) {}
    if (!inAir) { try { p.camera?.release(); p.camera?.dispose(); } catch (_) {} }
    try { sh()?.clearVehicleSeat?.(); } catch (_) {}
    try { p.audio?.stop({ fadeSec: 0.6 }); setTimeout(() => { try { p.audio?.dispose(); } catch (_) {} }, 1000); } catch (_) {}
    if (!inAir) { try { em()?.setMotion?.(localGuid(), MOTION.READY, MOTION.NONCOMBAT, 1.0); } catch (_) {} }
    // (the stand-in stays hidden under a composite airframe: un-hiding it flashed the retail stand-in for a frame)
    if (p.rigHidden) { try { em()?.setFilmHidden?.(localGuid(), false); if (!p.rigComposite) em()?.setFilmHidden?.(p.vehicle.guid, false); } catch (_) { /* */ } }
    // the aircraft got no observer samples while piloted (its states came as pilot copies): drop the stale ones from
    // before boarding — drawn for 1-3 frames at the old parked spot after a landing + exit, km away after a bail. In
    // the air it is dead-reckoned from the predictor (neutral input) while the FRESH track fills; parked it stays
    // where the pilot path drew it until its first observer state.
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
    handoff = { v: p.vehicle, seat: p.seat, camera: p.camera && p.camera.owned ? p.camera : null, camHeading: p.camHeading, lastSeat: p.lastSeat, startedAt: nowSec(),
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
    endHandoff("teleport");
    if (fall) { chutes?.close(localGuid()); stopFall("teleport"); }
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
  function chaseCamPose(seat, pose, ch0) {
    const ch = ch0 + (camTweak?.yaw ?? 0);
    const back = camTweak?.back ?? CHASE.back, up = camTweak?.up ?? CHASE.up;
    const ex = seat.x - Math.sin(ch) * back;
    const ey = seat.y - Math.cos(ch) * back;
    let ez = seat.z + up;
    const g = ground(ex, ey);
    if (!Number.isNaN(g) && ez < g + 2) ez = g + 2;
    // a tweaked orbit looks at the seat (the default chase framing looks a little down along the flight path)
    const pc = camTweak ? (camTweak.pitch ?? -Math.atan2(ez - seat.z, back)) : CHASE.pitch + pose.pitch * 0.4;
    const rl = camTweak ? (camTweak.roll ?? 0) : pose.bank * 0.25;
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
      ho.camera.write(chaseCamPose(seat, pose, ho.camHeading));
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
  function seatOf(v, pose, seat) {
    let q = FM.orientation(pose.heading, pose.pitch, pose.bank);
    let off = v.profile?.seats?.[seat]?.offset ?? [0, 0, 0];
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
    p.acc += wallDt;
    let n = 0;
    const hopping = !!p.hop; // boarding hop in progress: the vehicle stays parked
    while (p.acc >= FM.DT && n < 30) {
      p.acc -= FM.DT;
      const raw = p.controls.poll(FM.DT); // polled while hopping too: the throttle lever keeps its travel
      p.predictor.stepLocal(hopping ? NEUTRAL_INPUT : raw);
      sendInput(p);
      n++;
    }
    if (n >= 30) p.acc = 0;
    p.stepsLastFrame = n;
    p.predictor.decay(wallDt);
    const pose = p.predictor.renderPose(p.acc / FM.DT);
    const h = sh();

    // the local body rides the seat (wasm: no local physics while locked)
    const seat = seatOf(v, pose, p.seat);
    const cl = FM.toCellLocal(seat.x, seat.y, seat.z);
    try { h.setVehicleSeat(v.guid, cl.cell, cl.x, cl.y, cl.z, pose.heading); } catch (_) {}

    // draw: the vehicle and the pilot's rig at the predicted pose (after the entity tick → last write wins)
    const q = FM.orientation(pose.heading, pose.pitch, pose.bank);
    const thrNow = p.controls.status().throttle;
    const composite = drawVehicle(v, pose, q, { dt, throttle: thrNow, cockpit: p.view === "cockpit" });
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

    // cockpit view: the eye sits where the seated pilot's head is, and the retail stand-in has no interior (the demo
    // balloon's envelope starts right above the seat) — hide our own rig AND our vehicle's model there (render-only,
    // local: everyone else still sees both); shown again in chase view and on leaving the seat
    // With the composite airframe the cockpit keeps the aircraft: the nose, the wings and the guns ahead (its canopy part
    // is hidden; airframe.js), only our own rig goes. The stand-in balloon (no composite) still hides as before.
    const wantHidden = p.view === "cockpit";
    if (wantHidden !== !!p.rigHidden || composite !== p.rigComposite) {
      try {
        em()?.setFilmHidden?.(localGuid(), wantHidden);
        if (!composite) em()?.setFilmHidden?.(v.guid, wantHidden);
        p.rigHidden = wantHidden;
        p.rigComposite = composite;
      } catch (_) { /* never fatal */ }
    }

    // camera (+ the shake of a nearby explosion)
    if (p.camera && p.camera.owned) {
      let cam;
      if (p.view === "cockpit") {
        const eye = FM.rotate(seat.q, [0, COCKPIT.forward, COCKPIT.up]);
        cam = { pos: [seat.x + eye[0], seat.y + eye[1], seat.z + eye[2]], h: pose.heading, p: pose.pitch, r: pose.bank, fov: COCKPIT.fov };
      } else {
        if (p.camHeading === null) p.camHeading = pose.heading;
        p.camHeading = FM.wrapHeading(p.camHeading + angleDiff(pose.heading, p.camHeading) * (1 - Math.exp(-dt / CHASE.headingTau)));
        // aim at the seat, not the vehicle origin: the stand-in's crew sits up in its basket (profile seat offset)
        cam = chaseCamPose(seat, pose, p.camHeading);
      }
      const shake = fx.shakeAt(cam.pos);
      if (shake > 0.01) {
        cam.pos = [cam.pos[0] + (Math.random() - 0.5) * shake, cam.pos[1] + (Math.random() - 0.5) * shake, cam.pos[2] + (Math.random() - 0.5) * shake];
        cam.p += (Math.random() - 0.5) * shake * 0.01;
        cam.r += (Math.random() - 0.5) * shake * 0.01;
      }
      p.camera.write(cam);
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
        const own = (cl.cell >>> 16) << 16;
        if (own !== p.ownLb && win.__worldStreamer && typeof win.__worldStreamer.onPositionUpdate === "function") {
          p.ownLb = own;
          win.__worldStreamer.onPositionUpdate({ guid: localGuid(), landblockId: cl.cell });
        }
        // and keep the wasm COLLISION terrain (terrainHeightAt, the predictor's floor) resident ahead: the 3x3
        // around the lead point only — no second residency centre
        const lead = Number.isFinite(v.profile.leadSeconds) ? v.profile.leadSeconds : 6;
        const lp = FM.toCellLocal(pose.x + vel[0] * lead, pose.y + vel[1] * lead, pose.z);
        const lb = (lp.cell >>> 16) << 16;
        if (lb !== p.leadLb && typeof win.__ensureCollisionTerrain === "function") {
          rlogEvent(RLOG.LEAD, lb, p.leadLb | 0, 1);
          p.leadLb = lb;
          try { const r = win.__ensureCollisionTerrain(lb >>> 0); if (r && typeof r.catch === "function") r.catch(() => {}); } catch (_) { /* hint only */ }
        }
      } catch (_) { /* streaming hint only */ }
    } else try {
      const vel = FM.velocity(pose, v.params);
      const lead = Number.isFinite(v.profile.leadSeconds) ? v.profile.leadSeconds : 6;
      const lp = FM.toCellLocal(pose.x + vel[0] * lead, pose.y + vel[1] * lead, pose.z);
      const lb = (lp.cell >>> 16) << 16;
      if (lb !== p.leadLb && win.__worldStreamer && typeof win.__worldStreamer.onPositionUpdate === "function") {
        rlogEvent(RLOG.LEAD, lb, p.leadLb | 0, 0);
        p.leadLb = lb;
        win.__worldStreamer.onPositionUpdate({ guid: localGuid(), landblockId: lp.cell });
      }
    } catch (_) { /* streaming hint only */ }

    // engine hum: throttle drives the pitch, speed the brightness (in-ear in the cockpit, panned at the aircraft outside)
    try {
      const thr = p.controls.status().throttle;
      p.audio?.update({ throttle: 0.6 + thr * 1.4, speed: pose.speed, level: pose.mode === FM.MODE.PARKED && thr < 0.05 ? 0.4 : 1, fpv: p.view === "cockpit", pos: [pose.x, pose.y, pose.z] });
    } catch (_) { /* audio never breaks flight */ }

    // OSD + sights
    const g0 = ground(pose.x, pose.y);
    const st = p.predictor.stats();
    const raw = p.controls.status();
    osd.update({
      name: v.profile?.displayName, speed: pose.speed, agl: Number.isNaN(g0) ? 0 : pose.z - g0, heading: pose.heading,
      throttle: raw.throttle, mode: pose.mode, vCap: p.predictor.vCap,
      boost: !!(raw.override?.boost), land: false,
      corr: `corr ${st.corrections} (last ${st.lastCorrectionM.toFixed(2)} m)`,
      warn: p.lastServer && (p.lastServer.flags & 0x04),
      arms: armament(v, p.lastServer),
    });
    tickSights(p, v, pose, q, wallNow);
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

  /** Gunsight at the guns' convergence point; bomb pipper at the predicted impact of the next bomb (10 Hz solution). */
  function tickSights(p, v, pose, q, t) {
    const airborne = pose.mode === FM.MODE.FLIGHT || pose.mode === FM.MODE.LANDING;
    const ws = v.profile?.weapons || [];
    const cam = p.camera && p.camera.owned && typeof p.camera.camera === "function" ? p.camera.camera() : null;
    let ret = null, pip = null, label = "";
    if (!airborne) p.pipper = null;
    if (airborne) {
      const g = ws.findIndex((w) => w.kind === 1);
      if (g >= 0 && cam) {
        const conv = v.profile?.weaponExt?.[g]?.convergence || 110;
        const m = ws[g].muzzle ?? [0, 0, 0];
        const r = FM.rotate(q, [0, m[1] + conv, m[2]]);
        ret = project([pose.x + r[0], pose.y + r[1], pose.z + r[2]], cam);
      }
      const b = nextBomb(v, p.lastServer);
      if (b >= 0) {
        if (!p.pipper || t - p.pipper.at >= PIPPER_SEC) {
          const m = ws[b].muzzle ?? [0, 0, 0];
          const r = FM.rotate(q, m);
          const vel = FM.velocity(pose, v.params);
          const start = { x: pose.x + r[0], y: pose.y + r[1], z: pose.z + r[2], vx: vel[0], vy: vel[1], vz: vel[2] - BOMB_EJECT,
            terminal: v.profile?.weaponExt?.[b]?.dragTerminal || 280 };
          const hit = predictImpact(start, ground);
          const lb = Math.round((v.profile?.weaponExt?.[b]?.massKg ?? 0) * 2.20462 / 100) * 100;
          p.pipper = { at: t, hit, label: hit ? `${lb} lb  ${hit.t.toFixed(1)} s` : "" };
        }
        if (p.pipper.hit && cam) { pip = project([p.pipper.hit.x, p.pipper.hit.y, p.pipper.hit.z], cam); label = p.pipper.label; }
      } else p.pipper = null;
    }
    osd.sights(ret, pip, label);
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
  function tickObservers() {
    const t = nowSec();
    for (const v of vehicles.values()) {
      if (pilot && pilot.vehicle === v) continue;
      if (!v.track.count && !v.reckon) continue;
      const pose = observedPose(v, t);
      if (!pose) continue;
      const q = FM.orientation(pose.heading, pose.pitch, pose.bank);
      drawVehicle(v, pose, q, { dt: frameDt, throttle: pose.mode === FM.MODE.PARKED ? 0 : undefined });
      const occ = v.seats[0] >>> 0;
      if (occ && occ !== localGuid() && v.profile) {
        const seat = seatOf(v, pose, 0);
        writeEntity(occ, seat.x, seat.y, seat.z, seat.q, true);
      }
    }
  }

  // A vehicle we stopped tracking (out of sight, or the server deleted it from our view) never gets its despawn event:
  // drop it once its entity is gone AND no state has arrived for 5 s (states come at 10 Hz while the server tracks it
  // for us; the entity alone is not enough — the client may cull a far entity the server still sends).
  let lastPrune = 0;
  function pruneVehicles() {
    const t = nowSec();
    if (t - lastPrune < 1) return;
    lastPrune = t;
    const map = em()?.entityMap;
    if (!map) return;
    for (const [guid, v] of vehicles) {
      if (pilot && pilot.vehicle === v) continue;
      if (map.has(guid) || t - (v.lastMsgAt ?? 0) < 5) continue;
      forgetVehicle(v);
      vehicles.delete(guid);
      stats.pruned++;
    }
  }

  function nearestBoardable() {
    const me = localGuid();
    const inst = em()?.entityMap?.get(me);
    if (!inst || !inst.root) return null;
    const px = inst.root.position.x, py = inst.root.position.y, pz = inst.root.position.z;
    let best = null;
    let bestD = BOARD_RANGE_M;
    for (const v of vehicles.values()) {
      if (!v.profile || !v.last || v.last.mode !== FM.MODE.PARKED || (v.seats[0] >>> 0)) continue;
      const s = stateFromMsg(v.last);
      const d = Math.hypot(s.x - px, s.y - py, s.z - pz);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  function tickPrompt() {
    if (promptTimer) return; // a transient prompt is showing
    // never while falling / in the bail hand-off: ACE would seat a body it is still dropping (it now refuses too)
    if (pilot || fall || handoff || caps.granted === null || !(caps.granted & CAP_PILOT)) {
      if (promptVehicle) { promptVehicle = null; osd.prompt(null); }
      return;
    }
    const v = nearestBoardable();
    if (v !== promptVehicle) {
      promptVehicle = v;
      osd.prompt(v ? `Press B to board the ${v.profile.displayName}` : null);
    }
  }

  const onKeyB = (ev) => {
    if (ev.code !== "KeyB" || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const el = win.document?.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (!promptVehicle || pilot || fall || handoff) return;
    api.board(promptVehicle.guid);
  };
  win.addEventListener("keydown", onKeyB, true);

  // ---------------------------------------------------------------- frame hook

  function afterTick(ts, dtMs) {
    if (disposed) return;
    const dt = Number.isFinite(dtMs) ? (dtMs > 5 ? dtMs / 1000 : dtMs) : 1 / 60;
    frameDt = dt;
    stats.frames++;
    handshake();
    drainInbox();
    if (pilot) tickPilot(dt);
    else if (fall) tickFall();
    else if (handoff) tickHandoff(dt);
    else if (exitHop) tickExitHop(dt);
    tickObservers();
    fallPose?.tick(dt, nowSec()); // after the rig writes, before the canopies (they read the riser grips)
    pruneVehicles();
    tickPrompt();
    fx.tick(dt);
    if (!pilot) osd.sights(null, null, "");
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
          vehicle: pilot.vehicle.guid, seat: pilot.seat, view: pilot.view, sent: pilot.sent,
          state: pilot.predictor ? { ...pilot.predictor.state } : null,
          seq: pilot.predictor?.seq ?? null, vCap: pilot.predictor?.vCap ?? null,
          predictor: pilot.predictor?.stats() ?? null, controls: pilot.controls.status(),
          server: pilot.lastServer ? { step: pilot.lastServer.step, ack: pilot.lastServer.ack, mode: pilot.lastServer.mode, speed: pilot.lastServer.speed } : null,
        } : null,
        wire,
        weapons: fx.stats(),
        tracers: (() => { const w = fx.stats(); return { live: w.liveQuarrels, added: w.quarrels }; })(),
        airframes: airframes ? airframes.stats() : { enabled: false },
        chutes: chutes ? chutes.stats() : null,
      };
    },
    vehicles: () => [...vehicles.values()],
    /** Allocation-free membership test (entities.js: the flight entity horizon never culls a vehicle). */
    isVehicle: (guid) => vehicles.has(guid >>> 0),
    events: () => events.slice(),
    nearest: () => nearestBoardable()?.guid ?? null,
    board(guid) {
      if (pilot || fall || handoff) return { ok: false, reason: "busy" };
      const g = (guid ?? nearestBoardable()?.guid ?? [...vehicles.keys()][0]) >>> 0;
      if (!g) return { ok: false, reason: "no vehicle" };
      pendingBoard = { guid: g, t: nowSec() };
      try { sh().vehicleBoard(g, 0); } catch (e) { return { ok: false, reason: String(e) }; }
      return { ok: true, guid: g };
    },
    exit(mode) { requestExit(mode); return { ok: !!pilot }; },
    /** Bench: drive the analog input (throttle, pitch, roll, yaw, boost, fire, land) for `ms`. */
    setSticks(axes, ms) { if (!pilot) return false; pilot.controls.setOverride(axes, ms); return true; },
    clearSticks() { pilot?.controls.clearOverride(); },
    setView(view) { if (pilot) pilot.view = view === "cockpit" ? "cockpit" : "chase"; },
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
    get falling() { return !!fall; },
    openChute() { if (fall) { try { sh().vehicleExit(fall.vehicle, 2); } catch (_) {} return true; } return false; },
    dispose() {
      disposed = true;
      stopPiloting("dispose");
      endHandoff("dispose");
      stopFall("dispose");
      releaseLandingCam();
      try { win.removeEventListener("keydown", onKeyB, true); } catch (_) {}
      try { clearTimeout(promptTimer); } catch (_) {}
      promptTimer = null;
      for (const v of vehicles.values()) forgetVehicle(v);
      osd.dispose();
      fx.dispose();
      airframes?.dispose();
      fallPose?.dispose();
      chutes?.dispose();
      if (live.vehicles && live.vehicles.afterTick === afterTick) delete live.vehicles;
      if (win.__vehicles === api) delete win.__vehicles;
    },
  };
  win.__vehicles = api;
  console.log("[vehicles] installed (?vehicles=on): capability handshake after entering the world");
  return api;
}
