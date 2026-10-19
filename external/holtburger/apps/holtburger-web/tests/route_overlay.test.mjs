// tests/route_overlay.test.mjs — scene3d/route_overlay.js, the VTank route
// drawn in the 3D world (rings, legs, current waypoint, player line).
//
// Real `three` (node_modules, the same 0.184.0 the index.html import map
// serves); rynth/nav_file.js + rynth/vt/nav/route_model.js are the coordinate
// oracles; rynth/testdata/MatronHive.nav is a real VTank route (town → Town
// Network dungeon → Baishi → Matron Hive, Recall / Chat / 3 Portal-NPC points).
// No browser, no wasm, no timers (fake timers for the page attach).
//
// Run from apps/holtburger-web/:  node tests/route_overlay.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

const RO = await import("../scene3d/route_overlay.js");
const { degToWorld, navPointToLeg, parseNav } = await import("../rynth/nav_file.js");
const RM = await import("../rynth/vt/nav/route_model.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}
const near = (a, b, eps, msg) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `${msg || "near"}: ${a} vs ${b} (±${eps})`);

// A Holtburg waypoint (typed_points.nav #0) and metre offsets from it: 1° = 240 m.
const BASE = { ew: 33.6, ns: 42.079583332936, z: 0.3916916847229 };
const at = (type, dE, dN, extra = {}) => ({ type, ew: BASE.ew + dE / 240, ns: BASE.ns + dN / 240, z: BASE.z, ...extra });
const square = (routeType, activeIndex = 0) => ({
  routeType,
  activeIndex,
  points: [at(0, 0, 0), at(0, 10, 0), at(0, 10, 10), at(0, 0, 10)],
});
const deepClone = (r) => JSON.parse(JSON.stringify(r));
const makeScene = () => {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2; // scene3d/index.js:1663
  scene.add(worldRoot);
  const entitiesGroup = new THREE.Group();
  worldRoot.add(entitiesGroup);
  return { scene, worldRoot, entitiesGroup };
};
const anchorOf = (g, i) => ({ x: g.anchors[i * 3], y: g.anchors[i * 3 + 1], z: g.anchors[i * 3 + 2] });

// The mixed route: in-place points, a portal into a dungeon, a jump, a recall.
const DUNGEON = { ew: -101.658333333333, ns: -96.6, z: 2.08333134651184e-5 }; // MatronHive #9 (Town Network)
const mixed = (routeType = RO.NAV_ROUTE.Once, activeIndex = 0) => ({
  routeType,
  activeIndex,
  points: [
    at(0, 0, 0), // 0 walk
    at(4, 500, 0, { chat: "/ls" }), // 1 Chat with stale coordinates 500 m away → runs at 0
    at(0, 10, 0), // 2 walk
    at(6, 300, 300, { name: "Portal to Town Network", objectClass: 14, exitEW: BASE.ew + 12 / 240, exitNS: BASE.ns + 2 / 240, exitZ: BASE.z }), // 3 → drawn at its portal
    { type: 0, ew: DUNGEON.ew, ns: DUNGEON.ns, z: DUNGEON.z }, // 4 dungeon (teleported)
    { type: 9, ew: 0, ns: 0, z: 0, headingDeg: 90, holdShift: false, delayMs: 0 }, // 5 Jump (sentinel) → runs at 4
    { type: 0, ew: DUNGEON.ew + 8 / 240, ns: DUNGEON.ns, z: DUNGEON.z }, // 6 dungeon walk
    { type: 2, ew: 0, ns: 0, z: -1000 / 240, spellId: 1635 }, // 7 Recall (sentinel) → runs at 6
    at(0, 0, -5), // 8 back in town
  ],
});

console.log("\n— coordinates");

await check("navToAcWorld == nav_file.degToWorld (x, y) and route_model.pointWorld (z = navZ·240)", () => {
  const samples = [
    [33.6, 42.079583332936, 0.3916916847229],
    [DUNGEON.ew, DUNGEON.ns, DUNGEON.z],
    [56.8172263463338, 33.5988937695821, 0.175020837783813],
    [0.05, -0.05, 0],
    [101.9, 101.9, 1.2],
    [-101.95, -101.95, -0.3],
  ];
  for (const [ew, ns, z] of samples) {
    const a = RO.navToAcWorld(ew, ns, z);
    const b = degToWorld(ew, ns);
    assert.equal(a.x, b.wx);
    assert.equal(a.y, b.wy);
    const pw = RM.pointWorld({ type: 0, ew, ns, z });
    assert.equal(a.x, pw.wx);
    assert.equal(a.y, pw.wy);
    assert.equal(a.z, pw.z);
  }
});

await check("by hand: 33.6E 42.0796N z0.39169 → AC (32532, 34567.1, 94.006) = landblock 0xA9B4 local (84, 7.1)", () => {
  const a = RO.navToAcWorld(BASE.ew, BASE.ns, BASE.z);
  near(a.x, 32532, 1e-9, "x = (33.6·10 + 1019.5)·24");
  near(a.y, 34567.1, 1e-6, "y = (420.7958 + 1019.5)·24");
  near(a.z, 94.006004333, 1e-6, "z = 0.3916916847229·240");
  const leg = navPointToLeg(BASE.ew, BASE.ns, BASE.z);
  assert.equal(leg.lb >>> 16, 0xa9b4, "Holtburg");
  near(leg.x, 84, 1e-6, "local x");
  near(leg.y, 7.1, 1e-6, "local y");
  // scene3d places every landblock thing at lbX·192 + local (statics.js:1932, cells.js:742, rust_pose.js:84)
  near(((leg.lb >>> 24) & 0xff) * 192 + leg.x, a.x, 1e-6, "lbX·192 + x");
  near(((leg.lb >>> 16) & 0xff) * 192 + leg.y, a.y, 1e-6, "lbY·192 + y");
  const t = RO.acWorldToThree(a.x, a.y, a.z);
  assert.deepEqual([t.x, t.y, t.z], [a.x, a.z, -a.y]);
});

