// flight.eval.js — the flight-experience copy of ../../vehicles-2026-11-01/bench/vehicle-flight.eval.js: board the
// nearest parked vehicle, take off, fly the route with the autopilot (window.__vehicles.setSticks), land, exit.
// Per-LEG overrides on top of the vehicles eval: {heading, metres, agl?, throttle?, boost?, climb?} — `climb` holds a
// constant AGL target that ramps from the previous leg's to `agl` over the leg (Phase 3/4 climbs).
// window.__vehicleRun: {route: [...], agl: 100, throttle: 1, boost: false, sampleMs: 1000,
//   land: true, exit: true, fire: false, maxSec}
// Per sample: predicted pose, the last server state, prediction corrections, AGL, speed, server objects (count around
// the aircraft + first-seen distance of every new object), long tasks, rAF gaps, heap.
const R = window.__vehicleRun || {};
const V = window.__vehicles, W = window, L = window.liveScene3d, h = window.__sessionHandle;
const out = { ok: false, rows: [] };
if (!V) return { ...out, fatal: "window.__vehicles missing" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;
const angleDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const ground = (x, y) => { try { const z = h.terrainHeightAt(x, y); return z == null || !Number.isFinite(z) ? null : z; } catch (_) { return null; } };
const em = L.entityManager, me = (W.getLocalPlayerGuid?.() ?? 0) >>> 0;

// instruments
const lt = { n: 0, ms: 0, max: 0 };
let po = null;
try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { lt.n++; lt.ms += e.duration; if (e.duration > lt.max) lt.max = e.duration; } }); po.observe({ type: "longtask", buffered: false }); } catch (_) { po = null; }
const raf = { gaps: [], last: 0, on: true };
const rafTick = (t) => { if (!raf.on) return; if (raf.last) raf.gaps.push(t - raf.last); raf.last = t; requestAnimationFrame(rafTick); };
requestAnimationFrame(rafTick);
const heapMB = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
const rtt = () => { try { const v = h.sessionLastPingRttMs?.(); return Number.isFinite(v) && v < 60000 ? v : null; } catch (_) { return null; } };

// server-object census (first sight)
const known = new Set();
let vehicleGuid = 0;
const isWorldObj = (guid, p) => p && (guid >>> 0) !== me && (guid >>> 0) !== vehicleGuid && !(Math.abs(p.x) < 1 && Math.abs(p.y) < 1);
for (const [guid, inst] of em.entityMap) if (isWorldObj(guid, inst?.root?.position)) known.add(guid >>> 0);
const firstSeen = [];
let curSpeed = 0;
const scan = (x, y, ux, uy, t) => {
  let total = 0, bubble = 0;
  for (const [guid, inst] of em.entityMap) {
    const p = inst?.root?.position; if (!isWorldObj(guid, p)) continue;
    total++;
    const dx = p.x - x, dy = p.y - y, d = Math.hypot(dx, dy);
    if (d <= 112.5) bubble++;
    const k = guid >>> 0;
    if (!known.has(k)) { known.add(k); firstSeen.push({ t: r1(t), d: r1(d), along: r1(dx * ux + dy * uy), speed: curSpeed, name: inst.meta?.name ?? null }); }
  }
  return { total, bubble };
};

// ---- approach (the server boards only within 8 m) and board
const t0 = now();
const tSec = () => (now() - t0) / 1000;
if (!V.nearest()) {
  const v = [...V.vehicles()].reverse().find((x) => x.profile && x.last && x.last.mode === 0);
  if (v) {
    const lx = Math.max(1, v.last.x - 4), ly = v.last.y;
    h.sendChat(`@teleloc 0x${(v.last.cell >>> 0).toString(16)} ${lx.toFixed(2)} ${ly.toFixed(2)} ${(v.last.z + 0.5).toFixed(2)}`);
    for (let i = 0; i < 40 && !V.nearest(); i++) await sleep(250);
    await sleep(1500);
    out.approach = { teleported: true, near: !!V.nearest() };
  }
}
const target = R.vehicle ?? V.nearest() ?? V.vehicles().find((v) => v.profile)?.guid;
if (!target) return { ...out, fatal: "no vehicle to board", status: V.status() };
vehicleGuid = target >>> 0;
out.board = V.board(target);
while (!V.piloting && tSec() < 10) await sleep(200);
if (!V.piloting) return { ...out, fatal: "board refused / timed out", status: V.status() };
out.boardSec = r2(tSec());
await sleep(800);

