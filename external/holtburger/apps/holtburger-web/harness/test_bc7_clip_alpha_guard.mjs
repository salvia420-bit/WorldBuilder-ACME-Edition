// harness/test_bc7_clip_alpha_guard.mjs — CLIP-ALPHA guard (2026-10-07,
// `?bc7ClipAlphaGuard`, default ON): a BC7 payload that cannot reproduce the
// cutout its decoded RGBA8 albedo carries is never swapped in.
//
// Owner report: reed clumps (Surface 0x080000A1 / rs 0x0600385A, INDEX16
// ClipMap) drew as opaque black quads on the 1070. The served `tex-xu7`
// record for that RenderSurface has alpha >= 240 everywhere while the retail
// albedo is 58% alpha-0 (palette index < 8 under Base1ClipMap). The real-data
// half of this pin lives in test_bc7_clip_alpha_guard_real.mjs; THIS suite is
// synthetic (hand-built BC7 blocks, no DAT, no transcoder) so it runs anywhere.
//
// WHAT MUST HOLD
//   PART 1 — `bc7BlockAlphaFloor` reads every alpha-bearing BC7 layout right
//            (modes 4/5 incl. rotation, 6 with p-bits, 7 with 4 endpoints,
//            0-3 opaque, reserved = 0); `bc7AlphaFloor` stops early.
//   PART 2 — the cut: alphaTest*255 (a texel AT the ref survives), 128 for
//            blended, 0 for a material that ignores alpha; flag polarity.
//   PART 3 — the veto: opaque payload over a keyed albedo is refused, the
//            material keeps its RGBA8 map, `__bc7Pending` is SETTLED, the
//            atlas refeed fires and the bucket key is `f8`; one console line
//            per RenderSurface.
//   PART 4 — no veto for an opaque payload over an opaque albedo, nor for a
//            payload that carries alpha; `=off` restores the old swap.
//   PART 5 — the two-phase swap: a refused pre is never swapped, an admitted
//            pre survives a refused full, `onSwap` counts are exact.
//   PART 6 — xu7 lane: a refused xu7 record falls back to its tex-bc7 twin
//            (`__bc7Pending` held while the twin is in flight, even on the
//            already-cached leg), the twin replaces it in the cache, a re-fetch
//            skips xu7, and a refused twin still settles.
//   PART 7 — the MaterialCache call site + `window.__bc7ClipGuard`.
//
// Run:  cd apps/holtburger-web && node harness/test_bc7_clip_alpha_guard.mjs

import * as THREE from "three";
import {
  bc7BlockAlphaFloor,
  bc7AlphaFloor,
  bc7ClipAlphaGuardEnabled,
  bc7ClipAlphaGateFor,
  clipAlphaCutOf,
  clipAlphaGuardStats,
  bc7RecordLane,
  upgradeMaterialToBc7,
  initBc7Source,
  bc7Source,
  registerAtlasRefeed,
  parseHbc7,
  bc7LevelBytes,
  HBC7_HEADER_BYTES,
  _setBc7SupportForTest,
  _resetBc7ForTest,
} from "../scene3d/bc7_textures.js";
import { _bucketKeyFor, isBc7AtlasTexture, bc7AtlasShouldDefer } from "../scene3d/static_atlas.js";
import { MaterialCache } from "../scene3d/materials.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function setSearch(search) {
  globalThis.window = globalThis.window || {};
  globalThis.window.location = { search };
}

