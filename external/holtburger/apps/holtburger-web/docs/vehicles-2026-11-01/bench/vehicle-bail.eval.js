// vehicle-bail.eval.js — pilot page (M4): board, climb to the ceiling, bail out, fall, parachute, land on foot.
// window.__vehicleRun: {climbAgl: 440, maxSec: 240, manualChute: false}
// Checks: the chute opened (server event), the descent under it ≤ 6 m/s, health unchanged, the body on the terrain,
// the empty vehicle crashed and despawned.
const R = window.__vehicleRun || {};
const V = window.__vehicles, h = window.__sessionHandle, em = window.liveScene3d.entityManager;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const ground = (x, y) => { try { const z = h.terrainHeightAt(x, y); return z == null ? null : z; } catch (_) { return null; } };
const me = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
const health = () => {
  try {
    const ps = h.playerStats();
    const v = ps.vitals;
    let cur = null;
    for (let i = 0; i + 3 < v.length; i += 4) if (v[i] === 1) { cur = v[i + 1]; break; }
    try { ps.free?.(); } catch (_) { /* */ }
    return cur;
  } catch (_) { return null; }
};
const out = { ok: false, rows: [] };
if (!V) return { ...out, fatal: "window.__vehicles missing" };
const t0 = now();
const tSec = () => (now() - t0) / 1000;
// board (approach first if needed)
if (!V.nearest()) {
  const v = [...V.vehicles()].reverse().find((x) => x.profile && x.last && x.last.mode === 0);
  if (v) {
    h.sendChat(`@teleloc 0x${(v.last.cell >>> 0).toString(16)} ${Math.max(1, v.last.x - 4).toFixed(2)} ${v.last.y.toFixed(2)} ${(v.last.z + 0.5).toFixed(2)}`);
    for (let i = 0; i < 40 && !V.nearest(); i++) await sleep(250);
    await sleep(1500);
  }
}
const vehicleGuid = V.nearest();
out.board = V.board(vehicleGuid);
while (!V.piloting && tSec() < 10) await sleep(200);
if (!V.piloting) return { ...out, fatal: "board refused", status: V.status() };
out.healthBefore = health();
// climb to the ceiling
let st = null;
while (tSec() < 120) {
  st = V.status().pilot?.state;
  if (!st) { await sleep(100); continue; }
  const g = ground(st.x, st.y) ?? 0;
  const agl = st.z - g;
  if (st.mode === 2 && agl >= (R.climbAgl ?? 440)) break;
  V.setSticks({ throttle: 1, pitch: st.mode === 2 ? 1 : 0, roll: 0.2 }, 2000);
  await sleep(100);
}
out.climbSec = r1(tSec());
out.bailAgl = st ? r1(st.z - (ground(st.x, st.y) ?? 0)) : null;
out.bailSpeed = st ? r1(st.speed) : null;
// bail out (two X presses in the client; here the API call directly)
V.clearSticks();
V.exit(1);
const tB = now();
while (!V.falling && now() - tB < 5000) await sleep(100);
out.falling = V.falling;
let chuteAt = null, lastSample = -1;
while (V.falling && tSec() < (R.maxSec ?? 240)) {
  if (R.manualChute && !chuteAt && tSec() - out.climbSec > 3) V.openChute();
  const f = V.status().fall;
  if (f && tSec() - lastSample >= 1) {
    lastSample = tSec();
    out.rows.push({ t: r1(tSec()), agl: r1(f.agl), z: r1(f.z), vz: r1(f.vz), chute: f.chute });
    if (f.chute && chuteAt == null) chuteAt = { t: r1(tSec()), agl: r1(f.agl) };
  }
  await sleep(100);
}
out.fallSec = r1((now() - tB) / 1000);
out.chute = chuteAt;
await sleep(1500);
out.healthAfter = health();
const mp = em.entityMap.get(me)?.root?.position;
out.landed = mp ? { pos: [r1(mp.x), r1(mp.y), r1(mp.z)], ground: r1(ground(mp.x, mp.y)) } : null;
// the derelict vehicle glides down (~6.5 m/s sink), crashes and despawns 10 s later. It glides ~2 km away first, out of
// the on-foot player's sight, so its crash / despawn events may never reach this client (they go to sessions that still
// track it) — the client then prunes it (entity gone + no state for 5 s). The server's "[VEHICLE] despawn … (crashed)"
// log line (printed by the runner) is the authority; here: gone from the client + which events arrived.
const tV = now();
const evs = () => V.events().filter((e) => (e.vehicle >>> 0) === (vehicleGuid >>> 0)).map((e) => e.name);
while (V.vehicles().some((v) => v.guid === (vehicleGuid >>> 0)) && !evs().includes("despawn") && now() - tV < 100000) await sleep(500);
out.vehicleGone = !V.vehicles().some((v) => v.guid === (vehicleGuid >>> 0));
out.vehicleEvents = evs();
out.prunedByClient = V.status().stats?.pruned ?? null;
const chuteRows = out.rows.filter((r) => r.chute);
out.ok = true;
out.summary = {
  bailAgl: out.bailAgl, bailSpeedKmh: out.bailSpeed != null ? r1(out.bailSpeed * 3.6) : null, fallSec: out.fallSec,
  chuteAgl: chuteAt?.agl ?? null, sinkUnderChute: chuteRows.length ? r1(-Math.min(...chuteRows.slice(-5).map((r) => r.vz))) : null,
  healthBefore: out.healthBefore, healthAfter: out.healthAfter, unhurt: out.healthBefore != null && out.healthAfter === out.healthBefore,
  onGround: out.landed ? Math.abs(out.landed.pos[2] - (out.landed.ground ?? -1e9)) < 1.5 : false,
  vehicleGone: out.vehicleGone, vehicleEvents: out.vehicleEvents, despawnEventSeen: out.vehicleEvents.includes("despawn"),
};
return out;
