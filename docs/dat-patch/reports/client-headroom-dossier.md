# Client headroom dossier — can binary-patching `acclient.exe` buy us more triangles and heavier textures?

**Date:** 2026-08-15 · **Scope:** read-only investigation. No binary, DAT, ACE, or config was modified.
**Question (owner):** "Could we patch acclient.exe (Mag-ACClientPatcher style, on-disk binary patches)
to open headroom for MORE triangles and HEAVIER textures in the DATs? Maybe it's easy and we haven't tried."

**Short answer:** mostly we do not need a patch. The two limits people *assume* are the problem —
the 2 GB address space and a texture-dimension cap — are respectively **already lifted in the shipped
binary** and **do not exist**. The one hard wall that actually constrains the dat-patch project is the
**2 GiB DAT file ceiling**, and that one is *not* a byte patch. The single highest-value patch is a
different thing entirely: **trevis's one-instruction DAT-compression fix**, which buys ~460 MiB of
on-disk budget under that ceiling.

---

## 0. Verdict table

| # | Limit | Current reality (verified) | Patch needed? | Mechanism | Effort | Risk |
|---|---|---|---|---|---|---|
| 1 | **32-bit address space** | `acclient.exe` (EOR, linked 2015-06-12) **already has `IMAGE_FILE_LARGE_ADDRESS_AWARE`**. COFF `Characteristics = 0x012E`. PE checksum validates → unmodified retail binary. | **NO — already done** | — (PE flag already set) | — | — |
| 2 | **Texture dimensions** | No cap. `MaxTextureWidth/Height` are copied from D3D9 caps and **never read**. `CreateTexture` gets w/h verbatim. No POW2/square check in the world-texture path. | **NO** | — | — | — |
| 3 | **`EnvironmentTextureDetail` → 2-entry SurfaceTexture always resolves to the LOW entry** | `Render::ShouldDropHighDetail()` returns true whenever the pref ≠ 0, and **no preset ever sets it to 0**. A 2-entry `SurfaceTexture` therefore always yields entry `[1]`. | **NO — dodge in data** | Ship **single-entry** `SurfaceTexture` records (`m_num == 1` branch is unconditional). Tool already exists: `surface-texture-collapse`. | S (already built) | Low |
| 4 | **`>> fCurrentTextureScale` load-time downscale** | **Bites at the boot default.** `Render::Startup` calls `SetOverallGraphicsQuality(3)`, which sets the pref to 2 → `HALF_RES`. **A shipped 1024² renders at 512² out of the box.** | **NO if we ship a config; else YES** | Ship a default user config with `Render.EnvironmentTextureDetail = 0`. Fallback byte patch: the preset immediates in `SetOverallGraphicsQuality`. | S | Low (config) / Med (patch) |
| 5 | **4-mip-level cap** | `ImgTex::CreateD3DTexture` clamps the generated chain to **4 levels**. A 1024² bottoms out at 128² → minification shimmer at distance. | **YES — the one clean quality patch** | Byte patch: raise the `4` immediate in the mip-count clamp. | S | Low–Med |
| 6 | **Geometry / poly counts** | 16-bit indices cap a GfxObj at **65,535 vertices**. Heaviest retail GfxObj = **1,446 verts**; at 12× = 17,352 = **26 % of the cap**. | **NO** | — | — | — |
| 7 | **DBOCache budgets** | Count-based, but they bound only the *freed-shell freelist* (payload already released). The **live resident set has no cap in any unit**. Heavier assets are invisible to it. | **NO** | — | — | — |
| 8 | **GfxObjDegradeInfo / LOD** | A GfxObj with **no degrade record is always full mesh**. **BUT** if it *has* one, the root mesh is **never drawn at all** — every band including 0 comes from the degrade record, and band 0 is often a *different* GfxObj. 4,131 such records exist; 68 % do real swaps. | **NO — fix in data** | Clear `GfxObjFlags.HasDIDDegrade` on replaced GfxObjs, or repoint band 0. | S | Low |
| 9 | **DAT file size** | **HARD 2 GiB ceiling** (0x7FFFFFFF). Bit 31 of every block offset is a free-block flag; `DiskDev::SyncRead` seeks signed-32 with a NULL high word. | **Not byte-patchable** | Would require rewriting the block allocator + every mask site + SetFilePointerEx. | **L** | **High** |
| 10 | **DAT compression** | Client supports zlib'd records but a one-instruction bug (`m_iVersion` zeroed on decompress) breaks it. **trevis has a working fix; measured 50 % on portal.dat.** | **YES — highest value** | Byte patch at `DiskController::Decompress` (preserve `m_iVersion`). | S–M | Med |
| 11 | **UI textures only** | `UISurface::CreateSurface` hard-rejects > 2048 and force-rounds to power-of-two. | **NO** (avoid in data) | Keep world art off the UI path. | — | — |

---

## 0b. Method and provenance caveats — read before quoting any address

1. **`acclient.c` and `acclient.map` are DIFFERENT BUILDS.** `DiskDev::SyncRead` is at `0x676C60`
   in the decomp (matching the 2013 Binary Ninja pass, `acclient_2013.bndb_pseudo_c.txt:631939`)
   but `0x676CC0` in `acclient.map` — a consistent ~0x60 delta in that region. Our on-disk
   `acclient.exe` is the 2015-06-12 EOR build. **Neither address source can be trusted verbatim
   for patching our binary.** Locate every patch by byte-signature (needle/replace), which is
   exactly what Mag's and Yonneh's patchers already do. This is the #1 way to ship a bad patch.
2. All decomp claims below were opened and read, not recalled. Symbols are given so they can be
   re-derived: `rg -an 'Class::Method\(' $DECOMP/acclient.c | rg -v ';'`.
3. Local artefacts used: `/home/wbterminal/ac_base_dats/{acclient.exe,client_portal.dat,client_cell_1.dat,client_local_English.dat}`.
   `client_highres.dat` is **not** present in the base set.
4. **We already have a patch workspace and one applied patch.** `/mnt/wbterminal2/ac-eor-patch/`
   holds `acclient.eor.orig.exe`, `acclient.eor.patched.exe` (2026-07-26) and a pristine `acclient.exe`
   (md5 `116d9a66a70b6af449dc3a28d82f2f6d`, byte-identical to the base-dats copy). Diffing orig vs
   patched gives **exactly 6 changed bytes** — two 3-byte NOP runs:

   ```
   file 0x13EFFE   ff 40 24  ->  90 90 90     (inc dword ptr [eax+24h]  -> nop nop nop)
   file 0x13F19C   ff 46 24  ->  90 90 90     (inc dword ptr [esi+24h]  -> nop nop nop)
   ```

   These are notan's palette-leak fix, at the exact offsets the community documents. So the
   precedent is not merely external — **the on-disk patch loop already works here, and the harness for
   trying anything in this dossier exists.** Every candidate patch below should be built and diffed the
   same way (orig + patched + byte-run diff), never applied in place.

---

## 1. ADDRESS SPACE — the client is already Large Address Aware. Community folklore is wrong.

Parsed directly from `/home/wbterminal/ac_base_dats/acclient.exe`:

```
PE TimeDateStamp = 0x557A956C  = 2015-06-12 08:16:44 UTC
Machine          = 0x014C (i386)      OptMagic = 0x10B (PE32)
COFF Characteristics = 0x012E
    → IMAGE_FILE_LARGE_ADDRESS_AWARE (0x0020) = TRUE
DllCharacteristics = 0x0000   (no ASLR, no DEP, no SEH flags — VC-era binary)
ImageBase 0x400000  SizeOfImage 0x56D000
Stored PE checksum 0x004A60C3 == recomputed 0x004A60C3  → binary unmodified since link
```

The COFF `Characteristics` byte lives at **file offset 0x15E**. The LAA bit is set and the
checksum still validates, so this is stock retail — nobody patched it, Turbine shipped it that way.

