// tests/film_perception.test.mjs
//
// WHY: the AC Film Mode camera's perception turns the live scene into the
// SensorFrame (SPEC §3.1) the JEV pilot hears as words ("close tree
// ahead-left", "subject fully hidden behind a building for a while", "medium
// smoke blocking the view") and the safety reflex / mapper read as numbers.
// Wrong perception = a pilot that drifts into trunks, backs off from open
// sky, or never notices the subject vanished. It is built from three page
// adapters with injected dependencies — scene/world_query.js (rigs, statics,
// ground, cells), scene/particles_query.js (emitter clouds) and
// scene/sensors.js (budgeted, round-robin sphere sweeps through scene/los.js)
// — and this suite EXECUTES all three against fake liveScene3d / entityManager
// / sessionHandle / wasmExports objects whose sweeps implement real geometry
// (vertical trunk cylinders, axis-aligned walls, creature spheres, flat
// terrain) with real three r184 Object3Ds for rigs and particle anchors:
//   W1  entity kinds from itemType / objDescFlags / guid tier; obstacle words;
//   W2  entitiesNear (local player excluded, kinds filter, surface distance, dims
//       from objectPartDims else defaults × objScale);
//   W3  subject(ref) by guid / hex / name / 'player'; compass heading = −yaw (from
//       getHeading or the root quaternion); velocity from the kept history;
//   W4  localPlayer from LocalPlayerPose (LB-local → world, freed) and the rig fallback;
//   W5  staticsNear: per-landblock SoA fetch (lbKey|0xFFFE), LB-local → world,
//       building/tree/rock/prop kinds via isBuilding + archetype, SoA freed, cached;
//   W6  groundZ (terrainHeightAt, then the corridor; a miss schedules ensure);
//       cellAt (outdoor from xy; indoor walk via resolveViewerCell);
//   W7  describeHit refines a hit's kind (rock vs tree, creature + guid, player);
//   P1  particles: anchors in the THREE frame → AC, radius from sortingSphere +
//       parentOffset + sampled live particles; skyGlow / sky / filmHidden / empty skipped;
//   P2  near / alongSegment / onLens / inView; occludes by family (smoke true, fire false);
//   P3  owner-registry manager discovery + owner keys; frame-key caching;
//   S1  a tree 3 m ahead-left → sectors.left ≈ 3 kind tree; words "close tree";
//   S2  a wall ahead → sectors.center (building outdoors, wall indoors); bands;
//   S3  a subject behind a wall → visibleFrac 0, the unseen timer grows; with no
//       wall it is visible (subject guid excluded as missile_guid; self-hits count);
//       the subject is no obstacle for the clearance probes unless ctx.subjectIsObstacle;
//   S4  smoke between camera and subject → particles.inView occludes, visibleFrac
//       thinned, occluder "particles"; smoke on the lens → onLens;
//   S5  the sweep budget is honoured every frame (counted los calls) and the
//       round robin refreshes every probe; ages and motion compensation;
//   S6  pathAhead ttc from ctx.nominalAhead and from the velocity;
//   S7  limits (ceiling, floor, room) and the above/below band clamps;
//   S8  sensing heading = travel direction while moving (hysteresis), camera
//       heading at rest; straight-down pitch has no NaN;
//   S9  nearest ignores the ground below unless descending; cuts reset probes;
//   S10 every CollisionHit freed; bad poses / throwing los never throw.
//   W9  renderSetCells (shared by safety + sensors): viewer render set first, else
//       getRenderSet(1), copied; the safety reflex sweeps the same list;
//   W10 describeHit fade keys (tree / prop only) and staticFadeTargets: per-placement
//       Mesh / single-instance InstancedMesh nodes, shared InstancedMesh + instanced
//       LOD instances, visible BatchedMesh instances, animated anchors; script
//       anchors / other models / shared animated buckets never targeted
//       (review contracts-3 / seams-2 / gate-2);
//   S11 indoors with no ctx.cellIds the sensors sweep the render set's EnvCell walls
//       (centre sector, ceiling, subject behind a wall) — review contracts-1;
//   S12 a scenery tree hiding the subject → its fade key in occluderIds → the code
//       policy + mapper fade it (no reroute); once faded (ctx.fadedIds) the rays see past it;
//   W11 (round 2) describeHit names the placement whose axis is nearest relative to its
//       radius (two overlapping oaks: the one hit, not the lower row); ambiguous / outside
//       hits and props of unknown or big size get no fade key (the rim / barrel case);
//   W12 createStaticCatalogs: archetype + DAT-bounds size from the VFX descriptor, wasm
//       selection spheres for other Setups (0x02 only, once, freed, failures, bounded wait);
//   W13 a catalog filled after the landblock was cached still applies (rock → tree);
//   S13 the clump end to end: the sensors name the real blocker; fading the neighbour
//       does not make the subject visible.
//   W14 (round 3) scenery hits land on PHYSICS colliders (trunk cylspheres / boulder
//       spheres): the absolute-nearest axis that could own the hit (plausible collider
//       reach, behind the hit along its normal), with real catalog rows — a thin tree
//       beside a big canopy tree, a boulder beside a tree, near-tied trunks, a
//       collider-less bush nearer the hit than the trunk, a catalog collider reach;
//   S14 the same end to end through the real sensors (rock stays hidden after a wrong
//       fade; the thin tree / the pine fade, their neighbours do not clear the rays);
//   W15 a size fetch that never settles: one bounded wait per query (landblocks load
//       together), the DID remembered as stalled and skipped later, a late fetch un-stalls.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these are its perception page adapters.
// Run from apps/holtburger-web/: node tests/film_perception.test.mjs

import assert from "node:assert/strict";

const THREE = await import("three");
const LOS = await import("../scene3d/film/scene/los.js");
const WQ = await import("../scene3d/film/scene/world_query.js");
const PQ = await import("../scene3d/film/scene/particles_query.js");
const SN = await import("../scene3d/film/scene/sensors.js");
const { buildPilotState } = await import("../scene3d/film/pilot/scene_state.js");
const POL = await import("../scene3d/film/pilot/policy_code.js");
const MAP = await import("../scene3d/film/pilot/mapper.js");
const SF = await import("../scene3d/film/runtime/safety.js");
const { quatFromHPR } = await import("../scene3d/film/core/gimbal.js");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err && err.message ? err.message : err}`);
  }
}

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? "value"}: ${a} vs ${b} (eps ${eps})`);
}

const DEG = Math.PI / 180;
const LB = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;

/** Walk an object tree; assert no NaN numbers anywhere. */
function assertNoNaN(o, path = "frame") {
  if (typeof o === "number") {
    assert.ok(!Number.isNaN(o), `${path} is NaN`);
    return;
  }
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) assertNoNaN(v, `${path}.${k}`);
}

// ---------------------------------------------------------------------------
// Fake wasm CollisionHit + geometric sweeps
// ---------------------------------------------------------------------------
const ALL_HITS = [];
class FakeHit {
  constructor(t, p, n) {
    this._d = { t, x: p[0], y: p[1], z: p[2], normalX: n[0], normalY: n[1], normalZ: n[2] };
    this.freed = 0;
    ALL_HITS.push(this);
  }
  _get(k) {
    if (this.freed) throw new Error(`CollisionHit.${k} read after free()`);
    return this._d[k];
  }
  get t() { return this._get("t"); }
  get x() { return this._get("x"); }
  get y() { return this._get("y"); }
  get z() { return this._get("z"); }
  get normalX() { return this._get("normalX"); }
  get normalY() { return this._get("normalY"); }
  get normalZ() { return this._get("normalZ"); }
  free() {
    if (this.freed) throw new Error("double free");
    this.freed += 1;
  }
}

/** Sphere(R) swept p0→p1 against a vertical cylinder {c:[x,y], r, z0, z1}. */
function sweepCyl(p0, p1, R, prim) {
  const f = [p0[0] - prim.c[0], p0[1] - prim.c[1]];
  const d = [p1[0] - p0[0], p1[1] - p0[1]];
  const rr = R + prim.r;
  const C = f[0] * f[0] + f[1] * f[1] - rr * rr;
  let s;
  if (C <= 0) s = 0;
  else {
    const A = d[0] * d[0] + d[1] * d[1];
    if (A === 0) return null;
    const B = 2 * (f[0] * d[0] + f[1] * d[1]);
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    s = (-B - Math.sqrt(disc)) / (2 * A);
    if (s < 0 || s > 1) return null;
  }
  const q = [p0[0] + (p1[0] - p0[0]) * s, p0[1] + (p1[1] - p0[1]) * s, p0[2] + (p1[2] - p0[2]) * s];
  const z0 = prim.z0 ?? -Infinity, z1 = prim.z1 ?? Infinity;
  if (q[2] < z0 - R || q[2] > z1 + R) return null;
  const nv = [q[0] - prim.c[0], q[1] - prim.c[1]];
  const nl = Math.hypot(nv[0], nv[1]) || 1;
  const n = [nv[0] / nl, nv[1] / nl, 0];
  return { s, point: [prim.c[0] + n[0] * prim.r, prim.c[1] + n[1] * prim.r, q[2]], normal: n };
}

/** Sphere(R) swept p0→p1 against a sphere {c, r}. */
function sweepSphere(p0, p1, R, prim) {
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const m = [p0[0] - prim.c[0], p0[1] - prim.c[1], p0[2] - prim.c[2]];
  const rr = R + prim.r;
  const A = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const B = 2 * (m[0] * d[0] + m[1] * d[1] + m[2] * d[2]);
  const C = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] - rr * rr;
  let s;
  if (C <= 0) s = 0;
  else {
    const disc = B * B - 4 * A * C;
    if (disc < 0 || A === 0) return null;
    s = (-B - Math.sqrt(disc)) / (2 * A);
    if (s < 0 || s > 1) return null;
  }
  const q = [p0[0] + d[0] * s, p0[1] + d[1] * s, p0[2] + d[2] * s];
  const nv = [q[0] - prim.c[0], q[1] - prim.c[1], q[2] - prim.c[2]];
  const nl = Math.hypot(...nv) || 1;
  const n = nv.map((v) => v / nl);
  return { s, point: prim.c.map((c, i) => c + n[i] * prim.r), normal: n };
}

/** Sphere(R) swept against an axis-aligned wall {axis, value, lo:[x,y,z], hi:[x,y,z]}. */
function sweepPlane(p0, p1, R, prim) {
  const a = prim.axis;
  const s0 = p0[a] - prim.value, s1 = p1[a] - prim.value;
  let s;
  const sg = s0 >= 0 ? 1 : -1;
  if (Math.abs(s0) <= R) {
    if (sg * (s1 - s0) >= 0) return { s: 0, point: p0.map((v, i) => (i === a ? prim.value : v)), normal: [0, 1, 2].map((i) => (i === a ? sg : 0)) };
    s = 0;
  } else {
    if (sg > 0 && s1 >= R) return null;
    if (sg < 0 && s1 <= -R) return null;
    s = (s0 - sg * R) / (s0 - s1);
  }
  const q = [0, 1, 2].map((i) => p0[i] + (p1[i] - p0[i]) * s);
  for (let i = 0; i < 3; i++) {
    if (i === a) continue;
    if (q[i] < prim.lo[i] - R || q[i] > prim.hi[i] + R) return null;
  }
  q[a] = prim.value;
  return { s, point: q, normal: [0, 1, 2].map((i) => (i === a ? sg : 0)) };
}

function sweepList(list, p0, p1, R) {
  let best = null;
  for (const prim of list) {
    const h = prim.type === "cyl" ? sweepCyl(p0, p1, R, prim) : prim.type === "sphere" ? sweepSphere(p0, p1, R, prim) : sweepPlane(p0, p1, R, prim);
    if (h && (!best || h.s < best.s)) best = h;
  }
  return best ? new FakeHit(best.s, best.point, best.normal) : undefined;
}

/** Fake SessionHandle with geometric layers. */
function geoSh(opts = {}) {
  const prims = { buildingMesh: [], scenery: [], cellMesh: [], objects: [], statics: [], entities: [], ...(opts.prims ?? {}) };
  const calls = { objects: [], cellMesh: [] };
  const ground = opts.ground ?? (() => 0);
  return {
    prims,
    calls,
    sweepSphereAgainstBuildingMesh(fx, fy, fz, tx, ty, tz, r) { return sweepList(prims.buildingMesh, [fx, fy, fz], [tx, ty, tz], r); },
    sweepSphereAgainstScenery(fx, fy, fz, tx, ty, tz, r) { return sweepList(prims.scenery, [fx, fy, fz], [tx, ty, tz], r); },
    sweepSphereAgainstStatics(fx, fy, fz, tx, ty, tz, r) { return sweepList(prims.statics, [fx, fy, fz], [tx, ty, tz], r); },
    sweepSphereAgainstCellMesh(fx, fy, fz, tx, ty, tz, r, cells) {
      calls.cellMesh.push(cells);
      return sweepList(prims.cellMesh, [fx, fy, fz], [tx, ty, tz], r);
    },
    sweepSphereAgainstObjects(fx, fy, fz, tx, ty, tz, r, missileGuid, exempt) {
      calls.objects.push({ missileGuid, exempt });
      return sweepList(prims.objects.filter((p) => p.guid !== missileGuid), [fx, fy, fz], [tx, ty, tz], r);
    },
    terrainHeightAt(x, y) { return ground(x, y); },
    playerGuid() { return opts.localGuid ?? 0x50000001; },
    objectPartDims(guid) { return opts.dims && opts.dims.has(guid) ? Float32Array.from(opts.dims.get(guid)) : new Float32Array(0); },
  };
}

/** A three.js rig root at AC position p (AC components in the quaternion, as entities.js stores them). */
function rig(p, yaw = 0) {
  const g = new THREE.Group();
  g.position.set(p[0], p[1], p[2]);
  g.quaternion.set(0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2));
  return g;
}

function fakeLive(entities = [], extra = {}) {
  const entityMap = new Map();
  for (const e of entities) entityMap.set(e.guid, { guid: e.guid, root: rig(e.pos, e.yaw ?? 0), meta: e.meta ?? {} });
  return {
    entityManager: {
      entityMap,
      ...(extra.getHeading ? { getHeading: extra.getHeading } : {}),
      ...(extra.findGuidByName ? { findGuidByName: extra.findGuidByName } : {}),
    },
    frameTime: { tsMs: 0 },
  };
}

const E = [1000, 1000, 3]; // camera eye in the sensor scenes (LB 0x0505, ground z = 0)
const pose0 = (over = {}) => ({ t: 0, pos: E.slice(), h: 0, p: 0, r: 0, q: quatFromHPR(over.h ?? 0, over.p ?? 0, 0), fov: 60, ...over });

/** Counting los wrapper. */
function countingLos() {
  const c = { n: 0, perFrame: [] };
  const fn = (...args) => {
    c.n += 1;
    return LOS.segmentBlocked(...args);
  };
  return { fn, c };
}

// ===========================================================================
// world_query
// ===========================================================================

const F = WQ.ENTITY_FLAGS;

await check("W1 entity kinds from itemType / objDescFlags / guid tier, and obstacle words", () => {
  assert.equal(WQ.entityKindOf({ objDescFlags: F.ODF_PLAYER }, 0x80000001), "player");
  assert.equal(WQ.entityKindOf({}, 0x50000002), "player", "guid tier 0x5");
  assert.equal(WQ.entityKindOf({ itemType: F.ITEM_TYPE_CREATURE, objDescFlags: F.ODF_ATTACKABLE }, 0x80000001), "creature");
  assert.equal(WQ.entityKindOf({ itemType: F.ITEM_TYPE_CREATURE, objDescFlags: F.ODF_VENDOR }, 0x80000001), "npc");
  assert.equal(WQ.entityKindOf({ objDescFlags: F.ODF_DOOR }, 0x7a9b4001), "door");
  assert.equal(WQ.entityKindOf({ itemType: F.ITEM_TYPE_PORTAL }, 0x7a9b4002), "portal");
  assert.equal(WQ.entityKindOf({ objDescFlags: F.ODF_BINDSTONE }, 0x7a9b4003), "lifestone");
  assert.equal(WQ.entityKindOf({ objDescFlags: F.ODF_CORPSE | F.ODF_PLAYER }, 0x80000009), "corpse");
  assert.equal(WQ.entityKindOf({ itemType: F.ITEM_TYPE_CONTAINER }, 0x80000010), "container");
  assert.equal(WQ.entityKindOf(null, 0x80000011), "item");
  assert.equal(WQ.obstacleKindForEntity("npc"), "creature");
  assert.equal(WQ.obstacleKindForEntity("player"), "player");
  assert.equal(WQ.obstacleKindForEntity("door"), "door");
  assert.equal(WQ.obstacleKindForEntity("portal"), "prop");
  assert.equal(WQ.staticKindOf({ isBuilding: true }), "building");
  assert.equal(WQ.staticKindOf({ source: "scenery", archetype: "trunk-canopy" }), "tree");
  assert.equal(WQ.staticKindOf({ source: "scenery", archetype: "tip-flex" }), "tree");
  assert.equal(WQ.staticKindOf({ source: "scenery", archetype: null }), "rock");
  assert.equal(WQ.staticKindOf({ source: "object", archetype: "foliage-pollen" }), "tree");
  assert.equal(WQ.staticKindOf({ source: "object", archetype: "rigid-glint" }), "prop");
});

function worldScene() {
  const live = fakeLive([
    { guid: 0x50000001, pos: [1000, 1000, 0], meta: { objDescFlags: F.ODF_PLAYER, name: "Dolly" } },
    { guid: 0x80000010, pos: [1003, 1000, 0], yaw: Math.PI / 2, meta: { itemType: F.ITEM_TYPE_CREATURE, objDescFlags: F.ODF_ATTACKABLE, name: "Drudge Skulker", setupId: 0x02000123 } },
    { guid: 0x80000011, pos: [1000, 1006, 0], meta: { itemType: F.ITEM_TYPE_CREATURE, name: "Pathwarden Adara", objScale: 2 } },
    { guid: 0x7a9b4001, pos: [990, 1000, 0], meta: { objDescFlags: F.ODF_DOOR, name: "Door" } },
    { guid: 0x50000002, pos: [1001, 1001.5, 0], meta: { objDescFlags: F.ODF_PLAYER, name: "Other Player" } },
  ]);
  const sh = geoSh({ dims: new Map([[0x80000010, [0.7, 2.2]]]) });
  return { live, sh };
}

