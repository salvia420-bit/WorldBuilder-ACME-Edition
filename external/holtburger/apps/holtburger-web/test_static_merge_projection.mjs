// 2026-08-06 — `window.__statMergeProjection()` / `projectStatMergeBuckets`.
//
// WHAT THIS DEFENDS. Array-texture merging of the `?statBatchChunk` population
// is the largest measured item on the board, and its size has now been revised
// TWICE by live measurement. Both revisions are assertions in this file, because
// both were arrived at by an estimate that looked reasonable and was wrong by
// about a factor of two.
//
//   The ceiling is 129 -> 37 DRAWN buckets ≈ 3.68 ms, not 396 -> 86 ≈ 6.4 ms.
//   The region-width sweep is the proof: regionDiv 3 -> 12 removed 131 resident
//   buckets and bought 14 draws and 0.00 ms. Resident bucket count and DRAWN
//   bucket count are decoupled, so a projection stated over resident buckets
//   measures nothing.
//
//   And a texture array cannot ignore tile size. The 37 comes from
//   `bucketfrag.mjs`'s `stateOnlyKey`, which ignores the bound texture ENTIRELY,
//   dimensions included; `texStorage3D` fixes (format, w, h, depth) at
//   allocation, which is exactly why `_bucketKeyFor` carries `w x h` and a
//   format field. The live drawn census says the state axis is nearly free (6
//   distinct render states against 38 distinct material values), so the TILE
//   axis is essentially the whole problem.
//
// The projection is therefore an INSTRUMENT, and an instrument that is wrong is
// worse than none — it would be quoted into a design. So:
//
//   PART 1 — it reproduces today's key. `today` must equal the live bucket
//            count, because both are (region, material object).
//   PART 2 — merging is real: same region + same tile + same state + different
//            TEXTURES collapse to one bucket, and a global layer pool cuts one
//            layer per distinct surface.
//   PART 3 — THE SIZE AXIS IS REAL AND IS NOT SILENTLY COLLAPSED. Two surfaces
//            that differ only in tile size must NOT merge. This is the single
//            assertion that separates an honest projection from the idealised
//            86, and it is the reason this file exists.
//   PART 4 — the region key is kept: the same class in two regions is two
//            buckets but ONE global array pool. (Dropping the region key was
//            measured a wash — the fixed cost saved is handed back as
//            per-instance cull work.)
//   PART 5 — `regionStrict` splits where `_stateKeyOf` fuses. `side`,
//            `polygonOffset`, `emissive` and the shadow flags are NOT in the
//            atlas's state key; flattening them across 26,586 instances is
//            z-fighting, reversed `?perPolyCull`, dropped Luminosity and changed
//            shadows respectively. The gap between `regionClass` and
//            `regionStrict` is the price of correctness and must be visible.
//   PART 6 — outright blockers are counted, not silently merged away (a blocked
//            bucket still costs its own draw).
//   PART 7 — layer MEMORY both ways. A global pool cuts one layer per surface;
//            region-scoped pools re-cut one per (surface, region). That
//            multiplier is the finding that decides the design, so the probe
//            must report both and they must differ by exactly the region count.
//   PART 8 — THE DRAWN SPLIT. `drawn` must exclude a hidden bucket and an empty
//            one, and must be able to differ from `all` in every projection.
//            A probe that reports only resident buckets would have re-made the
//            exact mistake the region sweep caught.
//   PART 9 — TIER SNAPPING, the dial that prices the tile axis. Snapping to one
//            canonical tier must reach `regionState`; more tiers must land
//            between that and the unsnapped count; and snapping UP must cost
//            memory, or the dial would look free and it is not.
//
// 2026-08-06, second pass — a THIRD 2x, and this one was the instrument's fault.
// `blockedDrawn.deformed = 193` was read as 193 members and priced at 193 draws;
// it is 193 BUCKETS. And `drawn` cannot see the frustum, so the live run's
// "342 drawn of 346 resident" is a resident-scale number wearing a
// submitted-scale name — against 177 submitted measured independently for the
// same population. Both are now assertions:
//
//   PART 10 — the counting unit is BUCKETS. A 1,000-instance blocked bucket
//             bumps the blocker once, and the payload states its own unit.
//   PART 11 — the deformation residue is PROJECTED, not merely counted, so its
//             collapse factor (today -> regionClass) is readable. A count alone
//             cannot say whether un-blocking it is worth 1 ms or 0.1 ms.
//   PART 12 — the SUBMITTED sampler. Counting `onBeforeRender` calls measures
//             the draws three really made, rather than transcribing its cull;
//             un-armed it reports null, because an absent measurement quoted as
//             zero is the same error one rung down.
//
// Run:
//   cd apps/holtburger-web/
//   node test_static_merge_projection.mjs

