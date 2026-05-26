# Spell-Data Inventory — Wave 13 / Phase 41

Authored 2026-05-26 by Agent AN. Wave 13 = magic casting audit.
Question: "We already have all spells documented (or do we?)"

Answer up front: **We have the spell catalog (6,266 records), but NOT the
per-spell windup/cast motion sequence.** Component IDs are in the catalog;
the Gesture field — the MotionCommand each component maps to — only
exists in the DAT's SpellComponentTable (0x0E00000F), which holtburger
has no parser for.

## §1 Data files in the repo today

All under `external/holtburger/apps/holtburger-web/data/`:

| File | Size | Records | Per-record fields | Source |
|------|------|---------|-------------------|--------|
| `spells-catalog.json` | 1.77 MB | 6,266 | name, school, level, untargeted, mana, icon, desc, duration (always 0), components ["Comp_N", …] | built from LSD-Partial by `scripts/build_spells_catalog.py:60-99` |
| `spell-shapes.json` | 281 KB | 6,266 | school, shape (Bolt/Arc/Streak/Volley/Wall/Ring/Blast/Self), level | derived from catalog by `apps/holtburger-web/scripts/gen-spell-shapes.cjs:213-239` |
| `spell-components.json` | 5.2 KB | 163 components | id → display name only | hand-extracted from DAT 0x0E00000F (per its `_comment`); NO Gesture, Type, Icon, Text, CDM, Time fields |

Catalog generator (`scripts/build_spells_catalog.py:74-84`) emits exactly
these 9 fields per spell — strips zero components, derives `untargeted`
from `SpellFlags.SelfTargeted = 0x8` (line 43), drops `duration` (always
0 because LSD nests it under `meta_spell.spell.duration`, see §4 below).
Shape classifier (`gen-spell-shapes.cjs:218-238`) buckets non-War/Void
into Self by default; covers 524 War+Void via 7 shape regexes (Bolt 129,
Arc 70, Streak 62, Volley 76, Wall 32, Ring 96, Blast 59).

## §2 DAT parsers in `crates/holtburger-dat`

**`spell_table.rs`** (243 LoC) parses **SpellTable (0x0E00000E)** with
binrw. `SpellBase` struct at `file_type/spell_table.rs:27-66` captures
24 retail fields including obfuscated `name`/`description`, `school`,
`icon_id`, `category`, `bitfield`, `base_mana`, `base_range_*`, `power`,
`spell_economy_mod`, `formula_version`, `meta_spell_type`, `meta_spell_id`,
8-entry `raw_components`, `caster_effect`, `target_effect`, `display_order`.
Type-dependent `extras` enum (lines 102-115) reads `Enchantment`
(duration/degrade) / `PortalSummon` (lifetime) / `None` based on
`meta_spell_type` — mirrors ACE.DatLoader logic
(`SpellBase.cs:78-89`). Tests at lines 207-225, 227-242 cover minimal
hash table + obfuscated-string round-trip.

**SpellComponentTable (0x0E00000F): NO PARSER EXISTS.** Verified by:
```
grep "SpellComponentsTable\|0x0E00000F" crates/holtburger-dat/src/**/*.rs
→ no matches
```
The `manifest.rs:70,105,235` only registers `SpellTable::FILE_ID`. The
`spell-components.json` file (§1) was hand-extracted upstream from
DatReaderWriter, not parsed by us.

**`spell_export.rs`** in `holtburger-tools` (302 LoC) exports SpellTable
records to JSON for tooling — captures only `Name|Description|School|
Category|Bitfield|BaseMana|BaseRange*|Power|RawComponents|ManaMod|FormulaVersion`
(line 17-31). Does not surface `caster_effect`, `target_effect`,
`meta_spell_*`, or extras.

## §3 ACE-side canonical spell data

| File | What it holds |
|------|---------------|
| `ACE.DatLoader/FileTypes/SpellTable.cs:11-27` | SpellTable container + `ComputeHash` + `GetSpellFormula` (lines 32-72) that randomizes per-account taper IDs via 3 formula versions |
| `ACE.DatLoader/Entity/SpellBase.cs:9-114` | Per-spell DAT struct (matches our Rust 1:1; `Formula = DecryptFormula(rawComps, Name, Desc)` at line 104 — XOR-key derived from name+desc hash) |
| `ACE.DatLoader/FileTypes/SpellComponentsTable.cs:8-79` | **163-component table at DID 0x0E00000F** — `GetSpellWords` (lines 37-78) joins herb+powder+potion components into the chant string |
| `ACE.DatLoader/Entity/SpellComponentBase.cs:5-29` | **`Gesture` field at line 11 — the load-bearing MotionCommand per component**. Type enum at SpellComponentsTable.cs:10-21 (Scarab=1, Herb=2, Powder=3, Potion=4, Talisman=5, Taper=6, +Pea variants) |
| `ACE.Server/Entity/SpellFormula.cs:245-263` | `WindupGestures` collects `(MotionCommand)scarab.Gesture` for every scarab in the formula |
| `ACE.Server/Entity/SpellFormula.cs:271-287` | `CastGesture` returns `(MotionCommand)talisman.Gesture` (last component, asserted-Type-5) |
| `ACE.Server/WorldObjects/Player_Magic.cs:605-646` | `DoWindupGestures` enqueues each `WindupGesture` sequentially via `EnqueueMotionMagic` (line 636). Skipped on `SpellFlags.FastCast` or weapon spells |
| `ACE.Server/WorldObjects/Player_Magic.cs:648-689` | `DoCastGesture` enqueues the cast motion after windup (line 685). `casterItem.UseUserAnimation` overrides if a wand/staff is equipped (lines 655-657) |
| `ACE.Entity/Enum/MotionCommand.cs:118-127` | **`MagicPowerUp01..10` (0x1000006F-0x10000078)** — the windup motions scarab.Gesture references. Cast gestures live in `MagicBlast/MagicHeal/MagicHarm/MagicEnchantItem/MagicPortal/MagicPray/MagicSelfHead/MagicSelfHeart/MagicBonus/MagicClap/MagicThrowMissile/MagicTransfer/MagicVision` (0x4000002B-0x40000039) |

