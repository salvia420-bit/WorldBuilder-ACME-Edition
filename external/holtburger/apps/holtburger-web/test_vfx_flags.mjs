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
  terrainGrassEnabled, terrainGrassStompEnabled,
  terrainGrassBladeCount, terrainGrassRadiusM, terrainGrassDensity,
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
// Terrain VFX (Wave 0B, 2026-07-31) added router rows that are NOT part of the
// 2026-06-24 DEFAULT-ON suite: every terrain-VFX flag is a STRICT exact-match
// opt-in that ships OFF (plan §2.4/§5.9), so it never tracks visualAllEffects()
// and `?visual=all` does not light it. The DEFAULT-ON count below is therefore
// still 14 — that is the number every "N effects active" assertion means.
const SHIP_OFF_IDS = ALL_IDS.filter((id) => id.startsWith("terrain."));
const DEFAULT_ON_IDS = ALL_IDS.filter((id) => !id.startsWith("terrain."));

// ---- the router map is complete ----
check("VFX_EFFECT_FLAGS maps all 14 DEFAULT-ON effect ids", DEFAULT_ON_IDS.length === 14, DEFAULT_ON_IDS.join());
check("every mapped id has a function reader", ALL_IDS.every((id) => typeof VFX_EFFECT_FLAGS[id] === "function"));
check("the ship-OFF terrain rows are registered (so they don't fall through to visualAllEffects)",
  SHIP_OFF_IDS.length >= 1, SHIP_OFF_IDS.join());
check("no flags: every ship-OFF terrain effect is OFF", SHIP_OFF_IDS.every((id) => vfxEffectEnabled(id) === false));

// ---- DEFAULT-ON (no window / no flags) ----
clearUrl();
check("no flags: visualEnabled() true (default-on)", visualEnabled() === true);
check("no flags: visualAllEffects() true (default-on)", visualAllEffects() === true);
check("no flags: every per-effect reader true", ALL_READERS.every((f) => f() === true));
check("no flags: vfxEffectEnabled(all default-on ids) true", DEFAULT_ON_IDS.every((id) => vfxEffectEnabled(id) === true));
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

// ---- TERRAIN GRASS (Wave 1A) — STRICT opt-ins that ship OFF ----
// Every terrain-VFX flag is an EXACT-match opt-in (plan §2.4/§5.9): it never
// tracks visualAllEffects(), `?visual=all` does not light it, and an
// unrecognised value warns rather than half-enabling. The DEFAULT-ON count
// above must stay 14.
clearUrl();
check("terrain.grass + terrain.grassStomp are registered ship-OFF rows",
  SHIP_OFF_IDS.includes("terrain.grass") && SHIP_OFF_IDS.includes("terrain.grassStomp"));
check("no flags: terrainGrassEnabled() false (ship-OFF)", terrainGrassEnabled() === false);
check("no flags: terrainGrassStompEnabled() false", terrainGrassStompEnabled() === false);
setUrl("?visual=all");
check("?visual=all does NOT light grass (strict opt-in, not a suite effect)",
  vfxEffectEnabled("terrain.grass") === false && vfxActiveEffectIds().length === 14);
setUrl("?terrainGrass=on");
check("?terrainGrass=on: reader true", terrainGrassEnabled() === true);
check("?terrainGrass=on: vfxEffectEnabled(terrain.grass) true", vfxEffectEnabled("terrain.grass") === true);
check("?terrainGrass=on: stomp still off (independent bisection flag)",
  terrainGrassStompEnabled() === false);
setUrl("?terrainGrass=1");
check("?terrainGrass=1 does NOT enable (EXACT `on` only — the gfxRelief rule)",
  terrainGrassEnabled() === false);
setUrl("?visual=off&terrainGrass=on");
check("?visual=off kills grass too (the firewall composition rule)",
  vfxEffectEnabled("terrain.grass") === false);
setUrl("?terrainGrass=on&terrainGrassStomp=on");
check("?terrainGrassStomp=on: stomp reader true", terrainGrassStompEnabled() === true);
setUrl("?terrainGrassBlades=40000&terrainGrassRadius=64&terrainGrassDensity=0.5");
check("?terrainGrassBlades numeric override", terrainGrassBladeCount() === 40000);
check("?terrainGrassRadius numeric override", terrainGrassRadiusM() === 64);
check("?terrainGrassDensity numeric override", terrainGrassDensity() === 0.5);
setUrl("?terrainGrassDensity=9");
check("?terrainGrassDensity out of range (0..2) → default 1", terrainGrassDensity() === 1);
clearUrl();
check("no flags: blade count falls back to the 60025 (245²) high-tier default",
  terrainGrassBladeCount() === 60025);
check("no flags: radius falls back to 48 m", terrainGrassRadiusM() === 48);

// ---- memoization reset hygiene ----
setUrl("?glint=off");
check("memo: glint off under its URL", vfxEffectEnabled("emissive.glint") === false);
clearUrl();
check("memo: reset+clear ⇒ glint active again (default-on)", vfxEffectEnabled("emissive.glint") === true);

clearUrl();
console.log(`\nVFX flags + firewall (default-on): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