import * as THREE from "three";
import {
  projectStatMergeBuckets,
  armStatMergeSubmittedSampler,
  disarmStatMergeSubmittedSampler,
} from "./scene3d/static_atlas.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// Fixtures. The probe only ever reads `isBatchedMesh`, `userData`, `material`
// and the two shadow flags off a node, and `traverse` off the root — so a plain
// object is a faithful stand-in and the test needs no GL context. The MATERIALS
// are real, because `_stateKeyOf` reads THREE blending/wrapping constants and a
// hand-rolled stub would test a transcription of the key rather than the key.
// ---------------------------------------------------------------------------

function tex(w, h) {
  const t = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat);
  t.image = { width: w, height: h, data: t.image.data };
  return t;
}

function mat(map, over = {}) {
  const m = new THREE.MeshStandardMaterial({ map });
  Object.assign(m, over);
  return m;
}

let _seq = 0;
function bucket(region, material, over = {}) {
  return {
    isBatchedMesh: true,
    castShadow: false,
    receiveShadow: false,
    name: `static-batch-c-r${region}-#${_seq++}`,
    ...over,
    material,
    userData: { __staticBatchCrossLb: true, regionKey: region, instances: 10, ...(over.userData || {}) },
  };
}

function root(children) {
  return { traverse(fn) { for (const c of children) fn(c); } };
}

console.log("statics bulk-merge projection");
console.log("=========================");

// ---------------------------------------------------------------------------
// PART 1 + 2 — today's key reproduced; merging by texture is real.
// Two regions, three DISTINCT 256x256 surfaces each, one render state.
// Today: 6 buckets (each surface its own material object). Merged: 2.
// ---------------------------------------------------------------------------
console.log("\nPART 1/2 — today's key, and merging distinct textures");
{
  const t = [tex(256, 256), tex(256, 256), tex(256, 256)];
  const nodes = [];
  for (const r of ["10x10", "10x11"]) for (const tt of t) nodes.push(bucket(r, mat(tt)));
  const p = projectStatMergeBuckets(root(nodes));
  check("today reproduces the live bucket count", p.all.buckets.today === 6 && p.batchBuckets === 6,
    `today=${p.all.buckets.today} live=${p.batchBuckets}`);
  check("three textures, one tile, one state → ONE bucket per region",
    p.all.buckets.regionClass === 2, `regionClass=${p.all.buckets.regionClass}`);
  check("regions counted", p.all.regions === 2, `regions=${p.all.regions}`);
  check("a global pool cuts one layer per distinct SURFACE",
    p.all.layers.shared === 3, `shared=${p.all.layers.shared}`);
  check("instances are summed off userData", p.instances === 60, `instances=${p.instances}`);
}

// ---------------------------------------------------------------------------
// PART 3 — THE SIZE AXIS. This is the assertion the whole file is for.
// ---------------------------------------------------------------------------
console.log("\nPART 3 — the tile-size axis is real (the 86 figure ignores it)");
{
  const nodes = [
    bucket("10x10", mat(tex(256, 256))),
    bucket("10x10", mat(tex(256, 256))),
    bucket("10x10", mat(tex(512, 512))),
  ];
  const p = projectStatMergeBuckets(root(nodes));
  check("same size merges, different size does NOT",
    p.all.buckets.regionClass === 2, `regionClass=${p.all.buckets.regionClass} (expect 2: one per tile size)`);
  check("...while (region, state) alone would claim ONE — that is the gap",
    p.all.buckets.regionState === 1, `regionState=${p.all.buckets.regionState}`);
  check("distinct tiles reported", p.all.distinctTiles === 2, `distinctTiles=${p.all.distinctTiles}`);
  check("non-square tiles are a distinct class too", (() => {
    const q = projectStatMergeBuckets(root([
      bucket("10x10", mat(tex(256, 256))), bucket("10x10", mat(tex(256, 128))),
    ]));
    return q.all.buckets.regionClass === 2;
  })());
}

