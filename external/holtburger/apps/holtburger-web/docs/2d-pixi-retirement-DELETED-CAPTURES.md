# 2D-PIXI retirement — deleted capture scripts (item 9a, 2026-06-18)

These 16 `capture_*.cjs` diagnostic scripts were **deleted** (not moved) on the
`2d-pixi-retirement` branch. All are 2D-only: they drive the retired PIXI render
path (`renderNeighbourhood`, `window.liveScene`, `entry.sprite`, `window.buildingMap`,
`entry.portalSwirl`/`portalChip`) and therefore **cannot run post-8a** (pixi.js
removed; `liveScene` is permanently null under the default `renderer=3d`).

Recoverable from git history (`git show <commit>^:<path>`). None were wired into
any harness runner (`harness/run-all.mjs` / `run-js-headless.mjs` / `playwright/`
reference zero of them — verified), so deletion does not affect the test gate.

## Redundant with a 3D-native sibling (coverage preserved)
| Deleted (2D) | Superseded by (3D-native) | Coverage |
|---|---|---|
| `capture_phase4_step3.cjs` | `capture_3d_movement_e2e.cjs` | local-player movement wire round-trip (real keydown → setMovementInput → ACE echo → position delta) under `?renderer=3d` |
| `capture_phase6_step_a_geometry.cjs` | `capture_phase7_2_buildings.cjs` | building geometry rendered (`liveScene3d.buildingsGroup.children >= 16`) |
| `capture_phase6_step_c_envcells.cjs` | `capture_phase7_3_envcells.cjs` + `capture_academy_envcells.cjs` | EnvCell interior geometry in 3D |

## Pure-dead 2D scripts (no 3D port; covered elsewhere or obsolete)
- `capture_step6.cjs` — injected spawns into `window.handleEntitySpawn` after the 2D `renderNeighbourhood` pass (both retired → legacy/).
- `capture_step6_player.cjs`, `capture_step6_monster.cjs`, `capture_step6_monster_walking.cjs`, `capture_step6_blacksmith.cjs` — 2D sprite-render visual probes (`entry.sprite`); 3D entity rendering is covered by `capture_phase7_4_entities.cjs` / `capture_academy_entities.cjs`.
- `capture_phase6_step_b_collision.cjs` — asserted the player **sprite** stopped at a wall; 3D collision is in the live movement/physics path (`capture_3d_movement_e2e.cjs`).
- `capture_phase6_step_d_floors.cjs`, `capture_phase6_step_f_dungeon.cjs` — 2D EnvCell floor/dungeon visuals; 3D EnvCells covered by the phase7_3 / academy envcell captures.
- `capture_phase4_step2b.cjs` — screenshotted the 2D PIXI canvas with rendered sprites.
- `capture_phase4_step5.cjs` — `useObject` on the first interactable found in `window.entityMap` (empty in 3D; the 3D entity map lives in the scene3d EntityManager).
- `capture_phase4_step6d.cjs` — asserted `entry.portalSwirl` (2D PIXI.Graphics swirl) — **retired in 7b** (§9 ruling: per-entity 2D swirl dropped; 3D uses the global `portal_space.js` donut).
- `capture_phase4_step6f.cjs` — asserted `entry.portalChip` (2D `PIXI.Text` chip) — **retired in 8a** (`ensurePortalChip` stubbed PIXI-free).
- `capture_terrain_eval.cjs` — cropped/zoomed the 2D PIXI canvas for alpha-mask compositing; 3D terrain alpha-mask is covered by the `capture_visfid_*` suite.

## NOT deleted (the one genuine port)
`capture_phase6_step_e_doors.cjs` — door block→click→open→walk-through E2E has **no
3D sibling**. Blind-ported to 3D in item 9b (UNVALIDATED — needs Playwright).
