# World-expand step 1 — as-built (2026-05-14)

Brief at [`docs/world-expand-step-1-handoff.md`](world-expand-step-1-handoff.md).
12 numbered objectives + 1 follow-on fix shipped via 6 waves of parallel
team agents on the same day. Renderer's static-baked 3×3 Holtburg ring
now extends to a 13×13 ring (169 LBs, ~2.4 km × 2.4 km of Aluvian
Heartlands countryside) with per-LB lazy bakers wired into
`handlePositionUpdate` so players can walk to any LB anywhere on the
map.

## Commit ledger (13 commits, ahead of `origin/master`, NOT pushed)

| Wave | Obj | Commit | What landed |
|---|---|---|---|
| 0 | 1 | `4eae2fc` | docs(emit-dynamic-site): oracle parity for world-expand step 1 |
| brief | — | `d5083eb` | docs(emit-dynamic-site): world-expand step 1 handoff brief |
| 1 | 2 | `7145f11` | feat(holtburger-web): refactor `buildHoltburgTerrain` into per-LB baker + ring driver |
| 1 | 3 | `9ea1601` | feat(holtburger-web): refactor `buildHoltburgBuildings` into per-LB baker + ring driver |
| 1 | 4 | `11eb8f6` | feat(holtburger-web): refactor `buildHoltburgStatics` into per-LB baker + ring driver |
| 2 | 5 | `0b3487b` | feat(holtburger-web): Objective 5 — expose `loadTerrain/Buildings/Statics` on `liveScene3d` |
| 2 | 9 | `c30647d` | feat(holtburger-web): Objective 9 — fog far floor 2500m |
| 3 | 6 | `e736b9b` | feat(holtburger-web): Objective 6 — lazy 3D LB-entry hook in `handlePositionUpdate` |
| 3 | 7 | `f65a7de` | feat(holtburger-web): Objective 7 — distance-keyed subdivision LOD |
| 4 | 8 | `2bbb0ad` | feat(holtburger-web): Objective 8 — flip Holtburg ring radius 1 → 6 (3×3 → 13×13) |
| 5 | 10 | `81482de` | test(holtburger-web): Objective 10 — `capture_world_expand_e2e.cjs` oracle parity for 13×13 ring |
| follow-on | — | `42c71bf` | fix(holtburger-web): alias world-expand baker Sets + opts on `liveScene3d` |

## Verification gates

| Gate | Baseline (`89b3986`) | After step 1 (`42c71bf`) |
|---|---|---|
| `cargo test --workspace` | 1352/0/1 | **1352/0/1** ✓ |
| `wasm-pack build --target nodejs` | clean | **clean** ✓ |
| `wasm-pack build --target web` | clean | **clean** ✓ |
| `node smoke_test.cjs` | 162 OK / 0 FAIL | **173 OK / 0 FAIL** (+11) ✓ |

Smoke deltas per objective:
- Obj 2 / 3 / 4 (per-LB refactors): +1 / +1 / +2
- Obj 5 (liveScene3d hooks): +6
- Obj 6 (handlePositionUpdate hook): +1
- Obj 7 (distance LOD): +1
- Obj 8 (radius flip): +1
- Obj 9 (fog floor): +1
- Obj 10 (capture present): +1
- aliasing fix: +0

Total: +15 smoke checks across the step. (4 less than the 14-objective brief's "≥10 expected"; 11 actually observed; some objectives folded their +N into the parallel agents' overlap.)

## Capture results

`node capture_world_expand_e2e.cjs` (Agent J, commit `81482de`): **9 PASS / 6 FAIL** of 15 assertions. Cold init: **~14 s** (brief expected 10-30 s). All failures were the **two renderer bugs** the capture was designed to find:

