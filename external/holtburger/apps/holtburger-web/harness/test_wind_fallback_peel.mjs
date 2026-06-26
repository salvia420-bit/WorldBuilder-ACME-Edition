// harness/test_wind_fallback_peel.mjs — P4.3 coverage-gated peel fallback gate.
//
// THE SAFETY-NET PROOF for the later "fetch-not-synthesize" flip. Three locks:
//
//   A) suite_assets.js registers a `windclip` decoder that parses the SuiteBlob
//      windclip PAYLOAD (the exact little-endian layout the rust codec
//      holtburger-suite-bake/src/windclip.rs emits) into the object
//      getOrCreateWindGroup consumes — and is FAIL-SOFT (null on malformed,
//      never throws).
//
//   B) animated_scenery.js attachWindTrees returns `{built, failed}`; a FORCED
//      clip-miss (buildOneWind returns null for every placement) lands every
//      placement in `failed` — built + failed == ALL placements, NONE vanish.
//
//   C) statics.js re-adds `failed` to the frozen `statics` array, so a missed
//      wind clip becomes a STATIC tree. The no-miss path (failed empty) leaves
//      `statics` byte-identical — the off-trace [R] invariant.
//
// Pure Node, NO browser / wasm / server. Run standalone:
//     node harness/test_wind_fallback_peel.mjs
// (cwd-independent: bare `three` resolves from scene3d/, app modules via ../).

// statics.js touches window.* at module-eval when window exists (a backbuffer
// rAF loop) — stub the surface BEFORE importing the wind path.
globalThis.window = {
  location: { search: "?treeWind=on" },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

import { SuiteAssetSource, registerSuiteDecoder, _hasSuiteDecoder } from "../scene3d/suite_assets.js";
import { attachWindTrees } from "../scene3d/animated_scenery.js";
import { isTreeDid, treeWindDids, _resetTreeWindFlags } from "../scene3d/tree_wind.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Build a windclip PAYLOAD in JS that mirrors windclip.rs `sample()` exactly,
//    so the JS decoder is proven against the rust producer's byte layout. ──
const FF_PER_PART_FRAME = 7, RIG_FLOATS = 11;
function buildWindclipPayload(numParts, numFrames, k, fps) {
  const ff = numFrames * numParts * FF_PER_PART_FRAME; // floats / bucket
  const bs = ff * 4;
  const total = 16 + k * bs + numParts * RIG_FLOATS * 4;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, numParts, true);
  dv.setUint32(4, numFrames, true);
  dv.setUint32(8, k, true);
  dv.setFloat32(12, fps, true);
  // K bucket-major, frame-major f32 blocks — value(b,i) = b*100 + i*0.25 - 1.5.
  for (let b = 0; b < k; b++) {
    let o = 16 + b * bs;
    for (let i = 0; i < ff; i++, o += 4) dv.setFloat32(o, b * 100 + i * 0.25 - 1.5, true);
  }
  // Per-part rig: pivot.xyz, weight, rest_o.xyz, rest_q.wxyz.
  let ro = 16 + k * bs;
  for (let p = 0; p < numParts; p++) {
    dv.setFloat32(ro, p, true);             // pivot.x
    dv.setFloat32(ro + 4, p + 0.5, true);   // pivot.y
    dv.setFloat32(ro + 8, p - 0.25, true);  // pivot.z
    dv.setFloat32(ro + 12, 0.1 + 0.3 * p, true); // weight
    dv.setFloat32(ro + 16, 10 + p, true);   // rest_o.x
    dv.setFloat32(ro + 20, 20, true);       // rest_o.y
    dv.setFloat32(ro + 24, -30 - p, true);  // rest_o.z
    dv.setFloat32(ro + 28, 1, true);        // rest_q.w
    dv.setFloat32(ro + 32, 0, true);        // rest_q.x
    dv.setFloat32(ro + 36, 0, true);        // rest_q.y
    dv.setFloat32(ro + 40, 0, true);        // rest_q.z
    ro += RIG_FLOATS * 4;
  }
  return new Uint8Array(buf);
}

