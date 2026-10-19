# tools/water-flow — terrain-water flow + foam bake

`bake_water_flow.py` works out, for every terrain-water vertex in Dereth, which way the water flows, how fast, and how much foam it carries. It writes two files:

| file | what |
|---|---|
| `data/water_flow.bin` | Flow and foam bytes: one 9×9 block per landblock that has any flow or foam ("HBWF" v1, format below). |
| `data/water_flow_sites.json` | The waterfall and drop sites, with lip and foot in global metres, for particle and mist work. |

It needs only Python 3 and numpy. It reads the retail base DATs directly. It does not use WorldBuilder.Terminal, the ACE database or the network.

The output is deterministic: two runs on the same DATs give byte-identical files. A run takes about 20 s and peaks around 0.55 GB RSS. Set `WATER_FLOW_RSS=1` to log the peak at each stage.

```sh
cd apps/holtburger-web
python3 tools/water-flow/bake_water_flow.py            # bake (defaults: ~/ac_base_dats/client_{cell_1,portal}.dat)
python3 tools/water-flow/bake_water_flow.py --check    # re-read data/water_flow.bin: header, order, seams, checkpoints
# --cell PATH --portal PATH [--allow-nonbase]   other DATs (refused unless they live in ~/ac_base_dats)
# --out PATH --sites PATH                       other output paths
# --debug-npz PATH                              also dump the full 2041x2041 grids (FE, FN, SPEED, FOAM, CLASS, ...)
```

A bake ends by running `--check` on what it just wrote. The exit code is non-zero if any check fails.

## Inputs (read straight from the DATs)

The field layouts follow ACE.DatLoader.

**`client_cell_1.dat`, `0xXXYYFFFF` CellLandblock records** (all 65,025 of them):
- Layout: `u32 id, u32 hasObjects, u16 terrain[81], u8 height[81]`.
- Vertex index is `gridX*9 + gridY`. `gridX` runs east and `gridY` runs north.
- Terrain type is `(terrain >> 2) & 0x1F`.
- Global vertex: `(gx, gy) = (lbX*8 + gridX, lbY*8 + gridY)`, at global metres `(24·gx, 24·gy)`.
- I checked this layout against the WorldBuilder.Terminal `get-terrain-data` extraction of every landblock. Height index, type, road and scenery are identical, and shared landblock edges agree.

**`client_cell_1.dat`, `0xXXYYFFFE` LandblockInfo records:**
- Layout: `u32 id, u32 numCells, u32 numObjects, numObjects × (u32 setupId, f32 origin[3], f32 quat[4])`.
- Only the objects are read. Objects whose setup is a waterfall anchor are kept as fall markers: `0x020003E4 0x0200085A 0x02000859 0x020003C5 0x02000B4D 0x02000B4E`. There are 659 of them.

**`client_portal.dat`, Region `0x13000000`:**
- Read in this order: `u32 id, u32 regionNumber, u32 version, PString name (u16 length), align to 4`.
- Then LandDefs: `i32 numBlockLength, i32 numBlockWidth, f32 squareLength, i32 lblockLength, i32 vertexPerCell, f32 maxObjHeight, f32 skyHeight, f32 roadWidth, f32 landHeightTable[256]`.
- Vertex height in metres is `landHeightTable[height]`.

**Water codes:**
- 16–20 are retail SurfChar water: running, standing fresh, shallow sea, shallow still sea, deep sea.
- 22 is FauxWaterRunning. Retail paints fall faces with it, and the client draws it as water.
- 23 (SeaSlime) is land here.

## Algorithm

AC rivers are flat. 99.6% of running-water vertices have no lower water neighbour, and the north river is a single 6.6 km flat at 28 m. Height gradients therefore cannot give a direction. Direction comes from topology instead.

1. **Ocean (the only sinks).** The ocean is the sea-coded (18–20) vertices of the two big 4-connected sea components (≥100k vertices) that sit at sea level (H ≤ 0.5 m), plus the map edge. Raised or inland sea-coded water is a lake, not a sink. That covers Cragstone lake (code 19), the Cataracts of Sabella terraces, the Ithaenc pools and the mountain tarns.

