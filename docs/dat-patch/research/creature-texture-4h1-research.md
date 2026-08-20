# 4.H1 — creature / monster texture lane: feasibility + method (RESEARCH, 2026-08-20)

Turnkey design doc for **plan rank #4 / §4.H1** of
`docs/dat-patch/PLAN-2026-08-18-hedonic-allocation.md` (`PLAN:53`, `:138-141`):
the "recolor wall" — INDEX16 depalettize + ClothingTable recolor handling,
"4,182 surfaces / 432 palettes". This is research only. No dat tool was run; no
dat was rebuilt or written; the live dat rebuild was not disturbed. Every dat
fact below was read either from a small file (ACE loader source, decomp,
existing census JSON) or is cited from an existing report. Primary claims carry
`file:line`. Anything that would need a dat tool to close is flagged **VERIFY**.

Source legend:
- `DECOMP` = `/home/wbterminal/ac-headers/acclient.c` / `acclient.h` (retail EoR pseudo-C)
- `ACE`    = `/home/wbterminal/ace-server/Source/ACE.DatLoader/{FileTypes,Entity}/`
- `DRW`    = `external/DatReaderWriter/DatReaderWriter/dats.xml`
- lane code = `tools/dat-patch/*.py` (read-only reference)
- census   = `/mnt/wbterminal2/dat-patch-creatures/census/` + `dat-patch-dungeons/clothing_rs_global.json`

---

## 0. TL;DR verdicts

| question | verdict |
|---|---|
| **Does converting INDEX16/P8 → DXT break recolor?** | **Yes, provably.** Recolor is an *index → palette-entry* indirection (`Palette::Modify` overwrites palette ARGB slots; the texel INDEX resolves through the modified palette in `ImgTex::CopyIntoData`). DXT freezes the index→RGB step, so `Palette::Modify` has nothing to bite on. Decomp + ACE both confirm. |
| **Is the plan's "INDEX16→DXT depalettize" the right frame?** | **Only half.** For the **811 recolor-live** creature surfaces, depalettize is *wrong* — they take **route (a): stay INDEX16, upscale 2×**, which keeps recolor working. DXT (route b) is safe **only** for the never-recolored subset. |
| **Is the lane already partly done?** | **Yes.** The coverage-fill session (2026-08-20) shipped **3,122 palette-route records** via `fill_import.py` route (a), unconditionally recolor-safe. Route (a) needs **no** recolor census at all — staying palettized is always safe. |
| **What still needs the census?** | Only **route (b)** eligibility. The reverse-lookup census already exists (`clothing_rs_global.json` = 1,624 RS; `creatures_census.json`), so classifying the safe subset is turnkey. |
| **Execution readiness** | 🟢 route (a) (proven, gated, recolor-safe) · 🟡 route (b) (needs the existing census + a per-record "is 4× DXT worth freezing the color" call). |

**Headline correction for the executing session:** the plan text
(`PLAN:139-141`, "Own the INDEX16→DXT depalettize path") reads as if depalettize
is the lane. It is not. The recolor wall means *the opposite* for real monsters:
**do not depalettize them; upscale them in place as INDEX16.** That path is
already shipping. Depalettize is an optional byte/resolution optimization for the
minority of palettized creature surfaces that are never recolored.

---

## 1. The recolor wall — why DXT freezes colors and breaks ClothingTable recolor

### 1.1 The client's recolor mechanism (decomp)

Recolor in AC is not a texture swap — it is a **palette-entry overwrite** applied
to a *copy* of the base palette, resolved per-texel at texture construction time.

**Step 1 — build a modified palette.** `Palette::makeModifiedPalette(palID, subs)`
(`DECOMP:365273`) allocates a fresh 2048-entry `Palette`, loads the base palette,
then applies:
```
if ( Palette::Modify(v7, palID, 0, 0x800u) && Palette::Modify(v7, subs) )   // DECOMP:365301
```
i.e. copy the whole base palette into slots `[0, 0x800)` = `[0, 2048)`, **then**
apply the subpalette list on top.

