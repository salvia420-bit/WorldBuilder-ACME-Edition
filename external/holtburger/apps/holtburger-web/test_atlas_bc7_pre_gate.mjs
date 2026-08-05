// The statics-atlas deferral vs P1 preview-first (2026-08-05 regression).
//
// url-flags.md `texPre` promises "Statics-ATLAS buckets are full-only by
// design". The gate in static_atlas.js used to read
// `!bc7Tex && bc7PendingOn(mat)`, which the PRE swap walked straight through:
// once the quarter-res preview is installed, `mat.map` IS a BC7 texture while
// the full verdict is still pending, so the node got committed to a bucket
// keyed at the PREVIEW's dimensions and stayed quarter-res until its LB
// re-streamed. No GPU, no wasm: fetchImpl/preFetchImpl injected.
//
// Run: node test_atlas_bc7_pre_gate.mjs
import {
  initBc7Source,
  upgradeMaterialToBc7,
  _setBc7SupportForTest,
  _resetBc7ForTest,
  bc7PendingOn,
} from "./scene3d/bc7_textures.js";
import { isBc7AtlasTexture, bc7AtlasShouldDefer } from "./scene3d/static_atlas.js";

let fails = 0;
const check = (cond, label) => {
  if (cond) console.log("ok:", label);
  else {
    console.log("FAIL:", label);
    fails += 1;
  }
};

const blocks = (n) => Math.ceil(n / 4);
function hbc7(w, h) {
  const lvls = [];
  let lw = w;
  let lh = h;
  for (;;) {
    lvls.push(blocks(lw) * blocks(lh) * 16);
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  const buf = new Uint8Array(20 + lvls.reduce((a, b) => a + b, 0));
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
const tick = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
const freshMat = () => ({
  map: { name: "rgba8", wrapS: 1000, wrapT: 1000, colorSpace: "srgb", dispose() {} },
  userData: {},
  needsUpdate: false,
});

// THE REAL GATE — imported, not transcribed, so reverting the fix in
// static_atlas.js makes this suite go red instead of quietly staying green.
const wouldDefer = (mat) => bc7AtlasShouldDefer(mat);

// --- case 1: PRE landed, FULL still in flight -> MUST still defer -----------
{
  _resetBc7ForTest();
  _setBc7SupportForTest(true);
  const full = deferred();
  initBc7Source({
    fetchImpl: () => full.promise,
    preFetchImpl: () => Promise.resolve(hbc7(128, 128)),
  });
  const mat = freshMat();
  const p = upgradeMaterialToBc7(mat, 0x06001234);

  check(wouldDefer(mat), "case1: deferred before anything lands");
  await tick();
  check(isBc7AtlasTexture(mat.map), "case1: the PRE texture did swap in");
  check(mat.map.image.width === 128, "case1: and it is the quarter-res preview");
  check(mat.userData.__bc7Pending === true, "case1: full verdict still pending");
  check(
    wouldDefer(mat),
    "case1: STILL DEFERRED with a PRE map installed (the regression: was false)",
  );

  full.resolve(hbc7(512, 512));
  await p;
  check(mat.map.image.width === 512, "case1: full record swapped over the preview");
  check(!mat.userData.__bc7Pending, "case1: pending marker cleared by the full phase");
  check(!wouldDefer(mat), "case1: released for atlasing once the FULL record is in");
}

// --- case 2: no pre namespace -> unchanged pre-P1 behaviour -----------------
{
  _resetBc7ForTest();
  _setBc7SupportForTest(true);
  const full = deferred();
  initBc7Source({
    fetchImpl: () => full.promise,
    preFetchImpl: () => Promise.resolve(null),
  });
  const mat = freshMat();
  const p = upgradeMaterialToBc7(mat, 0x06005678);
  await tick();
  check(wouldDefer(mat), "case2: full-only archive still defers while in flight");
  check(mat.map.name === "rgba8", "case2: map is still the RGBA8 twin");
  full.resolve(hbc7(256, 256));
  await p;
  check(!wouldDefer(mat), "case2: released after the full record lands");
  check(isBc7AtlasTexture(mat.map) && mat.map.image.width === 256, "case2: full BC7 installed");
}

// --- case 3: absent record -> released, never stuck deferring forever -------
{
  _resetBc7ForTest();
  _setBc7SupportForTest(true);
  initBc7Source({
    fetchImpl: () => Promise.resolve(null),
    preFetchImpl: () => Promise.resolve(null),
  });
  const mat = freshMat();
  const res = await upgradeMaterialToBc7(mat, 0x06009999);
  check(res === false, "case3: absent record resolves false");
  check(!wouldDefer(mat), "case3: a proven-absent surface is NOT held out of the atlas");
  check(mat.map.name === "rgba8", "case3: keeps its RGBA8 albedo");
}

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
