// test_fixed_grid.mjs — S15b (2026-07-11) ?fixedGrid player-centered TERRAIN
// slot-grid residency acceptance gate
// (docs/PLAN-fixed-slot-grid-residency-2026-07-11.md §2, §4.4).
//
// Imports scene3d/fixed_grid.js's pure FixedSlotGrid / computeBlockKeys /
// diffResidency directly as ESM and drives them with injected spy deps (the
// world_stream.js / terrain_ring.js dependency-injection test style) — no
// browser, no build, no `three`, no wasm.
//
// Covers:
//   1. W sizing from radius (W = 2·radius+1; FIXED_GRID_TERRAIN_RADIUS == 1).
//   2. seed (first observation) — fetch whole block, no release, resident==block.
//   3. no-move (delta 0) — no fetch, no release, moved:false.
//   4. shift in all 8 directions — exact incoming (fetch) + vacated (release)
//      edge key sets, computed INDEPENDENTLY of the grid's own geometry.
//   5. interior-untouched invariant — interior keys (block∩oldBlock) appear in
//      NEITHER the fetch nor the release set (spy).
//   6. multi-LB deltas ≤ W with overlap (dx=2, and the (2,2) corner) — exact
//      edge sets; interior still untouched.
//   7. teleport (|delta| ≥ W) — whole-grid invalidate: fetch the whole new
//      block, releaseEdge NEVER called (today's behavior exactly).
//   8. map-edge clamp — a 0xffff corner seed batches only the in-range LBs.
//   9. flag parsing truth table (S16 flip: absent + non-off → ON; only the
//      exact off-spellings off/0/false → OFF) — locks the DEFAULT-ON off-escape
//      reader contract (mirrors FIXED_GRID_ENABLED / FIXED_GRID_PARK_ENABLED).
//  10. diffResidency + assertResidency — sync → silent; forced divergence
//      (unbacked / untracked / offBlock) → warns with the diff; in-flight edge
//      LB is NOT mis-flagged as an over-claim.
//
// Run: node test_fixed_grid.mjs   (no browser, no build)

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const { FixedSlotGrid, computeBlockKeys, diffResidency, FIXED_GRID_TERRAIN_RADIUS } =
  await import("./scene3d/fixed_grid.js");

const lbKeyFromXY = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;

// Independent expected-key builder: keys at an explicit list of [x,y] coords
// (no computeBlockKeys — so the assertions can't tautologically agree with the
// grid's own geometry).
const keysAt = (coords) => new Set(coords.map(([x, y]) => lbKeyFromXY(x, y)));
const sameSet = (a, b) =>
  a.size === b.size && [...a].every((k) => b.has(k));
const asKeySet = (arr) => new Set(arr.map((k) => k >>> 0));

function makeGrid({ radius = 1 } = {}) {
  const fetchCalls = []; // [Set<key>, cx, cy]
  const releaseCalls = []; // [Set<key>]
  const warns = []; // [msg, detail]
  const grid = new FixedSlotGrid({
    radius,
    lbKeyFromXY,
    fetchEdge: (keys, cx, cy) => fetchCalls.push([new Set(keys), cx, cy]),
    releaseEdge: (keys) => releaseCalls.push([new Set(keys)]),
    warn: (m, d) => warns.push([m, d]),
  });
  return { grid, fetchCalls, releaseCalls, warns };
}

// ---------------------------------------------------------------------
// 1 — W sizing from radius
// ---------------------------------------------------------------------
{
  check("(1) FIXED_GRID_TERRAIN_RADIUS is 1 (the loadTerrainRing 3×3 radius)",
    FIXED_GRID_TERRAIN_RADIUS === 1);
  check("(1) radius 1 → width 3", makeGrid({ radius: 1 }).grid.width === 3);
  check("(1) radius 5 → width 11", makeGrid({ radius: 5 }).grid.width === 11);
  check("(1) radius clamped to ≥1 (0 → 1 → width 3)",
    new FixedSlotGrid({ radius: 0, lbKeyFromXY }).width === 3);
}

