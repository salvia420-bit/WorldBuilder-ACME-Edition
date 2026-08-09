# T00 — CENSUS-CLASS spike: implementation report

Agent: T00 implementation agent. Date: 2026-08-09. Scope: `apps/holtburger-web/harness/census-class.mjs` (+ reducer test), `docs/reengineering/impl/`.

**Status: DONE (live census ran 2026-08-09 — see "Live run 2026-08-09" below; VERDICT: RE-EXAMINE).** Historical context: the harness landed Tier-1-green at `0ad7e151` while the live census was BLOCKED (I9) — earlyoom killed the census chromium's renderer during the Nanto streaming burst on both attempts permitted that night (evidence below, kept verbatim). The blockers cleared (box quiet, ~4.3 GB available, swap free; ACE up) and run 3 completed both scenes.

## Shipped

| file | what | commit |
|---|---|---|
| `harness/census-class.mjs` | CENSUS-CLASS collector + reducer + live driver: page-side collector over the live material populations (scene walk under the world groups + MaterialCache maps), node-side reducer building EXACTLY pass-07 S3's class key, (sector × class) pool projection from per-instance matrices, pass split (P7 Q2 translucent residue), axis-explosion analysis, RESULTS-v2 emission (@resident/@cached), prewarm class-list artifact, WITHIN-BOUNDS / RE-EXAMINE verdict vs SPEC §3 T00 bounds (classes ≤ 48, pools ≤ 300) | `0ad7e151` |
| `harness/test_census_class.mjs` | 35 Tier-1 checks: exact S3 key encoding (full-precision alphaTest string, custom-blend triple, `_patchSetCacheKey` verbatim, VFX `set#config` token, row-31 floorBias distinctness, tex dims byte + f7/f8, shadow pair), pool projection incl. unknown-sector conservative floor, pass classification (D-07.3), axis analysis, verdict rule | `0ad7e151` |

Classifier axes are read-verified against the live code (this session): `_stateKeyOf` static_atlas.js:480-498 (+ `_applyStateKey` 501-521, RND-33 wrap field); side/FrontSide clones materials.js:3521-3540; `_patchSetCacheKey` materials.js:553-585; VFX `set#config` token statics.js:1791-1802 + `getCachedVariant` key `${did}|${setKey}|${configKey}` materials.js:3625-3646; MaterialCache maps materials.js:2823-3062; atlas buckets `stat-atlas-x-` + `_bucketKeyFor` (`f7|f8`) static_atlas.js:1097-1100, 1181-1248; cross-LB buckets + merged pools static_batch_x.js:1440-1510; pool material name `stat-array-pool-` static_array_pool.js:436-438; animated scenery `isAnimatedSceneryInstanced` animated_scenery.js:571; particles `userData.__particle` particles/particle_manager.js:1311; world groups index.js:1415-1420; `liveScene3d` facade index.js:3372-3423 (snapshot trap null-guarded — the collector reports `cache.available:false` honestly if the init3D snapshot predates the cache).

## Spec conformance

SPEC §3 T00: *"Run the class-cardinality census over TODAY'S materials (CI arm, quality mid): classifier over live MaterialCache populations at settled Nanto + Town Network. Acceptance: report published; classes ≤ ~48 / projected pools ≤ ~300, or pass 7's key design is re-examined BEFORE T22 sizes anything."*

- **"classifier over live MaterialCache populations"** — **MET (tooling)**: built, tested, CI-runnable (`node harness/census-class.mjs --live`), quality=mid per pass-10 Q5.
- **"at settled Nanto + Town Network"** — **FAILED on this box (BLOCKED)**: neither scene reached a settled capture. Both attempts died in the Nanto post-teleport streaming burst; Town Network was never reached. Evidence in "Census attempts" below.
- **"report published … or re-examined"** — this report is published; **no verdict line can be honestly issued** (no data). The bounds question stays OPEN and still gates T22 sizing (see Handoffs).