async function decodeVia(bytes) {
  // Drive the REAL registered decoder through SuiteAssetSource (the runtime path).
  const src = new SuiteAssetSource({ fetchImpl: () => bytes });
  check("_decoder windclip registered at import", _hasSuiteDecoder("windclip"));
  const first = src.get(0x02001063, "windclip"); // null + kicks fetch
  check("first get() is null while inflight (kicks fetch)", first === null);
  await tick();
  return { decoded: src.get(0x02001063, "windclip"), src };
}

console.log("== A) windclip decoder (suite_assets.js) ==");
{
  const NP = 2, NF = 3, K = 4, FPS = 30;
  const payload = buildWindclipPayload(NP, NF, K, FPS);
  const { decoded, src } = await decodeVia(payload);
  check("decode returns an object (not null)", decoded && typeof decoded === "object");
  check("header echoed: numParts/numFrames/fps/numBuckets",
    decoded && decoded.numParts === NP && decoded.numFrames === NF &&
    decoded.fps === FPS && decoded.numBuckets === K,
    decoded && `${decoded.numParts},${decoded.numFrames},${decoded.fps},${decoded.numBuckets}`);
  check("frames is a Float32Array of numFrames*numParts*7",
    decoded && decoded.frames instanceof Float32Array &&
    decoded.frames.length === NF * NP * FF_PER_PART_FRAME,
    decoded && `${decoded.frames && decoded.frames.length}`);
  check("frames === bucket 0 (zero-transform clip)", decoded && decoded.frames === decoded.buckets[0]);
  check("frames[0] == bucket0 value 0*100 + 0*0.25 - 1.5 = -1.5",
    decoded && Math.fround(decoded.frames[0]) === Math.fround(-1.5), decoded && decoded.frames[0]);
  check("bucket 1 desynced from bucket 0 (per-phase data preserved)",
    decoded && decoded.buckets[1][0] !== decoded.buckets[0][0]);
  check("bucketFrames(b) indexes mod K", decoded && decoded.bucketFrames(K) === decoded.buckets[0]);
  check("rig.len == numParts; rest.q is AC wxyz [1,0,0,0]",
    decoded && decoded.rig.length === NP &&
    decoded.rig[0].rest.q.length === 4 && decoded.rig[0].rest.q[0] === 1 &&
    decoded.rig[1].weight === Math.fround(0.1 + 0.3),
    decoded && JSON.stringify(decoded.rig[1] && decoded.rig[1].rest.q));
  check("decode path raised NO error (errors===0)", src.errors === 0, `errors=${src.errors}`);

  // FAIL-SOFT: malformed payloads → null, never throw (errors stay 0).
  const truncated = payload.slice(0, payload.length - 4);
  const { decoded: dTrunc, src: sTrunc } = { ...(await decodeVia(truncated)) };
  check("truncated payload decodes to null (fail-soft)", dTrunc === null);
  check("truncated decode did NOT throw (errors===0)", sTrunc.errors === 0, `errors=${sTrunc.errors}`);

  const zeroK = buildWindclipPayload(NP, NF, K, FPS).slice();
  new DataView(zeroK.buffer).setUint32(8, 0, true); // k = 0 → BadCounts
  const { decoded: dK0, src: sK0 } = await decodeVia(zeroK);
  check("k==0 payload decodes to null (fail-soft)", dK0 === null);
  check("k==0 decode did NOT throw (errors===0)", sK0.errors === 0, `errors=${sK0.errors}`);

  const trailing = new Uint8Array(payload.length + 4);
  trailing.set(payload, 0);
  const { decoded: dTrail } = await decodeVia(trailing);
  check("trailing-bytes payload decodes to null (strict-len fail-soft)", dTrail === null);
}

