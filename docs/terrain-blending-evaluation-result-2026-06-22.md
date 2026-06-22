# RESULT — Terrain boundary-blending candidate evaluation (2026-06-22)

Companion to `HANDOFF-terrain-blending-tech-survey-2026-06-22.md`. That doc is the
*survey* (candidates A–G + the eval workflow). This doc is the *verified
evaluation result*: every candidate was run through a multi-agent
**research → adversarial-verify (technical + architecture lenses) → judge**
pipeline, plus four new candidates (H–K) derived from round-1 findings and
re-ranked unified. 35 agents total, ~2.15M tokens.

> Status: **research + ranking complete; nothing implemented yet.** Next step is
> STEP 0 on the 1070 (below). Implement behind URL flags per the survey §4 / §5.

---

## TL;DR

- **Verified root cause** of the user's "noise-jaggy" rejection: the SHIPPED
  `?paintMode=winner` path perturbs corner weights with per-pixel `fragHash21`
  (`terrain.js:1002-1004`) — a value hash with **no spatial interpolation** =
  salt-and-pepper grain. Every candidate was scored on whether it supplies
  spatial coherence to that field.
- **Top pick: H (domain-warped value-noise perturbation) + D (smoothstep soft
  band)**, shipped as two separable flags. H is the lowest-cost realization of
  round-1's verified top pick (B+D) and eliminates B's one verified
  severity:high blocker.
- **The survey doc was materially wrong in several places** — all confirmed by
  both verifier lenses (table below). Most consequential: C is *not* a
  wasm-rebuild job, A is *not* "~2KB / no new data", and E is misattributed and
  needs *no* precompute.

### Unified ranking (A–K)

| Rank | Cand | Score | Conf | One line |
|---|---|---:|---:|---|
| 1 | **H** ✨ | 80 | 0.78 | Domain-warp the boundary noise (reuse in-tree `valueNoise2D`) + soft top-two blend |
| 2 | B | 76 | 0.80 | Voronoise weight perturbation (organic shape; needs new vec3 hash3) |
| 3 | D | 74 | 0.85 | Smoothstep soft-edge band — one `?winnerSoftness` param on the winner block |
| 4 | C | 68 | 0.78 | Triangle barycentric winner (NO wasm rebuild after all) |
| 5 | **K** ✨ | 56 | 0.72 | Macro-variance anti-tiling — the ONLY interior-repetition fix |
| 6 | A | 52 | 0.85 | Histogram-preserving de-mud — POST-FILTER, MEDIUM-HIGH cost |
| 7 | **J** ✨ | 48 | 0.65 | Soft-winner + cheap contrast — contrast op **refuted** on raw sRGB |
| 8 | F | 44 | 0.80 | Fix texMerge composite — "wrong rotation = blocks" premise UNVERIFIED |
| 9 | **I** ✨ | 40 | 0.70 | Bake-time splat field — LB-seam blocker **code-confirmed** |
| 10 | E | 34 | 0.86 | Laplacian finisher (Wronski 2025) — needs a mask our data lacks |
| 11 | G | 8 | 0.90 | Dead — WebGL2/ES3.0 has no geometry-shader stage |

✨ = new candidate added in round 2 from round-1 findings.

---

## The two-axis frame (why the survey under-counted the answer)

The verifiers converged on the problem having **two orthogonal axes**, and most
A–G candidates only fix one:

- **Boundary SHAPE** — where the grass→sand line runs (grid vs organic).
  Tools: B (voronoise), C (barycentric), H (domain warp), the shipped winner.
- **Boundary CROSS-SECTION** — how it transitions across the line (hard 1-texel
  edge vs muddy wash vs sharp-but-distinct). Tools: D (smoothstep band), A
  (histogram de-mud), E (Laplacian).
