# DESIGN — recolor residency: what retail actually does, and our two structural wastes (2026-07-26)

Companion to the "dye" terminology audit (see `RESULTS-matcache-falsifier-2026-07-26.md`
next moves and the audit summarized below). Decomp research verified against
`acclient.c`/`acclient.h`/PDB + the 2013 pseudo-C second opinion; our side verified on
master post-`4965f2d5`. Anchor by symbol — line numbers drift.

## 0. Terminology ruling (from the forensic audit, same night)

The codebase's "dyed" path is the **general ObjDesc subpalette recolor path** — skin/
hair/eye tones (ACE emits 3 subpalettes per humanoid unconditionally,
`WorldObject_Networking.cs:1011/1019/1027`), every RNG loot color
(`LootGenerationFactory.cs:597-606`), weenie creature variants, corpses. Of ACE's 99
palette templates exactly 10 are dye-reachable; player dyeing (plant → pot → apply) is
a recipe editing `PaletteTemplate`/`Shade` upstream — zero render-path involvement.
The retail client's 3D path has zero "dye" symbols (ClothingTable ×97, Subpalette
×131). **Essential system, benign mislabel** — rename plan: dye→recolor in ~6 files,
3 tiers, ~2 h; the Dye Pot preview plugin keeps its (correct) name. Cutting the path
is not shippable: it would collapse all skin/loot/creature coloring and render
Base1ClipMap bodies (dolls, Virindi) as solid boxes — `?recolor=off` exists as a
measurement bracket only.

## 1. Retail's model — the premise is wrong, the lesson is better

**Retail also composites a full 32-bit RGBA copy per recolor.** It never binds
palettes to the GPU (`SetCurrentTexturePalette` appears nowhere), and it does **no
dedup across identically-dyed wearers** (`ImgTex::CreateCombinedTexture` only keys
`(texDID, palDID)` for DAT-resident palettes; a modified palette has
`m_pMaintainer == 0` → keyless `custom_texture_table` → fresh composite per wearer,
`acclient.c:367699-367751`). Fifty identically-dyed wearers = fifty composites.
**We are better than retail on that axis** (our `(did|palette|subs)`-keyed share).

Retail's frugality is structural, not clever:
- **4 B/px in ONE heap.** Index plane stays in the DAT (`PFID_P8`/`INDEX16`);
  `ImgTex::CopyIntoData` writes ARGB once (`acclient.c:365907-366003`); the staging
  RGBA is **purged at upload** (`:366173-366176`); what persists is a
  `D3DPOOL_SYSTEMMEM` mip-chain master (≤4 mip levels, `:366125`).
- **Refcount lifetime**: despawn → `CPhysicsPart::RestoreSurfaces` →
  `releaseCustomSurface` → `~ImgTex` frees everything (`:314553-314580`).
- **Real pressure LRU**: `PurgeOldResources(120.0)` when video memory is low
  (`:123102`), inline `DiscardResourceBytes` retry on D3D OOM (`:454779`).
- A modified `Palette` is 72 B + 8 KiB ARGB (2048 entries — the 256-entry DAT palette
  is 8×-replicated at load, `Palette::InitLoad`, `acclient.c:365035-365060`).
- Era anchor: "video memory low" = VRAM < 12 MB or available < 24 MB
  (`:457982-457984`); `EnvironmentTextureDetail` right-shifts every texture.

**50-wearer arithmetic** (256×256, distinct dyes): retail ≈ 17 MiB heap + 16.6 MiB
VRAM; holtburger ≈ **37.5 MiB heap** (wasm 512 KiB/sig + JS 256 KiB/sig, never
released) + 16.7 MiB VRAM. **≈2.2× host RAM; 3× on raw pixel planes**
(retail 4 B/px one heap; us 12 B/px across wasm+JS).

## 2. Our two structural wastes (the actual lever)

1. **The composed cache stores 4 B/px nothing reads.**
   `fetch_entity_surface_pixels_impl` computes Sobel normal (3 B/px) + height
   (1 B/px) and `surface_memo_insert_composed` caches them (`src/lib.rs`
   ~:12374-12381, ~:9536-9563) — but **all three entity consumers use only
   `sp.pixels`** (`entities.js:3793, :4914/:5004, :9649`);
   `surfacePixelsToNormal/HeightTexture` are only called from palette-free
   MaterialCache paths. Skipping the derived planes on the composed class only is
   **exactly −50% per composed entry** + saved Sobel CPU + smaller worker transfers.
   ⚠ Scope guard: gate on `base_palette_id != 0 || !sub_palettes.is_empty()` — the
   entity palette-free class is shared with statics, which DO read the planes.
2. **The JS paletted cache is count-capped, not byte-capped.**
   `PALETTED_CACHE_CAP = 256` signatures; 64 MiB retained at 256², 256 MiB at 512²;
   past the cap it thrashes into per-wearer duplication (the Swank museum mechanism —
   evicted textures stay pinned by live meshes). The byte tallies to fix it
   (`_palBytes`) landed with the instrumentation merge (`4965f2d5`); the fix is the
   while-condition + a `?palBudgetMB=N` flag.

Both land as `feat/composed-slim` (in flight). Ranked alternatives, for the record:
GPU-side composite into an RTT per signature (#2: ~0 heap/sig, retail-identical
filtering since mips come from composed RGBA; needs an RTT pool + CPU fallback for
`?nullRender`); fragment-shader palette lookup (#3: leanest bytes, 8 KiB/sig, but
index planes cannot mip-filter → distant NPCs alias — a regression retail did not
have; magnification experiment only); dropping `image.data` post-upload (#4: no
supported three.js hook, breaks context-loss, saves nothing under `?nullRender`).

## 3. Confirmation instruments

- `__diag.palettedCache()` (`palSigs/palMB/palHiMB/palEvict` relay columns) — the
  Swank discriminator: default arm should show `palEvict` spiking + heap step at the
  museum; post-fix rerun should show `palMB` bounded with no thrash mint.
- `__diag.entityOwned()` (`entMB`) — expected ≈0 in normal sessions (the per-wearer
  pool the falsifier doc originally fingered is nearly unreachable); non-zero would
  itself be news.
- `?recolor=off` A/B (running as this is written:
  `/mnt/wbterminal2/recolor-ab-2026-07-26/`) brackets the whole recolor system's
  memory cost and directly tests the Swank attribution.
