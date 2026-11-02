// film-hellcat.eval.js — the pilot page of the Hellcat film (film-hellcat-1070.mjs): board the parked Hellcat, fly to
// the kill site, a strafing pass on two players (the cockpit view), then (mode "full") the climb to the ceiling over the
// sea, back to the town, bail out, free fall, chute, touchdown. Every beat is an event stamped with performance.now()
// so the driver can cut the recording. The server resolves every bolt; this script only flies, aims and holds the
// trigger (window.__vehicles.setSticks).
// window.__vehicleRun: {mode: "full" | "attack", site: {x, y}, from: deg (the attack comes FROM this bearing),
//   victims: [names], victimPos: [[x, y], ...], cruiseAgl, slowAtM, attackStartM, attackAgl, attackThrottle, rangeM,
//   coneDeg, maxPasses, holdCockpitSec, climbHeading, ceilingAgl, ceilingHoldSec, town: {x, y}, bailLeadM,
//   endAfterLandSec, flyOnM, maxSec}
const R = window.__vehicleRun || {};
const V = window.__vehicles, W = window, L = window.liveScene3d, h = window.__sessionHandle;
const out = { ok: false, events: [], passes: [], rows: [] };
if (!V) return { ...out, fatal: "window.__vehicles missing" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;
const angleDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const ground = (x, y) => { try { const z = h.terrainHeightAt(x, y); return z == null || !Number.isFinite(z) ? null : z; } catch (_) { return null; } };
const em = L.entityManager;
const t0 = now();
const tSec = () => (now() - t0) / 1000;
const ev = (kind, extra = {}) => { out.events.push({ kind, t: now(), tSec: r1(tSec()), ...extra }); window.__filmPhase = kind; };
window.__filmEvents = out.events;

// ---- the victims: entity by name (players), else the planned spot
const names = R.victims || [];
const planned = R.victimPos || [];
// ACE shows a character of an admin account with a leading "+" ("+Funnel Probe"): compare without it
const norm = (n) => String(n ?? "").replace(/^\+/, "");
const findByName = (name) => {
  for (const [g, inst] of em.entityMap) if (norm(inst.meta?.name) === norm(name)) return { guid: g >>> 0, inst };
  return null;
};
const corpseOf = (name) => {
  for (const inst of em.entityMap.values()) { const n = String(inst.meta?.name ?? ""); if (n.startsWith("Corpse of ") && norm(n.slice(10)) === norm(name)) return true; }
  return false;
};
const dead = new Set();
const isDead = (i) => {
  if (dead.has(i)) return true;
  const e = findByName(names[i]);
  let d = false;
  try { d = !!(e && em.isDeathHeld?.(e.guid)); } catch (_) { d = false; }
  if (d || corpseOf(names[i])) { dead.add(i); ev(`kill${dead.size}`, { victim: names[i] }); return true; }
  return false;
};
const victimPos = (i) => {
  const e = findByName(names[i]);
  if (e) { const p = e.inst.root.position; return { x: p.x, y: p.y, z: p.z, seen: true }; }
  const p = planned[i];
  return p ? { x: p[0], y: p[1], z: ground(p[0], p[1]) ?? 0, seen: false } : null;
};

// ---- board
if (!V.nearest()) {
  const v = [...V.vehicles()].reverse().find((x) => x.profile && x.last && x.last.mode === 0);
  if (v) {
    h.sendChat(`@teleloc 0x${(v.last.cell >>> 0).toString(16)} ${Math.max(1, v.last.x - 4).toFixed(2)} ${v.last.y.toFixed(2)} ${(v.last.z + 0.5).toFixed(2)}`);
    for (let i = 0; i < 40 && !V.nearest(); i++) await sleep(250);
    await sleep(1500);
  }
}
ev("boarding");
out.board = V.board();
while (!V.piloting && tSec() < 10) await sleep(200);
if (!V.piloting) return { ...out, fatal: "board refused / timed out", status: V.status() };
ev("boarded");
V.setView("chase");
await sleep(R.boardHoldMs ?? 2500);

const prof = V.vehicles().find((v) => v.guid === V.status().pilot.vehicle)?.profile;
const muzzle = prof?.weapons?.[0]?.muzzle ?? [0, 4, 0.5];
const range = R.rangeM ?? Math.min(112, (prof?.weapons?.[0]?.range ?? 120) - 8);
const cone = (R.coneDeg ?? 1.4) * DEG;
const site = R.site;
const fromRad = (R.from ?? 12) * DEG;
const town = R.town;
const mode = R.mode || "full";
let phase = "takeoff", pass = 0, passRec = null, outHeading = null, lastSample = -1, killedAt = null, flyOnFrom = null;
let ceilingAt = null, overSea = false;
const holdAgl = (s, agl, heading) => {
  // pitch toward the AGL target over the highest ground 0-300 m ahead
  let gmax = ground(s.x, s.y) ?? s.z - agl;
  for (let d = 50; d <= 300; d += 50) { const g = ground(s.x + Math.sin(heading) * d, s.y + Math.cos(heading) * d); if (g != null && g > gmax) gmax = g; }
  return clamp((gmax + agl - s.z) / 40, -1, 1);
};
while (tSec() < (R.maxSec ?? 900)) {
  const p = V.status().pilot;
  if (!p || !p.state) { if (!V.piloting) break; await sleep(100); continue; }
  const s = p.state;
  const g0 = ground(s.x, s.y);
  const agl = g0 == null ? null : s.z - g0;
  let sticks = { throttle: 1, pitch: 0, roll: 0, yaw: 0, boost: true, fire: false, land: false };
  if (phase === "takeoff") {
    if (s.mode === 2) { phase = mode === "bail" ? "climbOut" : "cruise"; ev("takeoff"); }
  } else if (phase === "climbOut") {
    // mode "bail": out over the sea on climbHeading up to bailAgl, then back to the town
    const want = (R.climbHeading ?? 260) * DEG;
    sticks.roll = clamp(angleDiff(want, s.heading) * 3.0, -1, 1);
    sticks.pitch = agl != null && agl < (R.bailAgl ?? 2600) ? 1 : holdAgl(s, R.bailAgl ?? 2600, s.heading);
    if (agl != null && agl > 1500 && !out.events.some((e) => e.kind === "throughClouds")) ev("throughClouds", { agl: r1(agl) });
    if (!overSea && g0 != null && g0 <= 0.5) { overSea = true; ev("overSea"); }
    if (agl != null && agl >= (R.bailAgl ?? 2600) - 30 && Math.hypot(town.x - s.x, town.y - s.y) > (R.turnBackM ?? 4500)) {
      phase = "ceiling"; ceilingAt = now() - 1e6; ev("turnToTown");
    }
  } else if (phase === "cruise") {
    const dx = site.x - s.x, dy = site.y - s.y, dist = Math.hypot(dx, dy);
    const want = Math.atan2(dx, dy);
    sticks.roll = clamp(angleDiff(want, s.heading) * 3.0, -1, 1);
    sticks.pitch = holdAgl(s, R.cruiseAgl ?? 90, s.heading);
    if (dist < (R.slowAtM ?? 2600)) { sticks.boost = false; sticks.throttle = R.attackThrottle ?? 0.45; }
    if (dist < (R.attackStartM ?? 1500)) {
      phase = "attack"; pass = 1; passRec = { pass, minDist: 1e9, fired: 0, t: r1(tSec()) }; out.passes.push(passRec);
      V.setView(R.attackView ?? "cockpit");
      ev("attackStart", { dist: r1(dist) });
    }
  } else if (phase === "attack") {
    sticks.boost = false;
    sticks.throttle = R.attackThrottle ?? 0.45;
    const alive = names.map((_, i) => i).filter((i) => !isDead(i));
    if (!alive.length) {
      if (!killedAt) { killedAt = now(); ev("bothDead"); }
    }
    const ti = alive.length ? alive[0] : names.length - 1;
    const tp = victimPos(ti);
    if (!tp) { phase = mode === "full" ? "climb" : "flyon"; continue; }
    const q0 = Math.cos(s.pitch), mx = s.x + Math.sin(s.heading) * q0 * muzzle[1], my = s.y + Math.cos(s.heading) * q0 * muzzle[1];
    const mz = s.z + Math.sin(s.pitch) * muzzle[1] + muzzle[2];
    const ax = tp.x - mx, ay = tp.y - my, az = tp.z + 0.9 - mz;
    const aH = Math.hypot(ax, ay), dist = Math.hypot(ax, ay, az);
    const ahead = ax * Math.sin(s.heading) + ay * Math.cos(s.heading);
    if (killedAt) {
      // both down: hold the line over the bodies a moment (the shot), then go
      sticks.pitch = holdAgl(s, R.attackAgl ?? 32, s.heading);
      if ((now() - killedAt) / 1000 > (R.holdCockpitSec ?? 2.5) || ahead < -40) {
        if (mode === "full") { phase = "climb"; V.setView("chase"); ev("climbStart"); }
        else { phase = "flyon"; flyOnFrom = { x: s.x, y: s.y }; ev("flyOn"); }
      }
    } else {
      const wantHdg = Math.atan2(ax, ay), wantPitch = Math.atan2(az, aH);
      const eH = angleDiff(wantHdg, s.heading), eP = wantPitch - s.pitch;
      sticks.roll = clamp(eH * 4.0, -1, 1);
      sticks.yaw = clamp(eH * 6.0, -1, 1);
      // stay at the attack height until ~250 m out, then nose onto the target (the floor clamp keeps ~30 m AGL)
      sticks.pitch = aH > 260 ? holdAgl(s, R.attackAgl ?? 32, s.heading) : clamp(wantPitch / (prof?.maxPitch ?? 0.436), -1, 1);
      passRec.minDist = Math.min(passRec.minDist, r1(dist));
      if (dist < range && Math.abs(eH) < cone * 2 && Math.abs(eP) < cone * 2.5) {
        sticks.fire = true; passRec.fired++;
        if (!out.events.some((e) => e.kind === "firstFire")) ev("firstFire", { dist: r1(dist) });
      }
      if (Math.abs(eH) < 20 * DEG) passRec.aligned = true;
      if (passRec.aligned && (ahead < 0 || aH < 6)) {
        passRec.end = r1(tSec());
        if (pass >= (R.maxPasses ?? 3)) { phase = mode === "full" ? "climb" : "flyon"; flyOnFrom = { x: s.x, y: s.y }; V.setView("chase"); ev("passesExhausted"); }
        else { phase = "out"; outHeading = s.heading; V.setView("chase"); ev("goAround", { pass }); }
      }
    }
  } else if (phase === "out") {
    // back round to the approach line (the same bearing as the first pass: over the valley onto the rise, a level
    // line of fire) — take K's go-arounds came back from wherever the turn ended, over the hill, and missed
    sticks.throttle = 0.7; sticks.boost = false;
    const p0x = site.x + Math.sin(fromRad) * (R.repositionM ?? 1400), p0y = site.y + Math.cos(fromRad) * (R.repositionM ?? 1400);
    const dx0 = p0x - s.x, dy0 = p0y - s.y, d0 = Math.hypot(dx0, dy0);
    // first clear the site on the current heading, then head for the approach point
    const want = (outHeading != null && Math.hypot(site.x - s.x, site.y - s.y) < 500) ? outHeading : Math.atan2(dx0, dy0);
    sticks.roll = clamp(angleDiff(want, s.heading) * 2.5, -1, 1);
    sticks.pitch = holdAgl(s, (R.cruiseAgl ?? 70), s.heading);
    if (names.every((_, i) => isDead(i))) { phase = mode === "full" ? "climb" : "flyon"; flyOnFrom = { x: s.x, y: s.y }; continue; }
    if (d0 < (R.repositionReachM ?? 250)) {
      phase = "attack"; pass++; passRec = { pass, minDist: 1e9, fired: 0, t: r1(tSec()) }; out.passes.push(passRec); outHeading = null;
      V.setView(R.attackView ?? "cockpit");
      ev("attackStart", { pass });
    }
  } else if (phase === "flyon") {
    sticks.boost = false;
    sticks.pitch = holdAgl(s, (R.attackAgl ?? 32) + 40, s.heading);
    if (Math.hypot(s.x - flyOnFrom.x, s.y - flyOnFrom.y) > (R.flyOnM ?? 900)) { ev("done"); phase = "done"; }
  } else if (phase === "climb") {
    const want = (R.climbHeading ?? 252) * DEG;
    sticks.roll = clamp(angleDiff(want, s.heading) * 3.0, -1, 1);
    sticks.pitch = 1;
    if (agl != null && agl > 1500 && !out.events.some((e) => e.kind === "throughClouds")) ev("throughClouds", { agl: r1(agl) });
    if (agl != null && agl >= (R.ceilingAgl ?? 4950)) { phase = "ceiling"; ceilingAt = now(); ev("ceiling", { agl: r1(agl) }); }
  } else if (phase === "ceiling") {
    sticks.pitch = holdAgl(s, mode === "bail" ? (R.bailAgl ?? 2600) : (R.ceilingAgl ?? 4950) + 50, s.heading);
    const hold = (now() - ceilingAt) / 1000 < (R.ceilingHoldSec ?? 8);
    const dx = town.x - s.x, dy = town.y - s.y, dist = Math.hypot(dx, dy);
    const want = hold ? (R.climbHeading ?? 252) * DEG : Math.atan2(dx, dy);
    if (!hold && !out.events.some((e) => e.kind === "turnToTown")) ev("turnToTown", { dist: r1(dist) });
    if (mode === "bail" && !hold && Math.abs(angleDiff(Math.atan2(dx, dy), s.heading)) < 25 * DEG && !out.events.some((e) => e.kind === "lineUp")) ev("lineUp", { dist: r1(dist) });
    sticks.roll = clamp(angleDiff(want, s.heading) * 2.5, -1, 1);
    // the sea below: the world tier's terrain type (water codes 16-20) would need a lookup; the height at sea level is
    // the honest proxy for the edit (Dereth's sea floor reads as the 0 m land height)
    if (!overSea && g0 != null && g0 <= 0.5) { overSea = true; ev("overSea"); }
    if (overSea && g0 != null && g0 > 2 && !out.events.some((e) => e.kind === "coast")) ev("coast");
    const aligned = Math.abs(angleDiff(Math.atan2(dx, dy), s.heading)) < 25 * DEG;
    if (!hold && aligned && dist < (R.bailLeadM ?? 700)) {
      V.clearSticks();
      V.exit(1);
      ev("bail", { dist: r1(dist), agl: r1(agl) });
      phase = "fall";
    }
  }
  if (phase === "fall") break;
  if (phase === "done") break;
  V.setSticks(sticks, 2000);
  if (tSec() - lastSample >= 1) {
    lastSample = tSec();
    out.rows.push({ t: r1(tSec()), phase, x: r1(s.x), y: r1(s.y), agl: r1(agl), kmh: r1(s.speed * 3.6), hdg: r1(s.heading / DEG), mode: s.mode });
  }
  await sleep(50);
}
V.clearSticks();
if (phase === "fall") {
  const tB = now();
  while (!V.falling && now() - tB < 5000) await sleep(100);
  let chute = false;
  while (V.falling && tSec() < (R.maxSec ?? 900) + 240) {
    const f = V.status().fall;
    if (f && f.chute && !chute) { chute = true; ev("chute", { agl: r1(f.agl) }); }
    if (f && !out.events.some((e) => e.kind === "fallThroughClouds") && f.agl < 2200) ev("fallThroughClouds", { agl: r1(f.agl) });
    await sleep(100);
  }
  ev("touchdown");
  await sleep((R.endAfterLandSec ?? 6) * 1000);
  ev("end");
}
out.dead = [...dead].map((i) => names[i]);
out.ok = true;
out.summary = { phase, dead: out.dead, passes: out.passes.map((p) => ({ pass: p.pass, fired: p.fired, minDist: p.minDist })), events: out.events.map((e) => `${e.kind}@${e.tSec}`) };
return out;
