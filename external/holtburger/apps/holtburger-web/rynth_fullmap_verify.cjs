#!/usr/bin/env node
// Full-map bake verification (node-only, against a sidecar serving the full-map
// tile dir). Confirms: /health tile count, the frozen Arwic repro is detour|mixed,
// and short intra-region walk routes in 3 FAR-APART map quadrants each snap to the
// baked mesh (coverage detour|mixed, not blind straight). Also exercises LRU by
// hitting far-apart corridors in sequence (tiles stream + evict without error).
//   RYNTHNAV_URL=http://127.0.0.1:8768 node rynth_fullmap_verify.cjs
const EP = process.env.RYNTHNAV_URL || "http://127.0.0.1:8768";

const cell = (x, y) => 1 + ((x / 24) | 0) * 8 + ((y / 24) | 0);
const objid = (lbx, lby, x, y) => (((lbx << 24) | (lby << 16) | cell(x, y)) >>> 0);
let fails = 0;
const check = (n, c, d = "") => { console.log(`  ${c ? "ok  " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); if (!c) fails++; };
async function post(body) {
  const r = await fetch(`${EP}/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
// short 2-LB diagonal walk inside a region, lb-form so no portal graph; z=120 relies
// on the widened start snap. Returns { d, spatialOk } where spatialOk asserts EVERY
// non-portal leg's landblock word sits within 1 LB of the from/to landblock box —
// the check that catches a spatially-offset-but-still-"detour" mesh (a mesh shifted
// N landblocks still yields polys and coverage:"detour", so coverage alone is blind
// to placement errors; this asserts the geometry is where it claims to be).
async function localWalk(lbx, lby) {
  const fromLbx = lbx, fromLby = lby, toLbx = lbx + 2, toLby = lby + 2;
  const from = objid(fromLbx, fromLby, 40, 40);
  const to = objid(toLbx, toLby, 150, 150);
  const d = await post({ from: { lb: from, x: 40, y: 40, z: 120 }, to: { lb: to, x: 150, y: 150, z: 120 } });
  const minX = Math.min(fromLbx, toLbx) - 1, maxX = Math.max(fromLbx, toLbx) + 1;
  const minY = Math.min(fromLby, toLby) - 1, maxY = Math.max(fromLby, toLby) + 1;
  let spatialOk = true, offLeg = null;
  for (const l of d.legs || []) {
    if (l.portal) continue;
    const lx = (l.lb >>> 24) & 0xff, ly = (l.lb >>> 16) & 0xff;
    if (lx < minX || lx > maxX || ly < minY || ly > maxY) {
      spatialOk = false;
      offLeg = `${lx.toString(16)}${ly.toString(16)}`;
      break;
    }
  }
  return { d, spatialOk, offLeg };
}

(async () => {
  console.log(`endpoint: ${EP}`);
  let health;
  try { health = await (await fetch(`${EP}/health`)).json(); }
  catch (e) { console.log(`FAIL: sidecar unreachable at ${EP} (${e.message})`); process.exit(1); }
  console.log(`health: ${JSON.stringify(health)}`);
  check("health ok", health.ok === true);
  check("full-map tile count is large (>5000 on disk)", Number(health.tiles) > 5000, `tiles=${health.tiles}`);

  // Frozen Arwic repro must stay detour|mixed on the full map too.
  const frozen = await post({ from: { lb: 2846408729, x: 84, y: 12, z: 50 }, to: { ns: 33.3, ew: 56.6 } });
  check("frozen Arwic repro detour|mixed", frozen.coverage === "detour" || frozen.coverage === "mixed", `coverage=${frozen.coverage}`);

  // 3 far-apart quadrants — pick landblocks known to carry content.
  // NW Holtburg ~0xA9B4, central Arwic ~0xC6A9, SE toward Qalaba'r/Silyun ~0x9721.
  // Confirmed-present dense anchors (anchor + (+2,+2) walk neighbor both baked).
  const regions = [
    ["NW/Holtburg", 0xA7, 0xB0],
    ["central", 0xC0, 0xA5],
    ["SE", 0x90, 0x15],
  ];
  for (const [name, lbx, lby] of regions) {
    const { d, spatialOk, offLeg } = await localWalk(lbx, lby);
    const good = d.ok === true && (d.coverage === "detour" || d.coverage === "mixed");
    check(`local walk ${name} (0x${lbx.toString(16)}${lby.toString(16)}) snaps to mesh`, good,
      `ok=${d.ok} coverage=${d.coverage} legs=${(d.legs || []).length}`);
    // spatial placement: every leg's landblock within 1 LB of the from/to box
    check(`local walk ${name} legs land in the correct landblock (no offset)`, spatialOk,
      offLeg ? `stray leg at LB ${offLeg}` : "");
  }

  // LRU stress: alternate far-apart corridors; must not error/degrade.
  let lruOk = true;
  for (let i = 0; i < 4; i++) {
    const a = await localWalk(0xA7, 0xB0);
    const b = await localWalk(0x90, 0x15);
    if (a.d.ok !== true || b.d.ok !== true || !a.spatialOk || !b.spatialOk) lruOk = false;
  }
  check("LRU stress: alternating far corridors stay ok", lruOk);

  console.log(`FULLMAP-VERIFY: ${fails === 0 ? "PASS" : `FAIL (${fails})`}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(`ERR ${e.message}`); process.exit(1); });
