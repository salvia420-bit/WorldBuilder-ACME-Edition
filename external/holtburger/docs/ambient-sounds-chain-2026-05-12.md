# Ambient sounds — `CRegionDesc` → terrain → STB → SoundTable → Wave chain

**Date:** 2026-05-12
**Status:** RESEARCH COMPLETE — implementation NOT YET STARTED.
**Why this doc exists:** User asked for town-specific positional ambient sound from
**real DAT data only**. We confirmed via PhatSDK source that there IS a complete
DAT-driven chain, anchored at `CRegionDesc`, that feeds positional ambient sounds.
This doc maps the full chain, what we already parse, what's missing, and the
minimum work to land "I can hear the forge and the wind in Holtburg".

The doc is structured to be consumed cold by a team agent. Each section names
specific files and line ranges so an agent can verify every claim by reading the
cited source. Don't trust this doc on faith — read the C++ + the schema.

## Intent

A player walks into Holtburg town. Within a few seconds they should hear:

- An always-present background ambient (wind, distant town hum) — biome-driven.
- Periodic positional FX (bird chirp from a tree, fountain water from a fountain,
  forge crackle from each forge) — driven by terrain + scene + per-entity data.

Both layers exist in retail DAT. Neither is hardcoded. Both flow from data
attached to `Region 0x13000000`. This doc shows the chain end-to-end so a team
agent can build the wasm + JS bridge that turns DAT bytes into PannerNode plays
through our existing `AudioManager` (H3-D).

We already shipped:

- **Wave (0x0A) parser + `fetchWave` wasm export + AudioManager** (commit `fde41e8`).
  Browsers can decode + position-play any Wave DID via `AudioManager.play(did, pos)`.
- **Region SoundDesc parser** (`crates/holtburger-dat/src/file_type/region.rs`,
  the `SoundDesc` + `AmbientSTBDesc` + `AmbientSoundDesc` structs around lines
  322-380). Region 0x13000000 carries 37 STBs that ship cleanly through this
  parser.

The missing piece is the **resolver bridge** that connects:

```
terrain id at player position
  → SceneType                     (we parse this)
    → stb_index                   (we parse this — but never resolve)
      → AmbientSTBDesc            (we parse the array — never indexed)
        → stb_id (SoundTable DID) (we have the field — never looked up)
          → SoundTable file (0x20xxxxxx) (NOT YET PARSED)
            → Sounds[Sound enum]  (NOT YET RESOLVED)
              → Wave DID(s)
                → AudioManager.play (we have)
```

## The chain — concrete

### Step 1: `CRegionDesc` carries `sound_info` and `terrain_info`

**Source:** `external/GDL/PhatSDK/RegionDesc.h:247, RegionDesc.cpp:276-309`.

```cpp
// RegionDesc.cpp:276 — unpack of CRegionDesc
sound_info = new CSoundDesc;
UNPACK_OBJ_READER(*sound_info);
// ...
scene_info = new CSceneDesc;
DWORD num_scene_types = reader.Read<DWORD>();
scene_info->scene_types.grow(num_scene_types);
for (DWORD i = 0; i < num_scene_types; i++)
{
    CSceneType *sceneType = new CSceneType();
    int stb_index = reader.Read<int>();
    sceneType->sound_table_desc = (stb_index != -1)
        ? sound_info->stb_desc.array_data[stb_index]   // ← LOAD-BEARING
        : NULL;
    sceneType->UnPack(&reader);
    scene_info->scene_types.add(&sceneType);
}
// ...
terrain_info = new CTerrainDesc();
```

