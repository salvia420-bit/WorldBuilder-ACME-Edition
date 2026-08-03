// Phase X.1 — Quality preset system.
//
// Single user-facing knob (`?quality=low|mid|high|ultra`) controlling
// every visual-fidelity toggle in the renderer. Individual features
// retain per-feature URL overrides (e.g. `?quality=mid&pom=on`) for
// A/B testing during development.
//
// Source of truth for the preset table is `docs/quality-presets.md`.
// If you change the table here, update the doc and vice versa.
//
// Consumed at scene init by `scene3d/index.js`. Each phase that gates
// on quality reads its flag from `liveScene3d.quality` directly; this
// module does not import from any renderer subsystem so it can be
// loaded in isolation (Node test harness, devtools console).

// ── TERRAIN-VFX PROMOTION SWITCHBOARD (2026-08-01) ─────────────────────────
//
// The nine terrain-VFX FAMILY MASTERS ship OFF on every tier (plan §5.9 "ship
// OFF, promote deliberately"), and each one is promoted only after the owner
// eye-tests it on the 1070. Before this switchboard that promotion was FOUR
// edits per family (one per tier) with the intended ladder living only in
// docs/url-flags.md prose — and `terrainIce` showed what that costs: it was
// false on every tier while `ultra.terrainIceRefraction` said `true`, i.e. the
// tier's stated intent was DEAD CONFIG that no tier could reach.
//
// So the two halves are separated. `TERRAIN_VFX_TIERS` is the LADDER — the
// tier-by-tier intent each family will run at, written down and testable now.
// `TERRAIN_VFX_PROMOTED` is the GATE — one boolean per family, all false, and
// flipping ONE of them to `true` is the whole promotion. Nothing else moves:
// the sub-effect keys below (`terrainGrassStomp`, `terrainSnowPrints`,
// `terrainIceRefraction`, …) already carry their own per-tier intent and
// compose with the master at every reader, so they become live exactly where
// the ladder says and stay dead everywhere else.
//
// ⚠ These are the SHIPPED defaults. Flipping one is a ship-visible change and
// needs the owner's approval — `?terrainGrass=on` etc. is the way to eye-test
// without touching this table.
export const TERRAIN_VFX_PROMOTED = Object.freeze({
    trail: false,
    grass: false,
    sand: false,
    snow: false,
    // USER 1070 SIGN-OFF 2026-08-01 (in-person vistest): ice ships.
    ice: true,
    volcano: false,
    swamp: false,
    dirt: false,
    rock: false,
});

// The per-family ladder, from each flag's docs/url-flags.md promotion target
// ("Promotion target `PRESETS.{high,ultra}.X = true`"). `low` and `mid` also
// ship 0 counts for most families, so a promoted master renders nothing there
// even if a tier is later added to this table.
export const TERRAIN_VFX_TIERS = Object.freeze({
    low: false, mid: false, high: true, ultra: true,
});

/** The shipped value of one family master at one tier: the ladder, GATED. */
export function terrainMaster(family, tier) {
    return TERRAIN_VFX_PROMOTED[family] === true && TERRAIN_VFX_TIERS[tier] === true;
}

