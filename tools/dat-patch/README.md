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
- `data/table.json` — the surface-class gate table.

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