Magic stance is `MotionStance.Magic = 0x80000049` (line 80). Cast speed
constant `Player_Magic.cs:603`: `CastSpeed = 2.0f`.

## §4 LSD spot-checks (5 representative spells)

Direct samples from
`external/LSD-Partial-2025-02-23_16-15/spells.json` (5.4 MB, 6,266 entries
under `table.spellBaseHash`):

| Spell | id | school | formula (8-slot) | base_mana | power | base_range | sp_type | extras |
|-------|----|--------|------------------|-----------|-------|------------|---------|--------|
| Strength Self I | 2 | 4=Creature | [1,7,33,44,60,0,0,0] | 15 | 1 | 0 | 1=Enchantment | spell.duration=1800.0, smod{key,type,val}, spellCategory |
| Heal Self I | 6 | 2=Life | [1,7,26,41,61,0,0,0] | 15 | 1 | 0 | 3=Boost | spell.dt, boost, boostVariance |
| Lightning Bolt I | 75 | 1=War | [1,15,34,40,55,0,0,0] | 5 | 1 | 30 | 2=Projectile | etype, baseIntensity, variance, wcid, numProjectiles, spreadAngle, verticalAngle, defaultLaunchAngle, bNonTracking, dims, peturbation, imbuedEffect, slayerCreatureType, critFreq, critMultiplier, ignoreMagicResist, elementalModifier |
| Whirling Blade I | 92 | 1=War | [1,15,34,47,55,0,0,0] | 5 | 1 | 30 | 2=Projectile | same shape as Bolt; differs only in `wcid` (projectile WCID) and `etype` |
| Nether Streak V | 5345 | 5=Void | [5,70,18,198,55,0,0,0] | 50 | 200 | 30 | 2=Projectile | scarab=Gold (5), talisman=55, last comp=198 Essence of Kemeroi |

**Note:** LSD-Partial has NO `spellComponentBaseHash` key (verified
`grep -oE '"[a-zA-Z_]+":' spells.json | sort -u` returns only spellBaseHash
+ per-spell sub-fields). LSD does not include the gesture lookup. The
catalog generator's `duration: 0` (line 82) skips LSD's nested
`meta_spell.spell.duration` — recoverable but unused.

The spot-checks confirm a key insight: **all War/Void Projectile spells
(Bolt, Whirling Blade, Volley, …) share the same `meta_spell.spell`
shape**. They differ only in `wcid`, `etype`, `baseIntensity`, and
`numProjectiles`/`spreadAngle`/`verticalAngle` — the projectile pattern.
The cast animation itself is invariant per scarab+talisman pair.

## §5 Per-spell motion data — DO WE HAVE IT?

**No.** Not in any form usable by the cast-pose code.

What ACE proves (`SpellFormula.cs:245-287`): the animation sequence for
casting any spell is mechanically derived as:

```
for each scarab in formula:               // 1+ scarabs depending on spell tier
    play SpellComponentTable[scarab].Gesture as MotionStance.Magic
play SpellComponentTable[talisman].Gesture as MotionStance.Magic
```

The `Gesture` field is a `uint` MotionCommand (`SpellComponentBase.cs:11`).
For scarabs, `Gesture` references one of the 10 `MagicPowerUp0N`
windups (`MotionCommand.cs:118-127`). For talismans, it references
one of the 13 cast motions (`MagicBlast/MagicHeal/MagicHarm/…`,
`MotionCommand.cs:50-63`).

Our `spell-components.json` (5.2 KB, ID→Name only) drops the Gesture
field. The catalog's `components: ["Comp_1","Comp_7","Comp_33","Comp_44","Comp_49"]`
gives us the formula but **no animation mapping** — we don't know which
MotionCommand Lead Scarab maps to, or that Hawthorn Talisman triggers
MagicHeal.

