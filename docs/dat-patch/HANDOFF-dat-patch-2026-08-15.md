# HANDOFF — dat-patch: texture-driven 4× displacement is REAL (session 2026-08-15)

Supersedes the ordered TODO in `HANDOFF-dat-patch-2026-08-14.md` (whose §0 course
correction this session executed). State: **the pilot is done and validated** — a
patched portal.dat with 16 Holtburg buildings at 4.00× texture-driven relief, physics
byte-identical, portal linkage intact, round-trip proven.

## 1. WHAT SHIPPED THIS SESSION

- **Course correction executed** (owner directive): 10×-everywhere → **4× texture-aware**.
  Subdivision without displacement is invisible under Gouraud; the (fixed, final) Remacri
  textures are the placement reference. Assembled method, working prototype in
  `/mnt/wbterminal2/dpc-work/`:
  surface gate (vetoes → class table `/mnt/wbterminal2/gfx-material-agent/table.json`)
  → `seam` height field on the BASE texture ("base for height, Remacri for pixels";
  DeepBump ONNX fallback when seam carves <0.08) → subdivide 12–16 seg/edge, displace
  outward along authored normals, boundary-edge clamp (gfx_subdiv.rs doctrine) → QEM
  decimate to budget, original vertices locked → UVs recomputed in the source triangle's
  frame (texture registration by construction). Gate-refused: PN tess (needs max-deviation
  guard) or facet op. **Image delta saturates ~25 grey levels from 2×–64×: 4× is the knee.**
- **Two Opus 5 concept rounds** (reports vendored: `reports/concepts-r1-REPORT.md`,
  `concepts-r2-REPORT.md`): r1 proved server-spawned objects inherit DAT patches for free
  (client resolves SetupTableId from its own portal.dat; decomp-verified) and surfaced the
  cell-dat bloat; r2 assembled and proved the texture-driven method on 10 objects.
- **Holtburg pilot batch** (`/mnt/wbterminal2/dat-patch-pilot-holtburg/`): 16/18 building
  GfxObjs patched (2 gate-refused, all-Flush), 2,096 → ~8,380 drawn tris (3.98–4.00×),
  ~106 B/added-tri, iteration bumped. `export/` = the deployable dat set.