await check("W2 entitiesNear: local excluded, kinds filter, surface distance, dims from objectPartDims or defaults × objScale", () => {
  const { live, sh } = worldScene();
  const wq = WQ.createWorldQuery({ liveScene3d: live, sessionHandle: sh, THREE, ownerRegistry: null });
  const all = wq.entitiesNear([1000, 1000, 1], 8);
  assert.deepEqual(all.map((e) => e.guid), [0x50000002, 0x80000010, 0x80000011], "nearest first, local player excluded");
  const skulker = all.find((e) => e.guid === 0x80000010);
  assert.equal(skulker.kind, "creature");
  near(skulker.radius, 0.7, 1e-6, "objectPartDims radius");
  near(skulker.height, 2.2, 1e-6, "objectPartDims height");
  near(skulker.distance, 3 - Math.fround(0.7), 1e-9, "surface distance (radius is a Float32Array value)");
  assert.deepEqual(skulker.pos, [1003, 1000, 0], "root.position is AC world");
  assert.equal(skulker.setupId, 0x02000123);
  const adara = all.find((e) => e.guid === 0x80000011);
  assert.equal(adara.kind, "npc");
  near(adara.radius, 0.48 * 2, 1e-9, "default × objScale");
  near(adara.height, 1.8 * 2, 1e-9);
  assert.deepEqual(wq.entitiesNear([1000, 1000, 1], 8, { kinds: ["creature"] }).map((e) => e.guid), [0x80000010, 0x80000011], "obstacle kind matches npc");
  assert.deepEqual(wq.entitiesNear([1000, 1000, 1], 8, { kinds: "npc" }).map((e) => e.guid), [0x80000011]);
  assert.equal(wq.entitiesNear([1000, 1000, 1], 20, { includeLocal: true }).some((e) => e.isLocal && e.kind === "player"), true);
  assert.deepEqual(wq.entitiesNear([1000, 1000, 1], 20, { limit: 1 }).length, 1);
  assert.deepEqual(wq.entitiesNear([NaN, 0, 0], 5), []);
  assert.deepEqual(WQ.createWorldQuery({}).entitiesNear([0, 0, 0], 5), [], "no liveScene3d");
});

await check("W3 subject(ref): guid / hex / name / 'player'; heading = −yaw; velocity from history", () => {
  const { live, sh } = worldScene();
  let T = 10;
  const wq = WQ.createWorldQuery({ liveScene3d: live, sessionHandle: sh, THREE, now: () => T, ownerRegistry: null });
  const a = wq.subject(0x80000010);
  assert.equal(a.guid, 0x80000010);
  near(a.heading, -Math.PI / 2, 1e-12, "yaw +π/2 (facing west) → compass −π/2");
  assert.deepEqual(a.velocity, [0, 0, 0], "first sample");
  live.entityManager.entityMap.get(0x80000010).root.position.x += 1;
  T = 10.5;
  const b = wq.subject("0x80000010");
  near(b.velocity[0], 2, 1e-9, "vx = 1 m / 0.5 s");
  near(b.velocity[1], 0, 1e-12);
  assert.equal(wq.subject("Pathwarden Adara").guid, 0x80000011, "name scan");
  assert.equal(wq.subject("pathwarden adara").guid, 0x80000011, "case-insensitive fallback");
  assert.equal(wq.subject({ name: "Drudge Skulker" }).guid, 0x80000010);
  const me = wq.subject("player");
  assert.equal(me.guid, 0x50000001);
  assert.equal(me.isLocal, true);
  assert.equal(me.kind, "player");
  assert.equal(wq.subject("Nobody"), null);
  assert.equal(wq.subject(0x12345678), null, "unknown guid without wasm position");
  assert.equal(wq.subject(null), null);
  // getHeading wins when present (EntityManager convention: CCW yaw).
  const live2 = fakeLive([{ guid: 0x80000020, pos: [5, 5, 0], meta: { itemType: F.ITEM_TYPE_CREATURE } }], {
    getHeading: () => -Math.PI / 4,
    findGuidByName: (n) => (n === "Bob" ? 0x80000020 : 0),
  });
  const wq2 = WQ.createWorldQuery({ liveScene3d: live2, THREE, ownerRegistry: null });
  near(wq2.subject("Bob").heading, Math.PI / 4, 1e-12, "compass = −getHeading");
  // A guid with no rig resolves through sessionHandle.objectPosition (LB-local → world).
  const sh3 = { objectPosition: () => Float64Array.of(LB(5, 5) | 0x1c, 40, 41, 2) };
  const p = WQ.createWorldQuery({ liveScene3d: fakeLive([]), sessionHandle: sh3, ownerRegistry: null }).subject(0x80000099);
  assert.deepEqual(p.pos, [1000, 1001, 2]);
  near(WQ.compassFromRootQuat({ x: 0, y: 0, z: Math.sin(-0.3), w: Math.cos(-0.3) }), 0.6, 1e-12, "yaw −0.6 → compass 0.6");
  assert.equal(WQ.compassFromRootQuat({ x: NaN, y: 0, z: 0, w: 1 }), null);
});

await check("W4 localPlayer: LocalPlayerPose LB-local → world, compass heading, box freed; rig fallback", () => {
  let freed = 0;
  const pose = {
    landblockId: LB(5, 5) | 0x1a, x: 40, y: 41, z: 3, heading: Math.PI / 2, isOnGround: true,
    free() { freed += 1; },
  };
  const wq = WQ.createWorldQuery({ liveScene3d: fakeLive([]), sessionHandle: { getLocalPlayerPose: () => pose, playerGuid: () => 0x50000001 }, ownerRegistry: null });
  const lp = wq.localPlayer();
  assert.deepEqual(lp.pos, [1000, 1001, 3]);
  near(lp.heading, -Math.PI / 2, 1e-12);
  assert.equal(lp.cellId, (LB(5, 5) | 0x1a) >>> 0);
  assert.equal(lp.onGround, true);
  assert.equal(lp.guid, 0x50000001);
  assert.equal(freed, 1, "LocalPlayerPose freed");
  const { live, sh } = worldScene();
  delete sh.getLocalPlayerPose;
  const wq2 = WQ.createWorldQuery({ liveScene3d: live, sessionHandle: sh, ownerRegistry: null });
  const lp2 = wq2.localPlayer();
  assert.deepEqual(lp2.pos, [1000, 1000, 0]);
  assert.equal(lp2.cellId, (LB(5, 5) | (1 + Math.floor(40 / 24) * 8 + Math.floor(40 / 24))) >>> 0);
  assert.equal(WQ.createWorldQuery({}).localPlayer(), null);
});

/** Fake SoA table (getters throw after free). */
class FakeSoa {
  constructor(fields) {
    this._f = fields;
    this.freed = 0;
  }
  _g(k) {
    if (this.freed) throw new Error(`SoA.${k} read after free()`);
    return this._f[k];
  }
  get len() { return this._g("len"); }
  get modelIds() { return this._g("modelIds"); }
  get objIds() { return this._g("objIds"); }
  get positions() { return this._g("positions"); }
  get quaternions() { return this._g("quaternions"); }
  get scales() { return this._g("scales"); }
  get isBuilding() { return this._g("isBuilding"); }
  get landblockIds() { return this._g("landblockIds"); }
  free() {
    if (this.freed) throw new Error("double free");
    this.freed += 1;
  }
}

function staticsWasm() {
  const k = LB(5, 5);
  const made = [];
  const calls = [];
  const wasm = {
    made,
    calls,
    async fetch_landblock_objects_soa(ids) {
      calls.push(["objects", Array.from(ids)]);
      const lb = (ids[0] & 0xffff0000) >>> 0;
      const s = lb === k
        ? new FakeSoa({
          len: 2,
          modelIds: Uint32Array.of(0x01001234, 0x02000999),
          positions: Float32Array.of(40, 46, 0, 42, 40, 0),
          quaternions: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0),
          scales: Float32Array.of(1, 1),
          isBuilding: Uint8Array.of(1, 0),
          landblockIds: Uint32Array.of(k, k),
        })
        : new FakeSoa({ len: 0 });
      made.push(s);
      return s;
    },
    async fetch_landblock_scenery_soa(ids) {
      calls.push(["scenery", Array.from(ids)]);
      const lb = (ids[0] & 0xffff0000) >>> 0;
      const s = lb === k
        ? new FakeSoa({
          len: 3,
          objIds: Uint32Array.of(0x02000246, 0x02000494, 0x02000500),
          positions: Float32Array.of(37, 40, 0, 40, 37, 0, 44, 44, 0),
          quaternions: new Float32Array(12),
          scales: Float32Array.of(1.2, 1, 0.5),
          landblockIds: Uint32Array.of(k, k, k),
        })
        : new FakeSoa({ len: 0 });
      made.push(s);
      return s;
    },
  };
  return wasm;
}

const ARCH = new Map([[0x02000246, "trunk-canopy"], [0x02000500, "tip-flex"]]);

await check("W5 staticsNear: per-landblock SoA (lbKey|0xFFFE), world coords, kinds, freed, cached", async () => {
  const wasm = staticsWasm();
  const wq = WQ.createWorldQuery({ wasmExports: wasm, catalogs: { vfxArchetypeOf: (did) => ARCH.get(did) ?? null }, ownerRegistry: null });
  const got = await wq.staticsNear([1000, 1000, 1], 10);
  assert.deepEqual(wasm.calls, [["objects", [(LB(5, 5) | 0xfffe) >>> 0]], ["scenery", [(LB(5, 5) | 0xfffe) >>> 0]]]);
  const byDid = new Map(got.map((s) => [s.did, s]));
  assert.equal(byDid.get(0x01001234).kind, "building");
  assert.deepEqual(byDid.get(0x01001234).pos, [1000, 1006, 0], "LB-local → world");
  assert.equal(byDid.get(0x02000999).kind, "prop");
  assert.equal(byDid.get(0x02000246).kind, "tree");
  near(byDid.get(0x02000246).radius, 2.5 * 1.2, 1e-6, "tree radius × scale");
  assert.equal(byDid.get(0x02000494).kind, "rock", "uncatalogued scenery → rock");
  assert.equal(byDid.get(0x02000500).kind, "tree", "tip-flex scenery → tree");
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].distance <= got[i].distance, "sorted");
  for (const s of wasm.made) assert.equal(s.freed, 1, "SoA freed");
  const n = wasm.calls.length;
  const again = await wq.staticsNear([1000, 1000, 1], 10);
  assert.equal(wasm.calls.length, n, "cached landblock");
  assert.equal(again.length, got.length);
  assert.equal((await wq.staticsNear([1000, 1000, 1], 1.5)).map((s) => s.did).includes(0x02000999), true, "prop within 1.5 m");
  // Cached-only variant: never blocks, fetches missing landblocks in the background.
  const wasm2 = staticsWasm();
  const wq2 = WQ.createWorldQuery({ wasmExports: wasm2, ownerRegistry: null });
  assert.deepEqual(wq2.staticsNearCached([1000, 1000, 1], 10), []);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(wq2.staticsNearCached([1000, 1000, 1], 10).length >= 4, "background fetch landed");
  assert.deepEqual(await wq.staticsNear([NaN, 1, 1], 5), []);
  assert.deepEqual(await WQ.createWorldQuery({}).staticsNear([1000, 1000, 0], 5), [], "no wasm → empty");
});

await check("W6 groundZ: terrainHeightAt first, then the corridor (miss schedules ensure); cellAt outdoor/indoor", async () => {
  const ensured = [];
  const corridor = {
    heightAt: (x) => (x < 2000 ? 7 : null),
    async ensure(keys) {
      ensured.push(...keys);
      return { ok: true, loaded: keys, cached: [], failed: [] };
    },
  };
  const sh = { terrainHeightAt: (x) => (x < 500 ? 5 : undefined) };
  const wq = WQ.createWorldQuery({ sessionHandle: sh, terrainCorridor: corridor, ownerRegistry: null });
  assert.equal(wq.groundZ(100, 100), 5, "terrainHeightAt");
  assert.equal(wq.groundZ(1000, 100), 7, "corridor");
  assert.equal(wq.groundZ(3000, 100), null, "unknown");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(ensured, [LB(Math.floor(3000 / 192), 0)], "background ensure of the missing landblock");
  assert.equal(wq.groundZ(NaN, 1), null);
  // cellAt
  assert.equal(wq.cellAt([1000, 1000, 0]), (LB(5, 5) | 0x0a) >>> 0, "outdoor cell 1 + 1·8 + 1 from local (40, 40)");
  const walks = [];
  const sh2 = {
    resolveViewerCell(fx, fy, fz, tx, ty, tz, r, cell) {
      walks.push([fx, fy, fz, tx, ty, tz, r, cell]);
      return tx > 1005 ? (LB(5, 5) | 0x0106) >>> 0 : cell;
    },
  };
  const wq2 = WQ.createWorldQuery({ sessionHandle: sh2, ownerRegistry: null });
  const hint = (LB(5, 5) | 0x0105) >>> 0;
  assert.equal(wq2.cellAt([1001, 1000, -50], hint), hint, "no known point in the hint cell → hint");
  assert.equal(walks.length, 0);
  assert.equal(wq2.cellAt([1006, 1000, -50], { cell: hint, from: [1000, 1000, -50] }), (LB(5, 5) | 0x0106) >>> 0);
  assert.deepEqual(walks[0], [1000, 1000, -50, 1006, 1000, -50, 0.3, hint]);
  // The resolved point now seeds the next walk from that cell.
  wq2.cellAt([1007, 1000, -50], (LB(5, 5) | 0x0106) >>> 0);
  assert.deepEqual(walks[1].slice(0, 3), [1006, 1000, -50]);
  assert.equal(wq2.noteCellPoint(hint, [999, 999, -50]), true);
  wq2.cellAt([1000, 1000, -50], hint);
  assert.deepEqual(walks[2].slice(0, 3), [999, 999, -50]);
  assert.equal(wq2.cellAt([NaN, 0, 0], hint), 0);
});

await check("W7 describeHit refines kinds: scenery rock vs tree, creature + guid, player, building indoors = wall", async () => {
  const { live, sh } = worldScene();
  const wasm = staticsWasm();
  const wq = WQ.createWorldQuery({ liveScene3d: live, sessionHandle: sh, wasmExports: wasm, catalogs: { vfxArchetypeOf: (did) => ARCH.get(did) ?? null }, ownerRegistry: null });
  await wq.staticsNear([1000, 1000, 0], 10);
  // A horizontal normal alone says "tree"; the placement table says the rock at (1000, 997).
  const rock = wq.describeHit({ layer: "scenery", point: [1000, 997.4, 0.5], normal: [0, 1, 0] });
  assert.equal(rock.kind, "rock");
  assert.equal(rock.did, 0x02000494);
  const tree = wq.describeHit({ layer: "sweepSphereAgainstScenery", point: [997.3, 1000, 1], normal: [1, 0, 0] });
  assert.equal(tree.kind, "tree");
  const cr = wq.describeHit({ layer: "objects", point: [1002.4, 1000, 1], normal: [-1, 0, 0] });
  assert.equal(cr.kind, "creature");
  assert.equal(cr.guid, 0x80000010);
  const pl = wq.describeHit({ layer: "objects", point: [1001, 1001, 1], normal: [-1, 0, 0] });
  assert.equal(pl.kind, "player", "another player (the local dolly is never reported)");
  assert.equal(pl.guid, 0x50000002);
  assert.equal(wq.describeHit({ layer: "buildingMesh", point: [1000, 1005.5, 2] }).kind, "building");
  assert.equal(wq.describeHit({ layer: "buildingMesh", point: [1000, 1005.5, 2] }, { indoor: true }).kind, "wall");
  assert.equal(wq.describeHit({ layer: "terrain", point: [1, 1, 0] }).kind, "terrain");
  assert.equal(wq.describeHit({ layer: "cellMesh", point: [1, 1, 0] }).kind, "wall");
  assert.equal(wq.describeHit({}).kind, null);
});

// ===========================================================================
// particles_query
// ===========================================================================

/** A particle scene with the real worldRoot frame (rotation.x = −π/2). */
function particleScene() {
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  const entitiesGroup = new THREE.Group();
  worldRoot.add(entitiesGroup);
  worldRoot.updateMatrixWorld(true);
  const mgr = { particleTable: new Map(), _scene: entitiesGroup };
  let nextId = 1;
  const add = (o) => {
    const parent = new THREE.Group();
    parent.position.set(o.pos[0], o.pos[1], o.pos[2]); // _scene-local = AC
    entitiesGroup.add(parent);
    worldRoot.updateMatrixWorld(true);
    const parts = (o.parts ?? []).map((p) => {
      const m = new THREE.Object3D();
      m.position.set(p[0], p[1], p[2]);
      m.scale.setScalar(p[3] ?? 1);
      m.userData.__op = p[4] ?? 1;
      m.geometry = { boundingSphere: { radius: 0.5 } };
      return m;
    });
    const em = {
      parent,
      partIndex: -1,
      parentOffset: { position: new THREE.Vector3(...(o.offset ?? [0, 0, 0])), quaternion: new THREE.Quaternion() },
      info: { id: o.did, sortingSphere: { radius: o.sort ?? 1 }, maxParticles: o.max ?? 10, startTrans: 0, fxProfile: o.fxProfile ?? null },
      numParticles: o.n ?? 10,
      parts,
      _baseIsAdditive: o.additive === true,
      skyGlow: o.skyGlow === true,
      filmHidden: o.filmHidden === true,
    };
    const id = nextId++;
    mgr.particleTable.set(id, em);
    return { id, em };
  };
  return { worldRoot, entitiesGroup, mgr, add };
}

const CATALOG = {
  emitters: {
    "0x32000100": { family: "smoke_dark", behavior: "plume" },
    "0x32000200": { family: "fire", behavior: "standing" },
    "0x32000300": { family: "sky", behavior: "drift" },
    "0x32000400": { family: "mist_white", behavior: "drift" },
  },
  synthesized: { "particle.brazierEmbers.smoke": { family: "smoke_dark" } },
};

await check("P1 emitter spheres: THREE-frame anchors → AC, radius from sorting sphere + offset + live particles, skips", () => {
  const S = particleScene();
  const smoke = S.add({ did: 0x32000100, pos: [1000, 1006, 1.5], sort: 2, offset: [0, 0, 0.5], parts: [[1000, 1006, 6, 1, 0.8], [1000, 1006, 2, 1, 0.6]] });
  S.add({ did: 0x32000300, pos: [1000, 1006, 50] }); // sky family
  S.add({ did: 0x32000100, pos: [1000, 1006, 1], skyGlow: true });
  S.add({ did: 0x32000100, pos: [1000, 1006, 1], filmHidden: true });
  S.add({ did: 0x32000100, pos: [1000, 1006, 1], n: 0 }); // nothing live
  const pq = PQ.createParticlesQuery({ managers: [S.mgr], THREE, catalog: CATALOG, ownerRegistry: null });
  const snap = pq.snapshot();
  assert.equal(snap.length, 1, "sky / skyGlow / filmHidden / empty skipped");
  const s = snap[0];
  near(s.center[0], 1000, 1e-9, "AC x");
  near(s.center[1], 1006, 1e-9, "AC y (from three −z)");
  near(s.center[2], 1.5, 1e-9, "AC z (from three y)");
  near(s.radius, 4.5 + 0.5, 1e-9, "live particle 4.5 m above the anchor + its 0.5 m size");
  assert.equal(s.family, "smoke_dark");
  assert.equal(s.behavior, "plume");
  assert.equal(s.occludes, true);
  near(s.density, 1 * 0.7, 1e-9, "√(10/10) × mean opacity 0.7");
  assert.equal(s.key, `m0#${smoke.id}`);
  assert.equal(s.emitter, smoke.em);
  const withHidden = PQ.createParticlesQuery({ managers: [S.mgr], THREE, catalog: CATALOG, ownerRegistry: null, includeHidden: true });
  assert.equal(withHidden.snapshot().length, 2, "includeHidden keeps the filmHidden one");
  // No THREE: matrixWorld fallback gives the same AC centre.
  const noThree = PQ.createParticlesQuery({ managers: [S.mgr], catalog: CATALOG, ownerRegistry: null }).snapshot();
  near(noThree[0].center[1], 1006, 1e-9, "matrixWorld fallback");
  assert.equal(PQ.emitterCatalogKey(0x3200000b), "0x3200000B");
  assert.equal(PQ.familyOccludes("fire"), false);
  assert.equal(PQ.familyOccludes("gas_alpha"), true);
  assert.equal(PQ.familyOccludes(null, { additive: false, radius: 2 }), true, "big uncatalogued alpha cloud");
  assert.equal(PQ.familyOccludes(null, { additive: true, radius: 5 }), false);
  assert.deepEqual(pq.familyInfo(0, "particle.brazierEmbers.smoke"), { family: "smoke_dark", behavior: null }, "synthesized profile");
  const fnLookup = PQ.createParticlesQuery({ managers: [S.mgr], THREE, familyOf: () => "fire", ownerRegistry: null });
  assert.equal(fnLookup.snapshot()[0].occludes, false, "injected familyOf wins");
});

