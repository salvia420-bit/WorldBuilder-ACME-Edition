#!/usr/bin/env node
// tools/make_shot.mjs — phase 2 of the Egg Orchard FPV run (orchestrator, 2026-10-15).
//
// Builds the plan shot `egg-orchard.run` (technique fpv.fpv-run) from data/racing_line.json (JEV passes baked in),
// data/zones.json and data/tricks.json; finds the shortest duration the zone caps fly WITHOUT overspeed (so the run
// is as fast as its speed plan allows and never time-compressed), dry-flies it through the real flight model
// (flyTrajectory 'fpv', 24 fps) and writes:
//   run-shot.json        the plan shot (site = site.json id)
//   data/flown.json      [{t, pos}] of the FLOWN take at 24 fps (for tools/check_clearance.py)
//   data/nominal.json    the same for the nominal trajectory
//   data/build.json      duration search, meta (tricks with their windows / skips, zones, peak speed), tracking
//
//   node tools/make_shot.mjs [--duration=<s>] [--step=0.5]
import fs from "node:fs";
import path from "node:path";

const HB = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web";
const SHOTS = await import(path.join(HB, "scene3d/film/shots/index.js"));
const DRONE = await import(path.join(HB, "scene3d/film/shots/drone.js"));
const FLIGHT = await import(path.join(HB, "scene3d/film/drone/flight_model.js"));
const SCHEMA = await import(path.join(HB, "scene3d/film/shots/fpv_tricks.js"));

const HERE = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const FPS = 24;
const J = (f) => JSON.parse(fs.readFileSync(path.join(HERE, f), "utf8"));
const line = J("data/racing_line.json");
const zonesDoc = J("data/zones.json");
const tricksDoc = J("data/tricks.json");
const site = J("site.json");

const r3 = (x) => Math.round(x * 1000) / 1000;
const CORNER_R = Number(process.env.CORNER_R ?? 0.4);
// Smoothing pre-compensation: fpv.fpv-run fillets and curvature-smooths its input (≈ 0.6·cornerRadius + 0.8 m), which
// rounds off the baked pass bumps by up to ≈ 0.7 m. Feed it a line nudged by the opposite of that error, iterated, so
// the line it FLIES lands on the authored, clearance-checked racing line.
function compensate(target, iters) {
  let input = target.map((p) => p.slice());
  const stats = [];
  for (let it = 0; it < iters; it++) {
    const L = DRONE.fpvRunLine(input, { cornerRadius: CORNER_R }, { indoor: {} });
    let sPrev = 0, maxE = 0, sumE = 0;
    const next = [];
    for (let i = 0; i < target.length; i++) {
      const P = target[i];
      let best = sPrev, bd = Infinity;
      for (let q = Math.max(0, sPrev - 1.5); q <= Math.min(L.length, sPrev + 3); q += 0.02) {
        const a = L.at(q);
        const d = Math.hypot(a[0] - P[0], a[1] - P[1], a[2] - P[2]);
        if (d < bd) { bd = d; best = q; }
      }
      sPrev = best;
      const a = L.at(best);
      const e = [P[0] - a[0], P[1] - a[1], P[2] - a[2]];
      maxE = Math.max(maxE, bd);
      sumE += bd;
      next.push([input[i][0] + e[0], input[i][1] + e[1], input[i][2] + e[2]]);
    }
    stats.push({ iter: it, maxDevM: r3(maxE), meanDevM: r3(sumE / target.length) });
    if (it < iters - 1) input = next;
  }
  return { input: input.map((p) => p.map(r3)), stats };
}
const comp = compensate(line.points, Number(process.env.COMP_ITERS ?? 4));
const points = comp.input;
console.error(`compensation: ${JSON.stringify(comp.stats)}`);

