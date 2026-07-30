# HANDOFF — BC7 texture unification (session of 2026-07-29 → 07-30)

**Bottom line:** the texture pipeline was re-architected to bypass the DAT entirely.
Coverage went **1,500 → 2,999 RenderSurfaces**, everything is BC7 with full mip
chains, `client_portal.dat` stays **byte-identical to retail**, and the cold-boot
pack went *back down* to retail size. All structural claims are verified. **Nothing
aesthetic is verified** — the 1070 went offline mid-session and never returned.

Commits this session: `184ba776`, `0d8914f1`, `58ad2991`, `dff8d58b`, `0ca8ac6d`
(+ this doc).

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

## 5. ⚠ TWO EXPORTER BUGS — latent, not introduced here, NOT yet fixed at source

1. **DXT1 punch-through alpha silently dropped.**
   `DatReaderWriter.Extensions/.../RenderSurfaceExtensions.cs` decodes `PFID_DXT1`
   via BCnEncoder.NET `CompressionFormat.Bc1` — the **opaque** variant — so
   `c0 <= c1` index-3 clear pixels become `RGBA(0,0,0,255)`. Verified by re-decoding
   raw `sourceData` with a spec-written decoder and cross-checking holtburger-dat's
   Rust `decompress_dxt1` (RGB agrees to maxErr ≤ 1; only alpha differs).
   Consequence: up to **54% of a quad drawing solid black**; `0x0600396B` is fully
   transparent and would have become **1,329 black chips**.
2. **Six `Base1ClipMap` paletted rows lost their index-<8 clip range.**

**16 rows total had transparency missing from every downstream artifact.** The
hazard agent worked around this for the affected rows (colour-bleed + re-upscale +
nearest-×4 true 1-bit mask; band error 18.50 → 1.47). **The exporter itself is still
wrong**, so anything exported in future inherits it. Fix at source = re-export the
`tex/` corpus.

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
