// tests/hot_mat_variant.test.mjs — lane F hot spots (2026-10-26):
// `?hotMatVariant` generated mirrors in scene3d/batched_material_variant.js.
//
// CLAIM: with the flag on, syncBatchMatVariants() leaves every variant with
// exactly the own properties (same keys, same key order, Object.is-equal
// values) the flag-off `_mirror` loop leaves, after EVERY frame, and the
// internal per-entry lists (keys / hot / ver) that decide future frames match
// too. Only the property lookup changes (named instead of keyed).
//
// HOW: two instances of the module (distinct import URLs → distinct module
// state): REF with the flag off, GEN with it on. They mirror the SAME member
// materials; each frame both sync and every variant pair is compared key by
// key. The scenario drives what members do live (opacity fades, map re-seats,
// needsUpdate, cold-key changes picked up by the 1/32 sweep, new own keys after
// a version bump, keys added WITHOUT a bump, holds/releases that drop and
// re-create variants) plus the edge cases the generated code must spell
// right: integer-like and non-identifier keys, an own enumerable accessor
// (read the same number of times, in the same order), `__proto__` as an own key.
//
// Run:   cd apps/holtburger-web && node tests/hot_mat_variant.test.mjs [--bench]

import * as THREE from "three";

const P = new URL("../scene3d/batched_material_variant.js", import.meta.url).href;
const REF = await import(P + "?ref");
const GEN = await import(P + "?gen");
REF.__setHotMatVariantForTest(false);
GEN.__setHotMatVariantForTest(true);

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const SKIP = new Set(["id", "uuid", "_listeners"]); // per-object by design
// Every frame: same own keys in the same order, Object.is-equal values (a
// variant's own properties are data properties — it only ever gets them by
// assignment — so reading them calls nothing). Every 50th frame also the full
// descriptors.
function diffVariant(a, b, full) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return `key count differs: ${ka.length} vs ${kb.length}`;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (k !== kb[i]) return `key order differs at ${i}: ${k} vs ${kb[i]}`;
    if (SKIP.has(k)) continue;
    if (full) {
      const da = Object.getOwnPropertyDescriptor(a, k), db = Object.getOwnPropertyDescriptor(b, k);
      if (!!da.get !== !!db.get || !!da.set !== !!db.set || da.writable !== db.writable || da.enumerable !== db.enumerable) return `descriptor differs at ${k}`;
      if (!da.get && !Object.is(da.value, db.value)) return `value differs at ${k}: ${String(da.value)} vs ${String(db.value)}`;
    } else if (!Object.is(a[k], b[k])) return `value differs at ${k}: ${String(a[k])} vs ${String(b[k])}`;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return "prototype differs";
  return null;
}
function diffEntry(va, vb) {
  const ea = REF.__batchMatVariantEntryForTest(va), eb = GEN.__batchMatVariantEntryForTest(vb);
  if (!ea || !eb) return (!!ea === !!eb) ? null : "entry liveness differs";
  if (ea.ver !== eb.ver) return `ver differs ${ea.ver} vs ${eb.ver}`;
  if (ea.keys.join("\u0001") !== eb.keys.join("\u0001")) return "keys list differs";
  if (ea.hot.join("\u0001") !== eb.hot.join("\u0001")) return `hot list differs: [${ea.hot}] vs [${eb.hot}]`;
  return null;
}

// ── population (shared members; each module makes its own variant) ─────────
const r = rng(20261026);
const tex = Array.from({ length: 24 }, () => new THREE.Texture());
const members = [];
let getterReads = 0;
function makeMember(i) {
  const x = r();
  let m;
  if (x < 0.65) {
    const o = { map: tex[(r() * tex.length) | 0] };
    if (r() < 0.3) { o.transparent = true; o.opacity = 0.5 + 0.5 * r(); }
    if (r() < 0.2) o.alphaTest = 0.5;
    if (r() < 0.15) { o.emissive = new THREE.Color(0xffffff); o.emissiveIntensity = 1.2; o.emissiveMap = o.map; }
    m = new THREE.MeshStandardMaterial(o);
  } else if (x < 0.85) m = new THREE.MeshBasicMaterial({ map: tex[(r() * tex.length) | 0], transparent: r() < 0.5 });
  else if (x < 0.93) m = new THREE.MeshLambertMaterial({ map: tex[(r() * tex.length) | 0] });
  else m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: "void main(){}", fragmentShader: "void main(){}" });
  const d = r();
  if (d < 0.25) { m.onBeforeCompile = () => {}; m.customProgramCacheKey = () => "k" + (i % 5); }
  else if (d < 0.40) { m.__hbLum = 1; m.onBeforeCompile = () => {}; }
  else if (d < 0.50) { m.__dspTok = null; m.__dspFrame = 0; m.__dspKey = 0; }
  else if (d < 0.55) { m.defines = { USE_X: "" }; m.__hbPal = true; }
  else if (d < 0.58) { m["7"] = 1; m["weird-key"] = "a"; }  // integer-like + non-identifier own keys
  else if (d < 0.60) {
    let hidden = 0.25;
    Object.defineProperty(m, "fadeGetter", { enumerable: true, configurable: true,
      get() { getterReads += 1; return hidden; }, set(v) { hidden = v; } });
  }
  return m;
}
for (let i = 0; i < 260; i++) members.push(makeMember(i));
const protoMember = new THREE.MeshBasicMaterial();
const fakeProto = Object.create(THREE.MeshBasicMaterial.prototype);
Object.defineProperty(protoMember, "__proto__", { value: fakeProto, enumerable: true, writable: true, configurable: true });
members.push(protoMember);