**Key invariant:** the `stb_index` (one per SceneType in SceneDesc) is the
INDEX into `CSoundDesc::stb_desc` (the SoundDesc's 37-entry STB array). A
value of `-1` means "no ambient sounds for this scene type". A value of `≥0`
points at one specific AmbientSTBDesc.

**Our parser already reads `stb_index`** at
`crates/holtburger-dat/src/file_type/region.rs:391-399`
(`SceneType::unpack` → `stb_index: u32`). **Bug to fix:** the parser reads
it as `u32` (so -1 wraps to `0xFFFFFFFF`); should be `i32` to preserve the
sentinel. Trivial fix.

### Step 2: `AmbientSTBDesc` carries a SoundTable DID + ambient entries

**Source:** `external/GDL/PhatSDK/SoundDesc.h:5-32`.

```cpp
class AmbientSoundDesc {
public:
    SoundType stype;          // Sound enum value (0x46-0x4D = Ambient1-8)
    int is_continuous;        // ← DERIVED, NOT WIRE — see below
    float volume;             // 0..1
    float base_chance;        // 0..1 — probability each rate-window fires
    float min_rate;           // seconds (lower bound between fires)
    float max_rate;           // seconds (upper bound)
};

class AmbientSTBDesc : public PackObj {
public:
    DWORD stb_id = 0;                            // ← SoundTable DID (0x20xxxxxx)
    int stb_not_found = 0;                       // diagnostic
    SmartArray<AmbientSoundDesc *> ambient_sounds;
    class CSoundTable *sound_table = NULL;       // ← resolved via stb_id lookup
    unsigned int play_count = 0;                 // runtime
};

class CSoundDesc : public PackObj {
public:
    SmartArray<AmbientSTBDesc *> stb_desc;       // ← the array indexed by stb_index
};
```

**`is_continuous` gotcha** (`SoundDesc.cpp` AmbientSoundDesc unpack):

```cpp
sound->stype = (SoundType) pReader->Read<int>();
sound->volume = pReader->Read<float>();
sound->base_chance = pReader->Read<float>();
sound->is_continuous = sound->base_chance == 0.0f;   // ← DERIVED
sound->min_rate = pReader->Read<float>();
sound->max_rate = pReader->Read<float>();
```

`is_continuous` is **NOT IN THE WIRE FORMAT**. It's a derived flag set
client-side when `base_chance == 0.0`. Treat `base_chance == 0` as
"continuous loop (always playing)", non-zero as "roll the dice every
`(min_rate, max_rate)` seconds and fire if `random() < base_chance`".

Our parser at `region.rs::AmbientSoundDesc::unpack` (line 333-342) reads
the 5 wire fields correctly. We just need to compute `is_continuous`
from `base_chance` JS-side (or expose it as a derived field on the wasm
mirror).

### Step 3: Terrain → which SceneType the player is on

**Source:** `external/GDL/PhatSDK/RegionDesc.h:103-115`,
`RegionDesc.cpp:99-145`.

```cpp
class CTerrainType : public PackObj {
public:
    PString terrain_name;                          // "Grassland", "LushGrass", etc.
    RGBAUnion terrain_color;
    SmartArray<CSceneType *> scene_types;          // ← multiple scene types per terrain
};

class CTerrainDesc {
public:
    LandSurf *land_surfaces = NULL;
    SmartArray<CTerrainType *> terrain_types;      // indexed by terrain id (vertex's type)
};
```

Each terrain type has N **scene types**. The active scene type at a
given (x, y) world coord depends on a deterministic hash of position
(`CTerrainDesc::GetScene` — `RegionDesc.cpp:131`) which we DON'T need
for sound purposes; we just need the chosen scene type's
`sound_table_desc`.

**Holtburg specifics** — see existing memory
`project_holtburger_skybox_done_2026-05-11` and the
`region_1_first_day_groups_sky_object_gfx_object_ids_have_gfx_obj_prefix`
test: retail Dereth Region `0x13000000` has 37 STBs and N terrain
types. The terrain types most relevant for Holtburg are
`LushGrass` (terrain code 3, 42% of Holtburg vertices) and `Grassland`
(code 1, 22%) per the `describe-landblock` survey at
`docs/holtburg-coverage-survey-2026-05-12.md`. Each of those terrain
types has a list of scene types, and each scene type's
`stb_index → AmbientSTBDesc` is the ambient sound bank for grass.

**Our parser reads CTerrainType + CSceneType + scene_types lists**
(`region.rs:578-625`). What we DON'T have is a runtime that picks the
active scene type at a given (x, y).

### Step 4: SoundTable (0x20xxxxxx) lookup — NOT YET PARSED

**Source:** `external/DatReaderWriter/DatReaderWriter/dats.xml`
(grep `<type name="SoundTable"`):

```xml
<type name="SoundTable"
      text="DB_TYPE_STABLE in the client."
      parent="DBObj"
      first="0x20000000" last="0x2000FFFF"
      flags="DBObjHeaderFlags.HasId">
  <field name="HashKey" type="int"/>
  <field name="_numHashes" type="int"/>
  <vector name="Hashes" length="_numHashes" type="Dictionary"
          genericKey="uint" genericValue="SoundHashData"/>
  <field name="_numSounds" type="int"/>
  <vector name="Sounds" length="_numSounds" type="Dictionary"
          genericKey="Sound" genericValue="SoundData"/>
</type>

<type name="SoundData">
  <field type="uint" name="_numEntries"/>
  <vector name="Entries" length="_numEntries"
          type="List" genericValue="SoundEntry"/>
  <field type="int" name="Unknown"/>
</type>

<type name="SoundEntry">
  <vector name="Id" type="QualifiedDataId" genericValue="Wave"/>  <!-- Wave DID -->
  <field type="float" name="Priority"/>
  <field type="float" name="Probability"/>
  <field type="float" name="Volume"/>
</type>
```

**This file type has no parser yet.** It needs a Rust struct + binrw
unpack at `crates/holtburger-dat/src/file_type/sound_table.rs`
(naming + style mirror `wave.rs` from H3-B commit `fde41e8`). The
shape is small — maybe 80-100 LoC of parser, 30-40 LoC of tests, one
retail probe against `0x20000041` (one of the STB IDs surfaced by the
SoundDesc dump).

The schema's `<vector type="Dictionary">` annotation is the same one
`PhysicsScript`'s ScriptData uses — a count-prefixed list of
(key, value) pairs. See `holtburger-dat/src/file_type/physics_script.rs`
for the read pattern that Sky-J P2 (`b499411`) shipped.

**Schema-vs-wire gotcha to verify on first read** (same caveat as
ParticleEmitter — see
`crates/holtburger-dat/src/file_type/particle_emitter.rs` header):
`SoundEntry.Id` is annotated as `<vector type="QualifiedDataId">` but
on the wire it's a scalar `u32` (QualifiedDataId.Unpack reads exactly
one DWORD). Test the first parse against ACE's `SoundTable.cs` to
confirm.

