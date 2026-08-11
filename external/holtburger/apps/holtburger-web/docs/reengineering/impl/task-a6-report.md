# TASK a6 — TEXBC7-ALPHA-AUDIT (the box-buildable half of `TEXBC7-ALPHA-REBAKE`)

Batch-D `postBakeCodeWork` item `TEXBC7-ALPHA-REBAKE`. The corpus and the hires
upscaler live on the laptop's mounted drives, so the re-bake itself is out of scope
here (task statement). This half is the tool the item's second sentence demands —
"then AUDIT all alpha-bearing surfaces the same tool upscaled (clipmap/Base1ClipMap
class especially)" — so the laptop run is one command.

## What landed (commits)

Branch `fanout-D-a6`, three bisectable commits. Nothing outside
`apps/holtburger-tools/` was touched.

| commit | what |
|--------|------|
| `46b52ab6` | leg 1 — `src/alpha_audit.rs`: the alpha classifier (DAT truth + the three corpus containers) + `src/lib.rs` module line |
| `1aad6ece` | leg 2 — `src/bin/alpha-audit.rs`: the census / corpus-verdict CLI |
| `76e3e76b` | leg 3 — `tests/alpha_audit.rs`: real-record tests against `~/ac_base_dats/` |

New files only, plus one line in `apps/holtburger-tools/src/lib.rs` (`pub mod
alpha_audit;`). No `scene3d/`, no `lib.rs` (wasm), no `crates/holtburger-*` edits —
`holtburger-dat` is used as a dependency and was not modified. No new URL flag (this
is a native tool), so no `url-flags.md` row is owed.

### The classifier (`src/alpha_audit.rs`, 15 unit tests)

Four classes on the decoded alpha plane and nothing else:

| class | rule |
|---|---|
| `opaque` | every texel alpha == 255 (includes "the PFID has no alpha bits") |
| `fully-transparent` | every texel alpha == 0 — the PORTAL-BLACKBOX class |
| `punch-through` | alpha ∈ {0,255}, both present |
| `gradient-alpha` | at least one texel with 0 < alpha < 255 |
| `undetermined` | no decode (unsupported PFID / short record / encoded corpus payload) |

`gradient-alpha` is STRICT — one soft texel in a 512² mask lands there — so the class
cannot silently absorb the Remacri alpha-fringe failure mode
(`impl/texfix-fringe-2026-08-09.md`: a binary source upscaled into a 37 %-wide soft
band). The row therefore also carries `partialFrac` and a derived
`effectivelyBinary` bit at that report's own shape (partial fraction < 0.5 %), which
is what a consumer should bucket on when it means "is this a mask". An EMPTY plane is
`undetermined`, never `opaque` — a truncated record must not pass as clean.

DAT truth routes through the client's own decoders (`Texture::to_rgba8_*`,
`file_type/dxt.rs`) so punch-through, explicit/interpolated DXT alpha and the clipmap
rule are the same code the renderer runs. Alpha CAPABILITY (`format_carries_alpha`, a
PFID property — DXT1 is IN, punch-through is an alpha mode of it) is kept distinct
from alpha REALITY (`AlphaClass::bears_alpha`, what these bytes do), and both are
counted.

Corpus side reads the three containers the lanes actually ship:

* **PNG** (`out/<set>-remacri`, the upscale corpus) — EXACT, texel by texel. A PNG
  with no alpha channel gets its own source label `png-no-alpha-channel`, so the
  summary can say *the channel was gone* rather than *the pixels were opaque*.
* **KTX2** (`--tex-xu7` ingest / xubc7 corpora) — header + basic Data Format
  Descriptor, no pixels. `BC1_RGB`'s missing alpha bit is the strongest possible drop
  signal; ETC1S carries alpha as a second DFD sample so the sample count settles it
  exactly; **BC7 (vkFormat 145/146) returns `None`** because its alpha lives in the
  block modes and no header read can see it.
* **HBC7** (`--tex-bc7` / `--tex-bc7-pre` ingest — raw BC7 blocks behind a 20-byte
  header) — a BC7 **mode scan**. Mode is unary-coded in the low bits of each block, so
  `block[0].trailing_zeros()` is the mode; modes 0–3 carry no alpha field at all, so
  an all-0..3 payload is *provably* opaque with no decode. The converse is not
  available (mode 6 is the workhorse for opaque high-quality blocks too), so any
  mode-4..7 block yields `undetermined` rather than a manufactured "has alpha". The
  mode histogram ships on the row so a consumer can re-adjudicate without re-running.

