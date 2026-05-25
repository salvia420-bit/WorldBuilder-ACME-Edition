# Cell-Portal Graph Parity Method (Wave 5.A)

Companion to [`wire-conformance-method.md`](wire-conformance-method.md) (Wave 1),
[`dat-parity-method.md`](dat-parity-method.md) (Wave 2.A/B/D),
[`enum-parity-method.md`](enum-parity-method.md) (Wave 2.C),
[`physics-parity-method.md`](physics-parity-method.md) (Wave 3.A/B/F), and
[`motion-parity-method.md`](motion-parity-method.md) (Wave 3.C).

This doc covers the **cell-portal graph + PVS visibility slice** of Wave 5 per
the [diagnostic toolset plan](diagnostic-toolset-plan-2026-05-19.md) §3 row 12
and §6 Wave 5 W5.A.

Status: **shipped 2026-05-20**.

**Status update (2026-05-25):** added §"Known scope gap (added 2026-05-25):
LandCell↔EnvCell visibility + runtime PView" below — captures a real
gap surfaced live in Holtburg via wire-agent probes
(`/mnt/wbterminal1/tmp/claude-scratch/envcell-contamination-2026-05-25/`).
Validator unchanged.

## The contract

For every landblock `lb` in a sampled cohort, every directed portal edge
in `lb`'s `EnvCell` records must have a matching reverse edge:

```
∀ (A, B, polyA, polyA_idx) ∈ Portals(lb)
  where A.flags & PortalFlags.NoOtherCell == 0  AND  B != 0xFFFE:

    Portals(B)[A_portal.OtherPortalId].OtherCellId == A
```

For every cell `c` and BFS depth `N`:

```
BFS_N(c) ⊆ DatVisibleCells(c)
```

i.e. the live BFS-N visibility set is a **subset** of the dat's precomputed
`VisibleCells` array (which is the depth=∞ transitive closure baked at retail
content-build time).

## Why this method exists

Asheron's Call's indoor rendering pipeline (cottages, dungeons, towers)
relies on a **per-cell visibility graph** baked into `client_cell_1.dat`.
Each `EnvCell` record carries:

1. **`CellPortals[]`** — outgoing portal edges to other cells in the same
   landblock.
2. **`VisibleCells[]`** — precomputed PVS (potentially visible set) — every
   cell reachable from this one through the portal graph, depth-unlimited.
3. **`Surfaces[]`** — the cell's drawable geometry.

The retail engine's `CEnvCell::recursively_get_object` (acclient.c:349403)
walks `CellPortals` recursively with a visited-set gate to find objects.
The renderer uses `VisibleCells` to PVS-cull non-visible cells per-frame
(`PView::OtherPortalClip` at acclient.c:9939).

**If the portal graph is asymmetric**, the live BFS walk may visit cells
the dat's PVS doesn't list — surfacing as "invisible wall" rendering
artifacts or as collision objects becoming unfocusable when the player
moves through a one-way portal in the wrong direction.

**If the dat's `VisibleCells` is missing cells the BFS reaches**, the
renderer may cull cells the player should see — surfacing as the
"missing cottage interior" class of bug.

Our holtburger-web port pipelines through the same DAT bytes via
`fetchEnvCellsInLandblock` (wasm) → `cells.js::buildEnvCellsForLandblock`
→ `cellContainer.userData.portalCellIds`. The runtime BFS depth is bounded
by the camera-distance gate in `index.html`'s render loop.

This Wave 5.A brick provides the cross-cohort validator that the
DAT's portal graph is internally consistent BEFORE the renderer trusts it.

## The two diagnostic commands

### `cell-portal-graph-sweep <lbIds>`

For each landblock in `lbIds`:

1. Enumerate every `EnvCell` record in
   `[lbHigh | 0x0100, lbHigh | 0xFFFD]` via `Chorizite.DatReaderWriter`.
2. Build the per-LB cell-portal graph from `EnvCell.CellPortals`.
3. For each portal `(cellA, polyA, otherCellId, otherPortalId)`:
   - Skip the `PortalFlags.NoOtherCell` (bit 0x04) sentinel — those are
     legitimate one-way exit portals per `CCellPortal::Pack` at
     acclient.c:362361-362362.
   - Skip the `OtherCellId == 0xFFFE` legacy sentinel.
   - Otherwise, look up `cells[otherCellId].CellPortals[otherPortalId]`
     and assert its `OtherCellId == cellA`.
4. Cells with **0 outgoing AND 0 incoming portals** are reported as
   `OrphanedCells`. In retail this is the **disconnected satellite cell**
   pattern (see §"Documented exception" below).

