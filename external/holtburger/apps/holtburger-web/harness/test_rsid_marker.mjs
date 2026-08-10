// harness/test_rsid_marker.mjs — RSID-MARKER: the universal `__texRsId` stamp
// and the bc7Pending hold-out → re-offer loop (texture family).
//
// WHY THIS SUITE EXISTS
// ---------------------
// T22-PRODUCER's live arm refused 363 of 815 offered nodes with reason
// `bc7Pending` and read `holdoutRsIds = 0` in the same census: the members
// were held out with no key to file them under, so `atlasRefeed(rsId)` could
// never re-offer them and they stayed on the legacy producer for the session.
// The cause was a marker gap — `__pvwRsId` is written only for preview-BORN
// materials and `__bc7RsId` only after a full tier LANDS, so a material in
// `__bc7Pending` (precisely the refused state) carried neither.
//
// WHAT MUST HOLD:
//   PART 1 — the stamp primitive: `stampRsId` writes `__texRsId` in place
//            (never a spread — live non-enumerable handles), is idempotent
//            and counted once; `materialRsId` is ONE total reader with the
//            tier-specific markers taking precedence.
//   PART 2 — EVERY bc7-born material class carries a marker: the X6 upgrade
//            path stamps BEFORE the await (so `__bc7Pending` can never exist
//            without the key), stamps on the already-cached leg, stamps past
//            the ask-once gate (a rebuilt material), the ST5 preview-born
//            path stamps alongside `__pvwRsId`, and variant clones inherit it.
//   PART 3 — the verdict seam: `atlasRefeed(rsId)` fires when the BC7 verdict
//            SETTLES — landed, absent, or failed (a negative verdict settles
//            dims/format just as finally) — never on the pre-phase swap; the
//            counters split resolved vs. delivered.
//   PART 4 — the pool re-offer, end to end: a bc7Pending refusal is FILED,
//            the verdict re-offers it, the admitted node leaves the legacy
//            scene graph and lives in a pool.
//   PART 5 — a re-offer that is refused AGAIN is counted per reason and the
//            node keeps rendering legacy (counted-never-silent both ways).
//   PART 6 — the ledger's edges: duplicate hold-outs are refused (a double
//            re-offer would double-draw the prop), a marker-less material is
//            counted as the gap it is, and a node whose landblock died while
//            its texture was in flight is dropped as STALE, never resurrected.
//   PART 7 — `refeedRsId` guards: a layer is never rewritten from a texture of
//            different dims OR different format (an RGBA8 page written from a
//            CompressedTexture would ZERO the layer — the member goes black).
//   PART 8 — OFF arm: with no pooled world the producer holds nothing, and the
//            verdict seam is a no-op against the atlas's own handler.
//
// Run:  cd apps/holtburger-web && node harness/test_rsid_marker.mjs

import * as THREE from "three";
import {
  stampRsId,
  materialRsId,
  upgradeMaterialToBc7,
  initBc7Source,
  bc7Source,
  bc7Stats,
  texStats,
  registerAtlasRefeed,
  atlasRefeed,
  makeBc7Texture,
  parseHbc7,
  bc7LevelBytes,
  HBC7_HEADER_BYTES,
  _setBc7SupportForTest,
  _resetBc7ForTest,
  _resetTexCompressedOnlyForTest,
  initTexCompressedOnly,
} from "../scene3d/bc7_textures.js";
import {
  _atlasRefeedImpl,
  _resetStatAtlasForTest,
  _statAtlasStatsForTest,
  addSingletonsToCrossLbAtlas,
} from "../scene3d/static_atlas.js";
import {
  initPoolWorld,
  addSingletonsToPools,
  poolWorldCensus,
  poolWorldActive,
  getPoolWorld,
  _resetPoolWorldForTest,
} from "../scene3d/pool_producer.js";
import { _resetDrawPoolsForTest, getPoolRegistry } from "../scene3d/pool_registry.js";
import { ClassMaterialRegistry } from "../scene3d/pool_material.js";
import { axisRecordOf, classKeyOf } from "../scene3d/pool_class_key.js";
import { MaterialCache } from "../scene3d/materials.js";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}

function setSearch(search) {
  globalThis.window = globalThis.window || {};
  globalThis.window.location = { search };
}

