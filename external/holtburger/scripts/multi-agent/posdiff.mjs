// Pure positional diff, shared by posweep.mjs and tests.
// exp:  [[modelId, wx, wy, z], ...]            (DAT LandblockInfo world positions)
// rend: [{m:modelId, p:[x,y,z]}, ...]          (placements.walk rendered positions)
//
// Matching is 1:1 nearest-3D *within each modelId group*. This is the key fix
// over v1's XY-only nearest with no 1:1 removal: stacked same-model objects
// (e.g. repeated pillars/floors of a building) pair with their true-Z partner,
// so they no longer produce false ROOF/MISPLACED. A pair within 2m (3D) is a
// match; rendered >4m above expected is roof; otherwise misplaced; an expected
// with no rendered partner is not-rendered.
export function diffObjects(exp, rend) {
  const g = new Map();
  const grp = (m) => { let v = g.get(m); if (!v) g.set(m, (v = { e: [], r: [] })); return v; };
  for (const [mid, ex, ey, ez] of exp) grp(mid >>> 0).e.push({ ex, ey, ez });
  for (const o of rend) { if (!Array.isArray(o.p)) continue; grp(o.m >>> 0).r.push({ x: o.p[0], y: o.p[1], z: o.p[2] }); }
  let matched = 0, nr = 0; const roof = [], moved = [];
  for (const [m, { e, r }] of g) {
    if (!e.length) continue;                 // rendered-only (phantom) — out of scope here
    if (!r.length) { nr += e.length; continue; }
    const pairs = [];
    for (const ee of e) for (const rr of r) pairs.push([(rr.x - ee.ex) ** 2 + (rr.y - ee.ey) ** 2 + (rr.z - ee.ez) ** 2, ee, rr]);
    pairs.sort((a, b) => a[0] - b[0]);
    const eu = new Set(), ru = new Set();
    for (const [d2, ee, rr] of pairs) {
      if (eu.has(ee) || ru.has(rr)) continue; eu.add(ee); ru.add(rr);
      const xy = Math.hypot(rr.x - ee.ex, rr.y - ee.ey), dz = rr.z - ee.ez, dist = Math.sqrt(d2);
      if (dist <= 2) matched++;
      else if (dz > 4) roof.push(["0x" + m.toString(16), +ee.ez.toFixed(1), +rr.z.toFixed(1)]);
      else moved.push(["0x" + m.toString(16), +xy.toFixed(1), +dz.toFixed(1)]);
    }
    for (const ee of e) if (!eu.has(ee)) nr++;
  }
  return { matched, nr, roof, moved };
}