// ---------------------------------------------------------------------------
// BC7 block builders (bits LSB-first from byte 0, per the BC7 spec)
// ---------------------------------------------------------------------------
function putBits(b, pos, n, v) {
  for (let i = 0; i < n; i += 1) {
    const bit = (v >>> i) & 1;
    const p = pos + i;
    if (bit) b[p >> 3] |= 1 << (p & 7);
    else b[p >> 3] &= ~(1 << (p & 7));
  }
}
/** mode 6: A0/A1 are 7-bit, p0/p1 the unique p-bits -> alpha = (A<<1)|p */
function mode6(a0, a1, p0 = 1, p1 = 1) {
  const b = new Uint8Array(16);
  b[0] = 0x40;
  putBits(b, 49, 7, a0);
  putBits(b, 56, 7, a1);
  putBits(b, 63, 1, p0);
  putBits(b, 64, 1, p1);
  return b;
}
function mode1() {
  const b = new Uint8Array(16).fill(0xff);
  b[0] = 0x02; // bit 1 set, bit 0 clear -> mode 1
  return b;
}
/** mode 5: rot 0 -> 8-bit alpha endpoints; rot c+1 -> 7-bit colour channel c */
function mode5({ rot = 0, a0 = 255, a1 = 255, ch = [[127, 127], [127, 127], [127, 127]] } = {}) {
  const b = new Uint8Array(16);
  b[0] = 0x20;
  putBits(b, 6, 2, rot);
  for (let c = 0; c < 3; c += 1) {
    putBits(b, 8 + 14 * c, 7, ch[c][0]);
    putBits(b, 15 + 14 * c, 7, ch[c][1]);
  }
  putBits(b, 50, 8, a0);
  putBits(b, 58, 8, a1);
  return b;
}
/** mode 4: rot 0 -> 6-bit alpha endpoints; rot c+1 -> 5-bit colour channel c */
function mode4({ rot = 0, a0 = 63, a1 = 63, ch = [[31, 31], [31, 31], [31, 31]] } = {}) {
  const b = new Uint8Array(16);
  b[0] = 0x10;
  putBits(b, 5, 2, rot);
  for (let c = 0; c < 3; c += 1) {
    putBits(b, 8 + 10 * c, 5, ch[c][0]);
    putBits(b, 13 + 10 * c, 5, ch[c][1]);
  }
  putBits(b, 38, 6, a0);
  putBits(b, 44, 6, a1);
  return b;
}
/** mode 7: four 5-bit alpha endpoints + four p-bits -> 6-bit, expanded */
function mode7(as = [31, 31, 31, 31], ps = [1, 1, 1, 1]) {
  const b = new Uint8Array(16);
  b[0] = 0x80;
  for (let i = 0; i < 4; i += 1) {
    putBits(b, 74 + 5 * i, 5, as[i]);
    putBits(b, 94 + i, 1, ps[i]);
  }
  return b;
}

/** A full-chain HBC7 whose level-0 block i is `blockAt(i)`; deeper levels opaque. */
function makeHbc7(w, h, blockAt) {
  const levels = [];
  let lw = w;
  let lh = h;
  for (;;) {
    levels.push(bc7LevelBytes(lw, lh));
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  const buf = new Uint8Array(HBC7_HEADER_BYTES + levels.reduce((a, n) => a + n, 0));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x37434248, true);
  dv.setUint32(4, w, true);
  dv.setUint32(8, h, true);
  dv.setUint32(12, Math.ceil(w / 4), true);
  dv.setUint32(16, Math.ceil(h / 4), true);
  let off = HBC7_HEADER_BYTES;
  levels.forEach((n, li) => {
    for (let i = 0; i < n / 16; i += 1) buf.set(li === 0 ? blockAt(i) : mode6(127, 127), off + i * 16);
    off += n;
  });
  return buf;
}
const OPAQUE = (w = 16, h = 16) => makeHbc7(w, h, () => mode6(127, 127)); // alpha 255
const NEAR_OPAQUE = (w = 16, h = 16) => makeHbc7(w, h, () => mode6(120, 127, 0, 1)); // 240..255, the xu7 shape
const CUTOUT = (w = 16, h = 16) => makeHbc7(w, h, (i) => (i % 3 === 0 ? mode6(0, 127, 0, 1) : mode6(127, 127)));

