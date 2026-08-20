# AcmeRedline — schema reference (v1)

Machine-readable form: **`tools/dat-patch/redline/schema_v1.json`** (JSON Schema
draft-07). It carries two top-level definitions:

* `#/definitions/entry` — one line of `redline.jsonl`
* `#/definitions/statusEvent` — one line of `redline-status.jsonl`

The entry shape is **frozen at v1**: the Chorizite plugin emits exactly this and the
worker codes against it. Anything this document adds is *interpretation* of fields the
schema cannot express, or a convention the two sides must agree on. Interpretations that
are not yet confirmed with the plugin are listed in §6 and repeated in
`docs/redline/DESIGN.md` §12.

Validate a queue with:

```
python3 tools/dat-patch/redline/queue_worker.py \
    --queue <redline.jsonl> --portal ~/ac_base_dats/client_portal.dat --strict
```

`--strict` exits nonzero if any line fails. Validation happens **before** any dat is
opened. If the `jsonschema` package is importable it is used; otherwise a built-in
draft-07 subset validator runs, and it refuses to start if the schema uses a keyword the
subset does not honour (`queue_worker._schema_selfcheck`) — validating less than the
schema promises would be worse than not validating.

---

## 1. Entry

### Identity

| field | type | notes |
|---|---|---|
| `id` | string | `^rl-[0-9]{8}-[0-9]{6}-[0-9a-fA-F]{4}$` — `rl-<utc yyyymmdd>-<hhmmss>-<4 hex>`. The primary key; `redline-status.jsonl` references it. |
| `v` | integer | `const: 1`. A future v2 gets its own schema file, not a widened v1. |
| `createdAt` | string | ISO 8601 with an explicit zone (`Z` or `±HH:MM`). A bare local timestamp is rejected — the queue is merged across machines. |
| `author` | string | 1–64 chars. Account name. **Untrusted display text.** |

### `clientRelease`

| field | required | notes |
|---|---|---|
| `kitTag` | yes | `^acme-r[0-9]+(\.[0-9]+)?$` — matches the kit directory name `acme-$TAG` (`tools/dat-patch/kit/assemble_kit.sh:53`), *not* the bare `--tag` value. |
| `portalSha256` | yes | sha256 of the `client_portal.dat` the reporter is running — the same checksum `assemble_kit.sh:193-197` writes into `SHA256SUMS.txt`. |
| `highresSha256` | no | nullable: a pre-HIFI-split kit has no `client_highres.dat`. |

This block is what makes a report reproducible. When the worker's `--portal` sha differs
from the report's, id drift is expected rather than suspicious.

### `world` and `camera`

`world.landblock` is the cell id in the `(x<<24)|(y<<16)|cell` form the client's
`pose.landblockId` uses; `world.pos` is the reporter's position, `world.heading` degrees.
`camera` is the eye: `pos`, `lookAt`, `fovDeg`.

`camera` exists so the verification loop can re-shoot the frame the reporter saw. The
only rig in the tree that can consume it verbatim today is the holtburger web port's
`window.__cam.set(ex, ey, ez, tx, ty, tz)` / `.fov(v)`
(`external/holtburger/apps/holtburger-web/scene3d/camera.js:1220-1263`, behind
`?camDebug=on`). The retail-client rigs have no pose control. See `DESIGN.md` §8.

### `selection`

`kind` picks which sub-object is load-bearing. The others may still be present and are
resolved for context:

| `kind` | required sub-object | primary target (aggregation key) |
|---|---|---|
| `texture` | `renderSurfaces` (≥1) | `renderSurfaces[0].rsId` |
| `triangles` | `triangles` | `triangles.gfxObjId` |
| `object` | `objects` (≥1) | `objects[0].gfxObjId` → routed to `triage` |

The schema does not encode that conditional (draft-07 `if/then` is deliberately outside
the validator subset). The worker enforces it semantically and emits an
`empty-selection` guard, so a mis-shaped entry produces a diagnosable work item instead
of a validation failure with no context.