// ---- fly
const route = R.route || [{ heading: 111, metres: 3000 }];
const agl = R.agl ?? 100;
const st = () => V.status().pilot;
let leg = 0, legStart = null, phase = "takeoff", travelled = 0, lastPos = null;
let lastSample = -1e9;
const maxSec = R.maxSec ?? 900;
let corrList = [];
let lastPred = null;
// R.stop: the driver ends the route early (flight-1070.mjs --ab: the A/B is done, the rest of the route is not needed)
while (tSec() < maxSec && !R.stop) {
  const p = st();
  if (!p || !p.state) { await sleep(100); if (!V.piloting) break; continue; }
  const s = p.state;
  if (lastPos) travelled += Math.hypot(s.x - lastPos.x, s.y - lastPos.y);
  lastPos = { x: s.x, y: s.y };
  const LC = route[Math.min(leg, route.length - 1)] || {};
  let sticks = { throttle: LC.throttle ?? R.throttle ?? 1, pitch: 0, roll: 0, yaw: 0, boost: LC.boost ?? !!R.boost, fire: false, land: false };
  if (phase === "takeoff") {
    if (s.mode === 2) { phase = "fly"; legStart = { x: s.x, y: s.y }; out.takeoffSec = r2(tSec()); }
  } else if (phase === "fly") {
    const L0 = route[leg];
    const want = (L0.heading * DEG) % (2 * Math.PI);
    const err = angleDiff(want, s.heading);
    sticks.roll = clamp(err * 3.0, -1, 1);
    // altitude: hold AGL over the highest known ground 0-300 m ahead
    let gmax = ground(s.x, s.y) ?? s.z - agl;
    for (let d = 50; d <= 300; d += 50) { const g = ground(s.x + Math.sin(s.heading) * d, s.y + Math.cos(s.heading) * d); if (g != null && g > gmax) gmax = g; }
    const legAgl = L0.agl ?? agl;
    const zErr = gmax + legAgl - s.z;
    sticks.pitch = clamp(zErr / 40, -1, 1);
    sticks.fire = !!R.fire;
    const legDist = Math.hypot(s.x - legStart.x, s.y - legStart.y);
    if (legDist >= L0.metres) {
      leg++;
      legStart = { x: s.x, y: s.y };
      if (leg >= route.length) { phase = R.land === false ? "done" : "land"; out.routeSec = r2(tSec()); }
    }
  } else if (phase === "land") {
    sticks = { throttle: 0, pitch: 0, roll: 0, yaw: 0, land: true };
    if (s.mode === 0) { phase = "landed"; out.landedSec = r2(tSec()); }
  }
  V.setSticks(sticks, 2000);
  if (tSec() - lastSample >= (R.sampleMs ?? 1000) / 1000) {
    lastSample = tSec();
    corrList = V.corrections(); // keep the last list: after an exit the predictor is gone
    const pr = p.predictor || {};
    lastPred = pr;
    const ux = Math.sin(s.heading), uy = Math.cos(s.heading);
    curSpeed = s.speed;
    const g = ground(s.x, s.y);
    const lastRaf = raf.gaps.splice(0);
    const row = {
      t: r1(tSec()), phase, leg, mode: s.mode, x: r1(s.x), y: r1(s.y), z: r1(s.z), agl: g == null ? null : r1(s.z - g),
      kmh: r1(s.speed * 3.6), hdg: r1(s.heading / DEG), seq: p.seq, ack: p.server?.ack ?? null, ackLag: pr.lastAckLagSteps ?? null,
      corr: pr.corrections ?? null, lastCorrM: r2(pr.lastCorrectionM), maxCorrM: r2(pr.maxCorrectionM), substAcks: pr.substitutedAcks ?? null,
      sent: p.sent, rtt: rtt(), obj: scan(s.x, s.y, ux, uy, tSec()), newObj: firstSeen.length,
      lt: { n: lt.n, ms: Math.round(lt.ms), max: Math.round(lt.max) }, rafMax: lastRaf.length ? Math.round(Math.max(...lastRaf)) : null,
      rafN: lastRaf.length, heap: heapMB(),
    };
    lt.n = 0; lt.ms = 0; lt.max = 0;
    out.rows.push(row);
  }
  if (phase === "landed" || phase === "done") break;
  await sleep(100);
}
raf.on = false;
try { po?.disconnect(); } catch (_) { /* */ }
V.clearSticks();
out.corrections = V.piloting ? V.corrections() : corrList;
out.lastPredictor = lastPred;
out.finalStatus = V.status();
out.travelledM = r1(travelled);
// ---- exit
if (R.exit !== false && phase === "landed") {
  await sleep(1500);
  V.exit(0);
  const tE = now();
  while (V.piloting && now() - tE < 8000) await sleep(200);
  out.exited = !V.piloting;
  await sleep(1500);
  const mp = em.entityMap.get(me)?.root?.position;
  const vp = em.entityMap.get(vehicleGuid)?.root?.position;
  out.afterExit = { me: mp ? [r1(mp.x), r1(mp.y), r1(mp.z)] : null, vehicle: vp ? [r1(vp.x), r1(vp.y), r1(vp.z)] : null,
    dist: mp && vp ? r1(Math.hypot(mp.x - vp.x, mp.y - vp.y)) : null, groundUnderMe: mp ? r1(ground(mp.x, mp.y)) : null };
}
// ---- summary
const fly = out.rows.filter((r) => r.phase === "fly");
const cs = out.corrections.filter((c) => Number.isFinite(c)).sort((a, b) => a - b);
const q = (a, f) => (a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))] : null);
const ds = firstSeen.filter((f) => f.t >= (out.takeoffSec ?? 0)).map((f) => f.d).sort((a, b) => a - b);
out.firstSeenSample = firstSeen.slice(0, 120);
out.ok = true;
out.summary = {
  phase, boardSec: out.boardSec, takeoffSec: out.takeoffSec, routeSec: out.routeSec, landedSec: out.landedSec, exited: out.exited ?? null,
  travelledKm: r2(travelled / 1000),
  kmhMedian: fly.length ? q(fly.map((r) => r.kmh).sort((a, b) => a - b), 0.5) : null,
  aglMedian: fly.length ? q(fly.map((r) => r.agl ?? 0).sort((a, b) => a - b), 0.5) : null,
  corrections: cs.length, corrP50: r2(q(cs, 0.5)), corrP95: r2(q(cs, 0.95)), corrMax: r2(cs.length ? cs[cs.length - 1] : null),
  corrOver2m: cs.filter((c) => c > 2).length,
  substAcks: lastPred?.substitutedAcks ?? null, missingAcks: lastPred?.missingAck ?? null, ackLagLast: lastPred?.lastAckLagSteps ?? null,
  replayed: lastPred?.replayed ?? null, steps: lastPred?.steps ?? null,
  rttMedian: q(out.rows.map((r) => r.rtt).filter((v) => v != null).sort((a, b) => a - b), 0.5),
  newObjects: ds.length, firstSeenMedian: q(ds, 0.5),
  // warning time (carry experiment definition): along-track distance at first sight ÷ speed, objects first seen at cruise
  warnSecMedian: (() => { const cr = firstSeen.filter((f) => f.t >= (out.takeoffSec ?? 0) + 10 && f.speed > 20).map((f) => f.along / f.speed).sort((a, b) => a - b); return cr.length ? r2(q(cr, 0.5)) : null; })(),
  warnOver1sFrac: (() => { const cr = firstSeen.filter((f) => f.t >= (out.takeoffSec ?? 0) + 10 && f.speed > 20); return cr.length ? r2(cr.filter((f) => f.along / f.speed >= 1).length / cr.length) : null; })(),
  landmarksFirstSeenMedian: (() => { const lm = firstSeen.filter((f) => f.t >= (out.takeoffSec ?? 0) && f.name && !/^Corpse/.test(f.name)).map((f) => f.d).sort((a, b) => a - b); return lm.length ? q(lm, 0.5) : null; })(), firstSeenAheadFrac: firstSeen.length ? r2(firstSeen.filter((f) => f.along > 0).length / firstSeen.length) : null,
  longTaskMsPerSecMedian: q(fly.map((r) => r.lt.ms).sort((a, b) => a - b), 0.5), longTaskMax: Math.max(0, ...out.rows.map((r) => r.lt.max)),
  heapMax: Math.max(0, ...out.rows.map((r) => r.heap ?? 0)),
  afterExit: out.afterExit ?? null,
};
return out;
