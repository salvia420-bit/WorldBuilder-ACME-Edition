// ?statGeomCache (perf T3, GPU half) — headless test for scene3d/static_geom_cache.js.
//
// The module decides when a SHARED statics geometry may be disposed, so the
// properties that matter are about disposal: a leased entry is never disposed,
// an aborted bake's undo never touches another bake's lease, every geometry is
// disposed exactly once, and the byte accounting the trim policy reads cannot
// drift. The last one is checked by a seeded fuzz against a recomputed truth.
//
// Run: cd apps/holtburger-web/ && node test_static_geom_cache.mjs

import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) { return null; }
}
const tp = locateThree();
if (!tp) { console.log("static-geom-cache test: SKIP (three not located)."); process.exit(0); }
const THREE = await import("file://" + tp);
const M = await import("./scene3d/static_geom_cache.js");

console.log("?statGeomCache — shared statics geometry");
console.log("=========================");

const disposed = new Map(); // uuid -> count
function geom(tris = 4) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tris * 9), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(tris * 6), 2));
  g.addEventListener("dispose", () => disposed.set(g.uuid, (disposed.get(g.uuid) || 0) + 1));
  return g;
}
const bytesOf = (tris) => tris * 9 * 4 + tris * 6 * 4;
const groups = (n = 1, tris = 4) => Array.from({ length: n }, (_, i) => ({ geometry: geom(tris), surfaceDid: 0x08000000 + i, doubleSided: false }));
const levels = (tris = 2) => new Map([["1|0", [{ geometry: geom(tris), dist: 50, degradeMode: 0 }]]]);
const timesDisposed = (g) => disposed.get(g.uuid) || 0;