**Step 2 — the overwrite loop (the crux).**
`Palette::Modify(this, subID, offset, numcolors)` (`DECOMP:365097`):
```
v6 = offset + numcolors;
if ( offset + numcolors <= this->num_colors && DBObj::Get(subID, type 0xA) != 0 )
    for ( i = offset; i < v6; ++i )
        v4->ARGB[i] = *(_DWORD *)(*(_DWORD *)(v8 + 64) + 4 * i);   // ~DECOMP:365120
```
It **overwrites palette entries `ARGB[offset .. offset+numcolors)`** with the ARGB
of a substitute Palette record (`subID`, fetched as DBObj type `0xA` = Palette).
`Palette::Modify(Subpalette *)` (`DECOMP:365132`) just walks the `prev/next`
linked list of `Subpalette{ subID, offset, numcolors }` (`acclient.h:39601-39608`)
and applies each range. So a recolor = "replace this contiguous *range of palette
indices* with these colors."

**Step 3 — resolve texels through the modified palette.**
`ImgTex::CopyIntoData(dst, pitch, texture, palette, clipmap)` (`DECOMP:365907`)
walks the RenderSurface and, for `format == 101` (INDEX16):
```
v13 = *(_WORD *)(i + 2 * v11);                        // the 2-byte texel INDEX
... *(_DWORD *)v8 = Palette::get_color32(palette, v13); // resolve INDEX -> ARGB   ~DECOMP:365965
```
(P8 is the `else` branch, a 1-byte index; `clipmap && index < 8 → 0` is the
transparency sentinel, matching `pallib.py:8-9` and `DECOMP:365958/365980`.) The
`palette` handed in is the **modified** palette from step 1. `Palette::get_color32`
is `DECOMP:365029`.

**The wall, stated exactly:** the recolored appearance is produced entirely by
(1) overwriting palette *slots* and (2) the texel *index* sampling those slots.
A DXT (or any RGB) record stores **frozen ARGB per texel — no index** — so there
is nothing for `Palette::Modify` to overwrite and nothing that samples the
modified palette. `CopyIntoData`'s index path is never taken (DXT decodes
natively through `ImgTex::CreateD3DTexture`, not the palette blit). **Recolor
silently no-ops; the item ships in one frozen color.** This is why
`pallib.py:11-18` (RECOLOR SAFETY) and `fill_import.py:13-19` refuse to DXT a
palettized record without a recolor-safety census.

### 1.2 Where the ranges/palettes come from (ACE ClothingTable)

The dat side of the mechanism, in ACE loader order:

- **ClothingTable (0x10)** — `ACE ClothingTable.cs:22-34`: two packed hash tables.
  - `ClothingBaseEffects` keyed by **setup id** → the model/texture-swap side.
  - `ClothingSubPalEffects` keyed by **PaletteTemplate** → the recolor side.
- **ClothingBaseEffect → CloObjectEffect** (`CloObjectEffect.cs`): `Index` (part
  slot), `ModelId` (a part GfxObj swap), and `CloTextureEffects`.
- **CloTextureEffect** (`CloTextureEffect.cs`): `OldTexture` → `NewTexture` (both
  SurfaceTexture 0x05) — the *texture swap*, decomp `TextureMapChange
  { part_index, old_tex_id, new_tex_id }` (`acclient.h:39611-39615`). A swap can
  point the part at a different 0x05/0x06 entirely.
- **CloSubPalEffect → CloSubPalette** (`CloSubPalEffect.cs`, `CloSubPalette.cs`):
  `Ranges` = `List<CloSubPaletteRange>` + a `PaletteSet` (0x0F).
- **CloSubPaletteRange** (`CloSubPaletteRange.cs`): `Offset`, `NumColors` — the
  **exact `offset`/`numcolors` pair** fed to `Palette::Modify` above.
