// vehicle-m2-setup.eval.js — pilot page: put a target creature on open ground away from town, then come back.
// window.__vehicleRun: {wcid: 7, offset: [0, -400] (metres from where the pilot stands), name: "Drudge Skulker"}
// Returns carry = {target: {guid, cell, x, y, z, name}, vehicle: {...}} for the next steps (window.__vehiclePrev).
const R = window.__vehicleRun || {};
const h = window.__sessionHandle, em = window.liveScene3d.entityManager;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const me = () => em.entityMap.get((window.getLocalPlayerGuid?.() ?? 0) >>> 0)?.root?.position;
const ground = (x, y) => { try { const z = h.terrainHeightAt(x, y); return z == null ? null : z; } catch (_) { return null; } };
const cellOf = (gx, gy) => {
  const lbx = Math.floor(gx / 192), lby = Math.floor(gy / 192);
  const lx = gx - lbx * 192, ly = gy - lby * 192;
  const cell = ((lbx << 24) | (lby << 16) | (Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1)) >>> 0;
  return { cell, lx, ly };
};
const tele = async (gx, gy, gz) => {
  const c = cellOf(gx, gy);
  h.sendChat(`@teleloc 0x${c.cell.toString(16)} ${c.lx.toFixed(2)} ${c.ly.toFixed(2)} ${gz.toFixed(2)}`);
  for (let i = 0; i < 40; i++) { await sleep(250); const p = me(); if (p && Math.hypot(p.x - gx, p.y - gy) < 3) break; }
  await sleep(2500);
};
const name = R.name || "Drudge Skulker";
const start = me();
if (!start) return { fatal: "no local player pose" };
const home = { x: start.x, y: start.y, z: start.z };
const [ox, oy] = R.offset || [0, -400];
const tx = home.x + ox, ty = home.y + oy;
// the client holds collision terrain only around its load point: prime the streamer for the target landblock first
let tz = ground(tx, ty);
if (tz == null && window.__worldStreamer?.onPositionUpdate) {
  window.__worldStreamer.onPositionUpdate({ guid: (window.getLocalPlayerGuid?.() ?? 0) >>> 0, landblockId: cellOf(tx, ty).cell });
  for (let i = 0; i < 60 && tz == null; i++) { await sleep(250); tz = ground(tx, ty); }
}
if (tz == null) return { fatal: `no terrain at the target spot (${tx}, ${ty})` };
await tele(tx, ty, tz + 0.5);
const before = new Set([...em.entityMap.entries()].filter(([, i]) => (i.meta?.name ?? "") === name).map(([g]) => g >>> 0));
h.sendChat(`@create ${R.wcid ?? 7}`);
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  for (const [g, i2] of em.entityMap) if ((i2.meta?.name ?? "") === name && !before.has(g >>> 0)) { target = { guid: g >>> 0, inst: i2 }; break; }
}
if (!target) return { fatal: `@create ${R.wcid ?? 7} produced no new ${name}` };
const p = target.inst.root.position;
const tc = cellOf(p.x, p.y);
const carry = { target: { guid: target.guid, name, cell: tc.cell, x: p.x, y: p.y, z: p.z }, home };
await tele(home.x, home.y, home.z + 0.5);
return { carry, summary: { target: "0x" + target.guid.toString(16), at: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], back: !!me() && Math.hypot(me().x - home.x, me().y - home.y) < 5 } };
