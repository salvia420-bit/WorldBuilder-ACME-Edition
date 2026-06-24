// VFX firewall unit backstop (Visual-Behavior Suite, Phase 1 / slice 16, P1.16).
//
// THE FIREWALL: one compiled program per component-SET, never per-DID/instance.
// The program-cache key (componentSetKey → __vfxSetKey) carries ONLY ordered
// component ids + each linkVariant() token — never config scalars, vVfxHash,
// guid, or instanceHash. This is the unit proof that program count = O(SETs);
// the REAL flat-program-count proof is the 1070 ?renderDiag walk (queued).
//
// NOTE: componentSetKey does NOT sort its input — it maps in the given order and
// relies on the caller (fragComponentsForDescriptor) to canonicalize. So the
// "order-stable" invariant is tested THROUGH fragComponentsForDescriptor (the
// sorter), which is where descriptor-authoring-order independence actually lives.

import { componentSetKey, fragComponentsForDescriptor, fragConfigKey } from "./scene3d/vfx/frag_install.js";
import "./scene3d/vfx/components/index.js"; // barrel — registers all Phase-1 components
import { getComponent } from "./scene3d/vfx/registry.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const glint = getComponent("emissive.glint");
const tarnish = getComponent("weathering.tarnish");
check("components registered via barrel", !!glint && !!tarnish);

// 1) config-INVARIANT — config scalars never enter the program key.
check("config-INVARIANT: setKey ignores config scalars",
  componentSetKey([glint], { strength: 0.2 }) === componentSetKey([glint], { strength: 0.9 }),
  `${componentSetKey([glint], { strength: 0.2 })} vs ${componentSetKey([glint], { strength: 0.9 })}`);

// 2) order-STABLE — the same SET authored in either descriptor order canonicalizes
//    to one key (the sort lives in fragComponentsForDescriptor, not componentSetKey).
const setAB = fragComponentsForDescriptor({ componentIds: new Set(["emissive.glint", "weathering.tarnish"]) });
const setBA = fragComponentsForDescriptor({ componentIds: new Set(["weathering.tarnish", "emissive.glint"]) });
check("order-STABLE: same SET → same key regardless of descriptor authoring order",
  componentSetKey(setAB, {}) === componentSetKey(setBA, {}),
  `${componentSetKey(setAB, {})} vs ${componentSetKey(setBA, {})}`);
check("canonical order is FAMILY_ORDER (weathering before emissive)",
  componentSetKey(setAB, {}) === "weathering.tarnish+emissive.glint", componentSetKey(setAB, {}));

// 3) distinct SET → distinct key (a real new program; program count tracks SETs).
check("distinct SET → distinct key",
  componentSetKey([glint], {}) !== componentSetKey([glint, tarnish], {}));

// 4) NO per-instance token leaks into the program key (the headline firewall).
const k = componentSetKey([glint, tarnish], { aVfxHash: 0.7, guid: 0xdeadbeef, instanceHash: 0x1234 });
check("NO per-instance token in the program key (config/hash/guid excluded)",
  !/dead|beef|0\.7|aVfxHash|instanceHash|0x1234/i.test(k), k);

// 5) config DOES move the heap-dedup configKey (it just must not touch setKey).
check("config forks configKey (heap dedup) while setKey stays constant",
  fragConfigKey([glint], { strength: 0.2 }) !== fragConfigKey([glint], { strength: 0.9 }) &&
  componentSetKey([glint], { strength: 0.2 }) === componentSetKey([glint], { strength: 0.9 }));

console.log(`\nVFX firewall: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
