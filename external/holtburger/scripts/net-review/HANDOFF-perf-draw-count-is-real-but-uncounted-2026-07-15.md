# HANDOFF — the draw counter was blind (3.9×). Fixing it did NOT make draws the cause: the frame is bound by PER-OBJECT work.

> **Read §4c first.** This document's original title said "the frame IS draw-bound". A profile then killed that:
> cutting TRUE draws **−63%** bought only **−10.5%** CPU, and the top self-time item is **`getParameters` (10.2%)** —
> three's program-resolve path (~19%), not draw submission. The **counter really was blind** (that stands), but
> **a better metric is not a mechanism.** The title is kept in the filename for continuity; the thesis is corrected below.

**Date:** 2026-07-15 · **Box:** wbterminal laptop → 1070 (tailscale, CDP :9333, real GPU) · **Self-contained.**
Supersedes `HANDOFF-perf-cpu-bound-submission-2026-07-15.md` (`94e357f2`/`fb212e4d`). Its §3.1 directive
("run `draw-budget-probe.mjs`, pick the target from the census, not from intuition") was followed exactly,
and the census refuted, then re-confirmed, then RE-AIMED its own headline. Read the predecessor only for
the reasoning trail and for §3.3/§4, which are untouched and still owed. Every number that matters is
restated here; the ones the predecessor got wrong are corrected in §1.
REPO=`/home/wbterminal/WorldBuilder-ACME-Edition`, HOLT=`$REPO/external/holtburger/apps/holtburger-web`,
net-review=`$REPO/external/holtburger/scripts/net-review`.

---
## 0. TL;DR — where we are

- **`renderer.info.render.calls` UNDERCOUNTS THE FRAME BY ~3.9×.** Holtburg is not a 1,920-draw frame; it
  is a **~7,500-draw frame**. A `BatchedMesh` submits one multiDraw *range per visible instance* and three
  counts the whole multiDraw as **`1`** (`three.module.js:4449`, literal `1`). §2.
- **⭐ `statics` is 78% of the REAL draws (5,791/frame) while `info.calls` reported 9.5% (183/frame).**
  It is also 59% of render CPU. Those two facts only agree once the counter is corrected — and they now
  agree exactly. §2.
- **⚠ The predecessor's "draw-call COUNT is the lever" thesis is now REFUTED — by building it (§4b).**
  `?walkInInstance` cut TRUE draws **7,563 → 2,761 (−63%)** and renderCPU moved only **28.14 → 25.19 ms
  (−10.5%)**; the ~2.4 µs/real-draw model predicted ~11.5 ms. What survives is narrower and still useful:
  a census read through `info.calls` **cannot see the target at all** (it ranks `cells` 4× above `statics`,
  which owns 78% of real draws). **The instrument was broken AND the thesis was wrong** — two separate
  errors that happened to point the same way. §2, §4b, §4c.
- **`BatchedMesh` is NOT the bug** — it is working as designed: it saves state binds, not draws (one
  multiDraw range per instance). ⚠ The per-draw µs figures this document derived from it (2.4 / 4.7 / 7.9 /
  11.7) are **NOT a cost model** — dividing a subtree's CPU by its draws assumes draws cause that CPU, and
  §4b proved they mostly do not. Do not plan with them. §3, §4b.
- **⭐ THE LEAD: INSTANCE the batched statics. ~17,774 → ~375 real draws.** The "singletons" are not
  singletons: **17,774 instances share only 324 distinct geometries (54.9×)**, and the top geometry is drawn
  **1,736 times**. Root cause: the **walk-in/streaming baker never instances anything** — it emits one plain
  Mesh per placement (`statics.js:2023`), and only the ring-wide baker groups by modelId (`:2723`). §4.
- **⭐⭐ THE FRAME IS PER-OBJECT WORK, AND IT IS IN-FRAME — VERIFIED BY SPLITTING THE PROFILE BY ANCESTOR.**
  `profile-split-render.mjs`: **78.8% of samples are inside `render()`; BAKE/compile is 0.0%** — so the
  profile IS the frame, and the program-resolve path is **14.7% in-frame** (halved to 7.3% by
  `?walkInInstance`, which is what its −10.5% win actually was). I retracted this in §4d fearing bake
  contamination; **the retraction was wrong and is withdrawn.** §4c/§4d.
- **⚠ THE OPEN QUESTION (hand this over): the profile says `getProgram` runs per object per frame; §4d
  measured every trigger that can cause that as STABLE. Both cannot be true.** Likeliest hole is mine —
  `version-churn-probe` v1 saw only PRE-EXISTING materials, and a NEW material forces a resolve
  (`__version === undefined`). Else: vendor a patched three behind an importmap override and count which
  condition fires (three is CDN-loaded, `index.html:951` — that is why it was not instrumented in place).
- **Five triggers for a per-frame program re-resolve were each MEASURED and each is dead** (§4d): version
  churn (1 obj/frame — the known §5.1 residual mesh), class thrash (B−P = 0.10 ms), lights-state version
  (0 changes/430f), env/fog/toneMapping/clipping (0/339f), vertexAlphas (impossible for statics). **Nothing
  forces a per-frame re-resolve**, which is itself evidence the §4c reading was wrong.
- **On the predecessor's ⭐⭐ §3.2 lead I was wrong TWICE, in opposite directions.** I killed it for the
  wrong reason (its 66 µs evidence was a denominator artifact — but *refuting a claim's evidence is not
  refuting the claim*, §6.7). Then the profile appeared to vindicate it, and I over-claimed AGAIN — §4d
  measured all five of its possible triggers and every one is dead. **Current status: its mechanism is
  real in three's source and appears to cost ~nothing per frame here.** §4c/§4d.
- **One hypothesis genuinely died:** the `BatchedMesh.onBeforeRender` per-frame-walk suspect (mine, refuted
  by its own A/B at 1.60 ms = noise). §1.
- **`?perPolyCull` (predecessor §3.3) and the §4 backlog are UNTOUCHED and still owed.** I did not go near
  them; the user's account of perPolyCull and the portalStencil coupling stand exactly as recorded.