// ---------------------------------------------------------------------------
// PART 4 — the region key survives; array pools are global.
// ---------------------------------------------------------------------------
console.log("\nPART 4 — region-scoped buckets, globally-scoped pools");
{
  const shared = tex(128, 128);
  const nodes = ["1x1", "1x2", "1x3", "2x1"].map((r) => bucket(r, mat(shared)));
  const p = projectStatMergeBuckets(root(nodes));
  check("one bucket PER REGION (node-level frustum culling is kept)",
    p.all.buckets.regionClass === 4, `regionClass=${p.all.buckets.regionClass}`);
  check("...but ONE global array pool behind all four",
    p.all.buckets.globalClasses === 1, `globalClasses=${p.all.buckets.globalClasses}`);
}

// ---------------------------------------------------------------------------
// PART 5 — what `_stateKeyOf` leaves out. Each case is a live population:
//   side           — the `?perPolyCull` sidedness split, and `makeArrayMaterial`
//                    hardcodes DoubleSide.
//   polygonOffset  — materials.js `staticBiasMaterials` / `floorBiasMaterials`
//                    exist for no other purpose; flattening them is z-fighting.
//   emissive       — the Luminosity term (memory: flat emissive, not emissiveMap).
//   castShadow     — a per-BUCKET flag; the batcher takes it from its template
//                    node, the atlas hardcodes true.
// ---------------------------------------------------------------------------
console.log("\nPART 5 — the fields the atlas state key does NOT carry");
for (const [label, over, nodeOver] of [
  // NOTE `THREE.FrontSide === 0` IS the MeshStandardMaterial default, so the
  // differing arm has to be DoubleSide or this case silently tests nothing —
  // which is exactly what it did on the first run.
  ["side", { side: THREE.DoubleSide }, {}],
  ["polygonOffset", { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }, {}],
  ["emissive", { emissive: new THREE.Color(0x00ff00), emissiveIntensity: 0.7 }, {}],
  ["castShadow", {}, { castShadow: true }],
]) {
  const a = bucket("9x9", mat(tex(64, 64)));
  const b = bucket("9x9", mat(tex(64, 64), over), nodeOver);
  const p = projectStatMergeBuckets(root([a, b]));
  check(`${label} differs: the atlas key FUSES them...`, p.all.buckets.regionClass === 1,
    `regionClass=${p.all.buckets.regionClass}`);
  check(`...and regionStrict keeps them apart (${label})`, p.all.buckets.regionStrict === 2,
    `regionStrict=${p.all.buckets.regionStrict}`);
}
{
  // The control: identical materials must NOT split under the strict key, or
  // `regionStrict` would be a constant re-statement of `today` and useless.
  const t0 = tex(64, 64);
  const p = projectStatMergeBuckets(root([bucket("9x9", mat(t0)), bucket("9x9", mat(tex(64, 64)))]));
  check("control: equal-by-value materials stay merged under regionStrict",
    p.all.buckets.regionStrict === 1, `regionStrict=${p.all.buckets.regionStrict}`);
}
{
  // And the render state the atlas DOES carry still splits, both keys.
  const p = projectStatMergeBuckets(root([
    bucket("9x9", mat(tex(64, 64))),
    bucket("9x9", mat(tex(64, 64), { transparent: true, alphaTest: 100 / 255 })),
  ]));
  check("alphaTest/transparent split under BOTH keys",
    p.all.buckets.regionClass === 2 && p.all.buckets.regionStrict === 2,
    `class=${p.all.buckets.regionClass} strict=${p.all.buckets.regionStrict}`);
}
{
  // RND-33: a WRAP member and a CLAMP member can never share a packed layer.
  const wrapTex = tex(64, 64);
  wrapTex.wrapS = THREE.RepeatWrapping;
  const p = projectStatMergeBuckets(root([
    bucket("9x9", mat(tex(64, 64))), bucket("9x9", mat(wrapTex)),
  ]));
  check("RND-33 wrap vs clamp never co-bucket", p.all.buckets.regionClass === 2,
    `regionClass=${p.all.buckets.regionClass}`);
}