**This contradicts the community's settled belief.** From the Discord archive:

- *decalinfo / Hells / 2024-03-19:* "Your system memory is largely irrelevant, acclient can only consume 2gb"
- *decalinfo / Hells / 2024-01-16:* "client will crash the closer to 2gb it reaches / prob closer to 1.6"
- *chorizite / paradox (ex-Turbine) / 2024-10-21:* "you can edit the large memory aware bits in the exe to enable it. we didn't during retail b/c the launcher hashed the client to check updates each launch"

paradox's recollection is of an earlier era; the 2015 EOR build has the bit. Across 477,753 archived
messages, `"large address aware"` + `LAA` return **exactly two hits** and nobody ever reports
having checked the flag on the shipped exe.

**What LAA buys us:** on 64-bit Windows an LAA 32-bit process gets a **4 GB user address space**
instead of 2 GB. That is not theoretical headroom for the DATs, though — the client **does not
memory-map them** (verified: the only `CreateFileMapping`/`MapViewOfFile` call sites are a 7 KB
anonymous section at `acclient.c:719466` and `MMapUtil::MMap` at `:724052`, whose sole caller is
`PFileParser::LoadBinary`, the loose-file path). DAT access is pure streamed `SetFilePointer` +
`ReadFile`. So our +1 GB of DAT content costs address space **only as much of it as is resident**.
(Note: trevis's "memory mapped dat stuff" in Discord refers to *his own* C# tooling, not acclient.)

**Honest caveat — do not bank headroom we haven't measured.** LAA is set, yet users report crashes
near 1.6–2 GB. Something other than the PE flag is capping them (the client's own allocator, address
fragmentation, or the well-known palette/icon leak). Before assuming ~2 GB of new headroom, measure
peak private bytes of a real EOR client under a heavy scene. Two known mitigations already exist:
notan's palette-leak patch (`github.com/eriknihlen/ac-eor-palette-leak-fix`, two 3-byte NOPs, "leak
rate drops ~95 %+"), and the undocumented `-usemem` switch (`acclient.c:78284`; default
`m_fUseMemoryManager = 0` at `:78671`; the string is present in our exe).

**Verdict: no patch needed. Instead, correct the project's assumption and measure.**

---

## 2. TEXTURE PATH — no dimension cap exists

### 2a. `MaxTextureWidth` / `MaxTextureHeight` are written and never read

Exhaustive over the whole 938,010-line decomp — five hits, all writes:

```
acclient.c:455604   this->m_caps.MaxTextureWidth  = 0;      (RenderDeviceD3D ctor)
acclient.c:455605   this->m_caps.MaxTextureHeight = 0;
acclient.c:457123   v2 = v1->m_D3DCaps.MaxTextureHeight;    (RenderDeviceD3D::DetectDeviceCaps, :457087)
acclient.c:457127   v1->m_caps.MaxTextureWidth  = v1->m_D3DCaps.MaxTextureWidth;
acclient.c:457129   v1->m_caps.MaxTextureHeight = v2;
```

No read site, no `min()`, no comparison, no rejection. Cross-checked against the independent 2013
Binary Ninja decomp: two hits, the same copy. **The device cap is dead code.**

### 2b. The actual D3D call passes dimensions through verbatim

There is exactly **one** `IDirect3DDevice9::CreateTexture` in the client, in
`RenderTextureD3D::CreateD3DTexture` (`acclient.c:685177`), called at `:685242` with
`m_nWidth, m_nHeight, m_nNumLevels, <usage>, m_PixelFormat, pool` — all caller-supplied
(`:685244-685251`). The only failure handling is a `D3DERR_OUTOFVIDEOMEMORY` retry driven by
`GraphicsResource::DiscardResourceBytes`; any other HRESULT returns 0 silently (`:685313`).
There are **no `D3DXCreateTexture*` call sites at all** (searched: zero hits).

`RenderTexture::Create2D` (`acclient.c:136287`) does zero validation — it only rejects
`_Flags & 2 && _Flags & 1`, then stores width/height/levels/format.

### 2c. Power-of-two and squareness — decoded, then ignored (except in the UI)

- `D3DPTEXTURECAPS_SQUAREONLY` is decoded into `m_caps.bSquareTexturesOnly` (`acclient.c:457147`)
  and **never read**.
- `D3DPTEXTURECAPS_NONPOW2CONDITIONAL` is never decoded. Instead `acclient.c:457153` hardcodes
  `bSimpleNonPowerOfTwoTextures = 0` — and that field is read in exactly **two places, both UI**
  (`UISurface::GetBestWidthHeight` `:124826`, `UISurface::CreateSurface` `:124918`).
- No manual `& (w-1)` / IsPow2 check exists anywhere in the `ImgTex` / `RenderSurface` world path.

**Keep shipping power-of-two anyway** — the client will happily hand an NPOT texture to D3D9 and
silently get 0 back on hardware that refuses it.

### 2d. What the DAT record must satisfy (this one WILL bite)

`RenderSurface::Serialize` (`acclient.c:128423`) hard-rejects a record unless the size matches
exactly (`acclient.c:128504-128508`):

```c
if ( !(flags & 0x10)   /* 0x10 == PFID_CUSTOM_RAW_JPEG only */
  && imageSize != width * height * bitsPerPixel >> 3 )
    { Archive::RaiseError(...); return; }
```

For DXT1 that is `w*h/2`; for DXT5 `w*h`. **Dimensions must be multiples of 4** or the identity
cannot hold and the record is thrown away. `Width`/`Height` are `int` in the format
(`dats.xml:3680-3681`) — no dimension cap in the schema either.

### 2e. Mips — the client builds them itself, and caps the chain at 4 levels

The DAT does **not** need to carry a mip chain for `0x05`/`0x06` content. `ImgTex::CreateD3DTexture`
(`acclient.c:366008`) uploads level 0 and then generates the rest in software:

```
acclient.c:366157   D3DXLoadSurfaceFromSurface(..., 0x70005 /* BOX|MIRROR */, ...)
acclient.c:366160   D3DXFilterTexture(v24, 0, -1, 0x70005)
```

But the level count is clamped (`acclient.c:366110-366125`):

```c
v16 = 1; NumMipLevels = 1;
v17 = max(width, height);
if ( v17 > 1 ) { do { v17 >>= 1; ++v16; } while (v17 > 1);
                 NumMipLevels = v16;
                 if ( (unsigned)v16 > 4 ) NumMipLevels = 4; }   /* <-- acclient.c:366125 */
```

`NumMipLevels` then flows into `RenderTexture::Create2D` via vtable `+88` at `acclient.c:366133`
(the decompiler drops arguments at that call site, but `Create2D`'s signature is
`(width, height, _nNumLevels, format, flags)` — `acclient.c:136287` — and `NumMipLevels` is the only
level count in scope). It also feeds the `SetResourceSize` accounting loop at `:366166-366171`.

**Consequence:** a 1024² texture gets levels 1024 / 512 / 256 / 128 and nothing smaller. Retail's
256² textures bottomed out at 32². So our high-res art will **shimmer and alias at distance** where
retail did not — the top-line visual regression of the whole plan, and the one place a byte patch
genuinely earns its keep. Raising that `4` immediate is small, self-contained and low-risk.

*Also:* `D3DUSAGE_AUTOGENMIPMAP` is effectively never used for DAT content. It is requested only when
the format is **not** compressed **and** `m_nNumLevels == 1` (`acclient.c:365464-365468`), then gated
on `m_caps.bAutoGenMipMaps` (`:685228`). A large DXT texture fails both preconditions.

### 2f. DXT passes straight through

