Everything verified: 18/18 on my test, no regression, and `frag_attach.js` correctly sits in `scene3d/vfx/` (infra) so the component scanner doesn't treat it as a component. Here is the deliverable.

---

## Goal

Thread the catalog descriptor's `config{}` + frag `componentIds` into the `statics.js` material-assignment path so `?visual` drives the **right** frag components per DID. At the two build seams, when `?visual && fragPlanForDid(modelId) != null`, swap `materialCache.getCached(surfaceDid)` → the slice‑02 frag variant built from that DID's descriptor plan. Off / no descriptor / no registered frag component ⇒ plan is `null` ⇒ the plain material is kept ⇒ **byte‑identical frozen render**. Coexists with the windBend MECH‑A peel (a DID can carry both).

**Slice boundary (the integration seam):**
- **`frag_attach.js` (mine, descriptor level):** DID → `vfxDescriptorFor` → select *registered* frag components → merge `config` onto each component's `defaults` → FAMILY_ORDER‑sorted plan. Pure; imports only `vfx_catalog.js` + `registry.js`. **Does not import `frag_install.js`** (so it + its test stand alone today).
- **`frag_install.js` (slice 02, shader level):** `buildFragVariant(mc, surfaceDid, entries)` → one cached per‑SET variant via `getCachedVariant`. *I consume its signature; statics.js imports it.*
- **`statics.js` (mine, the wiring):** the two seam edits below.

## Files

### NEW — `scene3d/vfx/frag_attach.js` (written + verified)
Full contents (key surface; the file on disk is the source of truth):

```js
import { vfxDescriptorFor } from "../vfx_catalog.js";
import { getComponent, FAMILY_ORDER } from "./registry.js";

function _orderKey(comp) {
  const fam = FAMILY_ORDER[comp.family];
  return (fam == null ? 99 : fam) * 1000 + 0; // family-major; id breaks ties
}
function _splitConfig(descriptorConfig) {           // byId = plain-object buckets; shared = scalars/arrays
  const shared = {}, byId = {}, cfg = descriptorConfig || {};
  for (const k in cfg) { if (!Object.prototype.hasOwnProperty.call(cfg, k)) continue;
    const v = cfg[k]; if (v && typeof v === "object" && !Array.isArray(v)) byId[k] = v; else shared[k] = v; }
  return { shared, byId };
}
export function mergeComponentConfig(comp, split) {  // defaults < shared < byId[comp.id]
  return { ...(comp.defaults || {}), ...split.shared, ...(split.byId[comp.id] || {}) };
}
export function fragEntriesForDescriptor(descriptor) {
  const ids = descriptor && descriptor.componentIds;
  if (!ids || typeof ids.forEach !== "function") return [];
  const split = _splitConfig(descriptor.config); const out = [];
  ids.forEach((id) => {
    const comp = getComponent(id);
    if (!comp || comp.mech !== "frag") return;                          // registry = authoritative mech
    if (typeof comp.enabled === "function" && !comp.enabled()) return;  // slice-14 per-effect flag hook
    out.push({ comp, config: mergeComponentConfig(comp, split) });
  });
  out.sort((a, b) => { const d = _orderKey(a.comp) - _orderKey(b.comp);
    return d !== 0 ? d : (a.comp.id < b.comp.id ? -1 : a.comp.id > b.comp.id ? 1 : 0); });
  return out;
}
export function fragPlanForDid(did) {
  const entries = fragEntriesForDescriptor(vfxDescriptorFor(did));
  if (entries.length === 0) return null;
  return { entries, ids: entries.map((e) => e.comp.id) };
}
export function isFragDid(did) { return fragEntriesForDescriptor(vfxDescriptorFor(did)).length > 0; }
```

### EDIT — `scene3d/statics.js`

**Seam 0 — import (after `statics.js:96`):**
```js
import { visualEnabled, ensureVfxCatalog, vfxDescriptorFor, hasWindBend } from "./vfx_catalog.js";
// ── ADD ──
// VFX fragment effects (?visual). frag_attach maps a DID's descriptor → its
// registered FRAG components + per-component config ("plan"); frag_install
// (slice 02) turns a plan into the cached per-SET material variant. Plan null
// ⇒ the plain getCached material is kept (byte-identical frozen path).
import { fragPlanForDid } from "./vfx/frag_attach.js";
import { buildFragVariant } from "./vfx/frag_install.js";
```

