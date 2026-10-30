// tests/gpu_batch_rows.test.mjs — R3-3 K2: row textures, the instanceMatrix
// redirect, normal-matrix rows and camera-relative origins
// (scene3d/gpu_batch/row_texture.js; docs/2026-10-29-round3-gpu-driven.md
// §R3-3 items 3 and 5).
//
// Locks:
//   1. std430 packing: a row is texelsPerRow consecutive 16-byte vec4s, float
//      offset (row * texelsPerRow + texel) * 4; matrices column-major as f32;
//      row 0 reserved and zero; alloc / free hand out zeroed rows;
//   2. normal-matrix rows equal three's Matrix3.getNormalMatrix bit for bit
//      (f64), zeros for a singular (collapsed) matrix;
//   3. one upload per frame: flush() schedules one full texSubImage2D only
//      when something changed; growth doubles, is charged to the upload
//      budget as ROW_GROW and refused cleanly;
//   4. the redirect GLSL: header before main, the setup call is main's first
//      statement, `#define instanceMatrix` after the setup, idempotent,
//      untouched without main; through three r184 + a fake WebGL2 the row
//      sampler is a sampler2D bound to the row texture, and a frame with a
//      dirty table issues exactly one texSubImage2D for it;
//   5. origins: (origin - camera) in f64, stored once as f32; on points at
//      x ~ 32.4 km the camera-relative composition (f32 GPU arithmetic
//      emulated op by op) stays within 0.05 mm of the f64 truth where the
//      absolute f32 instance matrix is off by millimetres;
//   6. (K3, 2026-10-30) the kit's state-row texture across a context loss /
//      restore: three uploaded it on BOTH contexts, and its growth (or
//      resetKit) deletes only the restored context's GL texture — never one
//      made before the loss — and while the context is lost, nothing; the
//      growth is a DEFERRED spend whose ticket lands when three uploads the
//      new texture (Texture.onUpdate), is dropped when the texture is
//      replaced first, and the growth is timed (`ms.rowGrow`, S1).
//
// Run from apps/holtburger-web/:  node tests/gpu_batch_rows.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

const RT = await import("../scene3d/gpu_batch/row_texture.js");
const UB = await import("../scene3d/gpu_batch/upload_budget.js");

test("1. std430 packing, row 0 reserved, zeroed alloc / free", () => {
  const t = new RT.RowTexture({ texelsPerRow: 5, rows: 4 });
  assert.equal(RT.std430Offset(3, 2, 5), (3 * 5 + 2) * 4);
  assert.equal(t.texture.image.width, 5, "one texel per vec4");
  assert.equal(t.texture.image.height, 4, "one texture row per kit row");
  assert.equal(t.texture.type, THREE.FloatType);
  assert.equal(t.texture.minFilter, THREE.NearestFilter);
  const a = t.alloc();
  const b = t.alloc();
  assert.deepEqual([a, b], [1, 2], "row 0 is never handed out");
  const m = new THREE.Matrix4().compose(new THREE.Vector3(1.1, -2.2, 3.3), new THREE.Quaternion(0.1, 0.2, 0.3, 0.9).normalize(), new THREE.Vector3(1, 2, 0.5));
  t.writeMat4(b, 1, m.elements);
  t.writeVec4(b, 0, 9, 8, 7, 6);
  const o = RT.std430Offset(b, 1, 5);
  for (let i = 0; i < 16; i++) assert.equal(t.data[o + i], Math.fround(m.elements[i]), `column-major f32 element ${i}`);
  assert.deepEqual(Array.from(t.data.subarray(RT.std430Offset(b, 0, 5), RT.std430Offset(b, 0, 5) + 4)), [9, 8, 7, 6]);
  assert.ok(t.data.subarray(0, 20).every((v) => v === 0), "row 0 stays zero");
  t.free(b);
  assert.ok(t.data.subarray(b * 20, b * 20 + 20).every((v) => v === 0), "a freed row is zeroed (collapsed)");
  assert.equal(t.alloc(), b, "and reused");
});