### Step 5: Putting it all together — what plays when

For each per-tick (or per-second) ambient tick at player position
`(px, py, pz, landblock_id)`:

1. From `landblock_id` derive (`lbX`, `lbY`) and the vertex terrain
   types (we already do this for terrain rendering — see
   `apps/holtburger-web/scene3d/terrain.js`).
2. For each unique terrain type touching the player's surroundings,
   look up `CTerrainType::scene_types[k]` for some k chosen by
   position hash (see step 3 — pick any scene type for now; refine
   later).
3. The scene type has `sound_table_desc` (an `AmbientSTBDesc`).
4. For each `ambient_sounds[i]` (5 numbers — `stype`, `volume`,
   `base_chance`, `min_rate`, `max_rate`):
   - If `base_chance == 0.0` → loop forever (start once, never stop
     while this STB is active).
   - Else, roll a timer in `[min_rate, max_rate]` seconds. When the
     timer fires, `random() < base_chance` → play; else reset timer.
5. To play, look up the parent `AmbientSTBDesc.stb_id` → fetch
   SoundTable. Get `Sounds[stype]` → `SoundData` (a weighted list of
   `SoundEntry`). Pick one entry by `Probability`-weighted random.
   Get the entry's Wave DID. Call `AudioManager.play(waveDid, ...)`.