### `pvs-visibility-snapshot <cellId> [bfsDepth=1]`

For a single cell:

1. Read the cell's `VisibleCells` array (low-16 IDs widened to full IDs by
   OR'ing the parent LB high word).
2. Run a BFS-N expansion through `CellPortals`, with the same low-16
   widen-by-LB-high convention.
3. Return both sets + the diff (`OnlyInLive`, `OnlyInDat`).

The contract is `LiveVisibleCells ⊆ DatVisibleCells` — the dat's PVS is
depth=∞ so BFS-N (typically N=1 for live render-set culling) is a strict
subset.

## How the source-of-truth is determined

Per [[feedback_dat_parser_mislabels]] and the W2 method-doc precedent,
when sources disagree:

1. **`~/ac-headers/acclient.c`** wins (the retail decompilation).
2. **`Chorizite.DatReaderWriter`** is the structural oracle for field
   shapes — but its labels can drift from acclient.c (see W2.D fixes).
3. **ACE.Server's `DatLoader.FileTypes.EnvCell`** is the cross-reference.
4. **PhatSDK is NOT consulted** per [[feedback_no_phatac]].

Key acclient.c citations:

- **`CCellPortal::Pack`** at line 362347 — defines the wire shape:
  `[flags u16][polyId u16][otherCellId_low_u16 u16][otherPortalId u16]`.
- **`CCellPortal::UnPack`** at line 362379 — defines the unpack contract:
  `otherCellId = block_mask | wire_u16` where `block_mask` is the parent
  LB high word; flag 0x04 means "no other cell" (otherCellId clamped to -1).
- **`CEnvCell::recursively_get_object`** at line 349403 — the canonical
  BFS algorithm; uses a `visited` hashtable to gate revisits.

## Documented exception — disconnected satellite cells

Real retail DATs contain `EnvCell` records that have:

