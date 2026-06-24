# Item magic-effect visuals (UiEffects + the 3D weapon flame) — feature scope (2026-06-24)

Scoping doc produced from the Burning Sands Katar (WCID 44265) investigation. **Read the
"What the investigation actually found" section first — it corrects the initial framing.**

## TL;DR
"UiEffects" turned out to be **two different things**, and the dramatic in-hand flame is
*probably not* UiEffects:
- **Track A — `UiEffects` (PropertyInt 18):** per the acclient decomp these render as **2D
  inventory/tooltip ICON overlays** (`*_UIEffectImage`), e.g. `FIRE_UIEffectImage=6`. NOT a 3D
  world effect. The client has **zero** UiEffects handling today.
- **Track B — the 3D wielded-weapon flame** (the reference image): the katar weenie carries **no**
  particle/PhysicsScript flame and no 3D-effect property other than `UI_EFFECTS=32`, so the in-world
  flame is most likely the **weapon model's emissive/luminous surface** (model `0x0200051C`, part
  `0x010002C0`) — a render-fidelity / VFX-suite matter, **not** UiEffects.

**Recommended first step before any code:** verify whether model `0x0200051C`'s surfaces are
luminous/emissive (does the blade glow in the DAT?). That single check decides whether the
"flaming weapon" is (a) a cheap render-fidelity fix (we already render the mesh; just honor its
emissive), or (b) a genuinely new effect to author.

**★ UPDATE — that check is done, and it rules emissive OUT:** model `0x0200051C` → part
`0x010002C0` → surfaces `0x0800052B / 0x0800096E / 0x080003EB` all have **luminosity = 0.0**,
translucency 0.0, diffuse 1.0 (the `0x084xxxxx` surfaces on the gfxobj are runtime SubPalette
shifts, not DAT files). So the blade is **not** emissive in the DAT. Combined with: UI_EFFECTS =
icon overlay (Track A), no particle/PhysicsScript flame (combat-only table) → **the weenie data
examined contains NO 3D-flame source.** The dramatic in-hand flame is therefore one of:
  1. **UI_EFFECT_FIRE rendered as a 3D overlay by retail** (despite the `UIEffectImage` icon naming,
     retail may also apply a 3D particle/material to wielded items per flag) — needs an acclient
     decomp dive on how `UIEffectMask` is consumed beyond the icon (not found in the quick grep).
  2. **A fire-painted/animated blade TEXTURE** (`0x05000276` etc.) — a static "fire look" baked into
     the texture, not particles. Check the texture pixels.
  3. The reference image is from a client/build whose data differs from this LSD-Partial weenie.
**So the very first implementation task is to NAIL the 3D-flame source** (decomp dive on UIEffectMask
3D usage + inspect texture `0x05000276`) before committing to Track B's design — don't assume it's emissive.

## What the investigation actually found (confirmed)
- **Weapon mesh renders.** The earlier "no mesh" was a framing artifact — the nameplate floats
  ~2.2 m above the object, so a close-up aimed at the nameplate put the weapon below frame. Aimed
  at the rig root, the katar (4 surface meshes) is visible. (Runtime-verified on the 1070.)
- **Spawn works.** `@create 44265` via `__sessionHandle.sendChat` (phase4demo has GM) drops it on
  the ground; entity count +1, nameplate "Burning Sands Katar" in-world, 0 console errors.
- **`UI_EFFECTS_INT (18) = 32` = `UI_EFFECT_FIRE` (0x20).** Full enum (acclient.h:7550):
  Magical 0x1 · Poisoned 0x2 · BoostHealth 0x4 · BoostMana 0x8 · BoostStamina 0x10 · **Fire 0x20**
  · Lightning 0x40 · Frost 0x80 · Acid 0x100 · Bludgeon 0x200 · Slash 0x400 · Pierce 0x800 ·
  Nether 0x1000. Retail maps each to a `*_UIEffectImage` icon (acclient.txt `UIEffectIcons_GROUP_ENUM`).
- **The client has no UiEffects pipeline.** No `UiEffects`/`UI_EFFECT` handling in `scene3d/*`,
  `index.html`, the wasm `src/lib.rs`, or `holtburger-common` properties; and the entity meta does
  NOT carry `uiEffects` (keys are setup/palette/icon/mtable/physicsScriptDid/soundTable/… only).
