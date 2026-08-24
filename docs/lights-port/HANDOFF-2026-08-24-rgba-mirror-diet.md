# HANDOFF 2026-08-24 — the zero-quality-loss memory lane: RGBA mirrors, TexMerge, and the hitch gate

Continues: `HANDOFF-2026-08-23-crash-investigation.md` (family A+B),
`ANALYSIS-2026-08-23-familyB-yaraq-dump.md` (fragmentation verdict),
`RESEARCH-2026-08-23-residency-governor.md` (governor design; shipped in
`AcmeLights/Services/MemoryGovernor.cs`, gauntlet-proven).

**Owner constraint (2026-08-24): NO visually worse textures.** The r9 content diet
(2048→1024 caps) is SHELVED. This lane replaces it with a fix that changes zero pixels.

## ⚠ THE HITCH ISSUE — IMPORTANT, measure BEFORE/WITH everything else

The governor ran the entire 14-town gauntlet in Tier-3 crit-hold (freelisting disabled:
every freed DAT object is destroyed immediately and re-loaded from disk on next use).
That is the safe mode for crashes but a plausible source of **hitching / 1%-low
regression** from reload churn — the exact metric the owner already flagged as the #1
gate ("fps avg fine; 1% lows need work").

**The next 14-town gauntlet MUST measure frame-time, not just survival:**
1. Add a per-second frame-time stats line to the AcmeLights heartbeat (avg / p99 / max
   frame dt, count of frames >33ms and >100ms) — the rendering callback fires every
   in-world frame, so the data is already flowing; it just isn't recorded.
2. Run the gauntlet **A/B: `memgov=1` vs `memgov=0`** (hot knob, same route — the tour
   rig is `D:\Temp\acdt-crashtour.ps1`, task `acdtcrashtour`, guard needs ≥2 min idle
   after the rig's own SendInput). Compare hitch counts per town.
3. If crit-hold hitches: first try raising `memcritfragmb` down / widening the recovery
   gate so towns run Tier-1-caps-only (freelisting ON, capped); the caps alone were
   worth part of the ~300MB. The RGBA-mirror fix below should ultimately make crit-hold
   rare, which retires the issue structurally.

`memlog=1` is left ON in `C:\Temp\acdt\lights.cfg` (1 line/5 s, async sink).

## The finding this handoff exists for (dump fingerprint, 2026-08-24)

Fingerprinting the Yaraq crash dump's committed-private regions (dump at
`/mnt/wbterminal2/crashdump-12356/acclient.exe.12356.dmp`; census tooling
`va_census.py` / `dump_stack.py` in the 2026-08-23 session scratchpad — the fingerprint
script classifies 16KB samples at 25/50/75% of every ≥1MiB region):

- committed private ≥1MiB: **1,496 MiB in 610 regions**
- **RGBA-opaque pixel data (every 4th byte 0xFF): 1,008 MiB in 412 regions** ← the hog
- mostly-zero (heap free space): 133 MiB · other: 355 MiB

**Two-thirds of the process is uncompressed 32bpp RGBA pixel buffers in CPU heap** —
redundant with the VRAM copies actually rendered. The nice on-disk textures (DXT/
INDEX16) are NOT the problem; their *expanded CPU-side mirrors* are. The earlier
"15.8MB blocks" were heap segments full of these (the 8MB all-zero ones are heap slack).

## The machinery (decomp, read-verified with line anchors in ~/ac-headers/acclient.c)

1. **TexMerge** — retail's runtime terrain compositor. `TexMerge::FillTempTexBuffer`
   (:305909) allocates a static temp `TexMerge::tex_data = new[](4 × base_tex_size²)`,
   then `CopyAndTile` (:304666) + up to 3× terrain `Merge` + 2× road `Merge` per land
   cell pcode. The merged output becomes a per-cell RGBA texture. With r9-upscaled
   terrain sources, every merged texture ballooned 4–16× — and towns have the most land
   cells in view, which is exactly why towns are where family B lives.
   **Merged textures are regenerable by design**: `Current_Render_LandscapeTextureDetail`
   change → `bNeedReloadTextures = 1` (:380972) → full re-merge. Their CPU copies are
   droppable insurance. Scale globals: `ImgTex::fLandTextureScale`,
   `fClipmapTextureScale/fRGBATextureScale/fIndexedTextureScale` (:380980ff).