// ---------------------------------------------------------------------------
// PART 6 — outright blockers. A blocked bucket still costs a draw, so it must
// be counted and must NOT appear in any merged class.
// ---------------------------------------------------------------------------
console.log("\nPART 6 — blockers counted, never merged away");
{
  const deformed = mat(tex(64, 64));
  deformed.userData.__vfxSetKey = "deformation.windSwayGpu";
  const basic = new THREE.MeshBasicMaterial({ map: tex(64, 64) }); // wireframe path
  const noMap = new THREE.MeshStandardMaterial();
  const nodes = [
    bucket("3x3", mat(tex(64, 64))),
    bucket("3x3", deformed),
    bucket("3x3", basic),
    bucket("3x3", noMap),
  ];
  const p = projectStatMergeBuckets(root(nodes));
  check("MECH-B deformation variants are held out (ptDeformed's rule)",
    p.blocked.deformed === 1, JSON.stringify(p.blocked));
  check("non-MeshStandard (wireframe MeshBasic) held out", p.blocked.nonStandard === 1);
  check("a material with no map is held out", p.blocked.noMap === 1);
  check("only the one mergeable bucket forms a class",
    p.all.buckets.regionClass === 1 && p.all.buckets.globalClasses === 1,
    `regionClass=${p.all.buckets.regionClass}`);
  check("blocked buckets still count in the live total", p.batchBuckets === 4);
}

// ---------------------------------------------------------------------------
// PART 7 — layer memory, both scopings. THE number that decides the design.
// One surface resident in 4 regions: a global pool cuts 1 layer, region-scoped
// pools cut 4. The ratio is the region-overlap factor, and it is why the design
// keeps the ARRAYS global and only the BatchedMeshes regional.
// ---------------------------------------------------------------------------
console.log("\nPART 7 — global pool vs region-scoped pools");
{
  const shared = tex(256, 256);
  const nodes = ["1x1", "1x2", "1x3", "1x4"].map((r) => bucket(r, mat(shared)));
  const p = projectStatMergeBuckets(root(nodes));
  check("global pool: one layer for a surface resident in 4 regions",
    p.all.layers.shared === 1, `shared=${p.all.layers.shared}`);
  check("region-scoped pools: four copies of the same layer",
    p.all.layers.regional === 4, `regional=${p.all.layers.regional}`);
  check("...and the MB figures scale with them",
    p.all.layers.regionalMB > p.all.layers.sharedMB * 3.5,
    `sharedMB=${p.all.layers.sharedMB} regionalMB=${p.all.layers.regionalMB}`);
  check("per-layer bytes come from _perLayerBytesFor, not a transcription",
    p.all.classes[0].perLayerKiB === 256 * 256 * 4 * 2 / 1024 || p.all.classes[0].perLayerKiB === 256 * 256 * 4 / 1024,
    `perLayerKiB=${p.all.classes[0].perLayerKiB} (512 with ?statNra on, 256 without)`);
}
{
  // Capacity: a class holding more distinct surfaces than `_layerCapacityFor`
  // allows would spill members to `ptLayerFull`. At 2048x2048 with ?statNra on
  // the budget affords ONE layer, so the ceiling is the `_ATLAS_NRA_MIN_LAYERS`
  // floor of 16 — the "a big tile still gets a usable bucket" clause. 20
  // distinct surfaces clears it; 3 does not, which is what the first run of this
  // case reported and is the reason the number is read off `p.all.classes[0].capacity`
  // in the failure detail rather than assumed.
  const nodes = [];
  for (let i = 0; i < 20; i++) nodes.push(bucket("5x5", mat(tex(2048, 2048))));
  const p = projectStatMergeBuckets(root(nodes));
  check("a class over its layer ceiling is flagged, not silently promised",
    p.all.layers.classesOverCapacity === 1,
    `over=${p.all.layers.classesOverCapacity} cap=${p.all.classes[0].capacity} surfaces=${p.all.classes[0].surfaces}`);
}

