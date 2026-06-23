Everything is verified and passing (27/27, existing tests green). Here is the complete deliverable.

---

## Goal

Build the **frag-component attach path** — the shared infra that, for a static node carrying frag-family components, resolves a *cloned* material variant whose `onBeforeCompile` chain carries every frag component's `declareUniforms` + `inject`, composed in `(FAMILY_ORDER, id)` order under **one** `__vfxSetKey`. This is the firewall enforcement point: **one compiled program per component-SET**, never per-DID. statics.js swaps `materialCache.getCached(surfaceDid)` → the frag variant when `?visual` && the DID's descriptor carries frag components; off ⇒ byte-identical.

Mine alone (created + tested, 27/27 pass): `scene3d/vfx/frag_install.js`, `test_vfx_frag_install.mjs`. Shared-file edits (materials.js, statics.js) given as precise diffs to avoid clobbering the other 15 agents.

## Files

### NEW — `scene3d/vfx/frag_install.js` (full contents, created on disk)

Key design: **THREE-free / import-cycle-safe** (imports only the pure `registry.js` + `vfx_catalog.js`, like `vfx_catalog.js` itself). The host (statics bake) injects `globals` (`VFX_GLOBALS`) and `installComponentPatch` (`materials.js installVfxComponentPatch`) so the firewall material surgery stays inside materials.js and this module stays node-testable. Public API:

- `fragComponentsForDescriptor(descriptor, patchMechs=PATCH_MECHS)` → ordered registered frag components (filters MECH-A/light/particle + unregistered ids; sorts by `(FAMILY_ORDER, id)`).
- `componentSetKey(comps, config)` → program-key bits: ordered ids + each `linkVariant()` token **only** (never config scalars/hashes).
- `fragConfigKey(comps, config)` → link-irrelevant config hash (heap clone-dedup only).
- `resolveFragMaterial({materialCache, surfaceDid, descriptor, globals, installComponentPatch, sharedPrelude?, patchMechs?})` → cloned variant or `null` (null when `!visualEnabled()` / no frag comps / no installer ⇒ caller keeps base ⇒ byte-identical).
- `resolveFragMaterialForDid({...did...})` → catalog-routing wrapper.
- `configForComponent`, `PATCH_MECHS`, `_resetFragInstall` (test seam).

The core resolve body (proves the firewall):

```js
const comps = fragComponentsForDescriptor(descriptor, patchMechs);
if (comps.length === 0) return null;
const cfg = (descriptor && descriptor.config) || {};
const setKey = componentSetKey(comps, cfg);   // program-cache key bits (link only)
const configKey = fragConfigKey(comps, cfg);  // heap-dedup only (NOT in program key)
return materialCache.getCachedVariant(surfaceDid, setKey, configKey, (material) => {
  if (sharedPrelude) installComponentPatch(material, sharedPrelude, undefined, globals); // slice 03 vVfxHash
  for (const comp of comps) {
    installComponentPatch(material, comp, configForComponent(comp, cfg), globals);
  }
});
```

`getCachedVariant` (materials.js:1845) sets `userData.__vfxSetKey = setKey` **before** the builder runs, so the lazily-read `_patchSetCacheKey` (materials.js:262) already reflects the SET; `_chainBeforeCompile` (materials.js:297) installs the lazy `customProgramCacheKey`. Two clones with the same `setKey` share one program; `configKey` only forks the heap object.

### EDIT — `scene3d/materials.js`: add `installVfxComponentPatch` (one new export)

`_chainBeforeCompile` is module-private, so frag components can't chain themselves. Add the single exported helper that keeps the firewall (chain + cache-key) inside materials.js. **Anchor: immediately after the `VFX_GLOBALS` block closes at line 322** (`_chainBeforeCompile` is defined above at 297, in scope):

