// ragdoll_env.test.mjs — environment interaction for the death ragdoll.
//
// NEW 2026-08-03. `scene3d/ragdoll_env.js` (687 lines, riding the DEFAULT-ON
// `?ragdoll` flag) had ZERO test coverage, including two exported seams
// (`clearSettledBodies`, `settledBodyCount`) that nothing had ever called.
//
// The headline lock is §3. `indoor` came from `inst._outdoorCellIdx` — a
// SPAWN-TIME stamp with exactly one writer (entities.js:4551, the ObjectCreate
// path) that nothing refreshes when the creature MOVES, plus `inst._cellIdx`,
// which does not exist anywhere in the tree. That stale bit then VETOED the
// terrain probe outright (`const terrainAt = indoor ? null : _terrainFn(live)`),
// so a mob that spawned in a cottage and died on the lawn got no terrain floor
// at all — `envForRagdoll` returned null and the sim fell back to the flat
// death plane this module exists to replace. Silently, because a flat plane is
// exactly what "no env" looks like.
//
// `three` is import-stubbed. The stub has no `Raycaster`, so `_getScratch()`
// fails and the module degrades to "no raycasting available" — which is a
// DOCUMENTED rung of its degradation ladder and precisely the state that
// isolates the floor/terrain decision under test.
//
// Run: node tests/ragdoll_env.test.mjs   (from apps/holtburger-web/)

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolvePath(__dirname, "../_three_stub_loader.mjs")).href);

const {
  envForRagdoll,
  registerSettledBody,
  clearSettledBodies,
  settledBodyCount,
  FLOOR_ELEVATED_EPS_M,
  FLOOR_GRID_HALF_M,
  STACK_SELF_RADIUS_M,
  STACK_BODY_HEIGHT_MAX_M,
  REGISTRY_MAX,
  WALL_MIN_CLEARANCE_M,
} = await import("../scene3d/ragdoll_env.js");

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

/* ── fixtures ─────────────────────────────────────────────────────────── */

/** A scene facade with only the parts this module reads. */
function makeLive(terrainHeightAt, entityMap = new Map()) {
  return {
    entitiesGroup: null, // no matrixWorld ⇒ the AC frame is used as-is
    worldRoot: null,
    cellsGroup: null,
    buildingsGroup: null,
    entityManager: { entityMap },
    sessionHandle: terrainHeightAt ? { terrainHeightAt } : null,
  };
}

function makeInst(cellIdx, x, y, z) {
  return { _outdoorCellIdx: cellIdx, root: { position: { x, y, z } } };
}

/** A settled corpse instance the gatherer will accept (`_deathAt` tell). */
function makeCorpse(x, y, z, partZ = 0.2) {
  return {
    _deathAt: 1,
    root: { position: { x, y, z } },
    parts: [{ position: { x: 0, y: 0, z: partZ } }],
  };
}

/* ── 1. degradation ladder ────────────────────────────────────────────── */
section("degradation ladder");
{
  clearSettledBodies();
  ok(envForRagdoll(null) === null, "no instance ⇒ no env (and no throw)");
  ok(envForRagdoll({ root: { position: { x: NaN, y: 0, z: 0 } } }, { live: makeLive(null) }) === null,
    "a NaN death position ⇒ no env");
  ok(envForRagdoll(makeInst(0, 0, 0, 0), { live: null }) === null, "no scene ⇒ no env");
  // Everything absent at once: nothing better than the caller's flat plane.
  ok(envForRagdoll(makeInst(0, 10, 10, 5), { live: makeLive(null) }) === null,
    "no terrain, no raycast, no bodies ⇒ null, so ragdoll.js keeps its legacy path");
}

