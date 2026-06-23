I have verified every critical seam. Writing the synthesis now (read-only — output to stdout).

---

## Assignment (Task 16 — Sequencing / Risk / Rollback synthesis)

Produce the **dependency graph + sequenced roadmap** across tasks 01–15: classify each work item as **JS-ONLY** (no wasm rebuild), **NEEDS-WASM-REBUILD** (gated), or **OFFLINE-BAKE**; define the Phase-1a critical path to first-visible-motion, then 1b → 2 → 3; enumerate the top risks each with mitigation + rollback; and emit the ordered, independently-shippable step list the final plan expands.

---

## Findings (file:line — the seams the whole roadmap hangs on)

**The existing player IS the Phase-1a vehicle** — `scene3d/animated_scenery.js`:
- `buildSceneryAnimationClip(THREE_, frames, numParts, numFrames, fps)` (`animated_scenery.js:125`) is **pure, exported, unit-tested**, and takes a *flat Float32Array* `[ox,oy,oz, qw,qx,qy,qz]` per (frame,part) — it never touches the DAT. **A synthetic JS-generated array drops straight in.**
- `attachAnimatedScenery(scene3d, placements, wasmExports, opts)` (`:314`) filters on `defaultAnimationId != 0` (`:321`), so trees (`defaultAnimation = 0`) are invisible to it today — Phase 1a needs a sibling entry, not a flag flip.
- The shared-driver map `_didGroups` is keyed by `animId` (`:101`); `getOrCreateDidGroup(animId, wasmExports)` (`:204`) calls `wasmExports.fetchAnimation(animId)` (`:209`). For trees there is no animId → the synthetic path must key by a **synthetic id** (e.g. `wind:<setupId>:<rigHash>`) and build the clip from a procedural function instead of `fetchAnimation`.
- `buildOne` (`:245`) already pulls **per-part meshes + rest hinge frames** from `wasmExports.fetchBuildingPlacement(setupId)` (`:255`, `bundle.takePartMeshes()` `:262`, `takePartHingeFrames()` `:263`). **Phase 1b's bbox rig can compute base-pivot/height-weight from these part meshes in JS — no new wasm export.**
- One shared mixer per DID, advanced once per rAF (`:394–396`); per-instance pose **copied** (`:419–423`); **512 cap** (`DEFAULT_MAX_ANIMATED=512` `:43`, `maxAnimated()` `:56`, drop-over-cap `:336`); **140 m distance cull** (`DEFAULT_TICK_RADIUS_M` `:44`, `:416`); **LRU/orphan reclaim** via `_isOrphaned` (`:192`) + splice (`:406–414`); `userData.landblockId` tag for the existing LRU (`:271`).

**The divert seam exists TWICE** — `scene3d/statics.js`:
- Per-LB path: peel at `statics.js:1576–1587`, attach at `:1829–1830`.
- Ring path: peel at `:2081–2092`, attach at `:2363–2364`.
- Both peel `defaultAnimationId != 0` out of `statics` *only when `animSceneryEnabled()`* (flag-gated; off ⇒ byte-identical frozen path). **A parallel `windTrees = statics.filter(TREE_DIDS.has(objId))` mirrors this at the same four lines.** Attach is called with 3 args (no `opts`) for outdoor → defaults to `staticsGroup` parent.

**Adapter attribute seam is mechanical** — `scene3d/adapter.js`:
- `meshToGeometryGroups` (`:707`) emits **non-indexed, per-surface-grouped, winding-reversed** triangles: per-tri-vertex write loop `:783–799`, `setAttribute("position"/"uv"/"normal")` at `:802–813`, returns `{ groups:[{geometry, surfaceDid, doubleSided}], surfaceDids }` (`:826–829`). **Critical for VAT:** single-sided groups reverse vertex order to `[0,2,1]` (`:777`) — any VAT/vertexId scheme must replicate this exact triangulation+grouping+winding or rows won't align.
- A `windWeight` (float, itemSize 1, length `n*3`) is one `new Float32Array(n*3)` written inside the `:783` loop + one `geom.setAttribute("windWeight", new THREE.BufferAttribute(w,1))` after `:813`. **JS-only, no rebuild.**

