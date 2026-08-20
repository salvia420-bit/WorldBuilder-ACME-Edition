# tools/dat-patch — the DAT relief + legibility pipeline (vendored 2026-08-15)

Vendored from the /mnt/wbterminal2 working dirs after the decimator fix
(barycentric carry — registration exact at any amplitude) and the legibility
bake landed.  Provenance: `dpc-work/` (core), `dat-patch-legibility/` (bake +
sunny renderer, newest render3.py), `dat-patch-pilot-holtburg/` (runner,
validator, gallery).  All shared modules were byte-identical across dirs at
vendor time except render3.py (legibility copy is canonical).

Doctrine and results: `docs/dat-patch/HANDOFF-dat-patch-2026-08-15.md` (§0
addendum = legibility bake, decimator root cause, client-headroom findings)
and `docs/dat-patch/reports/`.

## Layout
- Core: `gfxlib matlib datlib objlib pipeline relief3d db_height common
  r2lib board render3` — gate → seam/DeepBump height → subdivide → displace →
  QEM (provenance-guarded, barycentric-carried) → UV/normal finalize.
- Bake: `legibility.py legboards.py rebuild_boards.py diag_split.py` — the
  two-band mean-luminance-preserving emboss (g_hi 0.35 / g_lo 0.50 / a0 0.15,
  anchor 1.15× retail) + phone-board renderer.  `ladder.py` = the superseded
  starkness study (kept for reference; its darken-only cavity_bake is retired).
- Pilot: `pilot.py validate.py gallery.py diag.py` — Holtburg 16-building
  runner + the validation contract (physics drift 0.0, PORT counts, carries
  byte-identical).  Recipe C: amp 0.20 wall classes, plinth ramp → 0.11 m at
  ground, sculpted normals gain 2.5, 4× budget.
- Tranche: `tranche.py driver_buildbox.sh` — the production runner that scales
  the pilot to the world's static architecture (see below).  Recipe C is
  imported from `pilot.py`, so there is exactly one copy of it.
- Planner: `budget_planner.py` — headroom knobs (measure target dats;
  budget = ceiling − measured − reserve; default reserve 300 MiB).  Run this
  against the SERVER'S dats, never assume base sizes.
- Tripwires: `walk_check.py` (client-semantics b-tree/free-chain walk),
  `fix_degrade_chains.py` (the F1 degrade-chain invariant + its fixup — see
  below) and `color_ledger.py` (the I8 colour tripwire vs retail — see below).
  All are read-only by default and exit nonzero on violation, so a driver can
  call them after every portal-mutating step.
- Take driver: `r7_take5.sh` — the r7.1 take-5 driver (deblock rebake + colour
  anchor + colour ledger + degrade-chain fold).  Takes 1–4 live in
  `/mnt/wbterminal2/dat-patch-r7/r7_driver{,2,3,4}.sh` for provenance; take 5
  onwards is versioned here.
- `data/table.json` — the surface-class gate table.
- Kit (`kit/`) — everything the PLAYER touches, added 2026-08-19 for r8:
  `assemble_kit.sh` builds a shippable kit dir from built dats (sha-verifies every
  copy, generates `kit-manifest.txt` + `SHA256SUMS.txt` + `README.txt`, self-gates
  with play.bat's own rule, packages the tgz); `acme-patch-client.ps1` +
  `patch-my-client.bat` patch the player's OWN `acclient.exe` (the kit ships no
  client bytes — community-norms.md); `play.bat` is the fresh-install loud-fail
  launcher; `check_ps1_table.py` gates the patcher's table against the (untracked)
  `patch_client.py` registry AND proves the result is byte-identical to the
  in-client-gated exe — `assemble_kit.sh` refuses to run without it; `kit-gate.ps1`
  is the 14-arm headless Windows gate for both mechanisms.
  ⚠ `play.bat` deliberately avoids parentheses in message text and does every file
  test in a subroutine: cmd parses a whole `( … )` block at once, so a `)` inside
  an expanded variable silently mangles the block (that defect let a truncated dat
  pass as OK — reports/r8-kit-assembly-2026-08-19.md).
- `DatDeleteRepro/` — synthetic repro for DRW's `Tree.TryDelete` b-tree corruption
  (upstream-drw-btree-delete-fix.md). **No tool in this lane may call TryDelete**;
  DatHifiSplit builds by reconstruction instead.

