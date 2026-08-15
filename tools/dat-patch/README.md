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
