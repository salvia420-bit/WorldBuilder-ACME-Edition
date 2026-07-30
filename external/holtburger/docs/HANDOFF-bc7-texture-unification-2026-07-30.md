# HANDOFF — BC7 texture unification (session of 2026-07-29 → 07-30)

**Bottom line:** the texture pipeline was re-architected to bypass the DAT entirely.
Coverage went **1,500 → 2,999 RenderSurfaces**, everything is BC7 with full mip
chains, `client_portal.dat` stays **byte-identical to retail**, and the cold-boot
pack went *back down* to retail size. All structural claims are verified. **Nothing
aesthetic is verified** — the 1070 went offline mid-session and never returned.

Commits this session: `184ba776`, `0d8914f1`, `58ad2991`, `dff8d58b`, `0ca8ac6d`
(+ this doc).

**Follow-up session 2026-07-30 (later):** the mip validator that produced the
shipped bake was never committed — now `ab56d786`, with tests. Both §5 exporter
bugs are **fixed at source** (`6d1ffe91`, `494b1aea`) and their blast radius
re-measured against the real DAT: **~702 rows, not 16**. §5 is rewritten; the
numbers it used to carry were wrong. Nothing has been re-exported (§9.6).

---

## 1. THE PIVOT — read this first, it reframes everything

The client **never opens a `.dat`**. It fetches shards by `(namespace, file_id)` via
`shard_url_template` with a resident-bytes cap
(`crates/holtburger-resource-http/src/manifest_source.rs`), and `dat-shard` already
preserved non-retail namespaces (`holtburger/core` survives because the HBA is read
first). **The DAT was a distribution format we had been treating as a constraint.**

Routing textures through a client-native namespace voids, for the texture path:

| constraint | status |
|---|---|
| retail 31-bit / 2 GiB address space | gone — no monolithic DAT |
| PFID enum has no BC7 code | gone — our namespace, our format, our decoder |
| DXT-only block formats | gone |
| DX9 4096² dimension cap | gone (WebGL2; the 1070 does 16384) |
| DatReaderWriter 5 MB record cap | gone |
| the `0xCDCDCDCD` b-tree leaf bug | gone *for this path* |
| the 5 refused 4096² records | gone |
| **boot.hba 5.75× growth** | **gone** — 1,972,841 B, retail size |

And ACE keeps loading a pristine `client_portal.dat` for the things it actually
needs (SpellTable, MotionTable, Setup/GfxObj physics, CellLandblock, EnvCell) —
none of which textures touch. `~/ac_base_dats/client_portal.dat` still hashes
`dc6e500ba22e6b186db7171e3f3345238b6444c85d798adc85e550973b8d12e4`.

**Corrections to the earlier record, both mine, both load-bearing:**
- I claimed the 2 GiB wall was DatReaderWriter's alone and the format allowed ~4 GiB.
  **Wrong.** `CLBlockAllocator::ExpandFile` writes block-chain pointers as
  `offset | 0x80000000`, `Load_Data` tests `if (v7 < 0)` then masks `0x7FFFFFFF`, and
  `DiskDev::SyncRead/SyncWrite` call `SetFilePointer(fd, off, 0, 0)` — NULL high word,
  signed LONG. Bit 31 is a **flag**; retail cannot seek past 2 GiB. `OpenDataFile`
  validates only the magic, so a >2 GiB dat is **not rejected — it opens and silently
  misreads.** "Just widen to uint" would have shipped corruption.
- I claimed only the 1070 could render BC7. **Wrong** — SwiftShader exposes
  `EXT_texture_compression_bptc` and renders it in software. Local iteration works.
- `portal_dat_iteration: 620756992` is **not** a hires marker (it appears with the
  pristine retail portal too). It only means a real portal DAT was layered in via
  `--eor-portal` rather than coming from the HBA (which yields 0).

---

## 2. WHERE THINGS ARE