await check("dungeon point (MatronHive #9): landblock 0x0006, the same lbX·192 + local frame cells.js uses for EnvCells", () => {
  const a = RO.navToAcWorld(DUNGEON.ew, DUNGEON.ns, DUNGEON.z);
  const leg = navPointToLeg(DUNGEON.ew, DUNGEON.ns, DUNGEON.z);
  assert.equal(leg.lb >>> 16, 0x0006);
  near(a.x, 70, 1e-6, "x");
  near(a.y, 1284, 1e-6, "y");
  near(((leg.lb >>> 24) & 0xff) * 192 + leg.x, a.x, 1e-6, "cells.js x");
  near(((leg.lb >>> 16) & 0xff) * 192 + leg.y, a.y, 1e-6, "cells.js y");
});

await check("end to end: worldRoot(−π/2) → entitiesGroup → overlay puts the ring and marker at three (x, z, −y)", () => {
  const { scene, entitiesGroup } = makeScene();
  const ov = RO.createRouteOverlay({ THREE, parent: entitiesGroup, opts: { labels: false } });
  ov.setRoute({ routeType: 1, activeIndex: 0, points: [at(0, 0, 0)] });
  ov.setVisible(true);
  scene.updateMatrixWorld(true);
  const { lines, activeGroup } = ov.objects;
  // One point, no legs: line vertex 0 is ring segment 0 = centre + (R, 0) at z + lift.
  const v = new THREE.Vector3().fromBufferAttribute(lines.geometry.attributes.position, 0).applyMatrix4(lines.matrixWorld);
  near(v.x, 32532 + 1.0, 1e-3, "three x = AC x + R");
  near(v.y, 94.006004333 + 0.12, 1e-3, "three y = AC z + lift");
  near(v.z, -34567.1, 1e-3, "three z = −AC y");
  const m = new THREE.Vector3().setFromMatrixPosition(activeGroup.matrixWorld);
  near(m.x, 32532, 1e-6, "marker x");
  near(m.y, 94.006004333, 1e-6, "marker y");
  near(m.z, -34567.1, 1e-6, "marker z");
  // float32 attributes stay small: the origin rides in pathGroup's (float64) matrix
  const arr = lines.geometry.attributes.position.array;
  let big = 0;
  for (let i = 0; i < arr.length; i++) big = Math.max(big, Math.abs(arr[i]));
  assert.ok(big < 5, `local vertex magnitude ${big}`);
});

console.log("\n— route types and leg kinds");

await check("Circular / Linear / Once / Follow: legs, closing leg, chevrons, rings", () => {
  const C = RO.buildRouteGeometry(square(RO.NAV_ROUTE.Circular));
  assert.deepEqual(
    [C.counts.rings, C.counts.walkSegments, C.counts.closingSegments, C.counts.chevrons, C.counts.hiddenLinks],
    [4, 3, 1, 4, 0],
  );
  const L = RO.buildRouteGeometry(square(RO.NAV_ROUTE.Linear));
  assert.deepEqual([L.counts.rings, L.counts.walkSegments, L.counts.closingSegments, L.counts.chevrons], [4, 3, 0, 0]);
  const O = RO.buildRouteGeometry(square(RO.NAV_ROUTE.Once));
  assert.deepEqual([O.counts.rings, O.counts.walkSegments, O.counts.closingSegments, O.counts.chevrons], [4, 3, 0, 3]);
  const F = RO.buildRouteGeometry(square(RO.NAV_ROUTE.Follow));
  assert.deepEqual([F.counts.rings, F.line.vertexCount, F.mesh.indexCount], [0, 0, 0]);
  // closing leg: 10 m dashed 1.0 on / 0.75 off → 6 dashes, no ribbon
  assert.equal(C.counts.dashes, 6);
  assert.deepEqual(C.segments.map((s) => s.kind), [RO.SEG.walk, RO.SEG.walk, RO.SEG.walk, RO.SEG.closing]);
  assert.deepEqual([C.segments[3].a, C.segments[3].b], [3, 0]);
});

await check("exact buffers (Circular square): line 6 + 12 + 4·48 + 16 vertices, mesh 3·8 + 4·96 vertices / 3·12 + 4·288 indices", () => {
  const C = RO.buildRouteGeometry(square(RO.NAV_ROUTE.Circular));
  assert.equal(C.line.vertexCount, 3 * 2 + 6 * 2 + 4 * 48 + 4 * 4);
  assert.equal(C.line.positions.length, C.line.vertexCount * 3);
  assert.equal(C.mesh.vertexCount, 3 * 8 + 4 * 96);
  assert.equal(C.mesh.indexCount, 3 * 12 + 4 * 288);
  assert.ok(C.mesh.indices instanceof Uint16Array);
  for (let i = 0; i < C.mesh.indexCount; i++) assert.ok(C.mesh.indices[i] < C.mesh.vertexCount);
  // with a palette, every vertex gets its slot's colour
  const pal = new Float32Array(13 * 3);
  for (let k = 0; k < 13; k++) pal.set([k / 16, 0.5, 1 - k / 16], k * 3);
  const Cp = RO.buildRouteGeometry(square(RO.NAV_ROUTE.Circular), {}, RO.navToAcWorld, pal);
  for (let i = 0; i < Cp.line.vertexCount; i++) assert.equal(Cp.line.colors[i * 3], pal[Cp.line.keys[i] * 3]);
  // legs + rings of plain Points use the path colour; the closing leg its own
  const keys = new Set(Cp.line.keys);
  assert.deepEqual([...keys].sort((a, b) => a - b), [RO.COLOR_KEY.path, RO.COLOR_KEY.closing]);
});

