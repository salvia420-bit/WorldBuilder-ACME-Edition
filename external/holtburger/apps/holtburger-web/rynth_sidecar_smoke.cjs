#!/usr/bin/env node
// Sidecar smoke (node-only, NO browser): exercises the RynthNav sidecar
// (:8767, apps/rynthnav-sidecar) HTTP contract directly — GET /health,
// POST /route for a Holtburg-region on-foot hop, leg sanity (finite fields,
// landblock-local 0..192, monotonic world-frame progress toward the goal),
// and CORS headers (the in-page GlobalRouter fetches cross-origin).
// No ACE account is used; safe to run any time the sidecar is up.

const EP = "http://127.0.0.1:8767";

// Contract frame math (RynthNavPlugin.cs:128-130,295-296,585-586,707).
const worldXY = (lb, x, y) => [((lb >>> 24) & 0xff) * 192 + x, ((lb >>> 16) & 0xff) * 192 + y];
const degFromWorld = (w) => (w / 24 - 1019.5) / 10;

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails += 1;
};

(async () => {
  // ── /health ────────────────────────────────────────────────────────
  let hr, health;
  try {
    hr = await fetch(`${EP}/health`);
    health = await hr.json();
  } catch (e) {
    console.log("FAIL: sidecar not running — see apps/rynthnav-sidecar/README");
    process.exit(1);
  }
  console.log(`health: ${JSON.stringify(health)}`);
  check("health ok:true", health.ok === true);
  check("health portals=817", health.portals === 817, `portals=${health.portals}`);
  check("health tiles>0", Number(health.tiles) > 0, `tiles=${health.tiles}`);
  check("health CORS header", !!hr.headers.get("access-control-allow-origin"));

  // ── /route: Holtburg-region from, {ns,ew} goal ~1.5 landblocks away ─
  const from = { lb: 0xa9b40019 >>> 0, x: 84, y: 66, z: 18 };
  const [fwx, fwy] = worldXY(from.lb, from.x, from.y);
  const [gwx, gwy] = [fwx + 200, fwy + 200]; // ~283m diagonal (~1.5 lbs)
  const to = { ns: degFromWorld(gwy), ew: degFromWorld(gwx) };
  console.log(`route: from lb=0x${from.lb.toString(16)} (${from.x},${from.y}) -> ns=${to.ns.toFixed(3)} ew=${to.ew.toFixed(3)}`);

  let rr, res;
  try {
    rr = await fetch(`${EP}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    res = await rr.json();
  } catch (e) {
    console.log(`FAIL: /route unreachable/unparseable (${e.message})`);
    process.exit(1);
  }
  check("route CORS header", !!rr.headers.get("access-control-allow-origin"));
  check("route ok:true", res.ok === true, res.ok !== true ? `error=${res.error}` : "");
  const legs = Array.isArray(res.legs) ? res.legs : [];
  check("legs.length>0", legs.length > 0, `legs=${legs.length}`);
  console.log(
    `plan: ${legs.length} legs, estUnits=${res.estUnits}, portalsUsed=${res.portalsUsed}, coverage=${res.coverage}, stitchedLegs=${res.stitchedLegs}, partial=${res.partial}`
  );

  // ── contract v2: per-leg stitch flag + top-level stitchedLegs/partial ────
  check("every leg has boolean stitch", legs.every((l) => typeof l.stitch === "boolean"));
  const stitched = legs.filter((l) => l.stitch === true).length;
  check("top-level stitchedLegs is a number", typeof res.stitchedLegs === "number", `got ${typeof res.stitchedLegs}`);
  check("stitchedLegs matches per-leg count", res.stitchedLegs === stitched, `top=${res.stitchedLegs} legs=${stitched}`);
  check("top-level partial is a boolean", typeof res.partial === "boolean", `got ${typeof res.partial}`);
  // Coverage/stitch consistency: any stitch => at least "mixed"; a clean "detour" is stitch-free.
  if (res.coverage === "detour") {
    check("coverage detour => 0 stitches, not partial", stitched === 0 && res.partial === false, `stitches=${stitched} partial=${res.partial}`);
  } else {
    check("non-detour coverage => stitchedLegs>0 || partial", stitched > 0 || res.partial === true, `cov=${res.coverage} stitches=${stitched} partial=${res.partial}`);
  }

  // Per-leg sanity: finite fields, landblock-local x,y in [0,192).
  let sane = true;
  for (const [i, l] of legs.entries()) {
    const finite =
      Number.isFinite(l.lb) && Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.z);
    const local = l.x >= 0 && l.x < 192 && l.y >= 0 && l.y < 192;
    if (!finite || !local) {
      sane = false;
      console.log(`  leg ${i}: ${JSON.stringify(l)}`);
    }
  }
  check("every leg finite + 0<=x,y<192", sane);

  // Monotonic world-frame progress toward the goal (allow <=5m regressions
  // for string-pull corners).
  let mono = true;
  let prevD = Math.hypot(fwx - gwx, fwy - gwy);
  for (const [i, l] of legs.entries()) {
    const [wx, wy] = worldXY(l.lb >>> 0, l.x, l.y);
    const d = Math.hypot(wx - gwx, wy - gwy);
    if (d > prevD + 5) {
      mono = false;
      console.log(`  leg ${i}: dist-to-goal ${d.toFixed(1)}m > prev ${prevD.toFixed(1)}m + 5`);
    }
    prevD = d;
  }
  check("legs progress monotonically (<=5m regressions)", mono, `final dist=${prevD.toFixed(1)}m`);

  const pass = fails === 0;
  console.log(`SIDECAR: ${pass ? "PASS" : `FAIL (${fails} checks)`}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error(`ERR ${e.message}`);
  process.exit(1);
});
