# VFX (Visual-Behavior Suite) — build progress log

Implementing the §17 build order from `docs/visual-suite-spec/VISUAL-SUITE-BUILD-SPEC.md`
(source copy: `~/from-vm/visual-suite-brainstorm-2026-06-23/`). Design doc:
`docs/visual-behavior-suite-design-2026-06-23.md`. Branch: `feat/tree-wind-sway-2026-06-23`.
Driven by a self-paced `/loop`. Commits are LOCAL only (no push until asked).

Legend: `[JS]` locally verifiable · `[C#]` WB.Terminal (BUILD-UNVERIFIED locally) · `[WASM]` Rust rebuild (buildbox) · `[bake]` offline.

## Phase 0 — minimal vertical slice
Spec-commit 1 is split into 1a/1b/1c for small, safe, individually-verifiable steps.

- [x] **1a — VFX component registry + contract + `deformation.windBend`** `[JS]` ✅ verified
  - New: `scene3d/vfx/registry.js` (the VisualComponent contract + `registerComponent`/`validateComponent`/`getComponent`, `FAMILY_ORDER`, legacy-safety read/write vocab enforced at register time), `scene3d/vfx/components/windBend.js` (MECH-A; wraps `buildBboxRig`+`buildTreeWindClip`).
  - Test `test_vfx_windbend.mjs`: buildClip **byte-identical** to the inline tree-wind math; registry **rejects** lightCountDelta!=0, cacheKeyScope=instance, and non-render writes (the firewall corollaries).
  - Touches NO existing runtime → zero risk to the working tree-wind. `?treeWind` unchanged.
  - **Adjudication:** the design doc's `procMotion.windBend` family isn't in the build-spec §2.2 enum (deformation|weathering|emissive|texture|particle). Standardized to **family `deformation`, mech `A`, id `deformation.windBend`**. The C# classifier (1b/commit-2) must emit this same id.
- [x] **1b — dormant material substrate** `[JS]` ✅ verified — in `materials.js`: `VFX_GLOBALS` (5 shared uniforms, exported), the single `_patchSetCacheKey` `|v + __vfxSetKey` line (constant `"|v"` suffix on every key when unset → no behavior change), `vfxVariants` Map (ctor) + `getCachedVariant` (mirrors `getCachedFloorBias`) + dispose walk. Inert until a frag/MECH-B component uses it. Test `test_vfx_material_substrate.mjs` 6/6; `test_materials_paletted_lru` no regression.
  - **Follow-up (deferred to first frag commit):** per-DID invalidation of `vfxVariants` (the LRU `floorBiasMaterials.delete(did)` twins at materials.js ~2602/~3238 don't yet clear `vfxVariants` entries whose key starts with `${did}|`). Harmless while dormant.
- [x] **1c — runtime rewire** `[JS]` ✅ verified — `animated_scenery.js getOrCreateWindGroup` now calls `windBend.buildClip({numParts, rig}, windParams)` instead of `buildTreeWindClip` directly (removed the now-unused import; added the `windBend` import). `windBend.buildClip` accepts a precomputed rig OR derives one from partBoxes. Test asserts `buildClip({numParts,rig}) == partBoxes-path == old inline call` byte-for-byte → the live tree-wind is unchanged. `test_vfx_windbend` 11/11; `test_animated_scenery` + all wind tests no regression.
  - **✅ Spec-commit 1 (1a+1b+1c) COMPLETE: the shipped tree-wind now flows through the VFX component system, byte-identical.**
- [ ] **Commit 2 — C# classifier + descriptor schema** `[C#]` BUILD-UNVERIFIED — `VisualDescriptor.cs` + `visual_archetype_rules.jsonl` (3 archetypes + `rigid`) + `CommandEngine.Vfx.cs` `vfx classify`/`emit-allowlist`. Exit: `emit-allowlist trunk-canopy` reproduces `TREE_WIND_DIDS`. Will hand-author a small `visual_descriptors.jsonl` fixture so commit 3 (JS) can be tested without the C# build.
- [ ] **Commit 3 — client catalog fetch + descriptor-by-mech router** `[JS]` — `scene3d/vfx_catalog.js`; generalize the `statics.js:1594` tree-wind divert; `?visual` default-OFF; absent-catalog byte-identical.
- [ ] **Commit 4 — legacy-safety lint test** `[JS]` — `scene3d/vfx/lint_caps.js` + per-component reads/writes manifest + headless test, 3 negative fixtures.
- [ ] **Commit 5 — `vfx gauge` Half-A + cost model** `[C#]` BUILD-UNVERIFIED + `[JS]` instrumentation — `cost_model.jsonl` + `VfxGauge` over the 222-placement Holtburg ref.

**Phase 0 exit bar:** classifier round-trips `TREE_WIND_DIDS` byte-identically · `vfx gauge` green · legacy-safety lint green · bare-default loads + 0 errors.

## Queued for buildbox / 1070 (not done locally)
- (none yet — Phase 0 1a is JS-only and verified)

## Notes
- 8GB laptop: never `cargo build/test --workspace` / `wasm-pack` locally → any WASM step is written then queued for the buildbox.
- WB.Terminal C# has no local `.sln`/csharp-lsp → C# steps are written faithfully but marked BUILD-UNVERIFIED; JS steps that depend on a C# artifact get a hand-authored fixture.