// Preset table. Keys are the four supported quality tiers; values are
// flat boolean/number bags consumed by per-phase gating code. Adding a
// new feature flag means: (a) add it here with sensible defaults
// across all four tiers, (b) document it in `docs/quality-presets.md`,
// (c) read it from `liveScene3d.quality[<flag>]` at the phase's gate.
export const PRESETS = {
    low: {
        antialias: false,
        // `shadows` preset keys removed 2026-08-01 (perf-synthesis §4 dead
        // config): nothing ever read `flags.shadows` — plain shadow maps are
        // the independent `?shadows=on` opt-in (index.js `shadowsEnabled`)
        // and real shadows at high tiers are the `csm` flag below. The
        // Phase 0.1 "collapse into quality.flags.shadows" follow-on never
        // happened; wiring it now would silently default shadow maps ON at
        // mid+ — a deliberate NON-change without a 1070 measurement.
        // Wave 2.B (2026-05-28): procedural normal maps off on `low`.
        // Saves +texture memory and sampler bandwidth on integrated /
        // mobile GPUs where the Sobel-derived bumps don't visibly beat
        // 2026-07-30: flipped ON. Measured on a GTX 1070 at Dryreach,
        // quality=mid, 400 frames/arm — normal maps + statNra + texBc7 together
        // ran 35.2 ms median / 28.4 fps against 36.7 / 27.2 for the bare
        // default, i.e. no cost to pay for. `?normalMaps=off` is the escape.
        normalMaps: true,
        detailFlag: false,
        terrainDetailNormal: false,
        triplanar: false,
        triplanarSlopeThresholdPct: 100,
        // Anisotropic texture filtering cap (1 = isotropic / off). Driven into
        // setAdapterMaxAnisotropy at scene init and capped by the GPU max. Kept
        // OFF on `low` for integrated/mobile/swiftshader perf-worker GPUs.
        anisotropy: 1,
        subdivLevel: 1,
        // Geometry relief (gfx_remodel.rs OP1 — texture-blind convex-edge
        // rails) — see docs/url-flags.md `gfxRelief`.
        // DEFAULT-ON since 2026-07-30 after the 1070 eye-test: chamfer caps on
        // hard convex edges give AC's razor-sharp building corners a lit
        // transition band, so beams read as having thickness instead of being
        // painted on. `?gfxRelief=off` is the escape (the resolver in
        // scene3d/gfx_relief.js matches "on"/"off" EXACTLY and falls through to
        // this preset otherwise; it stays out of BOOL_FLAGS so parseBool cannot
        // widen it to "1"/"true"/"yes").
        // The operation is PURELY ADDITIVE — no existing vertex moves, no draw
        // call is added (rails inherit their parent's surface subset), and the
        // model gate leaves ~87% of GfxObjs byte-identical.
        // `low`: still off — added tris are paid TWICE at any tier with shadows
        // and low is the tier that exists to not pay.
        //
        // gfxSubdivLevel is 0 on EVERY tier: the rails do not subdivide, and
        // per-texel displacement measured 0.211 mean-abs against undisplaced on
        // the 1070 (a ~1 cm joint cannot exist on a ~15 cm vertex grid). Raise
        // it explicitly with ?gfxSubdivLevel=N to experiment.
        gfxRelief: false,
        gfxSubdivLevel: 0,
        gfxReliefScale: 0.6,
        pom: false,
        pomStepsPrimary: 0,
        pomStepsSelfShadow: 0,
        // statPom — the ATLAS-side parallax (static_atlas.js): marches the
        // per-surface seam-height field packed into the nra alpha channel.
        // `low` exists to not pay per-fragment dependent-fetch loops.
        statPom: false,
        csm: false,
        bloom: false,
        vignette: false,
        lensFlare: false,
        lightShafts: false,
        // Terrain VFX (Wave 0B, docs/2026-07-31-terrain-vfx-plan.md §2.2/§5.8).
        // `terrainTrail` = the shared stomp/footprint render-target trail map.
        // SHIPS FALSE ON EVERY TIER (§5.9 "ship OFF, promote deliberately");
        // the ladder that will be flipped on at promotion is high/ultra true,
        // low/mid false. Deliberately NOT in BOOL_FLAGS — `parseBool` also
        // accepts `1`/`true`/`yes`, which would widen the exact-`on` opt-in its
        // decisive reader (`scene3d/vfx_flags.js::terrainTrailEnabled`)
        // requires. The three NUMERIC knobs below are safe here (they cannot
        // turn the feature on by themselves) so the Graphics-settings bag can
        // carry them; the readers clamp whatever they get, from either source.
        // Terrain VFX — GRASS (Wave 1A, plan §3.1). `terrainGrass` is the
        // master and, like `terrainTrail`/`gfxRelief`, is deliberately NOT in
        // BOOL_FLAGS (parseBool would widen its exact-`on` opt-in). It ships
        // FALSE on every tier (§5.9); the promotion target is high/ultra true.
        // `terrainGrassBlades` is THE degrade lever: grass is vertex-bound, so
        // render scale buys it nothing (§3.1) — 0 here means the `low` tier is
        // disabled outright, which is the §5.8 contract for every effect in
        // this plan. Counts are perfect squares (the scatter pool rounds up).
        terrainGrass: terrainMaster("grass", "low"),
        terrainGrassBlades: 0,
        terrainGrassRadius: 32,
        terrainGrassStomp: false,
        terrainTrail: terrainMaster("trail", "low"),
        terrainTrailRes: 128,
        terrainTrailRadius: 32,
        terrainTrailFade: 4,
        // Terrain SAND/DESERT (Wave 1B, plan §3.2). `terrainSand` is the FAMILY
        // MASTER and ships false on every tier (§5.9); `low` is additionally
        // `null` in the plan's tier table — every sand knob here is 0/false, so
        // even `?terrainSand=on` at low renders nothing. Like `terrainTrail`,
        // the two BOOLEANS are deliberately NOT in BOOL_FLAGS (parseBool would
        // widen the exact-`on` opt-in their readers require); the three NUMERIC
        // knobs are safe in INT/FLOAT_FLAGS — they cannot turn the family on.
        terrainSand: terrainMaster("sand", "low"),
        terrainSandStreamerCount: 0,
        terrainSandDevilCount: 0,
        terrainSandSparkle: false,
        terrainSandRadius: 32,
        // Terrain SNOW/ICE (Wave 2A, plan §3.4). TWO masters — `terrainSnow`
        // (spindrift + sparkle + prints) and `terrainIce` (the codes-2/27
        // material treatment) — because one is particles+shader and the other
        // is a material change, and bisecting them separately is the point.
        // Both ship false on every tier (§5.9); `low` is additionally `null` in
        // the plan's tier table, so every knob here is 0/false and even
        // `?terrainSnow=on` at low renders nothing. Neither boolean is in
        // BOOL_FLAGS (parseBool would widen the exact-`on` opt-in their readers
        // require); the two NUMERIC knobs are safe in INT/FLOAT_FLAGS.
        terrainSnow: terrainMaster("snow", "low"),
        terrainSnowSpindriftCount: 0,
        terrainSnowSparkle: false,
        terrainSnowPrints: false,
        terrainSnowRadius: 32,
        terrainIce: terrainMaster("ice", "low"),
        terrainIceRefraction: false,
        // Terrain VOLCANO/OBSIDIAN (Wave 2B, plan §3.6). `terrainVolcano` is the
        // FAMILY MASTER and ships false on every tier (§5.9); `low` is `null` in
        // the plan's tier table, so every knob here is 0/false and even
        // `?terrainVolcano=on` at low renders nothing. The three BOOLEANS stay
        // out of BOOL_FLAGS for the `gfxRelief` reason; the three numerics are
        // safe in INT/FLOAT_FLAGS — they cannot turn the family on.
        // NOTE: no ash key — ash fall is DEFERRED (plan §8 risk 9; see
        // `vfx_flags.js`'s volcano block for the SnowSystem assessment).
        terrainVolcano: terrainMaster("volcano", "low"),
        terrainHaze: false,
        terrainCrackGlow: false,
        terrainVolcanoEmberCount: 0,
        terrainHazeStrength: 0,
        terrainVolcanoRadius: 0,
        // Terrain DIRT/MUD (Wave 3B, plan §3.7). `terrainDirt` is the FAMILY
        // MASTER and ships false on every tier (§5.9); `low` is `null` in the
        // plan's tier table, so every knob here is 0/false and even
        // `?terrainDirt=on` at low renders nothing. The four BOOLEANS stay out
        // of BOOL_FLAGS for the `gfxRelief` reason; the two numerics are safe in
        // INT/FLOAT_FLAGS — they cannot turn the family on.
        terrainDirt: terrainMaster("dirt", "low"),
        terrainFootfall: false,
        terrainMudPrints: false,
        terrainMudWetness: false,
        terrainDirtDustCount: 0,
        terrainDirtRadius: 32,
        // Terrain SWAMP/MARSH (Wave 3A, plan §3.5). `terrainSwamp` is the
        // FAMILY MASTER and ships false on every tier (§5.9); `low` is `null`
        // in the plan's tier table, so every knob here is 0/false and even
        // `?terrainSwamp=on` at low renders nothing. The four BOOLEANS stay out
        // of BOOL_FLAGS for the `gfxRelief` reason; the three numerics are safe
        // in INT/FLOAT_FLAGS — they cannot turn the family on.
        // NOTE: no `terrainGroundFogSoftness` key. That knob is URL-ONLY by
        // design (see `vfx_flags.js::terrainGroundFogSoftnessM`): it arms the
        // fog's scene-depth read, which is a framebuffer feedback loop against
        // the composer's live depth attachment, so no tier may turn it on.
        terrainSwamp: terrainMaster("swamp", "low"),
        terrainGroundFogCount: 0,
        terrainGroundFogRadius: 32,
        terrainMarshGasCount: 0,
        terrainMarshWisps: false,
        terrainSwampFireflies: false,
        terrainSwampMidges: false,
        // Terrain ROCK/BARREN (Wave 4A, plan §3.3). `terrainRock` is the FAMILY
        // MASTER and ships false on every tier (§5.9); `low` is `null` in the
        // plan's tier table, so both counts are 0 and even `?terrainRock=on` at
        // low renders nothing. The master and the two effect booleans stay out
        // of BOOL_FLAGS for the `gfxRelief` reason; the three numerics are safe
        // in INT/FLOAT_FLAGS — they cannot turn the family on.
        // NOTE: no `terrainRockDensity` key. That knob is URL-ONLY by design
        // (see `vfx_flags.js::terrainRockDensity`), like `terrainGrassDensity`
        // and `terrainDirtDustDensity`: the tier owns the shipped counts and
        // the density knob is the continuous A/B lever on top of them.
        terrainRock: terrainMaster("rock", "low"),
        terrainRockPebbleCount: 0,
        terrainRockGritCount: 0,
        terrainRockRadius: 32,
        maxParticlesPerEmitter: 64,
    },
    mid: {
        antialias: true,
        // Wave 2.B (2026-05-28) turned these off on `mid`: the +texture memory
        // and per-fragment normal-map work were measured to cost more FPS than
        // the visual delta returned. RE-MEASURED 2026-07-30 on a GTX 1070 and
        // that no longer holds — with texBc7 also on, the compressed textures
        // cut enough bandwidth that the everything-on arm was FASTER (35.2 ms
        // median / 28.4 fps vs 36.7 / 27.2). `?normalMaps=off` is the escape.
        normalMaps: true,
        detailFlag: true,
        terrainDetailNormal: true,
        triplanar: true,
        triplanarSlopeThresholdPct: 60,
        // Anisotropic filtering — moderate on mid-tier to keep grazing-angle
        // terrain/road textures from smearing without the full 16× cost.
        anisotropy: 4,
        subdivLevel: 2,
        // 1 = 4x tris on world models. Shadows are ~half the GPU cost at
        // quality=high and are the ONLY vertex-stage-bound pass, so mid/high
        // both stop at 4x; 16x is an `ultra` opt-in.
        gfxRelief: true,
        gfxSubdivLevel: 0,
        gfxReliefScale: 1.0,
        // pom ON at mid (2026-07-30, second pass): EnvCell interiors and
        // non-atlased singletons — i.e. EVERY dungeon wall — are not atlas
        // members, so with `pom` off at mid they were the one surface class
        // left flat while the outdoor world got `statPom`. Same 8/4 mid step
        // counts, same 5-10 m fade; `?pom=off` escapes.
        pom: true,
        pomStepsPrimary: 8,
        pomStepsSelfShadow: 4,
        // statPom ON at mid (2026-07-30): unlike the legacy singleton `pom`,
        // the atlas POM is fade-limited, marches the mid-tier 8/4 step counts
        // above, and the 2026-07-30 1070 measurement showed the
        // everything-on arm FASTER than bare default (BC7 bandwidth pays for
        // the fragment work). `?statPom=off` escapes.
        statPom: true,
        csm: false,
        bloom: true,
        vignette: false,
        lensFlare: false,
        lightShafts: false,
        // Terrain VFX grass — see the `low` tier for the rationale. 24336 =
        // 156²; stomp off at mid (the trail RT is a high/ultra promotion).
        terrainGrass: terrainMaster("grass", "mid"),
        terrainGrassBlades: 24336,
        terrainGrassRadius: 32,
        terrainGrassStomp: false,
        // Terrain VFX trail map — see the `low` tier for the rationale.
        terrainTrail: terrainMaster("trail", "mid"),
        terrainTrailRes: 128,
        terrainTrailRadius: 48,
        terrainTrailFade: 4,
        // Terrain SAND — see the `low` tier. mid = streamers + sparkle, no
        // devils (plan §3.2 "mid {streamers:800, devils:0, sparkle:true}").
        terrainSand: terrainMaster("sand", "mid"),
        terrainSandStreamerCount: 800,
        terrainSandDevilCount: 0,
        terrainSandSparkle: true,
        terrainSandRadius: 48,
        // Terrain SNOW/ICE — see the `low` tier. plan §3.4
        // "mid {sparkle:true, spindrift:0, prints:false}": the sparkle is the
        // WHOLE mid tier. Prints are off because POM is off at mid, so a print
        // would degrade to darkening-only — coherent, but not worth the RT.
        terrainSnow: terrainMaster("snow", "mid"),
        terrainSnowSpindriftCount: 0,
        terrainSnowSparkle: true,
        terrainSnowPrints: false,
        terrainSnowRadius: 48,
        terrainIce: terrainMaster("ice", "mid"),
        terrainIceRefraction: false,
        // Terrain VOLCANO — see the `low` tier. mid = crack glow ONLY (plan §3.6
        // "mid {crackGlow:true}"): no haze (a fullscreen fill cost), no embers.
        // The crack glow degrades coherently with POM off at this tier — its POM
        // correction term is then exactly zero (plan §2.7.3 point 4).
        terrainVolcano: terrainMaster("volcano", "mid"),
        terrainHaze: false,
        terrainCrackGlow: true,
        terrainVolcanoEmberCount: 0,
        terrainHazeStrength: 0,
        terrainVolcanoRadius: 0,
        // Terrain DIRT/MUD — see the `low` tier. mid = footfall puffs ONLY
        // (plan §3.7 "mid {footfall:true}"): no prints (POM is high/ultra, and
        // a darkening-only print is the degrade, not the shipped mid look), no
        // wetness, no haze (a fill cost this tier does not spend).
        terrainDirt: terrainMaster("dirt", "mid"),
        terrainFootfall: true,
        terrainMudPrints: false,
        terrainMudWetness: false,
        terrainDirtDustCount: 0,
        terrainDirtRadius: 40,
        // Terrain SWAMP — see the `low` tier. plan §3.5 "mid {fog:8, gas:false,
        // fireflies:true}": the two particle re-anchors (which cost one
        // synthesized emitter per swamp landblock) and a thin 8-card fog ring,
        // but NO gas vents and no wisps.
        terrainSwamp: terrainMaster("swamp", "mid"),
        terrainGroundFogCount: 8,
        terrainGroundFogRadius: 40,
        terrainMarshGasCount: 0,
        terrainMarshWisps: false,
        terrainSwampFireflies: true,
        terrainSwampMidges: true,
        // Terrain ROCK — see the `low` tier. plan §3.3 "mid {pebbles:3000}";
        // the grit ladder is §3.2's streamer ladder at the "1/5 density" §3.3
        // item 2 asks for (800 → 160).
        terrainRock: terrainMaster("rock", "mid"),
        terrainRockPebbleCount: 3000,
        terrainRockGritCount: 160,
        terrainRockRadius: 40,
        maxParticlesPerEmitter: 256,
    },
    high: {
        antialias: true,
        normalMaps: true,
        detailFlag: true,
        terrainDetailNormal: true,
        triplanar: true,
        triplanarSlopeThresholdPct: 30,
        // Full anisotropic filtering on high+ (capped by the GPU max in
        // index.js). Restores retail-sharp terrain/road textures at grazing
        // angles — the prior global `setAdapterMaxAnisotropy(1)` smeared them.
        anisotropy: 16,
        subdivLevel: 4,
        gfxRelief: true,
        gfxSubdivLevel: 0,
        gfxReliefScale: 1.0,
        pom: true,
        pomStepsPrimary: 16,
        pomStepsSelfShadow: 8,
        statPom: true,
        csm: true,
        bloom: true,
        vignette: true,
        lensFlare: false,
        // INERT without `?clouds=on` (perf-synthesis §4): the only reader is
        // index.js `effect.lightShafts = !!quality.flags.lightShafts` on the
        // cloud effect, which is only constructed under the `clouds` opt-in.
        // Kept true so shafts light up the moment clouds are promoted.
        lightShafts: true,
        // Terrain VFX grass — see the `low` tier. 60025 = 245², the plan's
        // reference budget (240k tris, one draw call, <= 3.5 ms on an R9 290 —
        // a hypothesis, §8 risk 6: measure before fixing this number).
        terrainGrass: terrainMaster("grass", "high"),
        terrainGrassBlades: 60025,
        terrainGrassRadius: 48,
        terrainGrassStomp: true,
        // Terrain VFX trail map — see the `low` tier for the rationale.
        terrainTrail: terrainMaster("trail", "high"),
        terrainTrailRes: 256,
        terrainTrailRadius: 48,
        terrainTrailFade: 4,
        // Terrain SAND — see the `low` tier. plan §3.2 "high {streamers:2000,
        // devils:1, sparkle:true}".
        terrainSand: terrainMaster("sand", "high"),
        terrainSandStreamerCount: 2000,
        terrainSandDevilCount: 1,
        terrainSandSparkle: true,
        terrainSandRadius: 64,
        // Terrain SNOW/ICE — see the `low` tier. plan §3.4
        // "high {sparkle:true, spindrift:1200, prints:true}". Prints need POM,
        // which is high/ultra only.
        terrainSnow: terrainMaster("snow", "high"),
        terrainSnowSpindriftCount: 1200,
        terrainSnowSparkle: true,
        terrainSnowPrints: true,
        terrainSnowRadius: 64,
        terrainIce: terrainMaster("ice", "high"),
        terrainIceRefraction: false,
        // Terrain VOLCANO — see the `low` tier. plan §3.6 "high {crackGlow:true,
        // haze:true, embers:1}". The haze is fill-bound, so it DOES get cheaper
        // at 25 % render scale (plan §5.8).
        terrainVolcano: terrainMaster("volcano", "high"),
        terrainHaze: true,
        terrainCrackGlow: true,
        terrainVolcanoEmberCount: 1,
        terrainHazeStrength: 1,
        terrainVolcanoRadius: 160,
        // Terrain DIRT/MUD — see the `low` tier. plan §3.7 "high
        // {footfall:true, prints:true, dustHaze:800}". POM is live at this tier,
        // so the print gets its dent as well as its darkening.
        terrainDirt: terrainMaster("dirt", "high"),
        terrainFootfall: true,
        terrainMudPrints: true,
        terrainMudWetness: false,
        terrainDirtDustCount: 800,
        terrainDirtRadius: 56,
        // Terrain SWAMP — see the `low` tier. plan §3.5 "high {fog:16,
        // gas:true, fireflies:true}". Wisps stay ultra-only.
        terrainSwamp: terrainMaster("swamp", "high"),
        terrainGroundFogCount: 16,
        terrainGroundFogRadius: 56,
        terrainMarshGasCount: 2,
        terrainMarshWisps: false,
        terrainSwampFireflies: true,
        terrainSwampMidges: true,
        // Terrain ROCK — see the `low` tier. plan §3.3 "high {pebbles:9000}";
        // grit = §3.2's high streamer count (2000) at 1/5.
        terrainRock: terrainMaster("rock", "high"),
        terrainRockPebbleCount: 9000,
        terrainRockGritCount: 400,
        terrainRockRadius: 56,
        maxParticlesPerEmitter: 1024,
    },
    ultra: {
        antialias: true,
        normalMaps: true,
        detailFlag: true,
        terrainDetailNormal: true,
        triplanar: true,
        triplanarSlopeThresholdPct: 30,
        anisotropy: 16,
        subdivLevel: 8,
        // 2 = 16x tris. `ultra` is never auto-selected (see detectGpuTier), so
        // the shadow-pass vertex bill here is always a deliberate opt-in.
        gfxRelief: true,
        gfxSubdivLevel: 0,
        gfxReliefScale: 1.0,
        pom: true,
        pomStepsPrimary: 24,
        pomStepsSelfShadow: 12,
        statPom: true,
        csm: true,
        bloom: true,
        vignette: true,
        lensFlare: false,
        // INERT without `?clouds=on` (perf-synthesis §4): the only reader is
        // index.js `effect.lightShafts = !!quality.flags.lightShafts` on the
        // cloud effect, which is only constructed under the `clouds` opt-in.
        // Kept true so shafts light up the moment clouds are promoted.
        lightShafts: true,
        // Terrain VFX grass — see the `low` tier. 119716 = 346².
        terrainGrass: terrainMaster("grass", "ultra"),
        terrainGrassBlades: 119716,
        terrainGrassRadius: 64,
        terrainGrassStomp: true,
        // Terrain VFX trail map — see the `low` tier for the rationale.
        terrainTrail: terrainMaster("trail", "ultra"),
        terrainTrailRes: 512,
        terrainTrailRadius: 64,
        terrainTrailFade: 4,
        // Terrain SAND — see the `low` tier. plan §3.2 "ultra {streamers:3000,
        // devils:2, sparkle:true}".
        terrainSand: terrainMaster("sand", "ultra"),
        terrainSandStreamerCount: 3000,
        terrainSandDevilCount: 2,
        terrainSandSparkle: true,
        terrainSandRadius: 80,
        // Terrain SNOW/ICE — see the `low` tier. plan §3.4
        // "ultra {sparkle:true, spindrift:2500, prints:true, iceRefraction:true}".
        // 2500 = 50², already a perfect square, so the pool rounds nothing.
        terrainSnow: terrainMaster("snow", "ultra"),
        terrainSnowSpindriftCount: 2500,
        terrainSnowSparkle: true,
        terrainSnowPrints: true,
        terrainSnowRadius: 80,
        terrainIce: terrainMaster("ice", "ultra"),
        terrainIceRefraction: true,
        // Terrain VOLCANO — see the `low` tier. plan §3.6 "ultra
        // {crackGlow:true, haze:true, embers:3, ash:true}" MINUS ash, which is
        // deferred (plan §8 risk 9) and therefore carries no key at all.
        terrainVolcano: terrainMaster("volcano", "ultra"),
        terrainHaze: true,
        terrainCrackGlow: true,
        terrainVolcanoEmberCount: 3,
        terrainHazeStrength: 1.25,
        terrainVolcanoRadius: 220,
        // Terrain DIRT/MUD — see the `low` tier. plan §3.7 "ultra
        // {footfall:true, prints:true, dustHaze:2000, wetness:true}". The
        // wet-mud darkening + sheen is the ultra-only addition, exactly as the
        // plan's tier table has it.
        terrainDirt: terrainMaster("dirt", "ultra"),
        terrainFootfall: true,
        terrainMudPrints: true,
        terrainMudWetness: true,
        terrainDirtDustCount: 2000,
        terrainDirtRadius: 72,
        // Terrain SWAMP — see the `low` tier. plan §3.5 "ultra {fog:24,
        // gas:true, wisps:true}".
        terrainSwamp: terrainMaster("swamp", "ultra"),
        terrainGroundFogCount: 24,
        terrainGroundFogRadius: 72,
        terrainMarshGasCount: 3,
        terrainMarshWisps: true,
        terrainSwampFireflies: true,
        terrainSwampMidges: true,
        // Terrain ROCK — see the `low` tier. plan §3.3 "ultra {pebbles:18000}";
        // grit = §3.2's ultra streamer count (3000) at 1/5.
        terrainRock: terrainMaster("rock", "ultra"),
        terrainRockPebbleCount: 18000,
        terrainRockGritCount: 600,
        terrainRockRadius: 72,
        maxParticlesPerEmitter: 2048,
    },
};