- **(Bonus) INTERIOR** — single-type tiling repetition ("flat tile / big
  blocks"), addressed only by K.

The survey scored these as rivals; they are halves. The winning play is one cheap
SHAPE tool × one cheap CROSS-SECTION tool — which is exactly H+D.

---

## Verified corrections to the survey doc

| Survey claim | Verdict | Reality (both lenses) |
|---|---|---|
| **C**: "High cost + wasm rebuild required" | **FALSE** | Fragment already reads all 9×9 codes via `uVertexTypes`; cell diagonal `cell_swto_ne_cut` is a portable u32 PRNG (`terrain_subdiv.rs:443`) derivable in GLSL or bakeable. No wasm rebuild for the prototype. |
| **A**: "~2KB LUT, no new data, ~30 LOC, MEDIUM" | **FALSE** | Needs a full second 33-layer Tinput atlas (~33 MiB @512px), **mandatory** PCA color decorrelation (omitted entirely by the survey), a `-0.5` mean-subtract (omitted), and a ~26M-entry boot sort. Real cost **MEDIUM-HIGH**. A only de-muds; it does not shape edges. |
| **E**: "Sharma & Heitz 2025; requires precomputed Laplacian pyramids; atlas memory doubles; ~165 lookups; compose-with: none" | **FALSE** | Single author **Bartlomiej Wronski**, JCGT 2025 (Heitz is only a citation). Uses the **existing mip chain** — no precompute, no memory doubling; bandwidth ~133% not ~5×. Composes with **any** mask supplier (B/H/D/winner). |
| **F**: "ship first; wrong rotation caused the blocks" | **UNVERIFIED (sev:high)** | The rotation-causes-blocks premise is untested; competing hypothesis (A8 masks decode to near-full coverage → rotation irrelevant) is also untested. texMerge default-on already shipped 2026-06-20 and was user-rejected live. Do **not** ship first. |
| **G**: "WebGL2 supports geometry shaders via separate program" | **FALSE** | WebGL2/ES3.0 has **no** geometry-shader stage. G is impossible-as-described (correct conclusion — skip — for the wrong reason). |
| **A/E/F** framed as organic-boundary fixes | **reframed** | A and E are de-mud/finishing **post-filters** that need a blend mask they don't have; F is retail-blocky. Boundary-SHAPE work belongs to B/C/H/winner-perturbation. |

---

## Per-candidate verdicts

### 1 — H ✨ (top pick component) — Domain-warped soft bilinear
- **What:** warp the boundary-noise sample coord with a 1–2 octave value-noise
  fBM (IQ domain warping), replacing the 4 per-pixel `fragHash21` taps; optional
  soft top-two blend over the perturbed-weight gap.
- **Decisive find:** the spatially-coherent primitive already exists in-tree —
  `valueNoise2D` + `fade` (quintic) + `hash21` at **`terrain.js:806-815`**, but
  only in `TERRAIN_VERTEX_GLSL`. H's core impl is a ~6-LOC cross-stage copy into
  the fragment shader (the exact `fragHash21` redeclaration precedent;
  watch the silent black-terrain trap).
- **Cost:** LOW. ~50 LOC total, 3 new float uniforms, **no** new textures, **no**
  vec3 hash3 (B's blocker), **no** wasm rebuild. No Tinput/atlas memory (unlike A).
- **Perf risk:** ~8 vnoise (~16–32 `sin`) / fragment — more than the shipped
  winner (4 `sin`), far less than B (~100 vec3-hash3). MUST `?diag=1` A/B on the
  1070; add a distance-based warp-amp falloff (mirror `uDetailTexFadeStart/End`
  `terrain.js:1512-1523`).
- **Why #1 over B:** delivers B's organic-shape goal AND eliminates B's verified
  severity:high blocker. Held just above B (it's a composition-with-substitution,
  not a new technique class).

### 2 — B — Voronoise-modulated weights
Round-1 #1. Attacks the root cause directly (structured field replaces
salt-and-pepper), drop-in at `terrain.js:1383-1394`, no wasm, no new per-vertex
data. Nudged 78→76 only because H reaches the same goal without B's blockers
(needs a new vec3 hash3; ~100 hash evals/fragment; the survey's Red Blob citation
for voronoise is actually C's technique, misattributed).

### 3 — D — Smoothstep soft-edge band
Round-1 #2, unchanged. NOT an SDF (no source supports a material-boundary SDF
from per-vertex bytes) — it's "winner + tunable smoothstep over the
winner−runner-up gap" as a single `?winnerSoftness` param (NOT a 4th paintMode).
H absorbs D's mechanism; keep it a separable flag so the soft half (which
*opposes* the just-shipped winner-take-all de-mud) can be A/B'd independently.

