# AcmeRedline — system design (pipeline side)

**Status:** design + working skeleton, 2026-08-20. Nothing here modifies an existing
pipeline file; every integration point below is a *proposal*, marked as such.

**Scope split.** The in-game Chorizite plugin lives in `AcmeRedline/` and is another
agent's work. This document and everything under `tools/dat-patch/redline/` is the
**consumer** side: it reads what the plugin wrote and turns it into work items for the
lanes that already exist in `tools/dat-patch/`.

Every claim about the pipeline below carries a `file:line` citation. Where something was
*not* verified, it says so in a `TODO` naming exactly what was and was not checked.

---

## 1. Why this exists

The dat-patch pipeline has an asymmetry. It can *measure* structure precisely — the
whole gate stack in `tools/dat-patch/` (`walk_check.py`, `validate.py`,
`texture_lane.py` round-trip at `texture_lane.py:665-697`, `variant_verify.py`) proves a
dat is well-formed — but the thing it is actually optimising, *does this look better*, is
eye-only. `tools/dat-patch/release.sh:7` states the rule outright: "tooling proves
structure, only the retail client proves render semantics."

Today the eyes belong to one person doing batched 1070 sessions. AcmeRedline turns
players into a distributed sampling of those eyes, at the exact granularity the lanes
work at: a RenderSurface id, or a set of triangles on a GfxObj.

The value is not "bug reports". It is **exposure-weighted targeting**. The hedonic plan
(`docs/dat-patch/PLAN-2026-08-18-hedonic-allocation.md:46`) scores a byte as
`(visible improvement × screen-time exposure) ÷ (bytes + resident cost + risk)`. The
numerator's second term has never been measurable. A redline queue measures it directly:
the records players actually complain about are, by construction, the records players
actually look at.

---

## 2. Data flow

```
  in-game plugin (AcmeRedline/, not this scope)
     │  player selects a texture / triangle patch / object, types feedback
     │  pre-flights against acme-meta.json  ─────────────┐
     ▼                                                   │
  redline.jsonl            (append-only, one entry/line) │
  shots/<id>-view.png                                    │
  shots/<id>-mask.png                                    │
     │                                                   │
     ▼                                                   │
  queue_worker.py  ── reads client_portal.dat (READ-ONLY) via datlib/gfxlib
     │  validate → resolve → guard → classify → aggregate
     ▼
  work-items.json          (one item per TARGET id, not per report)
     │
     ▼
  an AI agent (or a human) picks the top item
     │  status_writer.py --state in-progress
     │  runs the named lane: texture_lane.py / fill_import.py / tranche.py / terrain_lane.py
     │  before/after verification (§7)
     │  status_writer.py --state fixed --release acme-rN
     ▼
  redline-status.jsonl     (append-only event log)
     │
     ▼
  the plugin tails it and shows the reporter "fixed in acme-r10"
                                                         │
  gen_kit_meta.py ──► acme-meta.json ────────────────────┘
     (built alongside the kit; tells the plugin which RenderSurfaces are
      terrain-protected and which are palette-route, before a report is filed)
```

Two files, both append-only, both JSONL. No database, no daemon, no server. The queue is
whatever directory the plugin writes to; the worker takes a path.

---

## 3. The queue entry schema (v1, frozen)

Reproduced verbatim as the contract the plugin emits. The machine-checkable form is
`tools/dat-patch/redline/schema_v1.json`; field-by-field notes and the open contract
questions are in `docs/redline/SCHEMA.md`.

```json
{
 "id": "rl-<utc yyyymmdd-hhmmss>-<4 hex>", "v": 1, "createdAt": "<ISO8601 UTC>",
 "author": "<account name>",
 "clientRelease": {"kitTag": "acme-r9", "portalSha256": "...", "highresSha256": "..."},
 "world": {"landblock": "0x....", "pos": [x,y,z], "heading": deg},
 "camera": {"pos": [x,y,z], "lookAt": [x,y,z], "fovDeg": f},
 "selection": {
   "kind": "texture" | "triangles" | "object",
   "objects": [{"objectId": "0x...", "setupId": "0x02......", "gfxObjId": "0x01......", "worldFrame": {"pos": [x,y,z], "quat": [w,x,y,z]}}],
   "renderSurfaces": [{"rsId": "0x06......", "surfaceId": "0x08......", "surfaceTextureId": "0x05......", "uvHints": [[u,v]]}],
   "triangles": {"gfxObjId": "0x01......", "indices": [int], "footprint": {"centroids": [[x,y,z]], "normals": [[x,y,z]], "areaM2": f}, "baseRecordSha256": "<sha of GfxObj record bytes>"},
   "screenLasso": {"points": [[x,y]], "viewport": [w,h]}
 },
 "prompt": "<free text>", "tags": ["too-blurry","wrong-material","seam","silhouette","remove-detail","recolor","other"], "severity": 1,
 "attachments": ["shots/<id>-view.png", "shots/<id>-mask.png"],
 "guards": {"terrainProtected": false, "paletteRoute": false},
 "status": {"state": "queued"}
}
```

Status events live in a **separate** append-only log, `redline-status.jsonl`:

```json
{"entryId": "...", "at": "<ISO>", "state": "queued|in-progress|fixed", "release": "acme-rN", "note": "...", "by": "<agent/tool>"}
```

Derived current state = the **last** event for an entryId
(`queue_worker.derive_status`, `tools/dat-patch/redline/queue_worker.py`). The
`status.state` inside an entry is a seed value only.

### Why the split

The entry file is a **fact record** written once by the plugin; the status file is a
**process record** written many times by tools. Keeping them apart means:

* the queue file is never rewritten, so it can be `cat`-appended from the game client
  with no read-modify-write and no locking on the plugin side;
