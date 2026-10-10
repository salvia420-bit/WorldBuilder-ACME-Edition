## Your job

You are one of 8 reviewers giving EVERY retail Asheron's Call particle emitter (0x32 ParticleEmitter
records in client_portal.dat) an individual visual upgrade in the holtburger-web three.js client.
A generator has already proposed a profile per emitter (family recipe × how the emitter moves ×
measured size/life/crowding × context). Your job, for the emitters in THIS packet:

1. **Understand each effect.** Look at the textures (open the contact sheet PNG and any thumbnail you
   need with the Read tool — you can see images). Read each emitter's motion data and context
   (PlayScript names, weenie names, setups). Work out what it is in game: "Flaming Club breath-fire
   plume", "Holtburg chimney smoke", "Lifestone glow", "RegenDown blue debuff motes", "portal swirl",
   "creature blood splatter droplets", etc. Emitters sharing a script are parts of one effect — say
   which part (core flash, trail, debris, ring...).
2. **Verify the family.** The family drives the recipe. If a texture is mis-filed (e.g. a red "solid
   ball" that is really blood droplets in a Splatter script, a "faint glow" that is really water mist,
   a star used as rain), set `family` (one of the family names below) and fix the params.
3. **Tune the params** where the generated values would look wrong for THIS emitter: too hot/bloomy for a
   dense emitter, not enough glow for a spell core, spin on a sprite whose orientation matters, flicker on
   something that should be steady, erosion on a crisp sprite, a fade that would hide a deliberately
   brief flash, softness too large for a tiny spark, etc. Most generated values are reasonable — change
   what is wrong, and use your judgement to make signature effects (portals, lifestones, hearth fires,
   spell cores, level-up) look their best.
4. **Write a note for every emitter**: one line, what it is in game + what the upgrade does to it.
   e.g. `"Flaming Club BreatheFlame plume core: white-hot flicker, cools orange→red, dissolves; soft vs ground"`.
   Notes must be specific to the emitter (its role/context/motion) — not a family boilerplate.

Be careful and concrete; nobody can eyeball the result on a GPU, so your understanding is the only
check. When the context is empty (static scenery default scripts with no weenie), infer from the
texture + motion (e.g. persistent rising grey puffs at ~2 m size = chimney/brazier smoke; persistent
still faint warm halo = lamp/torch glow).

## LAPTOP RULES (verbatim from the owner's CLAUDE.md — mandatory)

- Parallel agents may read, edit and run TARGETED single tests only
  (`node test_x.mjs`). They must NOT run the full JS gate, cargo, wasm-pack or
  browsers. The orchestrator runs the full gate and builds ONCE, after merging,
  one at a time.
- You do NOT need to run any test at all for this task. Do not start browsers, servers, builds.
- Do NOT use git (no commit, no push, no branch, no stash) and do not arm any automation.
- Write ONLY your own output file under the scratchpad `overrides/` directory. Do not edit any
  repository file and do not touch other reviewers' files.
- Python helper scripts are fine (keep them in the scratchpad), but keep memory use small
  (no loading all 2051 emitters into heavyweight structures repeatedly; no image libraries on
  big batches beyond your own textures).

## How the particles are drawn (pipeline facts you need)

- Every retail particle is a flat textured quad (usually billboarded to the camera by the DAT degrade
  mode), drawn UNLIT: `colour = texture.rgb`, `alpha = texture.a × per-particle opacity`. Retail lerps
  opacity linearly from `1-startTrans` to `1-finalTrans` over the particle's life, and lerps scale
  start→final. The particle is killed at the end of its lifespan regardless of its opacity — so an
  emitter with `finalTrans` well below 1 POPS OUT of existence; with `startTrans` near 0 it POPS IN.
- **Additive** sprites (surface type 0x10000) blend `dst += rgb × alpha` (black = invisible); they are
  unfogged (retail). **Alpha** sprites blend normally with alphaTest 0.1 and depth write.
