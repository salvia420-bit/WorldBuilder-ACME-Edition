// Bundle the @takram/* packages into single self-contained ESM files under
// vendor/takram/, so index.html's importmap can load them locally (served by
// the laptop no-cache server) instead of as code-split ESM from jsdelivr.
//
// Why: jsdelivr serves these packages code-split (index.js -> shared3.js ->
// shaders.js ...). The 1070 Firefox intermittently fails to fetch the
// sub-chunk graph, which breaks the whole scene3d import (cloud_overlay.js
// statically imports @takram/three-atmosphere). A single bundled file has no
// sub-chunk graph to fail on. (@takram/three-clouds was already vendored this
// way; this extends it to the rest.)
//
// `three`, `postprocessing`, `tiny-invariant` stay external -> resolved by the
// importmap to their single-file CDN builds (reliable; never in the failure
// set). Cross-@takram imports stay external so each vendored file resolves the
// others via the importmap (no duplication, one module instance each).
//
// Reproduce:
//   npm install --no-save esbuild @takram/three-atmosphere@0.19.1 \
//     @takram/three-geospatial@0.9.1 @takram/three-geospatial-effects@0.6.4
//   node scripts/build-vendor-takram.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const external = [
  "three",
  "three/*",
  "postprocessing",
  "tiny-invariant",
  "@takram/three-atmosphere",
  "@takram/three-atmosphere/*",
  "@takram/three-geospatial",
  "@takram/three-geospatial/*",
  "@takram/three-geospatial-effects",
  "@takram/three-geospatial-effects/*",
  "@takram/three-clouds",
  "@takram/three-clouds/*",
];

// [importmap specifier, entry file, output file]
const targets = [
  ["@takram/three-atmosphere", "node_modules/@takram/three-atmosphere/build/index.js", "vendor/takram/three-atmosphere.js"],
  ["@takram/three-atmosphere/shaders/bruneton", "node_modules/@takram/three-atmosphere/build/shaders/bruneton.js", "vendor/takram/three-atmosphere-shaders-bruneton.js"],
  ["@takram/three-geospatial", "node_modules/@takram/three-geospatial/build/index.js", "vendor/takram/three-geospatial.js"],
  ["@takram/three-geospatial/shaders", "node_modules/@takram/three-geospatial/build/shaders.js", "vendor/takram/three-geospatial-shaders.js"],
  ["@takram/three-geospatial-effects", "node_modules/@takram/three-geospatial-effects/build/index.js", "vendor/takram/three-geospatial-effects.js"],
];

for (const [spec, entry, out] of targets) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, out),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external,
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`  ${spec.padEnd(44)} -> ${out}`);
}
console.log("done");