/** RGBA8 albedo; `keyed` clears the alpha of the left half (retail index<8). */
function albedo(w, h, keyed) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      px[o] = 90; px[o + 1] = 110; px[o + 2] = 40;
      px[o + 3] = keyed && x < w / 2 ? 0 : 255;
    }
  }
  const t = new THREE.DataTexture(px, w, h, THREE.RGBAFormat);
  t.name = keyed ? "rgba8-keyed" : "rgba8-opaque";
  return t;
}
function clipMat(keyed, { alphaTest = 100 / 255, transparent = false, flags = 0x4 } = {}) {
  const m = new THREE.MeshStandardMaterial({ alphaTest, transparent });
  m.map = albedo(16, 16, keyed);
  m.userData = { surfaceTypeFlags: flags };
  return m;
}

let warnLines = [];
const realWarn = console.warn;
console.warn = (...a) => {
  const s = a.join(" ");
  if (s.includes("[materials/bc7] refused")) warnLines.push(s);
  else realWarn(...a);
};

/** Fresh module state + a record source. */
function arm({ search = "", fetchImpl, preFetchImpl, xu7ParsedImpl } = {}) {
  _resetBc7ForTest();
  setSearch(search);
  _setBc7SupportForTest(true);
  initBc7Source({ fetchImpl, preFetchImpl: preFetchImpl || (async () => null), xu7ParsedImpl });
  warnLines = [];
  const refeeds = [];
  registerAtlasRefeed((rs) => {
    refeeds.push(rs);
    return 0;
  });
  return refeeds;
}

// ===========================================================================
console.log("PART 1 — BC7 alpha floor from block endpoints");
// ===========================================================================
{
  check("mode 6 alpha 255 (A=127, p=1)", bc7BlockAlphaFloor(mode6(127, 127), 0) === 255);
  check("mode 6 floor = min endpoint (A0=0,p0=0)", bc7BlockAlphaFloor(mode6(0, 127, 0, 1), 0) === 0);
  check("mode 6 p-bits are per endpoint (254 / 255)", bc7BlockAlphaFloor(mode6(127, 127, 1, 0), 0) === 254);
  check("mode 6 xu7 shape (A=120,p=0 -> 240)", bc7BlockAlphaFloor(mode6(120, 127, 0, 1), 0) === 240);
  check("modes 0-3 carry no alpha -> 255", bc7BlockAlphaFloor(mode1(), 0) === 255);
  check("reserved mode (byte0 = 0) decodes to 0", bc7BlockAlphaFloor(new Uint8Array(16), 0) === 0);
  check("mode 5 rot 0: 8-bit alpha endpoints", bc7BlockAlphaFloor(mode5({ a0: 200, a1: 37 }), 0) === 37);
  check("mode 5 rot 1: alpha is the RED channel (7-bit, expanded)",
    bc7BlockAlphaFloor(mode5({ rot: 1, a0: 0, a1: 0, ch: [[64, 127], [0, 0], [0, 0]] }), 0) === ((64 << 1) | (64 >> 6)));
  check("mode 5 rot 3: alpha is the BLUE channel",
    bc7BlockAlphaFloor(mode5({ rot: 3, a0: 0, a1: 0, ch: [[0, 0], [0, 0], [127, 127]] }), 0) === 255);
  check("mode 4 rot 0: 6-bit alpha expanded", bc7BlockAlphaFloor(mode4({ a0: 63, a1: 16 }), 0) === ((16 << 2) | (16 >> 4)));
  check("mode 4 rot 2: alpha is the GREEN channel (5-bit, expanded)",
    bc7BlockAlphaFloor(mode4({ rot: 2, a0: 0, a1: 0, ch: [[0, 0], [10, 31], [0, 0]] }), 0) === ((10 << 3) | (10 >> 2)));
  check("mode 7: min over all four endpoints", bc7BlockAlphaFloor(mode7([31, 31, 2, 31], [1, 1, 0, 1]), 0) === (((2 << 1) << 2) | ((2 << 1) >> 4)));
  check("mode 7 all-max -> 255", bc7BlockAlphaFloor(mode7(), 0) === 255);
  check("block offset honoured", (() => {
    const two = new Uint8Array(32);
    two.set(mode6(127, 127), 0);
    two.set(mode6(0, 0, 0, 0), 16);
    return bc7BlockAlphaFloor(two, 0) === 255 && bc7BlockAlphaFloor(two, 16) === 0;
  })());
  const op = parseHbc7(OPAQUE());
  check("payload floor: opaque = 255", bc7AlphaFloor(op) === 255);
  check("payload floor: xu7-shaped = 240", bc7AlphaFloor(parseHbc7(NEAR_OPAQUE())) === 240);
  check("payload floor: cutout = 0", bc7AlphaFloor(parseHbc7(CUTOUT())) === 0);
  check("payload floor: level 0 only (opaque level 0, deeper levels irrelevant)",
    bc7AlphaFloor(parseHbc7(makeHbc7(8, 8, () => mode1()))) === 255);
  check("unreadable payload -> -1", bc7AlphaFloor(null) === -1 && bc7AlphaFloor({ levels: [] }) === -1);
  // early exit: a floor under stopBelow returns at the first such block.
  const early = makeHbc7(16, 16, (i) => (i === 0 ? mode6(10, 10, 0, 0) : new Uint8Array(16)));
  check("stops at the first block under stopBelow (does not reach the reserved blocks)",
    bc7AlphaFloor(parseHbc7(early), 100) === 20);
}