2. **D3D9 managed-pool mirrors** — D3DPOOL_MANAGED keeps a full sysmem copy of every
   texture for device-loss recovery. 2005 insurance, pure waste on a machine with 8GB
   VRAM where the client can rebuild any texture from the DAT (or re-merge).
3. **ImgTex / RenderSurface source buffers** — the client may hold its own CPU copy on
   top (`ImgTex::texture_table`, `custom_texture_table`, `GetTempBuffer`).
   Note: palettized (INDEX16) clothing/creature recolors DO re-read source bits
   (Palette::Modify path) — any free-after-upload must exempt those.

## Research tasks (fork-sized; verify in BOTH decomp and dump)

- Split the 1,008 MiB precisely: TexMerge merged outputs vs managed mirrors vs ImgTex
  source copies. The dump can arbitrate: region sizes/contents vs known merged-texture
  dims; managed-pool mirrors should track the D3D texture set 1:1.
- `ImgTex::CreateD3DTexture` (ACBindings has offsets): which D3DPOOL is used per
  texture class? Where do source bits go after upload — kept? freed? by whom?
- Device-loss story: what the client does on D3DERR_DEVICELOST; whether the
  bNeedReloadTextures re-merge path can serve as the recreation path for default-pool
  merged textures. Client runs windowed (FullScreen=False) — losses are rare.
- The palette-recolor exemption list (which PFIDs/classes re-read CPU bits).

## Implementation sketch (Acme-plugin pattern, same discipline as the governor)

- New AcmeLights service (or sibling plugin): hook texture creation; put merged-terrain
  (and, class-by-class, plain world DXT) textures in D3DPOOL_DEFAULT and/or free CPU
  source buffers post-upload. Escape knobs per class, default-ON only after the 1070
  gauntlet + eye pass. On device reset: trigger the client's own reload path.
- Gates: (a) 14-town gauntlet with the NEW frame-time telemetry, zero crashes, worst-town
  committed-private ≤ **1.1–1.2 GB** (fork A's target), governor OUT of crit-hold in
  towns; (b) owner eye-test — pixels must be identical (screenshot A/B is definitive
  here, unlike the shelved diet); (c) alt-tab / resolution-change / UAC-prompt survival
  (device-reset paths).

## Reference numbers (0x06 census of the deployed r10work pair, 2026-08-24)

Effective texture set (highres overlay over portal): 22,978 records, ~2.9 GiB real
payload. 2048² DXT class = 441 records ≈ 805 MiB; 1024² DXT ≈ 1,460 records ≈ 640 MiB;
INDEX16 ≈ 4,200 records ≈ 740 MiB (expands ×2 + per-palette-variant duplicates);
3× 4096² A8 masks. Kept for context only — the diet is shelved per the owner constraint.

## Deployed state (2026-08-24, end of session)

- 1070: governor AcmeLights.dll (107,520 B) live in `C:\Games\Chorizite\plugins\AcmeLights\`
  (backups `.bak-0823{,-2,-3}`), exe = LFA-fixed (sha f2880d6c…75a40730), client KILLED
  after the gauntlet. Retuned knobs appended to lights.cfg: memlowmb=1300 memhighmb=1200
  memcritmb=1700 memcritfragmb=5, memlog=1, bloomday=1 + 0.45/2.6/3 (owner's middle).
- Master fast-forwarded: the whole integ line (LFA fix lane, governor, docs) is on
  origin/master. `dat-align-lfa` is a registered patch_client.py entry
  (/mnt/wbterminal2/ac-eor-patch/); the canonical patched exe regenerates with it.
  ⚠ buildbox wine kit still has the pre-LFA exe — redeploy on next boot.
- RTSSHooks.dll (RivaTuner) pins 52.6 MB of low VA on the 1070 — owner: consider
  removing; never on shipping player boxes.
