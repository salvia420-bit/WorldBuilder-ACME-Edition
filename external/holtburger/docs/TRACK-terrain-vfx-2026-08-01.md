# TRACK — terrain-VFX program tracker (started 2026-08-01)

Working doc for the orchestrator. Plan of record:
`apps/holtburger-web/docs/2026-07-31-terrain-vfx-plan.md` (§7 wave plan, §8 risks).
Handoffs: wave0 + wave1 in this dir. **Update this file as items land; do not
start work not listed here.**

## Standing rules (violations = the "sidequests" this doc exists to prevent)

- **NO live browser/eye testing this session** — owner instruction 2026-07-31:
  laptop cannot host client sessions; look validation is an owner-run batched
  1070 session. We only ACCUMULATE the eye-test queue (§Eye-test queue below).
- Functional validation = node suites only (`node apps/holtburger-web/test_*.mjs`).
- Every terrain-fragment-shader edit → re-run `test_terrain_water.mjs` (73/0)
  and `test_terrain_sand_sparkle.mjs` (62/0).
- All new flags SHIP-OFF strict `=== "on"`; DEFAULT-ON count stays 14
  (`test_vfx_flags.mjs`). Bare-default boot must be byte-identical.
- Zero new npm packages. No new lights. No per-instance customProgramCacheKey.
- `quality-presets.md` lives at `external/holtburger/docs/` (repo docs, NOT app
  docs) — wave-1B missed it; don't repeat.
- No refactors / drive-by fixes; note them in the report and move on.

## Status board

| Wave | Family | Status |
|---|---|---|
| 0 | oracle + spine + trail map | ✅ landed 2026-07-31 |
| 1A | GRASS | ✅ landed 2026-07-31 (blade-revive live reading still owed → eye-test queue) |
| 1B | SAND | ✅ landed 2026-07-31 (devils never seen live — needs desert → eye-test queue) |
| **2A** | **SNOW/ICE** | ✅ merged to master 2026-08-01 (`4ff7494d..23dea459`, ff) — snow 186/0, ice 85/0, water 73/0 re-verified by orchestrator; look untested → eye-test queue N1–N10 |
| **2B** | **VOLCANO** | ✅ merged to master 2026-08-01 (`77a23ac6`) — volcano 147/0 + shader 103/0; ash DEFERRED (plan §8 r9); look untested → eye-test queue V1–V7 |
| **3A** | **SWAMP** | 🔶 IN FLIGHT (Opus agent, worktree) |
| **3B** | **DIRT/MUD** | 🔶 IN FLIGHT (Opus agent, worktree) |
| 4A | ROCK/BARREN | ⬜ |
| 4B | promotion pass | ⬜ OWNER-GATED (needs the 1070 batch) |

## Wave 2 execution checklist (this session)

- [x] Read wave-0/1 handoffs + plan §3.4, §3.6, §7, §8
- [x] Launch 2A SNOW/ICE (Opus, worktree)
- [x] Launch 2B VOLCANO (Opus, worktree)
- [x] 2A done → verify its suites + water/sparkle regression in its worktree
- [x] Merge 2A to master FIRST (it owns the terrain-fragment seam this wave)
- [x] Merge 2B; crack glow placed AFTER snow blocks; fragColor byte-unchanged;
      volcano-shader proximity threshold widened 1200→2400 (merge note)
- [x] Post-merge full battery: 20 suites 0 failed (scatter now 117,
      vfx_flags now 86; snow 186 · ice 85 · volcano 147 · volcano-shader 103)
- [x] `lint-url-flags` exit 0 (468 flags); quality-presets.md rows present
- [x] Append wave-2 items to Eye-test queue below
- [x] Write HANDOFF-terrain-vfx-wave2-2026-08-01.md, commit, push
- [ ] If session budget remains: launch Wave 3 (3A SWAMP ‖ 3B DIRT) same recipe
      (3B depends 1A only; 3A depends wave 0; no terrain-fragment overlap
      between them per plan — but 3B wetness may touch the fragment shader:
      same water-suite duty)

## Eye-test queue (owner-run 1070 batch — append only, never execute here)

Carried from wave 1 (`HANDOFF-terrain-vfx-wave1-2026-07-31.md` §5): W1 water
sheen · W2 code 22 · G1 grass (incl. visibleBlades>0 revive reading) · S1 sand.
- [ ] N1–N10 SNOW/ICE (sparkle motion/POM/mid · spindrift slope/weather/vs-sand
      · prints scallop test = the no-second-RT adjudication · ice read ·
      refraction ghosting · off-path boots) — full text in wave-2 handoff §4 /
      2A report
- [ ] V1–V7 VOLCANO (haze motion/depth-gate/leaves-region · crack-glow breathe
      + no POM slide · embers stable + light count · obsidian glass ·
      mid coherence · off boots) — full text in wave-2 handoff §4 / 2B report

## Known pre-existing failures (do NOT chase)

quality_preset 30/2 (`pom` pair) · `test_terrain_visual_z.mjs` (removed export)
· rust `corner_ring`. The 8 `--strict` undocumented url-flag readers.