// ===========================================================================
console.log("PART 2 — the cut + flag");
// ===========================================================================
{
  check("paletted ClipMap ref 100/255 -> cut exactly 100",
    clipAlphaCutOf({ alphaTest: 100 / 255 }) === 100);
  check("DDS ClipMap ref 200/255 -> 200", clipAlphaCutOf({ alphaTest: 200 / 255 }) === 200);
  check("legacy 0.5 -> 127.5 (texel 127 discarded, 128 survives)", clipAlphaCutOf({ alphaTest: 0.5 }) === 127.5);
  check("blended (transparent, no alpha test) -> 128", clipAlphaCutOf({ alphaTest: 0, transparent: true }) === 128);
  check("alpha test wins over transparent", clipAlphaCutOf({ alphaTest: 100 / 255, transparent: true }) === 100);
  check("opaque material ignores alpha -> 0", clipAlphaCutOf({ alphaTest: 0, transparent: false }) === 0);
  check("flag default ON (absent, or only other flags set)", bc7ClipAlphaGuardEnabled("") === true && bc7ClipAlphaGuardEnabled("?texXu7=off") === true);
  check("flag escapes: off/0/false/no",
    ["off", "0", "false", "no", "OFF"].every((v) => bc7ClipAlphaGuardEnabled(`?bc7ClipAlphaGuard=${v}`) === false));
  check("flag: any other value stays ON", bc7ClipAlphaGuardEnabled("?bc7ClipAlphaGuard=on") === true);
}

