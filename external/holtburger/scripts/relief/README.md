# `scripts/relief/` — read the baked relief variant at rest

Four small readers used by task-GFXOBJ-RELIEF (2026-08-11) to answer "is the
relief actually in the dist, on which models, and what does it look like"
WITHOUT a browser, a wasm build or a live login. They parse the shipped
artifacts directly, per the layouts in
`apps/holtburger-tools/src/pack_format.rs` (HBP1 container, S2-S3),
`crates/holtburger-dat/src/hbg1.rs` (GEOM/GEOMR row table + kind-0/1 payloads)
and `crates/holtburger-dat/src/landblock.rs` (`LandblockInfo`).

Run from the holtburger repo root, with `dist/` present. `zstd` on PATH.

| script | what |
|---|---|
| `build-pack-index.py` | header sweep over every `dist/packs/**/*.hbp` → `/tmp/s12/pack-index.json` (pack kind, origin, section table). ~2 min for 51,953 packs; every other script reads this cache. |
| `dist-relief-census.py` | every GEOMR (0x0C) row in the dist, joined to its co-located GEOM (0x09) default: triangle counts before/after, added tris, bbox extent, payload bytes. Reproduces `pack-report.json`'s `geom_relief_*` counters from the packs themselves. |
| `locate-variant-models.py` | which models a REGION actually renders (scenery JSONL + LBINFO objects/buildings, setups resolved to their parts) and which of those carry a variant — i.e. "stand here to see it". |
| `render-relief-pair.py` | software-rasterises ONE model's two co-located payloads (default vs variant) from the same camera: `s12-gfxobj-<did>-{relief-off,relief-on,diff}.png` + the % of pixels that changed. Flat Lambert, no textures — the GEOMETRY is the only variable. |

The renderer is deliberately untextured and unlit-by-the-real-engine: it
OVERSTATES how visible the rails are, because it removes the albedo detail and
scene clutter that hide them in the client. Treat it as "what the bake added",
not as "what the frame looks like".