## The degrade-chain invariant (`fix_degrade_chains.py`)

A SurfaceTexture (0x05) is a *degrade chain* of RenderSurface (0x06) ids,
highest detail first; `RenderTexture::DropUnwantedLevels` (acclient.c:137195)
drops the leading levels per the "Environment texture detail level" preference
and is a **no-op once the chain has ≤ 1 entry**.  So every chain that names a
baked 0x06 must be collapsed to exactly that one id, or a retail-detail sibling
can still top the stack on an install that mounts a real `client_highres.dat`.

    for every 0x05 whose chain contains a baked 0x06:  len(chain) == 1

r7 shipped **one** violation (`0x05000ECE`) — the importer keyed its collapse
list on the *SurfaceTexture*, and two 0x05s shared one retail chain, so the twin
was missed (`docs/dat-patch/reports/degrade-chain-audit-2026-08-17.md` §4).
`fix_degrade_chains.py` therefore groups every 0x05 **by its exact chain tuple**
and acts on the whole group; a shared chain cannot be half-fixed again.

```sh
FDC=$REPO/tools/dat-patch/fix_degrade_chains.py
# driver fixup stage, after the lanes, BEFORE the final compress/compact
python3 $FDC $PORTAL --fix --retail $BASE --wbt $WBT --json $R7/degrade-fix.json \
  || { echo "DEGRADE-CHAIN FIXUP FAILED"; exit 8; }
# ship gate: read-only, on the final packaged portal
python3 $FDC $PORTAL --check --retail $BASE \
  || { echo "DEGRADE-CHAIN TRIPWIRE FAILED"; exit 8; }
```

Placement, not decoration: run the fix *after* every lane has written (the
baked set is only complete then) and *before* the final `compress`/`compact`,
so the block churn from the rewrite is absorbed by the compact.  Then re-check
the packaged file.  Both calls are wired into `r7_take5.sh` (stages 4 and 5);
the fix is idempotent — an already-collapsed chain reports `ALREADY-SINGLE`,
and `--fix` re-analyses after writing and exits nonzero on any residue.  Unlike `walk_check.py` this is **not** cheap enough to run
after literally every step on a spindle — a cold `--check` over the 1.5 GB r7
portal is ~1.4 s of CPU but ~10 min of wall, all of it seeks — so two calls per
take (fixup + ship gate) is the intended cadence.  `--baked-ids` skips the
retail compare entirely and makes a check take seconds, but a list dumped
before the lanes ran is **stale by construction**; only reuse one that was
dumped from the same dat you are checking.

The rewrite is delegated to WBT's `surface-texture-collapse` (DatReaderWriter
2.1.8 `TryWriteFile`) — the same write path the lanes already use for the 1,400
chains they *do* collapse; this tool only fixes the selection.  "Baked" is
derived by byte-comparing the patched 0x06 records against retail; by default
only the ids named by multi-entry chains are resolved (a few thousand, with an
uncompressed-size shortcut before any inflate) because the invariant can never
depend on the rest.  `--full-baked` reproduces the audit's whole 2,412-id set,
`--baked-ids FILE` accepts a precomputed list, `--dump-baked FILE` writes one.

## The colour anchor and its ledger (`color_ledger.py`, I8)

Every baked RenderSurface is exposure-anchored to RETAIL inside
`legibility.bake_texture`: `mean_lum(shipped) = LUM_TARGET (1.15) ×
mean_lum(retail)`.  Three rules keep that guarantee real:

1. **The reference is retail, never a processed source.**  `matlib.tex_path`
   takes `allow_deblock=False` for the anchor's base load, so a mounted
   `DATPATCH_DEBLOCK_BASE` filters the *shipped albedo and the height pass*
   without ever becoming the thing we measure against.
2. **Both sides are averaged over the same texels.**  The Remacri corpus comes
   back fully opaque with the cutout filled by whatever the upscaler painted;
   the real alpha is transplanted back only after the bake.  Averaging the
   reference over its cutout and the candidate over the whole frame is what
   shipped 160 of r7's 2,192 bakes outside a ±15% band (0x060066B8 went out as
   a pure-white silhouette at a solved gain of 16.45×).  The reference's alpha
   now defines the population for both.
