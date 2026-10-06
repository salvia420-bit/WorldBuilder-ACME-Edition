// drawcensus.js — page-side (`node hbsess.mjs eval drawcensus.js`): per-category draws + submit ms per frame over
// window.__drawsMs (4000) while orbiting window.__hbOrbit (window.__drawsStill = true: no orbit). Includes
// window.__partDegrade.stats when present. Derived from hbprobe.mjs CENSUS (2026-10-06).
const ms = window.__drawsMs || 4000, orbit = window.__drawsStill ? null : window.__hbOrbit;
const r = window.liveScene3d.renderer;
const orig = r.renderBufferDirect;
const cats = new Map();
const nameOf = (o) => {
  let n = o, d = 0;
  while (n && !n.name && d < 5) { n = n.parent; d++; }
  const raw = (n && n.name) || "(anon)";
  return (d ? "^" + d + ":" : "") + raw.replace(/0x[0-9a-f]+/gi, "#").replace(/[0-9a-f]{6,}/gi, "#").replace(/\d+/g, "#");
};
let frames = 0;
r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
  const rt = r.getRenderTarget();
  const pass = (camera?.isOrthographicCamera ? "ortho" : "persp") + ":" + (rt ? `${rt.width}x${rt.height}` : "screen");
  const key = pass + "|" + (object.isInstancedMesh ? "Inst" : object.isBatchedMesh ? "Batch" : object.isPoints ? "Pts" : object.isSprite ? "Sprite" : object.isLine ? "Line" : "Mesh") + "|" + nameOf(object) + "|" + (material?.type || "?");
  const a = performance.now();
  const ret = orig.call(this, camera, scene, geometry, material, object, group);
  const dt = performance.now() - a;
  let c = cats.get(key); if (!c) { c = { n: 0, ms: 0, inst: 0, objs: new Set(), mats: new Set() }; cats.set(key, c); }
  c.n++; c.ms += dt; c.objs.add(object.id); c.mats.add(material?.id);
  if (object.isInstancedMesh) c.inst += object.count;
  return ret;
};
const tStart = performance.now(); let tLast = tStart;
await new Promise((resolve) => {
  const tick = (now) => {
    frames++; tLast = now;
    if (orbit) window.__cam.orbit(orbit.x, orbit.y, orbit.z, orbit.dist, orbit.az + ((now - tStart) / 1000) * orbit.degPerSec, orbit.el);
    if (now - tStart >= ms) return resolve();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
r.renderBufferDirect = orig;
const rows = [...cats.entries()].map(([k, c]) => ({ k, perFrame: +(c.n / frames).toFixed(1), msPerFrame: +(c.ms / frames).toFixed(3), uniqObjs: c.objs.size, uniqMats: c.mats.size, instPerFrame: Math.round(c.inst / frames) }))
  .sort((a, b) => b.perFrame - a.perFrame);
const tot = rows.reduce((a, b) => ({ d: a.d + b.perFrame, m: a.m + b.msPerFrame }), { d: 0, m: 0 });
return { frames, fps: +(frames / ((tLast - tStart) / 1000)).toFixed(1), totalDrawsPerFrame: +tot.d.toFixed(0), totalSubmitMsPerFrame: +tot.m.toFixed(2), rows: rows.slice(0, 45), partDegrade: window.__partDegrade ? window.__partDegrade.stats : null };
