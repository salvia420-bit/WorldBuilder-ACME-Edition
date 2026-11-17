const h = window.__sessionHandle;
h.sendChat("@tele 41.35N 33.33E");
await new Promise(r => setTimeout(r, 12000));
h.setSkyTimeOverride(0.5);
const T = await import("three");
const { buildSemiTrailer } = await import("./scene3d/vehicle/trailer_models.js");
const V = window.__vehicles, s = window.liveScene3d, DECK = 1.32;
const C = { x: 32468, y: 34408 };
const before = new Set(V.containers.list().map(c => c.guid));
for (const r of [{ t: "40hc", dx: -8 }, { t: "40", dx: 0 }, { t: "20", dx: 8 }]) {
  const x = C.x + r.dx, y = C.y;
  const g = h.terrainHeightAt(x, y);
  h.sendChat(`@container spawn ${r.t} ${x.toFixed(2)} ${y.toFixed(2)} ${(g + DECK).toFixed(2)}`);
  await new Promise(res => setTimeout(res, 800));
}
await new Promise(res => setTimeout(res, 5000));
const att = [];
for (const c of V.containers.list()) {
  const e = V.containers.get(c.guid);
  if (before.has(c.guid)) { e.model.root.visible = false; continue; } // old Holtburg spawns
  if (e.__chassis) continue;
  const tr = buildSemiTrailer(T, e.kind === 10 ? "20ft" : "40ft", { csmState: s.csmState, twistlockState: 1 });
  tr.root.position.set(0, 0, -DECK);
  e.model.root.add(tr.root);
  e.__chassis = tr;
  att.push({ guid: c.guid.toString(16), kind: e.kind, pos: [...e.model.root.position.toArray()].map(v => +v.toFixed(2)) });
}
const p = h.getLocalPlayerPose(); const lb = p.landblockId >>> 0;
return { me: { x: ((lb >>> 24) & 0xff) * 192 + p.x, y: ((lb >>> 16) & 0xff) * 192 + p.y, z: p.z }, att };