test("2. normal-matrix rows equal three's getNormalMatrix bit for bit", () => {
  const nm = new THREE.Matrix3();
  const out = new Float64Array(12);
  let s = 7;
  const r = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296 - 0.5; };
  for (let k = 0; k < 500; k++) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(r() * 1e4, r() * 1e4, r() * 100),
      new THREE.Quaternion(r(), r(), r(), r()).normalize(),
      new THREE.Vector3(0.2 + Math.abs(r()) * 3, 0.2 + Math.abs(r()) * 3, 0.2 + Math.abs(r()) * 3));
    nm.getNormalMatrix(m);
    RT.writeNormalMatrixColumns(m.elements, out, 0);
    const e = nm.elements;
    assert.deepEqual([out[0], out[1], out[2], out[4], out[5], out[6], out[8], out[9], out[10]], Array.from(e), `matrix ${k}`);
    assert.equal(out[3] + out[7] + out[11], 0);
  }
  assert.equal(RT.writeNormalMatrixColumns(new THREE.Matrix4().makeScale(0, 0, 0).elements, out, 0), false);
  assert.ok(out.every((v) => v === 0), "a collapsed matrix writes a zero normal matrix");
});

test("3. one upload per frame only when dirty; growth charged to the budget", () => {
  const t = new RT.RowTexture({ texelsPerRow: 4, rows: 2 });
  const v0 = t.texture.version;
  assert.equal(t.flush(), 0, "clean: nothing scheduled");
  assert.equal(t.texture.version, v0);
  const budget = new UB.UploadBudget({ bytesPerFrame: 1000, admitsPerFrame: 16 });
  budget.beginFrame(1);
  assert.equal(t.alloc(budget), 1);
  assert.equal(t.capacity, 2);
  // Row 2 needs capacity 4: 4 rows x 4 texels x 16 B = 256 B.
  assert.equal(t.alloc(budget), 2);
  assert.equal(t.capacity, 4);
  assert.equal(budget.stats.byKind.rowGrow, 256);
  t.writeVec4(2, 0, 1, 2, 3, 4);
  const v1 = t.texture.version;
  assert.equal(t.flush(), 4 * 4 * 16);
  assert.equal(t.texture.version, v1 + 1, "one needsUpdate");
  t.writeVec4(1, 0, 1, 1, 1, 1);
  t.writeVec4(2, 1, 1, 1, 1, 1);
  t.flush();
  assert.equal(t.texture.version, v1 + 2, "several writes, one upload");
  // Growth refused: nothing changes.
  const tiny = new UB.UploadBudget({ bytesPerFrame: 100, admitsPerFrame: 16 });
  tiny.beginFrame(1);
  tiny.trySpend(50, "geometry");
  assert.equal(t.alloc(tiny), 3, "row 3 fits the capacity: no growth"); // row 4 would grow to 8 rows = 512 B
  assert.equal(t.capacity, 4);
  assert.equal(t.alloc(tiny), -1, "growth refused this frame");
  assert.equal(t.stats.growRefused, 1);
  assert.equal(t.capacity, 4);
  // A grown texture keeps the rows' contents.
  const big = new UB.UploadBudget({ bytesPerFrame: 1 << 20 });
  big.beginFrame(1);
  const row = t.alloc(big);
  assert.equal(t.capacity, 8);
  assert.deepEqual(Array.from(t.data.subarray(RT.std430Offset(2, 0, 4), RT.std430Offset(2, 0, 4) + 4)), [1, 2, 3, 4]);
  assert.equal(t.uniform.value, t.texture, "the shared uniform follows the new texture");
  void row;
});

