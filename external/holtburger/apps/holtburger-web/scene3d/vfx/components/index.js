// VFX component barrel (Visual-Behavior Suite, Phase 1 / slice 16). Importing
// this module imports every Phase-1 component, each of which self-registers via
// registerComponent() at module load — so after one `import "./components/index.js"`
// the registry is fully populated and frag_attach.fragPlanForDid can resolve any
// DID's frag components. The runtime statics-bake path imports this once (next to
// the animated_scenery → windBend import); tests import it to register the set.
//
// Side-effect-only for registration, but the named re-exports let consumers grab
// a component object directly (e.g. test_vfx_firewall, the legacy-safety audit).
export { windBend } from "./windBend.js";              // deformation (Phase 0, MECH-A)
export { tipFlex } from "./tipFlex.js";                // deformation (Phase 2, MECH-B vertex)
export { tarnish } from "./tarnish.js";                // weathering / frag
export { wetness } from "./wetness.js";                // weathering / frag (channel precip)
export { frost } from "./frost.js";                    // weathering / frag (channel precip)
export { glint } from "./glint.js";                    // emissive / frag
export { magicGlow } from "./magicGlow.js";            // emissive / frag
export { itemAura } from "./itemAura.js";              // emissive / frag (#16 UiEffects aura)
export { enchantShimmer } from "./enchantShimmer.js";  // emissive / frag
export { flameFlicker } from "./flameFlicker.js";      // light (intensity-only)

// The canonical Phase-1 registered-component id set — the legacy-safety audit
// asserts the live registry equals exactly this (no missing barrel export, no
// stray registration).
export const TIER1_COMPONENT_IDS = Object.freeze([
  "deformation.windBend",
  "deformation.tipFlex",
  "weathering.tarnish",
  "weathering.wetness",
  "weathering.frost",
  "emissive.glint",
  "emissive.magicGlow",
  "emissive.itemAura",
  "emissive.enchantShimmer",
  "light.flameFlicker",
]);