The verdict is one pure function (`decide`):

| DAT | corpus | verdict | why |
|---|---|---|---|
| `fully-transparent` | anything | **SKIP** | zero information; no re-encode can improve it (the queue item's own rule, and what `062e5ce3` vetoes client-side) |
| `punch-through` / `gradient` | `opaque` | **REBAKE** | alpha dropped — the PORTAL-BLACKBOX defect |
| `punch-through` / `gradient` | `fully-transparent` | **REBAKE** | alpha destroyed |
| `punch-through` | `gradient` | **KEEP** + `punchthrough-softened` | the fringe class — owned by the fringe repair, must not inflate the REBAKE count |
| `opaque` | bears alpha | **REBAKE** | transparency invented |
| any | `undetermined` | **KEEP** + `corpus-alpha-undetermined` (REBAKE under `--strict-unknown`) | fail-open, loudly counted |
| `undetermined` | any | **SKIP** | no DAT truth to compare against |

Sub-signals are `flags`, deliberately separate from the verdict: the acceptance names
exactly three verdicts, and a real-but-not-a-rebake defect class must not be able to
inflate the REBAKE list.

### The CLI (`src/bin/alpha-audit.rs`)

Two modes over one walk. **The Surface index is built first and is not an ornament**:
a palettized record's alpha is not a property of the record alone (retail
`ImgTex::CopyIntoData` makes palette index < 8 transparent under `Base1ClipMap`), so
the tool walks `Surface (0x08) → SurfaceTexture (0x05) → Texture (0x06)` and decodes
each record under the clipmap bit its own references imply. That index also supplies
the `Base1ClipMap` flag the queue item asks for by name, the `image` /
`unreferenced` split, the `highestRes` bit (what the renderer and the upscaler
actually consume), and the blend-state bit (`Translucent|Alpha|InvAlpha|Additive`).

Determinism: ids ascending, every bucket a `BTreeMap`, **no timestamp anywhere**.
Provenance: sha256 of every input DAT plus of every corpus payload read (`--no-dat-sha`
records the literal string `"skipped"`, never a wrong hash). The `rows`/`ids` zip
after the rayon collect is `assert_eq!`-checked, not assumed — every verdict depends
on that ordering.

`--dat` is repeatable with hires-overlay semantics (later DAT wins for an id; every
row records which DAT it came from), so the laptop's repaired hires DAT overlays the
base in one run. **Every path is an argument; nothing under `/mnt` is compiled in.**

Row contract is the acceptance's, first fields first:

```json
{"id":"0x0600396B","dat":"client_portal.dat","datAlphaClass":"fully-transparent",
 "datAlpha":{"class":"fully-transparent","source":"dxt1-punch-through","format":"Dxt1",
   "formatRaw":827611204,"width":8,"height":8,
   "stats":{"texels":64,"zero":64,"full":0,"partial":0,"min":0,"max":0},
   "partialFrac":0.0,"zeroFrac":1.0,"effectivelyBinary":true},
 "surfaceClass":"clipmap",
 "refs":{"clipmap":true,"image":false,"blended":false,"surfaces":["0x08000157"],
   "paletteOverrides":0,"highestRes":true}}
```

so `jq -r 'select(.verdict=="REBAKE") | .id' verdicts.jsonl` is the whole re-bake
list. In corpus mode each row gains `corpusAlphaClass` / `verdict` / `reason` plus a
`corpus[]` array with one entry per lane (its own class, verdict, reason, flags,
payload sha256 and bytes). **DAT-truth-only mode emits no `verdict` field at all** —
there is nothing to compare against and inventing one would be a lie.

## Tests run + results

Toolchain: bare `cargo` hits "no rustup default" on this box; all runs used
`env PATH="/opt/rust/toolchains/1.95.0-x86_64-unknown-linux-gnu/bin:/usr/local/bin:/usr/bin:/bin"`.

