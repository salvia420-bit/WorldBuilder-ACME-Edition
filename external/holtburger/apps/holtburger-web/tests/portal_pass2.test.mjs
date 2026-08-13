// tests/portal_pass2.test.mjs — LANE D, `?portalPass2` (default OFF).
//
// Guards the four properties the gate has to have to be landable:
//   1. it is OFF unless explicitly `=on`/`=1` (the `!== "off"` footgun);
//   2. it is a strict SUBSET of its input — it can never add or mutate an
//      aperture, so it cannot make a visible interior appear where none was;
//   3. it groups per BUILDING and orders those groups BACK-TO-FRONT, which is
//      the observable output of retail's per-building BSP portal walk
//      (`BSPNODE::build_draw_portals_only`, acclient.c:364428-364520);
//   4. it fails OPEN — a malformed stream returns the input untouched, never a
//      truncated punch set (a truncated set = interiors vanish, the 2026-08-12
//      regression shape).

import assert from "node:assert/strict";
import {
  readPortalPass2Flag,
  parseApertures,
  encodeApertures,
  groupAperturesByBuilding,
  orderGroupsBackToFront,
  portalPass2Filter,
  BUILDING_GROUP_RADIUS_M,
} from "../scene3d/portal_pass2.js";

let n = 0;
function t(name, fn) {
  fn();
  n++;
  console.log("  ok ", name);
}

console.log("portal_pass2 (?portalPass2, default OFF)");

// --- 1. flag ---------------------------------------------------------------
t("absent parses false (default-off)", () => {
  assert.equal(readPortalPass2Flag("?foo=1"), false);
});
t("empty search parses false", () => {
  assert.equal(readPortalPass2Flag(""), false);
});
t("bare ?portalPass2 (no value) parses false", () => {
  assert.equal(readPortalPass2Flag("?portalPass2"), false);
});
t("=off parses false", () => {
  assert.equal(readPortalPass2Flag("?portalPass2=off"), false);
});
t("=true does NOT arm (only on/1 do)", () => {
  assert.equal(readPortalPass2Flag("?portalPass2=true"), false);
});
t("=on and =1 arm", () => {
  assert.equal(readPortalPass2Flag("?portalPass2=on"), true);
  assert.equal(readPortalPass2Flag("?portalPass2=ON"), true);
  assert.equal(readPortalPass2Flag("?portalPass2=1"), true);
});
t("no-arg, no window → false, never throws", () => {
  assert.equal(readPortalPass2Flag(null), false);
});

// --- fixtures --------------------------------------------------------------
// A v3 aperture: [nverts, cx,cy,cz, side, x0,y0,z0, ...]. AC space is Z-up.
function ap(cx, cy, cz, side, quad) {
  return [4, cx, cy, cz, side ? 1 : 0, ...quad];
}
// A vertical quad in the plane y = cy, spanning x∈[cx-1,cx+1], z∈[0,2].
function doorQuad(cx, cy) {
  return [cx - 1, cy, 0, cx + 1, cy, 0, cx + 1, cy, 2, cx - 1, cy, 2];
}
function stream(...aps) {
  const out = [aps.length];
  for (const a of aps) out.push(...a);
  return out;
}
const V3 = { withCellCenter: true, withPortalSide: true };

// --- 2. parse / encode round-trip ------------------------------------------
t("parse reads the v3 shape and encode round-trips it byte-for-byte", () => {
  const s = stream(ap(0, 0, 1, true, doorQuad(0, 0)), ap(60, 0, 1, false, doorQuad(60, 0)));
  const parsed = parseApertures(s, V3);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].nverts, 4);
  assert.equal(parsed[0].portalSide, true);
  assert.equal(parsed[1].portalSide, false);
  assert.deepEqual(encodeApertures(s, parsed), s);
});

t("parse of a TRUNCATED stream stops short (never reads past the end)", () => {
  const s = stream(ap(0, 0, 1, true, doorQuad(0, 0)));
  s.push(4, 1, 1, 1); // a second record header with no body
  s[0] = 2;
  const parsed = parseApertures(s, V3);
  assert.equal(parsed.length, 1);
});

