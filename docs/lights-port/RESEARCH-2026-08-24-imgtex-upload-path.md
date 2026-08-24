# RESEARCH 2026-08-24 — ImgTex upload path: pools, CPU mirrors, and what the RGBA heap actually is

Fork deliverable for `HANDOFF-2026-08-24-rgba-mirror-diet.md` research task 2 (+3, +4).
Every claim below is read-verified in the decomp body (`~/ac-headers/acclient.c`, line
anchors cited as `:NNNNNN`); struct layouts from `acclient.h`.

## TL;DR — the "managed-pool mirror" hypothesis is WRONG, but the diagnosis stands

The client never uses D3DPOOL_MANAGED. It hand-rolls its own managed pool: for every
texture it keeps a **D3DPOOL_SYSTEMMEM mip-chain texture** (`ImgTex::m_pSystemMemTexture`)
as the permanent CPU mirror, and creates a **D3DPOOL_DEFAULT** render texture
(`m_pRenderTexture`, marked thrashable) on demand from it via `UpdateTexture`. The
SYSTEMMEM mirrors — allocated by the D3D runtime in process heap — are the 1,008 MiB of
RGBA-opaque committed private. Opaque textures are stored **X8R8G8B8 with the X byte
0xFF** (the dump fingerprint's "every 4th byte 0xFF").

## The three-stage pipeline (world DAT texture)

1. **DAT bits** → `RenderSurface::sourceData.sourceBits` (plain `new[]` heap, the raw DAT
   payload). `RenderSurface::CreateFromSourceData` (:128167) converts them into stage 2
   and then **frees them**: `RenderSurface::DestroySourceSurfaceBits` (:128100, called
   :128310). Source bits do NOT persist.
2. **Scratch staging surface** — `RenderSurfaceD3D`: the constructor sets `m_pool = 3` =
   **D3DPOOL_SCRATCH** (:685812); `CreateD3DSurface` (:685744) calls
   CreateOffscreenPlainSurface with that pool. SCRATCH = pure driver-side system memory
   in our process heap. Format conversion happens here (`SelectSurfaceFormat`, :127903):
   - compressed (pfDesc.flags&4, DXT): **kept as DXT** when
     `m_caps.bCompressedTextures` (always true on the 1070/T4) — DXT is never expanded;
   - alpha+color → `pfARGBTextures` (A8R8G8B8); alpha-only → `pfAlphaTextures`;
   - **color-only → `pfRGBTextures` = X8R8G8B8** ← every opaque 24bpp/16bpp texture
     becomes 32bpp with 0xFF pad;
   - data category 6 (UI) → `GetUISurfaceFormat`;
   - non-D3D formats (41/101/243/244, the palettized INDEX16 family — `IsD3DFormat`
     :127810) stay unconverted in a plain heap `m_pSurfaceBits` buffer
     (`RenderSurface::Create` :128137 heap path) and never reach D3D.
3. **ImgTex::CreateD3DTexture** (:366008, VA 0x53EB10): builds
   `m_pSystemMemTexture` — a `RenderTextureD3D` whose flags put it in **pool 2 =
   SYSTEMMEM** (`RenderTextureD3D::CreateD3DTexture` :685177: `poolD3D = 0; if
   (m_Flags>>1 & 1) poolD3D = 2;`) — with **up to 4 mip levels** (NumMipLevels clamp,
   :366113ff), fills level 0 by `D3DXLoadSurfaceFromSurface` from the scratch surface,
   generates mips with `D3DXFilterTexture`, then **purges the scratch surface**
   (`m_pImageData->PurgeResource()` + `MarkResourceAsLost`, :366170ff). So after a clean
   upload the ONLY persistent CPU copy is the SYSTEMMEM mip chain ≈ w·h·bpp/8 × 1.33.
4. **On first use** — `ImgTex::GetD3DTexture` (:365416): creates `m_pRenderTexture` in
   pool DEFAULT (TexFlags 0, or 4 = autogen-mips), `SetResourceIsThrashable(1)`, and
   fills it from the SYSTEMMEM texture (AddDirtyRect + device `UpdateTexture`). If the
   DEFAULT copy is lost or evicted it is silently rebuilt from the mirror — this is the
   client's whole texture manager (`m_AllowManagement` / `m_ManagedRefCount` /
   `DiscardResourceBytes` retry loop on E_OUTOFMEMORY, :685234ff).

## Per-class table