await check("in-place points hang on the previous walk target; portal / recall legs are teleports (hidden); a jump leg is red", () => {
  const g = RO.buildRouteGeometry(mixed(RO.NAV_ROUTE.Once));
  assert.deepEqual(g.walk, [0, 2, 3, 4, 6, 8]);
  assert.equal(g.anchorOf[1], 0, "Chat with stale coords runs at #0");
  assert.equal(g.anchorOf[5], 4, "Jump (sentinel) at #4");
  assert.equal(g.anchorOf[7], 6, "Recall (sentinel) at #6");
  // Portal/NPC #3 is drawn at its portal object (12 m E, 2 m N), not its own (300, 300) coordinates
  const p3 = anchorOf(g, 3);
  const obj = RO.navToAcWorld(BASE.ew + 12 / 240, BASE.ns + 2 / 240, BASE.z);
  near(p3.x, obj.x, 1e-9, "portal x");
  near(p3.y, obj.y, 1e-9, "portal y");
  assert.deepEqual(
    g.segments.map((s) => [s.a, s.b, s.kind]),
    [
      [0, 2, RO.SEG.walk],
      [2, 3, RO.SEG.walk],
      [3, 4, RO.SEG.hidden], // through the portal
      [4, 6, RO.SEG.jump], // a Jump runs on this leg
      [6, 8, RO.SEG.hidden], // a Recall runs on this leg
    ],
  );
  assert.deepEqual([g.counts.walkSegments, g.counts.jumpSegments, g.counts.hiddenLinks, g.counts.pips, g.counts.poles], [2, 1, 2, 3, 3]);
  // the jump colour: the leg (2) + its chevron (4) + the Jump waypoint's gem edges (12 × 2)
  const jumpKeys = [...g.line.keys].filter((k) => k === RO.COLOR_KEY.jump).length;
  assert.equal(jumpKeys, 2 + 4 + 24);
  // Circular: the town closing leg #8 → #0 (5 m) is drawn dashed
  const c = RO.buildRouteGeometry(mixed(RO.NAV_ROUTE.Circular));
  assert.deepEqual(c.segments[c.segments.length - 1], { a: 8, b: 0, kind: RO.SEG.closing });
  // teleportLinks: the hidden legs become dashed links
  const t = RO.buildRouteGeometry(mixed(RO.NAV_ROUTE.Once), { teleportLinks: true });
  assert.deepEqual([t.counts.teleportLinks, t.counts.hiddenLinks], [2, 0]);
});

await check("leading in-place point: Once → the first walk target, Circular → the last (wrap); no walk target → its own spot", () => {
  const pts = [at(2, 900, 900, { spellId: 1635 }), at(0, 0, 0), at(0, 10, 0)];
  assert.equal(RO.buildRouteGeometry({ routeType: 4, points: pts }).anchorOf[0], 1);
  assert.equal(RO.buildRouteGeometry({ routeType: 1, points: pts }).anchorOf[0], 2);
  const lone = RO.buildRouteGeometry({ routeType: 4, points: [at(3, 5, 5, { pauseMs: 1000 }), { type: 4, ew: 0, ns: 0, z: 0, chat: "x" }] });
  assert.deepEqual([lone.anchorOf[0], lone.anchorOf[1], lone.counts.rings, lone.counts.pips], [0, -1, 0, 1]);
});

await check("teleport rules: Recall on a leg, legacy Portal, Portal/NPC on a portal (14); NPC legs only beyond teleportGapM; any leg > maxSegmentM", () => {
  const npc = (cls, far) => ({
    routeType: 4,
    points: [at(0, 0, 0), at(6, 0, 0, { objectClass: cls, exitEW: BASE.ew + 3 / 240, exitNS: BASE.ns, exitZ: BASE.z }), at(0, far, 0)],
  });
  assert.equal(RO.buildRouteGeometry(npc(37, 50)).segments[1].kind, RO.SEG.walk);
  assert.equal(RO.buildRouteGeometry(npc(37, 500)).segments[1].kind, RO.SEG.hidden);
  assert.equal(RO.buildRouteGeometry(npc(14, 20)).segments[1].kind, RO.SEG.hidden, "a portal always teleports");
  const talk = { routeType: 4, points: [at(0, 0, 0), at(7, 0, 0, { objectClass: 37, exitEW: 0, exitNS: 0 }), at(0, 30, 0)] };
  assert.equal(RO.buildRouteGeometry(talk).segments[1].kind, RO.SEG.walk);
  const long = { routeType: 4, points: [at(0, 0, 0), at(0, 1500, 0)] };
  assert.equal(RO.buildRouteGeometry(long).segments[0].kind, RO.SEG.hidden);
  assert.equal(RO.buildRouteGeometry(long, { maxSegmentM: 2000 }).segments[0].kind, RO.SEG.walk);
  // the type rules alone (short legs, no distance rule): a Recall on the leg, a legacy Portal at its start
  const recall = { routeType: 4, points: [at(0, 0, 0), { type: 2, ew: 0, ns: 0, z: 0, spellId: 48 }, at(0, 30, 0)] };
  assert.equal(RO.buildRouteGeometry(recall).segments[0].kind, RO.SEG.hidden);
  const portal = { routeType: 4, points: [at(0, 0, 0), at(1, 5, 0, { guid: 0x7a9b0001 }), at(0, 20, 0)] };
  assert.deepEqual(RO.buildRouteGeometry(portal).segments.map((s) => s.kind), [RO.SEG.walk, RO.SEG.hidden]);
});

