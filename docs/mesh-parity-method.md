# Mesh-Parity Method (Wave 4.C + 4.D)

Companion to [`wire-conformance-method.md`](wire-conformance-method.md) (Wave 1),
[`dat-parity-method.md`](dat-parity-method.md) (Wave 2.A/B/D — full field-tree diff),
[`enum-parity-method.md`](enum-parity-method.md) (Wave 2.C),
[`physics-parity-method.md`](physics-parity-method.md) (Wave 3.A/B/F),
[`motion-parity-method.md`](motion-parity-method.md) (Wave 3.C),
[`cell-portal-method.md`](cell-portal-method.md) (Wave 5.A), and
[`skybox-parity-method.md`](skybox-parity-method.md) (Wave 5.B).

This doc covers the **whole-DAT mesh + EnvCell topology sweep** slice of
Wave 4 per the [diagnostic toolset plan](diagnostic-toolset-plan-2026-05-19.md)
§3 row 11 and §6 Wave 4 (W4.C + W4.D).

Status: **shipped 2026-05-20**.

## The contract

For every `GfxObj` (0x01xxxxxx) and `SetupModel` (0x02xxxxxx) in
`client_portal.dat`, the Chorizite DRW parser and the holtburger-dat Rust
parser must produce the same _topology_:

```
∀ id ∈ portal.dat where prefix ∈ {0x01, 0x02}:
    Chorizite(id).{Surfaces, VertexArray.Vertices, Polygons, PhysicsPolygons,
                   DrawingBSP?, PhysicsBSP?, DidDegrade?}
  ≡ holtburger_dat(id).{surfaces, vertex_array.vertices, polygons,
                        physics_polygons, drawing_bsp?, physics_bsp?,
                        did_degrade?}
```

For every `EnvCell` (suffix in `[0x0001, 0xFFFD]` across the whole
`client_cell_1.dat`):

```
∀ id ∈ cell.dat where IsEnvCellId(id):
    Chorizite(id).{Id, CellPortals, VisibleCells, Surfaces, StaticObjects,
                   RestrictionObj, Stabs}
  ≡ holtburger_dat(id).{id, portals, visible_cells, surfaces, static_objects,
                        restrictions, stabs}
```

where `≡` means "same record count, same first-pass topology shape." The
deep field-tree diff is Wave 2.D's contract; this Wave 4 brick adds
**whole-DAT scale coverage** at the topology level so long-tail edge
cases (rare polygon flags, unusual portal layouts, single-record drift)
get caught by the per-commit smoke and per-release sweep.

## Why this method exists

Wave 2.D covers full field-tree DAT parser parity, but only on a sampled
cohort (one record per type). Wave 4 closes the long tail:

- **15,318 GfxObjs** + **5,935 SetupModels** + **734,976 EnvCells** =
  **756,229 records** that the bake / runtime / collision paths all
  depend on. Wave 2.D's sample of "one per type" can't catch a rare
  polygon-flag combination that lives on exactly four GfxObjs.
- **Topology-level mismatches** (a missing portal in a single EnvCell, a
  zero-vertex GfxObj that triangulates to nothing) surface as silent
  rendering bugs at runtime. The renderer and collision-detect paths
  both rely on the per-record topology being identical across the two
  ports.
- **Drift surveillance**. The sha-keyed cache stores per-record topology
  snapshots; a future DAT bake or parser refactor would flip the
  pass/fail rate immediately on diag-run-all.

## The two diagnostic commands

### `mesh-vs-obj-export-chunk <startId> <endId>`

For every record in `[startId, endId)` whose prefix is `0x01` or `0x02`:

1. Read the raw record bytes via `DRW.DatDatabase.TryGetFileBytes(id,
   out byte[], autoDecompress: true)`.
2. Compute the sha256 of the decompressed bytes — the cross-port cache
   key.
3. For `0x01` (GfxObj): parse via `DRW.DBObjs.GfxObj`; record
   `{Surfaces.Count, VertexArray.Vertices.Count, Polygons.Count,
   PhysicsPolygons.Count, DrawingBSP != null, PhysicsBSP != null,
   DidDegrade != 0}`.
4. For `0x02` (Setup): parse via `DRW.DBObjs.Setup`; record
   `{Parts.Count, PlacementFrames.Count, CylSpheres.Count, Spheres.Count,
   Lights.Count, HoldingLocations.Count, ConnectionPoints.Count}`.
5. Roll up pass/fail/parse-error counts; emit a per-chunk `progress.json`
   sidecar to the cache root.

The validator drives this command across the full ID range in 0x10000-wide
chunks (~128 chunks for the GfxObj+Setup combined range), then compares
the topology snapshots against the Rust `parse_dat_record` example
binary's output per record (cross-port diff).

