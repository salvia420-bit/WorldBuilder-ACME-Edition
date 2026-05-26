# PhysicsScript Bridge Research (Wave 15 / Phase 48, 2026-05-26)

Investigation of how server-broadcast `PlayScript` IDs (Launch, Explode,
Splatter…) map to actual retail `PhysicsScript (0x33)` particle systems,
so Wave 16+ can replace the placeholder Three.js spheres in
`scene3d/play_effect_vfx.js` with real AC VFX.

**Headline finding.** `PlayScript` is a *PER-ENTITY-INDIRECT* lookup —
the server only ever broadcasts the enum value, and **the client
resolves it through the entity's own `PhysicsScriptTable` (DAT type
0x34)** to land on a concrete `PhysicsScript (0x33)`. There is no
global PlayScript→PhysicsScript map. Two entities can play different
particle systems for the same `PlayScript.Launch` because they carry
different `PhysicsScriptTable` DIDs in their `Setup (0x02)` /
`PhysicsDesc`.

---

## §1 acclient.c — the PlayEffect handler chain

The retail opcode dispatch and full call chain (every line is
`/home/wbterminal/ac-headers/acclient.c`):

1. **0xF755 dispatch:** `392796` (`case 0xF755u:`) →
   `CM_Physics::DispatchSB_PlayScriptType` at `709614`. The sibling
   opcode `CM_Physics::DispatchSB_PlayScriptID` at `709942` is the
   raw-DID path (server sends a `PhysicsScript` DID directly, bypassing
   the PScriptType resolver — used for emotes/world-script hooks, not
   for normal `GameMessageScript`).
2. **Smart-box re-entry:** `SmartBox::HandlePlayScriptType` at
   `143375-143392`. Looks up the entity via
   `CObjectMaint::GetObjectA(object_id)` (`143382`). If absent →
   `QueueBlobForObject` (defers until the entity exists; relevant for
   our race-with-ObjectCreate case). If present → calls
   `CPhysicsObj::play_script((PScriptType)script_type, mod)`.
3. **The lookup:** `CPhysicsObj::play_script(PScriptType, float)` at
   `320326-320348`:
   ```c
   v5 = this->physics_script_table;     // (320335) per-ENTITY table
   if ( v5 ) {
     PhysicsScriptTable::GetScript(v5, &result, script_type, mod);
     result = CPhysicsObj::play_script_internal(this, result);
   }
   ```
   No table → no script plays. The entity holds its own
   `PhysicsScriptTable*`.
4. **Outer hash lookup:** `PhysicsScriptTable::GetScript` at
   `336931-336957`. Bucket = `type % m_numBuckets`, walks
   `m_hashNext` until `m_hashKey == type` (i.e. matches the
   `PScriptType` enum value). On miss it returns a sentinel
   (`stru_8444D0.id`) → no playback.
5. **Inner weighted pick:** `PhysicsScriptTableData::GetScript(mod)`
   at `336552-336581`. Iterates `script_array.m_data` and **picks the
   first entry where `mod <= entry->mod`** (i.e. the entries are sorted
   by mod and `mod` is a *threshold*, not a discrete key). This is the
   `Formula.Scale`-driven LOD picker — different cast strengths
   (Strength Self I vs VIII) can resolve to different PhysicsScripts.
6. **The actual playback:** `CPhysicsObj::play_script_internal(DID)`
   at `318035-318067`. Allocates a `ScriptManager` if needed, then
   `ScriptManager::AddScript(script_id)` at `329124-329139`. AddScript
   does `DBObj::Get(QualifiedDataID(script_id, 0x2B))` — DAT type
   `0x2B = PhysicsScript` per QDID convention — then
   `AddScriptInternal(PhysicsScript*)` and `ScriptManager::UpdateScripts`
   ticks it per frame walking each `PhysicsScriptData::Hook` at its
   `StartTime` offset.

**The table is loaded from `Setup`**. `CPhysicsObj::InitWithSetup`
around `320886-320900` reads `setup->default_phstable_id.id` and does
`physics_script_table = DBObj::Get(QualifiedDataID(id, 0x2C))` — DAT
type `0x2C = PhysicsScriptTable`. There is also a per-`PhysicsDesc`
override at `322321-322331` (sent over the wire on
`PublicWeenieDesc`/object-create — the server can swap the table at
runtime).

