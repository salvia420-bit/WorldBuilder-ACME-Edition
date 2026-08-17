# G6 — client_highres.dat hunt + highres-lane inventory, 2026-08-17

## VERDICT: **NOT FOUND**

There is **no real `client_highres.dat` on this laptop or on either external
drive**. Every one of the **37** files named `client_highres.dat` across
`/home/wbterminal`, `/mnt/wbterminal1` and `/mnt/wbterminal2` is an **empty
stub** — verified by opening each with `tools/dat-patch/datlib.py`:
**b-tree root = 0, 0 records.** No other DAT on the machine holds a single one
of the 2,283 portal-absent RenderSurface ids either.

The good news: even without the file, its size, record types and per-record
dimensions are now **pinned by three independent routes that agree to within
3.6%** (§4), so the G6 lane can be scoped and priced
exactly, and the F1 "less hallucination" premise can be graded — it is **true in
direction but overstated in magnitude** (§5). Acquisition leads that verifiably
exist are in §7.

---

## 1. What was searched (all read-only)

| sweep | scope | result |
|---|---|---|
| `plocate -i client_highres.dat` (db built today 08:03, `PRUNEPATHS` = `/tmp /var/spool /media …` only — both drives fully indexed) | whole filesystem | 37 hits, all stubs |
| `find /home/wbterminal /mnt/wbterminal1 /mnt/wbterminal2 -iname '*highres*' -o -iname '*hires*'` | live re-verify of the plocate result | ran ~1 h, **stopped** before finishing `/mnt/wbterminal2` (disk thrash). Everything it flushed **exactly reproduces plocate**: all 7 `/home` + 3 `/mnt/wbterminal1` `client_highres.dat` paths, all 1,049,600-byte stubs, plus only `DerethMaps/highres*.png` and holtburger `HANDOFF-hires-*.md` docs. No new candidate anywhere. |
| `find … -type f -size +20M` and `find … -size +115M -size -150M` (the exact band a real highres dat lands in, §4) | partial — got through `/home/wbterminal` + `/mnt/wbterminal1` (528 files > 20 MB), then **aborted**: three concurrent full-tree walks were thrashing the disk. Nothing dat-shaped in the band there (rustc `.so`s, `.safetensors`, `serve/*.png`, chrome caches). **Superseded, not needed** — see note below. |
| all `*.dat` > 50 MB — **97 files**, enumerated from the plocate index | each opened with `datlib`: b-tree walked, RenderSurface count + absent-id membership test | §3 |
| install media: `*.iso *.7z *.rar *.mdf *.nrg *.cab *.msi` — **35 files on the entire filesystem** | listed, nothing extracted | **no AC install media of any kind exists on this machine.** The only `.iso`s are `/usr/lib/memtest86+/*.iso`. The largest archive is a 40 MB fandom wiki dump; the rest are Discord-attachment `.rar`/`.7z` of `acclient.exe`/IDB/PDB drops (≤ 39 MB) and three Decal-plugin `.msi`s. Nothing on the box could contain a ~127 MB dat. |
| `~/ac_base_dats` | direct listing | **has no `client_highres.dat` at all**: only `acclient.exe` (4,841,472), `client_cell_1.dat` (348,127,232), `client_local_English.dat` (1,048,576), `client_portal.dat` (926,941,184). The handoff's "ac_base_dats has only the stub" is wrong in a harmless way — there is not even a stub there. |
| buildbox `~/ac_client/` kit (retail exe + dats staged 08-11) | `ssh` attempt | **unreachable** (`136.116.76.190:22` timed out — SPOT box down / new IP). Unverified; but per `memory/fleet-runbooks.md` the kit was staged from `~/ac_base_dats`, which has no highres file, so it almost certainly has none either. |
| the 1070 Windows box | not attempted | runbook header says **"1070 offline"** as of 2026-08-17. See §7 lead 1. |

**Why the name search is sufficient and the size sweep was expendable:**
`CLCache::LoadHighResDat` finds the file by `LookFile::LookForFile(…,
"client_highres.dat", m_strDatFilePath)` (`acclient.c:293684`). A usable highres
dat *must* carry that exact filename, so a filename search is the complete
search; a differently-named 127 MiB blob would be something we produced, and we
have never produced one (every export we make is portal/cell). The plocate index
was built **today at 08:03**, both drives are indexed (`PRUNEPATHS` touches
neither), and the only writer to these trees since then is this session's
scratch — so index staleness is not a gap either. The live `find` name sweep
is belt-and-braces on top of that, and where it got to it agreed exactly.