/** A valid HBC7 container with a full halving chain (the tex-family fixture). */
function makeHbc7(w, h, seed = 0) {
  const levels = [];
  let lw = w, lh = h;
  for (;;) {
    levels.push({ w: lw, h: lh, bytes: bc7LevelBytes(lw, lh) });
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  const total = levels.reduce((a, l) => a + l.bytes, 0);
  const buf = new Uint8Array(HBC7_HEADER_BYTES + total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x37434248, true); // "HBC7"
  dv.setUint32(4, w, true);
  dv.setUint32(8, h, true);
  dv.setUint32(12, Math.ceil(w / 4), true);
  dv.setUint32(16, Math.ceil(h / 4), true);
  let off = HBC7_HEADER_BYTES;
  levels.forEach((l, i) => { buf.fill((seed + i + 1) & 0xff, off, off + l.bytes); off += l.bytes; });
  return buf;
}

function triGeom(verts = 6) {
  const g = new THREE.BufferGeometry();
  const n = Math.max(3, verts);
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const idx = [];
  for (let i = 0; i + 2 < n; i += 3) idx.push(i, i + 1, i + 2);
  g.setIndex(idx);
  return g;
}

function pageTex(edge) {
  const t = new THREE.DataTexture(new Uint8Array(edge * edge * 4), edge, edge, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** The F-11.3 flag chain a pooled world requires (test_draw_pools' ARMED). */
const ARMED = "?drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on";

// ===========================================================================
console.log("PART 1 — the stamp primitive + the ONE reader");
// ===========================================================================
{
  _resetBc7ForTest();
  const RS = 0x06001234;
  const mat = { userData: {} };
  check("stampRsId returns the id it stamped", stampRsId(mat, RS) === RS);
  check("__texRsId is written", mat.userData.__texRsId === RS);
  check("stamp is counted", bc7Stats().rsIdStamped === 1);
  check("stamp is idempotent (no double count)",
    stampRsId(mat, RS) === RS && bc7Stats().rsIdStamped === 1);
  check("rsId 0 stamps nothing", stampRsId({ userData: {} }, 0) === 0 && bc7Stats().rsIdStamped === 1);
  check("a null material is a no-op", stampRsId(null, RS) === 0);

  // In place, never a spread: materials.js installs non-enumerable live
  // handles on userData and a rebuild would drop them.
  const live = { userData: {} };
  Object.defineProperty(live.userData, "__liveHandle", { value: 42, enumerable: false });
  const udRef = live.userData;
  stampRsId(live, RS);
  check("userData object identity is preserved (no spread)", live.userData === udRef);
  check("non-enumerable live handles survive the stamp", live.userData.__liveHandle === 42);

  // materialRsId — one total reader, tier-specific markers first.
  check("reader: __texRsId alone", materialRsId({ userData: { __texRsId: RS } }) === RS);
  check("reader: __pvwRsId beats __texRsId",
    materialRsId({ userData: { __texRsId: 1, __pvwRsId: RS } }) === RS);
  check("reader: __bc7RsId beats both",
    materialRsId({ userData: { __texRsId: 1, __pvwRsId: 2, __bc7RsId: RS } }) === RS);
  check("reader: nothing stamped ⇒ 0", materialRsId({ userData: {} }) === 0);
  check("reader: no userData ⇒ 0", materialRsId({}) === 0 && materialRsId(null) === 0);
  _resetBc7ForTest();
}

// ===========================================================================
console.log("PART 2 — every bc7-born material class carries the marker");
// ===========================================================================
{
  const RS = 0x06002345;

  // (a) THE HOLD-OUT STATE ITSELF: `__bc7Pending` and the key are written in
  //     the same synchronous breath, so a refused member is ALWAYS filable.
  _resetBc7ForTest();
  setSearch("");
  _setBc7SupportForTest(true);
  const full = deferred();
  initBc7Source({ fetchImpl: () => full.promise, preFetchImpl: async () => null });
  const matA = { userData: {}, map: null };
  const pA = upgradeMaterialToBc7(matA, RS);
  check("X6: __bc7Pending set before the await", matA.userData.__bc7Pending === true);
  check("X6: …and the rsId is stamped in the SAME breath (the 363-class fix)",
    matA.userData.__texRsId === RS && materialRsId(matA) === RS);
  full.resolve(makeHbc7(8, 8, 1));
  await pA;
  check("X6: the landed tier writes __bc7RsId over the same id",
    matA.userData.__bc7RsId === RS && materialRsId(matA) === RS);
  check("X6: the stamp is NOT cleared by the verdict (identity, not state)",
    matA.userData.__texRsId === RS && matA.userData.__bc7Pending === undefined);

  // (b) the already-cached leg takes no pending marker but IS stamped.
  const matB = { userData: {}, map: null };
  const pB = upgradeMaterialToBc7(matB, RS);
  check("X6 cached leg: no pending marker (record already known)",
    matB.userData.__bc7Pending === undefined);
  check("X6 cached leg: stamped anyway", matB.userData.__texRsId === RS);
  await pB;

  // (c) past the ask-once gate: a material rebuilt for a DID that already
  //     asked never reaches upgradeMaterialToBc7, so the stamp lives at the
  //     _maybeUpgradeToBc7 site as well.
  const DID = 0x08000055;
  const mc = new MaterialCache();
  const m1 = new THREE.MeshStandardMaterial();
  const m2 = new THREE.MeshStandardMaterial();
  mc._maybeUpgradeToBc7(DID, m1, RS);
  mc._maybeUpgradeToBc7(DID, m2, RS); // second material, same DID: ask skipped
  check("ask-once gate: the FIRST material is stamped", materialRsId(m1) === RS);
  check("ask-once gate: the REBUILT material is stamped too", materialRsId(m2) === RS);
  check("a non-RenderSurface id is never stamped",
    (() => { const m = new THREE.MeshStandardMaterial(); mc._maybeUpgradeToBc7(0x08000056, m, 0x08001111); return materialRsId(m) === 0; })());

  // (d) variant clones inherit it through the `{...base.userData}` re-seat
  //     every clone site in materials.js performs.
  const base = new THREE.MeshStandardMaterial();
  stampRsId(base, RS);
  const cloned = base.clone();
  check("three's clone carries the marker (variant families inherit)", materialRsId(cloned) === RS);
  const reseated = base.clone();
  reseated.userData = { ...(base.userData || {}), __cacheOwned: true };
  check("the materials.js re-seat shape carries it too", materialRsId(reseated) === RS);

  await tick();
  _resetBc7ForTest();
}

// ===========================================================================
console.log("PART 2b — the ST5 preview-born class stamps alongside __pvwRsId");
// ===========================================================================
{
  const RS = 0x06003456;
  const DID = 0x08000077;
  _resetBc7ForTest();
  _resetTexCompressedOnlyForTest();
  setSearch("?texCompressedOnly=on");
  _setBc7SupportForTest(true);
  initBc7Source({});
  const pvw = makeHbc7(16, 16, 0x60);
  initTexCompressedOnly({
    wasmNs: {
      surface_meta_sync: (d) => (d === DID ? JSON.stringify({
        kind: "textured", surfaceType: 0, translucency: 0, luminosity: 0,
        diffuse: 0, rsId: RS, palId: 0, aliased: false, category: null,
        roughnessOverride: null, normalScaleOverride: null,
      }) : ""),
      // tier bits: PVW present, full tier ABSENT (so no upgrade is kicked)
      pack_texref: (rs) => (rs === RS ? ((0b01 << 8) | 0x44) : -1),
      pack_pvw_blocks: (rs) => (rs === RS ? pvw.slice() : new Uint8Array(0)),
    },
    controller: { armed: true },
  });
  const mc = new MaterialCache();
  const mat = await mc.get(DID, async () => [null]);
  check("preview-born material carries __pvwRsId", mat.userData.__pvwRsId === RS);
  check("…and the universal marker", mat.userData.__texRsId === RS);
  check("…and reads through the ONE reader", materialRsId(mat) === RS);
  check("preview-born stamps are counted", texStats().tiers.rsIdStamped >= 1);
  _resetBc7ForTest();
  _resetTexCompressedOnlyForTest();
  setSearch("");
}

// ===========================================================================
console.log("PART 3 — the verdict seam fires on EVERY settled outcome");
// ===========================================================================
{
  const RS = 0x06004567;
  const armSeam = (fetchImpl) => {
    _resetBc7ForTest();
    setSearch("");
    _setBc7SupportForTest(true);
    initBc7Source({ fetchImpl, preFetchImpl: async () => null });
    const seen = [];
    registerAtlasRefeed((rs) => { seen.push(rs); return 0; });
    return seen;
  };

  // landed
  {
    const d = deferred();
    const seen = armSeam(() => d.promise);
    const mat = { userData: {}, map: null };
    const p = upgradeMaterialToBc7(mat, RS);
    check("no refeed while the verdict is in flight", seen.length === 0);
    d.resolve(makeHbc7(8, 8, 2));
    await p;
    check("LANDED verdict fires atlasRefeed with the rsId", seen.length === 1 && seen[0] === RS);
    check("resolved + delivered are both counted",
      bc7Stats().rsVerdictsResolved === 1 && bc7Stats().rsRefeedsFired === 1);
  }
  // absent (fetch resolves null → no parse, no swap)
  {
    const seen = armSeam(async () => null);
    const mat = { userData: {}, map: null };
    const res = await upgradeMaterialToBc7(mat, RS);
    check("ABSENT record: no swap", res === false && mat.map === null);
    check("…but the verdict SETTLED, so the seam fires", seen.length === 1 && seen[0] === RS);
  }
  // failed (fetch rejects)
  {
    const seen = armSeam(async () => { throw new Error("net down"); });
    const mat = { userData: {}, map: null };
    await upgradeMaterialToBc7(mat, RS);
    check("FAILED fetch: pending cleared", mat.userData.__bc7Pending === undefined);
    check("…and the seam fires (a member held on it is admissible now)",
      seen.length === 1 && seen[0] === RS);
  }
  // the PRE phase alone must NOT fire: the verdict is not settled.
  {
    _resetBc7ForTest();
    setSearch("");
    _setBc7SupportForTest(true);
    const pre = deferred();
    const fullD = deferred();
    initBc7Source({ fetchImpl: () => fullD.promise, preFetchImpl: () => pre.promise });
    const seen = [];
    registerAtlasRefeed((rs) => { seen.push(rs); return 0; });
    const mat = { userData: {}, map: null };
    const p = upgradeMaterialToBc7(mat, RS);
    pre.resolve(makeHbc7(4, 4, 3));
    await tick();
    check("pre-phase swap does NOT fire the seam (verdict still open)",
      mat.userData.__bc7Pre === true && seen.length === 0);
    check("…and the member is still HELD (pending marker intact)",
      mat.userData.__bc7Pending === true);
    fullD.resolve(makeHbc7(8, 8, 4));
    await p;
    check("the full phase fires it exactly once", seen.length === 1);
  }
  // no producer registered: resolved counts, delivered does not, nothing throws.
  {
    _resetBc7ForTest();
    setSearch("");
    _setBc7SupportForTest(true);
    initBc7Source({ fetchImpl: async () => makeHbc7(8, 8, 5), preFetchImpl: async () => null });
    registerAtlasRefeed(null);
    const mat = { userData: {}, map: null };
    await upgradeMaterialToBc7(mat, RS);
    check("unregistered seam: resolved counted, fired NOT",
      bc7Stats().rsVerdictsResolved === 1 && bc7Stats().rsRefeedsFired === 0);
    check("atlasRefeed with no handler is a 0 no-op", atlasRefeed(RS) === 0);
  }
  _resetBc7ForTest();
}

// ===========================================================================
console.log("PART 4 — the pool re-offer, end to end (the 363 hold-outs)");
// ===========================================================================
{
  const RS = 0x06005678;
  _resetBc7ForTest();
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetStatAtlasForTest();
  setSearch(ARMED);
  _setBc7SupportForTest(true);
  const d = deferred();
  initBc7Source({ fetchImpl: () => d.promise, preFetchImpl: async () => null });

  const group = new THREE.Group();
  const world = initPoolWorld({ THREE, group, search: ARMED });
  check("pooled world armed", world !== null && poolWorldActive() === true);

  // A member whose BC7 verdict is in flight: exactly the live arm's class.
  const mat = new THREE.MeshStandardMaterial({ map: pageTex(256) });
  mat.userData = { surfaceDid: 0x08000088 };
  const pending = upgradeMaterialToBc7(mat, RS);
  check("the member is in the refused state", mat.userData.__bc7Pending === true);

  const node = new THREE.Mesh(triGeom(6), mat);
  const r = addSingletonsToPools([node], {}, { domain: "st", lbKey: 0x40400000 });
  check("refused: comes back as passthrough (RENDERS, on the legacy path)",
    r.pooled === 0 && r.passthrough[0] === node);
  let c = poolWorldCensus();
  check("refusal reason is bc7Pending", c.classPages.refused.bc7Pending === 1);
  check("HELD OUT under its rsId — the counter that read 0 on the live arm",
    c.producer.heldOut === 1 && c.producer.holdoutRsIds === 1);
  check("no marker gap", c.producer.heldOutNoRsId === 0);
  group.add(node); // the producer call sites' contract for passthrough

  // The full tier lands → the verdict seam → the pool re-offer.
  d.resolve(makeHbc7(256, 256, 0x11));
  await pending;
  await tick();
  c = poolWorldCensus();
  check("re-offered exactly once", c.producer.reOffered === 1);
  check("ADMITTED on the second offer", c.producer.reOfferAdmitted === 1);
  check("nothing refused on the re-offer", Object.keys(c.producer.reOfferRefused).length === 0,
    JSON.stringify(c.producer.reOfferRefused));
  check("the hold-out ledger is drained", c.producer.holdoutRsIds === 0);
  check("the admitted member LEFT the legacy scene graph",
    node.parent === null && group.children.every((o) => o !== node));
  const reg = getPoolRegistry();
  check("…and lives in a pool now", reg.pools.size === 1 && [...reg.pools.values()][0].instances === 1);
  check("the pool's page is the BC7 class page (format from the LIVE texture)",
    [...reg.pools.values()][0].mesh.material.userData.__poolClassMat === true);
  check("accounting closes: heldOut = reOffered + stale + still-held",
    c.producer.heldOut === c.producer.reOffered + c.producer.reOfferStale);
  check("the hold-out mark is cleared from the node", node.userData.__poolHeldRs === undefined);

  // NOTHING CAN STICK (F-11.17): a re-offer that arrives while the member is
  // STILL pending must RE-FILE it, not drop it from the ledger — otherwise
  // the second (real) verdict finds nothing to re-offer and the member is
  // stranded exactly as the missing marker stranded it.
  const RS3 = 0x0600567a;
  const d3 = deferred();
  const mat3 = new THREE.MeshStandardMaterial({ map: pageTex(256) });
  mat3.userData = { surfaceDid: 0x0800008f };
  const pend3 = upgradeMaterialToBc7(mat3, RS3);
  const node3 = new THREE.Mesh(triGeom(6), mat3);
  addSingletonsToPools([node3], {}, { domain: "st", lbKey: 0x40400000 });
  group.add(node3);
  const heldBefore = poolWorldCensus().producer.heldOut;
  atlasRefeed(RS3); // an early/unrelated refeed for the same rsId
  const c2 = poolWorldCensus();
  check("an early re-offer while still pending refuses bc7Pending",
    c2.producer.reOfferRefused.bc7Pending === 1);
  check("…and RE-FILES the member (the ledger re-arms)",
    c2.producer.heldOut === heldBefore + 1 && c2.producer.holdoutRsIds === 1);
  d3.resolve(makeHbc7(256, 256, 0x14));
  // the injected fetchImpl is shared and already resolved; settle RS3's own
  // promise, which fires the seam a second time.
  await pend3;
  await tick();
  const c3 = poolWorldCensus();
  check("the real verdict admits the re-filed member",
    c3.producer.reOfferAdmitted === 2 && node3.parent === null);

  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetBc7ForTest();
}

// ===========================================================================
console.log("PART 5 — a re-offer refused AGAIN is counted, per reason");
// ===========================================================================
{
  const RS = 0x06006789;
  _resetBc7ForTest();
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  setSearch(ARMED);
  _setBc7SupportForTest(true);
  const d = deferred();
  initBc7Source({ fetchImpl: () => d.promise, preFetchImpl: async () => null });
  const group = new THREE.Group();
  initPoolWorld({ THREE, group, search: ARMED });

  const mat = new THREE.MeshStandardMaterial({ map: pageTex(256) });
  mat.userData = { surfaceDid: 0x08000089 };
  const pending = upgradeMaterialToBc7(mat, RS);
  const node = new THREE.Mesh(triGeom(6), mat);
  addSingletonsToPools([node], {}, { domain: "st", lbKey: 0x40400000 });
  group.add(node);
  check("held out", poolWorldCensus().producer.heldOut === 1);

  // Between the hold-out and the verdict the member becomes a MECH-B
  // vertex-deformed variant — still inadmissible when re-offered.
  mat.userData.__vfxSetKey = "deformation.windSwayGpu";
  d.resolve(makeHbc7(256, 256, 0x12));
  await pending;
  await tick();
  const c = poolWorldCensus();
  check("re-offered", c.producer.reOffered === 1);
  check("refused AGAIN, under its own reason", c.producer.reOfferRefused.deformed === 1,
    JSON.stringify(c.producer.reOfferRefused));
  check("not admitted", c.producer.reOfferAdmitted === 0);
  check("and it keeps rendering on the legacy path", node.parent === group);
  check("the ledger is still drained (no permanent re-offer loop)",
    c.producer.holdoutRsIds === 0);

  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetBc7ForTest();
}

// ===========================================================================
console.log("PART 6 — ledger edges: dupes, the marker gap, stale nodes");
// ===========================================================================
{
  const RS = 0x0600789a;
  _resetBc7ForTest();
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  setSearch(ARMED);
  _setBc7SupportForTest(true);
  const d = deferred();
  initBc7Source({ fetchImpl: () => d.promise, preFetchImpl: async () => null });
  const group = new THREE.Group();
  initPoolWorld({ THREE, group, search: ARMED });

  // (a) DUPLICATE: the same node offered twice while pending is filed ONCE —
  //     a second filing would re-offer it twice and double-draw the prop.
  const mat = new THREE.MeshStandardMaterial({ map: pageTex(256) });
  mat.userData = { surfaceDid: 0x0800008a };
  const pending = upgradeMaterialToBc7(mat, RS);
  const node = new THREE.Mesh(triGeom(6), mat);
  addSingletonsToPools([node], {}, { domain: "st", lbKey: 0x40400000 });
  addSingletonsToPools([node], {}, { domain: "st", lbKey: 0x40400000 });
  let c = poolWorldCensus();
  check("a re-offered-while-pending node is filed once", c.producer.heldOut === 1);
  check("the duplicate is counted, not dropped silently", c.producer.heldOutDupes === 1);
  group.add(node);

  // (b) THE MARKER GAP: a material with no marker at all cannot be filed.
  const bare = new THREE.MeshStandardMaterial({ map: pageTex(256) });
  bare.userData = { surfaceDid: 0x0800008b, __bc7Pending: true };
  const bareNode = new THREE.Mesh(triGeom(6), bare);
  addSingletonsToPools([bareNode], {}, { domain: "st", lbKey: 0x40400000 });
  c = poolWorldCensus();
  check("an unmarked member is refused bc7Pending like any other",
    c.classPages.refused.bc7Pending === 3);
  check("…and its unfilability is COUNTED (this is the gap the stamp closes)",
    c.producer.heldOutNoRsId === 1);
  check("…and it still renders (passthrough)", c.producer.heldOut === 1);

  // (c) STALE: a held-out node whose landblock died while the texture was in
  //     flight must never be resurrected into a pool.
  const mat2 = new THREE.MeshStandardMaterial({ map: pageTex(256) });
  mat2.userData = { surfaceDid: 0x0800008c };
  const RS2 = 0x0600789b;
  const pending2 = upgradeMaterialToBc7(mat2, RS2); // same injected fetchImpl
  const dead = new THREE.Mesh(triGeom(6), mat2);
  addSingletonsToPools([dead], {}, { domain: "st", lbKey: 0x41400000 });
  group.add(dead);
  group.remove(dead); // the LB evicted while the fetch was outstanding
  d.resolve(makeHbc7(256, 256, 0x13));
  await pending;
  await tick();
  c = poolWorldCensus();
  check("the LIVE hold-out was admitted", c.producer.reOfferAdmitted === 1);
  const reg = getPoolRegistry();
  const poolsBefore = reg.pools.size;
  // The evicted node's own rsId settles through its own upgrade promise
  // (same injected fetchImpl, already resolved above).
  await pending2;
  await tick();
  c = poolWorldCensus();
  check("the evicted node is dropped as STALE, never re-offered",
    c.producer.reOfferStale === 1 && c.producer.reOffered === 1);
  check("…and no pool was created for it", reg.pools.size === poolsBefore);

  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetBc7ForTest();
}

// ===========================================================================
console.log("PART 7 — refeedRsId guards: dims AND format");
// ===========================================================================
{
  const cm = new ClassMaterialRegistry({ warn: () => {} });
  const RS = 0x06008888;
  const mk = (tex) => {
    const m = new THREE.MeshStandardMaterial({ map: tex });
    m.userData = { surfaceDid: 0x08000090, __texRsId: RS };
    return m;
  };
  const axes = (m) => axisRecordOf(m, { domain: "st", castShadow: false, receiveShadow: false });

  const m = mk(pageTex(256));
  const rec = axes(m);
  const key = classKeyOf(rec);
  check("member admitted into an RGBA8 page", cm.admit(key, m, rec).ok === true);
  check("the layer is filed under the UNIVERSAL marker (was 0 before)",
    cm.classesForRsId(RS).length === 1);

  // Dims mismatch: the upgraded map is a different page tier entirely.
  m.map = pageTex(512);
  check("a dims-mismatched refeed is refused + counted",
    cm.refeedRsId(RS) === 0 && cm.census().layers.refeedDimMismatch === 1);

  // Format mismatch: same dims, but the map is now a CompressedTexture and the
  // page is RGBA8. Writing it would find no image.data and ZERO the layer.
  const bc7Tex = makeBc7Texture(parseHbc7(makeHbc7(256, 256, 0x21)));
  m.map = bc7Tex;
  const before = [...cm.classes.values()][0].arrays.diff.image.data.slice(0, 8);
  check("a format-mismatched refeed is refused + counted",
    cm.refeedRsId(RS) === 0 && cm.census().layers.refeedFormatMismatch === 1);
  const after = [...cm.classes.values()][0].arrays.diff.image.data.slice(0, 8);
  check("…and the layer was NOT zeroed (the member never goes black)",
    before.every((v, i) => v === after[i]));

  // A legal refeed (same dims, same format) rewrites the layer.
  m.map = pageTex(256);
  m.map.image.data.fill(7);
  check("a same-dims same-format refeed rewrites the layer", cm.refeedRsId(RS) === 1);
  check("…with the new pixels", [...cm.classes.values()][0].arrays.diff.image.data[0] === 7);
  cm.dispose();
}

// ===========================================================================
console.log("PART 8 — OFF arm: no pooled world, no behaviour change");
// ===========================================================================
{
  const RS = 0x06009999;
  _resetBc7ForTest();
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetStatAtlasForTest();
  setSearch(""); // no flag chain at all
  _setBc7SupportForTest(true);
  const d = deferred();
  initBc7Source({ fetchImpl: () => d.promise, preFetchImpl: async () => null });
  registerAtlasRefeed(_atlasRefeedImpl); // the atlas is the registered producer

  check("no pooled world arms without the chain",
    initPoolWorld({ THREE, search: "" }) === null && getPoolWorld() === null);

  const mat = new THREE.MeshStandardMaterial({ map: pageTex(256) });
  mat.userData = { surfaceDid: 0x08000091 };
  const pending = upgradeMaterialToBc7(mat, RS);
  const node = new THREE.Mesh(triGeom(6), mat);
  const r = addSingletonsToPools([node], {}, { domain: "st", lbKey: 0x40400000 });
  check("disarmed producer: every node passes through untouched",
    r.pooled === 0 && r.passthrough[0] === node);
  check("nothing is held out (no ledger exists)", node.userData.__poolHeldRs === undefined);

  // The atlas keeps its own pre-ST5 shape: a pending node is DEFERRED and
  // untracked, so the verdict's refeed finds nothing and changes nothing.
  const scene3d = { staticsGroup: new THREE.Group() };
  const atlasRes = addSingletonsToCrossLbAtlas([node], scene3d);
  const as = _statAtlasStatsForTest();
  check("atlas defers the pending node exactly as before",
    atlasRes.passthrough.length === 1 && as.ptBc7Deferred === 1 && as.atlased === 0);
  check("…and does NOT track it (pre-ST5 shape, untouched)", as.ptFullHoldout === 0);

  d.resolve(makeHbc7(256, 256, 0x31));
  await pending;
  await tick();
  check("the verdict fired the seam", bc7Stats().rsRefeedsFired === 1);
  check("…and the atlas-side handler was a 0 no-op (nothing tracked)",
    _statAtlasStatsForTest().refeeds === 0 && _statAtlasStatsForTest().rehomedNodes === 0);
  check("the node's rendering is unchanged (still the caller's to place)",
    node.parent === null);

  _resetStatAtlasForTest();
  _resetBc7ForTest();
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "RSID-MARKER ✅" : "RSID-MARKER ❌");
process.exit(failed === 0 ? 0 : 1);
