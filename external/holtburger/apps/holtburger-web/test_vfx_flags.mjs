// VFX — per-effect flag readers + the master gate. DEFAULT-ON (2026-06-24): the
// validated suite ships on. Escapes: ?visual=off = master kill-switch (everything
// off); ?visualAll=off drops every per-effect (master stays on); ?<effect>=off opts
// one out; ?<effect>=on re-enables one under ?visualAll=off. vfxEffectEnabled() still
// requires BOTH the master gate AND the per-effect flag.

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
function setUrl(search) { globalThis.window = { location: { search } }; _resetVfxCatalog(); _resetVfxFlags(); }
function clearUrl() { delete globalThis.window; _resetVfxCatalog(); _resetVfxFlags(); }

const ALL_READERS = [glintEnabled, magicGlowEnabled, enchantShimmerEnabled,
  tarnishEnabled, wetnessEnabled, frostEnabled, flameFlickerEnabled, tipFlexEnabled];
const ALL_IDS = Object.keys(VFX_EFFECT_FLAGS);

// ---- the router map is complete ----
check("VFX_EFFECT_FLAGS maps all 14 effect ids", ALL_IDS.length === 14, ALL_IDS.join());
check("every mapped id has a function reader", ALL_IDS.every((id) => typeof VFX_EFFECT_FLAGS[id] === "function"));

// ---- DEFAULT-ON (no window / no flags) ----
clearUrl();
check("no flags: visualEnabled() true (default-on)", visualEnabled() === true);
check("no flags: visualAllEffects() true (default-on)", visualAllEffects() === true);
check("no flags: every per-effect reader true", ALL_READERS.every((f) => f() === true));
check("no flags: vfxEffectEnabled(all ids) true", ALL_IDS.every((id) => vfxEffectEnabled(id) === true));
check("no flags: all 14 effects active", vfxActiveEffectIds().length === 14);
check("no flags: visualBudget() === Infinity (uncapped)", visualBudget() === Infinity);

// ---- ?visual=off → master kill-switch → nothing ----
setUrl("?visual=off");
check("?visual=off: visualEnabled() false", visualEnabled() === false);
check("?visual=off: vfxEffectEnabled(all ids) false", ALL_IDS.every((id) => vfxEffectEnabled(id) === false));
check("?visual=off: no active effects", vfxActiveEffectIds().length === 0);

// ---- ?visual=off dominates a per-effect ?glint=on (master kill wins) ----
setUrl("?visual=off&glint=on");
check("?visual=off&glint=on: master kill wins → glint NOT active", vfxEffectEnabled("emissive.glint") === false);
check("?visual=off&glint=on: no active effects", vfxActiveEffectIds().length === 0);

// ---- ?visualAll=off → master on, EVERY per-effect dropped ----
setUrl("?visualAll=off");
check("?visualAll=off: master still on", visualEnabled() === true);
check("?visualAll=off: visualAllEffects() false", visualAllEffects() === false);
check("?visualAll=off: per-effect readers false", ALL_READERS.every((f) => f() === false));
check("?visualAll=off: no active effects", vfxActiveEffectIds().length === 0);

// ---- ?visualAll=off&glint=on → surgical single re-enable ----
setUrl("?visualAll=off&glint=on");
check("?visualAll=off&glint=on: glint active", vfxEffectEnabled("emissive.glint") === true);
check("?visualAll=off&glint=on: tarnish off (surgical)", vfxEffectEnabled("weathering.tarnish") === false);
check("?visualAll=off&glint=on: active = [emissive.glint]", vfxActiveEffectIds().join() === "emissive.glint");

// ---- per-effect opt-OUT under default-on: ?glint=off ----
setUrl("?glint=off");
check("?glint=off: glintEnabled() false", glintEnabled() === false);
check("?glint=off: vfxEffectEnabled(glint) false", vfxEffectEnabled("emissive.glint") === false);
check("?glint=off: tarnish still active (default-on)", vfxEffectEnabled("weathering.tarnish") === true);
check("?glint=off: 13 effects active", vfxActiveEffectIds().length === 13);

// ---- ?visual=all still forces everything on (explicit) ----
setUrl("?visual=all");
check("?visual=all: all 14 effects active", vfxActiveEffectIds().length === 14);
check("?visual=all: unknown id falls back to ALL (true)", vfxEffectEnabled("emissive.future") === true);

// ---- ?visualBudget governor stub (default-on: no ?visual needed) ----
setUrl("?visualBudget=10");
check("?visualBudget=10 → 10", visualBudget() === 10);
setUrl("?visualBudget=0");
check("?visualBudget=0 → 0 (in range)", visualBudget() === 0);
setUrl("?visualBudget=99999");
check("?visualBudget out-of-range → Infinity (def)", visualBudget() === Infinity);
setUrl("?visualBudget=abc");
check("?visualBudget garbage → Infinity (def)", visualBudget() === Infinity);

// ---- memoization reset hygiene ----
setUrl("?glint=off");
check("memo: glint off under its URL", vfxEffectEnabled("emissive.glint") === false);
clearUrl();
check("memo: reset+clear ⇒ glint active again (default-on)", vfxEffectEnabled("emissive.glint") === true);

clearUrl();
console.log(`\nVFX flags + firewall (default-on): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