- **The PhysicsScriptTable `0x3400002B` is the weapon's COMBAT scripts**, not the flame: PScriptTypes
  0x39–0x44/0x8E/0x8F → CreateParticle swing effects; `Create (0x58)` → script `0x33000719` is a
  `Transparent` (fade) hook, hook_type 20. The play-effect resolver only handles CreateParticle(13)/
  CreateBlockingParticle(26), so Create(0x58) hits `missNoCreateParticleHook` (verified via
  `VFX_COVERAGE.realVfxMissBreakdown` delta). This is a real-but-separate gap (the spawn fade), not the flame.

## Track A — UiEffects icon overlays (the literal "UiEffects feature")
Render the 14 effect flags as icon overlays on item tooltips/inventory (Magical/Fire/Frost/…).
- **wasm:** parse `PropertyInt.UiEffects` (18) where item props are read (`holtburger-common`
  properties + the ObjectCreate/appraise hydration in `src/lib.rs`), and expose it (an
  `entityUiEffects(guid)`-style getter or on the inventory/examine snapshot).
- **client:** map flag→`UIEffectImage` (the icon ids in acclient.txt) and composite the overlay on
  the item icon in the inventory/examine UI (NOT scene3d — this is a 2D HUD effect).
- **Scope:** small-to-medium, low-risk, no rebuild risk beyond the wasm getter. Default-OFF flag,
  byte-identical when off.

## Track B — 3D wielded-weapon flame (what the reference image shows) — VERIFY FIRST
- **Step 0 (verify):** inspect model `0x0200051C` part `0x010002C0` surfaces — are any
  Luminous/emissive (the blade glows in the DAT)? Cross-ref `[[reference_chorizite_render_semantics_2026-06-20]]`
  (luminosity = FLAT emissive (lum,lum,lum), which our client currently under-renders vs emissiveMap).
- **If the flame is model emissive:** it's a render-fidelity fix — we already render the mesh; honor
  the surface luminosity (the chorizite-semantics deviation already noted in memory). Cheap, no new
  effect; benefits ALL luminous items.
- **If the flame needs a particle/light effect:** author it via the Phase-1 VFX-suite machinery
  (emissive frag + a POOLED light — never a light-count change, the no-relink rule) keyed off the
  item, reusing `installVfxComponentPatch` / the light pool. Medium, connects to the suite.
- **Wielded vs ground:** "we can't hold weapons in hand yet" — the flame should attach to the item
  mesh whether ground or wielded; the in-hand case also depends on the wield/attach render path.

## Touchpoints (file:line, current as of this branch)
- wasm property hydration: `apps/holtburger-web/src/lib.rs` (entity property dicts / ObjectCreate
  hydration; mirror how `physicsScriptDid`/`soundTableDid` reach the meta) + `crates/holtburger-common/src/properties/world_object.rs`.
- entity meta → JS: the spawn meta builder (loop.js `toMeta` ~2039) + `scene3d/entities.js` spawn.
- model emissive (Track B): `scene3d/materials.js` surface build + the luminosity handling flagged in
  `[[reference_chorizite_render_semantics_2026-06-20]]`.
- VFX-suite reuse (Track B effect): `scene3d/vfx/` (the Phase-1 emissive components + light cap).

## Risks / notes
- Any added light = the spell-freeze relink risk — must go through the existing light pool
  (`lightCountDelta:0`), reuse flameFlicker's discipline.
- A wasm change (Track A getter / any property forwarding) needs a buildbox-or-capped-local rebuild
  (8GB laptop; `capped-build wasm-pack ...` works — verified this session).
- Investigation course-corrections (for the record): first chased `Setup.default_script` (the katar
  has none — a wasm fix was written then reverted), then the PhysicsScriptTable Create(0x58) path
  (that's the spawn fade / combat scripts), before the weenie dump (`UI_EFFECTS=32`) + the decomp
  (`UIEffectImage`) clarified UiEffects = icon overlay and the 3D flame ≈ model emissive. A hex slip
  (`33555740 = 0x0200051C`, not `0x02000ADC`) meant early DAT-side *setup* checks were on the wrong
  object; runtime probes matched by name+decimal so "mesh renders" still holds.
