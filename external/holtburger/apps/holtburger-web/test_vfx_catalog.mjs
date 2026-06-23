// VFX Phase 0 / commit 3 — descriptor catalog + descriptor-by-mech router test.
//
// Locks: ?visual default-OFF; tolerant JSONL parse (hex did, string OR {id}
// components); the mech router; and the generalized statics divert predicate
// (off ⇒ selects nothing = byte-identical frozen; ?visual ⇒ catalog-driven;
// ?treeWind ⇒ hardcoded allowlist).

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

// Fixture in the C# emit shape — hex did; components as id-STRINGS and as {id}
// objects (parser must accept both). Includes a non-windBend (rigid-glint) DID.
const FIXTURE = [
  '{"did":"0x02001063","archetype":"trunk-canopy","components":["deformation.windBend"],"config":{},"confidence":1.0,"source":"allowlist"}',
  '{"did":"0x02001064","archetype":"trunk-canopy","components":[{"id":"deformation.windBend","mech":"A"}],"config":{}}',
  '{"did":"0x020007a2","archetype":"trunk-canopy","components":["deformation.windBend"]}',
  '{"did":"0x02000999","archetype":"rigid-glint","components":["emissive.glint","weathering.tarnish"]}',
  "# a comment line and a blank line below are ignored",
  "",
].join("\n");

// ---- default OFF ----
clearWindow();
check("visualEnabled() defaults FALSE (no ?visual)", visualEnabled() === false);

// ---- tolerant parse ----
const map = parseDescriptorsJsonl(FIXTURE);
check("parse yields 4 descriptors (comment/blank skipped)", map.size === 4, `got ${map.size}`);
check("hex did parsed to number", map.has(0x02001063) && map.has(0x020007a2));
check("string-component descriptor → componentIds has windBend",
  map.get(0x02001063).componentIds.has("deformation.windBend"));
check("{id}-object component descriptor → componentIds has windBend (tolerant)",
  map.get(0x02001064).componentIds.has("deformation.windBend"));

// ---- router + lookups ----
setVfxCatalog(map);
check("vfxDescriptorFor(windBend DID) found", !!vfxDescriptorFor(0x02001063));
check("hasWindBend true for trunk-canopy", hasWindBend(vfxDescriptorFor(0x02001063)));
check("hasWindBend false for rigid-glint", !hasWindBend(vfxDescriptorFor(0x02000999)));
check("descriptorMechs(trunk-canopy) = {A}",
  [...descriptorMechs(vfxDescriptorFor(0x02001063))].join() === "A");
check("descriptorMechs(rigid-glint) = {frag}",
  [...descriptorMechs(vfxDescriptorFor(0x02000999))].sort().join() === "frag");
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

// both flags OFF → selects nothing (frozen)
clearWindow(); setVfxCatalog(map);
check("OFF (no flags): isWind selects NOTHING → frozen", placements.filter(isWind).length === 0);

// ?visual on → catalog-driven: only the windBend descriptor (1063), not rigid-glint
globalThis.window = { location: { search: "?visual=on" } }; _resetTreeWindFlags(); _resetVfxCatalog(); setVfxCatalog(map);
check("?visual=on: isWind selects the windBend descriptor only",
  placements.filter(isWind).map((p) => p.modelId).join() === String(0x02001063));

// ?treeWind on (visual off) → hardcoded allowlist path (isTreeDid), catalog ignored
globalThis.window = { location: { search: "?treeWind=on" } }; _resetTreeWindFlags(); _resetVfxCatalog(); setVfxCatalog(map);
check("?treeWind=on: isWind uses the hardcoded allowlist (isTreeDid)",
  placements.filter(isWind).map((p) => p.modelId).join() === String(0x02001063));

clearWindow();
console.log(`\nVFX catalog + router: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
