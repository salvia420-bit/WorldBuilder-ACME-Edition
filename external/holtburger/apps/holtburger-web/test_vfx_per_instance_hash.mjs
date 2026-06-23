// VFX Phase 1 / slice 03 — per-instance variation hash (build spec §8).
//
// Verifies the SHARED INFRA that gives frag effects a stable per-object float
// `vVfxHash` WITHOUT a per-instance program and WITHOUT a geometry attribute:
//   - the GLSL is injected idempotently into a three onBeforeCompile shader,
//   - the per-instance source is selected by mesh type (batched/instanced/plain),
//   - the assignment lands AFTER <begin_vertex> (so batchingMatrix is in scope),
//   - the mechanism NEVER touches customProgramCacheKey (the firewall),
//   - the module source is legacy-safe-lint clean.
//
// Pure string surgery + source scan — no three, no WebGL. Runs under bare node
// and the headless harness (TIER1).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureVfxHashVarying,
  hasVfxHashVarying,
  vfxHash01Ref,
  VFX_HASH_VARYING,
  VFX_HASH_ASSIGN_VERTEX,
} from "./scene3d/vfx/per_instance.js";
import { lintSource } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const count = (s, sub) => s.split(sub).length - 1;

// A minimal stand-in for a three MeshStandardMaterial shader, preserving the
// chunk ORDER that matters: <common> (global), then in main() <batching_vertex>
// (declares batchingMatrix) BEFORE <begin_vertex>. Verified against three r184.
function freshShader() {
  return {
    vertexShader: [
      "#include <common>",
      "void main() {",
      "  #include <batching_vertex>",
      "  #include <begin_vertex>",
      "  #include <project_vertex>",
      "}",
    ].join("\n"),
    fragmentShader: [
      "#include <common>",
      "void main() {",
      "  #include <map_fragment>",
      "  #include <emissivemap_fragment>",
      "}",
    ].join("\n"),
  };
}

// ---- shape: the varying + hash are injected into both stages ----
const sh = freshShader();
check("clean shader is not yet patched", !hasVfxHashVarying(sh));
ensureVfxHashVarying(sh);
check("exported varying name is vVfxHash", VFX_HASH_VARYING === "vVfxHash");
check("vertex declares `varying float vVfxHash;`", sh.vertexShader.includes("varying float vVfxHash;"));
check("vertex defines the hash function vfxHash01()", sh.vertexShader.includes("float vfxHash01(vec2 p)"));
check("fragment declares `varying float vVfxHash;`", sh.fragmentShader.includes("varying float vVfxHash;"));
check("hasVfxHashVarying() now true", hasVfxHashVarying(sh));

// ---- ordering: assignment is AFTER <begin_vertex> so batchingMatrix is in scope
const vBegin = sh.vertexShader.indexOf("#include <begin_vertex>");
const vAssign = sh.vertexShader.indexOf("vVfxHash = vfxHash01(");
check("hash assignment lands AFTER #include <begin_vertex>", vBegin >= 0 && vAssign > vBegin);
const vCommon = sh.vertexShader.indexOf("#include <common>");
const vParsFn = sh.vertexShader.indexOf("float vfxHash01(vec2 p)");
check("hash function (PARS) lands after #include <common> and before main work",
  vCommon >= 0 && vParsFn > vCommon && vParsFn < vBegin);

// ---- mesh-type ladder: batched / instanced / plain all covered ----
check("USE_BATCHING branch reads batchingMatrix[3].xy",
  sh.vertexShader.includes("#ifdef USE_BATCHING") && sh.vertexShader.includes("batchingMatrix[3].xy"));
check("USE_INSTANCING branch reads instanceMatrix[3].xy",
  sh.vertexShader.includes("defined( USE_INSTANCING )") && sh.vertexShader.includes("instanceMatrix[3].xy"));
check("fallback (plain Mesh) branch reads modelMatrix[3].xy",
  sh.vertexShader.includes("#else") && sh.vertexShader.includes("modelMatrix[3].xy"));
check("exported assign GLSL has all three branches",
  VFX_HASH_ASSIGN_VERTEX.includes("batchingMatrix[3].xy") &&
  VFX_HASH_ASSIGN_VERTEX.includes("instanceMatrix[3].xy") &&
  VFX_HASH_ASSIGN_VERTEX.includes("modelMatrix[3].xy"));

// ---- idempotency: a second component in the SET reuses the varying ----
ensureVfxHashVarying(sh); // a 2nd frag component's inject() calls it again
ensureVfxHashVarying(sh); // ...and a 3rd
check("vertex varying declared exactly once after repeat calls",
  count(sh.vertexShader, "varying float vVfxHash;") === 1);
check("vertex hash function defined exactly once after repeat calls",
  count(sh.vertexShader, "float vfxHash01(vec2 p)") === 1);
check("vertex assignment ladder present exactly once after repeat calls",
  count(sh.vertexShader, "#ifdef USE_BATCHING") === 1);
check("fragment varying declared exactly once after repeat calls",
  count(sh.fragmentShader, "varying float vVfxHash;") === 1);

// ---- robustness: missing anchors don't throw or corrupt ----
const noAnchor = { vertexShader: "void main(){}", fragmentShader: "void main(){}" };
let safe = true;
try { ensureVfxHashVarying(noAnchor); ensureVfxHashVarying(null); ensureVfxHashVarying({}); }
catch (e) { safe = false; console.log("    threw:", e.message); }
check("ensureVfxHashVarying tolerates missing anchors / bad input", safe);

// ---- FIREWALL: the mechanism never touches customProgramCacheKey ----
const HERE = path.dirname(fileURLToPath(import.meta.url));
const modSrc = fs.readFileSync(path.join(HERE, "scene3d/vfx/per_instance.js"), "utf8");
// Strip comments (block + line) so the rationale comments — which legitimately
// NAME the things we avoid — don't false-positive. Mirrors lint_caps._blankComments.
const modCode = modSrc
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/\/\/[^\n]*/g, "");
check("FIREWALL: CODE never references customProgramCacheKey (comments excluded)",
  !modCode.includes("customProgramCacheKey"));
check("FIREWALL: procedural — CODE creates no aVfxHash InstancedBufferAttribute",
  !modCode.includes("aVfxHash") && !modCode.includes("InstancedBufferAttribute"));
check("injected GLSL never references customProgramCacheKey",
  !sh.vertexShader.includes("customProgramCacheKey") && !sh.fragmentShader.includes("customProgramCacheKey"));

// ---- legacy-safety: module source is denylist-clean ----
const hits = lintSource(modSrc);
check("Layer B: per_instance.js has no forbidden source patterns",
  hits.length === 0, hits.map((h) => `${h.lineno}:${h.label}`).join());

// ---- determinism: the hash is a pure, stable function in [0,1) ----
const a = vfxHash01Ref(123.5, -88.25);
const b = vfxHash01Ref(123.5, -88.25);
check("hash is deterministic (same input -> same output)", a === b);
check("hash output is in [0,1)", a >= 0 && a < 1);
check("distinct placements yield distinct hashes (variety)",
  vfxHash01Ref(10, 20) !== vfxHash01Ref(11, 20) && vfxHash01Ref(10, 20) !== vfxHash01Ref(10, 21));

console.log(`\nVFX per-instance hash: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