- Particles are drawn into an HDR (half-float, linear) buffer AFTER clouds/aerial perspective and BEFORE
  bloom + Neutral tone mapping. **Bloom engages on pixels whose luminance exceeds 1.1** (mip-blur
  bloom, intensity 0.55). So `gain` that pushes an additive sprite's bright texels past ~1.1 makes it
  glow with a halo; overlapping additive particles add up, so dense emitters reach bloom with less gain.
  Tone mapping compresses highlights, so a little over 1 is fine; huge values (≥4 after stacking) look
  blown-out white.
- Sprite textures are low-res (32–128 px) and sRGB-decoded to linear; texel luminance values in the
  tables (lum95) are 0..1 linear-ish proxies of the texture brightness.
- **Exposure (added after the 2026-10-09 review, from the offline preview):** the composer multiplies
  the whole HDR frame by `toneMappingExposure = 5` before the Neutral curve. Unlit particles were never
  calibrated for that, so `?particleFx` now applies a display calibration first: alpha sprites ×1/5
  (retail LDR colours; before it, "dark" smoke drew white), additive sprites ×K/5 with K = 2.0 (keeps
  saturated colours from bleaching; stops dense bursts flooding the frame with bloom). `gain`/`core`
  multiply on top of that, so an additive `gain` of 1.5 lands at 0.6× the old on-screen brightness
  but with a hotter core. Erosion thresholds perceptual energy (√linear), so `erode` 0.3 removes
  texels dimmer than ~30% perceived brightness by the end of life. Render
  `tools/particle-fx/preview.cjs` to see a change before shipping it.
- The upgrade shader runs once per fragment and is shared by all particles; each emitter's params live in
  a table row, so every emitter can be different at no draw-call cost.

## The params (what each one does on screen)

All optional; omitted = neutral (exactly the retail look). Safe ranges in brackets — stay inside them.

