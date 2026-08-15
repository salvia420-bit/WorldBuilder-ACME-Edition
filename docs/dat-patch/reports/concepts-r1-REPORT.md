# dat-patch concept boards + feasibility report

**Artist:** Opus 5 · **Date:** 2026-08-14 · **Brief:** 10 concept boards for 10 named sample objects,
plus an honest feasibility answer for *"100% of the portal.dat GfxObj catalog (15,318 records) at ~+1000%
triangles (10x)"*.

Everything below is measured off the read-only base DATs in `/home/wbterminal/ac_base_dats/`
(copied to `/mnt/wbterminal2/dpc-work/proj/dats/base/` so nothing writes to the originals), the live ACE
world DB, the Chorizite protocol definitions, and the retail decomp. No in-game capture was needed and
none was done. Nothing was pushed or committed.

---

## 1. The ten boards

| # | File | Subject | Status of the image |
|---|---|---|---|
| 01 | `01-cottage.png` | Rithwic cottage, GfxObj `0x0100082E` | **Real generated A/B** (relief-plan-apply, 90 -> 192 tris, gate 18/18) + 10x concept |
| 02 | `02-lugian.png` | Lugian, Setup `0x02000A0B`, 21 rigid parts | Real posed DAT geometry + part-breakdown + 10x concept |
| 03 | `03-rithwic-bridge.png` | The road causeway east of Rithwic, 4 GfxObj modules | Real world-placed assembly + seam analysis |
| 04 | `04-tree.png` | Tree, Setup `0x0200062C`, 6 parts | Real geometry + **measured** doubleSided billboard guard |
| 05 | `05-sign.png` | Signpost, Setup `0x02000290` -> `0x01000C79` | Real geometry + sibling comparison + 10x concept |
| 06 | `06-wall.png` | Arched gate wall, GfxObj `0x01004706` | **Real generated A/B** (plinth, 88 -> 120 tris, gate 18/18) + 2 real gate refusals |
| 07 | `07-cave.png` | LB `0x018B` "largecave", 212 EnvCells | Real dungeon geometry parsed from cell+portal dats |
| 08 | `08-lifestone.png` | Lifestone, Setup `0x020002EE`, 4 parts | Real geometry + part breakdown + 10x concept |
| 09 | `09-door.png` | Door, Setup `0x0200024F` | Real geometry + the full server-spawn trace diagram |
| 10 | `10-book.png` | Open Book, GfxObj `0x010006CD` | Real geometry + **full 15,318-record triangle census histogram** |

All renders are a purpose-built software z-buffer (numpy/PIL) drawing the *exact* DAT polygons —
flat-shaded, untextured, with a wireframe overlay at true topology. Where a board shows a "10x TARGET"
panel it is a subdivision/displacement stand-in, clearly labelled as a concept, not generated output.

### Per-object approach, one line each

1. **Cottage** — plinth + opening surround + belt course (already shipped, 2.1x); to 10x, add boundary-clamped
   panel tessellation plus eaves fascia, rafter tails, chimney corbel, drip moulds, sill stones, quoins.
2. **Lugian** — grow each of the 21 rigid parts *in place* (torso/thigh barrels, pauldrons, head, hands);
   never change part count or order, and clamp displacement to zero on every part boundary ring.
3. **Rithwic bridge** — parapet capstones + deck string course on each 24 m module, authored in module-local
   coordinates with the shared joint plane frozen so the four modules still register; arch voussoirs and
   cutwater need a new radial op.
4. **Tree** — tessellate the trunk only (0/41 regions doubleSided); skip the four canopy cards (100%
   doubleSided) and route the mixed branch part per-region; the real win here is the texture lane.
5. **Sign** — foot plinth, capital band, finial cap, 8-sided post, plus a new *edge-frame/rebate* op for the
   board; 10x is trivially reachable and barely visible — the 64x64 INDEX16 texture is the actual problem.
6. **Wall** — plinth already generated and gate-green; to 10x add coping course, radial voussoir band around
   the arch, end piers, and rectangular boundary-clamped block relief on the two 219 m2 faces.
