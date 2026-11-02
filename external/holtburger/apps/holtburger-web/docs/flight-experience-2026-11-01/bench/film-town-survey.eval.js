// film-town-survey.eval.js — where in a town can a falling body come down? (take D2 of the Hellcat film, 2026-11-02)
// The server lands a bailed-out body on the TERRAIN (VehicleBailout: VehicleTerrain.Ground, no building collision): a
// landing inside a building's footprint ends with the player standing inside it. This casts a ray straight down at every
// point of a grid around (cx, cy) against the buildings / statics / cells groups (worldRoot is the AC frame, rotated
// into three's Y-up) and reports the first hit above the terrain (window.__sessionHandle.terrainHeightAt):
//   '#' >= 2.5 m above the ground (a building, a roof, a tree)   '+' 0.6-2.5 m (a wall, a fence, a stall)   '.' open
// LIMIT (found in the D2 shoot): most of a town's buildings are BatchedMesh batches and this ray cast found only a few
// of Al-Arqas's (63 candidates) — use film-town-footprints.eval.js (the batch instances' boxes) for where buildings stand.
// window.__vehicleRun = {cx, cy, half: 150, step: 4}
// returns {rows: [string] north -> south, cx, cy, half, step, cands, frame, open: [[dx, dy, clearanceM], ...]}
const R = window.__vehicleRun || {};
let THREE;
try { THREE = await import("three"); } catch (_) { THREE = await import("https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js"); }
const L = window.liveScene3d, h = window.__sessionHandle;
const cx = R.cx, cy = R.cy, half = R.half ?? 150, step = R.step ?? 4;
const root = L.scene.getObjectByName("worldRoot");
if (!root) return { fatal: "no worldRoot" };
L.scene.updateMatrixWorld(true);
const ground = (x, y) => { try { const z = h.terrainHeightAt(x, y); return z == null || !Number.isFinite(z) ? null : z; } catch (_) { return null; } };
const groups = ["buildings", "statics", "cells"].map((n) => root.getObjectByName(n)).filter(Boolean);
// candidates: visible meshes whose world bounding sphere reaches the area (radius < 150 m: no terrain chunk, sky, sea)
const toAc = new THREE.Matrix4().copy(root.matrixWorld).invert();
const sph = new THREE.Sphere(), c = new THREE.Vector3();
const cands = [];
let seen = 0;
for (const g of groups) {
  g.traverseVisible((o) => {
    if (!o.isMesh) return;
    seen++;
    try {
      if (o.isInstancedMesh || o.isBatchedMesh) { if (!o.boundingSphere) o.computeBoundingSphere?.(); if (!o.boundingSphere) return; sph.copy(o.boundingSphere); }
      else { if (!o.geometry) return; if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); if (!o.geometry.boundingSphere) return; sph.copy(o.geometry.boundingSphere); }
      sph.applyMatrix4(o.matrixWorld);
    } catch (_) { return; }
    if (sph.radius > 150) return;
    c.copy(sph.center).applyMatrix4(toAc);
    if (Math.abs(c.x - cx) > half + sph.radius || Math.abs(c.y - cy) > half + sph.radius) return;
    cands.push(o);
  });
}
const rc = new THREE.Raycaster();
const o3 = new THREE.Vector3(), d3 = new THREE.Vector3(0, 0, -1).transformDirection(root.matrixWorld), p = new THREE.Vector3();
const n = Math.round(half / step);
const rows = [], grid = [];
const yieldNow = () => new Promise((r) => setTimeout(r, 0));
for (let j = n; j >= -n; j--) {
  let row = "";
  const gr = [];
  for (let i = -n; i <= n; i++) {
    const x = cx + i * step, y = cy + j * step, gz = ground(x, y);
    if (gz == null) { row += "?"; gr.push(null); continue; }
    o3.set(x, y, gz + 120).applyMatrix4(root.matrixWorld);
    rc.set(o3, d3); rc.near = 0; rc.far = 125;
    let top = null;
    try {
      const hits = rc.intersectObjects(cands, false);
      for (const hit of hits) { p.copy(hit.point).applyMatrix4(toAc); const dz = p.z - gz; if (dz > 0.6) { top = dz; break; } }
    } catch (_) { top = null; }
    const ch = top == null ? "." : top >= 2.5 ? "#" : "+";
    row += ch; gr.push(ch);
  }
  rows.push(row); grid.push(gr);
  if ((j & 7) === 0) await yieldNow();
}
// open points within 80 m of the centre, by clearance (the distance to the nearest non-open grid point)
const blocked = [];
for (let a = 0; a < grid.length; a++) for (let b = 0; b < grid[a].length; b++) if (grid[a][b] !== ".") blocked.push([(b - n) * step, (n - a) * step]);
const open = [];
for (let a = 0; a < grid.length; a++) for (let b = 0; b < grid[a].length; b++) {
  if (grid[a][b] !== ".") continue;
  const dx = (b - n) * step, dy = (n - a) * step;
  if (Math.hypot(dx, dy) > 80) continue;
  let cl = 1e9;
  for (const [bx, by] of blocked) { const d = Math.hypot(bx - dx, by - dy); if (d < cl) cl = d; }
  open.push([dx, dy, Math.round(cl * 10) / 10]);
}
open.sort((u, v) => v[2] - u[2]);
// a frame check: the terrain under the player by the same ray path (no candidates: the terrain group itself)
let frame = null;
try {
  const w = window.__cam.world();
  const tg = root.getObjectByName("terrain");
  o3.set(w.x, w.y, w.z + 50).applyMatrix4(root.matrixWorld);
  rc.set(o3, d3); rc.far = 200;
  const th = tg ? rc.intersectObject(tg, true) : [];
  frame = { me: w, ground: ground(w.x, w.y), terrainHit: th.length ? p.copy(th[0].point).applyMatrix4(toAc).z : null };
} catch (e) { frame = { error: e.message }; }
return { cx, cy, half, step, seen, cands: cands.length, rows, open: open.slice(0, 40), frame };
