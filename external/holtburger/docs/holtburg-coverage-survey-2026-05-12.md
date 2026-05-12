# Holtburg coverage survey — 2026-05-12

Probed retail Holtburg (LB `0xA9B4`, lbX:169, lbY:180) via
`describe-landblock` + targeted `weenie-snapshot` calls. Cross-
referenced each contents class against what `holtburger-web`
currently renders.

## What's in Holtburg (raw)

- **126 static objects**, broken down:
  - 64 Prop, 23 Scenery, 20 Furniture, 12 Structure, 5 Creature, 1 Interactive_Portal, 1 Unknown
- **12 buildings** (4 two-story, 4 three-story, 4 misc) with **123 interior cells** (the 17-cell Meeting Hall is one of them)
- **106 ACE spawns** (all `generator: Static`), broken down:
  - 64 Object, 27 Creature, 15 Npc
- **23 doors** (wcid 412)
- **30+ unique named NPCs**: Buckminster, Alcott, Pathwarden Thorolf, Royal Guard, vendors (Monyra, Renald, Wilomine, Fispur, Ecutha, Sedor, Thelnoth, Sontella, Ianto, Asenala, Gawain, Tirenia, Dwennon, etc.), Archmage Cindrue, Contract Broker, Wedding Planner, Tailor's Apprentice, Apprentice Alchemist, Sean the Speedy, Rand the Game Hunter, Worcer, Alfrin, Ealdred, …
- **5 forges**: Alchemy, Fletching, Cooking, Lockpick, Salvaging (all wcid 30460–30467)
- **9 generators / FX sources**:
  - Cow Generator (wcid 385)
  - Fireworks Generator (wcid 19457) — **particle effect**
  - April 2003 Raining Mad Cows (wcid 23631) — historical event
  - Holiday Planner Generator, Pumpkin Buffer Generator, Holiday Planner (80022/80225)
  - 4× Linkable Monster Generator (wcid 7923, 7924, 1154)
- **4 portals**:
  - Holtburg Meeting Hall Portal (wcid 6096)
  - Destroyed Portal to Redspire (wcid 11960)
  - Mannikin Foundry Portal (wcid 19717)
  - Portal to Town Network (wcid 43065)
- **2 stones**: Life Stone (wcid 509), Bind Stone (wcid 27547)
- **Furniture / props**: Well, Beer Keg, Chests, Lanterns (Lantern wcid 42227 = SetupModel 0x020001BC), Bottle, Helm and Shield, Pedestal Weak Spot, Nullified Statue of a Drudge, etc.

## What we currently render (verified)

| System | State | Where |
|---|---|---|
| Terrain (heightmap + LB texture) | ✅ | `fetch_landblock_heightmap` + `fetch_terrain_textures` |
| Buildings (0x02 SetupModel multi-part) | ✅ | Phase 6A `fetchBuildingPlacement` + Phase 6B sweep AABBs |
| Interior cells (0x0D EnvCell + 0x0E Environment) | ✅ | Phase 6C `populateCellContainersForLandblock` |
| Cell-graph indoor flip | ✅ | Phase 6D `isCurrentCellIndoor` / `outdoorContainer.visible` |
| Doors (DoorState rotation) | ✅ | Phase 6E `WorldEvent::DoorStateChanged` + sprite rotation |
| Static objects placement | ✅ | `fetch_landblock_objects` returns N `ObjectPlacement` per LB |
| Per-SetupModel lights (point/spot) | ✅ | Phase 7.6.1 `SetupLight` from `SetupModel.lights` HashMap |
| Sky dome + 0x01 GfxObj celestials | ✅ | Sky-I-B `skyCell` |
| Sky lighting (sun/ambient/fog) | ✅ | Sky-C `SkyLightingController` |
| Sky **particles** (0x02 anchor → PhysicsScript → emitter) | ✅ (Sky-J) | `sky_dome.js::_attachParticleChainFromState` + `scene3d/particles/*` |
| Entities (NPCs, creatures) — rig + animation | ✅ | Phase 7.4b `entities.js` EntityManager + AnimationMixer |
| Combat-mode toggle | ✅ | backtick keypress |
| Walk + run cycle bake | ✅ | `EntityCycleSet`, motion-table fps |

## What's MISSING for full Holtburg fidelity

