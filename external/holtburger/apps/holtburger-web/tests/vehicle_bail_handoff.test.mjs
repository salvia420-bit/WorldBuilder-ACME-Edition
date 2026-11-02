// tests/vehicle_bail_handoff.test.mjs — the bail hand-off (scene3d/vehicle/index.js BAIL_HANDOFF), behavioural.
//
// ACE's VehicleBailout.Bail releases the seat (VehicleSeat Empty) and THEN broadcasts the Bail event; on the 1070 the
// two reached the client 1-4 frames apart (film takes D2 / D2-t2 / D2-2-t1 / D2-2). In those frames the old client had
// already stopped piloting: the camera was released and the aircraft was drawn from its observer track, whose only
// samples were the PARKED ones from before boarding (the spawn, km away) — the Hellcat vanished for 1-4 frames at the
// bail and the camera jumped. These checks drive installVehicles with fakes (no DOM, no three; a fake camera where
// the camera is checked) through that exact sequence:
//   H1  between the seat release and the Bail the aircraft stays on its flight path (dead-reckoned), never at the stale
//       parked track sample, and the body rides the seat;
//   H2  at the Bail the drawn body continues from where it was drawn (no jump to the server's bail point), then eases
//       onto the server's twin;
//   H3  the aircraft hands over from the dead reckoning to its fresh observer track without a jump;
//   H4  a seat released in the air with no Bail ends the hand-off after BAIL_HANDOFF.maxSec; a parked exit starts none.
//   H5  the fall twin draws between its 30 Hz steps: under a jittered cadence (0-step / 2-step frames, film take D2-2)
//       the body still moves every frame along the fall's velocity;
//   H6  the bail frame and after (film take D2-3), at 30 / 60 fps and jittered, the server 10 m and 37 m behind: the
//       body never moves backward, no single-frame speed of the body, the camera or the aircraft exceeds 1.5x its
//       neighbour's, the camera-to-aircraft distance has no step, the aircraft never falls back past the body; also
//       with vsync-quantized / random frame lengths and the states 0-20 ms late on top (out of phase with the frames);
//   H7  a teleport in the air (ACE OnPlayerTeleport: the seat released, no Bail, no Touchdown) ends the hand-off at its
//       PlayerTeleport and never re-locks the body to the old site; a teleport while piloting starts none; with the
//       destination applied between frames (the seat release a frame or 1 s earlier), the movement tick that runs
//       before the PlayerTeleport dispatch never snaps the body back (vehicles.beforeMovement); a normal bail, also on a
//       wasm that never slaves the body (a stale pkg), is never taken for a teleport;
//   H8  dispose during a hand-off releases the seat lock it set (keyed on the player: nothing else would);
//   H9  a landing + exit on the ground never draws the aircraft at its stale pre-boarding sample.
//
// Run: node tests/vehicle_bail_handoff.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let fakeNowMs = 1000000;
Object.defineProperty(globalThis, "performance", { value: { now: () => fakeNowMs }, configurable: true, writable: true });

