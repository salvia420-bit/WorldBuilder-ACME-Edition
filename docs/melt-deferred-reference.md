# Melt deferred-functionality reference

**Date:** 2026-06-10
**Status:** Informational resource — NOT implemented functionality.

The melt-integration plan (`docs/melt-integration-plan-2026-06-10.md` §7) deliberately deferred four areas of `external/melt` because they have no current holtburger-web consumer: pre-ToD/Dark-Majesty texture codecs, DM↔ToD ID migration tables, cache converters, and ACE-DB content-mutation recipes. This document is the **agent briefing** for those areas, so a future task that brushes against them (historical-era DAT research, cross-era asset pairing, PhatAC cache archaeology, ACE-DB economy work) starts with the lay of the land instead of re-reading 4,000+ lines of melt source.

Served live by the WorldBuilder.Terminal command **`melt-reference`** (`{"command":"melt-reference"}` lists topics; `{"command":"melt-reference","topic":"dm-textures"}` returns a section).

Licensing reminder (per `external/melt/VENDORED.md`): melt is a research-only reference — **never link or copy its code**; reimplement on DatReaderWriter types if any of this is ever promoted to functionality.

Section headers below are stable anchors — `melt-reference` parses them. Topic keys: `dm-textures`, `id-migration`, `cache-converters`, `acedb-recipes`.

---

## 1. Dark Majesty / pre-ToD texture codecs

**Topic key:** `dm-textures`

**DM-era container layout vs ToD:**

Dark Majesty textures used type codes 0x04, 0x10, and 0x11 for pixel data, whereas ToD standardized on type 0x06 (RenderSurface). The DM header is read by `darkMajestyToPNG()` (`external/melt/Source/misc/TextureConverter.cs:410`) in this sequence:
- `fileHeader` (uint32, `0x05xxxxxx` prefix for landscape)
- `textureType` (uint32, codes 0x04/0x10/0x11)
- `width` (uint32)
- `height` (uint32, conditionally read: skipped if `textureType==20 && width==20`, a palette-only edge case)

ToD's `toPNG()` (TextureConverter.cs:228) reads fileHeader, textureType (now 0x06), width, height, format, **length** — the added length field (uint32) after format is what enables DXT/JPEG decompression. The DM format field is effectively absent; the textureType code itself encodes the pixel layout.

**Pixel format codes by era:**

*Dark Majesty* (darkMajestyToPNG, TextureConverter.cs:410–536):
- **0x04**: grayscale + alpha; 2 bytes/pixel (gray byte + alpha byte) → ARGB(alpha, g, g, g).
- **0x10**: RGB **planar** (full R-channel block, then G, then B); 3 bytes/pixel reconstructed.
- **0x11**: ARGB **planar** (A block, then R, G, B); 4 bytes/pixel reconstructed.
- **0x14** (20): RGB24 interleaved; 3 bytes/pixel; no alpha.

*ToD and later* (toPNG, TextureConverter.cs:228–394):
- **20 (0x14)**: D3DFMT_R8G8B8 — interleaved B,G,R per pixel; 3 bytes/pixel.
- **21 (0x15)**: D3DFMT_A8R8G8B8 — B,G,R,A per pixel; 4 bytes/pixel.
- **101 (0x65)**: palette-index variant; melt decodes 4 bytes/pixel in A,R,G,B read order.
- **244 (0xF4)**: alpha-only; 1 byte/pixel; reconstructed as white with read alpha.
- **500 (0x1F4)**: JPEG payload; reads `length` bytes, decodes via GDI+.
- **DXT1** (textureType==8): `length` bytes decompressed via ManagedSquish `Squish.DecompressImage()`.

