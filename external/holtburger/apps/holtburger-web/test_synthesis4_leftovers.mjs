// test_synthesis4_leftovers.mjs (2026-08-01) — pins the perf-synthesis §4
// leftover fixes landed together:
//
//   1. atlas 1K gate reads the RESOLVED quality preset, not the raw ?quality
//      param (gpu-probe/localStorage high boots were keeping the 512 atlas).
//   2. canvas MSAA no longer requested at mid+ by default (`?canvasMsaa=on`
//      escape; `?wireframe=1` keeps preset MSAA — it draws direct-to-canvas).
//   3. `?stableDepthShare=on` (ship-OFF): bespoke composer depth attachment
//      skipped; consumers get pmndrs' StableDepth; setSize path guarded;
//      flag-off arm keeps every legacy line.
//   4. dead `shadows` preset key removed everywhere (no reader existed;
//      `?shadows=on` keeps its own exact-match reader in index.js).
//
// Runs under plain node: `node test_synthesis4_leftovers.mjs`.

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

const indexJs = readFileSync(joinPath(__dirname, "scene3d", "index.js"), "utf8");
const atmoJs = readFileSync(joinPath(__dirname, "scene3d", "atmosphere_pipeline.js"), "utf8");
const qualityJs = readFileSync(joinPath(__dirname, "scene3d", "quality.js"), "utf8");
const urlFlags = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");

// ── 1. atlas gate on resolved preset ───────────────────────────────────────
check("atlas gate reads quality.preset (resolved), not raw ?quality",
  indexJs.includes('const _q = quality.preset;') &&
  !/const _q = \(_ps\.get\("quality"\)/.test(indexJs));

// ── 2. canvas MSAA ─────────────────────────────────────────────────────────
check("renderer antialias gated on wireframeMode || canvasMsaa",
  indexJs.includes("antialias: !!quality.flags.antialias && (wireframeMode || _canvasMsaa)"));
check("canvasMsaa reader is an exact-match opt-in",
  indexJs.includes('get("canvasMsaa") === "on"'));

// ── 3. stableDepthShare ────────────────────────────────────────────────────
check("stableDepthShare reader is an exact-match opt-in",
  atmoJs.includes('get("stableDepthShare") === "on"'));
check("bespoke depth creation is guarded by the flag",
  /if \(!stableDepthShare\) \{\s*\n\s*const _depthBufSize/.test(atmoJs));
check("flag-off arm keeps the bespoke attachments (byte-identical legacy)",
  atmoJs.includes("composer.inputBuffer.depthTexture = sceneDepthTexture;") &&
  atmoJs.includes("composer.outputBuffer.depthTexture = sceneDepthTexture;"));
check("setSize rebuild path returns early under the flag",
  /if \(stableDepthShare\) return;\s*\n\s*const old = composer\.inputBuffer\.depthTexture/.test(atmoJs));
check("getSceneDepthTexture hands out StableDepth under the flag",
  atmoJs.includes("composer.depthRenderTarget ? composer.depthRenderTarget.depthTexture : null"));

// ── 4. dead shadows preset key gone ────────────────────────────────────────
// Behavioral: import the real preset table and assert no tier carries the key.
const { PRESETS, PRESET_NAMES, getQuality } = await import("./scene3d/quality.js");
check("no preset tier carries a shadows key",
  PRESET_NAMES.every((t) => !("shadows" in PRESETS[t])));
check("getQuality flags carry no shadows key (node arm resolves without probe)",
  !("shadows" in getQuality("http://x/?quality=high", "test-ua").flags));
check("BOOL_FLAGS no longer parses shadows (comments excluded)",
  !/BOOL_FLAGS = new Set\(\[[^\]]*"shadows"/.test(
    qualityJs.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
  ));
check("index.js ?shadows=on reader survives untouched",
  indexJs.includes('const raw = params.get("shadows");'));

// ── docs ───────────────────────────────────────────────────────────────────
for (const flag of ["canvasMsaa", "stableDepthShare", "retailSun", "terrainGouraud"]) {
  check(`docs/url-flags.md documents ${flag}`, urlFlags.includes(`| \`${flag}\` |`));
}

console.log("");
console.log(`synthesis-§4 leftovers: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
