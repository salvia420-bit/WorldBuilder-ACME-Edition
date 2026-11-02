// film-town-footprints.eval.js — the building / static footprints around a point, in AC world metres relative to it
// (take D2 of the Hellcat film, 2026-11-02; used to pick Al-Arqas's open landing spot). Buildings and most statics are
// BatchedMesh batches per landblock: each instance's geometry bounding box x its instance matrix, through worldRoot (the
// AC frame). Ran against the live page; film-town-survey.eval.js's ray cast MISSED most of these batches.
// window.__vehicleRun = {cx, cy, rad: 220} -> {n, errs, items: [{grp, name, kind, x0, x1, y0, y1 (rel. to cx, cy), z0, z1, g}]}
const R = window.__vehicleRun || {};
const THREE = await import("three");
const L = window.liveScene3d, root = L.scene.getObjectByName("worldRoot"), h = window.__sessionHandle;
L.scene.updateMatrixWorld(true);
const CX = R.cx ?? 27636, CY = R.cy ?? 16956, RAD = R.rad ?? 220;
const toAc = new THREE.Matrix4().copy(root.matrixWorld).invert();
const m = new THREE.Matrix4(), box = new THREE.Box3(), wb = new THREE.Box3();
const ground = (x, y) => { try { return h.terrainHeightAt(x, y); } catch (_) { return null; } };
const out = [];
const errs = [];
const add = (grp, name, b, kind) => {
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
  if (Math.abs(cx - CX) > RAD || Math.abs(cy - CY) > RAD) return;
  const g = ground(cx, cy);
  out.push({ grp, name: name.slice(0, 60), kind, x0: +(b.min.x - CX).toFixed(1), x1: +(b.max.x - CX).toFixed(1), y0: +(b.min.y - CY).toFixed(1), y1: +(b.max.y - CY).toFixed(1), z0: +b.min.z.toFixed(1), z1: +b.max.z.toFixed(1), g: g == null ? null : +g.toFixed(1) });
};
for (const gname of ["buildings", "statics"]) {
  const grp = root.getObjectByName(gname);
  grp.traverse((o) => {
    if (!o.isMesh) return;
    try {
      // the AC frame: matrixWorld then back through worldRoot
      const toAcObj = new THREE.Matrix4().multiplyMatrices(toAc, o.matrixWorld);
      if (o.isBatchedMesh) {
        const n = o.maxInstanceCount ?? o._maxInstanceCount ?? 0;
        for (let i = 0; i < n; i++) {
          let gid;
          try { if (o.getVisibleAt && !o.getVisibleAt(i)) continue; gid = o.getGeometryIdAt(i); } catch (_) { continue; }
          if (gid == null || gid < 0) continue;
          o.getBoundingBoxAt(gid, box); o.getMatrixAt(i, m);
          wb.copy(box).applyMatrix4(new THREE.Matrix4().multiplyMatrices(toAcObj, m));
          add(gname, o.name, wb, "batch");
        }
      } else if (o.isInstancedMesh) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); wb.copy(o.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(toAcObj, m)); add(gname, o.name, wb, "inst"); }
      } else {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        wb.copy(o.geometry.boundingBox).applyMatrix4(toAcObj);
        add(gname, o.name, wb, "mesh");
      }
    } catch (e) { errs.push(`${o.name}: ${e.message}`); }
  });
}
return { n: out.length, errs: errs.slice(0, 10), items: out };
