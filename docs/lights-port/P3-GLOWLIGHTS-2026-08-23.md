# P3 — GLOW DYNAMIC LIGHTS (portals · spell projectiles · impacts · glowing creatures)

`AcmeLights/Services/GlowLights.cs`, 2026-08-23. Continues `PLAN-2026-08-22-acmelights.md` (Phase 3)
and `HANDOFF-2026-08-22-lighting-bloom-next.md`. Everything below was re-derived from the decomp and
the DATs in this session; where a prior research doc was wrong it is called out.

---

## 1. What the gap actually is (the premise changed)

The plan said "neither retail nor holtburger lights these — P3 is new content". That is only half
true, and the false half is the interesting one.

A retail **portal** weenie ships `PropertyInt.PhysicsState = 3084 = 0xC0C` — `Ethereal |
ReportCollisions | Gravity | **LightingOn (0x800)**` — on a `CSetup` that carries an authored
`lights` block. Setup `0x020001B3` (the classic swirling purple gateway, 1006 of 1941 portal weenies
in the LSD dump) authors:

```
lights[0] = { viewSpaceLocation.origin = (0.03, -1.29, 2.32),
              color = RGB(200,0,200),  intensity = 100,  falloff = 6 }
```

**War-spell projectiles** ship `PhysicsState = 166728 = 0x28B48` — `ReportCollisions | Missile(0x40)
| AlignPath | PathClipped | **LightingOn** | ScriptedCollision | Inelastic` — and 32 of their 43
distinct setups author a light too (`0x020003F0` Lightning Bolt → `RGB(200,0,255)` i100 f8).

ACE preserves this: `WorldObject_Networking.cs:563` synthesises `LightsStatus = true` from the
weenie's PhysicsState int, and `:645` re-emits the `LightingOn` bit on the wire. So the client really
does run `CPhysicsObj::set_lights` → `CPartArray::InitLights` (acclient.c:326321) → build a
`LIGHTLIST` → `CPartArray::AddLightsToCell(owner->cell)` → the light lands on the `CObjCell`.

**And then it goes nowhere, outdoors.** The per-frame dynamic refill only ever asks EnvCells:

```
SmartBox::set_viewer                       acclient.c:143995   (0x00452C80)
  Render::world_lights.num_dynamic_lights = 0                  :144012
  Render::add_dynamic_light(&viewer_light, player cell, player frame)
  CObjCell::add_dynamic_lights()                               :144033
     └─ 5-byte tailcall  →  CEnvCell::add_dynamic_lights()     acclient_2013.bndb_pseudo_c.txt:308233
           └─ iterate CEnvCell::visible_cell_table ONLY        acclient.c:349094
                 └─ CObjCell::add_dynamic_to_global_lights     acclient.c:346881
                       └─ Render::add_dynamic_light(lightinfo, cell->m_DID.id, &global_offset)
```

`visible_cell_table` holds **CEnvCells only**. Outdoors it is populated via
`CLandCell::grab_visible_cells` → `LScape::grab_visible_cells` → per-landblock
`CLandBlock::grab_visible_cells` → `CEnvCell::grab_visible(stab_list)` (acclient.c:354904 / 306571 /
351601 / 350001) — i.e. it holds the **building interiors** of loaded landblocks and never the
`CLandCell` you and the portal are standing in.

> **Finding: outdoors, retail silently drops every object dynamic light in the world.** The Holtburg
> town portal, a Flame Bolt crossing a field and a wisp in the open cast exactly nothing. Indoors the
> client delivers them correctly.

So P3's real job is two things:
1. **Re-donate** the retail-authored light for emitters whose cell the client will never ask.
2. **Synthesise** one for the visibly-luminous objects that were never authored a light at all —
   the classic wisps (`0x0200059A`/`99`/`9B`/`9D`, `0x02000899`, `0x0200089A`, `0x02001BAB`): one
   part, one surface, `Luminosity = 1.0`, empty `lights` block.

It also means **we must not double-light**. The scan skips any object that has an authored setup
light **and** `LIGHTING_ON` **and** an indoor cell — precisely the case the client already covers.

---

## 2. THE NO-THROUGH-WALL PROOF

### 2.1 `cellId` does not contain anything

`Render::add_dynamic_light(&LIGHTINFO, cellId, &frame)` → `Render::insert_light`
(acclient.c:380524, build-A `0x0054D1B0`, map `0x0014CDC0` → `0x0054DDC0`). It uses `cellId` for
**exactly two** things:

```c
  distancesq = 0.0;
  if ( !light_info->type )                                   // POINT only
  {
    LandDefs::get_block_offset(&result, cell_from, cell_id);  // :380546
    ... distancesq = |(frame->m_fOrigin + result) - stru_81EF50.m_fOrigin|²
  }
  ...
  v16->cellID = cell_id;                                     // :380612  (stored verbatim)
  PrimD3DRender::config_hardware_light(v19, &v16->d3dLight, cell_id, &v16->info);   // :380614
```

* `cell_from` is `Render::player_pos.objcell_id` and `stru_81EF50` is `Render::player_pos.frame`,
  written by `SmartBox::update_viewer` (acclient.c:145024) and `CellManager::ChangePosition`
  (:146714). Purely the distance-sort reference.
* `PrimD3DRender::config_hardware_light` (acclient.c, build-A `0x0059AD30`) **never reads its
  `cellID` parameter**.

`LandDefs::get_block_offset` (acclient.c:123110, `0x0043E630`, map `0x0003D7D0` → `0x0043E7D0`):

```c
  if ( cell_from >> 16 == cell_to >> 16 )        // SAME LANDBLOCK -> ZERO VECTOR
      *result = Legacy_Vector3_ZeroVector;
  else { ... (cell>>21)&0x7F8 ... * 24.0 ... }   // 192 units per landblock step, z forced 0
```

It reads **only the high 16 bits** — the landblock. The low 16 bits (the EnvCell index `0x0100+`)
are never touched. It is *structurally incapable* of distinguishing two rooms of one dungeon, and
returns the exact zero vector for them. That is the correct answer (EnvCell light frames are already
landblock-relative), and it means an out-of-PVS light lands at its true world position.

**Degenerate case:** `cell_to == 0` with `cell_from != 0` takes the `v7 = v8 = cell_from` unshifted
branch and produces ~1e10-unit offsets. `GlowLights.Emit` rejects `cellId == 0` outright.

### 2.2 Nothing downstream culls by cell either

| Function | acclient.c | Cell test? |
|---|---|---|
| `PrimD3DRender::UpdateLightsInternal` | :453206 | No. `Position{cellID, info.offset}.localtolocal(Render::viewer_pos, {0,0,0})` for **every** pooled light, no branch, no skip. |
| `Position::localtolocal` | :143795 | No failure path; uses `get_block_offset` → zero within a landblock → the transform is *exactly correct* across rooms. |
| `Render::remove_object_light` | :379672 | Pure viewer-space sphere overlap: `\|vs_loc − local_object_center\|² > (falloff + local_object_radius)²`. |
| `Render::minimize_object_lighting` | :380659 | First-8-that-overlap over the distance-sorted pool. No cell data. |
| `Render::minimize_envcell_lighting` | :379652 | `memset32(dynamic_light_used, 1, num_dynamic_lights)` then `add_active_light(i, DYNAMIC)` for **every** dynamic light. Its real signature is `(Position const&, float)` and it **reads neither parameter**. |
| `RenderDeviceD3D::DrawEnvCell` | :456878 | Calls the above unconditionally per envcell. |

