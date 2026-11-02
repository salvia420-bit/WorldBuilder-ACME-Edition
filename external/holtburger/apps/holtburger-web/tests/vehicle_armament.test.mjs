// tests/vehicle_armament.test.mjs — the Hellcat built from Asheron's Call parts and its armament (HBV1 v2), plus the
// 2026-11-02 review fixes on the vehicle client.
//
//   A1  the new input buttons: MISSILE 0x08 / BOMB 0x10 on the wire (flight_model quantizeInput / inputFromFrame);
//   A2  controls: G / V are latched (a tap between two 30 Hz steps still reaches a step, once); pollEdges reads the pad;
//   A3  the gun salvo replay = the server's (ACE VehicleWeapons.StepGuns): mount-major, round-minor, one xorshift32
//       stream; each gun aims at the boresight point `convergence` m ahead (GunDirLocal);
//   A4  the bomb twin = ACE VehicleOrdnance.Step (gravity + quadratic drag, same operation order); predictImpact;
//   A5  airframe.js pure helpers (composite?, kind ordinals, loaded-by-mask, gear pivot / stance);
//   A6  an airframe instance from a fake decoder: buckets per role, gear / canopy / ordnance visibility, the parked
//       tail-down tilt about the main wheels, the spinning propeller, dispose;
//   A7  the OSD: the armament line, no DOM after dispose;
//   A8  chute.js: an observed canopy whose body left view is dropped after CANOPY.goneSec (it leaked and reappeared);
//   A9  predictor: a server that consumed past our newest frame (a tab stall) → seq continues after its ack;
//   A10 installVehicles end to end (fake session + fake wasm decoder, real three): the stand-in is hidden once the
//       composite is ready, quarrels from a salvo, a bomb from BombRelease falls and bursts, the server's Explosion is
//       deduplicated, Rearmed clears the fired marks, a despawn forgets the airframe and un-hides the guid; no boarding
//       while falling.
//
// Run: node tests/vehicle_armament.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let fakeNowMs = 2000000;
Object.defineProperty(globalThis, "performance", { value: { now: () => fakeNowMs }, configurable: true, writable: true });