export const PRESET_NAMES = ["low", "mid", "high", "ultra"];

// Boolean-typed flags. Values "on"/"true"/"1" → true; "off"/"false"/"0"
// → false. Used by parseOverrides to coerce per-feature URL params.
const BOOL_FLAGS = new Set([
    "antialias",
    // "shadows" removed 2026-08-01 — see the PRESETS.low note: flags.shadows
    // had no reader; `?shadows=on` keeps its own exact-match reader in
    // index.js, unaffected by this parser.
    //
    // TOMBSTONE (2026-08-03): that 08-01 removal checked for READERS but not
    // for WRITERS, so `ui/graphics_settings.js` kept rendering a "Shadows"
    // checkbox writing `flags.shadows` into localStorage for the sanitizer
    // below to silently drop. The checkbox is now GONE, and the rule it left
    // behind is the reason this note stays: a dead flag must be REMOVED from
    // the panel, never rewired. Rewiring would honour a `flags.shadows` that
    // every already-saved `holtburger_graphics_v1` blob still contains as
    // `true`, silently switching shadow maps on for returning users.
    // `warnOnDeadFlag` below now names any future saved key with no reader.
    "normalMaps",
    "detailFlag",
    "terrainDetailNormal",
    "triplanar",
    "pom",
    "statPom",
    "csm",
    "bloom",
    "vignette",
    "lensFlare",
    "lightShafts",
]);