2. **Drop pairs.**
   - **Direct:** two 8-neighbouring water vertices at least 4 m apart.
   - **Gap:** upper water and lower water of a *different* 8-connected water body, at most 6 vertices apart and at least 10 m lower, where the straight segment crosses land and never rises more than 4 m above the upper water.
   - A pair is a **real fall** if:
     - the drop is ≥10 m, or ≥4 m when the upper vertex is running, standing or faux water, or has running water upstream;
     - sea-coded upper vertices need ≥15 m;
     - and neither end lies in noise or a corner zone (see step 4).

3. **Water-preferring priority flood.** A FIFO priority-flood (Barnes et al. 2014) runs over the full 8-neighbour grid from the ocean.
   - Land elevation gets +1000 m, so water routes always win. Land is crossed only where unavoidable, at the lowest saddle.
   - The land cells on gap-fall segments are opened as virtual water channels, so an upper pool drains over its own lip.
   - Depressions fill and flats drain in BFS order from their outlet. Cragstone lake fills to its 6 m spill, so the south river drains *south*, even though it sits 2–4 m higher than the lake.

4. **Direction.**
   - Direction is −∇D: a least-squares gradient over water neighbours of D, the flow-path distance to the sink along the flood's receiver tree. Steps across basin divides are skipped, the receiver direction is the fallback, and two 3×3 smoothing passes follow.
   - Water with a drop of 4 m or more to a lower water neighbour takes the steepest-descent direction.
   - These are forced still:
     - sea-coded slivers and spikes (a component with no equal-height flat of 4 or more vertices);
     - two corner zones outside the playable world: the SW corner (landblocks 0x00–0x14 × 0x00–0x13: the "compass wheel" with a free-standing faux-water patch, and the waterfall-anchor test square around 0x1203), and the sea-coded shelf in the NW corner (0x00–0x08 × 0xF4–0xFE).

5. **Speed** (relative; 1 = a normal river):

   | water | speed |
   |---|---|
   | running and faux water | 1.0 |
   | fall faces fed by running water | 1–4, by slope |
   | unfed steps | 0.5 |
   | lake bodies with through-flow (≥3 running vertices drain through) or feeding a real fall | 0.2 drift toward the outlet, ramping to 0.6 at a real lip |
   | other ponds and the ocean | 0 |

6. **Plunge.** Within 3 vertices of a real fall's foot, the flow turns radially away from the foot. Bottom DAT anchors also mark feet: an anchor counts when it is within 6 m of the lowest anchor within 200 m, and it marks the water within 1.5 vertices.
   - In moving water: blend weight 0.7 → 0, speed up to 1.5.
   - In still water (the ocean or sea-coded water at the foot of a fall into the sea): pure radial, speed 0.5 → 0.
   - Vertices that approach another lip at the same level (cascades) are skipped.

7. **Foam.**
   - 255 on fall faces: a drop of 6 m or more to a downstream water neighbour, by running, standing or faux water, or by any water if the drop is 15 m or more.
   - 255 at fall feet.
   - Both decay linearly to 0 over 96 m (4 vertices) of downstream travel.
   - Rapids get 80: running water with a 2–6 m downstream drop, decaying over 48 m.
   - "Downstream travel" is a Dijkstra search over water 8-neighbours that never climbs more than 0.5 m and never goes against the local flow (cos < −0.25).

8. **Sites.** The sites file merges direct drops (kind `terrain-water drop`, or `code-22 face` when code 22 is involved), `land-cliff gap`, `spill` and `anchor` evidence, each cluster within 96 m:
   - **spill:** a water body's flood outlet crosses 1–16 land vertices with a cliff step of 8 m or more and a total drop of 10 m or more.
   - **anchor:** a cluster of DAT anchors.
   - **Lip and foot** come from the strongest terrain evidence. Spills are used only when nothing else is present. Anchor-only sites use the highest and lowest anchors.
   - **Names** come from a small table of known falls in the script.

## `data/water_flow.bin` format (little-endian, version 1)

```
offset 0   char[4]  "HBWF"
       4   u16      version = 1
       6   u16      count                 number of landblocks stored
       8   f32      fullScaleUnits = 4.0  the speed that byte offset +-127 represents (a river, 1.0, is +-32)
      12   u32      reserved = 0
      16   u16      lbKey[count]          (lbX << 8) | lbY, strictly ascending
           u8       0-padding to the next 4-byte boundary
           count × 81 × 3 bytes           one block per lbKey, in the same order
```

