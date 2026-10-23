// 2026-10-22 — `?negFace` on model bundles (HBG1 v2 face marker; handoff
// HANDOFF-gpu-resident-statics-2026-10-22 §5 F7(a); runbook
// docs/HBG1-negface-marker-2026-10-22.md).
//
// The decision itself (which subsets each `?negFace` arm keeps, and when a
// model is `missing`) lives in Rust and is pinned by the native differs in
// src/geom_bundles.rs + crates/holtburger-dat/src/hbg1.rs. What this file
// pins, without a GPU or a wasm build, is the JS consumer's half:
//   * the `__diag.geometry.faceMarker` census folds the descriptor's
//     `negFaceRetail` / `faceUnmarked` / `faceFrontCopy` fields, and an
//     old-wasm descriptor (no fields) leaves it untouched without throwing;
//   * the "rebake GEOM" warning fires ONCE, on the first unmarked miss, and
//     the test seam re-arms it;
//   * missing models still route to `missingIds` (the counted fallback);
//   * the v2 marker bits (subset flags 0x08 MODEL_BACKFACE / 0x10
//     NOPOS_SLOT0) never change a group: `bundleToGeometryGroups` output is
//     identical with and without them, on the default arm and under
//     `?perPolyCull`.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/geom_bundles_negface.test.mjs

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// Minimal browser shim BEFORE importing the module under test.
globalThis.window = globalThis.window || { location: { search: "" } };

const gb = await import("../scene3d/geom_bundles.js");

// --- a tiny model entry: 2 surfaces, 3 subsets --------------------------------
// Subset rows as the wasm descriptor carries them; `markBits` lets the same
// entry be built with or without the v2 marker bits on the same rows.
function makeEntry(markBits) {
  // 4 verts, unit quad + a third tri.
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const nrm = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1];
  const idx = [0, 1, 2, 0, 2, 3, 0, 3, 1];
  const V = 4;
  const idxOff = V * 12 + V * 12 + V * 8;
  const buffer = new Uint8Array(idxOff + ((idx.length * 2 + 3) & ~3));
  const dv = new DataView(buffer.buffer);
  pos.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  nrm.forEach((v, i) => dv.setFloat32(V * 12 + i * 4, v, true));
  uv.forEach((v, i) => dv.setFloat32(V * 24 + i * 4, v, true));
  idx.forEach((v, i) => dv.setUint16(idxOff + i * 2, v, true));
  const m = markBits ? 1 : 0;
  const subsets = [
    // front tris, surface A, single-sided, stipple wrap
    { surfaceRef: 0x08000a01, flags: 0x02, firstIndex: 0, indexCount: 3 },
    // a NoPos tri on surface A (v2: NOPOS_SLOT0), double-sided
    { surfaceRef: 0x08000a01, flags: 0x01 | (m * 0x10), firstIndex: 3, indexCount: 3 },
    // a back tri on surface B (v2: MODEL_BACKFACE), stipple side
    { surfaceRef: 0x08000a02, flags: 0x04 | (m * 0x08), firstIndex: 6, indexCount: 3 },
  ];
  const entry = {
    id: 0x0100db01,
    didDegrade: 0,
    vtx: { off: 0, count: V },
    idx: { off: idxOff, count: idx.length, width: 2 },
    parts: [{ partIndex: 0, hinge: [0, 0, 0, 1, 0, 0, 0], vtxBase: 0, vtxCount: V,
      idxFirst: 0, idxCount: idx.length, subsets }],
    fused: { subsets },
  };
  return { entry, buffer };
}

function groupsSig(r) {
  return JSON.stringify(r.groups.map((g) => ({
    did: g.surfaceDid,
    dbl: g.doubleSided,
    stip: g.subsetStippled,
    idx: Array.from(g.geometry.getIndex().array),
  })));
}

// --- marker bits are invisible to grouping -----------------------------------
{
  const plain = makeEntry(false);
  const marked = makeEntry(true);
  for (const perPolyCull of [false, true]) {
    const a = gb.bundleToGeometryGroups(plain.entry, plain.buffer, { perPolyCull });
    const b = gb.bundleToGeometryGroups(marked.entry, marked.buffer, { perPolyCull });
    check(`groups identical with/without v2 marker bits (perPolyCull=${perPolyCull})`,
      groupsSig(a) === groupsSig(b), groupsSig(b));
  }
  const d = gb.bundleToGeometryGroups(marked.entry, marked.buffer, {});
  check("default arm: one group per surface", d.groups.length === 2);
  check("stipple OR per surface ignores the marker bits (A: wrap|0 = 1, B: side = 2)",
    d.groups[0].subsetStippled === 1 && d.groups[1].subsetStippled === 2,
    JSON.stringify(d.groups.map((g) => g.subsetStippled)));
  const ppc = gb.bundleToGeometryGroups(marked.entry, marked.buffer, { perPolyCull: true });
  check("perPolyCull: (surface, sides) split reads bit 0 only", ppc.groups.length === 3);
}

