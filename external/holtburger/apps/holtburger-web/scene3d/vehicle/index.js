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
// `liveScene3d.vehicles.afterTick(ts, dt)` runs every frame after tickPerFrame (scene3d/index.js), so the transforms
// written here are the last word before render.
//
// Debug / bench surface: `window.__vehicles` (status, board, exit, setSticks, spawn, despawn, ...).

import * as FM from "./flight_model.js";
import { createObserverTrack, createPilotPredictor, stateFromMsg } from "./predictor.js";
import { createVehicleControls } from "./controls.js";
import { createVehicleOsd } from "./osd.js";
import { createTracers } from "./weapons.js";
import { stepFall } from "./fall_model.js";
import { createCameraOwner } from "../film/runtime/camera_owner.js";
import { createDroneAudio } from "../drone/audio.js";

export const CAP_OBSERVE = 0x1;
export const CAP_PILOT = 0x2;
export const BOARD_RANGE_M = 8;
export const CHASE = Object.freeze({ back: 16, up: 4.5, lookAhead: 30, pitch: -0.12, fov: 70, headingTau: 0.25 });
export const COCKPIT = Object.freeze({ up: 0.9, forward: 0.1, fov: 78 });
export const EVENT_NAMES = Object.freeze({ 1: "takeoff", 2: "landed", 3: "crashed", 4: "despawn", 5: "bail", 6: "chute", 7: "touchdown", 8: "hit" });
/** Retail motion commands the pilot's rig holds (the server shows the same Sitting to every client). */
export const MOTION = Object.freeze({ SITTING: 0x41000013, READY: 0x41000003, NONCOMBAT: 0x8000003d });
/** `?vehicleAudio=off` (exact) builds no engine hum. */
export function vehicleAudioEnabled(search) {
  try { return new URLSearchParams(search || "").get("vehicleAudio") !== "off"; } catch (_) { return true; }
}
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
  const stats = { frames: 0, msgs: 0, states: 0, profiles: 0, fires: 0, events: 0, parseErrors: 0, inputsSent: 0, sendErrors: 0, boardRefusals: 0, lastRefusal: null, pruned: 0 };
  const osd = createVehicleOsd({ document: win.document });
  const tracers = createTracers({ liveScene3d: live, THREE });
  let pilot = null; // active piloting session
  let fall = null; // bail-out freefall of the local player (server-owned body, predicted here)
  let pendingBoard = null;
  let disposed = false;
  let bailArmedAt = -1e9;

  // ---------------------------------------------------------------- inbox

  function vehicleOf(guid) {
    let v = vehicles.get(guid >>> 0);
    if (!v) {
      v = { guid: guid >>> 0, profile: null, params: null, seats: [], last: null, track: createObserverTrack(), firstSeen: nowSec(), lastMsgAt: nowSec() };
      vehicles.set(v.guid, v);
    }
    return v;
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
        // The pilot's model is the stand-in object itself in v1 (profile.parts = [the stand-in]); it stays visible
        // and is posed by afterTick. A composite airframe would hide the stand-in here (setFilmHidden).
        break;
      }
      case "seat": {
        const v = vehicleOf(m.vehicle);
        if (m.state === 1) v.seats[m.seat] = m.occupant >>> 0;
        else if (m.state === 0) v.seats[m.seat] = 0;
        if (m.state === 2) {
          stats.boardRefusals++;
          stats.lastRefusal = REFUSAL[m.reason] ?? `reason ${m.reason}`;
          pendingBoard = null;
          osd.prompt(`Cannot board: ${stats.lastRefusal}`);
          setTimeout(() => osd.prompt(null), 2500);
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
        if (pilot && pilot.vehicle === v && pilot.predictor) {
          // the pilot's own gun: tracers leave the PREDICTED muzzle (the server's is ~RTT/2 behind)
          const s = pilot.predictor.state;
          const q = FM.orientation(s.heading, s.pitch, s.bank);
          const r = FM.rotate(q, v.profile?.weapons?.[m.mount]?.muzzle ?? [0, 4, 0.5]);
          tracers.add(m, v, [s.x + r[0], s.y + r[1], s.z + r[2]], s);
        } else {
          tracers.add(m, v);
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
          vehicles.delete(m.vehicle >>> 0);
        } else if (m.kind === 5 && mine) { // bail: the server now owns our falling body
          startFall(m, v);
        } else if (m.kind === 6 && mine && fall) { // chute: re-anchor on the server's opening point
          const [x, y, z] = FM.toGlobal(m.cell, m.x, m.y, m.z);
          Object.assign(fall, { x, y, z, vz: m.value, chute: true });
        } else if (m.kind === 7 && mine) { // touchdown (exit placement / landing): back on foot
          if (pilot) stopPiloting("touchdown");
          if (fall) stopFall("touchdown");
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

  function makePredictor(v, m) {
    return createPilotPredictor({ params: v.params, ground, initial: stateFromMsg(m), vCap: m.vCap, startSeq: 1 });
  }

  function startPiloting(v, seat) {
    if (pilot) stopPiloting("re-seat");
    if (!v.params) return;
    const controls = createVehicleControls({ window: win });
    controls.lock();
    controls.throttle = 0;
    let camera = null;
    try {
      camera = createCameraOwner({ liveScene3d: live, THREE, window: win, get sessionHandle() { return sh(); } });
      camera.own();
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
    pilot = {
      audio,
      vehicle: v, seat, controls, camera, acc: 0, predictor: v.last ? makePredictor(v, v.last) : null,
      startedAt: nowSec(), view: "chase", camHeading: null, lastServer: v.last, leadLb: 0, sent: 0,
      unsub: null,
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
    pilot = null;
    try { p.unsub?.(); } catch (_) {}
    try { p.controls.dispose(); } catch (_) {}
    try { p.camera?.release(); p.camera?.dispose(); } catch (_) {}
    try { sh()?.clearVehicleSeat?.(); } catch (_) {}
    try { p.audio?.stop({ fadeSec: 0.6 }); setTimeout(() => { try { p.audio?.dispose(); } catch (_) {} }, 1000); } catch (_) {}
    try { em()?.setMotion?.(localGuid(), MOTION.READY, MOTION.NONCOMBAT, 1.0); } catch (_) {}
    osd.update(null);
    console.log(`[vehicles] stopped piloting (${why})`);
  }

  // ---------------------------------------------------------------- bail-out fall

  function startFall(m, v) {
    const vel = pilot && pilot.predictor && v?.params ? FM.velocity(pilot.predictor.state, v.params) : [0, 0, 0];
    if (pilot) stopPiloting("bail");
    const [x, y, z] = FM.toGlobal(m.cell, m.x, m.y, m.z);
    const controls = createVehicleControls({ window: win });
    controls.lock();
    fall = { x, y, z, vx: vel[0], vy: vel[1], vz: vel[2], heading: m.value, chute: false, acc: 0, controls, vehicle: m.vehicle >>> 0, startedAt: nowSec(), lastWall: undefined };
    fall.unsub = controls.onAction((a) => {
      if (a.type === "exit" && fall && !fall.chute) {
        try { sh().vehicleExit(fall.vehicle, 2); } catch (_) { /* */ }
      }
    });
    osd.prompt("Bailed out — X opens the parachute (it opens by itself at 150 m)");
    setTimeout(() => osd.prompt(null), 3000);
    console.log("[vehicles] bail-out: falling");
  }

  function stopFall(why) {
    if (!fall) return;
    const f = fall;
    fall = null;
    try { f.unsub?.(); } catch (_) {}
    try { f.controls.dispose(); } catch (_) {}
    try { sh()?.clearVehicleSeat?.(); } catch (_) {}
    console.log(`[vehicles] fall ended (${why}) after ${(nowSec() - f.startedAt).toFixed(1)} s`);
  }

  function tickFall() {
    const f = fall;
    const wallNow = nowSec();
    let wallDt = f.lastWall === undefined ? 0 : wallNow - f.lastWall;
    f.lastWall = wallNow;
    f.acc += Math.min(1, Math.max(0, wallDt));
    while (f.acc >= FM.DT) {
      f.acc -= FM.DT;
      stepFall(f, FM.DT);
      const g = ground(f.x, f.y);
      if (!Number.isNaN(g)) {
        if (f.z < g) f.z = g; // the server's Touchdown ends the fall
      }
    }
    const cl = FM.toCellLocal(f.x, f.y, f.z);
    // keyed on the player (the vehicle's seat was released by the server)
    try { sh().setVehicleSeat(localGuid(), cl.cell, cl.x, cl.y, cl.z, f.heading); } catch (_) {}
    writeEntity(localGuid(), f.x, f.y, f.z, FM.orientation(f.heading, 0, 0));
    if (wallNow - f.startedAt > 120) stopFall("timeout"); // never stuck: the server places the body anyway
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
          osd.prompt("Press X again to bail out");
          setTimeout(() => osd.prompt(null), 1500);
          return;
        }
        m = 1;
      }
    }
    try { h.vehicleExit(pilot.vehicle.guid, m); } catch (_) {}
  }

  function sendInput(p) {
    const frames = p.predictor.recentFrames(3);
    if (!frames.length) return;
    const flat = new Int32Array(frames.length * 6);
    frames.forEach((f, i) => {
      flat.set([f.seq, f.throttle, f.pitch, f.roll, f.yaw, f.buttons], i * 6);
    });
    try {
      sh().vehicleInput(p.vehicle.guid, flat);
      stats.inputsSent++;
      p.sent++;
    } catch (_) {
      stats.sendErrors++;
    }
  }

  /** Seat world position + orientation for a vehicle pose. */
  function seatOf(v, pose, seat) {
    const q = FM.orientation(pose.heading, pose.pitch, pose.bank);
    const off = v.profile?.seats?.[seat]?.offset ?? [0, 0, 0];
    const r = FM.rotate(q, off);
    return { x: pose.x + r[0], y: pose.y + r[1], z: pose.z + r[2], q };
  }

  function writeEntity(guid, x, y, z, q) {
    const inst = em()?.entityMap?.get(guid >>> 0);
    if (!inst || !inst.root) return false;
    inst.root.position.set(x, y, z);
    inst.root.quaternion.set(q[1], q[2], q[3], q[0]);
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
    while (p.acc >= FM.DT && n < 30) {
      p.acc -= FM.DT;
      const raw = p.controls.poll(FM.DT);
      p.predictor.stepLocal(raw);
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
    writeEntity(v.guid, pose.x, pose.y, pose.z, q);
    writeEntity(localGuid(), seat.x, seat.y, seat.z, q);

    // camera
    if (p.camera && p.camera.owned) {
      if (p.view === "cockpit") {
        const eye = FM.rotate(q, [0, COCKPIT.forward, COCKPIT.up]);
        p.camera.write({ pos: [seat.x + eye[0], seat.y + eye[1], seat.z + eye[2]], h: pose.heading, p: pose.pitch, r: pose.bank, fov: COCKPIT.fov });
      } else {
        if (p.camHeading === null) p.camHeading = pose.heading;
        p.camHeading = FM.wrapHeading(p.camHeading + angleDiff(pose.heading, p.camHeading) * (1 - Math.exp(-dt / CHASE.headingTau)));
        const ch = p.camHeading;
        const ex = pose.x - Math.sin(ch) * CHASE.back;
        const ey = pose.y - Math.cos(ch) * CHASE.back;
        let ez = pose.z + CHASE.up;
        const g = ground(ex, ey);
        if (!Number.isNaN(g) && ez < g + 2) ez = g + 2;
        p.camera.write({ pos: [ex, ey, ez], h: ch, p: CHASE.pitch + pose.pitch * 0.4, r: pose.bank * 0.25, fov: CHASE.fov });
      }
    }

    // client streaming: the load point leads the aircraft by velocity × lead seconds (DESIGN §6.3)
    try {
      const vel = FM.velocity(pose, v.params);
      const lead = Number.isFinite(v.profile.leadSeconds) ? v.profile.leadSeconds : 6;
      const lp = FM.toCellLocal(pose.x + vel[0] * lead, pose.y + vel[1] * lead, pose.z);
      const lb = (lp.cell >>> 16) << 16;
      if (lb !== p.leadLb && win.__worldStreamer && typeof win.__worldStreamer.onPositionUpdate === "function") {
        p.leadLb = lb;
        win.__worldStreamer.onPositionUpdate({ guid: localGuid(), landblockId: lp.cell });
      }
    } catch (_) { /* streaming hint only */ }

    // engine hum: throttle drives the pitch, speed the brightness (in-ear in the cockpit, panned at the aircraft outside)
    try {
      const thr = p.controls.status().throttle;
      p.audio?.update({ throttle: 0.6 + thr * 1.4, speed: pose.speed, level: pose.mode === FM.MODE.PARKED && thr < 0.05 ? 0.4 : 1, fpv: p.view === "cockpit", pos: [pose.x, pose.y, pose.z] });
    } catch (_) { /* audio never breaks flight */ }

    // OSD
    const g0 = ground(pose.x, pose.y);
    const st = p.predictor.stats();
    const raw = p.controls.status();
    osd.update({
      name: v.profile?.displayName, speed: pose.speed, agl: Number.isNaN(g0) ? 0 : pose.z - g0, heading: pose.heading,
      throttle: raw.throttle, mode: pose.mode, ammo: p.lastServer?.ammo, vCap: p.predictor.vCap,
      boost: !!(raw.override?.boost), land: false,
      corr: `corr ${st.corrections} (last ${st.lastCorrectionM.toFixed(2)} m)`,
      warn: p.lastServer && (p.lastServer.flags & 0x04),
    });
  }

  // ---------------------------------------------------------------- observers + board prompt

  function tickObservers() {
    const t = nowSec();
    for (const v of vehicles.values()) {
      if (pilot && pilot.vehicle === v) continue;
      if (!v.track.count) continue;
      const pose = v.track.pose(t);
      if (!pose) continue;
      const q = FM.orientation(pose.heading, pose.pitch, pose.bank);
      writeEntity(v.guid, pose.x, pose.y, pose.z, q);
      const occ = v.seats[0] >>> 0;
      if (occ && occ !== localGuid() && v.profile) {
        const seat = seatOf(v, pose, 0);
        writeEntity(occ, seat.x, seat.y, seat.z, q);
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

  let promptVehicle = null;
  function tickPrompt() {
    if (pilot || caps.granted === null || !(caps.granted & CAP_PILOT)) {
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
    if (!promptVehicle || pilot) return;
    api.board(promptVehicle.guid);
  };
  win.addEventListener("keydown", onKeyB, true);

  // ---------------------------------------------------------------- frame hook

  function afterTick(ts, dtMs) {
    if (disposed) return;
    const dt = Number.isFinite(dtMs) ? (dtMs > 5 ? dtMs / 1000 : dtMs) : 1 / 60;
    stats.frames++;
    handshake();
    drainInbox();
    if (pilot) tickPilot(dt);
    else if (fall) tickFall();
    tickObservers();
    pruneVehicles();
    tickPrompt();
    tracers.tick(dt);
  }

  live.vehicles = { afterTick };

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
        })),
        fall: fall ? { x: fall.x, y: fall.y, z: fall.z, vz: fall.vz, chute: fall.chute, agl: fall.z - ground(fall.x, fall.y) } : null,
        pilot: pilot ? {
          vehicle: pilot.vehicle.guid, seat: pilot.seat, view: pilot.view, sent: pilot.sent,
          state: pilot.predictor ? { ...pilot.predictor.state } : null,
          seq: pilot.predictor?.seq ?? null, vCap: pilot.predictor?.vCap ?? null,
          predictor: pilot.predictor?.stats() ?? null, controls: pilot.controls.status(),
          server: pilot.lastServer ? { step: pilot.lastServer.step, ack: pilot.lastServer.ack, mode: pilot.lastServer.mode, speed: pilot.lastServer.speed } : null,
        } : null,
        wire,
        tracers: tracers.stats(),
      };
    },
    vehicles: () => [...vehicles.values()],
    events: () => events.slice(),
    nearest: () => nearestBoardable()?.guid ?? null,
    board(guid) {
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
    spawn(profile) { try { sh().sendChat(`@vehicle spawn ${profile ?? ""}`.trim()); return true; } catch (_) { return false; } },
    despawn(all) { try { sh().sendChat(all ? "@vehicle despawn all" : "@vehicle despawn"); return true; } catch (_) { return false; } },
    get piloting() { return !!pilot; },
    get falling() { return !!fall; },
    openChute() { if (fall) { try { sh().vehicleExit(fall.vehicle, 2); } catch (_) {} return true; } return false; },
    dispose() {
      disposed = true;
      stopPiloting("dispose");
      stopFall("dispose");
      try { win.removeEventListener("keydown", onKeyB, true); } catch (_) {}
      osd.dispose();
      tracers.dispose();
      if (live.vehicles && live.vehicles.afterTick === afterTick) delete live.vehicles;
      if (win.__vehicles === api) delete win.__vehicles;
    },
  };
  win.__vehicles = api;
  console.log("[vehicles] installed (?vehicles=on): capability handshake after entering the world");
  return api;
}
