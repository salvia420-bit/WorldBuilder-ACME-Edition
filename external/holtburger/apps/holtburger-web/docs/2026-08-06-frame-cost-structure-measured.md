# The frame, measured — and four theories it kills (2026-08-06)

Successor to `2026-08-06-next-gains-speculation.md`, which asked for exactly one thing
first: **decide whether the frame is CPU- or GPU-bound before building anything in its §2.**
That is now decided, and the answer invalidates a good deal of what followed it — including
two of its own items and, first, a theory of my own.

Everything here is measured on the 1070 at Nanto, quality `mid`,
`?renderScale=1&adaptiveRes=off`. Where a number is an estimate it says so.

---

## 1. The frame is CPU-bound. It is not close.

The speculation doc proposed plumbing a GPU timer query. That was unnecessary — the tree
already has one: `?vfxGauge=on` wraps the render window in
`EXT_disjoint_timer_query_webgl2` and publishes `window.__diag.vfxGauge.tGpuMs`
(`scene3d/index.js` `_vfxGaugeArm`). It needs `?renderDiag=on` alongside it, because
`vfxGaugeEndFrame` is called from the first line of `recordRenderDiag`.

The decisive test needed no code at all: sweep `renderScale` **inside one session** via
`window.__setRenderScale`, which varies only the pixel count while draw calls, geometry and
per-frame CPU stay byte-identical. Three interleaved pairs, draws pinned at 509:

| pixels | p50 frame | GPU timer | CPU in render window |
|---|---|---|---|
| 1.216 Mpx | 25.8 ms | 18.3 ms | 18.7 ms |
| 0.148 Mpx | 26.3 ms | 16.9 ms | 18.8 ms |

**8.2× fewer pixels changes nothing.** Not fill-bound, not fragment-bound, not overdraw.
Every item in the speculation doc's §3 ("if GPU-bound: go at overdraw, POM, and the
atmosphere pipeline") is the wrong tree.

Two of that doc's open questions close as a side effect:

* **§0 — the missing per-displayed-frame draw count.** It is **~509**, not 47.8. The world
  scene is submitted **once** per displayed frame (there is no hidden double-render), and
  that single submission is ~486 draws and ~18.7 ms of CPU in a ~25.8 ms frame.
* The `perf/perf_sampler.cjs` collector already sets `renderer.info.autoReset = false` and
  computes draws-per-displayed-frame, so this was measurable all along.

---

## 2. Where the CPU actually goes

Timed by wrapping `renderer.render`, `renderer.renderBufferDirect` (three's single funnel for
every real draw) and `BatchedMesh.onBeforeRender`:

| part | ms/frame | share |
|---|---|---|
| `renderer.render()` total | 24.22 | — |
| ├ `renderBufferDirect` — the draw funnel | 12.78 | 53% |
| ├ `BatchedMesh.onBeforeRender` — multidraw rebuild | 5.72 | 24% |
| └ remainder — sort / projectObject / uniforms | 5.72 | 24% |

Per draw, attributed by owner (note the 5.5× spread — this is the single most useful number
on this page):

| what | draws/frame | ms/frame | µs/draw |
|---|---|---|---|
| `statics \| static-batch-c` | 177 | **6.56** | 37 |
| `statics \| Mesh` | 49 | 2.12 | 43 |
| `statics \| stat-atlas-x` | 28 | 1.52 | **54** |
| `buildings \| Mesh` | 81 | 0.79 | **9.8** |
| `entities \| Mesh` | 27 | 0.34 | 12.7 |
| `statics \| particle` | 28 | 0.30 | 10.5 |
| `terrain \| BatchedMesh` | 1 | 0.10 | 96 |

Also measured: **71% of draws change material, and there are 160 program switches per frame
against only 79 distinct programs** — i.e. programs are re-bound roughly twice each because
draw order does not group by program.

### The rule this establishes

**Draw COUNT is a poor proxy for frame cost here.** The landed `?skipDeadAlpha` change removed
**12.1%** of draws and bought **2.8%** of frame time (~11 µs for those draws against a ~28.5 µs
average). Any plan that ranks draw-call work by count will over-promise. Rank by measured
µs, or measure first.

---

