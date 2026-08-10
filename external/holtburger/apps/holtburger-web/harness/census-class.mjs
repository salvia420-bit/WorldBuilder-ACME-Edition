#!/usr/bin/env node
// harness/census-class.mjs — CENSUS-CLASS spike (T00; SPEC §3 T00, F-11.13,
// pass-07 D-07.2/S3/Q1, pass-10 DT-31/32): class-cardinality census over
// TODAY'S materials. Answers, with a measurement, pass 7's single most
// load-bearing [A]: are there ≤ ~48 material classes / ≤ ~300 projected
// (sector × class) pools at settled Nanto + Town Network — or does the S3
// class key fragment (and on which axis)?
//
// WHAT IT DOES
// ------------
// A page-side collector (`collectClassCensusInPage`, injected via
// page.evaluate — a one-shot snippet, deliberately NOT a __diag surface)
// walks the live material populations:
//   * scene traversal under `liveScene3d.worldRoot`'s world groups
//     (terrain/buildings/statics/cells; entities skipped — charter I5-kept):
//     plain Meshes, per-LB batches (`__staticBatch`), cross-LB batches
//     (`__staticBatchCrossLb`, static_batch_x.js:1461-1489), statArrayMerge
//     pool buckets (`__statArrayMerged`), atlas buckets
//     (`__statAtlasCrossLb`, static_atlas.js:1225-1242), animated-scenery
//     InstancedMeshes (`isAnimatedSceneryInstanced`, animated_scenery.js:571),
//   * the MaterialCache maps (materials.js:2823-3062) as the resident
//     cache-side population (no domain/shadow axes there — reported as a
//     separate core-key cardinality, never mixed into the verdict).
// Every (mesh, material) usage is reduced to RAW AXIS FACTS; the node-side
// reducer builds EXACTLY pass 7 S3's canonical class key from them:
//
//   "<domain>|<state>|<patch>|<tex>|<shadow>"
//    domain = st | ec            (tr, as = reserved labels, reported apart)
//    state  = t{0|1} a{exact alphaTest string} w{0|1} b{mode|cS.D.E}
//             r{w|c} s{f|d}      (the _stateKeyOf axes, static_atlas.js:480-498,
//                                 + side; alphaTest full-precision string)
//    patch  = _patchSetCacheKey verbatim (materials.js:553-585:
//             hb|d|c|p|l|a|b|f|s|k|v<set>) + "#"+configKey for MECH-B sets
//             (statics.js:1791-1802 token rule)
//    tex    = x{t}{f7|f8}        ARRAY-PAGE TIER + compressed format —
//             t = clamp(ceil(log2(max dim)), 8, 11) (square pow2 pages
//             256²/512²/1024²/2048²), the pass-5 TEXREF axis as amended by
//             the T00 re-key 2026-08-09, approximated by live texture dims
//    shadow = c{0|1}r{0|1}       (node-level flags)
//
// The key BUILDERS are no longer defined here: they live in
// `scene3d/pool_class_key.js` (T22/ST9), the one place the runtime pool
// registry, this census and the boot prewarm list all read, so a census can
// never measure a different key than the renderer builds. They are
// re-exported below for the existing test surface.
//
// Projected pools = Σ over pooled classes (domains st + ec) of the class's
// distinct world-sector count; sector = 2×2 tiles = 4×4 LBs = 768 m,
// world-absolute (pass 7 D-07.1), from per-instance world positions
// (BatchedMesh matrices texture / InstancedMesh instanceMatrix).
//
// SCALE / WALLS: this is a RESIDENT-scale census of the scene-ATTACHED
// population (+ the cache maps at @cached). resident ≠ drawn ≠ submitted;
// warm-parked LBs are DETACHED from the scene and therefore not walked —
// stated, not hidden. Metrics are @resident / @cached tagged; the RESULTS-v2
// verdict is EXPLORATORY (a census informs; the WITHIN-BOUNDS/RE-EXAMINE
// verdict line is printed and lands in the T00 report + notes).
//
// RUN (live census; serve.py on :8765 + live ACE on :9000, ONE chromium):
//   node harness/census-class.mjs --live \
//     [--scenes nanto,townnetwork] [--out results.json] \
//     [--artifact t00-class-census.json] [--snapdir /mnt/wbterminal2/reeng/T00] \
//     [--commit sha] [--wasm-profile release|DEV-WASM|unknown]
// Offline re-reduce of a captured snapshot:
//   node harness/census-class.mjs --reduce snap.json --scene nanto
//
// The reducer + key builder are exported for harness/test_census_class.mjs.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createReport } from "./lib/report.mjs";
import {
  classKeyOf as _classKeyOf,
  programClassKeyOf as _programClassKeyOf,
  stateKeyOf as _stateKeyOf,
  patchKeyOf as _patchKeyOf,
  texKeyOf as _texKeyOf,
  passClassOf as _passClassOf,
  POOL_DOMAINS as _POOL_DOMAINS,
} from "../scene3d/pool_class_key.js";

