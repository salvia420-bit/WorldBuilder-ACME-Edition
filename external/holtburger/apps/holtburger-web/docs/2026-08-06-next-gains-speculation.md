# Where the next gains are — speculation, graded by evidence (2026-08-06)

Forward-looking companion to `2026-08-05-1070-black-flicker-and-renderer-oom-handoff.md`,
which is the measured record. **This document is mostly speculation and says so per item.**
Each entry is tagged:

* **MEASURED** — a number from this tree on the 1070.
* **INFERRED** — follows from measured numbers plus code that was read.
* **SPECULATIVE** — plausible, unmeasured, could be wrong.

> A note on sourcing: the draw-call article that prompted this
> (`threejsroadmap.com/blog/draw-calls-the-silent-killer`) returns **HTTP 403** to a
> non-browser fetch, so nothing here is drawn from it. Everything below comes from this
> tree's own measurements and from three r184's source.

---

## 0. First, a correction to carry forward

The 08-05 handoff §12 reports "draws / frame 55.4 → 47.8". **That unit is wrong.**
`info.render.frame` is incremented inside `renderer.render()` (three.module.js:17631), i.e.
once per render CALL — and this client makes several per displayed frame (shadow map, sky,
atmosphere, composer passes). So 55.4 is **draws per `render()` call**; the displayed-frame
total is that times the pass count, which was never measured.

The A/B *ratio* stands — same instrument on both arms — but nobody should quote 47.8 as a
per-frame draw count. Getting the real number is item 1 below, and it is the cheapest
thing on this list.

---

## 1. MEASURE the frame first — nothing here should be built before it

**MEASURED, and it is the whole problem:** the last frame-budget reading on this box was
**median 61.5 ms (~16 fps), p95 89 ms, worst 279 ms, at 1,058–1,598 draw calls**
(quality `mid`, `?renderScale=1&adaptiveRes=off`; §6 of the 08-05 handoff). That is the
user-visible complaint, and **we do not know whether it is CPU-bound or GPU-bound.**

Draw calls are a CPU-side cost — per-call state validation and command submission. If the
61.5 ms is GPU-bound (overdraw, fragment cost, POM marching, the atmosphere pipeline) then
every draw-call optimisation below buys nothing. The two are distinguishable in about ten
minutes:

* draws per DISPLAYED frame: reset `info` at frame start, read at frame end, and count
  `render()` calls per rAF alongside;
* CPU vs GPU: `EXT_disjoint_timer_query_webgl2` for GPU time, versus wall-clock spent
  inside the rAF callback. A frame where the callback is 8 ms and the frame is 61 ms is
  GPU- or present-bound, and the entire draw-call thread of work is the wrong tree.

**Do this before anything in §2.** The last three findings in this investigation each
overturned a plausible theory that had never been measured.

---

## 2. Draw calls — where they are still being spent

### 2a. `ptLayerFull` spills, and a ceiling that is now free to raise — INFERRED, cheap

**MEASURED:** at Nanto, `ptLayerFull` is **15–19 in both arms** of the 08-06 run. Each
spilled prop renders as an unbatched singleton — one extra draw call apiece, permanently,
for as long as that landblock is resident.

`_ATLAS_NRA_MAX_LAYERS = 128` was halved from 256 *purely as a memory bound* — the comment
says so. That trade no longer exists: since 2026-08-06 buckets **allocate what they use**
(1,941 layers → 160 for identical work). Raising the ceiling now costs nothing until a
layer is actually taken. One measured bucket sat at `cap=25 used=25`, i.e. already spilling.

**Expected:** 15–19 fewer draw calls per resident set, for a one-line change plus a
measurement. Small in absolute terms — which is exactly why item 1 matters: if the frame is
GPU-bound, 19 draw calls is noise.

### 2b. Bucket fragmentation — SPECULATIVE, potentially the bigger half

**MEASURED:** 21–29 buckets live at Nanto. A bucket is a `BatchedMesh` — at least one draw
call each, and the key is `512x512|0|0|1|b1|w|f7`: tile size crossed with render state
crossed with format. Two buckets differing only in a boolean render-state field cannot
share a draw call.

**SPECULATIVE:** if the state fields fragment more than the tile sizes do, then merging
compatible states (or normalising the ones that do not affect the shader) could collapse
29 buckets toward the ~6 distinct tile sizes. The measurement is one line — histogram the
bucket keys by their components and see which field is doing the splitting. Nobody has
looked.

### 2c. Instanced animated scenery — MEASURED elsewhere, still not landed

`MEMORY.md` records **2× fps, live-proven on 2026-07-02**, for instancing animated scenery,
and notes the "5,400-singleton wall RE-OPENED via anim-scenery". This is the largest
draw-call item on the list and it already has a measured result behind it. It is not in
this tree.