## 3. Four theories, killed by measurement

Recorded because each was plausible, and one was mine.

### 3a. "The 08-05 Remacri/t1024/MSAA/aniso stack caused the slowdown" — WRONG

The `mid` preset comments record 35.2 ms / 28.4 fps on the 1070 on 2026-07-30; the 08-05
handoff §6 records 61.5 ms. Three GPU-cost commits land exactly in that window — `412d2ee9`
(t1024 Remacri default, 4× terrain texel area), `717b409e` (2× MSAA on the composer RTs),
`0d75b247` (terrain anisotropy floor 4 → 16). The timeline is perfect and the mechanism is
plausible.

It is still wrong, because §1 shows the frame is not fill-bound at all. Remacri is a real and
heavy cost — in memory, in VRAM and on the wire (81 MB vs 20 MB first visit) — but it is not
what the frame time is made of. **This is why §1 had to come first.**

### 3b. "`ptBc7Deferred` is stranding props outside the atlas" — REAL, BUT NOT THE LEVER

`nodesIn 572, atlased 120, ptBc7Deferred 452` — 79% of props offered to the texture-array
atlas are held out by `bc7AtlasShouldDefer` (`static_atlas.js`), a race between the
synchronous batching feed and the async BC7 upgrade. The gate's own comment says the only
second chance is "the next per-LB feed after eviction/re-entry"; there is no re-feed when the
record actually lands.

Both follow-ups failed to pay:
* `?texBc7=off` (which makes the gate structurally unreachable) took `ptBc7Deferred` to 0 and
  lifted atlas admission 21% → 67% — and moved the frame 25.8 → 25.2 ms.
* Leaving Nanto and returning (BC7 now warm) lifted admission only 21% → 28%. The deferral is
  structural, not a cold-cache artifact.

### 3c. "Route everything through the atlas" — BADLY WRONG, and it reverses the premise

`?staticBatch=off&texBc7=off` sends the whole statics population to the atlas:

```
nodesIn 23,563 · atlased 4,527 into 20 buckets · 22,365 singletons
draws/frame 4,576 · p50 89 ms
```

That is the old 5,400-singleton wall. Note `nodesIn` — **23,563 here against 572 by default.**
The material-keyed batcher is absorbing ~23,000 props into 376 buckets (61:1) and handing the
atlas only its leftovers. The atlas is the *weaker* merger on volume; it is the *stronger* one
only on the narrow class it can admit. Any plan that treats the atlas as the main event has
the pipeline backwards.

### 3d. "Per-instance frustum culling is costing 5.72 ms" — HALF RIGHT, NOT SHIPPABLE

`static_batch_x.js` sets `perObjectFrustumCulled = true` on all 396 buckets (26,586
instances), and `BatchedMesh.onBeforeRender` does cost 5.72 ms/frame. Interleaved A/B:

| `perObjectFrustumCulled` | p50 | ktris/frame |
|---|---|---|
| on (shipped) | 31.4 ms | 516 |
| off | 31.0 ms | 936 |

Turning it off saves **0.40 ms** and costs **+420k triangles/frame (+81%)**. So the 5.72 ms is
overwhelmingly the multidraw-array *rebuild*, not the sphere tests — the cull is nearly free
and pays for itself. The trade would invert on weaker hardware. Do not ship this.

---

## 4. Corrections owed to the speculation doc

* **§2a (`ptLayerFull` spills, "the cheapest thing on this list")** — measured **0**, with
  `allocLayers 74` against `capLayers 1388`. The ceiling is not binding; raising it does
  nothing. The counter that *is* saturated is `ptBc7Deferred` (452), which that doc does not
  mention.
* **§2c ("instanced anim-scenery … is not in this tree")** — **false.** It landed
  2026-07-02 in `ca8e5e03`, is default-ON (`?animSceneryInstanced`), and measures 4–6 draws
  for the whole animated-scenery population.
* **§2b (bucket-key fragmentation)** — right question, wrong buckets. It reasons about the
  19–28 `stat-atlas-x` buckets, which are 1.52 ms of a 24 ms frame. The 396 `static-batch-c`
  buckets are where the fragmentation actually is (§5).