| thing | path |
|---|---|
| **BC7 payloads (v2, mipped)** | `/mnt/wbterminal2/pbr-terrain/bc7/blocks-mip/` — 2,999 `.hbc7` |
| encode ledger (per-record PSNR/levels) | `/mnt/wbterminal2/pbr-terrain/bc7/encode-ledger-mip.jsonl` |
| **servable dist** | `/mnt/wbterminal2/holtburger-dist-bc7m` (served on **:8767** from `/mnt/wbterminal2/bc7-webroot`) |
| encoder (mips default ON) | `scratchpad/bc7/bc7cli_v2` — src `scratchpad/bc7/bc7cli.cpp`, upstream in `bc7enc_rdo-master/` |
| BC1 comparator | `scratchpad/bc7/bc1cmp` |
| **local ESRGAN (iGPU!)** | `scratchpad/esrgan-linux/realesrgan-ncnn-vulkan` + `models/` |
| agent reports | `/mnt/wbterminal2/{terrain-bc7-agent,hazard-rows-agent,bc7-bake-agent,bc7-client-agent}/` |
| screenshots + measurements | `/mnt/wbterminal2/bc7-shots/` (see `READ-ME-FIRST.txt`) |
| DRW analysis (shelved) | `/mnt/wbterminal2/drw-int32-{code,discord}/` |
| old hires dist (superseded) | `/mnt/wbterminal2/holtburger-dist-hires` |

`scratchpad` = `/tmp/claude-1000/-home-wbterminal/b7d416d2-1612-4f09-8ff6-fe8d4602f741/scratchpad`
(**session-scoped — copy anything you need to keep off `/tmp`**).

---

## 3. THE PIPELINE (how to reproduce or extend)

```
retail RenderSurface PNG  (statics-x1/tex/, 20,684 exported)
   └─ ESRGAN ×4  realesrgan-x4plus  -j 1:1:1 -t 128        ← SAME model everywhere
        └─ fidelity gate  corr>=0.90 && mean|delta|<=20 vs box-downsampled source
             └─ bc7cli_v2 → HBC7 v2 container (level 0 + full mip chain)
                  └─ dat-shard --tex-bc7 <dir>  → namespace holtburger/tex-bc7
                       └─ client: lazy fetch by rsId → parseHbc7 → CompressedTexture /
                          CompressedArrayTexture via compressedTexSubImage3D
```