// Integer-typed flags.
//
// NOTE `gfxRelief` (the MASTER geometry-relief opt-in) is deliberately absent
// from BOOL_FLAGS: `parseBool` also accepts "1"/"true"/"yes", which would widen
// an opt-in that docs/url-flags.md requires to be an exact `=== "on"` match.
// Its one decisive reader is `scene3d/gfx_relief.js::resolveGfxRelief`. The two
// NUMERIC knobs below are safe to expose here (they cannot turn the feature on
// by themselves) so the Graphics-settings localStorage bag can carry them;
// gfx_relief.js clamps whatever it reads, from either source.
const INT_FLAGS = new Set([
    "subdivLevel",
    "gfxSubdivLevel",
    "pomStepsPrimary",
    "pomStepsSelfShadow",
    "triplanarSlopeThresholdPct",
    "maxParticlesPerEmitter",
    // Terrain-VFX grass (Wave 1A). `terrainGrass` / `terrainGrassStomp` are
    // absent for the same reason `gfxRelief` is — see the PRESETS comment.
    "terrainGrassBlades",
    // Terrain-VFX trail map (Wave 0B). `terrainTrail` itself is absent for the
    // same reason `gfxRelief` is — see the PRESETS comment.
    "terrainTrailRes",
    // Terrain SAND (Wave 1B). Counts only — `terrainSand` and
    // `terrainSandSparkle` are absent from BOOL_FLAGS for the `gfxRelief`
    // reason (their readers require an exact `=== "on"`).
    "terrainSandStreamerCount",
    "terrainSandDevilCount",
    // Terrain SNOW (Wave 2A). Count only — `terrainSnow`, `terrainSnowSparkle`,
    // `terrainSnowPrints`, `terrainIce` and `terrainIceRefraction` are absent
    // from BOOL_FLAGS for the `gfxRelief` reason (their readers require an
    // exact `=== "on"`).
    "terrainSnowSpindriftCount",
    // Terrain VOLCANO (Wave 2B). Count only — `terrainVolcano`, `terrainHaze`
    // and `terrainCrackGlow` are absent from BOOL_FLAGS for the `gfxRelief`
    // reason (their readers require an exact `=== "on"`).
    "terrainVolcanoEmberCount",
    // Terrain DIRT (Wave 3B). Count only — `terrainDirt`, `terrainFootfall`,
    // `terrainMudPrints` and `terrainMudWetness` are absent from BOOL_FLAGS for
    // the `gfxRelief` reason (their readers require an exact `=== "on"`).
    // (`?terrainDirtDustDensity` and `?terrainFootfallPuffs` are URL-ONLY, like
    // `?terrainGrassDensity`.)
    "terrainDirtDustCount",
    // Terrain SWAMP (Wave 3A). Counts only — `terrainSwamp`,
    // `terrainMarshWisps`, `terrainSwampFireflies` and `terrainSwampMidges` are
    // absent from BOOL_FLAGS for the `gfxRelief` reason (their readers require
    // an exact `=== "on"`).
    "terrainGroundFogCount",
    "terrainMarshGasCount",
    // Terrain ROCK (Wave 4A). Counts only — `terrainRock`, `terrainRockPebbles`
    // and `terrainRockGrit` are absent from BOOL_FLAGS for the `gfxRelief`
    // reason (their readers require an exact `=== "on"`).
    // (`?terrainRockDensity` is URL-ONLY, like `?terrainGrassDensity`.)
    "terrainRockPebbleCount",
    "terrainRockGritCount",
]);