await check("real route rynth/testdata/MatronHive.nav (186 points, Once) through route_model.makeRoute", () => {
  const parsed = parseNav(fs.readFileSync(path.join(APP, "rynth/testdata/MatronHive.nav"), "utf8"));
  const route = RM.makeRoute({ routeType: parsed.routeType, points: parsed.points });
  assert.equal(route.points.length, 186);
  const g = RO.buildRouteGeometry(route);
  assert.equal(g.walk.length, 184, "181 Points + 3 Portal/NPC");
  assert.equal(g.anchorOf[0], 1, "the leading Recall hangs on the first walk point");
  assert.equal(g.anchorOf[5], 4, "the Chat runs where #4 left the player (its own coords are the Recall's)");
  for (const [i, prev] of [
    [8, 7],
    [30, 29],
    [90, 89],
  ]) {
    const a = anchorOf(g, i);
    const b = anchorOf(g, prev);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    assert.ok(d < 10, `Portal/NPC #${i} drawn ${d.toFixed(1)} m from #${prev} (at its portal object)`);
  }
  const hidden = g.segments.filter((s) => s.kind === RO.SEG.hidden).map((s) => `${s.a}->${s.b}`);
  assert.deepEqual(hidden, ["8->9", "30->31", "90->91"]);
  for (const s of g.segments) {
    if (s.kind === RO.SEG.hidden) continue;
    const d = Math.hypot(g.anchors[s.b * 3] - g.anchors[s.a * 3], g.anchors[s.b * 3 + 1] - g.anchors[s.a * 3 + 1]);
    assert.ok(d <= 1000, `drawn leg ${s.a}->${s.b} is ${d.toFixed(0)} m`);
  }
  assert.equal(g.counts.walkSegments + g.counts.jumpSegments + g.counts.hiddenLinks, 183);
  assert.deepEqual([g.counts.rings, g.counts.pips, g.counts.closingSegments], [184, 2, 0]);
});

await check("garbage in: unknown types, NaN / null coordinates, non-objects, a null route — skipped, never thrown", () => {
  const g = RO.buildRouteGeometry({
    routeType: "weird",
    points: [null, 7, { type: 42, ew: 1, ns: 1 }, { type: 0, ew: NaN, ns: 1, z: 0 }, { type: 0, ew: null, ns: 1 }, { type: 0, ew: 33.6, ns: 42.08, z: null }, at(0, 0, 0)],
  });
  assert.equal(g.routeType, 1);
  assert.deepEqual(g.walk, [6]);
  assert.equal(RO.buildRouteGeometry(null).line.vertexCount, 0);
  assert.equal(RO.buildRouteGeometry({ points: [] }).mesh.indexCount, 0);
  const tr = RO.buildRouteGeometry({ routeType: 4, points: Array.from({ length: 20 }, (_, i) => at(0, i * 3, 0)) }, { maxPoints: 10 });
  assert.deepEqual([tr.truncated, tr.n, tr.counts.rings], [true, 10, 10]);
});

console.log("\n— signature, active index, rebuilds");

await check("routeSignature: clone-stable, ignores active / paused / enabled, sensitive to order, coords, type, portal object", () => {
  const r = mixed();
  const s = RO.routeSignature(r);
  assert.equal(RO.routeSignature(deepClone(r)), s);
  assert.equal(RO.routeSignature({ ...r, activeIndex: 5, paused: { reason: "x" }, enabled: false, finished: true }), s);
  assert.notEqual(RO.routeSignature({ ...r, points: r.points.slice().reverse() }), s);
  const moved = deepClone(r);
  moved.points[2].ew += 1e-6;
  assert.notEqual(RO.routeSignature(moved), s);
  const retyped = deepClone(r);
  retyped.points[2].type = 8;
  assert.notEqual(RO.routeSignature(retyped), s);
  const portal = deepClone(r);
  portal.points[3].exitEW += 1e-5;
  assert.notEqual(RO.routeSignature(portal), s);
  const cls = deepClone(r);
  cls.points[3].objectClass = 37;
  assert.notEqual(RO.routeSignature(cls), s);
  assert.notEqual(RO.routeSignature({ ...r, routeType: 2 }), s);
});

await check("active-index / state changes are O(1): no rebuild, same buffers, marker moved; in-place active → its anchor", () => {
  const { scene, entitiesGroup } = makeScene();
  const canvasCalls = [];
  const fakeCtx = new Proxy({}, { get: (_, k) => (k === "canvas" ? null : (...a) => canvasCalls.push([k, ...a])), set: () => true });
  const ov = RO.createRouteOverlay({
    THREE,
    parent: entitiesGroup,
    opts: { createCanvas: (w, h) => ({ width: w, height: h, getContext: () => fakeCtx }) },
  });
  const route = mixed(RO.NAV_ROUTE.Circular, 0);
  ov.setRoute(route);
  ov.setVisible(true);
  const st0 = ov.stats();
  assert.equal(st0.rebuilds, 1);
  const lineGeom = ov.objects.lines.geometry;
  const meshGeom = ov.objects.ribbons.geometry;
  const g = ov.geometry;
  // same points object, new index
  ov.setRoute({ ...route, activeIndex: 2 });
  // a fresh deep clone (what ActiveNav.route() returns every poll), index 6
  ov.setRoute({ ...deepClone(route), activeIndex: 6 });
  let st = ov.stats();
  assert.equal(st.rebuilds, 1, "no rebuild");
  assert.equal(ov.objects.lines.geometry, lineGeom);
  assert.equal(ov.objects.ribbons.geometry, meshGeom);
  assert.equal(st.markerApplies, 3);
  scene.updateMatrixWorld(true);
  const a6 = anchorOf(g, 6);
  assert.deepEqual([st.active.x, st.active.y, st.active.z], [a6.x, a6.y, a6.z]);
  const m = new THREE.Vector3().setFromMatrixPosition(ov.objects.activeGroup.matrixWorld);
  near(m.x, a6.x, 1e-6, "marker x");
  near(m.z, -a6.y, 1e-6, "marker three z");
  // the Chat (#1) is current: the marker sits on #0, the label names it
  ov.setRoute({ ...route, activeIndex: 1 });
  st = ov.stats();
  assert.equal(st.active.anchor, 0);
  assert.equal(st.active.label, "2 Chat");
  assert.equal(st.active.state, "active");
  assert.equal(ov.objects.activeMat.color.getHex(), RO.ROUTE_OVERLAY_COLORS.active);
  ov.setRoute({ ...route, activeIndex: 1, paused: { reason: "operator" } });
  assert.equal(ov.stats().active.state, "paused");
  assert.equal(ov.objects.activeMat.color.getHex(), RO.ROUTE_OVERLAY_COLORS.paused);
  ov.setRoute({ ...route, activeIndex: 1, enabled: false });
  assert.equal(ov.stats().active.label, "2 Chat (nav off)");
  assert.equal(ov.objects.activeMat.color.getHex(), RO.ROUTE_OVERLAY_COLORS.disabled);
  ov.setRoute({ ...route, activeIndex: 1, finished: true });
  assert.equal(ov.stats().active.shown, false);
  assert.equal(ov.objects.activeGroup.visible, false);
  // an unchanged state re-feed does nothing at all
  const applies = ov.stats().markerApplies;
  ov.setRoute({ ...route, activeIndex: 1, finished: true });
  assert.equal(ov.stats().markerApplies, applies);
  assert.equal(ov.stats().rebuilds, 1);
  assert.ok(canvasCalls.some((c) => c[0] === "fillText" && c[1] === "2 Chat"), "label drawn");
});

