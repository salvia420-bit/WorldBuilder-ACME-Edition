// tests/portal_punch_occlusion_flag.test.mjs — LANE A, 2026-08-14.
//
// The GATE's invariants live in portal_punch_occlusion_gate.test.mjs. This file
// guards the WIRING, which is where the gate was lost for a day, and which is
// pure source structure — no WebGL context, so it runs in the JS tier.
//
// Three things must stay true, each with a failure that has already happened:
//
//  1. The DEFAULT path allocates NOTHING for the gate. On 2026-08-13 a
//     correctly default-OFF feature still made the default composer ask for a
//     stencil attachment, which flips the shared scene depth texture to the
//     packed DepthStencilFormat/UnsignedInt248Type pair; some depth consumer
//     cannot read that, and distant town views went black (mean luma 2.3 vs 62
//     at orbit d=80). It reached master. So: `stencilBuffer` and the packed
//     depth format must be reachable ONLY through an explicitly-named flag,
//     never through `portalPunch` (which is DEFAULT-ON).
//
//  2. `?punchOcclusion=on` must NOT instantiate the retired PortalStencilPass.
//     That scaffold's `tickPortalStencil` parks every visible interior cell on
//     RENDER_LAYER_PORTAL_CELL (layer 2), emptying the layer-1 cells pass that
//     is the punch's entire mechanism — which is exactly why `?portalStencil=on`
//     could never exercise the gate ("reachable but does nothing",
//     HANDOFF-2026-08-13 O-P1).
//
//  3. The flag reader is a STRICT `=== "on"`. A reader coded `!== "off"` reads
//     ON when the parameter is absent — the house footgun (PARITY-LEDGER: "a
//     URL-flag coded !== 'off' reads ON when the param is absent").
//
// Run: node tests/portal_punch_occlusion_flag.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const pipeline = readFileSync(path.join(APP, "scene3d/atmosphere_pipeline.js"), "utf8");
const index = readFileSync(path.join(APP, "scene3d/index.js"), "utf8");
const cells = readFileSync(path.join(APP, "scene3d/cells.js"), "utf8");

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log("  ok  ", name);
}

console.log("portal punch occlusion FLAG wiring");

t("the composer's stencil request is gated on the two flags and nothing else", () => {
  const m = pipeline.match(/stencilBuffer:\s*([^,\n]+),/);
  assert.ok(m, "no `stencilBuffer:` in the EffectComposer options");
  const expr = m[1].trim();
  assert.equal(expr, "!!portalStencil || !!punchOcclusion", `stencilBuffer: ${expr}`);
  // The 2026-08-13 regression, spelled out so a revert to it fails here.
  assert.doesNotMatch(expr, /portalPunch/, "portalPunch is DEFAULT-ON — it must never allocate stencil");
  assert.doesNotMatch(expr, /^\s*true\s*$/, "an unconditional stencil attachment is the blackout");
});

t("the packed depth-stencil format is reachable only through the same two flags", () => {
  const m = pipeline.match(/if \(([^)]*)\) \{\s*\n\s*\/\/ Depth \+ stencil must share ONE packed attachment/);
  assert.ok(m, "the packed-depth branch moved — re-anchor this test");
  const cond = m[1].trim();
  assert.equal(cond, "portalStencil || punchOcclusion", `packed-depth branch reads: ${cond}`);
  assert.doesNotMatch(cond, /portalPunch/);
  // and the default branch must still be the plain pair
  assert.match(pipeline, /sceneDepthTexture\.format = THREE\.DepthFormat;/);
  assert.match(pipeline, /sceneDepthTexture\.type = THREE\.UnsignedIntType;/);
});

t("punchOcclusion does NOT construct the retired PortalStencilPass", () => {
  const m = pipeline.match(/if \(([^)]*)\) \{\s*\n\s*portalStencilPass = new PortalStencilPass/);
  assert.ok(m, "the PortalStencilPass construction guard moved — re-anchor this test");
  assert.equal(m[1].trim(), "portalStencil", "only ?portalStencil may raise the retired scaffold");
});

t("the punch pass still reads its gate off the BUFFER, never off the flag", () => {
  // Arming the gate against a missing stencil attachment makes the EQUAL test
  // fail everywhere and every interior vanishes (the 2026-08-12 regression
  // shape). The pipeline must therefore read the attachment back.
  assert.match(pipeline, /const _punchStencil = composer\.inputBuffer\?\.stencilBuffer === true;/);
  assert.match(pipeline, /new PortalPunchPass\(scene, camera, "punch", \{\s*\n?\s*stencil: _punchStencil,/);
});

t("?punchOcclusion is a STRICT ===\"on\" opt-in (absent ⇒ off)", () => {
  const m = index.match(/punchOcclusion:\s*\n?\s*(.+)/);
  assert.ok(m, "index.js does not pass punchOcclusion to the pipeline");
  const reader = m[1];
  assert.match(reader, /get\("punchOcclusion"\)\?\.toLowerCase\(\) === "on"/, reader);
  assert.doesNotMatch(reader, /!==/, 'a `!== "off"` reader reads ON when the param is absent');
});

t("the punch diag reports the gate's REAL armed state, read off the pass", () => {
  assert.match(cells, /occlusionGated: pass\.occlusionGated === true,/);
});

console.log("");
console.log(`portal punch occlusion flag wiring: ${passed} passed, 0 failed`);