7. **Cave** — this is a different lane entirely (Environment `0x0D` records, not GfxObjs): subdivide and
   displace wall/ceiling planes into rock, add floor rubble and ceiling fins, with every CellPortal edge
   frozen to the float.
8. **Lifestone** — re-*facet* the crystal (do not subdivide it), chamfer the three identical claw legs, and
   give it the ground plinth it has never had; best value-per-triangle in the whole set.
9. **Door** — panelled leaf via the same new edge-frame op, moulded stiles/rails, hinge straps, jamb rebate;
   used as the vehicle for the server-spawn investigation.
10. **Book** — page thickness, page curl, spine bands, clasp; included to make the honest argument that the
    median 27-triangle catalog object should *not* get a 10x pass.

### One note on the sample list

There is **no Lugian named "Titus"**. Searched: the LSD partial dump (19,686 weenies, `weenie_summary.jsonl`),
ACE's `WeenieClassName.cs` enum, the live ACE `ace_world` weenie table, and the acpedia title index
(37,571 titles) — zero hits for "titus" in any of them. Board 02 substitutes **wcid 24286 "Lugian Titan"**
(`lugiantitan`), and notes that *every* Lugian in ACE shares Setup `0x02000A0B` and MotionTable `0x09000006`,
so the choice of individual Lugian does not change the analysis.

---

## 2. Server-spawned objects (the door, the lifestone) — VERDICT: CONFIRMED

**A DAT-side mesh upgrade automatically reaches server-spawned objects. The server never sends geometry.**

The trace, end to end, all readable ground truth:

1. ACE `landblock_instance` row -> `weenie_Class_Id` 73395 (`Door`, WeenieType 19).
2. ACE `weenie_properties_d_i_d`, `type = 1` (`PropertyDataId.Setup`) = `33555023` = `0x0200024F`.
3. ACE `Source/ACE.Server/WorldObjects/WorldObject_Networking.cs:356` — `writer.Write(SetupTableId)`.
   A uint32. That is the entire mesh payload.
4. Wire: Chorizite `protocol.xml:6691`, `PhysicsDesc` mask `0x00000001`,
   `<field type="uint" name="SetupId" text="setup table id for this object" />`.
5. Client: `CPhysicsObj::makeAnimObject(setup_id, bCreateParts)` -> `CPartArray::SetSetupID(setup_id, ...)`.
6. Inside `CPartArray::SetSetupID` (decomp `acclient.c`, verified body):
   `QualifiedDataID::QualifiedDataID(&v9, setup_id, 7u); v6 = DBObj::Get(v5);` — **the DAT cache.**
   This is exactly where our patched bytes are read.
7. `CPartArray::InitParts()` instantiates each Setup part -> GfxObj `0x0100097C` / `0x0100097D` from portal.dat.
8. `D3DPolyRender::ConstructMesh` draws the flat polygon list — appended triangles included (per the
   already-established finding that `CGfxObj::InitLoad` discards non-portal drawing-BSP nodes).

Nothing in that chain is influenced by *who* spawned the object. The server owns identity, state and
placement; the client owns the mesh. Scope:

- **26,348 door instances** and all **365,183 `landblock_instance` rows** in the live ACE world DB inherit a
  DAT mesh upgrade for free.
- **3,909 distinct SetupDIDs** are referenced by the 19,154 weenie classes ACE spawns, out of 5,935 Setups in
  portal.dat — ~66% of the Setup catalog is live server-side content.
- The same holds for lifestones, chests, NPCs, monsters, portals, house hooks, and equipped items: every one
  is described by DIDs (Setup, MotionTable, SoundTable, PhysicsScript, ClothingBase, Palette), never vertices.

**Two caveats, both real:**

- ACE runs its *own* physics from *its own* copy of the DATs (`ACE.DatLoader` reads `SetupModel`/`GfxObj`).
  If a patch ever changes the physics polygon list, or `Height`/`Radius`/`StepUp`/`StepDown`/the collision
  spheres in the Setup, client and server disagree about where the object is. This is precisely why
  `obj-import` has `preservePhysics` and why the cottage patch kept 59 physics polys byte-identical.
- Deploy the patched portal.dat to **both** the client and the ACE server directory. For render-only relief
  the divergence is harmless; the moment anything touches physics it is a bug factory.