await check("a route change rebuilds once and disposes the old buffers (add a point, reverse, move one z)", () => {
  const { entitiesGroup } = makeScene();
  const ov = RO.createRouteOverlay({ THREE, parent: entitiesGroup, opts: { labels: false } });
  const r = square(RO.NAV_ROUTE.Once);
  ov.setRoute(r);
  ov.setVisible(true);
  const old = ov.objects.lines.geometry;
  const oldMesh = ov.objects.ribbons.geometry;
  const gone = [];
  old.addEventListener("dispose", () => gone.push("line"));
  oldMesh.addEventListener("dispose", () => gone.push("mesh"));
  ov.setRoute({ ...r, points: [...r.points, at(0, -10, 10)] });
  let st = ov.stats();
  assert.equal(st.rebuilds, 2);
  assert.notEqual(ov.objects.lines.geometry, old);
  assert.deepEqual(gone.sort(), ["line", "mesh"]);
  assert.equal(st.counts.rings, 5);
  ov.setRoute({ ...r, points: r.points.slice().reverse() });
  assert.equal(ov.stats().rebuilds, 3);
  const z = deepClone(r);
  z.points[1].z += 0.01;
  ov.setRoute(z);
  assert.equal(ov.stats().rebuilds, 4);
  ov.setRoute(deepClone(z));
  assert.equal(ov.stats().rebuilds, 4, "an equal clone is not a change");
  ov.setRoute(null);
  st = ov.stats();
  assert.equal(st.rebuilds, 5);
  assert.deepEqual([ov.objects.lines.visible, ov.objects.ribbons.visible, ov.objects.activeGroup.visible], [false, false, false]);
});

console.log("\n— lifecycle, render state");

await check("nothing is constructed or attached before setVisible(true); hide detaches, show re-attaches without a rebuild", () => {
  let constructed = 0;
  const TP = new Proxy(THREE, {
    get(t, k) {
      const v = t[k];
      if (typeof v === "function" && /^[A-Z]/.test(String(k))) {
        return new Proxy(v, {
          construct(c, args, nt) {
            constructed += 1;
            return Reflect.construct(c, args, nt === undefined ? c : c);
          },
        });
      }
      return v;
    },
  });
  const parent = new THREE.Group();
  const ov = RO.createRouteOverlay({ THREE: TP, parent, opts: { labels: false } });
  ov.setRoute(mixed());
  ov.setPlayer({ x: 1, y: 2, z: 3 });
  ov.update(16);
  ov.setOptions({ navLineThickness: 3, xray: false });
  assert.equal(constructed, 0, "no THREE object yet");
  assert.equal(parent.children.length, 0);
  assert.equal(ov.root, null);
  assert.equal(ov.stats().built, false);
  assert.equal(ov.stats().drawCalls, 0);
  ov.setVisible(true);
  assert.ok(constructed > 0);
  assert.deepEqual(parent.children, [ov.root]);
  assert.equal(ov.options.lineWidthM, 3 * RO.NAV_THICKNESS_M);
  assert.equal(ov.objects.xray.visible, false, "xray:false honoured");
  ov.setVisible(false);
  assert.equal(parent.children.length, 0);
  assert.equal(ov.stats().drawCalls, 0);
  const n = constructed;
  ov.setVisible(true);
  assert.equal(parent.children.length, 1);
  assert.equal(constructed, n, "re-show allocates nothing");
  assert.equal(ov.stats().rebuilds, 1);
  // no parent → cannot show
  const lonely = RO.createRouteOverlay({ THREE, opts: { labels: false } });
  lonely.setVisible(true);
  assert.equal(lonely.visible, false);
  assert.throws(() => RO.createRouteOverlay({}), /THREE is required/);
});

await check("dispose releases every geometry / material / label texture and detaches; later calls are no-ops", () => {
  const { entitiesGroup } = makeScene();
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  const ov = RO.createRouteOverlay({ THREE, parent: entitiesGroup, opts: { createCanvas: (w, h) => ({ width: w, height: h, getContext: () => ctx }) } });
  ov.setRoute(mixed(RO.NAV_ROUTE.Circular, 0));
  ov.setVisible(true);
  const O = ov.objects;
  const label = O.activeGroup.children.find((c) => c.isSprite);
  assert.ok(label, "label sprite built");
  const things = [O.lineGeom, O.meshGeom, O.activeGeom, O.playerGeom, O.emptyGeom, O.lineMat, O.xrayMat, O.ribbonMat, O.activeMat, O.playerMat, label.material, label.material.map];
  assert.ok(things.every(Boolean));
  const fired = new Set();
  things.forEach((t, i) => t.addEventListener("dispose", () => fired.add(i)));
  ov.dispose();
  assert.equal(fired.size, things.length, `disposed ${fired.size}/${things.length}`);
  assert.equal(entitiesGroup.children.length, 0);
  assert.equal(ov.stats().disposed, true);
  assert.equal(ov.root, null);
  ov.setRoute(mixed());
  ov.setVisible(true);
  ov.update(1);
  ov.setOptions({ ringRadiusM: 2 });
  ov.dispose();
  assert.equal(entitiesGroup.children.length, 0);
});