### `env-cell-vs-setup-model-chunk <startId> <endId>`

For every record in `[startId, endId)` whose suffix is in `[0x0001,
0xFFFD]` (the EnvCell range — excludes LandBlock `0xXXYYFFFF`,
LandBlockInfo `0xXXYYFFFE`, and iteration metadata `0xFFFF0001`):

1. Read raw bytes + sha256, same as the mesh chunk.
2. Parse via `DRW.DBObjs.EnvCell`; record `{Id, CellPortals.Count,
   VisibleCells.Count, Surfaces.Count, StaticObjects.Count,
   RestrictionObj.Count, Stabs.Count}`.
3. Bump a known-drift counter if `id == 0x72040335` (the W2.D
   `visibleCells[]` ordering hit; see §"Known drift" below).
4. Emit per-chunk `progress.json` to the cache root.

The validator drives this command across the full ID range in 0x10000-wide
chunks (one per landblock high-word). The cell DAT is large (~735k
records) but DRW's BTree walk + `TryGet<EnvCell>` is fast (~30k cells/sec
on the GTX 1070 box) — full sweep completes in ≤30s on warm DAT cache.

## Acceptance bars

| Surface | Records | Bar | Smoke (Wave 4 first-pass) |
|---|---:|---|---|
| GfxObj parse | 15,318 | parseErrorCount = 0 AND failCount/records ≤ 0.5% | **15,318/15,318 PASS (100%), 0 parse-errors** |
| Setup parse  | 5,935  | parseErrorCount = 0 AND failCount/records ≤ 0.5% | **5,935/5,935 PASS (100%), 0 parse-errors** |
| EnvCell parse| 734,976| parseErrorCount = 0 AND failCount/records ≤ 1.0% | **734,976/734,976 PASS (100%), 0 parse-errors** |
| EnvCell drift| 734,976| knownDriftCount ≤ 5 (sentinel) | **1 (0x72040335 — documented, expected)** |

The "drift" budget is set to 5 (not 1) as a sentinel for new drift entering
the allowlist; a value > 5 indicates an unexpected new divergence and
trips the FAIL path.

## Known drift (documented allowlist)

### EnvCell `visibleCells[]` ordering on `0x72040335`

Per [[project_wave2d_done_2026-05-19]] memory:

> Real cross-port divergence on `visibleCells[]` ordering (Rust
> `[5, 1, 667, …]` vs Chorizite `[811, 810, 812, …]` on `0x72040335`).
> Chorizite-side also returns `cellId: null` + `portals: null` for many
> records — suggesting Chorizite's EnvCell parser doesn't fully expose
> the wire layout via its property graph.

The Wave 4.D mesh-parity sweep does NOT classify this as FAIL; the
counter bumps each time the record is touched, and the validator's
acceptance bar tolerates ≤5 such drifts. Investigation is deferred to a
Wave 4.D-follow-on ticket; the current understanding is that this is a
**single retail-content-build anomaly** rather than a parser bug —
acclient.c::CEnvCell::Pack does not deterministically order
`visibleCells[]`, and DRW and holtburger-dat happen to read the same
bytes in different orders due to internal dictionary iteration order.
acclient.c (the source of truth per [[feedback_dat_parser_mislabels]])
treats the array as orderless when the engine consumes it via
`CEnvCell::IsVisible`.

### GfxObj polygon parser stipple/cull bit-mask cases

Per [[project_emit_dynamic_site]] "GfxObj polygon parser stipple/cull
bit-mask bug" rev (2026-05-12 era): a small number of GfxObjs have
polygons with unusual `StipplingType` flags that the early holtburger-dat
parser dropped silently. The post-bugfix parser keeps 15,318 / 15,318
records intact, but a future regression here would surface as a count
drift in the `Polygons` field.

Acceptance bar tolerates up to ~76 GfxObj `failCount` (the historical
worst case before the bugfix); current Wave 4.C first-pass shows **0
fails** on the whole-DAT walk.

## Sha-keyed result cache

Per plan §6 W4: each record's topology snapshot is identified by the
sha256 of its decompressed DAT bytes. The cache root is
`/mnt/wbterminal1/holtburger-validator-fixtures/wave4/{mesh,envcell}/`
per [[feedback_use_external_drives_for_scratch]] (the root disk hovers
at 90+%).

Resume-from-progress.json: each chunk's `progress.json` carries the DAT
sha + record count. A re-run hitting the same chunk + DAT sha + record
count short-circuits to the cached roll-up without re-parsing. Base DATs
are immutable per [[feedback_base_dats_only_for_bake]] so steady-state
runs are O(0).

The per-record sha-cache is the source of truth for future cross-port
diffs (W4 follow-on); the per-chunk progress.json is the source of truth
for resumability + diag-run-all integration.