| Gap | Impact in Holtburg | Effort |
|---|---|---|
| **In-world entity particles** — entity's `default_script_id` (PropertyDataId 30) → PhysicsScript → CreateParticleHook → emitter is not walked. Sky-J's ParticleManager is reusable; just needs a hook at ObjectCreate time. | Fireworks Generator's rockets, Life Stone glow, Bind Stone glow, fire on torches/lanterns, magical glow on weenies, spell FX — invisible. | **~1-2 days.** Parallel to Sky-J P5 but anchored on entity position instead of sky-cell origin. |
| **Wave / Audio (0x0A) playback** — no parser for the Audio file type, no AudioContext wiring. SoundTweakedHook fires sound but nothing plays. | Town ambience (footsteps, NPC voices, market noise), spell sounds, fireworks bangs — all silent. | **~3-5 days.** Parser + Web Audio API integration + 3D positional sound. |
| **Non-Particle PhysicsScript hooks** — we PARSE all 26 hook types but only CreateParticle is executed. SoundTweaked (sound trigger), CallPES (recursive PES — needed for weather), SetOmega (rotation animation), TextureVelocity (animated textures, e.g. spinning windmill blades), Transparent (fade ghosts/illusions) all no-op. | Lantern flame doesn't flicker (Transparent), portal swirls don't rotate (SetOmega), weather rain doesn't chain (CallPES → 0x33000429), magical sparkles silent (SoundTweaked). | **~2-4 days.** Each hook type is 5-30 lines of JS in the manager. |
| **Particle effects on generator-spawned entities** — Fireworks Generator (wcid 19457) is a weenie that the ACE server uses to spawn N firework rockets per cycle. The rockets arrive via ObjectCreate with PhysicsScript. Currently the rocket's pscript is stored on the entity property bag but `entities.js::spawn` doesn't walk it. | Fireworks Generator at (65, 156) silent + invisible animation. | **Covered by gap 1 above.** |
| **NPC visibility live-verify** — entities.js is wired but I haven't confirmed all 30+ Holtburg NPCs actually arrive via ObjectCreate when player is in-LB. ACE delivers them on visibility events; the client needs to handle each. | If broken: empty town. | **30 min** to live-capture + grep. |
| **Static object visual quality** — Phase 6A renders static placements as flat sprites/billboards (per emit-dynamic-site model). 3D `?renderer=3d` mode might use 3D meshes for these — uncertain. | Furniture (beer keg, chests, well) may look off. | **Verify via live screenshot.** |
| **Portals (wt=7)** — 4 portals in Holtburg. The portal mesh is a SetupModel with an animated swirl texture (TextureVelocityHook). Without TextureVelocity execution they're static. Click-to-teleport works via game logic; the visual is the gap. | Portals don't shimmer/spin. | **Covered by gap 3 above** (TextureVelocity hook). |
| **Lantern flame** — Lantern's SetupModel (0x020001BC) is a static 0.6m mesh. The flame is either: (a) a child SetupLight (covered by Phase 7.6.1) or (b) a child Animation with CreateParticleHook fired on play. Unknown which retail uses without a deeper probe. | Holtburg has lanterns visible but flames are static / missing. | **2 hours** to probe + write a fix. |

## Plan — ordered by ROI

### Phase H1 — Verify what already works live (~1 hour, no code changes)
Run a live capture session in Holtburg. Confirm:
1. NPCs (Buckminster, Alcott, Pathwarden) render via Phase 7.4b
2. Doors (23 of them) open/close
3. Static objects (Well, Beer Keg, lanterns) appear in the right places
4. Phase 7.6.1 lights (lantern lights, building lights) light up at night
5. Sky-J moon particles attached (the log line from P5)

Output: a punch list of what's _actually_ broken vs what we _think_ works.

### Phase H2 — In-world entity particles (~1-2 days)
**The big win.** Reuses Sky-J P4 ParticleManager — same parser, same runtime, different invocation. Hook into entities.js's spawn flow:

```js
// In entities.js::spawn or a follow-on chain walker
if (entity.physicsScriptDid && entity.physicsScriptDid !== 0) {
  const ps = await fetchPhysicsScript(entity.physicsScriptDid);
  for (const e of ps.takeEntries()) {
    if (e.hookType === 13 || e.hookType === 26) {
      const emitter = await fetchParticleEmitter(e.createParticleEmitterId);
      particleManager.addEmitter({
        emitterInfo: emitter,
        parent: entity.rig,  // <-- different from sky: anchor to entity
        partIndex: e.createParticlePartIndex,
        parentOffset: ...,
      });
    }
  }
}
```

Concrete validation: the **Fireworks Generator** spawns rocket entities at (65, 156) — those rockets should leave particle trails when this lands.

Side-benefit: Sky-J's open coord-frame question gets a partial answer — if entity-anchored particles render correctly, that's evidence that the sky-cell-origin coord-frame is wrong (interpretation b from Sky-J docs).

### Phase H3 — Wave/Audio (0x0A) playback (~3-5 days)
Parser + Web Audio API wiring. Each SoundTweakedHook fires a `Wave.play()` at 3D world position. Phase 1: positional ambient sounds (waves on coast, fountain, fire). Phase 2: NPC voice triggers on Sound hooks. Phase 3: spell + combat sounds.

### Phase H4 — Non-Particle PhysicsScript hooks (~2-4 days)
Implement the runtime for: SoundTweaked, TextureVelocity, SetOmega, Transparent, NoDraw, SetLight, CallPES (recursive), Scale, Diffuse, Luminous. Each is small. **CallPES recursion unlocks the weather DayGroup particles** (rain/snow) from Sky-J P6 carry-forward.

### Phase H5 — Portal swirls + lantern flames + spell FX (~1-2 days)
Specific visual polish powered by H2+H4: portal TextureVelocity, lantern Transparent flicker, magical glow on Life Stone / Bind Stone. Mostly capture-script-driven QA.

## Open questions (need user input)

1. **Priority among H2/H3/H4?** H2 (entity particles) is the most visible single change. H3 (audio) is high-impact but the parser + Web Audio plumbing is its own architectural project. H4 (non-particle hooks) is small individually but spread across 8+ hook types.
2. **Are NPCs actually rendering today?** Phase 7.4b looks complete but I haven't seen a live capture. Phase H1 verifies this in 30 min — should I run it?
3. **Sky-J coord-frame fix.** The user said "we spent enough hours on the skybox" — so skip the eye-test resolution for now? Or fold it into H2 (entity particles) which will surface a related coord-frame learning?

See also: [[project_holtburger_sky_j_done_2026-05-12]],
[[project_emit_dynamic_site]], [[reference_ac_dat_file_types]].
