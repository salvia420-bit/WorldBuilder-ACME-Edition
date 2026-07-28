// RND-04 (2026-07-27) — URL-flag truth table for the static-light vertex bake.
//
// This exists because of the project's standing footgun: a reader written
// `!== "off"` is ON when the param is ABSENT, regardless of what any comment
// or doc claims. RND-04 ships TWO readers that must agree —
// `readVertexBakeFlag` (materials.js, drives the shader) and
// `getVertexBakePoolConfig` (lighting.js, drives whether interior static
// lights still enter the pool) — and a disagreement between them is the one
// failure that produces a BLACK dungeon: shader suppressing direct light
// while the pool has already dropped the lights that would replace it.
//
// Dependency-free ON PURPOSE: both readers are pure functions of
// `globalThis.location.search`, so they are source-sliced out of their
// modules rather than imported. That keeps this runnable without `three`
// installed, unlike test_cell_lights.mjs / test_light_pool.mjs.
//
// Run: cd apps/holtburger-web/ && node test_vertex_bake_flags.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

function slice(file, startMarker, endMarker) {
  const src = readFileSync(resolvePath(__dirname, file), "utf8");
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error(`${file}: start marker not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error(`${file}: end marker not found: ${endMarker}`);
  return src.slice(a, b);
}

const materialsReader = slice(
  "scene3d/materials.js",
  "export function readVertexBakeFlag()",
  "export const VERTEX_BAKE",
).replace("export function", "function");

const lightingReader =
  slice(
    "scene3d/lighting.js",
    "function _rp5ReadParams()",
    "\n}\n",
  ) +
  "\n}\n" +
  slice(
    "scene3d/lighting.js",
    "let _vertexBakePoolConfig;",
    "// Test seam — mirrors the two above.",
  );

const build = new Function(
  "search",
  `
  const globalThis_ = { location: { search } };
  const globalThis = globalThis_;
  const window = globalThis_;
  ${materialsReader}
  ${lightingReader}
  return {
    shader: readVertexBakeFlag(),
    pool: getVertexBakePoolConfig(),
  };
  `,
);

console.log("RND-04 — vertex-bake URL flag truth table");
console.log("=========================================");

// (search, expected shader.enabled, expected shader.suppressDirect,
//  expected pool.dropCellStatics)
const TABLE = [
  // ABSENT = fully ON. This is the line the footgun rule exists for.
  ["", true, true, true],
  ["?someOtherFlag=1", true, true, true],
  // Explicit off-family: shader term gone, lights stay live. Must be the
  // pre-RND-04 render exactly.
  ["?vertexBake=off", false, false, false],
  ["?vertexBake=false", false, false, false],
  ["?vertexBake=0", false, false, false],
  ["?vertexBake=no", false, false, false],
  ["?vertexBake=OFF", false, false, false],
  // Pure-additive A/B arm: bake ADDS, direct light kept, lights still leave
  // the pool (the bake is authoritative for the walls either way).
  ["?vertexBake=lit", true, false, true],
  ["?vertexBake=add", true, false, true],
  // on-family is a no-op (it is already the default), NOT a disable.
  ["?vertexBake=on", true, true, true],
  ["?vertexBake=1", true, true, true],
  // Pool-only escape: walls baked + direct suppressed, but interior props
  // keep their live lamps (retail minimize_object_lighting for objects).
  ["?vertexBakePool=keep", true, true, false],
  ["?vertexBake=lit&vertexBakePool=keep", true, false, false],
];

for (const [search, wantEnabled, wantSuppress, wantDrop] of TABLE) {
  const r = build(search);
  const label = search === "" ? "(no params)" : search;
  check(
    `${label} -> shader.enabled=${wantEnabled}`,
    r.shader.enabled === wantEnabled,
    `got ${r.shader.enabled}`,
  );
  check(
    `${label} -> shader.suppressDirect=${wantSuppress}`,
    r.shader.suppressDirect === wantSuppress,
    `got ${r.shader.suppressDirect}`,
  );
  check(
    `${label} -> pool.dropCellStatics=${wantDrop}`,
    r.pool.dropCellStatics === wantDrop,
    `got ${r.pool.dropCellStatics}`,
  );
}

// The one combination that must be impossible: direct light suppressed on
// cell meshes while their lights have ALSO been removed from the pool would
// be fine (the bake replaces them), but the INVERSE — shader off while the
// pool has dropped the lights — leaves a dungeon lit by ambient alone.
for (const [search] of TABLE) {
  const r = build(search);
  check(
    `${search || "(no params)"} -> never (shader off AND lights dropped)`,
    !(r.shader.enabled === false && r.pool.dropCellStatics === true),
  );
}

// === PROGRAM-CACHE-KEY COVERAGE (2026-07-28 regression) ====================
// The OTHER route to the ambient-only dungeon: three.js caches compiled
// programs RENDERER-WIDE by (parameters + `customProgramCacheKey()`) and
// compiles from whichever material's `onBeforeCompile` ran first for that
// key. A patch that is not represented in `_patchSetCacheKey` therefore
// renders SOMEONE ELSE'S shader. RND-04 shipped `__acBakedLight` without a
// bit, so EnvCell meshes drew with the un-patched program (no emissive add)
// while their static lamps had already left the live pool. Every patch flag
// that changes the shader STRING must move the key.
const patchKeyFn = new Function(
  "material",
  slice("scene3d/materials.js", "function _patchSetCacheKey(material)", "\n}\n")
    .replace("function _patchSetCacheKey(material) {", "") +
    "\n",
);
const keyFor = (userData) => patchKeyFn({ userData });
const BASE_KEY = keyFor({ lightClampRetail: true });
const KEY_CASES = [
  ["baked cell material (RND-04)", { lightClampRetail: true, __acBakedLight: true }],
  ["static-bias décor prop", { lightClampRetail: true, __staticBiased: true }],
  ["floor-bias surface", { lightClampRetail: true, __floorBiased: true }],
  ["fill-depth-bias surface", { lightClampRetail: true, __depthBiased: true }],
  ["wire vertex-AO", { lightClampRetail: true, __aoPatched: true }],
  ["detail patch", { lightClampRetail: true, detailEnabled: true }],
  ["CSM patch", { lightClampRetail: true, csmEnabled: true }],
  ["POM patch", { lightClampRetail: true, pomEnabled: true }],
];
for (const [label, ud] of KEY_CASES) {
  const k = keyFor(ud);
  check(
    `program-cache key separates ${label} from the un-patched material`,
    k !== BASE_KEY,
    `${k} vs ${BASE_KEY}`,
  );
}
check(
  "un-patched key shape unchanged (no gratuitous program split)",
  BASE_KEY === "hb|d0|c0|p0|l1|a0|b0|f0|s0|k0|v",
  BASE_KEY,
);

console.log("=========================================");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