For **non-positional sounds** (the "town-wide hum"), playback is at
the listener position (no PannerNode attenuation). For
**positional sounds** (forge crackle at the forge), the SAME chain
applies but the PARENT is the entity (forge weenie) and the lookup
key is the entity's `SOUND_TABLE_DID` (PropertyDataId 3) — **not**
the Region's SoundDesc. See "Entity-anchored sounds" below.

### Entity-anchored sounds — a parallel chain

The user clarified 2026-05-12: "Sound effects of anything are set
via the `SOUND_TABLE_DID` (3) and point to a `0x20...` item."

For per-entity sounds (forge crackle, fountain water, NPC speak),
the entity's weenie property `PropertyDataId::SoundTable` (= 3) holds
a SoundTable DID. The trigger isn't a per-tick ambient roll — it's
either:

- An **animation hook** during the entity's idle animation
  (MotionTable → Animation → AnimationFrame.hooks contains
  `Sound` (hookType 1) or `SoundTable` (hookType 2) entries that fire
  at specific keyframes).
- An **ACE-pushed `GameMessageSound`** event when the server triggers
  an action (e.g. craft, /lifestone). See ACE source
  `ACE.Server/WorldObjects/Hotspot.cs`, `Switch.cs`, `PressurePlate.cs`
  for examples of `EnqueueBroadcast(new GameMessageSound(...))`.

**Both paths** route through the same SoundTable resolver: hook fires
a `Sound` enum, we look it up in the entity's SoundTable, get the
Wave DID, play.

Probed example (Alchemy Forge wcid `30465`, verified 2026-05-12):

```
type=1 (Setup):              0x0200124C
type=2 (MotionTable):        0x090000CB
type=3 (SoundTable):         0x20000014   ← LOAD-BEARING
type=4 (CombatTable):        0x3000001E
type=8 (Icon):               0x060036E1
type=22 (PhysicsScriptTable): 0x3400002A
```

When the forge's idle animation plays and a SoundTable hook fires
with `Sound.Ambient1`, look up the forge's SoundTable `0x20000014`,
find the entry for `Sound.Ambient1`, play that Wave at the forge's
world position via PannerNode.

## What our parser does today (verified)

| Piece | File / Line | Coverage |
|---|---|---|
| Region 0x13 → SoundDesc | `region.rs:367-379` | ✅ Reads stb_desc array |
| Region 0x13 → AmbientSTBDesc | `region.rs:345-364` | ✅ stb_id + ambient_sounds[] |
| Region 0x13 → AmbientSoundDesc | `region.rs:322-343` | ✅ 5 wire fields; ⚠️ missing derived `is_continuous` |
| Region 0x13 → SceneDesc + SceneType | `region.rs:385-417` | ⚠️ `stb_index: u32` — should be `i32` (preserves -1 sentinel) |
| Region 0x13 → TerrainDesc + TerrainType + scene_types | `region.rs:578-625` | ✅ Reads structure |
| Entity weenie → SoundTable DID (PropertyDataId 3) | `holtburger-common/src/properties/world_object.rs::stable_id()` | ✅ Accessor exists |
| AnimationHook → Sound (type 1) + SoundTable (type 2) | `setup_model.rs::AnimationHook::read:48-93` | ✅ Decoded; ⚠️ never executed during animation playback |
| **SoundTable file (0x20xxxxxx)** | — | ❌ NOT PARSED — biggest gap |
| **SoundTable wasm export** | — | ❌ NOT EXPOSED |
| **JS-side SoundTable resolver / cache** | — | ❌ NOT BUILT |
| **Per-tick ambient roller** | — | ❌ NOT BUILT |
| **AnimationMixer hook execution** | — | ❌ NOT BUILT (`entities.js` runs mixers but ignores hooks) |
| **ACE `GameMessageSound` → audio** | — | ❌ NOT WIRED |

## Implementation tasks

### Task A — SoundTable (0x20) parser