`PixelFormatDesc::SetFormat` decodes all five FourCCs — DXT1 `flags=4, bpp=4` (`acclient.c:122093-122097`),
DXT5 `flags=4, bpp=8` (`:122165-122167`), DXT2/3/4 likewise (`:122152-122162`). The compressed branch
of `RenderSurface::CreateFromSourceData` is a single `qmemcpy` of the whole payload
(`acclient.c:128272-128275`) — no decode, no recompress. `RenderTexture::SelectTextureFormat`
explicitly exempts compressed formats from conversion (`:136364`).

**One caveat:** whenever `fCurrentTextureScale != 0` (§3), the D3DX resize path must decompress and
recompress — generation loss plus a synchronous CPU cost that scales with area. The D3DX DXT codecs
are statically linked (`D3DXTex::D3DXDecodeDXT1/5` at `:555285`/`:555429`,
`D3DXEncodeDXT1/5` at `:555525`/`:555674`).

### 2g. Fixed buffers — one real cap, and it is not ours

- `TexMerge::tex_data` is allocated **once** as `4 * base_tex_size²` and never grown
  (`acclient.c:305934-305935`). `base_tex_size` comes from the Region record. This caps
  **landscape merged-tile** resolution, not object/building textures.
- `TextureBasedFont`'s glyph atlas is hardcoded 256×256 (`:686139-686140`, `:687139-687140`). Font only.
- No fixed-pitch or fixed-temp-buffer row loop exists in the DAT upload path; the uncompressed arm
  (`:128282-128299`) is pitch-aware and dimension-driven, and DXT bypasses it entirely.

### 2h. UI path — a real 2048 wall, avoid it

`UISurface::CreateSurface` (`acclient.c:124912`, and again at `:125048`) hard-rejects any surface
with `_nWidth > 0x800 || _nHeight > 0x800`, and the pow2 rounder saturates at 2048
(`:124840`, `:124860`). World art never goes through here — **keep it that way.**

---

## 3. TEXTURE-DETAIL OPTION — found. Two independent reducers, both live at the boot default.

**Both are dodgeable without a binary patch** — one config line plus single-entry records — but
neither is dodgeable by doing nothing.

Two user preferences, registered in `Render::Startup` (`acclient.c:382043-382065`):

```
acclient.c:41517   const unsigned int Render_LandscapeTextureDetail_Values[5]   = { 4, 3, 2, 1, 0 };
acclient.c:41518   const unsigned int Render_EnvironmentTextureDetail_Values[5] = { 4, 3, 2, 1, 0 };
acclient.c:45605   int dword_81EF98 = 2;   // Landscape texture detail   (static default)
acclient.c:45606   int dword_81EF9C = 1;   // Environment texture detail (static default)
```

`Render::UpdateFromPreferences` (`acclient.c:380924`) turns the pref into a shift
(`acclient.c:380982-380992`):

```c
if ( Current_Render_EnvironmentTextureDetail != dword_81EF9C ) {
    bNeedReloadTextures = 1;
    v2 = dword_81EF9C ? dword_81EF9C - 1 : 0;
    ImgTex::fClipmapTextureScale = v2;
    ImgTex::fRGBATextureScale    = v2;
    ImgTex::fIndexedTextureScale = v2;
}
```

Preset values, `Render::SetOverallGraphicsQuality` (`acclient.c:378743`):

| preset | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `LandscapeTextureDetail` | 4 | 3 | 2 | 2 | 0 |
| `EnvironmentTextureDetail` | 4 | 3 | 2 | **1** | **1** |

### 3a. Mechanism A — the load-time bit shift (`ImgTex::CreateD3DTexture`)

```
acclient.c:366084   v12   = v11 >> ImgTex::fCurrentTextureScale;   // width
acclient.c:366085   width = v11 >> ImgTex::fCurrentTextureScale;
acclient.c:366090   v14   = v13 >> ImgTex::fCurrentTextureScale;   // height
```
floored at `ImgTex::min_tex_size = 8` (`acclient.c:45327`, applied `:366091-366108`).

`fCurrentTextureScale` is selected per asset class immediately before the load:
`CSurface::RestoreLostSurface` (`:358369`) → `fRGBATextureScale` for handlers 1/4 (plain RGBA/DXT
object + environment textures) and `0` for handler 3 (TexMerge/terrain);
`CSurface::SetTextureAndPalette` (`:357818`) → `fIndexedTextureScale` / `fClipmapTextureScale`.

**Impact on us: NOT benign — the boot default halves our textures.** The static initializer says 1,
but it is overwritten before any preference is registered. The very first thing `Render::Startup`
does (`acclient.c:381940`) is:

```
acclient.c:381965   Render::m_CacheOverallGraphicsQuality = 3;
acclient.c:381966   Render::SetOverallGraphicsQuality(3u);
```

and preset 3 sets `dword_81EF9C = 2` (`acclient.c:378773`). The `RegisterPreference` calls that would
load a saved config value all come *after*, at `acclient.c:382000+` in the same function. **Absent a
saved user config, the effective boot value of `EnvironmentTextureDetail` is 2 → `fRGBATextureScale = 1`
→ `HALF_RES`. A shipped 1024² object texture is downscaled to 512² on load.** The reduction is real —
`D3DXLoadSurfaceFromSurface` + `D3DXFilterTexture` box-filter the source into a genuinely smaller D3D
surface (`acclient.c:366157-366160`); no filtering change recovers it. For DXT source that also costs
a decompress/recompress round trip and its generation loss.

| `EnvironmentTextureDetail` | UI label | `fCurrentTextureScale` | our 1024² renders at |
|---|---|---|---|
| 0 | VeryHigh | 0 FULL_RES | **1024** |
| 1 | High | 0 FULL_RES | **1024** |
| **2 — boot default** | Medium | 1 HALF_RES | **512** |
| 3 | Low | 2 QUARTER_RES | 256 |
| 4 | VeryLow | 3 EIGHTH_RES | 128 |

Note the value table is **inverted** relative to the UI order (`acclient.c:41517-41518` = `{4,3,2,1,0}`
against choices built VeryLow→VeryHigh), so 0 is the *best* setting.

**The fix costs nothing and needs no patch: ship a default user config with
`Render.EnvironmentTextureDetail = 0`.** That single value is also exactly what §3b needs — it is the
only value for which `ShouldDropHighDetail()` can be false — so one config line defeats *both*
texture-reduction mechanisms at once. Byte-patching the preset immediates in
`Render::SetOverallGraphicsQuality` (`acclient.c:378751-378795`) is the fallback if we cannot control
the config. (Also beware `Render::sm_WantSafeRenderSettings`, which forces both prefs to 2 —
`acclient.c:382200-382201`.)

*Distinct convention for terrain:* the landscape path indexes `ImageShift[5] = {0,1,2,4,8}`
(`acclient.c:40343`) via `fLandTextureScale` (`:306252`, `:306287`) — index 3 shifts **4 bits** (1/16)
and index 4 shifts **8** (1/256). With the default `LandscapeTextureDetail = 2` → shift 1, terrain
textures are **halved by default**. Out of scope for architecture/dungeons, but worth knowing.

### 3b. Mechanism B — level selection, and this one bites at EVERY preset

`ImgTex::GetSurfaceDID` (`acclient.c:366232`) is where a `SurfaceTexture` (0x05) resolves to a
`RenderSurface` (0x06):

```c
if ( this->m_SourceLevels.m_num == 1 ) goto LABEL_9;              /* always level 0 */
if ( this->m_SourceLevels.m_num != 2 )
    { IError::ReportDataErrorFrom(m_DID, "Cannot get surface DID, no source levels are listed!");
      return INVALID; }
if ( Render::ShouldDropHighDetail() ) result->id = m_SourceLevels.m_data[1].id;   /* LOW  */
else                        LABEL_9:  result->id = m_SourceLevels.m_data[0].id;   /* HIGH */
```

and (`acclient.c:379978-379986`):

```c
BOOL Render::ShouldDropHighDetail()
{ return !DBCache::s_pCache->...AreOnDisk(1766222152, 1) || dword_81EF9C; }
```

