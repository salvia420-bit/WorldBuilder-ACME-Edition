Both green — no regressions. Code is written and verified. Here is the complete slice deliverable.

---

# SLICE 14 — FLAGS + DOCS: the `?visual` flag family + url-flags.md

## Goal

The single, import-cycle-safe place that resolves **every per-effect VFX flag** for the Phase-1 cheap-fragment family, plus the master-gate firewall and the `?visualBudget` governor stub — all **DEFAULT-OFF**, so the frozen render is byte-identical until each effect is opted in. Plus the exact `docs/url-flags.md` additions (format-matched, NON-RETAIL, Pending-1070). Every emissive/weathering/light installer (slices 02, 05–11, 13) gates on one function: `vfxEffectEnabled(componentId)`.

Decision recorded: the readers live in a **new `scene3d/vfx_flags.js`**, not in `vfx_catalog.js`. Rationale — `vfx_catalog.js` already owns the master gate (`visualEnabled()`) and is touched by slices 02/13; a dedicated module is the single import point for the 7 effect installers, keeps `vfx_catalog.js` diff-free for the catalog slices, and mirrors `tree_wind.js`'s standalone pattern (imports nothing from the scene graph). It imports **only** `visualEnabled` from `vfx_catalog.js` (which imports nothing from the scene3d graph) → no static import cycle.

## Files

### NEW — `scene3d/vfx_flags.js` (full contents, written & test-verified)

The core design (matches `tree_wind.js:15-56` helper shape — `_strFlag`/`_numFlag`, plus a `_boolFlag` and memoized readers):

- `visualAllEffects()` — `?visual=all` OR `?visualAll=on`; the one-URL "light everything" switch (per-effect flags default ON, opt out per effect). DEFAULT-OFF.
- `glintEnabled() / magicGlowEnabled() / enchantShimmerEnabled() / tarnishEnabled() / wetnessEnabled() / frostEnabled() / flameFlickerEnabled()` — one memoized per-effect reader each, default = `visualAllEffects()`.
- `visualBudget()` — governor STUB, default `Infinity` (uncapped), clamp 0..4096.
- `VFX_EFFECT_FLAGS` — frozen `{componentId → reader}` router (the 7 ids).
- **`vfxEffectEnabled(componentId)`** — the one gate: `visualEnabled() && <per-effect flag>`. Master off ⇒ always false (firewall). Unknown id ⇒ `visualAllEffects()` fallback.
- `vfxActiveEffectIds()` — diag/gauge helper (slice 15).
- `_resetVfxFlags()` — test hygiene.

Full file is on disk at `external/holtburger/apps/holtburger-web/scene3d/vfx_flags.js` (143 lines). Key excerpt — the gate the rest of Phase 1 consumes:

```js
import { visualEnabled } from "./vfx_catalog.js";
// ...
export function vfxEffectEnabled(componentId) {
  if (!visualEnabled()) return false;                  // FIREWALL: master gate first
  const reader = VFX_EFFECT_FLAGS[componentId];
  return reader ? reader() : visualAllEffects();        // unknown id → only under ?visual=all
}
```

### EDIT (shared) — `docs/url-flags.md` — two insertions, exact anchors

**(A)** Append the flag-family rows to the **§2 Visual / render flags** table. Anchor = the last row of that table, the `rigModule` row at **`url-flags.md:190`** (immediately before the blank line 191 / `---` line 192). Insert these 13 rows right after line 190:

