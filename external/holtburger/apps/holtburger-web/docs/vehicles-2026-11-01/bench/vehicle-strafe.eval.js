// vehicle-strafe.eval.js — pilot page: kill a ground creature from the air (M2).
// Boards the nearest parked vehicle, takes off, flies out, turns back and makes strafing passes at the floor
// altitude (nose down, the gun fires along the nose), firing only when the target sits inside a small cone and in
// range. The server resolves every bolt; this script only aims and holds the trigger.
// window.__vehicleRun: {target: "Drudge Skulker", outM: 450, maxPasses: 6, coneDeg: 1.2, rangeM: 115, maxSec: 360}
const R = window.__vehicleRun || {};
const V = window.__vehicles, W = window, L = window.liveScene3d, h = window.__sessionHandle;
const out = { ok: false, passes: [] };
if (!V) return { ...out, fatal: "window.__vehicles missing" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;
const angleDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const ground = (x, y) => { try { const z = h.terrainHeightAt(x, y); return z == null || !Number.isFinite(z) ? null : z; } catch (_) { return null; } };
const em = L.entityManager, me = (W.getLocalPlayerGuid?.() ?? 0) >>> 0;
const tname = R.target || "Drudge Skulker";
const t0 = now();
const tSec = () => (now() - t0) / 1000;

const wantGuid = (R.targetGuid ?? window.__vehiclePrev?.target?.guid ?? 0) >>> 0;
const findTarget = () => {
  if (wantGuid) { const inst = em.entityMap.get(wantGuid); return inst ? { guid: wantGuid, inst } : null; }
  const mp = em.entityMap.get(me)?.root?.position;
  let best = null, bd = 1e9;
  for (const [g, inst] of em.entityMap) {
    if ((inst.meta?.name ?? "") !== tname) continue;
    const p = inst.root.position; const d = mp ? Math.hypot(p.x - mp.x, p.y - mp.y) : 0;
    if (d < bd) { bd = d; best = { guid: g >>> 0, inst }; }
  }
  return best;
};
const corpses = () => [...em.entityMap.values()].filter((i) => (i.meta?.name ?? "") === `Corpse of ${tname}`).length;
let deadSince = null;
const isDead = (g) => { try { return !!em.isDeathHeld?.(g); } catch (_) { return false; } };

const tgt = findTarget();
if (!tgt) return { ...out, fatal: `no ${tname} in view` };
out.target = { guid: "0x" + tgt.guid.toString(16), pos: [r1(tgt.inst.root.position.x), r1(tgt.inst.root.position.y), r1(tgt.inst.root.position.z)] };
const corpses0 = corpses();

// board (approach first if needed)
if (!V.nearest()) {
  const v = [...V.vehicles()].reverse().find((x) => x.profile && x.last && x.last.mode === 0);
  if (v) {
    h.sendChat(`@teleloc 0x${(v.last.cell >>> 0).toString(16)} ${Math.max(1, v.last.x - 4).toFixed(2)} ${v.last.y.toFixed(2)} ${(v.last.z + 0.5).toFixed(2)}`);
    for (let i = 0; i < 40 && !V.nearest(); i++) await sleep(250);
    await sleep(1500);
  }
}
out.board = V.board();
while (!V.piloting && tSec() < 10) await sleep(200);
if (!V.piloting) return { ...out, fatal: "board refused / timed out", status: V.status() };

const prof = V.vehicles().find((v) => v.guid === V.status().pilot.vehicle)?.profile;
const muzzle = prof?.weapons?.[0]?.muzzle ?? [0, 4, 0.5];
const range = R.rangeM ?? Math.min(115, (prof?.weapons?.[0]?.range ?? 120) - 5);
const cone = (R.coneDeg ?? 1.2) * DEG;
let phase = "takeoff", pass = 0, passRec = null, outHeading = null, firing = 0, firedSteps = 0;
let killed = false;
const hits0 = V.events().filter((e) => e.kind === 8).length;
while (tSec() < (R.maxSec ?? 360)) {
  const p = V.status().pilot;
  if (!p || !p.state) { if (!V.piloting) break; await sleep(100); continue; }
  const s = p.state;
  const t = findTarget();
  if (!t || corpses() > corpses0 || isDead(t.guid)) { killed = true; break; }
  const tp = t.inst.root.position;
  const dx = tp.x - s.x, dy = tp.y - s.y, dH = Math.hypot(dx, dy);
  const bearing = Math.atan2(dx, dy);
  let sticks = { throttle: R.throttle ?? 0.35, pitch: 0, roll: 0, yaw: 0, fire: false };
  if (phase === "takeoff") {
    sticks.throttle = 1;
    if (s.mode === 2) { phase = "out"; outHeading = bearing + Math.PI; }
  } else if (phase === "out") {
    // fly away from the target, climbing a little, then turn back
    sticks.roll = clamp(angleDiff(outHeading, s.heading) * 2.5, -1, 1);
    sticks.pitch = 0.2;
    if (dH > (R.outM ?? 450)) { phase = "in"; pass++; passRec = { pass, minDist: 1e9, fired: 0, t: r1(tSec()) }; out.passes.push(passRec); }
  } else if (phase === "in") {
    // aim: heading at the target, nose down onto it (the floor clamp keeps the aircraft at 30 m AGL)
    const q0 = Math.cos(s.pitch), mx = s.x + Math.sin(s.heading) * q0 * muzzle[1], my = s.y + Math.cos(s.heading) * q0 * muzzle[1];
    const mz = s.z + Math.sin(s.pitch) * muzzle[1] + muzzle[2];
    const ax = tp.x - mx, ay = tp.y - my, az = tp.z + 0.8 - mz;
    const aH = Math.hypot(ax, ay), dist = Math.hypot(ax, ay, az);
    const wantHdg = Math.atan2(ax, ay), wantPitch = Math.atan2(az, aH);
    const eH = angleDiff(wantHdg, s.heading), eP = wantPitch - s.pitch;
    sticks.roll = clamp(eH * 4.0, -1, 1);
    sticks.yaw = clamp(eH * 6.0, -1, 1);
    sticks.pitch = clamp(wantPitch / (prof?.maxPitch ?? 0.436), -1, 1);
    passRec.minDist = Math.min(passRec.minDist, r1(dist));
    if (dist < range && Math.abs(eH) < cone * 2 && Math.abs(eP) < cone * 2) { sticks.fire = true; passRec.fired++; firedSteps++; }
    if (Math.abs(eH) < 20 * DEG) passRec.aligned = true;
    // passed over the target (only once lined up on it — right after the turn-back it is still behind us): go around
    const ahead = ax * Math.sin(s.heading) + ay * Math.cos(s.heading);
    if (passRec.aligned && (ahead < 0 || dH < 8)) {
      passRec.end = r1(tSec());
      if (pass >= (R.maxPasses ?? 6)) break;
      phase = "out";
      outHeading = s.heading;
    }
  }
  V.setSticks(sticks, 2000);
  await sleep(50);
}
V.clearSticks();
out.killed = killed || corpses() > corpses0;
out.hits = V.events().filter((e) => e.kind === 8).length - hits0;
out.hitDamage = V.events().filter((e) => e.kind === 8).slice(-50).map((e) => r1(e.value));
out.tracers = V.status().tracers;
out.fireMsgs = V.status().stats.fires;
// land and exit so the next step starts on the ground
V.setSticks({ throttle: 0, land: true }, 60000);
const tL = now();
while (V.status().pilot?.state?.mode !== 0 && now() - tL < 40000) await sleep(250);
V.clearSticks();
await sleep(1000);
V.exit(0);
await sleep(2500);
out.landedAndExited = !V.piloting;
out.ok = true;
out.carry = window.__vehiclePrev ?? null;
out.summary = { killed: out.killed, passes: out.passes.length, hits: out.hits, firedSteps, fireMsgs: out.fireMsgs, tracers: out.tracers, minDist: out.passes.map((p) => p.minDist), exited: out.landedAndExited };
return out;