// Float-typed flags.
const FLOAT_FLAGS = new Set([
    "gfxReliefScale",
    "terrainGrassRadius",
    "terrainTrailRadius",
    "terrainTrailFade",
    // Terrain SAND (Wave 1B) — streamer-field half-extent in metres.
    "terrainSandRadius",
    // Terrain SNOW (Wave 2A) — spindrift-field half-extent in metres.
    // (`?terrainSnowSlope` is URL-ONLY, like `?terrainGrassDensity`.)
    "terrainSnowRadius",
    // Terrain VOLCANO (Wave 2B) — heat-shimmer amplitude multiplier and the
    // heat-source radius in metres around the nearest resident volcanic LB.
    "terrainHazeStrength",
    "terrainVolcanoRadius",
    // Terrain DIRT (Wave 3B) — dry-dust-haze field half-extent in metres.
    "terrainDirtRadius",
    // Terrain SWAMP (Wave 3A) — the fog ring's half-extent in metres.
    // (`?terrainGroundFogSoftness` is URL-ONLY, like `?terrainSnowSlope`.)
    "terrainGroundFogRadius",
    // Terrain ROCK (Wave 4A) — the half-extent in metres shared by the pebble
    // and grit windows.
    "terrainRockRadius",
]);

function parseBool(raw) {
    const v = String(raw).toLowerCase();
    if (v === "on" || v === "true" || v === "1" || v === "yes") return true;
    if (v === "off" || v === "false" || v === "0" || v === "no") return false;
    return null;
}

