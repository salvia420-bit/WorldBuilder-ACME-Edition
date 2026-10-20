// tests/bulk_child_remove.test.mjs
//
// 2026-10-20 (improvement hunt A3 / open-frontier-perf-2 step 1)
// `?bulkChildRemove` (DEFAULT ON, `=off|0|false` escape). LandblockLRU evict
// and park detach an LB's terrain / buildings / statics children with ONE
// order-preserving compaction pass (scene3d/bulk_child_remove.js
// `removeChildrenBulk`) instead of three's per-child `remove()` (indexOf +
// splice → O(k·n); ~14k frozen static-script anchors are direct staticsGroup
// children at Linvak).
//
// The claim is EXACT identity with repeated three r184 Object3D.remove():
//   R1  helper vs repeated remove() on twin real three Groups, with listeners
//       on every child ('removed') and the parent ('childremoved'): identical
//       surviving children + order, `children` array identity kept, identical
//       parent field on every object, identical event sequence (type, target,
//       child, child.parent at dispatch, membership at dispatch), the event
//       objects' target/child cleared afterwards, same removed count — for
//       front / middle / interleaved / shuffled-kill-order / Set kills, kills
//       carrying duplicates, null, detached and foreign-parented entries, the
//       whole group, and both sides of BULK_CHILD_REMOVE_MIN_KILL.
//   R2  scale: 14,210 children in 290-child LB runs (Linvak-class), remove the
//       oldest / a middle / an interleaved LB — identical results, no
//       listeners attached.
//   R3  fallbacks: a non-Object3D stub group gets its own remove() once per
//       kill entry in kill order; an instance-patched remove() keeps seeing
//       every call; failSoft isolates a throwing listener per child.
//   R4  LandblockLRU integration, `?bulkChildRemove` ON vs `=off` module arms
//       on identical real-three fixtures: non-bucket evict, non-bucket park,
//       bucketed evict + park, unpark — identical group children order,
//       parent fields, park stash order and event logs; flag grammar; the
//       getStats() telemetry.
//   R5  micro-bench (printed, not asserted — V8's splice is bimodal at this
//       size): per-LB removal at 14,210 / 23,490 children, oldest LB first.
//
// Run: node tests/bulk_child_remove.test.mjs

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

globalThis.window ??= {};
window.location ??= { search: "" };
globalThis.location ??= window.location;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;

const THREE = await import("three");
const { removeChildrenBulk, BULK_CHILD_REMOVE_MIN_KILL } = await import(v("scene3d/bulk_child_remove.js"));

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eqArr = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const firstDiff = (a, b) => {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `@${i}: ${a[i]} vs ${b[i]}`;
  return "";
};

// ---------------------------------------------------------------------------
// Twin fixtures: identical graphs built twice, objects addressed by name.
// ---------------------------------------------------------------------------
function makeTwin(n, { listeners = false } = {}) {
  const group = new THREE.Group();
  group.name = "G";
  const kids = [];
  for (let i = 0; i < n; i++) {
    const o = i % 3 === 0 ? new THREE.Mesh() : new THREE.Object3D();
    o.name = `c${i}`;
    kids.push(o);
    group.add(o);
  }
  const other = new THREE.Group();
  other.name = "OTHER";
  const foreign = new THREE.Object3D();
  foreign.name = "foreign";
  other.add(foreign);
  const detached = new THREE.Object3D();
  detached.name = "detached";
  const log = [];
  const evts = [];
  if (listeners) {
    for (const o of kids) {
      o.addEventListener("removed", function (e) {
        evts.push(e);
        log.push(`removed|${e.target.name}|parentNull=${this.parent === null}|inGroup=${group.children.includes(this)}`);
      });
    }
    group.addEventListener("childremoved", function (e) {
      evts.push(e);
      log.push(`childremoved|${e.target.name}|child=${e.child?.name}|childParentNull=${e.child?.parent === null}|inGroup=${group.children.includes(e.child)}`);
    });
  }
  const all = [group, other, foreign, detached, ...kids];
  const byName = new Map(all.map((o) => [o.name, o]));
  return { group, kids, other, foreign, detached, log, evts, all, byName };
}
const childNames = (g) => g.children.map((c) => c.name);
const parentMap = (t) => t.all.map((o) => `${o.name}->${o.parent ? o.parent.name : "null"}`);
// Kill spec = list of names (or null) resolved in each twin.
const resolve = (t, spec) => spec.map((nm) => (nm === null ? null : t.byName.get(nm)));