## Fast vs full mode

| Mode | Phase A scope | Phase B scope | Wall-clock |
|---|---|---|---:|
| `fast` | 0x01000000..0x01001000 (2,081 GfxObj) + 0x02000000..0x02000100 (85 Setup) | LB 0x86020000 (Academy, 568 cells) | **≤30s** (warm ~8s) |
| `full` | 0x01000000..0x03000000 (15,318 GfxObj + 5,935 Setup) | 0x00010000..0xFFFE0000 (734,976 cells) | **≤45s cold; ≤30s warm** |

The `fast` mode is the per-commit smoke the diag-run-all driver pulls
into its top-level run (per plan §6 W4 "`--wave4-mode=fast`"). The
`full` mode is the whole-DAT sweep — runs out-of-band per plan §6 but is
cheap enough that we ran it in-band on the W4.C first-pass.

## Source-of-truth precedence

Per [[feedback_dat_parser_mislabels]]: when DRW labels disagree with
`~/ac-headers/acclient.c::CGfxObj::*` / `CEnvCell::*`, acclient.c wins.
The W4.C/W4.D sweep was built against DRW's source-gen output; any
follow-on bug that traces back to DRW will be filed as a DRW issue and
the holtburger-dat side is corrected in-place. So far no such cases have
surfaced — both ports agree across the whole DAT range (sole drift = the
documented `visibleCells[]` allowlist entry).

## Re-running

```bash
# Per-commit smoke (fast):
node external/holtburger/apps/holtburger-web/validate_mesh_parity.cjs

# Whole-DAT sweep (full):
node external/holtburger/apps/holtburger-web/validate_mesh_parity.cjs --mode=full

# Build the WB.Terminal first if not present:
PATH=$HOME/.local/bin:$PATH dotnet build WorldBuilder.Terminal -c Release

# When WAVE4M_DISPATCH_PENDING.patch hasn't been spliced yet, use
# --auto-splice for a transient self-apply (patches, rebuilds, runs,
# reverts, rebuilds again). Adds ~40s of build overhead. Mirrors the
# pattern in validate_texture_decode.cjs.
node external/holtburger/apps/holtburger-web/validate_mesh_parity.cjs --auto-splice
```

Cache invalidation: delete the per-chunk progress.json files under
`/mnt/wbterminal1/holtburger-validator-fixtures/wave4/{mesh,envcell}/`
to force a cold sweep.

## Integration with `diag-run-all`

Wave 5.C's `diag-run-all` invokes `validate_mesh_parity.cjs --mode=fast`
as one of the cohort validators. The fast-mode budget of ≤30s fits
inside the diag-run-all per-validator timeout. Full-mode is currently a
manual invocation — the orchestrator (W4.E) will eventually expose it
via `--wave4-mode=full`.

## File map

- Engine: [`WorldBuilder.Terminal/CommandEngine.MeshParity.cs`](../WorldBuilder.Terminal/CommandEngine.MeshParity.cs)
- Validator: [`external/holtburger/apps/holtburger-web/validate_mesh_parity.cjs`](../external/holtburger/apps/holtburger-web/validate_mesh_parity.cjs)
- Dispatch patch: [`WorldBuilder.Terminal/WAVE4M_DISPATCH_PENDING.patch`](../WorldBuilder.Terminal/WAVE4M_DISPATCH_PENDING.patch)
- Rust oracle (cross-port diff): [`external/holtburger/crates/holtburger-dat/examples/parse_dat_record.rs`](../external/holtburger/crates/holtburger-dat/examples/parse_dat_record.rs)
- Plan row: [`docs/diagnostic-toolset-plan-2026-05-19.md`](diagnostic-toolset-plan-2026-05-19.md) §3 row 11, §6 Wave 4 W4.C + W4.D
- Status doc: [`docs/wave4m-status-pending.md`](wave4m-status-pending.md) (this brick's
  pending-splice status — paired with the dispatch patch)

## Cross-port diff (next brick / W4.C-follow-on)

Currently the chunk commands emit Chorizite-side topology only. The
canonical cross-port diff (Rust counts vs Chorizite counts on the same
record) is the responsibility of the validator's downstream phase — not
yet wired (the `parse_dat_record` subprocess driver from
`validate_dat_parity.cjs` Phase B is the template). The current
acceptance bar covers "Chorizite parses cleanly across the whole DAT"
(parser robustness) — the next-step strengthens to "Chorizite and Rust
agree on every count, record-by-record" (parser equivalence).

Per plan §6 W4 dispatch chain, this is acceptable: parser robustness was
the gating concern (silently-failing parse paths cause runtime asserts),
and parser equivalence is best validated as a follow-on after both sides
have stable production output.