test("4. the redirect GLSL and its GL stream through three r184", () => {
  const chunk = RT.instanceRedirectChunk({ sampler: "hbRowTex", rowAttr: "hbRow", matrixTexel: 0, originTexel: 4 });
  const shader = { vertexShader: "uniform float x;\nvoid main() {\n\tgl_Position = vec4(x);\n}" };
  assert.equal(RT.injectVertexHeader(shader, chunk, RT.ROW_REDIRECT_MARKER, "hbBatchRowSetup"), true);
  const vs = shader.vertexShader;
  assert.ok(vs.startsWith("#ifdef USE_INSTANCING"), "header first");
  assert.ok(vs.indexOf("#define instanceMatrix hbBatchInstanceMatrix") > vs.indexOf("void hbBatchRowSetup()"), "define after the setup body");
  assert.ok(/void main\(\) \{\n#ifdef USE_INSTANCING\n  hbBatchRowSetup\(\);\n#endif/.test(vs), "setup is main's first statement");
  assert.ok(vs.includes("hbM[3].xyz += texelFetch(hbRowTex, ivec2(0, hbO), 0).xyz;"), "origin offset added to the translation");
  assert.equal(RT.injectVertexHeader(shader, chunk, RT.ROW_REDIRECT_MARKER, "hbBatchRowSetup"), true);
  assert.equal(shader.vertexShader, vs, "idempotent");
  const nomain = { vertexShader: "void f() {}" };
  assert.equal(RT.injectVertexHeader(nomain, chunk, RT.ROW_REDIRECT_MARKER, "hbBatchRowSetup"), false);
  assert.equal(nomain.vertexShader, "void f() {}");

  // Real three program + fake GL: the row sampler binds the row texture; one
  // dirty frame = one texSubImage2D of the table.
  const calls = [];
  const gl = createFakeWebGL2({ onCall: (n, a) => calls.push([n, Array.from(a)]) });
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  const rows = new RT.RowTexture({ texelsPerRow: 5, rows: 8, name: "rows" });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const inst = new THREE.InstancedBufferAttribute(new Float32Array([1]), 1);
  geo.setAttribute("hbRow", inst);
  const mat = new THREE.MeshStandardMaterial();
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.hbRowTex = rows.uniform;
    RT.injectVertexHeader(sh, chunk, RT.ROW_REDIRECT_MARKER, "hbBatchRowSetup");
  };
  mat.customProgramCacheKey = () => "rows-test";
  const mesh = new THREE.InstancedMesh(geo, mat, 1);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.PerspectiveCamera();
  rows.alloc();
  rows.writeMat4(1, 0, new THREE.Matrix4().elements);
  rows.flush();
  gl.__fake.startSnapshots();
  renderer.render(scene, cam);
  const snaps = gl.__fake.takeSnapshots();
  const draw = snaps.find((s) => s.kind === "drawElementsInstanced");
  assert.ok(draw && /^tex#\d+$/.test(draw.uniforms.hbRowTex), `row sampler bound: ${draw && draw.uniforms.hbRowTex}`);
  calls.length = 0;
  rows.writeVec4(1, 4, 0, 0, 0, 0);
  rows.writeVec4(1, 3, 5, 6, 7, 1);
  rows.flush();
  renderer.render(scene, cam);
  const ups = calls.filter((c) => c[0] === "texSubImage2D");
  assert.equal(ups.length, 1, "one texSubImage2D per frame for the whole table");
  assert.deepEqual(ups[0][1].slice(0, 6), [gl.TEXTURE_2D, 0, 0, 0, 5, 8], "the full table, one call");
  calls.length = 0;
  renderer.render(scene, cam);
  assert.equal(calls.filter((c) => c[0] === "texSubImage2D").length, 0, "clean frame: no upload");
});

// --- 5. origins ---------------------------------------------------------------
const f = Math.fround;
/** f32 GPU mat4 x vec4, column-major, op by op (mul then add, in order). */
function mulMV(m, v) {
  const o = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) {
    let acc = f(m[r] * v[0]);
    acc = f(acc + f(m[4 + r] * v[1]));
    acc = f(acc + f(m[8 + r] * v[2]));
    acc = f(acc + f(m[12 + r] * v[3]));
    o[r] = acc;
  }
  return o;
}
const f32Mat = (e) => Array.from(e, f);

test("5. camera-relative origins: f64 on the CPU keeps f32 precision at 32.4 km", () => {
  const rowsTex = new RT.RowTexture({ texelsPerRow: 5, rows: 8 });
  const origins = new RT.OriginTable(rowsTex);
  const LB = 0xa8b30000; // x byte 168 -> 32,256 m
  const lbO = RT.landblockOrigin(LB);
  assert.deepEqual(lbO, [168 * 192, 0xb3 * 192, 0]);
  const slot = origins.acquire(LB, lbO[0], lbO[1], lbO[2]);
  const oRow = origins.rowOf(slot);
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  let maxLegacy = 0, maxKit = 0;
  let s = 99;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let k = 0; k < 400; k++) {
    // Camera a few metres off a random point of the landblock.
    const local = [r() * 192, r() * 192, 40 + r() * 20];
    cam.position.set(lbO[0] + local[0] + (r() - 0.5) * 30, lbO[1] + local[1] + (r() - 0.5) * 30, local[2] + 5);
    cam.lookAt(lbO[0] + local[0], lbO[1] + local[1], local[2]);
    cam.updateMatrixWorld(true);
    const V = cam.matrixWorldInverse;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), r() * 6.28);
    const vtx = [r() - 0.5, r() - 0.5, r() * 2, 1];
    // Truth (f64): view-space position of N * v.
    const Nabs = new THREE.Matrix4().compose(new THREE.Vector3(lbO[0] + local[0], lbO[1] + local[1], local[2]), q, new THREE.Vector3(1, 1, 1));
    const truth = new THREE.Vector4(...vtx).applyMatrix4(Nabs).applyMatrix4(V);
    // Legacy: absolute f32 instance matrix; modelView = V (object at the world origin).
    const legacy = mulMV(f32Mat(V.elements), mulMV(f32Mat(Nabs.elements), vtx.map(f)));
    // Kit: LB-local instance matrix + (origin - camera) row; mesh anchored at the camera.
    const Nloc = new THREE.Matrix4().compose(new THREE.Vector3(local[0], local[1], local[2]), q, new THREE.Vector3(1, 1, 1));
    origins.writeCameraRelative(cam.position.x, cam.position.y, cam.position.z);
    const off = rowsTex.data.subarray(RT.std430Offset(oRow, 0, 5), RT.std430Offset(oRow, 0, 5) + 3);
    assert.equal(off[0], f(lbO[0] - cam.position.x), "(origin - camera) computed in f64, stored once");
    const Mrow = f32Mat(Nloc.elements);
    Mrow[12] = f(Mrow[12] + off[0]); Mrow[13] = f(Mrow[13] + off[1]); Mrow[14] = f(Mrow[14] + off[2]); // hbM[3].xyz += offset
    const anchor = new THREE.Object3D();
    RT.anchorAtCamera(anchor, cam.position.x, cam.position.y, cam.position.z);
    anchor.updateMatrixWorld(true);
    const MV = new THREE.Matrix4().multiplyMatrices(V, anchor.matrixWorld); // three forms this in f64
    assert.ok(Math.abs(MV.elements[12]) + Math.abs(MV.elements[13]) + Math.abs(MV.elements[14]) < 1e-6, "near-zero translation reaches the GPU");
    const kit = mulMV(f32Mat(MV.elements), mulMV(Mrow, vtx.map(f)));
    const err = (p) => Math.hypot(p[0] - truth.x, p[1] - truth.y, p[2] - truth.z);
    maxLegacy = Math.max(maxLegacy, err(legacy));
    maxKit = Math.max(maxKit, err(kit));
  }
  assert.ok(maxKit < 5e-5, `camera-relative error ${maxKit} m`);
  assert.ok(maxLegacy > 5e-4, `absolute f32 error ${maxLegacy} m (the problem being solved)`);
  console.log(`  origins: max error absolute-f32 ${(maxLegacy * 1000).toFixed(3)} mm, camera-relative ${(maxKit * 1000).toFixed(4)} mm`);
  origins.release(LB);
  assert.ok(rowsTex.data.subarray(oRow * 20, oRow * 20 + 20).every((v) => v === 0), "released origin row zeroed");
});

