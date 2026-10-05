# Handoff for the next agent (2026-05-26)

This session shipped **18 waves / 54 phases** building out the combat-rendering vertical (melee + missile + magic trifecta) from foundation parsers through end-to-end VFX. The system is now retail-quality where the data exists, with graceful placeholder fallbacks everywhere else. The next agent will work on the **movement system and beyond** — many of the same data sources, tooling patterns, and ACE/retail conventions apply.

## Read first

- `external/holtburger/docs/cmt-fixes-plan-2026-05-26.md` — the master plan with all 54 phases, their findings, and the wave-by-wave results. Worth skimming the headers if you're picking up the combat thread.
- `external/holtburger/docs/magic-casting-audit-2026-05-26.md` (Wave 13) — example of a comprehensive audit doc style.
- `external/holtburger/docs/physicsscript-bridge-research-2026-05-26.md` (Wave 15) — example of cross-source research with retail+ACE citations.
- `external/holtburger/docs/sneak-fp-measurement-2026-05-26.md` (Wave 12) — example of a "no-ACE-mod-needed-after-all" investigation.

## Repo layout (verified by 54 phases)

| Path | Contents |
|---|---|
| `/home/wbterminal/WorldBuilder-ACME-Edition` | Git repo root |
| `external/holtburger/` | The subtree we work in |
| `external/holtburger/apps/holtburger-web/` | Web app (JS + wasm consumers) |
| `external/holtburger/apps/holtburger-web/src/lib.rs` | The wasm crate's main file (~30k lines) |
| `external/holtburger/apps/holtburger-web/scene3d/` | Three.js renderer + entity manager |
| `external/holtburger/apps/holtburger-web/ui/` | JS facades over wasm exports |
| `external/holtburger/apps/holtburger-web/plugins/` | UI plugins (combat-bar, vitals-hud, etc.) |
| `external/holtburger/apps/holtburger-web/data/` | Committed lookup JSON (motion names, spell shapes, etc.) |
| `external/holtburger/apps/holtburger-web/scripts/` | One-shot generator scripts (Python + Node) |
| `external/holtburger/apps/holtburger-web/test_*.mjs` | Standalone unit test files |
| `external/holtburger/crates/holtburger-dat/` | DAT file parsers |
| `external/holtburger/crates/holtburger-protocol/` | Wire protocol pack/unpack |
| `external/holtburger/crates/holtburger-common/` | Shared types (enums, property keys) |
| `external/holtburger/crates/holtburger-world/` | World state + handlers |
| `external/holtburger/crates/holtburger-core/` | CLI client |
| `external/holtburger/docs/` | Audit + handoff docs |

## Reference repos (read-only)

