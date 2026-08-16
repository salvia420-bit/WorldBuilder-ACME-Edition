# HANDOFF — 2026-08-16 PM: compression proven, r6 gated, phase-2 READY (read this first)

Supersedes the open items in HANDOFF-env-variant-design-2026-08-16.md and the
release-roadmap addenda. Everything below is on branch **integ/all-20260813**
(FF-clean to origin/master; see MERGE-STATUS.md). Context was tight this
session — this is the durable state.

## 0. TL;DR
- **Compression patch DERIVED + VALIDATED IN-CLIENT.** The ~40-50% portal
  headroom that phase 2 assumes is now REAL, not hoped-for. Patched client
  loaded a 45%-compressed portal, rendered decompressed textures at 1920x1080,
  entered world. → **Phase 2 (4x-everywhere textures + full-frequency dungeon
  relief, "build toward 600 MiB, do it once") is UNBLOCKED.**
- **r6 scenery tier GATED (passed) at VeryHigh** after fixing a cross-lane bug.
- **Two Opus-5 "artist" audits** found 10 real texture/geometry defects; fixes
  landed (commit 1ee63103) and validated in-client.
- **All the day's INI/resolution/daylight facts nailed down** (the client was
  being eyeballed at its WORST detail for every prior gate — now fixed).

## 1. WHAT'S DONE + VALIDATED (with the proof)
### 1a. Compression client patch (the phase-2 key)
- Mechanism (community, trevis/Yonneh): compressed records already have a full
  zlib path; `DiskController::Decompress` zeroes `Cache_Pack_t.m_iVersion`, and
  `AsyncCache::SerializeFromCachePack` rejects version-0 packs. One-byte fix =
  NOP that reject `je`. `GetCoreSDKPackVersionFromDBObjPackVersion` is a const-2
  stub so ONLY the `m_iVersion!=0` test gates.
- **Located by byte-signature** (the map/decomp/exe are 3 different builds):
  signature `83c4043bf774713bc7746d56c7442410`, NOP the `74 71`→`90 90`. In our
  ac_base_dats build that's file 0x17B28; in the 1070's box build it's 0x17878
  — the harness re-locates per build.