const THREE = await import("three");
const FM = await import("../scene3d/vehicle/flight_model.js");
const FALL = await import("../scene3d/vehicle/fall_model.js");
const W = await import("../scene3d/vehicle/weapons.js");
const AF = await import("../scene3d/vehicle/airframe.js");
const OSD = await import("../scene3d/vehicle/osd.js");
const CH = await import("../scene3d/vehicle/chute.js");
const PR = await import("../scene3d/vehicle/predictor.js");
const CT = await import("../scene3d/vehicle/controls.js");
const VI = await import("../scene3d/vehicle/index.js");
const golden = JSON.parse(readFileSync(join(HERE, "../docs/vehicles-2026-11-01/flight/flight-golden.json"), "utf8"));

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [OK] ${name}`); } catch (e) { failed++; console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, `${m || "near"}: ${a} vs ${b} (eps ${eps})`);

// ------------------------------------------------------------------------------------------------ the Hellcat profile
const DEG = Math.PI / 180;
const GUN_X = [-3.1, -2.55, -2.0, 2.0, 2.55, 3.1];
const RAILS = [[-4.55, 1.534], [-4.05, 1.497], [-3.55, 1.46], [3.55, 1.46], [4.05, 1.497], [4.55, 1.534]];
function hellcatProfile(vehicle) {
  const weapons = [], weaponExt = [];
  for (const x of GUN_X) { weapons.push({ kind: 1, roundsPerSecond: 5, spread: 1.2 * DEG, range: 140, damage: 9, magazine: 400, muzzle: [x, 1.82, 1.72] }); weaponExt.push({ muzzleVelocity: 120, convergence: 110, massKg: 0, dragTerminal: 0, spellId: 0 }); }
  for (const [x, z] of RAILS) { weapons.push({ kind: 2, roundsPerSecond: 1 / 0.3, spread: 0, range: 600, damage: 0, magazine: 1, muzzle: [x, 1.54, z] }); weaponExt.push({ muzzleVelocity: 60, convergence: 0, massKg: 0, dragTerminal: 0, spellId: 4451 }); }
  weapons.push({ kind: 3, roundsPerSecond: 0, spread: 0, range: 45, damage: 1200, magazine: 1, muzzle: [0, 0.35, 1.1] }); weaponExt.push({ muzzleVelocity: 0, convergence: 0, massKg: 907, dragTerminal: 300, spellId: 0 });
  weapons.push({ kind: 3, roundsPerSecond: 0, spread: 0, range: 32, damage: 700, magazine: 1, muzzle: [-1.55, 0.4, 1.2] }); weaponExt.push({ muzzleVelocity: 0, convergence: 0, massKg: 454, dragTerminal: 270, spellId: 0 });
  weapons.push({ kind: 3, roundsPerSecond: 0, spread: 0, range: 32, damage: 700, magazine: 1, muzzle: [1.55, 0.4, 1.2] }); weaponExt.push({ muzzleVelocity: 0, convergence: 0, massKg: 454, dragTerminal: 270, spellId: 0 });
  // a small airframe: fuselage (static), prop blade (propeller), main wheel + tail wheel (gear), windscreen (canopy),
  // a rail wand (ordnance 6) and the 2000 lb keg (ordnance 12)
  const parts = [
    { did: 0x02001888, offset: [0, -2, 2.3], rotation: [0.7071, -0.7071, 0, 0], scale: 1.3 },
    { did: 0x0200130b, offset: [0, 2.7, 2.3], rotation: [1, 0, 0, 0], scale: 1.38 },
    { did: 0x02000162, offset: [-1.75, 1.05, 0.41], rotation: [1, 0, 0, 0], scale: 1.24 },
    { did: 0x02000162, offset: [0.1, -5, 1.4], rotation: [1, 0, 0, 0], scale: 0.62 },
    { did: 0x020019c4, offset: [0, -0.1, 2.85], rotation: [1, 0, 0, 0], scale: 0.52 },
    { did: 0x0200017c, offset: [-4.55, 0.35, 1.53], rotation: [1, 0, 0, 0], scale: 1.75 },
    { did: 0x0200188d, offset: [0, -0.11, 1.1], rotation: [0.7071, -0.7071, 0, 0], scale: 1.15 },
  ];
  const partRoles = [0, 1, 2, 2, 3, 4 | (6 << 16), 4 | (12 << 16)];
  return { type: "profile", vehicle, profileKey: "hellcat-demo", displayName: "Hellcat", standInSetup: 0x020016f1, ...golden.params,
    leadSeconds: 6, seats: [{ offset: [0, -0.92, 2.18] }], weapons, weaponExt, parts, partRoles };
}

/** A fake wasm decoder: every model is one triangle (the geometry path through meshToGeometryGroups is real). */
function fakeDecoderLive(worldRoot) {
  const mat = new THREE.MeshLambertMaterial({ color: 0x886644 });
  const decoded = [];
  const wasmExports = {
    async fetchBuildingPlacement(did) {
      decoded.push(did >>> 0);
      const mesh = {
        triCount: 1,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        uvs: new Float32Array(6), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        surfaceIndices: new Uint8Array([0]), surfaces: new Uint32Array([0x08000001]),
        free() {},
      };
      return { partCount: 1, takePartMeshes: () => [mesh], takePartHingeFrames: () => [null], free() {} };
    },
  };
  const materialCache = { get: async () => mat, fallbackMaterial: null };
  return { worldRoot, wasmExports, materialCache, decoded, mat };
}

// ------------------------------------------------------------------------------------------------ A1
console.log("A1 the new input buttons");
await check("MISSILE 0x08 and BOMB 0x10 quantize onto the wire and back (no flight effect)", () => {
  const f = FM.quantizeInput({ throttle: 0.5, missile: true, bomb: true, fire: true });
  assert(f.buttons === (0x02 | 0x08 | 0x10), `buttons ${f.buttons}`);
  const u = FM.inputFromFrame(f);
  assert(u.missile && u.bomb && u.fire && !u.boost && !u.land, "decoded");
  assert(FM.BUTTON.MISSILE === 0x08 && FM.BUTTON.BOMB === 0x10, "constants = the server's ButtonMissile / ButtonBomb");
});
await check("toCellLocal clamps to landblock 0xFE (= the server's ToPosition; 0xFF does not exist)", () => {
  const c = FM.toCellLocal(255 * 192 + 50, 255 * 192 + 50, 10);
  assert(((c.cell >>> 24) & 0xff) === 254 && ((c.cell >>> 16) & 0xff) === 254, `cell ${c.cell.toString(16)}`);
});

// ------------------------------------------------------------------------------------------------ A2
console.log("A2 controls: latched G / V, pad edges");
function fakeWin() {
  const ls = new Map();
  return {
    addEventListener(t, fn) { ls.set(t, fn); }, removeEventListener(t) { ls.delete(t); },
    fire(type, code) { const fn = ls.get(type); if (fn) fn({ type, code, repeat: false, stopImmediatePropagation() {}, preventDefault() {} }); },
    document: { activeElement: null },
  };
}
await check("a V tap between two steps is reported by the next poll exactly once; G held keeps firing", () => {
  const win = fakeWin();
  const c = CT.createVehicleControls({ window: win, document: win.document, navigator: null, funnel: null });
  c.lock();
  win.fire("keydown", "KeyV"); win.fire("keyup", "KeyV");
  assert(c.poll(1 / 30).bomb === true, "the tap reaches a step");
  assert(c.poll(1 / 30).bomb === false, "once");
  win.fire("keydown", "KeyG");
  assert(c.poll(1 / 30).missile && c.poll(1 / 30).missile, "held");
  win.fire("keyup", "KeyG");
  assert(!c.poll(1 / 30).missile, "released");
  c.dispose();
});
await check("pollEdges emits the pad's Back (exit) edge once — the fall's chute on a gamepad", () => {
  let pressed = true;
  const pad = { connected: true, mapping: "standard", axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ get pressed() { return i === 8 && pressed; } })) };
  const c = CT.createVehicleControls({ window: fakeWin(), document: { activeElement: null }, navigator: { getGamepads: () => [pad] } });
  const got = [];
  c.onAction((a) => got.push(a.type));
  c.pollEdges(); c.pollEdges();
  pressed = false; c.pollEdges();
  pressed = true; c.pollEdges();
  assert(got.filter((t) => t === "exit").length === 2, `edges ${got}`);
});

// ------------------------------------------------------------------------------------------------ A3
console.log("A3 the gun salvo replay (= ACE VehicleWeapons.StepGuns)");
const profile = hellcatProfile(0x80011111);
/** The server's loop, transcribed from VehicleWeapons.cs: mount-major, round-minor, ONE rng stream, GunDirLocal. */
function serverSalvo(prof, count, seed, q, origin0) {
  let rng = seed >>> 0;
  const right = FM.rotate(q, [1, 0, 0]), up = FM.rotate(q, [0, 0, 1]);
  const out = [];
  const guns = prof.weapons.map((w, i) => (w.kind === 1 ? i : -1)).filter((i) => i >= 0);
  const m0 = prof.weapons[guns[0]].muzzle;
  for (const gi of guns) {
    const w = prof.weapons[gi], ext = prof.weaponExt[gi];
    const dl = ext.convergence > 0 ? (() => { const x = -w.muzzle[0], y = ext.convergence, l = Math.hypot(x, y); return [x / l, y / l, 0]; })() : [0, 1, 0];
    const base = FM.rotate(q, dl);
    const rel = FM.rotate(q, [w.muzzle[0] - m0[0], w.muzzle[1] - m0[1], w.muzzle[2] - m0[2]]);
    for (let k = 0; k < count; k++) {
      rng = W.xorshift32(rng); const u1 = (rng >>> 8) / 16777216;
      rng = W.xorshift32(rng); const u2 = (rng >>> 8) / 16777216;
      const r = w.spread * Math.sqrt(u1), a = 2 * Math.PI * u2;
      const tr = Math.tan(r * Math.cos(a)), tu = Math.tan(r * Math.sin(a));
      const d = [base[0] + right[0] * tr + up[0] * tu, base[1] + right[1] * tr + up[1] * tu, base[2] + right[2] * tr + up[2] * tu];
      const l = Math.hypot(...d);
      out.push({ o: [origin0[0] + rel[0], origin0[1] + rel[1], origin0[2] + rel[2]], d: d.map((c) => c / l) });
    }
  }
  return out;
}
await check("every quarrel of a 6-gun salvo matches the server's order, origins and directions", () => {
  const q = FM.orientation(0.7, 0.1, -0.3);
  const o0 = [26000, 17000, 150];
  const m = { mount: 0, mountCount: 6, count: 2, seed: 0x1234567 };
  const js = W.salvoRounds(profile, m, o0, q);
  const cs = serverSalvo(profile, 2, 0x1234567, q, o0);
  assert(js.length === 12 && cs.length === 12, `${js.length} rounds`);
  for (let i = 0; i < 12; i++) {
    for (let c = 0; c < 3; c++) { near(js[i].o[c], cs[i].o[c], 1e-9, `o[${i}]`); near(js[i].d[c], cs[i].d[c], 1e-12, `d[${i}]`); }
  }
});
await check("with no spread the six guns converge on the boresight point 110 m ahead of their line", () => {
  const p2 = JSON.parse(JSON.stringify(profile));
  for (const w of p2.weapons) w.spread = 0;
  const q = FM.orientation(1.2, 0, 0);
  const pose = { x: 30000, y: 20000, z: 200 };
  const m0 = p2.weapons[0].muzzle;
  const rm = FM.rotate(q, m0);
  const rounds = W.salvoRounds(p2, { mount: 0, mountCount: 6, count: 1, seed: 7 }, [pose.x + rm[0], pose.y + rm[1], pose.z + rm[2]], q);
  const cl = FM.rotate(q, [0, 1.82 + 110, 1.72]);
  const conv = [pose.x + cl[0], pose.y + cl[1], pose.z + cl[2]];
  for (const r of rounds) {
    const t = (conv[0] - r.o[0]) * r.d[0] + (conv[1] - r.o[1]) * r.d[1] + (conv[2] - r.o[2]) * r.d[2];
    const miss = Math.hypot(r.o[0] + r.d[0] * t - conv[0], r.o[1] + r.d[1] * t - conv[1], r.o[2] + r.d[2] * t - conv[2]);
    assert(miss < 1e-6, `miss ${miss}`);
  }
});

// ------------------------------------------------------------------------------------------------ A4
console.log("A4 the bomb twin (= ACE VehicleOrdnance.Step)");
function serverStep(b, dt) { // transcribed: VehicleOrdnance.Step
  const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  const k = b.terminal > 0 ? 9.8 / (b.terminal * b.terminal) : 0;
  b.vx += -k * sp * b.vx * dt; b.vy += -k * sp * b.vy * dt; b.vz += (-9.8 - k * sp * b.vz) * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
}
await check("stepBomb is bit-identical to the server's step over a 12 s drop", () => {
  const a = { x: 1000, y: 2000, z: 450, vx: 80, vy: 30, vz: -1.5, terminal: 300 };
  const b = { ...a };
  for (let i = 0; i < 360; i++) { FALL.stepBomb(a, FM.DT); serverStep(b, FM.DT); }
  for (const k of ["x", "y", "z", "vx", "vy", "vz"]) assert(a[k] === b[k], `${k} ${a[k]} vs ${b[k]}`);
});
await check("a heavy bomb approaches its terminal velocity; without drag it falls as h = g t² / 2", () => {
  const a = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, terminal: 300 };
  for (let i = 0; i < 30 * 120; i++) FALL.stepBomb(a, FM.DT);
  near(-a.vz, 300, 1.5, "terminal");
  const b = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, terminal: 0 };
  for (let i = 0; i < 300; i++) FALL.stepBomb(b, FM.DT);
  near(-b.z, 0.5 * 9.8 * 100, 0.5 * 9.8 * 100 * 0.01, "free fall 10 s");
});
await check("predictImpact (the pipper) lands where the twin does (the same step; sparse terrain samples)", () => {
  const start = { x: 5000, y: 5000, z: 380, vx: 0, vy: 95, vz: -1.5, terminal: 270 };
  const ground = () => 80;
  const hit = W.predictImpact(start, ground);
  const b = { ...start };
  while (b.z > 80) FALL.stepBomb(b, FM.DT);
  assert(hit && Math.hypot(hit.x - b.x, hit.y - b.y) < 3.5, `pipper ${hit && hit.y} vs ${b.y}`); // b = the first step below ground (one step = 3.2 m at 95 m/s)
  near(hit.z, 80, 1e-9, "on the ground");
});

// ------------------------------------------------------------------------------------------------ A5
console.log("A5 airframe helpers");
await check("hasComposite / kindOrdinal / weaponLoaded / gearPivotY / gearTarget", () => {
  assert(AF.hasComposite(profile), "composite");
  assert(!AF.hasComposite({ standInSetup: 0x020016f1, parts: [{ did: 0x020016f1 }] }), "the stand-in alone is not a composite");
  const k = AF.kindOrdinal(profile, 8);
  assert(k.kind === 2 && k.ordinal === 2, JSON.stringify(k));
  assert(AF.kindOrdinal(profile, 13).ordinal === 1, "the second bomb");
  assert(AF.weaponLoaded(profile, 8, 0b111011, 7) === false, "rail ordinal 2 empty");
  assert(AF.weaponLoaded(profile, 9, 0b111011, 7) === true, "rail ordinal 3 loaded");
  assert(AF.weaponLoaded(profile, 12, 63, 6) === false && AF.weaponLoaded(profile, 13, 63, 6) === true, "bomb masks");
  assert(AF.weaponLoaded(profile, 13, 63, 7, new Set([13])) === false, "a local fired mark hides it at once");
  assert(AF.gearPivotY(profile) === 1.05, `pivot ${AF.gearPivotY(profile)}`);
  assert(AF.gearTarget(FM.MODE.PARKED) === 1 && AF.gearTarget(FM.MODE.FLIGHT) === 0 && AF.gearTarget(FM.MODE.LANDING, 1) === 1 && AF.gearTarget(FM.MODE.LANDING, 20) === 0, "stance");
});

// ------------------------------------------------------------------------------------------------ A6
console.log("A6 an airframe instance");
await check("buckets per role; gear / canopy / ordnance visibility; tail-down when parked; the prop spins; dispose", async () => {
  const worldRoot = new THREE.Group();
  const live = fakeDecoderLive(worldRoot);
  const afs = AF.createAirframes({ liveScene3d: live, THREE });
  const v = { guid: 0x80011111, profile };
  assert(afs.ensure(v) === null, "null while decoding");
  for (let i = 0; i < 20 && afs.status(profile) === "building"; i++) await new Promise((r) => setTimeout(r, 5));
  assert(afs.status(profile) === "ready", `status ${afs.status(profile)}`);
  const inst = afs.ensure(v);
  assert(inst && worldRoot.children.includes(inst.root), "instance under worldRoot");
  assert(inst.ordnance.has(6) && inst.ordnance.has(12), "ordnance groups for weapons 6 and 12");
  const q = FM.orientation(0, 0, 0);
  for (let i = 0; i < 60; i++) afs.pose(inst, { x: 100, y: 200, z: 10, heading: 0, pitch: 0, bank: 0, mode: FM.MODE.PARKED }, { q, dt: 1 / 30, throttle: 0, agl: 0, missileMask: 63, bombMask: 7 });
  near(inst.body.rotation.x, AF.GEAR_PITCH, 1e-3, "tail down");
  // the main wheels' contact line stays put: (0, pivot, 0) maps onto itself
  const pv = new THREE.Vector3(0, 1.05, 0).applyEuler(inst.body.rotation).add(inst.body.position);
  near(pv.y, 1.05, 1e-9, "pivot y"); near(pv.z, 0, 1e-9, "pivot z");
  assert(inst.groups.gear.visible && inst.groups.canopy.visible, "gear + canopy on the ground");
  const a0 = inst.propAngle;
  for (let i = 0; i < 90; i++) afs.pose(inst, { x: 100, y: 200, z: 300, heading: 0, pitch: 0, bank: 0, mode: FM.MODE.FLIGHT }, { q, dt: 1 / 30, throttle: 1, agl: 290, cockpit: true, missileMask: 0b111110, bombMask: 0b110 });
  near(inst.body.rotation.x, 0, 1e-3, "level in flight");
  assert(!inst.groups.gear.visible, "gear up in flight");
  assert(!inst.groups.canopy.visible, "canopy hidden in the cockpit view");
  assert(!inst.ordnance.get(6).visible && !inst.ordnance.get(12).visible, "spent rail / bomb hidden");
  assert(inst.propAngle !== a0, "the prop turns");
  afs.dispose();
  assert(worldRoot.children.length === 0, "removed");
});

// ------------------------------------------------------------------------------------------------ A7
console.log("A7 the OSD");
await check("armament line; a prompt after dispose creates no DOM", () => {
  const line = OSD.armamentLine({ guns: 6, quarrels: 2394, rails: 6, missileMask: 0b110111, bombs: [2000, 1000, 1000], bombMask: 0b110 });
  assert(line.includes("QUARRELS 2394") && line.includes("◆◆◆◇◆◆") && line.includes("[----][1000][1000]"), line);
  let created = 0;
  const node = () => ({ style: {}, setAttribute() {}, remove() {}, textContent: "", className: "" });
  const doc = { getElementById: () => null, createElement: () => { created++; return node(); }, head: { appendChild() {} }, body: { appendChild() {} } };
  const o = OSD.createVehicleOsd({ document: doc });
  o.prompt("x");
  const n0 = created;
  o.dispose();
  o.prompt(null); o.update({ speed: 1 }); o.sights({ x: 1, y: 1 }, null);
  assert(created === n0, `created ${created - n0} after dispose`);
});

// ------------------------------------------------------------------------------------------------ A8
console.log("A8 chute.js: no leak for an observed body that left view");
await check("a canopy whose body is gone for > goneSec is removed", () => {
  const worldRoot = new THREE.Group();
  const chutes = CH.createChutes({ liveScene3d: { worldRoot }, THREE });
  chutes.open(0x50000099);
  chutes.tick(0.1, () => ({ x: 0, y: 0, z: 100, heading: 0 }));
  for (let i = 0; i < 60; i++) chutes.tick(0.1, () => null);
  assert(chutes.stats().live === 0, JSON.stringify(chutes.stats()));
  chutes.dispose();
});

// ------------------------------------------------------------------------------------------------ A9
console.log("A9 predictor: resync after the server consumed past our frames");
await check("seq continues after the server's ack (no 'late' frames, no stall + snap)", () => {
  const params = golden.params;
  const s0 = { x: 1000, y: 1000, z: 300, heading: 0, pitch: 0, bank: 0, speed: params.vMax, mode: FM.MODE.FLIGHT };
  const p = PR.createPilotPredictor({ params, ground: () => 0, initial: { ...s0 }, vCap: params.vMax, startSeq: 1 });
  for (let i = 0; i < 5; i++) p.stepLocal({ throttle: 1 });
  const cl = FM.toCellLocal(s0.x, s0.y + 500, s0.z);
  p.reconcile({ cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, heading: 0, pitch: 0, bank: 0, speed: params.vMax, mode: FM.MODE.FLIGHT, ack: 90, flags: 1, vCap: params.vMax });
  assert(p.seq === 91, `seq ${p.seq}`);
  const f = p.stepLocal({ throttle: 1 });
  assert(f.seq === 91, `next frame ${f.seq}`);
});

// ------------------------------------------------------------------------------------------------ A10
console.log("A10 installVehicles with the armament");
const LOCAL = 0x50000001, VEH = 0x80011111;
function stateMsg(s, step, flags = 0, ack = 0, masks = {}) {
  const cl = FM.toCellLocal(s.x, s.y, s.z);
  return { type: "state", vehicle: VEH, step, ack, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, heading: s.heading, pitch: s.pitch, bank: s.bank,
    speed: s.speed, vCap: golden.params.vMax, ammo: 2400, mode: s.mode, flags, missileMask: masks.m ?? 63, bombMask: masks.b ?? 7 };
}
function world() {
  const inbox = [];
  const v3 = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } });
  const rig = () => ({ root: { position: v3(), quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { Object.assign(this, { x, y, z, w }); } }, scale: { x: 1 } } });
  const entityMap = new Map([[LOCAL, rig()], [VEH, rig()]]);
  const hidden = [];
  const sh = {
    drainVehicleMessages: () => JSON.stringify(inbox.splice(0)),
    vehicleCapabilities() {}, vehicleInput() {}, vehicleExit() {}, vehicleBoard() { boards++; }, sendChat() {},
    setVehicleSeat() { return true; }, clearVehicleSeat() {}, terrainHeightAt: () => 0,
  };
  let boards = 0;
  const win = {
    location: { search: "?vehicles=on&vehicleAudio=off&vehicleChute=off&vehicleFallAnim=off&vehicleBoardAnim=off" },
    document: null, addEventListener() {}, removeEventListener() {}, getLocalPlayerGuid: () => LOCAL, __sessionHandle: sh,
    innerWidth: 1920, innerHeight: 1080,
  };
  const worldRoot = new THREE.Group();
  const live = { ...fakeDecoderLive(worldRoot), sessionHandle: sh,
    entityManager: { entityMap, setMotion() {}, setFilmHidden(g, on) { hidden.push([g >>> 0, !!on]); const i = entityMap.get(g >>> 0); if (i) i._filmHidden = !!on; return !!i; } } };
  const api = VI.installVehicles({ liveScene3d: live, THREE, window: win });
  const frame = (ms = 1000 / 30) => { fakeNowMs += ms; live.vehicles?.afterTick?.(fakeNowMs, ms); };
  return { inbox, api, frame, hidden, live, worldRoot, boards: () => boards };
}
const PARK = { x: 26300, y: 16950, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, mode: FM.MODE.PARKED };
const FLY = { x: 27000, y: 16960, z: 300, heading: Math.PI / 2, pitch: 0, bank: 0, speed: 100, mode: FM.MODE.FLIGHT };
await check("composite ready → stand-in hidden; a salvo draws 6 × count quarrels; a bomb falls and bursts once", async () => {
  const w = world();
  w.inbox.push({ type: "ack", granted: 3 }, hellcatProfile(VEH), stateMsg(PARK, 1), stateMsg(PARK, 4), stateMsg(PARK, 7));
  for (let i = 0; i < 5; i++) { w.frame(); await new Promise((r) => setTimeout(r, 5)); }
  for (let i = 0; i < 4; i++) w.frame();
  const st = w.api.status();
  assert(st.vehicles[0].airframe === "ready", `airframe ${st.vehicles[0].airframe}`);
  assert(w.hidden.some(([g, on]) => g === VEH && on), "the stand-in is film-hidden");
  assert(st.airframes.live === 1, `airframes ${JSON.stringify(st.airframes)}`);
  // observers: the vehicle flies; a 2-round salvo from all six guns
  w.inbox.push(stateMsg(FLY, 100), stateMsg(FLY, 103), stateMsg(FLY, 106));
  w.frame(); w.frame();
  const cl = FM.toCellLocal(FLY.x, FLY.y + 2, FLY.z + 1.7);
  w.inbox.push({ type: "fire", vehicle: VEH, step: 107, mount: 0, mountCount: 6, count: 2, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, dir: [1, 0, 0], seed: 99, speed: 220 });
  w.frame();
  assert(w.api.status().weapons.quarrels === 12, `quarrels ${w.api.status().weapons.quarrels}`);
  // a rail launch empties its wand at once
  w.inbox.push({ type: "fire", vehicle: VEH, step: 108, mount: 8, mountCount: 1, count: 1, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, dir: [1, 0, 0], seed: 0, speed: 160 });
  w.frame();
  // BombRelease from 300 m: falls, bursts on the ground (terrainHeightAt 0)
  const rel = FM.toCellLocal(FLY.x, FLY.y, FLY.z - 1.2);
  w.inbox.push({ type: "event", vehicle: VEH, kind: 9, step: 109, subject: 0x50000002, cell: rel.cell, x: rel.x, y: rel.y, z: rel.z, value: 2000, aux: 12, vel: [100, 0, -1.5] });
  w.frame();
  assert(w.api.status().weapons.liveBombs === 1, "a bomb in flight");
  for (let i = 0; i < 30 * 12 && w.api.status().weapons.liveBombs > 0; i++) w.frame();
  const ws = w.api.status().weapons;
  assert(ws.liveBombs === 0 && ws.explosions === 1, JSON.stringify(ws));
  // the server's Explosion for the same station: deduplicated
  const imp = FM.toCellLocal(FLY.x + 780, FLY.y, 0);
  w.inbox.push({ type: "event", vehicle: VEH, kind: 10, step: 300, subject: 0x50000002, cell: imp.cell, x: imp.x, y: imp.y, z: imp.z, value: 2000, aux: 12, vel: [0, 0, 0] });
  w.frame();
  assert(w.api.status().weapons.explosions === 1 && w.api.status().weapons.deduped === 1, JSON.stringify(w.api.status().weapons));
  // a far Explosion of another bomb (out of our sight): drawn from the event
  w.inbox.push({ type: "event", vehicle: VEH, kind: 10, step: 301, subject: 0x50000002, cell: imp.cell, x: imp.x, y: imp.y, z: imp.z, value: 1000, aux: 13, vel: [0, 0, 0] });
  w.frame();
  assert(w.api.status().weapons.explosions === 2, "event-only explosion drawn");
  // despawn: the airframe goes, the guid is un-hidden (ACE recycles dynamic guids)
  w.inbox.push({ type: "event", vehicle: VEH, kind: 4, step: 400, subject: 0, cell: imp.cell, x: 0, y: 0, z: 0, value: 0, aux: 0, vel: [0, 0, 0] });
  w.frame();
  assert(w.api.status().airframes.live === 0, "airframe removed");
  assert(w.hidden.length && w.hidden[w.hidden.length - 1][0] === VEH && w.hidden[w.hidden.length - 1][1] === false, `hidden log ${JSON.stringify(w.hidden)}`);
  w.api.dispose();
  for (let i = 0; i < 3; i++) w.frame();
});
await check("no boarding while falling (the client refuses; ACE refuses too)", () => {
  const w = world();
  w.inbox.push({ type: "ack", granted: 3 }, hellcatProfile(VEH), stateMsg(PARK, 1));
  w.frame();
  // a Bail event for us (as after a seat release in the air): the fall starts
  const at = FM.toCellLocal(PARK.x + 3, PARK.y, 120);
  w.inbox.push({ type: "event", vehicle: VEH, kind: 5, step: 10, subject: LOCAL, cell: at.cell, x: at.x, y: at.y, z: at.z, value: 0, aux: 0, vel: [0, 0, 0] });
  w.frame();
  assert(w.api.falling, "falling");
  const r = w.api.board(VEH);
  assert(r.ok === false && r.reason === "busy" && w.boards() === 0, JSON.stringify(r));
  w.api.dispose();
});

console.log(`\nvehicle_armament: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