const live = new Map(); // member -> { bmR, bmG } held BatchedMesh stand-ins
function hold(m) {
  if (live.has(m)) return;
  const bmR = { material: REF.batchedMaterialFor(m) }, bmG = { material: GEN.batchedMaterialFor(m) };
  REF.holdBatchedMaterial(bmR); GEN.holdBatchedMaterial(bmG);
  live.set(m, { bmR, bmG });
}
function release(m) {
  const h = live.get(m);
  if (!h) return;
  REF.releaseBatchedMaterial(h.bmR); GEN.releaseBatchedMaterial(h.bmG);
  live.delete(m);
}
for (const m of members) hold(m);

function mutate(f) {
  for (let j = 0; j < 8; j++) { const m = members[(r() * members.length) | 0]; m.opacity = Math.round(r() * 100) / 100; }
  if (f % 5 === 0) { const m = members[(r() * members.length) | 0]; if ("map" in m) m.map = m.map ? null : tex[(r() * tex.length) | 0]; }
  if (f % 11 === 0) { const m = members[(r() * members.length) | 0]; m.needsUpdate = true; }
  if (f % 13 === 0) { const m = members[(r() * members.length) | 0]; if ("roughness" in m) m.roughness = r(); else m.toneMapped = !m.toneMapped; }
  if (f % 17 === 0) { const m = members[(r() * members.length) | 0]; m.polygonOffset = !m.polygonOffset; m.polygonOffsetFactor = (r() * 4) | 0; }
  if (f % 29 === 0) { const m = members[(r() * members.length) | 0]; m.customProgramCacheKey = () => "late" + f; m.needsUpdate = true; } // new own key + bump
  if (f % 31 === 0) { const m = members[(r() * members.length) | 0]; m["lateNoBump" + (f % 3)] = f; }  // new key WITHOUT a bump
  if (f % 37 === 0) { const m = members[(r() * members.length) | 0]; if (m.fadeGetter !== undefined) m.fadeGetter = r(); }
  if (f % 41 === 0) { const m = members[(r() * members.length) | 0]; m["7"] = f; m["weird-key"] = "b" + f; }
  if (f % 43 === 0) { const m = members[(r() * members.length) | 0]; release(m); }
  if (f % 47 === 0) { const m = members[(r() * members.length) | 0]; hold(m); }
  if (f % 53 === 0) { protoMember.__proto__ = r() < 0.5 ? fakeProto : THREE.MeshBasicMaterial.prototype; protoMember.needsUpdate = true; }
}

const FRAMES = 1600;
let firstDiff = null, compared = 0, getterRef = 0, getterGen = 0;
for (let f = 0; f < FRAMES && !firstDiff; f++) {
  mutate(f);
  let g0 = getterReads; REF.syncBatchMatVariants(); getterRef += getterReads - g0;
  g0 = getterReads; GEN.syncBatchMatVariants(); getterGen += getterReads - g0;
  for (const [m, h] of live) {
    const why = diffVariant(h.bmR.material, h.bmG.material, f % 50 === 0) || diffEntry(h.bmR.material, h.bmG.material);
    compared += 1;
    if (why) { firstDiff = `frame ${f}, member #${members.indexOf(m)} (${m.type}): ${why}`; break; }
  }
}

