# HANDOFF — dat-patch: texture-driven 4× displacement is REAL (session 2026-08-15)

## 0. ADDENDUM — session 2 (2026-08-15 PM): the LEGIBILITY BAKE cracked the A/B problem

Owner verdict: **"ok im actually happy with this now."** What changed and what it supersedes:

- **Why every A/B looked identical (diagnosis, settled):** the ladder optimized pixel-diff %,
  which rewards high-frequency change human vision discards; people judge by silhouette,
  low-frequency shading structure, sharpness, hue. The §3c cavity bake was darken-only ×
  micro-frequency-only (= exposure change + dirt = the gloom direction), and the study
  renderer presented flat-on orthographic crops at ambient 0.30 on near-black. The Remacri
  statics are 2048² vs retail 256² and had never been shown at a magnification where it reads.
- **The legibility bake** (`/mnt/wbterminal2/dat-patch-legibility/`, REPORT.md + legibility.py):
  signed TWO-BAND directional emboss into the Remacri albedo from a fixed top-left UV-space
  convention light — micro band (seam detail) + structure band (timbers/brick courses,
  sigma≈8/128·min(W,H)) + small signed AO term. Gains g_hi 0.35 / g_lo 0.50 / a0 0.15,
  emboss tanh-limited, shade clamped ±0.60 (unclamped = black blotches on masonry).
  **Mean-luminance anchor 1.15× retail** (not 1.02×: arm C's sculpted normals alone cost
  3.5–5.5 % frame luminance; at 1.02× the result came out DARKER than today). All 9 framings
  brighter (+2.4 %–17.4 %). **This replaces §3c's "cavity floor 0.60" in TODO #1**: the texture
  lane bakes the legibility recipe pre-DXT-encode.
- **Per-class de-rates:** saturated/DeepBump-routed height fields (e.g. 0x080006E8 Plank)
  re-draw their own dark streaks as shading — gain 0.45, no AO. The emboss sharpens AC's
  2×2 mirror tiling (cottage chimney) — acceptable, note for the eyeball pass.
- **Presentation standard (use for ALL future owner A/Bs):** identical sunny daylight both
  panels (ambient ≈0.55, warm sun, light-sky bg), three framings (¾ silhouette / window-scale
  close crop / grazing wall), 1080-wide portrait boards stacking TODAY over PATCHED with mean
  luminance printed, plus an 800 ms before/after toggle GIF. Judge by EYE at phone scale;
  pixel-diff % is deprecated as a target metric. Delivery: `tailscale file cp … redmi-note-13-5g:`.
