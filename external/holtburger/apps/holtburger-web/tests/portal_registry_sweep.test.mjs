// tests/portal_registry_sweep.test.mjs — the static portal-anchor registry stays
// bounded without the set piece (2026-10-18 systematic review, VFXAUDIO-4).
// scene3d/vfx/portal_registry.js.
//
// WHY: statics.js registers every static portal anchor whatever the flags, and
// only fx_showcase's scan dropped detached ones — a scan that runs only with
// fxShowcase on and `?portalSetPiece` on. On the low preset (or either `=off`)
// every LRU re-bake added fresh anchors and pinned the evicted ones for the
// session. Registration now sweeps detached anchors whenever the map doubled
// since the last sweep; attached anchors are never dropped.
//
// Run from apps/holtburger-web/: node tests/portal_registry_sweep.test.mjs

import * as THREE from "three";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}

const reg = await import("../scene3d/vfx/portal_registry.js");
const PORTAL = 0x02000c18; // a portal-space hall setup (vfx/portal_setups.js)

reg._resetStaticPortalsForTest();
const group = new THREE.Group();
const resident = [];
for (let i = 0; i < 8; i++) {
  const a = new THREE.Group();
  group.add(a);
  reg.registerStaticPortalAnchor(a, PORTAL);
  resident.push(a);
}
// 50 landblock re-bakes with no set-piece scan: each bake registers a fresh
// anchor, then the LRU evicts it (detached)
let peak = 0;
for (let i = 0; i < 50 * 8; i++) {
  const a = new THREE.Group();
  group.add(a);
  reg.registerStaticPortalAnchor(a, PORTAL);
  group.remove(a);
  peak = Math.max(peak, reg.staticPortalAnchors().size);
}
const map = reg.staticPortalAnchors();
check("4. evicted anchors do not pile up in the registry (bounded across 400 re-bakes)", peak <= 128 && map.size <= 128,
  `peak ${peak}, now ${map.size}`);
check("4. the resident anchors are never swept", resident.every((a) => map.get(a) === PORTAL));
const fresh = new THREE.Group();
group.add(fresh);
check("4. a registration still answers true / false by Setup",
  reg.registerStaticPortalAnchor(fresh, PORTAL) === true && reg.registerStaticPortalAnchor(new THREE.Group(), 0x02000183) === false && map.has(fresh));
reg._resetStaticPortalsForTest();

console.log(`\n[portal_registry_sweep] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