## 1. WHAT WAS REFUTED / CORRECTED (do not re-inherit any of it)

| Claim (and where it came from) | Verdict |
|---|---|
| "**the next lever is draw-call COUNT**" (predecessor §3.1, its ⭐ headline) | **RIGHT, AND AIMED WRONG.** The frame is draw-bound — but at **~7,500** real draws, not 1,920, and the group that owns them (`statics`, 78%) is the one `info.calls` makes look smallest (9.5%). §3.1 said "pick the target from a census"; the census it specified, read through `info.calls`, ranks `cells` (768 counted draws) **4× above** `statics` (183). Following the instruction with the specified instrument selects the wrong target. The thesis is kept; the instrument is replaced. §2. |
| "**~66 µs per draw is ~10× what a draw costs** — something per-object per-frame is expensive in three's submission; prime suspect `needsUpdate` → program re-resolve; **this may be a WHOLE-CODEBASE lever**" (predecessor §3.2, its ⭐⭐) | **HALF RIGHT — AND I KILLED THE RIGHT HALF. ⚠ SEE §4c.** The 66 µs *number* was a denominator artifact (~26 real draws counted as one), so I declared the whole lead dead — including its MECHANISM, which a CPU profile then found to be **the single largest self-time item in the frame** (`getParameters` 10.2%; the program-resolve path ~19%). Its sentence "something per-object per-frame is expensive in three's submission" is **CORRECT**, and `needsUpdate` → `getProgram` → `getParameters` + cache-key-string was the **right suspect**, confirmed in three r184 source (§4c). **Refuting a claim's evidence is not refuting the claim.** The original verdict below is kept so the error is legible: | **DISSOLVED — there was never an anomaly.** 66 µs was ~26 real draws wearing one number's clothing. Corrected for the undercount, every path lands at 2.4–11.7 µs/draw, i.e. **ordinary**. The per-object-cost mystery that this whole lead existed to explain **does not exist**, so the `needsUpdate` refactor it proposed has no motivating measurement. §2/§3. (Its rule — *isolate before refactoring* — is what killed it. It was right to demand that.) |
| "the 508 BatchedMesh cost 13.93 ms because `onBeforeRender` walks every instance every frame (`perObjectFrustumCulled`/`sortObjects` default ON, `three.core.js:27218`)" (**MINE**, this session, from a source read) | **REFUTED BY ITS OWN A/B — and the source read was also wrong about our app.** `batchedmesh-flags-ab.mjs` found the live defaults are **`{pofc: true, sort: FALSE}`** — our code already disables sorting, so my "both default ON" was true of three and false of us. Killing the walk **entirely** (both flags off) saves **1.60 ms** (reps 2.6 / 0.61) against a **1.62 ms** baseline spread and a **±2.8 ms** placebo swing: **inside noise**. The walk is not the cost. §3. |
| "hiding `statics` gives **+96% fps**" (`draw-budget-probe.mjs` first run) | **A VSYNC ARTIFACT, not a 2× win.** Every p50 in this chain is a multiple of ~8.3 ms (33.4 / 16.7 / 8.3 = 4 / 2 / 1 intervals of a **120 Hz** rAF). fps is a STEP function of frame cost, so an arm reads +96% or +0% for the same ms saved depending on which side of a step it lands. The predecessor's §5.5 ("use draws and renderCPU; fps is only safe when the effect dwarfs the drift") is CORRECT and this is the mechanism behind it. |
| "`GROUPS=statics,entities,terrain,worldRoot`" (the default in `draw-budget-probe.mjs`) | **INCOMPLETE — it silently omitted 40% of the budget.** `worldRoot`'s children are terrain, buildings, statics, **cells**, entities (`index.js:1162-1167`). The arms summed to 1,133 draws against worldRoot's 1,901; the missing ~768 were `cells`, and nothing in the output said so. `draw-budget-cpu.mjs` enumerates the children from the LIVE graph and prints a parts-vs-whole reconciliation, which now closes to **−1.8 draws**. |
| "**2,271 plain meshes** … the gap between that and what they would cost batched IS the prize" (predecessor §3.1) | **BACKWARDS.** Batching is where the draws ALREADY are (5,791 of 7,500). Plain meshes are 297 draws / 3.48 ms in statics. The prize is not *more* BatchedMesh — it is making the batches we have stop emitting one real draw per instance. §4. |
| "the batched nodes are **true singletons** — models placed once — so instancing cannot help them and a MERGE is the only option" (**MINE**, first draft of this document's §4, from a code read) | **FALSE, AND IT NAMED THE WRONG FIX.** `singleton-dedupe-probe.mjs` hashed the actual vertex data: **17,774 instances share 324 distinct geometries (54.9×)**; only **82** geometries appear once. **17,692 instances sit on repeated geometry.** So instancing — measured FREE, 1 real draw for N — beats the merge I proposed: **~375 draws vs ~511**, and against a truer baseline (17,774, not 5,791). Verified against a hash-collision artifact by re-running with **every float hashed (no subsampling): identical, 324/82/375.** §4. |
| "the live batcher is `consolidateStaticSingletons` (`statics.js:1650`)" (**MINE**, same draft) | **WRONG FILE.** `?statBatchChunk` is **DEFAULT-ON** (`static_batch_x.js:38`), so the live path is `consolidateStaticSingletonsCrossLb` — per-(3×3-LB region, material) buckets. The live batch names say so plainly (`static-batch-c-r57x61-s08000007-m221`) and I quoted a path the flag routes around. **Read the node names out of the live scene before citing a builder.** |
| "`static_batch_x.js` chunks **dedupe geometry cross-LB within the region**" (its own header, `:16`/`:73`) | **OVERSTATED — and it would not have mattered anyway.** The dedupe is `gidOf`, keyed by **BufferGeometry object identity** and scoped **"this feed only"** (`:227`), so two LBs decoding the same model get different objects → different gids → duplicated vertex data (2,786 gids for 324 distinct datasets, ~8.6× vertex bloat). But gid dedupe saves **MEMORY, NOT DRAWS**: every *instance* still emits its own multiDraw range. Do not chase it as a perf fix. |

## 2. ⭐ THE COUNTER IS BLIND — and it is the reason this chain kept mis-aiming

**The mechanism, read from three r184 — not inferred:**
```js
// three.module.js:17253 — BatchedMesh submits ONE multiDraw…
renderer.renderMultiDraw( object._multiDrawStarts, object._multiDrawCounts, object._multiDrawCount );
// three.module.js:4440-4449 — …and three counts it as ONE call, whatever drawCount is.
extension.multiDrawElementsWEBGL( mode, counts, 0, type, starts, 0, drawCount );
info.update( elementCount, mode, 1 );          //                              ^^^ literal 1
// three.core.js:27352 — and a range is added PER VISIBLE INSTANCE.
multiDrawStarts[ multiDrawCount ] = geometryInfo.start * bytesPerElement * multiDrawMultiplier;
multiDrawCount ++;
```
So a BatchedMesh with 30 visible instances issues **30 real draws** and reports **1**. ANGLE/D3D11 has no
native multi-draw — `WEBGL_multi_draw` is present but it loops and issues them individually.

**Measured (`multidraw-truth-probe.mjs`, settled Holtburg, 1070):**

| | per frame |
|---|---|
| `info.render.calls` — **what every number in this chain has used** | 1,920.9 |
| BatchedMesh sub-draws (`Σ _multiDrawCount`, 196 active batches) | **5,838** |
| **TRUE draw count** | **~7,562** |
| **undercount factor** | **~3.94×** |

⚠ **Normalization trap, and I fell in it on the first run:** there are **19 `render()` calls per rAF**
(predecessor §3.4 — sky_scene + an ortho downsample chain), and only the world scene contains BatchedMesh.
Dividing the sub-draw total by `render()` calls instead of by rAF understates it by exactly 19× and prints
a plausible, wrong **"307 sub-draws, undercount 1.15×"**. What caught it: that row **disagreed with the CPU
row** (`info.calls` and renderCPU were already per-rAF). *If one column contradicts another, suspect the
normalization before you narrate the finding.* Fixed in the committed probe.

**Everything reconciles once corrected — this is the load-bearing table:**

| path | real draws/f | renderCPU/f | **µs per REAL draw** |
|---|---|---|---|
| statics — batched | **5,791** | 13.93 ms | **2.4** |
| statics — plain | 297 | 3.48 ms | 11.7 |
| cells | 768 | 3.58 ms | 4.7 |
| entities | 613 | 4.87 ms | 7.9 |

There is no 66 µs anomaly and no per-object mystery. There is a frame with **~7,500 real draws** in it,
78% of them in `statics`, costing an ordinary few µs each.

## 3. WHAT THE PROBES ACTUALLY FOUND (the trail, with the two dead ends kept)

**`draw-budget-cpu.mjs`** (A2 drift **1.8 draws / 0.01 ms**; parts-vs-whole closes to −1.8 draws):

| group | draws/f (counted) | renderCPU/f | census |
|---|---|---|---|
| **statics** | 521.4 (27.1%) | **16.61 ms (59.3%)** | 326 plain (286 uniq mat), 511 batched, 14 instanced |
| cells | 768.0 (39.9%) | 3.58 ms (12.8%) | 528 plain, 0 batched |
| entities | 612.7 (31.8%) | 4.87 ms (17.4%) | 1,134 plain (510 uniq mat) |
| terrain | 0.6 | 0.45 ms | 1 batched (121 inst) |
| buildings | −0.4 | 0.04 ms | empty at Holtburg |

`cells` issuing **47% more counted draws than `statics` for 4.6× less CPU** is the whole finding in one
row: it is not that cells is efficient, it is that statics' counted draws are each ~26 real ones.

**`statics-cpu-probe.mjs`** (partition statics by object class, 2 reps, baseline spread 2.74 ms):

| class | n | counted draws/f | renderCPU/f | reps |
|---|---|---|---|---|
| **batched** | 508 | 183.2 | **13.93 ms (47.8% of the frame)** | 14.44, 13.42 |
| plain | 339 | 297.3 | 3.48 ms | 3.61, 3.35 |
| instanced | 14 | 15.8 | **−0.28 ms (free)** | −0.23, −0.33 |

**The InstancedMesh row is the control that proves the whole story:** 14 InstancedMesh carrying **2,992
instances** cost **nothing**, because InstancedMesh is **1 real draw for N instances**. 512 BatchedMesh
carrying 17,895 instances cost 13.93 ms, because BatchedMesh is **N real draws for N instances**. Same
scene, same frame, two APIs, and the difference is exactly the one three's source predicts.

**DEAD END (mine): the per-frame walk.** `batchedmesh-flags-ab.mjs`, arms A/B/C/D/A:

| arm | renderCPU saved | tris | note |
|---|---|---|---|
| B `sortObjects=false` | −1.07 ms (reps 0.69, −2.83) | +0 | **accidental placebo** — already false in our code |
| C `perObjectFrustumCulled=false` | 2.29 ms | **+12,906 (+2.9%)** | |
| D **both false** (early-out fires; walk skipped entirely) | **1.60 ms** | +2.9% | **inside noise** |

Two things fall out, and the second one matters more than the first:
1. The walk is ~2 ms, not 14. **Hypothesis dead.**
2. **Arm C is the permission slip for §4.** Turning per-instance frustum culling *completely off* adds only
   **2.9% tris** — so the per-instance culling that BatchedMesh charges us a per-instance draw to keep is
   **culling almost nothing** at Holtburg. We are paying 5,791 draws to skip 2.9% of triangles.

**DEAD END (inherited): `needsUpdate` → program churn.** Never isolated, and now unmotivated — see §1. Do
not refactor on it. If someone still wants it, it needs its own micro-bench and its own reason.

## 4. ⭐ THE LEAD — the "singletons" are 54.9× duplicated. INSTANCE them (~17,774 → ~375 real draws).

**This section replaced a wrong one.** Its first draft said the batched nodes were true singletons and
proposed a geometry MERGE. That rested on a code read I never measured. Measured, it is false — and the
right fix is both simpler and bigger. The dead version is kept in §1 so nobody re-derives it.

**`singleton-dedupe-probe.mjs` — hashing the ACTUAL vertex data of every geometry range under `statics`:**

| | |
|---|---|
| BatchedMesh / active instances | 511 / **17,774** |
| geometry entries (gids) in those batches | 2,786 |
| **DISTINCT geometries (by vertex data)** | **324** |
| of which appear exactly once (true singletons) | **82** |
| instances sitting on REPEATED geometry | **17,692** |
| **dedupe ratio** | **54.9× instances per distinct model** |
| top repeat counts | **1,736**, 1,736, 1,372, 1,370, 760, 707, 707, 655, … |
| worst single batch | **277 instances / 1 distinct geometry** |

**Verified against the obvious artifact:** a subsampled hash could collide two models into one "distinct"
and fake the whole win. Re-run with `SAMPLES=0` — **every float hashed, no subsampling** — the numbers are
**identical** (324 / 82 / 375). The duplication is real.

**ROOT CAUSE — the walk-in baker never instances anything.** `statics.js` has two bakers and only one of
them groups:
```js
// :2023  WALK-IN / STREAMING PATH — one plain Mesh PER PLACEMENT. No grouping. No instancing.
for (const placement of statics) { … buildSingletonNode({ placement, … }) }   // :2057
// :2723  RING-WIDE PATH — the only caller of buildInstancedNode (:2756).
const isInstanced = group.length >= 2;                                         // grouped by modelId
```
Streaming is how you arrive anywhere, so in practice **almost every static is built un-instanced**, then
swept into the chunk buckets by material — one multiDraw range per placement. That is the 5,791 visible
real draws, and it is why the 14 InstancedMesh (2,992 instances, from the ring bake) are a rounding error
next to 17,774 batched ones. The "**5,400-singleton wall**" in memory is not a wall of unique models; it is
**324 models drawn 17,774 times**.

**THE FIX: group by geometry and emit InstancedMesh.** Draw floor by (material, geometry) is **~375**, vs
~511 for the merge I originally proposed and ~17,774 today. InstancedMesh is **1 real draw for N
instances** and is **measured free in this very scene** (14 nodes / 2,992 instances = **−0.28 ms**), which
is the strongest evidence in this document because it is the same frame, same GPU, same probe.
Two viable places, and the choice is a real design question — measure, do not pick from taste:
- **(a) give the walk-in path the ring path's grouping** (group placements by (modelId, surface) per feed
  → `buildInstancedNode`). Fixes it at the source; the ring baker already proves the shape works.