// ===========================================================================
console.log("PART 3 — veto: opaque BC7 over a keyed RGBA8 albedo");
// ===========================================================================
{
  const RS = 0x0600385a;
  const full = deferred();
  const refeeds = arm({ fetchImpl: () => full.promise });
  const mat = clipMat(true);
  const rgba = mat.map;
  const gate = bc7ClipAlphaGateFor(mat, RS, 0x080000a1);
  check("gate armed for a keyed ClipMap albedo", !!gate && typeof gate.admit === "function");
  let swaps = 0;
  const p = upgradeMaterialToBc7(mat, RS, () => swaps++, { gate });
  check("verdict in flight: __bc7Pending set, atlas defers", mat.userData.__bc7Pending === true && bc7AtlasShouldDefer(mat));
  full.resolve(OPAQUE());
  const res = await p;
  check("refused: promise resolves false, no onSwap", res === false && swaps === 0);
  check("material KEPT its RGBA8 albedo", mat.map === rgba && !mat.map.isCompressedTexture);
  check("__bc7Pending SETTLED (nothing left waiting)", mat.userData.__bc7Pending === undefined && !bc7AtlasShouldDefer(mat));
  check("__bc7Vetoed stamped, __bc7 not", mat.userData.__bc7Vetoed === "clip-alpha" && !mat.userData.__bc7);
  check("atlas refeed fired for the settled rsId", refeeds.length === 1 && refeeds[0] === RS);
  check("atlas bucket is RGBA8 (f8), not BC7",
    !isBc7AtlasTexture(mat.map) && _bucketKeyFor(16, 16, "k", isBc7AtlasTexture(mat.map)).endsWith("|f8"));
  const st = clipAlphaGuardStats();
  check("stats: armed, one full refusal, kept albedo",
    st.albedoKeyed === 1 && st.vetoedFull === 1 && st.keptAlbedo === 1 && st.vetoedSurfaces === 1);
  check("one console line, naming surface + rs + floor + cut",
    warnLines.length === 1 && /0x080000A1/.test(warnLines[0]) && /0x0600385A/.test(warnLines[0]) && /255/.test(warnLines[0]) && /100\/255/.test(warnLines[0]),
    warnLines.join(" | "));

  // A second Surface over the same RenderSurface: cached leg, still refused,
  // the albedo scan is answered from the per-RenderSurface cache, no new line.
  const mat2 = clipMat(true);
  const gate2 = bc7ClipAlphaGateFor(mat2, RS, 0x080000a2);
  const res2 = await upgradeMaterialToBc7(mat2, RS, null, { gate: gate2 });
  check("same RenderSurface, second Surface: refused too", res2 === false && !mat2.map.isCompressedTexture);
  check("albedo scan cached per RenderSurface", clipAlphaGuardStats().albedoScans === 1 && clipAlphaGuardStats().albedoCacheHits === 1);
  check("still ONE console line for the RenderSurface", warnLines.length === 1);

  // The xu7 lane's actual shape: alpha 240..255 is just as unable to drop a
  // texel under a 100 cut.
  arm({ fetchImpl: async () => NEAR_OPAQUE() });
  const m3 = clipMat(true);
  const r3 = await upgradeMaterialToBc7(m3, RS, null, { gate: bc7ClipAlphaGateFor(m3, RS, 1) });
  check("floor 240 >= cut 100: refused", r3 === false && !m3.map.isCompressedTexture);
  // ... but a BLENDED material's cut is 128, and an albedo whose texels are
  // all >= 128 is not keyed: no gate at all.
  const m4 = clipMat(false, { alphaTest: 0, transparent: true, flags: 0x14 });
  m4.map.image.data.forEach((v, i) => { if ((i & 3) === 3) m4.map.image.data[i] = 200; });
  check("blended, albedo alpha 200 everywhere: nothing to protect", bc7ClipAlphaGateFor(m4, RS, 2) === null);
}