function runCase(label, n, spec, { asSet = false, listeners = true } = {}) {
  const A = makeTwin(n, { listeners });
  const B = makeTwin(n, { listeners });
  const killA = resolve(A, spec);
  const killB = asSet ? new Set(resolve(B, spec)) : resolve(B, spec);
  const beforeA = A.group.children.length;
  // Reference: three r184's own remove(), one call per entry, in kill order.
  // (A Set kill iterates in insertion order, so dedup is the same order.)
  for (const c of (asSet ? new Set(killA) : killA)) A.group.remove(c);
  const removedA = beforeA - A.group.children.length;
  const arrB = B.group.children;
  const ret = removeChildrenBulk(B.group, killB);
  const nameA = childNames(A.group), nameB = childNames(B.group);
  const pA = parentMap(A), pB = parentMap(B);
  const ok =
    eqArr(nameA, nameB) &&
    B.group.children === arrB &&
    eqArr(pA, pB) &&
    eqArr(A.log, B.log) &&
    ret === removedA &&
    B.evts.every((e) => e.target === null && (e.type !== "childremoved" || e.child === null)) &&
    A.evts.every((e) => e.target === null && (e.type !== "childremoved" || e.child === null));
  check(`${label} (n=${n}, kill=${spec.length}, removed=${removedA}, events=${B.log.length})`, ok,
    !eqArr(nameA, nameB) ? `children ${firstDiff(nameA, nameB)}`
      : B.group.children !== arrB ? "children array identity changed"
      : !eqArr(pA, pB) ? `parents ${firstDiff(pA, pB)}`
      : !eqArr(A.log, B.log) ? `events ${firstDiff(A.log, B.log)}`
      : ret !== removedA ? `returned ${ret}, three removed ${removedA}`
      : "event target/child not cleared");
}