- **(b) instance inside the chunk batcher** (`static_batch_x.js`), keying by **geometry data**, not
  BufferGeometry identity. Catches cross-LB repeats the per-feed `gidOf` map structurally cannot — and note
  **324 distinct data vs 2,786 gids** means distinct *objects* often carry identical *data*, so identity
  keying is not enough. Also reclaims the ~8.6× vertex bloat.

**What instancing gives up, and why it is cheap here:**
- **Per-instance frustum culling** → **already measured at 2.9% of tris** (`batchedmesh-flags-ab.mjs` arm
  C). We are paying ~5,791 draws to skip 2.9% of triangles.
- **Per-instance shadow/receive flags** → `InstancedMesh.receiveShadow` is per-mesh, not per-instance —
  `buildInstancedNode` already documents and accepts this trade (`:2652`). Same trade, wider.
- **Eviction granularity** → the chunk buckets already solved per-LB excision (`_lbMembership` +
  `evictStaticBatchXForLb`, incl. the re-feed idempotence fix that cured a 41k-instance leak). An
  instanced bucket needs the same treatment; do not hand-roll a new one.

⚠ **THE TRAP THIS AREA ALREADY FELL INTO — read `static_batch_x.js`'s header first.** `?statBatchCrossLb`
(v1) consolidated **across** landblocks and is **CLOSED-NEGATIVE on the 1070**: ring-spanning nodes forfeit
*node-level* frustum culling (per-LB batches only draw the ~10% in view) and it measured **22.5 vs ~29
fps**. v2 (`?statBatchChunk`, the default-ON path) fixed that with 3×3-LB regions. Any instancing work must
stay **region-scoped** for the same reason: node-level culling is real and load-bearing; per-instance
culling (2.9%) is not. v1 died by blurring exactly that distinction.

