// Task #4 (2026-06-23) — sky-object Swarm particle chain ("birds in the sky").
//
// Birds are NOT mesh-animated scenery (the original task framing) — they are
// Region SkyObject `default_pes` (0x33) chains that walk to ParticleType.Swarm
// emitters (e.g. 0x330007db → 0x32000455/456/457, gfxobj 0x01001a61/a62/a63).
// sky_dome.js's weather path drew billboards only and never walked this chain
// (its own TODO), so the sky swarms never rendered.
//
// statics.js / sky_dome.js / loop.js can't be imported under node (THREE/wasm),
// so — like the other statics structural tests — this asserts the source-level
// wiring contract. The in-browser import smoke (exports/methods resolve, 0
// errors) was run separately on serve.py:8765; the VISUAL A/B is the 1070 batch
// eye-test (gated by ?skyBirds=on; the bird SkyObject is day-group + time-window
// gated, so the tester may need the right time-of-day).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const statics = readFileSync(joinPath(__dirname, "scene3d", "statics.js"), "utf8");
const sky = readFileSync(joinPath(__dirname, "scene3d", "sky_dome.js"), "utf8");
const loop = readFileSync(joinPath(__dirname, "scene3d", "loop.js"), "utf8");

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label}`); }
}

// --- statics.js: the reusable sky chain attach (over the proven scenery infra)
const skyFn = statics.slice(
  statics.indexOf("export async function attachSkyParticleChain"),
  statics.indexOf("export async function attachStaticDefaultScripts")
);
check("statics exports attachSkyParticleChain", skyFn.length > 0);
check("attachSkyParticleChain honors ?staticScripts=off", /_staticScriptsEnabled\(\)/.test(skyFn));
check("attachSkyParticleChain reuses the shared ParticleManager",
  /_ensureStaticParticleManager\(scene3d, wasmExports\)/.test(skyFn));
check("attachSkyParticleChain reuses _runStaticParticleChain (Swarm + CallPES loop)",
  /_runStaticParticleChain\(manager, anchor, pesId >>> 0, wasmExports, ownerKey, 0\)/.test(skyFn));
check("attachSkyParticleChain no-ops on pesId 0", /\(pesId >>> 0\) === 0\)\) return 0/.test(skyFn));

// --- sky_dome.js: flag, idempotent attach, camera-follow anchor
check("?skyBirds flag reader is DEFAULT-ON (=off escape)",
  /get\("skyBirds"\)\?\.toLowerCase\(\) !== "off"/.test(sky) && /_skyBirdsFlagCache/.test(sky));
check("?skyBirdAlt overhead altitude tunable", /get\("skyBirdAlt"\)/.test(sky));
const upd = sky.slice(sky.indexOf("updateSkyParticleChains(skyObjects, wasmExports)"),
                      sky.indexOf("\n  tick(_dt, camera)"));
check("updateSkyParticleChains gated on _skyBirdsEnabled", /if \(!this\._skyBirdsEnabled\) return;/.test(upd));
check("only attaches VISIBLE sky objects with a non-zero pesObjectId",
  /o\.pesObjectId >>> 0/.test(upd) && /pes === 0 \|\| !vis\) continue/.test(upd));
check("idempotent per pesObjectId (guard set before async attach)",
  /_skyBirdChainsAttached\.add\(pes\)/.test(upd) && /_skyBirdChainsAttached\.has\(pes\)\) continue/.test(upd));
check("attaches via statics.attachSkyParticleChain (dynamic import, no cycle)",
  /import\("\.\/statics\.js"\)/.test(upd) && /attachSkyParticleChain\(scene3d, this\._skyBirdAnchor, pes, wasmExports/.test(upd));
// FRAME INVARIANT (2026-08-03 fix #63). `_runStaticParticleChain` parents the
// Swarm emitters straight under this anchor, and every other caller hands it an
// anchor under `staticsGroup` — so the emitter offsets are AC-frame (Z-up). The
// anchor must therefore hang off `worldRoot`, NOT the Y-up root scene. These two
// checks assert the INVARIANT (correct frame, genuinely overhead), not the old
// mechanism; they previously locked the bug in place by matching
// `this.scene.add(...)` and `camera.position.z + this._skyBirdAltitude`, which
// parked the swarm 40 m SOUTH at eye height.
check("anchor parented to the AC frame (worldRoot), root scene only as fallback",
  /scene3d\.worldRoot \?\? this\.scene/.test(upd) && /frame\.add\(this\._skyBirdAnchor\)/.test(upd));
check("anchor frame's matrixWorld is seeded before the first worldToLocal",
  /frame\.updateWorldMatrix\(/.test(upd));
// tick: camera-follow at altitude, hidden indoors
const tickFn = sky.slice(sky.indexOf("  tick(_dt, camera) {"), sky.indexOf("  tick(_dt, camera) {") + 2200);
check("tick lifts the anchor along three.js world +Y (overhead), hides indoors",
  /_skyBirdPosScratch\.copy\(camera\.position\)/.test(tickFn) &&
  /_skyBirdPosScratch\.y \+= this\._skyBirdAltitude/.test(tickFn) &&
  /!isIndoor/.test(tickFn));
check("overhead point is converted into the anchor's parent frame",
  /frame\.worldToLocal\(_skyBirdPosScratch\)/.test(tickFn) &&
  /_skyBirdAnchor\.position\.copy\(_skyBirdPosScratch\)/.test(tickFn));
check("tick allocates no vector (module scratch, not a fresh Vector3)",
  !/new THREE\.Vector3\(\)/.test(tickFn));
// dispose: reap the shared-manager emitters + drop the idempotence guard
const disposeFn = sky.slice(sky.indexOf("  dispose() {"));
check("dispose reaps sky-swarm emitters by the same sky:<pes> owner key",
  /destroyAllForOwner/.test(disposeFn) && /`sky:\$\{pes\}`/.test(disposeFn));
check("dispose clears the per-pes idempotence guard and drops the anchor",
  /_skyBirdChainsAttached\.clear\(\)/.test(disposeFn) &&
  /_skyBirdAnchor\.parent\.remove\(this\._skyBirdAnchor\)/.test(disposeFn));

// --- loop.js: drives it from the same getSkyObjectStates snapshot
check("loop.js tickWeatherState calls updateSkyParticleChains with wasmExports",
  /updateSkyParticleChains\(skyObjects, scene3d\.wasmExports\)/.test(loop));

console.log(`\nSky birds (sky-object Swarm chain): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