- **Tooling**: `/mnt/wbterminal2/ac-eor-patch/patch_client.py` (registry key
  `dat-decompress`, plus `mip-cap-16` and notan's palette-leak). `list`/`verify`
  /`apply --only <keys>`. PE checksum auto-fixed. Full writeup:
  `ac-eor-patch/COMPRESSION-PATCH-FINDINGS.md` + `PATCH-NOTES.md`. Yonneh's map
  copied local (`yonneh-acclient.map`).
- **IN-CLIENT PROOF (2026-08-16 16:12)**: `acclient.box-PHASE2-TEST.exe`
  (leak+mip16+decompress on the box's own 4,837,376 build) + a fully
  DatCompress'd r6 portal → loaded, authed, ENTERED WORLD, rendered decompressed
  textures at 1920x1080 (`ac-eor-patch/gate-shot13.png`). The one-byte fix works
  end-to-end.
- **DatCompress tool** (`tools/dat-patch/DatCompress/`, DRW nuget 2.1.2): rewrites
  0x06 RenderSurface records as zlib-compressed. **Measured 45% on the r6 texture
  bulk** (1292.7→710.5 MiB, ~580 MiB freed), realCorruption=0 (on-disk bytes
  proven byte-identical to originals via a full-read inflate = what the client's
  zlib uncompress does). TEXTURE-ONLY by design so ACE.DatLoader (no inflate
  path, never reads textures) stays happy.
- **paradox caveat handled**: version-0 unpack uses default schema — SAFE for
  texture records (no version-gated schema). Don't blanket-compress non-texture
  records without the round-trip test.
- **Known DRW bug found (not ours, upstream)**: `DatDatabase.Decompress` does a
  single `ZLibStream.Read` that under-fills large records → tooling can't re-read
  compressed records until the Read is looped. Harmless to the retail client
  (zlib uncompress fills fully) and ACE. Fix: loop the Read in both Decompress
  overloads. Filed for upstream DRW.

### 1b. r6 scenery tier — GATED at VeryHigh
- Census gap closed: region-table scenery (trees/plants/egg-orchard) + all static
  objects were never in a texture tier. `dat-patch-scenery/` census → 340
  bakeable RS (all corpus-covered), baked capped 1024² with all audit fixes.
- Export `dat-patch-scenery/export/` (portal ~1686 MiB, 361 MiB headroom). 16
  missing-corpus textures staged as buildbox `upscale-corpus/batch4-in`.
- **1070 gate PASSED (2026-08-16 17:14, VeryHigh/1920x1080/DetailTextures=True)**:
  full Holtburg + Alabree + Yaraq + Braid + Muggy Guruk tour, zero crashes,
  clean render. Frames `dat-patch-scenery/gate-vhigh-cx_*.png` (taildropped to
  owner's redmi). GATE-STATUS.md in the lane dir.

### 1c. Opus-artist audit fixes (commit 1ee63103) — validated
Ten defects fixed across texture_lane.py / legibility.py / pallib.py /
RenderSurfaceExtensions.cs / CommandEngine.EnvironmentImport.cs:
- **`normal_gain` was DEAD** in relief3d.py:895 (dropped between docstring and
  body) — recipe C's "sculpted normals gain 2.5" shipped as gain 1.0 in EVERY
  lane since inception; the A/B that promoted C compared byte-identical arms.
  Fixed + synced to 3 mirror copies.
- texture_lane: clipmap alpha re-binarize at retail's 100 cut (DXT moves the
  client alpha-test ref 100→200); luminance anchor = retail (was self-referential
  +15% brightener); ESRGAN edge cross-fade (tileability); dither; clipmap→DXT5.
- legibility: wrap-aware emboss gradient (was 1-texel edge pipe).
- pallib: color-bleed transparent texels (was black backing → foliage halos).
- C#: BC encoder Balanced→BestQuality; normalize vn at parse.
- Still owed (not blocking): wrap-padded corpus RE-UPSCALE on the buildbox
  (proper tileability fix; the cross-fade is a stopgap). The mip-cap-16 exe
  patch is a candidate (needs its own far-pan QA — it was NOT the crash cause).

### 1d. The terrain cross-lane collision (today's scare, root-caused + fixed)
- Symptom: r6 crashed the client on Holtburg at VeryHigh (AV @ RVA 0x13EA26).
  First mis-attributed to CopyIntoData/r6 scenery; a Fable fork + disasm proved
  it's **`ImgTex::MergeTexture`** (terrain alpha compositor).
- Root cause: the DUNGEON texture lane's EnvCell census included **0x06006D4B and
  0x06006D50** — terrain base textures shared with dungeon surfaces — and
  Remacri-4x'd them to 2048² DXT1. Terrain needs them 512² A8R8G8B8 (MergeTexture
  locks + derives loop bounds from the base); the DXT/2048 base overruns the
  alpha buffer. Only shows at VeryHigh (first exercised today). r5==r6 because
  both inherit the dungeon-tier clobber.
- Fix: `DatRestore` (new tool, `tools/dat-patch/DatRestore/`) copied both records
  verbatim from retail base → 512² A8R8G8B8 in **r6 AND r5** (fixup clean).
- SYSTEMIC guard: `tools/dat-patch/terrain_protected_rs.txt` (48 terrain RS) +
  `texture_lane.run_lane` now REFUSES to bake any protected RS. Can't recur.

### 1e. INI / client facts (all in docs/dat-patch/1070-acclient-driving.md)
- **Every prior gate ran at the client's WORST detail** — the documented
  `EnvironmentTextureDetail=0` recipe was BACKWARDS (numeric = choice INDEX,
  worst-first; 0 = VeryLow). Correct spelling is the NAME: `VeryHigh`. This
  explained the owner's "still looks low-res".
- Resolution: `[Display] Resolution=1920x1080` (choice-NAME form), in-world only
  (login is force-800x600, released at world entry), mode must be
  adapter-enumerated. Showcase INI = VeryHigh both details, Anisotropic, detail
  textures on, DegradeDistance=10000 (pins band 0 so buildings don't LOD to
  retail past 50m), AutomaticDegrades=False, 1920x1080. Lives at scratch
  `UserPreferences.showcase2.ini`, deployed on the box.
- `/day` == the "Always Daylight Outdoors" character option (PersistentAtDay);
  lighting-only, sky stays on the game clock (trailer still needs a real Dereth
  day window for the sky).

## 2. REMAINING FOLLOWUPS (small, mostly mechanical)
1. **Repackage fixed r6** with release.sh → `release-r6-fixed.log` (running at
   handoff time; check it landed a fresh `acme-dats-r6-scenery.tgz` + sha).
2. **r5 already restored** (terrain fix applied to `r5-export/`; pre-fix saved as
   `.pre-terrainfix`). If r5 is ever re-served/re-packaged, it's now VeryHigh-safe.
3. Compression round-trip soak = effectively DONE (realCorruption=0 full-portal +
   in-client render). Only extend if you compress NON-texture records.
4. Buildbox `batch4-in` (16 scenery textures) upscale when the box is next up.
5. Upstream DRW: loop the `ZLibStream.Read` in DatDatabase.Decompress.

## 3. NEXT PHASE (the "do it once" plan, now unblocked)
Owner decision was: build toward the ~600 MiB the compression patch buys,
don't right-size textures twice. Order:
1. Ship trevis's patch into the distribution client build (patch_client.py
   `apply --only dat-decompress` on the shipped EoR exe; decide mip-cap-16
   separately after far-pan QA). Round-trip test any non-texture compression.
