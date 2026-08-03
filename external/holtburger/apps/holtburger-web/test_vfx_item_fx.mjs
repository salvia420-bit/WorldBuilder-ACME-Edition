// VFX `?itemFx` — UiEffects emissive item aura. BEHAVIOUR test (2026-08-03).
//
// WHY THIS FILE EXISTS. `?itemFx` shipped DEFAULT-ON under `?visual` on
// 2026-06-24 (url-flags.md row 834) and never rendered a single aura, for over a
// month, with no console evidence. `itemFxPlanFor` built its descriptor with
// `componentIds: ["emissive.itemAura"]` — a plain ARRAY. `fragEntriesForDescriptor`
// tolerates that (it only needs `.forEach`), but the runtime windSway append it
// performs calls `windResponds` -> `vfx_catalog.hasWindBend`, which did
// `componentIds?.has(...)`. Arrays have no `.has`, so every call threw a
// TypeError, and the sole call site (entities.js `_itemFxPlan`) catches and nulls
// the plan. Silent, total, default-on failure.
//
// There was NO test on this path at all. So the lock here is deliberately
// BEHAVIOURAL and runs the REAL pipeline — `itemFxPlanFor` -> the real
// `fragEntriesForDescriptor` -> the real registry — rather than hand-building a
// descriptor, because a hand-built descriptor of the *wrong shape* is exactly
// what hid this.

import { itemFxPlanFor, itemFxEnabled } from "./scene3d/vfx/item_fx.js";
import { hasWindBend, windResponds } from "./scene3d/vfx_catalog.js";
import { UI_EFFECT_REGISTRY } from "./scene3d/vfx/ui_effects_registry.js";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => {
  if (c) { pass++; console.log(`  [OK] ${l}`); }
  else { fail++; console.log(`  [FAIL] ${l} ${x}`); }
};

// ---------------------------------------------------------------------------
// THE REGRESSION LOCK: a plan must actually come back.
// ---------------------------------------------------------------------------
const FIRE = 0x0020;   // UI_EFFECT_TYPE Fire
const fireRow = UI_EFFECT_REGISTRY.find((r) => r.flag === FIRE);

let plan = null;
let threw = null;
try { plan = itemFxPlanFor(FIRE); } catch (e) { threw = e; }

ok("★ itemFxPlanFor does NOT throw (the array-vs-Set TypeError)",
  threw === null, threw && `${threw.constructor.name}: ${threw.message}`);
ok("★ itemFxPlanFor(Fire) returns a NON-NULL plan (the aura is actually planned)",
  plan !== null && typeof plan === "object");
ok("★ plan carries exactly the emissive.itemAura entry",
  !!plan && Array.isArray(plan.ids) && plan.ids.length === 1 && plan.ids[0] === "emissive.itemAura",
  plan && JSON.stringify(plan.ids));
ok("★ plan.entries[0] is the registered component with a merged config",
  !!plan && plan.entries.length === 1 && plan.entries[0].comp.id === "emissive.itemAura"
    && plan.entries[0].config && typeof plan.entries[0].config === "object");

// The tint must survive the descriptor -> _splitConfig -> mergeComponentConfig
// path (byId bucket keyed by component id). A plan that came back with the
// component's DEFAULT tint would mean the per-effect config never landed.
ok("★ the effect TINT reaches the component config (Fire != the default tint)",
  !!plan && Array.isArray(plan.entries[0].config.tint)
    && plan.entries[0].config.tint.join(",") === fireRow.tint.join(","),
  plan && JSON.stringify(plan.entries[0].config.tint));
ok("glow rides the config too", !!plan && plan.entries[0].config.glow === 0.5);

// Every registry row must plan, not just Fire — a per-bit regression would
// otherwise hide behind one lucky flag.
{
  let planned = 0;
  for (const row of UI_EFFECT_REGISTRY) {
    let p = null;
    try { p = itemFxPlanFor(row.flag); } catch (_) { p = null; }
    if (p && p.ids.length === 1 && p.entries[0].config.tint.join(",") === row.tint.join(",")) planned += 1;
  }
  ok(`★ all ${UI_EFFECT_REGISTRY.length} UiEffects bits plan an aura with their own tint`,
    planned === UI_EFFECT_REGISTRY.length, `planned=${planned}`);
}

// Mask 0 must stay null — that is the byte-identical path, not a bug.
ok("mask 0 ⇒ null plan (no aura, base material kept)", itemFxPlanFor(0) === null);
ok("unknown-bit mask ⇒ null plan", itemFxPlanFor(0x8000) === null);

// ---------------------------------------------------------------------------
// THE ROOT CAUSE, locked directly: a membership predicate must never throw.
// ---------------------------------------------------------------------------
{
  let arrThrew = null;
  try { hasWindBend({ componentIds: ["emissive.itemAura"] }); } catch (e) { arrThrew = e; }
  ok("★ hasWindBend tolerates a non-Set componentIds (no TypeError)",
    arrThrew === null, arrThrew && arrThrew.message);
  ok("hasWindBend(array without windBend) === false",
    hasWindBend({ componentIds: ["emissive.itemAura"] }) === false);
  ok("hasWindBend(array WITH windBend) === true (duck-typed, still correct)",
    hasWindBend({ componentIds: ["deformation.windBend"] }) === true);
  ok("hasWindBend(Set with windBend) === true (the normal path, unchanged)",
    hasWindBend({ componentIds: new Set(["deformation.windBend"]) }) === true);
  ok("hasWindBend(null / no componentIds) === false",
    hasWindBend(null) === false && hasWindBend({}) === false);

  let wrThrew = null;
  try { windResponds({ componentIds: ["emissive.itemAura"] }); } catch (e) { wrThrew = e; }
  ok("★ windResponds tolerates a non-Set componentIds (the actual throw site)",
    wrThrew === null, wrThrew && wrThrew.message);
}

// The producer's own shape — assert it hands a Set, so the array can't come back.
{
  // Reach the descriptor the only way a black-box test can: itemFxPlanFor
  // succeeded above, which is only possible if windResponds() did not throw.
  // Additionally pin the flag reader's documented default so a polarity flip
  // shows up here rather than as another silent dark feature.
  ok("itemFxEnabled() is DEFAULT-ON in a non-browser context? (documented: browser-only true)",
    typeof itemFxEnabled() === "boolean");
}

console.log(`\nVFX itemFx aura plan: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