const FM = await import("../scene3d/vehicle/flight_model.js");
const VI = await import("../scene3d/vehicle/index.js");
const golden = JSON.parse(readFileSync(join(HERE, "../docs/vehicles-2026-11-01/flight/flight-golden.json"), "utf8"));

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [OK] ${name}`); } catch (e) { failed++; console.log(`  [FAIL] ${name}: ${e && e.message ? e.message : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const LOCAL = 0x50000001, VEH = 0x800145c5;
const SEAT_OFF = [0, -1, 1.2];

/**
 * `camera`: a fake persp camera, so film's camera owner really owns it (the pilot / hand-off / fall camera writes).
 * `slaved: false`: a wasm that never applies the seat lock (a stale pkg): the body stays on the ground at the spawn.
 */
function makeWorld({ camera = false, slaved = true } = {}) {
  const inbox = [];
  const v3 = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } });
  const rig = () => ({ root: { position: v3(), quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { Object.assign(this, { x, y, z, w }); } }, scale: { x: 1 } } });
  const entityMap = new Map([[LOCAL, rig()], [VEH, rig()]]);
  const motions = [];
  const seatCalls = { set: 0, clear: 0 };
  const seatLog = []; // ["set" | "clear", guid, fake ms]
  // the wasm side: the seat lock (vehicle_link.rs), the movement tick's snap of the body onto it (movement.rs), the
  // local pose the wasm publishes (getLocalPlayerPose; the recv loop publishes a server position at once), and the
  // client events pumpNetFrame dispatches (kind 33 PlayerTeleport → app/client_events.js → onTeleport)
  const link = { seat: null, released: null, body: slaved ? null : FM.toCellLocal(26300, 16950, 2), events: [] };
  const sh = {
    drainVehicleMessages: () => JSON.stringify(inbox.splice(0)),
    vehicleCapabilities() {}, vehicleInput() {}, vehicleExit() {}, vehicleBoard() {}, sendChat() {},
    setVehicleSeat(g, cell, x, y, z) {
      seatCalls.set++; seatLog.push(["set", g >>> 0, fakeNowMs]);
      if (link.released === g >>> 0) return false;
      link.seat = { g: g >>> 0, cell, x, y, z };
      return true;
    },
    clearVehicleSeat() { seatCalls.clear++; seatLog.push(["clear", 0, fakeNowMs]); link.seat = null; link.released = null; },
    getLocalPlayerPose: () => (link.body ? { landblockId: link.body.cell, x: link.body.x, y: link.body.y, z: link.body.z, heading: 0, isOnGround: false, free() {} } : undefined),
    terrainHeightAt: () => 0,
  };
  // the recv loop's vehicle hook (vehicle_link.rs on_s2c), at arrival: a seat release frees the lock on that vehicle,
  // a Touchdown naming us any lock (and places the body)
  inbox.push = (...ms) => {
    for (const m of ms) {
      if (m.type === "seat" && m.state === 0 && link.seat && link.seat.g === m.vehicle >>> 0) { link.seat = null; link.released = m.vehicle >>> 0; }
      if (m.type === "event" && m.kind === 7 && m.subject >>> 0 === LOCAL) {
        if (link.seat) { link.seat = null; link.released = m.vehicle >>> 0; }
        if (m.cell) link.body = { cell: m.cell, x: m.x, y: m.y, z: m.z };
      }
    }
    return Array.prototype.push.apply(inbox, ms);
  };
  const win = {
    location: { search: "?vehicles=on&vehicleAudio=off&vehicleChute=off&vehicleFallAnim=off&vehicleBoardAnim=off" },
    document: null, addEventListener() {}, removeEventListener() {},
    getLocalPlayerGuid: () => LOCAL, __sessionHandle: sh,
  };
  const live = { entityManager: { entityMap, setMotion: (g, m) => motions.push([g, m]), setFilmHidden() {} }, sessionHandle: sh };
  if (camera) live.camera = { position: v3(), quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { Object.assign(this, { x, y, z, w }); } }, fov: 70, userData: {} };
  const api = VI.installVehicles({ liveScene3d: live, THREE: null, window: win });
  // scene3d/index.js tick: syncTickHop (vehicles.beforeMovement, then the wasm movement tick) → tickPerFrame
  // (pumpNetFrame: the client events) → vehicles.afterTick
  const frame = (ms = 1000 / 30) => {
    fakeNowMs += ms;
    live.vehicles?.beforeMovement?.();
    if (link.seat && slaved) link.body = { cell: link.seat.cell, x: link.seat.x, y: link.seat.y, z: link.seat.z };
    for (const k of link.events.splice(0)) if (k === 33) live.vehicles?.onTeleport?.();
    live.vehicles.afterTick(fakeNowMs, ms);
  };
  /** Between frames: PlayerTeleport + its destination UpdatePosition, as the recv loop applies them (kind 33 queued). */
  const teleport = (p) => { link.body = FM.toCellLocal(p.x, p.y, p.z); link.events.push(33); };
  /** The wasm body (global AC metres). */
  const body = () => (link.body ? (([x, y, z]) => ({ x, y, z }))(FM.toGlobal(link.body.cell, link.body.x, link.body.y, link.body.z)) : null);
  const pos = (g) => ({ ...entityMap.get(g).root.position });
  // the camera in the AC frame (three = AC x, z, -y)
  const cam = () => (live.camera ? { x: live.camera.position.x, y: -live.camera.position.z, z: live.camera.position.y } : null);
  return { inbox, api, frame, pos, cam, motions, seatCalls, seatLog, live, link, teleport, body };
}

function stateMsg(s, step, flags = 0, ack = 0, vCap = golden.params.vMax) {
  const cl = FM.toCellLocal(s.x, s.y, s.z);
  return { type: "state", vehicle: VEH, step, ack, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, heading: s.heading, pitch: s.pitch, bank: s.bank,
    speed: s.speed, vCap, ammo: 200, mode: s.mode, flags };
}
const PROFILE = { type: "profile", vehicle: VEH, profileKey: "hellcat-demo", displayName: "Hellcat", ...golden.params, leadSeconds: 6, seats: [{ offset: SEAT_OFF }], weapons: [] };
// parked at the spawn; flying 700 m east of it at 300 m (under the golden params' 450 m ceiling), heading east at vMax
const SPAWN = { x: 26300, y: 16950, z: 2, heading: 1.57, pitch: 0, bank: 0, speed: 0, mode: FM.MODE.PARKED };
const FLY = { x: 27000, y: 16960, z: 300, heading: Math.PI / 2, pitch: 0, bank: 0, speed: golden.params.vMax, mode: FM.MODE.FLIGHT };

