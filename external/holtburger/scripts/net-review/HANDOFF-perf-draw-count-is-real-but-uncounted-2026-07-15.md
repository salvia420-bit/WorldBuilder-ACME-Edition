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
- **⭐ THE LEAD: merge the singleton batches. ~5,791 → ~512 real draws, worth ~12.7 ms of a ~28 ms frame.**
  The evidence that it is nearly free is already measured, not assumed. §4.
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

## 4. ⭐ THE LEAD — merge the singleton batches (~5,791 → ~512 real draws, ~12.7 ms)

**What the batches actually are.** `statics.js` already instances the repeats: `buildInstancedStaticNode`
(`:1428`) keys by **(modelId, surfaceDid)** — "a tree modelId only appears in scenery" — and those are the
14 free InstancedMesh. What is left are the **singletons**, the models placed exactly once, which
instancing cannot help by definition (memory's known "**5,400-singleton wall**"). `consolidateStaticSingletons`
(`:1650`) sweeps them into a BatchedMesh per **material**:

```js
// statics.js:1678-1685 — one addGeometry PER NODE, so N nodes => N geometries => N instances => N ranges.
try { bm = new THREE.BatchedMesh(group.length, maxVerts, maxIdx, mat); } catch (_) { … }
for (const m of group) {
  const gid = bm.addGeometry(m.geometry);   // never deduped — each node gets its own geometry entry
  const iid = bm.addInstance(gid);
  bm.setMatrixAt(iid, m.matrix);
}
```
That is a correct use of BatchedMesh, and BatchedMesh honestly delivers what it promises: **fewer state
binds, one material, one buffer, 2.4 µs/draw — the best per-draw number in the frame.** It just never
promised *fewer draws*, and it is the draws that are left.

**THE FIX: a real geometry MERGE, not a batch.** For each (material, LB) group, bake each singleton's world
matrix into its vertices and concatenate into ONE geometry (`BufferGeometryUtils.mergeGeometries`) → **one
draw per group**, ~512 total, replacing ~5,791. At the measured 2.4 µs/real-draw that is **~12.7 ms of a
~28 ms frame** — larger than every other lever in this chain combined, and ~2× the entire surface
single-pass win the predecessor shipped.

**What a merge gives up, and why the cost is already measured to be ~nothing:**
- **Per-instance frustum culling** → **arm C measured this at 2.9% of tris.** Not a guess.
- **Per-instance visibility/matrix updates** → statics are static; they do not move. Eviction is already
  per-LB (`coversLbKeys`, the LRU refcount at `:1408`), and a per-(material, **LB**) merge keeps that
  granularity intact — do NOT merge across LBs.
- **Memory:** merged geometry duplicates vertex data for repeated geometry. Singletons are unique by
  definition, so there is little to duplicate — but MEASURE it, do not assume it.

**⚠ THE TRAP THIS EXACT IDEA ALREADY FELL INTO — read `static_batch_x.js`'s header before writing a line.**
`?statBatchCrossLb` (v1) consolidated batches **across** landblocks and is **CLOSED-NEGATIVE on the 1070**:
ring-spanning nodes forfeit *node-level* frustum culling (per-LB batches only draw the ~10% in view) and it
measured **22.5 vs ~29 fps**. Node-level culling is real and load-bearing; **per-instance** culling (2.9%)
is not. A per-(material, LB) merge keeps node-level culling and drops only the per-instance kind. That
distinction is the whole design, and v1 died by blurring it.

**How to measure it (the instrument problem is now the easy part):** `info.calls` cannot see this win —
merging 5,791 ranges into 512 draws BARELY MOVES `info.calls` (183 → 512, it goes **UP**). Use
`multidraw-truth-probe.mjs`'s true count and **renderCPU**. A merge that halves the frame while raising
`info.calls` is exactly what success looks like here.

## 5. RESIDUALS / UNKNOWNS (honest loose ends)

1. **Nothing was shipped this session.** No source change, no flag, no default flip. Four probes and a
   corrected map. The 12.7 ms is a PROJECTION from a measured per-draw cost, not a measured win — it stands
   or falls on someone building the merge and A/B-ing it.
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

## 7. HARNESS (all in `net-review/`)

- **`multidraw-truth-probe.mjs`** — ⭐ the corrected draw counter (`Σ _multiDrawCount` per rAF, per group,
  vs `info.calls`). **Run this before and after any batching/merge work; `info.calls` cannot score it.**
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
- **Artifacts:** `/mnt/wbterminal2/tmp/{draw-budget,draw-budget-cpu,statics-cpu,bm-flags,multidraw-truth}.json`
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