`1766222152 = 0x69466948`, whose little-endian bytes spell **`"HiFi"`** — the identical magic passed
as the `PORTAL_DATFILE` container id in `CLCache::LoadHighResDat` (`acclient.c:293704-293710`). So the
probe means literally *"is `client_highres.dat` mounted?"*.

**Because no preset ever sets `EnvironmentTextureDetail` to 0** (they set 4/3/2/1/1) and the boot
default is 2 (§3a), `ShouldDropHighDetail()` is **true for every realistic user**. A 2-entry
`SurfaceTexture` therefore *always* resolves to entry `[1]`. Entry `[0]` is effectively dead unless
the user manually picks the "VeryHigh" dropdown choice.

Empirically confirmed against `client_portal.dat`: of 181 sampled `SurfaceTexture` records, **101 have
1 level and 80 have 2**; of 12 sampled level-`[0]` DIDs, **10 are absent from `client_portal.dat`
entirely** — they live in `client_highres.dat`, exactly as the `"HiFi"` probe implies. Every level-`[1]`
DID resolves (e.g. `0x0500000C → [0x06003B9D, 0x06003B9E]`, with `0x06003B9E` = 128×128 `PFID_INDEX16`).

**The escape hatch costs nothing: ship SINGLE-ENTRY `SurfaceTexture` records.** `m_num == 1` takes
the unconditional full-detail branch. The project already understands this and already has the tool:
`surface-texture-collapse` (`WorldBuilder.Terminal/CommandEngine.DatBake.cs:307-390`,
`JsonCommandProcessor.cs:862`), whose own doc comment states the semantics correctly.

*(Sibling mechanism, not ours:* `RenderTexture::DropUnwantedLevels` (`acclient.c:137195`) drops the
top *N* levels of a `DB_TYPE_RENDERTEXTURE` (0x15) mip chain, `N` = the raw pref, from
`InitLoad` (`:137460`) and `GetSubDataIDs` (`:137416`). It early-outs at `m_num <= 1`. 0x15 is
effectively unused in retail portal.dat — but it is a live trap if anyone migrates content to it.
Nothing in the existing mining docs covers `DropUnwantedLevels`; this is a new finding.)*

### 3c. `client_highres.dat` — a real, sanctioned second volume, and ACE currently disables it

The client has a first-class optional high-resolution DAT:

```
acclient.c:293658   void CLCache::LoadHighResDat(CLCache *this)
acclient.c:293684       PStringBase<char>(&data_filename, "client_highres.dat");
acclient.c:293704       DiskConInitInfo(..., PORTAL_DATFILE, 0x69466948u, ...);
acclient.c:293790   if ( v2->m_dwProductID & 4 ) CLCache::LoadHighResDat(this);   // OnServerInterrogation
```

Mounting is **server-gated** on bit 2 of `m_dwProductID` in the DDD interrogation message — and
vanilla ACE hardcodes the flag off:

```
ace-server/Source/ACE.Server/Network/GameMessages/Messages/GameMessageDDDInterrogation.cs:10
    Writer.Write(1u); // m_dwProductID
```

ACE already knows the file otherwise (`ACE.DatLoader/DatManager.cs:64-71`, `ITERATION_HIRES = 497`).
Writing `5u` instead of `1u` would make every client mount `client_highres.dat` — **a second
portal-type DAT with its own independent 2 GiB budget.** That is a server-side one-token change,
not a binary patch, and it collides with the project's `keep-ACE-vanilla` rule, so it is a decision
to escalate rather than an action to take. It is also only half a solution: level `[0]` still needs
`ShouldDropHighDetail()` to be false, which needs either the user's dropdown or the byte patch in §8.

---

## 4. CACHES — DBOCache budgets are real, count-based, patchable, and **irrelevant to us**

The table lives in `MasterDBMap::InitDBTypeDef_Internal` (`acclient.c:91986`), 50 `FreelistDef`
records (`acclient.h:27715-27721`: `m_bRecycle, m_bShrink, m_nIdealSize, m_nMaxSize`), copied into
each `DBOCache` at construction (`acclient.c:83975-83977`). Ours:

| DB_TYPE | # | ideal | max | line |
|---|---|---|---|---|
| GFXOBJ | 6 | 100 | 200 | `:92196` |
| SURFACETEXTURE | 11 | 100 | 400 | `:92331` |
| RENDERSURFACE | 12 | 100 | 400 | `:92388` |
| SURFACE | 13 | 50 | 200 | `:92415` |
| DEGRADEINFO | 26 | 80 | 200 | `:92761` |
| RENDERTEXTURE | 30 | 128 | 256 | `:92869` |
| SETUP | 7 | 25 | 100 | `:92223` |

They are immediate `mov dword ptr [ebp+X], imm32` stores — no registry, no ini (searched:
`GetPrivateProfile*` appears only as unused Win32 import declarations at `:38669-38670`). So yes,
byte-patchable.

**But they do not do what the name suggests.** The enforcement is on `m_nFree`, a raw count, in
`DBOCache::FreelistAdd` (`acclient.c:83190-83197`) — and the freelist's only producer,
`DBOCache::FreeObject` (`:83049`), **releases the payload before enlisting the shell**
(`:83056-83061`). So "max 400" means 400 *empty allocator husks*. The live resident set is
`m_ObjTable`, tracked by `m_nTotalCount` — which is incremented at `:83889`, decremented at `:83911`,
zeroed at `:83972`, and **never compared to anything**. There is no live-set cap, in any unit.

Eviction is FIFO by release timestamp, not LRU by use (`m_timeStamp` is stamped at release, `:83181`);
`DBOCache::UseTime` (`:83129-83150`) destroys **one** stale (>30 s) shell per tick when
`m_nFree > m_nIdealSize`. The recycle path (`:83108-83116`) is dead — `m_bRecycle = 0` for all 50 types.

The only byte-aware machinery is `GraphicsResource::DiscardResourceBytes` (`acclient.c:131576`),
which is **reactive only**: it runs on `D3DERR_OUTOFVIDEOMEMORY` (`:687621`, `:685234`). The counters
`g_nTotalTextureRemoteBytes` (`:59085`), `g_nTotalSurfaceRemoteBytes` (`:59143`),
`g_TotalIndexBufferRemoteBytes` (`:59172`) are only `+=`/`-=` — **pure telemetry, never compared.**

**Verdict: nothing to raise. Heavier entries are invisible to these budgets, and there is no cap to
blow. The exposure is system RAM and VRAM, which is what §1's measurement is for.**

---

## 5. DEGRADE / LOD — missing record = full mesh; **present** record = the root mesh is never drawn

**This section contains the one finding most likely to silently waste the whole geometry effort.**

`CPhysicsPart` (`acclient.h:31155-31159`) holds `GfxObjDegradeInfo *degrades; unsigned deg_level;
int deg_mode; CGfxObj **gfxobj;` and draws `gfxobj[deg_level]`. Both selection sites are guarded:

```c
/* acclient.c:315158-315168 and CPhysicsPart::UpdateViewerDistance :315190-315200 */
v10 = v1->degrades;
if ( v10 && <not the player> )
    GfxObjDegradeInfo::get_degrade(v10, distance, &v1->deg_level, &v1->deg_mode);
else { v1->deg_level = 0; v1->deg_mode = 1; }
```

**No degrade record → `deg_level = 0` → `gfxobj[0]`, the full mesh, at every distance.** Degrade is
opt-in data, not a default, and there is no procedural or automatic decimation anywhere in the client.

### 5a. The band-0 trap — replacing a GfxObj that *has* a degrade record changes nothing

`CPhysicsPart::LoadGfxObjArray` (`acclient.c:314892`) builds the draw array. When a degrade record
exists, **the array is populated exclusively from `degrades[i].gfxobj_id` — the root GfxObj is never
inserted at any index, including 0** (`acclient.c:314920-314951`). The root is used only in the `else`
branch, i.e. when there is no degrade record (`acclient.c:314955-314962`):

