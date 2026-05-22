# Wire-agent solid-fill screenshots (2026-05-22)

Visual artifacts from the wire-agent colour-fill series this session
(commits `5cab848` + `b93a26f` + `7377d2a`). Captured headless via
`/tmp/local-wire-validate/validate-chromium.mjs` (Playwright +
Chromium+SwiftShader, `?renderer=3d&quality=low&agentic=low&wireframe=1`).

The session's cumulative boot win on this same harness:
**4395ms → 2755ms median (-1640ms, -37.3%)**.

| File | Shows |
|---|---|
| [01-holtburg-cottage-row.png](01-holtburg-cottage-row.png) | Close-up of the Holtburg cottage row at spawn. Red roofs, blue/yellow walls, green doors — per-bucket HSL fills from `MaterialCache._wireframeMaterialFor`. Crisp wireframe overlay on top via `polygonOffsetFactor=4` + `renderOrder=-1` on fills. NPC nameplates (`Fletching Forge`, `Stanleky Degreff the Bowyer`, `The Taut String`, …) visible above NPCs. |
| [02-holtburg-village-wide.png](02-holtburg-village-wide.png) | Wider village view. Terrain shows the per-vertex palette fill (grassland green in the foreground, with subtle code transitions along cell edges) plus the dark-green wireframe overlay. Buildings carry the same red/blue/yellow per-bucket fills as #1. |

Both screenshots are from Chromium+SwiftShader headless — no real GPU,
no anti-aliasing. On real hardware (e.g. the 1070 Ti) the wireframe
lines look noticeably crisper.

The terrain palette is hand-tuned per terrain code 0..31; see
`apps/holtburger-web/scene3d/terrain.js::TERRAIN_CODE_TO_RGB`. The
building / static / cell / entity fill colours come from the 32-bucket
HSL hash of surface DID (same hue as the wire material, S=0.45 L=0.32).
