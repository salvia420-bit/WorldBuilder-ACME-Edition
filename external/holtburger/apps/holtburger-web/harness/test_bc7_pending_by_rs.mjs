// harness/test_bc7_pending_by_rs.mjs — `?bc7PendingByRs` (STALE-CLONE, 2026-10-25): a `__bc7Pending`
// flag COPIED onto a variant clone stops deferring once its rsId's upgrade has settled.
//
// WHY THIS SUITE EXISTS
// ---------------------
// The floor-bias / front-side / static-bias / cell-baked clones are minted with
// `{...base.userData}`; a clone minted while its base waits on a BC7 verdict copies
// `__bc7Pending: true`, and the settle clears the BASE's copy only (buildings.js R1). On the 1070
// (Holtburg, full chain) 110 drawn materials carried the copy — 104 with the full record cached, 6
// with an absent verdict, none in flight — and 177 nodes were held out of the draw pools on them
// for the whole session. `bc7PendingOn` now asks the per-rsId wait that `upgradeMaterialToBc7`
// opens and closes.
//
// WHAT MUST HOLD:
//   PART 1 — back-compat: a flag with no history (hand-set fixture, never asked) reads pending.
//   PART 2 — while the upgrade is open, the base AND a clone copied from it read pending (and defer).
//   PART 3 — after the full record lands, the clone's copied flag no longer defers; counted.
//   PART 4 — ordering: the refeed fired at the verdict already sees the wait closed, so the
//            re-offer it triggers admits the clone.
//   PART 5 — absent and failed verdicts close the wait the same way.
//   PART 6 — `?bc7PendingByRs=off` keeps the copied-flag read (the escape).
//   PART 7 — a NEW wait on the same rsId (record evicted, asked again) makes the copy defer again
//            until that wait settles.
//
// Run:  cd apps/holtburger-web && node harness/test_bc7_pending_by_rs.mjs

import {
  upgradeMaterialToBc7,
  initBc7Source,
  bc7Source,
  bc7Stats,
  bc7PendingOn,
  registerAtlasRefeed,
  bc7LevelBytes,
  HBC7_HEADER_BYTES,
  _setBc7SupportForTest,
  _resetBc7ForTest,
} from "../scene3d/bc7_textures.js";
import { bc7AtlasShouldDefer, _atlasRefeedImpl } from "../scene3d/static_atlas.js";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}

function setSearch(search) {
  globalThis.window = globalThis.window || {};
  globalThis.window.location = { search };
}

