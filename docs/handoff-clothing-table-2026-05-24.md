# Handoff: ClothingTable (DAT 0x10) consumer wiring

**For:** next agent picking up the equipment-visuals push.
**Status (2026-05-24 update):** parser shipped (Milestone C4); reader foundation shipped (Wave 7.2 below); spawn-time substitution ALREADY exists in `fetch_entity_animation_keyframes`; **the genuinely missing piece is the mid-game equip-change path (UpdateObject 0xF7DB).**

## Wave 7.2 — what landed 2026-05-24 (this session's slice)

The original handoff (sibling commit 54bbe206) said "the spawn path drops texture_changes/model_changes." That turned out to be **partially incorrect** — a parallel Explore-agent trace of the actual wire path found those fields are already plumbed through:

```
Wire (ObjectDescriptionData::unpack)
  → Rust EntityUpdate (lib.rs:17656-17675 — pack model_changes/texture_changes flat)
  → JS loop.js (_sliceFromScratch at L604-606)
  → meta → EntityManager.spawn (entities.js:861-864)
  → animationCache.get(setupId, ..., {modelChanges, textureChanges, paletteId, paletteSubsFlat})
  → wasm fetch_entity_animation_keyframes (lib.rs:10778)
  → build_entity_animation_data_inner_v2(... &mc, &tc, ...) (lib.rs:10853)
```

So **ObjectCreate of an entity carrying clothing already produces the substituted visuals** via the wasm-side mesh+texture composition. What's NOT wired is mid-game equip change — when the player swaps a helmet, the server sends UpdateObject (0xF7DB) which holtburger-web's recv loop silently drops (no `GameMessage::UpdateObject(data) =>` arm in lib.rs).

Shipped this session (Wave 7.2):

