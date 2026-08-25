# Phase 2 Handoff — Visual-Behavior Suite (MECH-B deformation) — 2026-06-24

Current to HEAD `4ed2afb7` on `feat/tree-wind-sway-2026-06-23` (PUSHED). Supersedes the
Phase-1 handoff (`docs/PHASE1-INTEGRATION-HANDOFF.md`). Design doc:
`docs/visual-behavior-suite-design-2026-06-23.md` (§8 roadmap, §2.2 mechanisms, §4.1 deform catalog).

---

## 1. State of the world

The suite is a legacy-safe GPU-side visual-effects layer over AC objects. Phases 0 and 1 are
**built, verified, and now pushed**; this session also extended Phase 1 and shipped three orthogonal
features. Phase 2 (MECH-B deformation) is the next increment and is **not started**.

| Phase | What | Status |
|---|---|---|
| **0** — substrate + tree-wind + classifier | `scene3d/vfx/{registry,frag_attach,frag_install,oscillators,per_instance,...}.js`, `vfx_catalog.js`, `lint_caps.js`, the C# classifier (`CommandEngine.Vfx.cs` `vfx classify`/`emit-allowlist`/`gauge`), `getCachedVariant`, `?visual` flag family | ✅ DONE |
| **1** — emissive/material/frag bundle | 8 components: `deformation.windBend`, `weathering.{tarnish,wetness,frost}`, `emissive.{glint,magicGlow,enchantShimmer}`, `light.flameFlicker` — frag/fragment-seam, all default-OFF/byte-identical | ✅ DONE |
| **1+ (this session)** — item magic-effect visuals | extended the suite + shipped orthogonal features (see §2) — all **default-ON** | ✅ DONE, `4ed2afb7` |
| **2** — MECH-B deformation | `tip-flex`, `bow-limb`, `cloth-flutter`, `worn-garment` GPU vertex displacement | ⏳ **NEXT — this handoff** |
| 3 — particle/aura · 4 — texture/detail | per §8 | later |

**Validated state (HEAD):** TIER1 harness 37/37 prior-passing (6 pre-existing fails are not ours);
all VFX tests green (legacy-safety registry == component set, frag-install 34/34, firewall);
`vfx gauge --ref holtburg` STRUCTURAL-PASS; bare-default boot smoke 0 errors. `pkg/` is gitignored →
**rebuild wasm after pull** for the new exports.

---

## 2. What this session ADDED (and why it matters for Phase 2)

The "item magic-effect visuals" work (Burning Sands Katar investigation) committed `4ed2afb7`
extended the Phase-1 frag machinery and shipped orthogonal features. Three of these are
**Phase-2 enablers / precedents** — read them before starting:

- **★ The ENTITY frag seam — `_entityFragMat` (`entities.js`, mirrors `statics.js _fragMat`).** Phase 1's
  frag path was wired into **statics.js only**. This session added the seam to `entities.js`
  `resolveEntityMaterial` (the `getCached` branch). **Phase 2's tip-flex/bow-limb live on WEAPONS,
  which spawn as dynamic ENTITIES** — so deformation must hook the entity material path. That seam now
  exists; Phase 2 extends it for the vertex mech (or reuses it). The paletted `_entityMaterials` branch
  is still un-wired (the `getCachedPalettedVariant` follow-up) — relevant for dyed weapons.
- **★ A SECOND descriptor SOURCE — `item_fx.js itemFxPlanFor(mask)`.** Phase-1 descriptors are DID-keyed
  (the offline classifier → `vfx_catalog.vfxDescriptorFor(did)`). `item_fx` synthesizes a frag plan from a
  live property bitmask instead, feeding the SAME `fragEntriesForDescriptor → buildFragVariant` pipeline.
  Pattern precedent if any Phase-2 effect keys off live substate rather than the offline catalog.
- **`emissive.itemAura`** — a 9th frag component (tint-sourced emissive; 3 scalar tint uniforms + glow).
  Registered in `components/index.js` (export + `TIER1_COMPONENT_IDS` — the legacy-safety audit asserts
  the registry equals that list exactly; a new Phase-2 component MUST be added to BOTH or registration is
  a "stray" failure).