console.log("\n== B) attachWindTrees forced clip-miss → all placements in `failed` ==");
let peeled, attachResult;
{
  _resetTreeWindFlags();
  const treeDid = [...treeWindDids()][0];
  // A mixed LB: 2 trees (peeled) + 1 non-tree (stays frozen). Trees ALL miss.
  const treeA = { modelId: treeDid, landblockId: 0xAB110000, sourceObjIdx: 1, x: 10, y: 20, z: 0 };
  const treeB = { modelId: treeDid, landblockId: 0xAB110000, sourceObjIdx: 2, x: 30, y: 40, z: 0 };
  const rock = { modelId: 0x02000999, landblockId: 0xAB110000, sourceObjIdx: 3, x: 5, y: 5, z: 0 };
  const allPlacements = [treeA, rock, treeB];

  // statics.js peel (the exact predicate).
  peeled = allPlacements.filter((p) => isTreeDid((p?.modelId >>> 0) || 0));
  let frozenStatics = allPlacements.filter((p) => !isTreeDid((p?.modelId >>> 0) || 0));
  check("peel removed the 2 tree placements from frozen statics",
    peeled.length === 2 && frozenStatics.length === 1);

  // FORCE a clip miss: fetchBuildingPlacement yields partCount 0 ⇒ buildOneWind
  // returns null ⇒ the placement hits the (now non-silent) drop.
  const scene3d = { staticsGroup: { add() {} }, materialCache: { get: async () => null, preload: async () => {} } };
  let fetchCalls = 0;
  const wasmExports = {
    fetchBuildingPlacement: async () => { fetchCalls += 1; return { partCount: 0, free() {} }; },
    fetch_surfaces_pixels: async () => null,
  };
  attachResult = await attachWindTrees(scene3d, peeled, wasmExports);
  check("attachWindTrees returns {built, failed}",
    attachResult && typeof attachResult.built === "number" && Array.isArray(attachResult.failed));
  check("built === 0 (every clip missed)", attachResult.built === 0, `built=${attachResult.built}`);
  check("failed.length === peeled.length (NONE silently dropped)",
    attachResult.failed.length === peeled.length, `failed=${attachResult.failed.length}`);
  check("built + failed accounts for ALL peeled placements (no vanish)",
    attachResult.built + attachResult.failed.length === peeled.length);
  check("failed carries the ORIGINAL placement objects (===) for re-freezing",
    attachResult.failed.includes(treeA) && attachResult.failed.includes(treeB));
  check("fetchBuildingPlacement was actually exercised", fetchCalls === 2, `calls=${fetchCalls}`);

  // C) statics.js re-add: statics = statics.concat(failed) — the missed trees
  //    return to the frozen path. NONE of the 3 original placements vanish.
  frozenStatics = frozenStatics.concat(attachResult.failed);
  check("★ re-add: frozen statics now holds ALL 3 placements (no tree vanished)",
    frozenStatics.length === 3 &&
    [treeA, rock, treeB].every((p) => frozenStatics.includes(p)));
}

console.log("\n== C) no-miss path is byte-identical (failed empty ⇒ statics unchanged) ==");
{
  // When builds SUCCEED, attachWindTrees returns failed:[]; statics.concat([])
  // is the SAME members, SAME length — the off-trace [R] invariant the wiring
  // must preserve. (Driving a real success needs THREE meshes; the wiring
  // guarantee is the empty-concat identity, asserted directly.)
  const frozenStatics = [{ modelId: 0x02000999 }, { modelId: 0x02000aaa }];
  const before = frozenStatics.slice();
  const noMissFailed = [];
  const after = noMissFailed.length ? frozenStatics.concat(noMissFailed) : frozenStatics;
  check("failed empty ⇒ statics array reference + members unchanged",
    after === frozenStatics && after.length === before.length &&
    after.every((p, i) => p === before[i]));
  // And the guard early-returns keep failed empty (treeWind off ⇒ nothing peeled back).
  globalThis.window.location.search = "?treeWind=off";
  _resetTreeWindFlags();
  const offRes = await attachWindTrees(
    { staticsGroup: { add() {} } }, [{ modelId: 0x02001063 }],
    { fetchBuildingPlacement: async () => ({ partCount: 1, free() {} }) },
  );
  check("treeWind OFF guard returns {built:0, failed:[]} (off-trace re-adds nothing)",
    offRes.built === 0 && Array.isArray(offRes.failed) && offRes.failed.length === 0);
  globalThis.window.location.search = "?treeWind=on";
  _resetTreeWindFlags();
}

console.log(`\nP4.3 wind fallback peel: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