3. **`DATPATCH_COLOR_ANCHOR`** selects the anchor: `lum` (r7 semantics),
   `rgb` (per-channel means), `rgb+sat` (adds a chroma scale matching retail's
   mean saturation).  r7.1 ships `rgb+sat`.

```sh
CL=$REPO/tools/dat-patch/color_ledger.py
# gate stage: after the lanes bake, BEFORE anything is imported/compacted
python3 $CL --baked $R7/dungeons/baked,$R7/doors/baked,... \
  --retail-dir $DATPATCH_TEX_BASE --jobs 3 --json $R7/color-ledger.json \
  --gate --min-records 1500 --sat-median-lo 0.95 --cast-p99 0.05 \
  || { echo "COLOUR LEDGER TRIPWIRE FAILED"; exit 7; }
```

Defaults are calibrated against the shipped r7 corpus and the raw A-arm (see
`docs/dat-patch/reports/color-anchor-2026-08-18.md`).  Placement matters: a
colour regression is a *bake* fault, so the ledger runs on the bake artefacts —
catching it there costs a re-bake, catching it at the eye-test costs the take.

`texture_lane.py` also refuses to reuse a `baked/` directory stamped with a
different corpus/anchor (`bake-config.json`); `DATPATCH_BAKE_CACHE=1` over a
warm dir from a previous take would otherwise ship the old pixels silently.

## External data (NOT vendored)
- Base dats: `~/ac_base_dats/` (read-only; on buildbox too).
- Remacri upscales: `/mnt/wbterminal2/upscale-corpus/out/statics-remacri/`
  (2,931 × 2048² PNG, 2.9 G) — texture lane only; geometry lane needs none.
- DeepBump fallback model: `deepbump256.onnx` (25 MiB) — geometry lane,
  ML-routed surfaces only; path via `DEEPBUMP_ONNX` env or db_height.py.
- Caches (hcache/dbcache/project.db) are per-run artifacts — never vendor.

## Invariants (violate = silent corruption; see handoff §2/§3)
- Physics untouched: original VertexArray verbatim, physics polys id-stable.
- Every original drawn polygon carried byte-identical at its original key;
  PORT node counts identical; NoPos fillers carried, never re-emitted.
- Displacement along interpolated authored normals; UVs from CARRIED
  barycentrics (never back-projection).  Boundary edges clamped.
- Run `validate.py` on EVERY patched dat set; gallery right-panels read back
  from the exported dat.
- **Never patch a GfxObj whose degrade band 0 is a different object** — the
  client draws band 0, never the root mesh (dossier §5a).  `tranche.py`
  enforces this in both `enumerate` and `build`.

## The tranche runner (`tranche.py`)

Generalises `pilot.py` past the hardcoded Holtburg 18 to the ~2,000-record
static-architecture lane of `concepts-r2-REPORT.md` §6.3.

```sh
R=/mnt/wbterminal2/tranche-run          # holds proj/dats/base + the run outputs
python3 tranche.py enumerate --root $R --jobs 3          # + --window A6-AC,B1-B7
python3 tranche.py build     --root $R --jobs 3 --plan plan.json
dotnet .../WorldBuilder.Terminal.dll --stdin -p $R/proj/tranche.wbproj < $R/imports.jsonl
python3 validate.py --root $R                            # exit 0 == contract green
```

`enumerate` walks every LandBlockInfo in `client_cell_1.dat`, takes both
`buildings[]` (class *building*) and `objects[]` (class *structure*), resolves
Setups to parts, and routes each GfxObj:

| route | meaning |
|---|---|
| `displace` | in the tranche; carries `mult` (4–6× per r2 §6.3, ramped on the vertex spacing 4× buys) and `plannedAddedTris`/`plannedBytes` |
| `skip-small` | ≤ `--min-tris` (50) — r2's long tail, the texture lane covers it |
| `skip-degrade` | **degrade band 0 is not this record** → written to `degrade_deferred.json` with its band object ids |
| `skip-gate` | the surface gate refused every surface (nothing to carve) |

Measured on the retail dats: 5,346 LBInfo records → 1,921 distinct static
GfxObjs → 881 over 50 tris → the gate and the degrade guard cut from there.
(World-wide degrade-deferred: 5.)

