# HANDOFF — texture pipeline overhaul (session 2026-08-04)

**Read this with:** `apps/holtburger-web/docs/2026-08-04-xubc7-progressive-texture-plan.md`
(the phased XUBC7/progressive plan) and
`apps/holtburger-web/docs/2026-08-04-tranche2-paletted-upscale-prototype.md` (the
paletted spec). This doc is the session state + the ordered TODO to finish the job.

**The metric driving everything:** cold load / new-area streaming at ~666 kbps
(~5 MB/min). Fresh dungeon ≈ 33 MB of tex-bc7 today ≈ 6.5 min. NOT an fps
program — fps is draw-call-bound (63.6 ms @ 3,031 calls, 07-31).

## 1. SHIPPED THIS SESSION (committed with this doc)

- **`?terrainBc7` DEFAULT-ON at t512** (was exact-match opt-in). Validated both
  directions live (BC7 boot: 33 layers/10 mips/0 errors/built color+nra; `=off`
  boot: CC0 26 layers applied). Tier order now t512-first (cold-load call: 20 MB
  vs 78 MB). CC0 arm intact as escape. 1070 look-pass QUEUED not waived —
  arms F/G/H + `__terrainBc7Stats` probe added to
  `apps/holtburger-web/harness/vistest-1070-round1-7.mjs`.
- **serve.py Accept-Encoding gzip** (zstd-ready; box has no zstd module — loud
  startup warn). Cold boot code+data 14.6→4.8 MB (~3×). Range/304/--check
  verified intact. TODO tail: if proxy.cjs fronts tunnel runs it must forward
  Accept-Encoding un-buffered; JS minify would add ~2.5-3× on top (measured,
  recommendation only).

## 2. DECIDED (user calls, do not relitigate)

- **Upscaler for statics corpus: Remacri** (4x_foolhardy_Remacri). UltraSharp
  noted "safer" (no crosshatch hallucination) — kept as terrain candidate only.
- **Terrain: per-layer HAND-PICK across all 4 models** (29 tiles baked ×4 in
  the corpus run) — do NOT auto-pick; Remacri hallucinates crosshatch on grass.
  **RESOLVED 2026-08-04 (user call, supersedes the above): Remacri for ALL 29
  layers.** Decided after reviewing the 4-way sheets AND a 3×3 full-res tiled
  macro test of 0x06006D49 (remacri vs ultrasharp vs source) on the phone —
  no tiling/grid artifact; UltraSharp judged "a bit plain". The ×4 corpus and
  sheets remain on disk if any layer needs revisiting after the 1070 pass.
- **XUBC7 lossy tier is promising**: user could not distinguish source vs
  lossless vs q75 vs 1.5bpp-RDO sheets on phone. Motion/tiling verdict still
  needs the 1070. Add a q20/rdo60 probe to find the visible floor.
- **Paletted (Tranche 2) mechanism: GO** — user confirmed quantized column
  indistinguishable from pre-quant. All 5 gates passed (see §5).
- Diffusion upscalers (SUPIR etc.): rejected on provenance, permanently.
- **SUSPECT-TILED verdict (user, 2026-08-04): EXCLUDE ALL 32** (19 statics +
  13 tranche1; the ledger split is `phase` for statics/terrain but `batch` for
  tranche1 — key on both). Outputs moved to
  /mnt/wbterminal2/upscale-corpus/quarantine-suspect-tiled/ (with
  EXCLUDED-rsids.txt); those textures ship at retail res. Shippable remainder:
  2,931 statics + 1,054 tranche1.
- **Statics spot-check (user, 2026-08-04): PASS** — 20 stratified + 3 lowest-
  PSNR samples reviewed on phone ("remacri looks great"); corpus cleared for
  relief re-derive + encode.

## 3. IN FLIGHT AT SESSION CLOSE — collect first

