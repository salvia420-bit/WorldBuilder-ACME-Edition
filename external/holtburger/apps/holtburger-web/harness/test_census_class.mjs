#!/usr/bin/env node
// harness/test_census_class.mjs — Tier-1 test for the CENSUS-CLASS reducer
// (T00). Pure node, no browser: locks the pass-07 S3 canonical key encoding
// (state axes = _stateKeyOf + side; patch = _patchSetCacheKey verbatim +
// #config token; tex dims byte + f7/f8; shadow pair), the (sector × class)
// pool projection, the pass split, the axis-explosion analysis, and the
// SPEC §3 T00 verdict rule.

import {
  stateKeyOf, patchKeyOf, texKeyOf, classKeyOf, passClassOf,
  reduceClassCensus, censusVerdict, BOUNDS,
} from "./census-class.mjs";

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
}

const PLAIN_PATCH = { d: 0, c: 0, p: 0, l: 0, a: 0, b: 0, f: 0, s: 0, k: 0, v: "" };

function rec(over = {}) {
  return {
    domain: "st", source: "mesh",
    transparent: false, alphaTest: 0, depthWrite: true,
    blending: 1, blendTriple: null, wrap: "c", side: 2,
    patch: { ...PLAIN_PATCH }, vfxConfigKey: null,
    texW: 256, texH: 256, texCompressed: true, hasTex: true,
    castShadow: true, receiveShadow: true,
    instances: 1, mats: 1, meshes: 1, sectors: ["s10x20"],
    sectorsUnknown: 0, dids: [],
    ...over,
  };
}

// ── key encoding ───────────────────────────────────────────────────────────

// state token: _stateKeyOf axes + side.
check("state: opaque default", stateKeyOf(rec()) === "t0a0w1b1rcsd", stateKeyOf(rec()));
// alphaTest keeps the full-precision string (100/255 non-terminating rule).
const clip = rec({ transparent: true, alphaTest: 100 / 255 });
check("state: exact alphaTest string",
  stateKeyOf(clip) === `t1a${String(100 / 255)}w1b1rcsd`, stateKeyOf(clip));
// CustomBlending carries the src.dst.eq triple (c-prefixed).
const cb = rec({ blending: 5, blendTriple: "204.206.100" });
check("state: custom blend triple", stateKeyOf(cb).includes("bc204.206.100"), stateKeyOf(cb));
// Non-custom blending is b<mode>.
check("state: additive is b2", stateKeyOf(rec({ blending: 2 })).includes("b2"));
// depthWrite=false → w0; wrap w; FrontSide → sf.
check("state: w0/rw/sf",
  stateKeyOf(rec({ depthWrite: false, wrap: "w", side: 0 })) === "t0a0w0b1rwsf");

// patch token: _patchSetCacheKey verbatim.
check("patch: un-patched key", patchKeyOf(rec()) === "hb|d0|c0|p0|l0|a0|b0|f0|s0|k0|v",
  patchKeyOf(rec()));
const vfx = rec({
  patch: { ...PLAIN_PATCH, c: 1, v: "windSwayGpu" },
  vfxConfigKey: 'windSwayGpu={"amp":0.6}',
});
check("patch: vfx set + #config token",
  patchKeyOf(vfx) === 'hb|d0|c1|p0|l0|a0|b0|f0|s0|k0|vwindSwayGpu#windSwayGpu={"amp":0.6}',
  patchKeyOf(vfx));
// A set WITHOUT resolvable config still carries the set (no # suffix on null).
const vfxNoCfg = rec({ patch: { ...PLAIN_PATCH, v: "glint" }, vfxConfigKey: null });
check("patch: set without config", patchKeyOf(vfxNoCfg) === "hb|d0|c0|p0|l0|a0|b0|f0|s0|k0|vglint");

// tex token: (log2w<<4|log2h) hex + format.
check("tex: 256x256 bc7", texKeyOf(rec()) === "x88f7", texKeyOf(rec()));
check("tex: 512x256 rgba8",
  texKeyOf(rec({ texW: 512, texH: 256, texCompressed: false })) === "x98f8");
check("tex: no texture", texKeyOf(rec({ texW: 0, texH: 0, hasTex: false, texCompressed: false })) === "x00f8");

// full key: fixed order domain|state|patch|tex|shadow.
check("classKey: full S3 order",
  classKeyOf(rec()) === "st|t0a0w1b1rcsd|hb|d0|c0|p0|l0|a0|b0|f0|s0|k0|v|x88f7|c1r1",
  classKeyOf(rec()));
check("classKey: shadow pair discriminates",
  classKeyOf(rec({ receiveShadow: false })) !== classKeyOf(rec()));
// Row-31 protection: a floorBias clone is a DIFFERENT class by its existing bit.
check("classKey: floorBias variant is a distinct class",
  classKeyOf(rec({ patch: { ...PLAIN_PATCH, f: 1 } })) !== classKeyOf(rec()));