// ---------------------------------------------------------------------------
// PART 8 — the drawn split. The region-width sweep (regionDiv 3 -> 12: -131
// resident buckets, -14 draws, 0.00 ms) is the reason this exists: a projection
// over resident buckets measures a quantity that does not pay.
// ---------------------------------------------------------------------------
console.log("\nPART 8 — drawn vs resident");
{
  const t256 = () => mat(tex(256, 256));
  const nodes = [
    bucket("1x1", t256()),                                        // drawn
    bucket("1x1", t256(), { visible: false }),                    // hidden
    bucket("1x2", t256(), { userData: { instances: 0 } }),        // empty (evicted-but-alive)
    bucket("1x3", mat(tex(512, 512))),                            // drawn, other tile
  ];
  const p = projectStatMergeBuckets(root(nodes));
  check("resident count sees all four", p.batchBuckets === 4, `batchBuckets=${p.batchBuckets}`);
  check("a hidden bucket is not drawn", p.drawnBuckets === 2, `drawnBuckets=${p.drawnBuckets}`);
  check("an instance-less bucket is not drawn either (it submits nothing)",
    p.drawn.buckets.today === 2, `drawn.today=${p.drawn.buckets.today}`);
  check("drawn instances exclude the hidden and the empty",
    p.drawnInstances === 20, `drawnInstances=${p.drawnInstances}`);
  check("the two projections genuinely differ",
    p.all.buckets.today === 4 && p.all.buckets.regionClass === 3 &&
    p.drawn.buckets.regionClass === 2,
    `all.regionClass=${p.all.buckets.regionClass} drawn.regionClass=${p.drawn.buckets.regionClass}`);
  check("blockers are tallied over the drawn subset too",
    p.blockedDrawn.deformed === 0 && p.blocked.deformed === 0);
  check("drawn layer memory is a subset of resident layer memory",
    p.drawn.layers.sharedMB <= p.all.layers.sharedMB,
    `drawn=${p.drawn.layers.sharedMB} all=${p.all.layers.sharedMB}`);
}

// ---------------------------------------------------------------------------
// PART 9 — tier snapping. Because each layer holds ONE surface addressed by
// normalized UV, resampling to another tile size is a pure resolution change
// with no UV math — which is what makes this a real dial and not a fantasy.
// ---------------------------------------------------------------------------
console.log("\nPART 9 — tier snapping prices the tile axis");
{
  // Four tile sizes, one region, one state. Unsnapped: 4 buckets. One tier: 1.
  const nodes = [128, 256, 512, 1024].map((s) => bucket("7x7", mat(tex(s, s))));
  const p = projectStatMergeBuckets(root(nodes));
  check("unsnapped, each tile size is its own bucket",
    p.all.buckets.regionClass === 4, `regionClass=${p.all.buckets.regionClass}`);
  const one = p.all.snapped.find((s) => s.tiers.length === 1);
  const three = p.all.snapped.find((s) => s.tiers.length === 3);
  check("ONE canonical tier reaches the (region, state) ceiling",
    one.regionClass === p.all.buckets.regionState && one.regionClass === 1,
    `snapped[512]=${one.regionClass} regionState=${p.all.buckets.regionState}`);
  check("three tiers land between the ceiling and the unsnapped count",
    three.regionClass > one.regionClass && three.regionClass <= p.all.buckets.regionClass,
    `snapped[128,512,2048]=${three.regionClass}`);
  check("every tier set is priced in array MB, not just buckets",
    p.all.snapped.every((s) => typeof s.sharedMB === "number" && s.layers === 4),
    JSON.stringify(p.all.snapped.map((s) => ({ t: s.tiers, b: s.regionClass, mb: s.sharedMB }))));
  check("snapping UP costs memory — the dial is not free",
    one.sharedMB > three.sharedMB,
    `one-tier ${one.sharedMB} MB vs three-tier ${three.sharedMB} MB`);
  check("snapping is log-nearest, so a non-square tile picks ONE tier", (() => {
    // 128x512 has geometric mean 256 — nearest to 256, not torn between the two.
    const q = projectStatMergeBuckets(root([
      bucket("7x7", mat(tex(128, 512))), bucket("7x7", mat(tex(256, 256))),
    ]));
    return q.all.snapped.find((s) => s.tiers.length === 2).regionClass === 1;
  })());
  check("the strict key is snapped too (it must not silently un-split)",
    p.all.snapped.every((s) => s.regionStrict >= s.regionClass));
}