#### `selection.objects[]`

| field | required | notes |
|---|---|---|
| `objectId` | yes | server object GUID of the instance clicked. Context only — nothing in the dat pipeline is keyed by it. |
| `gfxObjId` | yes | `0x01……`. The record the geometry lane operates on. |
| `setupId` | no, **nullable** | `0x02……`. Retail static architecture is placed in LandBlockInfo as a bare `0x01` model id (`tools/dat-patch/pilot.py:94` `resolve_gfx`), and a scan of the retail portal found **no** Setup containing `0x01000827` (a Holtburg building). A building selection legitimately has no Setup; emit `null`, not a placeholder. |
| `worldFrame` | no | `pos` + `quat` as `[w, x, y, z]` — the DAT storage order (`tools/dat-patch/datlib.py:91`). |

When both `setupId` and `gfxObjId` are present the worker checks that the GfxObj is
among the Setup's parts and emits `setup-part-mismatch` (non-blocking) if not.

#### `selection.renderSurfaces[]`

| field | required | notes |
|---|---|---|
| `rsId` | yes | `0x06……`. |
| `surfaceId` | no, nullable | `0x08……`. **Strongly preferred**: the texture lane's `--ids-file` takes *Surface* ids, not RenderSurface ids (`tools/dat-patch/texture_lane.py:513-526`), and the Surface record is where the relief vetoes live (`tools/dat-patch/matlib.py:89-97`). |
| `surfaceTextureId` | no, nullable | `0x05……`. The worker cross-checks it against the Surface's own `tex` field. |
| `uvHints` | no | UV coordinates inside the reported texture. Their **bounding box** is the region the reporter meant; the worker converts it to a texel rect at the record's real dimensions. |

Only `renderSurfaces[0]` becomes the work item's target. Additional entries are recorded
in a note — splitting one report across several targets would fan out guards and priority
in ways that cannot be reasoned about.

#### `selection.triangles`

| field | required | notes |
|---|---|---|
| `gfxObjId` | yes | `0x01……`. |
| `indices` | yes | indices into the all-polygon fan-triangle stream (**§2**). Frozen: this is the whole set of index fields — no `indexBasis`, no counts. |
| `footprint` | no | `centroids[]`, `normals[]`, `areaM2` in model space. The *fallback* when the record has changed. Strongly recommended: without it a stale selection is unrecoverable. |
| `baseRecordSha256` | no | sha256 of the GfxObj record bytes **as `datlib.Dat.get()` returns them** — i.e. post-inflate for a compressed entry (`tools/dat-patch/datlib.py:51-65`). Not the on-disk bytes. |

#### `selection.screenLasso`

`points[]` in pixels plus `viewport: [w, h]`. Carried through untouched. Nothing in the
pipeline consumes it today; it is there so a future frame-space overlay can be drawn on
the attached screenshot.

### `prompt`, `tags`, `severity`

`prompt` is ≤4000 chars of untrusted free text. It is carried into `work-items.json` as
data and never interpolated into a command.

`tags` drive lane selection. The enum, and what each one routes to:

| tag | on `texture` | on `triangles` |
|---|---|---|
| `too-blurry` | `texture-legibility-rebake` — 4× bake, capped at 2048/side | (falls through to the default geometry menu) |
| `seam` | rebake **+ a tileability note**: an un-wrapped ESRGAN upscale breaks the wrap and shows a hairline grid; bake with `DATPATCH_WRAPPED_CORPUS=1` (`texture_lane.py:381-390`) | — |
| `wrong-material` | `texture-source-replacement` — no automated recipe exists | — |
| `recolor` | `texture-source-replacement`; on a palettized record it becomes a *palette* job, not a rebake | — |
| `remove-detail` | — | per-poly exclusion / amp override / class veto |
| `silhouette` | — | mult override into the 4–6× band, segments/decimator knobs |
| `other` | default rebake | default geometry menu |