1. `ClothingTable::unpack(&[u8])` helper in `crates/holtburger-dat/src/file_type/clothing.rs` (~5 LOC; mirrors the Wave-7.1 pattern).
2. `fetch_clothing_table(id)` wasm export in `apps/holtburger-web/src/lib.rs` using `serde_json::to_string` (the nested HashMap<u32, _> + recursive Vec structure is too complex for manual JSON; deps already in workspace). Wired through `window.__hbWasm`.
3. `ui/ac_clothing.js` runtime: `loadClothingTable(id)`, `getClothingTable(id)`, `getCloObjectEffects(rt, setupDid)`, `getCloSubPalEffect(rt, paletteTemplate)`. HashMap-key decode (serde_json's stringification + `parseInt(key, 10)` back to u32 in `_buildRuntime`).
4. `scene3d/diag/clothing.js` following the Wave-7.1 template: `loaded` Map, `failures` ring, `cached()` read-through. Wired into `diag.js` attach loop.

Verified end-to-end on `?wireframe=1&hud=none&plugins=none&diag=1` against live ACE: ClothingTable `0x10000001` loads, 17 base effects + 28 sub-pal effects decoded, the head-slot fixture (Setup `0x02001A18`, slot index 9) returns model_id `0x01004AA7` with texture pair `0x050003D5 → 0x0500025F` — **byte-exact match against the parser test fixture in `clothing.rs::CLOTHING_0X10000001_FIRST_OBJECT_EFFECT`**. Harness: `/mnt/wbterminal1/tmp/claude-scratch/wire-agent-new-pipelines-2026-05-24/run-diag-clothing.mjs`.

The reader is useful today for character-creation / dye-picker / examine-target UIs that need to enumerate a wardrobe without triggering a spawn. The visible-equip-change feature still requires the equip-change wire path below.

## What's left after Wave 7.2

### A. Equip-mid-game (UpdateObject) follow-on — ~½ day

When a live player equips a new item, ACE sends `UpdateObject` (opcode `0xF7DB`) carrying the same `ObjectDescriptionData.model_data` payload as `ObjectCreate`. Today this opcode is **silently dropped** by holtburger-web's recv loop in `apps/holtburger-web/src/lib.rs` (no `GameMessage::UpdateObject(data) =>` arm after `~L17472`). Mid-game equip changes are invisible to other clients as a result.

Required edits (estimated 4-6 hours including manual test against ACE):

1. **`apps/holtburger-web/src/lib.rs`** — add `ENTITY_UPDATE_KIND_APPEARANCE = 6` constant (existing kinds 0-5 at L12115-12161). Add the `GameMessage::UpdateObject(data) =>` arm; extract `data.model_data.{texture_changes, model_changes, sub_palettes}` using the same flat-encoding pattern as `ObjectCreate` at L17656-17675; push an EntityUpdate with kind=6 + the new flat arrays.
2. **`apps/holtburger-web/scene3d/loop.js`** — add a kind=6 dispatch case alongside the existing kind=0..5 cases (~L575-721). Route into `em.applyAppearance(guid, {modelChanges, textureChanges, subPalettes, paletteId})`.
3. **`apps/holtburger-web/scene3d/entities.js`** — add `applyAppearance(guid, opts)` to EntityManager. Steps:
   - Look up the entity instance by guid (`entityMap.get(guid)`)
   - Re-invoke `animationCache.get(setupId, mtableId, currentMotion, currentStance, fetchKeyframes, {modelChanges, textureChanges, paletteId, paletteSubsFlat})` with the NEW substitution args. The cache key includes the substitutions (see `AnimationCache.get` opts handling), so this returns a fresh-baked rig.
   - Swap out the entity's `partGroups`, `materials`, and `mixer.target` in place — keep the same root Group + animation mixer state so the entity doesn't visually pop.
   - Update `__diag.clothing` with an `onAppearanceChange` hook (add to `scene3d/diag/clothing.js` first).
4. **`scene3d/diag/clothing.js`** — add `onAppearanceChange(meta)` hook + counter; surface in `summary()` as `appearanceChanges`. Add a `recentChanges` ring buffer (~max 30) so the diag harness can audit.

Risk: medium. The applyAppearance hot-swap is the riskiest part — animation-mixer state sync (motion offset, action time) must persist across the rig rebuild OR the entity re-pops into rest-pose on every equip. Easier alternative: despawn + respawn the entity with the new appearance (cleaner but visible flicker).

Validation: hit `?diag=1` worker preset, equip-unequip an item on the local player, inspect `__diag.clothing.recentChanges` for the captured event + verify other clients in the same session see the visual change.

### B. Character-creation enumeration UI — uses today's reader

The reader landed in 7.2 is sufficient for `ui/character-create.js` (or a future dye-picker plugin) to enumerate a wardrobe + render variant icons without going through the per-pixel surface compositor:

```js
const rt = await loadClothingTable(0x10000001); // chest plate
const effects = getCloObjectEffects(rt, characterSetupDid); // body-part swaps
const dyes = Array.from(rt.clothingSubPalEffects.values()); // available variants
```

No additional wire-up needed — call `getCloSubPalEffect(rt, paletteTemplate)` to get `{icon: <RenderSurface_did>, clo_sub_palettes: [...]}`, then pass `icon` to `fetch_surface_pixels` for the icon thumbnail.

### C. Clothing II — full PaletteSet dye composer

The dye chain (CloSubPalette → PaletteSet → Palette → texture pixel substitution) is already handled by the wasm-side `fetch_entity_surface_pixels_impl` (lib.rs:~L5209) when `sub_palettes` triples arrive via the spawn path. The remaining work for "Clothing II":

- Wire a dye-picker plugin UI (consumer of `getCloSubPalEffect`)
- Add `__diag.clothing.dyeApplications` ring to observe which (sub_palette_id, offset, length) triples actually drove a surface fetch
- Verify retail-fidelity by screenshotting dyed armor sets against retail screenshots

Estimated 1-2 weeks for the full dye experience. None of it is blocked by Wave 7.2 or the equip-change follow-on above.

## Original architectural-scoping context (preserved for reference)

For comparison: CombatManeuverTable shipped end-to-end in Wave 7.1 in ~250 LOC. ClothingTable's full MVS (helmet visibility + equip-change + dye picker) was scoped at 9-12 days in the original Explore agent run. Wave 7.2 closes the reader portion (~250 LOC). The equip-change path is ~150 LOC + manual ACE testing.

Per-pixel palette compositing for entity surfaces already lives in `apps/holtburger-web/src/lib.rs::fetch_entity_surface_pixels_impl` (~L5209). It handles `base_palette_id + sub_palettes[]` overlays mirroring ACE `CalculateObjDesc`.

The wire protocol carries `ModelData.texture_changes` + `ModelData.model_changes` + `ModelData.sub_palettes` per `crates/holtburger-protocol/src/messages/object/types.rs`.

## Risks (carry forward from the architectural report)

1. **Part-index mismatch (HIGH).** CloObjectEffect.index is Setup-specific. Two SetupModels with different part counts (human vs monster) have misaligned indices. Validate rig part count at spawn; skip model_changes for indices >= part count.
2. **Wire-protocol coverage (MEDIUM).** Confirm UpdateObject + ObjectCreate ALWAYS include `model_data.{texture_changes, model_changes}` when an item is equipped (vs. only on initial spawn). Sniff actual ACE wire packets to verify; tooling exists in `wsbridge` logs.
3. **Async equip-change race (MEDIUM).** Equip → wasm fetch in-flight → unequip → stale install. Tag pending fetches with `(guid, item_id)`; discard if state changed.
4. **PaletteSet blend correctness (MEDIUM, deferred to II).** Already prove-able against retail screenshots once Clothing II's dye path ships. Use armor set 0x10000001 + dye 0x04000042 as the parity fixture.

## How to pick up (the equip-change follow-on)

1. Read this doc § "What's left after Wave 7.2 — A".
2. Read `apps/holtburger-web/src/lib.rs:17656-17675` for the existing `ObjectCreate` clothing-payload-pack pattern (this is the template for `UpdateObject`).
3. Read `apps/holtburger-web/scene3d/loop.js:575-721` for the existing entity-update dispatch (add a kind=6 case alongside).
4. Read `apps/holtburger-web/scene3d/entities.js:804-892` for the `spawn(meta)` flow (your `applyAppearance(guid, opts)` will mirror this — re-invoke `animationCache.get` with new substitution opts + swap parts in place).
5. Run the wire-agent harness with a manual equip-toggle script to confirm the diag surface observes the appearance change.
6. Update `docs/ui-asset-completeness-method.md` (note the equip-change path shipped).
7. Mark this doc closed with a link to the shipping commit.

## Cross-references

- Parser: `external/holtburger/crates/holtburger-dat/src/file_type/clothing.rs`
- Reader runtime (Wave 7.2): `external/holtburger/apps/holtburger-web/ui/ac_clothing.js`
- Diag surface (Wave 7.2): `external/holtburger/apps/holtburger-web/scene3d/diag/clothing.js`
- Wasm export (Wave 7.2): `external/holtburger/apps/holtburger-web/src/lib.rs::fetch_clothing_table`
- Wire protocol: `external/holtburger/crates/holtburger-protocol/src/messages/object/types.rs` (ModelData)
- Existing per-pixel palette compositor: `external/holtburger/apps/holtburger-web/src/lib.rs::fetch_entity_surface_pixels_impl` (~L5209)
- Existing spawn-time clothing path: `external/holtburger/apps/holtburger-web/src/lib.rs::fetch_entity_animation_keyframes` (~L10778)
- ACE reference: `external/ACE/Source/ACE.DatLoader/FileTypes/ClothingTable.cs`, `Source/ACE.Server/WorldObjects/WorldObject_Networking.cs::CalculateObjDesc`
- Acclient: `~/ac-headers/acclient.c` — `grep -n "ClothingTable\|ClothingBase\|CloSubPalEffect"`
- Related Wave 7.1 work: `docs/ui-asset-completeness-method.md`, `scene3d/diag/{combat,palettes,lod}.js` for the diag pattern
- Wave 7.2 verification harness: `/mnt/wbterminal1/tmp/claude-scratch/wire-agent-new-pipelines-2026-05-24/run-diag-clothing.mjs`
- DRW (cross-reference only per `feedback_dat_format_ace_over_drw`): `external/DatReaderWriter/DatReaderWriter/DBObjs/ClothingTable.cs`
