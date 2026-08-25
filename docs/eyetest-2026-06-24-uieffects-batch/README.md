# 1070 batch eye-test — UiEffects icons + itemFx aura — 2026-06-24

Real-GPU headless (GTX 1070, ANGLE/NVIDIA/D3D11), one session, all flags on
(`?uiEffectIcons=on&visual=on&itemFx=on`), `@create 44265` (Burning Sands Katar, Fire).

## Results (see uieffects-batch-report.json)
- **#13 real icons — VALIDATED.** Fire ordinal 6 → `0x06001B2E` (from DataIDMapper `0x25000009`)
  loads a real **32×32** icon via `fetch_icon_pixels`. The icon-resolution + load path works.
  (The examine-panel DATA path needs a *successful* Identify — `<test-account>`'s skill failed on the
  katar → `appraisalUiEffects:null`; a skill/content nuance, not a code bug. Inventory badges
  source `InventoryItem.uiEffects`, not the appraisal.)
- **#16 itemFx aura — PLUMBING VALIDATED, VISUAL SUBTLE.** `entityUiEffects(katar)=32` (the wasm
  index + getter work) and **all 4 katar surfaces carry the `itemAura` frag variant**
  (`materialsWithVfxKey:4`). `materialsWithEmissive:0` is expected — the glow is shader-injected
  (`totalEmissiveRadiance += tint*glow`), not `material.emissive`. **But** the orange Fire aura at
  `glow=0.5` is **not visually dominant** against the katar's blue-steel mesh (see `uieffects-aura.png`).
  → tuning question: bump `AURA_GLOW` (item_fx.js) for a clearer glow, or accept the subtle ambient.
- **R1 `?luminousEmissiveMap` — NOT RUN.** Needs DYED-LUMINOUS gear (the katar is lum=0); stage a
  dyed glowing item/NPC to A/B.

`uieffects-aura.png` = the katar framed with `?itemFx=on` (no flame this run — setupDefaultScript off).