`severity` is 1–5, reporter-assigned. It **breaks ties** in priority ordering but is not a
multiplier — a self-assigned severity would otherwise let one player outrank exposure
data.

### `attachments`

Paths **relative to the queue file's directory**. Absolute paths and any path containing
`..` are refused by `queue_worker._safe_attachments` and reported as an
`unsafe-attachment-path` guard. Existence is checked and reported, never assumed.

### `guards`

The plugin's optimistic pre-flight from `acme-meta.json`
(`tools/dat-patch/redline/gen_kit_meta.py`):

* `terrainProtected` — the rsId is in `tools/dat-patch/terrain_protected_rs.txt`
* `paletteRoute` — the rsId's format is INDEX16 or P8

**Advisory only.** The worker re-derives both from the dats and emits `guard-drift` on
disagreement, which in practice means the player's `acme-meta.json` is from a different
kit than the dat being resolved against.

### `status`

Seed value only, `{"state": "queued"}` at submit time. The authority is
`redline-status.jsonl`.

---

## 2. The triangle index convention — owned by the plugin, frozen

`selection.triangles.indices` are indices into the record's **fan-triangulated
draw-triangle stream over EVERY polygon in CGfxObj record (positional) order** — not
drawn-only, not polygon keys. Polygon *pi* (0-based record order) contributes
`len(p["v"]) - 2` triangles, emitted `(v[0], v[k], v[k+1])` for `k = 1 … n-2`;
stippled/NoPos filler polys (`Stippling & 0x4`) stay **in** the stream so an index is a
stable address.

That is the same fan the pipeline builds (`queue_worker._tri_stream`) and the same
`relief3d.SourceMesh` triangulates from (`pilot.py:273`, identical `len(v)-2` fan).

**Pinned by the plugin author; the pipeline verified and matches it:**