// ===========================================================================
console.log("PART 4 — no veto: opaque albedo, payload with alpha, =off");
// ===========================================================================
{
  const RS = 0x06001111;
  arm({ fetchImpl: async () => OPAQUE() });
  const opaqueMat = clipMat(false);
  check("opaque albedo: gate not armed (nothing to protect)", bc7ClipAlphaGateFor(opaqueMat, RS, 3) === null);
  const r1 = await upgradeMaterialToBc7(opaqueMat, RS, null, undefined);
  check("opaque BC7 over opaque RGBA8 swaps", r1 && r1.swapped === true && opaqueMat.map.isCompressedTexture);
  check("stats: albedoClean counted", clipAlphaGuardStats().albedoClean === 1);

  arm({ fetchImpl: async () => CUTOUT() });
  const m = clipMat(true);
  const gate = bc7ClipAlphaGateFor(m, RS, 4);
  const r2 = await upgradeMaterialToBc7(m, RS, null, { gate });
  check("BC7 that carries the cutout is ADMITTED and swapped", r2 && r2.swapped === true && m.map.isCompressedTexture);
  check("no refusal recorded, no console line", clipAlphaGuardStats().vetoedFull === 0 && warnLines.length === 0);
  check("admitted swap clears __bc7Pending + stamps __bc7", m.userData.__bc7Pending === undefined && m.userData.__bc7 === true);

  arm({ search: "?bc7ClipAlphaGuard=off", fetchImpl: async () => OPAQUE() });
  const mOff = clipMat(true);
  const gOff = bc7ClipAlphaGateFor(mOff, RS, 5);
  check("=off: no gate is built", gOff === null);
  const r3 = await upgradeMaterialToBc7(mOff, RS, null, gOff ? { gate: gOff } : undefined);
  check("=off: the opaque payload swaps in (pre-2026-10-07 behaviour)", r3 && r3.swapped === true && mOff.map.isCompressedTexture);
  check("=off: nothing counted", clipAlphaGuardStats().asked === 0);

  arm({ fetchImpl: async () => OPAQUE() });
  const comp = clipMat(true);
  comp.map = new THREE.CompressedTexture([{ data: new Uint8Array(16), width: 4, height: 4 }], 4, 4, THREE.RGBA_BPTC_Format);
  check("unreadable albedo (already compressed): guard stands down", bc7ClipAlphaGateFor(comp, RS, 6) === null);
  const opaqueMatl = clipMat(true, { alphaTest: 0 });
  check("material that ignores alpha: guard stands down", bc7ClipAlphaGateFor(opaqueMatl, RS, 7) === null);
  check("a throwing gate ADMITS (the guard may only refuse with evidence)", await (async () => {
    const mm = clipMat(true);
    const r = await upgradeMaterialToBc7(mm, RS, null, { gate: { admit() { throw new Error("boom"); } } });
    return r && r.swapped === true;
  })());
}

// ===========================================================================
console.log("PART 5 — the preview -> full two-phase swap");
// ===========================================================================
{
  const RS = 0x06002222;
  // pre carries the cutout, full does not: pre swaps, full is refused, the
  // material keeps the (correct) pre texture and the verdict settles.
  {
    const pre = deferred();
    const full = deferred();
    const refeeds = arm({ fetchImpl: () => full.promise, preFetchImpl: () => pre.promise });
    const m = clipMat(true);
    const swaps = [];
    const p = upgradeMaterialToBc7(m, RS, (r) => swaps.push(r), { gate: bc7ClipAlphaGateFor(m, RS, 10) });
    pre.resolve(CUTOUT(8, 8));
    await tick();
    check("admitted pre swapped in (8x8)", m.map.isCompressedTexture && m.map.image.width === 8 && swaps.length === 1);
    check("pre phase keeps __bc7Pending (atlas still defers)", bc7AtlasShouldDefer(m));
    full.resolve(OPAQUE(16, 16));
    const r = await p;
    check("full refused: no second swap", r === false && swaps.length === 1);
    check("material keeps the admitted pre texture", m.map.isCompressedTexture && m.map.image.width === 8);
    check("verdict settled + refeed fired", m.userData.__bc7Pending === undefined && refeeds.length === 1);
    check("console line says the preview was kept", warnLines.length === 1 && /keeping the admitted preview record/.test(warnLines[0]), warnLines.join(" | "));
  }
  // pre dropped the cutout, full carries it: pre never swaps, full does.
  {
    const pre = deferred();
    const full = deferred();
    arm({ fetchImpl: () => full.promise, preFetchImpl: () => pre.promise });
    const m = clipMat(true);
    const rgba = m.map;
    const swaps = [];
    const p = upgradeMaterialToBc7(m, RS, (r) => swaps.push(r), { gate: bc7ClipAlphaGateFor(m, RS, 11) });
    pre.resolve(OPAQUE(8, 8));
    await tick();
    check("refused pre: never swapped, RGBA8 still bound", m.map === rgba && swaps.length === 0);
    check("refused pre counted", clipAlphaGuardStats().vetoedPre === 1);
    full.resolve(CUTOUT(16, 16));
    const r = await p;
    check("admitted full swaps over the RGBA8 twin", r && r.swapped === true && r.replaced === rgba && swaps.length === 1);
    check("console line names the refused pre and the admitted full",
      warnLines.length === 1 && /refused the pre BC7 payload/.test(warnLines[0]) && /swapped in the full record/.test(warnLines[0]), warnLines.join(" | "));
  }
  // both refused: RGBA8 kept, exactly zero swaps, verdict settled.
  {
    arm({ fetchImpl: async () => OPAQUE(16, 16), preFetchImpl: async () => OPAQUE(8, 8) });
    const m = clipMat(true);
    const rgba = m.map;
    let swaps = 0;
    const r = await upgradeMaterialToBc7(m, RS, () => swaps++, { gate: bc7ClipAlphaGateFor(m, RS, 12) });
    await tick();
    check("pre + full both refused: RGBA8 kept, zero swaps", r === false && m.map === rgba && swaps === 0);
    check("…and nothing left pending", m.userData.__bc7Pending === undefined);
  }
}