**L4 corpus run — PREEMPTED MID-RUN AT SESSION CLOSE, needs restart+collect.**
Instance `l4-corpus` (us-central1-a, spot) was preempted by GCE at
2026-08-04T20:03Z (its SECOND preemption) and sits TERMINATED — zero billing,
**outputs safe on its disk, NOT yet pulled back**
(/mnt/wbterminal2/upscale-corpus/ is empty). State at preemption: statics
(Remacri, 2,950) deep in progress with 0 failures; terrain ×4 models and the
chained tranche1 batch (1,067 entity PNGs, verified on the disk) possibly not
yet run. RECOVERY (first thing next session):
1. `gcloud compute instances start l4-corpus --zone us-central1-a` (spot —
   retry/zone-hop if stocked out; snapshot+recreate pattern in §6 if the zone
   is dead: the disk carries checkpoints, deps, inputs, driver, outputs).
2. SSH in, re-launch the driver the same way (it is RESUME-SAFE: skips
   outputs that exist and pass the 4× dims check). Let it finish statics →
   terrain ×4 → tranche1.
3. tar+sha256 `out/` + `corpus-ledger.jsonl` + `run.log`, scp to
   /mnt/wbterminal2/upscale-corpus/, verify checksum, THEN
   `gcloud compute instances stop l4-corpus --zone us-central1-a` and verify
   TERMINATED. Do not leave it running unattended — preemption does the
   stopping for you but a healthy run does not.