// --- 3. grouping + ordering ------------------------------------------------
t("two far-apart cells become two buildings; two near cells become one", () => {
  const s = stream(
    ap(0, 0, 1, true, doorQuad(0, 0)),
    ap(4, 0, 1, true, doorQuad(4, 0)),
    ap(200, 0, 1, true, doorQuad(200, 0)),
  );
  const groups = groupAperturesByBuilding(parseApertures(s, V3), {});
  assert.equal(groups.length, 2);
  const sizes = groups.map((g) => g.apertures.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

t("grouping is transitive along a long building", () => {
  const step = BUILDING_GROUP_RADIUS_M - 1;
  const s = stream(
    ap(0, 0, 1, true, doorQuad(0, 0)),
    ap(step, 0, 1, true, doorQuad(step, 0)),
    ap(2 * step, 0, 1, true, doorQuad(2 * step, 0)),
  );
  const groups = groupAperturesByBuilding(parseApertures(s, V3), {});
  assert.equal(groups.length, 1);
});

t("groups come out BACK-TO-FRONT (farthest first), as retail's BSP walk does", () => {
  const s = stream(
    ap(0, 0, 1, true, doorQuad(0, 0)),
    ap(200, 0, 1, true, doorQuad(200, 0)),
  );
  const groups = orderGroupsBackToFront(
    groupAperturesByBuilding(parseApertures(s, V3), {}),
    { x: 0, y: 0, z: 1 },
  );
  assert.equal(groups.length, 2);
  assert.ok(groups[0].dist > groups[1].dist, "farthest group must be drawn first");
  assert.deepEqual(groups.map((g) => g.order), [0, 1]);
});

// --- 4. the filter ---------------------------------------------------------
t("output is always a SUBSET of the input (never adds, never mutates)", () => {
  const s = stream(
    ap(0, 0, 1, true, doorQuad(0, 0)),
    ap(200, 0, 1, false, doorQuad(200, 0)),
  );
  const before = s.slice();
  const { flat, diag } = portalPass2Filter(s, null, {
    ...V3,
    camAc: { x: 0, y: -30, z: 1 },
  });
  assert.deepEqual(s, before, "input stream must not be mutated");
  assert.ok((flat[0] | 0) <= (s[0] | 0), "kept must never exceed offered");
  assert.equal(diag.kept, flat[0] | 0);
  assert.equal(diag.offered, 2);
  // every kept record must appear verbatim in the input
  const parsedOut = parseApertures(flat, V3);
  const inTxt = JSON.stringify(before);
  for (const a of parsedOut) {
    assert.ok(inTxt.includes(JSON.stringify(a.pts).slice(1, -1)), "kept aperture is verbatim");
  }
});

t("sidedness seed drops the far-side door (retail ConstructView :462513)", () => {
  // Camera at y = -30 (outside, on the -y side). `portal_side` names the
  // room's INTERIOR side; one door faces the camera, the other faces away.
  const s = stream(
    ap(0, 0, 1, true, doorQuad(0, 0)),
    ap(0, 0, 1, false, doorQuad(0, 0)),
  );
  const { diag } = portalPass2Filter(s, null, { ...V3, camAc: { x: 0, y: -30, z: 1 } });
  assert.equal(diag.gates.sidedness, true);
  assert.equal(diag.dropped.sidedness + diag.kept, 2);
  assert.ok(diag.dropped.sidedness >= 1, "at least one facing must be rejected");
});

t("per-building diag reports offered/kept per group, in draw order", () => {
  const s = stream(
    ap(0, 0, 1, true, doorQuad(0, 0)),
    ap(4, 0, 1, true, doorQuad(4, 0)),
    ap(200, 0, 1, true, doorQuad(200, 0)),
  );
  const { diag } = portalPass2Filter(s, null, { ...V3, camAc: { x: 0, y: -30, z: 1 } });
  assert.ok(Array.isArray(diag.groups));
  assert.deepEqual(diag.groups.map((g) => g.order), diag.groups.map((_, i) => i));
  for (const g of diag.groups) {
    assert.equal(typeof g.offered, "number");
    assert.equal(typeof g.kept, "number");
    assert.ok(g.kept <= g.offered);
  }
  assert.equal(
    diag.groups.reduce((a, g) => a + g.kept, 0),
    diag.kept,
  );
});

t("NO Z-wipe is claimed: retail's Clear(4,…,1.0) is the INDOOR branch only", () => {
  const s = stream(ap(0, 0, 1, true, doorQuad(0, 0)));
  const { diag } = portalPass2Filter(s, null, { ...V3, camAc: { x: 0, y: -30, z: 1 } });
  // acclient.c:461483-461487 sits inside `if (this->outside_view.view_count)`,
  // which the outdoor entry (DrawPortal → DrawCells(this, 1)) never populates.
  assert.equal(diag.gates.zWipe, false);
});

t("nearer building occludes a farther aperture fully behind its screen span", () => {
  // Identity MVP → screen (ndc) coords are just AC x,y. Camera sits far away on
  // -z so the group distances separate cleanly.
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  // FAR building: a small door, screen rect x∈[-0.1,0.1].
  const far = [4, 0, 0, 900, 1,  -0.1,-0.05,900,  0.1,-0.05,900,  0.1,0.05,900,  -0.1,0.05,900];
  // NEAR building: a wide facade-spanning aperture that contains it on screen.
  const near = [4, 0, 0, 10, 1,  -0.8,-0.8,10,  0.8,-0.8,10,  0.8,0.8,10,  -0.8,0.8,10];
  const s = [2, ...far, ...near];
  const on = portalPass2Filter(s, I, { ...V3, camAc: null });
  assert.equal(on.diag.dropped.occluded, 1, "the far door is behind the near span");
  assert.equal(on.diag.kept, 1);
  // and the gate is switchable off without touching anything else
  const off = portalPass2Filter(s, I, { ...V3, camAc: null, occluder: false });
  assert.equal(off.diag.kept, 2);
  assert.equal(off.diag.gates.occluder, false);
});

t("fails OPEN: empty and malformed streams return the input untouched", () => {
  const empty = [0];
  const r1 = portalPass2Filter(empty, null, V3);
  assert.equal(r1.flat, empty);
  assert.equal(r1.diag.reason, "no-apertures");

  const bad = [3, 4, 0, 0, 1, 1]; // count 3, one truncated record
  const r2 = portalPass2Filter(bad, null, { ...V3, camAc: { x: 0, y: -1, z: 0 } });
  assert.equal(r2.flat, bad, "malformed input is handed straight back");
  assert.equal(r2.diag.reason, "parse-shape-mismatch");

  const r3 = portalPass2Filter(null, null, V3);
  assert.equal(r3.flat, null);
});

t("no camera → no sidedness gate, and the stream survives intact", () => {
  const s = stream(
    ap(0, 0, 1, true, doorQuad(0, 0)),
    ap(200, 0, 1, false, doorQuad(200, 0)),
  );
  const { flat, diag } = portalPass2Filter(s, null, { ...V3, camAc: null });
  assert.equal(diag.gates.sidedness, false);
  assert.equal(flat[0] | 0, 2);
});

console.log(`\nportal_pass2: ${n} passed, 0 failed`);
