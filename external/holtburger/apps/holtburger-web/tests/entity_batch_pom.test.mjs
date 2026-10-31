// tests/entity_batch_pom.test.mjs — POM parts of `?entityBatch`
// (scene3d/gpu_batch/entity_batch.js "POM PARTS"; the kit side:
// class_materials.js "POM MEMBERS", layer_state.js POM extension rows,
// array_pages.js R8 planes). Realboot keys (Holtburg, ultra, 2026-10-31): 52
// part materials `hb|d0|c0|p1|l1|a0|b0|f0|s0|k0|v` (the MaterialCache base:
// materials.js's POM patch, then its light clamp), routed "shader-chain".
// Every member below is built by materials.js's OWN installer (the smoke
// lib's materialCacheFor at `pom`: `_materialFromFlags` at pomEnabled, Stone,
// normal + seam-height planes), never a hand-made stand-in.
//
//   EP1 routing: a POM part the kit's array rule refuses ONLY for its p1 key
//       (unitArrayReason "shader-chain", the pre-change verdict) is batchable;
//       its verdict carries the very height plane materials.js keeps for it
//       and the scalars it recorded; a p1 flag over a light-clamp chain is
//       batchable without POM; every other rule still applies through the
//       p0-keyed view (a roughness map refuses); a non-p1 refused key, a
//       mangled POM text and a missing normal map stay legacy; the run key
//       of a POM part carries its chain fingerprint and height page key, a
//       plain member's run key is unchanged.
//   EP2 a POM rig (the real EntityManager, three r184, the recording fake
//       WebGL2): active with the same draw count as a plain rig; one height
//       layer + POM extension row per POM member, verify() clean incl. the
//       POM rows; each extension row equals the uniforms three bound for the
//       member's LEGACY draw (the draw snapshot of the first frame) and its
//       layer is a per-level copy of the very 2D plane that draw bound to
//       uPomMap; the class draws bind the height page (no uPomMap); the POM
//       text three compiled for the class equals the legacy program's modulo
//       the documented substitutions; the class keys carry `|pomc<id>` and
//       `|pom1`.
//   EP3 drift + release: a height re-upload re-plans (drift:map) onto a fresh
//       copy; dispose frees every POM extension row and height layer.
//   EP4 the smoke's pom arm dry-runs in node (two active rigs, POM layers,
//       verify clean, a pom1 class) and the layers readback walks the R8
//       height layers; the page and the runner carry the arms.
//   EP5 the extra-map census (`stats().extraMaps`): a leaf refused for its
//       texchan planes (aoMap + roughnessMap) is counted by its whole set.
//
// Each check fails on the pre-change tree (POM parts routed "shader-chain";
// no POM rows / R8 pages / POM class).
//
// Run: node tests/entity_batch_pom.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import * as R from "./entity_batch_rig.mjs";

const { THREE, EB, KIT, M, ADAPTER, D } = R;
R.requireBatch();
const LS = await import("../scene3d/gpu_batch/layer_state.js");
const AP = await import("../scene3d/gpu_batch/array_pages.js");
const PA = await import("../scene3d/gpu_batch/page_allocator.js");
const CM = await import("../scene3d/gpu_batch/class_materials.js");
const { unitArrayReason, arraySignature, memberProgramKey } = await import("../scene3d/gpu_batch/anim_scenery_batch.js");

const { check, done } = R.suite("entity_batch_pom");
const pomCache = () => R.LIB.materialCacheFor(M, ADAPTER, { pom: true });
const S_FIELDS = [["uPomSteps", "steps"], ["uPomDepth", "depth"], ["uPomShadowSteps", "shadowSteps"], ["uPomLodNear", "lodNear"],
  ["uPomLodFar", "lodFar"], ["uPomShadowDarkness", "shadowDarkness"], ["uPomGraze", "graze"]];
