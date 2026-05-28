# Surface render-state eye-test — 2026-05-28

Visual validation of commit `5b90672e` (Surface 0x08 float-driven luminous/diffuse
+ Alpha 0x100 blend) on the GTX 1070 (Firefox 150), live ACE, Holtburg LB 0xA9B4.

- `holtburg-overhead.jpg` — oblique view across Holtburg toward the river.
- `holtburg-diagonal.jpg` — 3/4 diagonal over the cottages + scenery.

529 meshes (226 buildings + 169 terrain + 132 statics) render with surface materials
applied; no regressions (no black/blown-out surfaces). Required the terrain.js
backtick fix + local-takram vendoring in `998b1d3e` to make the scene importable in
Firefox. Captured in-page via `renderer.domElement.toDataURL` — Playwright
`/screenshot` can't read this WebGL canvas (`preserveDrawingBuffer=false`).