function parseInteger(raw) {
    const n = Number.parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : null;
}

function parseFloatFlag(raw) {
    const n = Number.parseFloat(String(raw));
    return Number.isFinite(n) ? n : null;
}

// Persisted-preference keys this parser knowingly has no home for. Warned
// once each per session — a settings control that writes a key nothing reads
// is a UI element that does nothing, and that should never be silent.
const _deadFlagWarned = new Set();
export function warnOnDeadFlag(key) {
    if (_deadFlagWarned.has(key)) return false;
    _deadFlagWarned.add(key);
    try {
        // eslint-disable-next-line no-console
        console.warn(
            `[quality] saved graphics preference "${key}" has no reader — ` +
            "the control that wrote it does nothing (see quality.js BOOL_FLAGS)",
        );
    } catch (_) { /* never block boot for a diagnostic */ }
    return true;
}

function parseOverrides(params) {
    const overrides = {};
    for (const flag of BOOL_FLAGS) {
        if (!params.has(flag)) continue;
        const v = parseBool(params.get(flag));
        if (v !== null) overrides[flag] = v;
    }
    for (const flag of INT_FLAGS) {
        if (!params.has(flag)) continue;
        const v = parseInteger(params.get(flag));
        if (v !== null) overrides[flag] = v;
    }
    for (const flag of FLOAT_FLAGS) {
        if (!params.has(flag)) continue;
        const v = parseFloatFlag(params.get(flag));
        if (v !== null) overrides[flag] = v;
    }
    return overrides;
}