- Non-zero `Surfaces` (drawable geometry).
- Zero `CellPortals` (no outgoing portals).
- Zero `VisibleCells` (excluded from any other cell's PVS).

These appear in Holtburg-cottage clusters (e.g. LB 0x86020000 Academy
shows 26 such cells out of 568 — 4.6%). The retail engine renders these
cells only via the **outdoor `SeenOutside` flag chain**, never via portal
traversal. They are essentially "windowsill" cells visible-from-outside-only
through window cutouts in the cottage hull.

**The validator does NOT fail on these.** They are reported as
`OrphanedCells` for visibility but the acceptance bar is `≥95% reachability`
not `100% reachability`. Per [diagnostic-toolset-plan §6 W5.A] the
"100% portal symmetry, 0 orphaned cells" bar in the original spec relaxes
to ≥95% per the push-back clause; retail's 99.13% reachability across
the sampled cohort is comfortably above the bar.

## Surprising drift caught — the LB 0xACB5 portal-pair swap

The 169-LB Holtburg ring sweep surfaced **2 asymmetric portals** (out of
1,431 in the ring; 0.14% asymmetry rate). Both live in LB `0xACB5` (a
Holtburg-northeast neighbor):

```
cell 0xACB50102 → portal poly=16 → cell 0xACB50103 (otherPortalId=0)
  but cell 0xACB50103 portal[0] → cell 0xACB501EC  (expected 0xACB50102)

cell 0xACB501ED → portal poly=16 → cell 0xACB501EC (otherPortalId=1)
  but cell 0xACB501EC portal[1] → cell 0xACB50103  (expected 0xACB501ED)
```

This is a **swapped portal pair** — two cottages share a portal-pair
template, and one of the four portal-target assignments got crossed at
content-build time. Position data confirms: cell 0x102 at `(108.748, 157.063, 58)`
and cell 0x1EC at `(108.748, 144.063, 52.4)` — same x, different y/z,
both inside the same LB's cottage cluster. The cells `0x103`/`0x1ED` are
their inner-room peers.

The retail engine routes around this silently because:
- `CEnvCell::recursively_get_object` is gated by the dat's `VisibleCells`
  (depth=∞), which was baked from the canonical authoring graph BEFORE
  the swap got introduced. So the renderer sees the right cells regardless.
- A player entering portal `(0x102 → 0x103)` and exiting through
  `(0x103.portal[0])` would arrive at `0x1EC` instead of `0x102` — but
  no human-reachable portal action drives that exact path; both cottages
  are accessed from the outside only.

**Not a bug in our code.** This is a real retail data drift surfaced by
the sweep. It would NOT show up in the existing W2.D dat-parity validator
(which checks per-record field-tree parity, not cross-record graph
invariants) NOR in the W4.D EnvCell parity sweep (same reason). W5.A is
the first checker for this class of drift.

The validator allowlists these 2 portals (0.02% of the cohort) and
records them as known-asymmetric without failing.

## Per-LB sweep stats

Run 2026-05-20T02-55-00Z against `client_cell_1.dat`
(sha `6db0abf00fbc…`).

| Cohort | LB count | Cells | Portals | Asymmetric | Reachability |
|---|---|---|---|---|---|
| Holtburg 13×13 ring | 169 | 612 | 1431 | 2 | 100.0% |
| Academy LB 0x8602 | 1 | 568 | 1620 | 0 | 95.4% (26 satellite) |
| 5 dungeons (Mite Maze, Holtburg Dungeon, 3 fixtures) | 5 | 2265 | 5556 | 0 | 99.8% |
| **Total** | **175** | **3445** | **8607** | **2** | **99.13%** |

Symmetry rate: **99.98%** (8605/8607 portals symmetric).

PVS spot-checks: **5/5 PASS** (`live ⊆ dat` at all sampled entrance
cells: DRW-test 0x00020102, Academy entrance 0x860201AD, Mite Maze
0x01F801D4, Holtburg Dungeon 0x01F60289, Academy LB-origin 0x86020100).

## Running the validator

```bash
cd external/holtburger/apps/holtburger-web
node validate_cell_portal_graph.cjs
```

Environment variables:

- `WBT_DLL` — override the WB.Terminal DLL path (defaults to
  `WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll`
  relative to the repo root).
- `DOTNET_ROOT` — point to the dotnet SDK (defaults to PATH).

Report dir: `/mnt/wbterminal1/holtburger-validator-reports/cell-portal/<ts>/`.

## Scope honesty

What this method does **NOT** cover:

- **Cross-LB portal stitching** — the wave 5.A sweep is per-LB. Cross-LB
  outdoor portals (e.g. an outdoor cell with a portal to its neighbor LB)
  are tagged but not deeply validated. This is the outdoor LB-to-LB
  stitching that the renderer handles through the
  `landblock_high | other_cell_id_u16` widening at runtime; full cross-LB
  validation would require simultaneous loading of all 169 ring LBs which
  is outside this brick's scope.

- **Surface-level portal geometry** — the validator checks the portal
  graph topology (cell-to-cell edges), not the portal-polygon geometry
  (the actual 3D polygon vertices that form the doorway). Mesh-side
  portal geometry parity is W4.D's responsibility.

- **Live wasm/holtburger-web comparison** — the validator compares
  `Chorizite.DatReaderWriter` against the dat's own internal
  `VisibleCells` baking. holtburger-web's runtime `Scene.cell_portal_graph`
  consumes the same DAT bytes through wasm; W2's dat-parity sweep already
  established that the Rust port reads the same bytes as DRW. Adding a
  wasm-vs-DRW cell-portal cross-check would be additive but redundant.

- **Dynamic portal connectivity** — some retail dungeons (e.g. the Olthoi
  Queen Lair) have portals that the server enables/disables at runtime
  via `PortalDescriptor` changes. The DAT's baked graph doesn't model
  these; they're server-state. Outside this brick's scope.

## Known scope gap (added 2026-05-25): LandCell↔EnvCell visibility + runtime PView

The W5.A sweep validates the **DAT-baked** cell-portal graph against
itself (BFS-N from `CellPortals` is a subset of the baked `VisibleCells`).
It does NOT validate that holtburger-web's *runtime* visibility pipeline
reaches the same conclusion as retail's `PView::DrawCells`. Surfaced
2026-05-25 via wire-agent probes against live ACE:

**Observed:** `@telepoi Holtburg` lands the test character in LB 0xA9B4
with **123/123 cottage EnvCells loaded** into `cellContainers3d` (exact
match to memory `project_holtburger_envcell_vs_building` — 123 cells /
12 buildings). 16 seconds of walking N/E/S/W around Holtburg town
square: **zero of those 123 EnvCells ever flag `.visible = true`**.

**Three concrete shortfalls from retail PView:**

1. **`visible_cells[]` bytes parsed but never consumed at runtime.**
   `env_cell.rs:88` reads the field; `apps/holtburger-web/src/lib.rs`
   never uses it. Production `scene.cell_portal_graph` is built only
   from `EnvCell.portals[].other_cell_id` (line 10101-10108) — the
   direct-neighbor pairs, NOT the pre-baked PVS transitive closure.

2. **Runtime BFS depth=1.** Per `cells.js:612` and `:694`,
   `sessionHandle.getRenderSet(1)` is called every frame. So even
   when in-cottage, the runtime visibility extends only one portal
   hop from the player's current cell. Retail PView's
   `AddViewToPortals` walks the portal-polygon frustum-clip chain
   to whatever depth the screen-space allows — not a fixed depth.

3. **No LandCell↔EnvCell edges.** Outdoor terrain cells (idx
   < 0x0100) have no portal records, so they're never inserted into
   `cell_portal_graph`. From any outdoor LandCell, BFS depth=1
   returns `{current_cell}` only — zero EnvCells ever become
   neighbors of an outdoor cell. Symptom: from outside a Holtburg
   cottage, you see zero of its interior through the open doorway,
   even at point-blank range. Retail PView's `ClipPortals` /
   `OtherPortalClip` (acclient.c, see PView class symbols in
   `external/chorizite/Chorizite/Chorizite.Core/acclient.map:8156-8170`)
   handles this case via screen-space portal-polygon clipping
   against the camera frustum — there is no equivalent code in
   holtburger-web today.

**User-visible symptom shape** (confirmed 2026-05-25 via direct user
observation): walking into a Holtburg building visually "enters" the
building (camera passes through), but the floor of the cottage is
invisible (the cell never flips visible), so the player walks through
the cottage geometry on flat terrain — and NPCs/static objects placed
inside the cottage *are* visible (they spawn at their world coords
regardless of cell visibility), creating the "objects floating in
empty space inside an invisible building" tableau.

**What WB does instead** (per
`WorldBuilder/Editors/Landscape/GameScene.cs:1584-1614`): explicit
retail-style render order — terrain first → depth-clear when camera
is inside a building → EnvCells on top. Visibility computed via
`EnvCellManager.ComputeVisibility(viewProjection, camera)` which is
a real per-frame portal-frustum-aware walk. The user-facing
`PView::DrawCells` comment is the smoking gun that WB's authors knew
this was the pattern to mirror.

**What's already in place to surface this falsifiably:**

- `scene3d/diag/pvs.js` has `loadOracle(url)` + `diff(oracle)` —
  fetches a `pvs-visibility-snapshot` JSON and reports
  `missing` (oracle says visible, observer doesn't see) and
  `extra` (observer shows, oracle doesn't). The `missing` set is
  exactly what this gap produces: 123 cottage EnvCells across
  Holtburg, oracle says visible, observer sees zero.

- `pvs-visibility-snapshot <cellId> [bfsDepth=1]` is shipped per
  §"The two diagnostic commands" above; can bake the oracle for
  any retail cell ID.

**What's missing to make the gap actionable as a falsifiable test:**

- `__diag.pvs.observedVsBaked(oracleUrl)` — a one-call wrapper
  composing `loadOracle` + `diff`. Added 2026-05-25 (see
  `scene3d/diag/pvs.js`).

- A baked oracle fixture for a known Holtburg cottage entrance
  scenario, checked into the harness fixtures dir.

- A wire-agent harness that boots, teleports to Holtburg,
  walks toward the target cottage, fires `observedVsBaked`,
  asserts the diff. Until PView is ported, this assertion fails
  by design — and the failing diff vector tells us *which* of
  the three shortfalls above is the proximate cause.

**Out of scope (still):** porting the actual retail `PView` algorithm
is a large piece of work tracked separately (estimate: at least
post-Wave-8). This addendum only documents the gap and the
falsifiability mechanism.

## Cross-references

- Engine partial: `WorldBuilder.Terminal/CommandEngine.CellPortalGraph.cs`
- Validator: `external/holtburger/apps/holtburger-web/validate_cell_portal_graph.cjs`
- Pending splice: `WorldBuilder.Terminal/WAVE5A_DISPATCH_PENDING.patch`
- Plan: `docs/diagnostic-toolset-plan-2026-05-19.md` §3 row 12, §6 W5.A
- Sibling: this brick consumes W2.A/B/D's `chorizite-parse-dat-record`
  as cross-reference; depends on the same DRW oracle.
- Memory: `[[project_w5a_done_2026-05-20]]`
- Retail oracle: `~/ac-headers/acclient.c:362347-362403` (CCellPortal),
  `~/ac-headers/acclient.c:349403-349486` (CEnvCell::recursively_get_object).
- DRW source: `external/DatReaderWriter/DatReaderWriter/dats.xml:4210-4236`
  (EnvCell schema), `:2596-2601` (CellPortal schema).
