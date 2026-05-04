Place a combined namespaced HBA bundle in this folder:

- Preferred: `assets.hba`

The bundled release and Flatpak packaging ship a namespaced `assets.hba` archive. It contains the current TUI-required portal content under `eor/portal`, the required derived runtime asset under `holtburger/core`, and may also include `eor/cell` content in the same file. The runtime discovers HBA namespaces from archive metadata, so filenames are no longer used to infer archive scope.

If you want to generate `assets.hba` yourself, use:

```bash
cargo run -p holtburger-tools --bin dat2hba -- \
	--profile pruned \
	eor/portal=client_portal.dat \
	eor/cell=client_cell_1.dat \
	dats/assets.hba
```

Raw retail DATs are tooling inputs only. Normal client startup expects the generated `assets.hba` bundle, not bare `.dat` files.

## Profile choice

`dat2hba` accepts `--profile {full,pruned,micro}`:

- `full` — every entry from every input DAT. Multi-GB bundle; impractical
  for the smoke loop and the browser bundle.
- `pruned` — keeps `eor/portal` and `eor/cell` but drops the heaviest
  asset categories (audio, large textures, animation packs). ~230 MB
  with both `client_portal.dat` and `client_cell_1.dat`. **This is the
  right baseline for Phase 3 step 1** — it includes every landblock
  terrain (`XXYYFFFF`) and `LandblockInfo` (`XXYYFFFE`) record needed
  for the renderer.
- `micro` — `eor/portal` only, severely whittled. Smallest possible
  fixture (~353 KB) for the §8-step-4 HTTP-source check, but excludes
  the entire `eor/cell` namespace and so cannot drive a renderer.

## Verify the cell namespace landed (Phase 3 step 1)

```bash
./target/release/dat-tool meta dats/assets.hba
# Namespaces should include `eor/cell -> N entries` (typical N ≈ 780k for pruned)

./target/release/dat-tool list dats/assets.hba | grep "eor/cell:A9B4FFFF"
# Holtburg town centre landblock terrain — 252 bytes, type
# Landblock (Terrain) (0x000000FE).
```

`A9B4FFFF` is the `CellLandblock` (terrain heightmap) for the Holtburg
town centre — the landblock the Phase 3 step 1 renderer hardcodes.
`A9B4FFFE` is the matching `LandblockInfo` (object placements) used
in later steps; per-cell IDs `A9B40100..` are interior cells and are
not what the surface-terrain renderer reads.