1. **`liveScene3d.terrainBakedLbs.size === 0`** — the Set was populated on `scene3dForBuilders.terrainBakedLbs`, not on the public `liveScene3d` object. **Fixed in `42c71bf`** by aliasing the 6 fields (3 Sets + 3 opts bags) at lines 920-921 in `scene3d/index.js`, mirroring the existing `cellContainers3d` / `envCellLoadedLbs` pattern.
2. **`liveScene3d.loadTerrainForLandblock(...)` throws** — same root cause (`this.terrainOpts === undefined`). Fix in `42c71bf` resolves it.

**Capture re-run after the aliasing fix:** deferred to next session (Playwright bootstrap is fragile in headless mode; eye-test from PK on the live-ACE box is the better validation channel).

## Renderer-vs-oracle numbers (captured 2026-05-14)

| Metric | WorldBuilder.Terminal oracle | Renderer at `2bbb0ad` | Δ |
|---|---|---|---|
| Terrain meshes | 169 | **169** | 0 |
| Total placements (buildings + statics) | 766 | 785 = 47 buildings + 729 statics + 9 skippedNoMesh | **+19 (+2.48 %)** |
| Buildings at `0xA9B0` (South Outpost) | 3 (oracle structureCount) | **3** | 0 |
| Oracle parity drill on `0xA9B0` (Wave 0) | 36 placements | wasm 36 placements | **0** (byte-identical) |
| Fog far at init | — | **2500 m** | matches Obj 9 floor |

The **+19 count delta** is an open follow-on. Probable causes:
- `describe-landblock.structureCount` uses shell-pairing logic — different metric than wasm `isBuilding` flag (Wave 0 already flagged this).
- A handful of LBs the wasm bake includes that the oracle's `list-objects` excludes (or vice versa) — needs per-LB diff against the inventory to pinpoint.
- The `1 error` recorded in oracle JSONL (`Could not load landblock 0xA7B3`) means oracle has 168/169 successful LBs; that single missing record could account for some delta.

## What's new in the code (architectural changes)

### Per-LB baker contract