* **The entity rigs the doc never mentions** were the largest single block in the frame at
  170 draws — and 76 of those were rendering nothing (see `?skipDeadAlpha`, commit eb2ac114).

---

## 5. Where the remaining cost is concentrated

Roughly **12.3 ms of the 24 ms frame scales with bucket count**: 197 rendered buckets ×
(~29 µs `onBeforeRender` + ~37 µs draw). So what sets the bucket count?

`static_batch_x.js` keys buckets by **(3×3-LB region, material OBJECT identity)** — a `Map`
keyed by the object, not by a value. Measured across the 396 live buckets:

| | count |
|---|---|
| buckets | 396 |
| instances across them | 26,586 |
| distinct material **objects** | 95 |
| distinct material **values** | 76 |
| distinct render **states** | **7** |
| buckets if keyed by (region, material value) | 361 (−8.8%) |
| buckets if compatible surfaces shared ARRAY textures | **86 (−78.3%)** |

**Bucket count is set by texture identity, not render state — there are only 7 render states
in the entire scene.** Merging by value alone recovers 35 buckets; the real ceiling needs
compatible surfaces to share array textures, which is exactly what the atlas does for the
narrow class it admits.

**Do not multiply 310 × 66 µs and quote 20 ms.** Per-bucket cost has a fixed component and a
per-instance component, and merging removes only the fixed part — the instances still exist.
So the split had to be measured before any of this could be believed.

### 5a. The split, measured — and it is NOT the same on both halves

No synthetic scene was needed: 197 live buckets already vary widely in instance count, so
per-bucket time was regressed against it, `t = fixed + perInstance × n`.

| half | fixed | per-instance | r² | fixed share |
|---|---|---|---|---|
| `BatchedMesh.onBeforeRender` (rebuild) | 5.9 µs/bucket | 0.348 µs | 0.876 | **20%** |
| `renderBufferDirect` (draw submission) | **37.6 µs/bucket** | 0.038 µs | **0.014** | **90%** |

The onBeforeRender model reproduces its own measurement (197 × 5.9 µs + 13,195 × 0.348 µs =
5.74 ms against 5.75 ms observed), which is the check that it is not overfitted.

The two halves behave oppositely, and that is the whole finding:

* **The rebuild is 80% per-instance.** Merging buckets barely helps it — 396 → 86 recovers
  only **0.65 ms**. Taken alone this looked like a reason to abandon merging, and for one
  measurement it was.
* **The draw submission is 90% fixed, with r² = 0.014 against instance count** — i.e. a draw
  costs essentially the same whether its multidraw carries 5 instances or 500. That is the
  signature of per-draw state validation and binding dominating, and it is consistent with
  the independently measured *71% of draws change material* and *160 program switches for 79
  programs*.

**Merging 197 → ~43 buckets therefore saves ~5.79 ms on the draw side plus 0.65 ms on the
rebuild: ~6.4 ms of a ~24 ms frame, about 27%.** That is ~9× what `?skipDeadAlpha` bought,
and it makes array-texture merging the clear top lever — but on the strength of the *fixed
draw cost*, not the bucket count that first suggested it.

Caveats that stay attached to that number: it assumes merged buckets inherit the 396 → 86
ratio and gain no new per-bucket cost, and it is a Nanto-only figure.

---

## 5b. Half the frame is in the transparent pass, and it costs double

Splitting the draw funnel by `material.transparent`:

| pass | draws/frame | ms/frame | µs/draw | reorderable |
|---|---|---|---|---|
| OPAQUE | 215.1 | 4.28 | 20 | yes — three sorts by `material.id` |
| TRANSPARENT | 212.0 | **8.70** | **41** | **no** — z-sorted, blend order is load-bearing |

Half the draws are transparent and they cost **2× per draw**. (Ignore the "1697 distinct
programs" the first run printed for that pass — the probe fell back to `material.version`,
a mutable counter, when `material.program` was absent. It is an instrument artifact.)

The opaque pass has only **7 distinct programs** and 42 switches, so §6.2's reordering idea
is worth at most ~35 switches/frame — much smaller than the raw 160 suggested.