## 2. The 37 candidates, verified by bytes

Three distinct artifacts, none with content:

| bytes | md5 | records | copies | verdict |
|---|---|---|---|---|
| 1,049,600 | `20e6ec01aa81f13b5651bdc9f9a38dbe` | **0** | 23 | stub |
| 1,049,600 | `5147d29dacc74b246cdfa5ce6341c10e` | **0** | 13 | stub |
| 400 | `a75d7d422fd00bf31208b013e74d8394` | **0** | 1 (`/mnt/wbterminal2/reexport-proj/dats/base/`) | all-zero header, not even a valid dat |

Header check on the 1,049,600-byte stubs — they are *well-formed but empty*:

```
filetype=0x00005442  blocksize=1024  filesize=1049600
dataset=0x00000001 (PORTAL_DATFILE)  subset=0x69466948 ("HiFi")  btree=0x0  recs=0
```

`subset = 0x69466948` is the magic `CLCache::LoadHighResDat` passes to
`DiskConInitInfo` (`~/ac-headers/acclient.c:293684`, `0x69466948u`), i.e. these
stubs carry the *correct* fingerprint and would be mounted happily by a retail
client — they just resolve nothing. **This is a useful identity test for any
candidate file we acquire later:** a real `client_highres.dat` must have
`dataset=1`, `subset=0x69466948`, non-zero `btree`.

They are **our own output**, not a shipped retail artifact — created by
`WorldBuilder.Terminal/HeadlessProjectManager.cs:147` `EnsureHighResDatExists()`
→ `db.BlockAllocator.InitNew(DatFileType.Portal, 1766222152)`
(1766222152 = 0x69466948), because DatReaderWriter requires all four dats to
exist. So every project/export tree that has ever been created locally carries
one, which is why there are 37.

**Specifically answering the task's question about `ace-r6-dats`:**
`/mnt/wbterminal2/dat-patch-scenery/ace-r6-dats/client_highres.dat` is the
`20e6ec01…` **stub, 0 records** — the degrade audit's claim is confirmed. Same
for `ace-r5-dats` (`dat-patch-envgeo/`) and every `export/` kit.

## 3. Coverage of the 2,283 portal-absent ids: **0**

Absent-id set extracted from `/mnt/wbterminal2/dat-patch-r7/degrade-chain-audit.json`
(union of every entry with `status == "highres-only-absent"` plus every id in
`dropped_from_retail`): **2,283 distinct ids**, of which **1,342** sit in
`FULLY-BAKED` chains (the bake-both set). The handoff's "2,284" is the count of
*chain occurrences*; 2,283 is the count of *distinct ids* — one id
(`0x0600628F`) is named by two SurfaceTextures (`0x05000ECE` + `0x05002C2E`),
which is exactly the shared-chain de-dup miss the F1 audit flagged.

Lists regenerated to `/mnt/wbterminal2/highres-hunt-scratch/absent_ids.txt`
(2,283) and `bakeboth_ids.txt` (1,342); both are two lines of Python away from
the audit JSON if the scratch is cleaned.

Coverage of that set in every candidate found:

