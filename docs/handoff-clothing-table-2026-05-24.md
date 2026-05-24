# Handoff: ClothingTable (DAT 0x10) consumer wiring

**For:** next agent picking up the equipment-visuals push.
**Status: parser shipped; wasm export NOT yet shipped; consumer NOT yet wired.** This is the heaviest of the five vitaeum-parity deferred items, scoped as its own multi-day wave.

## Why this is its own wave (not a one-PR wiring)

The Rust parser landed with the vitaeum-parity Milestone C4 push (1917 retail records, byte-exact). Wiring it into a visible feature crosses several files in the render path AND requires palette compositing the existing surface chain only partially supports today.

For comparison: CombatManeuverTable shipped end-to-end in Wave 7.1 in ~250 LOC. ClothingTable's MVS is 9-12 days per the architectural-scoping report (`scripts/explore-clothing-table-2026-05-24.md` — captured in the originating Explore agent run).

## What ships today (Wave 7.1)

- Per-pixel palette compositing for entity surfaces already lives in `apps/holtburger-web/src/lib.rs::fetch_entity_surface_pixels_impl` (commit history; documented at lib.rs:~5209). It handles `base_palette_id + sub_palettes[]` overlays mirroring ACE `CalculateObjDesc`.
- The wire protocol already carries `ModelData.texture_changes` + `ModelData.model_changes` + `ModelData.sub_palettes` per `crates/holtburger-protocol/src/messages/object/types.rs`. So the server-pushed equipment data ARRIVES at the client; we just don't act on `texture_changes` + `model_changes` yet.
- `__diag.palettes` (Wave 7.1) observes any PaletteSet loaded standalone via `ui/ac_palette_set.js::loadPaletteSet`.

## The proposed wave shape

Per the architectural-scoping report, ship as **Clothing I + Clothing II**:

### Clothing I — visible MVS (~9-12 days)

Two slices in parallel (orthogonal risk profiles):

**Option (a) — Helmet-only.** Pick one body-part slot (head, index ~2) + one CloTextureEffect pair (old_texture → new_texture). Wire `UpdateObject.model_data.texture_changes` → `entityManager.applyTextureChanges(inst, changes)` → swap per-part `MeshStandardMaterial.map` to the new SurfaceTexture's composed pixels.

- **Files:** `scene3d/entities.js` (surface-construction site at ~L991-1059), `scene3d/materials.js` (per-DID material cache).
- **Wasm:** Reuse `fetch_entity_surface_pixels` — already composes base palette + sub-palette overlays. No new export needed.
- **JS:** ~150 LOC for `applyTextureChanges` + spawn-time + on-equip-change hooks.
- **Risk:** Low. Texture swap is just a material/map reassignment.

**Option (b) — Weapon-only.** Pick the right-hand part (index varies by Setup) + one CloObjectEffect `model_id` (GfxObj swap). Load the swap GfxObj as a separate rigged mesh, attach as a child of the hand bone.