await check("render state: layer 1, no raycast hits, no shadows, renderOrder x-ray < path < marker < 0, depth test only on the path", () => {
  const { scene, entitiesGroup } = makeScene();
  const ov = RO.createRouteOverlay({ THREE, parent: entitiesGroup, opts: { labels: false } });
  ov.setRoute(mixed(RO.NAV_ROUTE.Circular, 0));
  ov.setPlayer(RO.navToAcWorld(BASE.ew + 3 / 240, BASE.ns + 4 / 240, BASE.z));
  ov.setVisible(true);
  scene.updateMatrixWorld(true);
  const O = ov.objects;
  const drawn = [O.xray, O.lines, O.ribbons, O.activeMesh, O.playerLine];
  for (const o of drawn) {
    assert.equal(o.layers.mask, 1 << 1, `${o.name} on layer 1`);
    assert.equal(o.castShadow, false);
  }
  assert.ok(O.xray.renderOrder < O.lines.renderOrder);
  assert.equal(O.lines.renderOrder, O.ribbons.renderOrder);
  assert.ok(O.activeMesh.renderOrder > O.lines.renderOrder && O.activeMesh.renderOrder < 0);
  assert.deepEqual(
    [O.xrayMat.depthTest, O.lineMat.depthTest, O.ribbonMat.depthTest, O.activeMat.depthTest, O.playerMat.depthTest],
    [false, true, true, false, false],
  );
  for (const m of [O.xrayMat, O.lineMat, O.ribbonMat, O.activeMat, O.playerMat]) {
    assert.equal(m.transparent, true);
    assert.equal(m.depthWrite, false);
    assert.equal(m.fog, false);
    assert.equal(m.vertexColors, true);
    assert.equal(m.toneMapped, false);
    assert.equal(m.onBeforeCompile, THREE.Material.prototype.onBeforeCompile, "no shader patch");
    assert.equal(m.customProgramCacheKey, THREE.Material.prototype.customProgramCacheKey);
  }
  assert.ok(O.lineMat.isLineBasicMaterial && O.xrayMat.isLineBasicMaterial && O.playerMat.isLineBasicMaterial);
  assert.ok(O.ribbonMat.isMeshBasicMaterial && O.activeMat.isMeshBasicMaterial);
  assert.equal(O.ribbonMat.forceSinglePass, true, "DoubleSide+transparent would be 2 draws");
  assert.equal(O.activeMat.forceSinglePass, true);
  assert.equal(O.xray.frustumCulled, false);
  assert.equal(O.lines.frustumCulled, false);
  assert.equal(O.xray.geometry, O.lines.geometry, "x-ray shares the line buffer");
  const st = ov.stats();
  assert.equal(st.drawCalls, 5, "x-ray, lines, ribbons, marker, player line");
  // a ray straight down through waypoint #0 with every layer on: nothing to pick
  const p0 = anchorOf(ov.geometry, 0);
  const rc = new THREE.Raycaster(new THREE.Vector3(p0.x + 1, p0.z + 50, -p0.y), new THREE.Vector3(0, -1, 0));
  rc.layers.enableAll();
  rc.params.Line.threshold = 5;
  assert.deepEqual(rc.intersectObject(ov.root, true), []);
});

await check("per-frame update: player line from the feet to the current waypoint, uploads only on movement, hides near / far; pulse", () => {
  const { entitiesGroup } = makeScene();
  const feet = { x: 0, y: 0, z: 0, ok: true };
  const ov = RO.createRouteOverlay({
    THREE,
    parent: entitiesGroup,
    opts: { labels: false, getPlayer: (out) => ((out.x = feet.x), (out.y = feet.y), (out.z = feet.z), feet.ok) },
  });
  ov.setRoute(square(RO.NAV_ROUTE.Circular, 1));
  ov.setVisible(true);
  const a = ov.stats().active;
  Object.assign(feet, { x: a.x - 3, y: a.y - 4, z: a.z + 0.5 });
  ov.update(1000);
  const attr = ov.objects.playerGeom.attributes.position;
  assert.equal(ov.objects.playerLine.visible, true);
  assert.deepEqual([...attr.array].map((v) => Math.round(v * 1e4) / 1e4), [-3, -4, 0.65, 0, 0, 0.12]);
  const ver = attr.version;
  ov.update(1016);
  assert.equal(attr.version, ver, "standing still: no upload");
  feet.x += 1;
  ov.update(1032);
  assert.equal(attr.version, ver + 1);
  Object.assign(feet, { x: a.x + 0.2, y: a.y + 0.2 });
  ov.update(1048);
  assert.equal(ov.objects.playerLine.visible, false, "on the waypoint");
  Object.assign(feet, { x: a.x + 500, y: a.y });
  ov.update(1064);
  assert.equal(ov.objects.playerLine.visible, false, "beyond playerLineMaxM");
  feet.ok = false;
  ov.update(1080);
  assert.equal(ov.objects.playerLine.visible, false, "no pose");
  // pulse stays in [0.7, 1]·activeOpacity and moves
  ov.update(0);
  const o0 = ov.objects.activeMat.opacity;
  ov.update(300);
  const o1 = ov.objects.activeMat.opacity;
  assert.ok(o0 >= 0.7 * 0.9 - 1e-9 && o0 <= 0.9 + 1e-9 && o1 >= 0.7 * 0.9 - 1e-9 && o1 <= 0.9 + 1e-9);
  assert.notEqual(o0, o1);
  // the onBeforeRender driver: once per renderer frame, whichever line draws first
  const before = ov.stats().updates;
  const r7 = { info: { render: { frame: 7 } } };
  ov.objects.xray.onBeforeRender(r7);
  ov.objects.lines.onBeforeRender(r7);
  assert.equal(ov.stats().updates, before + 1);
  ov.objects.lines.onBeforeRender({ info: { render: { frame: 8 } } });
  assert.equal(ov.stats().updates, before + 2);
  ov.setOptions({ autoUpdate: false });
  ov.objects.lines.onBeforeRender({ info: { render: { frame: 9 } } });
  assert.equal(ov.stats().updates, before + 2, "autoUpdate:false");
  // push mode (no getPlayer): setPlayer applies at once
  const ov2 = RO.createRouteOverlay({ THREE, parent: entitiesGroup, opts: { labels: false } });
  ov2.setRoute(square(RO.NAV_ROUTE.Circular, 1));
  ov2.setVisible(true);
  ov2.setPlayer({ x: a.x + 6, y: a.y, z: a.z });
  assert.equal(ov2.objects.playerLine.visible, true);
  ov2.setPlayer(null);
  assert.equal(ov2.objects.playerLine.visible, false);
});

