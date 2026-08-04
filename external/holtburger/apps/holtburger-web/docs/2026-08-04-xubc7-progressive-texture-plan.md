# Texture wire-size plan — XUBC7 + progressive delivery (2026-08-04)

**The metric:** first-visit cold load and new-area streaming at player bandwidth
(~666 kbps ≈ 83 KB/s ≈ 5 MB/min). A fresh dungeon touching ~40 unique
RenderSurfaces is ~33 MB of `tex-bc7` payloads today (mean 820 KB/record,
2,999 records, 2.4 GB corpus) — **~6.5 minutes of streaming**. Everything below
is ranked against that number. Frame-rate is explicitly NOT the metric: the BC7
track already removed CPU decode, and the 07-31 1070 numbers (63.6 ms at 3,031
draw calls) say fps lives in draw-call land, not texture land.

## What already shipped this session (P0)

- `?terrainBc7` default-ON at t512 (20 MB atlas vs ~40 MB of CC0 PNGs; 1070
  look-pass QUEUED in `harness/vistest-1070-round1-7.mjs` arms F/G/H).
- `scripts/serve.py` Accept-Encoding gzip (zstd-ready): cold boot code+data
  **14.6 MB → 4.8 MB** (wasm 5.5→1.9 MB, 261-module JS graph 8.4→2.8 MB).
  ~176 s → ~58 s at 666 kbps, before any codec work.

## Measured XUBC7 numbers (basisu v2.50.0 master `9bebe167`, 2026-07-22)

12-texture representative sample from the real corpus
(`/mnt/wbterminal2/xubc7-proto/results/`, full logs + ktx2 there). Totals,
as fraction of the 55.07 MB raw BC7+mips sample:

| codec | bytes | % of raw | notes |
|---|---|---|---|
| zstd -19 of shipped .hbc7 | 41.28 MB | 75.0% | ≈ what serve.py gzip gets in flight |
| **XUBC7 lossless** | 32.64 MB | **59.3%** | beats zstd on EVERY texture; base-encode quality ±0.9 dB vs shipped bc7enc_rdo |
| XUBC7 `-quality 75` | 21.02 MB | 38.2% | PSNR 33–48 dB; no-RDO |
| XUBC7 `-quality 30 -xubc7_rdo_level 50` | 12.37 MB | 22.5% | ~1.1–3.4 bpp content-dependent |

Decode (single-threaded C++, proxy for wasm): ~32 ms/1024², ~0.5 s for a 4096²
full chain; format carries 8 stripes so threaded transcode scales ~linearly.
Prebuilt **1.04 MB** wasm transcoder with XUBC7→BC7 support is committed
upstream (`webgl/transcoder/build/basis_transcoder.wasm`).

**Hard constraint discovered:** XUBC7 **cannot ingest pre-encoded BC7**
(`xbc7::pack_image` takes RGBA only; BC7-DDS input errors out — verified in
source and CLI). Adoption = re-encode from the source PNGs
(`coverage100/` + `statics-x1/x4-output/`) and accept its bc7f base blocks.
Lossless-mode self-validation round-trips every block byte-exactly
(`basisu_xbc7_encode.cpp:3570`), and measured PSNR is within ±0.9 dB of the
shipped encodes (sometimes better) — but the on-GPU bytes DO change, so the
switch rides a 1070 batch, it doesn't skip one.

Caveats: our lossless bitrate runs 5.2–6.6 bpp (README claims 3.5–5.6 —
ESRGAN-upscaled content is noisy). KTX2 output uses an unregistered
supercompression scheme (basis-transcoder-only) — treat payloads as opaque
records in our shard store, never as interchange KTX2. `-xubc7` with no
`-quality` IS lossless; there is no "default lossy". 121/2950 ledger rows have
dims mismatched vs their hbc7 (downscale outliers) — re-encode driver must
size from the hbc7, not the ledger.

## P1 — progressive two-record delivery (no codec change, biggest UX win)

Level 0 is ~75% of every mipped payload; the client can't sample anything
until the whole record lands. Split each record into TWO self-contained HBC7
containers — **zero parser changes**, `parseHbc7` already handles both:

- `holtburger/tex-bc7-pre` — "preview": level 2 of the original as ITS level 0
  (quarter res) + the rest of the chain. ~6% of the record's bytes. Complete
  mip chain ⇒ mipmapped filtering stays legal.
- `holtburger/tex-bc7` — unchanged full record.

Client (`bc7_textures.js` / `Bc7RecordSource`): fetch preview first, build the
`CompressedTexture`, hand it out; fetch full at lower priority and SWAP the
texture on arrival (new texture + material.map swap + dispose old — never
in-place level surgery, incomplete-texture rules). A dungeon becomes
*texturally complete but soft* at ~2 MB instead of textureless until 33 MB,
then sharpens. Duplicated small-mip bytes ≈ +6% total wire — accepted.
Same trick applies to the terrain t512 atlas payloads at boot.

Bake side: `dat-shard` gains `--tex-bc7-preview <dir>` (or derives previews
from the full hbc7 by slicing blocks — the chain is raw BC7, sliceable without
re-encoding). Ordering INSIDE a container stays level-0-first (v2 unchanged).

## P2 — XUBC7 lossless as the payload codec (wire 75% → 59%)

New namespace `holtburger/tex-xu7` (+ `-pre`), payload = raw `.basis`/KTX2
bytes; decode in the bake worker via the 1.04 MB transcoder wasm → BC7 blocks
→ existing upload path. serve.py must ship these **identity** (already
zstd inside — add the ext to the incompressible list). Corpus re-encode from
source PNGs (~1–2 h on this box at -j3, or buildbox). Keep `tex-bc7` shards
during transition; flag `?texXu7` exact-match opt-in until the 1070 confirms
the new base blocks, then default-flip with `=off` escape per house rules.

## P3 — the lossy tier (wire → 38% or 22.5%)

The payoff tier for the cold-load metric: the 6.5-min dungeon at q75 ≈ 2.5 min,
at rdo-1.5bpp ≈ 1.5 min (≈ 45 s / 27 s with P1 preview-first on top).
DECISION NEEDED (eye, not math): q75 no-RDO vs q30+rdo50 — contact sheets for
the 12 sample textures are in
`/mnt/wbterminal2/xubc7-proto/results/sheets/` (source | lossless | q75 |
rdo1.5 crops); queue the call into the next 1070 batch alongside arms F/G/H.
Recommendation: ship the lossy tier as the DEFAULT streamed tier only if the
sheets + 1070 pass read clean on painted/emblem surfaces (the relief
classifier's painted classes are where 25–35 dB hurts); otherwise lossless
(59%) is already free of any quality question.

## Order of operations

1. ~~serve.py gzip~~ ✅  2. ~~terrainBc7 default~~ ✅
3. P1 preview records (bake + client swap) — pure win, no adjudication.
4. P3 lossy-vs-lossless call at the next 1070 session (sheets ready).
5. P2/P3 corpus re-encode at the chosen setting(s) + client transcoder in the
   bake worker. One container/namespace rev absorbs P1+P2+P3.