**Shader/material + uniform plumbing already has precedent** — `scene3d/materials.js` chained `onBeforeCompile` (`:293–325`) injects before `#include <begin_vertex>` (`:324`); `scene3d/loop.js` already writes per-frame uniforms (`mat.uniforms.uTime.value = tSec`, `loop.js:827–828`) — `windUniforms.uTime/uDir/uStrength` follow the identical pattern.

**No wind state exists** — `scene3d/weather_state.js` carries only `is_storm` + T/Td/P (`:75`, `getWeatherState` `:225`, `readWeatherFlags` `:247`, `window.__setWeather` `:260`); the wind schema is greenfield, couple gusts to `is_storm`.

**Offline tooling confirmed present:** `apps/holtburger-tools/src/bin/scenery-bake.rs` (87 KB), dat-write packers `crates/holtburger-dat-write/src/pack/{setup_model.rs, animation.rs}`; client fetch wiring at `src/lib.rs:2131` (`init_scenery_base_url`), per-part exports `fetchBuildingPlacement` (`lib.rs:9818`), `fetchAnimation` (`lib.rs:43127`). Tests `test_animated_scenery.mjs`, `test_static_batch.mjs`, `test_landblock_lru_evict.mjs` all present.

---

## Concrete coding steps — Dependency graph + classification

### Classification of every work item (the front-loading key under the 8 GB OOM constraint)

| Task | Class | Hard deps | Why this class |
|---|---|---|---|
| 01 player deepread → `attachWindTrees` + synthetic clip gen | **JS-ONLY** | — | `buildSceneryAnimationClip` takes a flat array; no DAT/wasm call needed |
| 02 statics divert + `TREE_DIDS` allowlist | **JS-ONLY** (filter + hardcoded list) | 01, 14 | Mirrors existing `defaultAnimationId` peel at the 4 known lines; allowlist seeded from ESTABLISHED facts |
| 02b allowlist *generator* (freq+bbox shape) | **OFFLINE-BAKE** (optional) | — | Only if the hardcoded list must become auditable/regenerable |
| 03 bbox base-pivot rig | **JS-ONLY** | 01, 02 | per-part bbox computed in JS from `takePartMeshes()` — no new export |
| 04 adapter `windWeight` attribute | **JS-ONLY** | — | JS post-pass over non-indexed stream at `adapter.js:783` |
| 05 Crytek two-band forest shader | **JS-ONLY** | 04, 12-lite | material clone + `onBeforeCompile`; **no bake, scales to forest** |
| 06 VAT runtime shader | **JS-ONLY** (runtime) | 04, 10 | shader samples a texture; texture comes from the bake |
| 07 skeletonize | **OFFLINE-BAKE** | raw verts (dat-tool/holtburger-dat — *no wasm*) | runs on buildbox, never the laptop |
| 08 harmonic wind sim | **OFFLINE-BAKE** | 07 | cascade→flatten→dense sample, deterministic |
| 09 AC-native Setup 0x02 + Anim 0x03 | **OFFLINE-BAKE** | 08 | dat-write packers; consumed as sidecar (no rebuild) or DAT overlay |
| 10 bake tool (VAT tex + sidecars) | **OFFLINE-BAKE** | 07,08,09 | new `tree-wind-bake` emitting under `dist/` like scenery-bake |
| 11 wasm exports gating | **classification** → mostly **none**; **NEEDS-WASM-REBUILD** only if VAT-meta/raw-vert export chosen | — | confirms 1a/1b/05 need **zero** new exports |
| 12 wind-state module | **JS-ONLY** | — | new module; storm coupling off `is_storm` |
| 13 LOD + scale | **JS-ONLY** | 01/03, 05/06, 02 | thresholds layered onto existing 140 m cull + pvsRing |
| 14 flags + docs | **JS-ONLY** | — | `?treeWind` parse + `docs/url-flags.md` row |
| 15 test + verification | **JS-ONLY** | 01,03,04,06 | node `--test` + headless smoke + diag counter |

**Headline:** Phases 1a, 1b, the no-bake forest shader (05), wind state (12), LOD (13), flags (14), tests (15) are **ALL JS-ONLY — zero wasm rebuilds.** The only wasm rebuild is *optional* (task 11) and deferrable to a single batched gate. All heavy compute (07/08/09/10) is OFFLINE-BAKE on the buildbox. **Nothing on the laptop's critical path triggers a `cargo build --workspace`.**

### Dependency graph (edges = "must precede")