```c
  v5.id = *(_DWORD *)(v4 + 176);                       /* root GfxObj's m_didDegrade */
  QualifiedDataID::QualifiedDataID(&v18, v5, 0x1Au);   /* DB_TYPE_DEGRADEINFO = 26 */
  *new_degrades = (GfxObjDegradeInfo *)DBObj::Get(v6);
  if ( v7 ) { /* fill gfxobj[i] from degrades[i].gfxobj_id for all num_degrades */ }
  else      { /* single-element array = the root object itself */ }
```

And band 0 is frequently a **different** GfxObj. Worked example from the real portal.dat:
`0x0100226A` carries `HasDIDDegrade` → `0x1100039D`, whose bands are
`[0x010022B8 (0/4/10), 0x010025BB (3/7/18), 0x010025BC (10/15/30), 0x010025BD (84/84/84), 0x0 (FLT_MAX)]`.
**Band 0 is `0x010022B8`, not `0x0100226A`.** Replacing `0x0100226A`'s geometry with a 12× mesh would
be invisible at every distance.

Prevalence in `client_portal.dat`: **4,131 `GfxObjDegradeInfo` records** against 15,318 GfxObjs. Of 296
sampled records, **202 (68 %) reference more than one distinct real GfxObj** (genuine mesh swaps);
bands per record `{2:83, 3:43, 4:109, 5:53, 6:7, 7:1}`; first-band `ideal_dist` median **10.0** → with
the +50 m bias, a median first swap around **60 m**. **All 296 are null-terminated** — the last band has
`gfxobj_id = 0` and `min/ideal/max = FLT_MAX`, and because `CPhysicsPart::Draw` gates on
`if (v5)` (`acclient.c:314600-314607`), that band is a genuine **cull**: the object stops drawing.

**Action (data, not patch), in order of preference:**
1. Clear `GfxObjFlags.HasDIDDegrade` (`dats.xml:147-152`, field at `dats.xml:3563-3566`) on every
   replaced GfxObj — the loader's null path is verified and yields "root mesh, always".
2. Or repoint band 0 (and any bands to keep) at the new high-poly meshes.
3. Add a bake-time assertion: for every patched GfxObj, either it has no degrade record, or
   `degrades[0].gfxobj_id == <the id we replaced>`.

### 5b. Framerate feedback makes it worse on slow machines

`Render::CalcDegLevel` (`acclient.c:380231-380341`) is a Mamdani controller over
`SceneTool::m_FramesPerSecond` with `min_framerate = 8 / ideal = 10 / max = 20`
(`acclient.c:45517-45519`), output `deg_mul` clamped to `[-1, +1]` (`:380315-380325`) and enabled by
`Render::auto_update_deg_mul = true` (`:45518`). Negative `deg_mul` pulls the bands *below*
`ideal_dist`, so a struggling machine degrades our meshes **earlier** than the DAT says — precisely
the machines our heavier content will create.

### 5c. Config-only defeats (no patch)

Three registered preferences (`acclient.c:382138-382179`): `Render.AutomaticDegrades`
(→ `auto_update_deg_mul`), `Render.GraphicsPerformance` (→ `s_rUserSuppliedDegradeBias`, `[-1,+1]`),
and `Render.DegradeDistance` (→ `s_rDegradeDistance`, default 50.0). **Setting
`Render.DegradeDistance` very large makes `d' = max(dist − D, 0) = 0` always, pinning every object to
band 0 with no binary patch** — the cleanest global defeat, and it pairs naturally with the
`Render.EnvironmentTextureDetail = 0` config line from §3a.

There is also a global kill switch, `degrades_disabled` (`acclient.c:54820`), honoured first thing in
`GfxObjDegradeInfo::get_degrade` (`:332356-332370`): `if (degrades_disabled) { *deg_index = 0; ... return; }`.
It is set to 0 at startup (`:144947`) and toggled by the preview/appearance paths (`:143913-143914`,
`:144245-144247`). Forcing it to 1 is a trivial byte patch (BSS `0x8442E4`) **but is the wrong lever** —
it would also disable retail's legitimate distance LOD everywhere. Prefer data, then config.
A second patch-only pin exists: `Render::force_level` (`acclient.c:45521`, default −1, never registered
as a preference); setting it to 0 pins every object to band 0 (`:332424-332431`).

Distance selection itself uses `Render::s_rDegradeDistance` as a bias and scales bands by
`Render::deg_mul` / `s_rUserSuppliedDegradeBias` (`acclient.c:332375-332400`) — see wave2-C RND-01.

### 5d. Correction to wave2-C R26 / RND-03

wave2-C correctly overturns the upstream `06-rendering.md:296-300` claim that these are "cull
distances" — they are `min_2D_degrade_distance_sq`, computed in `Render::SetDegradeLevelInternal`
(`acclient.c:379786-379816`) from `IDEAL_OBJECT_SORT_DISTANCE = 25.0` / `IDEAL_PARTICLE_SORT_DISTANCE = 16.0`
(`:41515-41516`). **But wave2-C's replacement wording is also wrong**: it says the threshold is what
"enables degrade + billboard re-orientation". It does not. In `CPhysicsObj::UpdateViewerDistance`
(`acclient.c:317930-317968`) **both** branches reach `get_degrade` (`:315159` and `:315190`) and both
call `calc_draw_frame` (`:315167`, `:315197`). The threshold is purely a **precision/cost switch** —
inside ~25 m each part recomputes its own `sort_center`-offset distance and viewer heading
(`:315120-315152`); beyond it, all parts share the object-level values. Nothing is culled and nothing
is enabled or disabled at 25 m. Worth folding back into wave2-C.

Scenery and buildings are **not** exempt: landblock scenery is instantiated as ordinary `CPhysicsObj`s
(`CLandBlock::get_land_scenes`, `acclient.c:352708-352717`) and flows through the same
`CPartArray::UpdateViewerDistance` → `get_degrade` path; `RenderDeviceD3D::DrawBuilding`
(`:456933-456940`) calls `UpdateViewerDistance` then gates on `gfxobj[deg_level]`. Note the distance fed
to `get_degrade` is `CYpt / gfxobj_scale.z` (`:315158`), so a scaled-up scenery instance degrades at a
proportionally *shorter* raw distance.

---

## 6. GEOMETRY PIPELINE — 65,535 verts per GfxObj, and we are nowhere near it

**Index format is 16-bit, and the 32-bit branch is dead.**
`RenderIndexStreamD3D::CreateDirect3DIndexBuffer` (`acclient.c:687561`) does branch on
`m_IndexSizeInBytes` between `D3DFMT_INDEX16` (101) and `D3DFMT_INDEX32` (102) at `:687587-687596` —
but `m_IndexSizeInBytes` is **written exactly once in the entire 31 MB decomp**:
`acclient.c:687534  v1->m_IndexSizeInBytes = 2;` in the constructor. Every other occurrence is a read.
Likewise the GfxObj mesh builder `D3DPolyRender::ConstructMesh` (`:455780`) calls
`D3DXCreateMeshFVF` with flags `0x220` / `0x18220` (`:456075-456079`) — **`D3DXMESH_32BIT` (0x1) is in
neither**.

**The real caps:**
- **65,535 vertices per GfxObj mesh.** Exceeding it fails `D3DXCreateMeshFVF` → `ConstructMesh`
  returns 0 (`:456102`) → `use_built_mesh` cleared (`:356507-356509`) → the object falls off the
  batched path onto **one `DrawPrimitiveUP(D3DPT_TRIANGLEFAN, ...)` per polygon** (`:455401`,
  `:455438`, `:455468`). Graceful, but catastrophic for framerate.
