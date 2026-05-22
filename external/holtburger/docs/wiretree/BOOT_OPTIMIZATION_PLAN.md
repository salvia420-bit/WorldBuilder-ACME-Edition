# Wire-agent cold-boot A/B plan (2026-05-22)

Current baseline: **3.18s** Chromium+SwiftShader (headless, no GPU).

## Boot anatomy (validated by Explore agent #1)

```
T+0.00 → T+0.78  wasm streaming compile + manifest source init   (780ms, serial)
T+0.80 → T+1.12  ACE handshake (server-bound, ~320ms)
T+1.14 → T+1.81  SelectCharacter + spawn (server-bound, ~670ms)
T+1.81 → T+3.18  in-world → ready (1370ms — CRITICAL BOTTLENECK)
                   ├─ phase7.1 terrain bake (~70ms, fast)
                   └─ phase7.2 buildings + statics PARALLEL (~1300ms, statics slowest @ 1330ms)
                       └─ dominated by fetch_surfaces_pixels × 85 + fetch_model_meshes × 66 (UNBATCHED)
```

ACE handshake + spawn (~990ms total) is server-round-trip — can't shrink without server changes. Targets are the **780ms init prefix** and the **1370ms in-world→ready tail**.

## Ranked hypotheses

A/B discipline: one isolated change per test, 3 runs per side, take median.