- New wasm getters (all SessionHandle methods or free exports; rebuild required):
  `fetchSetupDefaultScript`, `InventoryItem.uiEffects`, `SessionHandle.entityUiEffects` (+ the
  `UI_EFFECTS_INDEX` recv-loop stash, mirrors `DEFAULT_SCRIPT_INDEX`). Pattern for Phase-2 "read a live
  per-entity value at the spawn seam".

Orthogonal features shipped (NOT part of the suite, default-ON): Track B 3D weapon flame
(`?setupDefaultScript`, honor `SetupModel.default_script` → CreateParticle), Track A UiEffects 2D icon
badges (`?uiEffectIcons`), R1 dyed-luminous glow (`?luminousEmissiveMap`). The aura (`?itemFx`) is
default-ON but **gated by `?visual`** (suite master gate, default-OFF) so the bare client stays retail.

---

## 3. The substrate Phase 2 builds on (verified file:line)

- **MECH-B injection seam:** `materials.js _chainBeforeCompile` injects GLSL at
  `#include <begin_vertex>` to modify `transformed`; `customProgramCacheKey` (`materials.js:282`)
  disambiguates patch sets. This is the **VERTEX** seam — DISTINCT from the Phase-1 frag seam
  (post-`map_fragment`/`emissivemap_fragment` for emissive). Phase 2 = the FIRST vertex-displacement
  components.
- **Component contract** (`vfx/registry.js validateComponent`): `mech ∈ MECHS`, `lightCountDelta:0`,
  `cacheKeyScope ∈ {set,none}`, `linkVariant()` for program-key bits, `reads/writes` caps. Today every
  registered component is `mech:"frag"` (fragment). **Phase 2 needs a vertex/deform mech** and a
  vertex-install path mirroring `frag_install.buildFragVariant` but injecting at `begin_vertex` — OR
  generalize `frag_install` to dispatch on the component's seam. Decide this first (the cleanest is a
  sibling `vertex_install.js` keyed the same way, reusing the `__vfxSetKey` firewall + `getCachedVariant`).
- **The firewall (unchanged, binding):** program-key per component-SET (`__vfxSetKey`); clone-key per
  `(surfaceDid, setKey, configKey)` via `getCachedVariant`; per-instance variety via `hash01`/`aVfxHash`
  — **config + hash NEVER in `customProgramCacheKey`** (link explosion). One program per SET, not per-DID.
- **Grip frame for tip-flex:** `holding_locations` (`setup_model.rs:334`), already surfaced to JS by the
  wield path (`fetchSetupHoldingLocations` / the `_holdingLocCache` in `entities.js`). The axial weight
  ramps 0 at the grip part-origin → 1 at the distal tip.
- **Classifier already emits `tip-flex`** (Phase 0: WeaponType=Spear/Staff + thin-distal aspect) and
  `bow-limb` (Bow/Crossbow). `vfx_catalog` resolves these per-DID. So Phase 2 makes an EXISTING archetype
  RENDER — no new classifier rules needed for the first slice (atlan spear `0x02000724` / weenie 6253 is
  the worked reference).
- **Read-only live substate (for non-tipFlex):** bow `drawAmount` from the client ranged-action substate
  (`entities.js ~1242/2060`, read-only); cloth/garment `velocityHeading` from the entity's heading. Both
  feed a uniform — never written back to the wire.

---

## 4. Phase 2 work-list (ordered, each gated)

> Default-OFF behind a per-effect `?visual`-composed flag (e.g. `?tipFlex`), byte-identical when off,
> integrate flag-OFF-safe locally, QUEUE the batched 1070 eye-test (vertex displacement + normal-recompute
> + flat program count are 1070-only — SwiftShader is blind to it).

1. **P2.1 — vertex mech + install path.** Add a `mech:"vertex"` (or `"deform"`) to the registry contract +
   a vertex-injection path (sibling `vertex_install.js` or a generalized `frag_install`) that injects at
   `#include <begin_vertex>`, reusing `getCachedVariant` + the `__vfxSetKey` firewall. Unit-test the
   firewall (one program per SET) like `test_vfx_frag_install`.
