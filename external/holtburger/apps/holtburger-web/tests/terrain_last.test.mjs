// 2026-10-19 — ?terrainLast (scene3d/atmosphere_pipeline.js): under reversed-Z,
// on a frame that draws no doorway punch, the terrain family sorts after the
// other opaque phases so early depth rejection can skip the terrain pixels the
// buildings / statics / entities cover. The log buffer (no early-Z) keeps the
// old order exactly.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/terrain_last.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const VENDOR_CLOUDS = pathToFileURL(path.join(APP, "vendor", "takram-three-clouds", "build", "index.js")).href;
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(spec, ctx, next) {
        if (spec === "@takram/three-clouds") return { url: ${JSON.stringify(VENDOR_CLOUDS)}, shortCircuit: true };
        return next(spec, ctx);
      }`,
    ),
);

const THREE = await import("three");
const P = await import("../scene3d/atmosphere_pipeline.js");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

console.log("-- T1 flag reader ----------------------------------------------------");
{
  const R = (search) => { globalThis.location = { search }; return P.terrainLastEnabled(); };
  check("absent -> on (default)", R("") === true && R("?foo=1") === true);
  check("escapes -> off (off / 0 / false / no, any case)", ["off", "OFF", "0", "false", "no"].every((v) => R(`?terrainLast=${v}`) === false));
  check("anything else -> on", ["on", "1", "yes"].every((v) => R(`?terrainLast=${v}`) === true));
  delete globalThis.location;
}

console.log("-- T2 phase mapping ----------------------------------------------------");
{
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group(); worldRoot.userData.__punchPhase = 2; scene.add(worldRoot);
  const terrainGroup = new THREE.Group(); terrainGroup.userData.__punchPhase = 0; worldRoot.add(terrainGroup);
  const terrain = new THREE.Mesh(); terrainGroup.add(terrain);
  const statics = new THREE.Mesh(); worldRoot.add(statics);
  const punch = new THREE.Group(); punch.userData.__punchPhase = 1; scene.add(punch);
  const aperture = new THREE.Mesh(); punch.add(aperture);
  const untagged = new THREE.Mesh(); scene.add(untagged);
  check("terrain is phase 0 with terrain-last off", P.__phaseOfForTest(terrain, false) === 0);
  check("terrain moves after everything with terrain-last on", P.__phaseOfForTest(terrain, true) === 3);
  check("statics stay phase 2 either way", P.__phaseOfForTest(statics, false) === 2 && P.__phaseOfForTest(statics, true) === 2);
  check("the punch stays phase 1 either way", P.__phaseOfForTest(aperture, false) === 1 && P.__phaseOfForTest(aperture, true) === 1);
  check("untagged (phase 0 family) follows the terrain", P.__phaseOfForTest(untagged, true) === 3);
  check("order with terrain-last: punch < statics < terrain",
    P.__phaseOfForTest(aperture, true) < P.__phaseOfForTest(statics, true) && P.__phaseOfForTest(statics, true) < P.__phaseOfForTest(terrain, true));
}

console.log("-- T3 source wiring ----------------------------------------------------");
{
  const src = readFileSync(path.join(APP, "scene3d", "atmosphere_pipeline.js"), "utf8");
  check("the program sort and the phase-only sort both read _phaseOf",
    src.includes("setDrawSortPhase(renderer, _phaseOf, punchPhaseOpaqueSort);")
      && /function punchPhaseOpaqueSort\(a, b\) \{\s*const pa = _phaseOf\(a\.object\);\s*const pb = _phaseOf\(b\.object\);/.test(src));
  check("terrain-last is read once and only under reversed-Z",
    /const terrainLastOn = reversedZ && terrainLastEnabled\(\);/.test(src));
  check("set per frame before composer.render, off whenever a punch aperture draws",
    /_terrainLastNow = terrainLastOn && !\(portalPunchPass && portalPunchPass\.hasApertures\);[\s\S]{0,1600}composer\.render\(dt\);/.test(src));
}

console.log(`\nterrain last: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