| # | Hypothesis | Source | Expected | Risk | Effort |
|---|---|---|---|---|---|
| **H1** | `<link rel="preload" as="fetch" type="application/wasm">` for `holtburger_web_bg.wasm` | index.html `<head>` | 200-400ms | low | 1 line |
| **H2** | `<link rel="preload" as="script" type="module">` for `pkg/holtburger_web.js` | index.html `<head>` | 100-200ms | low | 1 line |
| **H3** | `<link rel="preload" as="script" type="module">` for `scene3d/index.js` (wire-relevant only) | index.html `<head>` | 100-200ms | low | 1 line |
| **H4** | Parallelize terrain bake with phase7.2 (`Promise.all([terrain, buildings, statics, envcells])`) | scene3d/index.js L778+L978 | 100-300ms | medium (verify terrain doesn't gate any downstream init) | small refactor |
| **H5** | Batch `fetch_surfaces_pixels` for buildings+statics (use F.41 batched path) | scene3d/buildings.js + statics.js | 200-300ms | medium (existing batch API on wasm side, untested in this path) | larger refactor |
| **H6** | Skip `preInit3D` for wireframe — eager-handoff handles it but adds ~20-50ms | index.html | -20-50ms (negative — DON'T add — eager preInit3D is the win) | — | revert idea |

Wire-mode skips atmosphere/clouds/skydome, so H5 only affects buildings (16 placements, 14 models) and statics (222 placements, 66 models). Buildings is small; statics is the real target.

## Execution order

1. **Baseline establishment**: 3 runs current HEAD (commit 93668b3) on SwiftShader. Take median boot time.
2. **H1 isolated**: add wasm preload only. 3 runs. Diff.
3. **H2 isolated**: add main JS preload (reverting H1 changes). 3 runs.
4. **H3 isolated**: add scene3d preload (reverting H2). 3 runs.
5. **Combined H1+H2+H3**: all preloads. 3 runs. Verify wins compose.
6. **H4 isolated**: terrain Promise.all hoist. 3 runs.
7. **H5 isolated** (if time): batched surface-pixel fetch. 3 runs.
8. **Final state**: ship all wins, revert losses, update memory.

## Measurement protocol

For each run:
- Fresh chromium launch (no warm caches across runs)
- `/clear-cache` driver call before navigate
- Wait for `__bootState === "ready"`
- Record `readyMs` from `t0 = Date.now()` at page-navigate

3 runs per side. Median is the comparison number. If max-min > 30% of median, run 2 more to estimate noise floor.

## Acceptance gate per hypothesis

Ship if:
- Median boot improves by **≥80ms** (above noise floor)
- No regression in rAF probe fps after ready (should be identical — same render path)
- No new error/warning in console during boot

Revert if:
- Improvement ≤30ms (noise)
- Any regression on the above
- Visible glitch (e.g., wasm-init race that flickers)

## Why these and not others

- **Module preload for atmosphere/aurora/cloud** (per agent #3) — irrelevant to wire (we skip them).
- **CDN preconnect** — wire skips most CDN deps; minor win.
- **setupModelLights parallelization** (agent #2 finding) — wire already skips it (`!wireframeMode` gate).
- **Sky-K composer parallelization** — wire skips composer entirely.

All the wire-relevant low-hanging fruit is on the wasm/JS critical path and the phase7 chain.

## Risks

- **Preload + URL query mismatch**: `?v=wire-skylight-skip` cache-bust strings are LIVE in source. Preload `href` must match exactly or it's a cache MISS (worse than no preload). Each cache-bump = preload-string-bump.
- **Preload `as=fetch` + wasm**: Chromium may warn if MIME type doesn't match. Test for console warnings.
- **Promise.all hoist for terrain**: If terrain bake mutates `scene3dForBuilders` state that buildings/statics read at construction-time, parallel execution could race. Verify by reading the bake entry sigs.

## Execution log — A/B results

### Methodology evolution

First two attempts used full-boot measurement (autoSpawn=first → `ready`):
- 3 runs same account → 11.1s/4.6s/4.5s on tailnet1 (chaos from kick-dance state drift)
- 4 runs rotating 4 accounts → 4.6s/5.1s/4.2s but only first run "clean", rest hit kick-dance
- 30s inter-run sleeps → stable at 12.3s but kick-dance ALWAYS fires (dominates signal)

The kick-dance overhead (~7-8s) drowns the wasm-prefix and phase7 signals we're optimizing.

**Pivot — measure to `char-list-ready` with fresh auto-create accounts.**
- ACE auto-creates accounts at level 4 (`AllowAutoAccountCreation: true`, `DefaultAccessLevel: 4`)
- New account = no character = autoSpawn=0 stops cleanly at char-list-ready
- No kick-dance overhead; no phase7 noise
- Each run uses unique timestamp-suffixed account name
- ~900ms per run = 4-5s for an A/B comparison

This isolates the wasm streaming compile + ACE handshake prefix (the part H1 targets) from the in-world phase (the part H4/H5 target).

### H1 — wasm `<link rel="preload" as="fetch">`

| variant | median | min | max | range | N |
|---|---:|---:|---:|---:|---:|
| baseline (no preload) | **924ms** | 880ms | 938ms | 58ms | 4 |
| H1 (with preload) | **969ms** | 930ms | 1068ms | 138ms | 4 |
| baseline repeat | 924ms | 880ms | 938ms | 58ms | 4 |

**Verdict: REJECT — within noise (+45ms vs ~70ms range), no measurable benefit.**

Why: on localhost the wasm fetch is already near-instant. Preload only helps when fetch latency can overlap with HTML parse + script eval. With local-server fetches finishing in <50ms there's nothing to overlap.

Reverted in-place — index.html restored to pre-H1 state.

**Expected to help on**: cloud-VM scenarios with real network latency (50-200ms RTT). Worth re-running A/B with `--throttle` chromium flag to simulate.

### H2-H5 — not executed this session

H2 (main JS preload) and H3 (scene3d preload) have the same "no localhost win" risk as H1. Defer to slow-network testing.

H4 (terrain Promise.all hoist) — agent 2's 800-1200ms estimate was wrong. Agent 1 measured terrain bake at 70ms in agentic=low (9 LBs). Hoisting saves at most 70ms. Not worth the code reshuffle.

H5 (batched fetch_surfaces_pixels) — biggest potential win (200-1000ms) but requires wasm-side batch route for statics that doesn't exist yet (F.41 exists for entities). Larger refactor — defer.

## What WOULD measurably improve wire boot

Based on the analysis, the actually-impactful changes require non-trivial work:

1. **Batched surface-pixel fetch for statics/buildings** (H5 properly) — implement `fetchStaticsSurfacesPixelsBatch` wasm export, plumb through bakers. Estimated 200-500ms.
2. **Phase7 trigger before in-world** — start phase7 fetches during the ~670ms spawn window (T+1.14 → T+1.81). Risk: phase7 reads wasm state that's only valid post-spawn.
3. **Throttle the test environment to surface preload wins** — if the deployment target is cloud-VM with real latency, H1-H3 preloads might genuinely save 200-500ms there. Re-run with Chromium's CPU + network throttling.

Current 924ms char-list-ready is a hard floor on localhost — dominated by wasm streaming compile (~700ms) + ACE LoginRequest round-trip (~200ms). Both inherent.