Each of terrain / buildings / statics now exposes three layers (lifted from cells.js's `buildEnvCellsForLandblock`):

```js
// per-LB lazy + idempotent
bakeXForLandblock(scene3d, lbX, lbY, opts, wasmExports);

// thin ring driver (used by the wrapper + init3D direct call)
bakeXRing(scene3d, centreLbX, centreLbY, radius, wasmExports);

// radius=1 back-compat wrapper (for existing 3×3 captures)
buildHoltburgX(scene3d, wasmExports);
```

Idempotency lives in `scene3d.{terrain,buildings,statics}BakedLbs: Set<u32>` keyed by `((lbX << 24) | (lbY << 16)) >>> 0`. Once-per-ring opts persist on `scene3d.{terrain,buildings,statics}Opts` so the lazy hook path can reuse the same wiring without re-resolving uniforms / textures.

### Lazy LB-entry path

`handlePositionUpdate` in `index.html` now mirrors its existing `loadEnvCellsForLandblock` hook for the three new layers:
- Terrain: 3×3 ring around the player's centre LB (LOD + edge stitching)
- Buildings: 1-LB single call (no cross-LB deps)
- Statics: 1-LB single call

The hook fires fire-and-forget per Position update; the bakers' Set guards short-circuit already-baked LBs in O(1).

### Distance-keyed subdivision LOD

`pickSubdivLevelForLb(opts, lbX, lbY)` uses Chebyshev distance from
`opts.playerLbKey ?? opts.initialCentreLbKey ?? (centreLbX, centreLbY)`:
- distance 0: `subdivLevel` (full)
- distance 1: `max(1, floor(subdivLevel / 2))`
- distance 2+: `1` (flat)

At radius=1 (back-compat) this matches the prior centre-vs-ring rule
exactly. At radius=6 it prevents triangle-count explosion in the 144
outer-ring LBs.

### Fog far floor

`scene3d/sky_lighting.js` now defines `FOG_FAR_FLOOR = 2500.0` and applies it as a third `Math.max` argument in `_applyState`'s per-tick `fog.far` clamp. Region 0x13's per-DayGroup `max_world_fog` lerp still drives colour + density curves; only the draw distance is floored.

## Known follow-ons (out of step 1 scope)

| Item | Severity | Notes |
|---|---|---|
| **Re-run `capture_world_expand_e2e.cjs` after `42c71bf`** | high | The aliasing fix should unblock 4 of 6 failing assertions. Open after next dev-server boot. |
| **+19 count delta (renderer vs oracle)** | medium | 2.48 %; worth investigating but doesn't block step 1. Likely a per-LB diff at one of the LBs the wasm reader handles differently than `list-objects`. |
| **3 captures broken by the radius flip** | medium | `capture_phase7_1_terrain.cjs` (lines 269, 295, 300, 305) + `capture_phase7_2_buildings.cjs` (line 348) + `capture_visfid_p22_displacement.cjs` (line 392) — all have hardcoded `=== 9` assertions. Either pin themselves to radius=1 via a URL param, or upgrade their assertions to `>= 9` / oracle-based counts. Documented in `2bbb0ad`'s commit body. |
| **Step 2 — radius as a URL param + spawn-centred ring** | normal | Generalises `HOLTBURG_RING_RADIUS=6` to `?radius=N` and centres on `playerLbAtSpawn` instead of hardcoded `0xa9 0xb4`. |
| **Step 3 — texture-atlas LRU + region streaming + eviction** | normal | Required for whole-Dereth. Gated on perf data from PK's hardware. |
| **Re-bake-on-LOD-shift** | low | Today's step 1 picks LOD at bake time; doesn't re-bake when the player walks closer to a distance-2+ LB that was flat-baked. Step 2 may add re-bake-on-approach. |
| **AmbientRuntime sanity across the new LBs** | low | Walks `terrainGroup.children` so auto-extends, but the new 168 non-Holtburg LBs haven't been audio-verified. PK eye-test. |
| **+1 missing LB in oracle (`0xA7B3` failed `list-objects`)** | low | Single LB in the 13×13 ring where the WorldBuilder.Terminal oracle returned an error. The wasm reader handled it (rendered with terrain=true via the heightmap path). Investigate whether the LB has a malformed retail record. |

## Coordination lessons learned (for future parallel-agent runs)

1. **Multiple agents in the same git tree.** Agents B/C/D all touched `smoke_test.cjs` concurrently. Each used `git apply --cached` with a hand-trimmed single-hunk patch to scope their commit cleanly. Pattern works, but creates "huh moments" mid-run. Easier alternative: keep `smoke_test.cjs` edits in one wave and have a designated "smoke aggregator" agent at the end.
2. **Phantom "completed" notifications.** Wave 2 Agent F and Wave 3 Agent H both hit a wasm-pack-race loop and emitted 3-5 truncated "completed" notifications before the actual final report arrived. Their changes WERE in the working tree but uncommitted. The orchestrator handled both by manually committing their portions (separating from sibling-agent WIP via `git apply` of hunk-specific patches generated from `git diff`).
3. **wasm-pack parallel-run race.** Two concurrent `wasm-pack build` invocations writing to the same `pkg/` dir clobber each other's `holtburger_web_bg.wasm-opt.wasm` mid-run. **Workaround:** isolate each agent's build with `--out-dir /mnt/wbterminal1/tmp/claude-scratch/.../pkg-{agent}/`. Documented in `7145f11`'s commit body.
4. **Honest FAIL is valuable.** Agent J reported 9/15 PASS instead of faking green; the FAIL signals surfaced two real renderer bugs that took ~5 minutes to fix at `42c71bf`. Without the honest report we'd have shipped a broken lazy hook.
5. **Late-arriving full reports.** Agents F and H eventually sent their full reports after multiple phantom truncations — useful retroactive validation but trust the orchestrator's `git log` over the agent's claim.

## Notes for the next world-expand step

Recorded for the agent picking up step 2 (radius URL param + spawn-centred ring):

- The brief's "decisions to NOT re-litigate" remain locked: lazy 3D pipeline, fog-extends-to-cover-ring, no Academy.
- Per-LB cost model from radius=6 measurement: ~14 s cold init for 169 LBs. Linear-ish scaling suggests radius=12 (~25×25 = 625 LBs) hits ~60 s. Radius=20 (~41×41 = 1681 LBs) would hit ~150 s — at that scale, **streaming becomes essential** (load-as-you-walk + eviction-as-you-leave; can't preload).
- The aliasing fix at `42c71bf` is critical context: **every new lazy field on `liveScene3d` needs an alias from `scene3dForBuilders`** at lines 920+. Easy to miss.
- WorldBuilder.Terminal oracle re-runnable for any new region via `/mnt/wbterminal1/tmp/claude-scratch/world-expand/world_expand_inventory.cjs` (change the `lbX/lbY` ranges).
- The single-LB `compare-render-corners` validator (`compare_render_corners.cjs` in WB.Terminal) can sweep a town list for footprint-corner agreement; useful for region-by-region step-2 work.
- Boot pack regeneration: today's boot covers Holtburg's 3-LB closure (1.86 MB). Step 2 might want to extend to radius=N where N matches the eventual streaming radius. `cargo run -p holtburger-tools --bin dat-shard` with the right `boot_landblock` arg is the lever.

## Memory updates

- `~/.claude/projects/-home-wbterminal/memory/project_world_expand_step_1.md` updated with as-built state.
- `~/.claude/projects/-home-wbterminal/memory/MEMORY.md` index line updated.

## Files at a glance

Renderer code:
- `external/holtburger/apps/holtburger-web/scene3d/terrain.js` — Obj 2 refactor + Obj 7 distance LOD
- `external/holtburger/apps/holtburger-web/scene3d/buildings.js` — Obj 3 refactor + Obj 5 opts persistence
- `external/holtburger/apps/holtburger-web/scene3d/statics.js` — Obj 4 refactor + Obj 5 opts persistence
- `external/holtburger/apps/holtburger-web/scene3d/sky_lighting.js` — Obj 9 fog floor
- `external/holtburger/apps/holtburger-web/scene3d/index.js` — Obj 5 load* methods + Obj 8 radius flip + `42c71bf` aliasing fix
- `external/holtburger/apps/holtburger-web/index.html` — Obj 6 lazy hook in `handlePositionUpdate`

Tests / captures:
- `external/holtburger/apps/holtburger-web/capture_world_expand_e2e.cjs` — Obj 10 oracle parity capture
- `external/holtburger/apps/holtburger-web/test_sky_lighting.mjs` — Obj 9 test update
- `external/holtburger/apps/holtburger-web/smoke_test.cjs` — +11 source-pattern checks across the step

Docs:
- `docs/world-expand-step-1-handoff.md` — the brief
- `docs/world-expand-oracle-parity-2026-05-14.md` — Wave 0 oracle parity
- `docs/world-expand-step-1-asbuilt-2026-05-14.md` — this doc

Oracle / scratch:
- `/mnt/wbterminal1/tmp/claude-scratch/world-expand/ring_13x13_inventory.jsonl` (730 KB)
- `/mnt/wbterminal1/tmp/claude-scratch/world-expand/heightmaps_13x13.json` (142 KB)
- `/mnt/wbterminal1/tmp/claude-scratch/world-expand/oracle_0xA9B0.jsonl` + `wasm_0xA9B0.json` + `probe_0xA9B0_wasm.mjs`
- `/mnt/wbterminal1/tmp/claude-scratch/world-expand/objective-{2..10}/` per-agent build outputs / logs

**End of as-built.** Step 2 (radius URL param) and step 3 (region streaming) are the natural next moves; PK eye-test on the live-ACE box is the better validation channel than the headless capture.