await check("P2 near / alongSegment / onLens / inView", () => {
  const S = particleScene();
  S.add({ did: 0x32000100, pos: [1000, 1006, 2], sort: 1.5 }); // smoke ahead
  S.add({ did: 0x32000200, pos: [1003, 1008, 1], sort: 0.5, additive: true }); // fire ahead-right
  S.add({ did: 0x32000100, pos: [1000, 990, 2], sort: 1 }); // smoke behind
  const pq = PQ.createParticlesQuery({ managers: [S.mgr], THREE, catalog: CATALOG, ownerRegistry: null });
  const n = pq.near([1000, 1000, 2], 8.5);
  assert.deepEqual(n.map((r) => r.family), ["smoke_dark", "fire"]);
  near(n[0].range, 6 - 1.5, 1e-9, "surface distance");
  const seg = pq.alongSegment([1000, 1000, 2], [1000, 1012, 2], 0);
  assert.equal(seg.length, 1);
  near(seg[0].t, 4.5 / 12, 1e-9, "entry fraction");
  near(seg[0].range, 4.5, 1e-9);
  assert.equal(pq.alongSegment([1000, 1000, 2], [1000, 1012, 2], 3).length, 2, "inflated by radius 3 reaches the fire");
  const pose = { pos: [1000, 1000, 2], h: 0, p: 0, fov: 60 };
  const iv = pq.inView(pose, { rangeM: 25, aspect: 16 / 9 });
  assert.deepEqual(iv.map((r) => r.family), ["smoke_dark", "fire"], "behind-camera smoke not in view");
  assert.equal(iv[0].occludes, true);
  assert.equal(iv[1].occludes, false);
  assert.equal(pq.onLens(pose), null, "nothing within 2 m");
  const lens = pq.onLens({ pos: [1000, 1005, 2] }, { radius: 2 });
  assert.equal(lens.family, "smoke_dark");
  assert.ok(lens.density > 0.9, `inside the cloud: ${lens.density}`);
  assert.equal(pq.onLens({ pos: [NaN, 0, 0] }), null);
  assert.deepEqual(pq.near(null, 3), []);
  assert.deepEqual(pq.alongSegment([0, 0, 0], null), []);
});

await check("P3 owner-registry manager discovery + owner keys; frame-key caching", () => {
  const S = particleScene();
  const e = S.add({ did: 0x32000200, pos: [5, 5, 1] });
  const byMgr = new WeakMap([[S.mgr, new Map([[e.id, "static:84213760"]])]]);
  const registry = { _owners: new Map([["static:84213760", { ids: new Map([[e.id, S.mgr]]) }]]), _byMgr: byMgr };
  let key = 1;
  const pq = PQ.createParticlesQuery({ ownerRegistry: registry, THREE, catalog: CATALOG, frameKey: () => key });
  const snap = pq.snapshot();
  assert.equal(snap.length, 1, "manager found through the registry");
  assert.equal(snap[0].key, `static:84213760#${e.id}`);
  assert.equal(snap[0].ownerKey, "static:84213760");
  S.add({ did: 0x32000200, pos: [6, 6, 1] });
  assert.equal(pq.snapshot().length, 1, "same frame key → cached");
  key = 2;
  assert.equal(pq.snapshot().length, 2, "new frame → rebuilt");
  S.add({ did: 0x32000200, pos: [7, 7, 1] });
  pq.invalidate();
  assert.equal(pq.snapshot().length, 3, "invalidate()");
  // liveScene3d managers (world manager on the entity manager) + the frameTime default key.
  const live = { entityManager: { _worldParticleManager: S.mgr }, frameTime: { tsMs: 5 } };
  const pq2 = PQ.createParticlesQuery({ liveScene3d: live, THREE, ownerRegistry: null });
  assert.equal(pq2.snapshot().length, 3);
  assert.equal(pq2.stats().rebuilds, 1);
  pq2.snapshot();
  assert.equal(pq2.stats().rebuilds, 1, "same frameTime.tsMs → cached");
});

await check("W8 particlesNear: internal particle query uses catalogs.particleFamilyOf; rows are JSON-safe", () => {
  const S = particleScene();
  S.add({ did: 0x32000100, pos: [1000, 1004, 2], sort: 1 });
  const live = { entityManager: { entityMap: new Map(), _worldParticleManager: S.mgr }, frameTime: { tsMs: 1 } };
  const wq = WQ.createWorldQuery({
    liveScene3d: live,
    THREE,
    ownerRegistry: null,
    catalogs: { particleFamilyOf: (did) => (did === 0x32000100 ? { family: "gas_alpha", behavior: "plume" } : null) },
  });
  const rows = wq.particlesNear([1000, 1000, 2], 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].family, "gas_alpha");
  assert.equal(rows[0].occludes, true);
  near(rows[0].range, 3, 1e-9);
  assert.equal("emitter" in rows[0] || "manager" in rows[0], false, "live refs dropped");
  assert.doesNotThrow(() => JSON.stringify(rows));
  assert.ok(wq.particles.near([1000, 1000, 2], 5)[0].emitter, "the raw query keeps the emitter for runtime hides");
});

// ===========================================================================
// sensors
// ===========================================================================

function sensorRig(opts = {}) {
  const sh = geoSh(opts.sh ?? {});
  const live = fakeLive(opts.entities ?? []);
  const wq = WQ.createWorldQuery({ liveScene3d: live, sessionHandle: sh, THREE, ownerRegistry: null, particles: opts.particles, now: () => 0 });
  const L = countingLos();
  const sensors = SN.createSensors({ worldQuery: wq, sh, los: L.fn, particles: opts.particles, budget: { sweepsPerFrame: opts.budget ?? 16 }, log: opts.log });
  return { sh, live, wq, L, sensors };
}

await check("S1 a tree 3 m ahead-left → sectors.left ≈ 3 (kind tree); words 'close tree' ahead-left", () => {
  const dir = SN.compassDir(-16 * DEG);
  const c = [E[0] + dir[0] * 3.3, E[1] + dir[1] * 3.3];
  const { sensors, L } = sensorRig({ sh: { prims: { scenery: [{ type: "cyl", c, r: 0.3, z0: 0, z1: 8 }] } } });
  const f = sensors.sense(pose0(), {}, 0.1);
  assert.ok(L.c.n <= 16);
  near(f.sectors.left.range, 3.0, 1e-6, "left sector range");
  assert.equal(f.sectors.left.kind, "tree");
  assert.equal(f.sectors.center.range, Infinity);
  assert.equal(f.sectors.far_left.range, Infinity);
  assert.equal(f.sectors.right.range, Infinity);
  near(f.nearest.range, 3.0, 1e-6, "nearest");
  assert.equal(f.nearest.kind, "tree");
  near(f.nearest.bearingDeg, -16, 1e-6, "bearing");
  near(f.nearest.elevDeg, 0, 1e-6, "elevation");
  near(f.sides.down.range, 3, 0.01, "ground 3 m below (terrain march)");
  assert.equal(f.sides.down.kind, "terrain");
  assert.ok(Number.isFinite(f.freeAhead.level) && f.freeAhead.level > 3, "the wide level band grazes the trunk");
  const st = buildPilotState(f, { technique: "classic.dolly-in" });
  assert.equal(st.obstacles.left, "close tree");
  assert.equal(st.obstacles.ahead, "clear");
  assert.equal(st.nearest.side, "ahead-left");
  assert.equal(st.nearest.kind, "tree");
  assert.equal(st.obstacles.below, "close terrain");
  assert.equal(st.subject.visibility, "no subject");
});

await check("S2 a wall ahead → sectors.center (building outdoors / wall indoors), bands, far sectors longer", () => {
  const wall = { type: "plane", axis: 1, value: E[1] + 6, lo: [E[0] - 50, 0, -10], hi: [E[0] + 50, 0, 30] };
  const { sensors } = sensorRig({ sh: { prims: { buildingMesh: [wall] } } });
  const f = sensors.sense(pose0(), {}, 0.1);
  near(f.sectors.center.range, 6, 1e-6, "center");
  assert.equal(f.sectors.center.kind, "building");
  near(f.sectors.far_left.range, (6 - 0.25) / Math.cos(32 * DEG) + 0.25, 1e-6, "far_left");
  near(f.sectors.right.range, (6 - 0.25) / Math.cos(16 * DEG) + 0.25, 1e-6, "right");
  near(f.freeAhead.level, 6, 1e-6, "level band");
  near(f.freeAhead.above, 6, 1e-6, "above band");
  near(f.freeAhead.below, 6, 1e-6, "below band");
  near(f.nearest.range, 6, 1e-6, "the wall, not the ground 3 m below (ground counts only when descending)");
  // Indoors: the same wall in the cell mesh is a "wall"; cell ids are passed through.
  const floor = { type: "plane", axis: 2, value: 0, lo: [0, 0, 0], hi: [5000, 5000, 0] };
  const R2 = sensorRig({ sh: { prims: { cellMesh: [{ ...wall }, floor] } } });
  const cells = [(LB(5, 5) | 0x0105) >>> 0];
  const g = R2.sensors.sense(pose0(), { indoor: true, cellIds: cells }, 0.1);
  near(g.sectors.center.range, 6, 1e-6);
  assert.equal(g.sectors.center.kind, "wall");
  assert.ok(R2.sh.calls.cellMesh.every((c) => c instanceof Uint32Array && c[0] === cells[0]), "cell ids → Uint32Array");
  near(g.sides.down.range, 3, 1e-6, "cell floor (no terrain march indoors)");
  assert.equal(g.sides.down.kind, "wall");
  assert.equal(g.indoor, true);
});

const SUBJ = 0x80000001;
function subjectEntity() {
  return { guid: SUBJ, pos: [E[0], E[1] + 12, 0], meta: { itemType: F.ITEM_TYPE_CREATURE, objDescFlags: F.ODF_ATTACKABLE, name: "Mosswart" } };
}
const subjectSphere = { type: "sphere", c: [E[0], E[1] + 12, 0.9], r: 0.5, guid: SUBJ };

await check("S3 a subject behind a wall → visibleFrac 0 and the unseen timer grows; no wall → visible (guid excluded)", () => {
  const wall = { type: "plane", axis: 1, value: E[1] + 6, lo: [E[0] - 50, 0, -10], hi: [E[0] + 50, 0, 30] };
  const { sensors, wq } = sensorRig({ entities: [subjectEntity()], sh: { prims: { buildingMesh: [wall], objects: [subjectSphere] } } });
  let prev = -1;
  let f;
  for (let i = 0; i < 12; i++) {
    f = sensors.sense(pose0(), { subjectRef: SUBJ }, 0.1);
    assert.equal(f.subject.visibleFrac, 0, `frame ${i}`);
    assert.ok(f.subject.unseenSec > prev, "unseen timer grows");
    prev = f.subject.unseenSec;
  }
  near(f.subject.unseenSec, 1.2, 1e-9, "12 × 0.1 s");
  assert.equal(f.subject.occluderKind, "building");
  assert.equal(f.subject.raysMeasured, 5);
  assert.equal(f.subject.guid, SUBJ);
  assert.ok(Array.isArray(f.subject.ndc), "subject in front");
  near(f.subject.ndc[0], 0, 1e-9, "centred horizontally");
  assert.ok(Number.isFinite(f.subject.sizeRatio));
  const st = buildPilotState(f, {});
  assert.equal(st.subject.visibility, "fully hidden");
  assert.equal(st.subject.unseen_for, "a while");
  assert.equal(st.subject.occluded_by, "building");

  // Without the wall: visible; the objects sweeps carried the subject guid as missile_guid.
  const R2 = sensorRig({ entities: [subjectEntity()], sh: { prims: { objects: [subjectSphere] } } });
  let g;
  for (let i = 0; i < 3; i++) g = R2.sensors.sense(pose0(), { subject: R2.wq.subject(SUBJ) }, 0.1);
  assert.equal(g.subject.visibleFrac, 1);
  assert.equal(g.subject.unseenSec, 0);
  assert.equal(g.subject.occluderKind, null);
  assert.ok(R2.sh.calls.objects.some((c) => c.missileGuid === SUBJ && c.exempt === true), "missile_guid = subject guid");
  // A point subject (no guid) whose own body is hit near the target still counts as visible.
  const R3 = sensorRig({ sh: { prims: { objects: [subjectSphere] } } });
  let h;
  for (let i = 0; i < 3; i++) h = R3.sensors.sense(pose0(), { subject: { pos: [E[0], E[1] + 12, 0], radius: 0.5, height: 1.8 } }, 0.1);
  assert.equal(h.subject.visibleFrac, 1, "self-hit rule");
  // The subject 3 m dead ahead is not an obstacle for the clearance probes (a dolly-in
  // approaches it on purpose) — unless ctx.subjectIsObstacle opts back in.
  const close = { guid: SUBJ, pos: [E[0], E[1] + 3, 0], meta: { itemType: F.ITEM_TYPE_CREATURE, objDescFlags: F.ODF_ATTACKABLE } };
  const body = { type: "sphere", c: [E[0], E[1] + 3, E[2]], r: 0.5, guid: SUBJ };
  const R4 = sensorRig({ entities: [close], sh: { prims: { objects: [body] } } });
  const m1 = R4.sensors.sense(pose0(), { subjectRef: SUBJ }, 0.1);
  assert.equal(m1.sectors.center.range, Infinity, "own subject excluded");
  assert.equal(m1.nearest.range, Infinity);
  const m2 = R4.sensors.sense(pose0(), { subjectRef: SUBJ, subjectIsObstacle: true }, 0.1);
  near(m2.sectors.center.range, 2.5, 1e-6, "counted when asked");
  assert.equal(m2.sectors.center.kind, "creature");
  const R5 = sensorRig({ entities: [close], sh: { prims: { objects: [body] } } });
  near(R5.sensors.sense(pose0(), {}, 0.1).sectors.center.range, 2.5, 1e-6, "with no subject it is just a creature");
  // Changing the subject resets its rays and timer.
  const k = sensors.sense(pose0(), { subject: { pos: [E[0] + 2, E[1] + 3, 0], radius: 0.4, height: 1.8 } }, 0.1);
  assert.equal(k.subject.raysMeasured <= 5, true);
  assert.ok(k.subject.unseenSec <= 0.1 + 1e-12, "timer restarted for the new subject");
  void wq;
});

await check("S4 smoke between camera and subject → inView occludes, visibleFrac thinned, occluder 'particles'; smoke on the lens", () => {
  const S = particleScene();
  const smoke = S.add({ did: 0x32000100, pos: [E[0], E[1] + 6, 1.5], sort: 1.5, n: 10, max: 10 });
  S.add({ did: 0x32000200, pos: [E[0] + 3, E[1] + 8, 1], sort: 0.5, additive: true });
  const pq = PQ.createParticlesQuery({ managers: [S.mgr], THREE, catalog: CATALOG, ownerRegistry: null });
  const { sensors } = sensorRig({ entities: [subjectEntity()], sh: { prims: { objects: [subjectSphere] } }, particles: pq });
  let f;
  for (let i = 0; i < 3; i++) f = sensors.sense(pose0(), { subjectRef: SUBJ }, 0.1);
  const smokeRow = f.particles.inView.find((p) => p.family === "smoke_dark");
  assert.ok(smokeRow, "smoke in view");
  assert.equal(smokeRow.occludes, true);
  near(smokeRow.range, Math.hypot(6, 1.5) - 1.5, 1e-9, "range to the cloud surface");
  const fire = f.particles.inView.find((p) => p.family === "fire");
  assert.equal(fire.occludes, false);
  near(f.subject.visibleFrac, 1 - 0.6 * 1, 1e-9, "density 1 smoke on the centre ray");
  assert.equal(f.subject.occluderKind, "particles");
  assert.ok(f.subject.occluderIds.includes(`m0#${smoke.id}`), "fade id of the cloud");
  assert.equal(f.particles.onLens, null);
  const st = buildPilotState(f, {});
  assert.equal(st.subject.visibility, "partly hidden");
  assert.equal(st.subject.occluded_by, "particles");
  assert.match(st.particles.in_view, /smoke dark blocking the view/);
  // On the lens.
  const S2 = particleScene();
  S2.add({ did: 0x32000400, pos: [E[0], E[1] + 0.5, E[2]], sort: 1.5, n: 4, max: 10 });
  const pq2 = PQ.createParticlesQuery({ managers: [S2.mgr], THREE, catalog: CATALOG, ownerRegistry: null });
  const R2 = sensorRig({ particles: pq2 });
  const g = R2.sensors.sense(pose0(), {}, 0.1);
  assert.equal(g.particles.onLens.family, "mist_white");
  near(g.particles.onLens.density, Math.sqrt(0.4), 1e-9, "√(4/10) × opacity 1 × full coverage");
  assert.equal(g.particles.onLens.occludes, true);
  assert.match(buildPilotState(g, {}).particles.on_lens, /^moderate mist white$/);
});

