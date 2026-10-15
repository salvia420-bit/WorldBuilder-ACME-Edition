// poi-kit/check.mjs — offline shot checker for the Dereth tour expansion (2026-10-15).
// Builds each plan shot with the REAL film technique registry against a ctx whose groundZ is the real AC terrain
// (geo.mjs), samples the take at the plan fps and reports terrain clearance, the nearest obstacle (statics,
// building prisms, default-bake scenery, spawns; retail-bake scenery reported separately), nominal speed, the
// flight-model dry-fly (drone/fpv: tracking gap + peak speed vs the preset cap), water under the lens, subject line
// of sight and subject-in-frame share. A shot with trim:{takeSec, inSec} is built at takeSec and ALSO reported for
// its edit window [inSec, inSec + duration.sec].
//
// usage: node check.mjs <plan.json> [shotId …] [--verbose] [--json] [--step=1]
//   --verbose  one row per --step seconds: t, pos, AGL, heading/pitch/fov, subject distance + NDC, LOS, nearest
//   --json     one JSON object per shot on stdout
import fs from "node:fs";
import { anchorWorld, blocked, groundZ, nearest, obstaclesNear, project, waterAt, distTo } from "./geo.mjs";

const HB = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web";
const SHOTS = await import(`${HB}/scene3d/film/shots/index.js`);
const FLIGHT = await import(`${HB}/scene3d/film/drone/flight_model.js`);
const PRESET_VMAX = { cinema: 12, heavy: 7, fpv: 25, indoor: 4 };

const args = process.argv.slice(2);
const planFile = args[0];
if (!planFile) { console.error("usage: node check.mjs <plan.json> [shotId …] [--verbose] [--json] [--step=1]"); process.exit(2); }
const verbose = args.includes("--verbose");
const asJson = args.includes("--json");
const stepArg = args.find((a) => a.startsWith("--step="));
const step = stepArg ? Number(stepArg.slice(7)) : 1;
const only = args.slice(1).filter((a) => !a.startsWith("--"));
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const sites = Object.fromEntries(plan.sites.map((s) => [s.id, s]));
const fps = (plan.format && plan.format.fps) || 24;
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const fv = (v) => v.map((x) => x.toFixed(1)).join(",");

