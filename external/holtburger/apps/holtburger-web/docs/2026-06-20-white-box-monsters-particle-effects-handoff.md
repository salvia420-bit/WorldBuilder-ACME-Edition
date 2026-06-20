# Handoff — "monsters render as glowing white boxes" + particle effects (2026-06-20)

**Status: ROOT CAUSE of the white box CONFIRMED (entity luminous surface); the
OPEN question is whether the monster's PARTICLE EFFECTS are being displayed at
all — the white box may be the bare emitter/setup part left visible because the
particle effect isn't rendering.** Several JS-only fixes shipped along the way
(all default-on, no wasm rebuild). User is an AC expert and steered most pivots.

---

## SYMPTOM
Looking at the live 1070 client, **monsters render as solid WHITE BOXES that
glow** (Beaten Doll / Battered Doll / etc., in the combat-training area south of
Holtburg, LB ~0xAB94). User says it's **systemic, not piecemeal** — *"portals
don't render, lots of monsters"* render wrong. **User LIKES the light/glow
effect the boxes give off and wants to KEEP it** while losing the solid box.

This started as a *different* report (textures/weenies/particles loading) and
narrowed to the white boxes. The earlier separate barren-wilderness work is in
`2026-06-20-empty-world-statics-investigation-handoff.md`.

---

## CONFIRMED ROOT CAUSE of the white box (from CDP + reference research)
The white box is the **doll ENTITY mesh**, NOT a particle and NOT a null
material:
- Doll `part_1`, surface **0x80003e4**: a **luminous** surface (luminosity float
  ≈1.0). Its paletted material (`paletted-80003e4-040010be`) has
  **`emissive=white, emissiveIntensity=1`** and — on the **paletted** path — **no
  emissiveMap is attached**, so it's a **flat white emissive** over the whole
  **opaque** quad. The texture is 8×8 **100% black RGB / 100% opaque alpha**, so
  no shape/cutout → renders as a **solid white glowing rectangle**. That flat
  white emissive IS the "light effect" the user likes.
- Doll **body = 11 invisible parts** (surface 0x8000015, translucency≈1 →
  opacity 0). This is **RETAIL-CORRECT** (Chorizite `CMaterial::GetTranslucencySimple`
  @0x0053A450: `opacity = 1 − translucency`). DO NOT "fix" the invisible parts.
- `modelChanges` (AnimPartChange) ARE applied correctly (part 9 substituted to
  real 64×128 surfaces 0x8000dd1/dd2/0x8000a4c).

### Measurement errors made this session (DO NOT repeat)
1. "zero emissive → box unchanged, so not emissive" — **WRONG.** The test
   iterated `materialCache.materials`; the doll material lives in
   `materialCache.**palettedMaterials**` and was never touched. Emissive IS the box.
2. `renderSet=1` outdoors is **by-design** (portal-graph BFS is indoor-only).
3. `_particleEmittersForGuid=0` / `particleTable=0` were **transient snapshots**;
   emitters ARE created (`nextEmitterId` climbs continuously).
4. Don't trust a single between-cast snapshot for transient particle state.

---

## THE OPEN LEAD (what the user was asking when this handoff was requested)
**"Are you displaying the particle effects for the monster?"** Strong hypothesis:
the glowing white box is the **bare setup/emitter-anchor part** that is visible
because the **doll's particle EFFECT isn't actually rendering** — i.e. the part
should be covered/replaced by a script-driven particle glow, but the particle
effect isn't displaying, leaving the luminous box.