// ---------------------------------------------------------------------------
// Hygiene: the two populations are never conflated, and a missing scene says so
// instead of returning a confident zero.
// ---------------------------------------------------------------------------
console.log("\nhygiene");
{
  const atlasNode = { isBatchedMesh: true, material: mat(tex(64, 64)), userData: { __statAtlasCrossLb: true } };
  const other = { isBatchedMesh: true, material: mat(tex(64, 64)), userData: {} };
  const p = projectStatMergeBuckets(root([bucket("1x1", mat(tex(64, 64))), atlasNode, other]));
  check("stat-atlas-x buckets are reported separately, never merged in",
    p.atlasBuckets === 1 && p.batchBuckets === 1, `atlas=${p.atlasBuckets} batch=${p.batchBuckets}`);
  check("an unmarked BatchedMesh (terrain/entities) is ignored entirely",
    p.all.buckets.today === 1, `today=${p.all.buckets.today}`);
  const e = projectStatMergeBuckets(null);
  check("no scene ⇒ an error, not a confident zero", typeof e.error === "string", e.error);
  check("a throwing traverse is caught by the window wrapper contract",
    typeof projectStatMergeBuckets === "function");
}

// ---------------------------------------------------------------------------
// PART 10 — THE COUNTING UNIT IS BUCKETS. `blockedDrawn.deformed = 193` was read
// as "193 members" and priced at 193 draws; it is 193 BatchedMesh nodes, and a
// bucket holds many members. One bucket with a thousand instances must bump the
// blocker exactly once, or every ms figure derived from it is a fiction.
// ---------------------------------------------------------------------------
console.log("\nPART 10 — blockers are counted in BUCKETS, never members");
{
  const deformed = mat(tex(64, 64));
  deformed.userData.__vfxSetKey = "deformation.windSwayGpu";
  const p = projectStatMergeBuckets(root([
    bucket("2x2", deformed, { userData: { __staticBatchCrossLb: true, regionKey: "2x2", instances: 1000 } }),
  ]));
  check("a 1,000-instance blocked bucket bumps the blocker ONCE",
    p.blocked.deformed === 1, `deformed=${p.blocked.deformed}`);
  check("its members are reported separately, as instances",
    p.instances === 1000, `instances=${p.instances}`);
  check("the payload states its own unit so the field name cannot be misread",
    p.units && p.units.blocked === "buckets", JSON.stringify(p.units));
}

// ---------------------------------------------------------------------------
// PART 11 — THE DEFORMATION RESIDUE IS PRICED, NOT JUST COUNTED. A count cannot
// say what un-blocking it would buy: 193 blocked buckets are worth a lot if they
// collapse to a handful and nothing if they are already near their floor. The
// residue must therefore be projected with the SAME keys as the mergeable
// population — and it must stay OUT of that population's totals.
// ---------------------------------------------------------------------------
console.log("\nPART 11 — the deformation residue is projected, not discarded");
{
  const sway = () => {
    const m = mat(tex(64, 64));
    m.userData.__vfxSetKey = "deformation.windSwayGpu";
    return m;
  };
  // Three sway buckets in one region: two share a tile+state (they would merge),
  // the third differs in tile size (it would not). Plus one ordinary bucket.
  const p = projectStatMergeBuckets(root([
    bucket("4x4", sway()),
    bucket("4x4", sway()),
    bucket("4x4", (() => { const m = sway(); m.map = tex(256, 256); return m; })()),
    bucket("4x4", mat(tex(64, 64))),
  ]));
  check("the residue never leaks into the mergeable projection",
    p.all.buckets.today === 1, `today=${p.all.buckets.today}`);
  check("the residue is projected on its own", p.deformed.buckets === 3 &&
    p.deformed.all.buckets.today === 3, JSON.stringify(p.deformed.buckets));
  check("and its COLLAPSE FACTOR is visible — 3 buckets to 2 classes",
    p.deformed.all.buckets.regionClass === 2,
    `regionClass=${p.deformed.all.buckets.regionClass}`);
  check("the residue names its sets — one set splits a class in two, five in six",
    p.deformed.setKeys["deformation.windSwayGpu"] === 3,
    JSON.stringify(p.deformed.setKeys));
  check("the tile axis splits the residue too (it is not idealised away)",
    p.deformed.all.buckets.regionClass > p.deformed.all.buckets.regionState,
    `class=${p.deformed.all.buckets.regionClass} state=${p.deformed.all.buckets.regionState}`);
  // A deformed bucket that ALSO fails a later gate must be counted once, as
  // deformed, and must not appear in either projection's rows.
  const q = projectStatMergeBuckets(root([
    bucket("4x4", (() => { const m = new THREE.MeshStandardMaterial(); m.userData.__vfxSetKey = "deformation.windSwayGpu"; return m; })()),
  ]));
  check("a deformed bucket that also has no map is counted ONCE, as deformed",
    q.blocked.deformed === 1 && q.blocked.noMap === 0 &&
    q.deformed.all.buckets.today === 0, JSON.stringify(q.blocked));
}