// ===========================================================================
console.log("PART 6 — xu7 lane falls back to the tex-bc7 twin");
// ===========================================================================
{
  const RS = 0x06003333;
  {
    let xu7Asks = 0;
    let hbc7Asks = 0;
    const twin = deferred();
    arm({
      xu7ParsedImpl: async () => { xu7Asks += 1; return parseHbc7(NEAR_OPAQUE()); },
      fetchImpl: () => { hbc7Asks += 1; return twin.promise; },
    });
    const src = bc7Source();
    const m = clipMat(true);
    const rgba = m.map;
    const swaps = [];
    const p = upgradeMaterialToBc7(m, RS, (r) => swaps.push(r), { gate: bc7ClipAlphaGateFor(m, RS, 20) });
    await tick();
    check("xu7 record fetched first (texXu7 default ON)", xu7Asks === 1);
    check("refused xu7 -> twin fetched, __bc7Pending HELD meanwhile", hbc7Asks === 1 && bc7AtlasShouldDefer(m));
    twin.resolve(CUTOUT());
    const r = await p;
    check("twin admitted and swapped in", r && r.swapped === true && r.replaced === rgba && swaps.length === 1);
    check("final map is the twin (carries the cutout)", bc7AlphaFloor({ levels: m.map.mipmaps }) === 0);
    check("verdict settled", m.userData.__bc7Pending === undefined && m.userData.__bc7 === true);
    check("stats: one fallback, one rescue, nothing kept",
      clipAlphaGuardStats().hbc7Fallbacks === 1 && clipAlphaGuardStats().hbc7Rescued === 1 && clipAlphaGuardStats().keptAlbedo === 0);
    check("console line says the twin was swapped in", warnLines.length === 1 && /twin/.test(warnLines[0]));
    const cached = src._cache.get(RS);
    check("the twin REPLACED the xu7 record in the cache", cached && bc7RecordLane(cached) === "hbc7");

    // Second Surface sharing the RenderSurface: cached leg serves the twin
    // straight away — no new xu7 or hbc7 fetch, no refusal.
    const m2 = clipMat(true);
    const r2 = await upgradeMaterialToBc7(m2, RS, null, { gate: bc7ClipAlphaGateFor(m2, RS, 21) });
    check("next Surface gets the twin from cache, no refetch", r2 && r2.swapped === true && xu7Asks === 1 && hbc7Asks === 1);

    // Record evicted (LB re-stream): the re-fetch skips the refused xu7 lane.
    src.dropRecord(RS);
    await src.getAsync(RS);
    check("re-fetch after eviction skips xu7 for a refused rsId", xu7Asks === 1 && hbc7Asks === 2);
  }
  // already-cached leg: no pending marker was ever set, the guard must set it
  // while the twin is in flight.
  {
    const twin = deferred();
    arm({ xu7ParsedImpl: async () => parseHbc7(OPAQUE()), fetchImpl: () => twin.promise });
    const src = bc7Source();
    await src.getAsync(RS); // an unguarded asker cached the xu7 record
    const m = clipMat(true);
    const p = upgradeMaterialToBc7(m, RS, null, { gate: bc7ClipAlphaGateFor(m, RS, 22) });
    await tick();
    check("cached leg: __bc7Pending set while the twin is in flight", m.userData.__bc7Pending === true && bc7AtlasShouldDefer(m));
    twin.resolve(CUTOUT());
    const r = await p;
    check("cached leg: twin swapped, pending cleared", r && r.swapped === true && m.userData.__bc7Pending === undefined);
  }
  // the twin drops the cutout too (or is absent): kept albedo, settled.
  for (const [label, twinBytes] of [["opaque twin", () => OPAQUE()], ["absent twin", () => null]]) {
    const refeeds = arm({ xu7ParsedImpl: async () => parseHbc7(NEAR_OPAQUE()), fetchImpl: async () => twinBytes() });
    const m = clipMat(true);
    const rgba = m.map;
    const r = await upgradeMaterialToBc7(m, RS, null, { gate: bc7ClipAlphaGateFor(m, RS, 23) });
    check(`${label}: RGBA8 kept, settled, refeed fired`,
      r === false && m.map === rgba && m.userData.__bc7Pending === undefined && m.userData.__bc7Vetoed === "clip-alpha" && refeeds.length === 1);
    check(`${label}: console line says the albedo was kept`, warnLines.length === 1 && /keeping the decoded albedo/.test(warnLines[0]));
  }
  // An hbc7-lane record is never "fallen back" from (there is no other lane).
  {
    let hbc7Asks = 0;
    arm({ fetchImpl: async () => { hbc7Asks += 1; return OPAQUE(); } });
    const m = clipMat(true);
    const r = await upgradeMaterialToBc7(m, RS, null, { gate: bc7ClipAlphaGateFor(m, RS, 24) });
    check("refused hbc7 record: no fallback fetch", r === false && hbc7Asks === 1 && clipAlphaGuardStats().hbc7Fallbacks === 0);
  }
}