// ---------------------------------------------------------------------------
console.log("\n-- 1. flag reader (default OFF; exact-match `on`) --");
{
  const _l = globalThis.location;
  for (const [search, want, mb] of [
    ["", false, 64], ["?statGeomCache=1", false, 64], ["?statGeomCache=true", false, 64],
    ["?statGeomCache=on", true, 64], ["?statGeomCache=on:128", true, 128], ["?statGeomCache=on:0", true, 64],
  ]) {
    globalThis.location = { search };
    M.__setStatGeomCacheForTest(undefined, 64);
    const got = M.statGeomCacheEnabled();
    check(`1.${search || "(absent)"} -> ${want}, ${mb} MB`, got === want && M.statGeomCacheBudgetMb() === mb,
      `${got} ${M.statGeomCacheBudgetMb()}`);
  }
  if (_l === undefined) delete globalThis.location; else globalThis.location = _l;
  M.__setStatGeomCacheForTest(false, 64);
  M.__resetStaticGeomCacheForTest();
  check("1g: off -> no instance", M.getStaticGeomCache() === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. insert, tag, lease --");
{
  const c = new M.StaticGeomCache({ budgetBytes: 1 << 30 });
  const gs = groups(2, 4);
  const e = c.insert(0x02000001, { groups: gs, surfaceDids: [1, 2], didDegrade: 0 });
  check("2a: geometries tagged __cacheOwned", gs.every((g) => g.geometry.userData.__cacheOwned === true));
  check("2b: bytes counted", e.bytes === 2 * bytesOf(4) && c.bytes === e.bytes, `${e.bytes}`);
  check("2c: a fresh entry starts unowned", c.unowned.has(0x02000001) && c.unownedBytes === e.bytes);
  check("2d: no degrade chain -> resolved (empty Map)", e.degraded instanceof Map && e.degraded.size === 0);
  c.acquire(0x10, 0x02000001);
  check("2e: acquire takes it out of the unowned set", !c.unowned.has(0x02000001) && c.unownedBytes === 0 && e.refs === 1);
  const again = c.insert(0x02000001, { groups: groups(1) });
  check("2f: a second insert returns the existing entry", again === e && e.groups === gs);
  check("2g: lookup hit/miss counted", c.lookup(0x02000001) === e && c.lookup(0x02000002) === null
    && c.stats.hits === 1 && c.stats.misses === 1);
  const empty = c.insert(0x02000003, {});
  check("2h: an empty model is recorded (no groups, no bytes)", empty.groups.length === 0 && empty.bytes === 0
    && c.stats.emptyInserts === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. leased entries are never trimmed --");
{
  const c = new M.StaticGeomCache({ budgetBytes: 0 });
  const g1 = groups(1), g2 = groups(1);
  c.insert(1, { groups: g1 }); c.acquire(0xa, 1);
  c.insert(2, { groups: g2 }); c.acquire(0xb, 2);
  const n = c.trim({ pressure: true });
  check("3a: pressure trim with every entry leased disposes nothing", n === 0 && timesDisposed(g1[0].geometry) === 0);
  c.releaseLb(0xa);
  const n2 = c.trim({ pressure: true });
  check("3b: once released, the entry goes (geometry disposed once)", n2 === 1 && timesDisposed(g1[0].geometry) === 1
    && !c.entries.has(1));
  check("3c: ...and is untagged", g1[0].geometry.userData.__cacheOwned === false);
  check("3d: the still-leased entry survives", c.entries.has(2) && timesDisposed(g2[0].geometry) === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. budget trim: oldest release first, down to the budget --");
{
  const one = bytesOf(4);
  const c = new M.StaticGeomCache({ budgetBytes: 2 * one });
  const gs = [];
  for (let i = 1; i <= 5; i++) { const g = groups(1, 4); gs.push(g); c.insert(i, { groups: g }); c.acquire(0x100 + i, i); }
  // release in the order 3,1,5,2,4 -> unowned order is that order
  for (const i of [3, 1, 5, 2, 4]) c.releaseLb(0x100 + i);
  const n = c.trim({ pressure: false });
  check("4a: trims exactly down to budget", n === 3 && c.unownedBytes === 2 * one, `n=${n} unowned=${c.unownedBytes}`);
  check("4b: the OLDEST releases went (3, 1, 5)", !c.entries.has(3) && !c.entries.has(1) && !c.entries.has(5)
    && c.entries.has(2) && c.entries.has(4));
  check("4c: under budget -> no-op", c.trim({ pressure: false }) === 0);
  c.acquire(0x999, 2);
  c.releaseLb(0x999);
  check("4d: re-release moves an entry to the tail", [...c.unowned.keys()].join(",") === "4,2");
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. bounded work per call --");
{
  const c = new M.StaticGeomCache({ budgetBytes: 0 });
  for (let i = 1; i <= 60; i++) c.insert(i, { groups: groups(1, 1) });
  const n1 = c.trim({ pressure: false });
  const n2 = c.trim({ pressure: false });
  const n3 = c.trim({ pressure: false });
  check("5a: at most 24 per call, drains over calls", n1 === 24 && n2 === 24 && n3 === 12 && c.entries.size === 0,
    `${n1} ${n2} ${n3}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 6. an aborted bake's undo leaves earlier leases alone --");
{
  const c = new M.StaticGeomCache({ budgetBytes: 0 });
  c.insert(7, { groups: groups(1) });
  c.acquire(0x77, 7);              // an earlier, committed bake of LB 0x77
  c.acquire(0x77, 7);              // a re-bake of the same LB in flight...
  c.release(0x77, 7);              // ...aborts and undoes its one acquire
  check("6a: the earlier lease still holds", c.entries.get(7).refs === 1 && c.hasLease(0x77));
  check("6b: trim cannot take it", c.trim({ pressure: true }) === 0 && c.entries.has(7));
  check("6c: undo of a lease never taken is a no-op", c.release(0x55, 7) === false && c.entries.get(7).refs === 1);
  c.releaseLb(0x77);
  check("6d: the LB's evict releases the rest", c.entries.get(7).refs === 0 && !c.hasLease(0x77));
}

// ---------------------------------------------------------------------------
console.log("\n-- 7. degrade chain: first resolver wins, bytes follow, disposed with the entry --");
{
  const c = new M.StaticGeomCache({ budgetBytes: 0 });
  const e = c.insert(9, { groups: groups(1, 4), didDegrade: 0x11000001 });
  check("7a: a chain id -> unresolved (null)", e.degraded === null);
  c.acquire(0x9, 9);
  const lv = levels(2);
  check("7b: setDegraded tags + counts the levels", c.setDegraded(9, lv) === true
    && lv.get("1|0")[0].geometry.userData.__cacheOwned === true && e.bytes === bytesOf(4) + bytesOf(2));
  check("7c: leased -> unownedBytes untouched", c.unownedBytes === 0);
  check("7d: a second resolver loses", c.setDegraded(9, levels(2)) === false);
  c.releaseLb(0x9);
  check("7e: release counts the levels into unowned bytes", c.unownedBytes === e.bytes);
  c.trim({ pressure: true });
  check("7f: trim disposes the levels too", timesDisposed(lv.get("1|0")[0].geometry) === 1 && c.bytes === 0);
  const e2 = c.insert(10, { groups: groups(1, 4), didDegrade: 0x11000002 });
  c.setDegraded(10, levels(2));
  check("7g: unleased setDegraded counts into unowned bytes", c.unownedBytes === e2.bytes);
}

// ---------------------------------------------------------------------------
console.log("\n-- 8. accounting fuzz: bytes / unownedBytes / refs vs recomputed truth --");
{
  let seed = 0x5eed;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const c = new M.StaticGeomCache({ budgetBytes: 4 * bytesOf(3) });
  const allGeoms = [];
  let bad = "";
  for (let step = 0; step < 4000 && !bad; step++) {
    const op = rnd(7);
    const id = 1 + rnd(30);
    const lb = 0x1000 + rnd(12);
    if (op === 0) {
      if (!c.entries.has(id)) { const g = groups(1 + rnd(2), 1 + rnd(4)); g.forEach((x) => allGeoms.push(x.geometry)); c.insert(id, { groups: g, didDegrade: rnd(2) ? 0x11000000 + id : 0 }); }
    } else if (op === 1) { c.acquire(lb, id); }
    else if (op === 2) { c.release(lb, id); }
    else if (op === 3) { c.releaseLb(lb); }
    else if (op === 4) { c.trim({ pressure: rnd(4) === 0 }); }
    else if (op === 5) { const lv = levels(1 + rnd(3)); for (const ls of lv.values()) for (const l of ls) allGeoms.push(l.geometry); if (!c.setDegraded(id, lv)) for (const ls of lv.values()) for (const l of ls) l.geometry.dispose(); }
    else { c.lookup(id); }
    // truth
    let bytes = 0, unowned = 0;
    const refs = new Map();
    for (const lease of c.leases.values()) for (const [mid, n] of lease) refs.set(mid, (refs.get(mid) || 0) + n);
    for (const e of c.entries.values()) {
      bytes += e.bytes;
      if ((refs.get(e.modelId) || 0) !== e.refs) { bad = `step ${step}: refs ${e.modelId} ${e.refs} vs ${refs.get(e.modelId) || 0}`; break; }
      if (e.refs === 0) { unowned += e.bytes; if (!c.unowned.has(e.modelId)) { bad = `step ${step}: unowned set misses ${e.modelId}`; break; } }
      else if (c.unowned.has(e.modelId)) { bad = `step ${step}: leased ${e.modelId} in unowned set`; break; }
    }
    if (!bad && bytes !== c.bytes) bad = `step ${step}: bytes ${c.bytes} vs ${bytes}`;
    if (!bad && unowned !== c.unownedBytes) bad = `step ${step}: unownedBytes ${c.unownedBytes} vs ${unowned}`;
    for (const mid of refs.keys()) if (!bad && !c.entries.has(mid)) bad = `step ${step}: lease on disposed entry ${mid}`;
  }
  check("8a: 4000 random ops, accounting exact at every step", bad === "", bad);
  const twice = allGeoms.filter((g) => timesDisposed(g) > 1);
  check("8b: no geometry ever disposed twice", twice.length === 0, `${twice.length}`);
  const liveDisposed = [];
  for (const e of c.entries.values()) {
    for (const grp of e.groups) if (timesDisposed(grp.geometry) > 0) liveDisposed.push(e.modelId);
  }
  check("8c: no live entry holds a disposed geometry", liveDisposed.length === 0, liveDisposed.join(","));
}

// ---------------------------------------------------------------------------
console.log("\n-- 9. clear --");
{
  const c = new M.StaticGeomCache({ budgetBytes: 1 << 30 });
  const g = groups(2);
  c.insert(1, { groups: g }); c.acquire(0x1, 1);
  c.clear();
  check("9a: everything disposed, nothing held", c.entries.size === 0 && c.leases.size === 0 && c.bytes === 0
    && c.unownedBytes === 0 && g.every((x) => timesDisposed(x.geometry) === 1));
}

console.log("=========================");
console.log(`static-geom-cache test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