// ---------------------------------------------------------------------
// 2 — seed (first observation)
// ---------------------------------------------------------------------
{
  const { grid, fetchCalls, releaseCalls } = makeGrid();
  const CX = 0x80;
  const CY = 0x80;
  const res = grid.update(CX, CY);
  const expectBlock = keysAt([
    [CX - 1, CY - 1], [CX, CY - 1], [CX + 1, CY - 1],
    [CX - 1, CY], [CX, CY], [CX + 1, CY],
    [CX - 1, CY + 1], [CX, CY + 1], [CX + 1, CY + 1],
  ]);
  check("(2) seed → moved+seed flags set", res.moved === true && res.seed === true);
  check("(2) seed → exactly ONE fetch call, zero release calls",
    fetchCalls.length === 1 && releaseCalls.length === 0);
  check("(2) seed → fetch carried the whole 3×3 block",
    sameSet(fetchCalls[0][0], expectBlock));
  check("(2) seed → resident record == the block",
    sameSet(grid.residentKeys, expectBlock));
  check("(2) seed → fetch centre coords forwarded",
    fetchCalls[0][1] === CX && fetchCalls[0][2] === CY);
}

// ---------------------------------------------------------------------
// 3 — no-move (steady state = ZERO terrain work)
// ---------------------------------------------------------------------
{
  const { grid, fetchCalls, releaseCalls } = makeGrid();
  grid.update(0x80, 0x80); // seed (1 fetch)
  const res = grid.update(0x80, 0x80); // same LB
  check("(3) no-move → moved:false", res.moved === false);
  check("(3) no-move → NO extra fetch (still 1), NO release",
    fetchCalls.length === 1 && releaseCalls.length === 0);
}

// ---------------------------------------------------------------------
// 4 + 5 — shift in all 8 directions, exact edge sets + interior untouched
// ---------------------------------------------------------------------
{
  const CX = 0x80;
  const CY = 0x80;
  // For a unit shift by (sx,sy) from a 3×3, the incoming edge is the new
  // block's cells whose (dx,dy) offset was OUT of the old [-1,1]² and the
  // vacated edge is the old block's cells now out of the new block. Enumerate
  // both independently.
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, -1], [1, -1], [-1, 1],
  ];
  let allOk = true;
  let interiorOk = true;
  const detail = [];
  for (const [sx, sy] of dirs) {
    const { grid, fetchCalls, releaseCalls } = makeGrid();
    grid.update(CX, CY);
    const nCX = CX + sx;
    const nCY = CY + sy;
    const res = grid.update(nCX, nCY);

    // Independent enumeration of new/old block coords.
    const blockCoords = (cx, cy) => {
      const out = [];
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) out.push([cx + dx, cy + dy]);
      return out;
    };
    const oldCoords = blockCoords(CX, CY);
    const newCoords = blockCoords(nCX, nCY);
    const oldSet = keysAt(oldCoords);
    const newSet = keysAt(newCoords);
    const expIncoming = new Set([...newSet].filter((k) => !oldSet.has(k)));
    const expVacated = new Set([...oldSet].filter((k) => !newSet.has(k)));
    const expInterior = new Set([...newSet].filter((k) => oldSet.has(k)));

    // fetchCalls[1] is the shift's incoming fetch (fetchCalls[0] was the seed).
    const gotFetch = fetchCalls[1] ? fetchCalls[1][0] : new Set();
    const gotRelease = releaseCalls[0] ? releaseCalls[0][0] : new Set();
    const okFetch = sameSet(gotFetch, expIncoming);
    const okRelease = sameSet(gotRelease, expVacated);
    const okResIncoming = sameSet(res.incoming, expIncoming);
    const okResVacated = sameSet(res.vacated, expVacated);
    if (!(okFetch && okRelease && okResIncoming && okResVacated)) {
      allOk = false;
      detail.push(`dir(${sx},${sy})`);
    }
    // Interior untouched: no interior key in the fetch OR release set.
    for (const k of expInterior) {
      if (gotFetch.has(k) || gotRelease.has(k)) { interiorOk = false; break; }
    }
    // Resident record is the new block after the shift.
    if (!sameSet(grid.residentKeys, newSet)) { allOk = false; detail.push(`res(${sx},${sy})`); }
  }
  check("(4) all 8 unit shifts → exact incoming(fetch)+vacated(release) edge sets",
    allOk, detail.join(" "));
  check("(5) interior slots untouched — no interior key in any fetch/release set",
    interiorOk);
}

