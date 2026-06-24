// VFX Phase 1 — per-effect flag readers + the master-gate firewall.
//
// Locks: every per-effect flag DEFAULT-OFF; vfxEffectEnabled() requires BOTH the
// ?visual master gate AND the per-effect flag (a per-effect flag alone never
// enables — the firewall); ?visual=all / ?visualAll=on light everything (opt-out
// per effect); the ?visualBudget governor stub parses + clamps; reset hygiene.

import {
  vfxEffectEnabled, vfxActiveEffectIds, VFX_EFFECT_FLAGS,
  glintEnabled, magicGlowEnabled, enchantShimmerEnabled,
  tarnishEnabled, wetnessEnabled, frostEnabled, flameFlickerEnabled, tipFlexEnabled,
  visualAllEffects, visualBudget, _resetVfxFlags,
} from "./scene3d/vfx_flags.js";
import { visualEnabled, _resetVfxCatalog } from "./scene3d/vfx_catalog.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
function setUrl(search) {
  globalThis.window = { location: { search } };
  _resetVfxCatalog(); _resetVfxFlags(); // _resetVfxCatalog clears visualEnabled()'s memo too
}
function clearUrl() { delete globalThis.window; _resetVfxCatalog(); _resetVfxFlags(); }

const ALL_READERS = [glintEnabled, magicGlowEnabled, enchantShimmerEnabled,
  tarnishEnabled, wetnessEnabled, frostEnabled, flameFlickerEnabled, tipFlexEnabled];
const ALL_IDS = Object.keys(VFX_EFFECT_FLAGS);

// ---- the router map is complete ----
check("VFX_EFFECT_FLAGS maps all 14 effect ids (Phase-1 + tipFlex + 6 particle: gemSparkle/brazierEmbers/foliage{Pollen,Fireflies,Leaves}/breathFog)", ALL_IDS.length === 14, ALL_IDS.join());
check("every mapped id has a function reader", ALL_IDS.every((id) => typeof VFX_EFFECT_FLAGS[id] === "function"));

// ---- default OFF (no window) ----
clearUrl();
check("no ?visual: visualEnabled() false", visualEnabled() === false);
check("no flags: every per-effect reader false", ALL_READERS.every((f) => f() === false));
check("no flags: vfxEffectEnabled(all ids) false", ALL_IDS.every((id) => vfxEffectEnabled(id) === false));
check("no flags: visualAllEffects() false", visualAllEffects() === false);
check("no flags: visualBudget() === Infinity (uncapped)", visualBudget() === Infinity);
check("no flags: vfxActiveEffectIds() empty", vfxActiveEffectIds().length === 0);

// ---- ?visual=on alone → master ON but every effect still OFF ----
setUrl("?visual=on");
check("?visual=on: master gate visualEnabled() true", visualEnabled() === true);
check("?visual=on alone: per-effect readers still false", ALL_READERS.every((f) => f() === false));
check("?visual=on alone: vfxEffectEnabled(glint) FALSE (effect not opted in)",
  vfxEffectEnabled("emissive.glint") === false);
check("?visual=on alone: no active effects", vfxActiveEffectIds().length === 0);

// ---- ?visual=on&glint=on → ONLY glint ----
setUrl("?visual=on&glint=on");
check("?visual+?glint: glintEnabled() true", glintEnabled() === true);
check("?visual+?glint: vfxEffectEnabled(glint) true", vfxEffectEnabled("emissive.glint") === true);
check("?visual+?glint: vfxEffectEnabled(tarnish) FALSE (surgical)", vfxEffectEnabled("weathering.tarnish") === false);
check("?visual+?glint: active = [emissive.glint]", vfxActiveEffectIds().join() === "emissive.glint");

// ---- THE FIREWALL: ?glint=on WITHOUT ?visual enables NOTHING ----
setUrl("?glint=on");
check("?glint without ?visual: glintEnabled() reads URL true", glintEnabled() === true);
check("FIREWALL: ?glint without ?visual: vfxEffectEnabled(glint) FALSE", vfxEffectEnabled("emissive.glint") === false);
check("FIREWALL: ?glint without ?visual: no active effects", vfxActiveEffectIds().length === 0);

// ---- ?visual=all → light everything (master + every effect) ----
setUrl("?visual=all");
check("?visual=all: master gate on", visualEnabled() === true);
check("?visual=all: visualAllEffects() true", visualAllEffects() === true);
check("?visual=all: every per-effect reader true", ALL_READERS.every((f) => f() === true));
check("?visual=all: vfxEffectEnabled(all ids) true", ALL_IDS.every((id) => vfxEffectEnabled(id) === true));
check("?visual=all: unknown id falls back to ALL (true)", vfxEffectEnabled("emissive.future") === true);
check("?visual=all: all 14 effects active", vfxActiveEffectIds().length === 14);

// ---- ?visualAll=on alias (composed with ?visual=on) ----
setUrl("?visual=on&visualAll=on");
check("?visualAll=on: visualAllEffects() true", visualAllEffects() === true);
check("?visualAll=on: vfxEffectEnabled(frost) true", vfxEffectEnabled("weathering.frost") === true);

// ---- ?visual=all with a per-effect opt-OUT ----
setUrl("?visual=all&glint=off");
check("?visual=all&glint=off: glintEnabled() false (opt-out wins)", glintEnabled() === false);
check("?visual=all&glint=off: vfxEffectEnabled(glint) false", vfxEffectEnabled("emissive.glint") === false);
check("?visual=all&glint=off: vfxEffectEnabled(tarnish) still true", vfxEffectEnabled("weathering.tarnish") === true);
check("?visual=all&glint=off: 13 effects active", vfxActiveEffectIds().length === 13);

// ---- ?visualAll=on WITHOUT ?visual still firewalled (master off) ----
setUrl("?visualAll=on");
check("FIREWALL: ?visualAll without ?visual: master off ⇒ no active effects", vfxActiveEffectIds().length === 0);

// ---- ?visualBudget governor stub ----
setUrl("?visual=on&visualBudget=10");
check("?visualBudget=10 → 10", visualBudget() === 10);
setUrl("?visual=on&visualBudget=0");
check("?visualBudget=0 → 0 (in range)", visualBudget() === 0);
setUrl("?visual=on&visualBudget=99999");
check("?visualBudget out-of-range → Infinity (def)", visualBudget() === Infinity);
setUrl("?visual=on&visualBudget=abc");
check("?visualBudget garbage → Infinity (def)", visualBudget() === Infinity);
setUrl("?visual=on&visualBudget=-5");
check("?visualBudget negative → Infinity (def, min 0)", visualBudget() === Infinity);

// ---- memoization reset hygiene ----
setUrl("?visual=on&tarnish=on");
check("memo: tarnish true under its URL", vfxEffectEnabled("weathering.tarnish") === true);
clearUrl();
check("memo: reset+clear ⇒ tarnish false again", vfxEffectEnabled("weathering.tarnish") === false);

clearUrl();
console.log(`\nVFX flags + firewall: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
