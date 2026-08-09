# Pass 02 — World pack format: closure packs, spatial index, shared-asset packs, content addressing, versioning

Pass 2 of 12. Governed by `TRACKING.md`'s protocol header. W1 core: the binary format that
replaces per-record HTTP addressing (I1's break, charter D-01.7). This pass defines the pack
partition, the container layout, the spatial index, the dedup/sharing split, content
addressing and patching, and the bake CLI that emits it — grounded in byte statistics
measured against the live dist this session. Source classes per R7: **[M]** measured this
session, **[D]** derived (arithmetic shown), **[A]** assumed-pending-measurement.

All measurements were produced by scripts run this session against the live dist
(`/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2`, the target of the `dist` symlink,
bake of 2026-08-05 per its `manifest.json` `generated_at`); scripts parsed the real HBNS
catalogs, real shard bytes, and real side-tree files. Scale labels per charter D-01.2.

## Inputs read

Opened in THIS session (file:line cited where load-bearing):

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all).
- `docs/reengineering/pass-01-requirements-charter.md` — lines 1–401 (all; budgets B1–B5,
  C1–C5, M-series; handoff H1 authorizes this pass to restate B1/C2 with arithmetic).
- `apps/holtburger-tools/src/dat_shard.rs` — lines 1–1372 (all but tail tests):
  `compute_boot_keep_set` (724–762), `write_boot_pack` (852–898), `write_shards_v2`
  (944–981), `shard_bundle_v2` (1099–1227), `ingest_tex_bc7_dir` (431–506), HBC7 container
  (124–139, 325–399), truncated-sha16 shard naming (903–924, 956–967).
- `apps/holtburger-tools/src/bin/dat-shard.rs` — lines 1–273 (all): CLI surface
  (`--input/--eor-*/--tex-*/--boot-landblock/--manifest-version/--output/--verify-boot-reachability`).
- `crates/holtburger-manifest/src/catalog.rs` — lines 1–362: HBNS wire format (header 16 B,
  ULEB128 delta entries ~19 B, CRC32+`SNBH` footer, docs at 14–51).
- `crates/holtburger-manifest/src/v2.rs` — lines 1–310: ManifestV2 fields (190–234), URL
  templates (167–180), `catalog_version` (204–208).
- `crates/holtburger-manifest/src/lib.rs` — lines 1–140: v1 schema, `format_shard_key`.
- `crates/holtburger-dat/src/archive.rs` — lines 1–260: HBA v2 header (29–35), 60-byte
  entry (`HBA_ENTRY_SIZE = RESOURCE_NAMESPACE_LEN + 28`, line 24; entry struct 60–70),
  per-entry zstd flag (73–74), namespace-span two-stage lookup (183–211).
- `crates/holtburger-dat/src/walk.rs` — lines 1–210: `collect_model_dependencies`
  (38–44), GfxObj/SetupModel/Surface/SurfaceTexture/Texture chain, highest-mip-only rule
  (129–137), depth cap 4 (52).
- `crates/holtburger-dat/src/landblock.rs` — lines 1–199: `LandblockInfo` layout (160–177),
  `Stab`/`BuildInfo` (13–35), `CellLandblock` 252 B fixed layout (52–63).
- `crates/holtburger-dat/src/file_type/surface.rs` — lines 1–120 (format docs 7–25, mask
  0x06 at 46); `surface_texture.rs` lines 1–62 (format line 5); `env_cell.rs` lines 60–151
  (`EnvCell::unpack` field order); `texture.rs` header layout (lines 6–8, 101–114).
- `crates/holtburger-dat/src/lib.rs` — lines 45, 157–169 (`RESOURCE_NAMESPACE_LEN = 32`;
  `ResourceSource` trait the pack source must sit behind).
- Live dist: `manifest.json` (648 B, v2, 7 namespaces), `manifest/` catalog sizes (`ls`:
  eor-cell.bin 15,352,534 B; eor-portal.bin 1,499,312 B; tex catalogs 57–80 KB),
  `boot.hba` (2,007,132 B), `_health.json`, side-trees (`scenery/` 2.0 GB, `spawns/`
  397 MB, `events/` 484 MB, `suite/` 1.1 GB via `du -shL`), plus the full measurement
  battery described in Spec S1 (catalog parse of all 895,038 entries; LandblockInfo parse
  of all 5,346 records; scenery JSONL scan of all 65,025 files; transitive closure walk of
  all 49,750 content-bearing LBs; 400-LB and 60-LB dungeon samples; compression probes).

## Decisions

### D-02.1 — Pack partition: 2×2-LB tile packs outdoors, per-LB interior packs, plus five shared-pack kinds

The world is delivered as:

1. **Tile packs** — one per 2×2-LB tile (grid 128×128 = 16,384 slots; **15,847 tiles
   measured non-empty** [M]). Contains the tile's terrain, LandblockInfo, folded
   scenery/spawns/events, small inline EnvCell sets, tile-local closure records
   (D-02.4), geometry slots (D-02.7), and references to shared packs.
2. **Interior packs** — one per LB whose EnvCell payload exceeds 32 KiB (dungeons, large
   town interiors; per-LB EnvCell bytes measured med 17.0 KB / p90 164.7 KB / p99 477.7 KB
   / max 2.01 MB over the 3,410 EnvCell-bearing LBs [M]). Below the threshold, EnvCells
   ride in the tile pack so town buildings need no extra fetch.
3. **Shared meta packs** — CORE (boot essentials), META-COMMONS, META-REGIONAL (D-02.4).
4. **Preview packs** — PVW-COMMONS + PVW-REGIONAL texture-preview carriers (payload format
   owned by pass 5; this pass fixes only their partition and framing).
