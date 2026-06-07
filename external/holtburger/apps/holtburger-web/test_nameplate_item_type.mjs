// Batch 12 / #25 — standalone ESM test for the ITEM_TYPE bit constants
// in `scene3d/nameplate_sprite.js`. Verifies `categoryForItemType` and
// `nameplateColorForCategory` against the authoritative wire ItemType
// enum (`index.html:4525`). Three of the constants were wrong before
// this fix (WRITABLE 0x00100000, LIFE_STONE 0x04000000, CASTER
// 0x00200000) so Books / Lifestones / Wands fell through to the
// neutral-white "misc" branch.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/abs/path/to/three.module.js node test_nameplate_item_type.mjs
//
// Same locate-three + factory-load pattern as test_f10_hud_nameplate.mjs.
// nameplate_sprite.js imports THREE and ../ui/ac_font.js; we strip both
// imports and inject a stub ac_font (the pure category/colour functions
// touch neither THREE nor the font path). We also delete the
// browser-only module-load blocks (window-guarded) — they no-op under
// the Function() factory because `window` is undefined, but the stripped
// THREE import means `THREE.Sprite` etc. would still be referenced only
// from functions we don't call here.

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

// ---- locate `three` (same pattern as test_f10_hud_nameplate.mjs) -----
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
  console.log("Batch12 #25 ITEM_TYPE test: SKIP (three not located).");
  console.log("  hint: THREE_PATH=/abs/path/to/three.module.js node test_nameplate_item_type.mjs");
  process.exit(0);
}
const THREE = await import("file://" + threePath);

console.log("Batch 12 / #25 — nameplate ITEM_TYPE constants test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load nameplate_sprite.js via the factory pattern ----------------
const npPath = resolvePath(__dirname, "scene3d", "nameplate_sprite.js");
if (!existsSync(npPath)) {
  check("nameplate_sprite.js exists", false, npPath);
  process.exit(1);
}
let src = readFileSync(npPath, "utf8");
// Strip the THREE import (THREE is injected) and the ac_font import
// (stubbed — pure category/colour functions don't touch it).
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
  `${src}\n; return { categoryForItemType, nameplateColorForCategory };`,
);
// Stub ac_font: report "font not ready" + a no-op loader/renderer.
const { categoryForItemType, nameplateColorForCategory } = factory(
  THREE,
  () => null,
  async () => null,
  () => null,
);

check(
  "categoryForItemType + nameplateColorForCategory exported",
  typeof categoryForItemType === "function" &&
    typeof nameplateColorForCategory === "function",
);

// Convenience: itemType → colour, the full pipeline the nameplate uses.
const colourFor = (it) => nameplateColorForCategory(categoryForItemType(it));

// ---- #25 fixed constants --------------------------------------------
check(
  "WRITABLE 0x00002000 → 'writable' → #e09a3f (was misc/#ffffff)",
  categoryForItemType(0x00002000) === "writable" &&
    colourFor(0x00002000) === "#e09a3f",
  `cat=${categoryForItemType(0x00002000)}, colour=${colourFor(0x00002000)}`,
);
check(
  "LIFE_STONE 0x10000000 → 'lifestone' → #4da0e8 (was misc/#ffffff)",
  categoryForItemType(0x10000000) === "lifestone" &&
    colourFor(0x10000000) === "#4da0e8",
  `cat=${categoryForItemType(0x10000000)}, colour=${colourFor(0x10000000)}`,
);
check(
  "CASTER 0x00008000 → 'weapon' (was misc)",
  categoryForItemType(0x00008000) === "weapon",
  `cat=${categoryForItemType(0x00008000)}`,
);

// ---- regression: the values that were already correct ----------------
check(
  "CREATURE 0x00000010 → 'creature' (no-regress)",
  categoryForItemType(0x00000010) === "creature",
  `cat=${categoryForItemType(0x00000010)}`,
);
check(
  "PORTAL 0x00010000 → 'portal' (no-regress)",
  categoryForItemType(0x00010000) === "portal",
  `cat=${categoryForItemType(0x00010000)}`,
);
check(
  "CONTAINER 0x00000200 → 'container' (no-regress)",
  categoryForItemType(0x00000200) === "container",
  `cat=${categoryForItemType(0x00000200)}`,
);
check(
  "MELEE_WEAPON 0x00000001 → 'weapon' (no-regress)",
  categoryForItemType(0x00000001) === "weapon",
  `cat=${categoryForItemType(0x00000001)}`,
);
check(
  "ARMOR 0x00000002 → 'armor' (no-regress)",
  categoryForItemType(0x00000002) === "armor",
  `cat=${categoryForItemType(0x00000002)}`,
);

// ---- guard against the stale values silently re-mapping --------------
// The OLD wrong WRITABLE bit (0x00100000) is NOT in the wire enum, so it
// must now fall through to "misc" — confirms we are not reading the old
// constant.
check(
  "stale WRITABLE bit 0x00100000 → 'misc' (proves new constant is live)",
  categoryForItemType(0x00100000) === "misc",
  `cat=${categoryForItemType(0x00100000)}`,
);
check(
  "PORTAL wins over LIFE_STONE for PortalMagicTarget (Portal|LifeStone)",
  categoryForItemType(0x00010000 | 0x10000000) === "portal",
  `cat=${categoryForItemType(0x00010000 | 0x10000000)}`,
);

console.log("=========================");
if (failed === 0) {
  console.log("PASS: all Batch 12 #25 ITEM_TYPE checks green.");
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed.`);
  process.exit(1);
}