Path: `crates/holtburger-dat/src/file_type/sound_table.rs`.

Reference:

- Schema: `external/DatReaderWriter/DatReaderWriter/dats.xml`, grep
  `name="SoundTable"` for the type and `name="SoundData"` +
  `name="SoundEntry"` for the inner structs.
- Style model: `crates/holtburger-dat/src/file_type/wave.rs` (commit
  `fde41e8`) — same RIFF-but-not-quite-RIFF small parser shape.
  Or `physics_script.rs` (commit `b499411`) for the Dictionary read
  pattern.
- Cross-check: `external/ACE/Source/ACE.DatLoader/FileTypes/SoundTable.cs`
  if present; the ACE C# unpack is the authoritative byte order.

Wire layout (verify the QualifiedDataId scalar gotcha on first
parse — see `particle_emitter.rs` header for the `<vector>` schema
quirk):

```
[u32 id]
[i32 hash_key]
[i32 num_hashes]
[(u32 key, SoundHashData value) × num_hashes]
[i32 num_sounds]
[(u32 sound_enum, SoundData value) × num_sounds]

SoundData:
  [u32 num_entries]
  [SoundEntry × num_entries]
  [i32 unknown]

SoundEntry:
  [u32 wave_did]
  [f32 priority]
  [f32 probability]
  [f32 volume]
```

`SoundHashData` schema isn't critical for ambient playback; minimal
viable parser can skip-read it. Document and defer.

Test plan:

- Round-trip 100% of retail `0x20000000..=0x2000FFFF` records (mirror
  `particle_emitter.rs::probe_retail_particle_emitter_chain`).
- Targeted: `0x20000014` (forge), `0x20000041` (one of the Region's
  STBs from the sound dump), `0x20000080`/`0x200000B3` (other STBs).
- For `0x20000014` (forge SoundTable), assert that `Sounds[Sound.Ambient1]`
  (Sound enum 0x46) exists and returns at least one `SoundEntry`
  whose `wave_did >> 24 == 0x0A`.

Also add `DatFileType::Audio`-style entry to `mod.rs` (already there
for Audio; add a `SoundTable = 0x20` if not). Check `manifest.rs::logic_only()`
keep-set — add SoundTable if not present.

### Task B — wasm export `fetchSoundTable`

Path: `apps/holtburger-web/src/lib.rs` (add alongside `fetchWave`,
`fetchPhysicsScript` from H3-C / Sky-J P3).

Mirror the existing pattern:

```rust
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct SoundTableJs { /* getter for id, hash_key, num_sounds */ }

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl SoundTableJs {
    /// Resolve a Sound enum value to a list of (wave_did, priority,
    /// probability, volume) entries. Returns empty array if no
    /// mapping for that enum.
    #[wasm_bindgen(js_name = entriesForSound)]
    pub fn entries_for_sound(&self, sound_enum: u32) -> Vec<JsValue> { /* ... */ }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(js_name = fetchSoundTable)]
pub async fn fetch_sound_table(did: u32) -> Result<SoundTableJs, JsValue> {
    // same prefetch + parse pattern as fetchWave / fetchPhysicsScript
}
```

Also plumb through `index.html` (see commit `db2abfa` for the
recurring failure mode where a new wasm export is invisible to
`init3D` because index.html's destructure-and-pass block doesn't
list it — a team agent will NEED to update index.html or
`fetchSoundTable` will silently be `undefined` despite being in the
wasm).

### Task C — JS SoundTable cache + resolver

Path: `apps/holtburger-web/scene3d/audio/sound_table_cache.js` (new
file alongside the H3-D `audio_manager.js`).

Mirror `MaterialCache`:

- `get(did) -> Promise<SoundTableJs>` — caches per-DID
- `resolveSound(did, sound_enum) -> {waveDid, volume, …}` — picks
  one entry by `probability`-weighted random
- `preload([dids])` — bulk fetch

### Task D — Per-tick ambient roller