```
cargo test -p holtburger-tools
  → 153 passed; 0 failed; 10 ignored          (across all targets, aggregated)
  → lib: 65 passed; 0 failed  (was 62 before this task; +15 new, filtered run below)

cargo test -p holtburger-tools --lib alpha_audit
  → 15 passed; 0 failed; 0 ignored; 50 filtered out

cargo test -p holtburger-tools --test alpha_audit -- --ignored --nocapture
  → 6 passed; 0 failed; 0 ignored             (17.98 s, real ~/ac_base_dats)
```

The 10 ignored are the 4 pre-existing real-DAT/`/mnt` gates (`bake_ci` ×3,
`page_resample` ×1) plus this task's 6.

`cargo clippy -p holtburger-tools --bin alpha-audit --lib --tests` is clean of
warnings on the three new files (pre-existing warnings elsewhere in the workspace are
untouched).

### The six real-record tests

| test | what it pins |
|---|---|
| `portal_swirl_record_is_fully_transparent` | `0x0600396B` re-measured from the DAT: PFID_DXT1 8×8, all four blocks asserted `c0 <= c1` + indices `0xFFFFFFFF`. **`datAlphaClass=fully-transparent`**, 64/64 zero texels, `source=dxt1-punch-through`; SKIP against all five corpus classes under both strictness settings |
| `second_cited_record_is_fully_transparent_via_the_clipmap_rule` | `0x060037A3` — **measured, not assumed**: 8×8 PFID_INDEX16, so it reaches the same class down a completely different path (palette index < 8). Its NEGATIVE half is load-bearing: without the clipmap bit the record is not transparent, so the Surface index is the difference between SKIP and a false verdict |
| `both_cited_records_hang_off_the_two_surfaces_the_client_veto_measured` | `062e5ce3`'s live Yaraq blast radius read "exactly 2 surfaces vetoed (`0x08000157` and `0x08000015`)". Reached here from the DAT side alone — both are `Base1ClipMap` and their chains land on the two cited records |
| `full_census_classifies_every_render_surface` | all 20,684 records; requires all four real classes populated (a classifier that collapses to one bucket is broken) and no record lost. Reproduces the release binary's numbers exactly |
| `cli_dat_truth_only_emits_the_row_contract` | runs the built binary: ascending-id order, absent `verdict`/`corpusAlphaClass`, summary buckets, and a **byte-identical re-run** |
| `cli_corpus_mode_catches_a_dropped_alpha_channel` | two fake lanes around a REAL punch-through record discovered by the census (`0x06003C2B` on today's DAT, not a hardcoded fixture): a 4× RGB PNG and an all-mode-1 `.hbc7`. Both reach REBAKE — one through exact texels, one through the BC7 mode histogram. The portal record sits in the same run with a payload just as defective and stays SKIP |

## DAT-truth-only census (run on the box)

```
$ alpha-audit --dat ~/ac_base_dats/client_portal.dat --out-dir /tmp/a6-census

alpha-audit: 20684 RenderSurface records across 1 DAT(s); 7634 referenced by a Surface
=== alpha-audit (dat-truth-only) ===
  dat client_portal.dat — 20684 RenderSurface / 6152 Surface records;
      sha256 dc6e500ba22e6b186db7171e3f3345238b6444c85d798adc85e550973b8d12e4
  20684 records — 19379 alpha-capable PFID / 13628 actually bearing alpha; 0 decode failures
  by alpha class:
    fully-transparent            7
    gradient-alpha               749
    opaque                       7056
    punch-through                12872
  by PFID:
    A4R4G4B4                     2
    A8                           86
    A8R8G8B8                     12984
    CustomLscapeAlpha            16
    CustomLscapeR8G8B8           33
    CustomRawJpeg                79
    Dxt1                         1971
    Dxt3                         5
    Dxt5                         127
    Index16                      4182
    P8                           6
    R5G6B5                       3
    R8G8B8                       1190
  by surface class:
    clipmap                      597
    clipmap+image                74
    image                        4859
    unreferenced                 15154
  surface class / alpha class:
    clipmap+image/fully-transparent 1
    clipmap+image/gradient-alpha 18
    clipmap+image/opaque         13
    clipmap+image/punch-through  42
    clipmap/fully-transparent    5
    clipmap/gradient-alpha       93
    clipmap/opaque               49
    clipmap/punch-through        450
    image/gradient-alpha         80
    image/opaque                 4536
    image/punch-through          243
    unreferenced/fully-transparent 1
    unreferenced/gradient-alpha  558
    unreferenced/opaque          2458
    unreferenced/punch-through   12137
  Base1ClipMap rows by alpha class:
    fully-transparent            6
    gradient-alpha               111
    opaque                       62
    punch-through                492
  highest-res rungs by alpha class:
    fully-transparent            6
    gradient-alpha               191
    opaque                       4598
    punch-through                735

real  0m1.883s
```

Re-run against a second build of the binary: `verdicts.jsonl` **byte-identical**
(9,754,794 B, `cmp` rc=0).

### PFID × class cross-tab (from `verdicts.jsonl`)

```
A4R4G4B4            gradient-alpha         2     Dxt1       fully-transparent      1
A8                  gradient-alpha        86     Dxt1       opaque              1714
A8R8G8B8            fully-transparent      1     Dxt1       punch-through        256
A8R8G8B8            gradient-alpha       554     Dxt3       gradient-alpha         2
A8R8G8B8            opaque               283     Dxt3       punch-through          3
A8R8G8B8            punch-through      12146     Dxt5       gradient-alpha        89
CustomLscapeAlpha   gradient-alpha        16     Dxt5       opaque                11
CustomLscapeR8G8B8  opaque                33     Dxt5       punch-through         27
CustomRawJpeg       opaque                79     Index16    fully-transparent      5
P8                  opaque                 6     Index16    opaque              3737
R5G6B5              opaque                 3     Index16    punch-through        440
R8G8B8              opaque              1190
```

### Which surfaces actually matter — derived cuts

* **Highest-res rungs: 5,530**, of which **932 bear alpha**. That is the population
  the upscaler consumes and the population that has alpha to lose. Their dims:
  128² ×301, 64² ×137, 32² ×97, 256² ×95, 128×64 ×79, 512² ×50, 64×128 ×39, 32×64 ×33.
* **`Base1ClipMap` rows: 671**, all of them highest-res, **609 alpha-bearing** —
  492 punch-through, 111 gradient, 6 fully-transparent. This is the class the queue
  item singles out and it is exactly the class where a flattened alpha renders as a
  solid quad.
* **`gradient-alpha`: 749, of which 123 are `effectivelyBinary`** (partial fraction
  < 0.5 %) — masks in all but name. On the corpus side those are the rows most likely
  to be mistaken for legitimate soft alpha.
* **Blend-state surfaces: 392**, 145 alpha-bearing.
* **`paletteOverrides` is 0 across all 20,684 rows.** No 0x08 record in retail
  `client_portal.dat` carries a non-zero `orig_palette_id`, so the audit's
  `palette_override=0` decode is retail-faithful here. Corroborated by an in-repo,
  read-verified note (`crates/holtburger-dat/src/walk.rs:106`): *"The Surface's
  `orig_palette_id` is non-canonical for most retail records (typically 0; the
  Texture's `default_palette_id` is what the decoder uses)."* The override path
  exists and is wired; a modded/hires DAT could exercise it.

### NEW FINDING — the fully-transparent set is SEVEN records world-wide

The queue item named two. The census found all of them:

| rs id | PFID | dims | surface class | referencing Surfaces |
|---|---|---|---|---|
| `0x060037A3` | Index16 | 8×8 | clipmap+image | `0x08000015`, `0x080003E4`, `0x0800099F`, `0x08000D0E`, `0x08001524` |
| `0x0600396B` | Dxt1 | 8×8 | clipmap | `0x08000157` |
| `0x0600415F` | Index16 | 64×64 | clipmap | `0x08000690` |
| `0x06004161` | Index16 | 64×64 | clipmap | `0x08000691` |
| `0x06004163` | Index16 | 64×64 | clipmap | `0x08000692` |
| `0x06004669` | Index16 | 64×64 | clipmap | `0x08000A22` |
| `0x06006E19` | A8R8G8B8 | 32×32 | unreferenced | — |

The five not in the queue item are the same defect class waiting to happen: the
client-side veto (`062e5ce3`) will catch them if the archive ships them opaque
(its `albedoFullyTransparent` guard is class-wide, not id-wide), but the archive
would still be shipping wrong pixels. All seven are permanently `SKIP` — that is the
point of the rule, not a gap.

Also note the two cited records confirm `062e5ce3`'s live blast-radius measurement
from the DAT side: `0x0600396B` hangs off `0x08000157` and `0x060037A3` hangs off
`0x08000015` — *"exactly 2 surfaces vetoed"*, reached independently.

## The laptop invocation (corpus mode)

Paths are arguments; set the four variables and run. Nothing below is compiled into
the tool.

```bash
BASE_DAT=~/ac_base_dats/client_portal.dat
HIRES_DAT=<path to client_portal_hires_repaired.dat>     # optional; overlays BASE_DAT
PNG_LANE=<upscale-corpus>/out/<set>-remacri              # EXACT lane — always include
XU7_LANE=<xubc7-corpus>/<set>-lossless                   # .ktx2
BC7_LANE=<the --tex-bc7 ingest dir>                      # .hbc7
OUT=<report dir>

alpha-audit \
  --dat "$BASE_DAT" \
  --dat "$HIRES_DAT" \
  --corpus "$PNG_LANE" \
  --corpus "$XU7_LANE" \
  --corpus "$BC7_LANE" \
  --out-dir "$OUT"

# the re-bake list:
jq -r 'select(.verdict=="REBAKE") | .id' "$OUT/verdicts.jsonl" > "$OUT/rebake-ids.txt"

# and the census-only pass (no corpus needed, ~2 s):
alpha-audit --dat "$BASE_DAT" --out-dir "$OUT-census"
```

Useful levers: `--only-alpha` (emit rows only for alpha-capable PFIDs; the census
counters still cover everything), `--strict-unknown` (turn an undetermined corpus
alpha into REBAKE), `--ids FILE` (restrict the walk), `--no-dat-sha` (skip the
927 MB hash), `--corpus-hba FILE --corpus-hba-ns holtburger/tex-bc7` (read a
namespace out of an HBA instead of a directory).

**Include the PNG lane whenever it exists.** It is the only exact reader; the KTX2
and HBC7 lanes can prove alpha ABSENT but not present, so a corpus-mode run against
encoded lanes alone will show a large `corpus-alpha-undetermined` count by design.
Outputs: `verdicts.jsonl`, `summary.json`, `PROVENANCE.md` (inputs + sha256s +
buckets + the REBAKE id list).

## Read-verified anchors

Every file:symbol below was opened this session.

* `crates/holtburger-dat/src/file_type/texture.rs` — `SurfacePixelFormat` (the PFID
  values + `Other(u32)` sentinel), `Texture::to_rgba8_impl` (the per-format arms; the
  `A8 | CustomLscapeAlpha` arm emitting `[v,v,v,0xFF]` = D1 below; the `clipmap && idx
  < 8` transparent branch in both the `P8` and `Index16` arms, cited to retail
  `ImgTex::CopyIntoData` acclient.c:365980 / 365958), `Texture::actual_dimensions`
  (JPEG dims live in the SOF, not the header), `to_rgba8_with_palette_override`.
* `crates/holtburger-dat/src/file_type/dxt.rs` — the DXT1 header note *"when `c0 <=
  c1` the 4th index encodes a fully-transparent pixel"* and the `if c0 > c1` branch;
  DXT3 explicit-nibble and DXT5 interpolated-alpha blocks.
* `crates/holtburger-dat/src/file_type/surface.rs` — the module header's
  **"Field-naming gotcha"**: `OrigTextureId` holds a **SurfaceTexture (0x05)** id, not
  a Texture id; `SURFACE_TYPE_TEXTURE_MASK = 0x06`; the `SurfaceType` bit table.
* `external/ACE/Source/ACE.Entity/Enum/SurfaceType.cs` — `Base1Solid=0x1`,
  `Base1Image=0x2`, `Base1ClipMap=0x4`, `Translucent=0x10`, `Alpha=0x100`,
  `InvAlpha=0x200`, `Additive=0x10000`. Mirrored as the `SURFACE_*` constants.
* `crates/holtburger-dat/src/file_type/surface_texture.rs` — `SurfaceTexture::highest_res`
  = last entry of `textures`.
* `crates/holtburger-dat/src/lib.rs` — `DatDatabase::files` (public map, so a
  type-prefix walk is a filter on `id >> 24`), `get_file`, `read_file_data` (uses
  `read_exact_at_compat`, i.e. positional reads on `&self` — which is what makes the
  rayon walk sound).
* `crates/holtburger-dat/src/archive.rs` — `HbaReader::open` / `entries()` /
  `get_file_in_namespace`, `HbaEntry::{file_id, namespace_id, is_pruned}`.
* `crates/holtburger-dat/src/walk.rs:106` — the `orig_palette_id` "typically 0" note
  quoted above.
* `apps/holtburger-tools/src/dat_shard.rs` — `validate_hbc7` (the 20-byte
  `"HBC7" | u32 w | u32 h | u32 blocksX | u32 blocksY` header and the mip-chain walk),
  `parse_hbc7_file_name` / `ingest_tex_bc7_dir` (**the `--tex-bc7` lane ships
  `<rsId>.hbc7`, NOT KTX2**), `ingest_tex_xu7_dir` (`.ktx2`).
* `apps/holtburger-web/scene3d/bc7_textures.js` — `HBC7_MAGIC`, `HBC7_HEADER_BYTES =
  20`, `parseHbc7`'s level walk (the client-side twin of the above).
* `apps/holtburger-tools/src/pack_bake.rs` — `KTX2_IDENTIFIER` and `ktx2_dims`
  (header offsets 20/24 for w/h).
* `apps/holtburger-web/scene3d/xu7_textures.js` — the three lane namespaces
  (`holtburger/tex-xu7`, fallback `tex-bc7`, plus `tex-bc7-pre`).
* `apps/holtburger-web/scene3d/materials.js` (via `git show 062e5ce3`) —
  `albedoFullyTransparent` + the `_maybeUpgradeToBc7` veto site, and the commit body's
  measured facts (the 8×8 DXT1 block contents, Surface `0x08000157`, GfxObj
  `0x0100168B`, Setup `0x020001B3`, "exactly 2 surfaces vetoed"). All independently
  re-measured from the DAT by the tests above.
* `apps/holtburger-tools/src/page_resample.rs` + `src/bin/page-resample.rs` +
  `tests/page_resample.rs` — the house pattern this task copies (pure module / IO bin /
  pinned tests; plan JSON + sha256 + `PROVENANCE.md`; `#[ignore]` real-DAT gates).
* `docs/reengineering/impl/texfix-fringe-2026-08-09.md` — the alpha-fringe episode
  (636 affected, 538 essentially-binary vs 98 partial-alpha, the `tpFrac ≥ 0.30`
  follow-up class) that `effectivelyBinary` and the `punchthrough-softened` flag are
  calibrated against.

## DEVIATIONS

**DEVIATION 1 — the A8 / CUSTOM_LSCAPE_ALPHA alpha plane does NOT come from
`Texture::to_rgba8`,** contrary to the item's "reuse the repo's existing DAT readers"
instruction, which the rest of the tool follows literally.

*Evidence:* `crates/holtburger-dat/src/file_type/texture.rs`, the
`SurfacePixelFormat::A8 | SurfacePixelFormat::CustomLscapeAlpha` arm emits
`[v, v, v, 0xFF]` — greyscale, alpha forced opaque. Read-verified that nothing in the
tree consumes these records as coverage (the only other reader is
`holtburger-dat-write/src/pack/texture.rs:59`, a bits-per-pixel table), so the
convention is harmless for the client but fatal for an alpha audit: it would report
every such record `opaque` and hide precisely the class being hunted.

*What I did instead:* for these two PFIDs the stored byte IS the alpha plane, read
directly, and every affected row is labelled `source: "a8-plane"` so the divergence is
visible in the data rather than only in a comment. A unit test
(`a8_plane_is_the_stored_byte_not_the_greyscale_decode`) asserts BOTH sides — the
audit's gradient classification AND that `to_rgba8` really does return all-255 — so
the divergence can never drift into an accident.

*Measured blast radius:* 102 records (86 `A8` + 16 `CustomLscapeAlpha`), all of which
classify `gradient-alpha`, i.e. they are real coverage masks. Under the naive decode
all 102 would have read `opaque`.

**DEVIATION 2 — corpus mode has not been exercised against a real corpus.** The
corpus/archive lanes are on the laptop's mounted drives, which do not exist on this
box (`~/ac_base_dats/` holds only `client_portal.dat`, `client_cell_1.dat`,
`client_local_English.dat`, `acclient.exe` — and no hires DAT, so the "+ highres if
present in that dir" clause was a no-op here). Corpus mode is therefore pinned by:
the PNG lane exercised end to end against a REAL DAT record in
`cli_corpus_mode_catches_a_dropped_alpha_channel`; the HBC7 lane likewise, as a second
lane in the same run; and the KTX2 reader against synthesized containers only
(`ktx2_vkformat_settles_what_it_can`, `ktx2_etc1s_alpha_is_the_second_sample`). The
first real-corpus run is a laptop job — see Remainder.

## Limits (recorded, not deviations — these are the tool's honest edges)

* **L1 — BC7 alpha content is undecidable without a decode, and the tool does not
  decode.** For KTX2 `vkFormat` 145/146 and for HBC7 payloads containing any mode-4..7
  block, the answer is `undetermined`, not "has alpha". This is a deliberate refusal
  to manufacture evidence, and it is why the PNG lane must be included in the laptop
  run. `--strict-unknown` is the lever for an operator who would rather re-encode than
  ship unverified.
* **L2 — the KTX2 UASTC channel-type table is asserted only in the negative
  direction** (`channelType 0 = RGB ⇒ no alpha`). The alpha-bearing UASTC channel
  codes differ between revisions of the KHR_DF table and I had no real UASTC payload
  on this box to settle it against, so the tool returns `None` rather than a guess —
  and emits `colorModel` + `channelTypes` verbatim on the row so the laptop can
  adjudicate from the evidence. ETC1S (sample-count) and the `vkFormat` table are
  unambiguous and are asserted in both directions.
* **L3 — `--corpus-hba` targets HBA archives.** The deployed dist is a v2 SHARD
  layout (CAS-keyed shards + per-namespace catalogs), not one HBA per namespace, so
  the HBA path covers boot packs / archive files; the primary corpus targets are the
  bake INGEST directories, which is also where a fix has to land to reach a re-bake.
* **L4 — the "unreferenced" bucket is large (15,154) and that is expected**, not a
  walk failure: 12,132 of them are `A8R8G8B8` punch-through, i.e. the icon/UI corpus,
  which is reached by weenie/Layout DIDs rather than by an 0x08 Surface chain. Those
  rows still get a full DAT-truth class; they simply have no clipmap bit to apply
  (correctly — the index < 8 rule is a Surface property).

## Remainder / follow-ups

1. **The re-bake itself (the other half of `TEXBC7-ALPHA-REBAKE`)** — out of scope by
   the task statement. The upscaler still needs (a) preserve the alpha channel and
   (b) skip fully-transparent records. This tool now supplies (b)'s exact id list —
   the seven above — and, after a laptop corpus run, (a)'s.
2. **First real corpus run (laptop).** Invocation is in "The laptop invocation"
   above. Two numbers to read first: `byFlag."corpus-alpha-undetermined"` (if it is
   most of the corpus, the run was pointed at encoded lanes without the PNG lane) and
   `byVerdict.REBAKE`. The 932 alpha-bearing highest-res rungs — and within them the
   609 alpha-bearing `Base1ClipMap` rows — are the population the run should account
   for.
3. **The five newly-found fully-transparent records** (`0x0600415F`, `0x06004161`,
   `0x06004163`, `0x06004669`, `0x06006E19`) should be added to the upscaler's skip
   list alongside `0x0600396B` / `0x060037A3`. The client is already immune
   (`062e5ce3`'s guard is class-wide), so this is an archive-hygiene item, not a
   rendering bug.
4. **The 123 `effectivelyBinary` gradient-alpha records** are the rows most at risk of
   the fringe failure mode being mistaken for legitimate soft alpha in a corpus
   comparison. They currently produce `punchthrough-softened` only when the DAT side is
   strictly binary; a follow-up could widen that flag to `effectivelyBinary` DAT rows
   too. Left alone here because it would change a verdict-adjacent rule without a real
   corpus to measure the effect on.
5. **A real BC7 alpha decoder** would collapse L1 and let the encoded lanes settle
   alpha exactly. Bounded work (alpha endpoints + indices for modes 4–7) but it needs
   a real corpus to validate against, so it belongs on the laptop side.
