// P1 preview-first (2026-08-04) — two-phase upgradeMaterialToBc7 contract.
// No GPU, no wasm: fetchImpl/preFetchImpl injected, HBC7 payloads synthesized.
// Run: node test_bc7_pre_phase.mjs
import {
  initBc7Source,
  upgradeMaterialToBc7,
  _setBc7SupportForTest,
  _resetBc7ForTest,
  bc7Stats,
} from "./scene3d/bc7_textures.js";

const blocks = (n) => Math.ceil(n / 4);
function hbc7(w, h) {
  // header + full halving chain to 1x1, zero-filled block data
  const lvls = [];
  let lw = w, lh = h;
  for (;;) {
    lvls.push(blocks(lw) * blocks(lh) * 16);
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  const total = 20 + lvls.reduce((a, b) => a + b, 0);
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x37434248, true);
  dv.setUint32(4, w, true);
  dv.setUint32(8, h, true);
  dv.setUint32(12, blocks(w), true);
  dv.setUint32(16, blocks(h), true);
  return buf;
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

function freshMat() {
  let disposed = [];
  const tex = (name) => ({
    name,
    wrapS: 1000,
    wrapT: 1000,
    colorSpace: "srgb",
    dispose() {
      disposed.push(this.name);
    },
  });
  return { mat: { map: tex("rgba8"), userData: {} }, disposed };
}

let failures = 0;
function check(cond, label) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", label);
  } else {
    console.log("ok:", label);
  }
}

async function run() {
  const RS = 0x06001234;

  // --- case 1: pre lands first, then full — two swaps, both reported ---
  {
    _resetBc7ForTest();
    _setBc7SupportForTest(true);
    const pre = deferred();
    const full = deferred();
    initBc7Source({ fetchImpl: () => full.promise, preFetchImpl: () => pre.promise });
    const { mat } = freshMat();
    const swaps = [];
    const p = upgradeMaterialToBc7(mat, RS, (res) => swaps.push(res.replaced?.name ?? res.replaced?.constructor?.name ?? "tex"));
    pre.resolve(hbc7(2, 2));
    await new Promise((r) => setTimeout(r, 10));
    check(mat.map && mat.map.image && mat.map.image.width === 2, "case1: pre texture swapped in first (2x2)");
    check(mat.userData.__bc7Pre === true, "case1: __bc7Pre marker set during pre phase");
    const preTex = mat.map;
    full.resolve(hbc7(8, 8));
    const res = await p;
    check(res && res.swapped === true, "case1: full phase resolves swapped");
    check(mat.map.image.width === 8, "case1: full texture (8x8) replaced pre");
    check(res.replaced === preTex, "case1: full phase replaced the PRE texture");
    check(swaps.length === 2, "case1: onSwap called exactly twice");
    check(mat.userData.__bc7 === true && !mat.userData.__bc7Pre, "case1: final markers");
    check(bc7Stats().preSwaps === 1, "case1: preSwaps tallied");
  }

  // --- case 2: full lands first — pre result discarded, one swap ---
  {
    _resetBc7ForTest();
    _setBc7SupportForTest(true);
    const pre = deferred();
    const full = deferred();
    initBc7Source({ fetchImpl: () => full.promise, preFetchImpl: () => pre.promise });
    const { mat } = freshMat();
    const swaps = [];
    const p = upgradeMaterialToBc7(mat, RS, () => swaps.push(1));
    full.resolve(hbc7(8, 8));
    await p;
    pre.resolve(hbc7(2, 2));
    await new Promise((r) => setTimeout(r, 10));
    check(mat.map.image.width === 8, "case2: late pre never overwrites full");
    check(swaps.length === 1, "case2: onSwap called once");
    check(bc7Stats().preSwaps === 0, "case2: no pre swap tallied");
  }

  // --- case 3: pre namespace absent — v1 behavior byte-for-byte ---
  {
    _resetBc7ForTest();
    _setBc7SupportForTest(true);
    initBc7Source({ fetchImpl: () => Promise.resolve(hbc7(8, 8)), preFetchImpl: () => Promise.resolve(null) });
    const { mat } = freshMat();
    const swaps = [];
    const res = await upgradeMaterialToBc7(mat, RS, () => swaps.push(1));
    check(res && res.swapped === true && mat.map.image.width === 8, "case3: full-only archive upgrades normally");
    check(swaps.length === 1, "case3: single swap");
  }

  // --- case 4: no onSwap — pre texture disposed when full lands ---
  {
    _resetBc7ForTest();
    _setBc7SupportForTest(true);
    const full = deferred();
    initBc7Source({ fetchImpl: () => full.promise, preFetchImpl: () => Promise.resolve(hbc7(2, 2)) });
    const { mat } = freshMat();
    const p = upgradeMaterialToBc7(mat, RS);
    await new Promise((r) => setTimeout(r, 10));
    const preTex = mat.map;
    let preDisposed = false;
    const origDispose = preTex.dispose ? preTex.dispose.bind(preTex) : null;
    preTex.dispose = () => {
      preDisposed = true;
      if (origDispose) origDispose();
    };
    full.resolve(hbc7(8, 8));
    await p;
    check(preDisposed, "case4: orphaned pre texture disposed without onSwap");
  }

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
