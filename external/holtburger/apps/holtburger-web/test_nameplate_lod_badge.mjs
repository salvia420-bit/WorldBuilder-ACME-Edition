// Batch 12 / #19 — standalone ESM test for buff-badge LOD hiding in
// `scene3d/nameplate_sprite.js`'s `tickNameplateLod`.
//
// Before the fix the out-of-range branch hid the nameplate sprite but
// NOT the sibling `buff_badge_<guid>` child, leaving a stranded "+N"
// chip floating where the name used to be. This test puts one entity far
// out of range (nameplate + visible badge) and one in range, ticks the
// LOD, and asserts the far badge AND its nameplate both go invisible
// while the in-range one keeps its badge visible.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/abs/path/to/three.module.js node test_nameplate_lod_badge.mjs
//
// Same locate-three + factory-load pattern as test_f10_hud_nameplate.mjs.
// tickNameplateLod is DOM-free; it only reads from the scene3d stub and
// toggles `.visible`. We inject THREE + stub ac_font.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
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
  console.log("Batch12 #19 LOD-badge test: SKIP (three not located).");
  console.log("  hint: THREE_PATH=/abs/path/to/three.module.js node test_nameplate_lod_badge.mjs");
  process.exit(0);
}
const THREE = await import("file://" + threePath);

console.log("Batch 12 / #19 — nameplate LOD buff-badge hide test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load nameplate_sprite.js via the factory pattern ----------------
const npPath = resolvePath(__dirname, "scene3d", "nameplate_sprite.js");
let src = readFileSync(npPath, "utf8");
src = src
  .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
  .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']\.\.\/ui\/ac_font\.js["'];?\s*$/m, "")
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+class\s+/gm, "class ");

const factory = new Function(
  "THREE",
  "getAcFont",
  "loadAcFont",
  "renderAcText",
  `${src}\n; return { tickNameplateLod };`,
);
const { tickNameplateLod } = factory(THREE, () => null, async () => null, () => null);

check("tickNameplateLod exported", typeof tickNameplateLod === "function");

// ---- build two synthetic entities ------------------------------------
// Each entity root is a THREE.Object3D positioned in three-world. The
// nameplate sprite (visible=true) is parented to the root, with a
// sibling buff_badge_<guid> sprite (visible=true). After LOD, the FAR
// pair must both be invisible; the NEAR pair must both stay visible.
function makeEntity(guid, worldX, worldZ) {
  const root = new THREE.Object3D();
  root.position.set(worldX, 0, worldZ);
  root.updateMatrixWorld(true);

  const nameplate = new THREE.Sprite();
  nameplate.name = `nameplate_E${guid}`;
  nameplate.visible = true;
  nameplate.userData = { nameplateText: `E${guid}` };
  root.add(nameplate);

  const badge = new THREE.Sprite();
  badge.name = `buff_badge_${guid >>> 0}`;
  badge.visible = true;
  badge.userData = { badgeKey: "1|0|0" };
  root.add(badge);

  root.updateMatrixWorld(true);
  return { guid, root, _nameplateSprite: nameplate, _buffBadgeSprite: badge, badge, nameplate };
}

// NEAR entity at origin; FAR entity 100 m away (NAMEPLATE_VISIBLE_RANGE_M
// defaults to 40 m, so 100 m is comfortably out of range).
const near = makeEntity(0x1001, 0, 0);
const far = makeEntity(0x2002, 100, 100);

const entityMap = new Map([
  [near.guid, near],
  [far.guid, far],
]);

// Camera at the origin so `near` is ~0 m and `far` is ~141 m away.
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
cam.position.set(0, 0, 0);
cam.updateMatrixWorld(true);

const scene3d = {
  camera: cam,
  cameraSwitcher: { activeCamera: cam },
  entityManager: { entityMap },
};

// Sanity: both badges start visible.
check(
  "pre-tick: both badges + nameplates visible",
  near.badge.visible &&
    near.nameplate.visible &&
    far.badge.visible &&
    far.nameplate.visible,
);

const result = tickNameplateLod(scene3d);

// ---- #19 assertions --------------------------------------------------
check(
  "out-of-range entity: nameplate hidden",
  far.nameplate.visible === false,
  `visible=${far.nameplate.visible}`,
);
check(
  "out-of-range entity: buff badge hidden (the #19 fix)",
  far.badge.visible === false,
  `visible=${far.badge.visible}`,
);

// ---- no-regress: in-range entity keeps both visible ------------------
check(
  "in-range entity: nameplate stays visible",
  near.nameplate.visible === true,
  `visible=${near.nameplate.visible}`,
);
check(
  "in-range entity: buff badge stays visible",
  near.badge.visible === true,
  `visible=${near.badge.visible}`,
);
check(
  "tick reported 1 visible / 2 considered (far hidden by range)",
  result.visible === 1,
  `visible=${result.visible}, considered=${result.considered}`,
);

console.log("=========================");
if (failed === 0) {
  console.log("PASS: all Batch 12 #19 LOD-badge checks green.");
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed.`);
  process.exit(1);
}