- **PaletteSet (0x0F)** (`ACE PaletteSet.cs`): `PaletteList` + `GetPaletteID(hue)`
  — the item's `Shade`/hue selects which Palette (0x04) from the set supplies the
  overwrite colors. `Palette (0x04)` (`ACE Palette.cs`) = `List<uint>` ARGB, i.e.
  DRW `Palette = [i32 numColors][u32 ARGB * n]` (`pallib.py:2-6`).

So an item's final look = base palette, with `Ranges` overwritten by the palette
`PaletteSet.GetPaletteID(item.Shade)` picks, indexed by the item's
`PaletteTemplate`. Freeze the indices and none of `PaletteTemplate`, `Shade`, or
the `PaletteSet` matters any more.

### 1.3 The 4,182 / 432 / 811 numbers — verified provenance

The plan's parenthetical ("4,182 surfaces / 432 palettes" and the "811 recolor
wall") **conflates three different populations.** Untangled:

| number | what it actually is | source |
|---|---|---|
| **4,182 INDEX16 + 6 P8 = 4,188** | *Every* palette-route RenderSurface in the retail portal (~20% of all 0x06). This is the total INDEX16/P8 population, **not** the recolor set. | `gen_kit_meta.py:76-124` (`scan_palette_rs`, 24-byte header format check 41/101); `docs/redline/DESIGN.md:219-220` |
| **4,182 surfaces / 432 palettes** | An **external community cross-check** (Crimson-Zan / gmriggs) that independently sized the INDEX16 wall; it *matched* our 4,182 count. "432 palettes" is *their* distinct-Palette count. | `docs/dat-patch/TASKLIST-2026-08-17.md:142` |
| **811 recolor-live** | The subset of the **creature** census actually walled off by recolor. From 6,801 spawnable creature wcids → 1,343 distinct RS → **811 recolor-live** (left untouched). | `docs/connectivity/connectivity-map.md:180`; `HANDOFF-release-roadmap-2026-08-15.md:317-323`; census `REPORT.md` |

**VERIFY-1:** "432 palettes" is an external number we never reproduced. If a
count matters for the lane, derive our own distinct-`DefaultPaletteId` count over
the 4,188 palette-route records (`fill_import.default_palette` reads the trailing
u32; a census can tally them without a dat *write*). Note `redline/DESIGN.md:220`
mislabels the whole 4,182 as "the recolor wall" — the true recolor-live creature
count is 811; the 4,182 is the addressable palette-route population, most of which
is *not* recolored.

### 1.4 Which INDEX16 records are recolor-subject vs safe to DXT

From the creature census (`census/REPORT.md`, fork run 2026-08-16), of **1,343
distinct creature RS**:

- **811 recolor-live** — a reaching wcid carries `ClothingBase` (PropertyDataId 7),
  a nonzero `PaletteTemplate` (PropertyInt 3), or a generator-forced palette
  (`weenie_properties_generator.palette_Id > 0`), **or** the RS is in the global
  clothing-reachable set. **Route (a) only.**
- **281** already patched by prior tiers.
- **141 safe plain** (corpus-covered) + **110 safe palettized** (54 covered + 56
  needing one upscale batch). These are the never-recolored creature surfaces —
  in practice **statue / monolith / painting-type "creatures"**, not real
  monsters (`HANDOFF:322-323`). **Route (a) or (b).**

Props side, same mechanism: `224 prop setups recolor-live → 396 palettized RS`
UNSAFE (`HANDOFF:225`). A PaletteTemplate-reclaim refinement was tried and closed
as a dead end: **2 of 396 reclaimable** — the conservative exclusion was correct
(`census/palette_reclaim.json`).

---

## 2. The two routes, and the exact classifier

### 2.1 Route (a) — stay INDEX16/P8, upscale, re-solve indices (recolor-preserving)

This is the shipped path (`fill_import.py:150-170`, `highres_lane.encode_paletted`
`highres_lane.py:212-253`):

