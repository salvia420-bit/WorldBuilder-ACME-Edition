# Pass 05 — Texture spec: compressed-only runtime path, tier policy, transcode placement, atlas/mip policy, CPU-mirror elimination, VRAM budgets

Pass 5 of 12. Governed by `TRACKING.md`'s protocol header. This pass fixes I3's break
(charter D-01.7: "compressed-only runtime path; preview tier is the frame-1 fallback;
no RGBA8 double-build"): the tier model (preview / full / lossy — including the inherited
P3 q75-vs-rdo call as a spec'd default), the wire-codec disposition of the three parallel
texture corpora, transcode placement (a dedicated texture worker, with the arithmetic),
the frame-1 story that replaces RGBA8-first, atlas array mip/aniso policy (the
level-0-only defect and the `__bc7Pending` no-re-feed defect), CPU-mirror elimination and
the context-loss story, and numeric VRAM/heap budgets per texture class. Source classes
per R7: **[M]** measured (this session unless a doc is named), **[D]** derived
(arithmetic shown), **[A]** assumed-pending-measurement.

Two inherited obligations are discharged here: **H-02.3** (the boot preview tier that
converts B1' ≈18 MB → ≤12 MB — D-05.2, with the arithmetic and one required correction
to pass 2's component table) and **charter H4 / survey §7** (the P3 lossy-tier default —
D-05.3, with a base-arithmetic correction to pass 2's B4 line).

## Inputs read

Opened in THIS session (file:line cited where load-bearing):

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all).
- `docs/reengineering/pass-01-requirements-charter.md` — lines 1–401 (all; D-01.2
  milestones, D-01.3 B-series, D-01.6 M-series, D-01.7 I3 disposition, H4, Q3).
- `docs/reengineering/pass-02-world-pack-format.md` — lines 1–600 (all; D-02.1 full-tier
  per-record rule, D-02.4 PVW tiering, D-02.7 TEXREF/PVW framing, D-02.8/S6.1 boot
  arithmetic, S1.1–S1.3 measured corpus, H-02.3).
- `docs/reengineering/pass-03-wire-and-fetch.md` — lines 1–646 (all; D-03.3 single fetch
  authority, D-03.4 lane T, S3 boot waves, S7 failure matrix, H-03.2).
- `docs/reengineering/pass-04-geometry-spec.md` — lines 1–607 (all; D-04.5 transferable
  bundle pattern, S6.3 B1 slack erosion, H-04.1).
- `docs/2026-08-04-xubc7-progressive-texture-plan.md` — lines 1–111 (all; measured codec
  table lines 25–30, the BC7-ingest hard constraint 37–44, P1/P2/P3, sheets location 96–98).
- `scene3d/bc7_textures.js` — lines 1–1013 (all): HBC7 contract + level-0-only array gap
  (24–56), `flagIsOff` family (101–105), `bc7Enabled` default-ON (111–132), `initBc7`/
  `bc7Available` (143–178), `parseHbc7` subarray-view chain walk (222–284), `makeBc7Texture`
  zero-copy wrap + chain-conditional minFilter (306–327), `makeBc7ArrayTexture` LEVEL-0-ONLY
  + `LinearFilter` (346–373), `writeBc7ArrayLayer` writes `levels[0]` only (381–398),
  `bc7RecordBudgetBytes` 256 MB default (498–509), `Bc7RecordSource` two-map cache +
  trim + never-evict-absent (526–604), `_begin` xu7-first + ask-don't-await transcoder
  (701–791), `upgradeMaterialToBc7` pre/full phases + `__bc7Pending` lifecycle (917–1007),
  `bc7PendingOn` (1010–1012).
- `scene3d/xu7_textures.js` — lines 1–581 (all): ~32 ms/1024² + 1.04 MB per-context
  transcoder (17–26), the bake-worker-absorbs-nothing tombstone + single-caller fact
  (27–54), `?xu7Budget` FIFO + 6 ms cap (94–140, 320–365), "(b) is a prerequisite for (a)"
  (311–318), `transcodeXu7`/`_transcodeNow` emit parseHbc7-shaped output (489–580,
  `cTFBC7_RGBA` at 537).
- `scene3d/static_atlas.js` — lines 1–400, 925–1255, 1410–1520: bucket key
  `_bucketKeyFor` w×h|stateKey|format (1097–1100), `_layerCapacityFor`/budget constants
  (926–961, 1144–1174), X7 grow-on-demand ×2 doubling (1135–1140, 1489–1495), bucket
  creation + arrays (1181–1248), `bc7AtlasShouldDefer` (1073–1075) and the deferral call
  site with NO re-feed hook — re-entry only "the next per-LB feed after eviction/re-entry"
  (1435–1460), BC7 layer write from `tex.mipmaps[0].data` (1502–1517), RGBA8 arrays with
  `generateMipmaps = true` (296–316, 327–348), `_texChannel` planes fallback (372–393).
- `scene3d/terrain_bc7.js` — lines 1–633 (all): tier table t1024 81 MB wire / 88.0 MiB
  GPU, t512 20 MB (107–110), aniso floor 16 + override rules (167–227), all-or-nothing
  channel load (333–420), synchronous level-major array assembly (444–502) invoked from
  `buildTerrainBc7Atlas` (565–612).
- `scene3d/adapter.js` — lines 1080–1200: `surfacePixelsToTexture` RGBA8 DataTexture +
  driver mipgen + aniso (1091–1139), `surfacePixelsToNormalTexture` runtime Sobel-derived
  normal pad/upload (1162–1200).
- `scene3d/materials.js` — lines 5495–5634: material built from decoded `SurfacePixels`
  then `_maybeUpgradeToBc7` post-build swap (5520, 5556–5567), clone/emissiveMap re-point
  + LRU byte-delta + RGBA8 twin dispose (5567–5634).
- `scene3d/texture_release.js` — lines 1–151 (all): `?texFreeCpu` strict `=on` (51–57),
  preconditions (a)/(b)/(c) (12–34), array/pooled exclusions (87–92), register-first
  release order (111–135).
- `scene3d/texture_rehydrate.js` — lines 1–120: registry contract, WeakRef entries,
  15 s deadline + concurrency 4 (61–70), loud-miss rule (54–59).
- `crates/holtburger-manifest/src/catalog.rs` — lines 1–120 (HBNS wire format, used to
  parse the live catalogs for this session's measurements).
- Live dist (`/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2`): parsed all three
  texture catalogs (`manifest/holtburger-tex-{bc7,bc7-pre,xu7}.bin`) with a fresh HBNS
  parser this session — full results in S1.

## Decisions

### D-05.1 — Wire codecs: XUBC7 is the only full-tier codec; previews are raw HBC7; tex-bc7 leaves the wire; the three-corpus redundancy ends

**The tier model (normative, per rsId):**

| tier | wire format | payload | delivery | consumed by |
|---|---|---|---|---|
| PVW (preview) | HBC7 (raw BC7, full mip chain), **≤128² level 0** (D-05.2) | ~21.9 KB at 128² [M] | inside PVW pack sections (pass 2 kind 0x0B), boot/ring-resident | synchronous, zero transcode — frame-1 source |
| FULL | XUBC7 KTX2 (basis scheme-6), full chain | med 242 KB lossless [M] | per-record CAS files, lane T (pass 3) | texture worker transcode → BC7 (D-05.4) |
| terrain | HBC7 arrays, t128 boot slice → t1024 full pair | 0.63 MB / 81 MB [M+D] | boot slice lane B; full pair lane T | worker-side assembly (D-05.4) |
| fallback | raw DAT records (0x08/0x05/0x06) | — | legacy per-record lane (pass 3 D-03.10) | wasm RGBA8 decode — no-BPTC GPUs + entity/palette-substituted surfaces only |

**Corpus disposition** (answers the three-parallel-tracks question):

- `tex-xu7` (3,985 records, 2,353 MB [M]) — **survives as the sole full-tier corpus**,
  re-encoded at the D-05.3 tier. It is already the more complete track (1,022 rsIds have
  xu7 but no bc7 record [M, S1]).
- `tex-bc7` (2,999 records, 2,519 MB [M]) — **retired from the wire.** It remains a
  legacy layer during migration (pass 9) and dies with the legacy dist. It is not even a
  bake input for the survivor: XUBC7 cannot ingest pre-encoded BC7 (verified constraint,
  xubc7 plan lines 37–44) — the xu7 corpus re-encodes from source PNGs regardless.
- `tex-bc7-pre` (2,893 records, 157.5 MB [M]) — **succeeded by the capped PVW pack
  payloads** (same HBC7 format, new 128² cap): measured corpus at the cap ≈ 47.7 MB
  (S1.3), ~64 MB [D] once the bake's preview-coverage invariant (D-05.5) adds the
  ~1,100 currently-preview-less rsIds.

*Rationale — where each codec wins, with the line arithmetic.* At T3 (83 KB/s) the wire
is the bottleneck by ~2 orders: a median full record (242 KB) is ~2.9 s of transfer vs
~8 ms of transcode for its 512² output (32 ms/1024² [M, xu7_textures.js:24] × ¼ area).
So the tier where bytes dominate (FULL) takes the smaller codec: xu7-lossless measured
**0.623×** the bc7 bytes over the 2,963 shared rsIds [M, S1.2] (vs zstd-over-HBC7 at
~0.75 [M, xubc7 plan line 27]). The tier where latency-to-first-pixel and zero-dependency
dominate (PVW, boot-critical) takes raw BC7: no 1.04 MB transcoder on the boot path (the
measured 15 s-class transcoder-load stall is exactly the failure `ensureXu7Transcoder`
exists for, bc7_textures.js:713–725), synchronous consumption at pack parse, and the
xu7 saving on preview-sized payloads is ~1 MB of a boot — not worth a boot-path
dependency. Terrain keeps HBC7 because its consumer is an all-or-nothing 33-layer array
with a hard uniformity contract (terrain_bc7.js:333–420) and its wire cost is already
paid once per tier, not per crossing.

*Rejected:* BC7+zstd as the full-tier codec (0.75–0.85× vs 0.623× — B4/C4 are byte-bound
at T3; and it forfeits the P3 lossy lever, which is an xu7-encoder feature);
XUBC7-everywhere including previews (boot-path transcoder dependency, above); keeping
both full corpora on the wire permanently (double bake time, the xu7-first-with-fallback
complexity in `_begin` stays forever; N5 says disk is not a metric but two live codecs
is a defect-class generator — the polarity/fallback bugs in this family's history are
the evidence).

### D-05.2 — Boot preview tier (H-02.3 discharged): PVW level-0 cap = 128²; B1 restated WITH the terrain component

**The cap:** every PVW payload's level 0 is ≤128×128 (bake derives it by mip-slicing the
full-tier chain — raw BC7 levels are sliceable without re-encode, xubc7 plan lines 73–75;
smaller textures ship their native chain; non-square textures cap the larger axis at 128).
Full chains always (mipmapped filtering stays legal — the hard rule at
bc7_textures.js:24–31). Chain-size table [D, arithmetic verified against the corpus
medians]: 128² = 21,892 B · 256² = 87,428 B · 512² = 349,572 B.

**Ring preview arithmetic** [D from pass 2's [M] ring composition]: the 11×11 ring's
preview set is 9.20 MB and commons-dominated — 46 commons textures ≥1,024 LBs carry
8.66 MB of it [M, pass 2 S1.2/D-02.4]. Capped: commons 46 × 21.9 KB = **1.01 MB**; the
non-commons remainder is 9.20 − 8.66 = 0.54 MB uncapped, so its capped size is ≤0.54 MB.
**Ring previews at the boot tier ≈ 1.3–1.6 MB** (I use 1.6). Pass 2's own estimate for
this line (~2.5 MB, S6.1) carried a "+tail" larger than the tail's uncapped total — the
2.5 was conservative slop, not arithmetic. Corroboration from this session's corpus-wide
measurement: capping the whole pre corpus reproduces 0.30× (157.5 → 47.7 MB, S1.3), and
the ring caps harder than the corpus because its bytes sit in the largest previews.

**Terrain boot slice (new component — required correction):** charter D-01.3's B1
arithmetic includes "terrain preview ≤ 2 MB" and D-01.2 defines `preview-complete` as
"every visible surface textured at preview tier or better, **terrain included**" — but
pass 2's S6.1 component table (inherited verbatim by pass 3 S8.1 and pass 4 S6.3) has
**no terrain row**.

> **SUPERSEDES pass-02 S6.1 (component table) because** the table omits the terrain
> component that the charter's B1 definition and arithmetic (D-01.2, D-01.3) require;
> at the current default that component is 81 MB (t1024) or 20 MB (t512) [M,
> terrain_bc7.js:107–110], so B1' "≤18 MB" as recorded was not a preview-complete
> number. The fix is a terrain preview tier, spec'd here.

**t128 boot slice:** 33 layers dedup to 29 unique rsIds [M, terrain_bc7.js:37–43];
29 × chain(128²) = **0.63 MB color, 1.27 MB color+nra** [D]. Derived by mip-slicing the
existing t1024 bake (levels 3.. of each payload) — no re-encode. Boot fetches the
**color slice only** (0.63 MB, lane B tail); the nra slice follows immediately after the
`preview-complete` milestone (terrain renders color-correct with `uPbrEnabled` off — the
color-only degrade path terrain_bc7.js:520–522 already defines); the t1024 full pair
streams on lane T and swaps wholesale under the existing all-or-nothing rule. t64
(0.16 MB color [D]) is the reserved emergency lever, not the default.

**B1 restated (T3, preview-complete)** [D; components inherit pass 2/4 classes]:

| component | MB |
|---|---|
| code+wasm gzip [M, charter] | 4.8 |
| manifest + index [D, pass 2 S4] | 0.5 |
| CORE (non-tex) [M+D, pass 2] | 1.0 |
| ring tile packs [D, pass 2] | 0.9 |
| META commons+regional [D, pass 2] | 1.2 |
| GEOM adder [D, pass 4 S6.3] | 1.0 |
| ring previews @128² cap [D, this pass] | 1.6 (pass-2 conservative: 2.5) |
| terrain t128 color slice [D, this pass] | 0.63 (t64 fallback: 0.16) |
| **total** | **11.6 expected · 12.6 conservative** |

**Disposition: B1 ≤12 MB is met at the expected values and breached by ≤0.6 MB at the
conservative stack.** The variance is two pinnable numbers: (a) the ring-capped preview
figure (1.6 vs 2.5 — retired by re-running pass 2's ring script with the cap function at
the first bake, pass 2 Q3's own suggestion); (b) pass 4's GEOM zstd ratio (its Q1). If
both land against us, the t64 terrain slice (−0.47) and deferring PVW-regional out of
the milestone window are the named levers. `in-world` is unaffected (≈9.4 MB [D]:
pass 3's 8.4 + GEOM 1.0 — no texture component gates it). This is the honest form R8
requires: achieved-in-expectation, with the retirement plan named, not papered.

**C4 side-effect:** the cap structurally fixes pass 2's max-preview-dungeon caveat —
interior previews become ≤21.9 KB/texture, so even a 40-texture dungeon is ≤0.9 MB of
previews ≤ C4's 2 MB [D from pass 2 S1.3 med 7 / p90 15 distinct interior textures].

*Rejected:* capping at 96² (not a mip-slice of any pow2 source — requires re-encode);
keeping quarter-res previews and adding a fourth "boot-only" corpus (two preview tiers
to bake, host, and reason about, for ~1 MB of difference vs the cap); shrinking the boot
ring (measured radius-invariant, pass 2 S1.2 — settled).

### D-05.3 — P3 lossy tier: spec'd default = **q75 no-RDO**, gated behind the pass-9 migration eye-test; B4 arithmetic corrected

**The default:** the pack-era full-tier corpus is encoded **XUBC7 `-quality 75` (no
RDO)** — measured 38.2% of raw BC7+mips on the 12-texture sample, PSNR 33–48 dB [M,
xubc7 plan lines 25–30]. Because a lossy default is a structural visual change, it ships
inside the migration eye-gate pass 9 already owes the first pack-served world (one 1070
batch, per the 1070-eyetests-batched rule; the q75-vs-rdo contact sheets at
`/mnt/wbterminal2/xubc7-proto/results/sheets/` ride the same batch). **Until that gate
passes, the corpus bakes lossless** (59.3% of raw) — the wall is explicit: this pass
cannot claim visual equivalence unseen (R8/N1), so the default is *spec'd, not
validated*, and the escape hatch is the owner's eye at the gate: clean read → q75 stands;
dirty read on painted/emblem classes → fall back to lossless, and the classifier-mixed
arm (below) becomes the follow-up.

**Base-arithmetic correction:**

> **SUPERSEDES pass-02 S6.1 (B4 line) because** it applied the of-raw-BC7 ratio (0.382)
> to the measured ring figure 83.5 MB, which is already **xu7-lossless** bytes — the
> ratios have different bases. (Charter H4's "q75 ⇒ ~30 MB" carries the same slip; the
> charter's B4 *target* is unchanged, only the projection is corrected.) Correct
> conversion: ring raw-BC7 equivalent = 83.5 / 0.623 ≈ 134 MB [D from two [M] figures];
> q75 ring = 134 × 0.382 ≈ **51 MB**; q30+rdo50 ring = 134 × 0.225 ≈ **30 MB**.

**B4 restated** [D]: converged spawn ring = B1 bytes + full-tier ring ≈ 12 + 51 ≈
**63 MB ≈ 12.6 min at T3 at q75** (lossless: ≈ 95 MB; rdo: ≈ 42 MB). **B4 ≤ 45 MB is
met only by the q30+rdo50 arm.** Trimming the converged radius does not rescue it: the
preview set is measured radius-invariant because commons dominate (pass 2 S1.2), and the
full tier shares the same rsId population, so it is expected to be commons-dominated
too [D]. Disposition: B4 carries as a tracked risk with exactly two retirement paths —
(a) the rdo arm passes the same eye-gate (then B4 ✓ at 42), or (b) an owner call relaxes
B4 toward ~65 MB (charter Q1 already contemplates relaxing B4 if 666 kbps is
unrepresentative). This pass does not pick (a) sight-unseen; that would be the
confident-guess failure R8 names.

**Reserved refinement (not v1):** classifier-mixed encode — the bake's relief classifier
already labels painted/emblem classes (xubc7 plan line 100), and the bytes live in the
upscaled 1024²+ tail (68% of corpus bytes [M, S1.4]) which is exactly the
ESRGAN-noisy content most tolerant of RDO. Encoding painted classes at q75/lossless and
upscaled-organic at q30+rdo50 projects between the two arms. No PSNR-per-class
measurement exists; it stays a designed option pending the sheets verdict.

*Rejected:* shipping q30+rdo50 as the blind default (2.5× the quality risk for the same
gate cost; the plan doc's own recommendation is preview-clean-first); lossless-forever
(forfeits the survey's "remaining big wire lever" and leaves B4 at ~95 MB); per-texture
adaptive quality decided at runtime (the encode is offline by construction).

### D-05.4 — Transcode placement: a dedicated texture worker (count 1); the budgeted main-thread FIFO becomes its fallback; terrain assembly and NRA derivation move into it

**Placement decision:** all XUBC7 → BC7 transcodes run in **one dedicated Web Worker**
(`scene3d/texture_worker.js`) owning its own basis transcoder instance (1.04 MB wasm per
JS context — the known per-context trap, xu7_textures.js:17–22; one worker = one bounded
extra copy). The worker holds **no wasm session and no fetch machinery**: pass 3's
PackFetchController remains the single fetch authority (D-03.3) and hands verified xu7
bytes over by transfer; the worker returns upload-ready BC7. This is shape (a) from
xu7_textures.js's own roadmap, built on top of shape (b) exactly as its comment requires
("(b) is a prerequisite for (a) being safe", xu7_textures.js:311–318): the budgeted FIFO
(`?xu7Budget`, 6 ms cap) is retained verbatim as the fallback arm for worker-construction
failure and for `?texWorkers=0`.

**The bottleneck arithmetic (why one worker suffices):** T3 delivers ≤83 KB/s; the worker
transcodes ~31 MB/s of *output* at the measured 32 ms/1024² rate [D: a 1024² chain is
~1.4 MB of BC7 for ~45 ms including mips]. The wire is the constraint by ~2 orders of
magnitude cold. The one regime where transcode becomes the constraint is a **warm cache**
(HTTP-cache hits arrive at disk speed — every reload re-pays transcode for the ring,
~134 MB of BC7 output ≈ 4–6 s of worker time [D]); that is off-main-thread and does not
gate any budget (B5 is network-only), but it is the number that would justify a second
worker — pass 10 measures queue depth on a warm 1070 boot before anyone adds one
(`?texWorkers=N` is the measurement escape). Offline-transcode-to-BC7-wire is rejected as
the default: it pays 1.61× bytes (1/0.623) on the tier where bytes are the binding
resource, and kills the D-05.3 lossy lever (RDO is an xu7-encoder feature; no measured
RDO-BC7+zstd figures exist to argue otherwise).

**Message contract** (composes pass 3's controller with pass 4's one-transferable
pattern; normative shape in S3): jobs in with one transferred `ArrayBuffer`, results out
with one transferred `ArrayBuffer` of concatenated levels + a small descriptor; the main
thread reconstructs the exact `parseHbc7` output shape as subarray views, so every
downstream consumer (`makeBc7Texture`, array layer writes) stays codec-blind — the
contract `transcodeXu7` already established (xu7_textures.js:489–495).

**Two more jobs move into the worker:**
- **Terrain array assembly.** `buildTerrainBc7Array`'s level-major concatenation — 88 MiB
  of alloc+memcpy for the t1024 pair — currently runs synchronously in one main-thread
  task at ring-resolve (read-verified, terrain_bc7.js:444–502 called from 565–612). It
  becomes a worker job (`kind: "terrain-assemble"`): 29 payloads in, one
  level-offset-descriptored buffer per array out, transferred. Main thread does zero
  copies; upload scheduling is pass 8's.
- **NRA derivation** (`kind: "nra-derive"`) — see D-05.5's normal-source decision.

*Rejected:* the bake worker as host (read-verified to contain zero bc7/xu7 code — its
whole import graph produces RGBA8 SurfacePixels and stops, xu7_textures.js:30–41; adding
transcode there couples texture throughput to bake jobs AND to pass 6's single-vs-dual
wasm decision — the texture worker is deliberately wasm-free and topology-neutral);
main-thread-budgeted as the permanent default (the 6 ms cap bounds the batch, not the
item — one 1024² is still a ~32 ms main-thread task, a standing F5/F6 tail tax);
N workers cold (the wire can't feed one).

### D-05.5 — Frame-1 story: materials are BORN compressed from the resident preview; the RGBA8 double-build is deleted; the normal source moves to worker derivation

**The new build path** (replaces RGBA8-first, adapter.js:1091–1139 +
materials.js:5520/5556): at material-build time —

1. **Surface metadata decodes without pixels.** The wasm surface decode grows a
   scalars-only form (translucency/luminosity/diffuse/palette flags, no pixel planes) —
   the scalar fields materials.js:5495–5504 consumes. Pixel decode simply does not run
   for BPTC-capable clients.
2. **Albedo = preview, synchronously.** The rsId's PVW payload is read from the resident
   PVW pack (packs for the ring are resident before materials build — pass 3 S1.4's
   guarantee) via a sync export (`pvw_blocks(rsId)`-shaped), parsed by `parseHbc7`,
   wrapped by `makeBc7Texture` (full chain ⇒ mips + aniso legal from frame 1). **Frame 1
   is retail texels at preview sharpness — never white, never RGBA8.**
3. **Full-tier upgrade** rides lane T → texture worker → the existing swap machinery
   (`upgradeMaterialToBc7`'s full phase and materials.js's clone/emissiveMap re-point +
   LRU delta, read-verified 5567–5634), minus the pre phase and minus the RGBA8 twin
   disposal (there is no twin). Lane-T request order: current tile's TEXREF set by
   Chebyshev tile distance, then ring; full tier is fetched only for tiles inside the
   ring (the B4 population).
4. **Preview coverage is a bake invariant:** every TEXREF'd rsId MUST have a PVW row
   (pass 2's `--verify-closure` extends to it). A missing preview at runtime is pass 3
   deploy skew — loud, placeholder material per its S7 matrix — never a silent RGBA8
   fallback. (Today's corpus needs the invariant: 2,893 previews vs 3,985 xu7 records
   [M]; the bake fills the gap by slicing/encoding previews for all.)

**BC7-incapable GPU (charter Q3):** `bc7Available()` (bc7_textures.js:174–178) stays the
gate. False ⇒ the client rides the **legacy per-record lane wholesale for textures**:
raw 0x06 records + wasm RGBA8 decode, today's path, catalogs-on-demand — correct,
slower, and banner'd as degraded. Raw texture records are deliberately NOT packed
(970.6 MB corpus [M, pass 2 S1.1] for a shrinking client class). SwiftShader/T2 is
measured BPTC-present (bc7_textures.js:59–64), so T2 rides the compressed path; the
fallback exists for real GPUs without `EXT_texture_compression_bptc`. Population data:
none exists — open question Q5.

**The normal-map problem (load-bearing, previously unnamed):** today's singleton
`normalMap` and the atlas NRA layers are derived at runtime from the *decoded RGBA8
pixels* (Sobel-from-luminance, adapter.js:1162–1200; atlas packs from planes,
static_atlas.js:372–393). Compressed-only deletes that source; doing nothing would
silently flatten shading (an N1 violation invisible to metrics). Decision: the texture
worker derives it — a `want.nra` flag on the transcode job makes the worker also
transcode level 0 (or level 1 = half res, the default) to RGBA32 (`cTFRGBA32` — the same
transcoder emits it), run the Sobel + channel pack in-worker, and return an RGBA8 NRA
plane alongside the BC7 chain. Half-res default [A]: normals at half the albedo res are
standard practice and quarter the plane bytes; the parity eye-check rides the migration
gate. The **offline nra corpus** (per-rsId BC7 nra records, the terrain arm's
derive-nra pipeline generalized — the survey's ~113 MB resident lever) is the designed
successor, reserved via a TEXREF tier bit (S2), not v1: it adds a second full-tier wire
corpus (~0.25× albedo bytes at half res [A]) and B4 cannot absorb it before the D-05.3
question settles. texchan roughness/AO sidecars are untouched v1 (fail-soft attach,
materials.js:5505) — folding them into the nra story is recorded as residue (Q7).

**What this deletes** (I3 ledger, anchors read this session): the RGBA8 decode+upload
first pass per surface (adapter.js:1091–1139 as the default albedo path); driver mipgen
double-work; the pre-record fetch phase and `__bc7Pre` machinery (preview now arrives
with the material, not by race); the RGBA8-twin dispose dance in the upgrade re-point;
the `_bc7Asked`/`__bc7Pending` race *as a boot-scale phenomenon* (a verdict-pending
material no longer exists at build time — the marker survives only for the full-tier
upgrade in-flight state, consumed by D-05.6's re-feed).

### D-05.6 — Atlas & array policy: full mip chains + aniso everywhere; preview-commit with re-home on upgrade (the `__bc7Pending` re-feed fix); growth step 1.5×; NRA arrays stay RGBA8 in v1

1. **Full mip chains in every bucket array.** `makeBc7ArrayTexture` allocates the
   complete halving chain and `writeBc7ArrayLayer` writes every level (the two sites the
   level-0-only defect names, bc7_textures.js:346–373/381–398 — the data is already in
   hand: statics records carry full chains, header 36–46, and the worker emits full
   chains). `minFilter = LinearMipmapLinearFilter`, aniso = the adapter preset value
   (same as singletons — closing the measured singleton-vs-atlas quality asymmetry,
   header 48–56). RGBA8 buckets already mip (`generateMipmaps = true`,
   static_atlas.js:311–313) — only the compressed allocator was the gap. **Cost is
   priced, not hand-waved:** +⅓ on compressed array bytes, GPU and CPU-staging both,
   inside the S7 budgets. The old blocker ("~1/3 VRAM on a page that OOMs near
   2,800 MB") is dissolved by arithmetic, not bravado: the OOM was heap, and the
   compressed-only path removes ~1 GB-class RGBA8 mirrors while this fix adds ~30 MB-class
   mip bytes at BC7 8 bpp under X7's allocated≈used discipline [D, S7]. Justification is
   memory/quality/stall — explicitly NOT an fps claim (walls: GPU theories on a
   CPU-bound frame).
2. **Bucket identity comes from TEXREF, not from whatever `mat.map` holds.** The bucket
   key keeps its `(w×h | stateKey | format)` shape (static_atlas.js:1097–1100) but w×h is
   the **full-tier dims declared in the pack's TEXREF row** (S2 adds a dims byte),
   known before any payload arrives. This makes bucket identity stable across the
   preview→full upgrade and kills the 2026-08-05 P1 class (node committed into a bucket
   keyed at preview dims and stuck there, static_atlas.js:1442–1457) structurally.
3. **The re-feed fix — preview-commit + re-home.** Today a `__bc7Pending` node is passed
   through with NO re-feed hook: it re-enters a bucket only when its LB evicts and
   re-streams (read-verified comment, static_atlas.js:1435–1440), which held 79% of props
   out as unbatched singletons [M, survey §2]. New contract:
   - A node whose full tier is not yet resident commits **immediately** into a bucket
     keyed at its **preview** dims (correct pixels, soft) — batched from frame 1;
   - `upgradeMaterialToBc7`'s full-phase swap calls a new `atlasRefeed(rsId)` hook: every
     member node of that rsId **re-homes** — geometry deleted from the preview-dim bucket
     (recycled-layer + optimize machinery exists), re-committed into the TEXREF-keyed
     full bucket with the full layer written. Empty preview buckets are torn down
     (new empty-bucket GC on the optimize pass).
   - Escape: `?atlasPreviewCommit=off` restores hold-out-until-full (the deferral path,
     now WITH the re-feed hook so nothing can stick). Re-home churn is bounded by the
     existing 6 ms-class build budgets (scheduling is pass 8's); it is a structural
     render change and rides the migration eye-gate (pass 9).
4. **Growth step ×1.5, not ×2.** `_atlasGrowTargetFor` doubles (static_atlas.js:
   1135–1140), which violates M6 (allocated ≤1.5× used) at the step. New step:
   `min(capacity, max(needed, ceil(alloc × 1.5)))` — one-line change, M6-compliant by
   construction, log-bounded growth count preserved.
5. **NRA arrays stay RGBA8 DataArrayTextures in v1**, fed by the worker-derived planes
   (D-05.5). The BC7-nra succession (encode offline, `CompressedArrayTexture` twin —
   the ~113 MB resident lever, survey §7) is reserved behind the same TEXREF tier bit as
   the offline nra corpus; it cannot exist before that corpus does (there is no runtime
   BC7 encoder, and there never will be one in this client).
6. **Terrain arrays are already correct** (full chains mandatory, aniso floor 16 at
   t1024 — terrain_bc7.js:57–66, 167–227) and keep their policy verbatim; only assembly
   placement (D-05.4) and mirror policy (D-05.7) change. The t128 boot slice builds the
   same 33-layer array shape at 128² (~0.9 MiB GPU both arrays [D]) and is wholesale-
   swapped, never level-patched (incomplete-texture rules).

*Rejected:* two-array buckets (preview array + full array with a per-layer readiness
bit) — elegant, saves the re-home churn, but adds a second sampler + per-layer state to
the atlas shader for a transient window whose cost is bounded and measurable; revisit
only if pass 10 attributes real churn cost to re-homing. Writing preview levels into the
full-dim array's lower mip slots — dead on arrival: levels 0–1 would be undefined
storage sampled at close range (not even black). Skipping mips on arrays "because the
frame is CPU-bound" — the defect is quality (shimmer/moire on tiling surfaces at
distance, the file's own diagnosis) and VRAM discipline, not fps.

### D-05.7 — CPU-mirror elimination: rehydrate v3 (source-keyed, async); per-class mirror policy; the texFreeCpu seam generalizes

The context-loss constraint is unchanged and non-negotiable (M4's hard rider: releasing
a mirror without a re-supply path is a permanently black world — 08-05 §10 via charter;
7 losses/session measured). The seam already built for it is kept and generalized:
`texture_rehydrate.js`'s registry (WeakRef entries, register-first ordering, 15 s
deadline, concurrency 4, loud-miss — read-verified 1–120) + `texture_release.js`'s
release arming. **v3 change: rehydrators are keyed by SOURCE, not by decoded-pixel
plane**, because on the compressed path the way back is not "re-decode SurfacePixels":

| texture class | CPU mirror policy | rehydrator (async, worker-routed) |
|---|---|---|
| terrain arrays (t128 + t1024 pair) | **freed post-upload** (−88 MiB heap at t1024 [M-derived]) | re-fetch payloads (immutable HTTP cache) → worker re-assemble → re-upload |
| full-tier singleton `CompressedTexture` | mirror ≡ the record-cache entry (shared buffer, zero-copy — bc7_textures.js:511–524); freed **with** record eviction via the release seam | re-fetch xu7 CAS file → worker re-transcode |
| preview textures | tiny (≤21.9 KB each); mirror kept | re-read from resident PVW pack (sync, trivially) |
| atlas/pool arrays (diffuse + nra) | **staging copy kept** — it is what `addLayerUpdate` re-uploads layers from and what X7 grow re-uploads; excluded from release by construction (texture_release.js:87–92 already enforces) | the staging copy IS the restore source (three's normal restore path) |
| entity/legacy RGBA8 | today's rules (planes + release v2 preconditions) | existing plane-based rehydrate |

Consequences:
- **The 256 MB record budget tightens to 128 MB** (`?bc7RecordsMB` default). Its sizing
  rationale is obsolete on two counts read this session: eviction no longer risks "a
  ~32 ms main-thread transcode" (bc7_textures.js:493–497) — re-transcode is worker-side —
  and freeing a record now CAN free texture bytes (the release seam nulls the shared
  buffer's texture refs and registers the rehydrator, instead of the old
  "evicting frees nothing while the texture lives" dead end).
- **xu7 source bytes are transient**: dropped after transcode (re-supply = HTTP cache).
  Rust holds no full-tier texture bytes at all — the Rust/JS split per pass 3's topology
  is: **Rust/PackStore = records + PVW preview payloads (pack-resident, pass 6's
  budgets); JS = transcoded BC7 artifacts + array staging; worker = nothing resident but
  the 1.04 MB transcoder.**
- **M4 census** [D]: atlas staging ~90 MB class (BC7 albedo ¼ of the RGBA8-era 123 MB
  occupied + RGBA8 nra + ×1.33 mips, under X7 discipline) + full-tier mirrors ≤128 MB
  (budget-enforced) + previews ~10 MB + entity residue ~30 MB class + terrain 0 =
  **~260 MB worst, ~220 typical vs M4 ≤250** — met in expectation, with the record
  budget as the enforcement knob if the census reads high. The 1,332→863 MB RGBA8-era
  mirror mountain is gone by construction, not by tuning.

### D-05.8 — VRAM budget mechanics: numeric per-class allocated-byte budgets; eviction is tier-demotion, never blackness

No direct WebGL2 VRAM instrument exists (charter D-01.6), so budgets bind on
**allocated-byte estimates** (`bc7TextureBytes`/`estimateTextureBytes`-family sums, all
mip levels) with M5 (zero context losses / 30-min ultra) and M6 (allocated ≤1.5× used)
as the observable proxies. Normative texture-class budgets (T1):

| class | allocated budget | enforcement |
|---|---|---|
| terrain arrays | ≤96 MiB (t1024 pair measured 88.0 [M]; +t128 slice ~0.9) | fixed-shape allocation; allocated=used by construction |
| atlas/pool bucket arrays, diffuse+nra, mips included | ≤256 MiB total | per-bucket 32 MiB budget (kept) + ×1.5 growth (D-05.6.4) + X7 ceilings; global sum published on `__atlasStats` |
| full-tier singletons + previews | ≤192 MiB | record budget (128 MB) + matBudget LRU; **eviction demotes the material's map back to its preview** (resident in-pack) instead of disposing to nothing — pressure costs sharpness, never correctness |
| entity/legacy RGBA8 | ≤64 MiB | existing matBudget machinery |
| **texture-class total** | **≈610 MiB [D/A]** | pass 10 validates via M5/M6 observation on the 30-min ultra route |

The demotion mechanism is the new primitive this budget buys: because previews are
permanently pack-resident (a few tens of MB corpus-wide, S1.3), every full-tier texture
has a legal cheap fallback at all times — the VRAM governor can shed ~⅞ of a texture's
bytes (full 512²+ chain → 128² chain) without a fetch, a decode, or a black frame. Pass 6
owns wiring demotion into its eviction machinery (H-05.1); this pass fixes the contract:
**demote before dispose; dispose only with the owning tile's residency.**

All figures state allocated vs used per D-01.2; nothing here is an fps claim (R5).

## Spec

### S1 — Measurements (this session, live dist)

Parsed all three texture catalogs with a fresh HBNS parser (format per catalog.rs:14–51;
CRC/trailing-magic verified). Populations agree with pass 2 S1.1 exactly.

**S1.1 Corpus stats** [M]:

| track | n | total MB | mean | med | p90 | p99 | max |
|---|---|---|---|---|---|---|---|
| tex-bc7-pre | 2,893 | 157.5 | 54.5 KB | 21.9 KB | 87.4 KB | 349.6 KB | 1.40 MB |
| tex-xu7 | 3,985 | 2,353.2 | 590 KB | 242 KB | 1.35 MB | 3.97 MB | 15.7 MB |
| tex-bc7 | 2,999 | 2,518.6 | 840 KB | 349.6 KB | 1.40 MB | 5.59 MB | 22.4 MB |

**S1.2 xu7 : bc7 ratio** [M]: 2,963 shared rsIds; xu7 1,568.5 MB vs bc7 2,518.1 MB =
**0.623×**. 1,022 rsIds are xu7-only; 36 bc7-only.

**S1.3 Dims census + cap arithmetic** [M]: byte-exact square-chain matching (chain(s) =
20 + Σ 16·⌈s/2ⁱ/4⌉²) identifies preview level-0 dims {32²:178, 64²:353, 128²:1016,
256²:389, 512²:191, 1024²:5} + 761 non-square/other; full-tier bc7 dims {…512²:1016,
1024²:389, 2048²:191, 4096²:5} + 816 other — each preview is exactly quarter-res of its
full (the two censuses map 1:1). **Capping every preview at chain(128²): corpus 157.5 →
47.7 MB (0.303×).** With bake-invariant coverage of the ~1,100 preview-less rsIds:
projected capped preview corpus ≈ 64 MB [D].

**S1.4 Where the full-tier bytes live** [M]: 1024²+ records are 585 of 2,999 but
~1,724 MB of 2,519 (**68% of bytes**) — the ESRGAN-upscaled tail; ≤512² records +
non-square are the remaining ~795 MB.

**S1.5 Chain-size table** [D, verified against corpus medians and the derive-ledger
examples in bc7_textures.js:40–46]: 64² = 5,508 B · 128² = 21,892 B · 256² = 87,428 B ·
512² = 349,572 B · 1024² = 1,398,148 B · 2048² = 5,592,452 B.

### S2 — TEXREF and PVW (pass 2 slot internals, now fixed)

**TEXREF row (kind 0x0A), 8 B — fills pass 2 D-02.7's reserved byte:**

```
rs_id u32 | tier_bits u8 | pvw_pack_ord u16 | dims u8
  tier_bits: bit0 PVW present (MUST be 1 — bake invariant D-05.5.4)
             bit1 FULL xu7 present
             bit2 full tier is lossy (q75-family) — diagnostic/labeling
             bit3 offline NRA record present (RESERVED, 0 in v1)
             bit4 texchan sidecar present
             bits5–7 reserved 0
  dims: (log2(full_w) << 4) | log2(full_h)   — bucket keying + budget planning
        (covers 1..32768; non-square exact)
```

**PVW payload (kind 0x0B):** HBC7 v1 container, unchanged parser (`parseHbc7`), level-0
cap 128 per D-05.2, full chain mandatory. Partition per pass 2 D-02.4 (PVW-COMMONS ≥1,024
LBs; PVW-REGIONAL by supergrid; interior previews in interior packs).

**Full tier:** per-record CAS files, XUBC7 KTX2, immutable+identity headers (pass 3 S6.1
row already covers them; the KTX2-compression-allowlist rule — never transport-compress —
carries over from the plan doc lines 80–86).

**Terrain:** `terrain-bc7-v2` manifest shape unchanged; adds the t128 slice as a
first-class tier directory (same manifest schema, `tier: "t128"`, sliced not re-encoded);
the tier ladder at boot is t128-color → t128-nra → t1024 pair (D-05.2), fetched through
the pass 3 controller (lane B slice, lane T full), retiring this module's private
`fetch()` calls.

### S3 — Texture worker contract (normative)

One worker, `scene3d/texture_worker.js`, no wasm session, own transcoder instance.

```
main → worker:
  {type:"init", transcoderBaseUrl}
  {type:"job", seq, kind:"xu7", rsId, bytes:ArrayBuffer,          // transfer [bytes]
     want:{nra:"half"|"full"|null}}
  {type:"job", seq, kind:"terrain-assemble", tier, layerRs:[33],
     payloads:[{rs, bytes:ArrayBuffer}…]}                          // transfer all
  {type:"cancel", seq}                                             // evicted pre-run

worker → main:
  {type:"result", seq, ok:true, kind,
     width, height, levelBytes:[u32…],        // level-major sizes
     bc7:ArrayBuffer,                          // ALL levels concatenated — transfer
     nra?: {width, height, plane:ArrayBuffer}} // RGBA8 packed N.xy/rough/AO — transfer
  {type:"result", seq, ok:false, err}          // caller falls back per its matrix
```

Rules: FIFO, one job at a time; a `result` is exactly one transferable payload buffer
(+ optional nra plane) — the pass 4 descriptor-plus-one-buffer pattern; main-side
reconstruction produces the `parseHbc7` shape via subarray views (zero further copies);
`terrain-assemble` returns one buffer per array with level offsets derivable from
`levelBytes` — the exact `mipmaps[]` layout `buildTerrainBc7Array` produces today
(terrain_bc7.js:427–439 layout contract). Failure of the worker itself (construction or
crash) arms the main-thread budgeted FIFO fallback (`?xu7Budget` machinery, retained).
Flags: `?texWorkers=0|1|N` (default 1; 0 = fallback arm; N>1 measurement-only), explicit
values, `flagIsOff` family semantics.

### S4 — Frame-1 build path and upgrade scheduling (normative sequence)

```
material build (sync, main or bake-worker feed):
  meta   = fetch_surface_meta(did)            // scalars only — NO pixel decode
  pvw    = pvw_blocks(rsId)                   // resident PVW pack, sync
  map    = makeBc7Texture(parseHbc7(pvw))     // mips+aniso legal, frame-1 correct
  mat    = _materialFromFlags(meta…, map)     // unchanged material machinery
  nra    = pending (worker-derived, attaches async — fail-soft flat until then)
  atlas  = commits NOW at preview dims (D-05.6.3)

upgrade (async, lane T):
  controller.needTexture(rsId)                // pass 3 lane T, sub-cap 4
  → verified xu7 bytes → worker job {kind:"xu7", want:{nra:"half"}}
  → swap full map (existing re-point machinery) + attach/refresh nra plane
  → atlasRefeed(rsId)                         // re-home members to the full bucket
  → drop xu7 source bytes; record cache holds the BC7 output (128 MB budget)

pressure (pass 6 residency event):
  demote: mat.map → preview texture (pack-resident, sync) ; full BC7 freed
  dispose: only with tile residency
```

No-BPTC clients skip steps 2–3 entirely and ride the legacy per-record lane (D-05.5).
Upload timing of the swapped textures (`compressedTexImage2D`/`…SubImage3D` cost) is
pass 8's budget; this pass guarantees only that payloads arrive upload-ready and
off-thread.

### S5 — Array/mip/aniso policy summary (normative)

| texture | format | mips | aniso | CPU staging |
|---|---|---|---|---|
| singleton albedo (preview + full) | BC7 sRGB | full chain always | preset value | = record cache entry |
| atlas diffuse buckets | BC7 sRGB `CompressedArrayTexture` | **full chain (fix)** | preset value **(fix)** | kept (layer writes + grow) |
| atlas nra buckets | RGBA8 linear (v1) → BC7 reserved | driver mipgen (today) | preset | kept |
| terrain color/nra arrays | BC7 sRGB/linear | full chain (already) | floor 16 at t1024 (already) | **freed** (rehydrate v3) |
| entity/legacy | RGBA8 | driver mipgen | preset | plane-based v2 rules |

Level-0-only compressed allocations become illegal in this codebase: `makeBc7ArrayTexture`
asserts chain-complete input post-fix; the `LinearFilter`-because-incomplete branch
survives only as a loud diagnostic path.

### S6 — Budget traceability

- **B1** — restated at 11.6 expected / 12.6 conservative with the terrain component
  included (D-05.2 table): **≤12 met in expectation**; variance retirement = ring
  re-score + GEOM ratio (named tasks); hard levers = t64 slice, PVW-regional deferral.
- **B4** — corrected base: q75 ⇒ ≈63 MB (12.6 min T3); ≤45 only via the rdo arm or an
  owner relaxation (D-05.3). Tracked risk, two named retirement paths.
- **C2/C5** — unchanged: previews ride tile-pack crossings at pass 2's measured
  0.11/0.56 MB columns (the cap only shrinks them); full tier is lane-T background by
  construction and cannot displace crossing fetches (pass 3 lane discipline).
- **C4** — ✓ structurally at the cap (≤0.9 MB previews for a 40-texture dungeon [D]);
  pass 2's max-preview caveat closes.
- **F5/F6 (tail)** — the two named main-thread stall sources on this path are removed
  structurally: xu7 transcode leaves the main thread (D-05.4); the 88 MiB terrain
  assembly task leaves the main thread (D-05.4). No fps prediction is made (R5); pass 10
  measures via the stall probe's buckets.
- **M4** — ≈220–260 MB census [D] vs ≤250: met in expectation, record budget is the
  knob (D-05.7). **M5** — texture-class allocation capped ≈610 MiB + demotion primitive;
  validated only by the 30-min ultra observation (pass 10). **M6** — growth step ×1.5
  (D-05.6.4) + X7 ceilings + fixed-shape terrain make every array compliant by
  construction.

### S7 — Deletion ledger (with evidence anchors read this session)

| deleted | anchor |
|---|---|
| RGBA8-first albedo decode+upload per surface (the I3 double-build) | adapter.js:1091–1139; materials.js:5520 |
| pre-record race phase + `__bc7Pre` + pre-vs-full atlas hole class | bc7_textures.js:947–999; static_atlas.js:1442–1457 |
| xu7-first-with-hbc7-fallback fetch chain (`_begin` tryXu7) | bc7_textures.js:701–791 (one codec per tier ends the fallback lattice) |
| main-thread transcode as the default arm (FIFO demoted to fallback) | xu7_textures.js:320–365, 502–512 |
| 88 MiB synchronous terrain assembly task | terrain_bc7.js:444–502 |
| `__bc7Pending` hold-out with no re-feed (79% of props unbatched) | static_atlas.js:1435–1460; survey §2 |
| level-0-only compressed arrays (`LinearFilter`, no aniso) | bc7_textures.js:346–373, 381–398 |
| tex-bc7 as a wire corpus (2,519 MB) + its catalog | S1; pass 9 stages retirement |
| terrain_bc7 private `fetch()` path (moves under the pass 3 controller) | terrain_bc7.js:285–331 |
| 256 MB record budget rationale ("eviction costs a main-thread transcode") | bc7_textures.js:479–509 → 128 MB, worker-era rationale |

### S8 — Diag hooks required (full spec is pass 10's)

`__bc7Stats`/`__xu7Stats` merge into `__texStats()`: `{tiers: {pvwHits, fullSwaps,
demotions}, worker: {jobs, msTranscode, queueDepth, maxQueueDepth, fallbackArm},
mirrors: {byClass bytes}, arrays: {alloc, used, mipBytes}, rehydrate: (existing
textureRehydrateStats), coverage: {texrefMissingPvw — MUST stay 0}}`. The atlas re-feed
adds `refeeds, rehomedNodes, emptyBucketsGCd` to `__atlasStats`.

## Handoffs to later passes

- **H-05.1 (→ pass 6):** Residency integration: the demote-before-dispose contract
  (D-05.8) as an eviction primitive; PVW pack payloads as permanently-ring-resident
  Rust bytes (their budget line in M3's pack accounting); the 128 MB record-cache and
  192/256/96/64 MiB class budgets are proposed defaults pass 6 may rebalance inside the
  M-series ceilings; refcount keys: full-tier textures refcount by rsId across
  materials/clones/atlas layers (the existing layerOf refcount shape generalizes).
- **H-05.2 (→ pass 7):** Bucket arrays (full-chain BC7 + RGBA8 nra, TEXREF-keyed dims)
  are the material-key substrate the pool design consumes; the re-feed/re-home events
  (D-05.6.3) must map onto pool membership transitions; whether pools subsume the atlas
  wholesale is pass 7's call — the layer/array contracts here are pool-agnostic.
- **H-05.3 (→ pass 8):** Upload scheduling: swapped full-tier textures, re-homed array
  layers (`addLayerUpdate` batches), and the terrain t128→t1024 wholesale swap all need
  upload budgets; the worker's result cadence is pass 8's to throttle (the queue is
  cancellable by `seq`).
- **H-05.4 (→ pass 9):** Migration + gates: (1) corpus re-encode sequencing (lossless
  first, q75 flip after the sheets+1070 gate — D-05.3); (2) the preview-commit atlas
  change and the worker-derived NRA parity are named structural render changes riding
  the first pack-world eye-gate; (3) tex-bc7/tex-bc7-pre layer retirement criteria;
  (4) doc-propagation duty: bc7_textures.js's header (level-0-only note), url-flags rows,
  and the texFreeCpu preconditions all describe the superseded world and must be
  rewritten the day the fixes land (walls: verdicts must reach the files agents read).
- **H-05.5 (→ pass 10):** Measurements this pass owes its [A]/[D] labels: (a) ring
  preview re-score with the cap function (B1 variance retirement — pass 2 Q3's script
  shape); (b) worker transcode throughput + warm-boot queue depth on the 1070
  (`?texWorkers` arm count); (c) M4/M5 census on the six-town + 30-min ultra routes
  against the S7 class budgets; (d) the `texrefMissingPvw = 0` coverage gate in CI;
  (e) NRA half-res parity screenshots into the 1070 batch.
- **H-05.6 (→ pass 11):** Attack surface flagged deliberately: the two SUPERSEDES blocks
  (pass 2 terrain omission, pass 2/charter B4 base slip) should be re-verified
  independently; B1's 11.6-vs-12.6 spread; the ~610 MiB VRAM class total's [A]
  components; the assumption that full-tier bytes are commons-dominated like previews
  (asserted [D], unmeasured).

## Self-check

- **Walls — scale confusion:** every figure states its population (corpus vs ring vs
  column; wire vs GPU vs CPU-staging vs allocated; lossless-base vs raw-BC7-base is the
  subject of an explicit correction, D-05.3). PASS.
- **Walls — draws×µs / draw-count proxy:** the one draw-adjacent claim (79% held out →
  preview-commit) is argued as correctness/structure with cost bounded and gated, not as
  a predicted frame-time win. No draw arithmetic anywhere. PASS.
- **Walls — GPU theories on a CPU-bound frame:** mips/aniso/array fixes are justified on
  quality + memory + stall grounds with explicit fps-claim disclaimers (D-05.6.1, S6
  F-row). PASS.
- **Walls — parked-vs-moving / boot variance:** no frame or boot timing claimed
  measured; all minutes are bandwidth arithmetic labeled [D]; validation routed to
  pass 10. PASS.
- **Walls — allocated≠used:** M6 enforced structurally (growth ×1.5, fixed-shape
  terrain, X7 ceilings); budgets state allocated explicitly. PASS.
- **Walls — flag-bit≠predicate:** new flags (`?texWorkers`, `?atlasPreviewCommit`)
  spec'd with explicit-value semantics on the shared `flagIsOff` family — the polarity
  bug class this exact file family already paid for (bc7_textures.js:90–105). PASS.
- **R1:** read order followed. Two contradictions of prior passes carry explicit
  SUPERSEDES blocks with evidence (terrain component omission; B4 ratio-base slip) —
  both are corrections the earlier passes' own [M] figures force, not re-derivations.
  All other decisions refine handoffs addressed to this pass (H-02.3, H-03.2, H-04.1,
  charter H4/Q3). PASS.
- **R2:** residency budgets/eviction wiring (6), pool succession (7), upload scheduling
  (8), migration staging/gates (9), bench mechanics (10) all deferred with proposed
  defaults. PASS.
- **R3:** writes = this file + own TRACKING.md row. Measurement scripts in the session
  scratchpad only. PASS.
- **R4:** every current-code claim carries file:line opened THIS session (see Inputs
  read); the wasm-crate trap not triggered (no `crates/holtburger-web` claims; wasm
  export changes are spec'd as requirements, not described as existing); dist facts
  measured directly with a fresh catalog parser, agreeing with pass 2's counts; the
  level-0-only, no-re-feed, 256 MB-budget, 32 ms, 88 MiB, and aniso-floor claims all
  re-verified at their lines rather than quoted. PASS.
- **R6:** six sections in order; decisions numbered with rationale + rejected
  alternatives. PASS.
- **R7:** concrete formats (TEXREF byte layout, worker message contract, chain-size
  table), numeric budgets with class labels, named module seams. PASS.
- **R8:** the q75 default is explicitly spec'd-not-validated with the eye-gate named;
  B4's miss is stated, not massaged; B1's spread is stated with retirement tasks;
  no-BPTC population, warm-boot worker throughput, NRA parity, and the
  commons-domination assumption for full tiers are declared open. PASS.

## Open questions

- **Q1 — Ring-capped preview figure (1.6 vs 2.5 MB).** B1's expected-vs-conservative
  spread hangs on it. Retire: re-run the pass 2 ring script with the cap function at the
  first bake prototype (pass 2 Q3 sized this at ~5 minutes once the script exists again).
  [Owner: first bake task / pass 10.]
- **Q2 — The q75 eye-gate and the B4 owner call.** q75 stands or falls at the sheets +
  1070 batch (D-05.3); if it stands, B4 still needs either the rdo arm passing the same
  gate or a target relaxation to ~65 MB. Owner decision required either way. [Owner:
  redmi, next 1070 batch.]
- **Q3 — Worker-derived NRA parity.** Half-res Sobel-from-transcoded-albedo vs today's
  full-res Sobel-from-decoded-RGBA8: expected visually equivalent-or-close, never
  eye-tested. Rides the migration gate; the offline nra corpus (with its B4 cost) is the
  designed successor if parity reads poor. [Owner: 1070 batch + pass 9 gate.]
- **Q4 — Warm-boot transcode throughput.** The one regime where one worker may be the
  bottleneck (~4–6 s of worker time for a ring [D]). Measure queue depth on a warm 1070
  boot before considering `?texWorkers=2`. [Owner: pass 10.]
- **Q5 — No-BPTC population.** The legacy-lane fallback tier is spec'd but no data
  exists on how many real clients lack `EXT_texture_compression_bptc`. If it is
  effectively zero, the fallback can be a boot banner + reduced support tier rather than
  a maintained path. [Owner call.]
- **Q6 — Preview derivation for the 761 non-square and 1,022 xu7-only records.**
  Mip-slicing covers the square HBC7 class; xu7-only records need a decode→slice→encode
  step at bake (encoder exists offline). The coverage invariant (`texrefMissingPvw = 0`)
  will surface any straggler; the bake work item must handle both classes. [Owner: bake
  implementation.]
- **Q7 — texchan sidecars (5,475 files).** Untouched in v1 (fail-soft attach). Folding
  roughness/AO into the offline nra corpus (Q3's successor) would retire the sidecar
  fetch class entirely — record when that corpus is sized. [Owner: nra-corpus work item.]