```js
//  ...line 322: };  (end of `export const VFX_GLOBALS = { ... };`)
+
+// Install ONE frag/MECH-B VFX component's patch onto a getCachedVariant clone
+// (Visual-Behavior Suite, spec §2.3/§2.6). frag_install.js calls this per
+// component in (FAMILY_ORDER, id) order; the chain composition + the
+// __vfxSetKey-driven program-cache key (set by getCachedVariant, read by
+// _patchSetCacheKey) live entirely here so frag_install stays THREE-free.
+// declareUniforms binds VFX_GLOBALS by REFERENCE (shared {value} objects driven
+// once/frame); inject splices the GLSL seam. Both run at compile (inside
+// onBeforeCompile), never at install time — so the shared uniforms are present
+// on shader.uniforms before three builds the program.
+export function installVfxComponentPatch(material, component, config, globals) {
+  if (!material || !component) return;
+  _chainBeforeCompile(material, function vfxComponentHook(shader) {
+    try { component.declareUniforms && component.declareUniforms(shader, config, globals); }
+    catch (e) { console.warn(`[vfx] declareUniforms ${component.id} failed:`, e); }
+    try { component.inject && component.inject(shader, { material: this, config, globals }); }
+    catch (e) { console.warn(`[vfx] inject ${component.id} failed:`, e); }
+  });
+}
```

### EDIT — `scene3d/statics.js`: wire the frag variant at the 2 material sites + 1 batch-key fix

**(a)** Extend the materials import — **line 77**:
```js
-import { MaterialCache, materialCanCastShadow } from "./materials.js";
+import { MaterialCache, materialCanCastShadow, VFX_GLOBALS, installVfxComponentPatch } from "./materials.js";
```
**(b)** Add the frag-install import next to the catalog import (line 96 already imports `visualEnabled, vfxDescriptorFor`):
```js
+import { resolveFragMaterial } from "./vfx/frag_install.js";
```
**(c)** Add one module-level helper (e.g. just below the imports / near `getOrCreateMaterialCache` ~line 375) — the single seam both sites call:
```js
// VFX frag variant (?visual). When the DID's descriptor carries frag components,
// return the per-SET cloned material variant (one program per SET, firewall);
// else the base material. Off / no-frag-descriptor ⇒ base ⇒ byte-identical.
function _fragMatOr(base, materialCache, surfaceDid, did) {
  if (!visualEnabled()) return base;
  const fragMat = resolveFragMaterial({
    materialCache, surfaceDid, descriptor: vfxDescriptorFor(did),
    globals: VFX_GLOBALS, installComponentPatch: installVfxComponentPatch,
  });
  return fragMat || base;
}
```
**(d)** Site 1 — lazy/singleton baker, **line 1730** (`placement` in scope):
```js
-      const mat = materialCache.getCached(g.surfaceDid);
+      const mat = _fragMatOr(materialCache.getCached(g.surfaceDid), materialCache, g.surfaceDid, placement.modelId);
```
**(e)** Site 2 — ring instanced/singleton path, **line 2325** (`modelId` in scope):
```js
-      const mat = materialCache.getCached(sg.surfaceDid);
+      const mat = _fragMatOr(materialCache.getCached(sg.surfaceDid), materialCache, sg.surfaceDid, modelId);
```
**(f)** `?staticBatch` fusion key — `consolidateStaticSingletons`, **line 1454**. Today it groups by `surfaceDid` only; with `?visual` two DIDs sharing a surfaceDid but different frag SETs would fuse into one BatchedMesh and inherit `group[0].material` (wrong set for the rest). Re-key by the **material reference** (same `(surfaceDid|setKey|configKey)` ⇒ same object via getCachedVariant dedup; off ⇒ same shared base per surfaceDid ⇒ identical grouping ⇒ byte-identical):
```js
-      const key = (n.userData.surfaceDid >>> 0);
+      const key = n.material; // material identity = (surfaceDid|setKey|configKey); off ⇒ shared base per surfaceDid (byte-identical)
```
and at line 1489–1490 read `surf` from the group instead of the (now object) map key:
```js
-    bm.userData = { landblockId: lbId, surfaceDid: surf, __staticBatch: true };
-    bm.name = `static-batch-lb${(lbId >>> 0).toString(16)}-s${surf.toString(16).padStart(8, "0")}-x${added}`;
+    const surf = (group[0].userData.surfaceDid >>> 0);
+    bm.userData = { landblockId: lbId, surfaceDid: surf, __staticBatch: true };
+    bm.name = `static-batch-lb${(lbId >>> 0).toString(16)}-s${surf.toString(16).padStart(8, "0")}-x${added}`;
```
(delete the old `for (const [surf, group] ...)` destructure of `surf` — change the loop header at line 1462 to `for (const group of bySurf.values())`.)