1. Upscale the RGBA **2×** (`fill_import.py:152-153`; 2× not 4× because a highres
   record is normally 2× its portal sibling — `highres_lane.py:9-20`).
2. Read the record's own `DefaultPaletteId` (trailing u32, `fill_import.py:45-53`)
   and its Palette colors (`pallib.palette_colors`).
3. Re-solve each texel to the **nearest palette index _within the record's OWN used
   index subset_** (`fill_import.legibility_encode_paletted:210-266`; k-d tree over
   the used subset, ties broken to the lowest index — bit-identical to the
   reference brute solve). Restricting to the source's used set makes "no new
   palette entries, no new clipmap-transparency holes" an invariant
   (`highres_lane.py:216-225`; verified on output: `indices new-not-in-old = 0`,
   `phase4-coverage-fill-2026-08-20.md`).
4. Emit raw record bytes (`<6I header><indices><u32 DefaultPaletteId>`) and land
   via `DatRecordInsert` (insert-only, readback-verified — **not**
   `render-surface-import`).

**Why (a) preserves recolor:** the output is still INDEX16/P8 against the same
`DefaultPaletteId`, so `Palette::Modify` + `CopyIntoData` (§1.1) work unchanged.
**Route (a) is unconditionally safe — it needs no recolor census.** That is the
key simplification: you can upscale *every* palettized creature surface, recolored
or not, and never break a tint.

Cost: 2× linear only (the upscaler's hallucination budget is halved vs 4×, which
is a *quality* argument, not a limitation). Byte cost ≈ same order as route (b)
before zlib; INDEX16 index planes compress well under `DatRecordInsert --compress`.

### 2.2 Route (b) — INDEX16 → DXT depalettize (freezes color, 4× smaller-ish, recolor-broken)

Decode the palette to RGBA once (`pallib.decode_paletted_rs`, honoring the clipmap
`idx < 8 → transparent` and RGB colour-bleed at cutout edges, `pallib.py:70-80`),
then bake to DXT1/DXT5 at 4× via `texture_lane.py`'s WBT `render-surface-import`
(BCnEncoder, client-grade). Gains: full 4× linear resolution, native DXT mip
decode, ~¼ the resident bytes of A8R8G8B8. **Loses: all recolor.** Valid **only**
for records that pass the recolor-safety classifier below. There is one blessed
exception already wired: a palettized record *with* a palette-resolved base PNG
that has been vetted may convert (`texture_lane.py:533-544`,
`redline/DESIGN.md:207-213`).

### 2.3 THE CLASSIFIER — is a RenderSurface recolor-live? (the route (a)/(b) test)

A palettized RS is **route-(b)-eligible (DXT-safe) iff it is recolor-DEAD**, i.e.
**none** of the following hold. Any one → route (a) only.

Reverse-lookup path (weenie → ClothingBase/PaletteTemplate → RS), all already
built:

1. **Global clothing-reachable set (structural).** `clothing_rs_global.json`
   (`/mnt/wbterminal2/dat-patch-dungeons/`, **1,624 RS**) = every RS reachable from
   any of the 1,975 setups extracted from all 1,917 ClothingTables
   (`clothing_setups_global.json` = 1,975; `HANDOFF` dungeons addendum). Built by
   walking every ClothingTable's `ClothingBaseEffects` → `CloObjectEffect.ModelId`
   (setup/part) and `CloTextureEffect.Old/NewTexture` → their 0x06. If the RS is
   in this set, **some** ClothingTable can retexture/recolor a part that shows it
   → route (a).
2. **Weenie ClothingBase (DID 7).** Any wcid reaching the RS has a `ClothingBase`
   → its setup is driven through a ClothingTable → route (a).
3. **Weenie PaletteTemplate (Int 3) ≠ 0.** Selects a `ClothingSubPalEffects`
   entry → subpalette overwrite → route (a).