### Buildbox validation run (2026-08-15, Holtburg window A6-AC,B1-B7)
First end-to-end box run (us-central1-b, seam-only lane — DeepBump venv not
shipped, matlib's graceful fallback): 108 candidates → 27 displace / 66
skip-small / 15 skip-gate / 0 deferred / 0 errors. `validate.py`: **25/27 green**;
all 27 pass the correctness invariants (physVertexPosDrift/NrmDrift = 0.0, PORT
counts equal, origPolysCarried byte-identical), cell dat size-identical with
**0 unexplained words**, portal +768 KB. The 2 non-green are `shellDisplacedOk`
only — maxShellDisp 0.013 / 0.017 m, just under the 0.02 m "meaningful
displacement" guard: weak-seam surfaces whose relief needs DeepBump (off on the
box) or should be gate-skipped rather than spent. NOT corruption. Two v1
refinements this exposes for the world run: (a) ship the DeepBump venv to the box
for ML-fallback parity with the pilot, or (b) have the router demote a surface to
skip-gate when seam's carved fraction predicts sub-threshold displacement, so no
triangles are spent on an invisible carve. The GPU is irrelevant to this lane
(pure-CPU numpy); a full `WINDOW=world` run is ~60 CPU-h (≈20 h wall at --jobs 3
on n1-standard-4), preemption-resumable via phase + `state/<gid>.json` stamps.

`build` runs recipe C per record, emits `obj/<gid>.obj` + `imports.jsonl` +
`build_stats.json`, and is **resumable** — `state/<gid>.json` records a sha256
over the base record bytes and every recipe knob, so a killed run resumes and
still writes a complete import batch.  `--jobs N` uses a *spawned* pool (forked
workers would share the dat file descriptor and race on `seek`).  Height fields
are computed once per **RenderSurface** in a warm-up phase, then memoised inside
each worker (`pipeline.memo_enabled`).

`--plan plan.json` (from `budget_planner.py`) caps the geometry spend at
`--bytes-per-tri` (106 B measured) × added triangles.  Records are taken in
value order (placements, then size); the first that does not fit stops the run
and every remaining record is written to `budget_dropped.json`.  No silent caps.

Useful flags: `--window X0-X1,Y0-Y1` (tile box), `--only 0x…,0x…`, `--limit N`,
`--geometry-budget-mib`, `--min-tris`, `--max-segments`, `--hcache DIR`.
All external paths in `matlib`/`gfxlib`/`pipeline` are env-overridable
(`DATPATCH_PORTAL`, `DATPATCH_CELL`, `DATPATCH_HCACHE`, `DATPATCH_TEX_BASE`,
`DATPATCH_CURATED_JSON`, …) so the same modules run on a box with no
`/mnt/wbterminal2`.

### The degrade guard (mandatory)
`client-headroom-dossier.md` §5a: `CPhysicsPart::LoadGfxObjArray` fills the draw
array *exclusively* from the degrade bands — the root GfxObj is never inserted
at any index, band 0 included.  Patching a carrier whose band 0 is a different
object is invisible at every distance.  v1 policy: no degrade record → patch;
band 0 == self → patch (the nearest band resolves to this record); band 0 ≠ self
→ **exclude** and list it in `degrade_deferred.json` with its band object ids
for the follow-up lane.  Over the 1,921-record tranche: 1,310 carriers, 1,301 of
them their own band 0, **9 deferred**.

### `driver_buildbox.sh`
Detached (`setsid nohup`), absolute-path, resumable driver for the whole run:
build WBT if the DLL is absent → enumerate → build `--jobs 3` → WBT batch
import+export → `validate.py` → `tranche.tgz` + `.sha256` + `~/TRANCHE_DONE`.
Each phase drops a stamp in `$ROOT/stamps/`; re-running skips finished phases
(`FORCE_PHASE=build` re-runs one).  It resets `proj/project.db` at the start of
the import phase (the stale-staged-state trap).  It starts no daemon and never
touches git.

```sh
ROOT=/mnt/data/tranche JOBS=3 PLAN=/mnt/data/plan.json \
  /path/to/tools/dat-patch/driver_buildbox.sh      # returns immediately
tail -f /mnt/data/tranche/driver.log
```