/** Board, fly n frames; returns the world with the pilot in the air. */
function airborne(nFrames = 20, opts = {}) {
  const w = makeWorld(opts);
  w.inbox.push({ type: "ack", granted: 3 }, PROFILE, stateMsg(SPAWN, 10), stateMsg(SPAWN, 13), stateMsg(SPAWN, 16));
  w.frame();
  // boarded; the predictor adopts the server's flight state (ack 0, no local history yet)
  w.inbox.push({ type: "seat", vehicle: VEH, seat: 0, occupant: LOCAL, state: 1 }, stateMsg(FLY, 4000, 1, 0));
  w.frame();
  for (let i = 0; i < nFrames; i++) w.frame();
  assert(w.api.piloting, "piloting");
  return w;
}

console.log("H1 seat released in the air, the Bail event 3 frames later");
await check("the aircraft stays on its flight path, never at the stale parked sample; the body rides the seat", () => {
  const w = airborne();
  const v0 = w.pos(VEH), b0 = w.pos(LOCAL);
  assert(dist(v0, SPAWN) > 300, "flying far from the spawn");
  w.inbox.push({ type: "seat", vehicle: VEH, seat: 0, occupant: 0, state: 0 });
  let prevV = v0, prevB = b0;
  for (let i = 0; i < 3; i++) {
    w.frame();
    const v = w.pos(VEH), b = w.pos(LOCAL);
    assert(dist(v, SPAWN) > 300, `frame ${i}: the aircraft drawn at the stale parked track sample`);
    const dv = dist(v, prevV), db = dist(b, prevB);
    assert(dv > 1.5 && dv < 6, `frame ${i}: aircraft step ${dv.toFixed(2)} m (~97 m/s ≈ 3.2 m/frame)`);
    assert(db > 1.5 && db < 6, `frame ${i}: body step ${db.toFixed(2)} m`);
    prevV = v; prevB = b;
  }
  const st = w.api.status();
  assert(st.handoff && st.stats.handoffs === 1 && !w.api.piloting && !w.api.falling, "in the hand-off");
  // the seat release's Ready is deferred to the Bail (the rig keeps sitting in the seat)
  assert(!w.motions.some(([g, m]) => g === LOCAL && m === VI.MOTION.READY), "no Ready before the Bail");
});

console.log("H2 the Bail: the body continues from where it was drawn");
await check("no jump at the Bail, then the body eases onto the server's twin", () => {
  const w = airborne();
  w.inbox.push({ type: "seat", vehicle: VEH, seat: 0, occupant: 0, state: 0 });
  w.frame(); w.frame();
  const b0 = w.pos(LOCAL);
  // the server's bail point: its seat ~10 m BEHIND the predicted one (the prediction lead)
  const srv = { x: b0.x - 10, y: b0.y, z: b0.z };
  const cl = FM.toCellLocal(srv.x, srv.y, srv.z);
  w.inbox.push({ type: "event", vehicle: VEH, kind: 5, subject: LOCAL, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, value: FLY.heading, step: 4100 });
  w.frame();
  assert(w.api.falling, "falling");
  const st = w.api.status();
  assert(st.fall.handoffMs > 0 && st.fall.offsetM > 5, `hand-off ${st.fall.handoffMs} ms, offset ${st.fall.offsetM}`);
  assert(st.stats.lastHandoff && st.stats.lastHandoff.why === "bail", "ended by the Bail");
  const b1 = w.pos(LOCAL);
  const step = dist(b1, b0);
  assert(step > 1.5 && step < 6, `the body's step on the Bail frame ${step.toFixed(2)} m (a jump to the server point would be ~10 m back)`);
  assert(b1.x > b0.x, "still moving forward");
  assert(w.motions.some(([g, m]) => g === LOCAL && m === VI.MOTION.READY), "the deferred Ready at the Bail");
  // ~2 s later the drawn body is the twin (offset gone)
  for (let i = 0; i < 60; i++) w.frame();
  assert(w.api.status().fall.offsetM === 0, "offset decayed");
});