// ---------------------------------------------------------------------
// 6 — multi-LB deltas ≤ W with overlap (dx=2 edge, then (2,2) corner)
// ---------------------------------------------------------------------
{
  const CX = 0x80;
  const CY = 0x80;
  // Shift by (2,0): W=3 blocks overlap on column CX+1. incoming = cols
  // {CX+2,CX+3}, vacated = cols {CX-1,CX}, interior = col CX+1.
  {
    const { grid, fetchCalls, releaseCalls } = makeGrid();
    grid.update(CX, CY);
    const res = grid.update(CX + 2, CY);
    const expIncoming = keysAt([
      [CX + 2, CY - 1], [CX + 2, CY], [CX + 2, CY + 1],
      [CX + 3, CY - 1], [CX + 3, CY], [CX + 3, CY + 1],
    ]);
    const expVacated = keysAt([
      [CX - 1, CY - 1], [CX - 1, CY], [CX - 1, CY + 1],
      [CX, CY - 1], [CX, CY], [CX, CY + 1],
    ]);
    const interior = keysAt([[CX + 1, CY - 1], [CX + 1, CY], [CX + 1, CY + 1]]);
    const gotFetch = fetchCalls[1][0];
    const gotRelease = releaseCalls[0][0];
    check("(6) dx=2 shift → incoming = 2 leading columns (6 keys), exact",
      sameSet(gotFetch, expIncoming) && sameSet(res.incoming, expIncoming));
    check("(6) dx=2 shift → vacated = 2 trailing columns (6 keys), exact",
      sameSet(gotRelease, expVacated) && sameSet(res.vacated, expVacated));
    check("(6) dx=2 shift → NOT a teleport (overlap on col CX+1)",
      res.teleport === false);
    check("(6) dx=2 shift → interior column untouched",
      [...interior].every((k) => !gotFetch.has(k) && !gotRelease.has(k)));
  }
  // Corner shift (2,2): overlap is the single cell (CX+1,CY+1).
  {
    const { grid, fetchCalls, releaseCalls } = makeGrid();
    grid.update(CX, CY);
    const res = grid.update(CX + 2, CY + 2);
    const interiorKey = lbKeyFromXY(CX + 1, CY + 1);
    check("(6) (2,2) corner shift → not a teleport, 8 in / 8 out, 1 interior",
      res.teleport === false && res.incoming.size === 8 && res.vacated.size === 8);
    check("(6) (2,2) corner shift → the single interior cell untouched",
      !fetchCalls[1][0].has(interiorKey) && !releaseCalls[0][0].has(interiorKey));
  }
}

// ---------------------------------------------------------------------
// 7 — teleport (|delta| ≥ W) → whole-grid invalidate, NO release
// ---------------------------------------------------------------------
{
  const CX = 0x40;
  const CY = 0x40;
  for (const [sx, sy, label] of [[3, 0, "dx=3 (exact no-overlap boundary)"], [50, 20, "far jump"]]) {
    const { grid, fetchCalls, releaseCalls } = makeGrid();
    grid.update(CX, CY);
    const nCX = CX + sx;
    const nCY = CY + sy;
    const res = grid.update(nCX, nCY);
    const newBlock = keysAt([
      [nCX - 1, nCY - 1], [nCX, nCY - 1], [nCX + 1, nCY - 1],
      [nCX - 1, nCY], [nCX, nCY], [nCX + 1, nCY],
      [nCX - 1, nCY + 1], [nCX, nCY + 1], [nCX + 1, nCY + 1],
    ]);
    check(`(7) ${label} → teleport flag set`, res.teleport === true);
    check(`(7) ${label} → fetch whole new block`,
      fetchCalls[1] && sameSet(fetchCalls[1][0], newBlock));
    check(`(7) ${label} → releaseEdge NEVER called (today's behavior exactly)`,
      releaseCalls.length === 0);
    check(`(7) ${label} → resident record == new block`,
      sameSet(grid.residentKeys, newBlock));
  }
}

// ---------------------------------------------------------------------
// 8 — map-edge clamp
// ---------------------------------------------------------------------
{
  const { grid, fetchCalls } = makeGrid();
  const res = grid.update(0xff, 0xff);
  const expect = keysAt([
    [0xfe, 0xfe], [0xff, 0xfe],
    [0xfe, 0xff], [0xff, 0xff],
  ]);
  check("(8) 0xFFFF corner seed → block clamps to the 4 in-range LBs",
    sameSet(fetchCalls[0][0], expect) && sameSet(res.incoming, expect));
  check("(8) 0xFFFF corner seed → resident record is the 4-LB clamped block",
    grid.residentKeys.size === 4);
}