**VERDICT: BLOCKED — census not run; WITHIN-BOUNDS / RE-EXAMINE undetermined.** Per the orchestrator's revised go/no-go (RAM gate lowered to 1.7 GB, one retry on a browser death), the second earlyoom kill is the hard stop.

## Census attempts (what was tried, exactly)

Preconditions verified: live ACE up (`ss -ulpn` ports 9000/9001, pid 498841); serve.py :8765 over the live tree with dist symlink healthy; `pkg/holtburger_web_bg.wasm` 6.2 MB (release-profile per the size heuristic — census counts are wasm-profile-independent, recorded for run validity only); no competing test chromium either attempt.

1. **Attempt 1** (2026-08-09 01:56, `--scenes nanto,townnetwork`, zero-GPU bot recipe `nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&quality=mid&agent=1` + autoLogin via `harness/lib/boot.mjs`; launch gate: 1854 MB available ≥ the revised 1.7 GB): in-world in 10,889 ms, `@telepoi Nanto` sent, then `page.evaluate: Target crashed` during settle polling. earlyoom log: `sending SIGTERM to process 1755780 … "chrome-headless" --type=renderer … VmRSS 1210 MiB` at `mem avail: 619 of 5341 MiB (11.60%), swap free: 0 of 6986 MiB`.
2. **Attempt 2** (the one permitted retry, 01:58, same recipe + `&lbCap=64` — the documented 8 GB-box ring-cap mitigation, url-flags.md `terrainBatch` row; recorded in taint; launch at 1793 MB available): in-world in 7,499 ms, `@telepoi Nanto`, `Target crashed` again. earlyoom: `SIGTERM to process 1756364 … VmRSS 1199 MiB`.

Diagnosis: the renderer needs ~1.2 GiB RSS through the Nanto teleport-burst bake storm regardless of `lbCap` (the cap bounds steady-state residency, not the burst), and the box had zero elasticity — swap 100% consumed (6,986/6,986 MiB) with ~2.1 GB held by other active sessions' tsservers (1.1 GB + 0.7 GB, owned by other running claude sessions — not killable from this task). earlyoom (`-m 12,5`, chrome in the prefer set) fires at ~640 MB available; both runs crossed it during the burst. Logs preserved: `/mnt/wbterminal2/reeng/T00/census-run.log`, `census-run2.log`; earlyoom lines quoted above from `/var/log/earlyoom.log`.

Not tried, deliberately: a third attempt (forbidden by the orchestrator directive), killing other sessions' language servers (outside my authority), a static-code estimate in place of the live census (forbidden by the task brief), quality≠mid (pass-10 Q5 requires mid).

## Deviations

None against SPEC.md. Two operational notes:

1. Attempt 1's runner piped through `tee | tail`, masking the node exit code (cosmetic; the crash was diagnosed from the log + earlyoom, and attempt 2 captured the true exit 1).
2. `--lbcap` was added to the harness for attempt 2. A capped run is a BOUNDED-RING census: class cardinality remains content-driven, but measured pool counts are ring-scale — the harness header documents that the full-ring ceiling must then be stated as classes × ≤16 sectors (pass 7 D-07.1), and the cap self-records in the RESULTS taint list.

## Tests run

```
$ node harness/test_census_class.mjs
census-class test: 35 passed, 0 failed
CENSUS-CLASS-TEST ✅   (exit 0)
```
Pure node, no browser, no measurements produced (@scale N/A — the test locks encodings and arithmetic, not figures). Live-run artifacts (RESULTS-v2, `t00-class-census.json`): **not produced** — no data; the writer was exercised end-to-end only by the Tier-1 test.

## Handoffs & risks