for (const shot of plan.shots) {
  if (only.length && !only.includes(shot.id)) continue;
  const site = sites[shot.site];
  const anchor = anchorWorld(site.anchor);
  const s = shot.subject;
  const point = s && s.kind === "point" ? { pos: s.pos, radius: s.radius ?? 0.6, height: s.height ?? 1.8, ...(Number.isFinite(s.heading) ? { heading: s.heading } : {}) } : null;
  const ctx = { subject: point || (s && s.kind !== "path" ? { pos: anchor, radius: 0.6, height: 1.8 } : null), anchor, groundZ: (x, y) => groundZ(x, y), path: shot.path || (s && s.kind === "path" ? s.points : undefined), aspect: 16 / 9, fps };
  const dur = shot.trim && Number.isFinite(shot.trim.takeSec) ? shot.trim.takeSec : shot.duration && shot.duration.sec;
  if (!Number.isFinite(dur)) { console.log(`${shot.id}: skipped (duration is not {sec} and no trim.takeSec)`); continue; }
  const spec = { technique: shot.technique, duration: dur, params: shot.params || {}, seed: shot.seed };
  for (const k of ["framing", "fov", "roll", "ease", "bounds"]) if (shot[k] !== undefined) spec[k] = shot[k];
  if (s) spec.subject = s;
  let traj;
  try { traj = SHOTS.buildShot(spec, ctx); } catch (e) { console.log(`${shot.id} ${shot.technique}: BUILD FAILED ${e.message}`); continue; }
  const D = traj.duration;
  const win = shot.trim ? [shot.trim.inSec, Math.min(D, shot.trim.inSec + (shot.duration.sec ?? D))] : [0, D];
  const p0 = traj.sample(0).pos, pm = traj.sample(D / 2).pos, pe = traj.sample(D).pos;
  const cx = (p0[0] + pm[0] + pe[0]) / 3, cy = (p0[1] + pm[1] + pe[1]) / 3;
  const R = Math.max(250, Math.hypot(p0[0] - cx, p0[1] - cy), Math.hypot(pe[0] - cx, pe[1] - cy)) + 60;
  const obs = obstaclesNear(cx, cy, R, { scenery: "both" });
  const drawn = obs.filter((o) => o.kind !== "scenery-retail");
  // the subject's own body (a Life Stone, statue, tower… whose footprint holds the subject axis; points ≤ 8 m wide)
  const bodyIds = new Set();
  if (point && point.radius <= 8) for (const o of drawn) {
    const ax = [point.pos[0], point.pos[1], point.pos[2] + point.height * 0.5];
    const inFp = o.fp ? distTo([ax[0], ax[1], (o.z0 + o.z1) / 2], o) === 0 : ax[0] >= o.lo[0] && ax[0] <= o.hi[0] && ax[1] >= o.lo[1] && ax[1] <= o.hi[1];
    if (inFp) bodyIds.add(o.id);
  }
  const stats = (t0, t1) => ({ minAgl: { v: Infinity }, maxAgl: -Infinity, near: { d: Infinity }, nearRetail: { d: Infinity }, vmax: 0, water: 0, n: 0, losN: 0, losBad: 0, firstBlock: null, inFrame: 0, frameN: 0, t0, t1 });
  const full = stats(0, D), wnd = stats(win[0], win[1]);
  const rows = [];
  const N = Math.max(1, Math.round(D * fps));
  let prev = null;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * D;
    const ps = traj.sample(t);
    const p = ps.pos;
    const g = groundZ(p[0], p[1]);
    const agl = g === null ? NaN : p[2] - g;
    const nb = nearest(p, drawn, (o) => !bodyIds.has(o.id));
    const nr = i % 3 === 0 ? nearest(p, obs, (o) => o.kind === "scenery-retail") : null;
    const v = prev ? Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) / (D / N) : 0;
    prev = p;
    let los = null, ndc = null;
    if (point && i % 6 === 0) {
      const tgt = [point.pos[0], point.pos[1], point.pos[2] + point.height * 0.5];
      los = blocked(p, tgt, drawn, Math.max(1.5, Math.min(point.radius, 8)), (o) => bodyIds.has(o.id));
      ndc = project(ps, tgt);
    }
    for (const st of [full, ...(t >= win[0] - 1e-9 && t <= win[1] + 1e-9 ? [wnd] : [])]) {
      st.n++;
      if (agl < st.minAgl.v) st.minAgl = { v: agl, t, p };
      if (agl > st.maxAgl) st.maxAgl = agl;
      if (nb.d < st.near.d) st.near = { ...nb, t };
      if (nr && nr.d < st.nearRetail.d) st.nearRetail = { ...nr, t };
      if (v > st.vmax) st.vmax = v;
      if (waterAt(p[0], p[1])) st.water++;
      if (ndc) {
        st.losN++; st.frameN++;
        if (los) { st.losBad++; if (!st.firstBlock) st.firstBlock = { t, ...los }; }
        if (!ndc.behind && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1) st.inFrame++;
      }
    }
    if (verbose && (i % Math.max(1, Math.round(fps * step)) === 0 || i === N)) {
      const sd = point ? Math.hypot(p[0] - point.pos[0], p[1] - point.pos[1], p[2] - point.pos[2] - point.height * 0.5) : NaN;
      const nd = point ? project(ps, [point.pos[0], point.pos[1], point.pos[2] + point.height * 0.5]) : null;
      const lb = point ? blocked(p, [point.pos[0], point.pos[1], point.pos[2] + point.height * 0.5], drawn, Math.max(1.5, Math.min(point.radius, 8)), (o) => bodyIds.has(o.id)) : null;
      rows.push({ t: +t.toFixed(2), pos: p.map((x) => +x.toFixed(1)), agl: +agl.toFixed(1), h: Math.round((ps.h * 180) / Math.PI), pitch: Math.round((ps.p * 180) / Math.PI), fov: Math.round(ps.fov), v: +v.toFixed(1),
        subjDist: +sd.toFixed(1), ndc: nd && !nd.behind ? [+nd.x.toFixed(2), +nd.y.toFixed(2)] : nd ? "behind" : null, los: lb ? `${lb.kind}:${lb.id}` : point ? "clear" : null, near: `${nb.d.toFixed(1)} ${nb.kind}:${nb.id}`, ...(ps.focus ? { focus: +ps.focus.toFixed(1) } : {}) });
    }
  }
  let flight = null;
  if (traj.family === "drone" || traj.family === "fpv") {
    try {
      const preset = (shot.pilot && shot.pilot.flightPreset) || FLIGHT.presetForTrajectory(traj);
      const fl = FLIGHT.flyTrajectory(traj, preset, fps).meta.flight;
      flight = { preset, vmaxCap: PRESET_VMAX[preset], maxSpeed: +fl.maxSpeed.toFixed(2), maxTrackingErrorM: +fl.maxTrackingErrorM.toFixed(2), overrunSec: fl.overrunSec, settled: fl.settled };
    } catch (e) { flight = { error: e.message }; }
  }
  const sum = (st) => ({
    t: [+st.t0.toFixed(2), +st.t1.toFixed(2)], minAgl: +st.minAgl.v.toFixed(2), minAglAt: +(st.minAgl.t ?? 0).toFixed(1), maxAgl: +st.maxAgl.toFixed(1),
    nearest: { d: +st.near.d.toFixed(2), kind: st.near.kind, id: st.near.id, t: +(st.near.t ?? 0).toFixed(1) },
    nearestRetailScenery: Number.isFinite(st.nearRetail.d) ? { d: +st.nearRetail.d.toFixed(1), id: st.nearRetail.id } : null,
    vmax: +st.vmax.toFixed(2), waterPct: Math.round((100 * st.water) / Math.max(1, st.n)),
    los: point ? { blocked: st.losBad, of: st.losN, first: st.firstBlock ? `${st.firstBlock.kind}:${st.firstBlock.id} @t${st.firstBlock.t.toFixed(1)}` : null } : null,
    subjectInFramePct: point ? Math.round((100 * st.inFrame) / Math.max(1, st.frameN)) : null,
  });
  const res = { shot: shot.id, technique: shot.technique, takeSec: +D.toFixed(3), window: shot.trim ? win.map((x) => +x.toFixed(3)) : null,
    start: { pos: p0.map((x) => +x.toFixed(1)) }, end: { pos: pe.map((x) => +x.toFixed(1)) }, subjectBody: [...bodyIds], take: sum(full), ...(shot.trim ? { edit: sum(wnd) } : {}), flight, ...(verbose ? { rows } : {}) };
  if (asJson) { console.log(JSON.stringify(res)); continue; }
  const line = (lab, x) => `   ${lab} t${x.t[0]}-${x.t[1]}: AGL ${f1(x.minAgl)}..${f1(x.maxAgl)} (min @t${x.minAglAt}) | nearest ${f1(x.nearest.d)} m ${x.nearest.kind} ${x.nearest.id} @t${x.nearest.t}${x.nearestRetailScenery ? ` (retail-bake tree ${x.nearestRetailScenery.d} m)` : ""} | vmax ${x.vmax} m/s | water ${x.waterPct}%${x.los ? ` | LOS blocked ${x.los.blocked}/${x.los.of}${x.los.first ? " first " + x.los.first : ""} | subject in frame ${x.subjectInFramePct}%` : ""}`;
  console.log(`${shot.id} ${shot.technique} take ${res.takeSec}s${res.window ? ` window ${res.window.join("-")}` : ""} start (${fv(p0)}) end (${fv(pe)})${bodyIds.size ? ` subjectBody ${[...bodyIds].join("; ")}` : ""}`);
  console.log(line("take", res.take));
  if (res.edit) console.log(line("edit", res.edit));
  if (flight) console.log(`   flight ${flight.error ? "ERROR " + flight.error : `${flight.preset}: peak ${flight.maxSpeed} m/s (cap ${flight.vmaxCap}), max tracking gap ${flight.maxTrackingErrorM} m${flight.overrunSec ? `, overrun ${flight.overrunSec}s` : ""}`}`);
  if (verbose) for (const r of rows) console.log(`     t=${r.t} pos=(${r.pos.join(",")}) agl=${r.agl} h=${r.h} p=${r.pitch} fov=${r.fov} v=${r.v} subj=${r.subjDist}m ndc=${JSON.stringify(r.ndc)} los=${r.los} near=${r.near}${r.focus ? " focus=" + r.focus : ""}`);
}