**Blocks.**
- Each block is 81 vertices × `[flowE, flowN, foam]`. Vertex `i = gridX*9 + gridY`, the same order as the DAT height array, with gridX east and gridY north.
- `flowE` and `flowN` are biased: `128 + round(127 · v / fullScaleUnits)`, clamped to 1..255. Here `v` is the east or north component of direction × speed.
- 128/128 means still.
- `foam` is 0..255.

**Which landblocks are stored.** A landblock is stored if any of its 81 vertices has a non-128 flow byte or non-zero foam.
- Everything else, including the open ocean and still ponds, is absent. A missing landblock means still with no foam.
- Values are computed on the global grid, so edge vertices shared by two stored landblocks are byte-identical.
- Each vertex on an edge next to a missing landblock is 128/128/0. `--check` verifies both.

The current bake is 849 landblocks and 208,023 bytes.

## `data/water_flow_sites.json`

The header holds `format`, `version`, `tool`, `coords`, `kinds` and `source`. `source` gives the size and SHA-256 of each input DAT and the region name.

Each entry in `sites[]` is one compact line:

```json
{"id", "lb": "0xB6A3", "kind": [...], "drop": m, "lip": [x, y, z], "foot": [x, y, z],
 "dir": [e, n], "anchors": n, "steps": n, "map": "29.2N 44.1E", "name": "Cragstone Falls" | null}
```

Coordinates are global metres: x east, y north, z terrain or anchor height.

## `--check` checkpoints

These are hand-labelled from geography. The vertex was chosen on the map, and the expectation comes from where the water must go, not from the bake.

| label | lbKey | gridX,gridY | expectation |
|---|---|---|---|
| north river mid-stretch | 0xA9B6 | 4,4 | sector E or SE |
| north river 100 m above Cragstone Falls | 0xB5A4 | 3,2 | E or SE |
| Cragstone Falls west face lip | 0xB6A3 | 0,3 | E, foam ≥ 200 |
| Cragstone Falls north face lip | 0xB6A3 | 4,8 | S, foam ≥ 200 |
| Cragstone plunge pool | 0xB6A3 | 3,2 | away from global (1457,1307), foam ≥ 100 |
| Cragstone lake mid | 0xBF9C | 2,2 | toward the south outlet (1609,1131), speed ≤ 0.5 |
| south river below Cragstone lake | 0xCA89 | 4,4 | S or SE |
| south river lower reach | 0xCE7A | 1,4 | W or SW |
| Marae Lassel main fall lip | 0x1DB4 | 1,2 | S, foam ≥ 200 |
| Marae Lassel plunge pool | 0x1DB4 | 1,0 | away from (233,1441), foam ≥ 100 |
| Blue Ghost upper pool | 0xE43D | 1,6 | toward (1827,489) |
| Blue Ghost lower pool | 0xE43D | 5,0 | away from (1827,490), foam ≥ 60 |
| still side pond, north river upper reach | 0x9CC2 | 1,5 | 128/128 |
| SE river mouth | 0xE650 | 5,2 | E, NE or SE |
| open ocean east of Dereth | 0xFA40 | 4,4 | landblock absent |

## Known failure modes

- **Braids, deltas, anabranches.** Each channel flows to the *nearest* outlet, so some cross-links and backwaters run against the visual main stream. On Marae Lassel's delta about 12% of vertices disagree with a naive "south to the mouths" expectation.
- **Lakes** drift toward their outlet, mostly radially near it. A lake whose outlet sits next to its inflow would carry flow back toward the fall beyond the 3-vertex plunge zone. Ponds with no inflow are still.
- **Land gaps longer than 6 vertices** do not get channels. For example, the Marae Lassel 76 m source pond spills over 12 land vertices. Such a pool drains toward its natural lowest saddle, which is usually, but not provably, the intended lip.
- **Fall faces** use steepest descent among 8 directions, without smoothing.
- **Speed is heuristic.** There is no width or discharge model: every river is 1.0.
- **Rapids** are rare. Rivers have only 53 steps of 2–4 m.
- **Code 23 faces.** Marae Lassel's cascade faces are code 23 (SeaSlime), so the client does not draw them as water. Only the pools above and below carry flow and foam.
- **Single `0x020003C5` anchors** away from water appear as anchor-only sites (drop 0). Some may be other emitters.
- **Plunge into the sea** also fires for small pools 12 m up that spill into the sea (0xEF6C, 0xF879), and for a lone anchor at 0xC7EA.
- **Corner zones** are listed by hand (`CORNER_ZONES`). Any new special area with sloped sea-coded water would need adding there.