```
14 (flag) ─┐
           ├─► 02 (peel+allowlist) ─► 01 (attachWindTrees+synthetic clip) ─► [PHASE 1a SHIP]
12-lite ───┘                                       │
                                                   ▼
                                          03 (bbox base-pivot rig) ─────────► [PHASE 1b SHIP]
                                                   │
04 (windWeight attr) ─► 05 (forest shader) ◄─ 12-lite ───────────────────► [FOREST no-bake SHIP]
04 ─────────────────────────────────────────────────────────┐
                                                             ▼
07 (skeletonize) ─► 08 (sim) ─┬─► 09 (AC-native) ──► (sidecar/overlay) ─► [HERO fidelity SHIP]
                              └─► 10 (VAT bake) ─► 06 (VAT runtime) ─────► [VAT forest SHIP]
12-full (wind state+gusts) ─► 13 (LOD tiers) ───────────────────────────► [POLISH SHIP]
15 (tests) runs alongside every ship; 11 (wasm gate) only if a route needs an export
```

### Phase critical paths

- **Phase 1a — FIRST-VISIBLE-MOTION (JS-ONLY, no bake, no rebuild):** `14 → 02 → 01 → 12-lite`. Hardcode `TREE_DIDS = {0x02001063, 0x020007A2, 0x02000246, 0x02000406, 0x02000407, …}` (from ESTABLISHED facts). Add `windTrees` peel at `statics.js:1576–1587` + `:2081–2092`; call new `attachWindTrees(scene3d, windTrees, wasmExports)` at `:1829` + `:2363`. In `animated_scenery.js`, add `attachWindTrees` + `getOrCreateWindGroup(syntheticId, rigFn)` that builds the clip from a procedural sinusoid (small Z/X-axis rotation per part) and registers under a `wind:<setupId>` key, sharing one mixer (same `_didGroups`/rAF/cap/cull machinery). **Result: near-field foliage rustles, ≤512 instances, off=frozen.**
- **Phase 1b — structured hinge (JS-ONLY):** `03`. Compute per-part bbox from `takePartMeshes()` in `buildOne`; rig = rotation **about each part's vertex Zmin base** (translate-to-base → quaternion → translate-back, baked into the per-part Frame); weight by height/width. Fixes the co-located-origin shear; canopy hinges, trunk barely moves.
- **Phase 2 — scale + fidelity:** two parallel sub-tracks. (a) **No-bake forest** `04 → 05`: ships immediately, GPU-instanced, uniform-only — the answer to the 512 cap. (b) **Bake pipeline** `07 → 08 → {09 AC-native sidecar | 10 VAT → 06}`: skeleton-driven dense motion on hero trees + VAT forest. Track (a) de-risks track (b) — if the bake slips, the forest still sways via 05.
- **Phase 3 — polish:** `12-full → 13 → 14-tuning`. Storm-coupled gusts, near/mid/far LOD crossover, `?treeWindStrength/Dir/Lod`.

### The ordered, independently-shippable step list (each keeps off ≡ frozen)

1. **S0 — flag scaffold** (14 + 15-lite): `?treeWind` parse (default-OFF), `docs/url-flags.md` row, `windTreesDiag()` counter stub. *JS-ONLY.*
2. **S1 — Phase 1a first motion** (02 + 01 + 12-lite): hardcoded `TREE_DIDS`, **cap-aware** `windTrees` peel at the 4 statics lines, `attachWindTrees` + synthetic rustle clip, constant wind vector. *JS-ONLY.*
3. **S2 — Phase 1b bbox rig** (03): base-pivot hinge replaces the naive clip. *JS-ONLY.*
4. **S3 — no-bake forest shader** (04 + 05): `windWeight` attribute + Crytek two-band material on the BatchedMesh/InstancedMesh forest, per-instance phase from `instanceMatrix`, `loop.js` uniform write. *JS-ONLY — the scale answer.*
5. **S4 — wind state** (12-full): direction/strength/gust module, storm coupling, feeds both player clip and shader uniforms in sync. *JS-ONLY.*
6. **S5 — LOD** (13): near=player/rig, mid=shader, far=frozen; crossover thresholds layered on the 140 m cull + pvsRing. *JS-ONLY.*
7. **S6 — offline skeleton+sim** (07 + 08): dense per-part frames on the buildbox → JSONL sidecar consumed by the player (replaces synthetic clip for hero trees). *OFFLINE-BAKE; runtime stays JS-ONLY via sidecar fetch.*
8. **S7 — AC-native authoring** (09): synthetic Setup 0x02 + dense Anim 0x03, byte-round-trip verified. *OFFLINE-BAKE.*
9. **S8 — VAT forest** (10 + 06): bake VAT textures + VAT runtime shader, upgrades S3's forest to skeleton-driven motion at instanced scale. *OFFLINE-BAKE + JS-ONLY runtime.*
10. **S9 — wasm gate (only if needed)** (11): single batched rebuild for any raw-vert / VAT-meta export, *iff* the sidecar route proves insufficient. *NEEDS-WASM-REBUILD.*

