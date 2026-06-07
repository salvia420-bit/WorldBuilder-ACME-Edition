// Batch 5 / #10 — getTerrainVisualZ world-frame raycast unit test.
//
// Run with (real vendored THREE; the existing harness convention):
//   cd external/holtburger/apps/holtburger-web && \
//     env THREE_PATH=".../three.module.js" \
//     node test_terrain_visual_z.mjs
//
// Exits non-zero on any failure.
//
// ===========================================================================
// What this exercises
// ===========================================================================
//
// `scene3d/terrain.js`'s `getTerrainVisualZ(scene3d, acX, acY, fallbackZ)`
// raycasts the rendered terrain to recover the visible surface height at an
// AC (x east, y north) query and returns it as AC z. The terrain mesh lives
// under `worldRoot` (rotation.x = -π/2, AC z-up → three.js y-up), so the cast
// MUST happen in the three.js WORLD frame:
//   origin = acToThree(x, y, 1000) = (x, 1000, -y)
//   dir    = (0, -1, 0)   (straight down in three's y-up world)
//   readback: AC z = hit.point.y   (closed-form inverse of acToThree)
//
// The pre-fix code cast (x, y, 1000) down -Z and read point.z, which only
// hits if the terrain happened to live in an unrotated AC frame — under the
// real worldRoot rotation it misses entirely (always returns fallbackZ),
// the dead-path bug #10 fixes. This test builds a REAL rotated terrain mesh
// and a REAL THREE.Raycaster (via the imported getTerrainVisualZ) and asserts
// the world-frame cast recovers the planted height.
//
// `three` resolves to the real vendored r0.184 module via THREE_PATH (same
// hook other captures use); terrain.js's transitive adapter/materials imports
// resolve against the same real THREE.

import { register } from "node:module";
import { pathToFileURL } from "node:url";

const THREE_PATH = process.env.THREE_PATH;
if (!THREE_PATH) {
  console.error("FAIL: THREE_PATH env var is required (path to three.module.js)");
  process.exit(1);
}

// Map the bare "three" specifier (used by terrain.js + adapter.js +
// materials.js) onto the real vendored build for the whole import graph.
const RESOLVER_URL =
  "data:text/javascript," +
  encodeURIComponent(`
    const THREE_PATH = ${JSON.stringify(THREE_PATH)};
    import { pathToFileURL } from "node:url";
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "three") {
        return { url: pathToFileURL(THREE_PATH).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `);
register(RESOLVER_URL);

const THREE = await import(pathToFileURL(THREE_PATH).href);
const { getTerrainVisualZ } = await import(
  pathToFileURL(
    new URL("./scene3d/terrain.js", import.meta.url).pathname
  ).href
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// ---------------------------------------------------------------------
// Build a scene3d-shaped fixture: worldRoot (-π/2 X) → terrainGroup → mesh.
// The mesh is authored in AC coords (x east, y north, z = height) exactly
// like the real terrain build, so worldRoot's rotation puts it into the
// three world frame the same way the live renderer does.
// ---------------------------------------------------------------------
function makeFixture(heightFn) {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2; // sole AC→three rotation (C2 invariant)
  scene.add(worldRoot);
  const terrainGroup = new THREE.Group();
  terrainGroup.name = "terrain";
  worldRoot.add(terrainGroup);

  // A grid plane in AC XY spanning [0,200]×[0,200], z = heightFn(x,y).
  const N = 20; // 21×21 vertices
  const span = 200;
  const positions = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * span;
      const y = (j / N) * span;
      positions.push(x, y, heightFn(x, y));
    }
  }
  const indices = [];
  const stride = N + 1;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(new Float32Array(positions), 3)
  );
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  );
  terrainGroup.add(mesh);

  // Raycaster reads WORLD matrices — ensure they are current.
  scene.updateMatrixWorld(true);

  return { terrainGroup };
}

const SENTINEL = -99999;

// ---- Case 1: flat terrain at AC z = 42 ------------------------------------
{
  const scene3d = makeFixture(() => 42.0);
  const got = getTerrainVisualZ(scene3d, 100, 80, SENTINEL);
  check(
    "flat: returns planted AC height (not sentinel)",
    got !== SENTINEL,
    `got ${got} (pre-fix bug returns the sentinel because the rotated mesh is missed)`
  );
  check(
    "flat: recovered z ≈ 42",
    Number.isFinite(got) && Math.abs(got - 42.0) < 1e-3,
    `got ${got}`
  );
}

// ---- Case 2: sloped terrain — proves point.y readback maps to AC z --------
// z increases with AC north (y). A constant-readback bug would fail this.
{
  const heightFn = (x, y) => 5.0 + 0.25 * y; // z at y=40 → 15, at y=160 → 45
  const scene3d = makeFixture(heightFn);
  const lo = getTerrainVisualZ(scene3d, 100, 40, SENTINEL);
  const hi = getTerrainVisualZ(scene3d, 100, 160, SENTINEL);
  check(
    "slope: low-north sample hits surface",
    lo !== SENTINEL && Math.abs(lo - heightFn(100, 40)) < 1e-2,
    `got ${lo}, expected ${heightFn(100, 40)}`
  );
  check(
    "slope: high-north sample hits surface",
    hi !== SENTINEL && Math.abs(hi - heightFn(100, 160)) < 1e-2,
    `got ${hi}, expected ${heightFn(100, 160)}`
  );
  check(
    "slope: AC z tracks AC north (hi > lo)",
    hi > lo + 10,
    `lo=${lo} hi=${hi}`
  );
}

// ---- Case 3: query outside the mesh footprint → fallback -----------------
{
  const scene3d = makeFixture(() => 7.0);
  const got = getTerrainVisualZ(scene3d, 5000, 5000, SENTINEL);
  check("off-mesh: returns fallbackZ", got === SENTINEL, `got ${got}`);
}

// ---- Case 4: empty terrain group → fallback (public contract) ------------
{
  const got = getTerrainVisualZ({ terrainGroup: { children: [] } }, 1, 1, SENTINEL);
  check("empty group: returns fallbackZ", got === SENTINEL, `got ${got}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll getTerrainVisualZ world-frame checks passed.");