// Orchestrator adjustments to agent D's trick and zone placements (raw arc length along racing_line.json), 2026-10-15.
// Rule-based (tied to the geometry or to the neighbouring trick), so they survive a re-bake that shifts every s:
//  - the entry dive overlaps the entry float, which already ends nose-down into the trench groove → dropped;
//  - the chute float (cut the throttle over the floor hole) lands 8.9 m before the chute dive;
//  - chimney A: a 1.5 m/s crawl from 3 m before to 2.5 m past its zone, and the 13 m float centred on the point where the
//    line crosses the shaft's centre (x 220) — the float keeps the route's forward motion, so it must rise and fall
//    INSIDE the 10 × 10 m shaft;
//  - the pit-edge roll is dropped: the chimney-B yaw spin (≈ 10 m) runs into the pit nose-over, no room between.
const adjLog = [];
const CHIMNEY_X = 220, CHIMNEY_SPEED = Number(process.env.CHIMNEY_SPEED ?? 1.5);
let chimneyCentreS = null;
{
  let best = Infinity;
  line.points.forEach((p, i) => {
    if (String(line.cells[i]).toUpperCase().endsWith("1E0")) {
      const d = Math.abs(p[0] - CHIMNEY_X);
      if (d < best) { best = d; chimneyCentreS = line.s[i]; }
    }
  });
  if (chimneyCentreS === null) throw new Error("chimney A (cell 0x1E0) is not on the racing line");
}
const isWhy = (t, re) => re.test(String(t.why || ""));
const src = tricksDoc.tricks;
const rawTricks = [];
for (const t of src) {
  if (t.type === "dive" && t.s < 30) { adjLog.push(`dropped dive@${t.s}: the entry float already ends nose-down into the trench groove`); continue; }
  if (t.type === "float" && isWhy(t, /floor hole/)) {
    const dive = src.find((x) => x.type === "dive" && isWhy(x, /floor chute/));
    const s = Math.round((dive.s - 8.9) * 100) / 100;
    adjLog.push(`moved chute float ${t.s} → ${s}: land before the chute dive at ${dive.s}`);
    rawTricks.push({ ...t, s });
    continue;
  }
  if (t.type === "float" && isWhy(t, /chimney A/)) {
    const half = Number(process.env.CHIMNEY_FLOAT_HALF ?? 3.4);
    const s = Math.round((chimneyCentreS - half) * 100) / 100;
    adjLog.push(`moved chimney float ${t.s} → ${s}: centred on the shaft (line at x ${CHIMNEY_X}, s ${chimneyCentreS.toFixed(2)})`);
    rawTricks.push({ ...t, s });
    continue;
  }
  if (t.type === "roll" && isWhy(t, /pit edge/)) {
    // the chimney-B yaw spin (≈ 10 m) and the pit nose-over leave no room for it: three tricks in ≈ 15 m
    adjLog.push(`dropped pit-edge roll@${t.s}: the chimney-B yaw spin flows straight into the pit nose-over`);
    continue;
  }
  rawTricks.push(t);
}