No in-game proof was produced (and none is needed to answer the question). An eyeball pass on the 1070 would
*confirm* it visually but cannot change the answer.

---

## 3. Creatures — what 10x means for an articulated model

**AC creatures are not skinned.** Each part is a rigid `GfxObj`; `MotionTable` (0x09) -> `Animation` (0x03)
supplies an absolute origin + quaternion **per part per frame**. Verified by parsing Setup `0x02000A0B`
(21 parts, 586 render tris, 1,758 verts, 2.63 m tall) and posing it from both its `PlacementFrames[0]` and
from `Animation 0x030005DE` frame 0 (the default-style Ready cycle) — identical standing pose.

Consequences:

- **Subdivision buys silhouette and Gouraud shading only.** It can never buy smooth joint deformation,
  because there is no skinning to improve. Ten times the triangles on a Lugian still bends at exactly the
  same 21 rigid hinges.
- **Hard coupling: part count and part order are frozen.** `Animation.NumParts` is stored in every 0x03
  record, and every frame carries exactly that many `Frame`s. Add, remove or reorder a part and you invalidate
  every animation that references the setup. 10x must be **strictly in-place growth of each existing part
  GfxObj** — the exact same append-only contract the relief gate already enforces, applied per part.
- **Part seams are the real risk.** Neighbouring parts interpenetrate at shoulder/hip by design. Any
  tessellation that displaces vertices outward re-opens or widens those seams *during animation*, where it is
  hardest to catch. Displacement must be clamped to zero on each part's boundary ring — the same guard the
  `organic_tess` prototype already uses for region boundaries.
- **Scale trap.** Creatures are re-scaled per weenie (`PropertyFloat 39 ObjScale`) and by Setup
  `DefaultScale`. A 10x mesh on a 0.5x-scaled variant is wasted budget; on a 3x Titan it is the one place it
  pays.
- **Anim hooks are safe.** `AnimationHook` entries reference part *indices*, which in-place growth does not
  change.
- Where the triangles should actually go: the barrel torso and thighs (currently 8-sided prisms), shoulder
  pauldrons, head/jaw silhouette, hands. Not feet, not fingers — sub-pixel at gameplay distance.

Budget: 586 -> ~5,900 tris on one creature setup is roughly +590 KB of record at the measured marginal cost.

---

## 4. The cave — dungeon geometry is a different (and much better) lane

Caves and dungeons are **not GfxObjs**. Geometry lives in `Environment` records (`0x0D`) in portal.dat; each
`EnvCell` in `client_cell_1.dat` names an `EnvironmentId` + a `CellStructure` index + a placement `Frame`.
WBT in this build (185 commands) has **no `render-dungeon` command** — the board's renders come from a Python
port of `ACE.DatLoader`'s `Environment` / `CellStruct` / `EnvCell` / `BSPNode` parsing, run over the read-only
base dats. 688 of 772 Environment records parse clean with it.

Measured:

| Quantity | Value |
|---|---|
| Environment (`0x0D`) records | 772, **6.03 MiB total** |
| CellStructs inside them | 2,683 |
| Render polygons across the 688 that parse | 33,613 (~37.7k extrapolated) |
| `EnvCell` records in client_cell_1.dat | **734,976** |
| Sample dungeon (LB `0x018B`, "largecave") | 212 EnvCells, 3,503 render tris, 30 distinct Environments |

**This is the single best value-per-byte opportunity in the entire project.** Six megabytes of records are
instanced 735,000 times. Ten-fold on *all* dungeon geometry in the game costs roughly **+43 to +54 MiB** —
under 5% of the available headroom, for every cave, mine, crypt and vault in Dereth.

What a 10x pass means there:

- A `CellStruct` has the same primitives as a GfxObj — `CVertexArray` + a Polygon dict + a cell BSP + physics
  polys + an optional drawing BSP — so the append-only relief/tessellation toolchain transfers directly, one
  struct at a time.
- Subdivide + normal-displace wall and ceiling planes into rock; add a floor rubble band and ceiling fins. A
  cave chamber currently averages ~12 polygons.