// ── SPEC §3 T00 acceptance anchors, as re-baselined by the T00 re-key
// (2026-08-09, applied in 24de3936 to pass-07 S5.3 + SPEC §3 T00): the total
// class bound splits from the PROGRAM class bound, because the page-tier tex
// axis is a texStorage3D-allocation axis, not a GLSL-program axis. Measured
// under the amended key: 63/271 (Nanto), 51/238 (Town Network), program
// classes 24/23.
export const BOUNDS = Object.freeze({ classes: 72, programClasses: 48, pools: 300 });

// ─────────────────────────────────────────────────────────────────────────────
// Page-side collector. MUST be self-contained (Playwright serializes it):
// no imports, no closure over harness scope, THREE constants inlined
// (RepeatWrapping=1000, CustomBlending=5, NormalBlending=1, sides 0/1/2 —
// stable three.js constants).
// ─────────────────────────────────────────────────────────────────────────────
export function collectClassCensusInPage() {
  const REPEAT_WRAPPING = 1000;
  const CUSTOM_BLENDING = 5;
  const out = { meta: {}, records: [], cache: null, skipped: {}, errors: [] };
  try {
    const ls = window.liveScene3d;
    if (!ls || !ls.worldRoot) return { error: "liveScene3d/worldRoot absent" };

    let pose = null;
    try { pose = window.__sessionHandle?.getLocalPlayerPose?.() ?? null; } catch (_) { /* meta only */ }
    out.meta = {
      url: location.href,
      bootState: window.__bootState ?? null,
      quality: ls.quality?.preset ?? null,
      landblockId: pose && pose.landblockId != null ? (pose.landblockId >>> 0) : null,
      terrainBakedLbs: (ls.terrainBakedLbs && ls.terrainBakedLbs.size) || null,
      materialCacheStats: (() => {
        try { return window.__diag?.materialCache?.() ?? null; } catch (_) { return null; }
      })(),
      ts: Date.now(),
    };

    // Instance sectors need current matrixWorld (renderOnDemand may have
    // frozen the auto-update); one forced pass is cheap at census scale.
    try { ls.scene.updateMatrixWorld(true); } catch (_) { /* fail-soft */ }

    // VFX configKey reverse index: vfxVariants keys are
    // `${did}|${setKey}|${configKey}` (materials.js getCachedVariant).
    const mc = ls.materialCache || null;
    const vfxCfg = new Map();
    const harvestVfx = (map) => {
      if (!map || typeof map.forEach !== "function") return;
      map.forEach((mat, key) => {
        try {
          const parts = String(key).split("|");
          if (parts.length >= 3 && mat) vfxCfg.set(mat, parts.slice(2).join("|"));
        } catch (_) { /* one bad key never kills the census */ }
      });
    };
    if (mc) { harvestVfx(mc.vfxVariants); harvestVfx(mc.vfxPalettedVariants); }

    // Bucket-name parser: atlas `stat-atlas-x-<w>x<h>|t|at|dw|blend|wr[..][|f7|f8]`
    // (static_atlas.js _bucketKeyFor:1097-1100 + bm.name:1243) and pool
    // material `stat-array-pool-<same shape, stricter middle>` (static_array_pool.js:438).
    // Fields 0..5 are positionally stable in BOTH (documented in
    // _strictStateKeyOf: "Fields 0..4 are left in place").
    const parseBucketName = (name, prefix) => {
      try {
        const parts = name.slice(prefix.length).split("|");
        if (parts.length < 6) return null;
        const dm = /^(\d+)x(\d+)$/.exec(parts[0]);
        if (!dm) return null;
        // VFX token field (pool keys only): `|x<setKey>#<cfgJson>` or `|x-`.
        let vfxToken = null;
        const xi = name.indexOf("|x", prefix.length);
        if (xi >= 0) {
          let t = name.slice(xi + 2);
          t = t.replace(/\|f[78]$/, "");
          if (t !== "-") vfxToken = t;
        }
        return {
          w: +dm[1], h: +dm[2],
          wrap: parts[5] === "w" ? "w" : "c",
          bc7: /\|f7(\||$)/.test(name),
          vfxToken,
        };
      } catch (_) { return null; }
    };

    // World-position → AC coords → 768 m world-sector key. worldRoot carries
    // rotation.x = -PI/2 (index.js:1412): ac(x,y,z) → world(x, z, -y), so
    // acX = wx, acY = -wz.
    const sectorsOfMesh = (mesh) => {
      const secs = new Set();
      let n = 0;
      let unknown = false;
      const me = mesh.matrixWorld && mesh.matrixWorld.elements;
      const add = (lx, ly, lz) => {
        const wx = me[0] * lx + me[4] * ly + me[8] * lz + me[12];
        const wz = me[2] * lx + me[6] * ly + me[10] * lz + me[14];
        const acX = wx;
        const acY = -wz;
        secs.add(`s${Math.floor(acX / 768)}x${Math.floor(acY / 768)}`);
      };
      try {
        if (!me) { unknown = true; }
        else if (mesh.isBatchedMesh) {
          const info = mesh._instanceInfo;
          const md = mesh._matricesTexture && mesh._matricesTexture.image
            && mesh._matricesTexture.image.data;
          if (Array.isArray(info) && md) {
            for (let i = 0; i < info.length; i++) {
              const inf = info[i];
              if (!inf || inf.active === false) continue;
              add(md[i * 16 + 12], md[i * 16 + 13], md[i * 16 + 14]);
              n++;
            }
          } else { unknown = true; n = (mesh.userData && mesh.userData.instances) || 0; }
        } else if (mesh.isInstancedMesh) {
          const a = mesh.instanceMatrix && mesh.instanceMatrix.array;
          const cnt = mesh.count | 0;
          if (a) { for (let i = 0; i < cnt; i++) { add(a[i * 16 + 12], a[i * 16 + 13], a[i * 16 + 14]); n++; } }
          else { unknown = true; n = cnt; }
        } else {
          add(0, 0, 0); n = 1;
        }
      } catch (_) { unknown = true; }
      return { sectors: [...secs], instances: n, unknown };
    };

    const agg = new Map();
    let matIdSeq = 0;
    const matIds = new Map();
    const idOf = (m) => {
      let v = matIds.get(m);
      if (v === undefined) { v = matIdSeq++; matIds.set(m, v); }
      return v;
    };

    const coreAxesOf = (mat, mesh) => {
      const mu = mat.userData || {};
      const ud = (mesh && mesh.userData) || {};
      let parsed = null;
      if (typeof mat.name === "string" && mat.name.startsWith("stat-array-pool-")) {
        parsed = parseBucketName(mat.name, "stat-array-pool-");
      } else if (mesh && String(mesh.name || "").startsWith("stat-atlas-x-")) {
        parsed = parseBucketName(String(mesh.name), "stat-atlas-x-");
      }
      // Texture axis: parsed bucket key wins (the bucket material's own map is
      // a 1×1 dummy — makeArrayMaterial); else atlas array on mesh.userData;
      // else the material's map.
      let texW = 0, texH = 0, compressed = false, hasTex = false;
      if (parsed) { texW = parsed.w; texH = parsed.h; compressed = parsed.bc7; hasTex = true; }
      if (!hasTex) {
        const arr = ud.diffArray;
        const tex = (arr && arr.image) ? arr : (mat.map || null);
        const img = tex && tex.image;
        if (img && img.width) {
          texW = img.width | 0; texH = img.height | 0;
          compressed = tex.isCompressedTexture === true;
          hasTex = true;
        }
      }
      // Wrap axis (RND-33): resolved member wrap. For array-material buckets
      // the member wrap lives ONLY in the bucket key (the array itself is
      // clamp-addressed) — parse it; else read mat.map.wrapS.
      const wrap = parsed ? parsed.wrap
        : (mat.map && mat.map.wrapS === REPEAT_WRAPPING) ? "w" : "c";
      const b = (mat.blending === undefined || mat.blending === null) ? 1 : mat.blending;
      const patch = {
        d: mu.detailEnabled ? 1 : 0, c: mu.csmEnabled ? 1 : 0, p: mu.pomEnabled ? 1 : 0,
        l: mu.lightClampRetail ? 1 : 0, a: mu.__aoPatched ? 1 : 0, b: mu.__depthBiased ? 1 : 0,
        f: mu.__floorBiased ? 1 : 0, s: mu.__staticBiased ? 1 : 0, k: mu.__acBakedLight ? 1 : 0,
        v: typeof mu.__vfxSetKey === "string" ? mu.__vfxSetKey : "",
      };
      let vfxConfigKey = null;
      if (patch.v) {
        vfxConfigKey = vfxCfg.get(mat) ?? null;
        if (vfxConfigKey === null && parsed && parsed.vfxToken) {
          const hi = parsed.vfxToken.indexOf("#");
          if (hi >= 0) vfxConfigKey = parsed.vfxToken.slice(hi + 1);
        }
        if (vfxConfigKey === null) vfxConfigKey = "?"; // set present, config unresolvable — counted, flagged
      }
      return {
        transparent: mat.transparent === true,
        alphaTest: +(mat.alphaTest || 0),
        depthWrite: mat.depthWrite === false ? false : true,
        blending: b,
        blendTriple: b === CUSTOM_BLENDING
          ? `${mat.blendSrc}.${mat.blendDst}.${mat.blendEquation}` : null,
        wrap,
        side: mat.side | 0,
        patch, vfxConfigKey,
        texW, texH, texCompressed: !!compressed, hasTex,
        matType: mat.type || null,
        surfaceDid: (mu.surfaceDid >>> 0) || 0,
      };
    };

    const skipped = { entities: 0, particles: 0, other: 0 };
    const pushUsage = (mesh, mat, domain, source) => {
      try {
        const core = coreAxesOf(mat, mesh);
        const rec = {
          ...core,
          domain, source,
          castShadow: mesh.castShadow === true,
          receiveShadow: mesh.receiveShadow === true,
        };
        const sig = JSON.stringify([
          rec.domain, rec.transparent, rec.alphaTest, rec.depthWrite,
          rec.blending, rec.blendTriple, rec.wrap, rec.side, rec.patch,
          rec.vfxConfigKey, rec.texW, rec.texH, rec.texCompressed,
          rec.castShadow, rec.receiveShadow, rec.source, rec.matType,
        ]);
        let a = agg.get(sig);
        if (!a) {
          a = {
            ...rec,
            instances: 0, meshes: 0, hiddenMeshes: 0, sectorsUnknown: 0,
            _mats: new Set(), _sectors: new Set(), _dids: new Set(),
          };
          agg.set(sig, a);
        }
        const sw = sectorsOfMesh(mesh);
        a.instances += sw.instances;
        a.meshes += 1;
        a._mats.add(idOf(mat));
        for (const s of sw.sectors) a._sectors.add(s);
        if (sw.unknown) a.sectorsUnknown += 1;
        if (mesh.visible === false) a.hiddenMeshes += 1;
        if (rec.surfaceDid && a._dids.size < 12) a._dids.add(rec.surfaceDid);
      } catch (e) {
        out.errors.push("pushUsage: " + ((e && e.message) || String(e)));
      }
    };

    // index.js:1415-1420 — the world groups. Entities excluded (charter I5).
    const groupDomains = { terrain: "tr", buildings: "st", statics: "st", cells: "ec", entities: null };
    const walk = (node, domain) => {
      if (!node) return;
      const ud = node.userData || {};
      const nm = String(node.name || "");
      if (ud.__particle || nm.startsWith("particle-")) { skipped.particles++; return; }
      if (node.isMesh || node.isBatchedMesh || node.isInstancedMesh) {
        let d = domain;
        let source = "mesh";
        if (ud.isAnimatedSceneryInstanced) { d = "as"; source = "animinst"; }
        else if (ud.__statAtlasCrossLb) source = "atlas";
        else if (ud.__statArrayMerged) source = "batchx-merged";
        else if (ud.__staticBatchCrossLb) source = "batchx";
        else if (ud.__staticBatch) source = "lb-batch";
        else if (node.isBatchedMesh) source = "batched";
        else if (node.isInstancedMesh) source = "instanced";
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const m of mats) if (m && m.isMaterial !== false) pushUsage(node, m, d, source);
      }
      const kids = node.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i], domain);
    };
    for (const child of ls.worldRoot.children) {
      const d = groupDomains[String(child.name || "")];
      if (d === null) { skipped.entities++; continue; }
      if (d === undefined) { skipped.other++; walk(child, "other"); continue; }
      walk(child, d);
    }
    out.skipped = skipped;

    out.records = [...agg.values()].map((a) => {
      const { _mats, _sectors, _dids, ...rest } = a;
      return { ...rest, mats: _mats.size, sectors: [..._sectors], dids: [..._dids] };
    });

    // Cache-side resident population (materials.js:2823-3062 maps). No
    // domain/shadow axes here — core-key cardinality only, kept apart from
    // the pooled verdict. `liveScene3d.materialCache` is an init3D snapshot
    // (may be null if the cache was minted after the facade — the known
    // snapshot trap); reported honestly either way.
    if (mc) {
      const cmaps = [
        "materials", "frontSideMaterials", "floorBiasMaterials",
        "staticBiasMaterials", "cellBakedMaterials", "vfxVariants",
        "vfxPalettedVariants", "palettedMaterials", "particleUnlitMaterials",
        "_animatedMaterials", "didMaterials",
      ];
      const cacheAgg = new Map();
      const sizes = {};
      for (const name of cmaps) {
        const map = mc[name];
        if (!map || typeof map.forEach !== "function") continue;
        sizes[name] = map.size;
        map.forEach((entry) => {
          try {
            const m = entry && entry.isMaterial ? entry
              : (entry && entry.material && entry.material.isMaterial ? entry.material : null);
            if (!m) return;
            const core = coreAxesOf(m, null);
            const sig = JSON.stringify([
              name, core.transparent, core.alphaTest, core.depthWrite,
              core.blending, core.blendTriple, core.wrap, core.side,
              core.patch, core.vfxConfigKey, core.texW, core.texH,
              core.texCompressed, core.matType,
            ]);
            let a = cacheAgg.get(sig);
            if (!a) { a = { ...core, map: name, mats: 0 }; cacheAgg.set(sig, a); }
            a.mats += 1;
          } catch (_) { /* one odd entry never kills the census */ }
        });
      }
      out.cache = { available: true, sizes, records: [...cacheAgg.values()] };
    } else {
      out.cache = { available: false, stats: out.meta.materialCacheStats };
    }
    return out;
  } catch (e) {
    return { error: (e && e.message) || String(e), partial: out };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Node-side reducer — pass 7 S3 canonical key + census arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

// The S3 key builders live in scene3d/pool_class_key.js (the single source
// shared with the runtime pool registry + the prewarm list). Re-exported so
// harness/test_census_class.mjs and the offline re-key evaluators keep their
// import surface.
export const stateKeyOf = _stateKeyOf;
export const patchKeyOf = _patchKeyOf;
export const texKeyOf = _texKeyOf;
export const classKeyOf = _classKeyOf;
export const programClassKeyOf = _programClassKeyOf;
export const passClassOf = _passClassOf;

const POOL_DOMAINS = _POOL_DOMAINS;

/**
 * Reduce a page snapshot to the census verdict inputs.
 * @param {{records: object[], cache?: object, meta?: object}} snapshot
 * @returns census object (see fields below)
 */
export function reduceClassCensus(snapshot) {
  const records = snapshot?.records ?? [];
  const classes = new Map(); // classKey -> aggregate
  const domains = {};
  const passes = { opaque: 0, additive: 0, translucent: 0 };
  const warnings = [];
  const allSectors = new Set();

  for (const rec of records) {
    const key = classKeyOf(rec);
    let c = classes.get(key);
    if (!c) {
      c = {
        key, domain: rec.domain, pass: passClassOf(rec),
        instances: 0, mats: 0, meshes: 0, sectors: new Set(),
        sectorsUnknown: 0, sources: new Set(), dids: new Set(), recs: [],
      };
      classes.set(key, c);
    }
    c.instances += rec.instances | 0;
    c.mats += rec.mats | 0;
    c.meshes += rec.meshes | 0;
    for (const s of rec.sectors ?? []) {
      c.sectors.add(s);
      if (POOL_DOMAINS.includes(rec.domain)) allSectors.add(s);
    }
    c.sectorsUnknown += rec.sectorsUnknown | 0;
    c.sources.add(rec.source);
    for (const d of rec.dids ?? []) if (c.dids.size < 12) c.dids.add(d);
    c.recs.push(rec);
    if (rec.vfxConfigKey === "?") {
      warnings.push(`class ${key}: VFX set "${rec.patch?.v}" config unresolvable (counted as one config)`);
    }
  }

  for (const c of classes.values()) {
    domains[c.domain] = domains[c.domain] || { classes: 0, instances: 0, mats: 0 };
    domains[c.domain].classes += 1;
    domains[c.domain].instances += c.instances;
    domains[c.domain].mats += c.mats;
    if (POOL_DOMAINS.includes(c.domain)) passes[c.pass] += c.instances;
  }

  const pooled = [...classes.values()].filter((c) => POOL_DOMAINS.includes(c.domain));
  // A pooled class whose instances have no resolvable sectors still needs
  // ≥ 1 pool — conservative floor, counted and warned.
  let projectedPools = 0;
  for (const c of pooled) {
    const n = c.sectors.size > 0 ? c.sectors.size : (c.instances > 0 || c.sectorsUnknown > 0 ? 1 : 0);
    c.pools = n;
    projectedPools += n;
    if (c.sectors.size === 0 && c.sectorsUnknown > 0) {
      warnings.push(`class ${c.key}: sectors unresolvable for ${c.sectorsUnknown} mesh(es) — floored at 1 pool`);
    }
  }

  // Axis-explosion analysis: pooled-class cardinality with one axis
  // neutralized at a time — the "which axis explodes the key" diagnostic.
  const axisDrop = {
    domain: (r) => ({ ...r, domain: "st" }),
    stateAlphaTest: (r) => ({ ...r, alphaTest: 0 }),
    stateBlend: (r) => ({ ...r, blending: 1, blendTriple: null, transparent: false }),
    stateWrap: (r) => ({ ...r, wrap: "c" }),
    stateSide: (r) => ({ ...r, side: 2 }),
    stateDepthWrite: (r) => ({ ...r, depthWrite: true }),
    patchBias: (r) => ({ ...r, patch: { ...r.patch, b: 0, f: 0, s: 0, k: 0 } }),
    patchVfx: (r) => ({ ...r, patch: { ...r.patch, v: "" }, vfxConfigKey: null }),
    vfxConfigOnly: (r) => (r.patch?.v ? { ...r, vfxConfigKey: "*" } : r),
    texDims: (r) => ({ ...r, texW: 0, texH: 0, hasTex: false }),
    texFormat: (r) => ({ ...r, texCompressed: false }),
    shadow: (r) => ({ ...r, castShadow: true, receiveShadow: true }),
  };
  const pooledRecs = records.filter((r) => POOL_DOMAINS.includes(r.domain));
  // PROGRAM classes — the key modulo the ENTIRE tex axis (dims AND format
  // never change the GLSL program). This is the D-07.9 prewarm population and
  // the p99 link-storm term's key; bounded separately from total classes
  // since the T00 re-key (page tier is a texStorage3D axis, not a program
  // axis).
  const programClasses = new Set(pooledRecs.map((r) => programClassKeyOf(r))).size;
  const axisAnalysis = {};
  for (const [axis, drop] of Object.entries(axisDrop)) {
    const set = new Set(pooledRecs.map((r) => classKeyOf(drop(r))));
    axisAnalysis[axis] = { classesWithoutAxis: set.size, contributes: pooled.length - set.size };
  }

  // Cache-side core-key cardinality (state|patch|tex, no domain/shadow).
  let cache = null;
  const cs = snapshot?.cache;
  if (cs && cs.available && Array.isArray(cs.records)) {
    const perMap = {};
    const allCore = new Set();
    let totalMats = 0;
    for (const rec of cs.records) {
      const core = `${stateKeyOf(rec)}|${patchKeyOf(rec)}|${texKeyOf(rec)}`;
      allCore.add(core);
      perMap[rec.map] = perMap[rec.map] || { mats: 0, coreClasses: new Set() };
      perMap[rec.map].mats += rec.mats | 0;
      perMap[rec.map].coreClasses.add(core);
      totalMats += rec.mats | 0;
    }
    cache = {
      available: true,
      sizes: cs.sizes ?? {},
      totalMats,
      coreClasses: allCore.size,
      perMap: Object.fromEntries(
        Object.entries(perMap).map(([k, v]) => [k, { mats: v.mats, coreClasses: v.coreClasses.size }]),
      ),
    };
  } else if (cs) {
    cache = { available: false, stats: cs.stats ?? null };
    warnings.push("materialCache unreachable via liveScene3d snapshot — cache-side census unavailable (scene walk unaffected)");
  }

  const totalInstances = pooled.reduce((a, c) => a + c.instances, 0);
  const totalMats = pooled.reduce((a, c) => a + c.mats, 0);
  const list = pooled
    .map((c) => ({
      key: c.key, domain: c.domain, pass: c.pass, instances: c.instances,
      mats: c.mats, meshes: c.meshes, pools: c.pools,
      sectors: c.sectors.size, sources: [...c.sources],
      dids: [...c.dids].map((d) => "0x" + (d >>> 0).toString(16).padStart(8, "0")),
    }))
    .sort((a, b) => b.pools - a.pools || b.instances - a.instances);

  const reserved = {};
  for (const c of classes.values()) {
    if (POOL_DOMAINS.includes(c.domain) || c.domain === "other") continue;
    reserved[c.domain] = reserved[c.domain] || { classes: 0, instances: 0, mats: 0 };
    reserved[c.domain].classes += 1;
    reserved[c.domain].instances += c.instances;
    reserved[c.domain].mats += c.mats;
  }

  return {
    meta: snapshot?.meta ?? {},
    skipped: snapshot?.skipped ?? {},
    errors: snapshot?.errors ?? [],
    pooledClasses: pooled.length,
    programClasses,
    projectedPools,
    pooledMaterials: totalMats,
    pooledInstances: totalInstances,
    sectors: allSectors.size,
    passes,
    domains,
    reserved,
    list,
    axisAnalysis,
    cache,
    warnings,
  };
}

/** SPEC §3 T00 verdict over one or more reduced scenes. */
export function censusVerdict(reducedScenes) {
  const offending = [];
  for (const [scene, r] of Object.entries(reducedScenes)) {
    if (r.pooledClasses > BOUNDS.classes) offending.push(`${scene}: classes ${r.pooledClasses} > ${BOUNDS.classes}`);
    if (r.programClasses != null && r.programClasses > BOUNDS.programClasses) {
      offending.push(`${scene}: programClasses ${r.programClasses} > ${BOUNDS.programClasses}`);
    }
    if (r.projectedPools > BOUNDS.pools) offending.push(`${scene}: pools ${r.projectedPools} > ${BOUNDS.pools}`);
  }
  return {
    verdict: offending.length === 0 ? "WITHIN-BOUNDS" : "RE-EXAMINE",
    offending,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

function printScene(name, r) {
  console.log(`\n── ${name} ──────────────────────────────────────────────`);
  console.log(`  lb=0x${(r.meta.landblockId ?? 0).toString(16).padStart(8, "0")} quality=${r.meta.quality} terrainBakedLbs=${r.meta.terrainBakedLbs}`);
  console.log(`  pooled classes (st+ec): ${r.pooledClasses}   program classes: ${r.programClasses}   projected pools: ${r.projectedPools}`);
  console.log(`  pooled materials: ${r.pooledMaterials}  instances: ${r.pooledInstances}  sectors: ${r.sectors}`);
  console.log(`  pass split (pooled instances): opaque=${r.passes.opaque} additive=${r.passes.additive} translucent=${r.passes.translucent}`);
  for (const [d, v] of Object.entries(r.domains)) {
    console.log(`  domain ${d}: ${v.classes} classes, ${v.instances} instances, ${v.mats} materials`);
  }
  if (r.cache?.available) {
    console.log(`  cache: ${r.cache.totalMats} materials over ${r.cache.coreClasses} core keys`);
  } else if (r.cache) {
    console.log("  cache: UNAVAILABLE via liveScene3d snapshot");
  }
  console.log("  top classes by projected pools:");
  for (const c of r.list.slice(0, 10)) {
    console.log(`    pools=${String(c.pools).padStart(3)} inst=${String(c.instances).padStart(6)} mats=${String(c.mats).padStart(4)} [${c.sources.join(",")}] ${c.key.length > 110 ? c.key.slice(0, 110) + "…" : c.key}`);
  }
  console.log("  axis analysis (classes if axis removed / classes the axis adds):");
  for (const [axis, v] of Object.entries(r.axisAnalysis)) {
    console.log(`    ${axis.padEnd(16)} ${String(v.classesWithoutAxis).padStart(4)}  (+${v.contributes})`);
  }
  for (const w of r.warnings.slice(0, 8)) console.log(`  ⚠ ${w}`);
  if (r.errors.length) console.log(`  ⚠ ${r.errors.length} collector errors (first: ${r.errors[0]})`);
}

function metricsOf(r) {
  const m = {
    "classes@resident": r.pooledClasses,
    "programClasses@resident": r.programClasses,
    "projectedPools@resident": r.projectedPools,
    "classMaterials@resident": r.pooledMaterials,
    "classInstances@resident": r.pooledInstances,
    "sectors@resident": r.sectors,
    "opaqueInstances@resident": r.passes.opaque,
    "additiveInstances@resident": r.passes.additive,
    "translucentInstances@resident": r.passes.translucent,
    "reservedClasses@resident": Object.values(r.reserved).reduce((a, v) => a + v.classes, 0),
    "terrainBakedLbs@resident": r.meta.terrainBakedLbs ?? null,
  };
  if (r.cache?.available) {
    m["cacheMaterials@cached"] = r.cache.totalMats;
    m["cacheCoreClasses@cached"] = r.cache.coreClasses;
  }
  return m;
}

async function settleScene(page, { stableMs = 30000, pollMs = 5000, timeoutMs = 420000 } = {}) {
  const t0 = Date.now();
  let last = null;
  let stableSince = null;
  const samples = [];
  while (Date.now() - t0 < timeoutMs) {
    const s = await page.evaluate(() => {
      const ls = window.liveScene3d;
      let meshes = 0;
      try { ls?.worldRoot?.traverse((o) => { if (o.isMesh || o.isBatchedMesh || o.isInstancedMesh) meshes++; }); } catch (_) { /* count best-effort */ }
      let mats = null;
      try { mats = window.__diag?.materialCache?.()?.entries ?? null; } catch (_) { /* absent pre-bake */ }
      let lbs = null;
      try { lbs = ls?.terrainBakedLbs?.size ?? null; } catch (_) { /* absent early */ }
      try { window.__renderOnce?.(); } catch (_) { /* renderOnDemand kick */ }
      return { lbs, meshes, mats, t: Date.now() };
    });
    samples.push(s);
    const sig = `${s.lbs}|${s.meshes}|${s.mats}`;
    if (sig === last) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return { settled: true, sample: s, samples };
    } else {
      stableSince = null;
      last = sig;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { settled: false, sample: samples[samples.length - 1] ?? null, samples };
}

async function liveMain() {
  const { launchAndEnter } = await import("./lib/boot.mjs");
  const scenes = (arg("scenes", "nanto,townnetwork")).split(",").filter(Boolean);
  const snapdir = arg("snapdir", "/mnt/wbterminal2/reeng/T00");
  try { mkdirSync(snapdir, { recursive: true }); } catch (_) { /* exists */ }

  // Zero-GPU bot recipe + census needs: quality mid (pass-10 Q5 — match the
  // 1070 reference), nosw (SW cache trap), agent=1 (netWorker keepalive).
  // `--lbcap N` caps the resident LRU (`?lbCap`, index.js:3218; default 203)
  // — the documented 8 GB-box OOM mitigation (url-flags.md terrainBatch row:
  // "the uncapped ring OOM-killed the 8GB box's renderer"). A capped run is a
  // BOUNDED-RING census: class cardinality is still content-driven, but
  // sector/pool counts are measured at the capped ring and the full-ring pool
  // ceiling must be stated as classes × 16 sectors (pass 7 D-07.1). The cap
  // rides the taint list.
  const lbCap = arg("lbcap", null);
  const query = {
    nosw: "1", renderOnDemand: "1", netDrainHz: "30",
    quality: "mid", agent: "1",
    ...(lbCap ? { lbCap: String(lbCap) } : {}),
  };
  console.log("census-class: launching headless census bot (one chromium)…");
  const { browser, page, url, inWorld, inWorldMs } = await launchAndEnter({ query, timeoutMs: 180000 });
  const reduced = {};
  const snapshots = {};
  try {
    if (!inWorld) throw new Error("BOOT-STALL: never reached in-world (see M9)");
    console.log(`census-class: in-world in ${inWorldMs} ms — ${url}`);

    const POI = { nanto: "Nanto", townnetwork: "Town Network" };
    for (const scene of scenes) {
      const poi = POI[scene] ?? scene;
      console.log(`census-class: @telepoi ${poi} …`);
      await page.evaluate((p) => window.__sessionHandle.sendChat(`@telepoi ${p}`), poi);
      await new Promise((r) => setTimeout(r, 8000)); // teleport + first burst
      const st = await settleScene(page);
      if (!st.settled) console.log(`census-class: ⚠ ${scene} did NOT plateau in time — capturing anyway (recorded)`);
      else console.log(`census-class: ${scene} settled (lbs=${st.sample.lbs} meshes=${st.sample.meshes} mats=${st.sample.mats})`);
      const snap = await page.evaluate(collectClassCensusInPage);
      if (snap.error) throw new Error(`collector failed at ${scene}: ${snap.error}`);
      snap.meta.settled = st.settled;
      snap.meta.settleSamples = st.samples.length;
      snapshots[scene] = snap;
      const snapPath = join(snapdir, `census-class-${scene}-${new Date().toISOString().slice(0, 10)}.json`);
      try { writeFileSync(snapPath, JSON.stringify(snap)); console.log(`census-class: snapshot → ${snapPath}`); } catch (e) { console.log(`census-class: ⚠ snapshot write failed: ${e.message}`); }
      reduced[scene] = reduceClassCensus(snap);
      printScene(scene, reduced[scene]);
    }
  } finally {
    try { await browser.close(); } catch (_) { /* already gone */ }
  }

  const v = censusVerdict(reduced);
  console.log(`\nVERDICT: ${v.verdict}${v.offending.length ? " — " + v.offending.join("; ") : ""} (bounds: classes ≤ ${BOUNDS.classes}, pools ≤ ${BOUNDS.pools})`);

  // RESULTS-v2 (EXPLORATORY — the census informs, it gates nothing itself;
  // the WITHIN-BOUNDS/RE-EXAMINE line above is the T00 deliverable).
  const taint = ["census-class", "renderOnDemand"];
  if (lbCap) taint.push(`lbCap=${lbCap}`);
  const report = createReport({
    bench: "CENSUS-CLASS",
    gate: "GATE-POOLS",
    protocol: "PC-6",
    url: Object.values(snapshots)[0]?.meta?.url ?? "unknown",
    commit: arg("commit", null),
    platform: { box: "wbterminal-laptop", renderer: "SwiftShader" },
    taint,
    wasmProfile: arg("wasm-profile", "unknown"),
  });
  for (const [scene, r] of Object.entries(reduced)) {
    report.addArm({
      arm: scene,
      verdict: "USABLE",
      metrics: metricsOf(r),
      settled: r.meta.settled === true,
      landblockId: r.meta.landblockId != null ? "0x" + r.meta.landblockId.toString(16).padStart(8, "0") : null,
      axisAnalysis: r.axisAnalysis,
      domains: r.domains,
      warnings: r.warnings.slice(0, 20),
    });
  }
  report.setVerdict("EXPLORATORY");
  report.setNotes(
    `CENSUS-CLASS spike (T00): ${v.verdict}` +
    (v.offending.length ? ` — ${v.offending.join("; ")}` : "") +
    `. Bounds [A]: classes ≤ ${BOUNDS.classes}, projected (sector×class) pools ≤ ${BOUNDS.pools} (pass 7 S5.3). ` +
    "Resident-scale, scene-ATTACHED population (warm-parked LBs are detached and not walked); resident ≠ drawn. " +
    "1070 confirm arm stays at GATE-POOLS (F-11.13).",
  );
  const outPath = arg("out", null);
  if (outPath) { report.write(outPath); console.log(`census-class: results → ${outPath}`); }

  const artifactPath = arg("artifact", null);
  if (artifactPath) {
    const union = new Map();
    for (const [scene, r] of Object.entries(reduced)) {
      for (const c of r.list) {
        let u = union.get(c.key);
        if (!u) { u = { key: c.key, domain: c.domain, pass: c.pass, scenes: {}, sources: new Set(), dids: new Set() }; union.set(c.key, u); }
        u.scenes[scene] = { instances: c.instances, mats: c.mats, pools: c.pools, sectors: c.sectors };
        for (const s of c.sources) u.sources.add(s);
        for (const d of c.dids) u.dids.add(d);
      }
    }
    const artifact = {
      generated: new Date().toISOString(),
      task: "T00",
      bench: "CENSUS-CLASS",
      bounds: BOUNDS,
      verdict: v.verdict,
      offending: v.offending,
      keyDoc: "pass-07 S3: <domain>|<state t,a,w,b,r,s>|<patch hb|d..k|v[#config]>|<tex x{dims}{f7|f8}>|<shadow c,r>",
      scenes: Object.fromEntries(Object.entries(reduced).map(([s, r]) => [s, {
        url: r.meta.url, landblockId: r.meta.landblockId, settled: r.meta.settled,
        pooledClasses: r.pooledClasses, projectedPools: r.projectedPools,
        sectors: r.sectors, passes: r.passes, domains: r.domains,
        reserved: r.reserved, axisAnalysis: r.axisAnalysis, cache: r.cache,
      }])),
      prewarmClassList: [...union.values()].map((u) => ({
        key: u.key, domain: u.domain, pass: u.pass, scenes: u.scenes,
        sources: [...u.sources], dids: [...u.dids],
      })),
    };
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    console.log(`census-class: class-list artifact → ${artifactPath}`);
  }
  return v;
}

async function main() {
  if (process.argv.includes("--live")) {
    const v = await liveMain();
    process.exit(v.verdict === "WITHIN-BOUNDS" ? 0 : 1);
  }
  const inPath = arg("reduce", arg("in", null));
  if (!inPath) {
    console.error("usage: node harness/census-class.mjs --live [--scenes a,b] [--out r.json] [--artifact t00.json]");
    console.error("   or: node harness/census-class.mjs --reduce snap.json --scene nanto");
    process.exit(2);
  }
  const snap = JSON.parse(readFileSync(inPath, "utf8"));
  const scene = arg("scene", "scene");
  const r = reduceClassCensus(snap);
  printScene(scene, r);
  const v = censusVerdict({ [scene]: r });
  console.log(`\nVERDICT: ${v.verdict}${v.offending.length ? " — " + v.offending.join("; ") : ""}`);
  process.exit(v.verdict === "WITHIN-BOUNDS" ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
