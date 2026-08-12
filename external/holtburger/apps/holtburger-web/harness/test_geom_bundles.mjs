// T13 (ST3, `?geomBundles`) — node battery for the HBG1 bundle consumer.
//
// What must hold:
//   PART 1 — flag grammar: EXACT-MATCH opt-in (on/1/true/yes), everything
//            else OFF (the flag-default footgun rule: only `=on`-class
//            values are real opt-ins).
//   PART 2 — arming gate: every missing leg (packSource, controller, wasm
//            exports, relief, placementId) DISARMS loudly; armed only when
//            all legs hold.
//   PART 3 — bundleToGeometryGroups ≡ meshToGeometryGroups on the same
//            triangle content: identical (surfaceDid → triangle multiset)
//            maps on the default arm (bucket by surface, doubleSided true,
//            per-surface stipple OR incl. the fallback-0 bucket), and the
//            (surface, sides) split under ?perPolyCull.
//   PART 4 — per-part groups: hinge passthrough + part-subset bucketing
//            (the buildings/anim-scenery shape).
//   PART 5 — env cell groups: resolved-DID bucketing + the acBakedLight
//            attribute (normalized u8, itemSize 3) on shared streams.
//   PART 6 — assemble wrappers: descriptor plumbing, missing-id routing,
//            __diag.geometry counters.
//   PART 7 — RELIEF-IN-BAKE (`?reliefBundles=on`, DEFAULT-OFF): flag
//            grammar, the relief arming legs (relief resolved ON + the
//            variant export + subdivLevel 0), the OFF-arm invariant (the
//            relief-free export is the one called), variant-export routing
//            when armed, and the 0-rows loud warning.
//
// Run:  cd apps/holtburger-web/ && node harness/test_geom_bundles.mjs