const range = (a, b) => Array.from({ length: b - a }, (_, i) => `c${a + i}`);
function shuffled(arr, seed) {
  const out = arr.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

console.log("bulkChildRemove — removeChildrenBulk vs three r184 Object3D.remove()");
console.log(`  (BULK_CHILD_REMOVE_MIN_KILL = ${BULK_CHILD_REMOVE_MIN_KILL})`);

console.log("R1 exact identity incl. events");
runCase("R1a front LB run, children order", 600, range(0, 290));
runCase("R1b middle LB run", 600, range(200, 490));
runCase("R1c tail LB run", 600, range(310, 600));
runCase("R1d interleaved (every 3rd)", 600, Array.from({ length: 200 }, (_, i) => `c${i * 3}`));
runCase("R1e shuffled kill order (events follow KILL order)", 600, shuffled(range(50, 350), 7));
runCase("R1f Set kill", 600, shuffled(range(100, 250), 11), { asSet: true });
const ODD = ["c5", "c9", null, "c5", "detached", "foreign", "c9", "c100", "c101", "c299", "c0", "c0", "c150"];
runCase("R1g duplicates + null + detached + foreign-parented entries (bulk)", 300,
  [...ODD, ...shuffled(range(200, 230), 13), "c201", null, "foreign"]);
runCase("R1g' same odd entries, short kill (three's loop)", 300, ODD);
runCase("R1h whole group (clear)", 257, shuffled(range(0, 257), 3));
runCase("R1i nothing removable (all foreign/detached, bulk-sized)", 50,
  Array.from({ length: 24 }, (_, i) => ["foreign", "detached", null][i % 3]));
for (const k of [0, 1, 2, BULK_CHILD_REMOVE_MIN_KILL - 1, BULK_CHILD_REMOVE_MIN_KILL, BULK_CHILD_REMOVE_MIN_KILL + 1, 64]) {
  runCase(`R1j threshold side k=${k}${k >= BULK_CHILD_REMOVE_MIN_KILL ? " (bulk)" : " (three's loop)"}`, 400, shuffled(range(10, 10 + k), k + 1));
}

// A child listed twice in `children` (only reachable by a direct push — add()
// re-parents) loses one slot per kill entry, as one remove() call would.
{
  const mk = () => {
    const g = new THREE.Group();
    const xs = [];
    for (let i = 0; i < 20; i++) { const o = new THREE.Object3D(); o.name = `d${i}`; g.add(o); xs.push(o); }
    g.children.push(xs[4]); // duplicate slot at the tail
    return { g, xs };
  };
  const a = mk(), b = mk();
  const killIdx = [4, 1, 2, 3, 5, 6, 7, 8, 9];
  for (const i of killIdx) a.g.remove(a.xs[i]);
  removeChildrenBulk(b.g, killIdx.map((i) => b.xs[i]));
  check("R1k duplicate child slot: one occurrence removed, like three",
    eqArr(childNames(a.g), childNames(b.g)) && a.xs[4].parent === null && b.xs[4].parent === null,
    `${childNames(a.g).join(",")} vs ${childNames(b.g).join(",")}`);
}

console.log("R2 scale (Linvak-class staticsGroup, no listeners)");
{
  const N = 14210, RUN = 290;
  const lbRun = (l) => range(l * RUN, (l + 1) * RUN);
  runCase("R2a oldest LB (front)", N, lbRun(0), { listeners: false });
  runCase("R2b middle LB", N, lbRun(24), { listeners: false });
  runCase("R2c interleaved LB (every 49th child)", N, Array.from({ length: RUN }, (_, i) => `c${i * 49 + 3}`), { listeners: false });
  runCase("R2d with listeners", N, shuffled(lbRun(10), 5), { listeners: true });
}

console.log("R3 fallbacks + failSoft");
{
  // Non-Object3D stub (the LRU suites' recording groups): its own remove(),
  // once per entry, in kill order — even for a large kill.
  const calls = [];
  const stub = { children: [], remove(c) { calls.push(c); } };
  const kill = Array.from({ length: 40 }, (_, i) => ({ id: i }));
  removeChildrenBulk(stub, kill);
  check("R3a stub group: remove() called per entry in kill order", calls.length === 40 && calls.every((c, i) => c === kill[i]));

  // Instance-patched remove (instrumentation) keeps seeing every call.
  const t = makeTwin(100);
  const ref = makeTwin(100);
  let seen = 0;
  const orig = t.group.remove.bind(t.group);
  t.group.remove = (c) => { seen++; return orig(c); };
  const spec = shuffled(range(0, 60), 9);
  removeChildrenBulk(t.group, resolve(t, spec));
  for (const c of resolve(ref, spec)) ref.group.remove(c);
  check("R3b instance-patched remove(): per-call path, same result", seen === 60 && eqArr(childNames(t.group), childNames(ref.group)));

  // failSoft: a throwing 'removed' listener on one child.
  const f = makeTwin(50, { listeners: true });
  f.byName.get("c20").addEventListener("removed", () => { throw new Error("boom"); });
  let threw = false;
  try { removeChildrenBulk(f.group, resolve(f, range(10, 30)), true); } catch (_) { threw = true; }
  const gone = range(10, 30).every((nm) => f.byName.get(nm).parent === null && !f.group.children.includes(f.byName.get(nm)));
  const childremoved = f.log.filter((l) => l.startsWith("childremoved")).length;
  check("R3c failSoft: no throw, all 20 removed, the throwing child's pair is the only one cut short",
    !threw && gone && childremoved === 19 && f.group.children.length === 30, `threw=${threw} gone=${gone} childremoved=${childremoved}`);
  const g2 = makeTwin(50);
  g2.byName.get("c20").addEventListener("removed", () => { throw new Error("boom"); });
  let threw2 = false;
  try { removeChildrenBulk(g2.group, resolve(g2, range(10, 30))); } catch (_) { threw2 = true; }
  check("R3d failSoft=false: a listener throw propagates (as three's loop would)", threw2);
}

// ---------------------------------------------------------------------------
// R4 LandblockLRU integration — ON vs OFF module arms on identical fixtures.
// ---------------------------------------------------------------------------
console.log("R4 LandblockLRU evict / park / unpark, ?bulkChildRemove ON vs =off");
async function importArm(search, tag) {
  window.location.search = search;
  const m = await import(`${v("scene3d/landblock_lru.js")}?arm=${tag}`);
  window.location.search = "";
  return m;
}
const ON = await importArm("", "on");
const OFF = await importArm("?bulkChildRemove=off", "off");

// Deterministic Linvak-ish fixture: 6 LBs, each with 2 terrain meshes (main +
// wire companion), 6 building placements, 40 statics (singletons + frozen
// anchors), plus LB-less ring InstancedMesh nodes that must survive. Children
// are interleaved across LBs the way staggered bakes leave them.
function makeWorld(M) {
  const lbs = [[0x40, 0x41], [0x41, 0x41], [0x42, 0x41], [0x40, 0x42], [0x41, 0x42], [0x42, 0x42]];
  const keys = lbs.map(([x, y]) => M.lbKeyFromXY(x, y));
  const terrainGroup = new THREE.Group(); terrainGroup.name = "terrain";
  const buildingsGroup = new THREE.Group(); buildingsGroup.name = "buildings";
  const staticsGroup = new THREE.Group(); staticsGroup.name = "statics";
  const cellsGroup = new THREE.Group(); cellsGroup.name = "cells";
  const log = [];
  const all = [terrainGroup, buildingsGroup, staticsGroup];
  const listen = (o) => {
    o.addEventListener("removed", function (e) { log.push(`removed|${e.target.name}|${this.parent === null}`); });
  };
  for (const g of [terrainGroup, buildingsGroup, staticsGroup]) {
    g.addEventListener("childremoved", (e) => log.push(`childremoved|${e.target.name}|${e.child.name}|${e.child.parent === null}`));
  }
  const mk = (name, ud, cls = THREE.Object3D) => {
    const o = new cls(); o.name = name; o.userData = ud; listen(o); all.push(o); return o;
  };
  for (let pass = 0; pass < 2; pass++) {
    lbs.forEach(([x, y], li) => {
      terrainGroup.add(mk(`t${li}.${pass}`, { lbX: x, lbY: y }, THREE.Mesh));
    });
  }
  for (let i = 0; i < 6; i++) {
    lbs.forEach(([x, y], li) => {
      const lbid = ((x << 24) | (y << 16) | (0x0100 + i)) >>> 0;
      buildingsGroup.add(mk(`b${li}.${i}`, { landblockId: lbid, placementKey: `${lbid.toString(16).padStart(8, "0")}:${i}` }, THREE.Group));
    });
  }
  for (let i = 0; i < 40; i++) {
    lbs.forEach(([x, y], li) => {
      const lbid = ((x << 24) | (y << 16) | (0x0001 + i)) >>> 0;
      staticsGroup.add(mk(i % 2 ? `anchor${li}.${i}` : `s${li}.${i}`, { landblockId: lbid }, i % 4 === 0 ? THREE.Mesh : THREE.Object3D));
    });
    if (i % 10 === 0) staticsGroup.add(mk(`ring${i}`, { coversLbKeys: new Set(keys) }));
  }
  const buildingMap3d = new Map(buildingsGroup.children.map((c) => [c.userData.placementKey, c]));
  const scene3d = {
    terrainGroup, buildingsGroup, staticsGroup, cellsGroup,
    cellContainers3d: new Map(), buildingMap3d,
    activeLights: [], terrainMaterials: [],
    terrainBakedLbs: new Set(keys), buildingsBakedLbs: new Set(keys),
    staticsBakedLbs: new Set(keys), envCellLoadedLbs: new Set(),
  };
  const lru = new M.LandblockLRU({ scene3d, maxResident: 64, getCurrentLbId: () => M.lbKeyFromXY(0x10, 0x10) });
  for (const k of keys) lru.track(k);
  return { lru, scene3d, keys, log, all };
}
const snap = (w) => ({
  terrain: childNames(w.scene3d.terrainGroup).join(","),
  buildings: childNames(w.scene3d.buildingsGroup).join(","),
  statics: childNames(w.scene3d.staticsGroup).join(","),
  parents: w.all.map((o) => `${o.name}->${o.parent ? o.parent.name : "null"}`).join(","),
  bmap: [...w.scene3d.buildingMap3d.keys()].join(","),
  log: w.log.join(";"),
  parked: [...w.lru.parkPool.entries()].map(([k, p]) =>
    `${k.toString(16)}:${p.terrain.map((c) => c.name)}|${p.buildings.map((c) => c.name)}|${p.statics.map((c) => c.name)}`).join(";"),
});
function script(w) {
  const out = [];
  const statsArr = w.scene3d.staticsGroup.children;
  w.lru.evict(w.keys[0]);                       // non-bucket evict
  out.push(snap(w));
  w.lru.park(w.keys[1]);                        // non-bucket park
  out.push(snap(w));
  const buckets = w.lru._bucketGroupChildren([w.keys[2], w.keys[3]]);
  w.lru.evict(w.keys[2], buckets);              // bucketed evict
  w.lru.park(w.keys[3], buckets);               // bucketed park
  out.push(snap(w));
  w.lru.unpark(w.keys[1]);                      // re-attach (appends)
  out.push(snap(w));
  w.lru.park(w.keys[1]);                        // park again from the tail
  out.push(snap(w));
  out.sameArray = w.scene3d.staticsGroup.children === statsArr;
  return out;
}
{
  const wOn = makeWorld(ON), wOff = makeWorld(OFF);
  const sOn = script(wOn), sOff = script(wOff);
  const steps = ["evict (scan)", "park (scan)", "bucketed evict + park", "unpark", "re-park"];
  steps.forEach((label, i) => {
    const a = sOn[i], b = sOff[i];
    const fields = Object.keys(a).filter((f) => a[f] !== b[f]);
    check(`R4.${i + 1} ${label}: ON == OFF (children order, parents, events, stash, buildingMap3d)`,
      fields.length === 0, fields.length ? `differs in ${fields.join(",")}` : "");
  });
  // Sanity that the fixture exercised something: the evicted/parked LBs'
  // nodes are gone, the ring nodes and the untouched LBs' nodes remain.
  const last = sOn[4];
  const lbGone = (li) => !new RegExp(`(^|,)(s|anchor)${li}\\.`).test(last.statics);
  check("R4.6 fixture sanity: LBs 0-3 detached, ring + LBs 4-5 intact, events logged",
    lbGone(0) && lbGone(1) && lbGone(2) && lbGone(3) &&
    /(^|,)ring0(,|$)/.test(last.statics) && /(^|,)s4\.0(,|$)/.test(last.statics) && /(^|,)anchor5\.39(,|$)/.test(last.statics) &&
    wOn.log.length > 400,
    `log=${wOn.log.length}`);
  check("R4.7 staticsGroup.children array identity kept through evict/park/unpark (ON arm)", sOn.sameArray === true);
  const stOn = wOn.lru.getStats(), stOff = wOff.lru.getStats();
  check("R4.8 getStats: bulkChildRemove ON/OFF, detach telemetry equal counts on both arms",
    stOn.bulkChildRemove === true && stOff.bulkChildRemove === false &&
    stOn.detachCalls === stOff.detachCalls && stOn.detachCalls > 0 &&
    stOn.detachedChildren === stOff.detachedChildren && stOn.detachedChildren > 200 &&
    Number.isFinite(stOn.detachMsTotal) && stOn.detachMsMax >= 0,
    JSON.stringify({ on: [stOn.bulkChildRemove, stOn.detachCalls, stOn.detachedChildren], off: [stOff.bulkChildRemove, stOff.detachCalls, stOff.detachedChildren] }));
}
{
  // Flag grammar: off / 0 / false disable; absent / on / anything else keep ON.
  const arms = [["?bulkChildRemove=0", false], ["?bulkChildRemove=false", false], ["?bulkChildRemove=on", true], ["?other=1", true]];
  let ok = true; const got = [];
  for (const [search, want] of arms) {
    const M = await importArm(search, `g${encodeURIComponent(search)}`);
    const lru = new M.LandblockLRU({ scene3d: { activeLights: [] }, maxResident: 4, getCurrentLbId: () => 0 });
    const val = lru.getStats().bulkChildRemove;
    got.push(`${search}=${val}`);
    if (val !== want) ok = false;
  }
  check("R4.9 flag grammar (=0/=false off; =on/absent on)", ok, got.join(" "));
}

// ---------------------------------------------------------------------------
// R5 micro-bench (informational).
// ---------------------------------------------------------------------------
// V8's splice is bimodal here: a `children` backing store that ever held more
// than ~16k slots lives in large-object space, which cannot be left-trimmed,
// so every front remove() memmoves the whole array (~25-35 µs). A session's
// staticsGroup shrinks and grows with LB churn, so the "grown" rows are the
// realistic in-session case; "fresh" rows are a group that never grew.
console.log("R5 micro-bench — one 290-child LB, oldest first, re-added at the tail (laptop, informational)");
function bench(n, mode, reps, grow = 0) {
  const g = new THREE.Group();
  for (let i = 0; i < n + grow; i++) g.add(new THREE.Object3D());
  if (grow) for (const c of g.children.slice(n)) g.remove(c);
  const times = [];
  for (let r = 0; r < reps; r++) {
    const kill = g.children.slice(0, 290);
    const t0 = performance.now();
    if (mode === "loop") for (const c of kill) g.remove(c);
    else removeChildrenBulk(g, kill);
    times.push(performance.now() - t0);
    for (const c of kill) g.add(c);
  }
  times.sort((a, b) => a - b);
  return { med: times[times.length >> 1], max: times[times.length - 1] };
}
for (const n of [14210, 23490]) {
  for (const grow of [0, 4000]) {
    bench(n, "loop", 4, grow); bench(n, "bulk", 4, grow);
    const a = bench(n, "loop", 25, grow), b = bench(n, "bulk", 25, grow);
    console.log(`  n=${n} ${grow ? "grown" : "fresh"}: remove() loop median ${a.med.toFixed(2)} ms (max ${a.max.toFixed(2)}), ` +
      `removeChildrenBulk median ${b.med.toFixed(2)} ms (max ${b.max.toFixed(2)}) — ${(a.med / Math.max(b.med, 1e-6)).toFixed(1)}x`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