console.log("H3 the aircraft hands over to its fresh observer track");
await check("dead reckoning → track (the parked samples dropped) with no jump", () => {
  const w = airborne();
  w.inbox.push({ type: "seat", vehicle: VEH, seat: 0, occupant: 0, state: 0 });
  w.frame();
  // the server's derelict aircraft: 10 Hz states, ~15 m behind the predicted one (and the same height)
  let prev = w.pos(VEH), maxStep = 0, step = 4200;
  const base = { ...prev };
  for (let i = 0; i < 60; i++) {
    if (i % 3 === 0) { const k = i / 3; w.inbox.push(stateMsg({ ...FLY, x: base.x - 15 + k * FLY.speed * 0.1, z: base.z, mode: FM.MODE.DERELICT }, step)); step += 3; }
    w.frame();
    const v = w.pos(VEH);
    maxStep = Math.max(maxStep, dist(v, prev));
    assert(dist(v, SPAWN) > 300, `frame ${i}: at the parked sample`);
    prev = v;
  }
  assert(maxStep < 6, `largest aircraft step ${maxStep.toFixed(2)} m (no pop; ~3.2 m/frame + the hand-over)`);
});

console.log("H4 the ends");
await check("no Bail: the hand-off ends after maxSec and the body is the player's again", () => {
  const w = airborne();
  const clear0 = w.seatCalls.clear;
  w.inbox.push({ type: "seat", vehicle: VEH, seat: 0, occupant: 0, state: 0 });
  for (let i = 0; i < Math.ceil(VI.BAIL_HANDOFF.maxSec * 30) + 3; i++) w.frame();
  const st = w.api.status();
  assert(!st.handoff && st.stats.lastHandoff && st.stats.lastHandoff.why === "timeout", JSON.stringify(st.stats.lastHandoff));
  assert(w.seatCalls.clear > clear0 && w.motions.some(([g, m]) => g === LOCAL && m === VI.MOTION.READY), "seat lock cleared + Ready");
});
await check("a parked exit starts no hand-off", () => {
  const w = makeWorld();
  w.inbox.push({ type: "ack", granted: 3 }, PROFILE, stateMsg(SPAWN, 10));
  w.frame();
  w.inbox.push({ type: "seat", vehicle: VEH, seat: 0, occupant: LOCAL, state: 1 });
  for (let i = 0; i < 5; i++) w.frame();
  w.inbox.push({ type: "seat", vehicle: VEH, seat: 0, occupant: 0, state: 0 });
  w.frame();
  const st = w.api.status();
  assert(st.stats.handoffs === 0 && !st.handoff, "no hand-off on the ground");
  assert(w.motions.some(([g, m]) => g === LOCAL && m === VI.MOTION.READY), "Ready at once");
});
await check("index.js: the Bail adopts the hand-off camera and blends the chase framing into the fall camera", () => {
  const src = readFileSync(join(HERE, "../scene3d/vehicle/index.js"), "utf8");
  assert(/const ho = endHandoff\("bail", true\)/.test(src) && /camera = ho\.camera && ho\.camera\.owned \? ho\.camera : null/.test(src), "adopts the camera");
  assert(/f\.camBlend/.test(src) && /BAIL_HANDOFF\.camBlendSec/.test(src) && /cb\.rel\[0\]/.test(src), "the blend, relative to the body");
  assert(/if \(!inAir\) \{ try \{ p\.camera\?\.release\(\)/.test(src), "a seat released in the air keeps the camera");
});

const SEAT_RELEASE = Object.freeze({ type: "seat", vehicle: VEH, seat: 0, occupant: 0, state: 0 });
const bailAt = (p, heading, step = 4100) => {
  const cl = FM.toCellLocal(p.x, p.y, p.z);
  return { type: "event", vehicle: VEH, kind: 5, subject: LOCAL, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, value: heading, step };
};

console.log("H5 the fall twin draws between its 30 Hz steps (film take D2-2)");
await check("10 ms / 56.7 ms frames (0 steps, then 2): the body moves every frame, along the fall's velocity", () => {
  const w = airborne();
  w.inbox.push(SEAT_RELEASE);
  w.frame(); w.frame();
  const b0 = w.pos(LOCAL);
  w.inbox.push(bailAt({ x: b0.x - 10, y: b0.y, z: b0.z }, FLY.heading));
  for (let i = 0; i < 60; i++) w.frame();
  assert(w.api.falling && !(w.api.status().fall.offsetM > 0), "falling, the bail offset eased out");
  let prev = w.pos(LOCAL), still = 0, back = 0, minStep = Infinity;
  for (let i = 0; i < 30; i++) {
    w.frame(i % 2 ? 2000 / 30 - 10 : 10);
    const b = w.pos(LOCAL);
    const step = dist(b, prev);
    minStep = Math.min(minStep, step);
    if (step < 0.05) still++;
    if (!(b.x - prev.x > 0)) back++; // the bail heading is east: the fall's horizontal velocity is +x
    prev = b;
  }
  assert(still === 0 && back === 0, `${still} of 30 frames stood still, ${back} did not move along the fall (min step ${minStep.toFixed(3)} m)`);
});

/**
 * The film's bail (take D2-3) through ACE's order: a Hellcat at 400 km/h (vMax 111, boost), the seat in its basket;
 * the server's derelict aircraft `lag` m BEHIND the predicted one (the prediction lead), stepping DERELICT_INPUT, its
 * 10 Hz observer states 50 ms late; the seat released, the Bail 2 frames later at the server's seat. `cadence`: 30, 60
 * (fps), "jitter" (10 / 56.7 ms), "vsync" (16.7 / 33.3 / 50 ms at 20 / 60 / 20 %) or "random" (8-58 ms); `netJit`: up
 * to that many ms more on each state's arrival (seeded: `seed`), so the states reach the client out of phase with the
 * frames. Rows {t, b (body), a (aircraft), c (camera)}: the frame before the Bail, then 60.
 */
function filmBail(lag, cadence, { seed = 1, netJit = 0 } = {}) {
  const vMax = 111, params = { ...golden.params, vMax }, seatOff = [0, 0, 5.75];
  const w = makeWorld({ camera: true });
  const msg = (s, step, flags = 0) => stateMsg(s, step, flags, 0, vMax);
  let n = 0, rs = seed >>> 0;
  const rnd = () => (rs = (Math.imul(rs, 1103515245) + 12345) >>> 0) / 4294967296;
  const ms = () => {
    if (cadence === "jitter") return n++ % 2 ? 2000 / 30 - 10 : 10;
    if (cadence === "vsync") { const r = rnd(); return (1000 / 60) * (r < 0.2 ? 1 : r < 0.8 ? 2 : 3); }
    if (cadence === "random") return 8 + rnd() * 50;
    return 1000 / cadence;
  };
  w.inbox.push({ type: "ack", granted: 3 }, { ...PROFILE, vMax, seats: [{ offset: seatOff }] }, msg(SPAWN, 10), msg(SPAWN, 13));
  w.frame();
  w.inbox.push({ type: "seat", vehicle: VEH, seat: 0, occupant: LOCAL, state: 1 }, msg({ ...FLY, speed: vMax }, 4000, 1));
  w.frame();
  w.api.setSticks({ throttle: 1, boost: true }, 1e6);
  for (const t0 = fakeNowMs; fakeNowMs - t0 < 3000;) w.frame(ms());
  const ps = w.api.status().pilot.state;
  const srv = { ...ps, x: ps.x - Math.sin(ps.heading) * lag, y: ps.y - Math.cos(ps.heading) * lag, mode: FM.MODE.DERELICT };
  let step = 5000, acc = 0;
  const late = [];
  const run = () => {
    const dt = ms();
    for (acc += dt / 1000; acc >= FM.DT; acc -= FM.DT) {
      FM.step(srv, FM.DERELICT_INPUT, params, vMax, () => 0, FM.DT);
      // (an ordered stream: a state never overtakes the one before)
      if (++step % 3 === 0) late.push({ at: Math.max(late.at(-1)?.at ?? 0, fakeNowMs + 50 + (netJit ? rnd() * netJit : 0)), m: msg(srv, step) });
    }
    while (late.length && late[0].at <= fakeNowMs) w.inbox.push(late.shift().m);
    w.frame(dt);
  };
  w.inbox.push(SEAT_RELEASE);
  run(); run();
  const r = FM.rotate(FM.orientation(srv.heading, srv.pitch, srv.bank), seatOff);
  w.inbox.push(bailAt({ x: srv.x + r[0], y: srv.y + r[1], z: srv.z + r[2] }, srv.heading, step));
  const rows = [];
  const rec = () => rows.push({ t: fakeNowMs, b: w.pos(LOCAL), a: w.pos(VEH), c: w.cam() });
  rec();
  for (let i = 0; i < 60; i++) { run(); rec(); }
  return { w, rows };
}

console.log("H6 the bail frame and after (film take D2-3)");
/**
 * The continuity checks on filmBail's rows. The size step: at most 5 % of the camera-to-aircraft distance per frame
 * (fixed cadences), or `sizePerSec` of it per second (a cadence of mixed frame lengths: 5 % per 33 ms = 1.5 / s).
 */
function assertContinuity(w, rows, { sizePerSec = null } = {}) {
  assert(w.api.falling && w.api.status().fall.handoffMs > 0, "a bail after the hand-off");
  const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
  const fwd = (d) => d.x * Math.sin(FLY.heading) + d.y * Math.cos(FLY.heading);
  const len = (d) => Math.hypot(d.x, d.y, d.z);
  const speed = (k, i) => len(sub(rows[i][k], rows[i - 1][k])) / ((rows[i].t - rows[i - 1].t) / 1000);
  let relMax = -Infinity;
  for (let i = 1; i < rows.length; i++) {
    const dt = (rows[i].t - rows[i - 1].t) / 1000;
    const bf = fwd(sub(rows[i].b, rows[i - 1].b)) / dt;
    assert(bf > 1, `frame ${i}: the body moved ${bf.toFixed(1)} m/s along the heading (backward / stalled)`);
    if (i >= 2) {
      for (const [k, name] of [["b", "body"], ["c", "camera"], ["a", "aircraft"]]) {
        const s0 = speed(k, i - 1), s1 = speed(k, i);
        assert(Math.max(s0, s1) <= 1.5 * Math.min(s0, s1), `frame ${i}: the ${name}'s speed ${s0.toFixed(1)} -> ${s1.toFixed(1)} m/s`);
      }
    }
    const d0 = len(sub(rows[i - 1].a, rows[i - 1].c)), d1 = len(sub(rows[i].a, rows[i].c));
    const sizeMax = sizePerSec === null ? 0.05 : sizePerSec * dt;
    assert(Math.abs(d1 - d0) <= sizeMax * d0, `frame ${i} (${(dt * 1000).toFixed(1)} ms): camera-to-aircraft ${d0.toFixed(2)} -> ${d1.toFixed(2)} m (a size step)`);
    // ahead of the body along the heading: it may only grow (the observer track's clock filter wobbles it by cm)
    const rel = fwd(sub(rows[i].a, rows[i].b));
    relMax = Math.max(relMax, rel);
    assert(rel > relMax - 0.3, `frame ${i}: the aircraft fell back ${(relMax - rel).toFixed(2)} m relative to the body`);
  }
}
for (const cadence of [30, 60, "jitter"]) {
  for (const lag of [10, 37]) {
    await check(`${cadence === "jitter" ? "jittered" : `${cadence} fps`}, the server ${lag} m behind: no backward step, no >1.5x speed step (body, camera, aircraft), no size step, the aircraft never falls back past the body`, () => {
      const { w, rows } = filmBail(lag, cadence);
      assertContinuity(w, rows);
    });
  }
}
// the states out of phase with the frames: each waits a different time to be drained, so the fresh observer track's
// clock offset (min-filtered) drops in steps for its first second — applied at once, each drop moved the aircraft
// several metres ahead in one frame (re-review: 273 m/s for one 16.7 ms frame, the camera-to-aircraft distance +15 %)
// (seeds that popped on the min-filtered clock; with the slewed one 111 cadence/seed pairs x 2 leads all pass)
for (const [cadence, seed] of [["vsync", 5], ["vsync", 7], ["random", 1]]) {
  for (const lag of [10, 37]) {
    await check(`${cadence} frames (seed ${seed}), the states 0-20 ms late on top, the server ${lag} m behind: the same, the aircraft never pops ahead`, () => {
      const { w, rows } = filmBail(lag, cadence, { seed, netJit: 20 });
      assertContinuity(w, rows, { sizePerSec: 1.5 });
    });
  }
}

console.log("H7 a teleport in the air: the seat released, no Bail, no Touchdown (ACE OnPlayerTeleport)");
await check("its PlayerTeleport ends the hand-off at once and the body is never re-locked to the old site", () => {
  const w = airborne();
  w.inbox.push(SEAT_RELEASE);
  w.frame(); w.frame();
  assert(w.api.status().handoff && w.seatLog.at(-1)[0] === "set" && w.seatLog.at(-1)[1] === LOCAL, "the hand-off locks the body to the seat");
  const mark = w.seatLog.length;
  w.live.vehicles.onTeleport?.(); // app/client_events.js kind 33 — dispatched before this frame's vehicle tick
  for (let i = 0; i < 60; i++) w.frame();
  const after = w.seatLog.slice(mark), sets = after.filter(([k]) => k === "set").length;
  const st = w.api.status();
  assert(sets === 0, `${sets} setVehicleSeat after the teleport (each one snaps the body back over the destination)`);
  assert(after.length && after[0][0] === "clear", "the lock released at the PlayerTeleport");
  assert(!st.handoff && st.stats.lastHandoff && st.stats.lastHandoff.why === "teleport" && !w.api.falling && !w.api.piloting, JSON.stringify(st.stats.lastHandoff));
  assert(w.motions.some(([g, m]) => g === LOCAL && m === VI.MOTION.READY), "the body is the player's again (Ready)");
});
await check("a PlayerTeleport while still piloting (its seat release drained after) starts no hand-off", () => {
  const w = airborne();
  const mark = w.seatLog.length;
  w.live.vehicles.onTeleport?.();
  w.inbox.push(SEAT_RELEASE);
  for (let i = 0; i < 10; i++) w.frame();
  const st = w.api.status();
  assert(st.stats.handoffs === 0 && !st.handoff && !w.api.piloting, `hand-offs ${st.stats.handoffs}`);
  assert(!w.seatLog.slice(mark).some(([k]) => k === "set"), "no seat lock after the teleport");
});
// ACE puts the seat release on the UIQueue bundle and PlayerTeleport + the destination UpdatePosition on the
// SmartboxQueue bundle; NetworkSession sends one bundle per pass, >= 5 ms apart (and a fog reset delays the teleport
// 1 s). With a frame boundary between them the hand-off has locked the body when the recv loop applies the
// destination, and the next movement tick runs BEFORE the kind-33 dispatch (scene3d/index.js syncTickHop).
const DEST = { x: 25000, y: 15000, z: 40 }; // a lifestone ~2 km away, on the ground
for (const [label, framesBetween] of [["the next frame (>= 5 ms after the seat release)", 1], ["1 s later (ACE's fog reset)", 30]]) {
  await check(`PlayerTeleport + the destination ${label}: the movement tick never snaps the body back to the old site`, () => {
    const w = airborne();
    w.inbox.push(SEAT_RELEASE);
    for (let i = 0; i < framesBetween; i++) w.frame(); // the release drained: the hand-off holds the body
    assert(w.api.status().handoff && w.link.seat && w.link.seat.g === LOCAL, "the hand-off locks the body (keyed on the player)");
    const mark = w.seatLog.length;
    w.teleport(DEST); // between frames: the recv loop applied the destination, kind 33 queued
    for (let i = 0; i < 30; i++) w.frame();
    const b = w.body();
    assert(b && dist(b, DEST) < 0.01, `the body ${dist(b, DEST).toFixed(1)} m from the destination (snapped back onto the lock at the old site)`);
    assert(!w.link.seat, "no seat lock left");
    assert(!w.seatLog.slice(mark).some(([k]) => k === "set"), "no setVehicleSeat after the destination landed");
    const st = w.api.status();
    assert(!st.handoff && st.stats.lastHandoff && st.stats.lastHandoff.why === "teleport" && !w.api.falling && !w.api.piloting, JSON.stringify(st.stats.lastHandoff));
    assert(w.motions.some(([g, m]) => g === LOCAL && m === VI.MOTION.READY), "the body is the player's again (Ready)");
  });
}
await check("the seat release and the teleport in the same gap between frames: no hand-off, the body at the destination", () => {
  const w = airborne();
  w.inbox.push(SEAT_RELEASE);
  w.teleport(DEST);
  for (let i = 0; i < 30; i++) w.frame();
  const st = w.api.status();
  assert(dist(w.body(), DEST) < 0.01 && !w.link.seat, `the body ${dist(w.body(), DEST).toFixed(1)} m from the destination`);
  assert(st.stats.handoffs === 0 && !st.handoff && !w.api.piloting, `hand-offs ${st.stats.handoffs}`);
});
await check("a bail through the same wasm model (the body on the hand-off's locks) is never taken for a teleport", () => {
  for (const ms of [1000 / 60, 1000 / 30, 100]) {
    const w = airborne();
    w.inbox.push(SEAT_RELEASE);
    w.frame(ms); w.frame(ms); w.frame(ms);
    const b0 = w.pos(LOCAL);
    w.inbox.push(bailAt({ x: b0.x - 30, y: b0.y, z: b0.z }, FLY.heading));
    w.frame(ms);
    const st = w.api.status();
    assert(w.api.falling && st.stats.lastHandoff && st.stats.lastHandoff.why === "bail", `${ms.toFixed(1)} ms frames: ${JSON.stringify(st.stats.lastHandoff)}`);
  }
});
await check("a wasm that never slaves the body (a stale pkg: it stays on the ground) never has it taken for a teleport", () => {
  const w = airborne(20, { slaved: false });
  w.inbox.push(SEAT_RELEASE);
  w.frame(); w.frame(); w.frame();
  const b0 = w.pos(LOCAL);
  w.inbox.push(bailAt({ x: b0.x - 10, y: b0.y, z: b0.z }, FLY.heading));
  w.frame();
  const st = w.api.status();
  assert(dist(w.body(), SPAWN) < 0.01, "the wasm body stayed on the ground");
  assert(w.api.falling && st.stats.lastHandoff && st.stats.lastHandoff.why === "bail", JSON.stringify(st.stats.lastHandoff));
});
await check("the hook: client_events.js kind 33 (before the ?portalSpace gate); tickHandoff exits on a teleport before locking", () => {
  const ev = readFileSync(join(HERE, "../app/client_events.js"), "utf8");
  const at = ev.indexOf("evt.kind === ClientEventKind.PORTAL_SPACE_ENTERED");
  const hook = ev.indexOf("liveScene3d?.vehicles?.onTeleport?.()", at);
  assert(at > 0 && hook > at && hook < ev.indexOf("sp.get('portalSpace')", at), "kind 33 calls liveScene3d.vehicles.onTeleport first");
  const src = readFileSync(join(HERE, "../scene3d/vehicle/index.js"), "utf8");
  const tick = src.slice(src.indexOf("function tickHandoff("));
  assert(/return nowSec\(\) - teleportAt < BAIL_HANDOFF\.maxSec \|\| portalSpaceOwnsFrame\(\);/.test(src), "a teleport = its PlayerTeleport or portal space");
  assert(tick.indexOf('if (teleportUnderWay()) { endHandoff("teleport"); return; }') >= 0
    && tick.indexOf("teleportUnderWay()") < tick.indexOf("setVehicleSeat"), "tickHandoff: the teleport exit before the lock");
  assert(/live\.vehicles = \{ afterTick, onTeleport, beforeMovement \}/.test(src), "liveScene3d.vehicles.onTeleport + beforeMovement");
  // the frame: syncTickHop calls vehicles.beforeMovement right before the wasm movement tick
  const idx = readFileSync(join(HERE, "../scene3d/index.js"), "utf8");
  const hop = idx.slice(idx.indexOf("async function syncTickHop()"), idx.indexOf("async function tick("));
  const bm = hop.indexOf("liveScene3dRef?.vehicles?.beforeMovement?.()"), tm = hop.indexOf("handle.tickMovement()");
  assert(bm > 0 && tm > bm, "scene3d/index.js syncTickHop: vehicles.beforeMovement before handle.tickMovement");
});

console.log("H8 dispose during a hand-off");
await check("releases the seat lock the hand-off set (keyed on the player)", () => {
  const w = airborne();
  w.inbox.push(SEAT_RELEASE);
  w.frame(); w.frame();
  assert(w.api.status().handoff && w.seatLog.at(-1)[0] === "set", "the hand-off holds the lock");
  w.api.dispose();
  assert(w.seatLog.at(-1)[0] === "clear", `the last seat call after dispose: ${w.seatLog.at(-1)[0]}`);
});

console.log("H9 a landing + exit on the ground");
await check("the aircraft is never drawn at its stale pre-boarding parked sample", () => {
  const w = makeWorld();
  w.inbox.push({ type: "ack", granted: 3 }, PROFILE, stateMsg(SPAWN, 10), stateMsg(SPAWN, 13), stateMsg(SPAWN, 16));
  w.frame();
  // boarded at the spawn; after a flight parked 3 km east (the pilot copies say so: the observer track never hears it)
  const LAND = { ...SPAWN, x: SPAWN.x + 3000, z: 0 }; // on the (flat, z 0) ground
  w.inbox.push({ type: "seat", vehicle: VEH, seat: 0, occupant: LOCAL, state: 1 }, stateMsg(LAND, 9000, 1));
  for (let i = 0; i < 60; i++) w.frame(); // the predictor's visual offset from the spawn decays (0.15 s)
  assert(dist(w.pos(VEH), LAND) < 1, "drawn at the landing spot while piloted");
  w.inbox.push(SEAT_RELEASE);
  for (let i = 0; i < 3; i++) {
    w.frame();
    assert(dist(w.pos(VEH), SPAWN) > 300, `frame ${i}: drawn at the stale parked sample (${dist(w.pos(VEH), SPAWN).toFixed(0)} m from the spawn)`);
  }
  w.inbox.push(stateMsg(LAND, 9100)); // its first observer state
  for (let i = 0; i < 3; i++) { w.frame(); assert(dist(w.pos(VEH), LAND) < 1, `frame ${i}: ${dist(w.pos(VEH), LAND).toFixed(1)} m from its state`); }
  assert(w.api.status().stats.handoffs === 0, "no hand-off on the ground");
});

console.log(`\nvehicle_bail_handoff: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
