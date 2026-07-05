# Cave of the Escaped Thief — terrain covering the entrance

Repro captures for the "outdoor terrain covers a dungeon/cave entrance" bug,
taken headless (SwiftShader) at the **Cave of the Escaped Thief**, landblock
`0x40D8` (71.1N, 50.2W), outdoor cell `0x40D8002C`, terrain height ≈ 4 m.

These are **geometry/occlusion** captures, not pixel fidelity — SwiftShader is
fine for that. Direct `renderer.render()` is used (the atmosphere composer only
renders correctly inside its live rAF loop, so the punch-ON result can't be
captured headless — see notes below).

| file | what it shows |
|---|---|
| `00-reference-working-retail.jpg` | Retail/reference: you see **down into the cave** through the stone entrance. |
| `01-bug-wireframe-topdown.png` | Wireframe top-down: terrain (retail split-diagonal grid) **fills the entrance ring**. |
| `02-bug-normal-topdown.png` | Normal materials, top-down: green grass **covers the ring hole** — the bug. |
| `03-terrain-hidden-topdown.png` | Same view, terrain hidden: the ring's centre reads dark (see note). |
| `04-terrain-hidden-angled.png` | Angled, terrain hidden: entrance ring + scenery; no clearly-lit interior. |

## Mechanism (measured, not inferred)

- The bug is **not** a depth-encoding regression — terrain and cells both write
  matching logarithmic `gl_FragDepth` (verified via compiled-shader inspection).
- At the entrance: **2 portal apertures are detected** (`getVisiblePortalApertures`,
  MVP folded through `worldRoot`), the camera classifies **outdoor**
  (`isCurrentCellIndoor() === false`), and with `?portalPunch=on` the punch pass
  **arms correctly** (`hasApertures`, world/cells split active, cells pass enabled).
- The only default blocker is that `?portalPunch` ships **default-off**, so nothing
  punches the terrain lid inside the detected apertures.
- `119` cell meshes sit within 30 m of the entrance, so the interior data is
  loaded — but the terrain-hidden captures (`03`, `04`) don't show a clearly-lit
  cave in the ring. That's ambiguous headless: the below-grade interior renders
  ~black without the composer's cell lighting, so it can't be distinguished from
  empty background in a direct render.

## Open confirmation

The decisive check — does arming the punch reveal the **lit** cave — needs the
real render loop (composer + lighting), i.e. an in-app `?portalPunch=on&nosw=1`
eyeball at the entrance. The headless rig proves the bug and that the punch arms;
it can't render the punch-ON frame.

Retail ground truth: `PView::DrawCells` (terrain → depth-clear gated on
`portalsDrawnCount` → portal-clipped cells), `PView::GetClip` (screen-space
portal-poly clip), `D3DPolyRender::DrawPortalPolyInternal` (the depth punch).
Contingency runbook: `external/holtburger/apps/holtburger-web/docs/incasefloatingartifact.md`.
