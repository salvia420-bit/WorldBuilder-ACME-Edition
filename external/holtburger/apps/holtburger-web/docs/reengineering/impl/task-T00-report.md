# T00 — CENSUS-CLASS spike: implementation report

Agent: T00 implementation agent. Date: 2026-08-09. Scope: `apps/holtburger-web/harness/census-class.mjs` (+ reducer test), `docs/reengineering/impl/`.

**Status: BLOCKED (I9).** The classifier/harness is complete and Tier-1-green; the live census could not be completed on this box — earlyoom killed the census chromium's renderer during the Nanto streaming burst on both permitted attempts (evidence below). No numbers are reported; nothing was substituted for the live census.

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