const smallTex = () => ADAPTER.surfacePixelsToTexture(new Uint8Array(16 * 16 * 4).fill(77), 16, 16);
const smallNrm = () => ADAPTER.surfacePixelsToNormalTexture(new Uint8Array(16 * 16 * 3).fill(128), 16, 16);
const smallHgt = () => ADAPTER.surfacePixelsToHeightTexture(new Uint8Array(256).map((_, i) => (i & 7 ? 230 : 40)), 16, 16);

function copiesOf(calls, gl) {
  let read = null, readLevel = -1, arr = null;
  const out = [];
  for (const [n, a] of calls) {
    if (n === "framebufferTexture2D" && a[0] === gl.READ_FRAMEBUFFER) { read = a[3]; readLevel = a[4]; }
    else if (n === "bindTexture" && a[0] === gl.TEXTURE_2D_ARRAY) arr = a[1];
    else if (n === "copyTexSubImage3D") out.push({ src: read, srcLevel: readLevel, dst: arr, level: a[1], layer: a[4], w: a[7], h: a[8] });
  }
  return out;
}
function fnText(src, sig) {
  const a = src.indexOf(sig);
  assert.ok(a >= 0, `function ${sig}`);
  return src.slice(a, src.indexOf("\n}\n", a) + 2);
}
const undoP3 = (s) => s.replace(/texture\( hbBatchPomArr, vec3\( ([A-Za-z_][A-Za-z0-9_]*), vHbP0\.x \) \)/g, "texture2D(uPomMap, $1)");

await check("EP1 routing: POM parts batch, flag-only p1 batches without POM, every other rule still applies", () => {
  const mc = pomCache();
  const base = mc.materials.get(D.A);
  assert.equal(memberProgramKey(base), "hb|d0|c0|p1|l1|a0|b0|f0|s0|k0|v", "premise: the realboot POM part key");
  assert.equal(unitArrayReason(base), "shader-chain", "premise: the kit's array rule refuses it for the key");
  assert.equal(EB.entityArrayReason(base), null, "batchable");
  const v = EB.entityPomVerdict(base);
  assert.ok(v && v.id && v.pom && v.pom.pom === true, JSON.stringify(v && { id: v.id, reason: v.reason }));
  assert.equal(v.pom.texture, M.heightTexForMaterial(base), "the very height plane materials.js keeps for it");
  const u = base.userData.pomUniforms;
  assert.deepEqual(v.pom.values, { steps: u.steps, depth: u.depth, lodNear: u.lodNear, lodFar: u.lodFar, shadowSteps: u.shadowSteps, shadowDarkness: u.shadowDarkness, graze: M.pomGrazeEnabled() ? 1 : 0 });
  const clip = mc.materials.get(D.CLIP);
  assert.equal(EB.entityArrayReason(clip), null, "an alpha-tested (ClipMap) POM part too");
  // A p1 flag over a light-clamp chain only.
  const flag = new THREE.MeshStandardMaterial({ map: smallTex(), side: THREE.DoubleSide });
  M.installLightClampShaderPatch(flag);
  flag.userData.pomEnabled = true;
  assert.equal(memberProgramKey(flag), "hb|d0|c0|p1|l1|a0|b0|f0|s0|k0|v");
  assert.equal(EB.entityArrayReason(flag), null);
  assert.equal(EB.entityPomVerdict(flag).pom, null, "no POM text: batched as the chain it runs");
  // Every other unitArrayReason rule, through the p0-keyed view.
  const rough = R.LIB.materialCacheFor(M, ADAPTER, { pom: true }).materials.get(D.B);
  rough.roughnessMap = smallTex();
  assert.equal(EB.entityArrayReason(rough), "map:roughnessMap");
  // Refusals.
  const keyed = new THREE.MeshStandardMaterial({ map: smallTex() });
  keyed.onBeforeCompile = function () {};
  keyed.customProgramCacheKey = () => "hb|d1|c0|p1|l1|a0|b0|f0|s0|k0|v";
  assert.equal(EB.entityArrayReason(keyed), "shader-chain", "detail + POM: still refused");
  const noN = new THREE.MeshStandardMaterial({ map: smallTex() });
  M.installPomShaderPatch(noN, smallHgt(), {});
  M.installLightClampShaderPatch(noN);
  assert.equal(EB.entityArrayReason(noN), "pom-no-normal");
  const bad = new THREE.MeshStandardMaterial({ map: smallTex(), normalMap: smallNrm() });
  M.installPomShaderPatch(bad, smallHgt(), {});
  M.installLightClampShaderPatch(bad);
  const inner = bad.onBeforeCompile;
  bad.onBeforeCompile = function mangled(sh, r) { inner.call(this, sh, r); sh.fragmentShader = sh.fragmentShader.replace("uniform float uPomGraze;", "uniform float uPomGraze;\nuniform float uPomExtra;"); };
  assert.equal(EB.entityArrayReason(bad), "chain-pom-shape");
  // Run keys.
  const hd = AP.describeTexture(v.pom.texture, AP.R8_PLANES);
  assert.equal(EB.entityRunKeyOf(base), arraySignature(base) + "|pomc" + v.id + "|h:" + PA.pageKeyOf(hd));
  const plain = R.materialCacheFor().materials.get(D.A);
  assert.equal(EB.entityRunKeyOf(plain), arraySignature(plain), "a plain member's run key is unchanged");
});