**Seam 1 — per-LB singleton baker (`statics.js:1726-1730`).** Compute the plan once per placement (the descriptor is keyed by `modelId`, not `surfaceDid`); swap per surface:
```js
    // One node per surface group. Single-surface model → one node
    // (byte-identical to the pre-RP1 fused path); multi-surface model →
    // one node per surface, each painted with its own material.
    // ── ADD: frag plan once per placement (descriptor keyed by modelId). windBend
    //    (MECH-A) DIDs were peeled into windTrees above, so this loop sees only
    //    non-windBend placements; a DID carrying BOTH is handled on the wind path. ──
    const fragPlan = visualEnabled() ? fragPlanForDid(placement.modelId) : null;
    for (const g of groups) {
      let mat = materialCache.getCached(g.surfaceDid);                       // const → let
      // One program per component-SET (firewall): every surface of this DID shares
      // the SAME setKey, so multi-surface models add clones, not programs.
      if (fragPlan) mat = buildFragVariant(materialCache, g.surfaceDid, fragPlan.entries);
```

**Seam 2 — ring instanced/singleton baker (`statics.js:2322-2325`).** One swap before the `if (isInstanced)` branch covers **both** InstancedMesh and Singleton (both read `mat`):
```js
    // RP1 — one node PER SURFACE GROUP. Single-surface model → one node
    // per modelId (byte-identical to the pre-RP1 fused path).
    // ── ADD: frag plan once per model (descriptor keyed by modelId). ──
    const fragPlan = visualEnabled() ? fragPlanForDid(modelId) : null;
    for (const sg of surfaceGroups) {
      let mat = materialCache.getCached(sg.surfaceDid);                      // const → let
      if (fragPlan) mat = buildFragVariant(materialCache, sg.surfaceDid, fragPlan.entries);
```

No other change — `mat` continues into `materialCanCastShadow(mat)` / `buildInstancedNode`/`buildSingletonNode` unchanged. The catalog is already `await ensureVfxCatalog()`'d in the peel block (`statics.js:1599` / `:2123`) before both loops, so no extra fetch.

## GLSL

None in this slice — it is pure JS threading. The descriptor `config` flows to GLSL **as uniform values only**: my merged per‑component config is handed to slice‑02's `buildFragVariant`, which passes each `entry.config` into `comp.declareUniforms(shader, config, VFX_GLOBALS)`. Config scalars therefore reach the shader through `uniform.value`, **never** the program key — honoring the firewall.

## Manifest

`frag_attach.js` is **infra, not a `VisualComponent`** (lives in `scene3d/vfx/`, not `scene3d/vfx/components/`), so it has no registry manifest and is correctly outside the `test_vfx_legacy_safety` component scan (`compDir = scene3d/vfx/components`, confirmed). It is nonetheless RULE‑clean: reads only the offline‑baked descriptor + the live registry (static/derived inputs), writes nothing, no `Math.random`/`Date.now`/`.visible=`/per‑instance cache key. The components it *selects* carry their own legal manifests.

**Config → component defaults mapping** (precedence low→high):

| Layer | Source | Example | Wins on conflict |
|---|---|---|---|
| `comp.defaults` | the component (single source of defaults) | `glint {strength:0.6, metalBias:0.5}` | lowest |
| `shared` | descriptor `config` top‑level **scalars/arrays** | `config.age = 0.4` → all comps | middle |
| `byId[comp.id]` | descriptor `config` top‑level **plain‑object** bucket | `config["emissive.glint"] = {strength:0.9}` | highest |

→ glint sees `{strength:0.9, metalBias:0.5, age:0.4}`; tarnish sees `{tarnish:0.3, tint:0.5, age:0.4}` (no `strength` leak). These values feed `declareUniforms` (uniform values) **and** slice‑02's `configKey` (heap dedup) — not the program key.

## Test

`test_vfx_frag_attach.mjs` (written, **18/18 passing**, `check()`/`process.exit` style; standalone — no slice‑02 dependency). Covers: plan shape; FAMILY_ORDER sort (weathering before emissive); merge precedence (defaults<shared<per‑id) incl. no cross‑component leak; MECH‑A filtered out; **both‑windBend‑+‑glint ⇒ frag‑only plan** (coexistence); fail‑soft (unregistered frag id, unknown DID → `null`); determinism; the slice‑14 `comp.enabled()` gate; and the **statics‑seam predicate mirror** — OFF keeps BASE (no resolver call, byte‑identical), ON swaps frag DIDs to the variant with `(surfaceDid, entries)`, ON keeps BASE for non‑frag DIDs.