| file | records | 0x06 RenderSurfaces | absent-id hits |
|---|---|---|---|
| all 37 `client_highres.dat` | 0 | 0 | **0 / 2,283** (empty b-tree) |
| `~/ac_base_dats/client_portal.dat` (retail) | 79,694 | 20,684 | **0 / 2,283** (full set tested) |
| `envimport-agent/test_portal.dat` | 79,694 | 20,684 | 0 / 115 |
| `hires-dist-work/client_portal_hires_repaired.dat` (1.6 GB) | 79,694 | 20,684 | 0 / 115 |
| `tranche2-proto/work/portal-t2.dat` (1.6 GB) | 79,694 | 20,684 | 0 / 115 |
| `pbr-terrain/bake/*/client_portal_hires.dat`, `ac-eor-patch/portal-*-compressed.dat` | (compressed b-tree — datlib can't walk; all derive from the same retail portal) | — | — |

Positive control on the membership test: 115 ids sampled *from the retail
portal's own* 0x06 set score **115/115** in the same code path, so a 0 is a
real absence, not a broken lookup.

The three files whose names contain "hires" are **our own upscale bakes of
`client_portal.dat`**, not the retail highres dat: identical id set
(79,694 records / 20,684 RenderSurfaces), just fatter records. **Every
portal-family dat on the machine holds exactly 20,684 RenderSurfaces — never
20,684 + 2,283.**

## 4. The real file, pinned without having it

Three independent derivations agree, which is worth more than any one alone.

**(a) From the corpus — exact size.** trevis, `#general` 2026-02-03 (dat
compression experiment):

```
Compressing client_portal.dat .. saved 463,170,560 bytes (49.97%)
Compressing client_highres.dat .. saved 64,918,528 bytes (48.75%)
Compressing client_cell_1.dat .. saved 37,662,720 bytes (10.82%)
Compressing client_local_English.dat .. saved 791,552 bytes (75.49%)
Total EOR DATs size: 1,409,286,144 bytes
```

Our three retail dats sum to 926,941,184 + 348,127,232 + 1,048,576 =
**1,276,116,992**. His EoR total minus ours =

> **client_highres.dat = 133,169,152 bytes (127.0 MiB)**

Cross-check: 64,918,528 / 133,169,152 = **48.75%**, matching his printed
percentage exactly. Our three sizes matching his total also confirms his install
is the same EoR build as `~/ac_base_dats`.

**Note for planning: the task brief's "roughly 200–300 MB" is wrong — a real
`client_highres.dat` is ~127 MiB.** That also rules out the 200–300 MB band as a
search target (nothing was there anyway).

**(b) From the portal — predicted contents.** Both retail code paths make the
highres record exactly **2× the portal record in each dimension**:

- `RenderTexture::ConstructTexture` (`acclient.c:136496`, Texture2D branch at
  `:136637`) calls `CreateTexture(entry0.width, entry0.height,
  levels = m_SourceLevels.m_num, format)` and then loads
  `m_SourceLevels[i]` into **mip level i** — and D3D mip level *i* is
  `(w>>i, h>>i)`. A 2-entry chain is therefore a 2-level mip pyramid: entry[1]
  *must* be half of entry[0].
- The older `ImgTex::GetSurfaceDID` (`:366232`) reads the same 2-entry list as a
  detail *pair*: index 0 when high detail is on, index 1 when
  `Render::ShouldDropHighDetail()` — consistent with the same 2:1 convention.
  (This is the mechanism `CommandEngine.DatBake.cs:28-38` already documents for
  `surface-texture-collapse`.)

So: read every portal-resident sibling's RenderSurface header from retail
(`u32 id, dataCategory, width, height, PixelFormat, len`, per `dats.xml:3677`),
double the dims (→ 4× `SourceData`), keep the format, add the 4-byte
`DefaultPaletteId` for INDEX16/P8, and pack at 1020 payload bytes per
1024-byte block:

> predicted **137,903,104 bytes (131.5 MiB)** for exactly those 2,283 records
> — **+3.6% vs the real 133,169,152.**

A 3.6% gap over 2,283 records is block-packing and a handful of records not
being a literal 4×.

**(c) From the corpus again — record *types*, on a real file.** trevis ran a
b-tree flag/type survey across all four EoR dats, `#utilitybelt` 2024-11-02:

```
highres, fwiw:
Flags: 00020000, 00030000, 00010000
Flag 1 Types: Iteration
Flag 2 Types: RenderSurface
Flag 3 Types: RenderSurface
```

i.e. a real `client_highres.dat` contains **RenderSurface records and nothing
else** (plus the single `FFFF0001` iteration entry) — compare his portal survey
in the same run, which lists 30+ types. Independent confirmation of the (b)
model. His portal counts in that survey (22,271 + 57,422 + 1 = **79,694**) also
match `~/ac_base_dats/client_portal.dat` exactly, so he is surveying the same
EoR build we hold and (a)'s subtraction is sound.

> **Conclusion: `client_highres.dat` holds essentially nothing but these 2,283
> RenderSurfaces, each 2× its portal sibling, same pixel format.** That is a
> strong enough model to plan and even to price the lane before we obtain the
> file.

Predicted format mix (= the portal siblings' formats), all 2,283:
**INDEX16 1,274 · DXT1 983 · R8G8B8 13 · CUSTOM_LSCAPE_ALPHA 8 ·
A8R8G8B8 3 · DXT5 2**. Over half are **paletted INDEX16** — the highres lane
needs the same palette→RGBA decode the existing 716 INDEX16→DXT bakes use, not
a straight DXT re-encode.

## 5. Grading the F1 premise: "512 sources instead of 256 = less hallucination"

**Direction: TRUE. Magnitude: OVERSTATED.**

For the 1,342 bake-both records, source resolution if we upscale from highres
instead of portal:

| highres long side | records | share |
|---|---|---|
| 16 | 1 | 0.1% |
| 32 | 10 | 0.7% |
| 64 | 92 | 6.9% |
| 128 | 263 | 19.6% |
| **256** | **714** | **53.2%** |
| 512 | 258 | 19.2% |
| 1024 | 4 | 0.3% |

Only **262 / 1,342 (19.5%)** would give us a ≥512 source. The **median highres
source is 256²**, not 512². F1's worked example (`0x0500278B`: portal
`0x06003E7E` 256² → highres `0x06003E7D` 512²) is real but it is the
**132-chain minority case** (portal sibling 256² → highres 512²); the modal case
is portal 128² → highres 256² (536 chains).

What *is* solidly true is the ratio, which is the part that matters for
upscaler artefacts — the linear upscale factor to the **same r7 output size**:

| | now (portal source) | with highres source |
|---|---|---|
| 1,322 records | **4×** | **2×** |
| 20 records | 1× (format conversion only) | **0.5×** — highres is *already larger* than our r7 output; we'd downscale, or just ship the retail highres record verbatim |

Halving the upscale factor on 1,322 of 1,342 records is a genuine
hallucination reduction (2× ESRGAN vs 4×), and the 20 outliers are free wins.
But the headline should be "**2× instead of 4×**", not "512 instead of 256".

## 6. What a highres / bake-both lane costs, exactly

| | records |
|---|---|
| distinct highres ids named by any r7 SurfaceTexture chain | **2,283** |
| ... in `FULLY-BAKED` chains → **the bake-both lane** | **1,342** |
| ... in `UNTOUCHED` chains (no lane coverage today) | 941 |
| predicted bake-both source bytes to ingest | 70,768,640 (67.5 MiB) of the 127 MiB file |

Lane attribution of the 1,342, with the highres source resolution each lane
would get (long side : count):

| lane | records | highres long-side distribution |
|---|---|---|
| texture-remacri | 499 | 32:1 64:22 128:140 **256:244** 512:92 |
| dungeons | 364 | 64:1 128:13 **256:223** 512:124 1024:3 |
| props | 183 | 32:4 64:35 128:36 **256:98** 512:9 1024:1 |
| *(pre-r7 inherited bakes, no lane png)* | 113 | 16:1 32:2 64:21 128:25 **256:64** |
| scenery | 105 | 32:1 64:11 128:34 **256:40** 512:19 |
| creatures | 43 | 32:2 128:12 **256:24** 512:5 |
| doors | 35 | 64:2 128:3 **256:21** 512:9 |
| **total** | **1,342** | |

Portal-sibling dims of the 1,342 (double them for the highres source):
128² 536 · 64² 183 · 256² 132 · 128×256 110 · 128×64 104 · 32² 86 ·
64×128 47 · 32×64 46 · 64×32 25 · 32×128 16 · … (tail of 12 more shapes).

Formats of the bake-both 1,342: **DXT1 939 · INDEX16 385 · R8G8B8 13 ·
DXT5 2 · A8R8G8B8 2**.

This matches the F1 audit's 1,342 exactly and supersedes the handoff's
"1,245 masked / 2,226 lane surfaces" figure, which came from the earlier
`audit_degrade_chain.py` pass; 1,342 is the number to plan against.

## 7. Acquisition leads that verifiably exist (nothing downloaded)

Ranked by friction. All corpus citations are real rows in
`/mnt/wbterminal2/ac-discord-archive/_indextest/ac.db`.

1. **The 1070 box's own AC install — zero download, highest confidence.**
   The 1070 (`young@100.127.215.75`) is a Windows box a person actually plays
   AC on; a stock install keeps `C:\Turbine\Asheron's Call\client_highres.dat`
   (path form confirmed by two corpus rows: trevis 2024-05-15
   `Writing C:\Turbine\Asheron's Call\client_highres.dat to …`; Super Nerd Cam
   2023-07-15 lists it among the four files to copy for a Dekarutide install).
   **Blocked right now**: `memory/fleet-runbooks.md:78` records the 1070 as
   **offline** as of 2026-08-17. When it is back: one 127 MiB read, nothing
   installed, nothing touched on the person's session.
2. **buildbox `~/ac_client/`** — long shot, unverified: SSH timed out this
   session (SPOT box down). Kit was staged from `~/ac_base_dats`, which has no
   highres file, so expect a miss — but it is a 5-second check next time the box
   is up.
3. **ACEmulator's documented install path** — `AC Support Bot` posts this in
   `#general`/`#decalinfo`/`#thwarg` on ~20 dated rows through 2026-05-13:
   "Follow the instructions to install Asheron's Call via ACEmulator —
   `https://emulator.ac/how-to-play`". This is the community-canonical full EoR
   client acquisition route and is where a full dat set (incl. highres) comes
   from.
4. **`#general` 2026-05-13 06:21, Brycter: "heres the latest dats too"** —
   `https://mega.nz/file/Q98n0BiR#p5IugPS8ZkQ7uX2A_LdN3Un2_wMX4gZBHowgs1Qomng`.
   A direct dat-set drop, 3 months old. Unknown whether the bundle includes
   highres — check with the §2 fingerprint.
5. **The ACCPP archive, posted as the answer to literally this question.**
   `#worldbuilder` 2025-12-05 04:13: petridish asks *"How do I get a copy of the
   highres .dat file on a non-windows pc"*; 04:40 Hells replies "Uhhhhh accpp
   archive prob" +
   `https://mega.nz/folder/L1MniCKJ#1dQCCFPc2ddcFILa_JGeZw/folder/7tdAhLhJ`,
   "Somewhere in there likely". (petridish: "thanks, I'll look" — no confirmation
   in the corpus that he found it, so treat as unverified.)
6. **`archive.org`** — trevis, `#pick a game` 2025-12-29:
   `http://archive.org/download/ac-updates/ac-updates.zip` (the AC patch
   archive); a separate 2026-02-18 row confirms an archive.org client download
   was working ("i downloaded the client again on sunday from there").
7. **Install media on this machine: none.** Only 35 archive/media files exist
   filesystem-wide (largest 40 MB, a fandom wiki dump; the only ISOs are
   memtest86+). No installer, no AC install tree, nothing large enough to hide a
   127 MiB dat. This route is closed locally.

Corpus caveat worth knowing before we count on a "just reinstall" path:
`#worldbuilder` 2025-12-05, paradox — *"i just copied it from the same install
i've been using since basically the beginning … i can't recall if the highres
was ever downloadable during updates"*; and Hells, `#general` 2025-03-21 —
*"i deleted userprefs and now its asking if i want to download the highres
data"*, i.e. retail fetched it **on demand from Turbine's (dead) patch
servers** behind the `ID_Option_HighResChange` prompt. So the file may not be
in every "full install" bundle — check for it explicitly (§2 fingerprint)
rather than assuming.

## 8. Recommendations for G6/G7

1. **G6 cannot complete as written** — there is no local highres dat to export
   the 1,245/1,342 sources from. Re-scope G6 to: (a) fetch the file via lead 1
   (1070, when up) or lead 3/4/5; (b) verify it with the §2 fingerprint plus a
   membership test against `absent_ids.txt` — a real one must resolve
   **2,283 / 2,283** and be ~133,169,152 bytes; (c) then bake.
2. **The lane is already fully specified without the file** (§4b, §6): 1,342
   records, ~67.5 MiB of source, known dims/formats per id. `texture_lane` work
   (highres reader + 2× rather than 4× upscale profile + INDEX16 palette path
   for 385 of them) can be written and unit-tested against synthesized 2× inputs
   *now*, so that the arrival of the dat is a data event, not a code event.
3. **Restate the pitch as "2× instead of 4× upscale on 1,322 records"** (§5),
   not "512 instead of 256". The 20 records where the retail highres record
   already exceeds our r7 output are the cheapest win in the whole lane — ship
   the retail bytes.
4. **The precedence question is still open and still blocking** portal-only
   shipping: `CLCache::LoadHighResDat` (`:293658`) mounts highres as a second
   `PORTAL_DATFILE` dataset, so which dat wins for an id present in both is a
   `LookFile`/`DBCache` search-order question that must be answered by reading
   that path (or by an A/B on a real install) before we rely on importing
   highres ids into `client_portal.dat`.
5. **Independent of all of the above**, the F1 fix stands and is cheap: collapse
   `0x05000ECE` to `[0x060045B4]`. `WorldBuilder.Terminal` already ships the
   command for it — `surface-texture-collapse` (`CommandEngine.DatBake.cs`,
   `JsonCommandProcessor.cs`), which keys on exactly this "index 0 lives in
   client_highres.dat" mechanism and refuses to write under `~/ac_base_dats`.
   Key the pipeline invariant on the *chain*, not the SurfaceTexture.

## Artifacts

- Scratch (regenerable, not committed): `/mnt/wbterminal2/highres-hunt-scratch/`
  — `absent_ids.txt` (2,283), `bakeboth_ids.txt` (1,342), `big-dats.txt`
  (97 dats > 50 MB), `media.txt` (35 archives), `probe-out.txt`, sweep listings.
- Nothing was modified, extracted, downloaded, or committed. All dat reads via
  `tools/dat-patch/datlib.py`.