(The modern equivalent for ToD-era decode/encode is chorizite's `RenderSurfaceExtensions.cs:98–285` — BCnEncoder-based, 12+ formats — which WB.Terminal already uses. Melt is the only reference for the **planar 0x10/0x11 and gray-alpha 0x04 DM formats**.)

**DM→ToD landscape/detail texture ID table** (`external/melt/Source/misc/DMtoToDTextures.cs:10–72`):

**41 total mappings** (33 landscape + 8 alpha maps), hardcoded. Patterns:
- DM `0x0500145x` → ToD `0x06006d4x`: e.g. `0x05001459` (Grassland) → `0x06006d40`; `0x0500145c` (BarrenRock) → `0x06006d6f`.
- DM `0x05001c3x` (detail/special): `0x05001c3a` (Moss) → `0x06006d3b`; `0x05001c3c` (olthoi) → `0x06006d3e`.
- `0x05001827` (SeaSlime) → `0x06006d55`; `0x0500181f` (Volcano1) → `0x06006d54`.
- Alpha maps DM `0x0500143e–0x05001371` → ToD `0x06006d30–0x06006d6d` (format 244).

**toBin() PNG→ToD write sequence** (TextureConverter.cs:55–217): 6-field header (fileHeader, type, width, height, format, length) then pixels — format 500: type=6, width=height=0, JPEG stream appended; format 20: type=6, B/G/R bytes; format 21: type=**2**, B/G/R/A; format 101: type=2, A/R/G/B; format 244: type=2, alpha bytes only. (Note the type-field flip between 6 and 2 by format.)

**When you'd need this:** historical-era DAT research (pre-ToD backups, Infiltration/CustomDM-style servers frozen on 0x04/0x10/0x11 containers) or decoding legacy landscape/detail textures from old portal.dat snapshots.

---

## 2. DM↔ToD ID migration tables

**Topic key:** `id-migration`

Melt's three cross-era asset-ID matching mechanisms (all in `external/melt/Source/`):

### buildTextureIdMigrationTable (datFile/datFileUtilities.cs:24–165)

Compares interior EnvCells between two DATs by landblock ID. `compareEnvCells()` (line 82) gates on structural match; once a cell pair matches, texture lists are paired **by positional index** (lines 84–87) — order-dependence is the core assumption. One-to-many conflicts are tracked in `cAmbiguousValues` (lines 88–115).

Outputs: `textureIdMigrationTable.txt` (`<oldId hex4> <newId hex4>` rows, lines 128–132), `…MissingConversions.txt` (135–141), `…Ambiguous.txt` (`old new(alt, alt…)`, 143–164).

### buildObjectIdMigrationTable (datFile/datFileUtilities.cs:167–369)

Dual-path: **landblock surface objects** (lines 219–268, gated by `compareLandblockInfo()`) and **dungeon stabs** (270–318, `compareEnvCells(…, true)`), both index-paired like textures. Outputs mirror the texture table (hex8 IDs, identity mappings excluded; lines 329–368).

### GfxObjTools.BuildTranslationTable / FindTranslation (misc/GfxObjTools.cs:110–204)

**Semantic fingerprint matching**, not positional: a Surface is identified by (Type, OrigTextureId, ColorValue, Translucency, Luminosity, Diffuse) — `OrigPaletteId` deliberately skipped ("always 0 in ToD", line 192). Brute-force scans `0x08000000..0x0800FFFF` (lines 183–200) for an exact field match.

**Key distinction:** migration tables = positional pairing under structural alignment (cross-era); FindTranslation = fingerprint equality within one DAT (any era).

### Modern WB.Terminal equivalent

For **same-era** work this is already implemented: `surface-fingerprint` (CommandEngine.AssetGraph.cs) caches every Surface's fingerprint row per session and answers probe-ID or partial-match queries instantly. The positional **cross-era** migration tables remain melt-only concepts — if cross-era pairing is ever needed, implement it as a new command that walks two `dat-open` handles and reuses the §existing diff/fingerprint plumbing.

**When you'd need this:** porting assets between game eras (DM↔ToD), reconciling a historical DAT's IDs against EoR, or auditing "same material, different ID" within one DAT (use `surface-fingerprint` for the latter — don't re-port melt).

---

## 3. Cache converters (cache4/6/8/9)

**Topic key:** `cache-converters`

These convert **PhatAC server cache dumps** (`000N.raw` binary tables — serialized game-world data, *not* client `cache.dat` files) to/from JSON. Located in `external/melt/Source/weenies/cache{4,6,8,9}Converter.cs`; wired into `Program.cs::GeneratePhatACLootFiles()` (Program.cs:1169–1559). **PhatAC is deprecated for our work** (ACE-only house rule) — this is archaeology reference only.

| Converter | Data | Input shape | Output | Notes |
|---|---|---|---|---|
| `cCache4Converter` (cache4Converter.cs, 158 lines) | Item interactions | int32 header + **hardcoded 292** records: resultId, skill (eSkills), difficulty, resultWcid/amount, success/failure messages + 163 discarded int32s (lines 27–44) | — (write methods stubbed) | Effectively dead code |
| `cCache6Converter` (cache6Converter.cs, 186 lines) | Landblock spawns | int16 lbCount + int16 generatorCount; per LB: key, weenies (wcid + pos 3f + quat 4f + id), links (src→dst id pairs) (lines 72–156) | One JSON per landblock, names via `landblockNames.geLandblockName` (158–185) | World spawn-point + link extraction |
| `cCache8Converter` (cache8Converter.cs, 178 lines) | Quest flags/timers | int16 count + const 32; per flag: name, repeatTimerSeconds, maxRepetitions, encoded description (27–106) | `questFlags.json` (133–155) AND raw re-pack `0008.raw` (157–177) | Round-trips |
| `cCache9Converter` (cache9Converter.cs, **1569 lines**) | **Weenies** | int32 count; per weenie (weenie.cs:46–104): wcid, name, statFlags bitmask → int/int64/bool/float/string/did/pos/iid stat dicts; dataFlags bitmask → attributes/skills/body/spellbook/emotes/createList/generator/ObjDesc; `0x01` delimiter | Raw round-trip, per-weenie JSON, "extended JSON" + `writeRawFromExtendedJson` rebuild | The workhorse; also feeds `generateRandomLoot` (Program.cs:1217+) combining cache9+cache2 with loot profiles |

Program.cs dispatch (1169–1559): `landblocks` → cache6+9 JSON export; `questflags` → cache8; `raw2json`/`json2raw` → cache9 extended round-trip; `cached`/`split`/`json` → loot generation.

**When you'd need this:** only if PhatAC-era cache dumps surface in research (e.g. comparing a 2017 PhatAC world snapshot's spawns/weenies against ACE/LSD data). Parse formats from this table; do not port the converters.

---

## 4. ACE-DB content-mutation recipes

**Topic key:** `acedb-recipes`

### I/O technique

`external/melt/Source/misc/aceDatabaseUtilities.cs` (~3,900 lines) mutates **live MySQL ACE databases** (`ace_world_customDM` / `ace_world_test` / `ace_shard_customDM`) directly: query → transform in memory → `UPDATE`/`INSERT`/`DELETE` on weenie property tables. Side outputs: TSV/TXT review files (`./input/`, `./`) and occasional replayable `.sql` dumps. WB.Terminal's own ACE-DB surface (`weenie-*`, `ace-db-ingest-*`, `placement-export-sql`) is the supported path — these recipes are a **pattern catalog**, not code to run.

### Recipe catalog (aceDatabaseUtilities.cs, line numbers in source)

**Vendor inventory management:** FindScrollVendors (16), BuildVendorSellList (112), RemoveAmmoFromSpecificIDs (153), RemoveAmmoFromBlacksmithsAndWeaponsmiths (174), RemoveCowlsFromShopkeepers (666), RemoveNonMutatedItemsFromVendors (712), AddSalvageToShopkeepers (753), RedistributeVendorMerchandiseTypes (798), RemoveSalvageMerchandiseTypeFromVendors (913), RedistributeTradeNotesToVendors (947), AddRumorColorCodesToVendors (1007), AddAlchemySuppliesToVendors (1058), AddLeyLineAmuletsToVendors (1148), AddCombatManualToVendors (1200), AddMagnifyingGlassToVendors (1251), AddCombatTacticsAndTechniquesToVendors (1282), AddTethersToVendors (1339), AddThrownWeaponsToVendors (2515), AddSalvageBarrelToVendors (2807), AddSpellComponentPouchToVendors (2837), RedistributeFoodIngredientsToGrocersAndFarmers (2869), RemovePortalGemsFromAllSpellComponentVendorsAddToJewelers (2936), AddSpellTransferScrollsToVendors (3184), AddSpellConduitToVendors (3357), RedistributeSpellServicesToVendors (3795).

**Item rebalancing:** ChangeShieldBurdens (332, TSV-driven), ChangeOlthoiArmorBurdensShard (400, dual-DB world+shard), ChangeArmorBurdens (482), ChangeSpellScrollPrices (559, weenie int prop 19), AddSkillReqToAtlanWeapons (1391, int prop 47), AddLevelReqToShadowArmor (1573), SoCSDisassemble (2630), ConvertSomeSoCStoTwoHanded (2719), IncreaseThrownWeaponsStackSizeTo250 (2778), ChangeArrows (3530), ChangeCompositeWeapons (3613), AddItemsToCookbook (3655), AddCooldownToCasters (3760).

**XP / loot economy:** CreateCreatureXPList (1918), GetCreatureXP (2144 — formula `min(1.75·level²+20·level, 30000) + HP/10·baseXP/35 + spellbookCount·150`), UpdateXPRewardsFromList (2197, emote_action type=2), CreateXPRewardsList (2307, quest-frequency modifiers −1000…−5000), CreateSpellDamageListForPortalDat (3022), ModifySpellDamage (3059).

**Food/cooking:** CreateFoodValueList (1650), CreateFoodList (1749). **Housing:** RemoveAllNonApartmentHouses (3870, deletes from landblock_instance). **Misc:** UpdateRumorDescriptions (204, incomplete).

### aceMutationScripts.cs — loot mutation-script generator

Generates ACE **loot-tier mutation scripts**: weighted variance distributions for weapon damage and armor bonuses across **8 loot tiers**. Model: per-profile TierData (wield requirements + per-increment ChanceEntry[] percentages); weapons use `MinDamage = MaxDamage × (1 − variance)` with Best/WorstDamageVariance bounds per tier; distributions shaped by `eRandomFormula` (favorMid/High/Low); WieldDifficulty scales by tier (T7/8 ≈ 150–180). `BuildScripts()` (line 198) → `BuildWeapon/ArmorTier` → `BuildVariances` → `WriteFile()` (835–984) emitting human-readable mutation blocks under `ACEmulator Mutations/MeleeWeapons/.../{weapon}.txt` for ACE's item-mutation registry.

**When you'd need this:** server content rebalancing or custom-shard economy work on the live ACE DB (`~/ace-server`). Explicitly out of scope for holtburger-web client parity — but the catalog tells you instantly whether "someone has already solved X vendor/loot problem" and where the pattern lives.
