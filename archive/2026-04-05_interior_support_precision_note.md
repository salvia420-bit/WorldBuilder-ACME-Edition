## 2026-04-05 Interior Support Precision Note

Relevant discovery while investigating support-aware interior placement:

- `WorldBuilder.Terminal` `export-envcell-components` already exports precise per-cell static object positions from EnvCells.
- The export includes:
  - per-cell `staticObjects` with local `x/y/z`
  - per-object world `worldX/worldY/worldZ`
  - anchor-relative `relX/relY/relZ` when a surface anchor exists
  - cell origins and cell orientations
  - component bounds
  - portal refs and visible cells
- The export implementation lives in `WorldBuilder.Terminal/CommandEngine.cs` in `BuildEnvCellComponentJson(...)`.

Why this matters:

- The current ML tensor path uses only coarse component features and does not yet consume the precise static-object geometry already available from the terminal export.
- This means support-aware interior research is not starting from zero.
- A future extractor may be able to build support-relative supervision for micro-placement without first inventing a brand new world-inspection surface.

Likely next follow-up for the terminal/program:

- If support-aware placement becomes viable, add a dedicated export or analysis surface for:
  - support-parent candidates
  - support plane / normal
  - support-relative local transforms
  - room-local coordinate frames
  - object-on-object attachment labels