check(`[1] ${FRAMES} frames: every live variant pair identical after every sync (${compared} comparisons)`, () => {
  assert(!firstDiff, firstDiff);
});
check("[2] the own accessor was read the same number of times by both paths", () => {
  assert(getterRef === getterGen && getterRef > 0, `ref ${getterRef} vs gen ${getterGen}`);
});
check("[3] the generated path really ran (lists compiled, no fallback)", () => {
  const s = GEN.batchMatVariantGenStats();
  assert(s.on && s.built > 0 && s.fallback === 0, JSON.stringify(s));
  assert(!REF.batchMatVariantGenStats().on, "ref arm must stay on the flag-off path");
});
check("[4] stats agree (live / holders / dropped)", () => {
  const a = REF.batchMatVariantStats(), b = GEN.batchMatVariantStats();
  assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
});
{
  const { __setRustFlagForTest } = await import(new URL("../scene3d/rust/scene_core.js", import.meta.url).href);
  const M1 = await import(P + "?flagprobe1");
  const onByDefault = M1.batchMatVariantGenStats().on === true;
  __setRustFlagForTest("hotMatVariant", undefined);
  const prevLoc = globalThis.location;
  globalThis.location = { search: "?hotMatVariant=off" };
  const M2 = await import(P + "?flagprobe2");
  const offWhenAsked = M2.batchMatVariantGenStats().on === false;
  globalThis.location = prevLoc;
  __setRustFlagForTest("hotMatVariant", undefined);
  check("[5] flag default ON since 2026-10-26; `?hotMatVariant=off` is the escape", () => {
    assert(onByDefault, "default must be on");
    assert(offWhenAsked, "=off must disarm");
  });
}
{
  // [6] Strict mode (2026-10-29, lane F2 finding): `_mirror` lives in a module, so a write it
  // cannot make throws; the generated mirror is compiled by `new Function`, sloppy unless its
  // body says otherwise — the same write would pass silently and the variant would keep a stale
  // value. A variant key made read-only, then a member change on that key: both paths throw.
  const SR = await import(P + "?strictref"), SG = await import(P + "?strictgen");
  SR.__setHotMatVariantForTest(false); SG.__setHotMatVariantForTest(true);
  const member = new THREE.MeshBasicMaterial();
  member.lockedKey = 1;
  const bR = { material: SR.batchedMaterialFor(member) }, bG = { material: SG.batchedMaterialFor(member) };
  SR.holdBatchedMaterial(bR); SG.holdBatchedMaterial(bG);
  member.needsUpdate = true; SR.syncBatchMatVariants(); SG.syncBatchMatVariants();
  for (const v of [bR.material, bG.material]) Object.defineProperty(v, "lockedKey", { value: v.lockedKey, writable: false, enumerable: true, configurable: true });
  member.lockedKey = 2; member.needsUpdate = true;
  const threw = (M) => { try { M.syncBatchMatVariants(); return null; } catch (e) { return e && e.constructor && e.constructor.name; } };
  const ref = threw(SR), gen = threw(SG);
  check("[6] a write the strict module loop throws on throws in the generated mirror too (\"use strict\")", () => {
    assert(SG.batchMatVariantGenStats().built > 0, "the generated path must have compiled a list");
    assert(ref === "TypeError" && gen === "TypeError", `ref ${ref} vs gen ${gen}`);
  });
  SR.releaseBatchedMaterial(bR); SG.releaseBatchedMaterial(bG);
}

// ── micro-bench (indicative; laptop i5-6300U shared with other agents) ──────
if (process.argv.includes("--bench")) {
  const BR = await import(P + "?benchref"), BG = await import(P + "?benchgen");
  BR.__setHotMatVariantForTest(false); BG.__setHotMatVariantForTest(true);
  const run = (M, label) => {
    const rr = rng(7);
    const save = r;
    const pop = [];
    for (let i = 0; i < 400; i++) pop.push(makeMember(i));
    for (const m of pop) M.batchedMaterialFor(m);
    const step = (f) => {
      for (let j = 0; j < 6; j++) pop[(rr() * pop.length) | 0].opacity = Math.round(rr() * 100) / 100;
      if (f % 23 === 0) pop[(rr() * pop.length) | 0].needsUpdate = true;
    };
    for (let f = 0; f < 3000; f++) { step(f); M.syncBatchMatVariants(); }
    const F = 20000;
    let t0 = process.hrtime.bigint();
    for (let f = 0; f < F; f++) step(f);
    const tm = Number(process.hrtime.bigint() - t0);
    t0 = process.hrtime.bigint();
    for (let f = 0; f < F; f++) { step(f); M.syncBatchMatVariants(); }
    const t = Number(process.hrtime.bigint() - t0);
    console.log(`  bench ${label}: ${((t - tm) / F / 1000).toFixed(1)} us/frame (400 variants)`);
    return save;
  };
  run(BR, "flag off (keyed _mirror)");
  run(BG, "?hotMatVariant (generated)");
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