### 4 — C — Triangle barycentric winner
Round-1 #3, unchanged. Lowest-cost topology reshape onto the retail triangle
diagonal; the survey's "High/wasm" cost is wrong. But it stays jaggy with
`fragHash21` unless it adopts smooth noise (= H/B) — so it's a topology variant
of the same fix, not a separate win.

### 5 — K ✨ — Macro-variance anti-tiling
Verifier-confirmed the ONLY candidate (A–K) attacking interior mono-tile
repetition (the "flat tile / big blocks" half). **~half already ships:** the T7
detail octave (`terrain.js:1515-1527`, `?terrainDetailTex`) and per-vertex
`vBrightness` modulation (`terrain.js:1755`, `?terrainMod`). K reduces to one
new low-freq world-scale fBM brightness multiply.
- **HARD precondition:** A/B the already-shipped `?terrainDetailTex=on` +
  `?terrainMod=on` on the 1070 first — the interior read may already be addressed.
- **Gotchas:** remap fBM to a 0.5-mean field or `MODULATE2X` net-darkens; place
  it AFTER the TexMerge overwrite block (post ~`1500`), not at `1398` (no-op on
  TexMerge LBs); mutually-exclude with `vBrightness` to avoid double-darkening.

### 6 — A — Histogram-preserving blend
De-mud/anti-tiling POST-FILTER, not an organic-boundary fix. STEP-5 escalation
only, for muddy-bilinear *wash* (not mono-tile repetition). Cost MEDIUM-HIGH.
K does NOT subsume A — A is analytically variance-correct where K is a brightness
heuristic.

### 7 — J ✨ — Soft-winner + cheap contrast — **partly refuted**
Heavily derivative (shape = B verbatim, soft band = D verbatim, de-mud = A's
variance op with Gaussianization stripped). Its one non-redundant lever is
**refuted**: the `rsqrt` variance op is defined only in the Gaussianized/linear
domain; applied to raw sRGB corner colours (`terrain.js:1346-1349`) it
amplifies/clips rather than preserving contrast. Salvageable only as an OVERLAY
(not linear-light, not bare rsqrt) in linear space — a "partial mud offset on
2-type edges," not a free A. Treat as a STEP-3.5 refinement, not a ship path.

### 8 — F — Fix texMerge composite
Bit-exact selection, JS-togglable, but the load-bearing premise is unverified
(sev:high). Only revisit if the user explicitly accepts retail-blocky AND a
mask-coverage decode check first proves the rotation hypothesis.

### 9 — I ✨ — Bake-time splat field — **blocked**
Genuinely distinct (the only bake-time/texture-space proposal) and offers
temporal stability (a fixed field can't shimmer). But **code-confirmed LB-seam
blocker**: `build_terrain_merge_data` (`lib.rs:974-983`) and `uVertexTypes` are
strictly LB-local with zero neighbour access → a baked control texture
ClampToEdge at the 192 m seam = the exact artifact already rejected. On the
root-cause metric it is strictly weaker than B. Conditional downstream fallback
only (if H/B shimmer in motion), and only after resolving the seam JS-side with a
2–3 cell neighbour skirt.

### 10 — E — Laplacian finisher
Mask-driven finishing filter; needs only the existing mip chain (survey was wrong
about precompute/memory). But our 1-byte/vertex data carries no smooth mask, so E
is not standalone — late polish only, after a mask supplier (B/H/D) ships.

### 11 — G — Voxel 4-weight blend — **dead**
Unanimous no-fit. No geometry stage in WebGL2; requires real 4-material-per-vertex
data we cannot supply; the shipped bilinear path IS already the 4-material
weighted average it would reinvent. Skip permanently.

---

## Recommended implementation sequence

**STEP 0 — Decide the complaint target (gates everything; called decisive-and-
unresolved by round-1 + every H/J verifier).** On the 1070, A/B the shipped
`?paintMode=winner` vs bilinear at LB `0xcf9e` (4-type cell) + `0xcd9d`. Is the
"graininess" the boundary PATH (salt-and-pepper shape → warp/B fixes) or the hard
per-fragment EDGE (→ D soft band fixes)? Also A/B already-shipped
`?terrainDetailTex=on` + `?terrainMod=on` to learn whether the interior flat-tile
read is already addressed (gates K). **Read console first** (silent black =
link error, invisible to console / `node --check`).

**STEP 1 — Prototype H's warp half FIRST** (lowest cost; attacks the PATH half;
preserves the deliberate winner-take-all de-mud). Cross-stage redeclare
`valueNoise2D` + `fade` + `hash21` into the fragment stage (verbatim copy of
`terrain.js:806-815`, rename `frag*` to avoid the `fragHash21` collision — ALL
THREE symbols). Swap the 4 `fragHash21` taps at `1383-1386` for domain-warped
`valueNoise2D`. New `?warpAmp` / `?warpFreq` floats, threaded via the
`?paintNoiseFreq` template (reader `2271-2290` → `resolveTerrainRingOpts` `1823`
→ uniform wire `3006-3007`). **Keep the hard argmax at `1391-1394`** for now — a
clean test of the PATH-vs-EDGE question.