**How to score it — the instrument is the easy part now, but it is still a trap.** `info.calls` **cannot
see this win**: collapsing 5,791 visible ranges into ~375 instanced draws moves `info.calls` from 183 to
~375 — it goes **UP**. Score with `multidraw-truth-probe.mjs`'s true count + **renderCPU**. *A change that
halves the frame while raising `info.calls` is exactly what success looks like here.* Also watch **tris**:
instancing draws every instance in a bucket that survives node-level culling, so expect roughly the +2.9%
arm C measured — if tris jump far more than that, the bucket scope is wrong.

## 4b. ⚠ IT WAS BUILT AND MEASURED — AND THE RESULT BREAKS THE DRAW-COUNT MODEL

`?walkInInstance` (default-OFF, `f6d617dd`) implements §4(a): the walk-in baker now groups by modelId and
emits an InstancedMesh at >=2 placements/LB, like the ring baker. **Clean A/B, 1070, settled Holtburg,
balanced order (rep1 ON-first, rep2 OFF-first), `walkin-ab.sh` + `multidraw-truth-probe.mjs`:**

| arm | renderCPU | TRUE draws | info.calls | tris/f |
|---|---|---|---|---|
| OFF | 27.62, 28.66 → **28.14 ms** (spread 1.04) | 7,563 | 1,921 | 443,767 |
| ON | 25.04, 25.34 → **25.19 ms** (spread 0.30) | **2,761 (−63%)** | **2,571 (UP)** | **546,596 (+23%)** |