- **Hard boundary rule:** any cell edge carrying a `CellPortal` must not move by a single float. Portals are
  matched between cells by polygon id and exact vertex match, and the visibility set is built from them. A
  moved portal edge leaks geometry or breaks PVS.
- Physics polys are a separate list in the same struct — leave byte-identical, same as GfxObjs.
- Risk is **concentrated, not diffuse**: 30 Environments cover the whole sample cave. A bad displacement
  appears in every dungeon that shares the struct, so the eyeball pass must be per-Environment, not
  per-dungeon.

---

## 5. Hard-limit math for 10x at 100% coverage

### 5.1 Full record census of the base `client_portal.dat`

79,694 records, 812.5 MiB of record bytes in an 884.0 MiB file (1024-byte blocks + free list).

| Type | Records | Bytes | Note |
|---|---:|---:|---|
| `0x06` Texture | 20,684 | **578.4 MiB** | the bulk of the dat |
| `0x01` GfxObj | 15,318 | **77.7 MiB** | the 10x target |
| `0x03` Animation | 2,066 | 53.6 MiB | |
| `0x0A` Wave | 786 | 50.0 MiB | |
| `0x04` Palette | 4,521 | 35.4 MiB | |
| `0x0D` Environment | 772 | **6.03 MiB** | dungeon geometry |
| `0x02` Setup | 5,935 | 2.2 MiB | |
| everything else | 29,612 | ~9 MiB | |

### 5.2 GfxObj geometry census (all 15,318 records, exported and counted)

- **869,312 render triangles** total, **615,119 vertices**.
- Mean 57 tris, **median 27**, p75 62, p90 128, p95 212, p99 460, **max 2,483** (`0x01004703`).
- Max vertices in any single model: **1,446**. Mean 40, median 20.
- Distribution: 43.0% of records are 1-20 tris; 26.8% are 21-50; **69.7% are 50 or fewer**. Only 118 records
  (0.77%) exceed 500 triangles; 26 exceed 1,000.
- (`obj-export` counts a double-sided retail polygon as two triangles — the same convention throughout.)

### 5.3 The 16-bit format caps are NOT the binding constraint

| Cap | Source | Worst existing model | Headroom |
|---|---|---|---|
| **32,767 vertices** per GfxObj | `Polygon.VertexIds` is `List<short>` | 1,446 verts | **22.6x** |
| **65,535 polygons** per GfxObj | `Polygons` is `Dictionary<ushort, Polygon>` | 2,483 tris | **26.4x** |
| 255 points per polygon | `Polygon.NumPts` is a byte | 3-4 | n/a |
| 255 UVs per vertex | `PosUVIndices` are bytes | 1-2 | n/a |

At 10x the largest model in the catalog reaches ~14,460 verts and ~24,830 polys — comfortably inside both
caps. **10x does not break the wire formats.** (20x would start to.)

The real ceiling is the file: **2 GiB - 1** (bit 31 of block offsets is a flag; retail seeks with a signed
32-bit `SetFilePointer`). portal.dat is 884.0 MiB, so **headroom = 1,220,542,463 bytes = 1,164.0 MiB
(1.137 GiB)**.

### 5.4 Marginal byte cost per added triangle — measured, not guessed

The proven cottage patch: record `0x0100082E` went **10,443 -> 21,810 bytes for +102 triangles =
111.4 B per added triangle**. That is the full round-trip cost through `obj-import` (re-serialised vertex
array, new surface table, appended polygons).

First-principles floor for an appended triangle: one `Polygon` record (~19-22 B + 2 B dict key) plus 1-3 new
`SWVertex` (12 B origin + 12 B normal + 2 B count + 8 B per UV = 34 B for one UV) = **~60 B/tri with good
vertex sharing, ~130 B/tri for isolated triangles**. The measured 111 B/tri sits exactly in that band, so the
model is trustworthy. A generator that fans/strips its appended geometry should land nearer 60-90.

### 5.5 What 10x actually costs

10x on all GfxObjs = **+7,823,808 triangles**.

| Marginal cost | Added bytes | Share of the 1,164 MiB headroom |
|---|---:|---:|
| 60 B/tri (optimistic, heavy vertex sharing) | 448 MiB | 38.5% |
| 90 B/tri (realistic for a tuned generator) | 672 MiB | 57.7% |
| 111 B/tri (measured today) | **828 MiB** | **71.2%** |