Evidence the particle pipeline is RUNNING but maybe not producing visible particles:
- Console shows the doll's PhysicsScript chain IS walked: `[entities/H2] chain
  walker entered for guid=0x80007262 pes=0x33000acb … fetched PS=0x33000acb
  entries=3`; `[play-effect-vfx/real] resolved scriptId=… emittersScheduled=1/2`.
- `nextEmitterId` climbs (emitters created) BUT snapshots showed
  `particleTable.size`/visible-additive-particle-mesh counts at ~0.
- Doll meta `physicsScriptDid: 0` (the 0x33000acb script came via another path —
  MotionTable CreateParticle / play-effect-vfx, not the entity's own field).

**NEXT STEP (unstarted):** determine whether the doll's emitters land in the
active `particleTable` and produce VISIBLE particle meshes, or whether
`setInfo`/spawn fails (e.g. `hwGfxObjId==0`, or particles spawn-and-die). If the
particle effect SHOULD be the glow and it's not rendering, the fix is to make the
emitter render — NOT to hack the luminous box surface. Reconcile with the user's
"I like the light effect": is that light effect the EMISSIVE box, or the
(missing) particle effect?

---

## SHIPPED THIS SESSION (JS-only, default-on, NO wasm rebuild; verify on reload)
1. **Grey/white statics race** — `scene3d/materials.js` `preload()` now awaits
   in-flight surface promises from sibling bakes (was returning before they
   resolved → `getCached` handed back grey 0x888888 fallback). Confirmed
   `fallbackHits=5096`. (Amplified by the pvsRingRadius change below.)
2. **Particle null-material guard** — `scene3d/particles/particle_manager.js`:
   when `materialFactory` returns null (gfxobj has no surface), render a shared
   invisible material instead of THREE's default white. `noSurfaceParticleMaterial()`.
3. **Unlit particle materials (`?particleUnlit`, default-on)** —
   `materials.js getParticleUnlit()` builds a cache-owned UNLIT `MeshBasicMaterial`
   (ParticleViewer parity: texture×opacity, additive/alpha from `Surfaces[0].Type`)
   instead of the lit MeshStandard entity path; wired at `entities.js` (world
   particle mgr) + `statics.js` (scenery particle mgr) materialFactory.
   **A/B showed the dolls' boxes UNCHANGED → they are entity meshes, not particles**
   (the fix is still correct for real particle effects; keep it).
4. (Pre-this-issue, same session) **barren-wilderness** `?pvsRingRadius` (default 5,
   player-centered streaming ring) — `cells.js` + `index.js`. See the other handoff.

**NONE of the above is committed to git yet** (serve.py serves the live source;
user reloads to pick up). Consider committing the grey-race + guards.

## PENDING DECISION (do NOT implement until the particle question above is settled)
User picked **"Additive glow for black-diffuse luminous"** — render surfaces that
are luminous AND near-black-diffuse as additive+transparent+depthWrite-off (soft
glow instead of solid box), narrow enough to spare lava/lifestones. BUT the
user's follow-up ("are you displaying the particle effects") suggests this may be
the WRONG fix if the real issue is a missing particle effect. **Settle the
particle question first.**

---

## REFERENCE MATERIAL (mined this session)
- **Memory `reference_chorizite_render_semantics_2026-06-20`** — acclient/WB C#
  truth: opacity=1−translucency (ours correct); **luminosity = FLAT emissive
  (lum,lum,lum), NOT texture-modulated** (ours deviates — attaches diffuse as
  emissiveMap, materials.js ~1242/2272); palette = surface OrigPaletteId base +
  ObjDesc SubPalette SHIFT on top; scenery ≤1/vertex noise<freq; particle texture
  from gfxobj Surfaces[0], additive iff `Surfaces[0].Type.Additive`.
- **`external/ParticleViewer/`** (gmriggs, VENDORED this session) — full C#
  particle render pipeline: `ParticleEmitterInfo(0x32) → HWGfxObjID → GfxObj →
  Surfaces[0] → Textures[0] (ColorValue→1×1 swatch, else SurfaceTexture)`,
  rendered as billboard, `opacity=1−CurTranslucency` (`==1 → NoDraw`), additive
  from surface flag. ObjDesc/palette NOT applied to particles. White box =
  Surfaces[0] white/missing or `ColorValue==0xFFFFFFFF`. Key files:
  `ACParticle/Physics/Particles/ParticleEmitter.cs`, `Model/GfxObj.cs:68-99`,
  `Render/Render.cs:53-129`, `Physics/PhysicsPart.cs:137-156`.
- **Memory `reference_ac_discord_dev_insights`** (updated) — OptimShi: MotionTable
  CreateParticle hooks → 0x32 emitters; Vermino: particles are a "set texture
  color" from emitterinfo, NOT a separate texture field; **OptimShi: "Palette data
  gets lost… just swap an equipped item to reset it"** (known retail appearance
  failure mode). trevis was "missing animations and objdesc overrides."
- `external/chorizite/ACBindings` (decompiled acclient), `external/ACE`,
  `external/melt/ACE.DatLoader`, `external/DatReaderWriter`.

## OTHER OPEN LEADS (lower priority)
- **SubPalette parse** — doll `subPalettes` decode to `[0x04000DC0, offset 0,
  length 0]` (a length-0 no-op dye). Suspicious; possible wire-subpalette
  offset/length parse bug (would mis-dye every subpalette monster). Verify vs ACE
  `CObjDesc`/DatReaderWriter subpalette format.
- **Luminosity emissiveMap deviation** — we texture-modulate luminosity via
  emissiveMap; retail is flat (lum,lum,lum). On the NON-paletted path this makes
  us dimmer; on the PALETTED path no emissiveMap is attached → flat white (the
  box). Aligning to flat-emissive is the systemic-correct behavior.
- **hwGfxObjId==0 fallback** — `particle_emitter.js:119` skips the emitter when
  `hwGfxObjId==0`; ParticleViewer falls back to `GfxObjId`. Causes MISSING
  particles (not white boxes).

## CDP REPRO
1070 Chrome over CDP **port 9333** (tunnel `ssh -fN -L 9333:127.0.0.1:9333
young@100.127.215.75` — already up); app tab at `http://127.0.0.1:18765/...`
(reverse `-R 18765` to laptop serve.py). chrome-devtools MCP: `list_pages` →
`evaluate_script`. Read getters via `window.liveScene3d` (entityManager.entityMap,
materialCache.{materials,palettedMaterials}, _worldParticleManager/_staticParticleManager).
Reload (`?nosw=1`) to pick up JS edits; A/B with `?particleUnlit=off`,
`?pvsRingRadius=1`. User uses the live client — prefer read-only probes (they
paused a visibility-toggle test mid-session).

## Related memory
[[reference_chorizite_render_semantics_2026-06-20]], [[reference_ac_discord_dev_insights]],
[[project_holtburger_white_objects_lighting_2026-05-30]], [[project_animation_root_cause_2026-06-18]],
[[reference_ac_re_artifacts]], [[reference_chorizite_org]].