- **T22 must NOT size against an assumed census.** R-03 (class-cardinality closed set) remains OPEN with the ≤48/≤300 figures still [A]. The census is one command away wherever RAM allows:
  `node harness/census-class.mjs --live --scenes nanto,townnetwork --out <results.json> --artifact docs/reengineering/impl/t00-class-census.json --commit $(git rev-parse --short HEAD) --wasm-profile release`
  Viable venues: (a) this box when ≥ ~2.5 GB is genuinely available AND swap is not saturated (both attempts show 1.7-1.8 GB at launch is NOT enough through the Nanto burst); (b) the 1070 (the census's confirm arm lives at GATE-POOLS anyway — F-11.13; running the CI arm there first is legitimate, tagged with the box). The reducer re-runs offline from a snapshot via `--reduce`.
- **Collector snapshot caveat for the eventual run**: if `liveScene3d.materialCache` is null (init3D snapshot trap), the cache-side census reports `available:false` and only the scene-walk half lands — the pooled verdict is unaffected (it is scene-walk-only by design), but the @cached rows will be absent; note it in that run's report.
- **Scene-attached ≠ resident-total**: warm-parked LBs are detached (landblock_lru park) and are not walked — the census measures the attached population + cache maps. Stated in the harness header and the RESULTS notes template; do not read its `@resident` rows as the full warm-park pool.
- **Boot itself is healthy at this memory level** (in-world in 7.5-10.9 s both attempts, M9-consistent); the killer is specifically the post-teleport streaming burst. If a future census must run on this box under pressure, the promising lever is spawning AT Nanto (skip the teleport invalidate) or a `?netDrainHz` throttle to flatten the burst — both untested, recorded here for the next owner.

## Live run 2026-08-09 (run 3) — census completed, VERDICT: RE-EXAMINE

Same agent, later the same day, after the orchestrator cleared both blockers (box quiet — no bake, sibling tsservers gone after reboot; live ACE back up).

### Run record

- **Command** (exact):
  `node harness/census-class.mjs --live --scenes nanto,townnetwork --out /mnt/wbterminal2/reeng/T00/t00-results-v2.json --artifact docs/reengineering/impl/t00-class-census.json --snapdir /mnt/wbterminal2/reeng/T00 --commit 4ecc8ec6 --wasm-profile release`
- **Box state at launch (R-MEM gate)**: 4321 MB available (gate ≥ 1700 PASS), swap 5864/6986 MiB free (vs 0 free at the failed attempts). Minimum observed during the Town Network burst: 1234 MB available. **No earlyoom kill** — the run's chromium lived to a clean harness exit (exit 1 = the RE-EXAMINE verdict path, census-class.mjs:827, not a crash). ACE up on :9000/:9001 (pid 283170); serve.py :8765 over the live tree; dist symlink healthy per `dist/_health.json` (shards 263 buckets, scenery 65025, spawns present).
- **Tree state**: holtburger `4ecc8ec6`; `pkg/holtburger_web_bg.wasm` = T20 release build, 6,344,497 B, sha256 `1f6f57c9432928c890fdef6e38ca9a5e016a15063855c765d224484b7e173907` — verified identical before and after the run (sibling T15 did not ship a new pkg/ mid-census).
- **lbCap re-derivation**: run WITHOUT `lbCap` (attempt 2's mitigation). The cap bounds steady-state residency, not the burst, and taints pool counts to ring-scale; with 4.3 GB available the ~1.2 GiB renderer burst clears without it. Full-ring, untainted pool counts below.
- **Recipe**: zero-GPU bot, `?renderer=3d&nullRender=1&autoLogin=1&autoSpawn=first&nosw=1&renderOnDemand=1&netDrainHz=30&quality=mid&agent=1` (quality=mid per pass-10 Q5). In-world in 10,106 ms.

### Results (RESULTS-v2: /mnt/wbterminal2/reeng/T00/t00-results-v2.json; both arms USABLE; taint: census-class, renderOnDemand)

| metric | nanto (lb 0xe63e0022) | townnetwork (lb 0x00070143) |
|---|---|---|
| pooled classes (st+ec) @resident | **122** | **80** |
| projected pools @resident | **352** | **274** |
| pooled materials / instances | 399 / 28,306 | 146 / 27,809 |
| sectors | 11 | 12 |
| pass split (opaque/additive/translucent inst) | 26,212 / 0 / 2,094 | 25,726 / 0 / 2,083 |
| domains (classes: st / ec / as / tr) | 83 / 39 / 2 / 1 | 61 / 19 / 2 / 1 |
| cache @cached (materials / core keys) | 803 / 172 | 491 / 80 |
| terrainBakedLbs | 130 | 136 |
| settled (plateau reached) | **false** | **false** |

**VERDICT: RE-EXAMINE** — nanto: classes 122 > 48; nanto: pools 352 > 300; townnetwork: classes 80 > 48 (bounds: classes ≤ 48, pools ≤ 300).

Axis analysis (classes the axis adds, nanto / townnetwork):

| axis | nanto | townnetwork |
|---|---|---|
| **texDims** | **+92** (30 without) | **+54** (26 without) |
| patchBias | +20 | +2 |
| stateAlphaTest | +16 | +12 |
| patchVfx | +8 | +9 |
| texFormat | +4 | +2 |
| vfxConfigOnly | +0 | +3 |
| domain, blend, wrap, side, depthWrite, shadow | +0 | +0 |

### Taints and caveats (recorded, per the harness contract)

1. **Neither scene reached the settle plateau in time** — captured anyway, `settled:false` in both arms. Counts are late-burst residency, not a fully-settled floor; direction of error is unknown but small (terrainBakedLbs 130/136 shows streaming was substantially complete).
2. **Town Network: 8 classes with VFX set `deformation.windSwayGpu` config unresolvable** (`#?` token, counted as ONE config each) — the TN class count is a FLOOR on the vfx-config axis. Nanto resolved its configs fully.
3. `@resident` = scene-ATTACHED population + cache maps; warm-parked LBs are detached and not walked (harness header). The @cached rows DID land (liveScene3d cache snapshot was live — the init3D-snapshot trap did not bite).

### R-03 disposition (what T22 may and may not do)

- **R-03 is now MEASURED, not assumed — and the answer is RE-EXAMINE.** The pass-7 S5.3 [A] figures (≤48 classes / ≤300 pools) do NOT hold for the S3 key as designed: 122/352 at Nanto.
- **The fragmentation is one axis, not the design.** Remove texDims and both scenes are comfortably inside the class bound (30 / 26 ≤ 48). Every state axis except alphaTest contributes zero. The core key (domain|state|patch|shadow) is sound; the raw texture-dims byte (`x{log2 dims}{f7|f8}`) is the fragmentation vector — 92 of Nanto's 122 classes exist only because of it. Secondary contributors worth a look in the same re-examination: patchBias (+20 at Nanto — the row-31 floorBias distinctness) and full-precision alphaTest strings (+16/+12; three distinct values observed: 0, 0.392…, 0.784…).
- **T22 MUST NOT size pools against ≤48/≤300** — per SPEC §3 T00 acceptance, pass 7's key design gets re-examined BEFORE T22 sizes anything. The concrete re-examination question for the orchestrator: fold/bucket the tex axis (e.g. atlas-tier buckets instead of raw log2 dims — the `f7|f8` format split alone costs only +4/+2), then re-reduce OFFLINE from the captured snapshots (`--reduce /mnt/wbterminal2/reeng/T00/census-class-{nanto,townnetwork}-2026-08-09.json`) — no new browser run needed to evaluate candidate keys.
- Prewarm class-list artifact for T22: `docs/reengineering/impl/t00-class-census.json` (committed).
- The 1070 confirm arm (F-11.13, GATE-POOLS) remains the census's second venue; this CI arm is the box-tagged first measurement.

### Artifacts

- RESULTS-v2: `/mnt/wbterminal2/reeng/T00/t00-results-v2.json`
- Raw snapshots (re-reducible): `/mnt/wbterminal2/reeng/T00/census-class-nanto-2026-08-09.json`, `census-class-townnetwork-2026-08-09.json`
- Run log: `/mnt/wbterminal2/reeng/T00/census-run3.log`
- Class-list artifact: `docs/reengineering/impl/t00-class-census.json` (committed with this report)