// Map raw arc lengths onto the line the technique flies (corners filleted + curvature-smoothed: shorter). A local
// search around the proportional estimate — never the global nearest point, which can land on another level where
// the line passes over itself (the pit, the ramp hall).
const rawS = line.s;
const rawAt = (s) => {
  let i = 0;
  while (i < rawS.length - 2 && rawS[i + 1] < s) i++;
  const f = rawS[i + 1] > rawS[i] ? Math.min(1, Math.max(0, (s - rawS[i]) / (rawS[i + 1] - rawS[i]))) : 0;
  return [0, 1, 2].map((k) => line.points[i][k] + f * (line.points[i + 1][k] - line.points[i][k]));
};
const runLine = DRONE.fpvRunLine(points, { cornerRadius: CORNER_R }, { indoor: {} });
const Lraw = rawS[rawS.length - 1], Ltech = runLine.length;
const mapS = (s) => {
  const p = rawAt(s);
  const guess = (s * Ltech) / Lraw;
  let best = guess, bd = Infinity;
  for (let q = Math.max(0, guess - 25); q <= Math.min(Ltech, guess + 25); q += 0.05) {
    const a = runLine.at(q);
    const d = Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]);
    if (d < bd) { bd = d; best = q; }
  }
  if (bd > 1.5) throw new Error(`arc-length map: raw s ${s} lands ${bd.toFixed(2)} m from the flown line`);
  return Math.round(best * 100) / 100;
};
// only the catalogue's fields (the docs carry why / tEstimate notes)
const zoneKeys = Object.keys(SCHEMA.FPV_ZONE_ITEM ?? { s0: 1, s1: 1, speed: 1 });
const zonesRaw = zonesDoc.zones.map((z) => ({ ...z }));
{
  const cz = zonesRaw.find((z) => isWhy(z, /chimney A/));
  if (!cz) throw new Error("no chimney A zone in zones.json");
  const a = { s0: Math.min(cz.s0 - 3.0, chimneyCentreS - 7), s1: Math.max(cz.s1 + 2.5, chimneyCentreS + 7), speed: CHIMNEY_SPEED };
  adjLog.push(`chimney zone ${cz.s0}-${cz.s1}@${cz.speed} → ${a.s0.toFixed(2)}-${a.s1.toFixed(2)}@${a.speed}: the float stays inside the shaft`);
  Object.assign(cz, a);
  for (const z of zonesRaw) {
    if (z === cz) continue;
    if (z.s1 > a.s0 && z.s0 < a.s0) z.s1 = a.s0;
    if (z.s0 < a.s1 && z.s1 > a.s1) z.s0 = a.s1;
  }
}
const zones = zonesRaw.map((z) => {
  const o = Object.fromEntries(zoneKeys.filter((k) => z[k] !== undefined).map((k) => [k, z[k]]));
  o.s0 = mapS(z.s0);
  o.s1 = Math.min(Ltech, mapS(Math.min(z.s1, Lraw)));
  return o;
}).filter((z) => z.s1 > z.s0);
const tricks = rawTricks.map((t) => {
  const allowed = ["type", "s", ...Object.keys(SCHEMA.FPV_TRICK_VARIANTS.fields[t.type] || {})];
  const o = Object.fromEntries(allowed.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
  o.s = mapS(t.s);
  return o;
});
const params = {
  speed: 8, speedMax: 12, amax: 9, alat: Number(process.env.ALAT ?? 12), cornerRadius: CORNER_R, lookAhead: 5, uptiltDeg: 25, lookAlongPath: 0.55,
  bankGain: 1.2, maxBankDeg: 60, throttleBobM: 0.08, bobHz: 1.1, wobbleDeg: 0.4, propwashDeg: 0.8, startHoldSec: 1.2,
  ends: "rest", zones, tricks,
};
const ctx = { path: points, anchor: points[0], indoor: {}, fps: FPS, aspect: 16 / 9 };
const seed = 0x0e66;
const build = (D) => SHOTS.buildShot({ technique: "fpv.fpv-run", duration: D, params, seed, fov: 100, framing: "WS" }, ctx);

// shortest duration without overspeed (bisection on [60, 300] s), then rounded up to the step
let D;
const search = [];
if (args.duration) D = Number(args.duration);
else {
  let lo = 60, hi = 300;
  if (build(hi).meta.overspeed) throw new Error("even 300 s overspeeds — check the zones");
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const o = build(mid).meta.overspeed;
    search.push({ D: r3(mid), overspeed: o });
    if (o) lo = mid; else hi = mid;
  }
  const step = Number(args.step ?? 0.5);
  D = Math.ceil(hi / step) * step;
}
const traj = build(D);
const M = traj.meta;
const flown = FLIGHT.flyTrajectory(traj, "fpv", FPS);
const N = Math.round(D * FPS);
const rows = (tr) => Array.from({ length: N + 1 }, (_, i) => {
  const t = Math.min(D, i / FPS);
  const p = tr.sample(t);
  return { t: r3(t), pos: p.pos.map(r3), h: r3(p.h ?? 0), p: r3(p.p ?? 0), r: r3(p.r ?? 0), fov: p.fov };
});
fs.writeFileSync(path.join(HERE, "data/flown.json"), JSON.stringify(rows(flown)));
fs.writeFileSync(path.join(HERE, "data/nominal.json"), JSON.stringify(rows(traj)));
let vmax = 0, prev = null;
for (const r of rows(flown)) {
  if (prev) vmax = Math.max(vmax, Math.hypot(r.pos[0] - prev[0], r.pos[1] - prev[1], r.pos[2] - prev[2]) * FPS);
  prev = r.pos;
}
const report = {
  duration: D, search, overspeed: M.overspeed, lengthM: M.lengthM, peakSpeed: M.peakSpeed, flownPeakSpeed: r3(vmax),
  tracking: { maxErrorM: r3(flown.meta.flight.maxTrackingErrorM), meanErrorM: r3(flown.meta.flight.meanTrackingErrorM), maxSpeed: r3(flown.meta.flight.maxSpeed), maxAccel: r3(flown.meta.flight.maxAccel), settled: flown.meta.flight.settled, overrunSec: flown.meta.flight.overrunSec },
  tricks: (M.tricks || []).map((t) => ({ type: t.type, s: t.s, t0: t.t0 != null ? r3(t.t0) : null, t1: t.t1 != null ? r3(t.t1) : null, skipped: t.skipped || false, reason: t.reason || null })),
  zones: M.zones, lockWindows: M.lockWindows, validate: M.validate,
  arcLength: { raw: r3(Lraw), flown: r3(Ltech) }, adjustments: adjLog, compensation: comp.stats,
};
fs.writeFileSync(path.join(HERE, "data/build.json"), JSON.stringify(report, null, 1));

