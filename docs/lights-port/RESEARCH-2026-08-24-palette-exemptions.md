# RESEARCH 2026-08-24 — palette-recolor exemptions for the free-after-upload diet

Task from `HANDOFF-2026-08-24-rgba-mirror-diet.md`: which texture classes re-read their
CPU source bits after initial upload, so a free-after-upload service must exempt them.
All anchors are line numbers in `~/ac-headers/acclient.c` (read-verified in the bodies,
not just prototypes). PFIDs: `PFID_P8 = 0x29 (41)`, `PFID_INDEX16 = 0x65 (101)`
(acclient.h:2569/2596). ImgTex objects ARE the `DB_TYPE_SURFACETEXTURE` (11) cache
objects; RenderSurface = `DB_TYPE_RENDERSURFACE` (12) — both already in the governor's
`memcaptex` group.

## Headline: retail already frees the staging buffer — the retained mirror is elsewhere

At the tail of a **successful** `ImgTex::CreateD3DTexture` (:366008), retail calls
`m_pImageData->PurgeResource()` + `MarkResourceAsLost` on its own staging RenderSurface
(:366173ff). Free-after-upload of the *staging* copy is the shipped design. What retail
KEEPS per uploaded texture is `m_pSystemMemTexture` — an explicit D3DPOOL_SYSTEMMEM
texture with a full mip chain, pinned with `m_AllowManagement = 0` (:366146ff), filled
via `D3DXLoadSurfaceFromSurface` + `D3DXFilterTexture` before the staging purge. That
sysmem-texture set (plus any managed-pool mirrors — sibling research) is where the
dump's 1,008 MiB lives. `ImgTex::RestoreResource` (:366205) re-runs `CreateD3DTexture`
only when the field at +276 is empty — the sysmem texture is the device-loss insurance.

## Re-reader inventory (who reads CPU texture bits after first use)

| # | Reader | What it reads | When it fires | Refetchable? |
|---|--------|---------------|---------------|--------------|
| 1 | `ImgTex::Combine` (:367576) → `ImgTex::CopyIntoData` (:365907) | the **palettized source** ImgTex's `m_pImageData` — LOCKS it, walks P8/INDEX16 texels through `Palette::get_color32`. Format gate: only 41/101 accepted (:367597) | every creation of a NEW (texture DID, palette DID) combined variant: clothing/creature recolor coming into view, palshift restore | YES — `CSurface::RestorePalShiftSurface` (:358218) demonstrates the pattern: `DBObj::Get(QualifiedDataID(indexed_texture_id, 0xB))` refetches the source from the DBOCache/DAT on demand (:358232) |
| 2 | `TexMerge::CopyAndTile` (:304666) / `TexMerge::Merge` (:304839) → `ImgTex::CopyCSI` / `ImgTex::MergeTexture` (:365632) | terrain **base textures** and **road/terrain alpha maps** (`m_pImageData` of both, read directly) | every land-cell re-merge: landblock streaming into view, `LandscapeTextureDetail` change (`bNeedReloadTextures` :380972) | YES — `CopyAndTile` is already lazy: `if (!terrain_tex->base_texture) base_texture = DBObj::Get(tex_gid, 0xB)` — a destroyed source is transparently refetched |
| 3 | `ImgTex::RestoreResource` (:366205) → `CreateD3DTexture` | `m_pImageData` (already purged post-upload → in practice the +276 sysmem texture path serves restores) | device loss (alt-tab from fullscreen, resolution change, UAC). Client runs windowed → rare | see §restore below — the client has a FULL from-DAT rebuild path |
| 4 | `ImgTex::GetTempBuffer` (:367485) / `AllocateTempBuffer` (:367298) | nothing — pure scratch. But the buffers are cached FOREVER in `temp_buffer_table`, keyed (format → width<<16\|height), never freed | first use of each distinct (format, size) | contents dead after each use — the table is flushable at zero content risk; with r9 sizes each 2048² BGRA entry pins 16 MB |

No other `ImgTex::GetData` callers exist (:367619, :367671 = Combine + LoadCSI only);
LoadCSI (splash/CSI images) reads file data at creation, not post-upload.

## The restore story (why the sysmem mirrors are droppable insurance)

`CSurface::RestoreLostSurface` (:358369) is a per-handler-class rebuild dispatcher that
never needs a retained CPU mirror:
- handler **1/4** (plain RGBA/DXT): `base1map = DBObj::Get(orig_texture_id, 0xB)` — refetch from DAT.
- handler **2** (palettized): `RestorePalShiftSurface` — refetch source + re-`CreateCombinedTexture`.
- handler **3** (merged terrain): `TexMerge::RestoreSurface` (:306241) — full re-merge.

It's invoked lazily at use (`type & 6 && !base1map && m_bIsLost` :454374). So EVERY
surface class is reconstructible from the DAT by the client's own machinery; the diet's
device-reset obligation is to route through this path (mark lost, drop base1map) rather
than relying on `ImgTex::RestoreResource`'s mirror re-upload.

## Variant caching (census cross-check)

`ImgTex::CreateCombinedTexture` (:367699) caches combined variants in
`ImgTex::texture_table` keyed by the 64-bit `__PAIR__(indexed-texture DID, palette DID)`
(:367720, add :367749), refcounted (cache hit = AddRef). Pairs with no maintainer DIDs
go to the untracked `custom_texture_table` set (:367753). This is the census's "INDEX16
expands ×2 + per-palette-variant duplicates": each worn palette variant is a distinct
full BGRA texture (+ its sysmem mirror).

## Exemption rule for the free-after-upload service

1. **Only touch ImgTexes that HAVE a GPU texture** (`m_pD3DTexture`/`m_pRenderTexture`
   non-null). CPU-only ImgTexes — palettized recolor sources, terrain base textures,
   alpha maps — are never uploaded; their `m_pImageData` is their only copy and is
   re-read on every combine/merge. Freeing those = refetch churn per merge (the hitch
   class), not memory savings. They are already governed by the tier-1 `memcaptex` caps.
2. **The droppable mass is the per-uploaded-texture `m_pSystemMemTexture` (+276) and any
   managed-pool mirror** — for every class, because RestoreLostSurface regenerates all
   three handler classes from DAT. Dropping it must pair with a device-reset route that
   marks the surface lost (`m_bIsLost`, base1map released) so the lazy :454374 check
   rebuilds it — do NOT leave `RestoreResource` as the only recovery.
3. **Palette-combined variants are droppable like any uploaded texture** (rule 2), with
   one ordering constraint: recreation calls `Combine`, which locks the palettized
   SOURCE — the source must be DBOCache-fetchable at that moment (it is; keep the
   `0x__FFxxxx`-style source records intact in the served DATs).
4. **Flush `temp_buffer_table` freely** under pressure (or cap it): pure scratch, never
   re-read, unbounded per distinct (format, size), r9 sizes make entries 16 MB+.
5. There is **no must-keep-CPU-bits class**: nothing reads texture bits post-upload that
   cannot be regenerated from DAT + palette + re-merge. The "exemptions" are about not
   touching never-uploaded sources (rule 1) and sequencing restores (rules 2–3).