Plus, on the same budget:

- 10x on all dungeon Environments: **+43 to +54 MiB**.
- Texture lane, modelled from a full census of all 20,684 texture records (dims + pixel format parsed from
  each record):

| Texture plan | New size | Delta |
|---|---:|---:|
| Re-encode to DXT1/DXT5, **no** up-res | 386 MB | **-193 MB** (a saving: 12,984 records are uncompressed A8R8G8B8, 1,190 are R8G8B8) |
| Remacri 4x, DXT capped 512^2, INDEX16 capped 256^2, icons untouched | 949 MB | **+371 MB (+354 MiB)** |
| Remacri 4x, DXT capped 512^2, INDEX16 capped 512^2 | 1,858 MB | +1,279 MB — **blows the ceiling** |
| Remacri 4x, DXT capped 1024^2 | 2,527 MB | +1,949 MB — **blows the ceiling** |

(Content breakdown: 13,394 records are <=32^2 icons totalling 65.8 MB; 7,290 content textures hold 512.6 MB.
Largest families: 12,852 x 32^2, 2,035 x 128^2, 1,145 x 256^2, 357 x 512^2.)

### 5.6 The verdict

**10x geometry across 100% of the GfxObj catalog is arithmetically borderline, not comfortable.**

Best realistic combined case:

```
10x GfxObj geometry  @ 90 B/tri         672 MiB
10x dungeon Environments                 54 MiB
Remacri 4x textures, 512/256 caps       354 MiB
                                     ----------
                                      1,080 MiB   of 1,164 MiB headroom  (92.8%)
```

At the *measured* 111 B/tri the same plan is **1,236 MiB — about 6% over the ceiling**, and a dat that
crosses 2 GiB - 1 does not fail loudly: retail opens it and silently misreads.

So: it *can* be made to fit, but only if (a) the generator is tuned to <=90 B per added triangle, (b) the
texture lane accepts a 512/256 cap, and (c) nobody spends the remaining ~7% margin on anything else. There
is no room for a second idea.

### 5.7 The non-byte limits, which are worse

1. **Runtime.** The retail client is a single-threaded D3D9 fixed-function renderer doing per-vertex Gouraud.
   Multiplying world geometry ~10x multiplies per-frame triangle throughput by roughly the same factor inside
   the PVS. This has not been measured and is the largest unknown in the whole plan. Mitigation exists in the
   format: `GfxObjFlags.HasDIDDegrade` + `DIDDegrade` is a retail LOD chain — the 10x mesh can be placed at
   LOD0 only, leaving distant draws at retail cost. That should be designed in from the start, not retrofitted.
2. **Drawing BSP.** Appended triangles render without a valid drawing BSP (established), which is fine for
   opaque geometry under the z-buffer, but alpha-blended surfaces sort through that tree. Any model with
   translucent surfaces needs `bsp-build` re-run, or it will sort wrong.
3. **Verification throughput.** 15,318 records x (gate + a human look) is the actual schedule. At one minute
   of artist review per record that is 255 hours. The gate catches geometric invariants; it cannot catch
   "this looks wrong".
4. **WARNING — the cell-dat export bloat, flagged as urgent.** Both proven patch outputs
   (`/mnt/wbterminal2/dat-patch-opus/` and `/mnt/wbterminal2/dat-patch-reliefgen/`) contain a
   `client_cell_1.dat` of **1,812,198,915 bytes** whose record content is **byte-identical to the base**
   (805,348 records, 210,460,134 B in both). The export path inflated the file **5.2x with zero added
   content**, to **84.4% of the 2 GiB - 1 ceiling**. portal.dat behaved correctly in the same runs
   (+51,200 B on disk for an +11,367 B record). Whatever pre-grow/free-list logic does that to a
   256-byte-block dat must be understood and fixed **before** any bulk patch, or the cell dat will cross the
   ceiling on its own.

---

## 6. Recommended realistic targets

Spend the budget by **screen area**, not by record count. 69.7% of the catalog is <=50 triangles and consists
of props, hooks, debris and inventory items that no player will ever see more closely.