**HBC7 v2 container** (dictated by the client's `parseHbc7`, NOT invented):
`magic "HBC7" | u32 width | u32 height | u32 blocksX | u32 blocksY` then levels
appended **contiguously**, each `ceil(w/4)*ceil(h/4)*16` bytes, dims halving via
`max(1, n>>1)` terminating at 1×1, and **every byte consumed** (trailing bytes are a
hard parse error). Mips are box-downsampled from the **source** and each level
encoded independently — never by decoding/re-encoding BC7.

Bake: `./target/release/dat-shard --input dats/assets.hba --eor-portal
~/ac_base_dats/client_portal.dat --eor-local ~/ac_base_dats/client_local_English.dat
--tex-bc7 /mnt/wbterminal2/pbr-terrain/bc7/blocks-mip --output <dir>
--manifest-version 2`, then symlink `scenery spawns events suite vfx` from the live
dist. ~6 min, peak RSS 1.93 GiB (the portal merge dominates; BC7 ingest streams at
~0.1 MB).

Flags: `?texBc7=on` (statics), `?terrainBc7=on|512|1024` (terrain). **Both default
OFF, exact-match, capability-gated on `EXT_texture_compression_bptc`.** Flag-off does
not even install the module.

---

## 4. STATE — verified numbers

**Final bake:** 888,140 unique shards · `tex-bc7` **2,999 records / 2,403.6 MB / 0
skipped** · `boot_pack` 1,972,841 · exit 0.

**Encode:** 2,950 base records, 0 failures, PSNR RGB min 35.40 / median **48.04** /
mean 47.64 (max-quality BC1 on the same sources: ~42–43 dB, so **+5.3 dB** at 2× the
bytes). Mip levels 6–13, **0 single-level rows**. Total 2,536 MB = exact 4/3 overhead.

**Coverage:** 3,629 world-visible Surfaces → 3,497 textured (132 are flat
`Base1Solid`, nothing to texture) → **3,228 unique RenderSurface records**.
Payloads on disk: **2,999**. Interiors: 707/804 covered, 82 untextured.

**Measured visual win** (pinned sun via `setSkyTimeOverride`, matched settle gate,
identical crops, SwiftShader):

| region | OFF | ON | Δ |
|---|--:|--:|--:|
| building masonry + timber | 373.5 | 784.7 | **+110.1%** |
| left stone wall | 1057.1 | 1669.2 | **+57.9%** |
| well (static) | 571.8 | 843.1 | **+47.4%** |
| **ground/terrain — not in BC7** | 685.4 | 685.4 | **+0.0%** ← negative control |

Terrain identical to the decimal is the control working, and also proves the two
frames were comparable.

**Live diag:** 118 textures built, 15 array layers, 3 compressed buckets, 104.5 MB
fetched, 0 parseErrors, 0 badMagic, **0 console errors**. Mip filtering verified
engaged: `minFilter=LinearMipmapLinearFilter`, `generateMipmaps=false` (correct —
WebGL cannot generate mips for compressed data; ours come from the container).

**Terrain (`0ca8ac6d`):** 33 atlas layers → only **29 unique RenderSurfaces** (retail
shares `0x06006D6F`, `0x06006D4D`, `0x06006D3C`). Upscaled locally on the HD 520
iGPU in ~59 min. Gate 25/29; the 4 dark rejects (MudRichDirt, ForestFloor, DarkMoss,
Olthoi) fall back to retail-bilinear ×2 — **4/33 t1024 layers carry bilinear, not
ESRGAN detail**, in the manifest, not silent. t512 = 22.0 MiB GPU / albedo 39.65 dB;
t1024 = 88.0 MiB / **46.04 dB**. 4.0× VRAM saving at equal dims; t1024 buys 2× linear
resolution for the same 88 MiB low/mid already spends (vs 352 MiB at high/ultra).
`nra` derived from the retail albedo because **POM reads height from the albedo
array's ALPHA** (`terrain.js:1123`) and offsets `cellUv` — CC0 height under retail
albedo is a registration bug, not a style choice. **Cost: glassy ice is lost** (real
regression vs CC0 `Ice003`); bump-from-diffuse reads stains as dents; height-in-alpha
costs 0.75 dB. **The CC0 arm is byte-unchanged and REMAINS THE DEFAULT.**

**Hazard rows:** 301 ship / **321,143 placements** recovered; 252 of those
*overwrote* (corrected) earlier encodes. 67 held — paletted, where BC7 measurably
degrades (65/79 below 40 dB, maxErr to 215); retail's 16-bit indices are exact.
BC7 unlocked **all 123 alpha rows** (the exclusion existed only because DXT1 has no
alpha; 91–94% of blocks land in modes 5/6/7). Dither 44 + tiny 85 ship at **retail
resolution** — the anime model was tested and *rejected* (denoises dither harder:
pointStdRatio 0.649 vs 0.809). 17 of 37 no-upscale rows rescued by per-channel mean
matching (**130,917 placements**, the single biggest recovery).

---

## 5. ✅ TWO EXPORTER BUGS — FIXED AT SOURCE 2026-07-30 (`6d1ffe91`, `494b1aea`)

Both are fixed in the exporter now. **The numbers below replace the ones this
section carried at handoff — every one of them was wrong**, and the corpus has
NOT been re-exported yet (see §9.6).

1. **DXT1 punch-through alpha silently dropped** — fixed in `6d1ffe91`.
   Every decode site asked BCnEncoder for `CompressionFormat.Bc1`, the **opaque**
   variant, so `c0 <= c1` index-3 clear pixels became `RGBA(0,0,0,255)`.
   Ground truth is retail's own `D3DXTex::D3DXDecodeDXT1` (`acclient.c:555285`):
   `if (v4 > (unsigned __int16)v5)` picks 4-colour mode, and the else branch zeroes
   all four floats — the fourth **is** alpha.
   - **Four live sites, not one**: `RenderSurfaceExtensions.ToRgba8`,
     `CommandEngine.TextureParity` (the client-parity *reference* — so it was
     comparing a correct Rust decoder against an all-255 alpha channel),
     `CommandEngine.UiSpriteExtract`, and `RenderSurfaceExtensions`'
     **encode** path (`Bc1` never emits punch-through, so importing a PNG with a
     cutout silently flattened it). `ObjectSpriteGenerator.DecompressDxt1` was
     already correct and is the in-repo reference.
   - **Blast radius is 257 records, not 1,905.** Of 20,684 RenderSurfaces, 1,971 are
     DXT1 and 1,905 contain a `c0 <= c1` block — but only **257** actually use
     index 3. `c0 <= c1` is *not* the trigger; flat-colour blocks satisfy it
     trivially. 906,652 corrupted pixels; **246 of the 2,999 shipped BC7** records.
   - `0x0600396B` fully transparent: **true** (the only such DXT1 record).
     "**1,329 black chips**" is **unsourced — do not repeat it.** The asset graph
     gives 1 SurfaceTexture → 1 Surface → 33 GfxObjs → 147 Setups. The qualitative
     claim stands; the number does not.
   - "up to 54%" is a shipped-set figure (`0x06003C4A`, 54.44%). Corpus-wide the
     worst is **`0x06005B7E` at 75.33%**, and it plus 10 others are **outside** the
     shipped BC7 set, so they need the non-BC7 path re-exported too.
2. **`Base1ClipMap` paletted rows lost their index-<8 clip range** — fixed in
   `494b1aea`. Retail `ImgTex::CopyIntoData` (`acclient.c:365959` INDEX16,
   `:365980` P8) writes the destination DWORD as literal `0` — RGB zeroed too, not
   just alpha. The threshold is 8 because `Palette::InitLoad` (`acclient.c:365035`)
   expands 256 palette entries into 2048 by replicating each 8×, so "index < 8" is
   exactly original entry 0.
   - **"Six rows" was wrong — the real figure is 445 rows / 2,110,807 pixels.**
     The six was a mis-transcription of the hazard agent's "6 of the 79" *held
     paletted worklist*, and even there only four are clipmap-paletted;
     `0x0600736C`/`0x0600736D` are `PFID_DXT1` with no palette — bug 1,
     double-counted. All 445 exported PNGs were confirmed to have alpha range
     (255,255): zero transparent pixels. 201 rows are >50% wrong; 5 are 100%
     clipped and exported as a solid rectangle of palette colour 0.
   - Clip-ness lives on the **Surface (0x08)**, not the RenderSurface, so the fix
     threads an explicit flag and `ExportTextures` resolves ownership up front.
     89 RenderSurfaces have both a clip-map and an image owner; "any owner is a
     clip-map" wins — retail is itself ambiguous, its `texture_table` key omits the
     clip-map bit (`acclient.c:367712`), so first-load wins.

**So the two bugs together are ~702 rows (257 DXT1 + 445 INDEX16 — disjoint by
format), not 16.** The hazard agent hand-repaired a handful (colour-bleed +
re-upscale + nearest-×4 true 1-bit mask; band error 18.50 → 1.47); the rest are
still wrong in `tex/` and in every artifact downstream of it.

Verification (both fixes, real data, no `~/ac_base_dats` write — sha256 still
`dc6e500b…d12e4`): bug 1 checked against 5 real-DAT fixtures with an
independently written spec-correct Python decoder — alpha exact, max RGB delta 0,
including a record with exactly **one** transparent pixel in 65,536 that any
mean- or thumbnail-based check would pass while broken. Bug 2's ownership walk
finds 721 clip-map Surfaces / 888 RenderSurfaces, matching an independent
from-scratch Python b-tree reader; all 445 rows produce exactly the independently
computed clipped-pixel count, decode to 0 transparent pixels with the flag off,
and all 34 clip-map paletted rows with no index < 8 are byte-identical either way.
Artifacts: `/mnt/wbterminal2/bug1-dxt1-agent/`, `/mnt/wbterminal2/bug2-clipmap-agent/`.

Related client fact: `applyClipMapRenderState` alpha-tests at **200/255**. ESRGAN's
soft edge erodes binary cutouts there (mask IoU 0.7654; one row lost 23% of its
cutout). Re-binarising the ×4 alpha at 128 restores it (min IoU 0.9470) — but doing
that to *graded* rows measured **worse** (0.24), so those ship verbatim.

---

## 6. DECIDED (don't relitigate)

- **ESRGAN darkening accepted** — "the darkness suits the current look". Uniform
  across both tracks (median 2.2/255, max 17.2). No gain correction. This also closes
  the 2026-07-29 eyetest's "ESRGAN heads read ~1 value darker" note.
- **DatReaderWriter work dropped** — textures bypass the DAT, portal.dat is never
  written. Analysis + patches shelved at `/mnt/wbterminal2/drw-int32-*`. Note the
  vendored HEAD already has the b-tree fix but all six consumers pin NuGet **2.1.2**;
  four already-corrupt DATs exist on disk (`asheron-ui-tools/testdats/`,
  `EnvCellMove{Export,Inspect}`), none live.
- **The 34 CC0 statics picks are user-approved**; the "plank character regression"
  was an *agent's* taste veto, not a defect. Do not resurrect it.
- **hires portal DAT superseded**, not shipped.
- **Buildbox not needed** — realesrgan needs Vulkan, not NVIDIA, and the HD 520 iGPU
  works (115 s per 512²→2048²).

## 7. OPEN — all aesthetic, all need the 1070 + MOTION

1. `texStorage3D` accepting a 33-layer 11-level compressed array (never rendered).
2. **Derived-normal green sign** — frame pinned from `terrain.js:1420-1427` but
   height polarity is still an assumption.
3. POM with derived height.
4. **Retail-vs-CC0 terrain look call** — including whether losing glassy ice matters.
5. **Does the mip chain kill the shimmer** — the user's original question was whether
   shimmer might read as sun sparkle. **Shimmer is temporal; no still can answer it.**
6. The two alpha correctness fixes "predict visible changes" — unverified.
7. Anisotropy at `quality=high` — a run was in flight at handoff time; `aniso=1` at
   default quality is CORRECT (preset-driven: low 1 / mid 4 / high+ultra 16,
   `index.js:1045-1052`), not a BC7 bug.

## 8. TRAPS BURNED THIS SESSION (all cost real time)

- **`rg -rn 'pat'` parses as `--replace n`** and silently rewrites every match. Use
  plain `rg -n`.
- **`.upper()` on an rsId** turns `0x…` into `0X…` and breaks every path lookup.
- **`pkill -f <pattern>` where the pattern is in your own command line** → self-kill,
  exit 144. Put the launch in a script.
- **`/usr/bin/time` does not exist on this box** — a bake silently no-op'd in 17 s.
  Poll `VmHWM` instead.
- **ACE single-login**: reusing `tailnet1` inside ~60 s fails as
  `no CharacterList within 30s (handshake timeout)`, which reads like a network fault.
  Wait 65 s+ between arms.
- **`performance.getEntriesByType('resource')` caps at 250 entries** by default and
  silently drops the rest — it reported 105 KB for an entire cold boot. Raise it via
  `addInitScript` AND account bytes from CDP response events.
- **A/B confounds, three in one measurement**: unpinned sun (day vs night), unequal
  settle (one arm 82.9 s vs the other 206.4 s → unloaded terrain read as a render
  difference), and a watcher waiting on a wrapper that exits immediately after
  `nohup` (reported "completed" while the real run continued).
- **`serve.py --check` reports OK on a dist with ZERO textures** — the namespace is
  declared even with 0 records. Always check the bake's own record count.
- **A `>20%` per-chunk abort assumes independent failures.** Worklist order groups
  related art, so one hard family trips it on a healthy GPU; and `MISMATCH` (content)
  must not be conflated with `ZERO` (blank output = real GPU fault).
- **`kickDance` is a removed flag** with a lint against re-emitting it.
- **1070 availability**: no sleep timer at any hour (idle sleep + hibernate both
  disabled, no wake timers, no scheduled sleep task), but shutdowns are
  *person-initiated* (`1074`/RuntimeBroker). Windows Update active hours end at
  **midnight**, so post-midnight auto-restart is permitted (currently defanged by
  `NoAutoRebootWithLoggedOnUsers=1`). The real-GPU path needs the **interactive**
  session, so any reboot kills it.

## 9. TO RESUME

1. Server: `scratchpad/serve-bc7m.sh` → :8767 (or re-point `HOLTBURGER_DIST`).
   **Always `?nosw=1`.**
2. Local A/B: `scratchpad/bc7_fallback_check.mjs --flag on|off --skyT 0.5`
   (pins the sun, common settle gate, early-bails on boot error).
3. Sharpness measurement: the Laplacian-variance/high-frequency crop comparison in
   the transcript — keep the terrain crop as the negative control.
4. When the 1070 returns: `scratchpad/launch-bc7.bat` (offscreen `-32000,-32000`,
   `--mute-audio`, isolated `cdpwb-bc7` profile), tunnel
   `ssh -fN -L 9333:127.0.0.1:9333 -R 8767:127.0.0.1:8767 young@100.127.215.75`,
   then `scratchpad/bc7_shots.mjs`. **Never `taskkill /IM chrome.exe`** — match the
   test profile by `--user-data-dir` only; a person uses that box.
5. Remaining coverage: 67 held paletted rows + 163 creature INDEX16 (palette-
   preserving path, user decided creatures stay indexed so recolour survives).
6. **Re-export the `tex/` corpus** — the exporter is correct as of `6d1ffe91` /
   `494b1aea`, but nothing downstream has been regenerated. ~702 rows change
   (257 DXT1 punch-through + 445 clip-map paletted). Gate: a full re-export of
   `~/ac_base_dats/client_portal.dat` must change **exactly** those rows and leave
   every other PNG byte-identical. Then re-run the ESRGAN → gate → `bc7cli_v2`
   pipeline for the changed rows and re-bake; 246 of the 2,999 shipped BC7
   payloads carry the DXT1 fault, and the 441 clip-map rows the hazard agent did
   not hand-repair were never audited. `export-textures` needs a project
   (`RequireProject`), and it opens the dats **ReadWrite** — point it at a copy,
   not `~/ac_base_dats`.
7. The two exporter fixes "predict visible changes" (§7.6) and are still
   **unverified visually** — the 1070 never came back this session.