**STEP 1-VALIDATE — bake in-world on the real 1070** (swiftshader is blind to
perf AND silent-black-on-link-error). `?diag=1` frame-time A/B (warp on/off);
eye-check shimmer IN MOTION + the 4-type junction at `0xcf9e`.

**STEP 2 — only if the hard edge still reads grainy:** add D's soft band behind a
separate `?winnerSoftness` (default 0). Replace the argmax with a smoothstep over
(winnerWeight − runnerUpWeight), tracking runner-up weight+colour through the
4-way cascade (~12–15 LOC). Narrow default; verify `fwidth` stability on the
warp-perturbed quantity on the 1070 (it must not shimmer).

**STEP 3 — add distance-based warp-amp falloff** (mirror `uDetailTexFadeStart/End`
`1512-1523`) before the final `?diag=1` perf A/B — the paint block has no distance
fade, so the per-fragment `sin` cost applies full-rate to far terrain. This is the
omitted perf risk most likely to fail the 1070.

**STEP 4 — only if interior mono-tile repetition persists** after the boundary is
fixed: prototype K as a low-freq world-scale fBM brightness multiply, placed AFTER
the TexMerge block (post ~`1500`), 0.5-mean remap, `vBrightness` mutual-exclusion.

**STEP 5 — only if interior is muddy-bilinear WASH** (not tiling): escalate to A
(histogram-preserving), budget MEDIUM-HIGH (second Tinput atlas sized from runtime
`built.tileSize`, mandatory PCA, mean-subtract).

**STEP 6 — park F, E, G, I, J** as standalone fixes (per the verdicts above).

**Ship rule:** per the project's default-on / no-eye-test-gate convention, ship
once the 1070 batch passes (loads + spawns + 0 errors); `?warpAmp=0` degrades to
the shipped winner look for a clean escape hatch.

---

## Anti-patterns reaffirmed (from §5 + verifiers)

- Sample noise at `vWorldPos.xy` (continuous), never `vGridUv` (192 m LB repeat).
- Any helper used in the fragment stage must be **declared** there — a
  vertex-only helper → silent black terrain.
- No backticks / `${}` in GLSL comments (closes the JS template literal).
- Don't trust `node --check` for shader-string edits; validate via in-world bake.
- Keep the `allSameType` early-out + `uPaintMode>0.5` gate so animated water stays
  smooth (bf563c5a).

---

## Method

Two background workflows (Opus 4.8): round 1 evaluated A–G (22 agents); round 2
added H–K and re-ranked unified (13 agents). Each candidate: 1 research agent
(read handoff + fetched primary papers + read our actual `terrain.js` /
`adapter.js` / `lib.rs`) → 2 adversarial verifiers (technical-vs-source +
architecture-vs-code, each prompted to refute) → judge. Round-2 judge ingested
round-1's verified results for a single A–K ranking. Round-1 A–G summary cached at
`/mnt/wbterminal1/tmp/claude-scratch/terrain-blend-research/prior-AG-summary.json`.