await check("S5 budget honoured every frame; round robin refreshes every probe; ages; motion compensation", () => {
  const wall = { type: "plane", axis: 1, value: E[1] + 10, lo: [E[0] - 50, 0, -10], hi: [E[0] + 50, 0, 30] };
  const nominal = [[E[0], E[1], E[2]], [E[0], E[1] + 3, E[2]], [E[0], E[1] + 6, E[2]], [E[0], E[1] + 9, E[2]]];
  for (const budget of [16, 4, 1]) {
    const { sensors, L } = sensorRig({ entities: [subjectEntity()], sh: { prims: { buildingMesh: [wall], objects: [subjectSphere] } }, budget });
    let last = 0;
    let frames = 0;
    let f;
    do {
      f = sensors.sense(pose0(), { subjectRef: SUBJ, nominalAhead: nominal }, 0.05);
      const used = L.c.n - last;
      last = L.c.n;
      assert.ok(used <= budget, `budget ${budget}: frame used ${used}`);
      assert.equal(f.budget.calls, used);
      assert.equal(f.budget.limit, budget);
      frames += 1;
    } while (!Object.values(f.ages).every(Number.isFinite) && frames < 40);
    assert.ok(Object.values(f.ages).every(Number.isFinite), `budget ${budget}: every probe measured`);
    const fullCycle = 5 + 3 + 5 + 3 + 5; // sectors, bands, sides, path chords, subject rays
    assert.ok(frames <= Math.ceil(fullCycle / budget) + 1, `budget ${budget}: ${frames} frames to cover`);
    assert.ok(sensors.stats().maxCalls <= budget);
  }
  // Ages grow while a probe waits its turn; ranges are motion-compensated in between.
  const { sensors } = sensorRig({ sh: { prims: { buildingMesh: [wall] } }, budget: 1 });
  const f1 = sensors.sense(pose0(), {}, 0.1);
  near(f1.sectors.center.range, 10, 1e-6);
  assert.equal(f1.ages.sectors, Infinity, "other sectors not yet measured");
  const f2 = sensors.sense({ ...pose0(), pos: [E[0], E[1] + 1, E[2]] }, { velocity: [0, 0, 0] }, 0.1);
  near(f2.sectors.center.range, 9, 1e-6, "compensated by the 1 m moved");
  const rec = f2.sectors.center;
  assert.equal(rec.kind, "building");
  const f3 = sensors.sense({ ...pose0(), pos: [E[0], E[1] + 1, E[2]] }, { velocity: [0, 0, 0] }, 0.1);
  near(f3.sectors.center.range, 9, 1e-6);
  assert.ok(f3.ages.sectors === Infinity || f3.ages.sectors >= 0.2 - 1e-12);
});

await check("S6 pathAhead: ttc from ctx.nominalAhead (timed points) and from the velocity", () => {
  const wall = { type: "plane", axis: 1, value: E[1] + 6, lo: [E[0] - 50, 0, -10], hi: [E[0] + 50, 0, 30] };
  const { sensors } = sensorRig({ sh: { prims: { buildingMesh: [wall] } } });
  const nominal = [
    { t: 0, pos: [E[0], E[1], E[2]] },
    { t: 1, pos: [E[0], E[1] + 5, E[2]] },
    { t: 2, pos: [E[0], E[1] + 10, E[2]] },
  ];
  const f = sensors.sense(pose0({ t: 0 }), { nominalAhead: nominal }, 0.1);
  near(f.pathAhead.ttc, 1 + 0.75 / 5, 1e-6, "contact 5.75 m along the path");
  assert.equal(f.pathAhead.kind, "building");
  near(f.pathAhead.distance, 5.75, 1e-6);
  assert.equal(buildPilotState(f, {}).path_ahead.contact_in, "soon");
  // Velocity extrapolation (no plan): 5 m/s north for 2 s.
  const R2 = sensorRig({ sh: { prims: { buildingMesh: [wall] } } });
  const g = R2.sensors.sense(pose0(), { velocity: [0, 5, 0] }, 0.5);
  near(g.pathAhead.ttc, 5.75 / 5, 1e-6);
  // Function form + untimed points (spread over aheadSec).
  const R3 = sensorRig({ sh: { prims: { buildingMesh: [wall] } } });
  const h = R3.sensors.sense(pose0(), { nominalAhead: () => [[E[0], E[1], E[2]], [E[0], E[1] + 12, E[2]]], aheadSec: 2 }, 0.1);
  near(h.pathAhead.ttc, (5.75 / 12) * 2, 1e-6);
  // At rest with no plan: no contact, age 0.
  const R4 = sensorRig({ sh: { prims: { buildingMesh: [wall] } } });
  const k = R4.sensors.sense(pose0(), {}, 0.1);
  assert.equal(k.pathAhead.ttc, Infinity);
  assert.equal(k.ages.pathAhead, 0);
  assert.deepEqual(SN.readNominalAhead([[1, 2, 3], { pos: [4, 5, 6] }, "bad"], NaN, 2).map((p) => p.dt), [0, 2]);
});

await check("S7 limits: ceiling / floor / room, and the above/below band clamps", () => {
  const ceiling = { type: "plane", axis: 2, value: E[2] + 1.5, lo: [0, 0, 0], hi: [5000, 5000, 0] };
  const floor = { type: "plane", axis: 2, value: E[2] - 1, lo: [0, 0, 0], hi: [5000, 5000, 0] };
  const leftWall = { type: "plane", axis: 0, value: E[0] - 1.2, lo: [0, 0, -100], hi: [0, 5000, 100] };
  const { sensors } = sensorRig({ sh: { prims: { cellMesh: [ceiling, floor, leftWall] } } });
  const f = sensors.sense(pose0(), { indoor: true, cellIds: [(LB(5, 5) | 0x0105) >>> 0] }, 0.1);
  near(f.sides.up.range, 1.5, 1e-6, "ceiling");
  near(f.sides.down.range, 1, 1e-6, "floor");
  near(f.sides.left.range, 1.2, 1e-6, "left wall");
  assert.equal(f.sides.right.range, Infinity);
  assert.equal(f.limits.canRise, false);
  assert.equal(f.limits.canSink, false);
  near(f.limits.ceiling, 1.5, 1e-6);
  near(f.limits.roomLeft, 0.45, 1e-6, "clearance − 0.75 m margin");
  assert.equal(f.limits.roomRight, Infinity);
  assert.equal(f.freeAhead.above, 0, "no room for the above band under a 1.5 m ceiling");
  assert.equal(f.freeAhead.below, 0, "nor for the below band over a 1 m floor");
  const st = buildPilotState(f, {});
  assert.equal(st.limits.can_rise, "no");
  assert.equal(st.limits.room_left, "none");
  assert.equal(st.limits.room_right, "plenty");
  assert.equal(st.limits.ceiling, "very close");
  // Open sky outdoors: can rise; 3 m above flat ground: can sink.
  const R2 = sensorRig({});
  const g = R2.sensors.sense(pose0(), {}, 0.1);
  assert.equal(g.limits.canRise, true);
  assert.equal(g.limits.canSink, true);
  assert.equal(g.limits.ceiling, Infinity);
});

await check("S8 sensing heading: travel direction while moving (hysteresis), camera heading at rest; nadir pitch has no NaN", () => {
  const eastWall = { type: "plane", axis: 0, value: E[0] + 6, lo: [0, 0, -100], hi: [0, 5000, 100] };
  const northWall = { type: "plane", axis: 1, value: E[1] + 4, lo: [0, 0, -100], hi: [5000, 0, 100] };
  const { sensors } = sensorRig({ sh: { prims: { buildingMesh: [eastWall, northWall] } } });
  const f = sensors.sense(pose0(), { velocity: [5, 0, 0] }, 0.5);
  near(f.senseHeading, Math.PI / 2, 1e-9, "travelling east while looking north");
  near(f.sectors.center.range, 6, 1e-6, "east wall ahead of the travel direction");
  near(f.sides.left.range, 4, 1e-6, "north wall on the travel-left");
  const g = sensors.sense(pose0(), { velocity: [0.45, 0, 0] }, 0.5);
  near(g.senseHeading, Math.PI / 2, 1e-9, "stays in travel mode above the exit speed");
  const h = sensors.sense(pose0(), { velocity: [0.2, 0, 0] }, 0.5);
  near(h.senseHeading, 0, 1e-9, "drops back to the camera heading");
  const k = sensors.sense(pose0(), { velocity: [0.45, 0, 0] }, 0.5);
  near(k.senseHeading, 0, 1e-9, "does not re-enter below the enter speed");
  assert.equal(sensors.sense(pose0(), { velocity: [5, 0, 0], senseFrame: "camera" }, 0.5).senseHeading, 0, "senseFrame camera");
  near(sensors.sense(pose0(), { senseHeading: 1.25 }, 0.5).senseHeading, 1.25, 1e-12, "explicit override");

  // Straight down: heading 0.7, pitch −90°, a trunk 5 m along the heading.
  const d = SN.compassDir(0.7);
  const R2 = sensorRig({ sh: { prims: { scenery: [{ type: "cyl", c: [E[0] + d[0] * 5, E[1] + d[1] * 5], r: 0.3, z0: 0, z1: 10 }] } } });
  const nadir = { t: 0, pos: E.slice(), q: quatFromHPR(0.7, -Math.PI / 2, 0), fov: 60 };
  const n1 = R2.sensors.sense({ ...nadir, h: 0.7, p: -Math.PI / 2 }, {}, 0.1);
  near(n1.senseHeading, 0.7, 1e-9);
  near(n1.sectors.center.range, 4.7, 1e-6, "horizontal sectors at nadir");
  assertNoNaN(n1);
  const n2 = R2.sensors.sense(nadir, {}, 0.1); // heading only from q (ambiguous at nadir → hint)
  assertNoNaN(n2);
  assert.ok(Number.isFinite(n2.senseHeading));
  // Subject straight below the nadir camera: ndc ≈ centre, no NaN.
  const R3 = sensorRig({});
  const n3 = R3.sensors.sense({ ...nadir, h: 0.7, p: -Math.PI / 2, pos: [E[0], E[1], 20] }, { subject: { pos: [E[0], E[1], 0], radius: 0.5, height: 1.8 } }, 0.1);
  assertNoNaN(n3);
  near(n3.subject.ndc[0], 0, 1e-9);
  near(n3.subject.ndc[1], 0, 1e-9);
});

await check("S9 nearest ignores the ground below unless descending; a cut resets every probe", () => {
  const { sensors } = sensorRig({ sh: { ground: () => 0 } });
  const low = { ...pose0(), pos: [E[0], E[1], 1] };
  const f = sensors.sense(low, {}, 0.5);
  near(f.sides.down.range, 1, 0.01);
  assert.equal(f.nearest.range, Infinity, "terrain below is not an obstacle at level flight");
  const g = sensors.sense(low, { velocity: [0, 0, -1] }, 0.5);
  near(g.nearest.range, 1, 0.01, "descending → terrain below counts");
  assert.equal(g.nearest.kind, "terrain");
  near(g.nearest.elevDeg, -90, 1e-6);
  near(g.pathAhead.ttc, 1, 0.02, "1 m at 1 m/s");
  assert.equal(g.pathAhead.kind, "terrain");
  // Cut: a 100 m jump forgets everything not re-measured this frame.
  const R2 = sensorRig({ budget: 2 });
  for (let i = 0; i < 8; i++) R2.sensors.sense(pose0(), {}, 0.1);
  const before = R2.sensors.sense(pose0(), {}, 0.1);
  assert.ok(Number.isFinite(before.ages.sides));
  const after = R2.sensors.sense({ ...pose0(), pos: [E[0] + 100, E[1], E[2]] }, {}, 0.1);
  assert.equal(R2.sensors.stats().cuts, 1);
  assert.equal(after.ages.sides, Infinity, "probes cleared on the cut");
  assert.equal(after.speedMps, 0, "no 1000 m/s spike across a cut");
  R2.sensors.reset();
  const fresh = R2.sensors.sense({ ...pose0(), t: undefined }, {}, 0.25);
  near(fresh.t, 0.25, 1e-12, "reset restarted the sensor clock");
  assert.equal(fresh.ages.sides, Infinity, "reset forgot every probe");
});

// ===========================================================================
// review fixes: indoor cell sweeps (contracts-1), static fades (contracts-3 / seams-2 / gate-2)
// ===========================================================================

await check("W9 renderSetCells (shared by safety + sensors): viewer render set first, else getRenderSet(1), copied; null when unusable", () => {
  const viewer = [(LB(5, 5) | 0x0110) >>> 0, (LB(5, 5) | 0x0111) >>> 0];
  const player = [(LB(5, 5) | 0x0105) >>> 0];
  const depths = [];
  const both = { getViewerRenderSet: () => viewer, getRenderSet: (d) => (depths.push(d), player) };
  const a = WQ.renderSetCells(both);
  assert.ok(a instanceof Uint32Array, "a Uint32Array (what the wasm cell sweeps take)");
  assert.deepEqual(Array.from(a), viewer, "the camera-rooted viewer set wins");
  const src = [7, 8];
  const copy = WQ.renderSetCells({ getRenderSet: () => src });
  src.push(9);
  assert.deepEqual(Array.from(copy), [7, 8], "a copy, not the live array");
  assert.deepEqual(Array.from(WQ.renderSetCells({ getViewerRenderSet: () => [], getRenderSet: (d) => (depths.push(d), player) })), player, "empty viewer set → getRenderSet");
  assert.deepEqual(Array.from(WQ.renderSetCells({ getViewerRenderSet: () => { throw new Error("borrow"); }, getRenderSet: (d) => (depths.push(d), player) })), player, "throwing viewer set → getRenderSet");
  assert.ok(depths.every((d) => d === 1), "depth 1 (the production depth)");
  assert.equal(WQ.renderSetCells({ getRenderSet: () => [] }), null);
  assert.equal(WQ.renderSetCells({ getRenderSet: () => { throw new Error("x"); } }), null);
  assert.equal(WQ.renderSetCells({}), null);
  assert.equal(WQ.renderSetCells(null), null);
  assert.deepEqual(Array.from(WQ.createWorldQuery({ sessionHandle: both, ownerRegistry: null }).renderSetCells()), viewer, "bound on the world query");
  // The safety reflex sweeps exactly the same list indoors (one helper for both).
  const seen = [];
  const safety = SF.createSafety({ sh: both, los: { segmentBlocked: (_h, _a, _b, o) => (seen.push(o.cellIds), { blocked: false }) } });
  safety.clamp({ pos: [1000, 1000, -50] }, { pos: [1001, 1000, -50] }, { indoor: true });
  assert.equal(seen.length, 1);
  assert.deepEqual(Array.from(seen[0]), viewer, "safety: same cells as the sensors");
});

/**
 * Placement tables for LB 0x0505: LandBlockInfo statics — a prop at (1002, 1000) (row 0) and a PLACED
 * trunk-canopy oak at (1000, 1006) (row 1); procedural scenery — an oak at (1010, 1000) (row 0) and a
 * rock at (994, 1006) (row 1).
 */
function fadeWasm() {
  const k = LB(5, 5);
  return {
    async fetch_landblock_objects_soa(ids) {
      return (ids[0] & 0xffff0000) >>> 0 === k
        ? new FakeSoa({ len: 2, modelIds: Uint32Array.of(0x02000999, 0x02000246), positions: Float32Array.of(42, 40, 0, 40, 46, 0), quaternions: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0), scales: Float32Array.of(1, 1), isBuilding: Uint8Array.of(0, 0), landblockIds: Uint32Array.of(k, k) })
        : new FakeSoa({ len: 0 });
    },
    async fetch_landblock_scenery_soa(ids) {
      return (ids[0] & 0xffff0000) >>> 0 === k
        ? new FakeSoa({ len: 2, objIds: Uint32Array.of(0x02000246, 0x02000494), positions: Float32Array.of(50, 40, 0, 34, 46, 0), quaternions: new Float32Array(8), scales: Float32Array.of(1, 1), landblockIds: Uint32Array.of(k, k) })
        : new FakeSoa({ len: 0 });
    },
  };
}

const lbHex = LB(5, 5).toString(16).padStart(8, "0");
/** The placed oak's fade key (a LandBlockInfo static: object row 1). */
const TREE_KEY = `placement:${lbHex}:object:1`;
const PROP_KEY = `placement:${lbHex}:object:0`;
/** The procedural scenery oak's key: v1 never ISSUES one (describeHit), and a hand-made one resolves to nothing. */
const SCENERY_TREE_KEY = `placement:${lbHex}:scenery:0`;
const at = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);

/**
 * KNOWN sizes for fadeWasm()'s placements (placed trees and props fade only at a known size): the prop a
 * barrel-sized selection sphere, the oak its DAT bounds (catalog maxDimension 9, aspectRatio 1.5).
 */
const FADE_DIMS = (did) => (did === 0x02000999 ? { radius: 0.6, height: 1.2, source: "selectionSphere" }
  : did === 0x02000246 ? { radius: 3, height: 9, source: "catalog" } : null);
const fadeCatalogs = (o = {}) => ({ vfxArchetypeOf: (did) => ARCH.get(did) ?? null, staticDimsOf: FADE_DIMS, ...o });