**Verdict by the rule stated BEFORE the run** (a delta under the OFF spread is not a win): **−2.95 ms,
−10.5% — a WIN**, and both reps agree so the login-slot confound (§8) cannot carry it. `info.calls` went
UP while the frame got faster, exactly as predicted — that inversion is now demonstrated, not argued.

**⭐ BUT THE REAL FINDING IS THE MISMATCH: −63% of the frame's TRUE draws bought −10.5% of its CPU.**
If draws were the frame, removing 4,800 of 7,563 would have removed far more than 3 ms. At the previously
inferred ~2.4 µs/real-draw it predicted **~11.5 ms**; it delivered **2.95**. So:
- **The ~2.4 µs/real-draw figure is REFUTED as a cost model.** It was derived by dividing a subtree's CPU
  by its draws — which silently assumes draws cause that CPU. They largely do not.
- **§2's "the frame IS draw-bound" survives only as far as the counter goes.** The counter was genuinely
  blind (that stands, 3.94×), but fixing the count did NOT make the count the cause. **A better metric is
  not a mechanism.** This document's own headline is now the fourth casualty of measuring a delta and
  narrating a cause from it.
- **Do NOT extrapolate the remaining 2,761 draws to another ~7 ms.** That is the same arithmetic that just
  failed by 4×.

## 4c. ⭐⭐ THE PROFILE — and I OWE THE PREDECESSOR AN APOLOGY: its §3.2 lead is REAL

`cpu-profile-probe.mjs` was run on both arms (settled Holtburg, 1070, CDP Profiler @100 µs, 14 s). **Top
SELF-time, share of all main-thread samples:**

| | OFF (default) | ON (`?walkInInstance`) |
|---|---|---|
| **`getParameters`** three.module.js:7431 | **10.2%** ← #1 | 4.8% |
| `setProgram` :18266 | 4.7% | 5.9% |
| `getProgram` :18087 | 4.0% | 2.2% |
| **program-resolve path (sum)** | **~18.9%** | **~12.9%** |
| `updateMatrixWorld` + `multiplyMatrices` | 9.3% | 11.4% |
| `onBeforeRender` (BatchedMesh walk) | 4.7% | *falls out of the top* |
| `projectObject` (scene walk) | 3.6% | 5.4% |
| bucket: three (render/submit) | 71.7% | 69.2% |
| bucket: app scene3d | 6.1% | 7.7% |

**I WAS WRONG TO KILL §3.2 WHOLESALE (see §1).** The predecessor guessed: *"`needsUpdate` bumps
`material.version`, which forces `getProgram` to re-resolve — a path that builds a program cache-key STRING
per call."* I dissolved that lead because its *evidence* (the "66 µs/draw anomaly") was a denominator
artifact. **The anomaly was fake; the MECHANISM is real, and it is the single largest self-time item in the
frame.** Confirmed in three r184 source, not inferred:
```js
// three.module.js:18420  setProgram
if ( material.version === materialProperties.__version ) { /* …many other triggers… */ }
else { needsProgramChange = true; materialProperties.__version = material.version; }  // version bump ⇒ ALWAYS
if ( needsProgramChange === true ) program = getProgram( material, scene, object );
// three.module.js:18098-18099  getProgram — BOTH run BEFORE the "identical program" early-out at :18127
const parameters      = programCache.getParameters( … );        // ← 10.2% SELF
const programCacheKey = programCache.getProgramCacheKey( parameters );   // builds a STRING
```
`getProgram` pays `getParameters` + a cache-key **string build** on EVERY call, and only *then* checks
whether the program even changed. So a per-frame `needsUpdate = true` writer is expensive exactly as the
predecessor claimed — and the two-pass it originally blamed is already FIXED (`?surfaceSinglePass`), yet
`getParameters` is STILL #1. **Something else is still bumping `material.version` per frame.**

**⚠⚠ AND THEN THE HUNT KILLED ITS OWN PREMISE — READ §4d BEFORE CHASING `getParameters`.**

## 4d. THE `getParameters` HUNT: every trigger is dead, and the profile may not be measuring the FRAME

`getProgram` (the only caller of `getParameters`) runs from `setProgram` ONLY when `needsProgramChange`
(:18440). I measured every condition that can set it. **All are stable at a settled Holtburg:**