// ===========================================================================
console.log("PART 7 — MaterialCache call site + window.__bc7ClipGuard");
// ===========================================================================
{
  const RS = 0x0600385a;
  const DID = 0x080000a1;
  arm({ xu7ParsedImpl: async () => parseHbc7(NEAR_OPAQUE()), fetchImpl: async () => null });
  check("window.__bc7ClipGuard installed by initBc7Source",
    typeof globalThis.window.__bc7ClipGuard?.stats === "function" && typeof globalThis.window.__bc7ClipGuard?.surface === "function");
  const mc = new MaterialCache();
  const m = clipMat(true);
  mc.materials.set(DID, m);
  mc._maybeUpgradeToBc7(DID, m, RS);
  for (let i = 0; i < 50 && globalThis.window.__bc7ClipGuard.surface(DID)?.verdict === "pending"; i += 1) await tick(2);
  const s = globalThis.window.__bc7ClipGuard.surface(DID);
  check("surface(0x080000A1) records the refusal and the KEPT rgba8 map",
    s && s.verdict === "kept" && s.vetoed === true && s.map && s.map.kind === "rgba8" && s.rs === "0x0600385A",
    JSON.stringify(s));
  check("refusals() lists it", globalThis.window.__bc7ClipGuard.refusals().some((e) => e.did === "0x080000A1"));
  check("material settled through the real call site", m.userData.__bc7Pending === undefined && !m.map.isCompressedTexture);
  const unarmed = clipMat(false);
  mc.materials.set(0x08000099, unarmed);
  mc._maybeUpgradeToBc7(0x08000099, unarmed, 0x06009999);
  check("surface() is null for a Surface the gate never armed for", globalThis.window.__bc7ClipGuard.surface(0x08000099) === null);
  await tick(10);
}

console.warn = realWarn;
_resetBc7ForTest();
registerAtlasRefeed(null);
console.log(`\nbc7 clip-alpha guard: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "BC7-CLIP-ALPHA-GUARD ✅" : "BC7-CLIP-ALPHA-GUARD ❌");
process.exit(failed === 0 ? 0 : 1);