await check("W10 describeHit gives PLACED tree / prop placements of known size a fade key (never rock / building / procedural scenery); staticFadeTargets finds their live draws (object keys only)", async () => {
  const staticsGroup = new THREE.Group();
  const live = { ...fakeLive([]), staticsGroup };
  const wq = WQ.createWorldQuery({ liveScene3d: live, wasmExports: fadeWasm(), catalogs: fadeCatalogs(), ownerRegistry: null });
  await wq.staticsNear([1000, 1000, 0], 12);
  const tree = wq.describeHit({ layer: "statics", point: [1000, 1005.5, 1], normal: [0, -1, 0] });
  assert.deepEqual([tree.kind, tree.fadeKey, tree.did], ["tree", TREE_KEY, 0x02000246], "a placed (LandBlockInfo) tree of known size");
  const prop = wq.describeHit({ layer: "statics", point: [1002, 999.6, 0.5], normal: [0, -1, 0] });
  assert.deepEqual([prop.kind, prop.fadeKey], ["prop", PROP_KEY]);
  // Procedural scenery (collider hits): labelled from the placement table, NEVER a fade key (v1).
  const sTree = wq.describeHit({ layer: "scenery", point: [1009.5, 1000, 1], normal: [-1, 0, 0] });
  assert.deepEqual([sTree.kind, sTree.did, sTree.fadeKey], ["tree", 0x02000246, null], "a procedural tree: label only (before r4: its scenery key)");
  const sTree2 = wq.describeHit({ layer: "sweepSphereAgainstScenery", point: [1009.5, 1000, 1] });
  assert.deepEqual([sTree2.kind, sTree2.fadeKey], ["tree", null], "the wasm method name, no normal: still no key");
  const rock = wq.describeHit({ layer: "scenery", point: [994, 1004.6, 0.5], normal: [0, -1, 0] });
  assert.deepEqual([rock.kind, rock.fadeKey], ["rock", null], "rocks are structure: rerouted, never faded");
  assert.equal(wq.describeHit({ layer: "buildingMesh", point: [1000, 1006, 2] }).fadeKey, null);
  assert.equal(wq.describeHit({ layer: "objects", point: [1, 1, 1] }).fadeKey, null);
  assert.equal(wq.describeHit({}).fadeKey, null);
  assert.deepEqual(WQ.FADEABLE_STATIC_SOURCES, ["object"]);
  assert.equal(WQ.isStaticFadeKey(TREE_KEY), true);
  assert.deepEqual(WQ.parseStaticFadeKey(TREE_KEY), { lbKey: LB(5, 5), source: "object", index: 1 });
  assert.deepEqual(WQ.parseStaticFadeKey(SCENERY_TREE_KEY), { lbKey: LB(5, 5), source: "scenery", index: 0 }, "the key FORMAT still names both tables (v2)");
  assert.equal(WQ.isStaticFadeKey(`static:${LB(5, 5)}#3`), false, "a static owner's particle key is not a placement key");
  assert.equal(WQ.isStaticFadeKey(`${TREE_KEY}#3`), false);
  assert.equal(WQ.isStaticFadeKey(42), false);
  // A placed tree of UNKNOWN size (no size source: the default radius) gets no key: "placed trees of known size".
  const unsized = WQ.createWorldQuery({ wasmExports: fadeWasm(), catalogs: { vfxArchetypeOf: (did) => ARCH.get(did) ?? null }, ownerRegistry: null });
  await unsized.staticsNear([1000, 1000, 0], 12);
  const u = unsized.describeHit({ layer: "statics", point: [1000, 1005.5, 1], normal: [0, -1, 0] });
  assert.deepEqual([u.kind, u.did, u.fadeKey], ["tree", 0x02000246, null], "default size → reroute, never fade");
  assert.equal((await unsized.staticsNear([1000, 1006, 0], 0.5)).find((r) => r.source === "object").dimsSource, "default");

  // The live staticsGroup: every draw kind statics.js / the batchers / animated_scenery make.
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const propMesh = new THREE.Mesh(geo, mat);
  propMesh.position.set(1002, 1000, 0);
  propMesh.userData = { modelId: 0x02000999, landblockId: LB(5, 5), placementKey: "prop", source: "landblockinfo" };
  const otherModel = new THREE.Mesh(geo, mat);
  otherModel.position.set(1002, 1000, 0);
  otherModel.userData = { modelId: 0x02000777, landblockId: LB(5, 5) };
  const anchor = new THREE.Object3D();
  anchor.position.set(1002, 1000, 0);
  anchor.userData = { isStaticScriptAnchor: true, landblockId: LB(5, 5) };
  const oneInst = new THREE.InstancedMesh(geo, mat, 1);
  oneInst.userData = { modelId: 0x02000999, instanceCount: 1 };
  oneInst.setMatrixAt(0, at(1002, 1000, 0));
  const forest = new THREE.InstancedMesh(geo, mat, 3);
  forest.userData = { modelId: 0x02000246, instanceCount: 3 };
  forest.setMatrixAt(0, at(990, 1000, 0));
  forest.setMatrixAt(1, at(1000, 1006, 0));
  forest.setMatrixAt(2, at(1010, 1000, 0));
  const lod = new THREE.LOD();
  lod.userData = { modelId: 0x02000246, isInstancedLod: true };
  for (const dist of [0, 60]) {
    const lv = new THREE.InstancedMesh(geo, mat, 2);
    lv.setMatrixAt(0, at(1000, 1006, 0));
    lv.setMatrixAt(1, at(980, 980, 0));
    lod.addLevel(lv, dist);
  }
  const bm = new THREE.BatchedMesh(8, 200, 400, mat);
  const gid = bm.addGeometry(geo);
  const b0 = bm.addInstance(gid);
  bm.setMatrixAt(b0, at(1000, 1006, 0)); // the tree's first surface group
  const b1 = bm.addInstance(gid);
  bm.setMatrixAt(b1, at(995, 995, 0)); // elsewhere
  const b2 = bm.addInstance(gid);
  bm.setMatrixAt(b2, at(1000, 1006, 0)); // the tree's second surface group
  const b3 = bm.addInstance(gid);
  bm.setMatrixAt(b3, at(1000, 1006, 0));
  bm.setVisibleAt(b3, false); // parked: nothing to hide
  const b4 = bm.addInstance(gid);
  bm.deleteInstance(b4); // deleted ids are skipped (getMatrixAt throws)
  const animInstanced = new THREE.Group();
  animInstanced.position.set(1000, 1006, 0);
  animInstanced.userData = { isAnimatedScenery: true, instanced: true, landblockId: LB(5, 5) };
  const bucket = new THREE.InstancedMesh(geo, mat, 4); // animated_scenery's shared rAF-written bucket
  bucket.userData = { isAnimatedSceneryInstanced: true };
  bucket.setMatrixAt(0, at(1000, 1006, 0));
  const windTree = new THREE.Group();
  windTree.position.set(1000, 1006, 0);
  windTree.userData = { isAnimatedScenery: true, isTreeWind: true, landblockId: LB(5, 5) };
  staticsGroup.add(propMesh, otherModel, anchor, oneInst, forest, lod, bm, animInstanced, bucket, windTree);
  staticsGroup.updateMatrixWorld(true);

  const tp = wq.staticFadeTargets(PROP_KEY);
  assert.deepEqual([tp.kind, tp.did, tp.pos], ["prop", 0x02000999, [1002, 1000, 0]]);
  assert.deepEqual(tp.targets.map((t) => [t.type, t.node]), [["node", propMesh], ["node", oneInst]], "per-placement Mesh + an InstancedMesh holding only it; other model / anchor skipped");
  const tt = wq.staticFadeTargets(TREE_KEY);
  const desc = tt.targets.map((t) => (t.type === "node" ? ["node", t.node] : t.type === "instance" ? ["instance", t.mesh, t.index] : ["batch", t.mesh, t.instanceId]));
  assert.deepEqual(desc, [
    ["instance", forest, 1],
    ["instance", lod.levels[0].object, 0],
    ["instance", lod.levels[1].object, 0],
    ["batch", bm, b0],
    ["batch", bm, b2],
    ["node", animInstanced],
    ["node", windTree],
  ], "only that tree: one instance of the shared forest, every instanced-LOD level, the visible batch instances, the animated anchors — never a shared animated bucket");
  // v1: a scenery key resolves to NOTHING, even with a live draw on its origin (forest instance 2 stands on
  // the scenery oak) and even once cached — so a take can never hide procedural scenery.
  assert.equal(wq.staticFadeTargets(SCENERY_TREE_KEY), null, "a hand-made scenery key hides nothing");
  assert.equal(wq.staticFadeTargets(`placement:${lbHex}:scenery:1`), null, "nor the rock's");
  // A key describeHit never produced (a fresh query) still resolves from the statics cache; unknown keys → null.
  const fresh = WQ.createWorldQuery({ liveScene3d: live, wasmExports: fadeWasm(), catalogs: fadeCatalogs(), ownerRegistry: null });
  await fresh.staticsNear([1000, 1000, 0], 12);
  const viaCache = fresh.staticFadeTargets(PROP_KEY);
  assert.deepEqual([viaCache.kind, viaCache.pos, viaCache.targets.length], ["prop", [1002, 1000, 0], 2]);
  assert.equal(fresh.staticFadeTargets(SCENERY_TREE_KEY), null);
  assert.equal(wq.staticFadeTargets(`placement:${LB(9, 9).toString(16).padStart(8, "0")}:object:0`), null);
  assert.equal(wq.staticFadeTargets("m0#3"), null);
  wq.reset();
  assert.equal(wq.staticFadeTargets(TREE_KEY), null, "reset() forgets remembered keys with the cache");
  assert.deepEqual(WQ.createWorldQuery({ ownerRegistry: null }).staticFadeTargets(TREE_KEY), null);
});

await check("S11 indoors with NO ctx.cellIds the sensors sweep the render set's EnvCell walls (review contracts-1): wall, ceiling, subject behind a wall", () => {
  const cell = (LB(5, 5) | 0x0105) >>> 0;
  const wall = { type: "plane", axis: 1, value: E[1] + 6, lo: [E[0] - 50, 0, -10], hi: [E[0] + 50, 0, 30] };
  const ceiling = { type: "plane", axis: 2, value: E[2] + 1.5, lo: [0, 0, 0], hi: [5000, 5000, 0] };
  const R = sensorRig({ entities: [subjectEntity()], sh: { prims: { cellMesh: [wall, ceiling], objects: [subjectSphere] } } });
  R.sh.getViewerRenderSet = () => [cell];
  R.sh.getRenderSet = () => [0xdead0105];
  let f;
  for (let i = 0; i < 3; i++) f = R.sensors.sense(pose0(), { indoor: true, subjectRef: SUBJ }, 0.1);
  assert.ok(R.sh.calls.cellMesh.length > 0, "cell sweeps ran");
  assert.ok(R.sh.calls.cellMesh.every((c) => c instanceof Uint32Array && c.length === 1 && c[0] === cell), "the viewer render set, copied");
  near(f.sectors.center.range, 6, 1e-6, "the cell wall blocks the centre sector");
  assert.equal(f.sectors.center.kind, "wall");
  assert.equal(f.limits.canRise, false, "a 1.5 m ceiling: no room to rise");
  near(f.limits.ceiling, 1.5, 1e-6);
  assert.equal(f.subject.visibleFrac, 0, "the subject behind the wall is hidden");
  assert.equal(f.subject.occluderKind, "wall");
  const st = buildPilotState(f, {});
  assert.equal(st.subject.visibility, "fully hidden");
  // Explicit ctx.cellIds still win; outdoors the render set is never read.
  const R2 = sensorRig({ sh: { prims: { cellMesh: [wall] } } });
  let reads = 0;
  R2.sh.getRenderSet = () => (reads += 1, [cell]);
  R2.sensors.sense(pose0(), { indoor: true, cellIds: [0x01020105] }, 0.1);
  assert.equal(reads, 0, "explicit cellIds → no render-set read");
  assert.ok(R2.sh.calls.cellMesh.every((c) => c[0] === 0x01020105));
  const R3 = sensorRig({ sh: { prims: { cellMesh: [wall] } } });
  R3.sh.getRenderSet = () => (reads += 1, [cell]);
  const g = R3.sensors.sense(pose0(), {}, 0.1);
  assert.deepEqual([reads, R3.sh.calls.cellMesh.length, g.sectors.center.range], [0, 0, Infinity], "outdoors: no cells, no cell sweeps");
  // Once per sense() call, not once per probe.
  const R4 = sensorRig({ sh: { prims: { cellMesh: [wall] } } });
  let n4 = 0;
  R4.sh.getRenderSet = () => (n4 += 1, [cell]);
  R4.sensors.sense(pose0(), { indoor: true }, 0.1);
  assert.equal(n4, 1, "one render-set read per frame");
  assert.ok(R4.sh.calls.cellMesh.length >= 10);
});

await check("S12 a PLACED tree hiding the subject → its fade key in occluderIds → the pilot fades it (no reroute); faded (ctx.fadedIds) → the rays see past it. A PROCEDURAL scenery tree → kind tree, NO id → the fade becomes a reroute; no faded id clears it (r4)", async () => {
  // The placed oak (LandBlockInfo static, object row 1) at (1000, 1006): its render bounds stop the statics layer.
  const trunk = { type: "cyl", c: [E[0], E[1] + 6], r: 0.5, z0: 0, z1: 8 };
  {
    const sh = geoSh({ prims: { statics: [trunk], objects: [subjectSphere] } });
    const wq = WQ.createWorldQuery({ liveScene3d: fakeLive([subjectEntity()]), sessionHandle: sh, wasmExports: fadeWasm(), THREE, catalogs: fadeCatalogs(), ownerRegistry: null, now: () => 0 });
    await wq.staticsNear([E[0], E[1], 0], 12);
    const sensors = SN.createSensors({ worldQuery: wq, sh });
    let f;
    for (let i = 0; i < 3; i++) f = sensors.sense(pose0(), { subjectRef: SUBJ }, 0.5);
    assert.equal(f.subject.visibleFrac, 0, "all five rays stop on the trunk");
    assert.equal(f.subject.occluderKind, "tree");
    assert.deepEqual(f.subject.occluderIds, [TREE_KEY], "the placed tree's fade key");
    const pol = POL.codePolicy(f, null);
    assert.equal(pol.occluder_action.choice, "fade");
    const sp = MAP.createResidualMapper({}).apply(pol, { now: 0, sensorFrame: f });
    assert.deepEqual([sp.fadeIds, sp.reroute], [[TREE_KEY], false], "a real fade id reaches the setpoint");
    let g;
    for (let i = 0; i < 3; i++) g = sensors.sense(pose0(), { subjectRef: SUBJ, fadedIds: [TREE_KEY] }, 0.1);
    assert.equal(g.subject.visibleFrac, 1, "the faded tree no longer hides the subject");
    assert.equal(g.subject.occluderKind, null);
    assert.deepEqual(g.subject.occluderIds, []);
    assert.equal(g.subject.unseenSec, 0);
    // A different faded id does not make the tree transparent.
    let h;
    for (let i = 0; i < 3; i++) h = sensors.sense(pose0(), { subjectRef: SUBJ, fadedIds: new Set([PROP_KEY, 0x80000099]) }, 0.1);
    assert.equal(h.subject.visibleFrac, 0);
  }
  // The same trunk as PROCEDURAL scenery (a scenery oak at (1000, 1006), scenery row 0): the physics collider stops
  // the scenery layer — labelled tree, never an id.
  {
    const k = LB(5, 5);
    const wasm = {
      async fetch_landblock_objects_soa() { return new FakeSoa({ len: 0 }); },
      async fetch_landblock_scenery_soa(ids) {
        return (ids[0] & 0xffff0000) >>> 0 === k
          ? new FakeSoa({ len: 1, objIds: Uint32Array.of(0x02000246), positions: Float32Array.of(40, 46, 0), quaternions: new Float32Array(4), scales: Float32Array.of(1), landblockIds: Uint32Array.of(k) })
          : new FakeSoa({ len: 0 });
      },
    };
    const sh = geoSh({ prims: { scenery: [trunk], objects: [subjectSphere] } });
    const wq = WQ.createWorldQuery({ liveScene3d: fakeLive([subjectEntity()]), sessionHandle: sh, wasmExports: wasm, THREE, catalogs: fadeCatalogs(), ownerRegistry: null, now: () => 0 });
    await wq.staticsNear([E[0], E[1], 0], 12);
    const sensors = SN.createSensors({ worldQuery: wq, sh });
    let f;
    for (let i = 0; i < 3; i++) f = sensors.sense(pose0(), { subjectRef: SUBJ }, 0.5);
    assert.deepEqual([f.subject.visibleFrac, f.subject.occluderKind, f.subject.occluderIds], [0, "tree", []], "round 3: [the scenery key]");
    const pol = POL.codePolicy(f, null);
    assert.equal(pol.occluder_action.choice, "fade", "a soft kind: the policy still answers fade");
    const m = MAP.createResidualMapper({});
    const sp = m.apply(pol, { now: 0, sensorFrame: f });
    assert.deepEqual([sp.fadeIds, sp.reroute, m.stats().fadeFallbacks], [[], true, 1], "nothing to fade → the camera reroutes");
    const key = WQ.staticFadeKey({ lbKey: k, source: "scenery", index: 0 });
    let g;
    for (let i = 0; i < 3; i++) g = sensors.sense(pose0(), { subjectRef: SUBJ, fadedIds: [key] }, 0.1);
    assert.deepEqual([g.subject.visibleFrac, g.subject.occluderIds], [0, []], "a hand-made scenery key in fadedIds never reads as a clear view");
    assert.equal(wq.staticFadeTargets(key), null, "and the take could not hide it anyway");
  }
});

// ---------------------------------------------------------------------------
// round-2 fixes (r2-perception): which placement a hit names, real catalogs
// ---------------------------------------------------------------------------

/**
 * Placement tables for LB 0x0505 from world-space rows `{did, pos:[x,y,z], scale?}`:
 * `scenery` → the procedural scenery table, `objects` → LandBlockInfo statics (never buildings).
 */
function rowsWasm(scenery, objects = [], extra = {}) {
  const k = LB(5, 5);
  const soa = (list, idsKey) => (list.length
    ? new FakeSoa({
      len: list.length,
      [idsKey]: Uint32Array.from(list.map((r) => r.did)),
      positions: Float32Array.from(list.flatMap((r) => [r.pos[0] - 960, r.pos[1] - 960, r.pos[2] ?? 0])),
      quaternions: new Float32Array(4 * list.length),
      scales: Float32Array.from(list.map((r) => r.scale ?? 1)),
      isBuilding: new Uint8Array(list.length),
      landblockIds: Uint32Array.from(list.map(() => k)),
    })
    : new FakeSoa({ len: 0 }));
  return {
    async fetch_landblock_objects_soa(ids) { return (ids[0] & 0xffff0000) >>> 0 === k ? soa(objects, "modelIds") : new FakeSoa({ len: 0 }); },
    async fetch_landblock_scenery_soa(ids) { return (ids[0] & 0xffff0000) >>> 0 === k ? soa(scenery, "objIds") : new FakeSoa({ len: 0 }); },
    ...extra,
  };
}
const keyOf = (source, index) => WQ.staticFadeKey({ lbKey: LB(5, 5), source, index });
const OAK = 0x02000246;
/** The round-1 checker's clump: two oaks 1.9 m apart; B has the LOWER row index, the rays hit A. */
const CLUMP_B = [1001.8, 1006.6, 0];
const CLUMP_A = [1000, 1006, 0];

/** A wasm SetupSelectionSphere box (getters + free()). */
class FakeSphere {
  constructor(d) {
    this._d = d;
    this.freed = 0;
  }
  get cx() { return this._d.cx ?? 0; }
  get cy() { return this._d.cy ?? 0; }
  get cz() { return this._d.cz ?? 0; }
  get radius() { return this._d.radius; }
  get valid() { return this._d.valid ?? true; }
  get setupId() { return this._d.id; }
  free() {
    this.freed += 1;
  }
}

/** OAK at the default tree size, but KNOWN (the catalog's): the W11 / S13 clump numbers stay r 2.5 m, h 8 m. */
const OAK_DIMS = (did) => (did === OAK ? { radius: 2.5, height: 8, source: "catalog" } : null);
const clumpCatalogs = { vfxArchetypeOf: (did) => ARCH.get(did) ?? null, staticDimsOf: OAK_DIMS };