5. **ENV packs** — environment records (0x0D) for interiors, tiered like meta (D-02.4).

Full-tier texture payloads (tex-xu7 class, median 242 KB [M, S1.1]) stay **per-record
content-addressed files**, exactly as today — at that size, request overhead is amortized
and packing them would destroy cache granularity. They are outside pack scope by design.

*Rationale.* 2×2 was chosen over per-LB and 4×4 on measured churn and size: an 11-LB
crossing front admits ~3 tile packs per column at 2×2 (6 tiles per 2 columns) vs 11
per-LB GETs per column (C1 budget ≤12 would be consumed by packs alone) vs an average
1.5 but lumpier 4×4 front that over-fetches a 4-LB-deep strip (~4× C2 bytes in the
admitted step). Mean per-column *new* payload measured at 2×2-compatible granularity is
~0.11 MB (S1.5) — 2×2 keeps the admitted unit well under C2 while dividing request count
by 4 vs per-LB. The survey (§5 W1) explicitly anticipates "per-landblock (or 2×2 tile)".
*Rejected:* per-LB packs (4× requests, worse intra-pack dedup — town assets repeat in
each of the 4 LBs of a town center); 4×4/8×8 tiles (coarser eviction interplay with
pass 6's slot grid; larger over-fetch on ring edges); one-pack-per-region (re-downloads
whole region on any change; C3 requires unchanged crossings to be 0 network).

### D-02.2 — Container: new `HBP1` sectioned format, not HBA v2

