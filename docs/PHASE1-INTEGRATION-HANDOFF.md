# Phase 1 Integration Handoff — Visual-Behavior Suite (2026-06-23)

**For the next agent.** Phase 0 of the Visual-Behavior Suite is BUILT + VERIFIED + pushed. A 16-agent
implementation kit for Phase 1 (the cheap emissive/material/frag bundle) is ready. Your job: **integrate
Phase 1 effect-by-effect from the kit**, each step gated + default-OFF + byte-identical-when-off. This
handoff is self-contained; read it, then the kit, then go.

WB.Terminal C# work is **Opus-4.8 only** (you should be Opus 4.8). Live web source is
`external/holtburger/apps/holtburger-web/` (NOT `~/holtburger`). 8GB laptop: **never** `cargo
build/test --workspace` or `wasm-pack`. dotnet 10.0.203 IS local (single-project build + REPL run OK).

---

## 1. State of the world

- **Branch:** `feat/tree-wind-sway-2026-06-23`, pushed to `origin` @ `ce0d991b` (= full Phase 0, incl. C#).
- **Phase 0 (DONE, 7 commits `1f036384`→`ce0d991b`):** the entire VFX component SUBSTRATE — registry +
  contract, the shipped tree-wind re-expressed as `deformation.windBend`, the dormant material substrate
  (`VFX_GLOBALS`/`getCachedVariant`/the `|v` cache-key line), the C# classifier (`vfx classify`/`emit-allowlist`),
  the client catalog + descriptor-by-mech router (`?visual` default-OFF), the legacy-safety lint (Layer A/B/C),
  and the `vfx gauge` Half-A static estimator. Progress log: `docs/vfx-build-progress.md`.
- **Phase 1 KIT (your input):** `~/from-vm/phase1-implementation-kit-2026-06-23/PHASE1-IMPLEMENTATION-KIT.md`
  (535 lines) + `parts/01..16.md` (full code), also `origin/phase1-implementation-kit` at `docs/phase1-kit/`.
  Produced by a 16-Opus-agent buildbox run grounded in the Phase-0 substrate.
- **Design refs:** `docs/visual-behavior-suite-design-2026-06-23.md` (design) +
  `docs/visual-suite-spec/VISUAL-SUITE-BUILD-SPEC.md` (the implementation-ready spec, §2/§7/§8/§10/§11).
- **Memory:** `project_visual_behavior_suite_2026-06-23` + `project_tree_wind_plan_2026-06-23`.

**⚠ The kit's "✅ on disk" marks are from the VM's working tree — those files were NOT committed (only
`docs/phase1-kit/` was). On the laptop you RECONSTRUCT each file from the part's code blocks.** Verify each
part is a COMPLETE file (not a truncated snippet) before writing it.

---

## 2. The substrate you build on (verified file:line, current as of `ce0d991b`)

- `scene3d/vfx/registry.js` — `registerComponent(c)` ENFORCES the contract; `validateComponent`,
  `getComponent`, `allComponents`, `FAMILY_ORDER {deformation:0,texture:1,weathering:2,emissive:3,particle:9}`.
  `WRITE_CAPS` Set @ **`:33`** = {renderTransform,partTransform,materialUniform,emitter}.
- `scene3d/vfx/lint_caps.js` — `ALLOWED_READS`/`ALLOWED_WRITES` (@ **`:28`**) + `FORBIDDEN_SOURCE` +
  `lintManifest`/`lintSource`. Test `test_vfx_legacy_safety.mjs` dir-scans `scene3d/vfx/components/*`.
- `scene3d/materials.js` — `VFX_GLOBALS` @ **`:316`** (uTime/uWindDir/uWetness/uFrost/uCamPos, shared
  {value} by reference); `_patchSetCacheKey` `|v + __vfxSetKey` line @ **`:277`** (the firewall key);
  `getCachedVariant(surfaceDid,setKey,configKey,builder)` @ **`:1845`** (clone + `__vfxSetKey` stamp @ `:1854`);
  `_chainBeforeCompile` @ ~`:292`.
- `scene3d/vfx_catalog.js` — `visualEnabled()` (?visual default-OFF), `vfxDescriptorFor`, `descriptorMechs`,
  `COMPONENT_MECH` @ **`:40`** (currently the 4 entries windBend/tipFlex/glint/tarnish), `ensureVfxCatalog`.
- `scene3d/animated_scenery.js` + `scene3d/vfx/components/windBend.js` — the MECH-A reference component.
- `scene3d/statics.js` — imports @ `:77` (materials) / `:96` (vfx_catalog); `consolidateStaticSingletons` @
  `:1449`; per-LB baker `getCached(g.surfaceDid)` @ `:1730` (`placement.modelId` @ `:1718`); ring baker ~`:2324`.
- C#: `WorldBuilder.Terminal/CommandEngine.Vfx.cs` (`vfx classify`/`emit-allowlist`/`gauge`),
  `WorldBuilder.Shared/Lib/VisualDescriptor.cs`, `VfxData/{visual_archetype_rules.jsonl, cost_model.jsonl}`.

---

## 3. The binding constraints (do not violate)

- **THE RULE (legacy-safe):** a component READS only static/derived inputs + the client clock; WRITES only
  render-time transforms / CLONED-material uniforms / emitters / light-INTENSITY — NEVER the wire value,
  physics/collision, or a server-replicated field. No light-COUNT change (modulate `.intensity` only, never
  `.visible`/array). `deterministic:true` (no `Math.random`/argless `Date.now` — use `hash01`).
  `lightCountDelta:0`. `cacheKeyScope ∈ {set,none}` (never `"instance"`). The lint enforces all of this.
- **THE FIREWALL — one compiled program per component-SET, never per-DID/instance.** The program-cache key
  (`__vfxSetKey`) carries ONLY ordered component ids + each `linkVariant()` token — never config scalars,
  `vVfxHash`, guid, or instanceHash. Config rides uniforms; per-instance variation rides the `vVfxHash`
  varying (procedural from the per-instance matrix — BatchedMesh has no custom float attr). `test_vfx_firewall.mjs`
  (kit §11) is the unit backstop; the REAL proof (flat program count) is 1070-only.
- **`?visual` + per-effect flags ALL default-OFF; byte-identical when off.** With `?visual` off the catalog
  is never consulted, no frag variant is resolved, shared uniforms rest at `{value:0}`, no material binds them.
- **GLSL seams (build spec §2.3, composed by FAMILY_ORDER under one chain):** weathering after
  `#include <map_fragment>` (POST SubPalette decode — modify resolved `diffuseColor.rgb`) / after
  `<roughnessmap_fragment>` for roughness; emissive after `#include <emissivemap_fragment>`
  (`totalEmissiveRadiance +=`). **NEVER put backticks in GLSL inside JS template literals** — use array-join.

---

## 4. The integration plan (the kit's §11 ordered commit list = your work-list)

Work down **P1.1 → P1.16** in `PHASE1-IMPLEMENTATION-KIT.md` §11. Each commit = files + a node test + verify.
Order (dependency-correct, already adjudicated by the synthesizer):

1. **P1.1** oscillator registry + `loop.js` tick · 2. **P1.2** frag-install + `componentSetKey` +
   **`installVfxComponentPatch`** (materials.js, the kit §2b EDIT 1) + **`buildFragVariant`** bridge (kit §2b
   EDIT 2) · 3. **P1.3** per-instance `vVfxHash` · 4. **P1.4** shadow-pass guard · 5. **P1.5** flag readers
   (`vfx_flags.js`) · 6–8. **P1.6-8** emissive glint / magicGlow / enchantShimmer · 9–11. **P1.9-11**
   weathering tarnish / wetness / frost · 12. **P1.12** weather inputs → uWetness/uFrost/uWindDir · 13.
   **P1.13** flameFlicker + the **`lightIntensity` cap** (add to BOTH `lint_caps.js:28` ALLOWED_WRITES AND
   `registry.js:33` WRITE_CAPS) · 14. **P1.14** ⚠ THE ACTIVATION — `statics.js` EDITs A–F (the only step that
   renders anything) · 15. **P1.15** cost_model rows + gauge · 16. **P1.16** barrel
   (`components/index.js`) + `test_vfx_firewall.mjs` + harness TIER1 registrations + `url-flags.md` docs.

**Per-step gate (run EVERY commit):**
```
node test_<thing>.mjs                                   # the new test green
node test_vfx_legacy_safety.mjs                         # lint still green (it dir-scans components/*)
node test_vfx_windbend.mjs && node test_vfx_catalog.mjs && node test_vfx_material_substrate.mjs  # P0 regression
node harness/run-js-headless.mjs --only=vfx,treeWind --tier=1   # the registered suite
# C# steps (P1.13 cap, P1.15 gauge):  dotnet build -m:1 the .csproj  +  re-run the gauge (Debug dll):
printf 'vfx gauge --ref holtburg\nexit\n' | dotnet WorldBuilder.Terminal/bin/Debug/net8.0/WorldBuilder.Terminal.dll   # MUST stay STRUCTURAL-PASS
```
Commit LOCAL only (no push unless the user asks). Default-OFF, so off=byte-identical is the safety net.

---

## 5. My review findings — watch-items (read before integrating)

The kit is high quality; anchors are accurate (I cross-checked §2/§7 against disk). Caveats:

- **R-A (files in parts, not on disk):** reconstruct every "✅ on disk" file from its part's code block; verify
  completeness. The synthesis shows only excerpts.
- **R-B (HIGHEST RISK — P1.14 EDIT F):** the activation re-keys `consolidateStaticSingletons` (statics.js:1449,
  the shipped static-batch consolidation that cut nodes 8766→1951) from `surfaceDid` to material-identity. It
  *should* be byte-identical when `?visual` off (shared base per surfaceDid → same grouping) — **prove it with
  an explicit off-path test + keep `test_static_batch.mjs` green.** Give P1.2 + P1.14 extra scrutiny; the rest
  is low-risk (default-OFF, no call site until P1.14).
- **R-C (visual + full-firewall validation is 1070-only):** SwiftShader links shaders too fast to expose the
  program-count cost, and can't show the effects. So locally you verify byte-identical-when-off + tests + lint +
  gauge STRUCTURAL-PASS + the `componentSetKey` firewall UNIT test. "One program per SET when ON" and "does it
  look right" are the **batched 1070 eye-test** (kit §9) — QUEUE it in `docs/url-flags.md`, do not run it.
- **R-D (minor):** wrap `uTime` (e.g. `mod 3600`) in the P1.1 oscillator tick (precision drift, kit R6). Adding
  `lightIntensity` to the write-caps is sound (light-COUNT changes still rejected by `lightCountDelta:0` + the
  `.visible=` source scan) — just update BOTH files.

**Kit open-question resolutions (recommended):** apply the `precip` channel rename now (wetness+frost share a
channel — one-token edit, avoids latent double-darken); use a per-component `enabled: () => vfxEffectEnabled(id)`
hook (frag_attach already supports it); the catalog content (`visual_descriptors.jsonl`) is the classifier's job
(orthogonal — Phase 1 integrates byte-identical with an empty catalog; populate rigid-glint/magic-item/
weatherable/torch DIDs only when staging the eye-test).

---

## 6. Mechanics / how to drive this

- **Baseline check first:** confirm the green Phase-0 baseline before touching anything —
  `node harness/run-js-headless.mjs --only=vfx,treeWind --tier=1` (expect 7 PASS) + the gauge command above
  (expect STRUCTURAL-PASS). If those aren't green, stop and investigate.
- **The loop:** the user has been driving this with a self-paced `/loop` (one commit per iteration, schedule
  the next, STOP-and-ASK on genuine forks / 1070 / wasm needs). A ready prompt:
  > `/loop Integrate Phase 1 of the Visual-Behavior Suite from the kit at ~/from-vm/phase1-implementation-kit-2026-06-23/PHASE1-IMPLEMENTATION-KIT.md, following its §11 ordered commit list (P1.1→P1.16) and docs/PHASE1-INTEGRATION-HANDOFF.md. Each iteration: reconstruct the next commit's file(s) from the kit/parts (verify completeness), run the per-step gate (new test + test_vfx_legacy_safety + P0 regression + harness vfx tier + gauge STRUCTURAL-PASS), commit LOCAL on feat/tree-wind-sway-2026-06-23 (no push), update docs/vfx-build-progress.md. Give P1.2 + P1.14 (the statics activation + EDIT F consolidate re-key) extra scrutiny with an explicit off=byte-identical test. JS-only is locally verifiable; C# uses dotnet build -m:1 + the Debug-dll REPL run. ?visual + per-effect flags default-OFF; never push; queue the 1070 eye-test in docs/url-flags.md, never run it. STOP and ASK on a genuine decision; when Phase 1 is complete + gauge green + lint green, report and ASK before Phase 2.`
- **C# verify:** `dotnet build -m:1` the `WorldBuilder.Terminal/WorldBuilder.Terminal.csproj`; run commands via
  the **Debug** dll (`bin/Release` may be stale): `printf 'cmd\nexit\n' | dotnet <Debug dll>`.
- **Don't push; don't run 1070 eye-tests** (queue them). The branch is on origin @ `ce0d991b`; push Phase-1
  commits only when the user asks.

---

## 7. Done-when
Phase 1 = all 16 commits in; every per-step gate green at each; `?visual` + per-effect flags default-OFF;
`docs/vfx-build-progress.md` updated; the batched 1070 eye-test queued in `docs/url-flags.md`. Then STOP and ask
the user before Phase 2 (deformation MECH-B) — don't auto-cross the phase boundary. The visible payoff lands at
the 1070 eye-test, not locally.