## §2 ACE broadcast logic

Server-side, the choice of `PlayScript` ID is hard-coded per game-event
and the table-resolution work is entirely the client's responsibility.
Key sites in `~/ace-server/Source/ACE.Server/WorldObjects/`:

- `WorldObject.cs:688` `ApplyVisualEffects(PlayScript effect, …)` and
  `WorldObject.cs:695` `PlayParticleEffect(PlayScript effectId, …)` —
  thin wrappers that emit `new GameMessageScript(Guid, effectId, speed)`.
- `WorldObject_Magic.cs:358-365` — caster gets `spell.CasterEffect`,
  target gets `spell.TargetEffect`, both with `spell.Formula.Scale` as
  the mod / intensity.
- `WorldObject_Magic.cs:1833` — projectiles (multi or single) get
  `PlayScript.Launch` with `sp.GetProjectileScriptIntensity(spellType)`.
- `Monster_Combat.cs:316,411` — hits dispatch a *directional* splatter
  via `(PlayScript)Enum.Parse("Splatter" + height + dir)`.
- `Player_Magic.cs:879,917` — fizzle uses literal `PlayScript.Fizzle`
  at speed 0.5f.
- `WorldObject.cs:727,900` — `PlayScript.Create` / `PlayScript.Destroy`
  for spawn/despawn.

The wire packet itself
(`Source/ACE.Server/Network/GameMessages/Messages/GameMessageScript.cs`):
```
opcode 0xF755 PlayEffect (SmartboxQueue):
  WriteGuid(targetGuid)
  Write(uint32 scriptId)        // enum value — NOT a DID
  Write(float speed)            // mod for the inner weighted pick
```
So the server **only ever sends the `PScriptType` enum value**.
`PhysicsScriptTable.GetScript()` in
`ACE.Server/Physics/Scripts/PhysicsScriptTable.cs:15-18` is a stub that
returns 0 — ACE doesn't pick the concrete DID at all, by design. That
work belongs to the client (and to us).

## §3 PhysicsScript / Table DAT shape (confirm)

Already parsed by `external/holtburger/crates/holtburger-dat/src/file_type/{physics_script.rs, physics_script_table.rs, particle_emitter.rs}`. ACE-side
shape (mirrors our Rust):

- **PhysicsScript (0x33)** — `Id(u32)` + `List<PhysicsScriptData>` where
  `PhysicsScriptData = (double StartTime, AnimationHook Hook)`
  (`ACE.DatLoader/FileTypes/PhysicsScript.cs`,
  `ACE.DatLoader/Entity/PhysicsScriptData.cs`). Hooks include
  `CreateParticleHook`, `Sound`, etc. The runtime ticks `StartTime`
  offsets and fires the hooks (e.g. `CreateParticleHook` →
  `fetchParticleEmitter(emitter_id)`).
- **PhysicsScriptTable (0x34)** — `Id(u32)` +
  `Dictionary<uint PScriptType, PhysicsScriptTableData>` where
  `PhysicsScriptTableData = List<ScriptAndModData>` and
  `ScriptAndModData = (float Mod, uint ScriptId)`
  (`ACE.DatLoader/Entity/{PhysicsScriptTableData,ScriptAndModData}.cs`).
  Picker semantic = first entry whose `Mod >= incoming mod` (§1.5).

## §4 Existing JS particle runtime — capability assessment

`scene3d/particles/` (1185 LoC across `particle.js`,
`particle_emitter.js`, `particle_manager.js`, `particle_emitter_info.js`,
`time_rng.js`, `index.js`) is a faithful port of ACE's
`Source/ACE.Server/Physics/Particles/` (Sky-J P4, 2026-05-12). It
consumes **ParticleEmitterInfo POJOs** (or the wasm `ParticleEmitterJs`
struct) — one ParticleEmitter per `CreateParticleHook` in the
PhysicsScript. ALL 12 `ParticleType` cases are implemented; tests can
inject deterministic time/rng.

`scene3d/entities.js:3262-3269` already documents the end-to-end chain:
`entity.physicsScriptDid (0x33..) → fetchPhysicsScript → for each
CreateParticleHook → fetchParticleEmitter → particleManager.addEmitter`.
This is used for entity-attached scripts (rocket trail in flight, etc.)
and Sky-J firework debris.

