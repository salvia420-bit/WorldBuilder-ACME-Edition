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

A "glowing" verdict is required for **every** class, so a *destroyed* portal (setup `0x020019E4` —
no authored light, no luminous surface) correctly stays dark.

### 3.3 Class → policy

| Class | Test | Colour | Notes |
|---|---|---|---|
| `portal` | `ACCWeenieObject.pwd._type == TYPE_PORTAL (0x10000)` | authored, or `glowportalcolor` | `pwd` is at weenie+152, `_type` at weenie+208, `_wcid` at +164; guarded by the `_phys_obj` back-pointer at +148 |
| `projectile` | `PhysicsState & MISSILE_PS (0x40)` | authored, then the school table (§4) | tracked per frame from the live physics object, never a stale position |
| `glow` | `pwd._type == TYPE_CREATURE (0x10)` (or any object at `glowcreatures=2`) | authored, else derived from the luminous surfaces | |
| impact | a tracked projectile disappears from `CObjectMaint::object_table` | inherits the projectile's colour | 300–500 ms, quadratic ease-out |

`STATIC_PS` objects are excluded by default (`glowstatics=0`): outdoor lampposts hit the same
retail gap, but a town has many and they would crowd the 10-slot pool. Knob provided; P4 owns
per-draw ranking.

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
| `glowrange` | 45 | metres from the player worth tracking (0 = no cap) |
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

Log lines to audit against:

```
acmelights: glowlights scan 214 objs, 3 candidates, tracking 3 (inject 3/frame, 8210 lit frames), impacts 0
acmelights: glowlights id=0x8000ABCD wcid=2358 class=portal color=0xC800C8 i=100 f=6.0 dist=7.4
```

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
Expect within 10 s: a `glowlights scan …` heartbeat with `tracking >= 1` if a portal is in range.
`@create 2358` (Surface Portal, setup `0x020001B3`) spawns a stationary ethereal purple portal.
**Pass:** a purple pool of light on the ground under it, `class=portal color=0xC800C8 i=100 f=6.0`
in the log, ≥60 fps. This is the outdoor gap being filled — retail casts nothing here.

A/B: `glowlights=0` → the glow disappears within one frame; `glowlights=1` → it returns.

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

## 8. Open risks / not done

1. **The `set_viewer` detour is new.** It is the same thiscall shape as the proven
   `SetWorldAmbientLight` detour (not the cdecl-with-byte `EndFrame` shape that destabilized the
   client on 2026-08-22), but it has never run live. §7.7 is its gate.
2. **Defaults are DAT-authored, not eye-tuned.** Intensity 100 / falloff 6–8 is retail's own idiom
   and what a wall torch uses, so it should read correctly — but `glowintensity` /
   `glowfalloffscale` exist precisely because nobody has looked at it yet.
3. **Flame Bolt I–VII reads white** (§4). Needs a spell→object association the client does not
   expose.
4. **Virindi / Shadows / Liches are not caught** (§3.3) — no authored light, no luminous surface.
   A wcid allowlist would fix it but would be invented content.
5. **Outdoor `STATIC_PS` props** (lampposts) hit the same retail gap and are off by default
   (`glowstatics=1` to try). They could crowd the 10-slot pool in a town; P4's per-draw ranking is
   the right home for that.
6. **One verdict per setup DID.** Two objects sharing a setup but differing by palette (recoloured
   creatures) share a derived colour. Authored lights are unaffected.
7. **A projectile culled at range** (rather than actually hitting) still produces an impact flash.
   Bounded by `glowrange` (45 m) and 400 ms; cosmetic.
8. **P4 interaction.** This phase produces well-scoped *sources* and caps itself at
   `glowmax=6` of 10 so it cannot starve retail's own lights. Ranking them per draw is P4's job.