import * as THREE from "three";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL ${msg}`);
  }
}

// Minimal browser shims BEFORE importing the modules under test.
globalThis.window = globalThis.window || {
  location: { search: "" },
};

const gb = await import("../scene3d/geom_bundles.js");
const { meshToGeometryGroups } = await import("../scene3d/adapter.js");

// ---------------------------------------------------------------------------
// PART 1 — flag grammar
// ---------------------------------------------------------------------------
for (const [v, want] of [
  ["?geomBundles=on", true],
  ["?geomBundles=1", true],
  ["?geomBundles=true", true],
  ["?geomBundles=yes", true],
  ["?geomBundles=off", false],
  ["?geomBundles=0", false],
  ["?geomBundles=garbage", false],
  ["", false],
  ["?geomBundles", false],
]) {
  ok(
    gb.geomBundlesEnabled(v) === want,
    `flag grammar: "${v}" → ${want}`
  );
}

// ---------------------------------------------------------------------------
// PART 2 — arming gate
// ---------------------------------------------------------------------------
function armWith({ search, hbFetch, relief, wasm }) {
  globalThis.window.location.search = search;
  if (hbFetch === undefined) delete globalThis.__hbFetch;
  else globalThis.__hbFetch = hbFetch;
  if (relief === undefined) delete globalThis.__hbGfxRelief;
  else globalThis.__hbGfxRelief = relief;
  return gb.initGeomBundles({ wasmExports: wasm });
}
const fakeWasm = {
  assemble_model_geometry: () => {},
  assemble_envcell_geometry: () => {},
};
ok(
  armWith({ search: "?geomBundles=on", wasm: fakeWasm }) === false,
  "arming: requires ?packSource"
);
ok(
  armWith({
    search: "?geomBundles=on&packSource=on",
    wasm: fakeWasm,
  }) === false,
  "arming: requires an armed controller"
);
ok(
  armWith({
    search: "?geomBundles=on&packSource=on",
    hbFetch: { enabled: true },
    wasm: null,
  }) === false,
  "arming: requires the wasm exports"
);
ok(
  armWith({
    search: "?geomBundles=on&packSource=on",
    hbFetch: { enabled: true },
    relief: { enabled: true },
    wasm: fakeWasm,
  }) === false,
  "arming: explicit relief wins and disarms bundles"
);
ok(
  armWith({
    search: "?geomBundles=on&packSource=on&placementId=off",
    hbFetch: { enabled: true },
    wasm: fakeWasm,
  }) === false,
  "arming: ?placementId=off disarms (baked retail chain)"
);
ok(
  armWith({
    search: "?geomBundles=on&packSource=on",
    hbFetch: { enabled: true },
    wasm: fakeWasm,
  }) === true,
  "arming: all legs present → armed"
);
ok(gb.geomBundlesActive() === true, "geomBundlesActive reflects armed");
gb._testDisarm();
ok(gb.geomBundlesActive() === false, "testDisarm clears armed");
ok(
  armWith({ search: "?packSource=on", hbFetch: { enabled: true }, wasm: fakeWasm }) ===
    false,
  "flag absent → never arms"
);

// ---------------------------------------------------------------------------
// Shared triangle fixture → (fake wasm ModelMesh, bundle entry + buffer)
// ---------------------------------------------------------------------------
// Triangles in emission order. surface 0x…10 has TWO subsets (a stippled
// single-sided one and a doubleSided one — merged on the default arm, split
// under perPolyCull); surface 0x…20 is a back-face class; plus one
// fallback-bucket (no-surface) triangle.
const T = [
  // subset A: surface 0x10, dbl=false, stipple wrap+side
  { s: 0x08000010, dbl: false, stip: 0x3, v: [[0,0,0],[1,0,0],[1,1,0]], uv: [[0,0],[1,0],[1,1]], n: [0,0,1] },
  { s: 0x08000010, dbl: false, stip: 0x3, v: [[0,0,0],[1,1,0],[0,1,0]], uv: [[0,0],[1,1],[0,1]], n: [0,0,1] },
  // subset B: surface 0x20, dbl=false (back face), no stipple
  { s: 0x08000020, dbl: false, stip: 0x0, v: [[0,0,1],[1,1,1],[1,0,1]], uv: [[0,0],[1,1],[1,0]], n: [0,0,-1] },
  // subset C: surface 0x10, dbl=true, no stipple
  { s: 0x08000010, dbl: true, stip: 0x0, v: [[2,0,0],[3,0,0],[3,1,0]], uv: [[0,0],[1,0],[1,1]], n: [0,1,0] },
  // subset D: fallback (no surface)
  { s: 0, dbl: true, stip: 0x0, v: [[5,5,5],[6,5,5],[6,6,5]], uv: [[0,0],[0,0],[0,0]], n: [1,0,0] },
];

function makeFakeMesh() {
  const triCount = T.length;
  const positions = new Float32Array(triCount * 9);
  const uvs = new Float32Array(triCount * 6);
  const normals = new Float32Array(triCount * 9);
  const sIdx = new Uint8Array(triCount);
  const sidesTypes = new Uint8Array(triCount);
  const surfaces = [];
  const stipple = [];
  const sIdxOf = (did, st) => {
    if (did === 0) return 0xff;
    let i = surfaces.indexOf(did);
    if (i < 0) {
      i = surfaces.length;
      surfaces.push(did);
      stipple.push(0);
    }
    stipple[i] |= st;
    return i;
  };
  T.forEach((t, ti) => {
    for (let v = 0; v < 3; v += 1) {
      positions.set(t.v[v], ti * 9 + v * 3);
      uvs.set(t.uv[v], ti * 6 + v * 2);
      normals.set(t.n, ti * 9 + v * 3);
    }
    sIdx[ti] = sIdxOf(t.s, t.stip);
    sidesTypes[ti] = t.dbl ? 1 : 2;
  });
  return {
    triCount,
    positions,
    uvs,
    normals,
    surfaceIndices: sIdx,
    sidesTypes,
    surfaces: Uint32Array.from(surfaces),
    subsetStippled: Uint8Array.from(stipple),
  };
}

function makeBundle() {
  // Dedup verts over (pos, uv, n) — the corner identity at fixture scale.
  const verts = [];
  const key2idx = new Map();
  const vertOf = (p, uv, n) => {
    const k = JSON.stringify([p, uv, n]);
    let i = key2idx.get(k);
    if (i === undefined) {
      i = verts.length;
      verts.push({ p, uv, n });
      key2idx.set(k, i);
    }
    return i;
  };
  // Subsets in first-seen (surface, flags) order, contiguous index ranges.
  const subsetKeyOf = (t) =>
    `${t.s}|${(t.dbl ? 1 : 0) | (t.stip << 1)}`;
  const subsetOrder = [];
  const bySubset = new Map();
  for (const t of T) {
    const k = subsetKeyOf(t);
    if (!bySubset.has(k)) {
      bySubset.set(k, { s: t.s, flags: (t.dbl ? 1 : 0) | (t.stip << 1), tris: [] });
      subsetOrder.push(k);
    }
    bySubset.get(k).tris.push(t);
  }
  const indices = [];
  const subsets = [];
  for (const k of subsetOrder) {
    const sub = bySubset.get(k);
    const first = indices.length;
    for (const t of sub.tris) {
      for (let v = 0; v < 3; v += 1) {
        indices.push(vertOf(t.v[v], t.uv[v], t.n));
      }
    }
    subsets.push({
      surfaceRef: sub.s,
      flags: sub.flags,
      firstIndex: first,
      indexCount: indices.length - first,
    });
  }
  // Serialize: pos f32 | normal f32 | uv f32 | idx u16 pad4.
  const V = verts.length;
  const posBytes = V * 12;
  const idxOff = posBytes + V * 12 + V * 8;
  const idxBytes = (indices.length * 2 + 3) & ~3;
  const buffer = new Uint8Array(idxOff + idxBytes);
  const dv = new DataView(buffer.buffer);
  verts.forEach((v, i) => {
    for (let c = 0; c < 3; c += 1) dv.setFloat32(i * 12 + c * 4, v.p[c], true);
    for (let c = 0; c < 3; c += 1)
      dv.setFloat32(posBytes + i * 12 + c * 4, v.n[c], true);
    for (let c = 0; c < 2; c += 1)
      dv.setFloat32(posBytes + V * 12 + i * 8 + c * 4, v.uv[c], true);
  });
  indices.forEach((ix, i) => dv.setUint16(idxOff + i * 2, ix, true));
  const entry = {
    id: 0x01004001,
    didDegrade: 0x11000001,
    vtx: { off: 0, count: V },
    idx: { off: idxOff, count: indices.length, width: 2 },
    parts: [
      {
        partIndex: 0,
        hinge: [0.5, 1.5, 2.5, 1, 0, 0, 0],
        vtxBase: 0,
        vtxCount: V,
        idxFirst: 0,
        idxCount: indices.length,
        subsets,
      },
    ],
    fused: { subsets },
  };
  return { entry, buffer };
}

// Group → sorted triangle multiset (positions+uv+normals, JSON-keyed).
function groupTris(group) {
  const g = group.geometry;
  const pos = g.getAttribute("position");
  const uv = g.getAttribute("uv");
  const nrm = g.getAttribute("normal");
  const tris = [];
  const corner = (vi) => [
    [pos.getX(vi), pos.getY(vi), pos.getZ(vi)],
    [uv.getX(vi), uv.getY(vi)],
    [nrm.getX(vi), nrm.getY(vi), nrm.getZ(vi)],
  ];
  const idx = g.getIndex();
  const count = idx ? idx.count : pos.count;
  for (let t = 0; t < count / 3; t += 1) {
    const c = [];
    for (let v = 0; v < 3; v += 1) {
      const vi = idx ? idx.getX(t * 3 + v) : t * 3 + v;
      c.push(corner(vi));
    }
    tris.push(JSON.stringify(c));
  }
  tris.sort();
  return tris;
}

function groupMap(result) {
  const m = new Map();
  for (const g of result.groups) {
    const k = `${g.surfaceDid}|${g.doubleSided ? 1 : 0}`;
    const prev = m.get(k) || [];
    m.set(k, prev.concat(groupTris(g)).sort());
  }
  return m;
}

// ---------------------------------------------------------------------------
// PART 3 — equivalence, default arm + perPolyCull arm
// ---------------------------------------------------------------------------
{
  delete globalThis.__perPolyCull;
  const legacy = meshToGeometryGroups(makeFakeMesh());
  const { entry, buffer } = makeBundle();
  const bundle = gb.bundleToGeometryGroups(entry, buffer);

  ok(
    bundle.groups.length === legacy.groups.length,
    `default arm: same group count (${bundle.groups.length} vs ${legacy.groups.length})`
  );
  const lm = groupMap(legacy);
  const bm = groupMap(bundle);
  ok(lm.size === bm.size, "default arm: same bucket keys");
  for (const [k, v] of lm) {
    const b = bm.get(k);
    ok(!!b, `default arm: bucket ${k} present in bundle`);
    if (b) {
      ok(
        JSON.stringify(v) === JSON.stringify(b),
        `default arm: bucket ${k} triangle multiset identical`
      );
    }
  }
  // Per-surface stipple OR matches the legacy per-surface accumulation.
  const stippleOf = (r, did) =>
    r.groups.find((g) => g.surfaceDid === did)?.subsetStippled;
  ok(
    stippleOf(bundle, 0x08000010) === stippleOf(legacy, 0x08000010),
    `stipple OR for 0x…10 (${stippleOf(bundle, 0x08000010)} vs ${stippleOf(legacy, 0x08000010)})`
  );
  // Fallback bucket present with surfaceDid 0.
  ok(
    bundle.groups.some((g) => g.surfaceDid === 0),
    "fallback bucket (surfaceDid 0) present"
  );
  // surfaceDids excludes the fallback.
  ok(
    !bundle.surfaceDids.includes(0) &&
      bundle.surfaceDids.includes(0x08000010) &&
      bundle.surfaceDids.includes(0x08000020),
    "surfaceDids carries real DIDs only"
  );
  // setIndex present + shared position attribute across groups.
  ok(
    bundle.groups.every((g) => g.geometry.getIndex() !== null),
    "every bundle group is indexed (setIndex present)"
  );
  const attrs = new Set(bundle.groups.map((g) => g.geometry.getAttribute("position")));
  ok(attrs.size === 1, "groups share ONE position attribute (VBO sharing)");
  ok(
    bundle.groups.every((g) => g.geometry.boundingSphere !== null),
    "computeBoundingSphere ran"
  );

  // perPolyCull arm: (surface, sides) split.
  globalThis.__perPolyCull = true;
  const legacyPc = meshToGeometryGroups(makeFakeMesh());
  const bundlePc = gb.bundleToGeometryGroups(entry, buffer);
  ok(
    bundlePc.groups.length === legacyPc.groups.length,
    `perPolyCull arm: same group count (${bundlePc.groups.length} vs ${legacyPc.groups.length})`
  );
  const lpc = groupMap(legacyPc);
  const bpc = groupMap(bundlePc);
  for (const [k, v] of lpc) {
    ok(
      JSON.stringify(v) === JSON.stringify(bpc.get(k) || null),
      `perPolyCull arm: bucket ${k} identical`
    );
  }
  delete globalThis.__perPolyCull;
}

// ---------------------------------------------------------------------------
// PART 4 — per-part groups
// ---------------------------------------------------------------------------
{
  const { entry, buffer } = makeBundle();
  const parts = gb.bundleToPartGroups(entry, buffer);
  ok(parts.parts.length === 1, "one part out");
  const p = parts.parts[0];
  ok(
    p.hinge.x === 0.5 && p.hinge.y === 1.5 && p.hinge.z === 2.5 && p.hinge.qw === 1,
    "hinge passthrough"
  );
  ok(p.groups.length === 3, `part groups bucketed by surface — 0x10 merged (${p.groups.length})`);
  ok(
    parts.surfaceDids.has(0x08000010) && parts.surfaceDids.has(0x08000020),
    "part surfaceDids accumulated"
  );
  ok(gb.bundleToPartGroups({ missing: true }, buffer) === null, "missing part entry → null");
}

// ---------------------------------------------------------------------------
// PART 5 — env cell groups (baked light attribute)
// ---------------------------------------------------------------------------
{
  const { entry, buffer } = makeBundle();
  // Rewrap the model entry as a cell entry: resolved DIDs + a baked stream.
  const V = entry.vtx.count;
  const withBaked = new Uint8Array(buffer.length + V * 3 + 4);
  withBaked.set(buffer, 0);
  const bakedOff = buffer.length;
  for (let i = 0; i < V * 3; i += 1) withBaked[bakedOff + i] = (i * 7) & 0xff;
  const cellEntry = {
    cellId: 0x12340100,
    vtx: entry.vtx,
    idx: entry.idx,
    baked: { off: bakedOff },
    subsets: entry.fused.subsets.map((s) => ({
      surfaceDid: s.surfaceRef,
      flags: s.flags,
      firstIndex: s.firstIndex,
      indexCount: s.indexCount,
    })),
  };
  const r = gb.cellToGeometryGroups(cellEntry, withBaked);
  ok(r !== null && r.groups.length === 3, "cell groups built (surface-merged)");
  const g0 = r.groups[0].geometry;
  const baked = g0.getAttribute("acBakedLight");
  ok(!!baked && baked.itemSize === 3 && baked.normalized === true, "acBakedLight attribute normalized u8×3");
  ok(baked.array[3] === 21, "baked stream values pass through");
  ok(gb.cellToGeometryGroups({ missing: true }, withBaked) === null, "missing cell → null");
}

// ---------------------------------------------------------------------------
// PART 6 — assemble wrappers + diag counters
// ---------------------------------------------------------------------------
{
  const { entry, buffer } = makeBundle();
  const descriptor = JSON.stringify({
    models: [entry, { id: 0x01009999, missing: true }],
    assembled: 1,
    missing: 1,
    bytes: buffer.length,
  });
  gb._testArm({
    assemble_model_geometry: () => ({ buffer, descriptor }),
    assemble_envcell_geometry: () => ({
      buffer,
      descriptor: JSON.stringify({
        landblockId: 0x12340000,
        cells: [{ cellId: 1, missing: true }],
        assembled: 0,
        missing: 1,
        bytes: 0,
      }),
    }),
  });
  const before = gb.geomBundleStats().bundles.assembled;
  const res = gb.assembleModels([entry.id, 0x01009999]);
  ok(res !== null, "assembleModels returns under _testArm");
  ok(res.byModel.has(entry.id), "assembled model keyed");
  ok(
    res.missingIds.length === 1 && res.missingIds[0] === 0x01009999,
    "missing id routed to fallback list"
  );
  ok(
    gb.geomBundleStats().bundles.assembled === before + 1,
    "bundles.assembled counter advanced"
  );
  const env = gb.assembleEnvcells(0x12340000, [1]);
  ok(env !== null && env.missingIds.length === 1, "env missing cell routed");
  gb.countGeomFallback(3);
  ok(
    gb.geomBundleStats().geomFallback.modelsServedByRuntimeDecode >= 3,
    "geomFallback counter advances"
  );
  ok(
    globalThis.window.__diag?.geometry === gb.geomBundleStats(),
    "__diag.geometry installed and live"
  );
  gb._testDisarm();
  ok(gb.assembleModels([1]) === null, "disarmed assembleModels → null (legacy path)");
}

// ---------------------------------------------------------------------------
// PART 7 — RELIEF-IN-BAKE (`?reliefBundles=on`)
// ---------------------------------------------------------------------------
for (const [v, want] of [
  ["?reliefBundles=on", true],
  ["?reliefBundles=1", true],
  ["?reliefBundles=true", true],
  ["?reliefBundles=yes", true],
  ["?reliefBundles=off", false],
  ["?reliefBundles=0", false],
  ["?reliefBundles=garbage", false],
  ["", false],
  ["?reliefBundles", false],
]) {
  ok(
    gb.reliefBundlesEnabled(v) === want,
    `relief flag grammar: "${v}" → ${want}`
  );
}

{
  // A wasm surface that carries the variant export + a resident-row count.
  let reliefCalls = 0;
  let flatCalls = 0;
  let residentRows = 7;
  const reliefWasm = {
    assemble_model_geometry: () => {
      flatCalls += 1;
      return { buffer: new Uint8Array(0), descriptor: JSON.stringify({ models: [], assembled: 0, missing: 0, bytes: 0 }) };
    },
    assemble_model_geometry_relief: () => {
      reliefCalls += 1;
      return { buffer: new Uint8Array(0), descriptor: JSON.stringify({ models: [], assembled: 0, missing: 0, bytes: 0 }) };
    },
    assemble_envcell_geometry: () => {},
    geom_relief_rows_resident: () => residentRows,
  };

  // Relief ON but the flag absent → the T13 D3 rule still stands (DISARM).
  ok(
    armWith({
      search: "?geomBundles=on&packSource=on",
      hbFetch: { enabled: true },
      relief: { enabled: true, subdivLevel: 0 },
      wasm: reliefWasm,
    }) === false,
    "relief arm: DEFAULT-OFF — relief ON without ?reliefBundles still disarms"
  );
  // Flag on, but the wasm has no variant export (stale pkg/) → DISARM.
  ok(
    armWith({
      search: "?geomBundles=on&packSource=on&reliefBundles=on",
      hbFetch: { enabled: true },
      relief: { enabled: true, subdivLevel: 0 },
      wasm: fakeWasm,
    }) === false,
    "relief arm: missing assemble_model_geometry_relief disarms (stale pkg/)"
  );
  // Flag on, but a subdiv level the bake cannot reproduce → DISARM.
  ok(
    armWith({
      search: "?geomBundles=on&packSource=on&reliefBundles=on",
      hbFetch: { enabled: true },
      relief: { enabled: true, subdivLevel: 3 },
      wasm: reliefWasm,
    }) === false,
    "relief arm: subdivLevel > 0 has no baked variant → disarms"
  );
  // All legs → armed WITH relief.
  ok(
    armWith({
      search: "?geomBundles=on&packSource=on&reliefBundles=on",
      hbFetch: { enabled: true },
      relief: { enabled: true, subdivLevel: 0 },
      wasm: reliefWasm,
    }) === true,
    "relief arm: all legs present → armed"
  );
  ok(gb.reliefBundlesActive() === true, "reliefBundlesActive true when armed");
  ok(
    gb.geomBundleStats().relief.armed === true &&
      gb.geomBundleStats().relief.variantRowsResident === 7,
    "__diag.geometry.relief records the resident variant row count"
  );
  gb.assembleModels([0x01000001]);
  ok(
    reliefCalls === 1 && flatCalls === 0,
    "armed relief arm routes to assemble_model_geometry_relief"
  );

  // The flag ON but relief resolved OFF must NOT engage the variant export —
  // relief geometry with relief off would be an incoherent pairing.
  ok(
    armWith({
      search: "?geomBundles=on&packSource=on&reliefBundles=on",
      hbFetch: { enabled: true },
      wasm: reliefWasm,
    }) === true,
    "relief flag with relief OFF still arms bundles"
  );
  ok(
    gb.reliefBundlesActive() === false,
    "relief flag alone does not engage variants (gfxRelief must resolve ON)"
  );
  const beforeFlat = flatCalls;
  gb.assembleModels([0x01000001]);
  ok(
    flatCalls === beforeFlat + 1 && reliefCalls === 1,
    "OFF arm calls the relief-FREE export (byte-identical legacy routing)"
  );

  // A dist baked without --geom-relief: arms, but says so out loud.
  residentRows = 0;
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  const armed0 = armWith({
    search: "?geomBundles=on&packSource=on&reliefBundles=on",
    hbFetch: { enabled: true },
    relief: { enabled: true, subdivLevel: 0 },
    wasm: reliefWasm,
  });
  console.warn = realWarn;
  ok(armed0 === true, "0 resident variant rows still arms (defaults are relief-free)");
  ok(
    warns.some((w) => w.includes("0 GEOMR rows resident")),
    "0 resident variant rows warns LOUDLY (never silent)"
  );
  ok(
    gb.geomBundleStats().relief.variantRowsResident === 0,
    "variantRowsResident reports 0 for a relief-free dist"
  );
  gb._testDisarm();
  ok(
    gb.reliefBundlesActive() === false,
    "testDisarm clears the relief arm too"
  );
  // The test seam honours the relief opt-in explicitly.
  gb._testArm(reliefWasm, { relief: true });
  ok(gb.reliefBundlesActive() === true, "_testArm({relief:true}) arms variants");
  gb._testDisarm();
}

// ---------------------------------------------------------------------------
// PART 8 — DIAG-SHADOW: `__diag.geometry` is SHARED with diag/geometry.js
//
// Both modules install on the same key. Before 2026-08-11 each did it with a
// whole-object assignment, so the loser's surface vanished — in practice the
// geom-audit ran last and its `relief()` GATE FUNCTION sat where the
// RELIEF-IN-BAKE `relief` DATA FIELD should be, which is why the T4 eye
// session could not read `__diag.geometry.relief.variantRowsResident` in any
// arm and had to match a console string instead (task-T4-EYES-report.md
// §3.3). These checks pin the composition in BOTH install orders.
// ---------------------------------------------------------------------------
{
  const { attachGeometry } = await import("../scene3d/diag/geometry.js");
  const reliefWasm = {
    assemble_model_geometry: () => null,
    assemble_envcell_geometry: () => null,
    assemble_model_geometry_relief: () => null,
    geom_relief_rows_resident: () => 11,
  };

  // --- order A: the audit attaches FIRST, then the bundles arm.
  globalThis.window.__diag = {};
  attachGeometry(globalThis.window.__diag);
  gb._testArm(reliefWasm, { relief: true });
  let d = globalThis.window.__diag.geometry;
  ok(d === gb.geomBundleStats(), "order A: __diag.geometry keeps the stats identity");
  ok(
    d.relief && typeof d.relief === "object" && typeof d.relief.armed === "boolean",
    "order A: __diag.geometry.relief is the DATA field, not a function"
  );
  ok(d.relief.armed === true, "order A: relief.armed readable literally");
  ok(typeof d.reliefGate === "function", "order A: the gfxRelief gate survives as reliefGate()");
  ok(typeof d.audit === "function" && typeof d.summary === "function",
    "order A: the geom-audit entry points survive");
  ok(!!d.bundles && !!d.entityDecode && !!d.geomFallback,
    "order A: the bundle counters survive");

  // --- order B: the bundles arm FIRST, then the audit attaches.
  globalThis.window.__diag = {};
  gb._testArm(reliefWasm, { relief: true });
  attachGeometry(globalThis.window.__diag);
  d = globalThis.window.__diag.geometry;
  ok(d === gb.geomBundleStats(), "order B: __diag.geometry keeps the stats identity");
  ok(
    d.relief && typeof d.relief === "object" && d.relief.armed === true,
    "order B: the audit does NOT shadow the relief data field"
  );
  ok(typeof d.reliefGate === "function" && typeof d.audit === "function",
    "order B: the audit entry points land on the shared object");
  ok(!!d.bundles && !!d.entityDecode,
    "order B: the audit does NOT wipe the bundle counters");

  // The gate is still a working reader (it reads window.__gfxRelief).
  globalThis.window.__gfxRelief = { enabled: true, subdivLevel: 0, scale: 1.0 };
  const gate = d.reliefGate();
  ok(gate && gate.config && gate.config.enabled === true,
    "reliefGate() still reports the resolved gfxRelief config");
  ok(
    gate.config !== d.relief,
    "reliefGate() and the relief data field are DIFFERENT surfaces"
  );

  // JSON-serialisable: a headless capture of __diag.geometry must carry the
  // registered relief fields (a function would have been dropped silently).
  const round = JSON.parse(JSON.stringify(d));
  ok(
    round.relief && round.relief.variantRowsResident === d.relief.variantRowsResident,
    "relief fields survive JSON capture (a gate function would not)"
  );

  gb._testDisarm();
  delete globalThis.window.__gfxRelief;
}

console.log(`geom-bundles: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "GEOM-BUNDLES ✅" : "GEOM-BUNDLES ❌");
process.exit(failed === 0 ? 0 : 1);