> **Verdict: retail's `cellId` argument provides ZERO containment. A light injected with an
> out-of-PVS cell id renders at its true position and is enabled on every EnvCell drawn — it lights
> the wall from the other side.** A post-hook injection is *not* contained by anything.

### 2.3 Where retail's containment actually lives — and how we reuse it

Retail never bleeds because of **who is asked to donate**, not because of any test at
light-application time. The donor set is `CEnvCell::visible_cell_table`, rebuilt on every cell change:

```c
// CellManager::ChangePosition, acclient.c:146705-146717
  (*(void (__thiscall **)(uint))(*(_DWORD *)v12 + 112))(v12);   // vtable+112 = grab_visible_cells
  ...  Render::world_lights.num_static_lights = 0;
       Render::world_lights.num_dynamic_lights = 0;
       cell_from = curr_cell->pos.objcell_id;
  CEnvCell::flush_cells();

// CEnvCell::grab_visible_cells, acclient.c:350172
  CEnvCell::add_visible_cell(this->m_DID.id);            // itself
  for (i < num_stabs) CEnvCell::add_visible_cell(stab_list[i]);   // its DAT PVS
  if (seen_outside) LScape::grab_visible_cells(...);     // + building interiors of loaded LBs
```

`CObjCell::stab_list` (+228, count at +224) is the EnvCell DAT record's **`VisibleCells`** list —
unpacked in `CEnvCell::UnPack` (acclient.c:349282-349293) as `block_mask | uint16 index` per entry.
That authored per-cell PVS is the dungeon's own "which rooms can be seen from here" table.

The membership test is a side-effect-free hash lookup:

```
CEnvCell::GetVisible(unsigned int cell_id) -> CEnvCell*      // 0 when not visible
  acclient.c:349673 · build-A 0x0052DC10 · map RVA 0x0012D870 -> VA 0x0052E870
  (ACBindings Dats/DBObjs/CEnvCell.cs exposes it at the same 0x0052E870)
```

It is the *cheapest correct* test: no DAT load, no allocation — unlike `CEnvCell::add_visible_cell`
(loads a cell) and `CObjCell::GetVisible` (can allocate for outdoor ids).

**`GlowLights.CellAllowed` therefore applies retail's own rule with retail's own test:**

```csharp
if (cellId == 0) return false;                        // get_block_offset degenerate path
if (!cfg.GlowContain) return true;                    // the A/B escape hatch
if ((cellId & 0xFFFF) >= 0x100)                       // indoor EnvCell
    return CEnvCell_GetVisible(cellId) != 0;          // == retail's donation rule, exactly
return landscapeVisible;                              // outdoor: open air, but never leak into a
                                                      // sealed dungeon (mirrors RenderNormalMode's
                                                      // "outdoor cell || viewer_cell->seen_outside")
```

`landscapeVisible` reads the **player's** cell (`CPhysicsObj+144` → `CObjCell+232 seen_outside`),
not `SmartBox::viewer_cell` — `set_viewer` zeroes `viewer_cell` at acclient.c:144009 and its caller
restores it only after we return.

**What this guarantees:** a glow in a room whose cell is not in the viewer's authored PVS never
enters the light pool, exactly as a retail wall torch in that room never would. What it does *not*
claim: two rooms that the DAT says can see each other (a doorway, a balcony) will light each other —
that is retail's own behaviour and the parity bar.

### 2.4 Corrections to the prior research doc

* `research-retail-light-machinery.md` gives build-A `0x0052AD80` for `CObjCell::add_dynamic_lights`
  and implies it is a real outdoor/indoor split. It is a **5-byte `jmp`** to
  `CEnvCell::add_dynamic_lights`; there is only one refill routine. (IDA emitted no body; the Binary
  Ninja dump `acclient_2013.bndb_pseudo_c.txt:308233` has it.)
* The same doc's `CPartArray` sketch (`lights` at `+0x2C`) is wrong — PDB says `setup@84`,
  `num_parts@88`, `parts@92`, `lights@112`. (Already known from TorchLights; restated because P3
  depends on `parts`/`num_parts` too.)
* `Position` is polymorphic: `objcell_id` is at **+4**, not +0.

---

## 3. Classification

Verdict is memoised **per `CSetup` DID** in a 512-slot open-addressed table; the surface walk runs
once per setup, never per frame. Two signals, in order:

### 3.1 Authored (primary)

`CSetup::num_lights` (+144) / `CSetup::lights` (+148, `LIGHTINFO[104]`). We copy colour
(`+80`, RGBColor floats 0..1), intensity (`+92`), falloff (`+96`) and the light's **local offset
origin** (`+56` = `offset.m_fOrigin`), but build our own identity-quaternion `Frame` for
`LIGHTINFO::offset` so nothing depends on how the DAT-loaded Frame was cached.

Coverage over the full LSD dump (all 2,762 distinct setup DIDs scanned):

| weenieType | weenies | on a lit setup | setups | lit setups |
|---|---|---|---|---|
| Portal (7) | 1941 | **1779 (91.7%)** | 47 | 21 |
| ProjectileSpell (33) | 86 | **75 (87.2%)** | 43 | 32 |
| Creature (10) | 6057 | 371 (6.1%) | 693 | 84 |

Portal light colours are authored **per portal family** — `0x020001B3` purple `#C800C8`,
`0x020005D5` red, `0x020005D3` green, `0x020005D6` yellow, `0x020005D4` orange, `0x020005D2` blue —
so taking the DAT value is strictly better than a single hard-coded violet.

### 3.2 Luminous surfaces (fallback)

Live part/surface graph (already resident — no DAT load):
`CPartArray+88 num_parts` / `+92 parts[]`; `CPhysicsPart+32` → `CGfxObj**` (deref twice) for
`num_surfaces` (`CGfxObj+52`); `CPhysicsPart+196` → `CSurface**` (`part->surfaces` is sized from
`(*part->gfxobj)->num_surfaces` — acclient.c:314440, :314520); `CSurface+88 type`, `+96 color_value`,
`+112 base1pal`, `+120 luminosity`. `LUMINOUS = 0x40`, `ADDITIVE = 0x10000`, `BASE1_SOLID = 0x1`
(acclient.h:5820). `D3DPolyRender::SetSurface` (acclient.c:454385) reads `luminosity` straight into
`Render::luminosity`, so it is exactly what bloom already brightens.

**A bare `luminosity > 0` would have been a bad classifier — and would have missed every portal.**
Measured over all 693 creature setups:

| test | creature setups passing |
|---|---|
| any surface `Luminosity > 0` | 132/693 (**19.0%**) |
| any `Luminosity >= 0.9` | 67/693 (9.7%) |
| **`Luminosity >= 0.9` AND luminous fraction >= 0.25** | **41/693 (5.9%)** |

