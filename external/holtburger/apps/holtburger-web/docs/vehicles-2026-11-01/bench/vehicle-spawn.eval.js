// vehicle-spawn.eval.js — pilot page: spawn a vehicle with @vehicle spawn and wait until the capable client knows it
// (VehicleProfile + VehicleState) and the stand-in entity exists. window.__vehicleRun: {profile?, timeoutMs?}
const R = window.__vehicleRun || {};
const V = window.__vehicles;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { ok: false };
if (!V) return { ...out, fatal: "window.__vehicles missing (?vehicles=on not loaded)" };
const t0 = performance.now();
while (V.status().caps.granted === null && performance.now() - t0 < 20000) await sleep(500);
out.capsGranted = V.status().caps.granted;
const before = new Set(V.vehicles().map((v) => v.guid));
V.spawn(R.profile);
let v = null;
while (performance.now() - t0 < (R.timeoutMs ?? 20000)) {
  v = V.vehicles().find((x) => !before.has(x.guid) && x.profile && x.last);
  if (v) break;
  await sleep(300);
}
if (!v) return { ...out, fatal: "no new vehicle with profile+state", status: V.status() };
const em = window.liveScene3d.entityManager;
let inst = null;
for (let i = 0; i < 40 && !inst; i++) { inst = em.entityMap.get(v.guid); if (!inst) await sleep(250); }
const me = em.entityMap.get((window.getLocalPlayerGuid?.() ?? 0) >>> 0)?.root?.position;
const p = inst?.root?.position;
out.ok = true;
out.vehicle = v.guid;
out.profile = { key: v.profile.profileKey, name: v.profile.displayName, standIn: v.profile.standInSetup, vMax: v.profile.vMax, speedCap: v.profile.speedCap, seats: v.profile.seats.length, weapons: v.profile.weapons.length, parts: v.profile.parts.length };
out.state = { mode: v.last.mode, cell: (v.last.cell >>> 0).toString(16), step: v.last.step };
out.entity = inst ? { name: inst.meta?.name ?? null, setup: inst.meta?.setupId ?? inst.meta?.modelId ?? null, pos: p ? [p.x, p.y, p.z] : null, distFromMe: p && me ? Math.hypot(p.x - me.x, p.y - me.y) : null } : null;
out.wire = JSON.parse(window.__sessionHandle.vehicleWireStats());
out.summary = { ok: true, vehicle: "0x" + v.guid.toString(16), caps: out.capsGranted, profile: out.profile.key, entity: !!inst, dist: out.entity?.distFromMe, wireReceived: out.wire.received_total };
return out;
