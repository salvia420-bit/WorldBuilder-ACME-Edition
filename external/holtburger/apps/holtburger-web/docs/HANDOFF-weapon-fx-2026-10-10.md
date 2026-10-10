# Handoff — per-weapon effects (`?weaponFx`), 2026-10-10

Owner report: *"I can see the weapons bending (more like gyrating or shaking) …
all the weapons seem white, and I haven't really seen the full effects."*

## 1. What was wrong (all three confirmed)

A held or dropped weapon used the statics' visual-suite SET on SHARED
materials: catalog `tip-flex` ⇒ `deformation.tipFlex` + `emissive.glint`,
`rigid-glint` ⇒ `emissive.glint` + `weathering.tarnish`, plus
`emissive.itemAura` for any UiEffects bit.

1. **Shaking.** Every per-object variation came from the per-instance hash
   `vfxHash01(modelMatrix[3].xy)`, the mesh's WORLD position. That is right for
   a static placement. On a held weapon it is re-rolled every frame, so:
   - tipFlex's ±1.5° sine jumped to a random point of its cycle every frame;
   - glint's highlight jumped to random facets;
   - tarnish's patina amount strobed.

   tipFlex also ran on daggers, swords and maces: the catalog's "tip-flex" means
   any weapon with aspect > 3. Its shaft frame (axis / grip / length) was never
   wired either, so it pivoted at the model origin with a 1 m placeholder length.
2. **White.** itemAura added a flat `tint × 0.5`, and glint a 0.4 sparkle, in
   DISPLAY units. The composer applies 5× exposure before the tone curve.
   Measured on the GPU test (`test_weapon_fx_gpu.cjs`, Neutral at exposure 5,
   bare blade = (95,95,100)):
   - a Slash / Pierce / Bludgeon item rendered **(246,246,252), 100 % white
     pixels**;
   - a Magical item (most loot) rendered (209,198,252), pale lavender.
3. **Too bright in shade.** `Material.clone()` drops `onBeforeCompile` but keeps
   the userData flags. Every VFX clone therefore lost the CSM patch: its
   0.45–1.0 shade multiplier applies to entity materials whether or not they
   receive shadows. A clone stayed fully lit in shade, up to 2.2× its wielder,
   while its program key still claimed CSM.

## 2. What it is now

`scene3d/vfx/weapon_fx.js` (+ `weapon_class.js`, `weapon_fx_glsl.js`,
`components/weaponFlex.js`, `components/weaponAura.js`).

- **Who.** A weapon-ish entity gets its OWN materials: a catalog weapon
  archetype, a weapon name, or a UiEffects glow bit. Projectiles are skipped.
  - The materials come from `MaterialCache.makeOwnedVariant`: entity-owned and
    freed with the rig. Lost-patch flags are stripped, and CSM (and the light
    clamp) re-installed when the base had them.
  - Uniforms are bound by reference from that weapon's bundle, so every weapon
    has its own phase, glow and bend. There is still one program per component
    SET; the GPU test shows a second weapon adds 0 programs.
