// blood_decals.test.mjs — the Phase-6 persistent blood decals (`?blood`).
//
// NEW 2026-08-03. `scene3d/blood_decals.js` (806 lines, DEFAULT-ON since the
// 2026-08-02 owner flip, never eye-tested) had ZERO test coverage — while
// carrying a `/* ── pure math (node-tested) ── */` banner over four exported
// pure functions that no suite had ever imported. Two defects were sitting
// under that banner:
//
//   §3 the arterial ceiling ray was not a rotation at all — it multiplied each
//      component of the spray direction by a DIFFERENT trig function of the
//      same angle, and a `|| 0.1` that binds looser than `*` replaced the Y
//      term outright whenever the spray ran along ±X. Indoor ceiling spatter
//      always landed on the same side of the victim.
//   §5 `indoor` came from `inst._outdoorCellIdx`, a SPAWN-TIME stamp with
//      exactly one writer (entities.js:4551) that nothing refreshes when the
//      creature moves — plus `inst._cellIdx`, which does not exist anywhere in
//      the tree. A mob that spawned in a cottage and died on the lawn read
//      "indoor" forever: no terrain fallback, no statics in the ray targets.
//
// `three` is import-stubbed (the module builds nothing at module scope, and
// nothing exercised here reaches the raycaster or the canvas atlas).
//
// Run: node tests/blood_decals.test.mjs   (from apps/holtburger-web/)

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolvePath(__dirname, "../_three_stub_loader.mjs")).href);

globalThis.window = { location: { search: "" } };

const {
  bloodEnabled,
  makeRayFan,
  stampOrientation,
  ageAlpha,
  resolveIndoor,
  BLOOD_TERRAIN_TRUST_M,
  BLOOD_TTL_S,
  BLOOD_RAYS_HIT,
  BLOOD_RAYS_CRIT,
} = await import("../scene3d/blood_decals.js");

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function section(n) {
  console.log(`\n— ${n}`);
}
const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= eps;
const len3 = (v) => Math.hypot(v[0], v[1], v[2]);

