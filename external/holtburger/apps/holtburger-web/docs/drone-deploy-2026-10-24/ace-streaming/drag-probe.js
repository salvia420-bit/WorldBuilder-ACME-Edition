// Position-drag probe (hb-drag experiment build only). Slides the local player along the ground with
// debugDragPose — one AutonomousPosition per step — and censuses what ACE streams in around the moving player.
const RUN = __RUN__; // { heading: deg clockwise from north, speed: m/s, metres, stepMs }
const em = window.liveScene3d.entityManager, h = window.__sessionHandle, g = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
if (typeof h.debugDragPose !== "function") return { error: "debugDragPose missing: not the hb-drag build" };
const P = () => em.entityMap.get(g)?.root?.position;
const isWorld = (guid, r) => r && (guid >>> 0) !== g && !(Math.abs(r.x) < 1 && Math.abs(r.y) < 1);
const cellOf = (x, y) => {
  const lbx = Math.floor(x / 192), lby = Math.floor(y / 192), lx = x - lbx * 192, ly = y - lby * 192;
  const cell = ((lbx << 24) | (lby << 16) | (Math.min(7, Math.floor(lx / 24)) * 8 + Math.min(7, Math.floor(ly / 24)) + 1)) >>> 0;
  return { cell, lx, ly };
};
const p0 = P();
if (!p0) return { error: "no local player position" };
const rad = (RUN.heading * Math.PI) / 180, ux = Math.sin(rad), uy = Math.cos(rad);
const known = new Set();
for (const [guid, inst] of em.entityMap) if (isWorld(guid, inst?.root?.position)) known.add(guid >>> 0);
const preKnown = known.size;
const census = (cx, cy) => {
  let near = 0, ahead = 0, total = 0;
  for (const [guid, inst] of em.entityMap) {
    const r = inst?.root?.position;
    if (!isWorld(guid, r)) continue;
    total += 1;
    if (Math.hypot(r.x - cx, r.y - cy) <= 112.5) { near += 1; if ((r.x - cx) * ux + (r.y - cy) * uy > 0) ahead += 1; }
  }
  return { near, ahead, total };
};
const first = [], rows = [], t0 = performance.now(), perSec = Math.max(1, Math.round(1000 / RUN.stepMs));
let x = p0.x, y = p0.y, z = p0.z, travelled = 0, steps = 0, zMiss = 0, maxSnapErr = 0, c = cellOf(x, y);
while (travelled < RUN.metres) {
  const step = Math.min((RUN.speed * RUN.stepMs) / 1000, RUN.metres - travelled);
  x += ux * step; y += uy * step; travelled += step; steps += 1;
  const tz = h.terrainHeightAt(x, y);
  if (tz === undefined || tz === null) zMiss += 1; else z = tz;
  c = cellOf(x, y);
  h.debugDragPose(c.cell, c.lx, c.ly, z);
  await new Promise((r) => setTimeout(r, RUN.stepMs));
  const p = P();
  if (p) maxSnapErr = Math.max(maxSnapErr, Math.hypot(p.x - x, p.y - y));
  for (const [guid, inst] of em.entityMap) {
    const k = guid >>> 0, r = inst?.root?.position;
    if (known.has(k) || !isWorld(guid, r)) continue;
    known.add(k);
    first.push({ t: +((performance.now() - t0) / 1000).toFixed(1), d: +Math.hypot(r.x - x, r.y - y).toFixed(1),
      along: +((r.x - x) * ux + (r.y - y) * uy).toFixed(1), name: inst.meta?.name ?? null });
  }
  if (steps % perSec === 0) rows.push({ t: +((performance.now() - t0) / 1000).toFixed(1), at: "0x" + c.cell.toString(16), m: Math.round(travelled), ...census(x, y), new: first.length });
}
const runMs = performance.now() - t0;
await new Promise((r) => setTimeout(r, 6000));
const pEnd = P(), ds = first.map((f) => f.d).sort((a, b) => a - b);
return {
  run: RUN, start: [Math.round(p0.x), Math.round(p0.y), +p0.z.toFixed(1)], end: [Math.round(x), Math.round(y), +z.toFixed(1)],
  endCell: "0x" + c.cell.toString(16), rendered: pEnd ? [Math.round(pEnd.x), Math.round(pEnd.y), +pEnd.z.toFixed(1)] : null,
  steps, runSec: +(runMs / 1000).toFixed(1), achievedMps: +(travelled / (runMs / 1000)).toFixed(1), zMiss, maxSnapErr: +maxSnapErr.toFixed(2), preKnown,
  newObjects: first.length, firstSeenDist: ds.length ? { min: ds[0], median: ds[Math.floor(ds.length / 2)], max: ds[ds.length - 1] } : null,
  firstSeenAhead: first.filter((f) => f.along > 0).length, settledCensus: census(x, y), portal: !!window.__isPortalSpaceActive?.(),
  timeline: rows, sample: first.slice(0, 30),
};
