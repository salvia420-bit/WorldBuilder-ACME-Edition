// vehicle-armament.eval.js — pilot page: the Hellcat's armament end to end (HBV1 v2, 2026-11-02).
// Boards the parked vehicle (checks the composite airframe replaced the stand-in), takes off away from the target,
// climbs to ~130 m AGL, fires the six crossbows for 1.5 s (quarrels counted), ripples the six lightning rails (spell
// projectiles), turns back and bombs the target creature on the pipper (the 2,000 lb, then the two 1,000 lb), waits for
// the explosions, lands, waits for the rearm on the ground, exits.
// window.__vehicleRun: {outM: 650, aglM: 130, maxSec: 420}; window.__vehiclePrev.target from vehicle-m2-setup.eval.js.
const R = window.__vehicleRun || {};
const V = window.__vehicles, W = window, L = window.liveScene3d, h = window.__sessionHandle;
const out = { ok: false, phases: [] };
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
const mark = (name, extra = {}) => out.phases.push({ name, t: r1(tSec()), ...extra });
const tgt0 = window.__vehiclePrev?.target ?? null;
if (!tgt0) return { ...out, fatal: "no target (run vehicle-m2-setup.eval.js first)" };
const tpos = () => { const i = em.entityMap.get(tgt0.guid >>> 0); return i ? i.root.position : { x: tgt0.x, y: tgt0.y, z: tgt0.z }; };
const tname = tgt0.name || "Drudge Skulker";
const corpses = () => [...em.entityMap.values()].filter((i) => (i.meta?.name ?? "") === `Corpse of ${tname}`).length;
const corpses0 = corpses();

// board
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
const vid = V.status().pilot.vehicle;
const vrec = () => V.vehicles().find((v) => v.guid === vid);
const prof = vrec()?.profile;
out.profile = { parts: prof?.parts?.length ?? 0, partRoles: prof?.partRoles?.length ?? 0, weapons: (prof?.weapons || []).map((w) => w.kind).join(""),
  weaponExt: prof?.weaponExt?.length ?? 0, seat: prof?.seats?.[0]?.offset ?? null };
for (let i = 0; i < 40 && V.status().vehicles.find((v) => v.guid === vid)?.airframe !== "ready"; i++) await sleep(250);
const vs = V.status().vehicles.find((v) => v.guid === vid);
out.airframe = { status: vs?.airframe, standInHidden: vs?.standInHidden, stats: V.status().airframes };
mark("boarded", { ammo: vs?.ammo, missileMask: vs?.missileMask, bombMask: vs?.bombMask });