## GLSL

frag_install emits **no GLSL of its own** — it composes the components' seam edits. The artifact is the *composed* fragment for a real 2-component emissive SET `{emissive.enchantShimmer, emissive.magicGlow}` (both already on this branch), proving the chain order. Install order = sorted ascending (`enchantShimmer` < `magicGlow`); each prepends after the seam include, so the later-installed line lands **above** ⇒ executes first:

```glsl
#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * uGlow;                              // magicGlow (runs first)
totalEmissiveRadiance *= (1.0 + uEnchantAmp * sin(uTime * uEnchantFreq + vVfxHash * 6.2831853)); // enchantShimmer (after)
```

Glow **adds**, then shimmer **multiplies the sum** — the documented intent. `uTime`/`vVfxHash` are shared (uniform-by-reference / slice-03 varying), so the program is identical for every instance: config scalars (`uGlow`, `uEnchantAmp/Freq`) ride uniforms, never `#define`s. The optional `sharedPrelude` seam declares the per-instance `vVfxHash` varying once at the front of the chain (slice 03 plugs in here), so all reads resolve before the component injects run.

The three canonical seams compose the same way under one `__vfxSetKey`, ordered by `FAMILY_ORDER {deformation:0,texture:1,weathering:2,emissive:3}`: weathering after `#include <map_fragment>` (post-palette `diffuseColor.rgb`), emissive after `#include <emissivemap_fragment>` (`totalEmissiveRadiance += …`), glint/spec after `#include <roughnessmap_fragment>`.

## Manifest

frag_install.js is **infra, not a component** — it has no manifest and is **not** scanned by `test_vfx_legacy_safety` (that harness scans `scene3d/vfx/components/*` only). But it is firewall-load-bearing, so it holds the line for the components it attaches:

- **cacheKeyScope = "set"** is what it *enforces*: `componentSetKey` encodes set membership + `linkVariant()` bits only → fed to `getCachedVariant(... setKey ...)` → `userData.__vfxSetKey` → `_patchSetCacheKey` `"|v"+setKey`. Per-instance variation (config scalars, `aVfxHash`) flows through uniforms/attributes, **never** the cache key.
- Source is clean against `lint_caps.FORBIDDEN_SOURCE`: no `wasmExports.*`, no `setPosition/moveTo/teleport`, no `Math.random`, no argless `Date.now`, no `.visible=`, and `customProgramCacheKey` never sees `guid/instanceHash/aVfxHash`. The `_stableStr` configKey hash is deterministic.
- `installVfxComponentPatch` (materials.js) only mutates a `getCachedVariant` **clone** (`__cacheOwned`, shares textures) — never a shared base, never light count.

## Test

`test_vfx_frag_install.mjs` — pure node (`check()`/`process.exit`), **27/27 pass**. Registers fake frag + MECH-A components into the registry, drives `resolveFragMaterial` through a fake `MaterialCache` that mirrors materials.js (sets `__vfxSetKey` before builder; dedups on `surfaceDid|setKey|configKey`). Locks:

- `(FAMILY_ORDER, id)` ordering of both the key and the install chain; input-order-independence.
- **Firewall**: config scalars do **not** change `setKey` but **do** change `configKey`; `linkVariant()` bits **do** fork `setKey`.
- **Program count ≈ SETs, not DIDs**: 15 resolves over 5 surfaceDids × 3 configs ⇒ **1 distinct setKey** (1 program) but 15 distinct clone keys; a genuinely different SET adds exactly one more.
- MECH-A `windBend` filtered out (coexists); off ⇒ `null`; missing installer ⇒ `null` (fail-soft); `sharedPrelude` installs first without touching `setKey`; catalog routing via `resolveFragMaterialForDid`.