```markdown
| `visual` | `on`/`all`/`off` | **off** | **NON-RETAIL** Visual-Behavior Suite master gate (Phase 0). `on` enables the descriptor-catalog VFX path (`vfx_catalog.js visualEnabled()`); the per-effect flags below pick WHICH cheap-fragment effects run (each ALSO default-off, gated on BOTH). `=all` = the one-URL "light everything" switch (master ON + every per-effect flag defaults ON; opt out per effect). OFF ⇒ catalog never consulted ⇒ byte-identical frozen render. Pending 1070 eye-test. | scene3d/vfx_catalog.js + scene3d/statics.js |
| `treeWind` | `on` | off | **NON-RETAIL** Phase-0 archetype #1 (MECH-A): AC scenery trees/foliage sway in wind (retail trees are frozen). OFF ⇒ the statics divert never runs ⇒ byte-identical frozen instanced path. Pending 1070 eye-test. | scene3d/tree_wind.js + scene3d/animated_scenery.js + scene3d/statics.js |
| `treeWindStrength` | float 0–4 | 1.0 | Global tree-wind amplitude multiplier (only with `?treeWind=on`). | scene3d/tree_wind.js |
| `treeWindDir` | float −360–360 | 135 (SE) | Tree-wind azimuth in degrees (only with `?treeWind=on`). | scene3d/tree_wind.js |
| `glint` | `on` | off | **NON-RETAIL** emissive.glint — view+time specular sparkle on metal/swords. Requires `?visual`. +0 programs beyond the component set. Pending 1070 eye-test. | scene3d/vfx_flags.js + scene3d/vfx/components/glint.js |
| `magicGlow` | `on` | off | **NON-RETAIL** emissive.magicGlow — ambient emissive glow on magic items (feeds bloom halos free if `?bloom=on`). Requires `?visual`. Pending 1070 eye-test. | scene3d/vfx_flags.js + scene3d/vfx/components/magicGlow.js |
| `enchantShimmer` | `on` | off | **NON-RETAIL** emissive.enchantShimmer — pulsing emissive shimmer on enchanted gear (phase per-instance hash; driven by the oscillator). Requires `?visual`. Pending 1070 eye-test. | scene3d/vfx_flags.js + scene3d/vfx/components/enchantShimmer.js |
| `tarnish` | `on` | off | **NON-RETAIL** weathering.tarnish — metal tarnish/patina + crevice darkening (deterministic per-instance age from hash01(setupDid^instanceHash) + a global age; NEVER the server wear value; post-palette decode). Requires `?visual`. Pending 1070 eye-test. | scene3d/vfx_flags.js + scene3d/vfx/components/tarnish.js |
| `wetness` | `on` | off | **NON-RETAIL** weathering.wetness — global rain sheen (up-facing surfaces darker+glossier; driven by `uWetness` from the weather inputs). Requires `?visual`. Mutually exclusive with `?frost` at runtime. Pending 1070 eye-test. | scene3d/vfx_flags.js + scene3d/vfx/components/wetness.js |
| `frost` | `on` | off | **NON-RETAIL** weathering.frost — winter-zone frost/ice lighten+desaturate+micro-sparkle (driven by `uFrost` from season/temp). Requires `?visual`. Mutually exclusive with `?wetness`. Pending 1070 eye-test. | scene3d/vfx_flags.js + scene3d/vfx/components/frost.js |
| `flameFlicker` | `on` | off | **NON-RETAIL** light.flameFlicker — torch/brazier light `.intensity` jitter via an oscillator (NEVER `.visible`/light-COUNT change — the no-relink rule, lightCountDelta 0). Requires `?visual`. Pending 1070 eye-test. | scene3d/vfx_flags.js + scene3d/vfx/components/flameFlicker.js |
| `visualAll` | `on` | off | **NON-RETAIL** convenience: default every per-effect VFX flag ON (still gated by `?visual`; opt out per effect with `?glint=off` etc.). Alias of `?visual=all`. The batched-eye-test one-URL switch. Pending 1070 eye-test. | scene3d/vfx_flags.js |
| `visualBudget` | int 0–4096 | ∞ (uncapped) | **NON-RETAIL** governor STUB (Phase 1): soft cap on concurrently-active VFX component-sets / per-frame cost the future bloom/light governor (build spec §10/§11) will enforce. Parsed + memoized now; nothing consumes it yet (queued-for-1070). | scene3d/vfx_flags.js |
```

**(B)** Keep the index callout accurate. Anchor = the **`url-flags.md:61`** prose paragraph "**Still opt-in (default-off) on purpose:**", which ends with `…and the texture/palette overrides.`. Append one sentence to that paragraph:

```markdown
 Plus the **Visual-Behavior Suite** (NON-RETAIL, Pending-1070) — the master gate `visual` (`=all` lights everything), the Phase-0 tree-wind family `treeWind`/`treeWindStrength`/`treeWindDir`, the Phase-1 cheap-fragment effects `glint`/`magicGlow`/`enchantShimmer`/`tarnish`/`wetness`/`frost`/`flameFlicker`, the `visualAll` convenience, and the `visualBudget` governor stub — all default-off; the frozen render is byte-identical until each is opted in.
```

> These two are given as diffs (not applied) deliberately: `url-flags.md` is a shared file and 16 agents are live on this branch — applying it now risks clobbering a parallel edit. The new module + test are mine alone and **are written to disk**.

## GLSL

