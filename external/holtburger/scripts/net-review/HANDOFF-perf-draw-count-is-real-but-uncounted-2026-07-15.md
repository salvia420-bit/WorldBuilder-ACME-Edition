# HANDOFF — the frame IS draw-bound. The counter we measured it with is blind to 78% of the draws.

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
- **The predecessor's thesis SURVIVES, but its aim does not.** "The next lever is draw-call COUNT" is
  RIGHT: at ~7,500 real draws and ~2.4-12 µs each, submission is the frame. But a census taken through
  `info.calls` — which is what §3.1 asked for — points at `cells` (39.9% of counted draws, 12.8% of CPU)
  and away from `statics`. **The instrument the plan specified cannot see the target the plan wanted.** §1.
- **`BatchedMesh` is NOT the bug. It is the cheapest path in the frame** — 2.4 µs per real draw, vs 4.7 µs
  (cells), 7.9 µs (entities), 11.7 µs (plain statics). It is working as designed. What it does *not* do is
  reduce the number of real draws: it saves state binds, not draws. §3.
- **⭐ THE LEAD: INSTANCE the batched statics. ~17,774 → ~375 real draws.** The "singletons" are not
  singletons: **17,774 instances share only 324 distinct geometries (54.9×)**, and the top geometry is drawn
  **1,736 times**. Root cause: the **walk-in/streaming baker never instances anything** — it emits one plain
  Mesh per placement (`statics.js:2023`), and only the ring-wide baker groups by modelId (`:2723`). §4.
- **Two hypotheses died here, both mine, both by measurement.** The `needsUpdate`/program-churn suspect and
  the `BatchedMesh.onBeforeRender` per-frame-walk suspect. §1. Neither should be re-inherited.
- **`?perPolyCull` (predecessor §3.3) and the §4 backlog are UNTOUCHED and still owed.** I did not go near
  them; the user's account of perPolyCull and the portalStencil coupling stand exactly as recorded.

## 1. WHAT WAS REFUTED / CORRECTED (do not re-inherit any of it)

| Claim (and where it came from) | Verdict |
|---|---|
| "**the next lever is draw-call COUNT**" (predecessor §3.1, its ⭐ headline) | **RIGHT, AND AIMED WRONG.** The frame is draw-bound — but at **~7,500** real draws, not 1,920, and the group that owns them (`statics`, 78%) is the one `info.calls` makes look smallest (9.5%). §3.1 said "pick the target from a census"; the census it specified, read through `info.calls`, ranks `cells` (768 counted draws) **4× above** `statics` (183). Following the instruction with the specified instrument selects the wrong target. The thesis is kept; the instrument is replaced. §2. |
| "**~66 µs per draw is ~10× what a draw costs** — something per-object per-frame is expensive in three's submission; prime suspect `needsUpdate` → program re-resolve; **this may be a WHOLE-CODEBASE lever**" (predecessor §3.2, its ⭐⭐) | **DISSOLVED — there was never an anomaly.** 66 µs was ~26 real draws wearing one number's clothing. Corrected for the undercount, every path lands at 2.4–11.7 µs/draw, i.e. **ordinary**. The per-object-cost mystery that this whole lead existed to explain **does not exist**, so the `needsUpdate` refactor it proposed has no motivating measurement. §2/§3. (Its rule — *isolate before refactoring* — is what killed it. It was right to demand that.) |
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
7. **fps here is vsync-quantized to ~8.3 ms steps (120 Hz rAF).** It is a step function of frame cost: the
   same ms saved reads +96% or +0% depending on where it lands. This is the *mechanism* behind the
   predecessor's "use draws and renderCPU, not fps" — it is not conservatism, it is quantization.
8. **HASH THE DATA; DO NOT TRUST THE NAME.** Everything called these nodes "singletons" — the function name
   (`consolidateStaticSingletons`), the comments, memory's "5,400-singleton wall", and my own §4 draft.
   They are 54.9× duplicated. **One probe that hashed vertex data beat four sessions of a plausible name.**
   When a name asserts a property that decides your fix (unique / cached / deduped / singleton), measure
   the property. And when a code read tells you a dedupe exists (`static_batch_x.js:16` "chunks still
   dedupe geometry cross-LB"), check what it is keyed on — `gidOf` keys on **object identity**, and 2,786
   distinct objects carried 324 distinct datasets.
9. **A FLAG CAN ROUTE AROUND THE FILE YOU ARE READING.** I cited `statics.js:1650` as the live batcher; the
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
- **Artifacts:** `/mnt/wbterminal2/tmp/{draw-budget,draw-budget-cpu,statics-cpu,bm-flags,multidraw-truth,singleton-dedupe,singleton-dedupe-exact}.json`
  + `.log`.

## 8. OPS / GIT

- **1070:** `schtasks /run /tn cdpwbclaude` (headless, muted, off-screen, `--user-data-dir=C:\Temp\cdpwb-claude`);
  tunnel `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@100.127.215.75`. Kill test chrome by
  `cdpwb-claude` cmdline match ONLY — **a person uses that box** — and verify with `Get-Process chrome`.
- **`tailnet1` is single-login and the gap is REAL (predecessor §6.8, re-confirmed twice here):** two
  back-to-back runs died — one `boot error`, one that logged in but streamed NOTHING (`pose: null`,
  `terrEverBaked: 0`, everything 0, and it burned the full 240 s settle timeout before aborting). **Wait
  45-60 s between runs.** The silent-empty-world failure is the nastier of the two; it looks like a settle
  problem, not a login one.
- No wasm rebuild needed for any of this: JS is served LIVE by `scripts/serve.py` → :8765. `dist` is a
  symlink to `/mnt/wbterminal2/holtburger-dist`.
- Do **NOT** `git stash` in this repo (3 pre-existing entries). A/B with `git show <sha>:<path> > <path>`.
