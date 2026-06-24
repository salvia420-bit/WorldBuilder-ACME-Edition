# 1070 eye-test / object-spawning screenshots — 2026-06-24

Captured headless on the GTX 1070 (real ANGLE/NVIDIA D3D11), Holtburg, quality=low, phase4demo.

- **01-holtburg-barren-render.png** — outdoor Holtburg after full bake. Scene-graph DATA says
  populated: **169 LBs baked, 47 buildings, 984 statics, 62 entities, 3527 mesh nodes** — yet the
  render shows a sparse field (player, Life Stone, poles, rain; no buildings). The barren-render to explain.
- **02-katar-spawned-nameplate-rawrender.png** — after `@create 44265` (Burning Sands Katar, WCID 44265,
  setup 0x02000ADC). Raw `canvas.toDataURL()` forced render (darker — bypasses the post composer). The
  **"Burning Sands Katar" nameplate renders in-world** (spawn succeeded, entity count +1) but no weapon mesh.
- **03-katar-closeup-nameplate-no-weaponmesh.png** — camera aimed at the katar. Its **nameplate** + the
  **Life Stone mesh** (blue crystal) render, but the **katar weapon mesh does NOT** — i.e. weapon/item
  meshes aren't drawing (ground or hand), only nameplates, while world-objects (Life Stone) do render.