---

## Risks & open questions

| # | Risk | Mitigation | Rollback |
|---|---|---|---|
| R1 | **Joint cracking** — rigid parts rotated independently open gaps at seams (no vertex skinning in AC, ESTABLISHED) | Pivot at the **shared part base**, clamp max angle (≤~5° trunk, larger canopy), overlap/weld geometry at bake; for hero use VAT/continuous vertex displacement, not rigid-part rotation | `?treeWind=off` → frozen merged mesh (statics peel is gated, untouched) |
| R2 | **Co-located-origin pivot shear** (THE central gotcha) — all parts at origin, `parent_index=-1`; rotating canopy about origin swings a huge arc | Task-03 math: rotate about each part's **vertex Zmin base**, never model origin. Assert `pivot.z == bbox.min.z` in unit test | flag-off → frozen |
| R3 | **Perf regression on the 1070** (CPU-bound outdoor ~20 fps) | Player capped 512 (`:43`) + 140 m cull (`:416`); forest is **uniform-only** shader (no per-instance CPU); VAT GPU-instanced. Mixers advanced once per DID (`:394`) not per-instance | flag-off → zero added cost |
| R4 | **OOM on any local `cargo build`** (8 GB laptop) | Phases 1a/1b/05/12/13/14/15 are **JS-ONLY**; bakes (07–10) on buildbox; wasm export (11) deferred to ONE batched gate, built off-laptop | n/a (no build attempted) |
| R5 | **VAT vertexId/order mismatch** with adapter triangulation (non-indexed, per-surface grouped, `[0,2,1]` winding reversal at `adapter.js:777`) | Bake VAT from the **identical `meshToGeometryGroups` output** (replicate group order + winding), key rows by post-group vertex index, embed a vertex-count + checksum assertion in both bake and runtime | flag-off → frozen; or fall back to S3 procedural shader (no VAT) |
| R6 | **512 cap vs forest scale** (one DID has 317 k placements) | Player only for near hero trees; bulk via instanced shader (05)/VAT (06); LOD crossover (13). **Cap-aware peel** (below) | flag-off → frozen |
| R7 | **Cap-aware peel hazard** — peeling `windTrees` from `statics` then dropping over the 512 cap makes trees *vanish* (neither frozen nor animated; existing player drops at `:336`) | Peel **only** the nearest-N that will actually attach; leave the remainder in the frozen `statics` path (forest shader S3 then animates them in place without peeling) | flag-off → all trees frozen |
| R8 | **TREE_DID misclassification** (non-tree sways, or trees double-render) | Seed allowlist from verified top-placement DIDs; gate via part/bbox shape check; keep allowlist auditable (S6 generator). Attach is fail-soft (`:339`) | flag-off → frozen |
| R9 | **Bake non-determinism** (no `Date`/`Math.random` in sandboxes) | Derive per-branch phase from a hash of bone index; fixed loop length; SHA sidecars like existing bakes | re-bake |

**Open questions for the synthesis owner:**
1. **Hero-tree sidecar vs DAT overlay** (S6/S7) — JSONL sidecar fetched like `fetchAnimation` keeps runtime JS-only; a DAT overlay is more retail-faithful but needs the client to mount an overlay DAT. Recommend **sidecar first**, DAT overlay as a later fidelity option.
2. **Does the forest shader (S3) peel at all?** It can animate trees *in place* in the BatchedMesh without peeling — only the player (S1/S2) peels. This makes S3 independent of R7. Confirm the two routes don't both claim the same DIDs (LOD owns the handoff in S5).
3. **Loop seamlessness / fps** for the dense bake (08) — must satisfy Nyquist for leaf flutter while looping cleanly; resolve before S6.