**The gap.** What's NOT wired is the `PhysicsScriptTable` resolver.
The Rust crate parses 0x34, but `lib.rs` exposes
`fetch_physics_script` (0x33) and `fetch_particle_emitter` (0x32)
*only* — `grep "fetch_physics_script_table" src/lib.rs → 0 matches`.
Concretely, today there is no JS-accessible function that takes
`(table_did, PScriptType, mod) → PhysicsScript DID`.

## §5 The lookup mapping — concrete picture

```
                ┌──────────── server ────────────┐
GameMessageScript(target_guid, PlayScript.Launch, mod=1.0)  ← opcode 0xF755
                └────────────────┬───────────────┘
                                 │ wire
                ┌────────────────▼───────────────┐
                │  client looks up target_guid   │
                │  in CObjectMaint               │
                └────────────────┬───────────────┘
                                 │
            target.physics_script_table  (loaded from
            Setup.default_phstable_id OR PhysicsDesc.PhsTableID)
                                 │
   ┌─────────────────────────────▼─────────────────────────────┐
   │ PhysicsScriptTable[PScriptType=0x04 Launch]               │
   │   = [(mod=0.5, script_id=0x33000123),                     │
   │      (mod=1.0, script_id=0x33000124),                     │
   │      (mod=2.0, script_id=0x33000125)]                     │
   │   pick first where incoming_mod <= entry.mod              │
   └─────────────────────────────┬─────────────────────────────┘
                                 │ resolved PhysicsScript DID
                ┌────────────────▼───────────────┐
                │ fetchPhysicsScript →           │
                │   for each CreateParticleHook: │
                │     fetchParticleEmitter →     │
                │     particleManager.addEmitter │
                └────────────────────────────────┘
```

Two non-obvious consequences:

1. **A given `PlayScript.Launch` can render visually different particles
   depending on the entity.** A war-magic Lightning Bolt projectile
   carries a different `Setup.default_phstable_id` than a
   life-magic Drain Health Other projectile. Without the per-entity
   table, all Launches render identically — which is precisely the
   complaint that motivates this research.
2. **`speed` on the wire IS the `mod` for the picker.** Our wasm
   already plumbs `f32_payload: speed` through to JS
   (`play_effect_vfx.js:51`), but we ignore it
   (`play_effect_vfx.js:405-406` `void speed`). A real implementation
   has to feed it into `PhysicsScriptTableData::GetScript`.

## §6 Multi-projectile spell shapes (Volley / Wall / Ring)

Confirmed: the *visual* differentiation for Volley/Wall/Ring is
**entirely an emergent property of multi-projectile spawning**, not a
per-shape PhysicsScript variant. From
`Source/ACE.Server/WorldObjects/WorldObject_Magic.cs`:

- `:1509 CreateSpellProjectiles` reads `spell.NumProjectiles` (e.g.
  Volley = 3-5, Ring = 12-24, Wall = a grid via `DimsOriginX/Y/Z`).
- `:1569 CalculateProjectileOrigins` lays out positions using
  `spell.SpreadAngle`, `spell.CreateOffset`, and the dims (Ring uses
  the `SpreadAngle == 360` branch around `:1592`; Wall uses
  `:1602-:1613` `DimsOriginX/Y` grid; Volley uses the spread-angle
  cone path `:1677-:1680`).
- `:1833` — each successfully spawned projectile fires its OWN
  `ObjectCreate` AND its OWN
  `GameMessageScript(sp.Guid, PlayScript.Launch, …)`.