- **Files:** `scene3d/entities.js` (animation mixer integration), `scene3d/setup_model.js` if it exists or wherever rig parts are wired.
- **Wasm:** New export `fetch_clothing_table(id) → JSON` (just the `clothing_base_effects[setup_did].clothing_object_effects` for the slot). ~80 LOC.
- **JS:** ~200 LOC for GfxObj attachment + animation sync.
- **Risk:** Medium. Animation-rig sync (swap rig must respect the parent bone's frame); part-index varies per Setup.

### Clothing II — full body + dyes (~15-20 days)

- **Option (c)** — Full body-part substitution across all CloObjectEffect entries. No palette dyes yet.
- **Option (d)** — Full ClothingTable + PaletteSet for dyes. Composes via the existing `fetch_entity_surface_pixels_impl` chain.

Defer this wave behind a `?clothing=full` URL flag during development to A/B against pre-Wave-7.2 sessions.

## The wasm export shape (Clothing I + II)

Add to `apps/holtburger-web/src/lib.rs` after `fetch_gfx_obj_degrade_info` (~L5340 region):

```rust
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn fetch_clothing_table(clothing_id: u32) -> Result<String, JsValue> {
    use holtburger_dat::{ResourceKey, ResourceSource};
    use holtburger_dat::file_type::ClothingTable;
    let source = global_source::global_source();
    let initial = [ResourceKey::new("eor/portal", clothing_id)];
    prefetch::ensure_walk_prefetched(&source, &initial, |_| {}).await?;
    let bytes = match source.get_file_by_key(ResourceKey::new("eor/portal", clothing_id)) {
        Ok(b) => b,
        Err(_) => return Ok("null".to_string()),
    };
    let ct = match ClothingTable::unpack(&bytes) {
        Ok(t) => t,
        Err(_) => return Ok("null".to_string()),
    };
    // Serialize the nested struct as JSON (consider serde_json since
    // ClothingTable derives Serialize per clothing.rs:130-137 and the
    // nested types do too — manual JSON build like fetch_action_map
    // would be ~300 LOC of nested for-loops).
    serde_json::to_string(&ct).map_err(|e| JsValue::from_str(&e.to_string()))
}
```

Note: the existing wasm exports avoid `serde_json` to keep the bundle slim, but for ClothingTable the nesting (HashMap<u32, ClothingBaseEffect> with recursive sub-types) makes manual JSON construction prohibitively complex. Adding `serde_json` is a ~20 KB bundle hit — pay it once.

**Also** add `ClothingTable::unpack(&[u8])` helper to `clothing.rs` (mirrors the helpers in `combat_maneuver_table.rs`, `palette_set.rs`, `degrade_info.rs` added in Wave 7.1).

Then expose through `window.__hbWasm` in `index.html` (around L1292, alongside the new Wave 7.1 entries).

## JS runtime shape (suggestion)

`apps/holtburger-web/ui/ac_clothing.js`:

```js
const tables = new Map();
const inFlight = new Map();

export async function loadClothingTable(id) { ... } // mirrors ac_palette_set.js pattern
export function getClothingTable(id) { ... }

export function getCloObjectEffects(table, setupDid) {
  // → Array<{index, model_id, clo_texture_effects: [{old_texture, new_texture}]}>
  return table?.clothing_base_effects?.[setupDid >>> 0]?.clothing_object_effects ?? [];
}

export function getCloSubPalette(table, paletteTemplate) {
  // → {icon, clo_sub_palettes: [{ranges, palette_set}]}
  return table?.clothing_sub_pal_effects?.[paletteTemplate >>> 0] ?? null;
}
```

## Diag surface shape (when consumer ships)

Follow the Wave 7.1 pattern: new `scene3d/diag/clothing.js`. Counters: `tablesLoaded`, `textureChangesApplied`, `modelChangesApplied`, `subPalettesApplied`, per-entity equip-event ring. Cross-reference with `__diag.palettes` for the PaletteSet side.

## Risks (carry forward from the architectural report)

1. **Part-index mismatch (HIGH).** CloObjectEffect.index is Setup-specific. Two SetupModels with different part counts (human vs monster) have misaligned indices. Validate rig part count at spawn; skip model_changes for indices >= part count.
2. **Wire-protocol coverage (MEDIUM).** Confirm UpdateObject + ObjectCreate ALWAYS include `model_data.{texture_changes, model_changes}` when an item is equipped (vs. only on initial spawn). Sniff actual ACE wire packets to verify; tooling exists in `wsbridge` logs.
3. **Async equip-change race (MEDIUM).** Equip → wasm fetch in-flight → unequip → stale install. Tag pending fetches with `(guid, item_id)`; discard if state changed.
4. **PaletteSet blend correctness (MEDIUM, deferred to II).** Already prove-able against retail screenshots once Clothing II's dye path ships. Use armor set 0x10000001 + dye 0x04000042 as the parity fixture.

## How to pick up

1. Read this doc.
2. Read `crates/holtburger-dat/src/file_type/clothing.rs` for the struct shape (lines 1-140).
3. Read `apps/holtburger-web/src/lib.rs::fetch_entity_surface_pixels_impl` (~L5209) to see the existing palette compositor.
4. Read `crates/holtburger-protocol/src/messages/object/types.rs::ModelData` for the wire payload.
5. Pick Option (a) OR (b); ship the wasm export + JS runtime + entities.js integration + a diag surface in one PR.
6. Update `docs/ui-asset-completeness-method.md` (move ClothingTable from §6 "When extended" to §1 pipelines table).
7. Mark this doc closed with a link to the shipping commit.

## Cross-references

- Parser: `external/holtburger/crates/holtburger-dat/src/file_type/clothing.rs`
- Wire protocol: `external/holtburger/crates/holtburger-protocol/src/messages/object/types.rs`
- Existing palette compositor: `external/holtburger/apps/holtburger-web/src/lib.rs::fetch_entity_surface_pixels_impl` (~L5209)
- ACE reference: `external/ACE/Source/ACE.DatLoader/FileTypes/ClothingTable.cs`, `Source/ACE.Server/WorldObjects/WorldObject_Networking.cs::CalculateObjDesc`
- Acclient: `~/ac-headers/acclient.c` — `grep -n "ClothingTable\|ClothingBase\|CloSubPalEffect"`
- Related Wave 7.1 work: `docs/ui-asset-completeness-method.md`, `scene3d/diag/{combat,palettes,lod}.js` for the diag pattern
- DRW (cross-reference only per `feedback_dat_format_ace_over_drw`): `external/DatReaderWriter/DatReaderWriter/DBObjs/ClothingTable.cs`
