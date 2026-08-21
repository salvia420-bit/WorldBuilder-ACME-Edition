# acclient.exe patches (EoR build) — CORRECTED 2026-08-16

⚠ SUPERSEDED-IN-PART by `PATCHES.md` (the reproducible harness + registry).
This file's original claim was WRONG and is corrected below. See PATCHES.md
`patch_client.py` for the authoritative, byte-signature-located patcher.

Deliverable: `acclient.eor.leakfix+mip16.exe`
  (was misleadingly named `compress+mip16` — renamed; it has NO compression)

## Patch A — texture/palette LEAK fix (pre-existing; notan's, NOT compression)
- 0x13EFFE: FF 40 24 -> 90 90 90   (inc dword[eax+24])
- 0x13F19C: FF 46 24 -> 90 90 90   (inc dword[esi+24])
These NOP two refcount increments in **ImgTex / CreateFromRenderSurface_Internal**
texture code (link map: the region 0x13EFD0–0x13F1C0 is all ImgTex/RenderSurface;
`ImgTex::CreateD3DTexture` is 0x13EB10). This is notan's texture/palette LEAK
fix. **My earlier note calling this "DAT compression enable" was an unverified
assumption and is wrong** (flagged by the patch-harness agent; confirmed against
acclient.map). Shipped in the community EoR client.

## Patch B — mip-level cap 4 -> 16 (REJECTED 2026-08-16 far-pan QA)
- 0x13FC2D: 04 -> 10
`ImgTex::CreateD3DTexture` clamps computed mip count to 4; raising it was meant
to kill distant shimmer. **QA A/B showed it blanks every large upscaled DXT
world texture (white surfaces, all distances). Do not ship; see PATCHES.md.**

## ⚠ COMPRESSION PATCH DOES NOT EXIST YET
trevis's DAT-decompression fix targets `AsyncCache::SerializeFromCachePack`
(map RVA 0x00016AC0) / the `DiskController` cluster (~0x000F7Bxx) — a DIFFERENT
region entirely, present in NO file here. The ~40% headroom plan depends on
it, so it must still be LOCATED (byte-signature; the exe matches neither
acclient.c nor acclient.map — all three are different builds) and derived.
Until then, phase 2's headroom assumption is UNPROVEN.

Restore = pristine `acclient.exe`.