// pass classification (D-07.3).
check("pass: opaque", passClassOf(rec()) === "opaque");
check("pass: additive", passClassOf(rec({ blending: 2, transparent: true })) === "additive");
check("pass: translucent", passClassOf(rec({ transparent: true })) === "translucent");
check("pass: alpha-tested transparent counts opaque-path",
  passClassOf(rec({ transparent: true, alphaTest: 0.392 })) === "opaque");

// ── reduction ──────────────────────────────────────────────────────────────

const snapshot = {
  meta: { landblockId: 0xcb4b0021, quality: "mid", terrainBakedLbs: 203 },
  records: [
    // one class spread over two records / three sectors
    rec({ instances: 100, mats: 3, sectors: ["s1x1", "s1x2"] }),
    rec({ instances: 50, mats: 2, sectors: ["s2x1"], source: "batchx" }),
    // same axes, envcell domain → different class
    rec({ domain: "ec", instances: 20, mats: 1, sectors: ["s1x1"] }),
    // reserved domains: never in the pooled verdict
    rec({ domain: "tr", instances: 200, mats: 200, sectors: ["s1x1", "s2x1"] }),
    rec({ domain: "as", instances: 40, mats: 4, sectors: ["s1x1"] }),
    // translucent class
    rec({ transparent: true, instances: 7, sectors: ["s1x1"] }),
    // unknown-sector class → floored at 1 pool + warning
    rec({ texW: 64, texH: 64, instances: 5, sectors: [], sectorsUnknown: 1 }),
  ],
  cache: {
    available: true,
    sizes: { materials: 3 },
    records: [
      { ...rec(), map: "materials", mats: 2 },
      { ...rec({ texW: 64, texH: 64 }), map: "materials", mats: 1 },
      { ...rec({ patch: { ...PLAIN_PATCH, f: 1 } }), map: "floorBiasMaterials", mats: 1 },
    ],
  },
};

const r = reduceClassCensus(snapshot);
check("reduce: pooled classes", r.pooledClasses === 4, r.pooledClasses);
// pools: class1 |{s1x1,s1x2,s2x1}|=3, ec 1, translucent 1, unknown floor 1 → 6
check("reduce: projected pools", r.projectedPools === 6, r.projectedPools);
check("reduce: pooled instances", r.pooledInstances === 182, r.pooledInstances);
check("reduce: reserved tr excluded", r.reserved.tr?.classes === 1 && r.reserved.tr.instances === 200);
check("reduce: reserved as excluded", r.reserved.as?.classes === 1);
check("reduce: pass split", r.passes.opaque === 175 && r.passes.translucent === 7, JSON.stringify(r.passes));
check("reduce: unknown-sector warning",
  r.warnings.some((w) => w.includes("floored at 1 pool")));
// pooled-domain sectors only: {s1x1, s1x2, s2x1} (tr/as sectors excluded).
check("reduce: sector census", r.sectors === 3, r.sectors);
check("reduce: list sorted by pools", r.list[0].pools === 3);
check("reduce: cache core keys", r.cache.coreClasses === 3, r.cache?.coreClasses);
check("reduce: cache per-map", r.cache.perMap.materials.mats === 3
  && r.cache.perMap.floorBiasMaterials.coreClasses === 1);

// axis analysis: collapsing domain merges st/ec twins → fewer classes;
// collapsing texDims merges the 64x64 offshoot.
check("axis: domain contributes", r.axisAnalysis.domain.contributes >= 1,
  JSON.stringify(r.axisAnalysis.domain));
check("axis: texDims contributes", r.axisAnalysis.texDims.contributes >= 1,
  JSON.stringify(r.axisAnalysis.texDims));
check("axis: wrap contributes zero here", r.axisAnalysis.stateWrap.contributes === 0);

// ── verdict rule ───────────────────────────────────────────────────────────

check("verdict: within bounds", censusVerdict({ nanto: r }).verdict === "WITHIN-BOUNDS");
const fat = {
  ...r,
  pooledClasses: BOUNDS.classes + 1,
};
const v2 = censusVerdict({ nanto: r, townnetwork: fat });
check("verdict: re-examine names the scene+axis",
  v2.verdict === "RE-EXAMINE" && v2.offending[0].startsWith("townnetwork: classes"));
const fatPools = { ...r, projectedPools: BOUNDS.pools + 1 };
check("verdict: pool bound fires independently",
  censusVerdict({ x: fatPools }).verdict === "RE-EXAMINE");

// ── done ───────────────────────────────────────────────────────────────────
console.log(`census-class test: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "CENSUS-CLASS-TEST ✅" : "CENSUS-CLASS-TEST ❌");
process.exit(failed === 0 ? 0 : 1);
