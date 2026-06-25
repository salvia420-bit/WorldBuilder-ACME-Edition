# Phase 4 — Bake-Side Migration + System Simplification
## A 16-Agent Opus-4.8 Buildbox Sweep Spec

**Date:** 2026-06-25
**Branch base:** `master` (== `origin/master`, salvia420-bit) — the whole Visual-Behavior Suite (Phases 0–3) is on master.
**Run vehicle:** headless `claude -p --dangerously-skip-permissions` ON the buildbox (Max OAuth), per `reference_buildbox_headless_claude_workflow`. **NOT** the laptop Workflow tool. All 16 agents are Opus-4.8 (WB.Terminal/C# work is Opus-4.8-only per `feedback_wb_terminal_workflow_opus_only`).
**Predecessor:** `docs/visual-behavior-suite-design-2026-06-23.md` §8 (re-phased here: this is the NEW Phase 4; texture moves to Phase 5; classifier-maturation to Phase 6).

---

## 0. Why this phase exists (read first)

The suite paints ~10k AC object models with GPU visual-behavior components selected by an offline classifier. Phases 0–3 shipped (wind-sway, emissive frag, vertex deform, particles). A code survey (2026-06-25, five Explore agents) found the suite is **already ~70% bake-aligned** — the descriptor catalog is baked offline, and GPU shaders correctly stay runtime — but a band of **deterministic runtime work** remains that should be on the build side. This phase moves it there.

It is also a **major structural change**, and we are deliberately using it as the moment to **analyze and simplify** the suite. Every agent has a **dual mandate**:

1. **MIGRATE** its slice's deterministic runtime work to a baked artifact.
2. **SIMPLIFY** the runtime that remains — delete dead code, collapse the runtime-derivation paths that the bake makes redundant, unify schemas — **without changing behavior**.

The hard guard on (2) is **`off=byte-identical`** plus the legacy/program-key firewall (§3). Simplify only with a proof it is safe (a test or a tight argument), never because it "looks cleaner."

---

## 1. Ground truth — the survey (shared context for EVERY agent)

Every agent receives §1–§3 verbatim. This is the established inventory; agents verify against current code (line numbers drift — confirm before relying).

### 1.1 Per-phase bake inventory

| Phase | Runtime work today (file:line) | Verdict |
|---|---|---|
| **0 — wind (MECH-A)** | Keyframe **clips** synthesized per-load: `buildTreeWindClip` `wind_rig.js:149`. Per-part **bbox/pivot/swayAmp** from GfxObj verts: `wind_rig.js:59–137`. Wind **config** (fps/amp/dir/cycles/flutter) hardcoded defaults: `wind_rig.js:150`, `tree_wind.js:44`. | **Biggest mover.** Clips → per-DID **binary** bake (VAT / AC-native Animation 0x03). Rig + config → fold into descriptor. `holtburger-scenery-bake` touches NONE of this today. |
| **1 — emissive (frag)** | Fragment GLSL compile; per-instance hash (`per_instance.js`); config→uniforms. Descriptor already baked (`vfx_catalog.js:113` fetches `visual_descriptors.jsonl`). | **Already done.** Shaders MUST stay runtime; per-instance hash is procedural & cheaper than baking. **Nothing to migrate.** Highest *simplification* surface (it's "finished" code). It is the **golden pattern** the others mirror. |
| **2 — deform (MECH-B)** | GLSL vertex displacement (MUST stay runtime). **Shaft geometry config** (shaftAxis/gripBase/shaftLen) currently falls back to generic defaults `(0,0,1)/0/1` — `tipFlex.js:196–202`; descriptor does NOT carry it. | **One clean win.** Compute shaft frame from GfxObj bbox + `holding_locations` offline in C# (`CommandEngine.Vfx.cs:389` `BuildResult`) → descriptor.config. (= the "per-DID config refinement deferred" item.) |
| **3 — particles** | **emitterInfo POJO synthesis** at attach time: `gemSparkle.js:108`, `brazierEmbers.js:66`, `foliageAmbient.js:85`, `breathFog.js:87` (pure: config reads + scalar math). **Anchor part-index + bbox** heuristic walk: `particle_attach.js:294–316`. | **Two wins.** Pre-resolve POJOs offline → descriptor sidecar. Bake anchor part-index/bounds (the `vfx anchor-parts` command that does NOT exist yet — `brazierEmbers.js:159` already hardcodes `partIndex:1` with a "baked by vfx anchor-parts" TODO). Catalog already baked via `vfx-emit-catalog`. |

**Must-stay-runtime everywhere (correct, not a gap):** GPU shader compilation, particle simulation/spawn, camera billboarding (`particle_manager.js:377`), per-frame oscillators (`oscillators.js:182`), and **live-state** reads — weather/day-night gates (`particle_env_gates.js:100`) and creature-breath part-frames from server pose (`particle_emitter.js:129`). The bake line is the GPU/live boundary; do not cross it.

### 1.2 The bake→fetch contract (proven mechanics — REUSE, do not reinvent)

Proven by 3+ artifact types — scenery, events, spawns, the vfx catalog:

```
Rust producer crate  →  artifact + .sha256 sidecar  →  served from dist/{type}/  →
  wasm init_{type}_base_url(url) + fetch_landblock_{type}(cells)  →  JS ensureInit + per-LB lazy fetch + cache
```

- Scenery: `holtburger-scenery-bake` → `0x{XXYY}.scenery.jsonl` (+ `.sha256` with body hash + FNV1a placements fingerprint) → `dist/scenery/` → `lib.rs:2131 init_scenery_base_url` + `lib.rs:2469 fetch_landblock_scenery` → `statics.js:382`.
- Determinism helpers: `wire_f32_bits` + `{:.6}` (`format_f32_six_sig`, -0.0→+0.0) + `placements_fingerprint` (FNV1a/64). **Every baked float goes through these.**
- VFX catalog: `dist/vfx/visual_descriptors.jsonl` (one global file, per-DID-keyed) → `vfx_catalog.js:58/113/133`.
- E9a/E9b material sidecar (`scenery-bake.rs:810 format_materials_sidecar` + `CommandEngine.SurfaceMaterials.cs`) is **built but NOT wired to runtime** — a ready template for a per-DID artifact path.
- Serving reality: `dist` is a **symlink → `/mnt/wbterminal2/holtburger-dist-v2/`**, NOT git. Bakes land there.
- `holtburger-manifest` (v2) provides versioning/cache-bust/content-hash naming but current artifacts don't use it. **Defer manifest integration to Phase 5+** unless trivial.

### 1.3 ★ The single most important design rule: PER-DID, not per-LB

Suite data is **per-Setup-DID** — one tree/spear/brazier *setup* appears in thousands of landblocks. Keying suite artifacts per-LB (like scenery) would massively duplicate. **All Phase-4 artifacts are per-DID:** small config folds into the existing per-DID `visual_descriptors.jsonl`; the one heavy artifact (wind clips) gets a **per-DID binary sidecar** (e.g. `dist/suite/{did_hex}.windclip.bin` + `.sha256`). Reuse the scenery *mechanics* (Rust producer, determinism, wasm init/fetch, JS lazy-load+cache) but key by **DID**, mirroring the vfx catalog — NOT the per-LB scenery file.

### 1.4 The A/B bucket plan (the shape of the work)

- **Bucket A — descriptor-config enrichment (the bulk; small JSON; low-risk).** Shaft geometry (P2), resolved emitter POJOs + anchor part-index/bounds (P3), wind config (P0) → extend `visual_descriptors.jsonl` via `CommandEngine.Vfx.cs:389 BuildResult`. No new artifact type, no new fetch path. Most of the "move it bake-side" win.
- **Bucket B — one new per-DID binary artifact.** P0 wind keyframe clips are too big for JSON → per-DID binary sidecar + a new Rust bake pass + a new wasm/JS fetch path. The ONLY new infrastructure — and the exact contract **Phase 5 texture channels reuse**. This is why bake precedes texture.

---

## 2. The simplification mandate (the "while keeping functional" half)

We are touching the whole suite's data flow; that is the right time to pay down complexity. Concrete simplification targets, by kind:

- **Delete runtime derivation the bake makes redundant.** Once shaft geometry / emitter POJOs / anchor indices / wind rigs are in the descriptor, the runtime code that *derived* them (`buildTreeWindClip`, `_resolveAnchor` heuristic walk, `buildBboxRig` at-load, the `emit()` config-merge) collapses to **fetch + apply**. Map and remove it.
- **Unify the descriptor schema.** Today config arrives ad-hoc per component. Consolidate the new per-DID data (shaft frame, POJO, anchor, wind config) into ONE coherent, documented `VisualDescriptor` schema + ONE fetch + ONE router. This is the central simplification.
- **Collapse redundant variants / dead code.** Phase 1 especially — it's "finished," so it accretes unused branches, dead flags, duplicated string templates, stale fallbacks. Sweep them.
- **One authority per concern.** One tick-cull radius, one oscillator tick, one anchor resolver, one per-instance-hash path across all mechs (the design's S-series already aims here; finish it).

### 2.1 The HARD guard (non-negotiable, every agent)

A simplification ships ONLY if it preserves all of:

1. **`off=byte-identical`.** With the suite's flags off (`?visual=off` and each `?<effect>=off`), the render is **byte-for-byte** identical to pre-Phase-4. There is a node harness for this — extend it; a simplification with no off-trace test does not ship.
2. **Legacy-safety firewall.** Components READ only static/derived inputs (DAT geometry/Surface/weenie + server pos/heading + deterministic hash01) + wall-clock; WRITE only render-time transforms / CLONED material uniforms; NEVER wire value, physics/collision, or replicated state. Baking must not smuggle a live input into a baked artifact (e.g. weather gates, creature part-frames — those MUST stay runtime, §1.1).
3. **Program-key firewall.** The shader program-cache key encodes component-SET membership + linkVariant bits ONLY — never config, never per-instance state. Program count stays O(distinct SETs), never O(DIDs). A baked-config change must not leak into the program key.
4. **No light-count change** (avoids the relink/freeze) and **no per-instance `customProgramCacheKey`**.
5. **Bake determinism.** Re-running the bake on the same DAT yields byte-identical artifacts (`wire_f32_bits`/`{:.6}`/FNV1a). A `bake-source.sha256` records DAT iteration + bake-CLI version.

> Framing for agents: "Behavior is frozen; only its *location* and its *shape* may change. If you cannot prove behavior is unchanged, propose it as a flagged follow-up, do not apply it."

---

## 3. Constraints, paths, and gotchas (shared context, every agent)

**Repo layout** (root `/home/wbterminal/WorldBuilder-ACME-Edition`, on the buildbox checkout):
- Web client JS: `external/holtburger/apps/holtburger-web/scene3d/` (+ `scene3d/vfx/`, `scene3d/vfx/components/`, `scene3d/particles/`).
- wasm crate: `external/holtburger/apps/holtburger-web/src/lib.rs` (~49.5k lines).
- Rust crates: `external/holtburger/crates/` — `holtburger-dat` (incl `normal_gen.rs`, `surface_classify.rs`), `holtburger-scenery-bake`, `holtburger-event-bake`, `holtburger-manifest`, `holtburger-dat-write`. Bake CLIs under `external/holtburger/apps/holtburger-tools/src/bin/` (e.g. `scenery-bake.rs`).
- C# build side: `WorldBuilder.Terminal/CommandEngine.Vfx.cs` (+ `.SurfaceMaterials.cs`, `VfxData/cost_model.jsonl`, `VfxData/visual_archetype_rules.jsonl`), `WorldBuilder.Shared/Lib/VisualDescriptor.cs` + `Lib/AceDb/EntityEnums/`.
- Descriptor catalog (served): `dist/vfx/visual_descriptors.jsonl`.

**Build/runtime gotchas (durable):**
- C# csproj targets **net8** under net10 → `DOTNET_ROLL_FORWARD=Major dotnet build`. `dotnet 10.0.203` is on the buildbox; use the Debug DLL (bin/Release may be stale).
- **OOM discipline:** never `cargo build/test --workspace`. Build single crates (`-p holtburger-dat`) / single examples. Bakes are buildbox-only (8 GB laptop OOMs).
- `dist` → `/mnt/wbterminal2/holtburger-dist-v2/`, not git. New artifacts stage there.
- LSD weenies on the box: repo-root `external/LSD-Partial-2025-02-23_16-15/weenies` (filename = name; intStats/didStats only).
- Wasm rebuild = `capped-build wasm-pack ... --release` (PATH needs `~/.cargo/bin`); a new free wasm export must be wired into BOTH index.html `wasmExports` sites + `init3D` opts + bump `?v=` cache-bust, or entities.js soft-degrades.
- `vfx gauge --ref holtburg` STRUCTURAL-PASS is the build-side gate (G1 programs ≤ Kp, G2 drawcalls/particle budget, G3 VRAM, G4 lights==0). Keep it green.

**Verification anchors that already exist (extend, don't reinvent):** the VFX legacy-safety lint (`scene3d/vfx/lint_caps.js` + the Layer A/B/C test), `test_vfx_firewall`, `test_vfx_tipflex`, `test_vfx_vertex_install`, `frag_install`/`frag_attach` tests, the full TIER1 JS harness (currently 23/23 + 6 pre-existing non-VFX fails), and `vfx gauge`.

---

## 4. The 16 agents

Three clusters. Cluster 1 (8) = subsystem analyze+design+simplify, each owning files. Cluster 2 (3) = cross-cutting unification. Cluster 3 (5) = adversarial verify (4) + synthesis (1). Clusters run as waves: **1 ∥ → 2 ∥ → 3 verify ∥ → 3 synth**. Every agent gets §1–§3 verbatim, then its brief below. Every Cluster-1/2 agent returns BOTH a **bake-migration design** and a **simplification ledger** (with off-trace proof per item).

> Output discipline: each agent WRITES its part to `parts/NN-<slug>.md` via the Write tool and returns a short stdout summary ONLY. Do **not** `cp parts/synth.md KIT.md` (it clobbers the Write-tool doc — known footgun). Source that lives untracked in the buildbox working tree must be captured into the tarball, not just referenced.

### Cluster 1 — Subsystem analyze + design + simplify (Wave 1, parallel ×8)

**A01 — Wind clips → per-DID binary bake (Bucket B, the heavy artifact).**
Own: `wind_rig.js` (`buildTreeWindClip:149`, `partBBox:59`, `swayAmp:98`, `buildBboxRig:113`, `hash01:199`), `animated_scenery.js` (`buildSceneryAnimationClip:131`), the tree-wind plan (`~/from-vm/tree-wind-plan-2026-06-23/` / `origin/tree-wind-plan`), `holtburger-scenery-bake`, `holtburger-dat-write` (packs Animation 0x03 byte-identical).
Design: the per-DID wind-clip bake. **Decide the artifact**: AC-native Animation(0x03) sidecar (hero, byte-identical, replayable by the existing keyframe player) vs VAT vertex-animation-texture (forest bulk, scales to 317k) vs a compact frame-major `.windclip.bin` (7 floats/part/frame). Recommend the format(s) + the per-DID naming (`dist/suite/{did_hex}.windclip.bin` + `.sha256`), the Rust bake pass (new module in scenery-bake or a `holtburger-suite-bake` crate), and the determinism contract. Map the runtime change: `buildTreeWindClip` becomes **fetch-not-synthesize**; the player consumes the baked clip unchanged.
Simplify: with clips baked, what of `wind_rig.js` (the whole synth path) and `animated_scenery.js` (the build half) deletes or collapses? Keep the per-frame mixer-advance / cull / per-instance phase (MUST stay runtime). Prove `?treeWind`-off byte-identical.

**A02 — Wind rig + config → descriptor (Bucket A) + scenery/animated-scenery runtime simplify.**
Own: `wind_rig.js:59–137` (partBBox/swayAmp/buildBboxRig), `tree_wind.js` (`TREE_WIND_DIDS:64`, config defaults), `statics.js` (windTrees peel/attach ~`:1700`), `vfx/components/windBend.js`.
Design: bake per-DID **rig** (per-part pivot=vertex-Zmin + sway weight, computed offline from GfxObj) + **wind config** (fps/amp/dir/cycles/flutter, today hardcoded/URL-flag) into the descriptor.config under `procMotion.windBend`. Specify the C# (or Rust) computation and the schema fields. The `TREE_WIND_DIDS` allowlist becomes a pure classifier output (already round-trips).
Simplify: `buildBboxRig`/`partBBox` at-load → deleted (baked); the statics peel reads descriptor instead of the hardcoded Set. Collapse the windBend component to config-consumer. Off byte-identical proof.

**A03 — Deform shaft-geometry → descriptor (Bucket A) + tipFlex/vertex_install simplify.**
Own: `vfx/components/tipFlex.js` (`declareUniforms:176–202`, GLSL `:73–130`), `vfx/vertex_install.js` (`injectBeginVertex:106`), `CommandEngine.Vfx.cs:389 BuildResult`, atlan spear `0x02000724` (shaftLen 1.526 DAT probe), `holding_locations`.
Design: compute per-DID **shaft frame** (shaftAxis = longest GfxObj bbox axis; gripBase = grip anchor from `holding_locations` or part Zmin; shaftLen = extent) offline in C# `BuildResult`, serialize into `descriptor.config["deformation.tipFlex"]`. The runtime already reads config (`tipFlex.js:196`) — so this just *populates* it and removes the generic-default fallback's reliance.
Simplify: once every tipFlex DID carries a real shaft frame, can the `(0,0,1)/0/1` default path shrink to an assert? Confirm `buildBboxRig` is unused by tipFlex (it is) and prune any stray import. GLSL stays runtime. Off (`?tipFlex=off`) byte-identical.

**A04 — Particle POJO pre-resolve → descriptor (Bucket A) + particle_attach simplify.**
Own: `vfx/components/{gemSparkle,brazierEmbers,foliageAmbient,breathFog}.js` (the `emit()`/POJO builders), `particles/particle_attach.js` (`mergeComponentConfig:97`, `emit():399`), `particles/particle_emitter_info.js` (POJO schema), `particle_sprites.js`.
Design: pre-resolve the emitterInfo POJO offline (merge component defaults + descriptor config once) and serialize the full POJO (~27 scalar fields + sprite DID) into the descriptor. Runtime stops calling `emit()` for non-gated effects (gemSparkle/brazier) and instantiates `ParticleEmitterInfo(pojo)` directly; for gated effects (foliage/breath) it applies only the live gate scalar to birthrate. **Keep runtime:** simulation, spawn RNG, billboard, weather/day/region gates.
Simplify: collapse the per-attach config-merge; the `emit()` hooks for non-gated effects become unused → remove or reduce to the gated path. Off byte-identical per effect.

**A05 — Particle anchor part-index/bbox → bake + the `vfx anchor-parts` command (Bucket A).**
Own: `particles/particle_attach.js:294–316 _resolveAnchor`, `brazierEmbers.js:159` (hardcoded `partIndex:1` + "vfx anchor-parts" TODO), `wind_rig.js:113 buildBboxRig` (reusable geometry walk), `CommandEngine.Vfx.cs`.
Design: implement the missing **`vfx anchor-parts <DID> <role>`** WB.Terminal command — offline, per-DID+role compute partIndex + bounds (center/radius) from GfxObj geometry (canopy = topmost-centroid-Z, head, bowl, …), reusing the bbox walk. Serialize into descriptor under each particle component's config. Runtime `_resolveAnchor` becomes a config read.
Simplify: delete the runtime heuristic walk; unify the brazier hardcode + foliage/breath resolves onto the one baked anchor field. Keep live creature-breath part-frame anchoring (`particle_emitter.js:129`) runtime. Off byte-identical.

**A06 — Phase 1 emissive AUDIT + aggressive simplify (the "finished code" sweep).**
Own: `vfx/components/{glint,magicGlow,enchantShimmer,tarnish,wetness,frost,flameFlicker,itemAura}.js`, `materials.js` (frag install path, `buildFragVariant`, `_chainBeforeCompile`, `applyFloatLumDiffuse:1275`), `oscillators.js`, `per_instance.js`, `frag_install.js`/`frag_attach.js`, `item_fx.js`, `vfx_catalog.js`.
Mandate: this phase migrates NOTHING (already baked) — its value is (a) **certify** it as the golden pattern the others copy, (b) **simplify** the largest, most-settled code surface. Hunt: dead branches, unused flags, duplicated GLSL templates, stale fallbacks, redundant uniform plumbing, the few genuine bake-exceptions (anything reading DAT surface props at runtime the bake already has — e.g. `applyFloatLumDiffuse` luminosity/diffuse: confirm sourced from baked `SurfacePixels`, not re-derived). Produce a ranked simplification ledger, each item with an off-trace proof. Document the canonical "descriptor → fetch → route → apply, program-key = SET only" pattern for A09 to formalize.

**A07 — Shared per-DID binary-sidecar bake→fetch contract (Bucket B infra).**
Own: the contract (§1.2), `holtburger-scenery-bake` (the model), `lib.rs:2131/2469` (wasm init/fetch shape), `statics.js`/`baked_ambient_source.js`/`vfx_catalog.js` (JS lazy-load patterns), `scenery-bake.rs` determinism helpers, `holtburger-manifest`.
Design: the reusable **per-DID binary-sidecar** path that A01's wind clips (and Phase-5 texture channels) ride: artifact naming (`dist/suite/{did_hex}.<type>.bin` + `.sha256`), the Rust producer API (a `holtburger-suite-bake` crate OR a scenery-bake extension — recommend), the wasm exports (`init_suite_base_url` + `fetch_suite_artifact(did, type)` — per-DID, NOT per-LB), the JS orchestrator (`scene3d/suite_assets.js`, mirroring `baked_ambient_source.js` lazy+cache+fail-soft), determinism + `bake-source.sha256`, and serving to `/mnt/wbterminal2/holtburger-dist-v2/suite/`. Explicitly REJECT the per-LB pattern for suite data (§1.3) and justify. Manifest integration = note as Phase-5 follow-up.
Simplify: identify what of the E9a/E9b unshipped material-sidecar path can be reused vs retired; one fetch/cache helper shared across artifact types.

**A08 — C# classifier / WB.Terminal: BuildResult enrichment + bake commands + gauge.**
Own: `CommandEngine.Vfx.cs` (`VfxClassify:206`, `BuildResult:389`, `VfxEmitCatalog:632`, `VfxGauge:483`), `WorldBuilder.Shared/Lib/VisualDescriptor.cs`, `VfxData/visual_archetype_rules.jsonl`, `VfxData/cost_model.jsonl`, EntityEnums.
Design: the build-side that produces Bucket A — extend `BuildResult` to emit, per DID: shaft frame (A03), resolved emitter POJOs (A04), anchor part-index/bounds (A05 via `vfx anchor-parts`), wind rig+config (A02). The wind-clip binary bake (A01/A07) is invoked from a new verb (`vfx bake-clips` or in `vfx-emit-catalog`). Ensure the catalog stays repeatable (cache persists; plain `load` → emit reproduces). Update `vfx gauge` to account the new baked artifacts (binary-sidecar VRAM as a per-DID, not per-placement, cost row) and keep STRUCTURAL-PASS.
Simplify: one `BuildResult` assembly path feeding one descriptor schema (coordinate with A09); retire any divergent config emission.

### Cluster 2 — Cross-cutting unification (Wave 2, parallel ×3)

**A09 — The unified `VisualDescriptor` schema (the central simplification).**
Inputs: A01–A08 part files. Own: `VisualDescriptor.cs`, the JSONL format, `vfx_catalog.js` parse/route, `frag_attach.js`/`particle_attach.js` config consumption.
Produce: ONE coherent, versioned per-DID descriptor schema that carries every new field (procMotion.windBend rig+config, deformation.tipFlex shaft frame, particle POJOs + anchor, references to per-DID binary sidecars) alongside the existing components/config. Define: field names/types, the binary-sidecar reference convention (DID + type → URL), back-compat (old catalog still parses; missing fields → today's defaults so `off` stays identical), and the single router that dispatches by mech. This is where "ad-hoc per-component config" collapses into one schema + one fetch + one router. Specify the C# serialization ↔ JS parse contract exactly.

**A10 — Legacy-safety firewall + `off=byte-identical` + desync proof for the migration.**
Inputs: A01–A09. Own: `lint_caps.js` + the Layer A/B/C test, `test_vfx_firewall`, the off-trace harness, the desync proof points (`entities.js` setPose copy() stomp ~`:2161`, SetOmega re-derive ~`:2178`).
Produce: the safety case for the whole migration. Verify no baked artifact captures a live input (weather, creature part-frames, camera, time) — those stay runtime (§1.1). Verify the program-key firewall survives the schema change (config/per-instance never in the key). Extend the off-trace harness so EVERY Phase-4 simplification has a byte-identical-when-off test. Produce the consolidated legacy-safety manifest (per component: reads/writes) updated for the baked flow.

**A11 — Determinism, round-trip, reproducible bake + test-harness plan.**
Inputs: A01–A09. Own: `wire_f32_bits`/`{:.6}`/FNV1a, `scenery-bake.rs` patterns, the `bake-source.sha256`, the C# round-trip asserts (`SurfaceMaterials.cs` E9b model).
Produce: the determinism contract for every new artifact (binary clips + descriptor floats) — same DAT → byte-identical bake; a round-trip test (bake → read → assert equality, like E9b); the `bake-source.sha256` (DAT iteration + CLI version); the node/dotnet test plan that gates each P4.x commit (extend TIER1 + `vfx gauge` + the off-trace + round-trip). Flag any nondeterminism risk (HashMap iteration order, float formatting, palette fetch order).

### Cluster 3 — Adversarial verify (Wave 3a, parallel ×4) + synthesis (Wave 3b, ×1)

**A12–A15 — Red-team verifiers**, one per slice: **A12** wind (A01+A02), **A13** deform (A03), **A14** particles (A04+A05), **A15** contract+C#+schema (A07+A08+A09). Each is prompted to **REFUTE**: does the baked output actually reproduce the runtime output bit-for-bit (or within the determinism contract)? Does `off` stay byte-identical? Does the proposed simplification delete something still reachable? Does any bake smuggle a live input past the firewall? Does the per-DID keying actually avoid duplication, and does the fetch path fail soft? Default to "unsafe/unproven" unless the design carries a test or a tight argument. Output a verdict (PASS / PASS-WITH-FIXES / REJECT) + required fixes folded back.

**A16 — Synthesis.** Inputs: all parts + verifier verdicts. Produce the consolidated deliverable (§5): the ordered **P4.x commit plan**, the **unified schema**, the **simplification ledger** (deduped, risk-ranked, each with its off-proof + owning commit), the **test plan**, the **exit bar**, and the **open questions**. Write to a distinct filename (`PHASE4-BAKE-MIGRATION-SYNTHESIS.md`) — do NOT clobber via cp.

---

## 5. Deliverables (what the tarball returns)

```
phase4-bake-work/
  PHASE4-BAKE-MIGRATION-SYNTHESIS.md   # A16 — the master plan (commit list + schema + ledger + tests + exit bar)
  SCHEMA.md                            # A09 — the unified VisualDescriptor schema (C# ↔ JS contract)
  SIMPLIFICATION-LEDGER.md             # consolidated, risk-ranked, each item w/ off-proof + owning commit
  SAFETY-CASE.md                       # A10 — firewall + off-trace + desync
  DETERMINISM-AND-TESTS.md             # A11 — bake reproducibility + round-trip + gating tests
  parts/01..16-*.md                    # each agent's full design + simplification ledger
  artifacts/                           # any prototype Rust/C#/JS, schema fixtures, captured untracked source
```

The plan must be **applied locally via `/loop`** afterward (autonomous, per-step off-trace + round-trip + `vfx gauge` gate), NOT auto-committed by the buildbox.

---

## 6. Exit bar (the sweep is "done" when the plan guarantees)

1. **Bucket A baked:** shaft geometry, emitter POJOs, anchor indices, wind rig+config all emitted into the unified descriptor by `BuildResult`; runtime consumes them; the derivation code is removed or collapsed.
2. **Bucket B path stood up:** the per-DID binary-sidecar bake→fetch contract exists and wind clips ride it; the path is documented as Phase-5-texture-ready.
3. **Phase 1 untouched functionally**, but simplified with proofs.
4. **`off=byte-identical`** for every effect, proven by an extended off-trace harness.
5. **Firewalls intact:** legacy (no wire/physics/replicated write; no live input baked), program-key (O(SETs)), light-count==0.
6. **Bake deterministic + round-trip-verified**, with `bake-source.sha256`.
7. **`vfx gauge --ref holtburg` STRUCTURAL-PASS** with the new artifacts accounted.
8. **Every simplification carries its safety proof**; unproven ones are demoted to flagged follow-ups.
9. The **simplification ledger** shows the suite is measurably smaller/simpler at the runtime boundary (LOC removed, runtime-derivation paths eliminated) without behavior change.

---

## 7. Running it on the buildbox (operational)

Per `reference_buildbox_headless_claude_workflow`:
1. Start the buildbox (`gcloud compute instances start`, us-central1-a); recover any prior WIP stash first.
2. scp the driver + this spec; the driver launches the 16 `claude -p --dangerously-skip-permissions` agents in the 3 waves (each agent gets §1–§3 + its §4 brief; Opus-4.8).
3. Collect parts into the tarball; checksum; scp back to the laptop (`~/from-vm/phase4-bake-work-2026-06-25/`).
4. Push the spec/branch artifacts (docs only — code applies via `/loop`).
5. **Gated poweroff**: `sudo poweroff` ONLY after the tarball + push succeed; then an explicit laptop-side `gcloud compute instances stop` as backstop (the in-VM poweroff didn't transition the box to TERMINATED last time).

**Cost note:** 16 Opus-4.8 agents + waves is a large run (prior comparable sweeps ~600k–1M tokens). Worth it for a structural change this central; the user has opted into the buildbox sweep.

---

## 8. Open questions for the sweep to settle

1. **Wind-clip artifact format** — Animation(0x03) byte-identical sidecar vs VAT vs compact `.windclip.bin`, or a tier (hero=Animation, forest=VAT). A01 + A12 decide; affects the binary-sidecar contract (A07).
2. **Suite-bake crate vs scenery-bake extension** — new `holtburger-suite-bake` (clean) vs fold into `holtburger-scenery-bake` (less infra). A07 recommends.
3. **How aggressive to delete vs deprecate** the now-redundant runtime derivation — delete in-phase (cleaner, riskier) vs leave behind a flag for one cycle. A10/A16 set the policy; default = delete only with an off-trace test, else deprecate.
4. **Descriptor schema version bump** — additive (back-compat, missing fields → defaults) is required so `off` stays identical and old catalogs still load. A09 confirms the migration story.