* an agent that mangles a status write cannot corrupt the report itself;
* history is preserved — "who picked this up, when, and what did they say" is the log,
  not a mutable field;
* the plugin's in-game display only has to tail one small file.

`status_writer.append_event` validates against the schema *before* appending, and writes
under `flock(LOCK_EX)` so two agents finishing simultaneously cannot interleave a line.

### Lifecycle

```
 queued ──(agent claims)──► in-progress ──(kit ships)──► fixed
    ▲                            │
    └────(reopened: append a new "queued" event)◄────────┘
```

Only three states, deliberately: the plugin has to render this in an AC UI. A
`--state fixed` event **requires** `--release`, because "fixed" with no kit tag is
unverifiable by the reporter (`status_writer.py`, `main()`).

`queue_worker.py --status <log>` skips entries whose derived state is `fixed`, so a
re-run of the worker naturally shrinks to the open backlog. `--include-fixed` overrides.

---

## 4. Resolution: what the worker checks against the real dats

Every id in a report is a claim by a plugin running against *some* kit. The worker
re-derives all of it from the dat it is pointed at, through the pipeline's own readers
(`tools/dat-patch/datlib.py`, `tools/dat-patch/gfxlib.py`) — never a re-implementation.

| Claim | Check | Grounded in |
|---|---|---|
| GfxObj record exists | `gid in dat.files` | `datlib.py:51` |
| its true tri/poly/vert counts | fan-triangulate `rec["polys"]` | `gfxlib.parse_gfxobj`, `gfxlib.py:170`; drawn-count convention `tranche.py:301` |
| the record has not moved under the reporter | `sha256(dat.get(gid))` vs `baseRecordSha256` | `datlib.Dat.get` returns the **inflated** bytes, `datlib.py:51-65` |
| RenderSurface dims + format | 24-byte header `Id,DataCategory,W,H,Format,len` | `texture_lane.rs_header`, `texture_lane.py:68-78`; same layout `fill_import.py:37-43` |
| palettized record's palette | trailing `DefaultPaletteId` after the payload | `fill_import.default_palette`, `fill_import.py:45-53` |
| Surface → SurfaceTexture → RenderSurface | `Portal.surface()` walks the chain and takes the highest entry **present in this dat** | `gfxlib.py:318-342` |
| degrade bands | `GfxObjDegradeInfo`, nearest band first | `gfxlib.parse_degrade_info`, `gfxlib.py:235-253` |
| Setup parts | `parse_setup` | `datlib.py:108` |
| instance exposure | every `0x____FFFE` LandBlockInfo record, `buildings[] + objects[]`, model ids resolved to GfxObjs | the same walk `tranche.py:187-201` + `pilot.resolve_gfx`, `pilot.py:94` |

**`stale-selection`.** When `baseRecordSha256` no longer matches, the stored triangle
indices are not trusted at all — another lane may have re-imported the record with a
different polygon count. The worker falls back to `selection.triangles.footprint`:
nearest current triangle centroid to each stored centroid, and it reports the residual
distance so a human can judge whether the match is real
(`queue_worker.Resolver.triangles`). On the fixture this recovers indices `[0,3,5]`
exactly with a 0.6 mm residual.

**Sharp edge — the id a report cites may not exist in the dat you resolve against.** On a
HIFI-split kit the shipped 0x06 records live in `client_highres.dat`
(`PLAN-2026-08-18-hedonic-allocation.md:112-118`), and `gfxlib.Portal.surface` explicitly
takes the highest SurfaceTexture entry *present in the dat it opened*
(`gfxlib.py:332-340`). So the same Surface resolves to different RenderSurfaces on a base
install and on a patched one. The worker does not treat that as an error: it emits an
`rs-id-drift` guard naming both, and a `hasHighresEntry` note telling the agent to patch
the **highres** record.

---

## 5. Guards — the three refusals, mirrored not reinvented

The worker's job on guards is to say *no earlier*, in the same words the lane would use
hours later.

### 5a. Terrain-protected RenderSurfaces → `terrain-lane-only` (blocking)

`tools/dat-patch/terrain_protected_rs.txt` lists 48 RenderSurfaces the retail client
requires at 512² A8R8G8B8: `ImgTex::MergeTexture` locks and composites them, and a
DXT/2048² overwrite reads out of bounds and crashes at
`LandscapeTextureDetail=VeryHigh`. Both texture lanes refuse them —
`texture_lane.py:505-524` and `fill_import.py:77-101` — after this was root-caused on
2026-08-16 when the dungeon lane clobbered `0x06006D4B`/`0x06006D50`.

The worker loads that file with the identical parse and routes any report naming one of
them to the terrain lane, blocked.

> **TODO (not verified):** `terrain_lane.py`'s CLI was **not** read for this deliverable.
> The work item says "route to the terrain lane" and stops short of naming arguments.
> Read its `argparse` before scheduling one of these.

### 5b. INDEX16 / P8 → palette route (non-blocking, but format-locked)

`PFID_P8 = 41`, `PFID_INDEX16 = 101` (`texture_lane.py:52-64` — the values were
corrected on 2026-08-16 after a hex/decimal confusion). Converting such a record to DXT
freezes its colours and breaks every ClothingTable subpalette recolour, which is most of
the creature/clothing corpus (`fill_import.py:13-19`). The shipped route keeps the
format: 2× upscale, indices re-solved against the record's **own** palette and its
**own** used index subset, emitted as raw record bytes for `DatRecordInsert` rather than
`render-surface-import` (`fill_import.py:150-170`).