N/A — this slice is flags + docs. No shader seams. (The flags *gate* the GLSL slices 05–11 produce; they don't emit any.)

## Manifest

N/A as a component — `vfx_flags.js` is **not** a `VisualComponent` and is **not** under `scene3d/vfx/components/`, so the `test_vfx_legacy_safety` Layer-B sweep (`compDir = scene3d/vfx/components`, `lint_caps.js:34-35`) does not scan it. It is nonetheless lint-clean by construction against `FORBIDDEN_SOURCE` (`lint_caps.js:43-51`): no `Math.random`, no argless `Date.now`, no `.visible=`, no `wasmExports.enqueue/send/*Collision*`, no `customProgramCacheKey`. Its only side-effect surface is reading `window.location.search` (a derived/static input) and returning booleans/numbers — it never reads the wire and never writes anything. The **firewall it enforces** is the manifest-relevant contract: `vfxEffectEnabled()` is the gate that keeps a per-effect flag from ever, by itself, triggering a `getCachedVariant` build (so program count stays O(component-sets), not O(flags×DIDs)).

## Test

`test_vfx_flags.mjs` (check()/process.exit style, mirrors `test_vfx_catalog.mjs`) — **written & run: 39 passed, 0 failed.** It locks:

- Default-OFF: no window ⇒ every reader false, `vfxEffectEnabled` false for all ids, `visualBudget === Infinity`, no active effects.
- `?visual=on` alone ⇒ master on but every effect still off (no `getCachedVariant` would fire).
- `?visual=on&glint=on` ⇒ **surgical**: only `emissive.glint` active; `weathering.tarnish` stays off.
- **The firewall**: `?glint=on` *without* `?visual` ⇒ `glintEnabled()` reads true from the URL but `vfxEffectEnabled("emissive.glint")` is **false** and no effects activate.
- `?visual=all` ⇒ all 7 active + unknown id falls back to ON; `?visual=all&glint=off` ⇒ opt-out wins (6 active).
- `?visualAll=on` without `?visual` ⇒ still firewalled (master off).
- `?visualBudget` parse/clamp (10→10, 0→0, 99999→∞, garbage→∞, −5→∞).
- Memoization reset hygiene.

Existing suites re-run clean: `test_vfx_catalog.mjs` 14/14, `test_vfx_legacy_safety.mjs` 17/17 (my module touches neither).

## Integration notes

- **Composition / who calls it.** Each effect installer gates on `vfxEffectEnabled(comp.id)` before contributing to the component SET. Concretely:
  - **frag-install (slice 02)** — when building `componentSetKey(comps,config)`, filter `comps` to those where `vfxEffectEnabled(c.id)` is true. This is what keeps the **firewall** intact at the program-key layer: a flag flip changes which components are in the set → which is the existing `__vfxSetKey` clone key, never a per-instance key. Program count = distinct active SETs.
  - **descriptor-config-threading (slice 13)** — at the `statics.js` build sites, the divert already checks `visualEnabled() && hasWindBend(...)` (`statics.js:1603, 2127`). The frag branch adds: `visualEnabled() && descriptor carries a frag component whose vfxEffectEnabled() is true`. A DID can carry BOTH a MECH-A peel and frag components (coexist).
  - **flameFlicker (slice 11)** — it's a light-tick, not a frag component, but reads the same gate via `flameFlickerEnabled()` / `vfxEffectEnabled("light.flameFlicker")`.
- **`vfxActiveEffectIds()`** is the hook slice 15's gauge / eye-test reads to report which effects are live (`window.__vfx?.activeEffects`-style diag).
- **Gauge cost row:** the flags themselves have **no** gauge cost (a flag is a 0-call, placement-independent URL read). The cost_model.jsonl rows for the 7 effects belong to **slice 15**; this slice only supplies the `?flag` that turns each on so the gauge's structural pass can A/B them.
- **`?flag`s shipped here:** `visual` (master, already in `vfx_catalog.js`), `glint`, `magicGlow`, `enchantShimmer`, `tarnish`, `wetness`, `frost`, `flameFlicker`, `visualAll`, `visualBudget`; plus documenting the Phase-0 `treeWind`/`treeWindStrength`/`treeWindDir` (which were live in code but **undocumented** in url-flags.md — closed that gap).
- **Queued-for-1070:** `visualBudget` is a parsed-but-unconsumed STUB — the bloom/light governor (slice 11 / build spec §10) wires it in 1070. Every flag is marked Pending-1070 in the doc; the batched eye-test (slice 15) flips `?visual=all` (or per-effect) and verifies effect-visible + off=byte-identical + no perf regression + gauge structural-pass.

## Risks

- **`?visual=all` semantics double-duty.** `?visual=all` both flips the master gate (via `visualEnabled()`, which already treats any non-off value as on) *and* `visualAllEffects()`. Verified consistent by the test, but if a future slice adds a `?visual=<archetype-name>` selector it must not collide with the literal `all` — documented; low risk.
- **Default-ON-under-`all` for unknown ids.** `vfxEffectEnabled(unknownId)` returns `visualAllEffects()`, so a *future* component with no flag yet will light up under `?visual=all`. This is intentional ("light everything") and stays default-off under plain `?visual=on`, but a new component author must add a `VFX_EFFECT_FLAGS` row to get a surgical opt-in flag. Called out in the module header.
- **wet/frost mutual exclusion is NOT enforced at the flag layer.** Both `?wetness=on&?frost=on` are allowed; the runtime weather decision (slice 12 `uWetness` vs `uFrost`) resolves which is active. If slice 12 doesn't enforce it, you could double-darken. Flag layer documents it; enforcement is slice 09/10/12's.
- **Shared-file `url-flags.md` edit** is supplied as a diff, not applied, to avoid a 16-way parallel clobber — the integrator (slice 16) must land insertion (A) after the current `rigModule` row and (B) on the §61 paragraph; line numbers will drift, so anchor on the row/paragraph text, not the line number.
- **Memoization vs. SPA reloads.** Readers memoize for the page lifetime (same as `tree_wind.js`/`vfx_catalog.js`); a flag change requires a reload. Consistent with every other flag in the client — no new risk.