| class | staging (freed?) | persistent CPU copy | pool of GPU copy | RGBA-0xFF fingerprint? |
|---|---|---|---|---|
| world DXT (r10 highres) | SCRATCH surface, purged after upload | SYSTEMMEM **DXT** mip chain (m_pSystemMemTexture) | DEFAULT, thrashable | no (DXT blocks) |
| world opaque RGB | SCRATCH (converted X8R8G8B8), purged | SYSTEMMEM **X8R8G8B8** mip chain | DEFAULT, thrashable | **YES** |
| world alpha | SCRATCH (A8R8G8B8), purged | SYSTEMMEM A8R8G8B8 mip chain | DEFAULT, thrashable | partial |
| terrain merged (TexMerge) | `TexMerge::tex_data` static 4·base² (:305935) + `GetTempBuffer` ImgTex | SYSTEMMEM **X8R8G8B8** mip chain per land-cell pcode; ImgTex in `custom_texture_table` (:367776), CSurface via `UseTextureMap` | DEFAULT, thrashable | **YES** |
| palettized INDEX16 source (PFID 41/101) | — | plain heap `m_pSurfaceBits`, 16bpp indices, **kept forever** (CreateD3DTexture refuses them: `if (m_pSurfaceBits) return 0`, :366059) | none (never uploaded) | no (index data) |
| combined clothing/creature (INDEX16 ⊗ palette) | SCRATCH (fmt 22, or 21 w/ clipmap), purged | SYSTEMMEM **X8/A8R8G8B8** mip chain per (texDID,palDID) pair in `ImgTex::texture_table` (:367699) | DEFAULT, thrashable | **YES** (X8 variants) |
| temp buffers | — | `ImgTex::temp_buffer_table` (:367485): ONE ImgTex per distinct (format,w,h), **never freed** — 2048² X8R8G8B8 = 16 MB each (the "15.8MB blocks") | — | **YES** |

## The merged-terrain path specifically

`TexMerge::MakeNewSurface` (:306275) / `RestoreSurface` (:306241):
`FillTempTexBuffer` (:305909) composites into the static `tex_data`, then
`ImgTex::CreateLScapeTexture` (:367758) → `LoadCSI` (:367644) creates a SCRATCH
X8R8G8B8 surface (format 22 literal) sized `(base_tex_size >>
ImageShift[fLandTextureScale]) / pcode-size`, runs `CSI2TGA` through a persistent
`GetTempBuffer` ImgTex, uploads, purges the scratch. **`TexMerge::RestoreSurface` is a
complete regeneration path** — it re-merges from the terrain source textures on demand,
which is what makes merged SYSTEMMEM mirrors droppable insurance.

## Device-loss story

- `RenderDeviceD3D::ResetDevice` (:459792): `GraphicsResource::PurgeResources()` →
  `Reset(presentD3D)` (retry loop on D3DERR_DEVICELOST with 200 ms sleeps) →
  `GetD3DResources` → lazy restore. Purged/lost resources come back through
  `GraphicsResource::RestoreLostResources` (:131171, driven from the render loop
  :380774/:380805) and per-use `m_bIsLost` checks (`GetD3DTexture` head, :365433).
- SYSTEMMEM textures and SCRATCH surfaces survive Reset by definition; only
  DEFAULT-pool objects are purged/recreated — today always refilled from the SYSTEMMEM
  mirror, never from disk.
- If a mirror is ALSO gone, `ImgTex::RestoreResource` (:366203) → `CreateD3DTexture`
  requires `m_pImageData` restored first, i.e. a DAT re-read (DBObj/GraphicsResource
  restore chain) — or `TexMerge::RestoreSurface` for merged terrain, or a re-`Combine`
  for clothing. The machinery exists; it is just never exercised for mirrors today.

## Palette-recolor exemption list (research task 4)

Only PFIDs **41 and 101** enter `ImgTex::Combine` (:367576 guards on exactly those two);
243/244 are the other two non-D3D formats (`IsD3DFormat` :127810) and likewise live in
CPU-only `m_pSurfaceBits`. These indexed sources are re-read on every palette combine
(`CopyIntoData`, Palette::Modify path) and MUST keep their CPU bits. They are 16bpp
index data — cheap, and NOT part of the RGBA-opaque 1,008 MiB. The combined OUTPUTS are
ordinary mirrored textures and are droppable, at the cost of a re-Combine on loss.

## What this means for the diet (implementation notes)

1. The target is `m_pSystemMemTexture` release-after-`UpdateTexture`, not a pool change:
   the GPU copies are already DEFAULT-pool. Free the mirror once the DEFAULT copy is
   filled; on loss/eviction fall through to the existing restore chain (DAT re-read /
   re-merge / re-combine) instead of `UpdateTexture`.
2. Class order by payoff and safety: merged terrain (regenerable by design, proven
   RestoreSurface path) → combined clothing (regenerable via Combine; verify the
   restore chain actually re-runs Combine on a lost combined ImgTex before defaulting
   ON) → world DXT/X8 (needs the DBObj re-read path exercised).
3. `temp_buffer_table` (:367485) is a second, smaller win: entries are keyed by size and
   never freed; with r9 sizes each is ~16 MB. A trim hook (drop entries not used for N
   s) is zero-risk — they are pure scratch, `AllocateTempBuffer` recreates.
4. Exemption: never touch ImgTex whose image data format ∈ {41, 101, 243, 244}.
5. `GetD3DTexture` stamps `m_TimeUsed`/`m_FrameUsed` per use (:365436ff) — free
   mirror-release logic can piggyback on those fields for "hot" detection.
