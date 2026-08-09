# T01 — Harness foundation: implementation report

Agent: T01 implementation agent. Date: 2026-08-08. Scope: `apps/holtburger-web/harness/**` only.

## Shipped

| file | what | commit |
|---|---|---|
| `harness/lib/diag_schema.mjs` | diag-surface registry: 20 surfaces (12 current, 8 reserved), S1 closed tag vocabulary (`SCALE_AXES`/`SCALE_TAGS`/`STAT_KEYS`), counter-vs-level + unit + scale per field, same-name-successor encoding (`retiresAt`/`successor`), `validateRegistry()`/`validateField()` | `e1349f13` |
| `harness/test_diag_schema.mjs` | Tier-1 lint: registry validation + evidence re-verification (opens every `current` surface's cited file:line and re-finds the name within ±5 lines) + 13 negative checks | `e1349f13` |
| `harness/lib/report.mjs` | RESULTS-v2 writer (`hb-results-v2`, pass-10 S12): refuses untagged metric keys, off-vocabulary tags, bare-number `*Ms` metrics, alien stat keys, reason-less REJECT arms, comparative verdicts without `controlSpread`; records `ts/commit/distGeneratedAt/url/taint/wasmProfile` | `65972416` |
| `harness/test_report_v2.mjs` | Tier-1 test for the writer + moving-bench `toResultsV2` conversion (synthetic rep, no browser) | `65972416` |
| `harness/lib/console_allowlist.mjs` | console-error allowlist: QuickEmote seed entry + evidence rule; `isAllowed`/`filterErrors`/`validateAllowlist` | `f890f16b` |
| `harness/test_console_allowlist.mjs` | Tier-1 lint + behavior test (unlisted errors gate; near-miss messages not laundered; prose evidence fails) | `f890f16b` |
| `harness/moving-bench.mjs` | converted to emit through the writer: new `toResultsV2()` export; `main()` writes v2 to `--out`. Console output, judge semantics, exit codes unchanged | `85c9d497` |

## Spec conformance

SPEC §3 T01 acceptance bullets:

- **"Tier-1 lints green"** — **MET.** All three new Tier-1 tests pass (results below). They follow the existing `harness/test_*.mjs` convention: bare `node <file>`, exit 0/1, no npm/package.json (harness/README.md:21-24). Note: `harness/` is deliberately outside `run-js-headless.mjs`'s tier scan (its `SCAN` covers app root, `rynth/`, `tests/` only — run-js-headless.mjs:422-447), matching the three pre-existing `harness/test_*.mjs` files.
- **"moving-bench converted to the writer"** — **MET.** Behavior-preserving: identical measurements, judge()/reject semantics, console text and exit codes; only the `--out` JSON shape changed to `hb-results-v2`. Every legacy field rides the arm as an aux key (S12 permits; nothing an operator read from the old shape is lost). Metric mapping: `rafMs→frameMs@moving` (provenance noted as `frameMsSource:"raf-interval"`), `cpuMs→cpuMs@moving`, `draws/ktris @submitted`, resident census `@resident`. `judge`/`deltaWalk` exports untouched — `node test_cam_moving_bench.mjs` still 38/38.

Pass-10 design points implemented as specced:

- D-10.1: `<name>@<scale>` keys, multi-axis (`bytes@wire@preview-complete`), writer throws on unsuffixed keys; registry declares kind/unit/scale; only `*Ms` fields may carry `attribution:true` (counts never priced); the tag vocabulary is ONE closed set shared by registry and writer (report.mjs imports it from diag_schema.mjs).
- D-10.3: counter-vs-level per field; same-name-successor rule mechanical (`__atlasStats→__diag.pools` at ST9, `__landblockLru.getStats→__diag.residency` at ST7; lint fails an unresolvable successor); install-timing ledger via required `availability` (incl. `late` for the ~35 s `__landblockLru` stamp, flag gates for `?vfxGauge`/`?linkProbe`/`?texCensus`).
- S3 registry artifact: current surfaces registered with read-verified field lists — `__bc7Stats` (bc7_textures.js:413-472, 812), `__xu7Stats` (bc7_textures.js:813 → xu7_textures.js:142-211), `__terrainBc7Stats` (terrain.js:3965 → terrain_bc7.js:245-262), `__atlasStats` (static_atlas.js:975-1041), `__diag.render` (index.js:531), `__diag.vfxGauge` (index.js:694), `__diag.wasmMem` (index.js:4667; `hb_mem_census` rows from src/lib.rs:11469-11593 + `summarizeMemCensus` in mem_census.js:30-68), `__hbWasmMemory` (index.html:2269/2291), `__linkProbe` (shader_prewarm.js:175-247), plus `__landblockLru.getStats`, `__diag.textures`, `__diag.runAll` registered opaque with rationale. Reserved pass-10 S3 names claimed with their normative field schemas: `__hbFetch`, `__diag.residency`, `__diag.pools`, `__framePhase`, `__frameWork`, `__texStats`, `__diag.geometry`, `__prewarmStats`.
- D-10.7 console gate: PASS iff zero errors after subtracting the allowlist; unlisted errors fail; seed entry pins `attack 0x13[0-9a-f]{6}` so non-QuickEmote missing links and cast-class hits still gate; evidence citation + date lint-enforced.
- S12 compatibility: existing `docs/RESULTS-*.json` shapes read for reference (RESULTS-statArrayMerge-AB-2026-08-06.json's rows/arm/verdict/errors/n/p50/p95/draws shape); pass 10 specs no consumer-side compatibility beyond moving-bench's own report ("supersedes the ad-hoc shapes; existing harnesses adopt it as they are touched"), and no in-tree programmatic consumer of moving-bench `--out` exists (only `test_cam_moving_bench.mjs` imports `judge`/`deltaWalk`, both unchanged).

## Deviations

None against SPEC.md. Two sub-spec-level notes (refinements, not deviations):

1. Pass-10 S1's "units ride the field NAME (`*Ms`, `*Bytes`)" is enforced one-directionally (suffix ⇒ unit must match; `attribution:true` ⇒ `Ms`-suffixed ms field). A bidirectional rule (every ms field must end `Ms`) would fail pass-10 S3's own reserved schemas (`__framePhase.p0..p4` are last-frame ms; `__hbFetch.milestones.*`; `__prewarmStats.msColor`), so it is not enforced.
2. `toResultsV2` records `wasmProfile:"unknown"` — the PR-13 release-wasm gate (fetching `pkg/*_bg.wasm` Content-Length) is not wired into moving-bench in this task; recorded honestly rather than guessed (handoff below).

## Tests run

All Tier-1 (pure Node, no browser, no wasm — @scale tags N/A, no measurements produced):

```
$ node harness/test_diag_schema.mjs
diag-schema lint: 60 passed, 0 failed (registry: 20 surfaces, 19 tags)
DIAG-SCHEMA ✅   (exit 0)

$ node harness/test_report_v2.mjs
report-v2: 39 passed, 0 failed
REPORT-V2 ✅   (exit 0)

$ node harness/test_console_allowlist.mjs
console-allowlist: 20 passed, 0 failed (1 entries)
CONSOLE-ALLOWLIST ✅   (exit 0)

$ node test_cam_moving_bench.mjs        # pre-existing moving-bench suite
moving-bench test: 38 passed, 0 failed   (exit 0)
```

Regression check: `node harness/run-all.mjs --js` exits 1 both before and after this task for a PRE-EXISTING reason unrelated to T01 — 17 UNREGISTERED app-root/`tests/` suites (`test_bc7_record_budget.mjs` … `tests/portal_clip.test.mjs`) flagged by the coverage guard (run-js-headless.mjs:728-733). None are T01 files; `harness/` is outside that scan. Every suite the runner actually executes passes.

## Handoffs & risks

- **PR-13 wiring:** moving-bench (and future benches) should populate `wasmProfile` from the `pkg/*_bg.wasm` size heuristic or the future `hb_build_profile()` export (pass-10 open Q4). The writer already carries the field.
- **Tier-3 conformance probe** (pass-10 S3: "a Tier-3 descriptor asserts the live page's surfaces match" the registry) is NOT part of T01 (browser-dependent); the registry's `reads`/`availability` fields are shaped for it.
- **Registry growth per stage:** ST2+ tasks land their reserved surface's real fields and flip nothing here — the reserved schemas ARE the normative target; drift between a landed surface and its reserved schema should fail the future Tier-3 probe, not be papered over by editing the schema silently.
- **Evidence re-verification is line-anchored** (±5 lines): large refactors of registration-site files will fail the lint until the registry's `evidence` line numbers are refreshed — that is the intended tripwire, but it means T12/T20/T22 owners touching `scene3d/index.js` around lines 531/694/4667/6042 will need a one-line registry update.
- **Console-gate integration:** benches other than moving-bench should adopt `filterErrors()` when they are touched (S12's "adopt as touched" rule); moving-bench currently records errors in the arm but its judge() already rejects on any error, which is stricter than the allowlist gate — left as-is deliberately (behavior-preserving).