- **Bend (`weaponFlex`).** Held poles only: spear, staff, polearm by name, or
  an unknown name ≥ 1.3 m long and ≤ 12 % thick. Never swords, daggers, maces,
  axes, bows or casters.
  - Each shaft end has a spring: a virtual tip chases the real end, damped
    against the end's own velocity.
  - At rest the shaft is straight. At a run it sways ~0.5°. At the end of a
    swing it whips (≈ 5° in the test's fast swing) and rings down at ~2–3 Hz
    (soft cap 7.4°).
  - The vertex stage turns each side about the grip on a cantilever profile,
    and normals follow. Spear butts bend too: an S shape under rotation, a C
    shape under translation.
- **Glow (`weaponAura`).** Driven by the UiEffects bit (else an element word in
  the name). Held, it sits on the blade side of the grip. All values pass
  through `gain / exposure`. Measured under Neutral, added light on a test
  blade:

  | Element | Look | Added light (R,G,B) |
  |---|---|---|
  | fire | blade glows red-hot, flames lick toward the tip, flicker | (147,80,28) |
  | frost | frost coat, cold breathing rim, ice glitter | (25,39,47) |
  | lightning | arcs re-struck ~15×/s; peak pixels 239 | (51,59,69) |
  | acid | green sheen, blobs creeping to the grip | (43,76,20) |
  | nether | steel blackens under smoke, violet rim | (15,−8,26) |
  | magic | Magical, poison, boosts: a gentle rim pulse in the item's colour | (26,20,37) |

  - Slash, Pierce and Bludgeon get no glow: retail only recolours the icon
    outline for them.
  - A swing flares the glow ×1.6, decaying over ~0.45 s.
- **Shine.** A warm band sweeps up the steel every ~5–11 s while held (7–16 s
  on the ground) and on every swing. It is masked to bright, desaturated texels,
  so grips stay dark.
- **Swing trails (`?swingTrails=all`, default).** These need `fxMotion`
  (mid / high / ultra).
  - Elemental weapons trail in their colour: UiEffects bit first, then the
    name, then the weapon's light colour.
  - Magical weapons trail a faint violet; every other blade a faint steel
    streak.
  - `=elemental` gives the first tier-2 rule.
- **Robustness.** Each frame the tick mirrors base-material changes onto the
  clones: a late texture, a re-installed cache base (the grey-fallback spawn
  race), a recolour heal or an appearance swap. The clone-on-write getter hands
  out the weapon's own material, so fades and luminous hooks keep the effects.

`?weaponFx=off` restores the previous entity path exactly (useful for the A/B).

## 3. Vistest checklist (owner-run)

URL: your usual one plus `?nosw=1`. Use `quality` mid or higher for the swing
trails. Spawn test items with the GM `@create` command. All of these are
verified in the live `ace_world`:

| wcid | Item | UiEffects | Expect |
|---|---|---|---|
| 348 | Spear | 0 | bend + shine, no glow |
| 338 | Quarter Staff | 0 | bend + shine |
| 3875 | Flaming Spear | Fire | fire glow, bend, orange trail |
| 3876 | Frost Spear | Frost | frost coat + glitter, cyan trail |
| 3874 | Lightning Spear | Lightning | crawling arcs, jagged trail |
| 3873 | Acid Spear | Acid | green blobs, green trail |
| 7574 | Ravenous Spear | Magical | soft violet rim pulse, faint violet trail |
| 41244 | Gearknight Greatsword | Slash | **no white wash**, shine only, steel trail, never bends |
| 3780 | Flaming Dagger | Fire | fire glow, never bends |
| 1435 | Ice Tachi | Frost | frost look on a blade |

What to look for:

1. **Standing still, idle.** A held spear does NOT shake or wobble. The old
   path jittered here; `?weaponFx=off` shows it.
2. **Running.** A spear or staff tip sways gently with the run. Swords stay
   rigid.
3. **Swinging.**
   - A spear or staff whips at the end of the swing and settles in about a
     second.
   - The glow flares.
   - A shine runs up the blade.
   - A trail follows the swing.
4. **Colours.** No weapon reads white. Magical loot shows only a subtle violet
   edge. Elemental weapons are obviously their element.
5. **Shade.** Stand in a building's shadow: the weapon darkens with its
   wielder instead of staying lit.
6. **On the ground.** Dropped weapons glint every ~10 s. Glows show, with no
   bend.
7. **Every look on one weapon.** In the console, run `__weaponFx.force("fire")`
   and then `"frost"`, `"lightning"`, `"acid"`, `"nether"`, `"magic"`.
   `__weaponFx.force(null)` restores. `__weaponFx.shine()` fires a sweep now.
   `__weaponFx.list()` shows each weapon's frame and live bend in degrees.
8. **Tuning, if a look is too strong or weak.**
   - Glow: `__weaponFx.auraGain = 1.5`, pinnable with `?weaponAuraGain=1.5`.
   - Bend: `flexGain`.
   - Shine: `shineGain`.

   Tell me the numbers and I'll bake them in.
9. **A/B.** `?weaponFx=off` (old path), `?weaponFlex=off`, `?weaponAura=off`,
   `?weaponShine=off`, `?swingTrails=elemental|off`.

## 4. Tests

- `test_weapon_fx.mjs` (in the JS gate): 128 checks.
  - Glow table; pole classification.
  - Shaft frame against the real atlan-spear bounds (GfxObj 0x01001A7D,
    z −0.558…1.526, grip 0.3925).
  - Spring: rest, steady motion, overshoot, ring-down, teleport, hitch, 30 vs
    144 fps.
  - Bend sign; the patch surgery on three's real ShaderLib sources;
    `makeOwnedVariant` flags + CSM + program key.
  - A simulated held swing through the real tick; base sync, adopt and forget;
    swing-trail looks.
- `test_weapon_fx_gpu.cjs` (SwiftShader, heavy: `capped-build node
  test_weapon_fx_gpu.cjs`): 25 checks × {Neutral, AgX}.
  - The programs compile, including with CSM.
  - Nothing active ⇒ pixel-identical to the bare base.
  - The old Slash aura whitens; each new element adds light in its own colour.
  - The bend moves the tip 5.5 px with the grip fixed.
  - Two weapons keep their own glows, with no extra program.
  - The shine band works.
- Full JS gate (capped): 511 / 515. The 4 failures were all one pin class —
  `test_terrain_{dirt,rock,swamp,volcano}.mjs` assert the suite's DEFAULT-ON
  count is 14. Those pins were moved to 16 and each test re-run green (242 /
  237 / 204 / 151 passed, 0 failed).
- Updated pins:
  - `test_vfx_flags.mjs` and the terrain dirt / rock / swamp / volcano tests
    (+ the snow comment): DEFAULT-ON count 14 → 16.
  - `test_particle_fx_tier2.mjs`: case 7, plain blades now trail by default;
    `=elemental` keeps the old rule.
  - `harness/test_build_shell.mjs`: 367 → 372 preloads, generator re-run.

## 5. Known limits / follow-ups

- **Statics and trees.** `getCachedVariant` (the shared VFX variants) has the
  same `clone()`-drops-CSM gap. Every swaying tree (`windSwayGpu`) and every
  glint/tarnish static is fully lit in CSM shade.
  - `makeOwnedVariant` shows the fix: strip the flags and re-install CSM.
  - Applying it to `getCachedVariant` changes how all those trees look in
    shade, so it wants its own eye test. Not done here.
- `_reseatVariantsForDid` still skips `vfxVariants`: a statics VFX variant
  minted from the grey fallback stays grey. The weapon path has its own rebase.
- The shadow pass draws a bent pole in its rest pose (three's depth material).
  The drift is ≤ 7°.
- Multi-part weapons (4 of 744 catalog setups) get a whole-item glow, with no
  bend and no shine.
- `tipFlex` / `glint` / `tarnish` / `itemAura` are unchanged. They still serve
  statics and `?weaponFx=off`; their world-position hash is correct for statics.