/** A valid HBC7 container with a full halving chain. */
function makeHbc7(w, h, seed = 0) {
  const levels = [];
  let lw = w, lh = h;
  for (;;) {
    levels.push({ bytes: bc7LevelBytes(lw, lh) });
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

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** What the clone sites do: a fresh material whose userData is a spread copy of the base's. */
const cloneOf = (base) => ({ userData: { ...base.userData }, map: base.map });

/** One armed source whose full fetch is held until the test resolves it. */
function arm(search = "") {
  _resetBc7ForTest();
  setSearch(search);
  _setBc7SupportForTest(true);
  const full = deferred();
  initBc7Source({ fetchImpl: () => full.promise, preFetchImpl: async () => null });
  return full;
}

// ===========================================================================
console.log("PART 1 — a flag with no history still reads pending");
// ===========================================================================
{
  arm();
  check("hand-set flag, no rsId ⇒ pending", bc7PendingOn({ userData: { __bc7Pending: true } }) === true);
  check("hand-set flag on a never-asked rsId ⇒ pending",
    bc7PendingOn({ userData: { __bc7Pending: true, __texRsId: 0x06000001 } }) === true);
  check("no flag ⇒ not pending", bc7PendingOn({ userData: { __texRsId: 0x06000001 } }) === false);
  check("…and the atlas gate agrees",
    bc7AtlasShouldDefer({ userData: { __bc7Pending: true, __texRsId: 0x06000001 } }) === true);
  check("nothing counted as stale", bc7Stats().stalePendingIgnored === 0);
}

// ===========================================================================
console.log("PART 2 + 3 — the open wait defers base and clone; the landed verdict releases the clone");
// ===========================================================================
{
  const RS = 0x06002001;
  const full = arm();
  const base = { userData: {}, map: null };
  const p = upgradeMaterialToBc7(base, RS);
  const clone = cloneOf(base);
  check("the clone copied the marker", clone.userData.__bc7Pending === true && clone.userData.__texRsId === RS);
  check("open: base pending", bc7PendingOn(base) === true);
  check("open: clone pending", bc7PendingOn(clone) === true);
  check("open: the atlas defers the clone", bc7AtlasShouldDefer(clone) === true);
  full.resolve(makeHbc7(8, 8, 1));
  await p;
  await tick();
  check("landed: base flag cleared", base.userData.__bc7Pending === undefined && base.userData.__bc7 === true);
  check("landed: the clone still CARRIES its copy", clone.userData.__bc7Pending === true);
  const before = bc7Stats().stalePendingIgnored;
  check("landed: …but it no longer reads pending", bc7PendingOn(clone) === false);
  check("landed: …and the atlas admits it", bc7AtlasShouldDefer(clone) === false);
  check("stale reads are counted", bc7Stats().stalePendingIgnored === before + 2,
    `${bc7Stats().stalePendingIgnored} vs ${before}+2`);
}

// ===========================================================================
console.log("PART 4 — the refeed fired at the verdict already sees the wait closed");
// ===========================================================================
{
  const RS = 0x06002002;
  const full = arm();
  const base = { userData: {}, map: null };
  const p = upgradeMaterialToBc7(base, RS);
  const clone = cloneOf(base);
  const seen = [];
  registerAtlasRefeed((rs) => { seen.push({ rs, pending: bc7PendingOn(clone) }); return 0; });
  full.resolve(makeHbc7(8, 8, 2));
  await p;
  await tick();
  check("the refeed fired once for the rsId", seen.length === 1 && seen[0].rs === RS, JSON.stringify(seen));
  check("…and the copied flag read NOT pending inside it", seen.length === 1 && seen[0].pending === false);
  registerAtlasRefeed(_atlasRefeedImpl); // the module's own handler, as at load
}

// ===========================================================================
console.log("PART 5 — absent and failed verdicts close the wait too");
// ===========================================================================
{
  const RS = 0x06002003;
  const full = arm();
  const base = { userData: {}, map: null };
  const p = upgradeMaterialToBc7(base, RS);
  const clone = cloneOf(base);
  full.resolve(new Uint8Array(0)); // empty payload = absent
  await p;
  await tick();
  check("absent: base flag cleared, no swap", base.userData.__bc7Pending === undefined && !base.userData.__bc7);
  check("absent: the clone's copy no longer defers", bc7PendingOn(clone) === false);

  const RS2 = 0x06002004;
  const full2 = arm();
  const base2 = { userData: {}, map: null };
  const p2 = upgradeMaterialToBc7(base2, RS2);
  const clone2 = cloneOf(base2);
  full2.reject(new Error("network"));
  await p2;
  await tick();
  check("failed: base flag cleared", base2.userData.__bc7Pending === undefined);
  check("failed: the clone's copy no longer defers", bc7PendingOn(clone2) === false);
}

// ===========================================================================
console.log("PART 6 — ?bc7PendingByRs=off keeps the copied-flag read");
// ===========================================================================
{
  const RS = 0x06002005;
  const full = arm("?bc7PendingByRs=off");
  const base = { userData: {}, map: null };
  const p = upgradeMaterialToBc7(base, RS);
  const clone = cloneOf(base);
  full.resolve(makeHbc7(8, 8, 3));
  await p;
  await tick();
  check("off: base settled", base.userData.__bc7Pending === undefined);
  check("off: the copy still reads pending (pre-2026-10-25 behaviour)", bc7PendingOn(clone) === true);
  check("off: the atlas still defers it", bc7AtlasShouldDefer(clone) === true);
  check("off: nothing counted as stale", bc7Stats().stalePendingIgnored === 0);
}

// ===========================================================================
console.log("PART 7 — a new wait on the same rsId makes the copy defer again");
// ===========================================================================
{
  const RS = 0x06002006;
  _resetBc7ForTest();
  setSearch("");
  _setBc7SupportForTest(true);
  const fulls = [deferred(), deferred()];
  let n = 0;
  initBc7Source({ fetchImpl: () => fulls[Math.min(n++, 1)].promise, preFetchImpl: async () => null });
  const base = { userData: {}, map: null };
  const p = upgradeMaterialToBc7(base, RS);
  const clone = cloneOf(base);
  fulls[0].resolve(makeHbc7(8, 8, 4));
  await p;
  await tick();
  check("first wait settled: the copy is released", bc7PendingOn(clone) === false);
  bc7Source()._cache.delete(RS); // the record budget evicted it
  const base2 = { userData: {}, map: null };
  const p2 = upgradeMaterialToBc7(base2, RS);
  check("asked again: the new base waits", base2.userData.__bc7Pending === true);
  check("asked again: the old copy defers again while that wait is open", bc7PendingOn(clone) === true);
  fulls[1].resolve(makeHbc7(8, 8, 5));
  await p2;
  await tick();
  check("second wait settled: released again", bc7PendingOn(clone) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "BC7-PENDING-BY-RS ✅" : "BC7-PENDING-BY-RS ❌");
process.exit(failed === 0 ? 0 : 1);