// --- the faceMarker census + the once-only warning ----------------------------
{
  const { entry, buffer } = makeEntry(true);
  let next = null;
  gb._testArm({
    assemble_model_geometry: () => ({ buffer, descriptor: JSON.stringify(next) }),
    assemble_envcell_geometry: () => null,
  });
  gb._testResetFaceMarkerAudit();
  const fm = gb.geomBundleStats().faceMarker;
  check("faceMarker present with zeroed counters before any batch",
    fm && fm.negFaceRetail === null && fm.unmarkedModels === 0 && fm.frontCopyModels === 0,
    JSON.stringify(fm));

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    // Batch 1: `?negFace` on, two v1 models missing.
    next = {
      models: [entry, { id: 0x0100aa01, missing: true }, { id: 0x0100aa02, missing: true }],
      assembled: 1, missing: 2, bytes: buffer.length,
      negFaceRetail: true, faceUnmarked: 2, faceFrontCopy: 0,
    };
    const r1 = gb.assembleModels([entry.id, 0x0100aa01, 0x0100aa02]);
    check("unmarked misses still route to missingIds (counted fallback)",
      r1 && r1.missingIds.length === 2 && r1.byModel.has(entry.id));
    check("unmarkedModels counts the batch", fm.unmarkedModels === 2, JSON.stringify(fm));
    check("negFaceRetail mirrors the arm the wasm served", fm.negFaceRetail === true);
    check("the rebake warning fires on the first unmarked miss",
      warns.length === 1 && /predate the v2 face marker/.test(warns[0]), warns[0]);

    // Batch 2: one more unmarked + one front-copy fallback; no second warning.
    next = {
      models: [{ id: 0x0100aa03, missing: true }, { id: 0x0100aa04, missing: true }],
      assembled: 0, missing: 2, bytes: 0,
      negFaceRetail: true, faceUnmarked: 1, faceFrontCopy: 1,
    };
    gb.assembleModels([0x0100aa03, 0x0100aa04]);
    check("counters accumulate", fm.unmarkedModels === 3 && fm.frontCopyModels === 1,
      JSON.stringify(fm));
    check("the warning is once-only", warns.length === 1, String(warns.length));

    // Batch 3: an old wasm (no `?negFace` fields) — nothing moves, nothing throws.
    next = { models: [entry], assembled: 1, missing: 0, bytes: buffer.length };
    const r3 = gb.assembleModels([entry.id]);
    check("old-wasm descriptor: assembles, counters unchanged",
      r3 && r3.byModel.has(entry.id) && fm.unmarkedModels === 3 && fm.frontCopyModels === 1
        && fm.negFaceRetail === true, JSON.stringify(fm));

    // Batch 4: `?negFace=off` arm, v2 dist — no misses, arm recorded.
    next = { models: [entry], assembled: 1, missing: 0, bytes: buffer.length,
      negFaceRetail: false, faceUnmarked: 0, faceFrontCopy: 0 };
    gb.assembleModels([entry.id]);
    check("legacy arm recorded, no new counts",
      fm.negFaceRetail === false && fm.unmarkedModels === 3, JSON.stringify(fm));

    // Seam: the warning re-arms.
    gb._testResetFaceMarkerAudit();
    next = { models: [{ id: 0x0100aa05, missing: true }], assembled: 0, missing: 1, bytes: 0,
      negFaceRetail: true, faceUnmarked: 1, faceFrontCopy: 0 };
    gb.assembleModels([0x0100aa05]);
    check("_testResetFaceMarkerAudit re-arms the warning", warns.length === 2);
  } finally {
    console.warn = origWarn;
  }

  check("__diag.geometry keeps the stats identity and carries faceMarker",
    globalThis.window.__diag?.geometry === gb.geomBundleStats()
      && globalThis.window.__diag.geometry.faceMarker === fm);
  const round = JSON.parse(JSON.stringify(gb.geomBundleStats()));
  check("faceMarker survives a headless JSON round-trip",
    round.faceMarker && round.faceMarker.unmarkedModels === 4, JSON.stringify(round.faceMarker));
  gb._testDisarm();
}

console.log(`\ngeom_bundles_negface: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
