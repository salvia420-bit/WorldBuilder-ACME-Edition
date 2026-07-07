# HANDOFF — statics / residency perf, next pass (2026-07-07)

You are continuing a town-load performance effort on branch
**`feat/net-worker-transport`**. The *reported* bug (a ~10-minute freeze when
teleporting to the "Town Network" hub dungeon) is **already fixed and pushed**
(Step 1a). Your job is the **remaining** per-frame statics-cull cost that only
bites a **large OUTDOOR view** + a couple of orthogonal secondary items. Read
this whole doc before touching code.

---

## 0. MANDATORY READING (in this order — do not skip)

1. **`docs/statics-cull-2026-07-07.md`** — the core handoff. The profiled root
   cause, what Step 1a did, and — critically — **why the per-LB "bucketed cull"
   (Step 2) was ATTEMPTED, MEASURED INEFFECTIVE, and REVERTED.** This is the
   single most important thing to internalise (see §4 below).
2. **`docs/dev-build-perf-fix-2026-07-07.md`** — the residency roadmap + the two
   earlier landed wins (entity-decode worker offload, spawn dispatch time-slice)
   and the "Remaining (the real residency work)" section.
3. **`docs/url-flags.md`** — grep for `bakeWorker`, `noSpawnTimeSlice`,
   `spawnDispatchPerTick`, `indoorPvsRing`. These are the flags this effort added.
4. **The buildbox design corpus in `~/from-vm/` — MANDATORY, see §1.**
5. MEMORY.md §3 `our-client` + `gfx-and-motion` + the `perf-maintainability`
   runbook (`retail-residency-is-the-target`, `verify-agent-leads`,
   `system-work-in-RUST-not-JS`).

## 1. MANDATORY — verify + read the `~/from-vm/` workflow corpus

A 16-agent design workflow ran on the buildbox for this change. Its output is on
this laptop. **Verify it is intact, then read it — but read it CRITICALLY (§4).**

```bash
ls -la ~/from-vm/statics-cull-wf.tgz ~/from-vm/statics-cull-wf/
# integrity: expect sha 480ad9ec778fc881a3ed437c09d68252d3770e47f2cd46ad05b5d95b1e00d4e1
cd ~/from-vm && sha256sum -c <(sed 's#/home/wbterminal/#./#' statics-cull-wf.tgz.sha256) 2>/dev/null \
  || sha256sum statics-cull-wf.tgz   # compare to the hash above
```
Contents: `statics-cull-wf/FINAL_DESIGN.md` (the synthesis) + `parts/01.md …
16.md` (per-facet deliverables) + `pre.md` (the shared brief) + `run.log`.

**Read, in priority order:**
- `FINAL_DESIGN.md` — the synthesis. ⚠ Its headline recommendation (per-LB
  bucketed cull, §2/§3 Step 2) is the one that was **falsified by measurement** —
  read §4 below FIRST, then read this for the *other* steps.
- `parts/08.md` — **over-streaming** (the real win; Step 1a came from here).
- `parts/10.md` — **retail residency reference** (LScape/DBOCache/PVS — the
  target architecture).
- `parts/11.md` — **missing-surface negative cache** (a clean, independent win).
- `parts/12.md` + `parts/16.md` — **cross-LB batched/instanced node interaction**
  and the red-team. These two came CLOSEST to catching the Step-2 flaw; re-read
  them knowing the flaw is real.

## 2. State of the branch (what is landed + pushed)

Branch `feat/net-worker-transport`, pushed to origin. Three commits this series:

| commit | change | flag (default-on) | verified |
|---|---|---|---|
| `0947f41e` | entity surface decode → bake_worker | `?bakeWorker=0` | main-thread block 3506→54 ms (−98%), bit-equivalent |
| `83f88c6b` | time-slice ObjectCreate→spawn dispatch | `?noSpawnTimeSlice=1`, `?spawnDispatchPerTick=N` | 120-spawn worst freeze 2020→561 ms (−72%) |
| `0e653945` | indoor PVS-ring gate (Step 1a) + these docs | `?indoorPvsRing=N` | Town Network residency 65→6 LBs (−91%) |