- **65,535 indices in the shared dynamic index ring**, hardcoded and never grown:
  `acclient.c:454306  RenderIndexStreamD3D::Init(v3, 0xFFFFu, 1u)`. Overflow returns 0 from
  `FillData` (`:687717`, `:687731`) and the draw is **silently dropped**. The dynamic *vertex* pool,
  by contrast, grows past its 8192 floor (`:456735-456736`). Static index buffers escape the ring —
  each gets its own exactly-sized IB (`:687863`).
- **Device caps `MaxPrimitiveCount` / `MaxVertexIndex` are never read** — the only occurrences in
  either file are the `_D3DCAPS9` declarations (`acclient.h:38565-38566`). `DrawIndexedPrimitive`
  (`acclient.c:688480`) passes all six arguments through unclamped.
- The runtime structs are honest 32-bit: `CGfxObj::num_polygons` and `CVertexArray::num_vertices`
  are both `unsigned int` (`acclient.h:31725`, `:31305`). Only the *index* types are `u16`
  (`CPolygon::vertex_ids`, `acclient.h:31858`).

**Measured against real content.** From the project's own census of 15,318 retail GfxObjs
(`/mnt/wbterminal2/dpc-work/gfx_geo.json`):

| | vertices |
|---|---|
| median | 20 |
| mean | 40.2 |
| **heaviest retail GfxObj** (`0x01004703`) | **1,446** |

| multiplier | records over 65,535 | heaviest result |
|---|---|---|
| 4× | 0 | 5,784 |
| 8× | 0 | 11,568 |
| **12×** | **0** | **17,352 (26 % of cap)** |

Even a uniform **45×** would keep every single record under the cap. **Geometry is a complete
non-issue for this plan — no patch, no split, no concern.** The only rule for the baker: if any
future record ever approaches 65 K verts, split it at bake time, because nothing at runtime will
split, warn, or degrade visibly. (Also note the unchecked narrowing at `acclient.c:138027`,
`*(_WORD *)&indices[2*v16++] = vertexIndex;` — a >65535 index truncates silently.)

---

## 7. DAT LIMITS — the one real wall, and it is not a byte patch

**Current sizes** (`/home/wbterminal/ac_base_dats/`, headers read at file offset 0x140):

| file | bytes | `fileSize_` | blockSize | dataset | firstFree | freeBlocks |
|---|---|---|---|---|---|---|
| `client_portal.dat` | 926,941,184 (884 MiB) | 0x37400000 | 1024 | 1 | 0x37386800 | 2,052 |
| `client_cell_1.dat` | 348,127,232 (332 MiB) | 0x14C00000 | 256 | 2 | 0x14B35A00 | 3,238 |
| `client_local_English.dat` | 1,048,576 | 0x00100000 | 1024 | 3 | 0x000FDC00 | 270 |

**Ceiling = 2,147,483,648 bytes (2 GiB).** Two independent walls land on exactly that number:

1. **Bit 31 of every block-chain pointer is a free-block flag, not an address bit.**
   `CLBlockAllocator::Load_Data` (`acclient.c:650711`) reads the 4-byte next-offset and
   at `:650758-650762` does `if (v7 < 0) { v7 &= 0x7FFFFFFF; result_f = 0; }` — **the read aborts.**
   The write side confirms the convention: `ExpandFile` terminates with `0x80000000` (`:650501`) and
   splices `offset | 0x80000000` (`:650505`); `StoreDataRollback` re-tags and then dereferences
   `nextOffset & 0x7FFFFFFF` (`:650392-650396`). A data block at ≥ 0x80000000 is indistinguishable
   from a free block, and the failure is **silent** — a partial record, not an error.
2. **`DiskDev::SyncRead` seeks signed-32 with a NULL high dword** (`acclient.c:653420-653427`):
   `if ( SetFilePointer(this->_fd, off, 0, 0) == -1 ) result = -105;` where `off` is `int`.
   `SyncWrite` (`:653442-653448`) is identical. Confirmed independently in the 2013 Binary Ninja
   decomp (`acclient_2013.bndb_pseudo_c.txt:631939-631948`). **`SetFilePointerEx`, `_lseeki64`,
   `fseek` appear zero times.**

Every on-disk offset field is signed `int`: `BTEntry::Offset_` (`acclient.h:28572`),
`BTNode::NextNode_[62]` (`:28581`), `DiskFileInfo_t::{firstFree_, finalFree_, btreeRoot_}`
(`:28238-28241`). Only `fileSize_` is unsigned (`:28235`) — and the read path never consults it.

**Headroom arithmetic:**

```
ceiling                       2,147,483,648
portal.dat today                926,941,184   (43.2 % of ceiling)
  headroom today             1,220,542,464   (1,164 MiB)

plan A: +970 MiB              1,944,059,904   (90.5 %) → margin 203,423,744 B  (194 MiB)
plan B: ~1.55 GB DXT1 target  ~1,550,000,000  (72 %)   → margin ~597 MB
```

Plan A is real but uncomfortable — 9.5 % margin on a wall whose failure mode is a *silent* truncated
record. The `CommandEngine.DatBake.cs:22-24` doc comment already projects ~1.55 GB for the DXT1
re-encode, which is the number to hold to. **Reconcile the two budgets before baking.**

**Two operational cautions:**
- portal.dat has only **2,052 free blocks (~2 MiB)**. Any in-place append immediately drives the
  allocator into `ExpandFile`, whose size arithmetic copies `fileSize_` into an `int`
  (`acclient.c:650494-650495`) and whose growth loop writes `v8 | 0x80000000`. **Build the enlarged
  DAT offline; never let the client grow it near the boundary.** (`DiskController::CheckRoom`,
  `:647182-647196`, calls `ExpandFile(..., 0x100000)` — 1 MiB at a time — whenever free blocks run low.)
- **Post-bake, assert** `max(BTEntry.Offset_) + size < 0x80000000` and every `BTNode.NextNode_[]`
  likewise. One block over the line loses one record silently.

`client_cell_1.dat` at 332 MiB has enormous headroom and is not a concern.

---

## 8. THE ONE PATCH WORTH DOING: enable DAT compression

The client already supports zlib-compressed DAT records — `BTEntry.comp_` is bit 0
(`acclient.h:28568`) and `DiskController::LoadDataEx` branches on it at `acclient.c:647460`. It is
broken by a single store. Verified end to end:

```
acclient.c:647444   v7 = *((_WORD *)ent_out + 1);        /* BTEntry.ver_ (16-bit) */
acclient.c:647446   buf_out->m_iVersion = v7;            /* version captured — good */
...
acclient.c:647367   char DiskController::Decompress(Cache_Pack_t *in, Cache_Pack_t *out)
acclient.c:647394       o_cpUncompressed->m_dwOffset = 0;
acclient.c:647397       v9->m_iVersion = 0;              /* <-- VERSION DESTROYED */
...
acclient.c:84396    v3 = i_cpData->m_iVersion;           /* AsyncCache::SerializeFromCachePack */
acclient.c:84402    if ( v3 && v5 ) { ... }              /* 0 fails the gate → unpack skipped */
```

This is exactly what trevis independently found and fixed:

> *utilitybelt / trevis / 2024-11-05:* "`DiskController::Decompress` sets the m_iVersion to 0 on
> successful decompression, which breaks a check for m_iVersion being not 0 in
> `AsyncCache::SerializeFromCachePack`" … "a one byte client patch would enable reading compressed
> dats though" … "i have a feeling they broke it on purpose"

With measured results:

> *general / trevis / 2026-02-02:* "zlib compression level 9, confirmed it works in the client with
> patch to set iVersion properly.
> `Compressing client_portal.dat .. saved 463,170,560 bytes (49.97%)`
> `Compressing client_highres.dat .. saved 64,918,528 bytes (48.75%)`
> `Compressing client_cell_1.dat .. saved 37,662,720 bytes (10.82%)` … Overall space saved: 40.20%"