4. **Generator-forced palette.** `weenie_properties_generator.palette_Id > 0` on
   any generator that spawns a reaching wcid — a tint channel the earlier
   lanes' checks missed (`census/REPORT.md`, Task 1). Route (a).

**Conservative rule (proven correct):** clear an RS for route (b) **only if NO
weenie in the ENTIRE DB** (not just placed — loot-spawned items never appear in
`landblock_instance`) using any ClothingTable-referenced setup that reaches it can
tint, **and** it is not in the global clothing-reachable set. The stricter-than-
directed version of this rule found only 2/396 props reclaimable
(`palette_reclaim.json`) — evidence the conservative exclusion is right and the
byte upside of route (b) on recolored records is not worth chasing.

**Reverse-lookup data sources:** offline = LSD (`weenie_summary.jsonl` setupDid +
per-wcid props) + the census dumps `census/{dids,paltmpl,wtypes,genedges}.tsv`;
authoritative = the live ACE world DB (`ace_world.weenie_properties_did` Setup=1 /
ClothingBase=7, `weenie_properties_int` PaletteTemplate=3,
`weenie_properties_generator.palette_Id`) — memory §ace-db-probe. The census that
already resolved 6,801 wcids used `landblock_instance` + transitive generator
closure (`census/REPORT.md`, Task 1).

**VERIFY-2:** `creatures_census.json` was built 2026-08-16 against a base portal +
a specific LSD/ACE snapshot. Before trusting its 811/195/56 split for a new build,
re-confirm the reaching-weenie inputs are current (a diff of the ClothingTable set
and the generator table vs the live ACE DB). The *method* is fixed; the *set* is a
snapshot.

---

## 3. The lane recipe

### 3.1 Classification → route per class

```
for each palettized creature RS (from the census, ranked by exposure §3.4):
    if RS in prior-patched:            skip (already covered)
    elif recolor-live (§2.3):          ROUTE (a)  stay INDEX16, 2x   [ALWAYS SAFE]
    else (recolor-dead, DXT-safe):     ROUTE (a) default; ROUTE (b) only if
                                       4x-DXT is judged worth the color freeze
                                       AND the surface benefits from 4x (near-field
                                       hero surface, §3.3 mip rule)
    if RS in terrain_protected_rs.txt: REFUSE (never — §3.3)
```

The default for **everything** is route (a): it is proven, gated, recolor-safe,
and already the shipped behaviour of `fill_import.py`. Route (b) is a deliberate,
per-record opt-in for recolor-dead statues/monoliths/paintings where 4× linear
resolution is visibly better than 2× and the ¼-byte DXT footprint is wanted.

### 3.2 Bake + import per route