There is one deliberate exception in the texture lane — a palettized record *with* a
palette-resolved base PNG has already been vetted for recolor safety and may be converted
(`texture_lane.py:533-544`). The work item names this so an agent doesn't rediscover it
by accident.

Scale check: `gen_kit_meta.py` counts **4,182 INDEX16 + 6 P8 = 4,188** palette-route
RenderSurfaces in the retail portal — the same 4,182 the hedonic plan calls the recolor
wall (`PLAN-2026-08-18-hedonic-allocation.md:53`). This guard is not an edge case; it is
20% of the portal's RenderSurfaces.

### 5c. Degrade band 0 is a different record → `band0-not-self` (blocking)

When a GfxObj carries a `GfxObjDegradeInfo`, `CPhysicsPart::LoadGfxObjArray` fills the
draw array **exclusively** from the band ids — the root mesh is never inserted at any
index, including 0. Patching such a carrier is completely invisible at every distance.
`tranche.py` enforces this twice: once in `enumerate` (`tranche.py:309-330`, writing the
record to `degrade_deferred.json`) and again in `build` as belt-and-braces
(`tranche.py:458-464`). Measured over the 1,921-record tranche: 1,310 carriers, 9 of them
not their own band 0.

The worker mirrors it, and adds what a report makes possible and a batch run does not: it
names the band-0 object as the **retarget candidate**, because the reporter was looking
at that mesh, not this one.

### 5d. The advisory guards, and guard drift

`entry.guards` is the plugin's optimistic pre-flight from `acme-meta.json`. It is never
trusted. The worker re-derives both flags from the dats and emits a `guard-drift` guard
when they disagree — which in practice means the player's `acme-meta.json` is from a
different kit than the dat the worker is resolving against. The fixture exercises this:
`rl-20260820-103355-b2d9` reports `paletteRoute: false` on `0x06004232`, which is
INDEX16.

Two more, non-blocking:

* `below-min-tris` — `tranche.py:303-308` routes records at or below `--min-tris` (50) to
  `skip-small`, on the grounds that the texture lane covers them for free. A report on
  one is a deliberate override, and the work item says which flag to pass.
* `dims-not-mult-4` — the DXT route skips non-multiple-of-4 dimensions
  (`texture_lane.py:591-596`).

---

## 6. Classification: lane + knob menu

This is the heart. A work item is only useful if it names the **actual knob** a lane
exposes, pre-filled with this record's measured facts. The mapping:

| selection.kind | tags | lane | knobs the work item names |
|---|---|---|---|
| texture | `too-blurry`, `seam`, `other` | `texture-legibility-rebake` | source dims/format read from the record; 4× target capped at 2048/side and snapped to mult-4; `DXT5` if Base1ClipMap else `DXT1`; the two WBT commands with their arguments; `DATPATCH_BAKE_MAX_SIDE` / `DATPATCH_REMACRI` / `DATPATCH_WRAPPED_CORPUS` / `DATPATCH_TEX_BASE` / `DATPATCH_DEBLOCK_BASE`; gainset `mid` |
| texture | `wrong-material`, `recolor` | `texture-source-replacement` | no automated recipe — flagged for a human/AI art step, with the `uvHints` bbox converted to a **texel rect at the record's real dims** |
| texture | (RS is INDEX16/P8) | `texture-palette-fill` | `fill_import.py` invocation; 2× target; `keepFormat`; the record's `DefaultPaletteId`; the note that these records are inserted by `DatRecordInsert`, not `render-surface-import` |
| texture | (RS terrain-protected) | `terrain-lane-only` | blocked |
| triangles | `remove-detail` | `geometry-displace` | **per-poly exclusion** (`relief3d.py:152-163`, amplitudes pinned at `:287-304`); **amp override** (`pilot.AMP_WALL=0.20`, `GROUND_SCALE=0.55`, `matlib.CLASS_AMP`, ceiling `relief3d.MAX_AMPLITUDE_M=0.10`); **class veto** (`pilot.WALL_CLASSES`, `pipeline.surface_meta(force=…)`, `pipeline.OVERRIDES`) |
| triangles | `silhouette` | `geometry-displace` | **mult override** into r2's 4–6× band (`tranche._mult_for`, `tranche.py:204-213`) with the added-triangle and byte estimate at 106 B/tri; `--max-segments` / `--area-share` / `FINE_BUDGET` back-off (`tranche.py:471-473`) |
| triangles | (band0 ≠ self) | `geometry-degrade-deferred` | blocked, band objects listed as retarget candidates |
| object | any | `triage` | candidate surfaces enumerated; the selection needs narrowing |

Every geometry item also carries the rebuild invocation
`tranche.py build --root … --only <gid>` (`--only` refuses ids that are not
`route=displace`, `tranche.py:533-539`) **plus the resume warning**: the resume hash
covers the base record bytes *and* every recipe knob, so changing a knob without bumping
`RECIPE_VERSION` silently reuses the stale OBJ (`tranche.py:111`, `:440-450`).

Three facts the classifier volunteers because they change what the right answer is:

* **Already-excluded polygons.** A `remove-detail` selection whose polygons are NoPos
  fillers, CullMode.None alpha cards or CullMode.Clockwise sheets is already satisfied —
  those polys carry no shell today (`relief3d.py:152`, `:287-304`).
* **Up-facing triangles.** `nz ≥ 0.7` means the orientation veto already stops them
  carving, because displacing a walkable surface upward over untouched physics is the r5
  feet-sink (`relief3d.py:38-61`). The fixture's gem selection hits this: 2 of 3
  triangles are up-facing.