let W = null;
await check("EP2 a POM rig: rows = the legacy draw's uniforms, layers copied from the legacy draw's plane, the POM class text", async () => {
  const calls = [];
  const sources = [];
  const mc = pomCache();
  const w = await R.world(true, { materialCache: mc, onCall: (n, a) => { calls.push([n, Array.from(a)]); if (n === "shaderSource") sources.push(String(a[1])); } });
  W = { w, calls, mc };
  const inst = await w.spawn(0x50000c01);
  // Frame 1 draws the legacy leaves (the rig is still admitting / warming).
  w.gl.__fake.startSnapshots();
  w.frame();
  const legacy = w.gl.__fake.takeSnapshots().filter((s) => /^draw/.test(s.kind) && s.uniforms.uPomSteps !== undefined);
  w.settle(60);
  assert.equal(inst._hbBatch.status, "active", JSON.stringify(w.em._entityBatch.stats().live));
  assert.ok(legacy.length >= 4, `premise: legacy POM draws in frame 1 (${legacy.length})`);
  const eb = w.em._entityBatch;
  const st = eb.stats();
  assert.equal(w.drawsOf().length, 7, "the plain rig's draw count (POM classes split nothing more)");
  const rows = [...inst._hbBatch.plan.memberRefs.values()];
  const pomRows = rows.filter((r) => r.pomRow > 0);
  assert.ok(pomRows.length >= 4 && st.layers.pom === pomRows.length, `POM members ${pomRows.length}, admitted ${st.layers.pom}`);
  const v = eb.verify();
  assert.deepEqual([v.rowMismatches, v.stateMismatches, v.pomMismatches, v.parkMismatches, v.attrMismatches], [0, 0, 0, 0, 0], JSON.stringify(v));
  const table = KIT.kitStateTable();
  const fpr = table.rows.floatsPerRow;
  const copies = copiesOf(calls, w.gl);
  for (const row of pomRows) {
    const glTex = w.renderer.properties.get(row.pom.texture).__webglTexture;
    const snap = legacy.find((s) => s.uniforms.uPomMap === `tex#${glTex.__id}`);
    assert.ok(snap, `${row.member.name}: its legacy draw bound its own plane`);
    assert.equal(LS.unpackLayerState(table.rows.data, row.slot * fpr).extRow, row.pomRow);
    const p = LS.unpackPomState(table.rows.data, row.pomRow * fpr);
    assert.equal(p.layer, row.pomLayer);
    for (const [n, f] of S_FIELDS) assert.equal(p[f], snap.uniforms[n], `${n}: the value three bound for the legacy draw`);
    const desc = row.pomPage.desc;
    assert.equal(desc.format, "r8");
    const mine = copies.filter((c) => c.dst === row.pomPage.gl.tex && c.layer === row.pomLayer);
    assert.equal(mine.length, desc.levels, "one copy per level");
    mine.forEach((c, l) => {
      const [lw, lh] = PA.levelSize(desc.width, desc.height, l);
      assert.deepEqual({ ...c }, { src: glTex, srcLevel: l, dst: row.pomPage.gl.tex, level: l, layer: row.pomLayer, w: lw, h: lh }, `level ${l}`);
    });
  }
  // The class draws.
  const snaps = w.drawsOf();
  const pages = new Set(pomRows.map((r) => `tex#${r.pomPage.gl.tex.__id}`));
  const pomDraws = snaps.filter((s) => s.uniforms.hbBatchPomArr !== undefined);
  assert.ok(pomDraws.length >= 1);
  for (const s of pomDraws) assert.ok(pages.has(s.uniforms.hbBatchPomArr));
  assert.equal(snaps.filter((s) => s.uniforms.uPomMap !== undefined).length, 0, "no legacy POM draw left");
  // Keys.
  const pomKeys = st.programKeys.filter((k) => k.endsWith("|pom1"));
  assert.ok(pomKeys.length >= 1 && pomKeys.every((k) => /\|entPart1\|pomc[0-9a-f]{8}\|n1\|pom1$/.test(k)), JSON.stringify(pomKeys));
  for (const run of inst._hbBatch.plan.runs) if (run.row.pomRow > 0) assert.equal(run.classEntry.material.userData.hbBatchPom, true);
  // The POM text three compiled.
  const legacyFs = sources.find((s) => s.includes("uniform sampler2D uPomMap;") && s.includes("_pomPerturbedUv"));
  const classFs = sources.find((s) => s.includes("uniform highp sampler2DArray hbBatchPomArr;") && s.includes("_pomPerturbedUv"));
  assert.ok(legacyFs && classFs, "both programs compiled");
  for (const sig of ["vec2 _pomPerturbedUv(", "float _pomShadow("]) assert.equal(undoP3(fnText(classFs, sig)), fnText(legacyFs, sig), sig);
  const block = (s) => s.slice(s.indexOf("// Phase 3.1 POM begin"), s.indexOf("// Phase 3.1 POM end"));
  assert.equal(block(classFs).replace(CM.POM_MAP_SAMPLE_BATCH, CM.POM_MAP_SAMPLE), block(legacyFs));
  assert.ok(sources.some((s) => s.includes("vHbP0 = texelFetch(hbBatchStateTex, ivec2(0, hbP), 0);")), "the vertex stage fetches the POM row");
  W.inst = inst;
});