| Path | Purpose |
|---|---|
| `/home/wbterminal/ace-server/Source/` | Primary ACE source — the canonical server reference |
| `/home/wbterminal/WorldBuilder-ACME-Edition/external/ACE/Source/` | Vendored ACE (don't modify permanently; user said temporary mods OK for investigation) |
| `/home/wbterminal/ac-headers/acclient.c` | Retail decomp (~31MB, 938k lines, Hex-Rays); search for class methods like `CPhysicsObj::*` |
| `/home/wbterminal/ac-headers/acclient.h` | Retail headers (348 enums + 6,936 structs) |
| `/home/wbterminal/WorldBuilder-ACME-Edition/external/chorizite/` | Chorizite — retail offsets + plugin SDK; ACBindings has Hex-Rays C# of all retail classes |
| `/home/wbterminal/WorldBuilder-ACME-Edition/external/DatReaderWriter/` | Third-party DAT parser; **dats.xml is OFTEN WRONG** — use only as a tester |

## AC data sources

| Path | Use |
|---|---|
| `~/ac_base_dats/client_portal.dat` | Retail portal DAT (use for parity tests via `HOLTBURGER_PORTAL_DAT=...`) |
| `~/ac_base_dats/client_cell_1.dat` | Cell DAT for landblock data |
| `external/LSD-Partial-2025-02-23_16-15/weenies/` | Weenie templates (gear stats, spells, NPCs). Spot-check via `grep` for specific WCIDs or names |
| `external/LSD-Partial-2025-02-23_16-15/spells/` | Spell data (consumed by `data/spells-catalog.json` generator) |
| `external/acpedia/acpediaorg-20210615-wikidump/acpediaorg-20210615-history.xml` | 1.4 GB wiki XML; 53,964 pages. Use a streaming parser (lxml.etree.iterparse) — don't load it all |
| `/mnt/wbterminal1/ac-refs/ac-data-repo/asheron.fandom.com/` | Fandom wiki dump (parallel to acpedia; user prefers fandom when they specify it) |

## Tooling that works

### Validation
```bash
# JS syntax
node --check path/to/file.js

# Run a JS unit test (always from repo root)
cd /home/wbterminal/WorldBuilder-ACME-Edition && node external/holtburger/apps/holtburger-web/test_X.mjs

# Rust check (single crate)
cd external/holtburger && export PATH="$HOME/.cargo/bin:$PATH" && cargo check -p holtburger-web --target wasm32-unknown-unknown

# Wasm build (touches src/lib.rs)
cd external/holtburger/apps/holtburger-web && wasm-pack build --target web --out-dir pkg --dev

# Parity test against retail DAT
cd external/holtburger && export PATH="$HOME/.cargo/bin:$PATH" HOLTBURGER_PORTAL_DAT="$HOME/ac_base_dats/client_portal.dat" && cargo test -p holtburger-dat --test <test_name>

# All combat-rendering tests at once
cd /home/wbterminal/WorldBuilder-ACME-Edition && for t in test_ac_aim_level_for_velocity test_ac_attack_type_for_weapon test_ac_damage_rating test_ac_spell_shape test_ac_spell_cast_sequence test_play_effect_resolver; do node external/holtburger/apps/holtburger-web/$t.mjs 2>&1 | tail -2; done
```

### Cargo path

`cargo` is at `$HOME/.cargo/bin/cargo` — needs `export PATH="$HOME/.cargo/bin:$PATH"` before invocation.

### Disk pressure

System disk fluctuates 85–96%. Write scratch / logs to `/mnt/wbterminal1/tmp/claude-scratch/`.

### Git workflow

- Single repo (`WorldBuilder-ACME-Edition` master). NOT a submodule despite the `external/` path.
- Origin: `https://github.com/salvia420-bit/WorldBuilder-ACME-Edition.git`
- Commit pattern: `feat(holtburger-web): <subject>` with multi-paragraph body
- Always `cd /home/wbterminal/WorldBuilder-ACME-Edition` before `git add` (else paths break)

## The three-source cross-reference principle

For every claim about AC behavior, verify across:
1. **ACE** (`~/ace-server/Source/`) — server-authoritative reference
2. **acclient.c** (`~/ac-headers/`) — retail decomp (truth for client behavior)
3. **DRW** (`external/DatReaderWriter/`) — third-party tester (often wrong on schema)

ACE > DRW for DAT parsing. acclient.c > ACE for retail-specific client behavior. **DRW dats.xml has frequent errors** — Phase 43 caught 4 of them in `SpellComponentsTable` alone (Icon shape, Lead Scarab Gesture, late-era scarab range, missing cast gestures).

## Critical patterns established

### Three-struct threading (Wave 6 Phase 15)
Adding a new per-weapon / per-entity property surfaced through wasm:
1. Add field to `WieldedWeaponEntry` (struct ~`src/lib.rs:14099`) — non-local entity cache
2. Add field to `EquippedWeaponJs` (~`src/lib.rs:14126`) — wasm-exported, with `#[wasm_bindgen(getter)]`
3. Add field to `InventoryItem` (~`src/lib.rs:13991`) — local-player twin
4. Populate from `entity.get_int_prop(PropertyInt::X)` or `get_float_prop(PropertyFloat::Y)` at 3 sites: `apply_inventory_object_create`, `entity_equipped_weapon`, `publish_player_inventory_snapshot`
5. Extend `scene3d/entities.js#getEquippedWeapon(guid)` on BOTH branches (local + non-local)

### Per-entity HashMap index (Wave 9 Phase 26 / Wave 16 Phase 50)
For per-entity data that the JS side queries by GUID:
```rust
struct SessionHandle {
    physics_script_table_index: Rc<RefCell<HashMap<u32, u32>>>,
    wielder_index: Rc<RefCell<HashMap<u32, Vec<WieldedWeaponEntry>>>>,
    projectile_index: Rc<RefCell<HashSet<u32>>>,
    // ...
}
```
Populated on `ObjectCreate`, updated on `UpdateObject`, pruned on `ObjectDelete`. Exposed via `entity_<thing>(guid)` wasm methods.

### Lazy-loaded JSON facade (Wave 5 Phase 12 / Wave 14 Phase 45)
JS modules under `ui/ac_*.js` that lazy-fetch a committed JSON, cache in module scope, expose sync accessors after first load:
```js
const cache = new Map();
let loadPromise = null;
export async function loadX() {
  if (loadPromise) return loadPromise;
  loadPromise = fetch('./data/x.json').then(r => r.json()).then(d => { cache.set(...); return d; });
  return loadPromise;
}
export function getX(id) { return cache.get(id) ?? null; }
```

### Plugin event bus (`__pluginClient.events`)
Cross-cutting events: `sneakAttackPredicted`, `spellCastInitiated`, `playEffect`, `damageDealt`, `damageTaken`, `playerStatsUpdated`. Subscribe via `client.events.on("X", handler)`; emit via `window.__pluginClient?.events?.emit?.("X", payload)`.

### Diag layer (`scene3d/diag/combat.js`)
- Per-feature counter object on `combat` accessor
- `summary()` returns counts only
- `snapshot()` returns full ring buffers
- `reset()` clears counters but preserves subscriptions

Surfaced via `window.__diag.combat.snapshot()` in console.

### DAT example dump (`crates/holtburger-dat/examples/`)
For ad-hoc DAT analysis: write a `dump_X.rs` mirroring `dump_cmt_ranged_rows.rs`. Compiles with the parser; runs via `cargo run -p holtburger-dat --example dump_X` with `HOLTBURGER_PORTAL_DAT` set.

### Vibe-pose placeholder + real-clip override (Waves 5 / 13)
Melee: `setSwingPose` (vibe-pose) → server's UpdateMotion → motion-table classifier → `setSwingMotion` overrides via tween-cancel. Same pattern for cast: `setCastPose` → `playCastSequence` → real scarab chain.

## Combat-rendering pipeline (what's wired end-to-end)

```
PLAYER CLICKS in magic stance
  → picking.js (line ~320) magic branch
    → sessionHandle.castTargetedSpell(guid, spellId)         [wire — ACE]
    → __pluginClient.events.emit("sneakAttackPredicted", …)  [Wave 16]
    → __pluginClient.events.emit("spellCastInitiated", …)    [Wave 9]
    → em.playCastSequence(localGuid, spellId)                [Wave 14]
      → for each scarab.Gesture in seq.windupGestures:
        → setSwingMotion(localGuid, gesture.motion)
        → await Promise(setTimeout(gesture.durationS * 1000))
      → setSwingMotion(localGuid, seq.castGesture.motion)
      → if (seq.casterEffect !== 0):
        → emit("playEffect", {targetGuid: localGuid, scriptId: casterEffect, speed: formulaScale})

SERVER BROADCASTS GameMessageScript (0xF755)
  → protocol crate decode → WorldEvent::PlayEffect
  → recv loop dispatches ClientEvent kind=30
  → index.html drainEvents → __pluginClient.events.emit("playEffect", …)
  → play_effect_vfx.js → _onPlayEffect
    → if (em.getPhysicsScriptTableDid(targetGuid) !== 0):
      → fetchPhysicsScriptTable(did)             [Wave 16 Phase 49]
      → pickScriptEntry(entries, speed)          [acclient.c:336552 weighted pick]
      → fetchPhysicsScript(scriptDid)
      → for each CreateParticle entry:
        → fetchParticleEmitter(emitterId)
        → wm.addEmitter({emitterInfo, parent: inst.root, partIndex, offsets})
      → setTimeout(2500ms, destroyParticleEmitter)
    → else: placeholder Three.js sphere/cube/torus burst (170/174 IDs covered)
```

## Combat coverage matrix (status at handoff)

| Subsystem | Coverage |
|---|---|
| Melee swings (local + remote, all stances) | Complete via CMT + motion-table |
| Missile attacks | Complete with gravity-arc prediction + per-weapon `MaximumVelocity` + fast-missile 1.2× |
| Magic casting | Complete: scarab windup chain + cast gesture + casterEffect |
| Sneak attack prediction | 90° rear hemisphere; melee + missile + magic; FP measurement via `AttackConditions::SneakAttack` |
| Recklessness UI band | 10–90% active band with skill-level tooltip |
| DR HUD | Predicted rollup (base + sneak + reckless) + last-hit damage row |
| Spell shape preview | All 8 shapes (Bolt/Arc/Streak/Volley/Wall/Ring/Blast/Self) overlay on cast |
| PlayScript VFX | 170/174 (97.7%) with placeholders; remaining 4 are unused enum sentinels |
| Real AC particles via PhysicsScript | Live for entities with `physicsScriptTableDid`; placeholder fallback elsewhere |
| **TargetEffect for spell hits** | **BLOCKED** — needs SpellId on `damageTaken` wire (ACE doesn't broadcast it today). Would benefit 5442/6266 spells. |

## Movement system — pointers for the next agent

The movement vertical has prior work but isn't as deeply built as combat. Per memory:

| Memory item | Relevance |
|---|---|
| `project_3d_camera_game_feel_done_2026-05-11.md` | 3D camera + movement shipped; coords `acToThree` / `threeToAc`; `PlayerTeleport` wasm-arm fix |
| `project_wave3a_done_2026-05-19.md` | Wave 3.A `physics-replay-trace` infrastructure (1030-tick Holtburg probe; C# `CPhysicsObj::UpdateObjectInternal` port; Playwright per-tick capture) |
| `project_wave3f_done_2026-05-19.md` | Wave 3.F pure-prediction shadow closes W3.A's gap; **5/5 PASS at maxDrift 0.04–0.09m**; OracleSim integrates with tick-count-driven sub-stepping |
| `project_wave3bc_done_2026-05-19.md` | `physics-jump-formula` (acclient.c:343343) + `motion-classify-swing` |
| `project_academy_rubberband_diagnosis.md` | Indoor per-poly walls + floor raycast + cell-AABB safety net |
| `project_holtburger_envcell_vs_building.md` | AC indoor geometry: EnvCells (123 cells / 12 buildings) vs SetupModel (outdoor objects) |
| `project_holtburger_jump_done_2026-05-16.md` | ACE `GetJumpHeight` formula + ballistic local prediction + `GameAction::Jump (0xF61B)` wire |
| `project_holtburger_entity_collision_done_2026-05-16.md` | Cylinder collision + `PhysicsState` draw-gate; BSP-poly + wasm radius pop deferred |
| `project_holtburger_godmode_falldamage.md` | Persistent fall-damage bug; try `/god` or `/godly` admin command |

### Key movement files
- `external/holtburger/apps/holtburger-web/src/lib.rs` — wasm side has physics + position updates
- `external/holtburger/crates/holtburger-world/src/` — physics integration, position handlers
- ACE: `~/ace-server/Source/ACE.Server/Physics/` — physics engine
- acclient.c: search for `CPhysicsObj::*` (esp. `UpdateObjectInternal`, `enter_default_state`, `apply_gravity`)

### Movement-specific patterns to expect
- **Server-authoritative positions** via `PublicUpdatePosition` / `Update Position` opcodes
- **Client predicts** between server ticks (pure-prediction shadow via W3.F)
- **OracleSim** in C# computes expected client position; diag captures drift
- **Coords:** AC uses Z-up; Three uses Y-up; conversion via `acToThree(ac)` / `threeToAc(three)` (memory)
- **Landblocks:** 256m × 256m; cell IDs `XXYYxxxx`; landblock prefix `0xFE`; cells `0xFD`
- **PhysicsState bitmask** drives many behaviors: `MISSILE = 0x40` (Wave 10 Phase 30), `HIDDEN`, `INELASTIC`, etc.

## Property key reference (verified in this session)

### PropertyInt
- 1 = ItemType
- 9007 = CurrentWieldedLocation (equip slot mask)
- 47 = AttackType (W_AttackType bitmask) ← **NOT 45** as DRW says
- 48 = WeaponSkill
- 353 = WeaponType ← **NOT 89** as DRW says

### PropertyFloat
- 22 = DamageVariance
- 23 = CurrentPowerMod
- 24 = AccuracyMod
- 26 = MaximumVelocity
- 61 = WeaponOffense (to-hit, NOT damage)
- 62 = WeaponOffense (per ACE; conflicts with our notes — re-verify if used)
- **63 = DamageMod** ← Wave 10 Phase 29 caught the plan's typo (was "62")
- 92 = PowerLevel (NOT 86 as RynthSuite says)
- 93 = AccuracyLevel (NOT 87 as RynthSuite says)

### MotionStance (low-16)
- `0x003c` = HandCombat
- `0x003e` = SwordCombat
- `0x003f` = BowCombat
- `0x0040` = SwordShieldCombat
- `0x0041` = CrossbowCombat
- `0x0044` = TwoHandedSwordCombat (catches ALL TwoHanded weapons; `TwoHandedStaffCombat = 0x45` is dead per Phase 22)
- `0x0046` = DualWieldCombat
- `0x0047` = ThrownWeaponCombat
- `0x0049` = Magic
- Ranged set: `[0x003f, 0x0041, 0x0043, 0x0047, 0x00e8, 0x00e9, 0x013b, 0x013c]`

### DAT file type prefixes (from memory)
- 0x01 Model, 0x02 SetupModel, 0x03 Animation, 0x04 Palette
- 0x05 SurfaceTexture, 0x06/0x07 Texture, 0x08 Surface
- 0x09 MotionTable, 0x0A Audio, 0x0D EnvCell, 0x0E Table
- 0x0E00000E SpellTable, 0x0E00000F SpellComponentsTable
- 0x10 Clothing, 0x12 Scene, 0x13 Region
- **0x30 CombatManeuverTable** (this session)
- 0x31 LanguageString, 0x32 ParticleEmitter, **0x33 PhysicsScript**, **0x34 PhysicsScriptTable**
- 0x40 Font, 0xFD IndoorCell, 0xFE Landblock, 0xFF LandblockInfo

## Anti-patterns / pitfalls

1. **Don't trust DRW dats.xml schema** — verify against ACE.DatLoader + retail bytes. We caught 7+ divergences in Phase 23+.
2. **Don't assume something is unsurfaced** — Wave 16 surprised us twice: `petable_id` and `default_phstable_id` were both already parsed, just never consumed. Grep before adding.
3. **Don't trust RynthSuite enum values** — multiple cases where their constants disagreed with ACE+our own (PowerLevel = 86 vs 92, AccuracyLevel = 87 vs 93). Cross-check.
4. **Don't trust audit-doc claims without source-of-truth** — the Lead Scarab "exempt from HasWindupGestures" was a misnomer; the actual retail mechanism is `Gesture = MotionCommand.Invalid (0x80000000)` which the cast pipeline silently filters.
5. **Don't trust the plan's PropertyInt/Float numbers** — Phase 29 caught the plan saying "62" when it should've been "63". Always cross-check ACE's enum file directly.
6. **Don't skip `cd` to repo root for git** — `git add` from `external/holtburger/` will fail with "did not match any files" because the working dir's relative paths don't match repo paths.
7. **Don't poll for harness-tracked work** — when a background command or agent completes, you're notified. No `sleep` loops.

## Validation cheat sheet

After ANY change:
```bash
# JS
node --check <files>

# Run a unit test
cd /home/wbterminal/WorldBuilder-ACME-Edition && node external/holtburger/apps/holtburger-web/test_X.mjs

# Wasm
cd external/holtburger && export PATH="$HOME/.cargo/bin:$PATH" && cargo check -p holtburger-web --target wasm32-unknown-unknown

# DAT parity
cd external/holtburger && export PATH="$HOME/.cargo/bin:$PATH" HOLTBURGER_PORTAL_DAT="$HOME/ac_base_dats/client_portal.dat" && cargo test -p holtburger-dat
```

If wasm built: confirm new methods in `pkg/holtburger_web.d.ts`. The d.ts file is regenerated; grep for the JS-name to confirm.

## Recent commits this session

Latest is `56817b8f` (Wave 18). Previous waves: `0bd0e3e8`, `0b50e404`, `06945623`, `9072b2c2`, `c69b0ae0`, `cf37e6d6`, `de1bcbb3`, `872ec047`, `f0762d87`, `f6c4d8cc`, `17b51bb2`, `b27bd5eb`, `7af758e5`, `c0f65cc8`, `90322d44`, `10796322`, `0bd0e3e8`. All on `master`, all pushed to `origin`.

## Final advice

- **Don't re-investigate things this session already settled.** The cmt-fixes-plan-2026-05-26.md doc has all the findings indexed by phase.
- **Match the established testing pattern.** New features get a `test_X.mjs` next to the prior 6.
- **Match the diag pattern.** New telemetry goes through `window.__diag.<area>.snapshot()`.
- **Movement is partially built.** Read the W3.A / W3.F / camera memory files before diving in — there's existing physics-replay infrastructure to extend.
- **Cite file:line everywhere.** Future agents grep your citations to verify. We caught real bugs because prior agents cited their sources.

Good luck.