* the plugin emits exactly this stream — `AcmeRedline/Services/SelectionService.cs:639-699`
  (`BuildFanStreamStatic` + `BuildFanTrianglePayload`: "over EVERY polygon in the record,
  in record (positional) order — NOT drawn-only");
* decomp `Render::GfxObjUnderSelectionRay` (`ac-headers/acclient.c:379997`) iterates
  `mesh->polygons` **positionally** over `num_polygons`; the client exposes no polygon
  key (`MouseSelectData.PolygonID` is the object id + **part** index, misnamed);
* decisive: the plugin's sample uses `indices [16, 85, 241]` on `0x01000827`, which has
  226 drawn / **242 total** fan triangles — 241 is valid **only** under all-polys. The
  pipeline resolves it to source polygons `[8, 40, 136]`.

**The basis is carried by matching it exactly, not by an in-entry field.** The frozen
`selection.triangles` object is `{gfxObjId, indices, footprint, baseRecordSha256}` with
`additionalProperties: false` — an entry carrying an `indexBasis` (or any count field)
would fail the plugin's own validation. The worker still **computes** `triCountAll`
(= stream length) and `triCountDrawn` (not-NoPos, as `tranche.py:301` counts) as *outputs*
in `work-items.json`, and keeps an `index-count-drift` guard that fires only if a
count-bearing entry is ever seen — inert for frozen input, a tripwire otherwise.

Each index resolves to a **source polygon**, the granularity every displace knob works at
(`excluded` per-polygon, `relief3d.py:152`; amplitudes pinned per polygon,
`relief3d.py:287-304`). The worker reports, per selected polygon: `polyIndex`, `stip`,
`sides`, `surfaceId`, whether it is a NoPos filler, and whether the recipe already
excludes it.

### Staleness and the footprint fallback

If `baseRecordSha256` does not match the record in the dat, the indices are discarded and
re-derived from `footprint.centroids` by nearest current **triangle** centroid, with the
worst residual reported (`footprintMaxResidualM`). On the fixture's
`rl-20260820-104102-c7aa` — deliberately stamped with an all-zero sha — this recovers
triangle indices `[0, 3, 5]` exactly at a 0.0006 m residual.

A large residual means the record was genuinely rebuilt and the selection should be
re-shot, not guessed at. The work item says so instead of proceeding quietly.

---

## 3. Status event

| field | required | notes |
|---|---|---|
| `entryId` | yes | must match the entry id pattern |
| `at` | yes | ISO 8601 UTC |
| `state` | yes | `queued` \| `in-progress` \| `fixed` |
| `release` | by convention | kit tag. `status_writer.py` **refuses** `--state fixed` without it. |
| `note` | no | ≤2000 chars. Convention: put the A/B board path here on a `fixed` event. |
| `by` | no | writer identity, e.g. `agent:texture-lane`, `queue_worker.py`, `AcmeRedline.plugin` |

**Append-only.** Derived current state = the last event for an `entryId`
(`queue_worker.derive_status`). Nothing rewrites history; re-opening an entry means
appending a fresh `queued` event. Writes go through
`status_writer.append_event`, which validates against the schema first and appends one
line under `flock(LOCK_EX)`.

---

## 4. Worked example

The fixture queue (`tools/dat-patch/redline/fixtures/redline.jsonl`) is six handwritten
entries. Every DAT id, format, dimension, triangle index and record hash in it was read
out of `/home/wbterminal/ac_base_dats/client_portal.dat`
(sha256 `dc6e500b…`); positions, camera poses, author names and prompts are invented.

| entry | kind / tags | target | what it exercises |
|---|---|---|---|
| `rl-…-a1c3` | texture / too-blurry | `0x06003C97` (128×128 DXT1) | the happy path + attachment existence checks |
| `rl-…-7f2b` | texture / too-blurry, seam | `0x06003C97` via a **different** GfxObj | **aggregation** — two reports, one work item, tags unioned, seam note added |
| `rl-…-9d44` | triangles / remove-detail | `0x01000827`, fan-stream indices `[16,17,163,210,211,229]` (229 valid only all-polys), **correct** sha | the displace knob menu, fan-stream → source-polygon resolution |
| `rl-…-4e01` | texture / wrong-material | `0x06006D51` (512×512 A8R8G8B8) | **terrain-protected guard**, blocking |
| `rl-…-b2d9` | texture / recolor | `0x06004232` (INDEX16) | **palette route** + **guard drift** (the entry claims `paletteRoute: false`) |
| `rl-…-c7aa` | triangles / silhouette | `0x0100004B`, **wrong** sha | **band0-not-self** guard + **stale-selection** + footprint relocation + up-facing note |

---

## 5. Extending the schema

v1 is frozen. A v2 would be a new file (`schema_v2.json`) and a new `v` value, with the
worker dispatching on `entry.v`. Candidate v2 additions already identified:

* a `baseRecordSha256` for **texture** selections — today a texture report from an older
  kit cannot be detected as stale (there is nothing to hash against);
* a `renderer` discriminator, if the plugin ever reports from something other than the
  retail client;
* `exposureHint` — the client knows how many instances of the model are in view.

---

## 6. Unconfirmed contract points

These are interpretations this side made because the schema does not state them. Each
needs a yes/no from whoever builds the plugin.

1. ~~**Triangle index base**~~ — **RESOLVED & FROZEN (§2):** all-polygon fan-triangle
   stream in positional record order; carried by matching, no in-entry field. Owned by the
   plugin side.
2. **`setupId` nullability** for bare-GfxObj statics (§1, `selection.objects[]`).
3. **Which dat the reported `rsId` came from** on a HIFI-split kit — portal or highres.
   Decides whether `rs-id-drift` is a signal or expected noise.
4. **`uvHints` v orientation** — DAT storage order (assumed, no flip applied) or D3D
   convention.
5. **Whether `screenLasso` is in the same space as the attached screenshot** — the
   `viewport` field suggests yes, but the mask PNG's dimensions are not constrained to it.