- **Route (a):** `fill_import.py` bake (`legibility.bake_texture(..., h=None)` =
  anchor-only, same `rgb+sat` retail anchor as the take-5 driver, so a filled
  creature sits at the shipped lane's exposure) → raw INDEX16 bytes →
  `build_r9_highres.sh` → `DatRecordInsert --compress` (insert-only, byte-identical
  readback). **No `render-surface-import`, no format change, no palette rewrite.**
- **Route (b):** `pallib.decode_paletted_rs` (clipmap-aware, edge colour-bled) →
  DXT PNG → `texture_lane.py` WBT `render-surface-import --allowCreate` (DXT5 if
  the decoded alpha is non-binary, else DXT1; dims snapped to mult-of-4,
  `fill_import.py:177-186`).

### 3.3 Constraints (terrain-protection, >2048, mip clamp)

- **Terrain protection:** the 48-entry `terrain_protected_rs.txt` set is refused by
  both routes (`fill_import.py:77-101`). Creature RS are not in the merge path, but
  the census must still exclude the list mechanically. (Rationale + the VeryHigh
  OOB failure: `highres-terrain-lanes-research.md §1.3`.)
- **The 2048 wall is UI-only** — it does **not** apply to 3-D creature surfaces
  (`highres-terrain-lanes-research.md §3.1`, `DECOMP:124912`). But **WBT's importer
  refuses 4096-side inputs** ("argument out of range"), so route (b) 4× on a
  ≥1024² source must be capped at 2048/side (`fill_import.py:66-68,177-186`). Route
  (a)'s 2× on the (typically ≤512²) palette sources stays well under this.
- **4-level mip clamp** (`DECOMP:366125`, `if v16 > 4: NumMipLevels = 4`): a 4096²
  gets only 4096/2048/1024/512 and aliases badly once minified below 512². For a
  creature you fight at close range this rarely bites, but it caps the sane route
  (b) target at 2048² anyway — which is also the WBT limit above. Net: **2048² is
  the ceiling for both routes**; 4× beyond a 512² source is the most you would
  ever bake.

### 3.4 Exposure ranking (creatures have no LandBlockInfo placements)

Creatures are **not** placed in the cell dat — they spawn from weenies at runtime,
so the `tranche.py` LBInfo walk and `env_geo` EnvCell walk both miss them
(`geometry-lanes-research.md §3b`). Rank by **spawn frequency** instead:

- `creature_enum.py` (already in-repo) is the weenie-driven enumerator: LSD
  `weenie_summary.jsonl` (`weenieType==10` + `setupDid`) → `spawnMaps/*.json`
  per-wcid placement count → `pilot.resolve_gfx`/`datlib.parse_setup` to parts →
  dedupe. It emits per-record summed spawn exposure. Reuse its exposure map to
  order the texture budget (it is written for the *geometry* spike but the
  weenie→setup→RS→exposure walk is exactly what the texture lane needs).
- The census already ships a **top-30 safe RS by spawn weight**
  (`creatures_census.json`; top `0x06003E2E` w=522 palettized,
  `0x06003A68/0x06003A6D` w=258). Spend top-down.

### 3.5 Byte budget

Per-record (before `DatRecordInsert --compress`, which is applied to route (a)):

| route | source→target | payload |
|---|---|---|
| (a) INDEX16 2× | 256²→512² | 512·512·2 = **512 KiB** indices (palette shared, ~free) |
| (a) INDEX16 2× | 512²→1024² | **2 MiB** indices |
| (b) DXT1 4× | 512²→2048² | 2048²/2 = **2 MiB** |
| (b) DXT5 4× | 512²→2048² | **4 MiB** |

INDEX16 planes are highly repetitive → zlib in `DatRecordInsert --compress`
recovers much of route (a)'s apparent size disadvantage.

**Runway.** The coverage fill already consumed most of the texture-side runway:
`client_highres.dat` compacted to **1.45 GiB** after landing 1,746 DXT + 3,122
palette records (`TASKLIST-2026-08-20-phase4-fill.md:81`). `DatRecordInsert`
appends at EOF and the hard ceiling is **2^31 − 1 ≈ 2.0 GiB** (`TASKLIST:107`), so
the incremental headroom for additional 4.H1 work is **≈550 MiB** — consistent
with the "~430 MB highres runway" figure in the brief. At ~0.5–2 MiB/record that
is a few hundred more creature surfaces, so 4.H1 must be **exposure-budgeted
top-down (§3.4), not a blanket pass.**

**VERIFY-3:** the exact free bytes to the 2^31 ceiling on the *current* build, and
how much of the 811-recolor-live population `fill_import` **already** covered this
session (it routes all INDEX16 to route (a) regardless of recolor status, so many
of the 811 may already be shipped at 2×). Measure "recolor-live RS covered vs
remaining" by intersecting `clothing_rs_global.json` + the 811 set against the
covered-records list from the fill manifest. This decides whether 4.H1 has real
remaining work or is substantially done.

---

## 4. Execution readiness

| sub-lane | readiness | why | first command |
|---|---|---|---|
| **Route (a): INDEX16 2× (recolor-safe)** | 🟢 **GREEN — proven, gated, partly shipped** | Mechanism verified (§1); route keeps INDEX16 so recolor is structurally intact; `fill_import.py` shipped 3,122 palette records this session, byte-identical readback. Needs **no** recolor census. | Run `fill_import.py` route (a) on the remaining uncovered palettized creature ids (the 2,110-palette tail noted at `TASKLIST-2026-08-20-phase4-fill.md:123`), ranked by `creature_enum.py` exposure. |
| **Route (b): DXT depalettize (recolor-dead subset)** | 🟡 **YELLOW — census exists, needs a per-record worth-it call** | Classifier is fully built (`clothing_rs_global.json` + `creatures_census.json`, §2.3); only ~195–251 of 1,343 creature RS are DXT-safe, and most are statue/monolith/painting types where 4× helps. Requires the color-freeze judgement + 2048² cap. | Intersect the census "safe" bucket with the not-yet-covered set, then `texture_lane.py` DXT import (2048²-capped) on the highest-exposure safe records. |
| **811 recolor-live real monsters** | 🟢 via route (a) / 🔴 via route (b) | They must **never** be depalettized. Route (a) 2× is the only correct path and it is already the pipeline's default behaviour. | (covered by the route (a) command above — no special handling) |

### The concrete first command a later session runs

Establish exactly what remains before baking anything — a read-only intersection,
no dat tool, no write:

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/tools/dat-patch
# recolor-live set (811) + global clothing-reachable set (1,624) vs what the
# coverage fill already covered — decides if 4.H1 has real remaining work (VERIFY-3)
python3 - <<'PY'
import json
census = json.load(open('/mnt/wbterminal2/dat-patch-creatures/census/creatures_census.json'))
clo    = set(json.load(open('/mnt/wbterminal2/dat-patch-dungeons/clothing_rs_global.json')))
# TODO(session): load the fill manifest's covered-id list and diff:
#   covered = {r['id'] for r in json.load(open('.../fill-manifest.json'))['inserts']}
# report: recolor-live covered vs remaining; safe-DXT-eligible remaining, ranked by
# creature_enum.py spawn exposure.
print('clothing-reachable RS:', len(clo))
print('census buckets:', {k: (len(v) if isinstance(v, (list, dict)) else v)
      for k, v in census.items() if not isinstance(v, str)})
PY
```

If that shows the 811 are already covered at 2× by the fill, 4.H1's remaining
scope collapses to route (b) opt-ins on recolor-dead statues — a small, optional
byte optimization, not a headline lane. If a meaningful recolor-live tail is
uncovered, run the route (a) `fill_import.py` command (row 1 of the table) on it,
exposure-first, within the ~550 MiB ceiling headroom.

---

## VERIFY items (collected)

- **VERIFY-1** — "432 palettes" is an external (Crimson-Zan) number never
  reproduced here; and `redline/DESIGN.md:220` mislabels the 4,182 total INDEX16
  population as "the recolor wall" (the real recolor-live creature count is 811).
  Derive our own distinct-`DefaultPaletteId` count if one is needed.
- **VERIFY-2** — `creatures_census.json` (811/195/56 split) is a 2026-08-16
  snapshot; re-confirm the reaching-weenie inputs (ClothingTable set + generator
  palette table) against the live ACE DB before trusting it for a new build.
- **VERIFY-3** — exact free bytes to the 2^31 `DatRecordInsert` ceiling on the
  current `client_highres.dat`, and how many of the 811 recolor-live RS
  `fill_import` already covered at 2× this session (route (a) covers them
  regardless of recolor status). This is the single fact that decides whether
  4.H1 has substantial remaining work.
- **VERIFY-4** — the route-(b) clipmap decode edge-bleed (`pallib.py:70-80`) and
  DXT alpha re-binarisation are correct for creature cutouts specifically (they
  were validated on doors/props); spot-check one clipmap creature surface
  (e.g. a winged/foliate monster) before a route-(b) batch.
