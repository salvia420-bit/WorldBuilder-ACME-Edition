# Handoff: ClothingTable (DAT 0x10) consumer wiring

**For:** next agent picking up the equipment-visuals push.
**Status (2026-05-24 update — Wave 7.3 SHIPPED):** parser shipped (Milestone C4); reader foundation shipped (Wave 7.2); spawn-time substitution ALREADY existed in `fetch_entity_animation_keyframes`; **mid-game equip-change path (UpdateObject 0xF7DB) shipped in Wave 7.3 via despawn+respawn**. Hot-swap optimization remains a future follow-on if visible flicker becomes a complaint.

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

## What's left after Wave 7.3

### A. Equip-mid-game (UpdateObject) — ✅ SHIPPED (Wave 7.3)

Shipped 2026-05-24:

1. **`apps/holtburger-web/src/lib.rs`** — added `ENTITY_UPDATE_KIND_APPEARANCE = 6` constant (alongside kinds 0-5 at L12177-12223). Added `GameMessage::UpdateObject(data) =>` arm between ObjectCreate and ObjectDelete (~L17916); extracts `model_changes`/`texture_changes`/`sub_palettes`/`palette_id` via the same flat-encoding pattern as ObjectCreate (mirrors L17718-17787); pushes EntityUpdate with kind=6 + only the four substitution-relevant fields populated (everything else zeroed — JS reuses the cached spawn metadata).
2. **`apps/holtburger-web/scene3d/loop.js`** — added `KIND_APPEARANCE = 6` const alongside existing kinds (L51); added kind=6 dispatch case in `drainEntityEvents3D` (~L727) routing into `em.applyAppearance(guid, {modelChanges, textureChanges, subPalettes, paletteId})`.
3. **`apps/holtburger-web/scene3d/entities.js`** — added `async applyAppearance(guid, opts)` method (above `remove(guid)` at ~L2017). V1 uses despawn+respawn: captures the entity's current world pose off `inst.root.position` (converts back to LB-local for the spawn meta), merges the new substitutions into the saved meta, calls `remove(g)` then `await spawn(newMeta)`. The next KIND_POSITION snaps the entity to its current server pose, so the visible flicker is bounded to one frame in steady state.
4. **`scene3d/diag/clothing.js`** — added `onAppearanceChange(meta)` hook + `appearanceChanges` counter + `recentChanges` ring (max 30). Fires BEFORE the despawn so observation lands even if the respawn errors out.

Verified 2026-05-24 with a harness that exercises `applyAppearance` on a live spawned entity in the wire-agent: dispatched=true, entity survived despawn-respawn round-trip, `appearanceChanges` counter incremented 0→2, sample event captured with `{guid:0x80002157, source:"wire-update-object", modelChangesCount:1, textureChangesCount:1, subPalettesCount:0, paletteId:0}`. Harness: `/mnt/wbterminal1/tmp/claude-scratch/wire-agent-new-pipelines-2026-05-24/run-diag-clothing-equip.mjs`.

**What this guarantees:** wire opcode 0xF7DB now routes through the same animation-cache substitution path that ObjectCreate has been using since vitaeum-parity Milestone C4 + the spawn-time wire already plumbed (lib.rs:~L10778-10830). Mid-game equip changes are no longer silently dropped.

**What it doesn't yet guarantee (deferred):** hot-swap that preserves animation-mixer state. Today's despawn+respawn snaps the entity back to rest-pose for one frame before the next motion event catches it up. For a chatting NPC or combat partner this is briefly visible. Hot-swap (preserve `inst.root` + `inst.mixer` + currently-playing action, swap only the part meshes + materials) is a future optimization — see § D below.

### B. Character-creation enumeration UI — uses the W7.2 reader

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

### D. Hot-swap optimization for applyAppearance — ✅ SHIPPED (Wave 7.5)

Shipped 2026-05-24:

1. **Load-bearing cache fix in `scene3d/animation.js`** — pre-W7.5 the AnimationCache key was `(setupId, mtableId, motion, stance)` and EXCLUDED `modelChanges` / `textureChanges` / `paletteId` / `paletteSubsFlat`. That meant two spawns of the same entity with different equips silently returned the SAME cached entry — so W7.3's despawn+respawn would re-render with stale clothing. W7.5 adds `AnimationCache._substitutionSuffix(...)` (FNV-1a-like hash) and appends it to the cache key when any substitution is non-default. Pre-W7.5 keys for plain spawns continue to match (empty suffix when all subs are zero/empty). Fixes BOTH despawn+respawn AND enables hot-swap.

2. **`EntityManager._applyAppearanceHotSwap(inst, newMeta, guid)`** — preserves `inst.root` + `inst.mixer` + `inst.currentAction`. Only the child Mesh contents of each `inst.parts[p]` Group get replaced. Mixer continues driving `parts[p].position` / `parts[p].quaternion` against the same clip — works because partGroup naming (`part_${p}`) is stable across substitutions on the same setupId. Disposes old entity-owned materials/textures after the new mesh tree is attached (in case the swap throws partway, we don't leave references to disposed assets).

3. **`?clothingHotSwap=1` URL flag** — read in `EntityManager.constructor` into `this._hotSwapAppearance`. `applyAppearance` checks the flag and calls `_applyAppearanceHotSwap`; on topology mismatch (`partGroups.length !== inst.parts.length`) OR any thrown error, falls through to W7.3 despawn+respawn so the equip change still propagates either way.

4. **Diag observability** — `__diag.clothing.recentChanges` entries carry `source: "hot-swap"` (Wave 7.5 path) or `source: "wire-update-object"` (Wave 7.3 fallback path). Counters share the same `appearanceChanges` total.

Verified end-to-end with A/B harness running both flag-on and flag-off sessions against live ACE:
- **default-despawn-respawn**: `source="wire-update-object"`, `sameInstReference: false` (new EntityInstance created)
- **hot-swap-flag** (`?clothingHotSwap=1`): `source="hot-swap"`, **`sameInstReference: true`** — same EntityInstance object preserved across the equip change, proving `inst.root` + `inst.mixer` + `inst.currentAction` continuity

Harness: `/mnt/wbterminal1/tmp/claude-scratch/wire-agent-new-pipelines-2026-05-24/run-diag-clothing-hotswap.mjs`.

**Known limitations:**
- Topology mismatch (e.g. swap to a setup with different part count) falls through to despawn+respawn. Same-setupId equip changes (the common case for clothing) always preserve topology.
- ~~Cache memory grows by `num_unique_equip_variants` per (setup, mtable, motion, stance) tuple.~~ **Closed by Wave 7.6** — `AnimationCache` now caps `entries.size` at 256 (configurable via `?animCacheMax=N`) with strict-LRU eviction. Move-to-tail on hit; skip in-flight entries during eviction. Eviction also triggers on Promise resolution (catches the boot-drain case where many concurrent fetches start before any can be evicted). Stats exposed via `__diag.assets.summary().animCache = {size, max, pending, evictions, watermark}`.
- Manual combat-motion validation against real GPU is still recommended before defaulting the flag on. The current harness verifies wire path + diag + reference preservation but not visual continuity through an actual swing animation. To default-on, a follow-on should run side-by-side capture on a 1070-class GPU comparing hot-swap to despawn-respawn under a combat swing cycle.

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