The distribution is bimodal at 0 and 1.0. The 19% figure is dominated by *one glowing eye or gem on
an ordinary body* (Olthoi Worker: 1 lit surface of 28; Marionettes 1/28; Dolls 1/12). Everything at
≥25% luminous fraction is genuinely luminous (wisps 1/1, Children of Fire/Lightning 21/21, Spectral
Samurai 20/37, Lantern 1/3). Ten mundane controls — base human NPC, Drudge, Rat, Tusker, Gromnie,
Skeleton, Shadow, Zombie, Virindi, Olthoi Worker — all fail the combined test.

So: `glowlum = 0.90` (peak) **and** `glowlumfrac = 0.25` (area fraction).

**And portal surfaces have `Luminosity = 0` across every top portal setup** (0x020001B3 →
GfxObj 0x01000ECB → Surface 0x08000102, lum 0; the coloured family → 0x08000157, lum 0). A
luminosity-only classifier would have missed 100% of portals. This is why the authored path is
primary.

> **FIXUP 2026-08-23 (defect 2).** The luminous test is `luminosity > 0` **alone**. The first cut
> also required `SurfaceType & (LUMINOUS 0x40 | ADDITIVE 0x10000)`, which was wrong twice over and
> rejected the Ethereal Wisp live even at `glowcreatures=2, glowrange=0`:
> * `D3DPolyRender::SetSurface` (acclient.c:454452) reads `surface->luminosity` into
>   `Render::luminosity` **unconditionally** — no type test anywhere — and `CSurface::InitEnd`
>   (:358128) never ORs those bits in, so the runtime `type` is verbatim the DAT value.
> * The false-positive statistics in the table above were measured from **luminosity values alone**,
>   so the extra gate was never part of what the thresholds were tuned against. Removing it makes
>   the code match the numbers it was tuned to, rather than being quietly stricter than them.
>
> Evidence: wcid 1535 Ethereal Wisp → setup `0x0200059A` (`lights: {}`, 1 part) → GfxObj
> `0x0100193F` → Surface `0x080003E4` = `{ type: Base1ClipMap (0x4) ONLY, luminosity: 1.0,
> diffuse: 1.0, colorValue: null }`. Peak 1.0 ≥ 0.9 and fraction 1/1 ≥ 0.25, so it now classifies —
> and so does every other clipmap glow, which is most of them. `BASE1_SOLID` is still consulted, but
> only as a *colour* source; the wisp is textured (`0x050015D7`) so its colour comes from the
> palette average, falling back to the `glow` class default `#D0E0FF` if the palette is unreadable.
>
> (Also from that session: wcid 42858 "Wisp" is a wall-banner housing item, not a creature — not a
> tuning target.)

### 3.2b Self-evident classes — and a claim I got wrong

> **CORRECTION 2026-08-23 (second live session).** The first cut required a glowing verdict from
> **every** class, and defended it with "a *destroyed* portal (setup `0x020019E4`) correctly stays
> dark". **That was wrong on both the fact and the principle.** `0x020019E4` is not a destroyed
> portal — the live ACE world DB says it is wcid 11960 `portalredspire-xp`, a perfectly real,
> walk-through portal standing in Holtburg (landblock `0xA9B4`, 145 m from the drop point). Its
> setup has 9 surfaces, **0 luminous**, and **no authored light** — so the rule I was defending
> left a real portal dark. It is not an outlier either: only **21 of the 47** portal setups in the
> LSD dump author a light.

**Portals and lifestones are now taken on trust: the ITEM_TYPE *is* the evidence.** Measured:

| setup | what it really is | authored lights | peak lum | luminous frac | old verdict |
|---|---|---|---|---|---|
| `0x020001B3` | Holtburg town/allegiance portals (3 of 4) | **1** (`#C800C8` i100 f6) | 0 | 0.00 | lit ✓ |
| `0x020019E4` | **Red Spire portal** (wcid 11960) | 0 | 0.00 | 0.00 | **dark ✗** |
| `0x020002EE` | **Lifestone** (wcid 509) | 0 | 0.75 | **0.14** | **dark ✗** |
| `0x0200059A` | Ethereal Wisp (wcid 1535) | 0 | 1.00 | 1.00 | lit ✓ |
| `0x02000A0B` | `rithwiclugiangemseller` NPC | 0 | 0.00 | 0.00 | dark ✓ |

The lifestone is the instructive one. It is a glowing blue crystal on a stone plinth: **one** lit
surface of seven, at 0.75. It fails *both* thresholds — and structurally it is the same shape as
the glowing-eye false positives (Olthoi Worker: 1 of 28) that the fraction test exists to reject.
Lowering `glowlum`/`glowlumfrac` to catch it would reopen those. Giving two closed, unambiguous
ITEM_TYPEs their own branch does not cost a single false positive.

**MISSILE deliberately stays evidence-based.** Arrows and atlatl darts are `MISSILE_PS` too, and
only the DAT can say which missiles are meant to glow.

### 3.3 Class → policy

`pwd` is at weenie+152, `_type` at weenie+208, `_wcid` at +164 (PDB fieldlists `0x13834`
ACCWeenieObject / `0x1364d` PublicWeenieDesc, verified directly), guarded by the `_phys_obj`
back-pointer at +148. ITEM_TYPE is tested by **bitmask**, not equality — `TYPE_PORTAL_MAGIC_TARGET`
is `0x10010000`, which an `== TYPE_PORTAL` test would miss.

| Class | Test | Needs a glow verdict? | Colour |
|---|---|---|---|
| `portal` | `_type & TYPE_PORTAL (0x10000)` | **no — self-evident** | authored, else derived, else `#C800C8`; `glowportalcolor` overrides |
| `lifestone` | `_type & TYPE_LIFESTONE (0x10000000)` | **no — self-evident** | derived from its 0.75 crystal surface, else `#4FA8FF` |
| `projectile` | `PhysicsState & MISSILE_PS (0x40)` | yes | authored, then the school table (§4) |
| `glow` | `_type & TYPE_CREATURE (0x10)`, or `STATIC_PS` at `glowstatics=1`, or any object at `glowcreatures=2` | yes | authored, else derived from the luminous surfaces |
| impact | a tracked projectile disappears from `CObjectMaint::object_table` | n/a | inherits the projectile's colour |

Note `DColor` is accumulated from **every** surface with `luminosity > 0`, independently of the
thresholds — so a self-evident emitter still gets its *real* colour whenever it has any luminous
surface at all, and only falls back to the class default when it has none.

`STATIC_PS` objects are excluded by default (`glowstatics=0`): outdoor lampposts hit the same
retail gap, but a town has many and they would crowd the 10-slot pool. Knob provided; P4 owns
per-draw ranking.

> **FIXUP 2026-08-23.** `glowstatics=1` was necessary but *not sufficient* — a lamppost is
> `TYPE_MISC`, not `TYPE_CREATURE`, so it also fell into the "prop" branch and silently needed
> `glowcreatures=2` as well. That is why setting `glowstatics=1` live at Holtburg left candidates
> at 1. Statics now have their own branch in the class gate and `glowstatics=1` alone is enough.
> Still default off, and still unvalidated live.

**Virindi are not caught** by either signal (setup `0x02000041`: 0/15 luminous surfaces, empty
`lights`, no default script) — same for Shadows (`0x0200071B`), Undead/Lich (`0x02000197`) and
"Glowing Pustule" (`0x02000F43`, lum 0 despite the name). Lighting those would need a wcid/name
allowlist, which is deliberately **not** shipped: it would be invented content, not data. Noted as
an open item.

