// VFX descriptor catalog + descriptor-by-mech router test.
// Updated P4.0c (the S0 severed-channel fix): ?visual is DEFAULT-ON (the suite
// shipped on at f3942a95) and ?visual=off is the byte-identical kill-switch; the
// parser is tolerant of the LIVE classifier shape ({name} components + per-component
// nested config) and a leading UTF-8 BOM. See docs/phase4-bake/.
//
// Locks: ?visual=off ⇒ selects nothing = byte-identical frozen; default/?visual=on
// ⇒ catalog-driven; ?treeWind ⇒ hardcoded allowlist. Tolerant JSONL parse: hex did;
// string, {id}, AND {name} components; nested config hoisted to config[id]; BOM stripped.

import {
  visualEnabled, parseDescriptorsJsonl, setVfxCatalog, _resetVfxCatalog,
  vfxDescriptorFor, hasWindBend, descriptorMechs,
} from "./scene3d/vfx_catalog.js";
import { treeWindEnabled, isTreeDid, _resetTreeWindFlags } from "./scene3d/tree_wind.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
function clearWindow() { delete globalThis.window; _resetTreeWindFlags(); _resetVfxCatalog(); }

// Fixture covering EVERY emitted shape: components as id-STRINGS, as {id} objects,
// and as {name} objects with per-component nested config (the LIVE classifier shape
// the pre-P4.0c parser dropped → the S0 keystone bug). Plus a non-windBend
// (rigid-glint) DID and a particle DID.
const FIXTURE = [
  '{"did":"0x02001063","archetype":"trunk-canopy","components":["deformation.windBend"],"config":{},"confidence":1.0,"source":"allowlist"}',
  '{"did":"0x02001064","archetype":"trunk-canopy","components":[{"id":"deformation.windBend","mech":"A"}],"config":{}}',
  '{"did":"0x020007a2","archetype":"trunk-canopy","components":["deformation.windBend"]}',
  '{"did":"0x02000999","archetype":"rigid-glint","components":["emissive.glint","weathering.tarnish"]}',
  '{"did":"0x02000abc","archetype":"gem-sparkle","components":[{"name":"particle.gemSparkle","channel":"particle","config":{"maxParticles":4,"birthrate":0.45}}]}',
  "# a comment line and a blank line below are ignored",
  "",
].join("\n");

// ---- default ON (the suite shipped default-on) ----
clearWindow();
check("visualEnabled() defaults TRUE (suite default-ON)", visualEnabled() === true);

// ---- tolerant parse ----
const map = parseDescriptorsJsonl(FIXTURE);
check("parse yields 5 descriptors (comment/blank skipped)", map.size === 5, `got ${map.size}`);
check("hex did parsed to number", map.has(0x02001063) && map.has(0x020007a2));
check("string-component descriptor → componentIds has windBend",
  map.get(0x02001063).componentIds.has("deformation.windBend"));
check("{id}-object component descriptor → componentIds has windBend (tolerant)",
  map.get(0x02001064).componentIds.has("deformation.windBend"));
// S0 fix: {name}-object component + nested config (the live classifier shape)
check("{name}-object component → componentIds has gemSparkle (S0 fix)",
  map.get(0x02000abc).componentIds.has("particle.gemSparkle"));
check("nested per-component config HOISTED to config[id] (S0 fix)",
  map.get(0x02000abc).config["particle.gemSparkle"]?.maxParticles === 4);
// BOM: the C# emit writes a leading UTF-8 BOM; a raw read must strip it
const bomMap = parseDescriptorsJsonl("﻿" + '{"did":"0x02001063","components":["deformation.windBend"]}');
check("leading UTF-8 BOM stripped → first descriptor parses", bomMap.has(0x02001063));

// ---- router + lookups ----
setVfxCatalog(map);
check("vfxDescriptorFor(windBend DID) found", !!vfxDescriptorFor(0x02001063));
check("hasWindBend true for trunk-canopy", hasWindBend(vfxDescriptorFor(0x02001063)));
check("hasWindBend false for rigid-glint", !hasWindBend(vfxDescriptorFor(0x02000999)));
check("descriptorMechs(trunk-canopy) = {A}",
  [...descriptorMechs(vfxDescriptorFor(0x02001063))].join() === "A");
check("descriptorMechs(rigid-glint) = {frag}",
  [...descriptorMechs(vfxDescriptorFor(0x02000999))].sort().join() === "frag");
check("descriptorMechs(gem-sparkle) = {particle}",
  [...descriptorMechs(vfxDescriptorFor(0x02000abc))].join() === "particle");
check("vfxDescriptorFor(unknown) = null", vfxDescriptorFor(0x02009999) === null);

// ---- the generalized statics divert predicate (mirrors statics.js isWind) ----
const isWind = (p) => {
  const did = (p?.modelId >>> 0) || 0;
  return (treeWindEnabled() && isTreeDid(did)) ||
         (visualEnabled() && hasWindBend(vfxDescriptorFor(did)));
};
const placements = [
  { modelId: 0x02001063 }, // windBend in catalog AND on hardcoded allowlist
  { modelId: 0x02000999 }, // rigid-glint (no windBend), NOT on allowlist
  { modelId: 0x0200dead }, // neither
];

// ?visual=off → master kill → selects nothing (byte-identical frozen). THE off-trace lock.
globalThis.window = { location: { search: "?visual=off" } }; _resetTreeWindFlags(); _resetVfxCatalog(); setVfxCatalog(map);
check("?visual=off: isWind selects NOTHING → byte-identical frozen", placements.filter(isWind).length === 0);

// default (no flags) → suite default-ON → catalog-driven: the windBend descriptor only
clearWindow(); setVfxCatalog(map);
check("default (no flags, default-ON): isWind selects the windBend descriptor only",
  placements.filter(isWind).map((p) => p.modelId).join() === String(0x02001063));

// ?visual=on → catalog-driven: only the windBend descriptor (1063), not rigid-glint
globalThis.window = { location: { search: "?visual=on" } }; _resetTreeWindFlags(); _resetVfxCatalog(); setVfxCatalog(map);
check("?visual=on: isWind selects the windBend descriptor only",
  placements.filter(isWind).map((p) => p.modelId).join() === String(0x02001063));

// ?treeWind=on with ?visual=off → hardcoded allowlist path (isTreeDid), catalog ignored
globalThis.window = { location: { search: "?treeWind=on&visual=off" } }; _resetTreeWindFlags(); _resetVfxCatalog(); setVfxCatalog(map);
check("?treeWind=on (visual off): isWind uses the hardcoded allowlist (isTreeDid)",
  placements.filter(isWind).map((p) => p.modelId).join() === String(0x02001063));

clearWindow();
console.log(`\nVFX catalog + router: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