2. **P2.2 — `procMotion.tipFlex` component.** Axial-weighted `begin_vertex` displacement: grip =
   `holding_locations` frame, `ampDeg≈1.5`, `tipWeightCurve:"smoothstep"`, `uTime` sway (oscillator-driven,
   config-invariant GLSL → one program). Add to `components/index.js` export **AND** `TIER1_COMPONENT_IDS`.
3. **P2.3 — wire into BOTH seams.** statics (`statics.js _fragMat`) for placed weapons + **entities
   (`entities.js _entityFragMat`, this session's seam)** for wielded/dropped weapons. Gate
   `visualEnabled() && tipFlexEnabled()`; null plan ⇒ base ⇒ byte-identical.
4. **P2.4 — normal-recompute decision.** Displacing `transformed` invalidates normals (lighting/glint).
   Measure on the 1070: cheap finite-difference normal in-shader vs. accept the lighting drift. The design
   flags this as a 1070 measurement, not a desk decision.
5. **P2.5 — `bow-limb` + `cloth-flutter`/`worn-garment`** (after tipFlex lands): `drawAmount`/
   `velocityHeading` uniforms from read-only substate. Bow string = a CPU MECH-A hinge (separate).
6. **P2.6 — gauge + 1070.** `vfx gauge --ref holtburg` STRUCTURAL-PASS with the new SET; batched 1070
   eye-test (the spear tip whips, off=rigid, program count flat with N spears, no relink).

---

## 5. Constraints (do not violate — the legacy-safe firewall)

An effect READS only static/derived inputs (DAT geometry/Surface/weenie props, server-authoritative
pos/heading, deterministic `hash01`) + the client wall-clock; WRITES only render-time transforms /
cloned-material uniforms the server neither stores nor replicates; NEVER the wire value, physics/collision,
or replicated state. **Desync proof in-tree:** `entities.js` `setPose copy()` STOMPS render-frame writes
every server update, and the collision BSP is untouched — so a vertex displacement can't leak to the wire
or break legacy movement. No light-COUNT change (relink freeze). No per-instance `customProgramCacheKey`
(link explosion). WB.Terminal/classifier work is Opus-4.8-only.

## 6. Done-when

Vertex mech + install path firewall-proven (one program per SET); `procMotion.tipFlex` renders on the
atlan spear (`@create 6253`) at both seams; `=off` byte-identical; harness green (legacy-safety registry
== set incl. the new component, new vertex-install test); gauge STRUCTURAL-PASS; **1070 eye-test PASSED**
(tip whips, rigid when off, flat program count, normal-recompute decision measured). Then `bow-limb` /
`cloth-flutter`, then Phase 3 (particle/aura).

---

## 7. Gotchas carried forward

- `pkg/` is gitignored → rebuild wasm (`capped-build wasm-pack build --target web --out-dir pkg --release`,
  PATH needs `~/.cargo/bin`) after pull; bump the `index.html` `?v=` cache-bust; new free wasm exports must
  be added to BOTH `index.html` wasmExports sites (SessionHandle methods don't need it).
- A new component MUST be in `components/index.js` export **and** `TIER1_COMPONENT_IDS` (legacy-safety
  audit asserts equality).
- 1070 batch headless: ONE session per account (two contexts = "Account In Use"); examine panel needs
  `window.__mainPanel` (absent headless) → drive via getters/probes; use `playwright-core` +
  `executablePath` chromium-1223; quality=low (ultra blocks entity spawn). Tunnel:
  `ssh -fN -R 18765:127.0.0.1:8765 <user>@<gpu-box-ip>`.
- LSD weenies on the laptop = repo-root `external/LSD-Partial-2025-02-23_16-15/weenies` (NOT under
  `external/holtburger`); JSON has `didStats`/`intStats` `[{key,value}]`, no name field → use the filename.
- Reusable DAT walker for archetype hunts: `crates/holtburger-dat/examples/find_luminous_dyed.rs`
  (DatDatabase opens portal.dat once; Setup→GfxObj→Surface). Pattern for a Phase-2 "thin-distal" geometry hunt.
