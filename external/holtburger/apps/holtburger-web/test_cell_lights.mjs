// RND-05/03 (2026-07-27) — headless ESM test for CELL-SCOPED light selection
// (?cellLights, default ON) in scene3d/lighting.js.
//
// Retail model under test (decomp anchors in the lighting.js header):
//   - light-pool selection scope = the viewer's cell + its portal/PVS-visible
//     cells; rebuilt ONLY when that set (or the source inventory) changes
//     (CellManager::ChangePosition → CEnvCell::flush_cells), never per frame;
//   - ranking = squared distance from the VIEWER (player), never the camera;
//     camera ORIENTATION appears nowhere in selection;
//   - hidden viewer light (point, white, falloff 10, intensity 2.25) rides
//     the dynamic pool with top priority.
//
// Asserts:
//   1. RQ-05 kill — a nearer-to-the-CAMERA lamp in a NON-VISIBLE room never
//      steals a slot from the player's own room's lamps.
//   2. RQ-07 kill — a full 32-step 360° camera yaw sweep leaves the selected
//      set AND the rebuild counter untouched (zero churn).
//   3. Rebuild cadence — across a scripted 300-frame walk the selection is
//      rebuilt exactly (1 initial + #cell-set-changes) times, not per frame.
//   4. Scope rules — visible-room lamps in, out-of-set rooms out; outdoor
//      (__lbKey-only) lamps excluded when enclosed-indoor, included outdoors;
//      unstamped (entity/dynamic) sources always candidates.
//   5. Overflow — >pool candidates rank by PLAYER distance² (nearest win).
//   6. Viewer light (?viewerLight=on) — slot-0 white light at player+2 m,
//      retail params (intensity 2.25, distance 10*1.3), present even with
//      zero world lights.
//   7. Source-count change (spawn/stream-in) forces an immediate rebuild.
//   8. Fail-soft — no sessionHandle / no getRenderSet ⇒ the historic
//      player-distance + hysteresis pool path runs unchanged (no throw).
//   9. Pool-count invariant — the visible dynamic-light count never moves
//      (the relink-freeze rule holds on the cell path too).
//
// Run: cd apps/holtburger-web/ && node test_cell_lights.mjs
// (SKIPs cleanly if three can't be located.)

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
    return process.env.THREE_PATH;
  }
  try {
    return require.resolve("three");
  } catch (_) {}
  try {
    const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
    if (existsSync(npxRoot)) {
      const fs = require("node:fs");
      for (const dir of fs.readdirSync(npxRoot)) {
        const idx = joinPath(npxRoot, dir, "node_modules/three/build/three.module.js");
        if (existsSync(idx)) return idx;
      }
    }
  } catch (_) {}
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log("cell-lights ESM test: SKIP (three not located).");
  process.exit(0);
}
const THREE = await import("file://" + threePath);