| Tier | Scope | Records | Target | Est. cost @90 B/tri |
|---|---|---:|---|---:|
| **A** Artist plans | Landmark architecture, town walls, bridges, lifestones, hero creature setups | ~300 | **8-12x** | ~25 MiB |
| **B** Generator ops | Architectural & large statics (low uvMap residual, 0 doubleSided) | ~2,000 | **4-6x** | ~90 MiB |
| **C** Dungeon Environments | All `0x0D` records | 772 | **6-10x** | ~45 MiB |
| **D** Long tail | <=50-tri props | ~10,700 | **1.5-3x** (edge rails only) or skip | ~35 MiB |
| **Skip** | doubleSided billboard foliage | — | 0x, texture lane only | 0 |

Total geometry ~= **195 MiB**, leaving ~970 MiB for the texture lane — which is where most of the *perceived*
modernisation actually lives, and which can then afford a more generous cap than 512/256 on hero surfaces.

World-wide effect: total render triangles go from 869k to roughly **3.2-3.8 million (~4x)**, concentrated
entirely on what the camera sees, with a runtime cost the retail client can plausibly carry and a byte budget
with real slack in it.

**If the owner wants a headline number: 4x across the world, 10x on the ~300 objects that matter, and
10x underground, is the honest shape of this project.** A literal 10x on all 15,318 records is achievable on
paper and unwise in practice — it consumes 71% of the file headroom to improve 10,700 objects nobody looks at,
while the same bytes spent on textures and on Tier A/B/C would look dramatically better.

---

## 7. New generator ops this investigation says are needed

The current registry is `plinth`, `opening_surround`, `belt_course`. Every board in this set ran into the
same missing pieces:

1. **`edge_frame`** — an inset frame/rebate around a flat region boundary (proud, band, inset). Needed by the
   sign board, the door leaf, every plaque, shutter and panel. Probably the single highest-reuse op.
2. **`belt_course` + `inset`** — the wall's belt failed `borders-on-original-surface` purely because it ran
   off the tapered ends. A clip-to-region-boundary inset parameter fixes an entire class of refusals.
3. **`voussoir`** — a radial band following an arch profile. Needed by the wall and the bridge.
4. **`facet`** — split each planar face into a shallow pyramid, keeping silhouette edges sharp. The right
   answer for the lifestone crystal and for any gem/crystal/rock in the catalog; multiplies triangles 3-4x
   with correct Gouraud shading and zero silhouette risk.
5. **`organic_tess`** — already prototyped; boundary-clamped Phong tessellation with the doubleSided guard.
   Needed by the tree trunk, creature parts and dungeon walls.
6. **`module_link`** — a plan-level declaration that two GfxObjs share a joint plane, so the generator freezes
   that plane and mirrors the profile. Needed by the bridge and by every modular static in the world.

And one **artist-facing fix** the wall board proved out: plans currently guess `proud` in metres, but the gate
checks in *UV* space. The cottage's map is 0.333 uv/m and the wall's is 0.5 uv/m, so the same 0.10 proud
passes on one and fails on the other. The plan schema should let the artist say `proud: {uv: 0.03}` and have
the generator solve for metres from `uvMap.M` in the region summary.

---

## 8. Reproduction

Working directory `/mnt/wbterminal2/dpc-work/` contains everything:

- `datlib.py` — read-only Python port of `ACE.DatLoader` (DAT B-tree/blocks, `SetupModel`, `GfxObj` vertex
  arrays, `Environment`/`CellStruct`/`BSPNode`, `EnvCell`).
- `objlib.py` — the software z-buffer renderer. `asm.py` / `cavelib.py` — setup and dungeon assembly.
- `board.py` / `common.py` / `b01.py` ... `b10.py` — the board compositor and one script per board.
- `census.json`, `gfx_geo.json`, `gfx_verts.json`, `gfx_sizes.json` — the full 15,318-record censuses.
- `relief/` — the real generated A/Bs and the gate check reports (`cottage_*`, `wall_*`, `wp_a..wp_e`).
- `proj/` — a WBT project over a **copy** of the base dats; the originals in `~/ac_base_dats/` were never
  written to.