// ---------------------------------------------------------------------
// 9 — flag parsing truth table (mirrors FIXED_GRID_ENABLED in index.js)
// ---------------------------------------------------------------------
{
  // S16 flip (2026-07-11): DEFAULT-ON with an off-escape (mirrors
  // FIXED_GRID_PARK_ENABLED). Absent → ON; ONLY the explicit off-spellings
  // (off/0/false) disable; every other value (incl. 1/on/true and unrelated
  // strings) reads ON.
  const readFixedGrid = (v) => v !== "off" && v !== "0" && v !== "false";
  const onVals = [null, "", "1", "on", "true", "yes", "2", "On", "TRUE", "Off", "FALSE"];
  const offVals = ["off", "0", "false"];
  check("(9) absent + explicit on-values + non-off strings → ON",
    onVals.every((v) => readFixedGrid(v) === true));
  check("(9) only the exact off-spellings (off/0/false) → OFF",
    offVals.every((v) => readFixedGrid(v) === false));
}

// ---------------------------------------------------------------------
// 10 — derived-view comparator (diffResidency) + assertResidency warn seam
// ---------------------------------------------------------------------
{
  const block = keysAt([[0x10, 0x10], [0x11, 0x10], [0x10, 0x11]]);
  // Sync: resident == baked == block → silent.
  {
    const d = diffResidency({ resident: new Set(block), baked: new Set(block), inFlight: null, block });
    check("(10) sync (resident==baked==block) → no divergence",
      d.unbacked.length === 0 && d.untracked.length === 0 && d.offBlock.length === 0);
  }
  // Over-claim: resident has an on-block key the bake path lacks → unbacked.
  {
    const baked = keysAt([[0x10, 0x10], [0x11, 0x10]]); // missing 0x10,0x11
    const d = diffResidency({ resident: new Set(block), baked, inFlight: null, block });
    check("(10) over-claim (resident∌baked) → unbacked reports the missing LB",
      d.unbacked.length === 1 && d.unbacked[0] === lbKeyFromXY(0x10, 0x11));
  }
  // In-flight covers the transient: same over-claim, but the LB is in flight.
  {
    const baked = keysAt([[0x10, 0x10], [0x11, 0x10]]);
    const inFlight = keysAt([[0x10, 0x11]]);
    const d = diffResidency({ resident: new Set(block), baked, inFlight, block });
    check("(10) in-flight edge LB is NOT flagged as an over-claim",
      d.unbacked.length === 0);
  }
  // Under-claim: baked in-block but grid doesn't know → untracked.
  {
    const resident = keysAt([[0x10, 0x10], [0x11, 0x10]]);
    const d = diffResidency({ resident, baked: new Set(block), inFlight: null, block });
    check("(10) under-claim (baked∌resident, on-block) → untracked reports it",
      d.untracked.length === 1 && d.untracked[0] === lbKeyFromXY(0x10, 0x11));
  }
  // Off-block resident (stale slot bug) → offBlock.
  {
    const resident = new Set([...block, lbKeyFromXY(0x99, 0x99)]);
    const d = diffResidency({ resident, baked: new Set(block), inFlight: null, block });
    check("(10) off-block resident key → offBlock reports it",
      d.offBlock.length === 1 && d.offBlock[0] === lbKeyFromXY(0x99, 0x99));
  }
  // assertResidency: seeded grid, baked==block → silent; baked empty → warns.
  {
    const { grid, warns } = makeGrid();
    grid.update(0x10, 0x10);
    const bakedFull = new Set(grid.residentKeys);
    grid.assertResidency({ baked: bakedFull, inFlight: null });
    check("(10) assertResidency: grid==baked → NO warn", warns.length === 0);
    grid.assertResidency({ baked: new Set(), inFlight: null });
    check("(10) assertResidency: baked empty → warns loudly with a diff",
      warns.length === 1 &&
      /derived-view divergence/.test(warns[0][0]) &&
      Array.isArray(warns[0][1]?.unbacked) && warns[0][1].unbacked.length > 0);
    // in-flight suppresses the warn (all resident are in flight).
    grid.assertResidency({ baked: new Set(), inFlight: new Set(grid.residentKeys) });
    check("(10) assertResidency: all-in-flight → still silent (no new warn)",
      warns.length === 1);
  }
}

console.log("");
console.log(`S15b fixedGrid: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