- **Decimator/UV bug FIXED + pilot regenerated on recipe C — 16/16 green.** True root cause
  (measured, supersedes the "cross-polygon merge" hypothesis): `relief3d.finalize` recovered
  UVs/normals by projecting the DISPLACED position back into the source triangle frame, but
  displacement runs along the interpolated authored normal (gfx_subdiv doctrine) and has a
  real in-plane component at smoothed corners/weld rings — texture slides ∝ amplitude
  (0x01002232 @ 0.20 m: 18.4 % of fine faces out-of-frame BEFORE decimation; decimation
  amplified it, worst face 158× source-tri area). Fix in canonical
  `/mnt/wbterminal2/dpc-work/relief3d.py`+`pipeline.py` (synced byte-identical to starkness/
  legibility copies): per-vertex parametric barycentrics carried through collapses (convex
  blend ⇒ registration exact at any amplitude), frames(u)⊆frames(v) collapse guard,
  area-weighted smoothed normals, per-source-tri budget floor (share 0.75). Proof renders
  `/mnt/wbterminal2/dat-patch-decimator/out/` (owner-eyeball-verified: wedges gone). Open in
  DEFECTS.md: faint Gouraud shading strip on 0x01002232 from re-triangulating a wall with
  differing authored corner normals (persists at normal gain 0.0 — not a pipeline bug).
  Pilot: recipe C (amp 0.20 wall classes, smoothstep plinth ramp → 0.11 m at ground, gain
  2.5), validate.py 16/16 green (physics drift 0.0, PORT identical, carries byte-identical),
  2,096 → 8,377 tris (3.99–4.00×). Deployable: `dat-patch-pilot-holtburg/export/` (arm-A
  build preserved as `export.armA/`). Still outstanding: 1070 eyeball pass (TODO #3).
- **Generalizability:** the bake is per-TEXTURE, so every user of a surface — the ~10,700
  skipped small props, dungeon Environments, everything — inherits it for FREE through the
  shared textures. The small-prop "Remacri-only" lane is unchanged and now much stronger.
- **LANDED → reports/client-headroom-dossier.md** (846 lines, read-verified citations).
  Verdict: patching mostly UNNECESSARY. Shipped EOR acclient.exe **already has LAA set**
  (COFF 0x012E; community belief wrong — measure, don't bank: crashes reported near 1.6–2 GB
  anyway). No texture caps: MaxTextureWidth/Height written but never read, no pow2/square
  checks on world textures, DXT passthrough. Geometry: 16-bit index cap 65,535 vs heaviest
  retail GfxObj 1,446 → 12× ≈ 26 % of cap. THREE REAL HAZARDS: (a) boot default
  `EnvironmentTextureDetail=2` (set by Render::Startup BEFORE prefs load) halves every object
  texture on upload AND forces 2-entry SurfaceTextures to the low-detail entry — defeat via
  `Render.EnvironmentTextureDetail = 0` + single-entry records (surface-texture-collapse
  exists); (b) **degrade trap**: replacing a GfxObj that carries GfxObjDegradeInfo is
  COMPLETELY INVISIBLE (LoadGfxObjArray never inserts the root mesh; band 0 usually a
  different object; 4,131 records, 68 % real swaps) — bake-time data fix required; (c) the
  **2 GiB DAT ceiling** (bit 31 of block offsets = free-block flag; DiskDev::SyncRead signed-32
  seek) fails SILENTLY and is not byte-patchable. Highest-value patch: **trevis's
  one-instruction DAT-compression fix** (DiskController::Decompress zeroes m_iVersion →
  AsyncCache::SerializeFromCachePack gate) — measured 49.97 % portal.dat saving, turns
  194 MiB margin into ~636 MiB; patch-and-diff harness exists at /mnt/wbterminal2/ac-eor-patch/.
  ⚠ acclient.c and acclient.map are DIFFERENT BUILDS (~0x60 apart in the DAT region, exe
  matches neither) — locate all patches by byte-signature, never quoted address.
- **Community cross-check LANDED → reports/discord-headroom-crosscheck.md** (Discord
  archive sweep + local PE verification). CORRECTIONS to the dossier: retail did NOT ship
  LAA (paradox: "we didn't during retail") — our ac_base_dats/acclient.exe is an
  already-4GB-patched copy (COFF 0x012E verified this session; checksum validation can't
  detect ntcore-style patches). trevis's compression fix fully corroborated WITH the
  author's measured numbers — but whole-set saving is **40.2 %** (cell_1 only 10.8 %),
  zlib must be 1.2.2, paradox warns the m_iVersion zeroing may be a deliberate workaround
  for another bug, and no patch bytes were ever published (derive by byte-signature;
  Yonneh's release_client.exe.map attachment is the offset goldmine). New decomp leads
  from the community: `Render::ShouldDropHighDetail()` gates ImgTex::GetSurfaceDID, and
  **ImgTex::CreateD3DTexture caps mips at 4 levels**. Degrade invisibility trap: nobody
  has ever hit it — we'd be first; keep the bake-time degrade fix mandatory. OOM band
  1.6–1.8 GB is leak-driven (icon-gen unfixed; palette leak fixed by notan; D3DXMesh
  suspected) — 4GB flag helps dats headroom but measure, don't bank.

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

### 4a. ADDENDUM — the TRANCHE RUNNER exists (2026-08-15, session 3)

`tools/dat-patch/tranche.py` + `driver_buildbox.sh` productionise TODO #5/#6 for
the **static-architecture lane**; `tools/dat-patch/README.md` has the usage.  The
geometry recipe is unchanged (recipe C is *imported* from `pilot.py`, one copy).

- **The tranche, measured.** `enumerate` walks all **5,346** LandBlockInfo
  records and takes both static lists — `buildings[]` (398 models / 6,979
  placements) and `objects[]` (1,475 / 42,942) — resolving Setups to parts:
  **1,921 distinct GfxObjs**, i.e. r2 §6.3's "~2,000 large statics" exactly.
  **881** clear the ≤50-tri long-tail cut; the surface gate and the degrade guard
  cut from there.  Per-record multiplier is r2's 4–6× band, ramped on the vertex
  spacing 4× would buy (>1.5 m → 6×, >0.9 m → 5×, else 4×).
- **v1 DEGRADE POLICY (mandatory, dossier §5a).** No degrade record → patch.
  Degrade record whose **band 0 is this record** → patch (the nearest band
  resolves to it; bands 1+ stay retail, which is the intended LOD).  Band 0 a
  **different** object → **EXCLUDE** and write it to `degrade_deferred.json` with
  its band object ids, for a follow-up lane that patches band objects directly.
  Re-checked inside `build` so a hand-edited manifest cannot slip one through.
  Over the tranche: **1,310 carriers, 1,301 of them their own band 0, 9
  deferred** — the guard is nearly free and the 9 would have been invisible bytes.
  (It also explains why the pilot was visible: all 16 are band-0-self carriers.)
- **NEW IMPORTER BUG found and fixed by the tranche smoke** (`CommandEngine.cs`,
  obj-import): the original-drawing carry was gated on `rebased`, which was
  gated on the record HAVING PHYSICS.  **388 of the 881 candidates (44 %) ship
  drawn polygons with no physics section at all** — on those, every original
  drawn polygon was dropped and the record came back as the displaced shell
  alone (holes wherever the gate refused a surface), under `success:true` with
  `drawingCarried:false`.  The rebase now runs whenever the original has a
  vertex array; `validate.py` check H catches this class, and did.
- **Throughput/plumbing:** `--jobs N` (spawned pool — forked workers share the
  dat fd and race on `seek`), per-**RenderSurface** height warm-up before the
  fan-out (TODO #5), resumable `build` (sha256 over base record bytes + every
  recipe knob in `state/<gid>.json`; `imports.jsonl` rebuilt from state so a
  killed run still emits a complete batch), `--plan plan.json` byte budget at
  106 B/added-tri that stops cleanly and lists every dropped record in
  `budget_dropped.json`.  `validate.py` now takes `--root` and **exits non-zero**
  on contract failures; all external paths in `matlib`/`gfxlib`/`pipeline` are
  env-overridable so the modules run on a box with no `/mnt/wbterminal2`.
- **Smoke (this laptop, `--jobs 1`, `/mnt/wbterminal2/tranche-smoke/`):**
  enumerate over the Holtburg window → 108 candidates, 27 displace, 66
  long-tail, 15 gate-refused, 0 deferred; a second enumerate over LBs 47–48,2C–2E
  exercised the exclusion path (3 deferred, band objects listed).  Build of
  exactly 2 records — `0x01000F68` (no degrade, no physics) and `0x0100081C`
  (degrade carrier, band 0 == self) — imported through WBT and `validate.py`
  green on both after the importer fix.
- **Still unfinished:** no full-world run has been executed (that is the
  buildbox driver's job — budget ~60 CPU-h in Python per TODO #5); the
  degrade-deferred follow-up lane (patch band objects directly) is not built;
  `tranche.py` covers architecture only — dungeons (TODO #4) and creatures still
  need their own lanes.

## 5. REPRO

`/mnt/wbterminal2/dat-patch-pilot-holtburg/`: `pilot.py enumerate` → `pilot.py build` →
WBT `--stdin -p proj/pilot.wbproj < imports.jsonl` → `validate.py` → `gallery.py`.
Defect forensics: `DEFECTS.md`, `diag.py`. Base dats `~/ac_base_dats/` read-only; all work
on copies under `/mnt/wbterminal2/`.
