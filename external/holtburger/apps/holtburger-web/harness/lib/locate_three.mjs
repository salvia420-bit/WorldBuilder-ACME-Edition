// harness/lib/locate_three.mjs — the ONE way a headless suite gets `three`.
//
// WHY THIS EXISTS (2026-08-03 review, finding F2)
// ----------------------------------------------
// Two different `locateThree()` implementations had drifted across the suite.
// The good one (test_particles.mjs) fell back to `require.resolve("three")`,
// which resolves fine because `three` is a real dependency in the app's
// node_modules. The degenerate one read ONLY `process.env.THREE_PATH` and
// otherwise returned null:
//
//     function locateThree() {
//         if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
//             return process.env.THREE_PATH;
//         }
//         return null;                       // <-- no fallback
//     }
//     if (!threePath) { console.log("… SKIP (three not located)."); process.exit(0); }
//
// Six suites carried the degenerate copy, so the invocation printed in each
// file's own header (`node test_visfid_p33_csm.mjs`) was an unconditional
// exit-0 that asserted nothing — and four of them were additionally BROKEN
// underneath, which the skip hid. Two of those six were cited in a fix
// document as green regression evidence.
//
// Rules encoded here:
//   * `three` is a declared dependency, so "not located" is an ENVIRONMENT
//     FAULT, not a reason to report success. `requireThree()` exits 1.
//   * Prefer the ESM build (`three.module.js`) — these suites were written
//     against it and several read named exports directly.
//   * `require.resolve("three")` yields the CJS build on this layout, whose
//     namespace puts everything under `.default`; `importThree()` unwraps it
//     so either build works.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// harness/lib -> harness -> apps/holtburger-web
const APP_ROOT = resolve(HERE, "..", "..");
const require = createRequire(import.meta.url);

/** Absolute path to a loadable three build, or null. */
export function locateThree() {
  // 1. Explicit override always wins.
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
    return process.env.THREE_PATH;
  }
  // 2. The app's own dependency, ESM build (what these suites expect).
  const esm = join(APP_ROOT, "node_modules", "three", "build", "three.module.js");
  if (existsSync(esm)) return esm;
  // 3. Whatever node resolves (may be the CJS build — importThree unwraps).
  try {
    return require.resolve("three");
  } catch (_) { /* fall through */ }
  // 4. Legacy npx caches, matching the pre-existing candidate scan.
  try {
    const npxRoot = join(process.env.HOME ?? "", ".npm", "_npx");
    if (existsSync(npxRoot)) {
      for (const dir of require("node:fs").readdirSync(npxRoot)) {
        const p = join(npxRoot, dir, "node_modules", "three", "build", "three.module.js");
        if (existsSync(p)) return p;
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

/**
 * Import three from `p`, normalising CJS-vs-ESM namespace shape.
 * The CJS build's namespace exposes the library under `.default`.
 */
export async function importThree(p) {
  const mod = await import("file://" + p);
  return mod.Object3D ? mod : (mod.default ?? mod);
}

/**
 * Locate + import three, or EXIT 1 with a diagnostic.
 *
 * Deliberately not a soft skip: `three` is in package.json, so its absence is
 * a broken environment and a suite that "passes" without it is lying. Set
 * `ALLOW_MISSING_THREE=1` to opt into the old skip-and-exit-0 behaviour for a
 * genuinely three-less environment.
 */
export async function requireThree(suiteLabel) {
  const p = locateThree();
  if (p) return await importThree(p);
  const label = suiteLabel ? `${suiteLabel}: ` : "";
  if (process.env.ALLOW_MISSING_THREE === "1") {
    console.log(`${label}SKIP (three not located; ALLOW_MISSING_THREE=1).`);
    process.exit(0);
  }
  console.error(
    `${label}FAIL — could not locate 'three'.\n` +
    `  'three' is a declared dependency of apps/holtburger-web; a missing copy is a\n` +
    `  broken environment, not a passing test. Fix it with one of:\n` +
    `    npm install            (from apps/holtburger-web)\n` +
    `    THREE_PATH=/abs/path/to/three.module.js node <this test>\n` +
    `  To deliberately skip on a three-less box: ALLOW_MISSING_THREE=1.`
  );
  process.exit(1);
}