await check("EP3 drift + release: a height re-upload re-plans onto a fresh copy; dispose frees every POM row and layer", () => {
  assert.ok(W && W.inst, "premise: EP2 ran");
  const { w, inst } = W;
  const eb = w.em._entityBatch;
  const row0 = [...inst._hbBatch.plan.memberRefs.values()].find((r) => r.pomRow > 0);
  const h = row0.pom.texture;
  const oldKey = row0.pomKey;
  const pages = KIT.kitPages(w.renderer);
  h.needsUpdate = true;
  w.frame();
  assert.ok((eb.stats().replanReasons["drift:map"] || 0) >= 1, JSON.stringify(eb.stats().replanReasons));
  w.settle(60);
  assert.equal(inst._hbBatch.status, "active");
  const row1 = inst._hbBatch.plan.memberRefs.get(row0.member);
  assert.equal(row1.pomKey, AP.contentKeyOf(h), "the new upload's content");
  assert.equal(pages.alloc.refCount(oldKey), 0, "the stale copy released");
  const v = eb.verify();
  assert.equal(v.pomMismatches + v.stateMismatches, 0);
  const held = [...inst._hbBatch.plan.memberRefs.values()].filter((r) => r.pomRow > 0).map((r) => [r.pomRow, r.pomKey]);
  eb.dispose();
  const rowsT = KIT.kitStateTable().rows;
  for (const [pr, k] of held) {
    assert.ok(rowsT._free.includes(pr), `POM row ${pr} freed`);
    assert.equal(pages.alloc.refCount(k), 0, `height layer ${k} released`);
  }
});