---

## 4. School colours for war-spell projectiles

The DAT only bothered to colour two schools' projectile lights; Fire, Frost, Force, Shock Wave and
Whirling Blade all ship a featureless `#FFFFFF`. And there is no client-side `DamageType` on a
`CPhysicsObj`. So `glowschool=1` (default) recolours by **setup DID**, every value grounded:

| School | Setups | RGB | Where the number came from |
|---|---|---|---|
| Cold | `0x02000883`, `0x020003F4` | `#D5FCFF` | frost-elemental setup `0x02000BEF` authored light; corroborated by the projectile's own texture `0x050012ED` → palette `0x04000B70` (avg `#AEC5D4`, brightest `#DEFFFF`) |
| Fire | `0x02000881`, `0x02000E18` | `#FF6C00` | fire-elemental line `0x020006A3` authored light; corroborated by `0x0200154B` "Child of Fire" `#FF4600` |
| Pierce | `0x02000887`, `0x020003F3` | `#FFFBA4` | Force Bolt's own `Surface 0x08000D2D.color_value` (BASE1_SOLID) |
| Bludgeon | `0x02000885`, `0x020003FA` | `#F0E8D8` | texture `0x05001300` → palette `0x04000B9B` (avg `#968D78`, brightest white) |
| Acid | `0x02000882`, `0x020003F6` | `#009600` | already authored on `0x020003F6` |
| Electric | `0x02000884`, `0x02000880`, `0x020003F0` | `#C800FF` | already authored on `0x020003F0`; corroborated by lightning elemental `0x020006AC` `#D400FF` |
| Nether | `0x02001A27/28/29` | `#C800FF` | authored |

**Deliberately absent: `0x0200040D`.** That generic missile setup is shared by Flame Bolt I–VII
*and* ordinary arrows, so tinting it fire-orange would tint arrows too. Flame Bolt I–VII therefore
reads white. Fixing it properly needs a spell→projectile-object association the client does not
expose; it is an honest open item, not a bug to paper over.

---

## 5. Mechanism, cost and safety

**Two cadences.**

* **Classify + track, 4 Hz** (`glowscanhz`), from the `SmartBox::m_renderingCallback` slot
  (`RenderCallback.cs`) — the `UpdateLightsInternal` heartbeat *stalls* when the scene's light set
  is static, this callback fires every in-world frame. Walks `CObjectMaint::object_table` (the
  TorchLights walk: `SmartBox+172` → `CObjectMaint+132`, `HashBase{buckets@12, table_size@16}`,
  chain via node+4, `CPhysicsObj` **is** the node) and resolves each hit to a finished
  `(colour, intensity, falloff, local offset)` tuple in a bounded, distance-sorted list of ≤24.
* **Inject, every frame**, from the `SmartBox::set_viewer` @`0x00452C80` **POST**-detour. It runs
  after the wipe, after the viewer light and after the EnvCell refill, so each appended
  `Render::add_dynamic_light` lives exactly one frame, re-adds cleanly, sorts correctly and cannot
  leak. Per-frame work is proportional to **tracked** objects, not to all objects:

  | per tracked light, per frame | cost |
  |---|---|
  | `CObjectMaint::GetObjectA(id)` @`0x00508890` | one native O(1) hash lookup — **also the liveness check**: we never hold a `CPhysicsObj*` across frames, so a freed object can never be dereferenced |
  | `CEnvCell::GetVisible(cell)` @`0x0052E870` | one native hash lookup (indoor only) |
  | `Render::add_dynamic_light` @`0x0054E030` | one native call |

  With `glowmax = 6` that is ≤ 18 native calls and zero allocation per frame.

  Ranging is **not** on that path: `SmartBox::convert_to_player_space` @`0x00452DE0` (→
  `Position::localtolocal`) runs once per *candidate* on the 4 Hz scan. It resolves `this->player`
  itself, so the plugin does not hand-roll a landblock rebase and does not depend on its own
  `SmartBox::player` offset for distances.

**`Frame::cache` is called once, at warmup.** `Frame::cache` (acclient.c:356984) reads **only the
quaternion** — it fills `m_fl2gv[9]` from `qw/qx/qy/qz` and never touches `m_fOrigin`. So one
identity-quaternion `LIGHTINFO` whose `offset.m_fOrigin` is rewritten per emit is correct and
mandatory-compliant (`CreatureMode::AddLight` is the reference). `Render::insert_light` **copies**
the `LIGHTINFO` (`Frame::combine` + field copies), so one reused unmanaged buffer is safe. The
emitter's own `m_position.frame` (obj+80) is passed as the `frame` argument — the same shape retail
uses for `viewer_light` at `{0,0,2}` and for `LIGHTOBJ::global_offset`.

**0x80131509 discipline.** `GlowLights.Warmup(cfg, log)` runs in `AcmeLightsPlugin.Initialize` on
the managed thread: allocates the unmanaged `LIGHTINFO`/`Frame` scratch, resolves both addresses via
`AddressResolver`, commits all three arrays, `RuntimeHelpers.PrepareMethod`s **every** method on the
type, and additionally prepares `Render.add_dynamic_light`. `Frame::cache` is JITed by the warmup's
own `_li->offset.cache()` call. Nothing on the injection path logs or allocates; the detour body is
`try { … } catch { }` and `NativeHooks.SetViewerImpl` wraps it in the `LogSafe` pattern.

**`glowlights=0`** returns from `OnSetViewer` before touching anything — no `LIGHTINFO` is built and
no `add_dynamic_light` is called, so the frame is bit-identical to stock. The detour is still
installed (so the knob live-toggles like `bloom`/`torchlights`) and forwards immediately.

---

## 6. Config knobs (`C:\Temp\acdt\lights.cfg`, 1 Hz reload)