Path: `apps/holtburger-web/scene3d/audio/ambient_runtime.js`.

Per rAF or per 100ms timer, for each currently-active
AmbientSTBDesc (driven by player's terrain type):

```
foreach ambient_sound in stb.ambient_sounds:
  if !ambient_sound.timer_active:
    schedule timer for random([min_rate, max_rate])
    ambient_sound.timer_active = true
  on timer expire:
    if base_chance > 0 && random() >= base_chance:
      reset timer
      return
    sound_table = await soundTableCache.get(stb.stb_id)
    entry = soundTableCache.resolveSound(stb.stb_id, ambient_sound.stype)
    audioManager.play(entry.waveDid, listenerPos, { gain: ambient_sound.volume * entry.volume })
    reset timer
```

Determining the player's terrain type: read the LB heightmap +
terrain types we already have via `fetch_terrain_textures` (see
`apps/holtburger-web/src/lib.rs::fetch_terrain_textures` and the
JS terrain renderer's vertex sampler). The active terrain type at
(px, py) is the type of the closest vertex (or interpolated; doesn't
matter for ambient — sample one corner).

Then `Region.terrain_info.terrain_types[terrain_code]` gives the
list of CSceneTypes. Pick the first one (or hash position for
determinism). That CSceneType's `stb_index` selects the
AmbientSTBDesc from `Region.sound_info.stb_desc[stb_index]`.

### Task E — AnimationMixer hook execution

Path: `apps/holtburger-web/scene3d/entities.js` (extend the existing
EntityManager).

Today's `entities.js` runs an `AnimationMixer` per entity but doesn't
fire `AnimationFrame.hooks`. The hooks include `Sound` (1),
`SoundTable` (2), `CreateParticle` (13), `SoundTweaked` (21), and
others (see `setup_model.rs::AnimationHook::read:48-93` — 26 hook
types decoded).

For sound execution:

1. When `EntityManager.spawn` builds the rig + clip, ALSO bake a
   timeline of `(time_in_clip, hookType, hookData)` entries from
   each `AnimationFrame.hooks`.
2. Per rAF: for each entity, compute the current clip time. If a
   hook in the bake fell between `lastTime` and `currentTime`, fire
   it.
3. For `Sound` (hookType 1): hookData is a Wave DID — play directly
   via `audioManager.play(waveDid, entity.rig.position)`.
4. For `SoundTable` (hookType 2): hookData is a Sound enum value.
   Look up the entity's SoundTable (`entity.meta.stableId` —
   plumbed through the spawn-meta in commit `4bd7217`'s clone +
   toMeta pipeline; add a new field `soundTableDid` mirroring the
   `physicsScriptDid` plumbing). Resolve enum → wave, then play.

### Task F — ACE `GameMessageSound` event handler

Path: `apps/holtburger-web/src/lib.rs` (recv-loop handler) +
`apps/holtburger-web/scene3d/entities.js` (apply side).

ACE pushes `GameMessageSound(guid, Sound.X, scale)` for triggered
actions. The wire opcode + parser need verifying via
`external/holtburger/crates/holtburger-protocol/src/messages/`. On
recv:

1. Look up the entity GUID's `soundTableDid` (in JS-side entityMap).
2. Resolve the Sound enum via SoundTable cache.
3. Play the wave at the entity's world position.

This unlocks: forge crafting sound (when ACE sends craft event),
lifestone bind sound, switch activation, hotspot triggers, etc.

## Validation strategy

### Unit level (cargo test)

- `sound_table.rs::probe_retail_forge_sound_table` — parse 0x20000014,
  assert `Sounds[Sound.Ambient1].entries[0].wave_did >> 24 == 0x0A`.
- `sound_table.rs::probe_all_retail_sound_tables` — round-trip every
  0x20xxxxxx record cleanly.
- Region `is_continuous` derived flag — assert that for at least one
  entry with `base_chance == 0.0`, `is_continuous()` returns true.

### Integration (Playwright capture)

Mirror `/mnt/wbterminal1/diag_h3.cjs`:

1. Login + spawn in Holtburg.
2. Sample `audioManager.playCount` initially.
3. Wait 60 seconds.
4. Assert `playCount > 0` (ambient sounds fired).
5. Inspect the cache: `soundTableCache.get(0x20000014)` resolves to a
   table with Sound.Ambient1 entries pointing at 0x0A.. waves.

### Live test (user-side ear)

- Walk into Holtburg outdoor area.
- Within ~10 seconds, hear bird/wind/ambient sounds.
- Walk near a forge.
- Hear forge-specific crackle (path E — animation hook).
- Activate a switch (path F).
- Hear the activation sound.

## Risks & open questions

1. **Terrain-to-SceneType chooser is unspecified.** PhatSDK's
   `CTerrainDesc::GetScene(terrain_id, scene_type_id, scene_index)`
   takes both scene_type_id and scene_index — so retail had a
   position-hash function picking which scene type at each (x, y).
   The hash function isn't decompiled. Practical workaround: pick
   `scene_types[0]` for each terrain type and accept that we have
   one ambient per terrain instead of per-position variation. Tune
   later if needed.

2. **`stb_index = -1` (no ambient for this scene type)** is real wire
   data. Our parser stores it as `u32` (so -1 → 0xFFFFFFFF). Fix to
   `i32` and treat as "no sounds" sentinel — Task A scope.

3. **SoundTable's `SoundHashData`** semantics are unknown. The
   `Hashes` dictionary is separate from `Sounds`. Hashing for what?
   Probably name-keyed audio paths or a string-table for client UI
   sound references. Safe to skip-read on first parse; revisit if
   anything breaks.

4. **`CSoundTable` in PhatSDK has `play_count = 0`** — runtime
   tracking. PhatSDK probably tracked "have I started this continuous
   loop yet?" via this. Our JS runtime needs an equivalent
   `_continuousActive: Set<sound_enum>` to avoid double-starting
   loops on every tick.

5. **`GameMessageSound` opcode wire format** isn't checked yet.
   Confirm via `external/holtburger/crates/holtburger-protocol/`
   that we have a parser; if not, Task F adds it.

6. **The user pushed back on "stuff you can't see/hear"** — heavy.
   This entire chain is data-grounded; verify each parse against a
   real DAT byte sequence and each resolve against a known weenie's
   SoundTable. Don't ship "should work" without empirical confirmation.
   See `feedback_no_partial_demos` memory.

## Memory + pointers

- `crates/holtburger-dat/src/file_type/region.rs:322-625` — current
  SoundDesc + SceneDesc + TerrainDesc parsers
- `crates/holtburger-dat/src/file_type/setup_model.rs:37-101` —
  AnimationHook decoder (reusable for hook execution)
- `crates/holtburger-dat/src/file_type/wave.rs` (commit `fde41e8`) —
  parser style model
- `crates/holtburger-dat/src/file_type/physics_script.rs` (commit
  `b499411`) — Dictionary read pattern model
- `apps/holtburger-web/scene3d/audio/audio_manager.js` (commit
  `fde41e8`) — Web Audio runtime, ready to receive `play(waveDid, pos)` calls
- `apps/holtburger-web/scene3d/sky_dome.js` (commit `5618579`) —
  Sky-J P5 chain walker, the pattern Task D/E should mirror for
  SoundTable resolution
- `apps/holtburger-web/src/lib.rs:13896-14013` (commit `a44794f`) —
  fetchPhysicsScript / fetchParticleEmitter — the pattern Task B
  should mirror
- `apps/holtburger-web/index.html:516-559` (commit `db2abfa`) —
  wasm-export destructure + init3D opts. **Task B WILL need to update
  this block or the wasm export will be invisible to scene3d** —
  failure mode that blocked Sky-J/H2/H3 from being visible for hours.

## Per-task agent prompts (copy/paste)

### For Task A agent

> Write `crates/holtburger-dat/src/file_type/sound_table.rs` parsing
> the AC SoundTable (0x20xxxxxx) DAT file type. Schema in
> `external/DatReaderWriter/DatReaderWriter/dats.xml`, grep
> `<type name="SoundTable"`. The schema is:
> `[u32 id, i32 hash_key, i32 num_hashes, dict[u32 → SoundHashData],
> i32 num_sounds, dict[u32 sound_enum → SoundData]]`. Each `SoundData`
> is `[u32 num_entries, SoundEntry × num_entries, i32 unknown]`. Each
> `SoundEntry` is `[u32 wave_did, f32 priority, f32 probability,
> f32 volume]`.
>
> Style model: `crates/holtburger-dat/src/file_type/wave.rs`. Dictionary
> read pattern model: `physics_script.rs::PhysicsScript::unpack`.
> Schema `<vector type="QualifiedDataId">` is a scalar `u32` on the
> wire — see `particle_emitter.rs` doc comment for the gotcha.
>
> Test: open `/home/wbterminal/projects/RetailSmoke/dats/base/client_portal.dat`,
> parse 0x20000014 (forge sound table — confirmed retail weenie attribute),
> assert `Sounds[0x46]` (Sound.Ambient1) returns non-empty entries with
> wave DIDs in 0x0A range. Also iterate ALL 0x20000000..=0x2000FFFF
> records and assert 100% parse success.
>
> Don't touch mod.rs; integration is separate. Don't add wasm exports;
> that's Task B. Just the Rust parser + test.

### For Task B agent (after Task A lands)

> Add `fetchSoundTable(did) → SoundTableJs` wasm export to
> `apps/holtburger-web/src/lib.rs`, mirroring `fetchWave` /
> `fetchPhysicsScript` (commits `fde41e8` and `a44794f`). The JS-side
> struct should expose:
> - `id`, `numSounds`, `numHashes` getters
> - `entriesForSound(sound_enum_u32) → Array<{ waveDid, priority,
>   probability, volume }>` — returns the entries for that Sound enum
>   (empty array if not present)
>
> CRITICAL: ALSO update `apps/holtburger-web/index.html` lines 516-559
> to import `fetchSoundTable` and pass it through to `init3D` opts.
> Without this, the wasm export is invisible to scene3d — same failure
> mode that blocked Sky-J / H2 / H3 for hours before commit `db2abfa`.

### For Task D agent (after A+B+C land)

> Write `apps/holtburger-web/scene3d/audio/ambient_runtime.js`. Drives
> Region.SoundDesc-keyed ambient sound playback per-tick. Reads the
> player's terrain type via the existing `fetch_terrain_textures`
> derivation (sample the LB vertex at player position), maps to
> `Region.terrain_info.terrain_types[code].scene_types[0]`, gets that
> SceneType's `stb_index`, looks up `Region.sound_info.stb_desc[stb_index]`
> (AmbientSTBDesc), iterates its `ambient_sounds[]` array, manages
> per-sound timers + probability rolls per the
> `[min_rate, max_rate, base_chance]` triple, and on fire calls
> `audioManager.play(waveDid, listenerPos)` with the
> resolved Wave DID from `soundTableCache.resolveSound(stb_id, stype)`.
>
> Handle `base_chance == 0.0` as continuous (start once, never stop
> until STB context changes). Don't double-start continuous loops.
>
> Tick from `scene3d/index.js`'s rAF loop alongside the existing
> `tickPerFrame` invocation. Bail when listener is indoors
> (`isCurrentCellIndoor()`); indoor ambient is a separate code path
> (EnvCell sounds) not covered by this task.

See also (related memory + docs):

- `project_holtburger_skybox_done_2026-05-11`
- `project_holtburger_sky_j_done_2026-05-12`
- `project_holtburg_h2_h3_done_2026-05-12`
- `reference_ac_dat_file_types`
- `docs/sky-particles-p5-integration-plan.md`
- `docs/holtburg-coverage-survey-2026-05-12.md`