await check("EP4 the smoke's pom arm + the R8 layers readback dry-run; the page and the runner carry them", async () => {
  const LIB = R.LIB;
  const mods = {
    entities: { EntityManager: R.EntityManager }, entityBatch: EB, kit: KIT, materials: M, adapter: ADAPTER,
    selectionLighting: await import("../scene3d/selection_lighting.js"),
  };
  const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
  const mk = () => { const gl = createFakeWebGL2(); return new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl }); };
  const off = await LIB.runEntityArm(THREE, mk(), mods, { arm: "pom", batch: false, frames: 12 });
  const offR = globalThis.window.liveScene3d.renderer;
  offR.render(off.scene, off.camera);
  const offCalls = offR.info.render.calls;
  const on = await LIB.runEntityArm(THREE, mk(), mods, { arm: "pom", batch: true, frames: 12 });
  const r = globalThis.window.liveScene3d.renderer;
  r.render(on.scene, on.camera);
  assert.deepEqual(on.status, ["active", "active"]);
  assert.ok(r.info.render.calls < offCalls, `${r.info.render.calls} < ${offCalls}`);
  assert.ok(on.stats.layers.pom >= 8, JSON.stringify(on.stats.layers));
  assert.equal(on.verify.pomMismatches, 0);
  assert.ok(on.stats.programKeys.some((k) => /\|pom1$/.test(k)));
  const L = await LIB.runEntityArm(THREE, mk(), mods, { arm: "humans", batch: true, frames: 12, pom: true });
  const lb = LIB.readbackLayers(L.em._entityBatch, KIT.kitPages(globalThis.window.liveScene3d.renderer));
  assert.ok(lb.pom >= 8 && lb.levels > lb.layers && lb.mismatched === 0, JSON.stringify(lb));
  const page = fs.readFileSync(new URL("../harness/glsl_smoke/entity_batch_page.html", import.meta.url), "utf8");
  assert.ok(page.includes('q.get("pom") === "1"') && /runEntityArm\([^)]*pom \}/.test(page) && page.includes("programKeys: r.stats.programKeys"), "the page passes pom through");
  const runner = fs.readFileSync(new URL("../harness/glsl_smoke/entity_batch_smoke.mjs", import.meta.url), "utf8");
  assert.ok(runner.includes('run("?arm=layers&pom=1")') && /\n  pom: \{ status: \["active", "active"\]/.test(runner) && runner.includes("if (want.pom)"), "the runner loads the pom arms and gates them");
});

await check("EP5 the extra-map census: a leaf refused for texchan planes is counted by its whole extra-map set", async () => {
  const mc = pomCache();
  const m = mc.materials.get(D.C);
  m.roughnessMap = ADAPTER.surfacePixelsToRoughnessTexture(new Uint8Array(32 * 32).fill(40), 32, 32);
  m.aoMap = ADAPTER.surfacePixelsToAoTexture(new Uint8Array(32 * 32).fill(200), 32, 32);
  const w = await R.world(true, { materialCache: mc });
  const inst = await w.spawn(0x50000c02);
  w.settle(60);
  assert.equal(inst._hbBatch.status, "active", "the rest of the rig batches");
  const st = w.em._entityBatch.stats();
  assert.ok((st.leafRoutes["map:aoMap"] || 0) >= 1, JSON.stringify(st.leafRoutes));
  assert.ok((st.extraMaps["aoMap+roughnessMap"] || 0) >= 1, JSON.stringify(st.extraMaps));
  w.em._entityBatch.dispose();
});

done();