| key | default | meaning |
|---|---|---|
| `glowlights` | **1** | master. `0` = no work, frame bit-identical |
| `glowportals` | 1 | `TYPE_PORTAL` objects |
| `glowprojectiles` | 1 | `MISSILE_PS` objects |
| `glowcreatures` | 1 | `0` off · `1` luminous creatures · `2` also luminous props |
| `glowlifestones` | 1 | `TYPE_LIFESTONE` objects (self-evident, §3.2b) |
| `glowstatics` | 0 | also re-donate `STATIC_PS` world props (outdoor lampposts) |
| `glowintensity` | 1.0 | **multiplier** on the emitted intensity |
| `glowfalloffscale` | 1.0 | **multiplier** on the emitted falloff (D3D `Range = falloff × 1.5`) |
| `glowsynthintensity` | 100 | absolute intensity for a luminous object with no authored light (DAT idiom) |
| `glowsynthfalloff` | 4 | ditto falloff |
| `glowlift` | 0.6 | local +Z of a *synthesised* light (authored lights carry the DAT offset) |
| `glowpulse` | 0.10 | portal/creature breathing amplitude, ~0.55 Hz (0 = steady) |
| `glowlum` | 0.90 | peak surface luminosity required with no authored light |
| `glowlumfrac` | 0.25 | min luminous fraction of the object's surfaces |
| `glowmax` | 6 | max glow lights injected per frame (dynamic pool is 10) |
| `glowrange` | **0 (uncapped)** | metres worth tracking — see below |
| `glowscanhz` | 4 | classify/track scan rate |
| **`glowcontain`** | **1** | **1 = no through-wall bleed** (retail's PVS rule). `0` = off — the A/B |
| `glowportalboost` | 1.0 | intensity multiplier for portals |
| `glowportalcolor` | 0 | hex RGB override; `0` = the DAT's per-portal authored colour. `8060FF` = the owner's reference violet |
| `glowprojectileboost` | 1.0 | |
| `glowschool` | 1 | recolour white-lit war projectiles per §4 |
| `glowimpactms` | 400 | impact-flash duration (0 = off) |
| `glowimpactboost` | 2.0 | peak multiplier of the projectile's own intensity |
| `glowimpactfalloff` | 10 | |
| `glowlog` | 1 | per-classification + 10 s heartbeat log |

Log lines to audit against (`glowlog=1`, throttled to ≥1 s, 10 s heartbeat):

```
acmelights: glowlights scan 214 objs -> 7 classed, 3 lum/frac-reject, 1 range-reject, 4 candidates,
            tracking 3 (inject 3/frame, 8210 lit frames, impacts 0)
            player cell=0xA9B4001C org=(84.5,12.0,42.1)
acmelights: glowlights id=0x7A9B4080 wcid=43065 class=portal color=0xC800C8 i=100 f=6.0 dist=7.4
acmelights: glowlights REJECT lum/frac id=0x80001234 wcid=192 setup=0x020007DD lum=0.00 frac=0.00 dist=0.0
acmelights: glowlights REJECT range   id=0x80005678 wcid=1535 setup=0x0200059A lum=1.00 frac=1.00 dist=61.3
```

**`player org=` is the first thing to read.** If it prints `(0.0,0.0,0.0)` while you are plainly not
at the landblock corner, `SmartBox::player` (+248) is not resolving and every fallback distance is
measured from the corner — that is the 2026-08-23 defect-1 signature. Distances themselves now come
from `SmartBox::convert_to_player_space`, which resolves `this->player` internally and is immune to
that offset, so a bad `player org=` no longer breaks ranging — it just tells you the offset is wrong.

The `REJECT` lines are the classifier's confession, in three flavours:
* `class-gate` — the setup **would** have glowed but its class is switched off (the verdict is
  resolved *before* the class gate purely so this line can exist; it is a cached hash probe, so it
  is free). This is the line that would have found the Holtburg lifestone immediately.
* `lum/frac` — no authored light, and it failed the luminosity test; the numbers say by how much.
* `range` — it classified fine and only `glowrange` dropped it.

Slots are **quota'd per reason** (3 each). In the first live run 28 `lum/frac` rejects starved the
single `range` reject out of a flat 8-slot ring, and its reason had to be recovered by A/B-ing
`glowrange` live — a rare reason must never be crowded out by a common one.

### Why `glowrange` defaults to 0 (uncapped)

The four portals in Holtburg's landblock sit at 81.7 m, 86.3 m, 145.8 m and 153.5 m from the
drop point (ACE `landblock_instance`, measured against the player at `(84.0, 7.1, 94.0)`). A 45 m
cap hid **all four**: the player looks across town at an unlit portal, and the light pops in as
they walk up — precisely the "judge by what a player can actually see, even in the distance"
artefact we are told to avoid. The cap also buys almost nothing: the object walk happens regardless,
the tracked list is already bounded to the nearest 24 by an insertion sort, injection is capped at
the nearest `glowmax` (6), and retail's own `Render::insert_light` distance-sorts and drops anything
that does not fit the 10-slot pool. Three independent bounds already exist; a fourth that is wrong
about visibility is not worth having. Keep the knob for perf triage only.

---

## 7. LIVE-VALIDATION SCRIPT (for the orchestrator)

Rig: chat lines into `C:\Temp\acdt\chat.txt` + fresh `C:\Temp\acdt\pid.txt`, then
`schtasks /run /tn acdtschat`. Capture with `dump=1` + `extrahooks=1` (rotating BMP in
`C:\Temp\acdt`). Watch the ACE/plugin log for the `glowlights:` lines above. `.` toggles first
person. **Check `schat.log` for `ABORT-USER-ACTIVE` before every batch.**

### 7.1 Smoke (2 min) — does anything light at all

```
lights.cfg:  glowlights=1  glowlog=1  bloom=1
@telepoi Holtburg
```
**At the Holtburg drop point the expected tracked set is already known** (ACE
`landblock_instance`, landblock `0xA9B4`, player `(84.0, 7.1, 94.0)`), so this doubles as a
regression fixture — with `glowrange=0` all five should appear, nearest first:

| dist | id | wcid | what | expected class |
|---|---|---|---|---|
| 5.4 m | `0x7A9B404F` | 509 | lifestone | `lifestone` (**new**) |
| 81.7 m | `0x7A9B4051` | 6096 | Allegiance Hall portal | `portal`, authored `#C800C8` i100 f6 |
| 86.3 m | `0x7A9B4080` | 43065 | Portal to Town Network | `portal`, authored `#C800C8` i100 f6 |
| 145.8 m | `0x7A9B405B` | 11960 | Red Spire portal | `portal`, **synthesised** (setup `0x020019E4` authors nothing) |
| 153.5 m | `0x7A9B404A` | 19717 | Low-statue dungeon portal | `portal`, authored |

**Pass:** the lifestone glows blue at your feet, `class=lifestone` in the log; all four portals
tracked; ≥60 fps. This is the outdoor gap being filled — retail casts nothing for any of them.
`@create 2358` (Surface Portal, setup `0x020001B3`) adds a stationary purple one at arm's length.

A/B: `glowlights=0` → the glow disappears within one frame; `glowlights=1` → it returns.
Also `glowrange=45` → the four portals vanish from `tracking` and reappear as `REJECT range`
lines; that is the regression this default protects against.

### 7.2 Colour spread — the authored per-portal palette

```
@create 52070      # Red Portal   (setup 0x020005D5, authored #FF0000)
@create 73548      # Green Portal (setup 0x020005D3, authored #009600)
```
**Pass:** three portals, three *different* light colours matching the log's `color=` field. This is
the single strongest evidence that the classifier is reading the DAT and not guessing.
Then `glowportalcolor=8060FF` → all three go the owner's violet. Revert to `0`.

### 7.3 Glowing creatures — both classifier paths

```
@create 1535    # Ethereal Wisp  — setup 0x0200059A: 1 surface, Luminosity 1.0, NO authored light
                #                  => exercises the SYNTHESISED path (glowsynthintensity/falloff)
@create 21550   # Stasis Wisp    — setup 0x02000A29: 0/17 luminous surfaces, authored light #1C1DC0
                #                  => exercises the AUTHORED path in isolation
@create 5705    # Flicker (fire elemental) — authored #FF6C00
```
**Negative controls — these must NOT be tracked:**
```
@create 23      # Virindi Servant (0x02000041: 0/15 luminous, no lights)
@create 192     # Drudge Prowler  (0x020007DD: 0/22 luminous, no lights)
@create 3       # Olthoi Worker   (0x02000AAC: 1/28 luminous @0.6 — the fraction test must reject it)
```
**Pass:** wisps/elemental appear in the log as `class=glow`; the three controls never do. If the
Olthoi shows up, `glowlumfrac` is not being applied.

**wcid 1535 is the defect-2 regression target** — it failed to classify on 2026-08-23 and must now
appear. If it does not, read its `REJECT lum/frac` line: `lum=1.00 frac=1.00` means the thresholds
are fine and something later dropped it; `lum=0.00` means the surface walk is not reaching
`Surface 0x080003E4` (check `CPhysicsPart+196 surfaces` / `(*gfxobj)->num_surfaces`).
Do **not** use wcid 42858 "Wisp" — it is a wall-banner housing item, not a creature.

### 7.4 Projectiles + impact flash

Stand outdoors, have a mob target, cast a war spell (or `@create` the projectile wcids 1499 Flame
Bolt, 1503 Frost Bolt, 1633 Acid Stream, 1635 Lightning Bolt to inspect them statically).
**Pass:** `class=projectile` entries appear and vanish within ~1 s; a brief flash at the impact
point; `impacts 1` in the heartbeat. Acid reads green, Lightning violet, Frost pale blue.
Known: **Flame Bolt I–VII reads white** (shares generic setup `0x0200040D` with arrows — §4).
Turn `glowschool=0` and confirm Frost/Force fall back to white — that proves the table is live.

### 7.5 ★ THE THROUGH-WALL TEST (the owner's hard caveat)

Dungeon **"Under Drudge Fort", landblock `0x00EE`**. Two adjacent, mutually **invisible** cells,
6.59 m apart, same floor height, sharing one solid wall:

| | teleloc | EnvCell `VisibleCells` |
|---|---|---|
| Room **A** | `@teleloc 0x00EE0195 172.347 -53.173 -5.994` | 52 entries, **409 absent**; `cellPortals` → 406,408,407 |
| Room **B** | `@teleloc 0x00EE0199 173.717 -59.622 -5.994` | 48 entries, **405 absent**; `cellPortals` → 421 |

Neither cell lists the other, and no portal (doorway) connects them — so the plugin's gate must
reject A's light while you stand in B. Both cells have live drudge spawns, so both are walkable.

Procedure:
1. `@teleloc 0x00EE0195 172.347 -53.173 -5.994` — Room A. `@create 21550` (Stasis Wisp — blue
   authored light, stationary enough) **or** `@create 2358` (portal, guaranteed static).
   Confirm the log shows it tracked and the room is visibly lit blue/purple. Capture.
2. `@teleloc 0x00EE0199 173.717 -59.622 -5.994` — Room B, wall between you and the emitter.
   **PASS = no glow on the shared wall, and the log's `tracking` count still includes the emitter
   but `inject N/frame` drops by one** (tracked but gated). Capture.
3. Set `glowcontain=0` (live, ≤1 s). **The wall should now glow** — that is the holtburger failure
   mode reproduced on demand, and it proves the gate is what is doing the work. Capture.
4. Set `glowcontain=1`. The glow disappears again. Capture.

Steps 2 and 3 are the A/B pair to taildrop; they are the whole deliverable for the caveat.

Backup pair, same dungeon upper level (11.7 m apart, also mutually invisible, no shared portal):
```
@teleloc 0x00EE022C 39.147 -117.488 0.006     (VisibleCells lacks 573)
@teleloc 0x00EE023D 50.323 -114.016 0.006     (VisibleCells lacks 556)
```
Independent second dungeon — **Catacombs of Tar'Kelyn, `0x00BB`**, vertical separation, 6.0 m:
```
@teleloc 0x00BB0283 60.0 -120.0 -12.0
@teleloc 0x00BB02C9 60.0 -120.0  -6.0
```

### 7.6 No double-lighting indoors

While in Room A with the portal spawned, note the log. Because a portal indoors already has
`LIGHTING_ON` + an authored setup light + an EnvCell cell, the scan must **skip** it (the client's
own `add_dynamic_to_global_lights` donates it). **Pass:** the portal is lit, but the glowlights
`tracking` count does *not* include it — one light, not two. Compare its brightness to the same
portal outdoors at Holtburg: they should look the same, not 2× indoors.

### 7.7 Perf gate

1070, `renderDiag`/fps overlay, walk Holtburg for 60 s with `glowlights=1` then `glowlights=0`.
**Pass:** ≥60 fps in both, no measurable delta (the scan is 4 Hz over ~200 objects; the per-frame
path is ≤18 native calls). Then 10 min in a dungeon with no crash — the `set_viewer` trampoline is a
new detour and this is its stability gate.

---

## 7b. Live session 2026-08-23 (buildbox, wine/DXVK, Holtburg outdoor) — what it found

**Good:** the `set_viewer` POST-detour is **stable under wine/DXVK** — 550+ consecutive lit frames,
no crash. The Holtburg portal classified exactly as designed: `id=0x7A9B4080 wcid=43065
class=portal color=0xC800C8 i=100 f=6.0`, i.e. the authored-DAT path works end to end and the
outdoor gap really is filled. That also proves `InqItemType`/`InqWcid` (the ACCWeenieObject
`pwd._type`/`_wcid` reads at +208/+164 behind the `_phys_obj` guard) are correct, and that
`Emit`'s world anchor (`obj+80`) places the light correctly.

**Two defects reported, one real:**

1. **Distance reference point** — every candidate was rejected at the default `glowrange=45`
   (`tracking 0, inject 0`); `glowrange=0` made it work. Diagnosed at the time as a broken origin
   read. **The second session disproved that** (see below): the distances were correct all along
   and the real fault was the 45 m default itself. Reworked to
   `SmartBox::convert_to_player_space` @`0x00452DE0` anyway (§5) — a better implementation for
   other reasons — plus the `player org=` heartbeat field and the `REJECT range` line.
2. **Ethereal Wisp (wcid 1535) never classified** — the surface type-bit gate (§3.2 fixup box).
   This one was a genuine bug.

**Not a defect but a wart, also fixed:** `glowstatics=1` alone did nothing (§3.3 fixup box).

### Second session (after the first fixup)

**Ethereal Wisp 1535 now classifies and lights**: `class=glow color=0xD0E0FF i=100 f=4.0 dist=5.0`,
injecting every frame, stable. And the distance rework was **vindicated in reverse** —
`convert_to_player_space` returns `dist=86.3` for portal `0x7A9B4080`, *identical* to the old
arithmetic, and the ACE `landblock_instance` row for that portal `(14.4, 55.6, 78.2)` against the
player at `(84.0, 7.1, 94.0)` computes to exactly 86.3. **The original DistSq was never wrong**; the
"≈ player corner distance" reading was a numerical coincidence, and the heartbeat now shows the
player origin reading true in-block coords. The native call stays because it is the better
implementation (no hand-rolled rebase, immune to the `SmartBox::player` offset), not because the old
one was broken. **Offsets vindicated: `ObjOrigin`/`ObjPosFrame`/`SbPlayer` are all correct.**

Three findings from that session, all addressed here:

1. **The object reported as a misclassified portal is an NPC.** `id=0x7A9B404E wcid=9423` is
   `rithwiclugiangemseller` — ACE world DB: `weenieType 12` (Vendor), `itemType 16`
   (`TYPE_CREATURE`), setup `0x02000A0B` (21 parts, 26 surfaces, **0 luminous**, no authored
   light). The classifier read it correctly and rejected it correctly; **not a defect.** Worth
   noting *why* the reject line was misread as a class-gate failure: the `lum/frac` reject fires
   after the class gate for **every** class, including portals, so its presence never implied the
   creature branch. The new `class-gate` reason removes that ambiguity.
2. **The actual glowing blue thing near the drop point is the LIFESTONE** — `0x7A9B404F`, wcid 509,
   `itemType 0x10000000` (`TYPE_LIFESTONE`), 5.4 m away, `PhysicsState 0x410` (no `LightingOn`).
   There is no portal within 80 m. It now has its own self-evident class (§3.2b).
3. **`glowrange` 45 → 0** and **reject slots quota'd per reason** (§6).

---

## 8. Open risks / not done

1. **The `set_viewer` detour is new.** ~~Never run live.~~ **Cleared 2026-08-23**: stable under
   wine/DXVK for 550+ lit frames on the buildbox. Still owed a long-session dungeon soak (§7.7).
2. **Defaults are DAT-authored, not eye-tuned.** Intensity 100 / falloff 6–8 is retail's own idiom
   and what a wall torch uses, so it should read correctly — but `glowintensity` /
   `glowfalloffscale` exist precisely because nobody has looked at it yet.
3. **Flame Bolt I–VII reads white** (§4). Needs a spell→object association the client does not
   expose.
4. **Virindi / Shadows / Liches are not caught** (§3.3) — no authored light, no luminous surface.
   A wcid allowlist would fix it but would be invented content. Note the §3.2b escape hatch does
   NOT apply: unlike portals and lifestones there is no ITEM_TYPE that means "this creature glows",
   so trusting a class is not available here.
4b. **Other self-evident classes are unexamined.** `TYPE_PORTAL_MAGIC_TARGET` (`0x10010000`) is now
   caught by the portal bitmask, but nobody has surveyed whether e.g. `TYPE_GEM` or
   `TYPE_MANASTONE` deserve the same treatment. Do it from the DAT, not from intuition.
5. **Outdoor `STATIC_PS` props** (lampposts) hit the same retail gap and are off by default
   (`glowstatics=1` to try). They could crowd the 10-slot pool in a town; P4's per-draw ranking is
   the right home for that.
6. **One verdict per setup DID.** Two objects sharing a setup but differing by palette (recoloured
   creatures) share a derived colour. Authored lights are unaffected.
7. **A projectile culled from the object table** (rather than actually hitting) still produces an
   impact flash. Now that `glowrange` defaults to uncapped, the only bounds are the 400 ms decay,
   the containment gate and `glowmax`; cosmetic, but if stray flashes show up at distance, a
   modest `glowrange` is the mitigation.
8. **P4 interaction.** This phase produces well-scoped *sources* and caps itself at
   `glowmax=6` of 10 so it cannot starve retail's own lights. Ranking them per draw is P4's job.

---

## 9. ★ 2026-08-23 (evening) — THE SECOND OUTDOOR GAP, and what the gain pass can/cannot fix

Written while sizing the system-wide intensity pass the owner asked for after the 1070 human test
("lifestone not that noticeable… you should do it system wide"). Two findings; the first changes
what §1 claims.

### 9.1 Outdoors, a dynamic light is never *enabled*, only never *donated*

§1 proved the donation half: outdoors the per-frame refill only asks EnvCells, so the light never
enters `Render::world_lights`. P3 fixes that. But there is a **second, independent** outdoor gap
downstream, and it is still open:

```c
// RenderDeviceD3D::DrawMeshInternal            acclient.c:456974
  if ( !Render::useSunlight )
      Render::minimize_object_lighting();       // <- the ONLY per-draw slot chooser

// SmartBox::RenderNormalMode, outdoor branch   acclient.c:144903-144906
  Render::update_viewpoint(&viewer); Render::set_default_view();
  Render::useSunlightSet(1);                    // <- outdoors, unconditionally
  LScape::draw(lscape);

// Render::useSunlightSet                       acclient.c:380646
  Render::useSunlight = use_sunlight;
  Render::reset_active_lights_state();          // all 8 slots -> -1 (disabled), :379424
  if ( use_sunlight ) { Render::add_active_light(-1, 0); Render::enable_active_lights(); }
                                                // slot 0 = world_lights.m_Sunlight, :379630
```

> **So for every outdoor draw the active-light set is exactly {the sun}. `minimize_object_lighting`
> is not called, `enable_active_lights` disables slots 1..7, and an injected dynamic light —
> however bright, however long its range — contributes NOTHING outdoors.** The indoor paths are
> unaffected: `PView::draw` does `useSunlightSet(0); restore_all_lighting()` (:461554) before its
> EnvCell pass and `DrawEnvCell` calls `minimize_envcell_lighting` (:456892), which enables every
> dynamic light.

This is consistent with everything observed: the Redoubt (indoor) wisp light was clearly visible
and correctly contained, while the Holtburg (outdoor) lifestone was "not that noticeable" at 5.4 m.
It also matches P4's own note that `seldraws` reads 0 outdoors — the same call that never happens.

**FIXED 2026-08-23 (P3b) — owner-approved. See §10.**

### 9.2 Intensity is saturated; RANGE is the lever

`PrimD3DRender::config_hardware_light` (acclient.c:453119) is the entire LIGHTINFO→D3D mapping:

```c
  Diffuse   = color * intensity;            // color 0..1, DAT idiom intensity = 100
  Range     = falloff * rangeAdjust;        // rangeAdjust = 1.5
  Attenuation0 = 0; Attenuation1 = 1; Attenuation2 = 0;   =>  atten = 1/d
```

and `Render::enable_active_lights` hands that `RenderLight` to D3D untouched (:379594). So a point
light contributes `colour·intensity/d·N·L`, clamped at 1.0 by the rasteriser, and **exactly zero
past `falloff × 1.5` — a hard clip, not a tail.**

For the Holtburg lifestone (synth `i=100 f=4`): reach `= 6.0 m`. The owner at 5.4 m was standing
at the edge of the light's existence, and one step back it was gone entirely. Meanwhile the term
at 5.4 m is `100/5.4 = 18.5 ×` colour — already ~18× past saturation. **Raising intensity there
changes nothing visible; only grazing-angle surfaces (small N·L) and the newly-reachable far field
respond to it.** Hence the gain pass is primarily a *range* pass:

| lever | knob | effect |
|---|---|---|
| falloff → `Range` | `glowrangegain` × per-class `glow*range` | how far the tint reaches (**primary**) |
| intensity → `Diffuse` | `glowgain` × per-class `glow*boost` | oblique + far-field brightness (secondary) |
| synth light height | `glowlift` (0.6, unchanged) | `N·L` on the ground: lift 0.6→1.5 is ~2.4× at 5 m (**untouched third lever**, noted for a future pass) |

Shipped defaults: `glowgain 1.6`, `glowrangegain 1.6`; lifestone `1.25 / 1.4` (→ `i=200 f=8.96`,
**reach 13.4 m**), portal `1.0 / 1.25`, creature `1.0 / 1.2`, projectile `1.0 / 1.15`; impacts
inherit both globals. The `glowlog` tracked line now prints `effi=`/`efff=`/`reach=` so the emitted
values and the metre cutoff can be read live instead of inferred.

---

## 10. P3b — THE OUTDOOR ENABLE (implemented 2026-08-23, owner-approved, DEFAULT ON)

Fixes §9.1. `Services/GlowLights.OnLandscapeDraw` + the `LScape::draw` pre-detour in
`Services/NativeHooks.cs` (its own delimited block, like P3/P4).

### 10.1 Hook point — and why not `useSunlightSet`

| | `Render::useSunlightSet(int)` | **`LScape::draw(LScape*)`** ← chosen |
|---|---|---|
| address | map RVA `0x0014D060` → VA `0x0054E060` | **`0x00506D90`** (ACBindings `LScape.cs`; the map's LScape block does not export `draw`) |
| shape | `void __cdecl(int)` — a cdecl **with an argument**, the shape that destabilized the client on `SceneTool::EndFrame` (never root-caused) | `void __thiscall(self)` — the **proven** shape of all four existing AcmeLights hooks |
| scope | also fires in the creature-mode paperdoll path (acclient.c:143938-143941), whose very next statements zero both light pools | fires **only** on the landscape pass itself |
| coverage | — | both callers for free: `RenderNormalMode`'s outdoor branch (:144906) **and** `PView::draw`'s outside-view (:461480, looking out of a dungeon mouth) |

At `LScape::draw` **entry**, `useSunlightSet(1)` has just run, so the active set is exactly
`{sun}` and every landscape/object draw that follows inherits whatever we leave. In the
`PView::draw` case retail tears our additions down again at `:461554`
(`useSunlightSet(0)` + `restore_all_lighting`) before its EnvCell pass — the scoping we would
otherwise have had to hand-write.

The build-A → shipped delta is **not** a global constant, so the address could not be guessed:
the three `Render::` neighbours all move by `+0xC10` (`enable_active_lights` `0x0054C080`→
`0x0054CC90`, `minimize_object_lighting` `0x0054D480`→`0x0054E090`, `useSunlightSet`
`0x0054D450`→`0x0054E060`, each confirmed against the map), while `LScape::draw` moves by
`+0xA60` (`0x00506330`→`0x00506D90`). ACBindings is the source of truth for it.

### 10.2 What it does

The dynamic half of `Render::minimize_envcell_lighting` (acclient.c:379652) — the routine the
client itself runs for **every EnvCell it draws** — applied to the sunlit pass:

```csharp
if (*Render.useSunlight == 0) return;                  // only the broken case
for (i = 0; i < num_dynamic_lights && added < budget; i++) {
    rl = sorted_dynamic_lights[i];                     // distance-sorted => nearest first
    if (!(rl->info.intensity > 0)) continue;           // skip the dormant viewer_light
    dynamic_light_used[i] = 1;
    Render.add_active_light(i, /*DYNAMIC*/ 2);
}
Render::enable_active_lights();
```

`add_active_light`'s index argument indexes `sorted_dynamic_lights` (acclient.c:379622), which
`Render::insert_light` keeps sorted by distance to the player — so the first `budget` are the
nearest `budget`. The `intensity > 0` skip matters because `set_viewer` adds retail's own
`viewer_light` every frame at distance 0 (it therefore sorts **first**) with intensity 0 unless
`headlamp` is on: without the skip it would eat the nearest real glow's slot.

### 10.3 Safety argument (this is the bar that was met)

* **Retail's own primitives, in retail's own order.** `add_active_light` + `enable_active_lights`,
  the exact pair `minimize_envcell_lighting` drives every frame indoors. No new state is invented;
  the only client memory written is `dynamic_light_used[i] = 1`, which retail itself `memset32`s to
  1 in `restore_all_lighting` (:379700).
* **Cannot overrun and cannot evict the sun.** `add_active_light` self-allocates slots and returns
  without adding once the 8-entry `Render::curLightUsage` table is full (:379548). If it reuses the
  sun's slot via the `prevLightUsage` match, it *relocates* the sun to a free slot — retail's own
  behaviour. `glowoutdoorbudget` is clamped to 1..7 on top of that.
* **One-pass lifetime.** The next `useSunlightSet` / `minimize_*` call resets the table, exactly
  like retail's own per-draw selection. Nothing accumulates across frames.
* **Inert when idle.** Returns before touching anything unless GlowLights is tracking an emitter,
  so a player with no glow source nearby gets a frame identical to today's.
* **Stale-index exposure is nil.** `sorted_dynamic_lights[]` entries are pointers into the fixed
  `dynamic_lights[10]` array, valid for the process lifetime; a pool wipe between our
  `enable_active_lights` and a later draw can at worst re-upload a stale light, never dereference
  freed memory. Retail carries the identical exposure through its own `carryOver` mechanism.
* **Pacing.** No allocation, no LINQ, no logging on the path; counters are plain ints folded into
  the existing 1 Hz glow heartbeat, which goes through `AsyncLog`.

**Which bar was met: safe-by-construction ✅, live-validated ❌.** The house rule ("validated gates
ship default-on") is met on the safety half only — this has never executed once. It ships DEFAULT
ON because the owner's complaint is precisely that outdoor glow is invisible, and because
`glowoutdoor=0` **read at startup means the detour is never installed at all** (zero footprint,
exactly like `selection=0`) — a real escape hatch for the trampoline itself, not only for its body.

### 10.4 Knobs

| key | default | meaning |
|---|---|---|
| `glowoutdoor` | **1** | 0 = off. At startup: the `LScape::draw` detour is never installed. Live: the body returns before touching client state |
| `glowoutdoorbudget` | **6** | hardware slots the outdoor pass may take, 1..7 (slot 0 is the sun) |

### 10.5 Live test — what to watch

Bare defaults, `@telepoi Holtburg`, stand at the drop point (the lifestone is 5.4 m away).

```
acmelights: hook installed  LScape::draw @ 00506D90 (P3b outdoor glow enable)
acmelights: glowlights scan N objs -> ... tracking 3 (inject 3/frame, ... ,
            outdoor 3/frame, 41210 sunlit passes, 0 outdeclined) player cell=0xA9B4001C ...
```

* **PASS** = `outdoor N/frame` is non-zero **and** the lifestone visibly tints the ground blue.
  `tracking 3` with `outdoor 0/frame` while standing outside is the pre-P3b behaviour — read
  `outdeclined`, which counts every early return (`useSunlight` was 0, a null pool, an impossible
  count, or every dynamic had intensity 0).
* **A/B:** `glowoutdoor=0` live → the outdoor tint disappears within one frame and `outdoor`
  drops to 0, while `tracking`/`inject` are unchanged (proof it is the *enable* doing the work,
  not the injection). `glowoutdoor=1` → it returns.
* **Slot starvation check:** with several emitters in view, confirm retail's own lights (torches on
  a nearby building) do not go dark. If they do, lower `glowoutdoorbudget` to 3-4.
* **Perf gate:** the detour is once per landscape pass (~once per frame), and the body is ≤ 7
  native calls. Walk Holtburg 60 s with `glowoutdoor=1` then `0`; expect no measurable delta.
* **Stability gate (the real one):** this is a NEW detour. 10 min outdoors + several
  indoor/outdoor transitions and teleports with no crash. If the client faults at world entry,
  `glowoutdoor=0` in `lights.cfg` before launch means the trampoline is never written.
