# Phase 3 particle/aura — 1070 eye-test frames (2026-06-24)

Real **GTX 1070** (ANGLE / D3D11 / NVIDIA), Holtburg, `<test-account>`, the Visual-Behavior
Suite shipped DEFAULT-ON (master `f3942a95`). Captured headless via
`phase3-1070b.mjs`; recipe: `~/from-vm/phase3-workflow-2026-06-24/PHASE3-EYETEST-RECIPE.md`.

| Frame | What |
|---|---|
| `01-holtburg-lifestone-rain-1070.png` | Spawn at the Holtburg **Life Stone** (the gemSparkle worked-ref, blue crystal) in active **rain** — the live weather system that the breath-fog/foliage gates read. |
| `02-holtburg-lifestone-clear-1070.png` | Same spot, weather forced **clear** (`window.__setWeather`) so additive effects aren't drowned. |
| `03-pine-forest-foliage-target-1070.png` | The dense Holtburg pine forest — the foliage (leaves/pollen) emitter targets. |

**What the run proved (data, not these wide frames):** with the suite ON, the static
particle path synthesized + drew **987 static + 8 world emitters** live in the
ParticleManager draw tables (vs a **118**-emitter retail-DAT baseline with the suite off)
— i.e. ~870 suite emitters rendering on real hardware. Individual effects are subtle at
world zoom; counts were read via the `window.__diag.particles()` bridge (commit `5e19374a`).

OPEN (not shown): a crisp single-effect close-up (needs a gem/brazier/Drudge WCID for a
centered `@create`) and a clean same-bake program-flat A/B.