* **Record-level relief vetoes.** Clipmap / non-image / translucent / luminous Surfaces
  can never carve (`matlib.py:89-97`). The worker reproduces exactly those four branches,
  because they read only the Surface record. It deliberately does **not** reproduce the
  material *class* lookup, which needs `DATPATCH_CLASSES_JSON` and
  `DATPATCH_CURATED_JSON` (`matlib.py:28-33`) — it says so in the work item and points at
  `tranche.py enumerate` for the class.

> **TODO (not verified — the one real gap):** the shipped tranche has **no per-polygon
> override input**. Exclusion is derived from the record's own `stip`/`sides` at
> `relief3d.py:152`; nothing reads a per-record poly list. Landing `per-poly-exclusion`
> needs a small override file threaded into `pilot.recipe_c_source` (`pilot.py:237`) or
> `relief3d.SourceMesh.from_record` (`relief3d.py:127`), plus a `RECIPE_VERSION` bump.
> The work item says this rather than pretending the knob exists. Each `indices` entry
> resolves to a source polygon (§6a), so a `per-poly-exclusion` action names the polygon
> list indices directly (`polygons`) alongside the triangle indices (`triangles`) — the
> override file would key on exactly those polygons.

### 6a. Triangle index convention — the plugin's frozen contract

`selection.triangles.indices` are indices into the record's **fan-triangulated
draw-triangle stream over EVERY polygon in CGfxObj record (positional) order** — not
drawn-only, not polygon keys. Polygon *pi* (0-based record order) contributes
`len(v)-2` triangles emitted `(v[0], v[k], v[k+1])`; stippled/NoPos filler polys stay
**in** the stream so an index is a stable address. This is `queue_worker._tri_stream`,
byte-for-byte the same fan `relief3d.SourceMesh` triangulates from (`pilot.py:273` uses
the identical `len(v)-2` fan).

**This convention is owned by the plugin side and is frozen.** It was pinned by the plugin
author against decisive evidence, which the pipeline verified:

* the plugin's emit builds exactly this stream —
  `AcmeRedline/Services/SelectionService.cs:639-699` (`BuildFanStreamStatic` +
  `BuildFanTrianglePayload`, "over EVERY polygon in the record, in record (positional)
  order — NOT drawn-only");
* the decomp it cites, `Render::GfxObjUnderSelectionRay`
  (`ac-headers/acclient.c:379997`), iterates `mesh->polygons` **positionally** over
  `num_polygons` — the client exposes no polygon *key*, and `MouseSelectData.PolygonID`
  is the object id + **part** index, misnamed;
* decisive: the plugin's own sample uses `indices [16, 85, 241]` on `0x01000827` where
  the record has 226 drawn / **242 total** fan triangles — index 241 is valid **only**
  under the all-polys stream. The pipeline resolved all three cleanly to source polygons
  `[8, 40, 136]`.

The basis is carried by **matching it exactly**, not by any in-entry field: the frozen
`selection.triangles` object is `{gfxObjId, indices, footprint, baseRecordSha256}` with
`additionalProperties: false`. So there is no `indexBasis` in the entry — an entry with
one would fail the plugin's own validation. `triCountAll`/`triCountDrawn` are
**worker-computed outputs** in `work-items.json`, never entry fields; the
`index-count-drift` guard is retained (it fires only if a count-bearing entry is ever
seen — inert for frozen input, a tripwire otherwise).

Each index resolves to a **source polygon**, the granularity every displace knob works at
(`excluded` per-polygon at `relief3d.py:152`, amplitudes welded per-polygon at
`:287-304`). The worker reports per selected polygon: `polyIndex`, `stip`, `sides`,
`surfaceId`, whether it is a NoPos filler, and whether the recipe already excludes it. On
a stale record or out-of-range index it relocates each `footprint.centroid` to the
nearest current **triangle** centroid and reports the worst residual.

---

## 7. Dedup, aggregation, priority

Reports are merged by **primary target id**, not by report:

* `selection.kind == "texture"` → `renderSurfaces[0].rsId`
* `selection.kind == "triangles"` → `triangles.gfxObjId`
* `selection.kind == "object"` → the first object's `gfxObjId`, routed to triage

This is the right key because it is the unit each lane operates on. `texture_lane.py`
bakes per RenderSurface and warms height fields once per RenderSurface, not per record
(`tranche.py:337-349`, "fields are per-texture, not per-record"). `tranche.py` builds per
GfxObj. Merging by anything finer would produce work items that cannot be executed
independently; merging by anything coarser would lose the guard that applies.

Merged fields: entry ids, reporters, tags (union), severity (max), prompts, cameras,
attachments, guards (deduped), actions (deduped **by action name**, with divergent
reasons collected into `alsoBecause` so the menu stays a menu). Resolved facts are a
property of the target, so first-writer-wins — a genuine disagreement would already have
surfaced as `stale-selection` or `rs-id-drift`.

**Priority = reports × instance exposure.**

Instance exposure is the placement count from every LandBlockInfo record in
`client_cell_1.dat` — the same walk `tranche.py:187-201` uses to rank its own budget
(`tranche.py:399-403` orders by `-instances`). It is the pipeline's existing proxy for
screen time, so redline priority is denominated in the same currency as the geometry
budget. `--cell` is optional because the scan costs ~2 minutes; without it exposure is
unknown and priority degenerates to the report count, and the work item says so in
`priorityFormula` rather than presenting a fabricated 1.

The effect on the fixture is the whole argument for the metric. Without `--cell` the two
reports on `0x06003C97` top the list at priority 2. With it, a **single** report on
`0x06004232` (51 placements) outranks them, because one player complaining about a
texture on 51 buildings is worth more than two complaining about one on 42.

Blocked items sort last regardless of priority — they are not actionable until a human
makes a routing decision.

---

## 8. The verification loop — before/after at the reporter's own camera

This is the part where the honest answer matters more than the ambitious one.

### 8a. What actually exists

| Rig | What it renders | Camera control | Where it lives |
|---|---|---|---|
| `eyetest-r72.sh` | **retail acclient** under wine | `@telepoi <name>` / `@teledungeon <name>`, then one 1.3-second left turn | `/mnt/wbterminal2/dat-patch-r7/session-scripts-2026-08-19/eyetest-r72.sh` (archived, **not in git**) |
| `drive-arm.sh` + `acdttour9` | **retail acclient** on the 1070 | `@telepoi` / `@teledungeon 0x<LB>` + a timed scan | `/mnt/wbterminal2/fmcap-1070-2026-08-19/drive-arm.sh`; the `acdt-*.ps1` tasks are Windows-box-local, hardcoded SHAs |
| `shoot.mjs` + `window.__cam` | **holtburger web port** | full eye + look-at + FOV | `/mnt/wbterminal2/eye1070-20260813/shoot.mjs`; API at `external/holtburger/apps/holtburger-web/scene3d/camera.js:1220-1263` |
| `render3.render()` | offline software render of **one GfxObj** | orthographic `(yaw, pitch, centre, radius)` — no eye, no FOV | `tools/dat-patch/render3.py:52` |
| `capture-all.cjs --live` | web port | teleloc only, no heading — **documented stub** | `external/holtburger/scripts/visual-regression/capture-all.cjs:402-430` |

The load-bearing fact: **the pose rig and the dat renderer are disjoint.**

`window.__cam` is exactly the primitive this loop wants —
`set(ex, ey, ez, tx, ty, tz)`, `orbit(tx, ty, tz, dist, azDeg, elDeg)`, `fov(v)`,
`park()`, `release()` (`camera.js:1220-1263`), installed only under an exact-match
`?camDebug=on` opt-in so the default render path is byte-identical
(`camera.js:420-427`, `external/holtburger/apps/holtburger-web/docs/url-flags.md:1504`).
`shoot.mjs` already drives it over CDP
from a named pose file (`pshots.json`: `{"name":"P1-town-az135-d80-el20","orbit":[…],"fov":60,"settle":5000}`).
But it renders the **web port**, which does not read the patched dats the way the retail
client does.

The retail client — the only thing that proves render semantics — has no pose control
beyond teleport plus a fixed 1.3 s turn (`eyetest-r72.sh:20-22, 36-42`). There is also no
before/after *differ* for client frames anywhere: `gallery.py` and
`texture_lane.make_board` (`texture_lane.py:768`) compute pixel-diff percentages, but
only between two offline software renders of a GfxObj, never between two client captures.

### 8b. Proposal (not built)

Three tiers, cheapest first. Only tier 1 is a small piece of work.

**Tier 1 — offline A/B board at the *record* level, camera ignored. BUILT:
`tools/dat-patch/redline/verify_fix.py`.** It *calls* (does not reimplement)
`texture_lane.make_board` (`texture_lane.py:768`, the `board` subcommand at `:1092`),
which renders BEFORE from the base dat and AFTER with textures DXT-decoded straight out
of the patched dat, on an identical camera and identical daylight, and writes
`boards/board_0x…png`.

```
python3 verify_fix.py --target 0x06003C97 --gid 0x01000827 \
    --pre  ~/ac_base_dats/client_portal.dat \
    --post /mnt/wbterminal2/dat-patch-r7/ace-r7-dats/client_portal.dat \
    --root <workdir> --wbt <WorldBuilder.Terminal.dll> \
    --status <log> --entry rl-… --release acme-r10
```

For an `0x06` RenderSurface target it finds a GfxObj that uses the RS (or takes `--gid`);
for an `0x01` GfxObj target it renders that record. On the smoke above (retail base vs the
real r7 4× dat) it produced a 1000×2954 board and reported frame luminance
`hero 0.221→0.260 (+17.4%)`, `graze 0.265→0.312 (+17.7%)` — the r7 legibility bake, read
back out of the patched dat — then appended a schema-valid `fixed` status event whose
`note` carries the board path and those numbers.

Two honest limits, both stated in the tool's docstring:
* make_board's AFTER **geometry** is the recomputed arm-C mesh, not `--post`'s geometry
  (it reads `--post` only for textures). So it is a genuine two-dat A/B for the *texture*
  on a record; a true geometry-from-post-dat diff would need `gallery.py`, which reads
  `export/client_portal.dat` back (`gallery.py:26`) but is a run-once script bound to a
  tranche dir, not a callable — wrapping it is a separate, larger task.
* It requires the retail re-export PNG corpus (`matlib.TEX_BASE`) and a built WBT dll;
  without either the corresponding panel renders untextured but the board still emits.

It does not re-shoot the reporter's pose, and does not pretend to. It answers "did the
record change the way we intended", which is what a `fixed` event needs to be defensible.

**Tier 2 — pose-replay against the web port, for triage only.** `world.landblock` +
`camera.pos` + `camera.lookAt` + `camera.fovDeg` map 1:1 onto
`@teleloc <cell> <x> <y> <z>` followed by `__cam.set(ex,ey,ez,tx,ty,tz)` and
`__cam.fov(f)`. A ~40-line sibling of `shoot.mjs` that reads `work-items.json` and shoots
one frame per work item would give an agent a *look* at what the reporter saw, at the
reporter's exact framing, without a Windows box. Useful for triage and for
`kind: "object"` narrowing. **Not** valid as a fix gate: the web port is a different
renderer.

**Tier 3 — pose control in the retail client.** The genuinely missing capability. The
retail tours address the world at POI-name granularity, so "re-shoot this exact pose"
against `acclient.exe` does not exist today. Two candidate routes, neither investigated:
`@teleloc` gets position and yaw (the `@loc` quaternion is accepted per
`memory/ace-live.md`), which is *most* of a pose but not pitch/FOV; or a client-side
camera hook analogous to `__cam`. This is a research spike, not a task.

> **TODO (not verified):** whether `@teleloc`'s optional quaternion actually sets camera
> orientation in the retail client, or only the character's facing. Not tested for this
> deliverable.

### 8c. What the loop looks like once tier 1 lands

```
  work item picked        status_writer --state in-progress --by agent:<lane>
  run the lane            texture_lane.py run / fill_import.py / tranche.py build --only
  BEFORE/AFTER board      texture_lane.py board --gid …    (or gallery.py for meshes)
  record A/B (BUILT)      verify_fix.py --target <id> --pre <base> --post <patched> --wbt …
  structural gate         walk_check.py, the lane's own round-trip (texture_lane.py:665-697)
  batch the eye check     one 1070 session, per §1070-eyetests-batched — the reporter's
                          landblock joins the tour stop list, since @telepoi granularity
                          is what the retail rig has
  kit                     build_kit_with_meta.sh --tag rN … (assemble_kit.sh + acme-meta, §9)
  close the loop          verify_fix … --status <log> --entry rl-… --release acme-rN
                          (writes the fixed event with the board path in its note)
```

The reporter sees `fixed / acme-r10` in game, on an entry they filed. That round trip is
the product.

---

## 9. Kit-meta integration

Two ways to get `acme-meta.json` into a shipped kit, both leaving `assemble_kit.sh`
untouched.

### 9a. The wrapper (BUILT): `tools/dat-patch/redline/build_kit_with_meta.sh`

A thin wrapper that forwards **every** argument to `assemble_kit.sh` unchanged, then runs
`gen_kit_meta.py` against the dats the kit actually shipped (the copies inside
`$OUT/acme-$TAG/`, so the sidecar's shas match `SHA256SUMS.txt`), and appends
`acme-meta.json` to the kit's `SHA256SUMS.txt` so it is covered by `sha256sum -c`.

```
build_kit_with_meta.sh --tag r9 --portal <dat> [--highres <dat>] --out <dir> [assemble args…]
```

Smoke-tested against the retail portal (with `--no-verify`, since the patcher gate needs
the untracked registry + exes): `assemble_kit.sh` ran unchanged and produced the kit, then
the wrapper wrote `acme-meta.json` (48 terrain-protected + 4,188 palette-route
RenderSurfaces, `portalSha256` matching the shipped dat) and `sha256sum -c SHA256SUMS.txt`
re-verified green **including** the appended meta line. It is fail-loud: a nonzero
`assemble_kit.sh` stops the run before meta; a `gen_kit_meta.py` failure fails the script.

This is the recommended path — it needs no change to a reviewed release script.

### 9b. The inline hook (PROPOSED, not applied)

If the owner later prefers it inline: `assemble_kit.sh` copies the dats, writes
`kit-manifest.txt`, `README.txt` and `SHA256SUMS.txt`, then self-gates. `acme-meta.json`
should be generated **after the dats are copied into `$KIT`** (so its shas are of the
shipped copies) and **before** the `SHA256SUMS.txt` block at `assemble_kit.sh:192`, so the
meta file is itself checksummed.

Insert between line 190 (`sed 's/^/   | /' "$KIT/README.txt" | head -12`) and line 192
(`echo "== SHA256SUMS.txt"`):

```bash
echo "== acme-meta.json (AcmeRedline plugin sidecar)"
python3 "$HERE/../redline/gen_kit_meta.py" --tag "acme-$TAG" \
  --portal "$KIT/client_portal.dat" \
  ${HIGHRES:+--highres "$KIT/client_highres.dat"} \
  --out "$KIT/acme-meta.json" | sed 's/^/   /'
```

and add `acme-meta.json` to the `sha256sum` argument list at `assemble_kit.sh:193-197`.

Note `--tag "acme-$TAG"`: the kit's `$TAG` is bare (`r8`, `r9` — `assemble_kit.sh:27`)
while the entry schema's `kitTag` pattern is `acme-r<N>`, matching the kit *directory*
name `acme-$TAG` (`assemble_kit.sh:53`). Runtime is ~12 s on the retail portal (measured);
add ~10 s if a highres dat is passed.

Deliberately **not** proposed: making the meta file's absence fatal. `play.bat`'s
fresh-install gate (`DESIGN-fresh-install-loud-fail-2026-08-19.md`) is about a *broken
install*; a missing redline sidecar just means the plugin pre-flights nothing, which is
the same optimistic-but-checked position `queue_worker` already handles as guard drift.

---

## 10. Executor — an agent corrects the queue

`tools/dat-patch/redline/executor.py` is the payoff: it walks a `work-items.json` and, per
item, dispatches to a concrete correction that lands a fixed record into a **working copy**
of a dat, emits a status event, and (where a fix landed) attaches an A/B board via
`verify_fix.py`.

**It touches no core lane code.** The dat pipeline runs live; the executor drives lanes
**only as black boxes** — `texture_lane.py run` and `tranche.py build` by subprocess,
`verify_fix.make_board` the way `verify_fix` already does. It reimplements none of their
logic. Two hard safety rails: every write lands on a copy under `--work-dir`, and any write
path resolving under `~/ac_base_dats` is refused (`executor.assert_not_base`); a
`--max-records` cap bounds records written per run, and hitting it defers the rest (logged,
not dropped).

**Free-pool safety (F1).** Records this lane writes are 500–5,500 blocks. The zeroed-arena
prep (`texture_lane.py prep`) chains only small (≤~65-block) records safely — its arena's
next-pointers are all zero, so a large record's chain terminates after ~1 block and reads
back `0x0` (`detail_texture_lane.py:271-276`). The executor therefore prepares the free pool
**once per run with DatCompress** (`prepare_free_pool`), which frees valid interior blocks
with real next-pointers — the only flow proven to land large records
(`detail_texture_lane.py:264-269`) — and never imports if that prep did not succeed. Every
written record is **read back** (`_readback_verify`, non-zero dims) before it can be stamped
`fixed`, and the run ends with `fixup_dat` + `walk_check` (`structural_finalize`); a
`walk_check` FAIL is surfaced loudly.

**Release required for status (F2).** `--apply` with `--status` writes `fixed` events, which
the frozen schema requires to carry a real `release` (`acme-r<N>`). The executor errors up
front if `--release` is missing rather than emitting an invalid placeholder that
`append_event` would reject (which previously lost the `fixed` event and stranded the entry
at `in-progress`).

### 10a. Dispatch table — drivable-today vs needs-a-proposal

| lane / tags | disposition | how |
|---|---|---|
| `texture-legibility-rebake` | **executable** | prepares a **safe** free pool once per run with **DatCompress** (frees valid interior blocks — the `detail_texture_lane.py:264-269` `flow="compress"` pattern), then builds the minimal `surfaces.json`+`ids.txt` the lane's own `run` consumes (`texture_lane.py:486,513-527`), subprocesses `texture_lane.py run` → WBT `render-surface-import`, and **reads the record back** (non-zero dims) before stamping fixed. After all imports it runs `fixup_dat` + `walk_check` on the scratch. The **only** lane that writes a dat end-to-end headlessly today. |
| `texture-source-replacement` (wrong-material / recolor) | **needs-manual** | no automated recipe — an art asset must exist first; the exact follow-up `run` command is emitted. |
| `texture-palette-fill` (INDEX16 / P8) | **needs-manual** | `fill_import.py` bakes `idx/<id>.bin`, but those records are applied by `DatRecordInsert` (`fill_import.py:150-170`), not a single headless dat-writing entrypoint — the two-command sequence is emitted. |
| `geometry-displace` + `silhouette` | **needs-manual** (artifact-drivable) | `tranche.py build --only <gid>` with today's knobs (`--area-share`, `--max-segments`, and the per-record `mult` in `models.json`) produces the corrected OBJ + `imports.jsonl`; the dat-write is a WB-project `obj-import`+`export` step (`tranche.py:14-15`) this executor is not given a project for, so it stops at the artifact and emits the apply command. |
| `geometry-displace` + `remove-detail` | **blocked** | needs the per-poly-exclusion knob that does not exist in the shipped lane — a precise PROPOSAL is emitted (§10b), never applied. |
| `geometry-degrade-deferred` (band0-not-self) | **blocked** | guard passthrough; the band-object retarget candidates are carried through. |
| `terrain-lane-only` | **blocked** | terrain-protected guard passthrough. |
| triage / `rs-missing` / whole-`object` | **needs-manual** | the selection must be narrowed; a missing record cannot be corrected. |

**Status events honour the frozen enum.** `statusEvent.state` is `queued|in-progress|fixed`
only — there is no `needs-manual`/`blocked` state. So an executed fix writes `in-progress`
(pickup) then `fixed`; a needs-manual item that was picked up gets one `in-progress` event
whose **note** records the manual follow-up; a purely guard-blocked item (never picked up)
gets **no** status event — "pass through unexecuted". The disposition
(`executed|needs-manual|blocked|deferred`) lives in `executor-report.json`, not in the
status enum.

**Modes.** Default is `--dry-run`: classify, print the plan and the exact commands, touch
nothing (no dat, no status). `--apply` copies the base to a scratch dat and executes, up to
`--max-records`.

### 10b. The per-poly-exclusion proposal (spec, not applied)

`remove-detail` on one record needs to exclude *named* source polygons from carving. Today
`relief3d.SourceMesh.from_record` derives `excluded` **only** from a polygon's own
`stip`/`sides` (`relief3d.py:152,157`) — there is no per-record override, so a
single-record complaint cannot be honoured without changing every record of that material.
The executor emits this as a proposal in the work item's report (with the exact polygon
indices resolved for that item), and does **not** implement it:

1. **`relief3d.py` · `SourceMesh.from_record`** (`:127` signature / `:152-163` per-poly flag
   build): add an optional `exclude_polys=None` (a set of source-polygon indices in record
   order); when a polygon's index is in it, force `excluded=True, amp=0.0` exactly as the
   stip/sides path already does — so the existing weld-to-zero (`:287-304`) is unchanged.
2. **`pilot.py` · `recipe_c_source`** (`:237-254`): thread `exclude_polys` through to
   `from_record`, sourced from a new optional per-record override file.
3. **`tranche.py` · `cmd_build`/`_build_one`** (`:453-499`, `:521`): read an optional
   `<root>/redline_overrides.json` `{gid_hex: {excludePolys: [int,…]}}` and pass the list
   into `recipe_c_source` for that gid.
4. **`tranche.py` · `RECIPE_VERSION`** (`:111`): **bump it** — the resume hash folds
   `RECIPE_VERSION` (`_recipe_hash`, `:440-450`), so a bump forces a rebuild of any record
   whose override set changed; without it a stale OBJ is silently reused.

This keeps redline out of the batch runner's default path (the override file is opt-in) and
costs one `RECIPE_VERSION` bump. It is the same knob the `per-poly-exclusion` work-item
action names (§6).

---

## 11. Trust model

Everything in an entry is **reporter-controlled**, including the ids.

* `prompt` and `author` are free text. They are carried into `work-items.json` as data
  and are never interpolated into a shell command. Nothing in this tool shells out at all.
* `attachments` paths are refused if absolute or containing `..`
  (`queue_worker._safe_attachments`); they are only ever resolved relative to the queue
  file's own directory, and existence is reported, not assumed.
* Every id is re-resolved against the dat. A report naming a nonexistent record produces a
  work item with a blocking `rs-missing`/`gfxobj-missing` guard, not a crash.
* The worker opens the dats read-only through `datlib.Dat` (`datlib.py:9`, plain `rb`) and
  writes exactly one file, `work-items.json`.
* Schema validation runs before anything touches a dat. If the real `jsonschema` library
  is importable the worker uses it; otherwise a built-in draft-07 subset validator runs,
  and it **refuses to start** if the schema uses a keyword the subset does not honour —
  validating less than the schema promises is worse than not validating.

A malicious entry's worst outcome is a work item that an agent then declines to act on.
The **executor** adds one write rail on top: it copies the base dat read-only and writes
only to a scratch copy under `--work-dir`, refusing any path under `~/ac_base_dats`
(`executor.assert_not_base`), and it drives the lanes as subprocesses rather than importing
their internals — so a lane change can never be introduced through the redline tooling.

---

## 12. Open design questions

1. **Triangle index convention — RESOLVED, owned by the plugin side, frozen.** `indices`
   are indices into the record's fan-triangulated draw-triangle stream over **every**
   polygon in record (positional) order — not drawn-only, not polygon keys. Pinned by the
   plugin author against decisive evidence (the decomp
   `Render::GfxObjUnderSelectionRay` iterating `mesh->polygons` positionally; the plugin's
   `BuildFanStreamStatic`; and a sample index of 241 valid only on the 242-triangle
   all-polys stream). The `selection.triangles` object is frozen as
   `{gfxObjId, indices, footprint, baseRecordSha256}` with `additionalProperties: false`
   — no `indexBasis` in the entry. `queue_worker._tri_stream` builds exactly this stream;
   the worker resolves each index to its source polygon and, when stale/out-of-range,
   relocates from the footprint centroids. See §6a. (An interim reading of the plugin's
   in-progress code briefly suggested polygon keys; the pipeline was reverted to match the
   frozen contract.)
2. **`setupId` optionality.** Retail static architecture is placed as a bare `0x01` model
   id in LandBlockInfo (`pilot.resolve_gfx`, `pilot.py:94`); a scan of the portal found
   **no** Setup containing GfxObj `0x01000827`. So a building selection legitimately has
   no Setup, and the schema makes `setupId` nullable. Confirm the plugin agrees rather
   than emitting a placeholder.
3. **Which dat does the plugin's `rsId` come from?** On a HIFI-split kit the client has
   both files mounted. If the plugin reports the id it actually sampled, `rs-id-drift`
   against a base portal is expected and benign; if it reports the portal id, the drift
   guard is a real signal. Needs a decision, not a guess.
4. **`uvHints` orientation.** The worker converts the bbox to a texel rect using v as
   stored, with no flip, and says so in the output. Whether the plugin's v matches DAT
   storage or D3D convention is unconfirmed.
5. **Per-polygon override input.** The `remove-detail` knob does not exist yet (§6 TODO).
   Design question: a per-record JSON override read by `tranche.py build`, or a first-class
   `redline-overrides.json` consumed by `pilot.recipe_c_source`? The second keeps redline
   out of the batch runner; the first keeps one code path.
6. **Aggregation across kits.** Two reports on the same rsId from `acme-r8` and `acme-r9`
   merge today. If r9 already changed that record, the r8 report may be stale in a way
   `stale-selection` cannot detect (there is no `baseRecordSha256` for textures). Adding
   one to the texture selection would close this — but the schema is frozen at v1, so it
   is a v2 note.
7. **Exposure for non-static records.** Creatures, clothing and dungeon-only meshes have
   no LandBlockInfo placements, so exposure is unknown and priority falls back to report
   count. The creature corpus is the highest-exposure surface class in the game
   (`PLAN-2026-08-18-hedonic-allocation.md:53`) and the metric currently scores it
   lowest. A spawn-map-derived exposure (`$LSD/spawnMaps/`) would fix it; not attempted.

---

## 13. Files

| Path | What |
|---|---|
| `docs/redline/DESIGN.md` | this document |
| `docs/redline/SCHEMA.md` | field-by-field schema reference + conventions |
| `tools/dat-patch/redline/schema_v1.json` | JSON Schema for entry + status event |
| `tools/dat-patch/redline/queue_worker.py` | queue → work-items.json |
| `tools/dat-patch/redline/status_writer.py` | append + derive status events |
| `tools/dat-patch/redline/gen_kit_meta.py` | acme-meta.json sidecar for the plugin |
| `tools/dat-patch/redline/build_kit_with_meta.sh` | wraps `assemble_kit.sh` (unchanged) + drops `acme-meta.json` into the kit (§9) |
| `tools/dat-patch/redline/verify_fix.py` | tier-1 before/after A/B by calling `texture_lane.make_board`; writes the board path into a `fixed` status event (§8) |
| `tools/dat-patch/redline/executor.py` | dispatches each work item to a black-box lane, writes the corrected record into a scratch dat, emits status + board (§10) |
| `tools/dat-patch/redline/fixtures/` | 6 handwritten entries with real DAT ids, a status log, and the smoke-run output |

Nothing under `tools/dat-patch/` outside `redline/` was modified. `assemble_kit.sh`,
`texture_lane.py`, `tranche.py`, `fill_import.py`, `board.py` and `gallery.py` are
**called** (subprocess or public-function black boxes), never edited.