console.log("RND-05/03 — cell-scoped light selection standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load lighting.js with closure-captured THREE (mirror test_light_pool) --
function loadModule(relPath) {
  let src = readFileSync(resolvePath(__dirname, relPath), "utf8");
  src = src.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
  src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/csm\.js["'];?\s*$/m, "");
  src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/landblock_lru\.js["'];?\s*$/m, "");
  return src;
}
function stripExports(src) {
  return src
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}
const csmSrc = loadModule("scene3d/csm.js");
const lightingSrc = loadModule("scene3d/lighting.js");
const lbKeyOfShim =
  "const LB_KEY_MASK = 0xffff_0000 >>> 0;\n" +
  "function lbKeyOf(idOrKey) { return (idOrKey & LB_KEY_MASK) >>> 0; }\n";
const composite =
  lbKeyOfShim + "\n" +
  stripExports(csmSrc) + "\n" +
  stripExports(lightingSrc) + "\n" +
  "; return { setupSceneLighting, capActiveLightsByDistance, " +
  "__resetLightPoolConfigForTest, __resetCellLightsConfigForTest, " +
  "LIGHTING_CONSTANTS };";
const mod = new Function("THREE", composite)(THREE);
const {
  setupSceneLighting,
  capActiveLightsByDistance,
  __resetLightPoolConfigForTest,
  __resetCellLightsConfigForTest,
  LIGHTING_CONSTANTS,
} = mod;

// ---- fixture -----------------------------------------------------------
// Venue mirrors the RQ-07 report's meeting hall (LB 0x0121, Cragstone —
// see the TIER2 dat-dump meeting_hall_cragstone_0x0121.json: 21 lit cells,
// 33 lamps, warm ARGB(255,150,80), intensity 100, falloff 4). The test uses
// a 3-room slice with hand-placed positions so expectations stay exact.
const ROOM_A = 0x01210100;
const ROOM_B = 0x01210101;
const ROOM_C = 0x01210102;
const LB_KEY = 0x01210000;

function makeLamp(name, x, y, z, cellId, lbKey) {
  const l = new THREE.PointLight(0xff9650, 100, 4 * 1.3, 2);
  l.position.set(x, y, z);
  l.visible = false; // pool mode: sources are permanent carriers
  l.name = name;
  l.userData = {};
  if (cellId != null) l.userData.__cellId = cellId >>> 0;
  if (lbKey != null) l.userData.__lbKey = lbKey >>> 0;
  return l;
}
function selectedNames(pool) {
  return pool.selPoint.map((s) => s.name ?? "(viewer)").sort();
}

function freshWorld({ pointCount = 4, viewerLight = false } = {}) {
  __resetLightPoolConfigForTest({
    enabled: true,
    pointCount,
    spotCount: 2,
    hysteresis: 0.64,
  });
  __resetCellLightsConfigForTest({
    enabled: true,
    viewerLight,
    viewerIntensity: 2.25,
  });
  const scene = new THREE.Scene();
  const lighting = setupSceneLighting(scene, {});
  const playerPos = new THREE.Vector3(0, 0, 0);
  const camera = { position: new THREE.Vector3(5, 2, 0) };
  const scene3d = {
    lighting,
    activeLights: [],
    camera,
    cameraSwitcher: {
      activeCamera: camera,
      getPlayerWorldPosition(v) {
        v.copy(playerPos);
        return v;
      },
    },
  };
  let renderSet = [ROOM_A];
  const session = {
    getRenderSet(depth) {
      return Uint32Array.from(renderSet);
    },
  };
  return {
    scene,
    scene3d,
    session,
    playerPos,
    camera,
    pool: lighting.lightPool,
    setRenderSet(ids) {
      renderSet = ids;
    },
  };
}

// ===================================================================
// 1. RQ-05 kill — own room beats nearer-to-camera other-room lamp
// ===================================================================
{
  const w = freshWorld();
  const a1 = makeLamp("a1", 2, 0, 0, ROOM_A);
  const a2 = makeLamp("a2", -2, 0, 0, ROOM_A);
  const a3 = makeLamp("a3", 0, 0, 3, ROOM_A);
  // b1 sits 1.2 m from the CAMERA (5,2,0) but in non-visible ROOM_B.
  const b1 = makeLamp("b1", 5.5, 2, 1, ROOM_B);
  w.scene3d.activeLights.push(a1, a2, a3, b1);
  capActiveLightsByDistance(w.scene3d, w.session);
  const sel = selectedNames(w.pool);
  check(
    "1a: room-A lamps selected, non-visible room-B lamp rejected",
    sel.join(",") === "a1,a2,a3" && !w.pool.selPoint.includes(b1),
    `selected=[${sel}]`
  );
  check(
    "1b: rejected room's slot idles at intensity 0 (no count change)",
    w.pool.point[3].intensity === 0,
    `i3=${w.pool.point[3].intensity}`
  );

  // ===================================================================
  // 2. RQ-07 kill — 32-step camera yaw sweep: zero churn
  // ===================================================================
  const before = selectedNames(w.pool).join(",");
  const rebuildsBefore = w.scene3d._cellLightsStats.rebuilds;
  let stable = true;
  for (let step = 0; step < 32; step += 1) {
    const th = (step / 32) * Math.PI * 2;
    w.camera.position.set(5 * Math.cos(th), 2, 5 * Math.sin(th));
    capActiveLightsByDistance(w.scene3d, w.session);
    if (selectedNames(w.pool).join(",") !== before) stable = false;
  }
  const rebuildsAfter = w.scene3d._cellLightsStats.rebuilds;
  check(
    "2a: selection identical at every yaw step (camera orbit is invisible to selection)",
    stable,
    ""
  );
  check(
    "2b: zero rebuilds across the sweep (churn counter flat)",
    rebuildsAfter === rebuildsBefore,
    `rebuilds ${rebuildsBefore} → ${rebuildsAfter}`
  );

  // ===================================================================
  // 7. source-count change forces an immediate rebuild
  // ===================================================================
  const a4 = makeLamp("a4", 0.5, 0, 0, ROOM_A);
  w.scene3d.activeLights.push(a4);
  capActiveLightsByDistance(w.scene3d, w.session);
  check(
    "7a: stream-in (count delta) rebuilds and admits the new lamp",
    w.scene3d._cellLightsStats.rebuilds === rebuildsAfter + 1 &&
      w.pool.selPoint.includes(a4),
    `rebuilds=${w.scene3d._cellLightsStats.rebuilds}, a4=${w.pool.selPoint.includes(a4)}`
  );
}

// ===================================================================
// 3. rebuild cadence == cell-set changes, not frames
// ===================================================================
{
  const w = freshWorld();
  const a1 = makeLamp("a1", 2, 0, 0, ROOM_A);
  const b1 = makeLamp("b1", 8, 0, 0, ROOM_B);
  const c1 = makeLamp("c1", 16, 0, 0, ROOM_C);
  w.scene3d.activeLights.push(a1, b1, c1);
  const script = [];
  for (let f = 0; f < 300; f += 1) {
    if (f === 100) {
      w.setRenderSet([ROOM_A, ROOM_B]); // walked to the doorway
      script.push(f);
    } else if (f === 200) {
      w.setRenderSet([ROOM_B]); // crossed into room B
      script.push(f);
    }
    // player drifts every frame — must NOT trigger rebuilds by itself
    w.playerPos.set(f * 0.05, 0, 0);
    capActiveLightsByDistance(w.scene3d, w.session);
  }
  const stats = w.scene3d._cellLightsStats;
  check(
    "3a: 300 frames, 2 set changes → exactly 3 rebuilds (1 initial + 2)",
    stats.rebuilds === 3,
    `rebuilds=${stats.rebuilds} (set changes at frames ${script})`
  );
  check(
    "3b: final selection = room-B only (a1/c1 out of scope after the walk)",
    selectedNames(w.pool).join(",") === "b1",
    `selected=[${selectedNames(w.pool)}]`
  );
}

// ===================================================================
// 4. scope rules — outdoor lamps vs enclosed cells; entity sources
// ===================================================================
{
  const w = freshWorld();
  const a1 = makeLamp("a1", 2, 0, 0, ROOM_A);
  const street = makeLamp("street", 3, 0, 0, null, LB_KEY); // outdoor lamp
  const spell = makeLamp("spell", 1, 0, 0, null, null); // entity/dynamic
  w.scene3d.activeLights.push(a1, street, spell);

  w.scene3d._poolSunIndoor = true; // genuinely enclosed (non-SeenOutside)
  capActiveLightsByDistance(w.scene3d, w.session);
  check(
    "4a: enclosed → outdoor __lbKey lamp excluded; room lamp + entity source in",
    selectedNames(w.pool).join(",") === "a1,spell",
    `selected=[${selectedNames(w.pool)}]`
  );

  w.scene3d._poolSunIndoor = false; // outdoors / SeenOutside interior
  w.scene3d._cellLightsStats.built = false; // force re-pick (state flip has no set delta)
  capActiveLightsByDistance(w.scene3d, w.session);
  check(
    "4b: not enclosed → outdoor lamp is a candidate again",
    selectedNames(w.pool).join(",") === "a1,spell,street",
    `selected=[${selectedNames(w.pool)}]`
  );
}

// ===================================================================
// 5. overflow ranks by PLAYER distance² (insert_light rule)
// ===================================================================
{
  const w = freshWorld({ pointCount: 4 });
  const lamps = [];
  for (let i = 0; i < 6; i += 1) {
    // distances from player (0,0,0): 1,2,3,4,5,6
    lamps.push(makeLamp(`L${i + 1}`, i + 1, 0, 0, ROOM_A));
  }
  // camera parked next to the FARTHEST lamp — must not matter
  w.camera.position.set(6, 0, 0);
  w.scene3d.activeLights.push(...lamps);
  capActiveLightsByDistance(w.scene3d, w.session);
  check(
    "5a: 6 candidates, pool 4 → nearest-to-PLAYER four win (L1..L4)",
    selectedNames(w.pool).join(",") === "L1,L2,L3,L4",
    `selected=[${selectedNames(w.pool)}]`
  );
}

// ===================================================================
// 6. viewer light (?viewerLight=on) — retail params, slot-0, zero-world
// ===================================================================
{
  const w = freshWorld({ viewerLight: true });
  w.playerPos.set(10, 3, -4);
  // ZERO world lights: the player light must still occupy slot 0.
  capActiveLightsByDistance(w.scene3d, w.session);
  const slot0 = w.pool.point[0];
  check(
    "6a: with zero world lights, slot 0 = viewer light at player+2 m up",
    slot0.intensity === 2.25 &&
      Math.abs(slot0.position.x - 10) < 1e-6 &&
      Math.abs(slot0.position.y - 5) < 1e-6 &&
      Math.abs(slot0.position.z - -4) < 1e-6,
    `i=${slot0.intensity}, pos=(${slot0.position.x},${slot0.position.y},${slot0.position.z})`
  );
  check(
    "6b: viewer-light params are retail's (falloff 10 × 1.3 = 13, white)",
    Math.abs(slot0.distance - 13) < 1e-6 &&
      slot0.color.r === 1 && slot0.color.g === 1 && slot0.color.b === 1,
    `distance=${slot0.distance}, rgb=(${slot0.color.r},${slot0.color.g},${slot0.color.b})`
  );
  check(
    "6c: constants exported (VIEWER_LIGHT_FALLOFF=10, VIEWER_LIGHT_INTENSITY=2.25)",
    LIGHTING_CONSTANTS.VIEWER_LIGHT_FALLOFF === 10 &&
      LIGHTING_CONSTANTS.VIEWER_LIGHT_INTENSITY === 2.25,
    ""
  );
  // Now add a room lamp NEARER to the player than 0 — viewer still slot 0
  // (dynamic-priority, distSq = -1).
  const a1 = makeLamp("a1", 10.5, 3, -4, ROOM_A);
  w.scene3d.activeLights.push(a1);
  capActiveLightsByDistance(w.scene3d, w.session);
  check(
    "6d: viewer light keeps slot 0 ahead of a nearer room lamp; lamp takes slot 1",
    w.pool.point[0].intensity === 2.25 && w.pool.selPoint[1] === a1,
    `slot0.i=${w.pool.point[0].intensity}`
  );
  // Player moves; feed (no rebuild) must track the viewer position live.
  const rebuilds = w.scene3d._cellLightsStats.rebuilds;
  w.playerPos.set(20, 0, 0);
  capActiveLightsByDistance(w.scene3d, w.session);
  check(
    "6e: viewer light tracks the player between rebuilds (feed path, no rebuild)",
    Math.abs(w.pool.point[0].position.x - 20) < 1e-6 &&
      Math.abs(w.pool.point[0].position.y - 2) < 1e-6 &&
      w.scene3d._cellLightsStats.rebuilds === rebuilds,
    `x=${w.pool.point[0].position.x}, rebuilds=${w.scene3d._cellLightsStats.rebuilds}`
  );
}

// ===================================================================
// 8. fail-soft — no session ⇒ historic pool path (no throw, no scoping)
// ===================================================================
{
  const w = freshWorld();
  const a1 = makeLamp("a1", 2, 0, 0, ROOM_A);
  const b1 = makeLamp("b1", 1, 0, 0, ROOM_B); // nearer, non-visible room
  w.scene3d.activeLights.push(a1, b1);
  let threw = false;
  try {
    capActiveLightsByDistance(w.scene3d); // NO sessionHandle (legacy caller)
  } catch (e) {
    threw = true;
  }
  check(
    "8a: no sessionHandle → no throw; historic nearest-N admits both lamps",
    !threw && w.pool.selPoint.length === 2,
    `threw=${threw}, sel=${w.pool.selPoint.length}`
  );
  // Empty render set (pre-spawn) must also fall through.
  const emptySession = { getRenderSet: () => new Uint32Array(0) };
  let threw2 = false;
  try {
    capActiveLightsByDistance(w.scene3d, emptySession);
  } catch (e) {
    threw2 = true;
  }
  check("8b: empty render set (pre-spawn) → legacy path, no throw", !threw2, "");
}

// ===================================================================
// 9. pool-count invariant (relink-freeze rule) on the cell path
// ===================================================================
{
  const w = freshWorld();
  function countVisibleDynamicLights(group) {
    let n = 0;
    group.traverse((o) => {
      if ((o.isPointLight || o.isSpotLight) && o.visible) n += 1;
    });
    return n;
  }
  const POOL_VISIBLE = 4 + 2;
  const base = countVisibleDynamicLights(w.scene3d.lighting.lightsGroup);
  const a1 = makeLamp("a1", 2, 0, 0, ROOM_A);
  const b1 = makeLamp("b1", 3, 0, 0, ROOM_B);
  w.scene3d.activeLights.push(a1, b1);
  capActiveLightsByDistance(w.scene3d, w.session);
  w.setRenderSet([ROOM_B]);
  capActiveLightsByDistance(w.scene3d, w.session);
  const after = countVisibleDynamicLights(w.scene3d.lighting.lightsGroup);
  check(
    "9a: visible dynamic-light count constant across set changes (6===6; sources stay hidden)",
    base === POOL_VISIBLE && after === POOL_VISIBLE &&
      a1.visible === false && b1.visible === false,
    `base=${base}, after=${after}`
  );
}

// ---- summary --------------------------------------------------------
console.log("=========================");
console.log(`cell-lights test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