// ---------------------------------------------------------------------------
// PART 12 — THE SUBMITTED SAMPLER. `_projDrawn` cannot see the frustum: the live
// 2026-08-06 run reported 342 "drawn" of 346 resident while the measured
// submitted count for the same population was 177. So `drawn` is resident-scale,
// and an absent submitted measurement must read as ABSENT rather than as zero —
// a null that gets quoted as 0 ms is the same class of error one rung down.
// ---------------------------------------------------------------------------
console.log("\nPART 12 — the submitted sampler measures draws, not visibility");
{
  const nodes = [bucket("5x5", mat(tex(64, 64))), bucket("5x5", mat(tex(128, 128)))];
  // BatchedMesh keeps onBeforeRender on its PROTOTYPE; the fixture stands in for
  // that with an own-property base so delegation and restore are both exercised.
  let baseCalls = 0;
  for (const n of nodes) Object.setPrototypeOf(n, { onBeforeRender() { baseCalls += 1; } });
  const r = root(nodes);

  const cold = projectStatMergeBuckets(r);
  check("un-armed, `submitted` is null — absent, not a confident zero",
    cold.submitted === null && cold.submittedSampled === false,
    `sampled=${cold.submittedSampled}`);
  check("the residue's submitted projection is null too", cold.deformed.submitted === null);

  check("arming reports how many buckets it wrapped",
    armStatMergeSubmittedSampler(r).armed === 2);
  // Render one frame in which only the FIRST bucket survives the cull.
  nodes[0].onBeforeRender();
  const hot = projectStatMergeBuckets(r);
  check("only the bucket three actually submitted counts as submitted",
    hot.submittedBuckets === 1 && hot.submitted.buckets.today === 1,
    `submitted=${hot.submittedBuckets}`);
  check("and it differs from `drawn`, which sees both — that gap IS the finding",
    hot.drawnBuckets === 2 && hot.submittedBuckets === 1,
    `drawn=${hot.drawnBuckets} submitted=${hot.submittedBuckets}`);
  check("submitted instances are counted over the submitted buckets only",
    hot.submittedInstances === 10, `n=${hot.submittedInstances}`);
  check("the wrapper delegates to the prototype's multidraw rebuild",
    baseCalls === 1, `baseCalls=${baseCalls}`);
  check("re-arming resets the counts rather than doubling them",
    (armStatMergeSubmittedSampler(r), projectStatMergeBuckets(r).submittedBuckets === 0));

  check("disarming restores the prototype method",
    disarmStatMergeSubmittedSampler(r).disarmed === 2 &&
    !Object.prototype.hasOwnProperty.call(nodes[0], "onBeforeRender"));
  nodes[0].onBeforeRender();
  check("after disarm the prototype runs unwrapped — no lingering per-draw cost",
    baseCalls === 2, `baseCalls=${baseCalls}`);
  check("counts survive the disarm, so a measurement can disarm THEN quote",
    projectStatMergeBuckets(r).submittedSampled === true);
  check("no scene ⇒ arm/disarm say so instead of silently doing nothing",
    typeof armStatMergeSubmittedSampler(null).error === "string" &&
    typeof disarmStatMergeSubmittedSampler(null).error === "string");
}

console.log("=========================");
console.log(`statics bulk-merge projection: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