2. Re-encode texture tiers at TRUE 4x (mip-cap patch makes 4x correct) WITH
   compression (texture-only), reclaiming the bulk.
3. **Full-frequency dungeon relief**: the current env-variants are at a ~3m
   wavelength (2 cycles across the screen vs 32 for buildings) because the
   triangle budget scales with source polygon COUNT not AREA (env_geo.py:142,
   segments=12). Rebuild area-based (~0.3m spacing) into the reclaimed headroom
   — all 3,924 variants, no cherry-picking. See the geometry-artist audit in
   this session's transcript for the exact env_geo._shell fix + the caveat that
   dungeon interior lighting is a wrapped/saturating torch model (judge dungeon
   assets under a matching rig, NOT the daylight turntable board).
4. Also worth the A/B the geometry artist flagged: r5-relief ON vs OFF at VeryHigh
   — the (now-correct) baked dungeon textures may be doing most of the visible
   work; if relief adds little at proper frequency, that changes the budget.

## 4. STATE POINTERS
- **Tiers** (rollback order): remacri→terrain→doors→props→dungeons→r4
  creatures+envgeo→**r5 env-variants (terrain-FIXED)**→**r6 scenery (terrain-FIXED,
  VeryHigh-GATED)**. ACE currently serves `dat-patch-scenery/ace-r6-dats/`.
- **Branch/merge**: integ/all-20260813, FF-clean. Merge gated only on final
  sign-off now that r6 gate passed. `docs/dat-patch/MERGE-STATUS.md` is the
  live tracker; `git rev-list --left-right --count origin/master...integ/all-20260813`.
- **New tools this session**: `tools/dat-patch/DatCompress/` (compress texture
  records), `tools/dat-patch/DatRestore/` (verbatim record restore),
  `terrain_protected_rs.txt` (bake exclusion), `ac-eor-patch/patch_client.py`
  (exe patch harness).
- **Exe artifacts** (`/mnt/wbterminal2/ac-eor-patch/`): acclient.exe (pristine),
  acclient.box-4837376.exe (the 1070's build), acclient.box-PHASE2-TEST.exe
  (leak+mip16+decompress), COMPRESSION-PATCH-FINDINGS.md.
- **1070 kit**: D:\ac-dat-test has the terrain-fixed r6 + stock exe + VeryHigh INI;
  backups `.stock-bak` / `.r5-bak` / `.r4.bak`. acdt* scheduled tasks +
  acdt-shots.ps1 (screenshot tour) deployed. Box was free all session (24.5h
  idle; the one ABORT-USER-ACTIVE was a false positive).

## 5. TRAPS LEARNED TODAY (don't rediscover these)
- **Cross-lane RenderSurface collisions are the dangerous class**: terrain needs
  specific surfaces as 512² A8R8G8B8; DXT-baking lanes must exclude them
  (terrain_protected_rs.txt now enforces). Audit any new lane's RS census against it.
- **Gate at VeryHigh** — VeryLow hides terrain-composite (MergeTexture) bugs.
  Every pre-2026-08-16 gate ran VeryLow and missed this.
- **Locate exe patches by byte-signature, never address** — map/decomp/exe are
  all different builds (fault RVAs don't line up; the CopyIntoData mis-id came
  from trusting the map's addresses).
- **Verify agent/fork leads by reading** — my own "r6 content bug" and
  "CopyIntoData" calls were both wrong until disasm; the fork's MergeTexture call
  was right AND its structural proof held. Trust, but disasm-verify.
- **DRW writes taint b-tree leaves** → run texture_lane fixup before datlib reads.
- **Idle guard false-positives** from injected input mid-tour; confirm with a
  standalone idleprobe (idle climbing monotonically with wall-clock = no human).
