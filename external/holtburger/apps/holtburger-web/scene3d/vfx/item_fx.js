// item_fx.js — UiEffects 3D item-aura plan builder (#16, 2026-06-24, NON-RETAIL).
//
// Synthesizes a frag descriptor from an entity's UiEffects bitmask (PropertyInt
// 18) and runs it through the SAME `fragEntriesForDescriptor` → `buildFragVariant`
// machinery the scenery/statics path uses — so the entity-aura material reuses
// the `__vfxSetKey` firewall (ONE program per component-SET, never per-item). The
// aura is `emissive.itemAura`, tinted by the registry's per-effect colour.
//
// Opt-in via `?itemFx` (composed with the `?visual` master gate at the entities.js
// seam). Default OFF / empty mask ⇒ `itemFxPlanFor` returns null ⇒ the seam keeps
// the base material ⇒ byte-identical. This is the non-retail enhancement for
// UiEffects items whose flame is NOT a retail `default_script` particle effect.

import { fragEntriesForDescriptor } from "./frag_attach.js";
import { uiEffectsList } from "./ui_effects_registry.js";
import "./components/itemAura.js"; // ensure the component self-registers

let _itemFxOn;
/** `?itemFx` URL flag — DEFAULT-ON (`=off` opts out; see inline note). Memoized. Safe in non-browser contexts. */
export function itemFxEnabled() {
  if (_itemFxOn === undefined) {
    _itemFxOn = false; // non-browser/test default
    try {
      if (typeof window !== "undefined" && window.location) {
        const v = new URLSearchParams(window.location.search).get("itemFx");
        // 2026-06-24: DEFAULT-ON (`=off` to opt out). NOTE: still gated by the
        // ?visual master suite gate (default-off), so the bare-default client is
        // unchanged — the aura only joins when ?visual is on.
        _itemFxOn = (v == null)
          ? true
          : !(["off", "0", "false", "no"].includes(String(v).toLowerCase()));
      }
    } catch (_) { /* default off in non-browser */ }
  }
  return _itemFxOn;
}

const AURA_GLOW = 0.5; // default emissive aura intensity (clamped (0,2] in the component)

/**
 * Build a frag plan for an entity's UiEffects bitmask, or null when there is
 * nothing to attach. The returned shape matches `fragPlanForDid` exactly
 * (`{entries, ids}`), so the entities.js `_fragMat` seam consumes it unchanged.
 * @param {number} uiEffects  PropertyInt 18 bitmask
 * @returns {{entries:Array<{comp:object,config:object}>, ids:string[]}|null}
 */
export function itemFxPlanFor(uiEffects) {
  const list = uiEffectsList(uiEffects);
  if (!list.length) return null;
  // Census: items carry exactly one flag → use the lowest set bit's tint.
  const row = list[0];
  const descriptor = {
    componentIds: ["emissive.itemAura"],
    // `_splitConfig` keys per-component config by the component id directly.
    config: { "emissive.itemAura": { glow: AURA_GLOW, tint: row.tint } },
  };
  const entries = fragEntriesForDescriptor(descriptor);
  if (!entries.length) return null;
  return { entries, ids: entries.map((e) => e.comp.id) };
}