| key | effect | range |
|---|---|---|
| `gain` | multiplies rgb. Additive: >1 brightens and (past ~1.1 luminance) blooms. Alpha: lightens the sprite. | 0.6–2.4 |
| `core` | extra multiplier on the texel's brightest parts only (`rgb *= 1 + core·smoothstep(0.45,1,maxRGB)`) — a white-hot centre without brightening the halo. Additive only. | 0–1.3 |
| `sat` | saturation (0 grey, 1 as authored, >1 richer). | 0.4–1.4 |
| `tint0`, `tint1` | rgb multipliers at birth and at death; blended by `age^tintCurve`. Fire cools (birth warm-white, death deep orange-red); smoke lightens/greys as it rises; magic deepens to its hue. Keep each channel 0.4–1.4. | per channel 0.4–1.4 |
| `tintCurve` | exponent on age for the tint ramp (<1 = changes early, >1 = changes late). | 0.4–3 |
| `fadeIn` | fraction of life over which alpha ramps 0→1 (smoothstep). Removes pop-in. Keep tiny (≤0.04) for bursts/flashes that must hit instantly; 0 when retail already fades in (`startTrans`≥0.85). | 0–0.35 |
| `fadeOut` | fraction of life over which alpha ramps 1→0 at the end. Removes pop-out. Small (≤0.06) when retail already fades out (`finalTrans`≥0.92) — otherwise the particle would vanish early. | 0–0.6 |
| `erode` | dissolve over life: texels whose energy (additive: max(rgb)·a, alpha: a) is below `erode·age^1.5` vanish (soft edge). Dim edges eat away first → smoke/fire wisps away instead of fading as a flat card. 0 for crisp sprites (stars, runes, insects, debris, solid balls). | 0–0.6 |
| `flicker` | smooth value-noise brightness wobble ±`flicker`, at `flickerHz` (per-particle random phase). Fire 0.12–0.25 @ 8–12 Hz; electricity 0.3–0.5 @ 14–20 Hz; magic glow 0–0.08. | 0–0.5 |
| `flickerHz` | speed for flicker; twinkle runs at 0.7× this. | 0.5–24 |
| `twinkle` | sharp sparkle glints (brief peaks up to ×(1+2.5·twinkle)) at random per-particle phase. Stars, gem/level-up sparkles, swarm motes, bubbles' glints. | 0–0.45 |
| `spin` | rotates the texture about the quad centre: total turns over ONE particle's life (each particle gets a random direction and 0.6–1.4× rate). Breaks the "same card" look of smoke/fire puffs, makes vortices turn, snowflakes/leaves/debris tumble. **Only for sprites that read fine rotated** (radially-ish symmetric, energy not in the corners — see `radial`/`edge` columns: edge must be < 0.16) **and full UVs**. Never for flame tongues, lightning, runes, insects, beams, streaks, full-frame swirl stripes (`swirl_tex`). | 0–1.6 |
| `wobble` | UV turbulence amplitude (sinusoidal, time-animated): flames lick, heat/water shimmer. 0.01–0.035 for flames, ≤0.012 for water/swirls, else 0. | 0–0.04 |
| `soft` | soft-particle distance in metres: alpha fades where the quad is within `soft` m in front of the scene depth — no hard line where smoke/fire/glow quads cut into the ground/walls. Scale with sprite size S (≈0.3–0.6·S); tiny sparks 0.03–0.1; big smoke 0.5–2. | 0–2.5 |
| `nearFade` | fade the particle out when it is within this many metres of the camera (start fading at 35% of it) — stops giant screen-filling quads when the camera passes through smoke/fog. ≈1·S for big soft sprites, small/0 for sparks. | 0–3 |
| `lit` | 0..1 how much the sprite follows scene light (day 1.0 → moonlit night ≈(0.30,0.34,0.45) → indoor ≈0.62). For NON-emissive matter (smoke, dust, water, leaves, insects, blood, debris, snow). 0 for anything that emits light (fire, magic, glows, lightning). | 0–1 |
| `pulse` | smooth sinusoidal breathing ±`pulse` at `pulseHz` (random phase per particle). Auras, runes, portals, lifestones. | 0–0.15 |
| `pulseHz` | breathing rate. | 0.2–4 |

Families available for `family`: fire, flame_tongue, mist_fire, smoke_dark, smoke_light, smoke_add,
mist_white, gas_alpha, mist_magic, dust, dark_burst, star, star_dark, glow_orb, glow_point, faint_glow,
lightning, tendril, vortex, vortex_dark, swirl_tex, ring_soft, ring_line, rune, streak, beam, specks, snow,
bubbles, liquid, blood, blood_mist, splash, water_sheet, water_streak, debris, leaves, insect, solid_ball,
solid_shard, solid_disc, misc, none, sky. (Changing `family` only relabels the catalog; the shader reads
the params — so when you re-family an emitter, give it the params that family should have.)

## Output schema (JSON)

```json
{
  "group": "<packet id>",
  "familyNotes": {"<surface 0x...>": "what this texture is and how its family should look (1–2 lines)"},
  "emitters": {
    "0x3200026E": {
      "note": "Flaming Club BreatheFlame plume core: white-hot flicker, cools orange→red, dissolves; soft vs ground",
      "params": {"flicker": 0.2},
      "family": "fire"
    }
  }
}
```

- `emitters` must contain EVERY emitter in your packet (key = the did exactly as written, uppercase hex
  after 0x). `note` is required; `params` holds only the keys you change (full value, not a delta;
  tints as `[r,g,b]`); `family` only when you re-file it.
- Valid JSON only (no comments, no trailing commas). Write it with a Python script if that is easier,
  then re-open it to check it parses and that every packet did is present.
- Finish with a short summary in your final message: what the effects in your group are, which
  emitters you re-filed or tuned materially and why, anything suspicious you could not resolve.