The Phase 41 hypothesis ("wind-up animation is one motion, projectile
pattern is the differentiator") **needs refinement**:

* For low-tier (Lead-scarab) spells with `HasWindupGestures = false`
  (`SpellFormula.cs:265`) → only the cast gesture plays. One motion.
* For higher-tier (Iron/Copper/.../Mana) spells → 1 windup per scarab
  + 1 cast gesture. Multi-scarab spells like Ring (e.g. Strength Other VI
  with 2 scarabs) play 2 windups. Multi-motion.
* `SpellFlags.FastCast = 0x4000` (`SpellFlags.cs:17`) skips windup
  entirely (`Player_Magic.cs:607-608`). Lightning Bolt I bitfield = 0x0003
  has no FastCast; Nether Streak V bitfield = 0x4003 **does** (0x4000
  bit set) → no windup.
* Wand/staff equipped overrides the talisman's cast gesture with
  `casterItem.UseUserAnimation` (`Player_Magic.cs:655-657`).

## §6 Recommended Wave 14 actions

To wire per-spell cast animations correctly:

1. **Add SpellComponentTable parser to holtburger-dat.** New file
   `crates/holtburger-dat/src/file_type/spell_component_table.rs`. Schema
   is in `external/DatReaderWriter/DatReaderWriter/dats.xml:3003-3014`:
   `Name(ObfuscatedPString) / align4 / Category(u32) / Icon(QualifiedDID
   →RenderSurface) / Type(u32 ComponentType) / Gesture(u32 MotionCommand)
   / Time(f32) / Text(ObfuscatedPString) / align4 / CDM(f32)`.
   Total 163 entries at DID 0x0E00000F (per ACE
   `SpellComponentsTable.cs:31` "Should be 163 or 0xA3"). Register in
   `manifest.rs` and `lib.rs`.

2. **Regenerate `spell-components.json` with Gesture + Type + Time** —
   replace the hand-extracted 163-entry name-only file with the parsed
   output. Adds ~10 KB. Schema:
   `{ "1": { "name": "Lead Scarab", "type": "Scarab", "gesture":
   "MagicPowerUp01", "time": 0.5, "icon": "0x060013E7" }, … }`.

3. **Synthesize `spell-cast-sequence.json`** keyed by SpellId, derived
   from the catalog's `components` joined with `spell-components.gesture`:
   `{ "75": { "windup_gestures": ["MagicPowerUp01"], "cast_gesture":
   "MagicBlast", "has_windup": false /*FastCast bit*/, "fastCast":
   false } }`. The Player_Magic.cs algorithm is small enough to port
   to JS directly; the SpellFormula getters at lines 245-287 are the
   spec.

4. **Verify scarab→MagicPowerUp0N mapping empirically.** ACE doesn't
   hardcode it (the Gesture field IS the spec), but the enum ordering
   `MagicPowerUp01..10` (0x6F-0x78) suggests Lead→01, Iron→02, …,
   Mana→10. Single retail pcap with each scarab-tier spell would confirm.

5. **Talisman→cast-motion mapping is 14 entries** (talismans 49-62 +
   the `MagicBlast/MagicHeal/MagicHarm/MagicEnchantItem/MagicPortal/
   MagicPray/MagicSelfHead/MagicSelfHeart/MagicBonus/MagicClap/
   MagicThrowMissile/MagicTransfer/MagicVision` set, ~13 commands). The
   parser pass in #1 makes this trivial.

Total estimated effort for #1-#3: one focused agent-shift. Wave 13's
Phase 42 cast-pose code should be authored against the
**catalog+spell-components** join, with a stubbed gesture map until #1
lands.

## File paths referenced

* `external/holtburger/apps/holtburger-web/data/spells-catalog.json`
* `external/holtburger/apps/holtburger-web/data/spell-shapes.json`
* `external/holtburger/apps/holtburger-web/data/spell-components.json`
* `external/holtburger/scripts/build_spells_catalog.py`
* `external/holtburger/apps/holtburger-web/scripts/gen-spell-shapes.cjs`
* `external/holtburger/crates/holtburger-dat/src/file_type/spell_table.rs`
* `external/holtburger/crates/holtburger-dat/src/manifest.rs`
* `external/holtburger/apps/holtburger-tools/src/spell_export.rs`
* `external/LSD-Partial-2025-02-23_16-15/spells.json`
* `~/ace-server/Source/ACE.DatLoader/FileTypes/SpellTable.cs`
* `~/ace-server/Source/ACE.DatLoader/Entity/SpellBase.cs`
* `~/ace-server/Source/ACE.DatLoader/FileTypes/SpellComponentsTable.cs`
* `~/ace-server/Source/ACE.DatLoader/Entity/SpellComponentBase.cs`
* `~/ace-server/Source/ACE.Server/Entity/SpellFormula.cs`
* `~/ace-server/Source/ACE.Server/WorldObjects/Player_Magic.cs`
* `~/ace-server/Source/ACE.Entity/Enum/SpellType.cs`
* `~/ace-server/Source/ACE.Entity/Enum/SpellFlags.cs`
* `~/ace-server/Source/ACE.Entity/Enum/MotionCommand.cs`
* `external/DatReaderWriter/DatReaderWriter/dats.xml` (lines 3003-3014, 4118-4122)
* `external/DatReaderWriter/DatReaderWriter.Tests/DBObjs/SpellComponentTableTests.cs`