/** Deterministic 0..1 stream so a fan is reproducible. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Rotate v by quaternion q ([x,y,z,w]) — independent of the module's own. */
function rotQ(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/* ── 1. the flag is DEFAULT-ON ────────────────────────────────────────── */
section("flag polarity (url-flags.md:800 — default ON, `!== \"off\"`)");
{
  window.location.search = "";
  ok(bloodEnabled() === true, "an ABSENT ?blood reads ON (owner default-on 2026-08-02)");
  window.location.search = "?blood=off";
  ok(bloodEnabled() === false, "?blood=off is the escape hatch");
  window.location.search = "?blood=1";
  ok(bloodEnabled() === true, "a non-'off' value stays ON (NOT a strict opt-in)");
  window.location.search = "";
}

/* ── 2. the ray fan ───────────────────────────────────────────────────── */
section("makeRayFan — shape");
{
  const outdoor = makeRayFan([1, 0], BLOOD_RAYS_HIT, false, false, seeded(1));
  ok(outdoor.length === BLOOD_RAYS_HIT, `a normal outdoor hit fans ${BLOOD_RAYS_HIT} rays`);
  ok(outdoor.every((r) => near(len3(r), 1, 1e-9)), "every outdoor ray is a UNIT vector");
  ok(outdoor.slice(1).every((r) => r[2] < 0), "rays after the first are pitched DOWN (blood falls)");

  const crit = makeRayFan([1, 0], BLOOD_RAYS_CRIT, false, true, seeded(1));
  ok(crit.length === BLOOD_RAYS_CRIT, `a crit fans ${BLOOD_RAYS_CRIT} rays`);
  // Outdoors there is no ceiling to hit, so no ray may point up hard.
  ok(!crit.some((r) => r[2] > 0.9), "an outdoor crit never adds a ceiling ray");

  const indoorCrit = makeRayFan([1, 0], BLOOD_RAYS_HIT, true, true, seeded(1));
  ok(indoorCrit.length === BLOOD_RAYS_HIT + 1, "an indoor crit adds the arterial ceiling ray");
  ok(indoorCrit.every((r) => near(len3(r), 1, 1e-9)), "every indoor ray is a UNIT vector too");
}

/* ── 3. REGRESSION: the arterial ray follows the SPRAY ────────────────── */
section("arterial ceiling ray (2026-08-03 regression lock)");
{
  const arterialFor = (quad, seed = 7) => {
    const rays = makeRayFan(quad, BLOOD_RAYS_HIT, true, true, seeded(seed));
    return rays[rays.length - 1]; // the ceiling ray is appended last
  };

  // (a) MIRROR INVARIANCE — the sharpest statement of the bug, and seed-free.
  // Two spray directions that are mirror images through the origin must give
  // arterial rays that are mirror images in X and Y. Pre-fix the X term
  // mirrored but the Y term was pinned at the `|| 0.1` constant for BOTH.
  const east = arterialFor([1, 0]);
  const west = arterialFor([-1, 0]);
  ok(near(east[0], -west[0], 1e-12) && near(east[1], -west[1], 1e-12),
    `opposite sprays give opposite leans (E=[${east[0].toFixed(4)},${east[1].toFixed(4)}] ` +
    `W=[${west[0].toFixed(4)},${west[1].toFixed(4)}])`);
  ok(near(east[2], west[2], 1e-12), "…while both keep the same upward component");

  // (b) A spray along +Y must LEAN +Y. Pre-fix `qy * 0.3 * Math.sin(yaw)` is
  // ~0 for a small yaw, so `|| 0.1` fired and the lean was a stub 0.1 — an
  // order of magnitude smaller and unrelated to the quadrant.
  const north = arterialFor([0, 1]);
  ok(north[1] > 0.2, `a +Y spray leans +Y by the full 0.3 (got ${north[1].toFixed(4)})`);
  ok(Math.abs(north[0]) < Math.abs(north[1]), "…and leans less in X than in Y");

  // (c) The lean is a genuine yaw rotation: its horizontal magnitude is the
  // same 0.3 whatever the yaw draw, because a rotation preserves length.
  let sameLen = true;
  for (let s = 1; s <= 40; s++) {
    const r = arterialFor([Math.SQRT1_2, Math.SQRT1_2], s);
    // Normalisation is uniform, so the horizontal:vertical RATIO survives it
    // and must be exactly 0.3 : 0.95 for every yaw a rotation can draw.
    if (!near(Math.hypot(r[0], r[1]) / r[2], 0.3 / 0.95, 1e-9)) sameLen = false;
    if (!near(len3(r), 1, 1e-9)) sameLen = false;
  }
  ok(sameLen, "the horizontal:vertical ratio is rotation-invariant across 40 yaw draws");

  // (d) The degenerate case the old `|| 0.1` was accidentally right about.
  const dead = arterialFor([0, 0]);
  ok(Number.isFinite(dead[0]) && Number.isFinite(dead[1]) && Math.hypot(dead[0], dead[1]) > 0,
    "a zero spray direction still gets a small explicit lean, not a vertical stripe");
  const nan = arterialFor([NaN, NaN]);
  ok(nan.every(Number.isFinite), "a NaN spray direction cannot produce a NaN ray");
}

/* ── 4. decal orientation ─────────────────────────────────────────────── */
section("stampOrientation");
{
  // A wall (normal +X). The streak must run DOWN it: the quad's local +Y —
  // which is increasing v, the direction the canvas art is painted toward —
  // has to end up pointing at world +Z (AC up).
  const wall = stampOrientation([1, 0, 0], 0.3, seeded(3));
  ok(wall.variant === "wall", "a horizontal normal is a wall");
  const up = rotQ(wall.quat, [0, 1, 0]);
  ok(up[2] > 0.99, `the streak's local +Y is aligned with world up (z=${up[2].toFixed(4)})`);
  const face = rotQ(wall.quat, [0, 0, 1]);
  ok(near(face[0], 1, 1e-6), "…and the quad still faces along the surface normal");
  ok(wall.scale[1] > wall.scale[0], "a wall streak is elongated down-slope");

  const floor = stampOrientation([0, 0, 1], 0.3, seeded(3));
  ok(floor.variant === "floor", "an up-facing normal is a floor");
  const ceil = stampOrientation([0, 0, -1], 0.3, seeded(3));
  ok(ceil.variant === "ceiling", "a down-facing normal is a ceiling");
  const ceilFace = rotQ(ceil.quat, [0, 0, 1]);
  ok(ceilFace[2] < -0.99, "the ceiling decal faces straight down");

  // A sloped ground plane gets mild down-slope elongation, a flat one does not.
  const flat = stampOrientation([0, 0, 1], 1, seeded(5));
  const slope = stampOrientation([0.5, 0, 0.866], 1, seeded(5));
  ok(near(flat.scale[0], flat.scale[1]), "a flat floor blot is round");
  ok(slope.scale[1] > slope.scale[0], "a sloped floor blot runs off down-slope");
}

/* ── 5. REGRESSION: `indoor` is a LIVE read, not a spawn stamp ────────── */
section("resolveIndoor (2026-08-03 regression lock)");
{
  const inst = (cellIdx, z) => ({
    _outdoorCellIdx: cellIdx,
    root: { position: { x: 100, y: 200, z } },
  });
  const terrainAt = () => 50; // flat terrain at z = 50

  // The case that was broken: spawned in a cottage (cell >= 0x0100), killed
  // outdoors standing ON the terrain. The stamp says indoor forever.
  ok(resolveIndoor(inst(0x0140, 50.1), terrainAt) === false,
    "a body sitting ON its own terrain column is OUTDOORS, whatever the spawn stamp said");
  // The inverse, which the stamp also gets wrong the other way round.
  ok(resolveIndoor(inst(0x0002, 50 + BLOOD_TERRAIN_TRUST_M + 1), terrainAt) === true,
    "a body metres off its terrain column is INDOORS (dungeon / cottage floor / rooftop)");
  ok(resolveIndoor(inst(0x0002, 50 - 40), terrainAt) === true,
    "…including one far BELOW the terrain (a dungeon under the surface)");

  // Tolerance boundary.
  ok(resolveIndoor(inst(0, 50 + BLOOD_TERRAIN_TRUST_M - 0.01), terrainAt) === false,
    "just inside the trust radius reads outdoor");
  ok(resolveIndoor(inst(0, 50 + BLOOD_TERRAIN_TRUST_M + 0.01), terrainAt) === true,
    "just outside it reads indoor");

  // The stamp survives ONLY as the fallback when the oracle cannot answer.
  ok(resolveIndoor(inst(0x0140, 50), () => null) === true, "no oracle answer ⇒ fall back to the indoor stamp");
  ok(resolveIndoor(inst(0x0002, 50), () => null) === false, "no oracle answer ⇒ fall back to the outdoor stamp");
  ok(resolveIndoor(inst(0x0140, 50), () => NaN) === true, "a NaN height is not an answer");
  ok(resolveIndoor(inst(0x0140, 50), () => { throw new Error("wasm gone"); }) === true,
    "a throwing oracle degrades to the stamp instead of breaking the hit");

  // Missing / malformed instances must never throw on the shared bus.
  ok(resolveIndoor(null, terrainAt) === false, "a null instance is not indoors, and does not throw");
  ok(resolveIndoor({ _outdoorCellIdx: 0x0140 }, terrainAt) === true, "no root ⇒ the stamp answers");
  ok(resolveIndoor(inst(0x0140, NaN), terrainAt) === true, "a NaN position ⇒ the stamp answers");
  // `_cellIdx` does not exist in the tree, but the reader still honours it.
  ok(resolveIndoor({ _cellIdx: 0x0140, root: { position: { x: 0, y: 0, z: NaN } } }, terrainAt) === true,
    "the legacy `_cellIdx` name is still read as a fallback");
}

/* ── 6. ageing ────────────────────────────────────────────────────────── */
section("ageAlpha");
{
  ok(ageAlpha(-1) === 0, "a stain that has not been born yet is invisible");
  ok(near(ageAlpha(0.06), 0.5, 1e-9), "the 0.12 s fade-in is linear");
  ok(ageAlpha(0.12) === 1, "…and reaches full opacity at 0.12 s");
  ok(ageAlpha(100) === 1, "a mature stain sits at full opacity");
  ok(near(ageAlpha(BLOOD_TTL_S - 45), 1), "the fade-out starts 45 s before the TTL");
  ok(near(ageAlpha(BLOOD_TTL_S - 22.5), 0.5), "…and is linear across those 45 s");
  ok(ageAlpha(BLOOD_TTL_S) === 0, "a stain is gone at the TTL");
  ok(ageAlpha(BLOOD_TTL_S + 10) === 0, "…and stays gone");
  // The fragment shader re-implements this curve off the same two constants
  // (fadeIn 0.12, fadeOut over the last 45 s of TTL). Locking the JS curve
  // here is what makes a future divergence visible at all — nothing else
  // calls this function.
  let monotone = true;
  let prev = 1;
  for (let t = BLOOD_TTL_S - 45; t <= BLOOD_TTL_S; t += 1) {
    const a = ageAlpha(t);
    if (a > prev + 1e-12) monotone = false;
    prev = a;
  }
  ok(monotone, "the fade-out never brightens");
}

console.log(`\nblood_decals: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
