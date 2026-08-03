// test_portal_stencil_alloc.mjs — the per-frame aperture rebuild must reuse
// its buffers (2026-08-03 review, task #152f).
//
// `setApertures` runs every frame from cells.js's tickPortalStencil. It used
// to allocate a fresh array + BufferGeometry + Float32BufferAttribute + Mesh
// per call and dispose last frame's GL buffer — ~600 fan vertices of pure
// churn at 60 Hz. This locks the reuse AND the geometry it produces, since a
// buffer-reuse bug shows up as the wrong triangles, not as a crash.
//
// Run: node test_portal_stencil_alloc.mjs

import * as THREE from "three";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
};

const { PortalStencilPass } = await import("./scene3d/portal_stencil.js");

// One quad aperture: 4 verts ⇒ 2 fan triangles ⇒ 18 floats.
const quad = (x) => [
  1, 4,
  x, 0, 0,
  x + 1, 0, 0,
  x + 1, 1, 0,
  x, 1, 0,
];

function makePass() {
  return new PortalStencilPass({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() });
}

const posOf = (p) => p._apertureGeom?.getAttribute("position");

// ── the geometry is correct ────────────────────────────────────────────────
{
  const p = makePass();
  p.setApertures(quad(0));
  const attr = posOf(p);
  check("one quad fan-triangulates to 2 triangles", p._apertureGeom.drawRange.count === 6,
    `drawRange=${JSON.stringify(p._apertureGeom.drawRange)}`);
  check("aperture count is tracked", p._apertureCount === 1);
  check("the first triangle is the (0,1,2) fan",
    attr.array[0] === 0 && attr.array[3] === 1 && attr.array[6] === 1 && attr.array[7] === 1,
    Array.from(attr.array.slice(0, 9)).join(","));
  check("the mesh is parented for the draw", p._apertureMesh?.parent === p.apertureGroup);
}

// ── steady state reuses everything ─────────────────────────────────────────
{
  const p = makePass();
  p.setApertures(quad(0));
  const geom0 = p._apertureGeom;
  const arr0 = posOf(p).array;
  const mesh0 = p._apertureMesh;
  let disposed = 0;
  geom0.addEventListener("dispose", () => { disposed += 1; });

  for (let f = 0; f < 120; f += 1) p.setApertures(quad(f % 5));

  check("120 frames reuse the SAME geometry", p._apertureGeom === geom0);
  check("120 frames reuse the SAME backing Float32Array", posOf(p).array === arr0);
  check("120 frames reuse the SAME mesh", p._apertureMesh === mesh0);
  check("120 frames dispose the geometry ZERO times", disposed === 0, `disposed=${disposed}`);
  check("…and the mesh is still parented after the last frame",
    p._apertureMesh?.parent === p.apertureGroup);
  check("…and the data actually updated (reuse is not staleness)",
    posOf(p).array[0] === 4, `x0=${posOf(p).array[0]}`);
}

// ── growth reallocates exactly once, then stabilises ───────────────────────
{
  const p = makePass();
  const big = (n) => {
    const out = [n];
    for (let i = 0; i < n; i += 1) out.push(...quad(i).slice(1));
    return out;
  };
  p.setApertures(big(1));
  const g1 = p._apertureGeom;
  p.setApertures(big(400));           // 400 quads ⇒ 7200 floats > the 768 cap
  const g2 = p._apertureGeom;
  check("a bigger aperture set grows the buffer", g2 !== g1);
  check("…and the draw range covers the new fan", g2.drawRange.count === 400 * 6,
    `count=${g2.drawRange.count}`);
  p.setApertures(big(399));
  check("a smaller following frame does NOT reallocate", p._apertureGeom === g2);
  check("…and shrinks the draw range instead", p._apertureGeom.drawRange.count === 399 * 6);
}

// ── degenerate input ───────────────────────────────────────────────────────
{
  const p = makePass();
  p.setApertures(quad(0));
  p.setApertures(null);
  check("null apertures detach the mesh", p._apertureMesh === null && p._apertureCount === 0);
  p.setApertures([1, 2, 0, 0, 0, 1, 1, 1]); // nv=2, below a triangle
  check("a degenerate polygon draws nothing", p._apertureCount === 0 && p._apertureMesh === null);
  p.setApertures(quad(0));
  check("…and the pass recovers on the next good frame", p._apertureCount === 1);
}

// ── teardown still releases the buffer ─────────────────────────────────────
{
  const p = makePass();
  p.setApertures(quad(0));
  const geom = p._apertureGeom;
  let disposed = 0;
  geom.addEventListener("dispose", () => { disposed += 1; });
  p._disposeApertureMesh();
  check("teardown disposes the reused geometry", disposed === 1);
  check("…and clears the cached refs",
    p._apertureGeom === null && p._apertureMesh === null && p._apertureMeshObj === null);
  p.setApertures(quad(0));
  check("…and the pass rebuilds cleanly afterwards", p._apertureCount === 1 && !!p._apertureGeom);
}

console.log("");
console.log(`portal stencil alloc: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