await check("W11 describeHit names the placement whose AXIS is nearest (round-1 regression: the lower row index won every tie); ambiguous / outside hits get no fade key — PLACED trees; the same clump as procedural scenery is labelled, never keyed (r4)", async () => {
  const wq = WQ.createWorldQuery({ wasmExports: rowsWasm([], [{ did: OAK, pos: CLUMP_B }, { did: OAK, pos: CLUMP_A }]), catalogs: clumpCatalogs, ownerRegistry: null });
  await wq.staticsNear([1000, 1000, 0], 20);
  // A ray stopped by placed tree A's render bounds (row 1) on the camera side.
  const onA = wq.describeHit({ layer: "statics", point: [1000, 1005.65, 1], normal: [0, -1, 0] });
  assert.deepEqual([onA.kind, onA.fadeKey], ["tree", keyOf("object", 1)], "tree A (before the round-1 fix: tree B, row 0 — both capsules contain the point, surface distance 0 for both)");
  const onB = wq.describeHit({ layer: "statics", point: [1001.8, 1006.25, 1], normal: [0, -1, 0] });
  assert.deepEqual([onB.kind, onB.fadeKey], ["tree", keyOf("object", 0)], "and B when the ray hits B");
  // Between the trunks: either could be the blocker → no fade key (the pilot reroutes), still a tree.
  const mid = wq.describeHit({ layer: "statics", point: [1000.9, 1006.3, 2], normal: [0, -1, 0] });
  assert.deepEqual([mid.kind, mid.fadeKey], ["tree", null], "ambiguous between two trunks");
  // The scores behind it.
  const rows = wq.staticsNearCached([1000, 1006, 0], 5);
  const A = rows.find((r) => r.index === 1), B = rows.find((r) => r.index === 0);
  near(WQ.staticHitScore([1000, 1005.65, 1], A), 0.35 / 2.5, 1e-6, "on A's axis side");
  near(WQ.staticHitScore([1000, 1005.65, 1], B), Math.hypot(1.8, 0.95) / 2.5, 1e-6);
  near(WQ.staticHitScore([1000, 1006, 10], A), 2 / 2.5, 1e-6, "above the top: distance to the segment end");
  assert.equal(WQ.staticHitScore([1, 2, 3], { pos: [1, 2, 3], radius: 0, height: 1 }), Infinity);
  assert.equal(WQ.staticHitScore(null, A), Infinity);
  // A lone placed tree hit OUTSIDE its radius (score > 1) is not faded; inside it is.
  const lone = WQ.createWorldQuery({ wasmExports: rowsWasm([], [{ did: OAK, pos: [1000, 1006, 0] }]), catalogs: clumpCatalogs, ownerRegistry: null });
  await lone.staticsNear([1000, 1000, 0], 20);
  const out = lone.describeHit({ layer: "statics", point: [1003, 1006, 1], normal: [1, 0, 0] });
  assert.deepEqual([out.kind, out.did, out.fadeKey], ["tree", OAK, null], "3 m from the axis of a 2.5 m tree: outside it");
  const inside = lone.describeHit({ layer: "statics", point: [1002, 1006, 1], normal: [1, 0, 0] });
  assert.deepEqual([inside.kind, inside.fadeKey], ["tree", keyOf("object", 0)], "2 m: inside its radius");
  assert.deepEqual(WQ.STATIC_HIT_RULES, { maxScore: 1, ambiguity: 0.25, propMaxSize: 2 });
  // The SAME clump as procedural scenery (collider hits): the label is still the tree, but no hit carries a key
  // (v1: the CollisionHit names no placement — r4-scenery-fade).
  const sc = WQ.createWorldQuery({ wasmExports: rowsWasm([{ did: OAK, pos: CLUMP_B }, { did: OAK, pos: CLUMP_A }]), catalogs: clumpCatalogs, ownerRegistry: null });
  await sc.staticsNear([1000, 1000, 0], 20);
  for (const point of [[1000, 1005.65, 1], [1001.8, 1006.25, 1], [1000.9, 1006.3, 2]]) {
    const h = sc.describeHit({ layer: "scenery", point, normal: [0, -1, 0] });
    assert.deepEqual([h.kind, h.did, h.fadeKey], ["tree", OAK, null], `scenery hit at ${point}`);
  }
  const sLone = WQ.createWorldQuery({ wasmExports: rowsWasm([{ did: OAK, pos: [1000, 1006, 0] }]), catalogs: clumpCatalogs, ownerRegistry: null });
  await sLone.staticsNear([1000, 1000, 0], 20);
  for (const x of [1003, 1004]) {
    const h = sLone.describeHit({ layer: "scenery", point: [x, 1006, 1], normal: [1, 0, 0] });
    assert.deepEqual([h.kind, h.did, h.fadeKey], ["tree", OAK, null], `a lone scenery tree hit ${x - 1000} m from its axis: labelled, no key`);
  }
});

await check("W11 props fade only at a KNOWN small size: the checker's rim hit names the big static (not the barrel 0.7 m away) and fades nothing; a lone barrel fades; default sizes never fade", async () => {
  const STATUE = 0x020005ff, BARREL = 0x020001aa;
  const objects = [{ did: BARREL, pos: [1002.6, 1006, 0] }, { did: STATUE, pos: [1000, 1006, 0] }, { did: BARREL, pos: [1006, 1000, 0] }];
  const spheres = new Map([[BARREL, { cz: 0.5, radius: 0.6 }], [STATUE, { cz: 1.5, radius: 3 }]]);
  const made = [];
  const fetched = [];
  const wasm = rowsWasm([], objects, {
    async fetchSetupSelectionSphere(id) {
      fetched.push(id);
      const b = new FakeSphere({ id, ...(spheres.get(id) ?? { radius: 0.1, valid: false }) });
      made.push(b);
      return b;
    },
  });
  const catalogs = WQ.createStaticCatalogs({ selectionSphere: (id) => wasm.fetchSetupSelectionSphere(id) });
  const wq = WQ.createWorldQuery({ wasmExports: wasm, catalogs, ownerRegistry: null });
  await wq.staticsNear([1000, 1000, 0], 20);
  assert.deepEqual(fetched.sort(), [BARREL, STATUE].sort(), "one selection-sphere fetch per Setup DID");
  assert.ok(made.every((b) => b.freed === 1), "every SetupSelectionSphere box freed");
  // The round-1 production example: a hit on the statue's rim 2 m from its origin, 0.72 m from the barrel.
  const rim = wq.describeHit({ layer: "statics", point: [1002, 1006.4, 1], normal: [1, 0, 0] });
  assert.deepEqual([rim.kind, rim.did, rim.fadeKey], ["prop", STATUE, null], "the statue (r 3 m: too big to fade) — before: the barrel's key");
  const barrel = wq.describeHit({ layer: "statics", point: [1006, 999.5, 0.5], normal: [0, -1, 0] });
  assert.deepEqual([barrel.kind, barrel.did, barrel.fadeKey], ["prop", BARREL, keyOf("object", 2)], "a lone barrel of known size fades");
  const rows = await wq.staticsNear([1006, 1000, 0], 1);
  assert.deepEqual([rows[0].dimsSource, rows[0].radius, rows[0].height], ["selectionSphere", 0.6, 1.1]);
  // The same scene with no size source (round-1 production wiring): sizes are defaults → no prop fades at all.
  const bare = WQ.createWorldQuery({ wasmExports: rowsWasm([], objects), ownerRegistry: null });
  await bare.staticsNear([1000, 1000, 0], 20);
  const rim0 = bare.describeHit({ layer: "statics", point: [1002, 1006.4, 1], normal: [1, 0, 0] });
  assert.deepEqual([rim0.kind, rim0.fadeKey], ["prop", null], "the barrel is no longer faded for the statue's rim");
  assert.equal(bare.describeHit({ layer: "statics", point: [1006, 999.5, 0.5], normal: [0, -1, 0] }).fadeKey, null, "unknown size → reroute, never fade");
  assert.equal((await bare.staticsNear([1006, 1000, 0], 1))[0].dimsSource, "default");
});