test("6. the kit's state rows across a context restore: no lost-context texture deleted; growth lands on upload", async () => {
  const KIT = await import("../scene3d/gpu_batch/kit.js");
  const rig = () => {
    const calls = [];
    const gl = createFakeWebGL2({ onCall: (n, a) => calls.push([n, Array.from(a)]) });
    const canvas = fakeCanvas(gl);
    const listeners = {};
    canvas.addEventListener = (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); };
    let lost = false;
    gl.isContextLost = () => lost;
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
    const fire = (type, ev) => { for (const fn of listeners[type] || []) fn(ev); };
    return {
      gl, calls, renderer,
      lose() { lost = true; fire("webglcontextlost", { preventDefault() {} }); },
      restore() { lost = false; fire("webglcontextrestored", {}); },
    };
  };
  const texDeletes = (calls, from) => calls.slice(from).filter(([n]) => n === "deleteTexture").map(([, a]) => a[0].__id);
  const createdTex = (calls, from) => calls.slice(from).filter(([n]) => n === "createTexture").length;
  {
    KIT.resetKit();
    const r = rig();
    KIT.kitPages(r.renderer); // the kit lives on this renderer
    const rows = KIT.kitStateTable().rows;
    const t0 = rows.texture;
    r.renderer.initTexture(t0); // three uploads it on the first context
    const fence = r.gl.createTexture().__id;
    r.lose();
    r.restore();
    const c0 = r.calls.length;
    r.renderer.initTexture(t0); // ... and again on the restored one
    assert.equal(createdTex(r.calls, c0), 1, "premise: re-uploaded on the restored context");
    const budget = new UB.UploadBudget({ bytesPerFrame: 1 << 20 });
    budget.beginFrame(1);
    const from = r.calls.length;
    assert.equal(rows.ensureRows(rows.capacity * 2, budget), true, "grown");
    const del = texDeletes(r.calls, from);
    assert.deepEqual(del.filter((id) => id < fence), [], "the lost context's texture is not deleted on the restored one");
    assert.equal(del.filter((id) => id > fence).length, 1, "the restored context's copy of the old texture is deleted (no leak)");
    // The growth: a deferred spend that lands when three uploads the new texture.
    assert.equal(budget.stats.byKind.rowGrow, rows.bytesFor(rows.capacity));
    assert.equal(budget.openTickets(), 1, "charged, not uploaded yet");
    assert.equal(budget.stats.timed.rowGrow, 1, "the growth is timed");
    assert.ok(Number.isFinite(budget.stats.ms.rowGrow) && budget.stats.ms.rowGrow >= 0);
    budget.beginFrame(2);
    assert.equal(budget.carriedBytes, rows.bytesFor(rows.capacity), "carried until three uploads it");
    r.renderer.initTexture(rows.texture);
    assert.equal(budget.openTickets(), 0, "landed by Texture.onUpdate");
    budget.beginFrame(3);
    assert.equal(budget.carriedBytes, rows.bytesFor(rows.capacity), "booked once more in the frame after its upload");
    budget.beginFrame(4);
    assert.equal(budget.carriedBytes, 0);
    // A growth replaced before it ever uploaded: its ticket is dropped.
    assert.equal(rows.ensureRows(rows.capacity * 2, budget), true);
    assert.equal(budget.openTickets(), 1);
    assert.equal(rows.ensureRows(rows.capacity * 2, budget), true);
    assert.equal(budget.openTickets(), 1, "the replaced texture's ticket was dropped");
    // resetKit after the restore: nothing of the lost context deleted either.
    r.renderer.initTexture(rows.texture);
    const f2 = r.calls.length;
    KIT.resetKit();
    assert.deepEqual(texDeletes(r.calls, f2).filter((id) => id < fence), [], "resetKit: nothing of the lost context");
    assert.equal(budget.openTickets(), 0);
  }
  {
    // While the context is lost: nothing is deleted at all (nothing is live).
    KIT.resetKit();
    const r = rig();
    KIT.kitPages(r.renderer);
    const rows = KIT.kitStateTable().rows;
    r.renderer.initTexture(rows.texture);
    const from = r.calls.length;
    r.lose();
    rows.ensureRows(rows.capacity * 2, null);
    KIT.resetKit();
    assert.deepEqual(texDeletes(r.calls, from), [], "lost: no delete issued");
  }
  {
    // Control: a live context, no restore: the old texture IS deleted.
    KIT.resetKit();
    const r = rig();
    KIT.kitPages(r.renderer);
    const rows = KIT.kitStateTable().rows;
    r.renderer.initTexture(rows.texture);
    const from = r.calls.length;
    rows.ensureRows(rows.capacity * 2, null);
    assert.equal(texDeletes(r.calls, from).length, 1, "live: the grown-over texture is deleted");
    KIT.resetKit();
  }
});
