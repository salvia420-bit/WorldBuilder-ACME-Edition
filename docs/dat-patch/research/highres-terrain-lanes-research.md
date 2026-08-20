# HIGHRES / terrain-texture Phase-4 lanes — feasibility + method design

Research doc for the three remaining terrain/texture lanes in
PLAN-2026-08-18-hedonic-allocation.md §4:

- **4.H3 terrain-2x** (plan rank #7, gated behind the "D4 diagnostic")
- **4.H2 terrain detail textures** (plan rank #6, "cheap, composite-safe")
- **4.H4 selective 4096²** (plan rank #8, "short list, measure first")

This is a **research + turnkey-method** document. Nothing here was written to any
dat; every dat touched below was opened **read-only** (base-dat reads are allowed;
the live pipeline was not disturbed). Primary sources are cited `file:line`. Where a
claim could not be closed from primary sources, it is flagged **VERIFY** with the
exact thing a later session must check.

Source legend:
- `DECOMP` = `/home/wbterminal/ac-headers/acclient.c` (retail EoR pseudo-C)
- `DRW` = `external/DatReaderWriter/DatReaderWriter/dats.xml`
- `ACE` = `~/ace-server/Source/ACE.DatLoader/`
- `DOSSIER` = `docs/dat-patch/reports/client-headroom-dossier.md` (decomp-verified, cross-checked vs the 2013 BinaryNinja decomp)
- lane code = `tools/dat-patch/*.py` (read-only reference)

---

## 0. TL;DR verdicts

| lane | status | one-line |
|---|---|---|
| **4.H3 terrain-2x** | 🔴 **RED — the D4 diagnostic already ran and FAILED (twice)** | Region-baseTexSize-2048 form is dead: the client exhausts its ~2.4 GB address space on the first outdoor composite burst at BOTH VeryHigh and High. Ship only the composite-safe fallbacks (= 4.H2, and/or 1024 sources with **no** Region patch). |
| **4.H2 detail textures** | 🟢 **GREEN — turnkey** | Detail textures render through a **separate** `CSurface` path, never the merge buffer; 3 detail RenderSurfaces (0x060037D2, 0x06006D57, 0x06006D58), all detail-only, tiny byte cost, DXT-safe. Command sequence below. |
| **4.H4 selective 4096²** | 🟡 **YELLOW — one survey first** | No 3-D texture-size cap exists in the client, but the **4-level mip clamp** means a 4096² aliases badly at distance. Feasible for a *short* near-field list; run the texel-starvation survey (method below), and pair with the mip-cap byte patch if shipped. |

---

## 1. 4.H3 — terrain-2x

### 1.1 What the "D4 diagnostic" is, exactly, and its PASS/FAIL criterion

**The D4 diagnostic is an empirical, in-client smoke test — not a static analysis.**
It is defined and executed in these files:

- Plan staging: `PLAN-2026-08-18-hedonic-allocation.md:69-71` (Phase-0.1: "The 15-min
  LandscapeTextureDetail=High terrain diagnostic ~/terrain-arm/, ~/terrain-smoke.sh")
  and the fork `:156-157` (D4: PASS → terrain-2x ships as a High-detail feature;
  FAIL → terrain-2x dead, D5 + no-Region-patch-1024 only).
- Definition/verdict of the original run: `HANDOFF-2026-08-17-EOD3.md:165-191`
  ("D4 ADDENDUM").
- Definition/verdict of the follow-up diagnostic arm: `reports/terrain-d4b-high-2026-08-18.md`.

**What it tests.** Build an "arm" portal from a sha-verified r7 copy with the full
terrain-2x edit applied (37 base terrain RenderSurfaces re-imported at 1024², the 8
blend masks upscaled to 1024², and `Region 0x13000000` `baseTexSize` patched
1024→2048 — see §1.4). Then run the client through the 6-stop smoke tour (spawn +
Holtburg + Yaraq + Rithwic + Holtburg + 180 s soak) under Wine while sampling **peak
`VmSize`** at each stop. The variable under test is `LandscapeTextureDetail`:
- **D4** = VeryHigh (composite at full `baseTexSize` 2048).
- **D4b** = High (composite halved by the `ImageShift` 1-bit shift, i.e. 1024 effective).

**PASS/FAIL criterion.** PASS = the client survives the full outdoor tour without an
address-space crash and with peak `VmSize` under the amber line
(~2.0 GB Wine / measured on Windows-LAA). FAIL = an OOM-class fault (write/read AV on a
null+offset or wild-high pointer, the signature of a downstream-of-failed-allocation)
during outdoor composite building. The standing gate is stated at
`PLAN-2026-08-18-hedonic-allocation.md:25-26`: "record peak VmSize across the 6-stop
tour per arm; treat ~2.0 GB (wine) as the amber line."

**The result is already in — HARD FAIL, both arms:**
- **D4 (VeryHigh):** clean indoors (60+ s, 3 frames), then on the first outdoor load
  (Yaraq, mid-portal-transit) a **write-AV at ntdll 0x7BC26925 writing 0x007A00AC** —
  right after `VmSize` jumped **1.63 GB → 2.42 GB** building composites
  (`HANDOFF-2026-08-17-EOD3.md:165-176`).
- **D4b (High):** failed **earlier** — crashed during initial spawn load, `VmSize`
  pegged at **2.39 GB**, read-AV at client `0x00525E7E` on wild pointer `0xB8D30000`
  (`reports/terrain-d4b-high-2026-08-18.md:12-37`).
- Halving the composite made no difference → "pure composite-size scaling, halve it and
  survive" is **disproven** (`terrain-d4b-high-2026-08-18.md:33-37`).

So the plan text at `:56` and `:143-145` ("gated … only in the shape the D4 diagnostic
proves safe") is answered: **the diagnostic resolved to FAIL after the plan was written
the same day.** A later session does **not** need to re-run D4/D4b to decide 4.H3 — it
needs only to re-confirm the fork consequence (§1.6).

### 1.2 The "MergeTexture composite wall" — how the client composites terrain

The retail landscape texture is not stored; it is **composited at runtime**, per unique
terrain-type combination, into a **single fixed buffer** sized off the Region record:

1. **Allocation (the wall):** `TexMerge::FillTempTexBuffer` (DECOMP:305909) allocates
   the one merge buffer **once** as
   `operator new[](4 * base_tex_size * base_tex_size)` (DECOMP:305930-305931; also
   `DOSSIER:215-217`, `:2g`). `4 *` = 4 bytes/texel → the buffer is **A8R8G8B8,
   uncompressed, by construction**. `base_tex_size` is read as the very first field of
   `TexMerge` in `TexMerge::UnPack` (`this->base_tex_size = *(_DWORD *)*addr`,
   DECOMP:306032).
2. **Base tiling:** `ImgTex::TileCSI` (DECOMP:365513) copies the base terrain
   RenderSurface into that buffer with **raw 4-byte DWORD copies**
   (`*(_DWORD *)v16 = *(_DWORD *)v12;`, DECOMP:365590), `tiling` times per axis. The
   source row width comes from the RenderSurface's own `m_pImageData->width`
   (DECOMP:365540-365544); the destination advances `4 * dest_width` per row
   (DECOMP:365604). So **src_width × tiling must equal dest_width exactly**, and the
   source must be 32-bit — a DXT source would be read as raw DWORDs = garbage/overrun.
3. **Blend:** `ImgTex::MergeTexture` (DECOMP:365632) walks the corner/side/road alpha
   masks over the composite. The rotation switch builds **all four walks out of the
   base texture's width/height** (`v8` = base `src_width`, `src_height`;
   DECOMP:365745-365759), never the alpha's; `scale_up_alpha = dest_width / alpha_width`
   (DECOMP:365722-365726). A full pass therefore touches `alpha_width × base_width`
   bytes and is in-bounds **only when alpha_edge == base_edge**. An alpha smaller than
   the base (e.g. a 512 mask left under a 1024 base) walks off the end of the alpha
   record — this is the r6-clobber OOB, documented in `terrain_lane.py:44-52`.
4. **Composite edge derivation:** `TexMerge::RestoreSurface` (DECOMP:306241) and
   `MakeNewSurface` (DECOMP:306287) derive each composite's edge as
   `(base_tex_size >> ImageShift[fLandTextureScale]) / (did >> 28)`
   (DECOMP:306252, :306287). `ImageShift[5] = {0,1,2,4,8}` (DECOMP:40343) — the shifts
   are 0/1/2/4/8 **bits** (÷1, ÷2, ÷4, ÷16, ÷256). **There is no half-step:** 2048@High
   (shift 1) = 1024 == 1024@VeryHigh (shift 0), so you cannot "halve one notch" to buy
   margin (`HANDOFF-2026-08-17-EOD3.md:186-190`).
5. **Residency multiplier:** each unique terrain combination becomes its own resident
   `ImgTex` via `ImgTex::CreateLScapeTexture` (DECOMP:367758) and is added to the
   `ImgTex::custom_texture_table` HashSet (DECOMP:367778, table decl :45433). These are
   **not one buffer** — they accumulate resident, each sized ~`base_tex_size`. Raising
   `base_tex_size` 1024→2048 multiplies **every** resident composite's footprint by 4.

That per-combination ×4 resident growth is what D4 measured directly (VmSize
1.63→2.42 GB on the first outdoor composite burst). The "wall" is the **address space**
(F-A, `PLAN:17-26`), not disk and not a client dimension check.

### 1.3 Why terrain RenderSurfaces are locked to 512² A8R8G8B8 — `terrain_protected_rs.txt`

`tools/dat-patch/terrain_protected_rs.txt` lists 48 RenderSurfaces that **any**
texture-baking lane (dungeon/creature/scenery/props) must exclude from its bake census
(header lines 1-5). The reason is exactly the merge path above: these RS are locked +
composited by `ImgTex::MergeTexture` via raw-DWORD `TileCSI`, so they **must stay 512²
A8R8G8B8 uncompressed** under the retail Region (baseTexSize 1024, texTiling 2 →
base edge = 1024/2 = 512). The list was written after the **root cause on 2026-08-16**:
the dungeon lane clobbered `0x06006D4B` / `0x06006D50` (baked them to DXT/2048) and the
client **crashed at LandscapeTextureDetail=VeryHigh** on the OOB alpha read
(`terrain_protected_rs.txt:2-5`). So "what breaks if a terrain texture is upsized or
reformatted" = either (a) DXT read as raw DWORDs by `TileCSI` → garbage/overrun, or
(b) a base/alpha edge mismatch → the `MergeTexture` walk reads past the record → the
VeryHigh crash. This is the same failure class D4 hit from the other direction (the
edges matched, but the ×4 composite footprint exhausted the address space).

**Caveat for later sessions:** the 48-entry list is a *conservative superset* — it
includes the 3 detail-texture RS and the 8 blend-mask siblings, which are **not** in the
merge path. See §2.3 for the proof that the 3 detail RS are safe to touch.

### 1.4 The "Region basetexsize patch" — `patch_region_basetexsize.py`

`tools/dat-patch/patch_region_basetexsize.py` retargets a **single u32**:
`Region 0x13000000 → terrainInfo → landSurfaces → texMerge → baseTexSize`
(DRW `dats.xml:2899-2900` `<type name="TexMerge"><field name="BaseTexSize" type="uint"/>`;
the tool parses the whole `RegionDesc` forward in ACE field order to locate it, then does
an in-place 4-byte rewrite — legitimate because a u32→u32 edit cannot change the record
length, and it byte-compares before/after to prove nothing else moved,
`patch_region_basetexsize.py:36-42`, `:379-445`). Default `--value 2048`.

**What it unlocks / why it is inert alone:** `baseTexSize` is the ceiling on terrain
texel density for the whole client — it is the composite edge and (via texTiling 2) the
required base terrain RS edge. Patching 1024→2048 tells the client to build 2048²
composites tiled from 1024² base RS. It is **one third of the lane** and is *actively
wrong* without the other two thirds (`patch_region_basetexsize.py:22-27`,
`terrain_lane.py:30-67`): the 29-30 base terrain RS must be re-baked to 1024² and the 8
blend masks upscaled to 1024² **first** (`terrain_lane.py bake --size 1024` /
`alpha --size 1024`), and the 8 blend SurfaceTextures collapsed so the merged mask is the
1024 sibling, not a reachable 512 highres sibling (`terrain_lane.py:335-352`, using
`ImgTex::GetSurfaceDID` DECOMP:366232 — 2-entry ST: entry 0 unless
`Render::ShouldDropHighDetail()`, DECOMP:379978). Ship the u32 patch without the
1024 bases/masks and every composite walks off a 512 record → the OOB crash.

I re-confirmed the retail baseline this session: `baseTexSize = 1024`, 30 base merge
SurfaceTextures, on the shipped base portal (read-only parse).

### 1.5 What specifically breaks (the VeryHigh crash / OOB read)

Two distinct failure modes, both reproduced:
- **Reformat/upsize a *protected* base RS in place** (DXT, or 2048 without the Region
  patch): `TileCSI` reads a DXT payload as raw DWORDs, or the `MergeTexture` base/alpha
  edge identity breaks → **OOB read → crash at VeryHigh** (the 2026-08-16 dungeon-lane
  clobber; `terrain_protected_rs.txt:2-5`).
- **Do the whole lane correctly (edges all match) but raise baseTexSize to 2048:** no
  OOB, but every resident composite is now 4× → **address-space exhaustion / OOM-class
  AV** on the first outdoor composite burst (D4/D4b; VmSize 1.63→2.42 GB then write-AV,
  `HANDOFF-2026-08-17-EOD3.md:165-176`).

### 1.6 Feasibility verdict for terrain-2x

**Not feasible in the Region-baseTexSize-2048 shape on the target client.** The address
space is the binding wall (F-A) and D4/D4b proved 2048 composites exhaust it at both
quality tiers. The `ImageShift` table forecloses a "half-step" composite
(DECOMP:40343). The three honest shapes, per `HANDOFF-2026-08-17-EOD3.md:186-190` and
the plan FAIL branch (`PLAN:144-145`, `terrain-d4b-high-2026-08-18.md:39-48`):

1. **High-detail-supported (Region 2048):** ❌ dead — the diagnostic that would have
   licensed it FAILED at High too.
2. **Composite-memory strategy** (fewer combos resident / earlier purge): unexplored,
   but would require a **binary patch** to the resident `custom_texture_table` lifetime
   (DECOMP:367778) — out of the 9-byte-patch release model; not recommended.
3. **1024 sources WITHOUT the Region patch:** ✅ safe. Keeps `baseTexSize` 1024, so the
   base RS stay 512² (no re-bake of the protected set), and instead pours the win into
   the **detail-texture** lane (§2), which composites through a different path.

**The precise gate a later session runs before shipping any terrain change:** none for
4.H3-as-Region-2048 (it is dead — do not re-import the 1024 bases or run
`patch_region_basetexsize.py patch`). The only terrain fold that ships is the
composite-safe **4.H2** (§2). If someone insists on re-opening 4.H3, the gate is the
**F-A VmSize ledger**: rebuild the arm, run the 6-stop tour, and it must hold peak
`VmSize` under ~2.0 GB (Wine) / the LAA line on Windows — which D4/D4b already show it
cannot. The arm portal and 1024/2x PNG sets are archived at
`/mnt/wbterminal2/terrain-2x/` (base-1024/ = 29 RS PNGs, alpha-2x/) for any re-test.

---

## 2. 4.H2 — terrain detail textures

### 2.1 What a DetailTextureId is

Per terrain type, the Region carries a detail texture separate from the base texture.
In the record it is the **10th u32** of each `TerrainTex`:

- `DRW dats.xml:2922-2933` `<type name="TerrainTex">`: `TextureId` (base ST),
  `TexTiling`, 6 vert-colour bounds, then **`DetailTexTiling`** and
  **`DetailTextureId`** (a `QualifiedDataId` → a SurfaceTexture 0x05).
- `ACE .../Entity/TerrainTex.cs:15-16,28-29` reads the same two trailing u32s as
  `DetailTexTiling` + `DetailTexGID`.
- The lane already parses them: `terrain_lane.py:153-155` collects `detailSts`;
  `patch_region_basetexsize.py:288-294` reads `detailTexTiling=f[8]`, `detailTexGid=f[9]`.

### 2.2 How the client tiles/applies detail textures (the render path)

Detail textures are a **second, independent texture stage**, applied at render time —
they never enter the merge buffer:

- `LScape::GenerateDetailSurface` (DECOMP:506230, body at ~307693) resolves the detail
  ST via `LandSurf::GetDetailTex` (DECOMP:304040 → `TexMerge::GetDetailTex`
  DECOMP:304939), then **creates its own surface**:
  `CSurface::makeCustomSurface(SH_CUSTOMDB)` and `CSurface::UseTextureMap(surface,
  detailImgTex, SH_CUSTOMDB)` (DECOMP:307706-307717). This is the **normal ImgTex/CSurface
  path**, not `TileCSI`/`MergeTexture`.
- Tiling is a per-mesh float, not a buffer tile: `D3DPolyRender::SetDetailTiling`
  (DECOMP:9772) with `Render::landscape_detail_tiling = 2.0` (DECOMP:45535), combined
  with the per-terrain `DetailTexTiling` from the record
  (`(*terrain_tex.m_data)->detail_tex_tiling`, DECOMP:304964). Enable/disable is
  `LScape::SetDetailTexturing` (DECOMP:308209) / `SmartBox::SetDetailTexturing`
  (DECOMP:143221).

### 2.3 Why this "dodges the MergeTexture composite wall entirely" — VERIFIED

Two independent reasons:
1. **Different code path.** The detail surface is a standalone `CSurface`
   (DECOMP:307706), uploaded through the ordinary `ImgTex::CreateD3DTexture`
   (DECOMP:366008) → `IDirect3DDevice9::CreateTexture` path (DECOMP:685242), which
   passes dimensions **verbatim** and **decodes DXT natively** (`DOSSIER:2b, 2f`,
   DECOMP:685242, :128272-128275). It does **not** touch the fixed
   `4 * base_tex_size²` merge buffer (DECOMP:305930) and does **not** add to the ×4
   per-combination composite pressure that killed D4.
2. **Not a base merge texture.** I proved this session (read-only Region parse) that the
   3 detail SurfaceTextures are **disjoint** from the 30 base merge SurfaceTextures:
   - detail STs: `0x050012AF` (tiling 1, used by 29 terrain types),
     `0x05001786` (tiling 4, BarrenRock), `0x05001787` (tiling 4, Grassland).
   - detail RenderSurfaces behind them: `0x060037D2` (64×64 A8R8G8B8),
     `0x06006D57` (256×256 A8R8G8B8), `0x06006D58` (256×256 A8R8G8B8).
   - None of `0x060037D2 / 0x06006D57 / 0x06006D58` appears in the base merge RS set
     (the 29 RS in `/mnt/wbterminal2/terrain-2x/base-1024/`), so upsizing/reformatting
     them cannot break `TileCSI`/`MergeTexture`. They are in
     `terrain_protected_rs.txt` (lines 6, 37, 38) only as the list's conservative
     superset (§1.3 caveat).

So the plan's claim (`PLAN:55`, "dodges the MergeTexture composite wall entirely") is
**correct**.

### 2.4 Candidate records, formats/dims, byte cost

Exactly **3** detail RenderSurfaces (measured read-only this session):

| detail RS | dims | format | tiling | terrain types |
|---|---|---|---|---|
| `0x060037D2` | 64×64 | A8R8G8B8 | 1 | 29 (generic: MarshSparseSwamp, …) |
| `0x06006D57` | 256×256 | A8R8G8B8 | 4 | 2 (BarrenRock) |
| `0x06006D58` | 256×256 | A8R8G8B8 | 4 | 2 (Grassland) |

Uncompressed A8R8G8B8 payload cost:

| set | current | 2× (128/512/512) | 4× (256/1024/1024) |
|---|---|---|---|
| A8R8G8B8 bytes | 540,672 (~0.52 MiB) | 2,162,688 (~2.06 MiB) | 8,650,752 (~8.25 MiB) |
| as DXT5 (÷4) | — | ~0.52 MiB | ~2.06 MiB |
| as DXT1 (÷8) | — | ~0.26 MiB | ~1.03 MiB |

Trivial against the 1.40 GiB highres-side runway. Resident cost is 3 textures — also
trivial, and (critically) **not** multiplied by terrain combinations the way the merge
composites are. This is why the lane is ranked "cheap, composite-safe" (`PLAN:55, 142`).

### 2.5 Exact bake + import route

Because detail textures ride the **normal surface path** (§2.2), they are treated like
any other object texture — **DXT is allowed** and preferred (`DOSSIER:2f`):

1. **Bake** 2×/4× PNGs for the 3 RS via the standard upscale corpus (Remacri), same as
   `texture_lane.py`. Prefer DXT5 (BC3) if the detail art has alpha, DXT1 (BC1) if not —
   consistent with the codec-cap reasoning (`PLAN:F-B`). A 4× (1024²) target is the
   ceiling worth baking; beyond that the 4-level mip clamp (§3, DECOMP:366125) bites.
2. **Import** through `texture_lane.py`'s DXT import path (**not** `terrain_lane.py`'s
   format-preserving A8R8G8B8 `run`, which is for the merge-path base RS). Dimensions
   must be multiples of 4 so `RenderSurface::Serialize`'s
   `imageSize == w*h*bpp/8` identity holds (`DOSSIER:2d`, DECOMP:128504-128508).
3. **Protection:** carve `0x060037D2 / 0x06006D57 / 0x06006D58` **out** of the
   `terrain_protected_rs.txt` exclusion for this lane only (they are detail-only, §2.3),
   OR pass them explicitly. Do **not** touch the 29 base merge RS or the 8 blend masks.
4. **No Region patch, no ST collapse, no baseTexSize change** — the detail STs are
   single-entry already, and the record's `DetailTexTiling` stays as-is.
5. **Gate:** standard `walk_check` + `DatCompress --verify` + WBT round-trip
   (parse each RS back, assert new dims/format), plus a VeryHigh 6-stop tour to confirm
   no regression (this lane should not move `VmSize` meaningfully — that itself is the
   evidence it dodged the wall).

**VERIFY (one open item, non-blocking):** which texture-scale reducer applies to the
detail surface at boot. Object/env textures are halved at the `EnvironmentTextureDetail`
boot default (2 → `fRGBATextureScale = 1` = HALF_RES, `DOSSIER:3a`, DECOMP:366084), and
terrain-merge uses `fLandTextureScale` (shift 0 at handler 3). The custom detail surface
(`SH_CUSTOMDB`) selects its scale in `CSurface::RestoreLostSurface` (DECOMP:358369) — a
later session should confirm which handler bucket `SH_CUSTOMDB` lands in, because if it
is the RGBA bucket, the shipped default-config `EnvironmentTextureDetail = 0` /
`LandscapeTextureDetail = 0` snippet (already part of the terrain lane, `terrain_lane.py:22-23`)
is what preserves the full detail resolution.

---

## 3. 4.H4 — the selective 4096² short list

### 3.1 The client's real texture-size cap (respect this first)

There is **no 3-D world-texture dimension cap** in the client (`DOSSIER:§2`,
independently cross-checked vs the 2013 BinaryNinja decomp):

- `m_caps.MaxTextureWidth/Height` are copied from D3D9 caps and **never read** — dead
  code (DECOMP:457127-457129; the only 5 hits are all writes, `DOSSIER:2a`,
  DECOMP:455604-455605).
- The one `IDirect3DDevice9::CreateTexture` call passes `m_nWidth, m_nHeight` **verbatim**
  (DECOMP:685242, `DOSSIER:2b`). No `D3DXCreateTexture*` anywhere.
- No power-of-two or squareness check on the world path (`D3DPTEXTURECAPS_SQUAREONLY`
  decoded then never read; `bSimpleNonPowerOfTwoTextures` hardcoded 0 and read only in
  the UI, `DOSSIER:2c`, DECOMP:457147-457153).
- The **2048 wall is UI-only**: `UISurface::CreateSurface` hard-rejects `w>0x800 ||
  h>0x800` and saturates the pow2 rounder at 2048 (DECOMP:124912, :124840, :124860;
  `DOSSIER:2h`). World art never goes through `UISurface`. (This is the ">2048 CPU-blit
  crash for UI" the brief refers to — it does **not** apply to 3-D surfaces.)

**So is 4096² even loadable for 3-D world surfaces? Yes** — the client hands the
dimensions straight to D3D9, and on any modern GPU / DXVK `MaxTextureWidth ≥ 8192`, so
the driver accepts it. The binding limits are therefore **not** a client dimension check
but:
1. **Address space (F-A)** — a 4096² A8R8G8B8 is 64 MiB resident; DXT1 is 8 MiB, DXT5
   16 MiB. A short list is fine; a blanket pass is not (`PLAN:F-A`, `:58-59`).
2. **The 4-level mip clamp (the real killer for 4096²).** `ImgTex::CreateD3DTexture`
   builds mips itself and **caps the chain at 4 levels** (`if (v16 > 4) NumMipLevels = 4`,
   DECOMP:366125; `DOSSIER:2e`). A 4096² gets only 4096/2048/1024/512 and **nothing
   smaller** — so at any distance where the surface is minified past 512², it
   **aliases/shimmers worse than retail**. This makes an un-patched 4096² *actively
   counterproductive* at distance and is the technical core of "measure first, expect a
   short list."
3. **Serialize identity** — dims must be ×4 (`imageSize == w*h*bpp/8`, DECOMP:128504,
   `DOSSIER:2d`).

**Recommendation:** if any 4096² ships, pair it with the mip-cap byte patch (raise the
`4` immediate at DECOMP:366125 — `DOSSIER:2e` calls it "small, self-contained,
low-risk"). Without that patch, 4096² only helps for surfaces that are **always** viewed
near-field (never minified below 512²) — which is exactly the "texel-starved at typical
view distance" population the survey is meant to find.

### 3.2 The texel-starvation measurement (runnable-later method)

**Definition.** A surface is *texel-starved* when, at a representative camera distance,
its on-screen footprint demands **more texels than the texture provides at the mip level
the client will actually select** — i.e. texels-per-screen-pixel < 1 at that distance.
Because the client applies no LOD bias to world textures and its mip selection is the
standard D3D9 minification (capped at 4 levels, §3.1), the practical proxy is:

```
texels_per_screen_pixel ≈ (texture_edge / world_edge_of_the_textured_face)
                          × (world_edge / on_screen_pixels_at_distance_D)
```

which reduces to comparing **texel size in world units** against **pixel size in world
units at distance D**:

```
world_units_per_texel   = face_world_edge / texture_edge        (from the mesh UVs + Setup scale)
world_units_per_pixel_D = (2 · D · tan(fov/2)) / screen_height   (camera projection)
starved  ⇔  world_units_per_texel > world_units_per_pixel_D      (texture coarser than the screen)
```

A surface is a **4096² candidate** only if it is starved even at its **current** highest
already-shipped resolution (2048²) at a distance `D` the player commonly views it from,
**and** it is never minified below 512² at that distance (else the mip clamp negates the
gain — §3.1).

**Data + tooling (all from existing commands, read-only):**
1. **Enumerate world surfaces and their meshes.** For each Surface `0x08` →
   SurfaceTexture `0x05` → RenderSurface `0x06` (dims/format), find the models that show
   it: `WBT asset-used-by <RS-or-surface id> transitive:true` — the command's own help
   says it "walks the closure up to Setups/Scenes ('which models show this surface')"
   (`JsonCommandProcessor.cs:3230`). Forward edges (Setup→GfxObj→Surfaces→ST→RS) come
   from `asset-refs` (`:3229`).
2. **Get each face's world size.** From the GfxObj vertices + the placing Setup/Scene
   scale, compute the world-space edge length of the polygons that use the surface
   (UV-span × world extent). This is the `face_world_edge` above. `env_geo.py` /
   `objlib.py` already parse GfxObj geometry; a later session extends them to emit
   per-surface world-extent.
3. **Pick representative D per surface class.** Ground/wall/prop each have a typical
   dwell distance; use the class median (e.g. walls ~3-8 m, ground underfoot ~2 m,
   distant scenery ≫). Screen: 1080p, retail default FOV.
4. **Score and rank.** Emit `texels_per_screen_pixel` at D for every surface at its
   current shipped resolution; the **short list** = surfaces with score < 1 (starved)
   **and** min-mip-at-D ≥ 512² (mip-clamp-safe). Expect the list to be dominated by
   large near-field hero surfaces (a wall/floor you stand on, a signpost you read),
   which is precisely the plan's "short list" intuition (`PLAN:57`).

**Criterion that yields the short list:** ship 4096² for a surface **iff** it is
texel-starved (score < 1) at its class-typical D, is viewed near-field enough that its
selected mip stays ≥ 512² (mip-clamp-safe), and passes the F-A resident-byte budget as
DXT (not A8R8G8B8 — `PLAN` rank #10 rejects blanket uncompressed). Everything else stays
at 2048²/BC3, which `PLAN:F-B` argues is hedonically competitive.

**VERIFY:** whether the client reads any LOD-bias / `D3DSAMP_MIPMAPLODBIAS` for world
textures — I did not find a read site, but the survey's mip-selection assumption
(standard D3D9 minification, no bias) should be confirmed against the sampler-state
setup before trusting the "min-mip-at-D" gate. (G5c DXVK LOD-bias knobs, `PLAN:152`, are
a *separate* external toggle, not a per-texture data lever.)

---

## 4. Execution-readiness summary (per lane)

**4.H3 terrain-2x — 🔴 RED (blocked; do not ship in current form).** The blocker is
proven and empirical: the D4 diagnostic and its D4b High follow-up **both HARD-FAILED**
(`HANDOFF-2026-08-17-EOD3.md:165-191`, `reports/terrain-d4b-high-2026-08-18.md`) — the
Region-baseTexSize-2048 form exhausts the ~2.4 GB 32-bit address space on the first
outdoor composite burst at *both* quality tiers, and the `ImageShift` table
(DECOMP:40343) forecloses a half-step. A later session should **not** re-import the 1024
bases or run `patch_region_basetexsize.py patch`; the only surviving terrain win is the
composite-safe detail lane (4.H2). Re-opening 4.H3 would require a binary patch to the
resident-composite lifetime (out of the release model) plus passing the F-A VmSize
ledger, which the evidence says it cannot.

**4.H2 detail textures — 🟢 GREEN (turnkey).** Verified composite-safe: detail textures
render through `LScape::GenerateDetailSurface` → `makeCustomSurface`/`UseTextureMap`
(DECOMP:307706-307717), a normal DXT-capable `CSurface` path disjoint from the merge
buffer; the 3 detail RS (`0x060037D2` 64², `0x06006D57`/`0x06006D58` 256²) are provably
not base merge textures. Command sequence: (1) bake 2×/4× DXT PNGs for the 3 RS off the
Remacri corpus (DXT5 if alpha, DXT1 if not); (2) import via `texture_lane.py`'s DXT path
with `0x060037D2/0x06006D57/0x06006D58` carved out of `terrain_protected_rs.txt` for this
lane; (3) **no** Region patch, **no** ST collapse; (4) gate with `walk_check` +
`DatCompress --verify` + WBT round-trip + a VeryHigh 6-stop tour (which should barely
move VmSize — the proof it dodged the wall). Byte cost ~1-2 MiB DXT at 4×. One
non-blocking VERIFY: confirm the `SH_CUSTOMDB` texture-scale bucket so the shipped
`EnvironmentTextureDetail=0` config preserves full detail resolution.

**4.H4 selective 4096² — 🟡 YELLOW (one survey first, then a short list).** The needed
measurement is the texel-starvation survey (§3.2): rank every world Surface `0x08`→`0x05`
→`0x06` by `texels_per_screen_pixel` at its class-typical view distance, using
`asset-used-by transitive:true` (`JsonCommandProcessor.cs:3230`) for the model→surface
map and GfxObj/Setup geometry for world-face size; the short list = starved (score < 1)
**and** mip-clamp-safe (selected mip ≥ 512² at that distance). 4096² **is** loadable for
3-D surfaces (no client cap — `DOSSIER:§2`, dims passed verbatim to D3D9,
DECOMP:685242; the 2048 wall is UI-only, DECOMP:124912), but the **4-level mip clamp**
(DECOMP:366125) makes an un-patched 4096² alias badly once minified past 512², so ship
4096² only for near-field hero surfaces and pair it with the mip-cap byte patch. Two
VERIFYs before executing: confirm no world-texture LOD-bias read site, and hold each
candidate to the F-A resident-byte budget as DXT.