**Why this is the highest-value action:** it directly attacks the *only* hard wall in this dossier.
Compressing the existing 884 MiB of portal.dat to ~442 MiB frees ~442 MiB **under the 2 GiB ceiling**,
turning the plan-A margin from 194 MiB into ~636 MiB. It also shrinks the download. DXT payloads will
compress far less than 50 % (they are already entropy-dense — expect 5–15 %), so the win comes from
the retail baseline, which is exactly where it is needed.

**Costs and risks:** every client must be patched (an on-disk patch — `Cache_Pack_t::m_iVersion` is a
runtime field, but the fix must be in the image; a launcher/loader could apply it). The DAT writer
must emit `comp_` correctly — *utilitybelt / Yonneh / 2024-11-02:* "first bit is compressed, last 16
bits is version". Decompression is synchronous on the load path, so measure hitching. And note
DatReaderWriter's allocator prerequisite already flagged in `CommandEngine.DatBake.cs:43-48`
(`BaseBlockAllocator.ReserveBlockCore` assumes a contiguous free run and will corrupt a retail DAT).

### Secondary patch candidates, ranked

| Patch | Site | Why | Effort/Risk |
|---|---|---|---|
| **Raise the 4-mip clamp** | `ImgTex::CreateD3DTexture`, `acclient.c:366125` (`NumMipLevels = 4`) | Removes distance shimmer on every large texture. The one *quality* patch our art actually needs. | S / Low–Med (watch `SetResourceSize` accounting at `:366166`) |
| **Force `Render::ShouldDropHighDetail()` → 0** | `acclient.c:379978`, decomp VA `0x0054C700`, map RVA `0x0014C310` (**builds differ — use a needle**). Patch to `xor eax,eax; ret`. | Makes 2-entry SurfaceTextures resolve to the HIGH entry, unlocking `client_highres.dat` as a second 2 GiB volume. | S / Med — only needed if we adopt the highres-dat split |
| **`RenderTexture::DropUnwantedLevels` → `mov al,1; ret`** | `acclient.c:137195`, decomp VA `0x0044C390` | Only if content migrates to `DB_TYPE_RENDERTEXTURE` (0x15). Not needed today. | S / Low |
| **Preset immediates → `EnvironmentTextureDetail = 0`** | `Render::SetOverallGraphicsQuality`, `acclient.c:378751-378795` (one byte per arm) | Only if we cannot ship a user config. Defeats both texture-reduction mechanisms at the source. | S / Med |
| **Neutralise the shift directly** | `Render::UpdateFromPreferences`, `acclient.c:380986-380992` — NOP the `v2 = dword_81EF9C - 1` so the three scales stay 0 | Blunter alternative to the above; leaves level selection (§3b) alone. | S / Med |
| `degrades_disabled = 1` | BSS `0x8442E4`, honoured at `acclient.c:332368` | Global LOD kill. **Wrong lever** — prefer clearing `HasDIDDegrade` in data (§5a) or `Render.DegradeDistance` in config (§5c). | S / Med |
| ~~DBOCache budgets~~ | `MasterDBMap::InitDBTypeDef_Internal`, `acclient.c:91986` | **Do not bother** — they bound empty shells, not resident memory (§4). | — |
| ~~LAA flag~~ | file offset `0x15E` | **Already set** (§1). | — |

### The zero-patch checklist (do these first — they cover most of the value)

1. Ship `Render.EnvironmentTextureDetail = 0` in the default user config (§3a + §3b).
2. Ship **single-entry** `SurfaceTexture` records — `surface-texture-collapse` already exists (§3b).
3. Clear `GfxObjFlags.HasDIDDegrade` on every replaced GfxObj, or repoint band 0 (§5a).
4. Keep dimensions power-of-two and multiples of 4; keep world art off the UI surface path (§2c, §2d, §2h).
5. Assert post-bake that every `BTEntry.Offset_ + size < 0x80000000` (§7).

---

## 9. Prior art — what the community has and has not done

**Has:** a mature patch toolchain and a proven patch→distribute→verify loop.
- **Mag-ACClientPatcher** (`github.com/Mag-nus/Mag-ACClientPatcher`, patch table in
  `Source/ACClientExePatches.cs`) — multiclient, RenderNormalMode bypass, Pea's 4K resolution unlock
  (offsets `0x0006128D`, `0x00063D94`), UseTime render disable.
- **Yonneh's C# hard-patcher** (2024) — needle/replace tables; documented offsets for dual-log
  (`0x000122C5`), file sharing (`0x00277E20`), intro skip (`0x004EEC63`).
- **notan's palette-leak fix** (`github.com/eriknihlen/ac-eor-palette-leak-fix`) — two 3-byte NOPs at
  `0x0013EFFE` / `0x0013F19C`, "leak rate drops ~95 %+". paradox offered to distribute byte patches
  through Decal, which already has the facility.
- **trevis's DAT-compression fix** — §8. The only executed *content-capacity* patch in the archive.

**Has not:** anything about raising content limits.
- **Zero** discussion of a polygon/vertex/triangle cap, ever.
- **Zero** follow-up on the one bigger-texture thread (worldbuilder, 2026-02-26: Advan asked, trevis
  said "i think the dats should be totally cool with it, and client code, but dx9 is generally
  4096x4096, or 2048x2048 for max compatibility", Vanquish420 said he'd try — **no result was ever
  reported**). Scanning 2026-02-26 → 2026-03-10 across all channels found nothing further.
- **Zero** DBOCache tuning discussion.
- The 2 GiB DAT ceiling was **speculated and never tested** — *general / trevis / 2024-05-16:*
  "i wonder if the client sometimes mixes ints / uints? if not, dats are limited to max int so like
  2gb i guess" … "guess i could make a 3gb dat and see if it breaks…". §7 settles it: **2 GiB, and
  for two independent reasons.**
- LAA: two hits in 477,753 messages, and **nobody checked the shipped flag.** §1 settles it: it is
  already set.

One adjacent hard limit worth remembering (*worldbuilder / paradox / 2025-10-29*): region terrain-type
and scenery tables are bit-packed at ~30–31 entries and "the upper limit may be hard-coded throughout
the client due to the nature of compilers" — "not with just data manipulation". Different problem,
but the same shape, and paradox's warning applies.

---

## 10. Is it easy? — the one-paragraph answer

Easier than expected, but not because binary patching is easy — because **most of the limits we
feared are not there, and most of the ones that are turn out to be data or config problems rather
than code problems.** The client is already Large Address Aware (verified on our own checksum-clean
2015 binary, contradicting settled community folklore), it never reads its own `MaxTextureWidth/Height`
caps, it applies no power-of-two or squareness check to world textures, its DBOCache "budgets" govern
empty allocator husks rather than resident memory, and its 65,535-vertex geometry cap sits **45× above**
the heaviest retail GfxObj we would ever touch. What is real: (a) the boot default
`EnvironmentTextureDetail = 2` **halves every object texture on load** and simultaneously forces
2-entry `SurfaceTexture`s to their low-detail entry — both defeated by one config line
(`Render.EnvironmentTextureDetail = 0`) plus single-entry records, no patch; (b) replacing a GfxObj
that carries a `GfxObjDegradeInfo` record is **completely invisible**, because the root mesh is never
inserted into the draw array and band 0 usually points somewhere else — a bake-time data fix, no
patch; (c) the 4-level mip clamp will make 1024² art shimmer at distance — a small, genuinely
worthwhile byte patch; and (d) the **2 GiB DAT file ceiling**, enforced twice over (bit 31 of every
block offset is a free-block flag, and `DiskDev::SyncRead` seeks signed-32 with a NULL high word),
which fails *silently* and is emphatically **not** a byte patch — lifting it means rewriting the block
allocator. So: the geometry and texture ambitions are unblocked today with essentially zero patching,
provided the bake gets the data and config right; the only thing that needs real engineering is the
disk budget.