const st = () => V.status().pilot?.state ?? null;
const agl = (s) => { const g = ground(s.x, s.y); return g == null ? null : s.z - g; };
const ev = (kind) => V.events().filter((e) => e.kind === kind);
const ev0 = { rel: ev(9).length, exp: ev(10).length, rearm: ev(11).length };
let phase = "takeoff", outHdg = null, gunsT = null, railsT = null, bombIdx = 0, pressT = null, ammoBefore = null, lastBombT = -1e9;
const aglWant = R.aglM ?? 130;
while (tSec() < (R.maxSec ?? 420)) {
  const s = st();
  if (!s) { if (!V.piloting) break; await sleep(100); continue; }
  const tp = tpos();
  const dx = tp.x - s.x, dy = tp.y - s.y, dH = Math.hypot(dx, dy), bearing = Math.atan2(dx, dy);
  const a = agl(s);
  // hold the altitude band with the pitch stick
  const holdPitch = a == null ? 0 : clamp((aglWant - a) / 60, -0.5, 0.6);
  let k = { throttle: 0.75, pitch: holdPitch, roll: 0, yaw: 0, fire: false, missile: false, bomb: false };
  if (phase === "takeoff") {
    k.throttle = 1; k.pitch = 0;
    if (s.mode === 2) { phase = "out"; outHdg = bearing + Math.PI; mark("airborne"); }
  } else if (phase === "out") {
    k.roll = clamp(angleDiff(outHdg, s.heading) * 2.5, -1, 1);
    if (a != null && a > aglWant - 25 && gunsT === null) { gunsT = tSec(); ammoBefore = vrec()?.last?.ammo; mark("guns", { ammo: ammoBefore }); }
    if (gunsT !== null && tSec() - gunsT < 1.5) k.fire = true;
    if (gunsT !== null && tSec() - gunsT >= 2.0 && railsT === null) { railsT = tSec(); mark("rails", { ammoAfterGuns: vrec()?.last?.ammo, quarrels: V.status().weapons.quarrels }); }
    if (railsT !== null && tSec() - railsT < 2.2) k.missile = true;
    if (railsT !== null && tSec() - railsT > 3 && dH > (R.outM ?? 650)) { phase = "in"; mark("turn-in", { missileMask: vrec()?.last?.missileMask, flashes: V.status().weapons.flashes }); }
  } else if (phase === "in") {
    const eH = angleDiff(bearing, s.heading);
    k.roll = clamp(eH * 3.0, -1, 1);
    k.yaw = clamp(eH * 4.0, -1, 1);
    const pp = V.pipper();
    if (pp) {
      // release when the pipper reaches the target along the track (or within 12 m of it)
      const along = (tp.x - pp.x) * Math.sin(s.heading) + (tp.y - pp.y) * Math.cos(s.heading);
      const miss = Math.hypot(tp.x - pp.x, tp.y - pp.y);
      if (Math.abs(eH) < 8 * DEG && (miss < 12 || along < 0) && bombIdx < 3 && tSec() - lastBombT > 0.6) {
        pressT = tSec(); lastBombT = tSec(); bombIdx++;
        mark("bomb", { n: bombIdx, miss: r1(miss), along: r1(along), agl: r1(a), speed: r1(s.speed), tImpact: r1(pp.t), pipper: [r1(pp.x), r1(pp.y), r1(pp.z)] });
      }
    }
    if (pressT !== null && tSec() - pressT < 0.2) k.bomb = true;
    if (bombIdx >= 3 && tSec() - lastBombT > 1) { phase = "after"; mark("bombs away"); }
    if (Math.abs(eH) < 60 * DEG && dH < 150 && bombIdx === 0) { // overshot without a solution: go around
      phase = "out"; outHdg = s.heading; railsT = -1e9; mark("go-around");
    }
  } else if (phase === "after") {
    k.roll = 0;
    if (ev(10).length - ev0.exp >= 3 || tSec() - lastBombT > 25) { phase = "land"; mark("explosions", { n: ev(10).length - ev0.exp, fx: V.status().weapons }); }
  } else if (phase === "land") {
    k = { throttle: 0, land: true, pitch: 0, roll: 0, yaw: 0 };
    if (s.mode === 0) { phase = "rearm"; mark("parked"); }
  } else if (phase === "rearm") {
    k = { throttle: 0, pitch: 0, roll: 0, yaw: 0 };
    if (ev(11).length > ev0.rearm) {
      await sleep(400); // the next state carries the full masks
      const l = vrec()?.last; mark("rearmed", { ammo: l?.ammo, missileMask: l?.missileMask, bombMask: l?.bombMask }); break;
    }
    if (tSec() - out.phases.find((p) => p.name === "parked").t > 15) { mark("no rearm"); break; }
  }
  V.setSticks(k, 2000);
  await sleep(33);
}
V.clearSticks();
const fx = V.status().weapons;
out.weapons = fx;
out.events = { releases: ev(9).length - ev0.rel, explosions: ev(10).length - ev0.exp, rearms: ev(11).length - ev0.rearm };
out.killed = corpses() > corpses0 || !em.entityMap.get(tgt0.guid >>> 0);
out.explosionsAt = ev(10).slice(-3).map((e) => ({ value: e.value, aux: e.aux, d: r1(Math.hypot(((e.cell >>> 24) & 0xff) * 192 + e.x - tpos().x, ((e.cell >>> 16) & 0xff) * 192 + e.y - tpos().y)) }));
// the pipper's solution at each press vs where the server's bomb burst (independent of the target's motion); the press
// reaches the server 1-3 steps later, so the burst is expected that much further along the track
{
  const bombs = out.phases.filter((p) => p.name === "bomb");
  const exps = ev(10).slice(-3);
  out.pipperError = bombs.map((b, i) => {
    const e = exps[i]; if (!e || !b.pipper) return null;
    const ex = ((e.cell >>> 24) & 0xff) * 192 + e.x, ey = ((e.cell >>> 16) & 0xff) * 192 + e.y;
    return { n: b.n, lb: e.value, err: r1(Math.hypot(ex - b.pipper[0], ey - b.pipper[1])), dz: r1(e.z - b.pipper[2]) };
  });
}
await sleep(500);
V.exit(0);
await sleep(2500);
out.exited = !V.piloting;
out.ok = true;
out.carry = window.__vehiclePrev ?? null;
out.summary = { airframe: out.airframe.status, standInHidden: out.airframe.standInHidden, quarrels: fx.quarrels, salvos: fx.salvos,
  releases: out.events.releases, explosions: out.events.explosions, rearmed: out.events.rearms > 0, killed: out.killed, exited: out.exited,
  pipperErrM: (out.pipperError || []).map((p) => p && p.err),
  phases: out.phases.map((p) => p.name).join(">") };
return out;
