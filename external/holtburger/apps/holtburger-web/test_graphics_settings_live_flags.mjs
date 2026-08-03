// R9 / task #153 — every control the Graphics tab renders must be a flag the
// renderer's sanitizer actually keeps.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_graphics_settings_live_flags.mjs
//
// `ui/graphics_settings.js` keeps its own `QUALITY_BOOL_FLAGS` /
// `QUALITY_INT_FLAGS` mirror of `scene3d/quality.js` so it can render controls
// without importing the renderer. The mirror drifted: quality.js dropped
// "shadows" from BOOL_FLAGS on 2026-08-01 (it had no reader), but the panel
// kept listing it AND kept rendering a "Shadows" checkbox that wrote
// `flags.shadows` into `holtburger_graphics_v1` — where quality.js's sanitizer
// silently discards it, since it is in none of the three flag sets. Inert end
// to end, and its display fallback (`shadows: true`) was the OPPOSITE of the
// real default (shadow maps are gated by the default-OFF `?shadows=on` opt-in,
// which has its own exact-match reader in scene3d/index.js).
//
// Adjudicated in the decision block under `BOOL_FLAGS` in scene3d/quality.js:
// REMOVE the control, do NOT rewire it — the panel has been writing
// `shadows: true` since it shipped, so honouring the key would flip shadow
// maps on for every returning user with no GPU measurement behind it.
//
// This test reads the flag sets out of scene3d/quality.js (the authority) and
// fails on ANY future drift in either direction, not just on "shadows".

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

globalThis.window = {};
globalThis.document = {
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, classList: { add() {}, toggle() {} } }),
  addEventListener: () => {},
};

const { __test_only } = await import(
  "file://" + resolvePath(__dirname, "ui/graphics_settings.js")
);

// Pull the authority's flag sets straight out of the source. Comment lines are
// stripped first so the commented-out `// "shadows"` tombstone is not counted.
function readFlagSet(src, name) {
  const m = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(src);
  if (!m) throw new Error(`could not find ${name} in scene3d/quality.js`);
  return new Set(
    m[1]
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((x) => x[1])),
  );
}
const qualitySrc = readFileSync(resolvePath(__dirname, "scene3d/quality.js"), "utf8");
const BOOL_FLAGS = readFlagSet(qualitySrc, "BOOL_FLAGS");
const INT_FLAGS = readFlagSet(qualitySrc, "INT_FLAGS");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} — ${detail}`); }
}

console.log("===========================================================");
console.log("R9 / #153 — Graphics tab renders no dead controls");
console.log("===========================================================");

check("scene3d/quality.js BOOL_FLAGS parsed", BOOL_FLAGS.size > 5, `size=${BOOL_FLAGS.size}`);
check("scene3d/quality.js INT_FLAGS parsed", INT_FLAGS.size > 0, `size=${INT_FLAGS.size}`);

check(
  "quality.js no longer keeps `shadows` (the premise of this test)",
  !BOOL_FLAGS.has("shadows"),
  "quality.js re-added shadows — re-adjudicate before changing the panel",
);

const deadBools = __test_only.QUALITY_BOOL_FLAGS.filter((f) => !BOOL_FLAGS.has(f));
check("every panel bool control survives the quality.js sanitizer",
  deadBools.length === 0, `dead: ${JSON.stringify(deadBools)}`);

const deadInts = __test_only.QUALITY_INT_FLAGS.filter((f) => !INT_FLAGS.has(f));
check("every panel int control survives the quality.js sanitizer",
  deadInts.length === 0, `dead: ${JSON.stringify(deadInts)}`);

check("panel no longer lists `shadows`",
  !__test_only.QUALITY_BOOL_FLAGS.includes("shadows"),
  JSON.stringify(__test_only.QUALITY_BOOL_FLAGS));

// The display fallback must not advertise a shadows default either — the real
// gate is the default-OFF `?shadows=on` opt-in.
const fallback = __test_only.effectiveFlags({});
check("effectiveFlags() fallback carries no `shadows` key",
  !("shadows" in fallback), `shadows=${fallback.shadows}`);

// And the panel source must not render a Shadows checkbox any more.
const panelSrc = readFileSync(resolvePath(__dirname, "ui/graphics_settings.js"), "utf8");
const rendersShadowRow = /boolRow\(\s*"Shadows"/.test(panelSrc);
check("no boolRow(\"Shadows\", ...) left in the panel", !rendersShadowRow);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