**Highest-value action:** adopt **trevis's one-instruction DAT-compression patch**
(`DiskController::Decompress` zeroing `m_iVersion`, `acclient.c:647397`, breaking the
`if (v3 && v5)` gate in `AsyncCache::SerializeFromCachePack`, `acclient.c:84402`). It is the only
patch that moves the wall that actually binds us — ~50 % off the retail baseline, turning ~194 MiB
of margin into ~636 MiB — it has a working proof-of-concept with measured numbers, and it costs one
instruction. Everything else on the list is either already done, dodgeable in data, or not worth it.

---

## Appendix A — verification index

| Claim | Symbol | Citation |
|---|---|---|
| LAA already set | PE COFF `Characteristics = 0x012E` | `ac_base_dats/acclient.exe` @ 0x15E; checksum 0x004A60C3 validates |
| Caps never enforced | `RenderDeviceD3D::DetectDeviceCaps` | `acclient.c:457087`, writes at `:457127`/`:457129`; 0 reads |
| Only D3D CreateTexture | `RenderTextureD3D::CreateD3DTexture` | `acclient.c:685177`, call `:685242-685251` |
| No validation | `RenderTexture::Create2D` | `acclient.c:136287-136305` |
| Record size identity | `RenderSurface::Serialize` | `acclient.c:128504-128508` |
| Mip clamp = 4 | `ImgTex::CreateD3DTexture` | `acclient.c:366110-366125`, `D3DXFilterTexture` `:366160` |
| Load-time shift | `ImgTex::CreateD3DTexture` | `acclient.c:366084-366090`; floor `min_tex_size = 8` `:45327` |
| Pref → shift | `Render::UpdateFromPreferences` | `acclient.c:380924`, `:380982-380992` |
| Preset table | `Render::SetOverallGraphicsQuality` | `acclient.c:378743-378796` |
| **Boot default = preset 3** | `Render::Startup` | `acclient.c:381965-381966`; preset 3 sets pref = 2 at `:378773` |
| `"HiFi"` probe constant | `1766222152 == 0x69466948` | matches `LoadHighResDat` magic `acclient.c:293704-293710` |
| **Root mesh never drawn** | `CPhysicsPart::LoadGfxObjArray` | `acclient.c:314920-314951` (degrade path) vs `:314955-314962` (null path) |
| Cull band / draw guard | `CPhysicsPart::Draw` | `acclient.c:314600-314607` |
| Degrade FPS feedback | `Render::CalcDegLevel` | `acclient.c:380231-380341`; constants `:45517-45519` |
| Scenery uses degrade | `CLandBlock::get_land_scenes` | `acclient.c:352708-352717`; `DrawBuilding` `:456933-456940` |
| 25 m is not a cull | `CPhysicsObj::UpdateViewerDistance` | `acclient.c:317930-317968` (both branches degrade) |
| Level selection | `ImgTex::GetSurfaceDID` | `acclient.c:366232-366256` |
| Always-drop gate | `Render::ShouldDropHighDetail` | `acclient.c:379978-379986` |
| 0x15 level drop | `RenderTexture::DropUnwantedLevels` | `acclient.c:137195-137270`; callers `:137416`, `:137460` |
| highres dat | `CLCache::LoadHighResDat` | `acclient.c:293658`, name `:293684`, gate `:293790` |
| ACE disables it | `GameMessageDDDInterrogation` | `ace-server/.../GameMessageDDDInterrogation.cs:10` |
| Freelist budgets | `MasterDBMap::InitDBTypeDef_Internal` | `acclient.c:91986`; enforcement `DBOCache::FreelistAdd` `:83190-83197` |
| No live-set cap | `DBOCache::m_nTotalCount` | `acclient.c:83889`, `:83911`, `:83972` — never compared |
| Degrade optional | `CPhysicsPart::UpdateViewerDistance` | `acclient.c:315190-315200`; `get_degrade` `:332356` |
| 16-bit indices | `RenderIndexStreamD3D` | `acclient.c:687534` (sole write), branch `:687587-687596` |
| Mesh 65535 cap | `D3DPolyRender::ConstructMesh` | `acclient.c:456075-456079` (no `D3DXMESH_32BIT`) |
| Dynamic IB ring | `ReferenceDynamicIndexStream` | `acclient.c:454306` |
| Block bit-31 flag | `CLBlockAllocator::Load_Data` | `acclient.c:650758-650762`; writes `:650501`, `:650505`, `:650392-650396` |
| Signed seek | `DiskDev::SyncRead` / `SyncWrite` | `acclient.c:653420-653427`, `:653442-653448` |
| Signed offset fields | `DiskFileInfo_t`, `BTEntry`, `BTNode` | `acclient.h:28238-28241`, `:28572`, `:28581` |
| DATs not mmapped | `MMapUtil::MMap` sole caller | `acclient.c:724052`, caller `PFileParser::LoadBinary` `:721977` |
| Compression bug | `DiskController::Decompress` | `acclient.c:647397`; gate `AsyncCache::SerializeFromCachePack` `:84402` |
| UI 2048 wall | `UISurface::CreateSurface` | `acclient.c:124912`, `:125048`; saturate `:124840`, `:124860` |
| Vertex census | 15,318 GfxObjs, max 1,446 verts | `/mnt/wbterminal2/dpc-work/gfx_geo.json` |

## Appendix B — open items

1. **Measure real client peak private bytes** under a heavy scene before assuming LAA headroom (§1).
   The reported ~1.6–2 GB crash wall is unexplained given the flag is set.
2. **Reconcile the DAT budget**: the brief says +970 MiB (→ 90.5 % of ceiling); `CommandEngine.DatBake.cs:22-24`
   projects ~1.55 GB total (→ 72 %). Pick one and hold to it (§7).
3. ~~`AreOnDisk` probe constant~~ — **RESOLVED**: `1766222152 = 0x69466948 = "HiFi"`, the same magic
   `CLCache::LoadHighResDat` passes as the container id (`acclient.c:293704-293710`). The probe asks
   "is `client_highres.dat` mounted?". (The exact vtable slot is still unverified — IDA rendered it as
   `&vfptr->AreOnDisk + 1`, which is the `UseTime` slot with mangled args; the *intent* is unambiguous.)
4. **`m_caps.bCompressedTextures`** is set unconditionally at `acclient.c:459184` and cleared at
   `:459221`; which branch runs in practice was not resolved. If it ends up 0, DXT records are
   converted to ARGB on load (`RenderSurface::SelectSurfaceFormat`, `:127928-127932`) — worth
   confirming before committing to a DXT-only pipeline.
5. **Escalate the ACE `m_dwProductID` question** (§3c) — it collides with `keep-ACE-vanilla` and is a
   policy decision, not an engineering one.
6. **Can we ship a default user config?** Both §3a and §5c reduce to config lines
   (`Render.EnvironmentTextureDetail = 0`, `Render.DegradeDistance` large). Whether our distribution
   can place a config file — and whether the client's config load actually runs *after*
   `Render::Startup`'s `SetOverallGraphicsQuality(3)` and therefore wins — is **unverified** and is the
   cheapest remaining thing to test. If a saved config does not override the preset, these become byte
   patches instead.
7. **`RenderPrefs::ModelDetail` and `SceneryDrawDistance` have no located consumer** — `ModelDetail`
   appears only in the struct declaration (`acclient.h:41671-41685`), `dword_81EFA0` only in presets,
   registration and safe-settings. Treat as "no consumer found", not proven-dead; offset arithmetic on
   `m_RenderPrefs` was not exhaustively traced.
8. **Whether the 4-level mip clamp reaches D3D** (§2e) — IDA lost the argument wiring at
   `acclient.c:366133`. The `Create2D` signature makes it near-certain, but confirm on the real binary
   before shipping that patch.
