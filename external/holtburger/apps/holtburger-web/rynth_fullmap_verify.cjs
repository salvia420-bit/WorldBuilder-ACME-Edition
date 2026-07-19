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
// on the widened start snap. Returns coverage.
async function localWalk(lbx, lby) {
  const from = objid(lbx, lby, 40, 40);
  const to = objid(lbx + 2, lby + 2, 150, 150);
  const d = await post({ from: { lb: from, x: 40, y: 40, z: 120 }, to: { lb: to, x: 150, y: 150, z: 120 } });
  return d;
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
    const d = await localWalk(lbx, lby);
    const good = d.ok === true && (d.coverage === "detour" || d.coverage === "mixed");
    check(`local walk ${name} (0x${lbx.toString(16)}${lby.toString(16)}) snaps to mesh`, good,
      `ok=${d.ok} coverage=${d.coverage} legs=${(d.legs || []).length}`);
  }

  // LRU stress: alternate far-apart corridors; must not error/degrade.
  let lruOk = true;
  for (let i = 0; i < 4; i++) {
    const a = await localWalk(0xA7, 0xB0);
    const b = await localWalk(0x90, 0x15);
    if (a.ok !== true || b.ok !== true) lruOk = false;
  }
  check("LRU stress: alternating far corridors stay ok", lruOk);

  console.log(`FULLMAP-VERIFY: ${fails === 0 ? "PASS" : `FAIL (${fails})`}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(`ERR ${e.message}`); process.exit(1); });