Packs use a new container (`HBP1`, Spec S2) with a typed **section table** and per-section
zstd, served identity (no transport compression; the pack's bytes ARE the hashed bytes).

*Rationale.* HBA v2 was read-verified as unsuitable: every entry costs 60 B including a
32-byte namespace string (archive.rs:24,60–70) — a tile pack holding a few hundred
sub-KB records would pay ~15–25% index overhead, and HBA has no notion of typed sections
(terrain vs placements vs geometry slots), no whole-file integrity footer, and no room
for pass-4/5 payload framing. HBNS conventions that already work stay: little-endian,
leading+trailing magic, CRC32 footer (catalog.rs:14–38). Per-section (not per-record)
zstd because records are tiny (EnvCell mean 261 B [M]) — per-record compression contexts
waste most of the win; measured whole-payload gzip-9 on a real Holtburg tile payload is
**0.409** ratio (S1.6), and section-level zstd meets or beats that.
*Rejected:* HBA v2 reuse (above); tar/zip (no typed sections, central-directory formats
optimize the wrong thing); per-record zstd (ratio loss on 261-B records); serving
zstd-compressed packs with `Content-Encoding` (breaks hash=bytes identity and Range
requests, pass 3's territory).

### D-02.3 — Record identity: pack-local namespace table; content addressing at PACK level only; per-record hashes deleted

Inside a pack, records are addressed `(ns_ordinal u8, file_id u32)` against a pack-header
namespace table. Packs themselves are named by **truncated sha256-16** of their bytes
(same digest convention as `write_shards_v2`, dat_shard.rs:903–924), living in the same
CAS layout (`packs/{prefix2}/{hash32}.hbp`). **No per-record sha256 anywhere in the new
path.**

*Rationale (measured).* Record-level content addressing earns nothing: across all
895,038 catalog entries, deduplication by content hash saves **0.00 MB in every eor
namespace** (805,348 eor/cell entries → 805,348 unique hashes; 79,694 eor/portal → 79,688)
and only 24 MB in the 2.5 GB texture tracks [M, S1.1]. The 16-byte-per-entry hash burden
is why `eor-cell.bin` is 15.35 MB and gzips at 0.955 (survey §2) — the catalog IS mostly
incompressible hashes for records that never collide. Integrity moves to the per-pack
hash (charter D-01.7/I1: "integrity moves to per-pack — pass 3"); the pack hash also
gives cache immutability for B5/C3. The 71%-of-main-thread per-shard sha256 cost
(survey §2) is deleted with the per-record path itself.
*Rejected:* keeping truncated per-record hashes inside packs (pure overhead, measured
zero dedup value); full 32-byte pack hashes on the wire (16-byte truncation is already
2^64 collision-resistant, same argument as dat_shard.rs:938–941).

### D-02.4 — Dedup/sharing: inline-≤4-tiles, regional 5–63, commons ≥64; textures never inline

Measured sharing reality (S1.3): the outdoor visual closure references only **7,940
distinct portal records** (21.4 MB unique non-texture bytes), but naive per-LB inlining
would ship **4,171 MB — a 194.7× duplication factor** [M]. Sharing is extreme AND
spatially skewed. The split, computed at tile granularity [M]:

| Class (non-texture records) | n | unique bytes | placement |
|---|---|---|---|
| used by ≤4 tiles | 3,620 | 15.5 MB | **inlined** in tile packs (total inlined cost across all tiles: 25.97 MB, mean 1.6 KB/tile) |
| used by 5–63 tiles | ~1,795 | ~3.8 MB | **META-REGIONAL** packs, one per 32×32-LB supergrid cell (256 cells; record assigned by usage-centroid) |
| used by ≥64 tiles | 1,039 | 2.10 MB | **META-COMMONS** (single pack, fetched once at boot) |

Texture payloads are never inlined (median tex-xu7 242 KB, mean preview 54 KB [M]);
previews partition the same way — PVW-COMMONS carries previews of textures used by
≥1,024 LBs (**46 textures, 8.66 MB at the current quarter-res preview tier** [M]);
the remainder goes to PVW-REGIONAL by the same supergrid. Environments (0x0D) get the
same tiering for interiors, measured over ALL 734,976 readable EnvCell records [M]:
769 distinct environments in use (of 772 in the corpus, 6.33 MB); used by ≤4 LBs: 338
envs / 2.52 MB → inlined in interior packs; 5–63 LBs: 263 / 2.52 MB → ENV-REGIONAL;
≥64 LBs: 168 / **1.21 MB → ENV-COMMONS** (a single small pack fetched on first interior
entry). Interior Surface records are byte-trivial (804 distinct, ~10 KB total [M]) and
inline freely.

*Rationale.* K=4 inline balances two measured facts: (a) C2/C5 have ~10–20× margin
(S1.5), so paying ≤4× duplication on small meta while crossing a town is immaterial in
bytes; (b) every inlined record removes a shared-pack dependency, keeping the
cold-crossing request count at ~3 tile packs/column (C1 ≤12). K=1 would push 10.7 MB of
2–4-tile records into shared packs whose fetch granularity (region) forces downloading
neighbors' assets anyway; K=8/16 balloon inline totals (34.9/48.6 MB [M]) with no request
saving. The regional/commons boundary at 64 tiles pins the commons at a size (2.10 MB)
that fits inside boot budgets.
*Rejected:* everything-shared (K=0) — maximal request fan-out for zero byte savings at
the measured margins; co-occurrence clustering (optimal but non-deterministic across
bakes — breaks D-02.6's stable-hash patching; supergrid assignment is deterministic).

### D-02.5 — Spatial index: one ~0.5 MB `HBSI1` binary replaces the 16.9 MB blocking catalogs

A single top-level index (Spec S4) maps tile → pack, interior LB → pack, and lists
shared/preview/env packs. Estimated size [D]: pack table (15,847 tiles + ~2,000 interior
+ ~600 shared/preview/env ≈ 18,500 packs) × 24 B ≈ 444 KB + 32 KB tile grid + tables
≈ **~490 KB raw** (hash-dominated, ≈incompressible, ~0.5 MB on the wire). Replaces
`eor-cell.bin` 15.35 MB + `eor-portal.bin` 1.5 MB as blocking boot cost [M baseline].
It does NOT list records: record→pack resolution for the rare out-of-band lookup goes
through the pack that owns the record's tile (or the fallback path, pass 3).

*Rationale:* O(packs) not O(records) is what makes the index 30× smaller than the
catalogs; the eor catalogs' 805k rows exist only to serve per-record GETs, which this
format deletes (I1). *Rejected:* per-namespace pack catalogs (packs are spatial, not
namespaced); embedding the index in manifest.json (binary + JSON mix, and the index must
be separately content-addressed for B5).

### D-02.6 — Versioning/patching: deterministic bake, hash-chained root, single-pack blast radius

- **Determinism rules (normative):** records sorted by (ns_ordinal, file_id) within
  sections; sections in ascending kind order; fixed zstd level 19, no dictionaries in v1;
  no timestamps inside packs; namespace table sorted. Re-baking unchanged input MUST
  reproduce byte-identical packs (CI check in the bake: `--verify-deterministic` re-bakes
  a sample tile and compares hashes).
- **Chain:** `manifest.json` (v3 fields, S7) → `index/{hash16}.bin` (HBSI1) →
  `packs/{prefix2}/{hash16}.hbp` + per-record texture files. All content below the
  manifest is immutable-by-name.
- **Blast radius of a one-record edit** [D]: 1 tile pack rebuilt (p50 ~2–30 KB, p99
  ~600 KB, S1.4) + index rebuilt (~0.5 MB) + manifest ((~1 KB)). Compare today: the
  edited shard plus **three catalog re-fetches ≈ 17 MB** because `catalog_version` is a
  single global counter (v2.rs:204–208). A shared-pack record edit additionally rebuilds
  that shared pack (≤2.1 MB commons worst case).
- **Warm boot / revisit:** unchanged world = manifest revalidation only; changed world =
  manifest + index + only the packs whose hashes changed. B5 (≤1 MB, ≤5 req) is met with
  margin [D: 1 KB + 0.5 MB + 0–few packs].
- Old dist layers (shards/, manifest/, boot.hba) continue to be emitted side-by-side
  during migration (charter N8, pass 9 owns retirement).

*Rejected:* delta-patching inside packs (complexity; packs are already small); mutable
pack names with cache-busting query strings (breaks CAS immutability C3/B5 rest on).

### D-02.7 — Geometry and texture slots are typed, framed, and OPAQUE to this pass

- **GEOM section (kind 0x09):** per-model framing `[model_id u32][encoding u16]
  [reserved u16][offset u32][size u32]` over an opaque payload blob. `encoding` values
  are assigned by pass 4 (0x0001 reserved for "pass-4 indexed-triangulated v1"; 0x0000 =
  "absent — decode from RECORDS section at runtime" is the migration state). The pack
  format guarantees only: framing, section-level zstd, and that a model's geometry
  payload lives in the SAME pack (tile or shared) as the decision D-02.4 assigns its
  records. Byte budgeting in S6 uses today's eor record bytes as the proxy (GfxObj corpus
  5,322 B mean [M]) with pass 4 owning the real coefficient (indexed pre-triangulated may
  be larger raw but compresses; I2's 3× de-index penalty moves offline).
- **TEXREF section (kind 0x0A):** per-referenced-texture rows
  `[rs_id u32][tier_bits u8][pvw_pack_ord u16][reserved u8]` — declares which tiers exist
  and which preview pack carries the preview. Payload formats, tier definitions, mip
  policy, and the boot-tier question all belong to pass 5.
- **Preview packs (kind 3):** a bare record stream of `[rs_id u32][offset u32][size u32]`
  + opaque payload rows; today's HBC7 container (dat_shard.rs:124–139) is the assumed v1
  payload, pass 5 may supersede.

*Rationale:* R2 — passes 4/5 own the internals; what W1 needs frozen NOW is the framing
and the co-location rule so pack sizes can be budgeted. *Rejected:* speccing an indexed
vertex layout here (pass 4's charge); leaving geometry outside packs entirely (would
re-create the per-record fetch pattern I1 kills for the pack's own closure).

### D-02.8 — Boot delivery replaces boot.hba; B1 restated conditionally (H1 exercised)

Boot = manifest → index → {CORE, META-COMMONS, PVW-COMMONS(+regional), spawn-ring tile
packs (36 at 2×2 for the 11×11 ring)} fetched in parallel. The special-case `boot.hba`
(write_boot_pack, dat_shard.rs:852–898) is retired; CORE carries its non-texture cargo
(BOOT_ESSENTIAL_PORTAL_IDS incl. UI font + keymap, dat_shard.rs:71–100; measured boot.hba
composition: 1.97 MB compressed of which 1.34 MB is RGBA textures that previews replace
[M, S1.7]).

**B1 restatement per H1** (the charter authorizes this with arithmetic, S6.1): at the
CURRENT preview tier (quarter-res), the spawn-ring preview set measures **9.20 MB
(Holtburg) / 9.12 MB (Nanto)** [M] and is radius-INVARIANT (7.49 MB already at a 3×3
ring [M, S1.2]) because it is dominated by world-common textures, not local ones. Total
boot ≈ 17–18 MB > B1's 12. **B1 holds at ≤12 MB if and only if pass 5 defines a boot
preview tier capped near 128²** (measured: the median preview IS already 128² ≈ 21.9 KB;
capping the large ones shrinks the ring preview set to ~2.5 MB [D, S6.1]). Until pass 5
rules, B1' = **≤18 MB (3.6 min at T3)** is the honest bound; the 12 MB target is
achievable, not achieved, and the lever is named. B2 ≈ 53 requests ≤ 64 ✓; B3 = 3
generations ≤ 4 ✓ (S6.1).

*Rejected:* shrinking the boot ring to rescue B1 (measured radius-invariance says it
doesn't work); keeping boot.hba alongside packs (two boot paths to maintain; CORE is the
same bytes better factored).

### D-02.9 — Side-trees fold into tile packs as typed sections

- **PLACEMENTS (0x04):** binary scenery rows, 44 B each `[obj_id u32][pos 3×f32]
  [quat 4×f32][scale f32][cell_xy u16][obj_idx u16]` — replaces scenery JSONL
  (measured 449 B/row [M]; med 2 / p90 165 / max 274 rows per LB [M]; corpus 2.0 GB JSONL
  → ~200 MB binary [D]). AABBs are NOT stored (derivable from model bounds; today's
  JSONL bakes them for convenience — the client's pack path recomputes or pass 4 embeds
  bounds per model once).
- **SPAWNS (0x05) / EVENTS (0x06):** v1 carries the existing JSONL rows verbatim,
  zstd-compressed at section level (med 10 / 5 rows per LB [M]). Binary schemas are a
  later optimization — not worth coupling to this format's launch.
- **ENVCELLS (0x03):** raw EnvCell record stream (they are already compact, mean 261 B).
- **suite/texchan (5,475 sidecars keyed by content hash), windclip (103), vfx
  descriptors (0.8 MB global):** NOT folded in v1 — they stay as-is (texchan is
  surface-keyed and pass-5-adjacent; windclip/vfx are global one-shots). Recorded as
  handoff, not scope.

*Rationale:* the three per-LB JSONL trees cost 3–4 GETs per LB today (survey §2) — that
alone is most of the C1 budget; folding them is what makes ≤12 requests/column possible.
*Rejected:* binary spawns/events schemas now (touches gameplay-adjacent readers for ~2%
of the byte win; JSONL+zstd gets the requests to zero extra and most of the bytes).

### D-02.10 — Bake CLI: `dat-shard` grows an `--emit-packs` mode sharing `LoadedBundle`

The existing binary gains (not a new tool — it reuses `read_input_bundle`'s HBA+DAT merge,
dat_shard.rs:247–290, and the walk crate):

```
dat-shard --emit-packs \
  --input assets.hba --eor-portal ... --eor-cell ... --eor-local ... \
  --scenery-dir DIR --spawns-dir DIR --events-dir DIR \      # side-trees to fold
  --tex-pre-dir DIR                                          # preview payloads (pass 5 tier)
  --geom-dir DIR                                             # optional pass-4 payloads (encoding 0x0001)
  --tile-size 2 --inline-k 4 --commons-threshold 64 \
  --interior-split-bytes 32768 \
  --boot-landblock 0xA9B4 --boot-ring 5 \
  --output DIR [--legacy-layers] [--verify-deterministic] [--verify-closure]
```

Emits `manifest.json` (v3), `index/{hash}.bin`, `packs/…`, and (with `--legacy-layers`)
today's shards/catalogs/boot.hba beside them for migration. `--verify-closure` generalizes
`--verify-boot-reachability` (bin/dat-shard.rs:101–103): every tile pack's REFS must
resolve within {inline ∪ named shared packs} or the bake fails loudly (the 2026-07-30
silent-empty-namespace lesson, dat_shard.rs:316–324 comment). Bake-memory note: side-tree
and preview ingestion stream per-tile like `ingest_tex_bc7_dir` (dat_shard.rs:411–430) —
the 2 GB scenery tree must never join `LoadedBundle`.

## Spec

### S1 — Measured dist statistics (the numbers this format is sized against)

All [M], measured this session on the live dist; scripts in session scratchpad
(catalog parser validated against `catalog.rs` wire format incl. CRC/trailing-magic
offsets; closure walk mirrors `walk.rs` incl. its highest-mip-only rule).

**S1.1 Corpus by namespace** (catalog parse, 895,038 entries; unique shard files 894,966
after 72 hash dups):

| namespace | n | total | mean | med | p90 | p99 |
|---|---|---|---|---|---|---|
| eor/cell | 805,348 | 210.5 MB | 261 B | 232 | 416 | 872 |
| — terrain 0xFFFF | 65,025 | 16.4 MB | 252 B fixed | | | |
| — LandblockInfo 0xFFFE | 5,346 | 2.5 MB | 464 B | 28 | 1,156 | 5,232 |
| — EnvCell | 734,977 | 191.6 MB | 261 B | 224 | 426 | 868 |
| eor/portal | 79,694 | 1,216.1 MB | 15.3 KB | 1,211 | 16.4 KB | 393 KB |
| — 0x06 Texture | 20,684 | 970.6 MB | 46.9 KB | | | |
| — 0x01 GfxObj | 15,318 | 81.5 MB | 5.3 KB | | | |
| — 0x0D Environment | 772 | 6.3 MB | 8.2 KB | | | |
| tex-bc7 | 2,999 | 2,518.6 MB | 840 KB | 350 KB | | |
| tex-bc7-pre | 2,893 | 157.5 MB | 54.5 KB | 21.9 KB | 87.4 KB | 349.6 KB |
| tex-xu7 | 3,985 | 2,353.2 MB | 590 KB | 242 KB | 1.35 MB | 3.97 MB |

Preview sizes decode to power-of-two BC7+mips: med 21.9 KB = 128², p90 87.4 KB = 256²,
p99 349.6 KB = 512² (arithmetic: side²·1 B/texel ×1.33 mips + 20 B HBC7 header).

**S1.2 Outdoor closure (all 49,750 content-bearing LBs: statics from all 5,346
LandblockInfos + scenery obj_ids from all 65,025 scenery JSONLs; walk = walk.rs chain):**

- Distinct portal records reachable: **7,940** (of 79,694 — 10%); non-texture unique
  21.4 MB; reachable textures 1,486 (xu7 852 MB, previews 84.4 MB of the 2,353/157 MB
  corpora — 64% of texture bytes are NOT outdoor-reachable: interiors + equipment).
- Duplication if inlined per LB: 4,171.6 MB = **194.7×**. Per 2×2 tile at K=1: total
  inline 8.81 MB; K=4: 25.97 MB; K=8: 34.85 MB; K=16: 48.63 MB.
- Popularity (tiles): ≤4 tiles: 3,620 recs/15.5 MB · 5–63: ~1,795/~3.8 MB · ≥64:
  1,039/2.10 MB. Previews by LB-popularity: ≥1,024 LBs: 46 recs/8.66 MB; ≥256: 130/11.07;
  ≥64: 299/17.23; ≥4: 785/47.32.
- Spawn rings, unique bytes (scale: distinct records for the ring):
  Holtburg 11×11 = meta 1.28 MB + previews 9.20 MB + terrain 30.5 KB (1,137 records);
  Nanto = 1.37 / 9.12 MB. Radius sweep (Holtburg previews): r1 7.49 → r2 8.54 → r3 8.81
  → r5 9.20 MB — **preview cost is commons-dominated, radius-invariant**.

**S1.3 Interiors** (all-LB grouping + 400-LB and 60-LB shard-parsed samples):

- 3,410 LBs carry EnvCells; cells/LB med 74 / p90 639 / p99 1,487 / max 4,213; bytes/LB
  med 17.0 KB / p90 164.7 KB / p99 477.7 KB / max 2.01 MB.
- Per-dungeon closure sample (n=60): environments/LB med 11 (55 KB of 0x0D records, but
  drawn from only 772 world-wide); interior distinct textures med 7 / p90 15; interior
  preview bytes med 198 KB / p90 598 KB / max 1.95 MB; interior full xu7 med 2.45 MB.

**S1.4 Tile pack size model** [D from S1.1–S1.3]: terrain 1,008 B fixed + LandblockInfo
(med 28 B) + placements (med ~8 rows×44 B, p90 ~660×44 ≈ 29 KB) + spawns/events zstd
(~2–10 KB) + inline meta (med 0, p99 1.5 KB, max 1.40 MB) + EnvCells ≤32 KB + framing
~200 B. **Expected tile pack: p50 ~4 KB, p90 ~50 KB, p99 ~600 KB** before geometry
payloads (pass 4 adds its coefficient).

**S1.5 Crossing (20-column westward walk from Holtburg, 11-LB front, scale = new unique
bytes entering the resident set per column):** meta mean 24.3 KB / max 164 KB; previews
mean 63.1 KB / max 361 KB; terrain 2.77 KB fixed. Median column is **0 new bytes** (empty
wilderness). With sidecars ≈ **mean ~0.11 MB, max ~0.56 MB per column**.

**S1.6 Compression probes** (gzip-9 as zstd floor): Holtburg-tile closure payload 604,923
→ 247,514 B = **0.409**; 121 terrain records 30,492 → 8,429 B = 0.276. BC7 preview
payloads assumed ≈1.0 (already high-entropy) [A].

**S1.7 boot.hba today** (parsed): 639 entries, 1.97 MB compressed; 0x06 textures 1.34 MB
comp (replaced by previews under I3), non-texture remainder ≈ 0.63 MB comp.

### S2 — `HBP1` container layout (normative)

Little-endian throughout. Whole file = header + section table + section payloads + footer.

```
Header (32 B):
  0   4  magic            = "HBP1"
  4   1  version          = 1
  5   1  pack_kind        (0=tile, 1=interior, 2=meta-shared, 3=preview, 4=env, 5=core)
  6   2  flags            (reserved, 0)
  8   4  origin           (tile packs: (tile_x u8)<<8 | tile_y u8 in low 16 bits;
                           interior: LB id u16; shared: supergrid cell or tier id)
  12  2  section_count
  14  1  ns_count
  15  1  reserved
  16  8  content_epoch    (bake identity: low 64 bits of the SOURCE sha — informational)
  24  8  reserved

Namespace table (ns_count × 32 B): fixed 32-byte zero-padded namespace strings,
  sorted; ns_ordinal = position. (RESOURCE_NAMESPACE_LEN = 32, lib.rs:45.)

Section table (section_count × 16 B), ascending kind:
  0   2  kind             (S3 registry)
  2   1  codec            (0 = raw, 1 = zstd)
  3   1  reserved
  4   4  offset           (from file start; u32 caps packs at 4 GiB, fine — packs
                           SHOULD stay ≤ 8 MiB, MUST stay ≤ 64 MiB)
  8   4  stored_size
  12  4  raw_size

Footer (8 B): crc32(all preceding bytes, IEEE — same polynomial/init/xor as
  catalog.rs:352-362) + trailing magic "1PBH".
```

Pack file name: `packs/{prefix2}/{trunc_sha256_32hex}.hbp`; digest over the full file
bytes (incl. footer), truncated to 16 bytes, hex-encoded — identical convention to
`write_shards_v2` (dat_shard.rs:956–967).

### S3 — Section kind registry (v1)

Record-stream sections share one framing: `[count u32]` then count ×
`[ns_ordinal u8][file_id u32][offset u32][size u32]` (13 B/record, offsets into the
decompressed section payload), then the payload bytes. Entries sorted by
(ns_ordinal, file_id) → binary search after one section decompress.

| kind | name | payload | notes |
|---|---|---|---|
| 0x01 | TERRAIN | 4 × CellLandblock 252 B, order (dx,dy) = (0,0),(0,1),(1,0),(1,1) | fixed layout, no index needed |
| 0x02 | LBINFO | record stream (0–4 LandblockInfo records) | raw eor bytes |
| 0x03 | ENVCELLS | record stream of EnvCell records | only when per-LB payload ≤ 32 KiB (else interior pack) |
| 0x04 | PLACEMENTS | `[count u32]` × 44 B rows per D-02.9, grouped by LB (4 sub-ranges in a 16 B preamble) | replaces scenery JSONL |
| 0x05 | SPAWNS | zstd JSONL, verbatim rows | v1 bridge |
| 0x06 | EVENTS | zstd JSONL, verbatim rows | v1 bridge |
| 0x07 | RECORDS | record stream: inline closure records (GfxObj/Setup/Surface/SurfaceTexture/Palette/…) | the K≤4 inline set |
| 0x08 | REFS | `[pack_count u8]` × `[hash16][kind u8]`, then `[rec_count u32]` × `[ns_ordinal u8][file_id u32][pack_ord u8]` | out-of-pack closure edges; MUST resolve at bake (`--verify-closure`) |
| 0x09 | GEOM | per D-02.7 framing, opaque payloads | pass 4 |
| 0x0A | TEXREF | per D-02.7 rows | pass 5 |
| 0x0B | PVW | preview record stream `[rs_id u32][offset u32][size u32]` + opaque payloads | preview/core packs only; payload = HBC7 v1, pass 5 may supersede |

Consumers MUST skip unknown kinds (forward compat); producers MUST NOT emit two sections
of the same kind in one pack.

### S4 — `HBSI1` spatial index layout (normative)

```
Header (24 B): magic "HBSI" | version u8=1 | flags u8 | reserved u16 |
  pack_count u32 | interior_count u32 | shared_count u16 | reserved u16 | epoch u32
Pack table: pack_count × 24 B: [hash16][size u32][kind u8][meta u8]
  (meta: for preview/env/meta-shared packs, the tier/supergrid ordinal)
Tile grid: 128×128 × u16 pack-table ordinal, row-major tile_x major; 0xFFFF = empty
  (32,768 B fixed)
Interior table: interior_count × 6 B: [lb u16][pack_ord u16][reserved u16], sorted by lb
Shared directory: shared_count × 4 B: [kind u8][ord_hi u8][pack_ord u16]
  (locates CORE / COMMONS / regional packs without scanning)
Footer: crc32 + "ISBH"  (HBNS conventions, catalog.rs:33-38)
```

Size [D]: 24 + 18,500×24 + 32,768 + ~2,000×6 + small ≈ **489 KB**; wire ≈ 0.5 MB
(hash-dominated). Meets charter B1's ≤1 MB index component with 2× margin.

Client lookup cost: tile → ordinal is O(1) array read; interior → binary search. The
index is one fetch, one parse, resident for the session (~0.5 MB heap — three orders
below M1).

### S5 — Bake population algorithm (normative order)

1. Load bundle (existing `read_input_bundle` merge semantics, dat_shard.rs:247–290).
2. Parse all LandblockInfos + scenery JSONLs → per-LB root model sets (statics,
   buildings, scenery). [Same inputs as this pass's measurement.]
3. Walk closures per LB via `collect_model_dependencies` (walk.rs:38) — UNCHANGED walk
   semantics v1 (incl. highest-mip-only, walk.rs:129–137).
4. Aggregate per 2×2 tile; compute tile-usage counts per record; assign records:
   inline (≤ K), regional (K+1..63, by usage-centroid supergrid cell), commons (≥64).
5. Assign preview/env/texref entries per D-02.4/D-02.7.
6. Emit shared packs first (their hashes feed REFS), then interior packs, then tile
   packs, then CORE; then HBSI1; then manifest v3. All emission deterministic (D-02.6).
7. `--verify-closure`: re-open every emitted pack, resolve every REFS edge, fail loud on
   any dangling reference. `--verify-deterministic`: re-emit N sample packs, compare
   hashes.

### S6 — Budget arithmetic (charter traceability)

**S6.1 Boot (B-series, T3 line).** Requests [D]: 1 manifest + 1 index + ~10 code/wasm +
1 CORE + 1 META-COMMONS + 1 PVW-COMMONS + ~2 regional + 36 ring tile packs ≈ **53 ≤ B2 64** ✓.
Serial depth: manifest → index → packs-in-parallel = **3 ≤ B3 4** ✓ (walk waves deleted).
Bytes [D, gzip/zstd applied at S1.6 ratios to meta, none to BC7]:

| component | current tier | with pass-5 128² boot tier |
|---|---|---|
| code+wasm (gzip, [M] charter) | 4.8 MB | 4.8 |
| manifest + index | 0.5 | 0.5 |
| CORE (non-tex boot.hba remainder [M] + tables) | ~1.0 | ~1.0 |
| ring tile packs (meta 1.28 MB×0.41 + terrain 8.4 KB + sidecars ~0.3) | ~0.9 | ~0.9 |
| META-COMMONS 2.10×0.41 + regional | ~1.2 | ~1.2 |
| previews for ring (S1.2, commons-dominated) | 9.2 | ~2.5 [D: cap ≥256² previews to 128² ⇒ 46×21.9 KB + tail] |
| **total** | **~17.6 MB** | **~10.9 MB ≤ B1 12** ✓ |

B1 disposition: **B1' ≤18 MB stands now; B1 ≤12 MB is delivered by pass 5's boot tier
decision** (H-02.3). B5 ✓ per D-02.6. B4 (converged 45 MB): ring full xu7 = 83.5 MB [M]
exceeds it — B4 already hangs on pass 5's lossy call (charter H4); at q75's 38.2% ratio,
83.5×0.382 ≈ 31.9 MB + meta/boot ≈ 40 MB ≤ 45 ✓ [D, pending pass 5].

**S6.2 Crossing (C-series).** C1 [D]: 3 tile packs + ≤2 shared-pack misses + sidecars 0
(folded) ≈ **5 ≤ 12** ✓ (full-tier texture fetches are pass-5 lazy, budgeted there).
C2 [M+D]: mean 0.11 MB, max col 0.56 MB ≤ **1.5 MB** ✓ (previews at current tier — no
boot-tier dependency; margin 2.7× on the worst measured column). C3: 0 network ✓
(immutable hashes + pass 6 residency). C4 [M+D]: first-ever dungeon = ENV-COMMONS
1.21 MB (once, cached) + interior pack med 17 KB (p90 165 KB) + regional/inline envs
(med 55 KB class) + previews med 198 KB ≈ **~1.5 MB median first-ever, ~0.3–0.8 MB
typical thereafter ≤ 2 MB** ✓; the caveat is max-preview dungeons (1.95 MB previews
alone [M]) which breach C4 regardless of packing — a pass-5 preview-tier question,
flagged there.
C5 [D]: worst measured column 0.56 MB needs 6.7 s at 83 KB/s against ≥27 s/column
travel — **4× margin worst-case, 20× typical** ✓.

**S6.3 What this format deletes** (I1 ledger, all [M] baselines): 15.35 MB blocking
eor-cell.bin; 1,700-request boots → ~53; ≥363 cell GETs/ring → 36 packs; 3–4 side-tree
GETs/LB → 0; per-shard sha256 (71% main-thread in probe) → per-pack hash; walk-loop
serial waves (≥4/chain) → 0 at runtime (closure is bake-time).

### S7 — Manifest v3 additions (shape only; pass 3 owns fetch/integrity semantics)

`version: 3`; keeps `source`, `generated_at`. Adds `world_index: {url, size, sha256_16}`,
`pack_url_template: "packs/{sha256_prefix2}/{sha256}.hbp"`, keeps `shard_url_template` +
`catalog_url_template` + `boot_pack` for the legacy path during migration (dual-stack,
pass 9). `catalog_version` retained for legacy consumers only.

## Handoffs to later passes

- **H-02.1 (→ pass 3):** Fetch semantics over packs: priority order, prefetch radius in
  tiles, Range policy (S2 offsets permit ranged section reads; default = whole-pack),
  integrity check placement for the per-pack hash, CDN/cache headers, SW story, and the
  per-record fallback path (legacy shards remain servable). Proposed default: whole-pack
  fetch + hash verify off-main-thread; prefetch radius 1 tile beyond the ring.
- **H-02.2 (→ pass 4):** GEOM payload encoding 0x0001 (indexed, pre-triangulated,
  transferable-friendly), the per-model bounds record (needed since PLACEMENTS drops
  baked AABBs), and the real byte coefficient vs the eor-proxy used in S1.4/S6 — if
  geometry payloads push p99 tile packs past ~2 MB, pass 4 must restate S1.4 and re-check
  C2 (the 2.7× worst-column margin is the buffer).
- **H-02.3 (→ pass 5):** The boot preview tier (cap ≈128²) that converts B1' 18 → ≤12 MB
  (S6.1 arithmetic); PVW payload format succession (HBC7 v1 assumed); TEXREF tier_bits
  assignment; texchan sidecar integration; the B4 lossy arm.
- **H-02.4 (→ pass 6):** Tile-pack granularity is designed to feed the slot grid —
  proposed default: slot-grid shift admits/evicts whole tiles; pack-resident bytes in
  Rust are the refcounted unit (M3's shard-record store is superseded by pack buffers).
- **H-02.5 (→ pass 9):** Dual-dist mechanics (`--legacy-layers`), retirement criteria for
  shards/catalogs/boot.hba, and the eye-test gate for the first pack-served world.
- **H-02.6 (→ pass 10):** Bench protocol must measure boot on emulated 666 kbps against
  S6.1's component table (per-component attribution, not just totals) and validate the
  determinism check in CI.

## Self-check

- **R1/R5 walls:** No figure here prices draws or frames — this pass is wire/bytes only.
  Scale labels: every count states its population (records vs entries vs unique bytes vs
  sum-over-tiles; S1.2 explicitly separates "unique" from "inlined total" — the
  allocated≠used discipline applied to bytes). Boot-variance wall not applicable (no
  frame benches run). PASS.
- **R2 scope:** Geometry/texture internals left as typed opaque slots (D-02.7);
  fetch/integrity semantics deferred to pass 3 (S7 note); residency to pass 6. PASS.
- **R3:** Writes: this file + own TRACKING.md row only. Measurement scripts live in the
  session scratchpad, not the repo. PASS.
- **R4:** Every code claim carries file:line read this session (dat_shard.rs,
  archive.rs, catalog.rs, v2.rs, walk.rs, landblock.rs, surface*.rs, env_cell.rs,
  lib.rs). The wasm-crate trap: not touched (no claims about `src/lib.rs` internals).
  Dist facts measured directly, not quoted from the survey — and two survey figures were
  corrected by measurement: dist logical corpus is 6.46 GB as quoted but shard-entry
  count is 895,038 entries / 894,966 unique files; EnvCell count is 734,977 (prompt said
  734,976 — off-by-one, catalog parse is authoritative). PASS.
- **R6:** Sections present in required order. PASS.
- **R7:** Formats byte-specified (S2–S4); thresholds numeric (K=4, 64, 32 KiB, tile=2×2);
  budgets carry [M]/[D]/[A] and arithmetic (S6). PASS.
- **R8:** B1 not claimed met — restated conditionally with the lever named (D-02.8);
  env tiering, geometry coefficient, and zstd-vs-gzip deltas carried as open questions
  rather than assumed. PASS.
- **Charter compliance:** D-01.7/I1 "fully broken for world content, per-record fallback
  MAY remain" — respected (legacy path retained for migration + rare/dynamic assets).
  H1 exercised with arithmetic as the charter requires. No prior-pass decision
  contradicted. PASS.

## Open questions

- **Q1 — zstd level-19 ratios on real sections.** All compression arithmetic uses gzip-9
  probes (S1.6) as a floor. Needs one bake prototype run to pin real ratios and bake
  time; if zstd-19 bake time on 15,847 tiles is prohibitive on the laptop, the fallback
  is level 12 (ratio delta ~2–3% typ.). [Owner: first implementation task; buildbox.]
- **Q2 — Geometry payload coefficient** (H-02.2): S1.4/S6 tile-pack sizes exclude pass-4
  GEOM payloads. The eor GfxObj corpus is 81.5 MB/15,318 models [M]; indexed
  pre-triangulated output size per model is unknown until pass 4 specs the layout.
- **Q3 — Boot preview tier** (H-02.3): B1 12 vs 18 MB hangs on it. Measured lever:
  ring previews are commons-dominated and radius-invariant; median preview is already
  128². Pass 5 owns; a 5-minute re-run of this pass's ring script with a cap function
  re-scores S6.1 exactly.
- **Q4 — RESOLVED during this pass.** The full-corpus envcell popularity scan completed
  (734,976 of 734,977 records readable — one record short/unreadable, negligible):
  environment tiering is now measured and folded into D-02.4/S6.2. Residue: identify the
  one unreadable EnvCell record during the first bake (`--verify-closure` will surface
  it).
- **Q5 — Non-visual closure completeness.** The measured closure mirrors walk.rs's visual
  chain (GfxObj/Setup/Surface/SurfaceTexture/Texture/Palette). Runtime also touches
  MotionTables (0x09), PhysicsScripts (0x33/0x34), sounds (0x0A, 52.4 MB corpus [M]) for
  animated scenery/entities — currently fetched per-record. Decision needed (pass 3
  fallback vs closure-widening): proposed default = widen the bake walk to include
  Setup→MotionTable/PhysicsScript/SoundTable edges before v1 ships, sized in the same
  K-tier machinery; sounds likely commons-tier (small distinct set, heavily shared). [A]
- **Q6 — World-edit blast radius on shared packs.** A commons-record edit rebuilds a pack
  every client re-downloads (≤2.1 MB). Acceptable for the current bake cadence; if the
  editor workflow ever needs record-level patching, a `PATCH` pack kind (overlay by
  (ns, fid)) is the reserved escape hatch — kind 0x0C is left unassigned for it.