await check("thickness: VTank 1..16 → 0.02 m steps; 0 drops the ribbons; the leg ribbon is ±w/2 across, the fin ±w/2 up", () => {
  near(RO.thicknessToWidthM(6), 0.12, 1e-12);
  near(RO.thicknessToWidthM(1), 0.02, 1e-12);
  near(RO.thicknessToWidthM(16), 0.32, 1e-12);
  near(RO.thicknessToWidthM(99), 0.32, 1e-12);
  assert.equal(RO.thicknessToWidthM(0), 0);
  assert.equal(RO.thicknessToWidthM("x"), 0);
  assert.equal(RO.thicknessToWidthM(null), 0);
  const two = { routeType: 4, points: [at(0, 0, 0), at(0, 10, 0)] };
  const g = RO.buildRouteGeometry(two, { navLineThickness: 10 });
  const w = 0.2;
  const P = g.mesh.positions;
  const y0 = (n) => P[n * 3 + 1];
  const z0 = (n) => P[n * 3 + 2];
  near(y0(0) - y0(1), w, 1e-5, "flat strip across the leg (east → ±y)");
  near(z0(5) - z0(4), w, 1e-5, "vertical fin");
  const noLegs = RO.buildRouteGeometry(two, { navLineThickness: 0 });
  assert.equal(noLegs.mesh.vertexCount, 2 * 96, "rings only");
  const none = RO.buildRouteGeometry(two, { navLineThickness: 0, navRingThickness: 0 });
  assert.equal(none.mesh.indexCount, 0);
  assert.ok(none.line.vertexCount > 0, "1 px lines remain");
  // later metre width beats an earlier VT value (and vice versa)
  const m1 = RO.mergeRouteOverlayOptions({ navLineThickness: 6 }, { lineWidthM: 0.3 });
  assert.equal(RO.resolveRouteOverlayOptions(m1).lineWidthM, 0.3);
  const m2 = RO.mergeRouteOverlayOptions({ lineWidthM: 0.3 }, { navLineThickness: 2 });
  near(RO.resolveRouteOverlayOptions(m2).lineWidthM, 0.04, 1e-12);
  // live: setOptions rebuilds the route and the marker geometry
  const { entitiesGroup } = makeScene();
  const ov = RO.createRouteOverlay({ THREE, parent: entitiesGroup, opts: { labels: false } });
  ov.setRoute(two);
  ov.setVisible(true);
  const marker = ov.objects.activeGeom;
  ov.setOptions({ navRingThickness: 12, navLineThickness: 1 });
  assert.equal(ov.stats().rebuilds, 2);
  assert.notEqual(ov.objects.activeGeom, marker);
  ov.setOptions({ xrayOpacity: 0.5 });
  assert.equal(ov.stats().rebuilds, 2, "opacity is a uniform");
  assert.equal(ov.objects.xrayMat.opacity, 0.5);
});

await check("live options: labels on / off after creation, renderOrder and layer re-applied to built objects", () => {
  const { entitiesGroup } = makeScene();
  const texts = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === "fillText" ? (t) => texts.push(t) : () => {}), set: () => true });
  const ov = RO.createRouteOverlay({
    THREE,
    parent: entitiesGroup,
    opts: { labels: false, createCanvas: (w, h) => ({ width: w, height: h, getContext: () => ctx }) },
  });
  ov.setRoute(square(RO.NAV_ROUTE.Circular, 2));
  ov.setVisible(true);
  const sprite = () => ov.objects.activeGroup.children.find((c) => c.isSprite);
  assert.equal(sprite(), undefined, "labels:false builds no sprite");
  assert.equal(ov.stats().drawCalls, 4);
  ov.setOptions({ labels: true });
  assert.ok(sprite(), "turned on later → built");
  assert.deepEqual(texts, ["3"]);
  assert.equal(sprite().renderOrder, 9);
  assert.equal(sprite().layers.mask, 1 << 1);
  assert.equal(ov.stats().drawCalls, 5);
  ov.setOptions({ labels: false });
  assert.equal(sprite().visible, false);
  assert.equal(ov.stats().drawCalls, 4);
  ov.setOptions({ renderOrder: -40, layer: 2, labels: true });
  const O = ov.objects;
  assert.deepEqual([O.xray.renderOrder, O.lines.renderOrder, O.ribbons.renderOrder, O.activeMesh.renderOrder, O.playerLine.renderOrder], [-40, -39, -39, -38, -38]);
  for (const ob of [O.xray, O.lines, O.ribbons, O.activeMesh, O.playerLine, sprite()]) assert.equal(ob.layers.mask, 1 << 2);
  assert.equal(sprite().visible, true);
  assert.equal(ov.stats().rebuilds, 1, "none of these rebuild buffers");
});

console.log("\n— page attach (installRouteOverlay)");