### 2d. The retail model — SPECULATIVE, large, and the honest long game

Retail AC used a refcounted `DBOCache` plus a fixed slot grid (`LScape::update_block`).
`MEMORY.md` frames our jank as per-LB re-decode plus bulk evict against that. The
residency work landed 2026-08-05/06 (byte budgets, grow-on-demand, the wasm staging seam)
moves in that direction without adopting the shape. Adopting it properly is a subsystem,
not a patch, and should follow item 1 and 2c rather than precede them.

---

## 3. Memory — what is left after the residency work

**MEASURED at Nanto after the 08-06 work:** heap 2,003 MB, live textures 863 MB, wasm
630 MB page-wide. Remaining rows worth naming:

| row | MB | status |
|---|---|---|
| BC7 singletons (`bc7_textures.js:307`) | ~261 | co-owned with the record cache |
| NRA + diffuse atlas arrays | ~151 | now allocation-follows-use |
| terrain BC7 array | 88 | session singleton |
| per-surface planes (`materials.js`) | ~74 | the only class `?texFreeCpu` releases today |

* **BC7 singletons — INFERRED.** `makeBc7Texture` passes `parsed.levels` through with no
  copy, so the texture and `Bc7RecordSource._cache` share one buffer. That is already
  optimal for a *resident* surface; the win would be dropping the record once the texture
  exists and re-fetching on demand, which needs an async seam in the synchronous atlas feed.
  Bounded at 256 MB since 2026-08-05, so it can no longer grow without limit.
* **NRA compression — SPECULATIVE, ~113 MB.** The NRA array is uncompressed RGBA8 while its
  diffuse twin ships BC7 — that asymmetry is why it was 4.4× larger before the growth fix
  and is still ~4× per layer. Normal+roughness+AO is exactly what BC5/BC7 is for. This is a
  bake-pipeline change, not a renderer one, and it would cut both the CPU mirror and the
  VRAM copy.
* **`?texFreeCpu` — MEASURED once, unarmed.** −107 MB live / −206 MB heap in a single
  paired run, 0 re-hydration failures. Owed an ABAB before arming, like the three budgets
  before it.

---

## 4. A second-order gain nobody was aiming for — INFERRED

`webgl_context_recovery.js` records context loss **observed 7× per session on the 1070**
under VRAM pressure, and every loss is a visible hitch plus a full re-upload. The atlas
growth fix cut GPU-side array allocation by the same factor as the CPU side (allocation is
what `texStorage3D` reserves), so VRAM pressure should fall materially.

**SPECULATIVE but cheap to check:** if loss frequency drops toward zero on a long session,
that is both a stability win and a signal that we have headroom to spend elsewhere — for
instance on raising the atlas ceilings in 2a. `__webglContextRecoveryHistory()` already
records every event; a long soak would answer it for free.

---

## 5. Debts, so they are not rediscovered

* **ABAB interleaves owed** by `?matBudgetMB`, `?surfaceBudgetMB`, `?bc7RecordsMB` and
  `?texFreeCpu`. This workload's variance is why: two control runs ten minutes apart
  differed by **40 % in bucket count and 400 MB in heap**. Single A/B runs have already
  misled this investigation once.
* **`test_stat_geom_dedup.mjs` fails 2/40** on master — verified pre-existing by stashing
  the whole tree. Untouched by the residency work, unexplained.
* **`lint-url-flags.mjs` exits 1** and always has: two un-waived `PRESENCE-GUARD` rows
  (`cells.js:571`, `atmosphere_pipeline.js:584`). Reading its *message* ("0 undocumented
  readers") is the correct check; reading `$?` through a pipe is not, and that artifact
  produced several "lint clean" claims in this session's commits that were imprecise.
* **`index.html`'s `modulepreload` block is stale** — missing at least `texture_census.js`,
  `surface_planes.js`, `texture_rehydrate.js`, `xu7_textures.js`, and listing modules no
  longer statically imported. `node scripts/gen-modulepreload.mjs` regenerates it; costs one
  cold-boot round-trip per missing leaf.
* **Census line numbers moved.** The NRA creation site the 08-05 census recorded as
  `static_atlas.js:271` is now `:341`. Any diff against
  `RESULTS-texture-census-2026-08-05.json` must account for that.

---

## 6. Suggested order

1. Measure the frame (§1). Ten minutes, and it decides whether §2 is worth anything.
2. If CPU-bound: 2a (free), then histogram the bucket keys (2b), then instanced
   anim-scenery (2c) — which already has a 2× result behind it.
3. If GPU-bound: none of §2. Go at overdraw, POM, and the atmosphere pipeline instead, and
   treat §3's NRA compression as the memory item worth doing anyway.
4. Either way, the ABAB debt in §5 before any more flags get armed.