/* ── 2. the outdoor terrain floor ─────────────────────────────────────── */
section("terrain floor");
{
  clearSettledBodies();
  // A plane sloping in +x: z = x/10.
  const slope = (x) => x / 10;
  const env = envForRagdoll(makeInst(0x0002, 100, 200, 10), { live: makeLive((x) => slope(x)) });
  ok(!!env, "an outdoor death on the terrain surface builds an env");
  ok(env.floorMode === "terrain", `floorMode is "terrain" (got ${env.floorMode})`);
  ok(env.indoor === false, "…and it reads outdoor");
  ok(near(env.floorZAt(100, 200), 10, 1e-6), "floorZAt at the death spot is the terrain height");
  ok(near(env.floorZAt(102, 200), 10.2, 1e-6), "…and follows the slope inside the grid (bilinear)");
  // Outside the pre-sampled grid the memoised oracle answers, quantised to 0.5 m.
  const far = env.floorZAt(100 + FLOOR_GRID_HALF_M + 5, 200);
  ok(near(far, slope(Math.round((100 + FLOOR_GRID_HALF_M + 5) * 2) / 2), 1e-6),
    "…and the 32-entry memo answers outside the grid");
  ok(env.gridSamples === 25, `the whole 5×5 grid sampled (got ${env.gridSamples})`);

  // Elevated: died on a bridge / rooftop. Terrain is the wrong answer, and the
  // module must NOT quietly use it.
  // 1 m to the east: inside STACK_SEARCH_RADIUS_M but outside STACK_SELF_RADIUS_M,
  // which exists to stop a ragdoll floating on its own about-to-spawn corpse.
  const bodies = registerSettledBody(301, 300, 49.5, 0.8); // so the env is non-null
  ok(bodies, "a settled body registers");
  const high = envForRagdoll(makeInst(0x0002, 300, 300, 50), { live: makeLive(() => 0) });
  ok(!!high, "an elevated death with a body nearby still builds an env");
  ok(high.floorMode === "flat" && high.indoor === true,
    `>${FLOOR_ELEVATED_EPS_M} m off the terrain column reads INDOOR and refuses the terrain floor ` +
    `(mode=${high.floorMode}, indoor=${high.indoor})`);
  clearSettledBodies();
}

/* ── 3. REGRESSION: a stale spawn stamp must not veto the probe ───────── */
section("stale `_outdoorCellIdx` (2026-08-03 regression lock)");
{
  clearSettledBodies();
  // Spawned inside a cottage EnvCell (cell >= 0x0100) — the stamp says indoor
  // and NOTHING ever updates it — but killed outdoors, standing on terrain.
  const terrain = (x) => x / 10;
  const env = envForRagdoll(makeInst(0x0140, 100, 200, 10), { live: makeLive(terrain) });
  ok(env !== null,
    "an indoor-STAMPED body standing on terrain still gets an env " +
    "(pre-fix the stamp vetoed the probe and this returned null)");
  ok(env && env.floorMode === "terrain", `…and it is a terrain floor (got ${env && env.floorMode})`);
  ok(env && env.indoor === false, "…and the live geometric read overrides the stale stamp");
  ok(env && near(env.floorZAt(102, 200), 10.2, 1e-6), "…and the sim gets the real slope under the body");

  // The stamp still answers when the oracle cannot.
  const noOracle = envForRagdoll(makeInst(0x0140, 100, 200, 10), { live: makeLive(null) });
  ok(noOracle === null, "with no oracle at all there is still nothing better than the flat plane");

  // And a REAL dungeon (deep under its own terrain column) is unaffected.
  registerSettledBody(501, 500, -19.6, 0.8); // offset past STACK_SELF_RADIUS_M
  const dungeon = envForRagdoll(makeInst(0x0140, 500, 500, -20), { live: makeLive(() => 0) });
  ok(dungeon && dungeon.indoor === true && dungeon.floorMode === "flat",
    "a genuine dungeon 20 m below its terrain column still reads indoor and refuses the terrain");
  clearSettledBodies();
}

/* ── 4. body stacking ─────────────────────────────────────────────────── */
section("stacking");
{
  clearSettledBodies();
  const corpse = makeCorpse(101, 200, 10, 0.2);
  const map = new Map([[1, corpse]]);
  const env = envForRagdoll(makeInst(0x0002, 100, 200, 10), { live: makeLive(() => 10, map) });
  ok(env && env.bodyCount === 1, `the live entity map contributes a corpse (got ${env && env.bodyCount})`);
  ok(env && env.floorZAt(101, 200) > 10, "the floor rises over a body lying there");
  ok(env && near(env.floorZAt(100, 200), 10, 1e-6), "…and is unchanged where no body lies");
  // A body ON the death spot is us / our own pending corpse and must be skipped.
  const self = new Map([[1, makeCorpse(100 + STACK_SELF_RADIUS_M / 2, 200, 10)]]);
  const env2 = envForRagdoll(makeInst(0x0002, 100, 200, 10), { live: makeLive(() => 10, self) });
  ok(env2 === null || env2.bodyCount === 0, "a body inside STACK_SELF_RADIUS_M is skipped (it is us)");
  // A standing rig must not become a 1.8 m platform.
  const tall = new Map([[1, makeCorpse(101, 200, 10, 1.9)]]);
  const env3 = envForRagdoll(makeInst(0x0002, 100, 200, 10), { live: makeLive(() => 10, tall) });
  ok(env3 && env3.floorZAt(101, 200) <= 10 + STACK_BODY_HEIGHT_MAX_M + 1e-9,
    "a corpse rig that never re-posed is clamped to STACK_BODY_HEIGHT_MAX_M");
  // A live, un-dead creature is not a body.
  const alive = new Map([[1, { root: { position: { x: 101, y: 200, z: 10 } }, parts: [] } ]]);
  const env4 = envForRagdoll(makeInst(0x0002, 100, 200, 10), { live: makeLive(() => 10, alive) });
  ok(env4 && env4.bodyCount === 0, "a living creature standing next to you is not a corpse to drape over");
  clearSettledBodies();
}