`scene3d/statics.js` is **pristine** (Step 2 reverted — do not look for it there).

## 3. The profiled root cause (ground truth, CDP through the freeze)

The Town Network freeze is the **per-frame statics tick scaling O(total resident
statics)**. `scene3d.staticsGroup` is a FLAT list; three passes walk it in full
every frame: `cullStaticsGroup` (statics.js), `tickStaticsBillboards`
(statics.js, own rAF), lighting `recordStatics` (lighting.js, O(N²) — re-walked
after each per-LB bake). Profile self-time: `_resolveStaticCullSphere` 11.0%,
`tickStaticsBillboards` 7.2%, three `intersectsSphere` 6.4%, `cullStaticsGroup`
6.1%, `recordStatics` 5.0%, `_staticOwnsLight` 2.9% → statics.js 27.4% of all
samples. At Town Network the streamer went to **~65 resident landblocks**.
Step 1a cut that to 6 (indoors), which resolves the reported freeze.

## 4. ⚠ THE STEP-2 DEAD-END — do NOT repeat it

The design (buildbox agents 05/06) recommended a **per-landblock bucket index**:
one aggregate-sphere frustum test per LB gates the whole bucket → O(N_LBs). I
implemented it (exact, conservative union spheres) and **measured it on the real
scene: it does not work.** At 65 LBs / 50,843 nodes: **only 52 buckets vs 49,092
nodes in the cross-LB tier (96%)**; `cullStaticsGroup` cost unchanged (~9 ms).

**Why:** the statics are **cross-LB INSTANCED.** The ~50k `InstancedMesh`/LOD
consolidation nodes carry `userData.coversLbKeys` (a **Set of size > 1** — one
mesh spans many landblocks; the statAtlas / cross-LB-consolidation trade of
draw-calls for un-bucketable nodes), NOT a single `userData.landblockId`. Only
non-consolidated singletons have `landblockId`. A salvage that bucketed
`coversLbKeys.size===1` nodes moved almost nothing (they are genuinely
multi-LB). **Per-LB spatial bucketing therefore cannot group the dominant node
set.** This is the `verify-agent-leads` discipline paying off — the design's
central premise was false for the real node structure, and only an empirical
measurement caught it. **Measure node structure BEFORE designing any spatial
cull.**

## 5. YOUR TASK — the remaining levers (pick with the user; all OUTDOOR-only)

The dungeon case is done. What is left is the per-frame cull at a large OUTDOOR
view (many LBs resident → ~50k cross-LB instanced-node frustum tests, ~9 ms/
frame). Candidate approaches, roughly by ROI/risk (NONE validated — measure):

1. **Outdoor residency cap** (safest, highest-ROI). `FINAL_DESIGN` secondary +
   `parts/08.md`: the LRU `maxResident` self-sizes to ~203 so eviction rarely
   fires and the resident set grows as you roam. Size it to the working set
   (`seen`+skirt) recomputed on LB crossings. This cuts N for the cull the same
   way Step 1a did indoors. Verify no evict↔re-bake thrash.
2. **Missing-surface negative cache** (independent, clean). `parts/11.md`: surface
   `0x08F00001` warned "unavailable → empty fallback" **569×/90 s** (no memo of
   the miss). Rust `HashSet` on the manifest source gated on catalog-absence
   (manifest is session-immutable → a catalog-absent DID is permanently absent,
   never masks a later record) + a JS `MaterialCache.missingSurfaces` Set.
3. **Fewer / coarser instanced nodes** — cut the ~50k node count directly
   (larger InstancedMesh consolidation). Harder; measure draw-call vs cull trade.
4. **Spatial hash on node aggregate-sphere CENTERS** (NOT landblockId) — the only
   hierarchical cull that fits cross-LB instanced nodes. Large multi-LB spheres
   cull poorly, so payoff is uncertain — a probe first, before any code.
5. **Also owed: a 1070 pixel eye-test for Step 1a** — confirm nothing visibly
   missing at a dungeon mouth/portal where surface is visible through the
   render-set (`?indoorPvsRing=1` default vs `=5`). SwiftShader here cannot judge
   pixels — this needs the 1070 (see §7).