await check("W12 createStaticCatalogs: archetype + DAT bounds from the VFX descriptor, selection spheres for the rest (0x02 only, once, freed, failures and a stalled fetch bounded)", async () => {
  // Pure size helpers.
  const sig = (M, A) => ({ raw: { signals: [{ name: "maxDimension", value: String(M) }, { name: "aspectRatio", value: String(A) }] } });
  assert.deepEqual(WQ.dimsFromDescriptor(sig(9, 1.5)), { radius: 3, height: 9 }, "tall: height = max extent, footprint = M / A");
  assert.deepEqual(WQ.dimsFromDescriptor(sig(4, 0.5)), { radius: 2, height: 2 }, "flat: footprint = max extent, height = A·M");
  assert.equal(WQ.dimsFromDescriptor(sig("x", 1)), null);
  assert.equal(WQ.dimsFromDescriptor({ raw: {} }), null);
  assert.equal(WQ.dimsFromDescriptor(null), null);
  assert.deepEqual(WQ.dimsFromSelectionSphere({ cx: 0.3, cy: 0.4, cz: 1, radius: 2, valid: true }), { radius: 2.5, height: 3 });
  assert.equal(WQ.dimsFromSelectionSphere({ cx: 0, cy: 0, cz: 0.1, radius: 0.1, valid: true }), null, "retail's 0.1 m placeholder");
  assert.equal(WQ.dimsFromSelectionSphere({ radius: 2, valid: false }), null);
  assert.equal(WQ.dimsFromSelectionSphere({ cz: -5, radius: 2 }), null, "entirely below ground");
  // The factory.
  const DESC = new Map([[OAK, { archetype: "trunk-canopy", ...sig(9, 1.5) }], [0x02000300, { archetype: "rigid-glint" }]]);
  let released = null;
  const ready = new Promise((r) => (released = r));
  let catalogLoaded = false;
  const fetched = [];
  const boxes = [];
  const timers = [];
  const cat = WQ.createStaticCatalogs({
    descriptorFor: (did) => (catalogLoaded ? DESC.get(did) ?? null : null),
    ready,
    selectionSphere(id) {
      fetched.push(id);
      if (id === 0x02000bad) return Promise.reject(new Error("no setup"));
      if (id === 0x02000555) return new Promise(() => {}); // a fetch that never settles
      const b = new FakeSphere({ id, cz: 0.5, radius: 0.6 });
      boxes.push(b);
      return b;
    },
    timeoutMs: 50,
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
  });
  const pre = cat.prefetchStaticDims([OAK, 0x02000300, 0x01000777, 0x020001aa, 0x020001aa, 0x02000bad]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fetched, [], "nothing fetched before the catalog module is ready");
  catalogLoaded = true;
  released(true);
  await pre;
  assert.deepEqual(fetched, [0x02000300, 0x020001aa, 0x02000bad], "uncatalogued-size Setups only (the oak has DAT bounds; 0x01 GfxObjs have no sphere); once per DID");
  assert.ok(boxes.every((b) => b.freed === 1), "boxes freed");
  assert.equal(cat.vfxArchetypeOf(OAK), "trunk-canopy");
  assert.equal(cat.vfxArchetypeOf(0x02000999), null);
  assert.deepEqual(cat.staticDimsOf(OAK, "tree"), { radius: 3, height: 9, source: "catalog" });
  assert.deepEqual(cat.staticDimsOf(0x020001aa, "prop"), { radius: 0.6, height: 1.1, source: "selectionSphere" });
  assert.equal(cat.staticDimsOf(0x02000bad, "prop"), null, "a failed fetch → defaults");
  assert.equal(cat.staticDimsOf(0x01000777, "prop"), null);
  const t0 = timers.length;
  await cat.prefetchStaticDims([0x020001aa, 0x02000bad]);
  assert.equal(fetched.length, 3, "cached (failures too): no second fetch");
  assert.equal(timers.length, t0, "nothing to wait for: no timer");
  // A stalled fetch is bounded by timeoutMs (the landblock still becomes ready).
  const stalled = cat.prefetchStaticDims([0x02000555]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(timers.length, t0 + 1);
  assert.equal(timers[t0].ms, 50);
  timers[t0].fn();
  await stalled;
  assert.equal(cat.stats().timeouts, 1);
  assert.equal(cat.stats().failures, 1);
  // Nothing injected: inert, never throws.
  const none = WQ.createStaticCatalogs();
  assert.equal(none.vfxArchetypeOf(OAK), null);
  assert.equal(none.staticDimsOf(OAK), null);
  await none.prefetchStaticDims([OAK]);
  const throwing = WQ.createStaticCatalogs({ descriptorFor: () => { throw new Error("x"); } });
  assert.equal(throwing.vfxArchetypeOf(OAK), null);
});

await check("W13 a catalog the client fills AFTER the landblock was cached still applies: a placed oak reads as a prop of unknown size (no key), then a tree with a fade key and its DAT-bounds size; a scenery oak goes rock → tree with no key", async () => {
  const DESC = new Map();
  const cat = WQ.createStaticCatalogs({ descriptorFor: (did) => DESC.get(did) ?? null });
  const wq = WQ.createWorldQuery({ wasmExports: rowsWasm([{ did: OAK, pos: [1010, 1006, 0] }], [{ did: OAK, pos: [1000, 1006, 0] }]), catalogs: cat, ownerRegistry: null });
  await wq.staticsNear([1000, 1000, 0], 20);
  const placedHit = { layer: "statics", point: [1000, 1005.65, 1], normal: [0, -1, 0] };
  const sceneryHit = { layer: "scenery", point: [1010, 1005.65, 1], normal: [0, -1, 0] };
  const before = wq.describeHit(placedHit);
  assert.deepEqual([before.kind, before.fadeKey], ["prop", null], "no archetype yet: a prop of unknown size (rerouted)");
  assert.deepEqual([wq.describeHit(sceneryHit).kind, wq.describeHit(sceneryHit).fadeKey], ["rock", null], "no archetype yet: scenery reads as rock");
  DESC.set(OAK, { archetype: "trunk-canopy", raw: { signals: [{ name: "maxDimension", value: "9" }, { name: "aspectRatio", value: "1.5" }] } });
  const after = wq.describeHit(placedHit);
  assert.deepEqual([after.kind, after.fadeKey], ["tree", keyOf("object", 0)]);
  const row = wq.staticsNearCached([1000, 1006, 0], 1).find((r) => r.source === "object");
  assert.deepEqual([row.kind, row.archetype, row.dimsSource, row.radius, row.height], ["tree", "trunk-canopy", "catalog", 3, 9]);
  assert.equal(wq.staticFadeTargets(keyOf("object", 0)).kind, "tree");
  const sAfter = wq.describeHit(sceneryHit);
  assert.deepEqual([sAfter.kind, sAfter.did, sAfter.fadeKey], ["tree", OAK, null], "the scenery oak is now labelled tree — still no key");
  assert.equal(wq.staticFadeTargets(keyOf("scenery", 0)), null);
});

await check("S13 the clump end to end (round-1 probe), PLACED trees: the sensors name the tree that actually blocks; fading it clears the rays, fading the neighbour does not. As procedural scenery: hidden, no ids, nothing clears it (r4)", async () => {
  // Only tree A's trunk is on the rays (B stands 1.9 m to the side, row 0).
  const trunkA = { type: "cyl", c: [CLUMP_A[0], CLUMP_A[1]], r: 0.35, z0: 0, z1: 8 };
  const run = (wq, sh, fadedIds) => {
    const sensors = SN.createSensors({ worldQuery: wq, sh });
    let f;
    for (let i = 0; i < 3; i++) f = sensors.sense(pose0(), { subjectRef: SUBJ, fadedIds }, 0.5);
    return f.subject;
  };
  {
    const sh = geoSh({ prims: { statics: [trunkA], objects: [subjectSphere] } });
    const wq = WQ.createWorldQuery({ liveScene3d: fakeLive([subjectEntity()]), sessionHandle: sh, wasmExports: rowsWasm([], [{ did: OAK, pos: CLUMP_B }, { did: OAK, pos: CLUMP_A }]), THREE, catalogs: clumpCatalogs, ownerRegistry: null, now: () => 0 });
    await wq.staticsNear([E[0], E[1], 0], 20);
    const s0 = run(wq, sh, null);
    assert.equal(s0.visibleFrac, 0);
    assert.equal(s0.occluderKind, "tree");
    assert.deepEqual(s0.occluderIds, [keyOf("object", 1)], "tree A (round 1: the neighbour B, row 0)");
    const s1 = run(wq, sh, s0.occluderIds);
    assert.equal(s1.visibleFrac, 1, "the take faded the real blocker: seen past it");
    const s2 = run(wq, sh, [keyOf("object", 0)]);
    assert.equal(s2.visibleFrac, 0, "fading the neighbour leaves the subject hidden (round 1 reported it visible)");
    assert.deepEqual(s2.occluderIds, [keyOf("object", 1)]);
  }
  {
    const sh = geoSh({ prims: { scenery: [trunkA], objects: [subjectSphere] } });
    const wq = WQ.createWorldQuery({ liveScene3d: fakeLive([subjectEntity()]), sessionHandle: sh, wasmExports: rowsWasm([{ did: OAK, pos: CLUMP_B }, { did: OAK, pos: CLUMP_A }]), THREE, catalogs: clumpCatalogs, ownerRegistry: null, now: () => 0 });
    await wq.staticsNear([E[0], E[1], 0], 20);
    const s0 = run(wq, sh, null);
    assert.deepEqual([s0.visibleFrac, s0.occluderKind, s0.occluderIds], [0, "tree", []], "round 3: [tree A's scenery key]");
    for (const faded of [[keyOf("scenery", 1)], [keyOf("scenery", 0)], [keyOf("scenery", 0), keyOf("scenery", 1)]]) {
      assert.deepEqual([run(wq, sh, faded).visibleFrac, run(wq, sh, faded).occluderIds], [0, []], `fadedIds ${faded}: still hidden`);
    }
  }
});

// ---------------------------------------------------------------------------
// round-3 fixes (r3-perception): scenery hits land on PHYSICS colliders; stalled size fetches
// ---------------------------------------------------------------------------

/**
 * Real rows of the client's VFX descriptor catalog (dist/vfx/visual_descriptors.jsonl, the
 * WorldBuilder classifier's DAT-bounds signals, verbatim) and the real DAT colliders of the
 * 2026-07-27 scenery census (scenery-collidability.json):
 *   BIG   0x02000222 trunk-canopy   maxDimension 10.03, aspectRatio 0.50 → r 5.015, h 5.015 (the checker's big tree)
 *   THIN  0x020001EC foliage-pollen 3.00 / 4.62 → r 0.325, h 3 (76 of 254 foliage-pollen rows have r < 0.5)
 *   PINE  0x02000258 trunk-canopy   23.96 / 1.49 → r 8.04, h 23.96; collider: cylsphere r 1.09 at (0.05, 0, −1.9), h 23.02
 *         (the most common scenery tree, ~588k placements)
 *   BUSH  0x020007A3 foliage-pollen 2.95 / 1.01 → r 1.46, h 2.95; NO collider (rung 4, ~319k placements)
 *   ROCK  0x02000584 uncatalogued   → rock, default size; collider: sphere r 0.95 at z 0.95
 */
const BIG = 0x02000222, THIN = 0x020001ec, PINE = 0x02000258, BUSH = 0x020007a3, ROCK = 0x02000584;
const REAL_DESC = new Map([
  [BIG, ["trunk-canopy", "10.03", "0.50"]],
  [THIN, ["foliage-pollen", "3.00", "4.62"]],
  [PINE, ["trunk-canopy", "23.96", "1.49"]],
  [BUSH, ["foliage-pollen", "2.95", "1.01"]],
].map(([did, [archetype, M, A]]) => [did, { archetype, raw: { signals: [{ name: "maxDimension", value: M }, { name: "aspectRatio", value: A }] } }]));
/** createStaticCatalogs over the real descriptor rows (the film/index.js wiring shape). */
const realCatalogs = (extra = {}) => WQ.createStaticCatalogs({ descriptorFor: (did) => REAL_DESC.get(did) ?? null, ...extra });
async function sceneryQuery(rows, extra = {}) {
  const wq = WQ.createWorldQuery({ wasmExports: rowsWasm(rows), catalogs: realCatalogs(extra.catalogs), ownerRegistry: null, ...(extra.deps ?? {}) });
  await wq.staticsNear([1000, 1000, 0], 20);
  return wq;
}

await check("W14 scenery LABEL helpers: absolute axis distance, plausible collider reach (catalog collider, else size-bounded per kind), side of the hit normal", () => {
  assert.deepEqual(WQ.SCENERY_HIT_RULES, { reachCap: { tree: 5.2, rock: 2.1 }, reachGrowth: 1.35, reachPadM: 0.6, slackM: 0.3, minNormalXY: 0.3, lateralM: 0.7 }, "r4: no ambiguity fields (scenery never gets a key)");
  const row = (o) => ({ pos: [10, 20, 0], radius: 1, height: 4, scale: 1, kind: "tree", ...o });
  near(WQ.staticAxisDistance([13, 24, 2], row()), 5, 1e-12, "horizontal while within the height");
  near(WQ.staticAxisDistance([10, 20, 7], row()), 3, 1e-12, "above the top: to the segment end");
  near(WQ.staticAxisDistance([10, 23, -4], row()), 5, 1e-12, "below the base");
  assert.equal(WQ.staticAxisDistance(null, row()), Infinity);
  assert.equal(WQ.staticAxisDistance([1, 2, 3], { pos: "x" }), Infinity);
  near(WQ.staticHitScore([13, 24, 2], row({ radius: 2 })), 2.5, 1e-12, "the bounds score is the same distance ÷ radius");
  // Reach: catalog collider × scale wins; else min(cap·s, max(1.35 r, r + 0.6 s)).
  near(WQ.sceneryColliderReach(row({ scale: 2 }), 1.09), 2.18, 1e-12, "a catalog collider (model m) × scale");
  near(WQ.sceneryColliderReach(row({ radius: 0.325 })), 0.925, 1e-12, "THIN: r + 0.6");
  near(WQ.sceneryColliderReach(row({ radius: 3 })), 4.05, 1e-12, "1.35 r");
  near(WQ.sceneryColliderReach(row({ radius: 8.04 })), 5.2, 1e-12, "PINE: capped (canopy 8 m, trunk 1.09 m)");
  near(WQ.sceneryColliderReach(row({ radius: 8.04 * 2, scale: 2 })), 10.4, 1e-12, "the cap scales with the placement");
  near(WQ.sceneryColliderReach(row({ kind: "rock", radius: 1.5 })), 2.1, 1e-12, "default rock");
  near(WQ.sceneryColliderReach(row({ kind: "rock", radius: 1.5 * 0.8, scale: 0.8 })), 2.1 * 0.8, 1e-12);
  assert.equal(WQ.sceneryColliderReach(row({ radius: 0 })), 0);
  assert.equal(WQ.sceneryColliderReach(null), 0);
  // Side: the owner's axis is behind the hit along −normal, within 0.7·max(1, s) of that line.
  const n = [0, -1, 0]; // the hit faces −y (toward a camera south of it)
  assert.equal(WQ.colliderSideFit([10, 19, 1], n, row()), true, "axis 1 m behind");
  assert.equal(WQ.colliderSideFit([10.6, 19, 1], n, row()), true, "0.6 m off the line");
  assert.equal(WQ.colliderSideFit([11, 19, 1], n, row()), false, "1 m off the line");
  assert.equal(WQ.colliderSideFit([11, 19, 1], n, row({ scale: 1.5 })), true, "a scaled collider may sit farther off the axis");
  assert.equal(WQ.colliderSideFit([10, 21, 1], n, row()), false, "axis in FRONT of the hit");
  assert.equal(WQ.colliderSideFit([10, 19, 1], [0, 0, 1], row()), null, "a cap / top normal says nothing");
  assert.equal(WQ.colliderSideFit([10, 19, 1], [0.1, -0.2, 0.97], row()), null, "nearly vertical");
  assert.equal(WQ.colliderSideFit([10, 19, 1], null, row()), null, "no normal");
  // Real catalog rows through createStaticCatalogs (catalog dims) and the optional collider source.
  const cat = realCatalogs({ colliderOf: (did) => (did === PINE ? 1.14 : did === BIG ? "x" : null) });
  assert.deepEqual(cat.staticDimsOf(THIN), { radius: 3 / 4.62 / 2, height: 3, source: "catalog" });
  assert.equal(cat.staticColliderOf(PINE), 1.14);
  assert.equal(cat.staticColliderOf(BIG), null, "not a number → none");
  assert.equal(realCatalogs().staticColliderOf(PINE), null, "no collider source (film/index.js today)");
  assert.equal(WQ.createStaticCatalogs({ colliderOf: () => { throw new Error("x"); } }).staticColliderOf(PINE), null);
});

await check("W14 the checker's mixed sizes (round-2 DEFECT): a thin tree's trunk hit next to a big canopy tree is LABELLED the THIN tree (12 of 12, with or without a normal); its own trunk hit the big one; never a key (r4)", async () => {
  // p1_real_catalog.mjs section (b): before the fix 7 of 12 named BIG (its 5 m canopy radius normalised the distance away).
  for (const D of [1.5, 2.5, 3.5, 4.5]) {
    const wq = await sceneryQuery([{ did: BIG, pos: [1000, 1000, 0] }, { did: THIN, pos: [1000 + D, 1000, 0] }]);
    for (const off of [0.15, 0.3, 0.45]) {
      for (const normal of [[0, -1, 0], null]) {
        const h = wq.describeHit({ layer: "scenery", point: [1000 + D, 1000 - off, 1], normal });
        assert.deepEqual([h.kind, h.did, h.fadeKey], ["tree", THIN, null], `thin trunk ${off} m off axis, big tree ${D} m away, normal ${normal}`);
      }
    }
    // The big tree's own trunk, 0.45 m off its axis, toward the camera.
    const big = wq.describeHit({ layer: "scenery", point: [1000, 999.55, 1], normal: [0, -1, 0] });
    assert.deepEqual([big.did, big.fadeKey], [BIG, null], `big trunk hit, thin tree ${D} m away`);
  }
});

await check("W14 a boulder hit beside a catalogued tree stays ROCK with no fade key (round-2 DEFECT: the tree's canopy radius took it, and fading the tree read as a clear view)", async () => {
  // p2_rock_tree.mjs: the uncatalogued boulder (default size) hit 1.2 m from its origin; tree BIG 2–4.5 m away.
  const configs = [
    ["tree 3 m SW (camera side)", [998, 997.8], [1000, 998.8, 0.6], 1],
    ["tree 2 m W", [998, 1000], [1000, 998.8, 0.6], 1],
    ["tree 4 m S, boulder scale 0.8", [1000, 996], [1000, 998.8, 0.6], 0.8],
    ["tree 4.5 m SE", [1003, 996.7], [1000, 999, 0.5], 1],
  ];
  for (const [label, tree, hit, s] of configs) {
    const wq = await sceneryQuery([{ did: ROCK, pos: [1000, 1000, 0], scale: s }, { did: BIG, pos: [tree[0], tree[1], 0] }]);
    for (const normal of [[0, -1, 0], null]) {
      const h = wq.describeHit({ layer: "scenery", point: hit, normal });
      assert.deepEqual([h.kind, h.did, h.fadeKey], ["rock", ROCK, null], `${label}, normal ${normal}`);
    }
  }
});

await check("W14 labels: near-tied trunks, a collider-less bush beside / in front of the hit never takes a trunk's label, a boulder beside a bush stays rock, a catalog collider tightens the reach — and no scenery hit ever carries a key (r4)", async () => {
  // Equal-size clump, overlapping trunks: both axes behind the hit, 0.45 vs 0.54 m away.
  const clump = await sceneryQuery([{ did: THIN, pos: [1000, 1006, 0] }, { did: THIN, pos: [1000.4, 1006.1, 0] }]);
  const tied = clump.describeHit({ layer: "scenery", point: [1000.2, 1005.6, 1], normal: [0, -1, 0] });
  assert.deepEqual([tied.kind, tied.did, tied.fadeKey], ["tree", THIN, null]);
  const clear = clump.describeHit({ layer: "scenery", point: [999.85, 1005.7, 1], normal: [-0.447, -0.894, 0] });
  assert.deepEqual([clear.did, clear.fadeKey], [THIN, null], "the front-left trunk (0.34 vs 0.68 m): a clear owner, still no key");
  // The PINE trunk (cylsphere r 1.09 on its axis) hit facing the camera; the BUSH (no collider: the
  // rays pass through it) stands 0.95 m from the hit — NEARER than the pine's axis (1.09 m) — but in
  // front of the surface / far off the normal line, so it cannot own the hit: the label is the pine.
  for (const bush of [[1000.9, 1004.6], [1000.9, 1005.2]]) {
    const wq = await sceneryQuery([{ did: PINE, pos: [999.95, 1006, 0] }, { did: BUSH, pos: [bush[0], bush[1], 0] }]);
    const h = wq.describeHit({ layer: "scenery", point: [1000, 1004.91, 1.5], normal: [0, -1, 0] });
    assert.deepEqual([h.kind, h.did, h.fadeKey], ["tree", PINE, null], `bush at ${bush}`);
  }
  // Beside a boulder the same bush does not turn the rock into a tree.
  const rb = await sceneryQuery([{ did: ROCK, pos: [1000, 1006, 0] }, { did: BUSH, pos: [1000.8, 1004.9, 0] }]);
  const boulder = rb.describeHit({ layer: "scenery", point: [1000, 1005.05, 0.9], normal: [0, -1, 0] });
  assert.deepEqual([boulder.kind, boulder.did, boulder.fadeKey], ["rock", ROCK, null]);
  // A catalog collider reach (model m) replaces the size bound: PINE's real trunk is 1.09 m (+0.05 axis
  // offset), so a hit 2.5 m from its axis cannot be its trunk — the label moves to BIG (axis 3.0 m behind,
  // within its own reach); without the collider the 5.2 m cap lets the nearer PINE axis keep it.
  const rows = [{ did: PINE, pos: [1000, 1006, 0] }, { did: BIG, pos: [1000.4, 1006.47, 0] }];
  const loose = await sceneryQuery(rows);
  const tight = await sceneryQuery(rows, { catalogs: { colliderOf: (did) => (did === PINE ? 1.14 : null) } });
  const far = { layer: "scenery", point: [1000, 1003.5, 1.5], normal: [0, -1, 0] };
  assert.deepEqual([loose.describeHit(far).did, loose.describeHit(far).fadeKey], [PINE, null], "size bound: 2.5 m ≤ 5.2 m");
  assert.deepEqual([tight.describeHit(far).did, tight.describeHit(far).fadeKey], [BIG, null], "collider bound: 2.5 m > 1.14 + 0.3 m");
  assert.equal(tight.describeHit({ layer: "scenery", point: [1000, 1004.91, 1.5], normal: [0, -1, 0] }).did, PINE, "its trunk surface is still the pine");
});
await check("S14 end to end with real sensors: scenery collider hits stay hidden with NO id — a boulder beside a catalogued tree, a thin trunk beside a big tree, a pine trunk behind a collider-less bush — and no faded scenery key clears them; the pilot's answer becomes a reroute (r4)", async () => {
  const runSensors = (sh, wq, pose, fadedIds) => {
    const sensors = SN.createSensors({ worldQuery: wq, sh });
    let f;
    for (let i = 0; i < 3; i++) f = sensors.sense(pose, { subjectRef: SUBJ, fadedIds }, 0.5);
    return f;
  };
  const scene = async (rows, scenery) => {
    const sh = geoSh({ prims: { scenery, objects: [subjectSphere] } });
    const wq = WQ.createWorldQuery({ liveScene3d: fakeLive([subjectEntity()]), sessionHandle: sh, wasmExports: rowsWasm(rows), THREE, catalogs: realCatalogs(), ownerRegistry: null, now: () => 0 });
    await wq.staticsNear([E[0], E[1], 0], 20);
    return { sh, wq };
  };
  const cases = [
    // p3_rock_tree_e2e.mjs: only the boulder's sphere (r 0.95 at z 0.95) is on the rays; tree BIG stands on the camera side.
    ["boulder beside BIG", [{ did: ROCK, pos: [E[0], E[1] + 6, 0] }, { did: BIG, pos: [E[0] - 2, E[1] + 3.8, 0] }],
      [{ type: "sphere", c: [E[0], E[1] + 6, 0.95], r: 0.95 }], pose0({ pos: [E[0], E[1], 1] }), "rock"],
    // The thin trunk (r 0.3) blocks; BIG stands 2.5 m to the side, off the rays.
    ["thin trunk beside BIG", [{ did: BIG, pos: [E[0] + 2.5, E[1] + 6, 0] }, { did: THIN, pos: [E[0], E[1] + 6, 0] }],
      [{ type: "cyl", c: [E[0], E[1] + 6], r: 0.3, z0: 0, z1: 3 }], pose0(), "tree"],
    // The pine's trunk blocks; the bush (no collider) stands between, nearer the hit point than the pine's axis.
    ["pine behind a bush", [{ did: PINE, pos: [E[0] - 0.05, E[1] + 6, 0] }, { did: BUSH, pos: [E[0] + 0.9, E[1] + 4.4, 0] }],
      [{ type: "cyl", c: [E[0], E[1] + 6], r: 1.09, z0: -1.9, z1: 21.1 }], pose0(), "tree"],
  ];
  for (const [label, rows, prims, pose, kind] of cases) {
    const { sh, wq } = await scene(rows, prims);
    const f = runSensors(sh, wq, pose, null);
    assert.deepEqual([f.subject.visibleFrac, f.subject.occluderKind, f.subject.occluderIds], [0, kind, []], `${label} (round 3: the tree's scenery key)`);
    const allKeys = rows.map((_, i) => keyOf("scenery", i));
    for (const faded of [...allKeys.map((k) => [k]), allKeys]) {
      const g = runSensors(sh, wq, pose, faded);
      assert.deepEqual([g.subject.visibleFrac, g.subject.occluderIds], [0, []], `${label}: fadedIds ${faded} is no clear view`);
    }
    for (const k of allKeys) assert.equal(wq.staticFadeTargets(k), null, `${label}: ${k} hides nothing`);
    const m = MAP.createResidualMapper({});
    const sp = m.apply(POL.codePolicy(f, null), { now: 0, sensorFrame: f });
    assert.deepEqual([sp.fadeIds, sp.reroute], [[], true], `${label}: the camera reroutes`);
  }
});

await check("W15 a size fetch that never settles costs ONE bounded wait: a query's landblocks wait together, the DID is remembered as stalled and later landblocks skip it; a late fetch un-stalls", async () => {
  const HUNG = 0x02000ddd, LATE = 0x02000eee;
  const lbOf = (ids) => (ids[0] & 0xffff0000) >>> 0;
  // Every landblock holds the hung DID at local (96, 96); landblocks with x < 8 also hold LATE at (100, 96).
  const wasm = {
    async fetch_landblock_objects_soa(ids) {
      const lb = lbOf(ids);
      const withLate = ((lb >>> 24) & 0xff) < 8;
      const dids = withLate ? [HUNG, LATE] : [HUNG];
      return new FakeSoa({
        len: dids.length,
        modelIds: Uint32Array.from(dids),
        positions: Float32Array.from(dids.flatMap((d, i) => [96 + 4 * i, 96, 0])),
        scales: Float32Array.from(dids.map(() => 1)),
        isBuilding: new Uint8Array(dids.length),
        landblockIds: Uint32Array.from(dids.map(() => lb)),
      });
    },
    async fetch_landblock_scenery_soa() { return new FakeSoa({ len: 0 }); },
  };
  const fetched = [];
  let releaseLate = null;
  const timers = [];
  let timersAtFirstFire = -1;
  const TIMEOUT = 80;
  const catalogs = WQ.createStaticCatalogs({
    selectionSphere(id) {
      fetched.push(id);
      if (id === HUNG) return new Promise(() => {}); // never settles
      return new Promise((resolve) => { releaseLate = () => resolve(new FakeSphere({ id, cz: 0.5, radius: 0.6 })); });
    },
    timeoutMs: TIMEOUT,
    setTimeout(fn, ms) {
      timers.push(ms);
      return setTimeout(() => {
        if (timersAtFirstFire < 0) timersAtFirstFire = timers.length;
        fn();
      }, ms);
    },
    clearTimeout: (t) => clearTimeout(t),
  });
  const wq = WQ.createWorldQuery({ wasmExports: wasm, catalogs, ownerRegistry: null });
  // Query 1: a 3×3 landblock disc (LB x 4..6, y 4..6), every landblock holding both DIDs.
  const t0 = Date.now();
  const rows1 = await wq.staticsNear([1056, 1056, 0], 280);
  const waited = Date.now() - t0;
  assert.equal(rows1.length, 18, "all 9 landblocks ready (sizes defaulted)");
  assert.ok(rows1.every((r) => r.dimsSource === "default"));
  assert.equal(timersAtFirstFire, 9, "all 9 landblocks waited TOGETHER (one after another, the first wait would fire with 1 timer made)");
  assert.ok(waited < 5 * TIMEOUT, `one bounded wait, not 9 in a row: ${waited} ms (sequential ≥ ${9 * TIMEOUT} ms)`);
  assert.deepEqual(fetched.sort(), [HUNG, LATE].sort(), "each DID fetched once");
  assert.deepEqual([catalogs.stats().stalled, catalogs.stats().timeouts], [2, 9]);
  // Query 2: 9 NEW landblocks (x 7..9) — both DIDs are stalled: no wait at all, no new fetch.
  const n = timers.length;
  const rows2 = await wq.staticsNear([1056 + 3 * 192, 1056, 0], 280);
  assert.equal(rows2.length, 9 + 3, "x 7 holds LATE too");
  assert.equal(timers.length, n, "no new timer: stalled DIDs are not waited for again");
  assert.equal(fetched.length, 2);
  // The late fetch settles: LATE leaves the stalled set and its rows pick up the real size when touched.
  releaseLate();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(catalogs.stats().stalled, 1, "only the hung DID is left");
  const late = wq.staticsNearCached([960 + 100, 960 + 96, 0], 0.5); // LATE in LB 0x0505
  assert.deepEqual(late.map((r) => [r.did, r.dimsSource, r.radius]), [[LATE, "selectionSphere", 0.6]]);
  // A landblock whose only uncatalogued DID is stalled is ready at once.
  const n2 = timers.length;
  await wq.staticsNear([1056 + 6 * 192, 1056 + 6 * 192, 0], 10);
  assert.equal(timers.length, n2);
});

// ---------------------------------------------------------------------------
// round-4 (r4-scenery-fade): a SCENERY collider hit never carries a fade key (orchestrator decision)
// ---------------------------------------------------------------------------

/**
 * More real rows of dist/vfx/visual_descriptors.jsonl (verbatim signals) and the real DAT colliders of the
 * 2026-07-27 scenery census (scenery-collidability.json; model space, × the placement scale):
 *   BOULDER 0x02001065 creature-breath 9.55 / 0.41 → rock, r 4.775; spheres r 2.299 at (0.449286, −0.888526, 0.99951)
 *           and (−0.0560766, 0.509131, 0.99951) — 51,241 placements, 87 % of the collidable scenery rocks
 *   TRI     0x0200035F trunk-canopy 11.66 / 0.68; spheres r 2.81 at (0.113602, 0.175, 0.3) and (2.34346, 0.175, 0.3),
 *           r 1.434 at (−3.62772, −0.6, −0.310501) — 53,284 placements
 *   TWIN    0x02000251 trunk-canopy 26.56 / 0.66; cylspheres r 1.831 at (−1.57982, 0, −1.13931) and r 1.512 at
 *           (1.38236, 0.291619, −1.13931), h 30 — 6,266 placements
 *   TWIN2   0x020002DC trunk-canopy 26.56 / 0.66; cylspheres r 0.952 at (−0.667384, 0, −1.13931) h 14.804 and
 *           r 0.749 at (0.78306, 0.291619, −1.13931) h 14.398 — 3,791 placements
 *   OAK     0x02000246 trunk-canopy 8.05 / 1.26; cylsphere r 0.85 h 3.334 on its axis — 283,249 placements
 */
const BOULDER = 0x02001065, TRI = 0x0200035f, TWIN = 0x02000251, TWIN2 = 0x020002dc;
const R4_DESC = new Map([
  [BOULDER, ["creature-breath", "9.55", "0.41"]],
  [TRI, ["trunk-canopy", "11.66", "0.68"]],
  [TWIN, ["trunk-canopy", "26.56", "0.66"]],
  [TWIN2, ["trunk-canopy", "26.56", "0.66"]],
  [OAK, ["trunk-canopy", "8.05", "1.26"]],
].map(([did, [archetype, M, A]]) => [did, { archetype, raw: { signals: [{ name: "maxDimension", value: M }, { name: "aspectRatio", value: A }] } }]));
const r4Catalogs = () => WQ.createStaticCatalogs({ descriptorFor: (did) => REAL_DESC.get(did) ?? R4_DESC.get(did) ?? null });
/** Census colliders → geoSh scenery prims for a placement at (x, y) with scale s. */
const CENSUS = {
  [BOULDER]: { spheres: [[0.449286, -0.888526, 0.99951, 2.299], [-0.0560766, 0.509131, 0.99951, 2.299]] },
  [TRI]: { spheres: [[0.113602, 0.175, 0.3, 2.81], [2.34346, 0.175, 0.3, 2.81], [-3.62772, -0.6, -0.310501, 1.434]] },
  [TWIN]: { cyls: [[-1.57982, 0, -1.13931, 1.831, 30], [1.38236, 0.291619, -1.13931, 1.512, 30]] },
  [TWIN2]: { cyls: [[-0.667384, 0, -1.13931, 0.952001, 14.804], [0.78306, 0.291619, -1.13931, 0.749001, 14.398]] },
  [OAK]: { cyls: [[0, 0, 0, 0.85, 3.334]] },
  [PINE]: { cyls: [[0.05, 0, -1.90161, 1.09, 23.02]] },
};
function censusPrims(did, x, y, s = 1) {
  const c = CENSUS[did] ?? {};
  return [
    ...(c.spheres ?? []).map(([ox, oy, oz, r]) => ({ type: "sphere", c: [x + ox * s, y + oy * s, oz * s], r: r * s })),
    ...(c.cyls ?? []).map(([ox, oy, oz, r, h]) => ({ type: "cyl", c: [x + ox * s, y + oy * s], r: r * s, z0: oz * s, z1: (oz + h) * s })),
  ];
}

/**
 * The round-3 checker's configurations (check:r3-perception, probes /tmp/claude-1000/r3perc-chk/p4, p5, p7), as
 * scenery rows + the occluder whose collider blocks the rays. Every one gave a NEIGHBOUR's fade key in round 3
 * (fading it read as a clear view through the real blocker). `occ` = the blocking placement; `hit` = the
 * describeHit-level hit the probe used.
 */
function r4Configs() {
  const out = [];
  // p4: the boulder at (1000, 1006); a catalogued tree 1–2 m behind its centre (BIG / PINE), boulder scale 1.0 / 1.4 / 0.6.
  for (const [label, tree, off, s] of [
    ["p4 BIG 2 m behind the boulder, scale 1.0", BIG, [0.45, 2], 1],
    ["p4 BIG 1 m behind, scale 1.0", BIG, [0.2, 1], 1],
    ["p4 PINE 2 m behind, scale 1.0", PINE, [0.45, 2], 1],
    ["p4 BIG 2 m behind, scale 1.4", BIG, [0.6, 2], 1.4],
    ["p4 BIG 2 m behind, scale 0.6", BIG, [0.3, 2], 0.6],
  ]) {
    out.push({ label, rows: [{ did: BOULDER, pos: [1000, 1006, 0], scale: s }, { did: tree, pos: [1000 + off[0], 1006 + off[1], 0] }], occ: { did: BOULDER, x: 1000, y: 1006, s } });
  }
  // p7: the boulder's own census scenes — the oak just behind it, the collider-less bush at its foot.
  for (const s of [0.7, 1]) {
    const cx = 1000 + 0.449286 * s, hy = 1006 - 0.888526 * s - 2.299 * s;
    out.push({ label: `p7 oak just behind the boulder, scale ${s}`, rows: [{ did: BOULDER, pos: [1000, 1006, 0], scale: s }, { did: OAK, pos: [cx, 1006 + 2.81 * s + 0.4, 0] }], occ: { did: BOULDER, x: 1000, y: 1006, s }, hit: { point: [cx, hy, s], normal: [0, -1, 0] } });
    out.push({ label: `p7 bush at the boulder's foot, scale ${s}`, rows: [{ did: BOULDER, pos: [1000, 1006, 0], scale: s }, { did: BUSH, pos: [cx + 0.3, hy + 1.6, 0] }], occ: { did: BOULDER, x: 1000, y: 1006, s }, hit: { point: [cx, hy, s], normal: [0, -1, 0] } });
  }
  // p5: off-axis colliders — 035F's off-axis sphere, the twin trunks' left trunk — with a catalogued tree behind the hit.
  const triX = 1000 - 2.34346, triY = 1006 - 0.175; // its sphere (2.343, 0.175) on the rays (x = 1000)
  const triHit = { point: [1000, 1006 - 2.81, 0.3], normal: [0, -1, 0] };
  out.push({ label: "p5 035F alone (its own off-axis sphere)", rows: [{ did: TRI, pos: [triX, triY, 0] }], occ: { did: TRI, x: triX, y: triY, s: 1 }, hit: triHit });
  out.push({ label: "p5 035F + BIG behind the hit", rows: [{ did: TRI, pos: [triX, triY, 0] }, { did: BIG, pos: [1000.157, 1006 - 2.81 + 4.635, 0] }], occ: { did: TRI, x: triX, y: triY, s: 1 }, hit: triHit });
  out.push({ label: "p5 035F + PINE behind the hit", rows: [{ did: TRI, pos: [triX, triY, 0] }, { did: PINE, pos: [1000.057, 1006 - 2.81 + 4.135, 0] }], occ: { did: TRI, x: triX, y: triY, s: 1 }, hit: triHit });
  const twinX = 1000 + 1.57982; // its left trunk on the rays
  const twinHit = { point: [1000, 1006 - 1.831, 2], normal: [0, -1, 0] };
  out.push({ label: "p5 0251 twin trunk alone (left trunk)", rows: [{ did: TWIN, pos: [twinX, 1006, 0] }], occ: { did: TWIN, x: twinX, y: 1006, s: 1 }, hit: twinHit });
  out.push({ label: "p5 0251 + BIG behind its left trunk", rows: [{ did: TWIN, pos: [twinX, 1006, 0] }, { did: BIG, pos: [1000.08, 1006 - 1.831 + 4.831, 0] }], occ: { did: TWIN, x: twinX, y: 1006, s: 1 }, hit: twinHit });
  const twin2X = 1000 + 0.667384;
  out.push({ label: "02DC twin trunk + BIG behind its left trunk", rows: [{ did: TWIN2, pos: [twin2X, 1006, 0] }, { did: BIG, pos: [1000.08, 1009, 0] }], occ: { did: TWIN2, x: twin2X, y: 1006, s: 1 }, hit: { point: [1000, 1006 - 0.952, 2], normal: [0, -1, 0] } });
  return out;
}

await check("W16 (r4) the round-3 checker's configurations — the main boulder 0x02001065 with a tree / bush behind it, off-axis multi-trunk trees with a neighbour — give NO fade key at all (round 3: a neighbour's key, i.e. a false clear view); the label stays a plausible placement", async () => {
  let n = 0;
  for (const cfg of r4Configs()) {
    const wq = WQ.createWorldQuery({ wasmExports: rowsWasm(cfg.rows), catalogs: r4Catalogs(), ownerRegistry: null });
    await wq.staticsNear([1000, 1000, 0], 20);
    // The probe's hit (p5 / p7), else the centre ray of p4's camera → subject, swept against the census spheres.
    let hit = cfg.hit;
    if (!hit) {
      const best = sweepList(censusPrims(cfg.occ.did, cfg.occ.x, cfg.occ.y, cfg.occ.s), [1000, 996, 1.2], [1000, 1012, 0.9], 0.05);
      assert.ok(best, `${cfg.label}: the centre ray hits the boulder`);
      best.free();
      hit = { point: [best._d.x, best._d.y, best._d.z], normal: [best._d.normalX, best._d.normalY, best._d.normalZ] };
    }
    for (const normal of [hit.normal, null]) {
      const h = wq.describeHit({ layer: "scenery", point: hit.point, normal });
      assert.equal(h.fadeKey, null, `${cfg.label}, normal ${normal}: no key`);
      assert.ok(["tree", "rock"].includes(h.kind), `${cfg.label}: label ${h.kind}`);
      assert.ok(cfg.rows.some((r) => r.did === h.did), `${cfg.label}: the label names a placement of the scene`);
      n += 1;
    }
    // The boulder's rows are real catalog rows: rock, DAT-bounds size.
    const occRow = wq.staticsNearCached([cfg.occ.x, cfg.occ.y, 0], 0.5).find((r) => r.did === cfg.occ.did);
    assert.equal(occRow.kind, cfg.occ.did === BOULDER ? "rock" : "tree");
    assert.equal(occRow.dimsSource, "catalog");
  }
  assert.equal(n, 2 * 15);
});

await check("S16 (r4) the same configurations end to end with the census colliders and the real sensors: the subject stays reported HIDDEN with no occluder id; fading every neighbour's (hand-made) scenery key never reads as a clear view; staticFadeTargets hides nothing; the pilot's fade becomes a reroute", async () => {
  const low = pose0({ pos: [E[0], E[1], 1] });
  const run = (sh, wq, fadedIds) => {
    const sensors = SN.createSensors({ worldQuery: wq, sh });
    let f;
    for (let i = 0; i < 3; i++) f = sensors.sense(low, { subjectRef: SUBJ, fadedIds }, 0.5);
    return f;
  };
  for (const cfg of r4Configs()) {
    // Every placement's census collider is in the scenery layer (BIG / THIN are catalogue rows with no census entry;
    // the bush has none): the rays stop on the occluder's collider first.
    const prims = cfg.rows.flatMap((r) => censusPrims(r.did, r.pos[0], r.pos[1], r.scale ?? 1));
    const sh = geoSh({ prims: { scenery: prims, objects: [subjectSphere] } });
    const wq = WQ.createWorldQuery({ liveScene3d: fakeLive([subjectEntity()]), sessionHandle: sh, wasmExports: rowsWasm(cfg.rows), THREE, catalogs: r4Catalogs(), ownerRegistry: null, now: () => 0 });
    await wq.staticsNear([E[0], E[1], 0], 20);
    const f = run(sh, wq, null);
    assert.equal(f.subject.visibleFrac, 0, `${cfg.label}: hidden`);
    assert.deepEqual(f.subject.occluderIds, [], `${cfg.label}: no occluder id (round 3: the neighbour's key)`);
    assert.ok(["tree", "rock"].includes(f.subject.occluderKind), `${cfg.label}: kind ${f.subject.occluderKind}`);
    const keys = cfg.rows.map((_, i) => keyOf("scenery", i));
    for (const faded of [...keys.map((k) => [k]), keys]) {
      const g = run(sh, wq, faded);
      assert.deepEqual([g.subject.visibleFrac, g.subject.occluderIds], [0, []], `${cfg.label}: fadedIds ${faded} → still hidden`);
    }
    for (const k of keys) assert.equal(wq.staticFadeTargets(k), null, `${cfg.label}: ${k} resolves to nothing`);
    const m = MAP.createResidualMapper({});
    const pol = POL.codePolicy(f, null);
    assert.equal(pol.occluder_action.choice, f.subject.occluderKind === "rock" ? "reroute" : "fade");
    const sp = m.apply(pol, { now: 0, sensorFrame: f });
    assert.deepEqual([sp.fadeIds, sp.reroute], [[], true], `${cfg.label}: the camera reroutes (fade → fallback, or reroute)`);
  }
});

await check("S17 (r4) the sensors never take an id from a scenery hit, whatever the world query answers: a guid or a placement key (even an object key) on a scenery-layer hit is dropped and never 'seen through'; on a statics hit only a fadeable (object) placement key is kept", async () => {
  const OBJ_KEY = keyOf("object", 3), SCN_KEY = keyOf("scenery", 3);
  assert.equal(SN.isFadeableStaticKey(OBJ_KEY), true);
  assert.equal(SN.isFadeableStaticKey(SCN_KEY), false, "procedural scenery is never fadeable (v1)");
  for (const bad of ["fx:0x50000001:2", `${OBJ_KEY}#1`, "placement:zz:object:1", 42, null, undefined, ""]) assert.equal(SN.isFadeableStaticKey(bad), false, String(bad));
  const trunk = { type: "cyl", c: [E[0], E[1] + 6], r: 0.5, z0: 0, z1: 8 };
  const run = (layer, answer, fadedIds) => {
    const sh = geoSh({ prims: { [layer]: [trunk], objects: [subjectSphere] } });
    const live = fakeLive([subjectEntity()]);
    const real = WQ.createWorldQuery({ liveScene3d: live, sessionHandle: sh, THREE, ownerRegistry: null, now: () => 0 });
    // A world query whose describeHit names an id for EVERY hit (a stale or foreign implementation).
    const wq = { ...real, describeHit: () => ({ kind: "tree", did: 0x02000246, ...answer }) };
    const sensors = SN.createSensors({ worldQuery: wq, sh });
    let f;
    for (let i = 0; i < 3; i++) f = sensors.sense(pose0(), { subjectRef: SUBJ, fadedIds }, 0.5);
    return f.subject;
  };
  for (const answer of [{ fadeKey: SCN_KEY }, { fadeKey: OBJ_KEY }, { guid: 0x80000077 }, { guid: 0x80000077, fadeKey: OBJ_KEY }]) {
    const s0 = run("scenery", answer, null);
    assert.deepEqual([s0.visibleFrac, s0.occluderKind, s0.occluderIds], [0, "tree", []], `scenery hit, answer ${JSON.stringify(answer)}`);
    const s1 = run("scenery", answer, [SCN_KEY, OBJ_KEY, 0x80000077]);
    assert.deepEqual([s1.visibleFrac, s1.occluderIds], [0, []], `scenery hit, answer ${JSON.stringify(answer)}: nothing faded reads as a clear view`);
  }
  // Statics (render-bounds) hits: a scenery-source key is dropped, an object key is kept and, once faded, seen past.
  assert.deepEqual(run("statics", { fadeKey: SCN_KEY }, null).occluderIds, []);
  assert.deepEqual(run("statics", { fadeKey: SCN_KEY }, [SCN_KEY]).visibleFrac, 0);
  assert.deepEqual(run("statics", { fadeKey: OBJ_KEY }, null).occluderIds, [OBJ_KEY]);
  assert.equal(run("statics", { fadeKey: OBJ_KEY }, [OBJ_KEY]).visibleFrac, 1);
});

await check("S10 every CollisionHit freed; bad poses and a throwing los never throw", () => {
  for (const h of ALL_HITS) assert.equal(h.freed, 1, "hit freed exactly once");
  assert.ok(ALL_HITS.length > 50, `hits exercised: ${ALL_HITS.length}`);
  const logs = [];
  const sensors = SN.createSensors({ sh: {}, los: () => { throw new Error("boom"); }, log: (e) => logs.push(e) });
  const f = sensors.sense(pose0(), { subject: { pos: [E[0], E[1] + 5, 0] } }, 0.1);
  assert.equal(f.sectors.center.range, Infinity);
  assert.equal(f.subject.visibleFrac, 1, "unknown → treated as visible, never a guess");
  assert.ok(sensors.stats().losErrors > 0);
  assert.equal(logs.length, 1, "logged once");
  const e1 = sensors.sense(null, {}, 0.1);
  assert.equal(e1.sectors.center.range, Infinity);
  assert.equal(e1.subject, null);
  const e2 = sensors.sense({ pos: [NaN, 0, 0] }, {}, 0.1);
  assert.equal(e2.nearest.range, Infinity);
  const e3 = sensors.sense({ pos: [1, 2, 3], q: [0, 0, 0, 0], h: NaN }, { subject: { pos: "bad" }, nominalAhead: 42 }, NaN);
  assertNoNaN(e3);
  assert.equal(e3.subject, null, "invalid subject ignored");
  const empty = SN.emptySensorFrame();
  assert.equal(empty.ages.sectors, Infinity);
  assert.deepEqual(SN.SECTOR_CENTRES_DEG, [-32, -16, 0, 16, 32]);
  assert.equal(SN.PROBE_ORDER.length, 19);
  // Defaults: no deps at all still senses (los default, no world query).
  const bare = SN.createSensors();
  const b = bare.sense(pose0(), {}, 0.1);
  assert.equal(b.budget.limit, 16);
});

await check("S18 a POINT subject aimed at a Life Stone (holtburg.02: radius 1.2 m, the prongs stand ~2 m out): a ray stopped by a prong outside the subject radius is an occluder (its guid in occluderIds) — unless ctx.subjectBodyIds names the stone as the subject's own body: then the rays SEE the subject and nothing is offered for a fade; another body id does not clear it", () => {
  const LS = 0x7a9b4005;
  const stone = { guid: LS, pos: [E[0], E[1] + 6, 0], meta: { itemType: F.ITEM_TYPE_LIFE_STONE, name: "Life Stone" } };
  // One prong between the camera and the crystal: 1.8 m from the stone's axis (outside 1.2 + the 0.3 m self pad).
  const prong = { type: "cyl", c: [E[0], E[1] + 4.2], r: 0.4, z0: 0, z1: 4, guid: LS };
  const subject = { pos: [E[0], E[1] + 6, 0], radius: 1.2, height: 3.2 };
  const rigOf = () => sensorRig({ entities: [stone], sh: { prims: { objects: [prong] }, dims: new Map([[LS, [1.6, 3.6]]]) } });
  const run = (R, extra) => {
    let f;
    for (let i = 0; i < 3; i++) f = R.sensors.sense(pose0(), { subject, ...extra }, 0.1);
    return f.subject;
  };
  const bare = run(rigOf(), {});
  assert.ok(bare.visibleFrac < 1, `the prong hides part of the subject (visibleFrac ${bare.visibleFrac})`);
  assert.deepEqual(bare.occluderIds, [LS], "without a body the stone is offered as an occluder (the holtburg.02 fade)");
  const body = run(rigOf(), { subjectBodyIds: [LS] });
  assert.deepEqual([body.visibleFrac, body.occluderIds, body.occluderKind, body.unseenSec], [1, [], null, 0], "the subject's own body is seen, never an occluder");
  const other = run(rigOf(), { subjectBodyIds: [0x7a9b4006, "placement:a9b4fffe:object:3"] });
  assert.deepEqual(other.occluderIds, [LS], "only the named body counts as the subject");
});

console.log(`film_perception: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
