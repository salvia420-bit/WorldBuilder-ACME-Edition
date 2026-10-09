// tests/entity_particle_layer.test.mjs — entity particles ride the entity layer (2026-10-09).
//
// Entities draw on the INDOOR layer (1). Their particle meshes defaulted to
// layer 0, so in any dungeon (`?indoorDepthSplit` armed: world pass on layer
// 0 → depth wipe → cells pass on layer 1) the cells painted over every entity
// effect — all 40+ Town Network portal swirls were invisible.
//
//   P1  entityParticleRenderLayer() is 1 by default, 0 with ?indoorParticleLayer=off
//   P2  every entity-anchored addEmitter request passes it (entities.js ×2,
//       play_effect_vfx.js ×1) — a source wiring check
//   P3  ParticleManager keys the instanced bucket by the requested layer and
//       stamps the bucket mesh with it
//
// Run: node tests/entity_particle_layer.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { entityParticleRenderLayer, RENDER_LAYER_INDOOR } = await import("../scene3d/particles/render_layer.js");

let failures = 0;
function t(name, fn) {
  try { fn(); console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

t("P1 default layer 1; ?indoorParticleLayer=off → 0", () => {
  assert.equal(RENDER_LAYER_INDOOR, 1);
  assert.equal(entityParticleRenderLayer(""), 1);
  assert.equal(entityParticleRenderLayer("?indoorParticleLayer=off"), 0);
  assert.equal(entityParticleRenderLayer("?indoorParticleLayer=OFF"), 0);
  assert.equal(entityParticleRenderLayer("?indoorParticleLayer=on"), 1);
});

t("P2 every entity-anchored emitter request passes the entity layer", () => {
  const ent = readFileSync(path.join(APP, "scene3d/entities.js"), "utf8");
  const vfx = readFileSync(path.join(APP, "scene3d/play_effect_vfx.js"), "utf8");
  const count = (src) => (src.match(/renderLayer: entityParticleRenderLayer\(\)/g) || []).length;
  assert.equal(count(ent), 2, "entities.js: default-script + hook-13 requests");
  assert.equal(count(vfx), 1, "play_effect_vfx.js: PlayEffect request");
  assert.match(ent, /import \{ entityParticleRenderLayer \} from "\.\/particles\/render_layer\.js";/);
  assert.match(vfx, /import \{ entityParticleRenderLayer \} from "\.\/particles\/render_layer\.js";/);
});

t("P3 the manager keys buckets by layer and stamps the bucket mesh", () => {
  const pm = readFileSync(path.join(APP, "scene3d/particles/particle_manager.js"), "utf8");
  assert.match(pm, /const layer = emitter\.renderLayer \| 0;/);
  assert.match(pm, /if \(layer > 0\) im\.layers\.set\(layer\);/);
  assert.match(pm, /emitter\.renderLayer = layer;/);
});

console.log(`\n${failures ? `${failures} failed` : "3 passed, 0 failed"}`);
process.exit(failures ? 1 : 0);