- **Three importer/exporter bugs found and fixed** (WorldBuilder C#):
  1. *Collision corruption* — obj-import overwrite reassigned VertexArray ids while physics
     polys index that shared array by id (up to 17.66 m hull drift, invisible to byte-level
     polygon checks). Fix: original VertexArray carried VERBATIM, new render vertices
     appended. ⚠ All three r1 dat sets (`dat-patch-opus/-reliefgen/-smoke`) are
     collision-corrupt — regenerate or retire.
  2. *Cell-dat bloat root-caused* — `DatExportFixer.FixLeafBranchSentinels` followed garbage
     block-chain pointers and its fixup write zero-extended client_cell_1.dat by 1.46 GB.
     Fix: chains validated (in-bounds, 256-aligned, cycle-guarded) before any I/O. With the
     runaway gone the real work completes (5,780 cell leaf sentinels fixed).
  3. *Drawing-geometry discard* (the "white doors/windows" defect) — overwrite dropped the
     NoPos portal-filler quads' flags (OBJ cannot carry stippling) and rebuilt the drawing
     BSP with **zero PORT nodes** (decomp: `CGfxObj::InitLoad` → `BSPTREE::RemoveNonPortalNodes`
     keeps exactly the PORT chain — that IS interior visibility through openings). Fix:
     obj-import overwrite carries every original render polygon verbatim at its original key
     + the original drawing BSP, and appends imported tris at fresh keys (retail renders from
     the flat polygon dict, so appended tris need no BSP membership). Pipeline side: OBJ ships
     ONLY the displaced shell (`carved_only`, 6 mm floor so it never goes coplanar with the
     carried original behind it).

## 2. THE VALIDATION CONTRACT (validate.py — run it on EVERY patched dat)

16/16 green on the pilot. Per model: parses in two independent parsers (dpc-work gfxlib +
WBT chorizite-parse-dat-record); physics polys field-identical AND physics-referenced vertex
pos/normal drift exactly 0.0; surface table original-prefix; **H** every base drawn polygon
carried byte-identical at its original key (fillers included, flags intact); **I** PORT node
count identical to base; **J** max appended-vertex displacement > 0.02 m (guards silent
zeroing — the r2 PRE_BLUR saturation bug class); cell dat size-identical with every differing
word classified (0 unexplained). Gallery right-panels must be READ BACK from the exported dat.

## 3. TRAPS (this session's tuition)

- **Silent-invisibility rides on polygon flags, not surfaces** — never re-emit NoPos fillers
  through OBJ; carry them.
- **Byte-identical ≠ semantically identical** — physics polys were byte-identical while their
  vertex ids resolved 17 m away. Validate RESOLVED positions.
- **A 4 cm relief is sub-pixel on a whole-building frame** — galleries need close-crop
  grazing-light rows; "identical" A/Bs may be framing, check the bytes first (diag.py).
- **Stale `project.db` poisons re-runs** — after a bad batch, reset the staged state or the
  bad records become "original".
- **seam `PRE_BLUR` must scale with resolution** (`sigma = 0.6·min(w,h)/128`) or it saturates
  on 512²/Remacri and carves blank walls rigidly (= no-op displacement that still spends tris).
- **~6% of GfxObj records ship all-zero SWVertex normals** (causeway modules 100%) —
  synthesize angle-weighted normals before displacement and store them.
- Agent-notification wakeups can silently fail after long background jobs — arm a file-based
  Monitor on the deliverables (and don't let its pgrep pattern match its own cmdline).

## 3b. CODE REVIEW (high) — 10 findings, ALL FIXED and re-verified

The drawing-carry change was reviewed and hardened. Severity order: null-DrawingBSP could
destroy a record on disk while reporting success (SetEntry swallows the pack exception into
a zero-byte entry — now guarded loudly); the carry duplicated every original face on the
relief-plan-apply / export→edit→reimport workflows (now deduped by fan-triangle signature
with UV-slot canonicalization: cottage = 155 polys = 53 orig + 102 added, was heading for
245); repeated overwrites accumulated geometry unboundedly (carry source is now the BASE dat
record, staged entries discarded with a warning — double-import proven byte-identical to
single); plain overwrite and bsp-build now WARN when they'd drop PORT nodes (real fix for
BspGenerator PORT preservation is a TODO); obj-import JSON now returns `drawingCarried`,
`duplicatesDropped`, `totalDrawnPolygons`, `warnings`; `triangleCount` means imported-mesh
triangles again; shared `SeedMergedFromOriginal`/`KeyRangeFits` helpers replace drifted
copies (off-by-one guard fixed); the discarded BSP build is now skipped (`buildBsp` flag).
Post-fix: build 0 errors, pilot re-ran 16/16 green, export/ replaced with the green re-run.
Known pre-existing, untouched: BspBuild mutates a possibly-cached DAT-resident object in place.

## 3c. STARKNESS LADDER (owner: "still not stark enough") — the texture is the starkness lane

5-arm cumulative study (`/mnt/wbterminal2/dat-patch-starkness/`, LADDER.md), pixel-diff %
vs retail (close/street): A pilot-as-shipped 26/9 · B amp→0.20 m 25/12 · C +sculpted
normals (gain 2.5) 33/15 · D +cavity-baked Remacri (floor 0.60) **62/21** (0x01000C17:
**76/11**) · E +r1 silhouette ops 69/23. Conclusions: amplitude alone is nearly flat —
the "identical" look is Gouraud physics, not tuning; normal sculpting is free contrast
(retail lights from STORED normals); **cavity-baked albedo is the only "immediately
noticeable" arm** and ships via the texture lane, which is therefore promoted to top
priority alongside the eyeball pass. Production recipe: ship C in the geometry lane now
(amp 0.20 above plinth height, 0.10–0.12 at ground level — at 0.20 a wall overhangs its
footing and collision divergence doubles the design bound; openings stay clean), add D when
texture injection lands, reserve E for landmarks (plan ops + carve need ONE shared budget —
the E arm ran 8.5×). Trap: r1-imported records read back as sides=Clockwise+NoNeg and trip
two-surface-sheet exclusion in consumers — un-pin explicitly (or importer should write sides=0).

## 4. ORDERED TODO

1. **Texture lane bring-up — PROMOTED** (was #6; the ladder proved it carries most of the
   visible win): DXT1/5 encoder + budget planner + t2quant INDEX16 lane + **seam-cavity
   bake into the Remacri albedo pre-encode** (floor 0.60, carved surfaces only; shared
   textures affect all users of a surface — verify no pathological cases). DXT re-encode
   with no up-res SAVES ~193 MB.
2. **Geometry recipe C into the pilot** — amp 0.20 above plinth / 0.10–0.12 at ground,
   sculpted normals gain 2.5; regenerate the pilot export with it.
3. **1070 eyeball pass** (batched, per house rules): retail client + ACE on
   `dat-patch-pilot-holtburg/export/` — confirm portal visibility through openings in-client
   and the 6 mm shell floor against real D3D9 z-precision at distance.
4. **`environment-import`** — the dungeon lane (best value-per-byte: 772 Environment records
   = 6 MiB source, 735k EnvCell instances; r2's cave A/B was the owner's standout). Dungeon
   geometry is PORTAL-dat Environment (0x0D) records; CellPortal polys stay pinned; DRW packs
   Environment/CellStruct and `PortalDatDocument.SetEntry<T>` stages it — build the command on
   the fixed obj-import template.
5. **Throughput**: ~2 min/building in Python (~60 CPU-h for the ~2,000-static architecture
   tranche) — fan out on the buildbox or port the decimator to Rust. Add the per-RenderSurface
   height-field cache first (fields are per-texture, not per-record).
6. **Tranche plan** (r2 feasibility): architecture 4–6×, dungeons 6–10×, ~300 landmarks 8–12×
   via artist plans, creature PN tess (with max-deviation guard), skip the ~10,700 ≤50-tri
   props; texture lane budget after geometry: ~970 MiB.
7. **Regenerate or retire the collision-corrupt r1 dat sets** (`/mnt/wbterminal2/dat-patch-{opus,reliefgen,smoke}`).

## 5. REPRO

`/mnt/wbterminal2/dat-patch-pilot-holtburg/`: `pilot.py enumerate` → `pilot.py build` →
WBT `--stdin -p proj/pilot.wbproj < imports.jsonl` → `validate.py` → `gallery.py`.
Defect forensics: `DEFECTS.md`, `diag.py`. Base dats `~/ac_base_dats/` read-only; all work
on copies under `/mnt/wbterminal2/`.