```
VFX frag-install: 27 passed, 0 failed
```
Existing pure-node tests still green: catalog 14/14, legacy-safety 17/17, windBend 11/11.

## Integration notes

- **The firewall — one program per SET.** Program key = `_patchSetCacheKey` = `"...|v"+__vfxSetKey`. `setKey` carries only `(ordered ids + linkVariant tokens)`. Verify after each effect lands: distinct WebGLProgram count tracks distinct component-SETs (a handful), not DID/config count. The test asserts this mechanically; on-device it's the gauge "programs" structural check.
- **Composition order is the contract** other slices already rely on: `_chainBeforeCompile` runs hooks in install order; frag_install installs in `(FAMILY_ORDER, id)` ascending; each seam edit prepends after its `#include`, so earlier-sorted ends up outermost (runs last). `enchantShimmer.js`/`magicGlow.js` are written against exactly this.
- **Coexists with MECH-A windBend (slice 13/16 hand-off).** A DID can carry both. The frozen-statics sites here resolve the frag variant; windBend DIDs are *peeled* to the animated_scenery wind player (statics.js:1598). **Queued-for-1070:** the wind-player build path must also call `resolveFragMaterial` so a peeled tree that *also* has tarnish/glint gets its frag variant — today the peel takes the base material. Flagged for slice 16's sequencing.
- **`?flag`:** gated entirely by `visualEnabled()` (`?visual`, default-OFF) — no new flag of my own. Per-effect flags (slice 14) gate which components a descriptor emits, upstream of here.
- **Component registration:** frag components self-register on import (like `windBend.js`). They must be imported before the first bake. **Queued:** a `scene3d/vfx/components/index.js` barrel importing all frag modules, imported once from the statics-bake module (alongside the existing `animated_scenery.js` → `windBend.js` import). frag_install resolves purely via the registry, so unregistered ids are silently skipped (tested) — the barrel just populates it.
- **Shadow/depth (slice 04):** patches land on the color variant only; `materialCanCastShadow(mat)` already runs on the clone unchanged. The customDepthMaterial stays unpatched — slice 04's concern; nothing here touches it.
- **Gauge cost row** (`VfxData/cost_model.jsonl`, slice 15) — frag_install is placement-independent shared infra:
  | id | drawCalls | programs | uniformsPerFrame | texMem | cpuPerFrame |
  |----|----|----|----|----|----|
  | `infra.fragInstall` | 0 | `+1 per distinct component-SET` | 0 (uniforms bound by ref, driven by oscillator tick) | 0 (clones share textures) | 0 (resolve is bake-time, not per-frame) |

## Risks

- **staticBatch cross-DID fusion (handled, item f).** Without the material-identity re-key, `?visual + ?staticBatch` would apply one DID's frag set to every same-surfaceDid neighbor. The fix is byte-identical when `?visual` is off (shared base object per surfaceDid). If another agent edits `consolidateStaticSingletons` concurrently, this needs a merge.
- **`materials.js` export collision.** If a sibling slice also adds `installVfxComponentPatch`/a similar helper, dedupe to one definition (mine keeps chain+cache-key inside materials.js, which is the firewall requirement).
- **Per-component config namespacing** (`config["emissive.glint"]` vs flat) is a minimal convention here; the authoritative mapping is **slice 13**. If 13 picks a different shape, only `configForComponent` changes — `setKey`/`configKey`/the firewall are unaffected.
- **MECH-B (tipFlex) not yet in `PATCH_MECHS`.** A DID carrying both frag + MECH-B should share one `getCachedVariant` material/setKey. Today MECH-B is a separate vertex path; when it converges, add `"B"` to `PATCH_MECHS` so both compose under one program. Queued-for-1070, flagged for slice 16.
- **`getCachedVariant` swallows builder throws** (materials.js:1855) and returns the clone — a throwing `inject` yields an unpatched-but-cloned material (extra program, no effect) rather than a crash. Acceptable fail-soft; the per-component try/catch in `installVfxComponentPatch` narrows blast radius to the offending component.