| candidate trigger | measured | verdict |
|---|---|---|
| per-frame `material.version` bump (the predecessor's §3.2 suspect) | **1.0 object/frame** — and it is the KNOWN §5.1 residual double-submitted mesh, written by three's own two-pass at `:18068/:18072` (`version-churn-probe`, setter wrapped, writer named) | **dead** (negligible) |
| class thrash — `batching`/`instancing` flip (:18332/:18348) | 37 materials / 440 meshes (14.7%) DO span classes, but decloning them: **B − P = 0.10 ms** (`material-declone-ab`, placebo-controlled, drift-corrected) | **dead** (real mechanism, ~zero cost) |
| `lights.state.version` (:18321 — the FIRST condition, which I missed twice by reading the branch from its middle) | light-count signature `3/16/2/1/0/1/0/0/0`, **0 changes / 430 frames** (`lights-churn-probe`) | **dead** |
| `envMap` / `fog` / `toneMapping` / `clipping` / colorSpace | **0 changes / 339 frames**; the app never sets `scene.environment` or `envMap` at all (`env-churn-probe` + source) | **dead** |
| `vertexAlphas` / `vertexTangents` / `morph*` | `vertexColors: true` exists ONLY in particles + terrain — never on the `scene3d-surface-*` statics materials, so `vertexAlphas` is permanently false there | **dead** for statics |

**So nothing forces a per-frame program re-resolve — which means the premise of this hunt (and of §4c) is
probably WRONG.** `getProgram` has a SECOND caller I did not check until the end:
```js
// three.module.js:17283  prepareMaterial — the COMPILE path, reached from renderer.compile()
function prepareMaterial( material, scene, object ) { … getProgram( material, scene, object ); … }
```
and the app calls `renderer.compile()` via `prewarmSubtree` from **statics.js:2297, terrain.js:3721,
terrain_batch.js:431** — i.e. the BAKE path.

**I SUSPECTED A MEASUREMENT ERROR HERE AND RETRACTED §4c. THEN I MEASURED, AND THE RETRACTION WAS WRONG.**
The worry was legitimate: `renderCPU` wraps `renderer.render()` while the CPU profile samples the WHOLE
MAIN THREAD, and `getProgram`'s other caller (`prepareMaterial` ← `renderer.compile()` ← `prewarmSubtree`)
is the BAKE path, so the 10.2% could have been bake-time compile that was never in the frame.

**`profile-split-render.mjs` settles it by ANCESTOR** (no clock alignment: a V8 profile is a tree, so tag
every node by the region its ancestor chain puts it in, then sum self-samples). Both arms:

| | OFF | ON (`?walkInInstance`) |
|---|---|---|
| **inside `render()`** | **78.8%** of samples | 75.3% |
| **BAKE (compile / prewarm)** | **0.0%** | **0.0%** |
| program-resolve (getParameters+getProgramCacheKey+getProgram) | **14.7%, ALL in-frame** | **7.3%, all in-frame** |

**There is no bake contamination — zero samples.** So **§4c STANDS, §4d's retraction is WITHDRAWN**, and
`?walkInInstance` really does halve the in-frame program-resolve cost (14.7% → 7.3%), which is what its
−10.5% renderCPU win actually was.

**⚠⚠ WHICH LEAVES A LIVE CONTRADICTION — HAND THIS TO THE NEXT SESSION AS THE OPEN QUESTION.** The profile
says `getProgram` runs inside `render()` for a large share of the frame, i.e. `needsProgramChange` fires
per object per frame. The table above says **every trigger that can set it is stable**. Both cannot be
right. The likeliest hole is MINE: `version-churn-probe` v1 rescanned the scene ONCE, so it could only see
version bumps on materials that ALREADY EXISTED — a **brand-new material** has
`materialProperties.__version === undefined`, takes the `else` at :18420, and forces a `getProgram`.
Material CREATION is a per-frame program resolve and v1 was structurally blind to it (v2 now counts new
materials per frame). If that is not it either, the remaining move is to **vendor a patched
`three.module.js` behind an importmap override and count which condition fires** — three is loaded from
`cdn.jsdelivr.net` (`index.html:951`), which is why it could not be instrumented in place this session.

**Until that lands: the frame is ~25-28 ms of renderCPU, ~15% of it in-frame program resolve, and WHY the
resolve happens is UNKNOWN.**

**Why `?walkInInstance` won −10.5%, mechanically:** `getParameters` 10.2 → 4.8% and the BatchedMesh
`onBeforeRender` walk drops out — i.e. **the win came from fewer OBJECTS to resolve programs for, not from
fewer draws.** That is the same conclusion the draw-mismatch forced, arrived at independently.

**Where the ~25 ms goes, finally:** three's per-object submission machinery — **program resolve ~19%**,
scene-graph matrix updates ~9%, scene walk ~4%, BatchedMesh walk ~5%, plus buffer binds and uniform
uploads. **There is no single dominant draw cost.** ~72% of samples are inside three; only ~6% is app JS.
The frame is bound by **per-object work**, and both `updateMatrixWorld` and `projectObject` scale with NODE
count — which is why draw-count levers keep underdelivering.

**Whether to flip `?walkInInstance` default-ON is NOT settled, and I recommend against it on this evidence:**
−10.5% CPU is bought with **+23% tris** and two visual regressions (§4: one LOD level per LB-spanning node;
billboarding lost on degraded leaves — `tickStaticsBillboards` skips `isInstancedLod`). **No eye-test has
been run**, and the +23% is a GPU cost this CPU-side probe cannot price — on a GPU-bound box it could be a
net loss. It needs `singlepass-eyetest.mjs` at 3 POIs and a moving A/B (the trade is worst where LOD
matters most: distance), not a bare-default flip.

## 5. RESIDUALS / UNKNOWNS (honest loose ends)

1. **Nothing was shipped this session.** No source change, no flag, no default flip. Five probes and a
   corrected map. **The draw counts are measured; the ms saving is NOT.** "375 vs 17,774 real draws" and
   "54.9× duplication" are measurements. What they are worth in ms is a projection from 2.4 µs/real-draw
   and from InstancedMesh measuring free at 2,992 instances — plausible, unvalidated, and it stands or
   falls on someone building the instancing and A/B-ing it. **Do not quote a ms figure for this lead.**
   (The superseded merge draft quoted "~12.7 ms". It should not have.)
2. **Arm noise is ~±2.8 ms** (the accidental placebo in `batchedmesh-flags-ab.mjs`), and baseline spread
   was 1.62–2.74 ms across runs, though A-vs-A2 drift within `draw-budget-cpu` was 0.01 ms. **Treat any
   single-arm result under ~3 ms as noise.** The 13.93 ms and 5,791-draw findings clear it by 5×+; the
   cells/entities/terrain *rankings* do not, and should not be quoted as precise.
3. **`draw-budget-cpu.mjs`'s `hide:hello-cube` arm read −2.36 ms / +2.8 draws** for hiding ONE cube. That is
   the noise event above, but it is unexplained, and it fired in the middle of an otherwise 0.01 ms-drift
   run. Not investigated.
4. **Still no pinned pose for Holtburg** (inherited, §5.4 of the predecessor). Every run here was UNPINNED,
   so cross-page-load draw counts are directional only. All the load-bearing comparisons here are
   **within** one page load, which is why they survive this — but the emitter plateau again ranged
   **843 → 1,060** across my four runs at the same POI. `pinPose` for Cragstone is known
   (`0xbb9f0040 169.36 168.25 54.01`); derive one for Holtburg before any cross-load claim.
5. **The 19-render()-calls-per-frame mystery is UNCHANGED** (predecessor §3.4) — and it is now load-bearing
   for measurement, not just curiosity: it is the 19× normalization trap in §2. Nobody has still explained
   what resizes to 1112x619 and re-renders the whole world ~1 frame in 100.
6. **`statics` census counts disagree between probes**: `draw-budget-cpu` reported 511 batched / **2,907**
   instances (via `_geometryCount`), `batchedmesh-flags-ab` reported 512 / **17,895** (via
   `_instanceInfo.length`). The sub-draw measurement (5,791 visible ranges) is consistent with the larger
   figure. `_geometryCount` is not the instance count — **the 2,907 figure is wrong; do not quote it.**
7. **Everything here is Holtburg-only.** `buildings` is empty there and `terrain` is 1 batch; a dungeon or
   Yaraq could rank completely differently. The undercount MECHANISM is universal (it is three's source);
   the 78%/5,791 attribution is one POI.
8. **Untouched and still owed** (all inherited, all unexamined by me): `?perPolyCull` + the `?portalStencil`
   coupling (predecessor §3.3, incl. the user's first-hand account), `?particleInstancing` at Holtburg,
   the broken `?staticScripts=off`, the brazier-flame hero shot + 62-town walk, the anchor leak,
   `surfaceUnified` shipping the known-wrong reading, and the 1-mesh coverage hole.
9. **MEMORY.md is 24,835 bytes, over its own 24,400-byte load budget** (its header asks that this be
   reported, not silently edited). Still over. Reported again.

## 6. MEASUREMENT RULES (new this session; the prior handoffs' rules all still stand)

1. **VERIFY THE COUNTER BEFORE YOU OPTIMIZE THE THING IT COUNTS.** THE rule of this session. Four sessions
   optimized "draws/frame" and every one of them read a number that is blind to 78% of the draws. The
   fix was ~15 lines (`Σ _multiDrawCount`) and it re-aimed the entire program. Before a metric becomes
   the target, read the source of the counter and ask what it CANNOT see. `info.calls` counts a multiDraw
   as 1; `info.calls` is not a draw count.
2. **AN "ANOMALY" IS USUALLY A BROKEN DENOMINATOR.** "66 µs/draw is 10× what a draw costs" was true, alarming,
   and entirely an artifact — it spawned a ⭐⭐ whole-codebase refactor lead that had nothing under it. When
   a per-unit cost comes out ~10× off, suspect the unit before you write the theory. Corrected: 2.4 µs.
3. **CROSS-CHECK YOUR NORMALIZATION AGAINST A COLUMN THAT IS ALREADY RIGHT.** The 19× sub-draw error printed
   a plausible "1.15× undercount" and was caught ONLY because it contradicted the renderCPU column. Report
   two independently-normalized numbers side by side and let them disagree.
4. **KEEP THE ARM THAT SHOULD DO NOTHING** (predecessor §6.2, re-earned). `sortObjects=false` turned out to
   be already-false in our code, so that arm was an unplanned placebo — and it delivered this session's
   noise floor (±2.8 ms) for free, which is the only reason "D saves 1.60 ms" could be called dead rather
   than promising.
5. **READ THE FLAG OFF THE LIVE OBJECT, NOT OFF THE LIBRARY'S SOURCE.** I read `perObjectFrustumCulled = true;
   sortObjects = true;` in three and wrote "both default ON". Live, ours were `{pofc: true, sort: false}` —
   somebody had already set it. The probe printed `defaults as found` and caught me. Three's default is not
   your app's value.
6. **A CENSUS MUST RECONCILE PARTS TO WHOLE.** The first probe's arms summed to 1,133 of worldRoot's 1,901
   and said nothing. Enumerate children from the LIVE graph (never a hardcoded list) and PRINT the residual;
   `unattributed −1.8 draws` is a passing test, `unattributed 768` is a missing group named `cells`.
7. **REFUTING A CLAIM'S EVIDENCE IS NOT REFUTING THE CLAIM.** THE rule of this session's second half. The
   predecessor's ⭐⭐ lead ("something per-object per-frame is expensive in three's submission; suspect
   `needsUpdate` → program re-resolve") rested on a 66 µs figure that was a denominator artifact. I killed
   the number — correctly — and threw the mechanism out with it, writing "no motivating measurement". A
   profile then found that exact mechanism is the **single largest self-time item in the frame**
   (`getParameters` 10.2%). **When you refute the evidence for a claim, the claim returns to UNKNOWN, not to
   FALSE.** Say which one you killed. §4c.
8. **A PROFILE BEFORE A FIFTH STORY.** Four sessions named this frame's cost from deltas — fill rate
   (refuted), `needsUpdate` churn (dissolved, then vindicated), the BatchedMesh walk (refuted), draw count
   (refuted by building it). One 14-second CDP `Profiler` run answered it. Nobody had taken one.
   `cpu-profile-probe.mjs` costs one page load; a wrong lever costs a session. **Profile first.**
9. **fps here is vsync-quantized to ~8.3 ms steps (120 Hz rAF).** It is a step function of frame cost: the
   same ms saved reads +96% or +0% depending on where it lands. This is the *mechanism* behind the
   predecessor's "use draws and renderCPU, not fps" — it is not conservatism, it is quantization.
10. **HASH THE DATA; DO NOT TRUST THE NAME.** Everything called these nodes "singletons" — the function name
   (`consolidateStaticSingletons`), the comments, memory's "5,400-singleton wall", and my own §4 draft.
   They are 54.9× duplicated. **One probe that hashed vertex data beat four sessions of a plausible name.**
   When a name asserts a property that decides your fix (unique / cached / deduped / singleton), measure
   the property. And when a code read tells you a dedupe exists (`static_batch_x.js:16` "chunks still
   dedupe geometry cross-LB"), check what it is keyed on — `gidOf` keys on **object identity**, and 2,786
   distinct objects carried 324 distinct datasets.
11. **IF AN ARM CAN'T HOLD A RESOURCE THE OTHER ARM ALSO NEEDS, ORDER IS A VARIABLE — BALANCE IT.** The
   single-login gap made "did this arm settle?" depend on *the previous arm's outcome*, so strict `off,on`
   alternation pinned every ON arm to the post-success slot and manufactured 2/2 ON failures that read as
   "the flag breaks the world" (§8). A fixed gap is not a fixed condition. **Balance the order across reps,
   retry a lost arm instead of scoring it, and be suspicious of any arm that fails 100% of the time — real
   effects are rarely that tidy.** The tell was that the same flag had settled fine in a manual run minutes
   earlier; a 100%-clean split between "my code" and "not my code" should prompt a look at the harness
   before the code.
12. **A FLAG CAN ROUTE AROUND THE FILE YOU ARE READING.** I cited `statics.js:1650` as the live batcher; the
   default-ON `?statBatchChunk` routes to `static_batch_x.js` instead, and the live node names said so
   (`static-batch-c-r57x61-…`). **Read the object names out of the settled scene before citing a builder** —
   same family as the predecessor's §6.1 ("grepping creation sites tells you what you PATCHED, not what
   RUNS"), which that session learned the hard way and I then repeated.

## 7. HARNESS (all in `net-review/`)

- **`multidraw-truth-probe.mjs`** — ⭐ the corrected draw counter (`Σ _multiDrawCount` per rAF, per group,
  vs `info.calls`). **Run this before and after any batching/merge work; `info.calls` cannot score it.**
- **`singleton-dedupe-probe.mjs`** — ⭐ hashes the real vertex data of every batched geometry range and
  reports distinct-vs-instances + the draw floor for each candidate fix. `SAMPLES=0` hashes every float
  (the collision control). This is what proved the "singletons" are 54.9× duplicated. Re-run it at a
  dungeon / Shoushi before generalizing.
- **`draw-budget-cpu.mjs`** — per-subtree attribution in ONE page load with **renderCPU in ms** + a
  runtime-enumerated group list + a parts-vs-whole reconciliation. Supersedes `draw-budget-probe.mjs`
  (which is left in place as the predecessor's artifact — its GROUPS default is incomplete; prefer this).
- **`statics-cpu-probe.mjs`** — partitions a group (`GROUP=statics`) by object class (batched / plain /
  instanced), repeated arms (`REPS`), and prints the baselines' own spread AS the run's noise floor.
- **`batchedmesh-flags-ab.mjs`** — A/B/C/D/A over `perObjectFrustumCulled` / `sortObjects` on live
  BatchedMesh (no source change needed). Its arm C is the standing evidence that per-instance culling is
  worth 2.9% of tris.
- All four: assert `UNMASKED_RENDERER` is the GTX 1070 and refuse to publish otherwise; `settleAt()` +
  abort-if-not-settled; hide-via-accessor so the per-frame cullers cannot re-assert `visible`.
- Inherited and unchanged: `forcesinglepass-{ab,parity}.mjs`, `singlepass-eyetest.mjs`,
  `particle-{k-probe,pass-attrib,instancing-ab}.mjs`, `settle.mjs` (read its header), `town-fps-probe.mjs`.
- **Artifacts:** `/mnt/wbterminal2/tmp/{draw-budget,draw-budget-cpu,statics-cpu,bm-flags,multidraw-truth,singleton-dedupe,w2-{off,on}-*,prof-{off,on}}.json`
  + `.log`.

## 8. OPS / GIT

- **1070:** `schtasks /run /tn cdpwbclaude` (headless, muted, off-screen, `--user-data-dir=C:\Temp\cdpwb-claude`);
  tunnel `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@100.127.215.75`. Kill test chrome by
  `cdpwb-claude` cmdline match ONLY — **a person uses that box** — and verify with `Get-Process chrome`.
- **⚠⚠ `tailnet1`'s single-login gap CAN FORGE AN ARM EFFECT. The 45-60 s figure (predecessor §6.8) is only
  true after a FAILED run.** A run that reaches the world holds the account in-world for ~90 s; a run that
  fails never held it at all. So in a fixed-gap A/B the gap is effectively *conditional on the previous
  arm's outcome*, and with strict `off,on` alternation **every ON arm inherits the post-success slot**:
  ```
  off-1 SUCCESS -> +60s -> on-1  FAIL (pose:null, terrEverBaked:0 — nothing streamed)
  on-1  FAIL    -> +60s -> off-2 SUCCESS   (a failed arm never held the account)
  off-2 SUCCESS -> +60s -> on-2  FAIL
  ```
  That is **2/2 ON failures and 2/2 OFF successes from a login artifact**, and it reads exactly like "the
  flag breaks the world" — the same flag whose own manual run had settled fine minutes earlier (it followed
  a long idle). **Use a 150 s gap, BALANCE the order so the post-success slot alternates between arms, and
  retry a lost arm rather than scoring it** (`scratchpad/walkin-ab2.sh`). The silent-empty-world failure
  (`pose: null`, everything 0, burns the full 240 s settle timeout) is the nastier of the two failure modes
  because it presents as a settle/content problem, not a login one.
- **Do NOT `pkill -f <pattern>` where the pattern appears in your own command line** — including inside an
  `echo`. It matches your own shell and self-kills (exit 144). Memory warns about this; I hit it anyway
  while cleaning up the contaminated run. Kill by PID.
- **Do not `git show HEAD:<path> > <path>` to A/B source while a probe is running.** The redirect truncates
  before writing, so a page fetching that module mid-write gets a PARTIAL file and the world never streams
  — indistinguishable from the login failure above. Copy to a scratch path and swap, or run it when the box
  is idle.
- No wasm rebuild needed for any of this: JS is served LIVE by `scripts/serve.py` → :8765. `dist` is a
  symlink to `/mnt/wbterminal2/holtburger-dist`.
- Do **NOT** `git stash` in this repo (3 pre-existing entries). A/B with `git show <sha>:<path> > <path>`.
