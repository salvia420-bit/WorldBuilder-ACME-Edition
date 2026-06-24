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

## Update — katar IS visible (it was out of frame), flame is the real gap
- **04-katar-rig-aimed-at-root-IS-visible.png** / **05-katar-tight-closeup-weapon-present-no-flame.png** —
  camera aimed at the katar's ENTITY RIG ROOT (not its nameplate). The weapon mesh **builds + renders**
  (rig = 4 visible surface meshes, 90 verts). The earlier "no mesh" shot (#03) aimed at the nameplate,
  which floats **2.2m above** the object (nameplate y96.3 vs rig y94.1) → weapon was below frame.
- **Flame does NOT render:** `particleNodes=0` on the rig; the katar's native flame (play-effect
  `scriptId=0x58`, a PhysicsScript/particle) is `enqueued for not-yet-spawned guid` and never materializes.
  So the weapon body draws but the flame particle effect isn't rendered by the client.