await check("install → poll for the scene → attach, follow the nav, survive a scene swap, manual feed, hide, dispose", async () => {
  const timers = {
    n: 0,
    fns: new Map(),
    setInterval(fn) {
      this.n += 1;
      this.fns.set(this.n, fn);
      return this.n;
    },
    clearInterval(id) {
      this.fns.delete(id);
    },
    fire() {
      for (const fn of [...this.fns.values()]) fn();
    },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let imports = 0;
  const win = {};
  const h = RO.installRouteOverlay({
    win,
    timers,
    importThree: () => {
      imports += 1;
      return Promise.resolve(THREE);
    },
    opts: { labels: false },
  });
  assert.equal(win.__rynthRouteOverlay, h);
  assert.equal(RO.installRouteOverlay({ win, timers }), h, "idempotent");
  assert.equal(timers.fns.size, 0, "no timer before setVisible(true)");
  assert.equal(h.status().polling, false);
  assert.equal(imports, 0);

  h.setVisible(true);
  assert.equal(timers.fns.size, 1);
  assert.equal(h.status().attached, false, "no scene yet");
  assert.equal(imports, 0, "three is loaded only once a scene exists");

  // the scene lands (~35 s after login in the real client), with a bot route
  const eg1 = new THREE.Group();
  let navRoute = mixed(RO.NAV_ROUTE.Circular, 0);
  const nav = {
    enabled: true,
    route: () => deepClone(navRoute),
  };
  win.__bot = { vt: { nav } };
  const pose = { x: 0, y: 0, z: 0 };
  win.liveScene3d = { entitiesGroup: eg1, cameraSwitcher: { predictedPlayerPos: pose } };
  timers.fire();
  await flush();
  assert.equal(imports, 1);
  let st = h.status();
  assert.equal(st.attached, true);
  assert.equal(st.source, "auto");
  assert.deepEqual(eg1.children, [h.overlay.root]);
  assert.equal(st.overlay.points, 9);
  assert.equal(st.overlay.rebuilds, 1);

  // the bot advances (a new clone each poll): marker only
  navRoute = { ...navRoute, activeIndex: 4 };
  timers.fire();
  st = h.status();
  assert.equal(st.overlay.rebuilds, 1);
  assert.equal(st.overlay.active.index, 4);
  // the player's feet come from the camera switcher's integrator pose
  const a4 = st.overlay.active;
  Object.assign(pose, { x: a4.x + 6, y: a4.y + 8, z: a4.z });
  h.overlay.update(5);
  assert.equal(h.overlay.objects.playerLine.visible, true);
  assert.deepEqual([...h.overlay.objects.playerGeom.attributes.position.array.slice(0, 2)], [6, 8]);
  // nav off → grey marker
  nav.enabled = false;
  timers.fire();
  assert.equal(h.status().overlay.active.state, "disabled");
  nav.enabled = true;
  // a waypoint is added: one rebuild
  navRoute = { ...navRoute, points: [...navRoute.points, at(0, 3, -8)] };
  timers.fire();
  assert.equal(h.status().overlay.rebuilds, 2);

  // relog / scene re-init: a new liveScene3d + entitiesGroup
  const eg2 = new THREE.Group();
  win.liveScene3d = { entitiesGroup: eg2, cameraSwitcher: { predictedPlayerPos: pose } };
  timers.fire();
  st = h.status();
  assert.equal(eg1.children.length, 0, "old scene released");
  assert.deepEqual(eg2.children, [h.overlay.root]);
  assert.equal(st.attaches, 2);
  assert.equal(imports, 1, "three imported once");

  // manual feed wins until setSource("auto")
  h.setRoute(square(RO.NAV_ROUTE.Linear, 2));
  timers.fire();
  st = h.status();
  assert.equal(st.source, "manual");
  assert.equal(st.overlay.points, 4);
  h.setSource("auto");
  assert.equal(h.status().overlay.points, 10);
  h.setSource(() => square(RO.NAV_ROUTE.Once, 0));
  assert.equal(h.status().overlay.points, 4);
  h.setSource(() => {
    throw new Error("feed broke");
  });
  assert.equal(h.status().overlay.points, 0);
  assert.match(h.status().lastError, /feed broke/);
  h.setSource("auto");

  // options flow through (VTank names)
  h.setOptions({ navLineThickness: 1, navRingThickness: 9 });
  near(h.overlay.options.lineWidthM, 0.02, 1e-12);
  near(h.overlay.options.ringWidthM, 0.18, 1e-12);

  // hide: timer stopped, detached; show: re-attached, nothing rebuilt
  const rebuilds = h.status().overlay.rebuilds;
  h.setVisible(false);
  assert.equal(timers.fns.size, 0);
  assert.equal(eg2.children.length, 0);
  h.toggle();
  assert.equal(timers.fns.size, 1);
  assert.equal(eg2.children.length, 1);
  assert.equal(h.status().overlay.rebuilds, rebuilds);

  // the scene goes away: overlay released, polling continues
  win.liveScene3d = null;
  timers.fire();
  assert.equal(h.status().attached, false);
  assert.equal(eg2.children.length, 0);

  h.dispose();
  assert.equal(timers.fns.size, 0);
  assert.equal(win.__rynthRouteOverlay, undefined);
  assert.equal(h.setVisible(true), false);
});

await check("vtNavRouteSource / readPlayerFeet: absent or throwing sources read as null / false", () => {
  assert.equal(RO.vtNavRouteSource({}), null);
  assert.equal(RO.vtNavRouteSource({ __bot: { vt: { nav: { route: () => { throw new Error("x"); } } } } }), null);
  const r = RO.vtNavRouteSource({ __bot: { vt: { nav: { route: () => ({ points: [], activeIndex: 0, routeType: 2, paused: null }), enabled: true } } } });
  assert.deepEqual(r, { points: [], activeIndex: 0, routeType: 2, reversed: false, finished: false, paused: false, enabled: true });
  const out = { x: 0, y: 0, z: 0 };
  assert.equal(RO.readPlayerFeet({}, out), false);
  assert.equal(RO.readPlayerFeet({ liveScene3d: { entityManager: { getLocalPlayerWorldPos: () => ({ x: 1, y: 2, z: 3 }) } } }, out), true);
  assert.deepEqual(out, { x: 1, y: 2, z: 3 });
  assert.equal(RO.readPlayerFeet({ liveScene3d: { cameraSwitcher: { predictedPlayerPos: { x: NaN, y: 0, z: 0 } } } }, out), false);
  assert.equal(RO.installRouteOverlay({ win: null }), null);
});

console.log(`\nroute_overlay: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