```
$ node test_vfx_frag_attach.mjs
  ... 18 [OK] ...
VFX frag-attach threading: 18 passed, 0 failed
```

## Integration notes

- **Composition on the chain.** `fragPlan.entries` are FAMILY_ORDER‑sorted (`weathering`=2 before `emissive`=3), which is exactly the order slice‑02 chains them via `_chainBeforeCompile` under one `__vfxSetKey`. Weathering patches `diffuseColor` after `<map_fragment>` (post‑palette), emissive adds to `totalEmissiveRadiance` after `<emissivemap_fragment>` — independent GLSL seams; the sort only fixes the deterministic chain order so the derived SET key is stable.
- **Firewall (one program per SET).** Plan depends only on the *component set + global config*, never per‑instance state; all instances of a DID get the same `entries` → same `setKey` → one program. A multi‑surface DID makes N material **clones** (one per surfaceDid) that **share one compiled program**. Program count stays O(distinct frag sets) ≈ a handful, not 10k DIDs. Verify via the gauge after each effect lands (program count delta = #new sets).
- **Coexist with the windBend MECH‑A peel.** The peel (`statics.js:1598`/`:2122`) removes `hasWindBend` DIDs into `windTrees` before these loops, so my seams only ever see frag‑bearing **non‑windBend** DIDs (the rigid‑glint archetype: swords/metal — rigid, no wind). Fully covered. **Both‑MECH‑A‑and‑frag** DIDs go to the wind player; the companion seam is `animated_scenery.js:459` (`buildOneWind`): `const mat = await materialCache.get(sid, spFetch);` → after resolving the base, apply `fragPlanForDid(p.modelId)`/`buildFragVariant` the same way. `fragPlanForDid` is reusable there verbatim. **Queued‑for‑1070** (not needed for the Phase‑1 rigid‑glint eye‑test); I left it out of the hot frozen loop deliberately so the two paths stay decoupled.
- **`?flag`.** Gated entirely by existing `visualEnabled()` (`?visual`, default‑OFF). Per‑effect flags (`?glint`, `?tarnish`, …, slice 14) plug in with zero change here via the optional `comp.enabled()` hook — a disabled effect's component drops out of `entries`, shrinking the SET (or nulling the plan) without touching this module.
- **Gauge cost row.** The threading itself is placement‑independent and ~free: one `Map` lookup + a tiny sorted array per placement/model (off‑path: a single memoized boolean), and `buildFragVariant` is memoized by `(surfaceDid|setKey|configKey)`. It adds **0 new cost axes and 0 programs** of its own — the per‑effect rows belong to slice 15's `cost_model.jsonl`. Add a wiring note there: "frag‑attach threading = O(1)/placement, 0 draw calls, 0 programs."

## Risks

- **Slice‑02 signature drift.** I consume `buildFragVariant(mc, surfaceDid, entries)` with `entries: Array<{comp, config}>` (FAMILY_ORDER‑sorted, per‑component merged config). If slice 02 lands `componentSetKey(comps, config)` + a different resolver shape, only the **two `buildFragVariant(...)` call lines + one import** in `statics.js` change — `frag_attach.js` and its test are unaffected. This is the single coordination point; flag at integration.
- **`COMPONENT_MECH` vs registry drift.** I select frag comps by the **live registry** `comp.mech === "frag"` (authoritative), not the catalog's `COMPONENT_MECH` router — so a descriptor naming an unregistered/not‑yet‑flagged frag id is skipped (fail‑soft → `null` → frozen) rather than erroring. Downside: an effect whose component module isn't imported yet silently won't attach; slice 16's audit/registration list (TIER1 registrations) must import every Phase‑1 frag component so they're in the registry.
- **`const`→`let` at two sites.** Trivial but real edits to shared `statics.js`; the byte‑identical guarantee rests on `fragPlan` being `null` whenever `?visual` is off (catalog empty when un‑ensured) — covered by the seam‑mirror test, but worth one eye on the off‑path in review.
- **Multi‑surface clone count.** A frag DID with many surfaces mints one variant clone per surfaceDid (shared program, shared textures). Memory is bounded by surfaces‑per‑frag‑DID × frag‑DIDs; negligible for rigid‑glint but worth watching if a broad weathering effect (wetness/frost, slices 09/10) is later attached via descriptor to high‑surface‑count models — those are global‑uniform effects and may be better applied base‑wide than per‑descriptor (slice 16 to decide).