// Mobile UA detection. Matches common mobile + tablet user-agents
// without trying to be perfect — the goal is "downgrade mid→low on
// likely-mobile hardware by default" not "perfectly classify every
// device". Users can always pass `?quality=high` explicitly to opt
// back into the higher tier.
export function isMobileUA(ua) {
    if (!ua || typeof ua !== "string") return false;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
}

// A5 — GPU tier classification heuristics.
//
// HIGH allowlist: modern desktop discrete cards + Apple-silicon GPUs
// known to comfortably handle the `high` preset. Conservative on
// purpose — we abstain to MID for anything we don't explicitly
// recognise.
//
// LOW deny-list: integrated GPUs, older mobile GPUs, and embedded
// chips that should run the `low` preset by default.
//
// Anything matched by neither list defaults to MID. We NEVER auto-
// promote to ULTRA — that tier is a deliberate opt-in via
// `?quality=ultra`.
const GPU_HIGH_RE = /RTX 30\d\d|RTX 40\d\d|RTX 20[678]0|RX 7[890]\d\d|RX 6[89]\d\d|M[1-4]( Pro| Max| Ultra)?|Apple GPU|Radeon Pro/i;
const GPU_LOW_RE = /Mali|Adreno [0-5]\d\d|PowerVR SGX|Intel\(R\) (HD|UHD|Iris Plus)|Intel\(R\) Atom|Tegra/i;

// Detect coarse GPU tier via a throwaway 1×1 probe canvas.
//
// Creates a `<canvas>`, asks for a WebGL context, queries the
// `WEBGL_debug_renderer_info` extension's unmasked renderer string,
// then destroys both. Returns one of "high" | "low" or null when the
// probe can't run (no document, no WebGL, no debug-renderer ext, or
// renderer string was masked/unrecognised). MID is encoded as the
// "unrecognised → fall through to existing default" path; we return
// null for the unrecognised case so the caller's chain still gets a
// chance to apply mobile-UA logic below.
//
// Browser-only. Guarded with a `typeof document` check so Node test
// harnesses don't trip.
export function detectGpuTier() {
    if (typeof document === "undefined") return null;
    let canvas = null;
    let gl = null;
    try {
        canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        gl =
            canvas.getContext("webgl") ||
            canvas.getContext("experimental-webgl");
        if (!gl) return null;
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (!ext) return null;
        const renderer = String(
            gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "",
        );
        if (!renderer) return null;
        if (GPU_HIGH_RE.test(renderer)) {
            return { tier: "high", renderer };
        }
        if (GPU_LOW_RE.test(renderer)) {
            return { tier: "low", renderer };
        }
        // Unrecognised string (incl. Firefox-strict "Mozilla" /
        // "WebGL Generic" masking) — abstain.
        return { tier: null, renderer };
    } catch (_e) {
        return null;
    } finally {
        // Throwaway-context cleanup: browsers cap to ~16 live WebGL
        // contexts, so we MUST release this one explicitly. Force a
        // context loss where available, drop the DOM node, and null
        // out our local references.
        try {
            if (gl) {
                const loseExt = gl.getExtension("WEBGL_lose_context");
                if (loseExt && typeof loseExt.loseContext === "function") {
                    loseExt.loseContext();
                }
            }
        } catch (_e) {
            // ignore — best-effort
        }
        gl = null;
        if (canvas) {
            try {
                canvas.remove();
            } catch (_e) {
                // ignore — best-effort
            }
            canvas = null;
        }
    }
}