**The interesting part is what is IN the transparent pass.** `applyClipMapRenderState`
(`materials.js`) sets `transparent = true` *together with* `depthWrite = true` on ClipMap
surfaces — foliage, fences — to reproduce retail's `SetAlphaBlendEnable(1)` +
ONE/INVSRCALPHA. But that is a binary alpha **mask** with z-writes: it does not depend on
blend order the way a true translucent surface does, yet it pays the transparent pass's
per-frame z-sort and forfeits the opaque pass's grouping. `?clipMapParity=ref` already keeps
the correct alpha reference while leaving `transparent = false`.

Toggled in-session on exactly the ClipMap-flagged materials (54 of 272 transparent
materials), three interleaved pairs:

| arm | p50 | p95 |
|---|---|---|
| transparent (shipped full parity) | 32.3 ms | 39.1 |
| opaque pass (alphaTest only) | **30.2 ms** | 36.4 |

**2.10 ms, 6.5%, from 54 materials** — 3× what `?skipDeadAlpha` bought, and the largest
single result of this session. It is deliberately NOT shipped here: full ClipMap parity was a
considered retail-fidelity decision (RND-08/33) and the edge blend genuinely differs, so this
needs an eye-test, not a flag flip. But it is the best measured lead on the board.

---

## 5c. A correction to this document

An earlier revision said the 4 invisible statics buckets held **"~21,845 triangles"**. They
hold **27**. That figure was `position.count / 3` read off a `BatchedMesh`, which reports its
**allocated** vertex buffer rather than used geometry — `_INIT_VERTS = 1 << 14`, and
4 × 16384 / 3 = 21,845 exactly. The live number is
`__statBatchXStats().deadBatch.triangles`.

Consequences, stated plainly: `?skipDeadBatch` saves 4 draws and 27 triangles, which is below
this workload's noise floor. It ships because it is provably output-identical and because the
missing `__baseTranslucency` stamp it fixes was a real divergence between the two surface
decoders — **not** as a performance win, and it should not be expected to move a frame
number. The rule to carry: never size a batch from its geometry attributes; ask it for its
used extent.

---

## 6. Order, on evidence

1. **ClipMap surfaces out of the transparent pass — 2.10 ms / 6.5% measured (§5b).** Largest
   result on the board, one existing flag away, and it needs an eye-test rather than
   engineering. Do this first.
2. **Array-texture bucket merging — ~6.4 ms/frame (§5a).** Bigger, but a subsystem. The
   gating fixed-vs-per-instance measurement is done and came back positive.
3. Program-switch ordering — **downgraded**. §5b measured the opaque pass at 7 programs / 42
   switches, so the reorderable headroom is ~35 switches/frame, not the 160 the aggregate
   suggested. The transparent half cannot be reordered at all.
4. Bucket merging by material *value* (−35 buckets, ~1.3 ms by the §5a fixed cost) — the
   tractable half, no format work.
5. `ptBc7Deferred` re-feed — worth doing on correctness grounds (79% of props miss the atlas
   because of a race), but §3b measured its frame value at ~0.6 ms. Do not sell it as perf.
6. Anything in the old §3 (overdraw, POM, atmosphere) — only if §1 is ever re-measured and
   comes back different.

## 7. Method notes worth keeping

* **Interleave within one session.** Every A/B here toggled arms in a live page rather than
  rebooting, because two control runs ten minutes apart have differed 40% in bucket count on
  this workload. The `perObjectFrustumCulled` result (0.40 ms) is smaller than that noise and
  would have been unreadable across boots.
* **Settle on `draws/frame` before sampling.** The first sweep of this session was wasted: the
  scene was still streaming, draws climbed 291 → 523 across arms, and the arms were not
  comparable.
* **A pixel-diff is not a regression test on an animated scene.** The `?skipDeadAlpha` arms
  differed in 20.1% of pixels — against a same-arm control of 16.9%. Swaying foliage and
  animated water dominate; the comparison cannot resolve a change of this size. Freeze the
  clock or argue from the blending math.
* `window.liveScene3d` is a one-time init snapshot, and `__cam`/`__set*` helpers attach only
  after `in-world`. Boot goes `ready` → `in-world` in ~350 ms, so a 1 s poll for exactly
  `ready` misses it — accept either.