4. Review ledger: **any `SUSPECT-TILED` rows** (small-texture 1→16 tiling,
   the user's explicit worry) **must be reviewed and excluded/redone, never
   shipped silently**; also PSNR outliers.
Inputs (both sha256'd, also already ON the instance disk):
/mnt/wbterminal2/upscale-bakeoff/corpus-inputs.tgz +
/mnt/wbterminal2/tranche1-src/tranche1-inputs.tgz.

Also still running locally: test-dist server on :8768 (tranche2 boot test,
orphan setsid — kill freely), live serve on :8765 (OLD pre-gzip process — a
restart picks up the committed compression).

## 4. THE ORDERED REMAINING PROCESS

1. **Collect corpus** (§3). Spot-check ~20 outputs vs sources; review ledger
   PSNR outliers + SUSPECT-TILED.
2. **Terrain hand-pick**: 29 tiles × {x4plus, remacri, ultrasharp, hat-l} in
   `out/terrain-*/` — build per-tile 4-way sheets, taildrop to redmi
   (`tailscale file cp ... redmi-note-13-5g:`), user picks per layer. Then
   re-bake terrain_bc7 t512/t1024 packs from winners (pipeline:
   /mnt/wbterminal2/terrain-bc7-agent/ scripts; nra derives from albedo —
   Sobel/luminance per that repo's derivation, water layers stay flat).
3. **Relief/nra re-derive for statics**: heights are seam+pillow from albedo
   (NOT DeepBump — it lost the eval, HANDOFF-relief-v2). Re-run the
   height_seam.rs derivation over the new Remacri albedo; classifier v2 tables
   are baked into wasm via include_str — table edits need a wasm rebuild.
4. **XUBC7 encode — the exact recipe** (binomialLLC/basis_universal, master
   commit `9bebe16726b3a61c8c213eeee3b7cffb462ef34e` = v2.50.0; built binary
   already at /mnt/wbterminal2/xubc7-proto/basis_universal/bin/basisu; build
   recipe: uv-installed cmake, Release+SSE4.1, `cmake --build . -j2`):
   - LOSSLESS: `basisu -xubc7 -mipmap -stats -output_file out.ktx2 in.png`
     (no -quality == lossless; there is NO default lossy).
   - Lossy tiers: `-quality 75` (38% of raw) and `-quality 30 -xubc7_rdo_level 50`
     (~22.5%); ADD `-quality 20 -xubc7_rdo_level 60` probe per §2.
   - **XUBC7 CANNOT ingest pre-encoded BC7** (RGBA input only — verified in
     source + CLI). Encode FROM the new Remacri PNGs. Its lossless mode
     self-validates block-exact; base-encode quality ±0.9 dB vs bc7enc_rdo.
   - Container: KTX2 with UNREGISTERED supercompression scheme 6 — treat as
     opaque payload bytes in our shard store, never interchange KTX2.
   - Corpus bitrates measured on our art: lossless ~59% of raw, q75 38%,
     rdo1.5 22.5% (12-sample matrix: /mnt/wbterminal2/xubc7-proto/results/).
   - Wire note: serve XUBC7 payloads identity (already Zstd inside). serve.py
     compresses by opt-in allowlist — unknown exts are identity by omission,
     so the rule is NEVER add the XUBC7 ext to `BIN_COMPRESS_EXTS` (there is
     no "incompressible list"; the no-cache ext list naming `.ktx2` is a
     different, cache-control-only list).
5. **Client integration (P1+P2 of the plan doc, one container/namespace rev)**:
   - P1 preview-first: two self-contained HBC7 records per texture
     (`holtburger/tex-bc7-pre` = quarter-res level0 + chain ≈ 6% of bytes;
     full record unchanged) — ZERO parser changes, swap texture on full
     arrival. Dungeon usable at ~2 MB instead of 33.
   - P2 XUBC7: prebuilt wasm transcoder is 1.04 MB
     (`webgl/transcoder/build/basis_transcoder.wasm`, has XUBC7→BC7 +
     `isXUBC7()`); integrate in the bake worker (remember: worker holds its
     own wasm — staleness trap) + main thread. New namespace `holtburger/tex-xu7`.
     `?texXu7` exact-match opt-in until 1070-confirmed, then default+escape.
   - Decode cost: ~32 ms/1024² ST native; stripes=8 in payloads for threading.
6. **Tranche 1 records** (entity/item plain-RGB): corpus run returns
   `out/tranche1-remacri/`. Encode (bc7cli or XUBC7 per timing of step 5) →
   `dat-shard --tex-bc7` ingest → rebake dist. NO client work: MaterialCache
   `_maybeUpgradeToBc7` fires for entities already; palette-composed surfaces
   already excluded via rsId=0. Candidates list:
   /mnt/wbterminal2/upscale-bakeoff/entity-plain-rgb-candidates.json (1,067).
7. **Tranche 2 batch** (1,189 paletted): prototype FULLY PASSED (§5). Batch =
   Remacri ×4 → `t2quant.py` constrained quantizer (in
   /mnt/wbterminal2/tranche2-proto/) → 4× INDEX16 records → inject via the
   t2tool (DatReaderWriter + the two write-bug workarounds, §5) → rebake.
   Apply the 512² output cap and ENABLE the A15 decode-admission budgets
   (already in the client, currently "unbounded/inert" — this is the VRAM
   lever; today's baseline: 142.6 MB entity RGBA at spawn, 746 textures).
   Spec gate revision (accepted): structural-zero + color-delta budget, NOT
   the <1% index floor (Remacri de-dithers AC's hand-dither — 8-72% same-range
   adjacent-entry churn is EXPECTED and harmless; NN-control roundtrips exact).
8. **One batched 1070 session** validates everything: vistest arms A-H (incl.
   terrainBc7 F/G/H), the new Remacri art in motion, XUBC7 lossy tier choice,
   tranche 1+2 spot checks. Batch it — do not drip.
9. **Then flip defaults** per house rules (bare-default loads+spawns+0 errors;
   escapes documented in url-flags.md; run scripts/audit-flag-defaults.mjs).

## 4b. RELIEF SANITY PASS (2026-08-05, step-3 verification — PASSED with a 1070 note)

Statics heights derive AT RUNTIME (height_seam.rs via wasm; no offline bake),
so the Remacri albedo automatically re-derives relief. Offline seam-operator
comparison over 15 old-vs-new pairs (script in session scratchpad; operator =
gfx-material-agent relief_op.op_seam): median height-field corr 0.774, NO
polarity inversions. **FINDING for arm E: Remacri sharpening makes the seam
operator carve CONSISTENTLY DEEPER — carve fraction often 1.5–3x the x4plus
albedo's (e.g. 0x06006784: 24.7%→67.1%).** Structurally sane, but the 1070
statPom arm should specifically judge whether statics relief now reads as
over-carved; if so the lever is the seam GROOVE_MIN/FULL thresholds (wasm
tables — rebuild required), not the art.

## 5. TRANCHE 2 PROTOTYPE RESULTS (all gates passed — evidence)

/mnt/wbterminal2/tranche2-proto/: 20 samples (ranges proven via ClothingTable/
LSD/CharGen), quantizer unit-tests 3/3, ZERO range-boundary / clip-sentinel /
hard-bleed violations across all samples × all real dye variants, NN-control
exact 20/20. Live boot (gate 4): Bak'tshay Servant rendered 1024² + 512×1024
composed textures from injected records, 0 errors (@create 44025; test dist
/mnt/wbterminal2/tranche2-testdist). Sheets user-approved. **DatReaderWriter
write bugs found** (report + workarounds in the t2tool, work dir):
(1) ReserveBlockCore assumes contiguous free region — pre-grow the dat copy
with a real contiguous free region first; (2) DatBTreeNode.Pack writes
0xCDCDCDCD in leaf branch slot[0] — zero all CD branch slots after writing
(the known b-tree bug, now with a proven workaround). Consider upstreaming.

## 5b. TRANCHE 2 BATCH SHIPPED (2026-08-05) + THE REAL DatReaderWriter WORKAROUNDS

Batch complete: 1,138 records (1,189 minus 51 CAP-SKIPPED 512px sources — no
gain under the 512² output cap; revisit with the A15 budgets). ZERO structural
violations (range/sentinel) across all quantizations; NN-controls exact.
256px sources mode-pooled 1024→512 in INDEX space post-quantize (emit_records
CAP logic; quantizer geometry untouched). Injected into a portal copy →
byte-verify 1,138/1,138 → diff-dat: 78,556 same / 1,138 diff / 0 missing →
dist `holtburger-dist-hires-bc7m-xu7t2` (all texture namespaces) → live boot
0 errors. **The §5 workarounds, now actually understood and tooled**
(tranche2-proto/pregrow.py + cdfix.py — use BOTH for any future injection):
(1) DRW's ReserveBlockCore does NOT walk the retail free chain — it assumes a
CONTIGUOUS free region (`FirstFreeBlock += BlockSize` per pop; decompiled
v2.1.2). Pre-grow = append zeroed blocks at EOF and point the header AT THAT
REGION ONLY (FirstFree=old EOF, count=N), abandoning the retail chain values.
Linking a chain corrupts; small injections only survive by luck.
(2) DRW leaves 0xCDCDCDCD in leaf-node branch slot[0]; DRW's reader tolerates
it but holtburger-dat recurses into it ("failed to fill whole buffer" at
DatOpen). cdfix.py walks the tree and zeroes tainted leaf branch slots
(182 leaves this batch). Upstream both to chorizite/DatReaderWriter.

## 6. KEY NUMBERS / PATHS

| thing | where |
|---|---|
| corpus outputs (pending) | /mnt/wbterminal2/upscale-corpus/ |
| bake-off metrics+sheets (Remacri verdict) | /mnt/wbterminal2/upscale-bakeoff/results/ |
| XUBC7 matrix + built basisu | /mnt/wbterminal2/xubc7-proto/ |
| tranche2 prototype (quantizer, records, sheets) | /mnt/wbterminal2/tranche2-proto/ |
| tranche1 inputs (1,067 entity PNGs) | /mnt/wbterminal2/tranche1-src/ |
| full texture export (20,684 PNGs, pristine DAT) | /mnt/wbterminal2/tranche1-src/raw/ |
| shipped hbc7 payloads (2,999) | /mnt/wbterminal2/pbr-terrain/bc7/blocks-mip/ |
| population math | 5,530 surveyed; 2,950 hires-covered; uncovered = 1,067 plain-RGB (>32px) + 1,189 paletted (>32px) + 562 tiny (retail-res by policy) + carve-outs |
| L4 recipe | spot g2-standard-8, image family pytorch-2-9-cu129-ubuntu-2404-nvidia-580; US zones stock out often — europe-west4-b worked; quota 1/region; Remacri ~0.57 s/img |

## 7. TRAPS RE-CONFIRMED THIS SESSION

`?nosw=1` on every dev URL · dist symlinks lie (curl the manifest, don't trust
--check alone) · ledger `in` paths are x4 OUTPUTS not sources (retail sources
live in stage-in/x4-input/tex dirs; 121 rows have mismatched dims — size from
the source file) · spot L4s vanish regionally (snapshot+recreate pattern works)
· `pip` doesn't exist on the laptop (uv does) · agents' visual verdicts need
your own eyes (Remacri grass crosshatch was undersold as "striking detail").
