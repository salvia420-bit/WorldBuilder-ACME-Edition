# Phase-4 fill — RESULTS (2026-08-20, corrected 2026-08-20 EOD after the in-client gate)

> **This file supersedes the same-day version committed at 3d153372.** That
> version described a kit whose highres CRASHED the retail client at
> char-select (deterministic 0xC0000005, fault offset 0x420a0 =
> SurfaceWindow::LegacyBlit) and claimed "99.5 % of 20,684 records" — a number
> inflated by 13,794 UI-consumed surfaces that can never ship re-encoded. The
> post-mortem and the corrected, gate-green kit are below.

## What the crash taught us: reachability, not size, decides safety

The client consumes 0x06 RenderSurfaces on two disjoint paths:

- **GPU 3D pipeline** (via an 0x05 SurfaceTexture): DXT and upscales are fine.
- **CPU 2D blit** (`SurfaceWindow::LegacyBlit`): icons, char-gen portraits,
  banners, splash/loading art, UI backgrounds. Cannot decode DXT; overruns on
  resized records. Any re-encoded record on this path = instant AV the moment
  the UI touches it (char-select is the first heavy consumer).

Two same-day crashes, same signature:
1. The tier C+D fill DXT-encoded 12,664 A8R8G8B8 **icons** (diagnosed earlier
   today; icons dropped).
2. The "world" tier was classified **by size** (≥128² ⇒ world). That let 493
   large UI surfaces through — 320x480 char-gen portraits, 1128x80 banners,
   1200x600 backgrounds, 2000x68 bars — all DXT1-converted. World-only dat,
   identical crash.

**The fix — `tools/dat-patch/surftex_reach.py`:** a fill record ships only if
it is referenced by some 0x05 SurfaceTexture in the retail portal (scan of all
7,221 SurfaceTextures → 9,494 reachable 0x06 ids), or is in the retail EoR
highres id set (Turbine shipped those highres; retail mounts that dat
natively — r8 ≡ that lineage and gated clean). Cross-check: the 622 image ids
referenced by all 101 retail UI layouts (WBT ui-pack-export) intersect the
kept set in **0 records**. This gate is now mandatory for every future
highres fill (it exits nonzero on any unsafe record).

The 493 were cut by reconstruction (no b-tree deletes): `DatCompact --exclude`
(new flag; the seed-only check refuses a seed carrying an excluded id, and
--verify treats an excluded id in the output as a mismatch).

## The r9 dats, final and GATE-GREEN

| | r8 | r9 | delta |
|---|---|---|---|
| client_portal.dat | 556,033,024 | **556,084,224** | +51,200 (statics-tranche straggler 0x010040E9, 228->912 tris, validate.py green) |
| client_highres.dat | 967,217,152 (4,706 recs) | **1,332,324,352 (9,081 recs)** | +4,375 texture records, DatCompact-dense |
| client_cell_1.dat | 347,298,304 | 347,298,304 | byte-identical |

**Coverage (honest):** 9,081 of the 9,494 3D-pipeline-reachable retail 0x06
records (95.7 %) ship upgraded — every world surface the GPU path can consume,
minus the 13 terrain-protected refusals and a small tiny-record tail. The
other ~11,200 retail 0x06 records are CPU-blitted UI (icons, portraits,
splash): they **cannot** ship re-encoded at all, and uncompressed upgrades
would cost ~810 MB for the least world-visible class. They are out of scope,
not "remaining".

Gates on the final artifacts, all PASS:
- walk_check: highres entries=9,082 free=35 OK; portal entries=81,206 free=16 OK.
- oversize: 0 records >2048 on either side.
- DatCompact --verify: 9,082/9,082 byte-identical, excluded-id leak check clean.
- surftex_reach.py: NOT_SAFE=0 on the shipped highres.
- Palette-route inserts readback-verified byte-identical (3,122 world fill).
- Colour ledger (baked-sample): lumRatio median 1.1540, castDrift p99 0.058, PASS.
- Tranche validate.py on the portal: 1/1 models OK, physDrift 0.0.
- Patcher-table gate (check_ps1_table.py): PASS at kit assembly.
- **1070 in-client gate (2026-08-20 20:33): GREEN.** DDD accepted, survived
  char-select (both prior crashing dats died in ≤20 s at the same offset),
  entered the world at ~2 min (`tailnet1 … entered the world`, ACE log),
  rendered stably to the full 420 s watcher lifetime, 21 shots, no exit.
  In-world captures show the upscaled surfaces live.

## What landed this session (unchanged from the earlier report)

1. **Recovery of the crashed landing** — DatCompact rebuild, remaining 2,110
   palette records inserted compressed, the 5 failed 4096-side DXT records
   root-caused (DRW 5 MB pack buffer) and re-shipped at 2048; WBT hardened to
   write >4.5 MB records through a right-sized buffer.
2. **Tier C+D icons (13,301 records)** — baked, landed, then **withdrawn**:
   DXT icons CPU-blit and crash (post-mortem above). Bakes parked on the box.
3. **World fill** — 1,746 DXT + 3,122 palette records landed; **493 of the DXT
   set withdrawn** by the reachability gate (UI art misclassified as world by
   the size tier). Net new world records this session: 4,375.
4. **Statics-tranche completion** — the one straggler built and landed
   portal-side.
5. **4.P2 band-object lane: clean negative.** 4.P1 verified already shipped in
   r7.1.

## Phase-4 items remaining

- **4.P3 env-variant re-cut** — staged portal-lineage session
  (PREP-envgeo-recut-lineage-2026-08-20.md).
- **4.P4 creature subdiv** — POC 9/9 invariants green; in-client eye-test
  still owed (needs the scratch portal staged on box+ACE plus a second
  chat-capable client to @create — session-sized, deferred).
- **4.H2 detail textures** — shipped to scratch, needs landing + gate.
- **4.H4 selective 4096²** — yellow, view-distance input missing.
- **4.H3 terrain-2x** — red (TexMerge VmSize AV, twice).

## Kit

Assembled from the gated artifacts (portal + highres + cell + patcher +
loud-fail gate), packaged as .tgz and .zip (patcher-table gate PASS):

```
/mnt/wbterminal2/dat-patch-r9/kit-r9b/
(sha256 in kit-manifest.txt and the .sha256 files alongside the archives)
client_portal.dat   sha256 03569ce401eb414ee2c8fd6f75dfca08c4543ad94d69817454d7e565df6404bb
client_highres.dat  sha256 c68fb07925244956d70d3fc742694e95d489b9b60c1809f609658310524e0b65
client_cell_1.dat   sha256 2eaf2a84f4f8b4e54b9304a41631647b234cd2303b38084151b3fff826c8dda6
```

The crashing 2026-08-20 morning kit (acme-r9 at /mnt/wbterminal2/dat-patch-r9/kit/,
highres fcf31a12…) is SUPERSEDED and must not be distributed; same for the
earlier A+B-only kit (kit-superseded-ab-only/).