## 6. How to measure (reproduce the exact A/B rig)

- Harness: `apps/holtburger-web/harness/lib/boot.mjs` → `launchAndEnter({query})`
  returns `{page, helpers, inWorld}`. Account **tailnet1/tailnet1** (accessLevel
  4 = Developer → `@telepoi` works). Live ACE runs on this laptop (Holtburg).
- Teleport: `window.__sessionHandle.sendChat("@telepoi Town Network")` (valid
  POIs: `SELECT name FROM ace_world.points_of_interest`). The character POSITION
  **persists** on ACE between sessions — a fresh boot lands where you last were.
- Force a high resident-LB count for an outdoor-style A/B even at the dungeon:
  **`?indoorPvsRing=5`** (disables Step 1a → ~65 LBs resident).
- Time the REAL cull: dynamic-import the live module + use the render loop's
  culler (fresh each frame):
  ```js
  const sm = await import("/apps/holtburger-web/scene3d/statics.js");
  const s3 = window.liveScene3d, culler = s3._frustumCuller;   // getFrustumCuller() in culling.js
  sm.cullStaticsGroup(s3, culler);                              // warm
  const t0 = performance.now(); for (let i=0;i<400;i++) sm.cullStaticsGroup(s3, culler);
  const perCallMs = (performance.now()-t0)/400;
  // node census: s3.staticsGroup.children.length, s3.staticsBakedLbs.size,
  //   coversLbKeys distribution, visible = children.filter(c=>c.visible!==false).length
  ```
- Main-thread-block metric: a 4 ms `setInterval` heartbeat; the max inter-fire
  gap during an operation = the longest freeze. `?nullRender=1` MANDATORY headless.
- Scratchpad probes from this session are gone; the recipe above reproduces them.
- **`window.liveScene3d` is set ~35 s AFTER in-world** — poll it non-null first.

## 7. Environment & fleet (facts you will need)

- **This laptop is NO-GPU (SwiftShader).** Good for scene-graph / console / state
  / timing / 0-errors. **Never trust it for pixel fidelity** — culling changes
  (things vanishing) MUST get a **1070** eye-test. 1070 recipe + the
  `__bootState==='ready'` gate + `?nosw=1`: `memory/fleet-runbooks.md`.
- Dev server: `external/holtburger/scripts/serve.py` → `:8765`; app at
  `http://127.0.0.1:8765/apps/holtburger-web/index.html`. JS is LIVE (no build);
  a wasm change needs `capped-build wasm-pack …` (memory `capped-builds`).
- **`?nosw=1` on EVERY dev URL** (service worker caches index.html/shards).
- **Buildbox fan-out** (for another 16-agent design pass): recipe in
  `memory/fleet-runbooks.md`. ⚠ **AUTH GOTCHA (cost me a wasted launch):** the
  box's stored Claude OAuth token EXPIRES (401 → agents emit 74-byte error
  stubs). Refresh it before launching:
  `gcloud compute scp ~/.claude/.credentials.json buildbox:~/.claude/.credentials.json --zone us-central1-a`
  then `chmod 600` on-box and smoke-test `claude -p ... "PONG"`. Also
  re-run the synthesis if it hits a transient "API Overloaded".

## 8. Guardrails any statics-cull work MUST keep (from `parts/13.md`)

- **Never hide a static that owns an active `SetLight`** (`_staticOwnsLight`
  guardrail — extinguishing its light pops on-screen illumination).
- **BatchedMesh statics sit at group origin** and self-cull per instance — keep
  them visible (the 2026-07-02 "vanished-forests" bug if you node-cull them).
- **Shadow casters** off the camera frustum can still cast INTO view.
- A conservative bound (union sphere) makes a hierarchical frustum cull EXACT
  (same visible set) — an under-sized bound = visible pop.

---
*Landed by the 2026-07-07 town-load-perf session. The reported freeze is fixed;
everything above is hardening + the design corpus that produced it. Start at §0.*