/* ── 5. the registry (seams that shipped uncalled) ────────────────────── */
section("settled-body registry");
{
  clearSettledBodies();
  ok(settledBodyCount() === 0, "clearSettledBodies empties it");
  ok(registerSettledBody(1, 2, 3) === true, "a finite record is stored");
  ok(settledBodyCount() === 1, "…and counted");
  ok(registerSettledBody(NaN, 2, 3) === false, "a NaN record is refused");
  ok(registerSettledBody(1, Infinity, 3) === false, "a non-finite record is refused");
  ok(settledBodyCount() === 1, "…and neither was stored");
  for (let i = 0; i < REGISTRY_MAX + 20; i++) registerSettledBody(i, 0, 0, 0.8);
  ok(settledBodyCount() === REGISTRY_MAX, `the registry is hard-capped at ${REGISTRY_MAX}`);
  clearSettledBodies();

  // A registry body feeds the stack just as a live corpse does.
  registerSettledBody(101, 200, 10.4, 0.8);
  const env = envForRagdoll(makeInst(0x0002, 100, 200, 10), { live: makeLive(() => 10) });
  ok(env && env.bodyCount === 1, "a registered body is gathered");
  ok(env && near(env.floorZAt(101, 200), 10.4, 1e-6), "…and its TOP is the support height");
  clearSettledBodies();
}

/* ── 6. lateral containment ───────────────────────────────────────────── */
section("constrainAC");
{
  clearSettledBodies();
  const env = envForRagdoll(makeInst(0x0002, 0, 0, 0), { live: makeLive(() => 0) });
  ok(!!env, "an outdoor env exists to constrain against");
  // With no raycasting every sector is Infinity, so containment is a no-op —
  // the documented open-air case.
  const p = { x: 50, y: 50, z: 0 };
  env.constrainAC(p, 0.2);
  ok(p.x === 50 && p.y === 50, "an unmeasured sector never pushes a node (outdoors is a no-op)");
  ok(env.sectors.length === 8 && [...env.sectors].every((s) => s === Infinity),
    "all 8 sectors read clear when nothing was raycast");

  // `sectors` is documented as the LIVE array a diag session can poke.
  env.sectors[0] = 1.0; // a wall 1 m east
  const q = { x: 5, y: 0, z: 0 };
  env.constrainAC(q, 0.2);
  ok(near(q.x, 0.8, 1e-9) && q.y === 0, `a node past a poked wall is pulled back to clear−radius (got ${q.x})`);
  const inside = { x: 0.5, y: 0 };
  env.constrainAC(inside, 0.2);
  ok(inside.x === 0.5, "a node already inside the clearance is untouched");
  // The clamp floor: a radius wider than the corridor must not invert.
  const fat = { x: 5, y: 0 };
  env.constrainAC(fat, 99);
  ok(near(fat.x, WALL_MIN_CLEARANCE_M, 1e-9), "an over-wide radius clamps to WALL_MIN_CLEARANCE_M, never negative");
  // Dead centre: no direction to push along.
  const centre = { x: 0, y: 0 };
  env.constrainAC(centre, 0.2);
  ok(centre.x === 0 && centre.y === 0, "a node at the death spot is left alone");
  env.constrainAC(null, 0.2);
  ok(true, "a null position does not throw");
  clearSettledBodies();
}

console.log(`\nragdoll_env: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