So a Volley of 5 fires:
- 5 × `ObjectCreate` for the projectile entities (each entity has the
  spell-projectile WCID's setup → its own `PhysicsScriptTable`)
- 5 × `GameMessageScript(0xF755, ProjectileGuidN, Launch, mod)`

On impact (`SpellProjectile.cs:90,110`), each projectile uses
`DefaultScriptId = PlayScript.ProjectileCollision` or `PlayScript.Explode`
and that fires when the projectile reaches its target.

**Wave 12's `spell_shape_preview.js` is correct** to render shape-
specific *predictive* overlays — but it's a UX hint only. The
authoritative N-projectile pattern emerges from N `ObjectCreate` +
N `Launch` script broadcasts.

## §7 Recommended Wave 16+ implementation plan

Concrete phases, in priority order. All assume Wave 15 has landed.

- **Wave 16 P49 — `fetchPhysicsScriptTable` wasm bridge.** Mirror the
  existing `fetchPhysicsScript` / `fetchParticleEmitter` exports in
  `apps/holtburger-web/src/lib.rs`. The Rust crate already parses
  0x34; this is purely a wasm-bindgen surface. Acceptance: JS can
  call `wasm.fetchPhysicsScriptTable(0x34000004) → { entries: Map<u32,
  ScriptAndModData[]> }`.

- **Wave 16 P50 — entity table caching.** Extend `EntityManager` (in
  `scene3d/entities.js`) to fetch + cache an entity's
  `PhysicsScriptTable` on first script event, keyed by the table DID.
  Currently `entity.physicsScriptTableDid` isn't pulled off the
  PhysicsDesc / setup at all — the wasm bridge in `src/lib.rs:13855+`
  exposes `physicsScriptDid` (the single 0x33 default) but not the
  table DID. Phase 50 also adds that getter.

- **Wave 16 P51 — replace `play_effect_vfx.js` placeholder with the
  resolver.** New `_onPlayEffect`: look up the target entity's
  `physicsScriptTable`, call its `GetScript(scriptId, speed)` (port
  the C# / acclient.c picker), then walk `fetchPhysicsScript →
  CreateParticleHook → fetchParticleEmitter → particleManager.addEmitter`
  exactly like `entities.js:3262-3269` already does. Keep the
  placeholder sphere/torus arms as a fallback for the
  table-missing case (still better than nothing).

- **Wave 16 P52 — extend spells-catalog.** Add `casterEffect`,
  `targetEffect`, `formulaScale` fields by re-running
  `scripts/build_spells_catalog.py` over LSD's `SpellBase`
  (the values are right there at LSD field offsets
  `CasterEffect/TargetEffect/FizzleEffect` — see ACE
  `Source/ACE.DatLoader/Entity/SpellBase.cs:36-38`). This lets the
  spellbook plugin pre-load PhysicsScripts for known spells so cast-
  to-render latency drops.

- **Wave 17 P53 — wire `mod` through.** `play_effect_vfx.js:405-406`
  currently discards `speed`. Plumb it into the `GetScript(mod)`
  picker so the right LOD/variant fires.

- **Wave 17 P54 — projectile-attached PhysicsScript on impact.**
  `SpellProjectile.DefaultScriptId = ProjectileCollision/Explode`
  (`SpellProjectile.cs:90,110`) means the projectile entity itself
  plays a script *on its own GUID* at impact. The existing
  `entities.js:3262` chain already handles entity-attached scripts;
  ensure projectile entities populate `physicsScriptDid`.

### Key surprises / risks

1. **`fetchPhysicsScriptTable` is the load-bearing missing piece.**
   Everything downstream (per-entity resolution, mod-driven LOD,
   spell-school differentiation) blocks on that one wasm export.
2. **`PhysicsDesc.PhsTableID` runtime override.** Some entities swap
   their table at runtime (acclient.c:322321-322331). Phase 50 has to
   listen for that on `appearance` / `update` messages, not just on
   ObjectCreate. Otherwise long-lived entities (player characters
   equipping a piece of gear with a new physics script) will play
   stale visuals.
3. **`PScriptType` retail name vs `PlayScript` ACE name.** Same enum,
   acclient `PScriptType` at `acclient.h:2626`, ACE
   `PlayScript : uint` at `ACE.Entity/Enum/PlayScript.cs:3`. Values
   match. Just be aware of the naming when reading retail decomp.
4. **Splatter directional resolution lives client-side too.** ACE
   computes `"Splatter" + height + dir` server-side and ships the
   resolved enum (`Monster_Combat.cs:316,410-411`), so no extra work —
   but each of the 12 Splatter IDs typically maps to a *different*
   PhysicsScript per-entity (different gore particle direction), so
   the placeholder collapse in `play_effect_vfx.js:457-467` is going
   to lose the directional info on the real-PhysicsScript path. Wave
   16 P51 should preserve it.