// Read user overrides persisted by the Graphics settings tab. Returns
// `null` when no localStorage entry exists, when localStorage is
// unavailable (Node test harness), or when the payload is malformed.
//
// The shape mirrors `ui/graphics_settings.js` exactly:
//   { preset?: "low"|..., flags?: { antialias: bool, ... }, extras?: {...} }
function readLocalGraphicsOverrides() {
    if (typeof localStorage === "undefined") return null;
    try {
        const raw = localStorage.getItem("holtburger_graphics_v1");
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        return parsed;
    } catch (_e) {
        return null;
    }
}

// Parse a `?quality=...` query string + per-feature overrides into a
// resolved preset bag. Mobile UAs default mid→low.
//
// Merge precedence (highest → lowest):
//   1. URL `?quality=` / per-flag `?antialias=on` overrides
//   2. `localStorage.holtburger_graphics_v1` user overrides
//   3. GPU-tier probe via `WEBGL_debug_renderer_info` (A5)
//   4. Mobile UA default ("low") / desktop default ("mid")
//
// Args (all optional; defaults read window/navigator when available):
//   url:        URL string or URL instance.
//   userAgent:  navigator.userAgent string.
//
// Returns: { preset: "low"|"mid"|"high"|"ultra", flags: {...},
//            source: "url"|"localstorage"|"gpu-probe"
//                    |"mobile-default"|"default" }
//
// The returned `flags` is a fresh object — callers can mutate without
// affecting `PRESETS`.
export function getQuality(url, userAgent) {
    const resolvedUrl =
        url ??
        (typeof window !== "undefined" && window.location
            ? window.location.href
            : null);
    const resolvedUa =
        userAgent ??
        (typeof navigator !== "undefined" ? navigator.userAgent : "");

    let params;
    try {
        params = resolvedUrl
            ? new URL(resolvedUrl).searchParams
            : new URLSearchParams("");
    } catch (_) {
        params = new URLSearchParams("");
    }

    const requested = params.get("quality");
    const mobile = isMobileUA(resolvedUa);
    const lsState = readLocalGraphicsOverrides();

    let preset;
    let source;
    if (requested && PRESET_NAMES.includes(requested)) {
        preset = requested;
        source = "url";
    } else if (lsState && typeof lsState.preset === "string"
        && PRESET_NAMES.includes(lsState.preset)) {
        preset = lsState.preset;
        source = "localstorage";
    } else {
        // A5 — GPU-tier probe. Runs only in the browser; abstains
        // (returns null) under Node, when WebGL is unavailable, when
        // `WEBGL_debug_renderer_info` is stripped, or when the
        // renderer string isn't on the HIGH allowlist or LOW
        // deny-list. NEVER auto-promotes to ULTRA.
        const probe = detectGpuTier();
        if (probe && probe.tier === "high") {
            preset = "high";
            source = "gpu-probe";
            // eslint-disable-next-line no-console
            console.log(
                `[quality] gpu-probe → high (renderer="${probe.renderer}")`,
            );
        } else if (probe && probe.tier === "low") {
            preset = "low";
            source = "gpu-probe";
            // eslint-disable-next-line no-console
            console.log(
                `[quality] gpu-probe → low (renderer="${probe.renderer}")`,
            );
        } else if (mobile) {
            preset = "low";
            source = "mobile-default";
        } else {
            preset = "mid";
            source = "default";
        }
    }

    const flags = { ...PRESETS[preset] };

    // localStorage flag overrides (sanitized — only known flag names
    // with correct types are accepted; everything else is dropped).
    if (lsState && lsState.flags && typeof lsState.flags === "object") {
        for (const k of Object.keys(lsState.flags)) {
            const v = lsState.flags[k];
            if (BOOL_FLAGS.has(k) && typeof v === "boolean") {
                flags[k] = v;
            } else if (INT_FLAGS.has(k) && Number.isFinite(v)) {
                flags[k] = v;
            } else if (FLOAT_FLAGS.has(k) && Number.isFinite(v)) {
                flags[k] = v;
            } else {
                // A saved preference this parser has no home for. Silently
                // dropping it is how the "Shadows" checkbox stayed inert and
                // invisible for two days (see the BOOL_FLAGS note). Name it
                // once per key per session so a dead control is audible.
                warnOnDeadFlag(k);
            }
        }
    }

    // URL per-flag overrides win.
    const overrides = parseOverrides(params);
    Object.assign(flags, overrides);

    return { preset, flags, source };
}

// Install a `window.__quality` mirror for devtools inspection. Idempotent;
// safe to call multiple times. Returns the resolved object so callers
// can store it on liveScene3d in one go.
export function installQualityOnWindow(quality) {
    if (typeof window === "undefined") return quality;
    window.__quality = quality;
    return quality;
}