const shot = {
  id: "egg-orchard.run",
  site: site.id,
  technique: "fpv.fpv-run",
  duration: { sec: D },
  framing: "WS",
  fov: 100,
  path: points,
  params,
  seed,
  cell: "0x002B0371",
  capture: { mode: "stepped" },
  pilot: { mode: "jev", fade: "never", consult: { withinM: 3 } },
  bounds: { maxLateral: 0.5, maxRise: 0.5, maxSink: 0.4, minSpeedScale: 0.9, maxSpeedScale: 1.05 },
  overlay: { props: { style: "freestyle" } },
  standingOrder: "Race the drop down to the orchard's exit portal on the planned line; pass every olthoi on its planned side with a metre to spare; never fade creatures; walls, vents and pillars at least 0.8 m away; slow rather than scrape.",
  notes: `Owner's full-dungeon FPV run (2026-10-15), appended after the music. Racing line ${line.length} m / 164 cells from the entrance drop 0x002B0371 to the Surface portal 0x002B0100, ${line.passesSource?.counts ? `${line.passesSource.counts.over} over / ${line.passesSource.counts.left} left / ${line.passesSource.counts.right} right` : ""} creature passes chosen by JEV (research/egg-orchard-run/data/passes.json), ${tricks.length} tricks (${report.tricks.filter((t) => !t.skipped).length} flown), speed zones per segment; offline dry-flight tracking ${report.tracking.maxErrorM} m; clearances in research/egg-orchard-run/verify.json.`,
};
fs.writeFileSync(path.join(HERE, "run-shot.json"), JSON.stringify(shot, null, 1));
console.log(JSON.stringify({ duration: D, overspeed: M.overspeed, lengthM: r3(M.lengthM), peakSpeed: r3(M.peakSpeed), flownPeak: report.flownPeakSpeed, tracking: report.tracking, tricks: report.tricks.map((t) => `${t.type}@${t.s}${t.skipped ? " SKIPPED " + t.reason : ` t${t.t0}-${t.t1}`}`) }, null, 1));
