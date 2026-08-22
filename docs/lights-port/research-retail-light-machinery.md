# Retail AC client FF lighting machinery — research for the AcmeLights port

> Explore-agent research report, 2026-08-22. Raw findings with file:line / symbol citations.

I have everything. Final report:

---

# RETAIL AC Client — Native FF D3D9 Lighting Machinery

## 0. Build/address caveat (read first)

Three artifacts, **two different binaries**:

| Artifact | Build |
|---|---|
| `/home/wbterminal/ac-headers/acclient.c`, `acclient.txt`, `acclient_2013.bndb_pseudo_c.txt` | build **A** (2013). `acclient.txt` is a PDB-ish listing: `seg1 base = 0x401000` (code), `seg3 base = 0x80A000` (data). |
| `.../Chorizite.Core/acclient.map` | build **B**. **Runtime VA = map_RVA + 0x401000**. |
| `ACBindings/Generated/*.cs` | build **B** (verified: `LIGHTINFO::SetDirection` map `0x051740`+`0x401000` = `0x452740` = binding offset; `GetDirection` map `0x19ABA0` → `0x59BBA0` = binding offset). |

Deltas A→B are **non-uniform** (`+0x40` in the SmartBox region, `+0xC10` in the Render region). **Use the map (build B) addresses for hooking.** All data addresses below are build-A-derived (from `acclient.txt` seg3) — see §7 for how to re-derive them at runtime on build B.

---

## 1. Core types

### `LIGHTINFO` — 104 bytes (0x68). Confirmed by `operator new(0x68u)` in `CreatureMode::AddLight`.

```c
struct __cppobj LIGHTINFO      // acclient.h:31688
{
  int             type;                  // +0x00  LIGHTINFO::LightType
  Frame           offset;                // +0x04  (64 bytes)
  AC1Legacy::Vector3 viewerspace_location;// +0x44  runtime-only, NOT in DAT
  RGBColor        color;                 // +0x50  3x float 0..1
  float           intensity;             // +0x5C
  float           falloff;               // +0x60
  float           cone_angle;            // +0x64  degrees, spot only
};
// LightType: POINT_LIGHT=0, DISTANT_LIGHT=1, SPOT_LIGHT=2, INVALID=0xFFFFFFFF
```

### `Frame` — 64 bytes (0x40)
```c
struct __cppobj Frame          // acclient.h:30647
{ float qw, qx, qy, qz;        // +0x00 quaternion
  float m_fl2gv[9];            // +0x10 cached local→global 3x3 (Frame::cache() fills this)
  AC1Legacy::Vector3 m_fOrigin;// +0x34 }
```
> Any injected `LIGHTINFO` **must** have `Frame::cache()` called on `offset`, or `m_fl2gv` is garbage and `GetDirection`/`config_hardware_light` produce nonsense.

### `RenderLight` — 220 bytes (0xDC). Verified: `LightParms.static_lights_Raw[13200] / 60 = 220`.
```c
const struct __cppobj RenderLight   // acclient.h:38943
{
  _D3DLIGHT9 d3dLight;      // +0x00 (104 bytes) — passed straight to IDirect3DDevice9::SetLight
  int        d3dLightIndex; // +0x68
  unsigned   cellID;        // +0x6C
  LIGHTINFO  info;          // +0x70 (104 bytes)
  float      distancesq;    // +0xD8 sort key (dist² from cell_from origin)
};
```

### `LightParms` — the actual light pool (NOT `m_GState.FFLightSources`)
```c
struct __cppobj LightParms          // acclient.h:46620
{
  RGBColor    ambient_color;        // +0x000
  RGBColor    sunlight_color;       // +0x00C
  Vector3     sunlight;             // +0x018
  bool        m_bSunlightValid;     // +0x024
  RenderLight m_Sunlight;           // +0x028 (220)
  int         num_static_lights;    // +0x104
  RenderLight static_lights[60];    // +0x108 (13200)
  RenderLight *sorted_static_lights[60];  // +0x34B8 (240)
  int         num_dynamic_lights;   // +0x35A8
  RenderLight dynamic_lights[10];   // +0x35AC (2200)
  RenderLight *sorted_dynamic_lights[10]; // +0x3E44 (40)
};                                  // total 0x3E6C
```

### `LIGHTOBJ` / `LIGHTLIST` — the cell-attachment layer
```c
struct __cppobj LIGHTLIST { unsigned num_lights; LIGHTOBJ *lightobj; };  // 8 bytes
struct LIGHTOBJ { LIGHTINFO *lightinfo; /*+0*/  Frame global_offset; /*+4*/  int state; /*+0x44*/ };  // 72 bytes
// state bit 0 == LightState::STATIC_LS -> routed to add_static_light, else add_dynamic_light
```

### `HWLightUsage` — the 8 hardware slots
```c
struct HWLightUsage { bool carryOver; int lightClass; int index; };  // 12 bytes, arrays of 8
// lightClass: LightClass{ SUNLIGHT=0, STATIC=1, DYNAMIC=2, NO_LIGHT=-1 }
```

### Where does `m_GState.FFLightSources` get filled? **It never does.**
Exhaustive xrefs to `FFLightSources` in `acclient.c`:
- `RenderDevice::GraphicsStatesType::GraphicsStatesType` — zero-init (`m_data=0; m_num=0; ChangedFFLightSources=1`)
- `RenderDevice::~RenderDevice` / `scalar deleting destructor` — `operator delete[]`

That's it. `SmartArray<RenderLight,1>::grow/Reset/operator=` and `RenderLight::operator=` exist in the map (`0x14F070`, `0x14EF40`, `0x14F310`, `0x14EEF0`) but are dead code in retail. Same for `m_GState.pMPLightSource`. **The live pipeline is `Render::world_lights` (a `LightParms` global), not `m_GState`.**

---

## 2. Lifecycle: DAT → live light → D3D

### 2a. DAT authoring
`dats.xml` (`DatReaderWriter/dats.xml:2731`) and ACE (`ACE.DatLoader/Entity/LightInfo.cs`):
```xml
<type name="LightInfo">
  <field name="ViewSpaceLocation" type="Frame"/>
  <field name="Color" type="ColorARGB"/>
  <field name="Intensity" type="float"/>
  <field name="Falloff"   type="float"/>
  <field name="ConeAngle" type="float"/>
</type>
<!-- Setup: -->
<field type="int" name="_numLights"/>
<vector name="Lights" length="_numLights" type="Dictionary" genericKey="int" genericValue="LightInfo"/>
```
**There is no `type` field in the DAT.** `CSetup::UnPack` (build A `0x0051A...`, acclient.c line 335521) reads the *dictionary key* into `LIGHTINFO+0` — i.e. **the DAT dictionary key lands in `LIGHTINFO::type`**:
```c
*(_DWORD *)v82 = *(_DWORD *)*v4;            // <-- key -> LIGHTINFO::type
Frame::UnPack((Frame *)(v82 + 4), v4, v60); // offset
RGBColor::UnPack((RGBColor *)(v82 + 80), v4, v60);
*(_DWORD *)(v82 + 92)  = intensity;
*(_DWORD *)(v82 + 96)  = falloff;
*(_DWORD *)(v82 + 100) = cone_angle;
// stride 104
```
So a setup whose light keys are 0,1,2 gets POINT, DISTANT, SPOT respectively. In practice retail setups use key 0 → all DAT setup lights are `POINT_LIGHT`. `viewerspace_location` is never unpacked (runtime-only).

### 2b. Object → cell attachment (this is what makes a wall torch a live light)
A torch is a `CPhysicsObj` whose `CSetup` has `num_lights > 0`, plus **PhysicsState bit `0x800` (LIGHTS_ON)**.

```
CPhysicsObj::set_lights(lights_on, send_event)        [A 0x0050FCF0 | map 0x0010F7C0 -> 0x005107C0]
  lights_on:  state |= 0x800; CPartArray::InitLights(part_array)
  else:       state &= ~0x800; CPartArray::DestroyLights(part_array)

CPhysicsObj::set_state(new_state, send_event)         [A 0x00514DD0 | map 0x001148D0 -> 0x005158D0]
  if (changed & 0x0800) -> InitLights / DestroyLights   // server-driven PhysicsState

SetLightHook::Execute(CPhysicsObj*)                   [A 0x00526FD0 | map 0x00126BD0 -> 0x00527BD0]
  { CPhysicsObj::set_lights(object, this->_lights_on, 0); }
  // struct SetLightHook : CAnimHook { int _lights_on; };
  // AnimationHookType::SetLight = 25 (ACE.Entity/Enum/AnimationHookType.cs:31)
  // => animation/PhysicsScript frames toggle lights on/off (torch flicker, spell FX)
```

```c
int CPartArray::InitLights(CPartArray *this)          // A 0x00518C00 | map 0x00118730 -> 0x00519730
{
  if (this->owner && this->setup->num_lights) {
    v2 = operator new(8u);                            // LIGHTLIST
    LIGHTLIST::LIGHTLIST(v2, this->setup->num_lights); // allocs LIGHTOBJ[n]
    this->lights = v2;
    for (i = 0; i < lights->num_lights; ++i) {
      lightobj[i].lightinfo = &this->setup->lights[i]; // POINTS AT DAT DATA
      if (this->owner->state & 1) lightobj[i].state |= 1;   // STATIC_LS
    }
    CPartArray::AddLightsToCell(this, this->owner->cell);
  }
  return 1;
}
```
`CPartArray::AddLightsToCell` → `CObjCell::add_light(cell, &lights->lightobj[i])` for each; appends to `CObjCell::light_list` (`DArray<LIGHTOBJ const*>`, grows by 5). Re-run on cell transitions from `CPhysicsObj::change_cell` (acclient.c:318239 / :318270).

`LIGHTLIST::set_frame(const Frame&)` [map `0x00117790` → `0x00518790`] stamps each `LIGHTOBJ::global_offset` — this is how a moving/animated part drags its light along.

### 2c. Cell → global light pool (per frame / per cell-change)
```c
void CObjCell::add_static_to_global_lights(CObjCell *this)   // A 0x0052B350 | map 0x0012AF60 -> 0x0052BF60
  for each light_list[i]:  if (state & 1) Render::add_static_light (lightinfo, m_DID.id, &global_offset);

void CObjCell::add_dynamic_to_global_lights(CObjCell *this)  // A 0x0052B390 | map 0x0012AFA0 -> 0x0052BFA0
  for each light_list[i]:  if (!(state & 1)) Render::add_dynamic_light(lightinfo, m_DID.id, &global_offset);

void CObjCell::add_lights(CObjCell*)          // A 0x0052B950 | map 0x0012B560 -> 0x0052C560  (both)
static void CObjCell::add_dynamic_lights()    // A 0x0052AD80 | map 0x0012A990 -> 0x0052B990
static void CEnvCell::add_dynamic_lights()    // A 0x0052D410 | map 0x0012D070 -> 0x0052E070
   // walks CEnvCell::visible_cell_table, calls add_dynamic_to_global_lights on every visible cell
```
Statics are collected in `CEnvCell::load_cells`-ish path (acclient.c:349954, `CObjCell::init_objects` + `add_static_to_global_lights` per visible cell) — only on cell transition. Dynamics are rebuilt **every viewer move**.

### 2d. The per-frame rebuild driver
```c
void SmartBox::set_viewer(SmartBox *this, Position *new_viewer, int set_sought_position)
// A 0x00452C40 | map 0x00051C80 -> 0x00452C80
{
  ...
  unk_8186E0 = LODWORD(SmartBox::s_fViewerLightFalloff);   // viewer_light.falloff
  Render::world_lights.num_dynamic_lights = 0;             // <-- WIPE dynamics
  unk_8186DC = LODWORD(SmartBox::s_fViewerLightIntensity); // viewer_light.intensity
  if (this->player) {
    if (!viewer_light.type || viewer_light.type == 2) viewer_light.offset.m_fOrigin = {0,0,2.0};
    Render::add_dynamic_light(&viewer_light, player->m_position.objcell_id, &player->m_position.frame);
  } else { ... add at viewer ... }
  CObjCell::add_dynamic_lights();                          // <-- REFILL dynamics
  SoundManager::SetPlayerPosition(...); LScape::set_sky_position(...); SceneTool::SetupCamera(...);
}
```
This is **the** per-frame dynamic-light rebuild and the natural place to append plugin lights (see §7).

### 2e. World→view transform + ambient upload (once per viewpoint)
```c
void Render::update_viewpoint(Position *_viewer_pos)     // A 0x0054D... | map 0x0014C9E0 -> 0x0054D9E0
{ ...; RenderDeviceD3D::SetWorldToViewMatrix(render_device, &vm);
  ((void (*)(void))Render::m_pRenderer->vfptr->UpdateLightsInternal)();   // <-- RenderVtbl slot 10 (+0x28)
  ... }
```
```c
void PrimD3DRender::UpdateLightsInternal()   // A 0x0059AED0 | map 0x0019AEE0 -> 0x0059BEE0
{
  // 1) ambient: world_lights.ambient_color * ambientBoostFactor, quantized to 8-bit TWICE
  //    (float->u8->float->u8 — measurable banding; free quality win to patch)
  RenderDeviceD3D::SetFFAmbientColor32(render_device, argb32);   // -> D3DRS_AMBIENT(139)

  // 2) for each sorted_static_lights[0..num_static_lights):
  //      build Position{cellID, info.offset} -> Position::localtolocal(Render::viewer_pos, ...)
  //      -> writes info.viewerspace_location
  //      then Frame stru_81EF08 (viewer frame) transforms viewerspace_location into
  //      d3dLight.Position (with Y/Z SWAPPED: D3D.y <- AC.z, D3D.z <- AC.y)
  //      and marks static_light_used[i] = 1
  // 3) same for sorted_dynamic_lights[0..num_dynamic_lights)
  // 4) lazily builds m_Sunlight (D3DLIGHT_DIRECTIONAL, Diffuse = sunlight_color * |sunlight|,
  //    Direction = -sunlight with Y/Z swap) if !m_bSunlightValid
}
```

### 2f. Insertion + D3DLIGHT9 authoring
```c
void Render::insert_light(int max_lights, int *num_lights, RenderLight *lights,
                          RenderLight **sorted_lights, LIGHTINFO *light_info,
                          const unsigned cell_id, Frame *frame, int offset)
// A 0x0054D1B0 | map 0x0014CDC0 -> 0x0054DDC0
{
  distancesq = 0;
  if (!light_info->type) {                        // POINT only
    LandDefs::get_block_offset(&result, cell_from, cell_id);
    distancesq = |(frame->m_fOrigin + block_offset) - stru_81EF50.m_fOrigin|²;   // vs current cell origin
  }
  // insertion sort into sorted_lights[] by ascending distancesq;
  // if full (num==max) and new light is farthest -> DROP IT (return)
  v16 = sorted_lights[v12];
  v16->info.type = light_info->type;
  Frame::combine(&v16->info.offset, frame, &light_info->offset);   // cell/obj frame ∘ light frame
  /* color round-tripped through 8-bit ARGB (quantization!) */
  v16->info.intensity = light_info->intensity;
  v16->info.falloff   = light_info->falloff;
  v16->info.cone_angle= light_info->cone_angle;
  v16->distancesq     = distancesq;
  v16->cellID         = cell_id;
  v16->d3dLightIndex  = offset + (v16 - lights);
  PrimD3DRender::config_hardware_light(v19, &v16->d3dLight, cell_id, &v16->info);
}

void Render::add_static_light (LIGHTINFO*, uint cell_id, Frame*)  // A 0x0054D3E0 | map 0x0014CFF0 -> 0x0054DFF0
  -> insert_light(Render::max_static_lights,  &world_lights.num_static_lights,
                  world_lights.static_lights, world_lights.sorted_static_lights,
                  li, cell_id, frame, Render::max_dynamic_lights + 1);

void Render::add_dynamic_light(LIGHTINFO*, uint cell_id, Frame*)  // A 0x0054D420 | map 0x0014D030 -> 0x0054E030
  -> insert_light(Render::max_dynamic_lights, &world_lights.num_dynamic_lights,
                  world_lights.dynamic_lights, world_lights.sorted_dynamic_lights,
                  li, cell_id, frame, 1);
```

### 2g. Attenuation model — `config_hardware_light`
```c
int PrimD3DRender::config_hardware_light(int light_index, _D3DLIGHT9 *o, uint cellID, LIGHTINFO *i)
// A 0x0059AD30 | map 0x0019AD40 -> 0x0059BD40
{
  if (!d3d_device) return 0;
  o->Diffuse.rgb = i->color.rgb * i->intensity;   // NOTE: Diffuse.a never set here
  o->Specular = {0,0,0,0};
  o->Ambient  = {0,0,0,0};

  if (i->type == 0) {                 // POINT
    o->Type = D3DLIGHT_POINT(1);
    o->Falloff = 1.0f;
    o->Range   = i->falloff * rangeAdjust;                  // rangeAdjust = 1.5f
    o->Position = { off.x, off.z, off.y };                  // Y/Z SWAP
  } else if (i->type == 1) {          // DISTANT
    o->Type = D3DLIGHT_DIRECTIONAL(3);
    o->Direction = { dir.x, dir.z, dir.y };                 // Y/Z SWAP, 3 separate GetDirection calls
    return 1;                                               // <-- EARLY RETURN: no attenuation write
  } else if (i->type == 2) {          // SPOT
    o->Type = D3DLIGHT_SPOT(2);
    o->Falloff = 1.0f;
    o->Range   = i->falloff * rangeAdjust;
    o->Theta = o->Phi = i->cone_angle;                      // inner == outer -> hard cone edge
    o->Position  = { off.x, off.z, off.y };
    o->Direction = { dir.x, dir.z, dir.y };
  } else return 1;

  o->Attenuation0 = 0.0f;
  o->Attenuation1 = 1.0f;    // pure LINEAR 1/d falloff
  o->Attenuation2 = 0.0f;
}
```
**Attenuation model: `1 / (0 + 1·d + 0·d²)`, hard-clipped at `Range = falloff * 1.5`.** No inverse-square, no smooth range cutoff. `Theta == Phi` means spots have no penumbra. `Specular` and `Ambient` are always black.

`LIGHTINFO::GetDirection` [A `0x0059AB90` | map `0x0019ABA0` → `0x0059BBA0`] returns `m_fl2gv` column for type 1/2, zero vector otherwise. Note it's called **3 times** per light (once per component) — a cheap hook win.

### 2h. Final D3D submission
```c
void Render::enable_active_lights()   // A 0x0054C080 | map 0x0014BC90 -> 0x0054CC90
{
  for (slot = 0; slot < 8; ++slot) {                      // curLightUsage[8], stride 12
    lightClass = curLightUsage[slot].lightClass;
    if (lightClass == -1)                    SetFFLightEnable(render_device, slot, 0);
    else if (lightCacheing && carryOver)     SetFFLightEnable(render_device, slot, 1);   // already resident
    else if (doDynamic && lightClass == 2) {
        d3ddev->lpVtbl[51](d3ddev, slot, world_lights.sorted_dynamic_lights[idx]);       // SetLight
        SetFFLightEnable(render_device, slot, 1); }
    else if (doStatic  && lightClass == 1) {
        d3ddev->lpVtbl[51](d3ddev, slot, world_lights.sorted_static_lights[idx]);
        SetFFLightEnable(render_device, slot, 1); }
    else if (doSun && lightClass == 0) {
        d3ddev->lpVtbl[51](d3ddev, slot, &world_lights.m_Sunlight);
        SetFFLightEnable(render_device, slot, 1); }
  }
}
```
vtable index 51 = `IDirect3DDevice9::SetLight`. Note the `RenderLight*` is passed directly as the `D3DLIGHT9*` — works because `d3dLight` is at offset 0.

```c
void RenderDeviceD3D::SetFFLightEnable(this, uint _Index, bool _bValue)  // A 0x005A3120 | map 0x001A3230 -> 0x005A4230
  if (m_bForceStates || m_State.FFLightEnable[_Index] != _bValue) {
      m_pDirect3DDevice->lpVtbl[53](dev, _Index, _bValue);   // LightEnable
      m_State.FFLightEnable[_Index] = _bValue; }

void RenderDeviceD3D::SetFFLighting(this, bool)                          // A 0x005A30E0 | map 0x001A31F0 -> 0x005A41F0
  -> SetRenderState(D3DRS_LIGHTING=137, bValue)
void RenderDeviceD3D::SetFFAmbientColor32(this, uint)                    // A 0x005A2DA0 | map 0x001A2EB0 -> 0x005A3EB0
  -> SetRenderState(D3DRS_AMBIENT=139, value)
```

### Call graph summary
```
DAT Setup.Lights[] ──CSetup::UnPack──▶ CSetup::lights (LIGHTINFO[])
                                            │
CPhysicsObj state|0x800 / SetLightHook ─────┤
  ├─ CPhysicsObj::set_lights / set_state
  └─ CPartArray::InitLights ──▶ LIGHTLIST(LIGHTOBJ[]) ──▶ CObjCell::add_light ──▶ CObjCell::light_list
                                                                                       │
                        ┌──────────────────────────────────────────────────────────────┘
   cell change ─────────┤ CObjCell::add_static_to_global_lights  ──▶ Render::add_static_light  ─┐
   SmartBox::set_viewer ┤ CEnvCell/CObjCell::add_dynamic_lights  ──▶ Render::add_dynamic_light ─┤
   SmartBox::set_viewer └ viewer_light (player glow)            ──▶ Render::add_dynamic_light ─┤
                                                                                                │
                                             Render::insert_light (dist² sort + cap) ◀──────────┘
                                                       │ Frame::combine, 8-bit color round-trip
                                                       ▼
                                        PrimD3DRender::config_hardware_light  ──▶ RenderLight.d3dLight
                                                       │
   Render::update_viewpoint ──▶ Render::m_pRenderer->vfptr[10] UpdateLightsInternal
                                   ├─ SetFFAmbientColor32 (D3DRS_AMBIENT)
                                   └─ per light: Position::localtolocal → viewerspace_location → d3dLight.Position
                                                       │
   RenderDeviceD3D::DrawMeshInternal ──▶ Render::minimize_object_lighting  ─┐
   RenderDeviceD3D::DrawEnvCell      ──▶ Render::minimize_envcell_lighting ─┤
                                                                            ▼
                                   Render::reset_active_lights_state / add_active_light (8 slots)
                                                       │
                                          Render::enable_active_lights
                                                       ├─ IDirect3DDevice9::SetLight(slot, RenderLight*)
                                                       └─ SetFFLightEnable(slot, TRUE)
```

---

## 3. Per-draw light budget & selection

**Hard limits, three tiers:**

| Limit | Value | Where |
|---|---|---|
| Static pool | `RenderLight static_lights[60]` | compile-time array in `LightParms` |
| Dynamic pool | `RenderLight dynamic_lights[10]` | compile-time array in `LightParms` |
| Static in use | `Render::max_static_lights` = **40** default (range 40..60 / 40..8-ish) | mutable `int` global |
| Dynamic in use | `Render::max_dynamic_lights` = **7** default (range 7..10 / 7..4) | mutable `int` global |
| **Enabled per draw call** | **8** — hardcoded `if (v0 >= 8)` + 8-entry `HWLightUsage` table | `Render::minimize_object_lighting` |

```c
int Render::SetDegradeLevelInternal(float new_deg_mul)   // A 0x0054C3C0 | map 0x0014BFD0 -> 0x0054CFD0
{
  Render::deg_mul = new_deg_mul;
  if (new_deg_mul >= 0) {  // "quality up"
    max_static_lights  = (int)(new_deg_mul * 20.0 + 40.0);     // 40 -> 60 at mul=1
    max_dynamic_lights = (int)(new_deg_mul *  2.0 +  7.0);     //  7 ->  9 at mul=1
    object_distance_2dsq = (17*mul + 25)²;  particle_distance_2dsq = (8*mul + 16)²;
  } else {                 // "quality down"
    max_static_lights  = (int)(40.0 + new_deg_mul * 20.0);
    max_dynamic_lights = (int)( 7.0 + new_deg_mul *  3.0);
    ...
  }
}
```

### Per-object nearest-light selection
```c
void Render::minimize_object_lighting()   // A 0x0054D480 | map 0x0014D090 -> 0x0054E090
{
  v0 = 0;                                  // slots consumed
  Render::reset_active_lights_state();     // shift cur->prev, clear cur (8 x {carryOver, class=-1, index=-1})

  for (i = 0; i < world_lights.num_dynamic_lights; ++i) {
    if (v0 >= 8 || Render::remove_object_light(&sorted_dynamic_lights[i]->info))
         dynamic_light_used[i] = 0;
    else { dynamic_light_used[i] = 1; Render::add_active_light(i, LightClass::DYNAMIC); ++v0; }
  }
  for (j = 0; j < world_lights.num_static_lights; ++j) {
    if (v0 < 8 && ( sorted_static_lights[j]->info.type            // non-point always passes
                 || |vs_loc - Render::local_object_center| <= sorted_static_lights[j]->info.falloff
                                                                 + Render::local_object_radius ))
         { static_light_used[j] = 1; Render::add_active_light(j, LightClass::STATIC); ++v0; }
    else   static_light_used[j] = 0;
  }
  Render::enable_active_lights();
}

int Render::remove_object_light(LIGHTINFO *li)   // A 0x0054C1B0 | map 0x0014BDC0 -> 0x0054CDC0
{ // returns 1 (=cull) iff POINT light and |li->viewerspace_location - local_object_center|
  //                                        > li->falloff + local_object_radius
}
```
Selection is **sphere-overlap rejection**, not true nearest-N — but because `sorted_*_lights` are already distance-sorted by `insert_light`, first-8-that-overlap ≈ nearest 8. **Dynamics always win over statics** (dynamics are iterated first and consume slots first).

Note the bug: the dynamic loop calls `remove_object_light` for *all* light types (it internally no-ops for non-POINT), but the static loop inlines the same test with the type check hoisted — behaviourally equivalent, structurally different.

`Render::local_object_center` / `local_object_radius` are set by `Render::viewconeCheck(CSphere*)` [A `0x0054C250`] from the object's bounding sphere, in viewer-local space.

### Call sites
```c
signed int RenderDeviceD3D::DrawMeshInternal(CGfxObj*, bool i_bBuilding, BoundingType)
// A 0x0059F360 | map 0x0019F470 -> 0x005A0470
{ ...
  if (!Render::useSunlight)  Render::minimize_object_lighting();     // <-- PER OBJECT
  ... }

void RenderDeviceD3D::DrawEnvCell(CEnvCell *cell)
// A 0x0059F170 | map 0x0019F280 -> 0x005A0280
{ if (!CEnvCell::GetDrawnThisFrame(cell)) { ... 
    if (!skipMinimStep)  Render::minimize_envcell_lighting();        // <-- PER ENVCELL
    ... } }

void Render::minimize_envcell_lighting()  // A 0x0054C170 | map 0x0014BD80 -> 0x0054CD80
{ reset_active_lights_state();
  memset32(dynamic_light_used, 1, num_dynamic_lights);
  for (i=0;i<num_dynamic_lights;++i) add_active_light(i, 2);   // ALL dynamics, no 8-cap check!
  enable_active_lights(); }                                     // (add_active_light silently drops past 8)
```

### Slot allocator (`carryOver` caching)
```c
void Render::add_active_light(int index, int lightClass)  // A 0x0054BFB0 | map 0x0014BBC0 -> 0x0054CBC0
  // 1. scan prevLightUsage[8] for a matching (lightClass,index) -> reuse that SLOT, set carryOver=1
  //    (skips the SetLight call entirely next frame when lightCacheing != 0)
  // 2. if the slot was already claimed this frame, relocate the incumbent to a free slot
  // 3. else find first free slot in curLightUsage[8]; if none free -> SILENTLY DROP
void Render::reset_active_lights_state()  // A 0x0054BE00 | map 0x0014BA10 -> 0x0054CA10
  // memcpy curLightUsage[8] -> prevLightUsage[8], then reset cur to {carryOver:0, class:-1, index:-1}
void Render::restore_all_lighting()       // A 0x0054C220 | map 0x0014BE30 -> 0x0054CE30
void Render::useSunlightSet(int)          // A 0x0054D450 | map 0x0014D060 -> 0x0054E060
  // set Render::useSunlight; if on: reset state, add_active_light(-1, SUNLIGHT), enable — SUN ONLY,
  // which is why outdoor terrain gets 1 light and minimize_object_lighting is skipped.
```

---

## 4. Dynamic lights at runtime (spells / torches / player glow)

**1. Player/viewer glow** — `viewer_light`, a static `LIGHTINFO` global, re-added every `SmartBox::set_viewer`:
```c
LIGHTINFO viewer_light = { 0 /*POINT*/, identity Frame, {0,0,0}, {0,0,0}, 0.0f, 0.0f, 0.0f };
// A: viewer_light @ 0x00818680 ; intensity @ 0x008186DC ; falloff @ 0x008186E0
// driven by:  SmartBox::s_fViewerLightIntensity @ 0x0083CC10
//             SmartBox::s_fViewerLightFalloff   @ 0x00818610
// position forced to {0,0,2.0} above the player when type is POINT or SPOT
```
Ships at intensity/falloff 0 (invisible). **Setting those two floats non-zero instantly gives the player a real headlamp** with zero code — the cheapest possible "add a light" for a plugin.

**2. Object lights** — `PhysicsState 0x800` (LIGHTS_ON) toggled by:
- server `set_state` packets → `CPhysicsObj::set_state`
- animation frames → `SetLightHook` (`AnimationHookType::SetLight = 25`) → `SetLightHook::Execute` → `CPhysicsObj::set_lights`
- `PhysicsScript` / `PhysicsScriptTable` entries carrying `SetLightHook`

**3. `CPhysicsObj` has no `LIGHTINFO` members.** Its light state is exactly `state & 0x800` + `part_array->lights` (`LIGHTLIST*` at `CPartArray+0x2C`):
```c
struct __cppobj CPartArray {
  uint pa_state; CPhysicsObj *owner; CSequence sequence; MotionTableManager *motion_table_manager;
  CSetup *setup; uint num_parts; CPhysicsPart **parts; Vector3 scale; Palette **pals;
  LIGHTLIST *lights;                 // <-- the object's live lights
  AnimFrame *last_animframe; };
```
The *other* "lighting" API on physics objects is **surface tinting, not lights**:
`CPhysicsObj::SetLighting(float,float)` / `SetPartLighting` / `RestoreLighting` → `CPartArray::SetLightingInternal` → `CPhysicsPart::SetLighting(diffuse, luminosity)` which writes `curDiffuse`/`curLuminosity` on `CPhysicsPart` (→ D3D material Emissive). Same for `UIElement_SmartBoxWrapper::ApplyLighting(uint, LightingMode{LM_RESTORE/LOW/HIGH})`. Don't confuse these with FF lights.

**4. Programmatic light creation reference** — `CreatureMode::AddLight` [A `0x004555B0` | map `0x00054650` → `0x00455650`] is the cleanest in-client example:
```c
void CreatureMode::AddLight(CreatureMode *this, LIGHTINFO::LightType _lightType, float _intensity)
{
  v4 = operator new(0x68u);                 // sizeof(LIGHTINFO)
  Frame identity at v4+4;  Frame::cache((Frame*)(v4+4));   // <-- MANDATORY
  *(int*)v4 = _lightType;
  _direction = {1,1,1};  LIGHTINFO::SetDirection((LIGHTINFO*)v4, &_direction);
  *((float*)v4 + 23) = _intensity;                       // +0x5C intensity
  RGBColor::SetColor32((RGBColor*)(v4+80), 0xFFFFFFFF);  // +0x50 color = white
  *((DWORD*)v4 + 24) = 0x7F7FFFFF;                       // +0x60 falloff  = FLT_MAX
  *((DWORD*)v4 + 25) = 0x43B40000;                       // +0x64 cone_angle = 360.0f
  SmartArray_push(&this->creature_mode_lights, v4);
}
// consumed in CreatureMode::Render [A 0x004529D0]:
//   for (j..) Render::add_static_light(creature_mode_lights.m_data[j], 0, &identityFrame);
```
Also `UIElement_Viewport::SetLight(LightType, float, const Vector3&)` [map `0x0006AE40` → `0x0046BE40`] and `CreatureMode::SetLightDirection` [map `0x00053560` → `0x00454560`].

**5. Spell effects / particles do NOT create FF lights.** Particle emitters (`ParticleEmitterInfo`) are unlit sprites; `GfxVelocityDesc`/`GfxObjInfo` have no light fields. Only `SetLightHook` on a script/animation, or a Setup with `num_lights`, produces a light. That's the gap a plugin fills.

---

## 5. Ambient light

`m_GState.AmbientLight` (`RGBAColor` in `RenderDevice::GraphicsStatesType`) is **not** the FF ambient path. The live value is `Render::world_lights.ambient_color`, uploaded via `SetFFAmbientColor32` → `D3DRS_AMBIENT`.

**Setter (single funnel):**
```c
void SmartBox::SetWorldAmbientLight(SmartBox *this, float intensity, unsigned color)
// A 0x004530A0 | map 0x000520E0 -> 0x004530E0
{
  this->game_ambient_level = intensity;
  this->game_ambient_color = color;
  if (!this->creature_mode) {
     RGBColor::SetColor32(&rgb, color);
     rgb.r = rgb.r * intensity;                     // <-- BUG: only .r scaled by intensity, not .g/.b
     Render::world_lights.ambient_color = rgb;
  }
}
```
(That `rgb.r * intensity` with `.g`/`.b` untouched is a genuine retail bug — ambient goes red-biased as intensity rises. Worth patching.)

**Outdoor / day-night cycle:**
```c
LScape::tick_lighting-ish (acclient.c:307250, inside LScape update)
  every  CRegionDesc::current_region->sky_info->light_tick_size  seconds (default 3.0):
    t = GameTime::current_game_time->present_time_of_day;
    CRegionDesc::GetLighting(t, &ambient_level, &ambient_color, &sunlight_vec, &sunlight_color)
      // A 0x004FE9C0 | map 0x000FE440 -> 0x004FF440   -> delegates to
    SkyDesc::GetLighting(...)         // A 0x00500A80 | map 0x00100600 -> 0x00501600
    clamp: if (ambient_level < LScape::min_ambient) ambient_level = min_ambient;
    apply LScape::m_override_* blend (m_override_transition += 0.04/tick)
    LScape::set_landscape_lighting(lscape, ambient_level, color, &sunlight_vec, sunlight_color);

void LScape::set_landscape_lighting(LScape*, float _ambient_level, RGBAUnion _ambient_color,
                                    Vector3 *_sunlight, RGBAUnion _sunlight_color)
// A 0x00505... (acclient.c:307003) | map 0x001044D0 -> 0x005054D0
{
  LScape::ambient_level = _ambient_level;  LScape::ambient_color = _ambient_color;
  if (LScape::m_fAlwaysDaylight) { CRegionDesc::GetLighting(0.5, ...); clamp to min_ambient; }
  else { LScape::sunlight = *_sunlight; LScape::sunlight_color = _sunlight_color; }

  Render::world_lights.sunlight       = LScape::sunlight;
  Render::world_lights.sunlight_color = RGBColor(LScape::sunlight_color);
  Render::world_lights.m_bSunlightValid = 0;                     // forces UpdateLightsInternal rebuild

  intensity = |LScape::sunlight| * 0.2 + LScape::ambient_level;  // == LScape::calc_object_light()
  SmartBox::SetWorldAmbientLight(SmartBox::smartbox, intensity, LScape::ambient_color.color);

  for each land_block: CLandBlockStruct::calc_lighting(&lb->vertex_lighting);  // bakes terrain vertex colors
}

float LScape::calc_object_light()   // A 0x00455730 | map 0x00054850 -> 0x00455850
{ return sqrt(sunlight·sunlight) * 0.2 + LScape::ambient_level; }
```

**Dungeon (indoor) ambient** — from `CellManager` cell-change (acclient.c:146690):
```c
if (indoor || curr_cell->seen_outside) {
   Render::world_lights.sunlight = LScape::sunlight;  ...  m_bSunlightValid = 0;
   SmartBox::SetWorldAmbientLight(smartbox, LScape::calc_object_light(), LScape::ambient_color.color);
} else {
   SmartBox::SetWorldAmbientLight(smartbox, 0.2f, 0xFFFFFFFF);   // <-- FLAT DUNGEON AMBIENT
}
```
**`0.2f / 0xFFFFFFFF` is the hardcoded dungeon ambient.** Single most impactful constant for "dungeons are too flat/too bright".

**Global ambient multiplier:** `ambientBoostFactor` (default `1.0f`), applied in `UpdateLightsInternal`.

`CreatureMode::Render` [A `0x004529D0`] overrides with `CreatureMode::m_clrAmbientLight` for the paperdoll/char-gen viewport, and brackets with `useSunlightSet(1); num_static=num_dynamic=0; useSunlightSet(0);`.

---

## 6. Global on/off switches & limits worth patching

| Symbol | Build-A addr | Type / default | Effect |
|---|---|---|---|
| `Render::max_static_lights` | `0x0081EC94` | `int` = **40** | pool cap; **hard array bound 60** |
| `Render::max_dynamic_lights` | `0x0081EC98` | `int` = **7** | pool cap; **hard array bound 10** |
| `doSun` | `0x0081EFCC` | `int` = 1 | master enable, sun/directional |
| `doStatic` | `0x0081EFD0` | `int` = 1 | master enable, static lights |
| `doDynamic` | `0x0081EFD4` | `int` = 1 | master enable, dynamic lights |
| `lightCacheing` | `0x0081EFD8` | `int` = 1 | `carryOver` slot reuse; **set 0 to force a `SetLight` every frame** (needed if you mutate `RenderLight` in place) |
| `rangeAdjust` | `0x00820CC4` | `float` = **1.5** | `D3DLIGHT9.Range = falloff * rangeAdjust` — global light-reach multiplier |
| `ambientBoostFactor` | `0x00820CC8` | `float` = **1.0** | global ambient multiplier |
| `skipMinimStep` | `0x008ED52C` | `int` | skips `minimize_envcell_lighting` in `DrawEnvCell` |
| `Render::useSunlight` | `0x00866334` | `int` | when 1, `DrawMeshInternal` **skips** per-object selection (sun-only outdoor path) |
| `Render::deg_mul` | `0x0086630C` | `float` | quality slider input to `SetDegradeLevelInternal` |
| `LScape::min_ambient` | `0x0084194C` | `float` | ambient floor |
| `LScape::m_fAlwaysDaylight` | `0x00841798` | `bool` | forces `GetLighting(0.5)` |
| `LScape::m_override_ambient_level` / `_color` / `_transition` | `0x0084179C` / `0x00841778` / — | | scripted ambient override + blend |
| `SmartBox::s_fViewerLightIntensity` | `0x0083CC10` | `float` = 0 | **player headlamp intensity** |
| `SmartBox::s_fViewerLightFalloff` | `0x00818610` | `float` = 0 | **player headlamp radius** |

**Other key data (build A):**
| Symbol | Addr |
|---|---|
| `Render::world_lights` (`LightParms`) | **`0x008672A0`** |
| `Render::viewer_lights` (`LightParms`, only `sunlight_color` used, in `D3DPolyRender` diffuse calc) | `0x0086B228` |
| `Render::curLightUsage` (`HWLightUsage[8]`) | **`0x00846058`** |
| `Render::prevLightUsage` (`HWLightUsage[8]`) | `0x00866268` |
| `Render::static_light_used` (`int[60]`) | `0x008460C8` |
| `Render::dynamic_light_used` (`int[10]`) | `0x00866238` |
| `Render::local_object_center` (`Vector3`) | `0x0086B114` |
| `Render::local_object_radius` (`float`) | `0x00866260` |
| `viewer_light` (`LIGHTINFO`) | **`0x00818680`** |
| `Render::m_pRenderer` (`Render*`) | `0x0086633C` |
| `RenderDevice::render_device` | `0x0086F330` |
| `SmartBox::smartbox` | `0x0083CA58` |
| `LScape::sunlight` (`Vector3`) | `0x00841940` |
| `LScape::sunlight_color` (`RGBAUnion`) | `0x00841768` |
| `LScape::ambient_color` (`RGBAUnion`) | `0x0084176C` |
| `LScape::ambient_level` (`float`) | `0x00841770` |

**There is no `MAX_LIGHTS` named constant.** The 8-light per-draw ceiling exists in exactly two places: the immediate `8` in `Render::minimize_object_lighting` (`if (v0 >= 8 || ...)`), and the loop bounds over the 8-entry `curLightUsage`/`prevLightUsage` tables (stride-12, terminated by comparing against the address of the next global). Raising it requires **relocating both `HWLightUsage` arrays** to plugin-owned memory and repatching the bound comparisons in `reset_active_lights_state`, `add_active_light`, and `enable_active_lights` — see §7(c).

**`RenderPrefs`** (`Render::m_RenderPrefs` @ `0x0081EF90`) has **no light-count field**: `TextureFiltering, LandscapeDetailTextures, EnvironmentDetailTextures, MultiPassAlpha, LandscapeTextureDetail, EnvironmentTextureDetail, SceneryDrawDistance, LandscapeDrawDistance, AspectRatio, DisplayAdapter, MaxHardwareClass, ScreenBrightness, FieldOfView, ModelDetail`. Light budget rides on `ModelDetail` → `deg_mul` → `SetDegradeLevelInternal`.

Also: FF lighting is toggled per-surface by `override_light_state` in `D3DPolyRender::SetSurface`-adjacent code (acclient.c:454684, :455350) and by `MGStates.WantFFLighting = (Layer->m_Options & 2)` in the multi-pass material system (acclient.c:458547). A surface with lighting overridden renders unlit regardless of your lights.

---

## 7. Best hook points for a plugin

### Address table (map build = Chorizite target; runtime VA = map RVA + 0x401000)

| Symbol | map RVA | **runtime VA** | build-A VA |
|---|---|---|---|
| `Render::insert_light` | `0014CDC0` | **`0054DDC0`** | `0054D1B0` |
| `Render::add_static_light` | `0014CFF0` | **`0054DFF0`** | `0054D3E0` |
| `Render::add_dynamic_light` | `0014D030` | **`0054E030`** | `0054D420` |
| `Render::minimize_object_lighting` | `0014D090` | **`0054E090`** | `0054D480` |
| `Render::minimize_envcell_lighting` | `0014BD80` | **`0054CD80`** | `0054C170` |
| `Render::remove_object_light` | `0014BDC0` | **`0054CDC0`** | `0054C1B0` |
| `Render::add_active_light` | `0014BBC0` | **`0054CBC0`** | `0054BFB0` |
| `Render::enable_active_lights` | `0014BC90` | **`0054CC90`** | `0054C080` |
| `Render::reset_active_lights_state` | `0014BA10` | **`0054CA10`** | `0054BE00` |
| `Render::restore_all_lighting` | `0014BE30` | **`0054CE30`** | `0054C220` |
| `Render::useSunlightSet` | `0014D060` | **`0054E060`** | `0054D450` |
| `Render::SetDegradeLevelInternal` | `0014BFD0` | **`0054CFD0`** | `0054C3C0` |
| `Render::update_viewpoint(Position const&)` | `0014C9E0` | **`0054D9E0`** | (acclient.c:380352) |
| `Render::update_viewpoint(Frame const&)` | `0014D830` | **`0054E830`** | `0054DC20` |
| `PrimD3DRender::UpdateLightsInternal` | `0019AEE0` | **`0059BEE0`** | `0059AED0` |
| `PrimD3DRender::config_hardware_light` | `0019AD40` | **`0059BD40`** | `0059AD30` |
| `PrimD3DRender::InitializeLights` | `0019AC00` | **`0059BC00`** | `0059ABF0` |
| `RenderDeviceD3D::SetFFLighting` | `001A31F0` | **`005A41F0`** | `005A30E0` |
| `RenderDeviceD3D::SetFFLightEnable` | `001A3230` | **`005A4230`** | `005A3120` |
| `RenderDeviceD3D::SetFFAmbientColor32` | `001A2EB0` | **`005A3EB0`** | `005A2DA0` |
| `RenderDeviceD3D::DrawMeshInternal` | `0019F470` | **`005A0470`** | `0059F360` |
| `RenderDeviceD3D::DrawEnvCell` | `0019F280` | **`005A0280`** | `0059F170` |
| `LIGHTINFO::GetDirection` | `0019ABA0` | **`0059BBA0`** | `0059AB90` |
| `LIGHTINFO::SetDirection` | `00051740` | **`00452740`** | `00452740` |
| `LIGHTINFO::convert_to_local` | `0019C420` | **`0059D420`** | `0059C3D0` |
| `LightParms::LightParms` | `0014D3B0` | **`0054E3B0`** | `0054D... ` |
| `RenderLight::RenderLight` | `0014C6D0` | **`0054D6D0`** | — |
| `LIGHTLIST::LIGHTLIST(uint)` | `00118170` | **`00519170`** | `00518... ` |
| `LIGHTLIST::set_frame` | `00117790` | **`00518790`** | — |
| `CObjCell::add_light` | `0012ADE0` | **`0052BDE0`** | `0052B1D0` |
| `CObjCell::remove_light` | `0012AE20` | **`0052BE20`** | `0052B210` |
| `CObjCell::add_static_to_global_lights` | `0012AF60` | **`0052BF60`** | `0052B350` |
| `CObjCell::add_dynamic_to_global_lights` | `0012AFA0` | **`0052BFA0`** | `0052B390` |
| `CObjCell::add_lights` | `0012B560` | **`0052C560`** | `0052B950` |
| `CObjCell::add_dynamic_lights` (static) | `0012A990` | **`0052B990`** | `0052AD80` |
| `CEnvCell::add_dynamic_lights` (static) | `0012D070` | **`0052E070`** | `0052D410` |
| `CPartArray::InitLights` | `00118730` | **`00519730`** | `00518C00` |
| `CPartArray::DestroyLights` | `00118CE0` | **`00519CE0`** | `005191B0` |
| `CPartArray::AddLightsToCell` | `001179D0` | **`005189D0`** | `00517EA0` |
| `CPartArray::RemoveLightsFromCell` | `00117A20` | **`00518A20`** | `00517EF0` |
| `CPhysicsObj::set_lights` | `0010F7C0` | **`005107C0`** | `0050FCF0` |
| `CPhysicsObj::set_state` | `001148D0` | **`005158D0`** | `00514DD0` |
| `SetLightHook::Execute` | `00126BD0` | **`00527BD0`** | `00526FD0` |
| `SmartBox::set_viewer` | `00051C80` | **`00452C80`** | `00452C40` |
| `SmartBox::SetWorldAmbientLight` | `000520E0` | **`004530E0`** | `004530A0` |
| `LScape::set_landscape_lighting` | `001044D0` | **`005054D0`** | (acclient.c:307003) |
| `LScape::calc_object_light` | `00054850` | **`00455850`** | `00455730` |
| `CLandBlockStruct::calc_lighting` | `00131440` | **`00532440`** | `00531700` |
| `CRegionDesc::GetLighting` | `000FE440` | **`004FF440`** | `004FE9C0` |
| `SkyDesc::GetLighting` | `00100600` | **`00501600`** | `00500A80` |
| `CreatureMode::AddLight` | `00054650` | **`00455650`** | `004555B0` |
| `UIElement_Viewport::SetLight` | `0006AE40` | **`0046BE40`** | `0046B590` |
| `calc_point_light` | `0019C900` | **`0059D900`** | `0059C8B0` |
| `D3DPolyRender::SetStaticLightingVertexColors` | `0019D0F0` | **`0059E0F0`** | `0059CFE0` |
| `CPhysicsObj::SetLighting` (surface tint, not FF) | `00111550` | **`00512550`** | `00510A80` |

**Re-deriving data addresses on the map build:** don't hardcode build-A data addresses. `Render::add_static_light` and `Render::add_dynamic_light` are 3-instruction thunks that push four absolute addresses as immediates — read the operands at `0x0054DFF0` / `0x0054E030` to recover `&Render::max_static_lights`, `&world_lights.num_static_lights` (= `world_lights + 0x104`), `world_lights.static_lights` (= `+0x108`), `world_lights.sorted_static_lights` (= `+0x34B8`). One read yields the whole `LightParms` base. Likewise `Render::enable_active_lights` at `0x0054CC90` references `curLightUsage`, `doSun/doStatic/doDynamic/lightCacheing`, and `RenderDevice::render_device`; `config_hardware_light` at `0x0059BD40` references `rangeAdjust`.

---

### (a) Enumerate all active lights

**No hook needed — pure reads.** Once `Render::world_lights` is located:
```
world_lights + 0x104           int      num_static_lights
world_lights + 0x34B8 + 4*i    RenderLight*  sorted_static_lights[i]   (distance-sorted)
world_lights + 0x35A8          int      num_dynamic_lights
world_lights + 0x3E44 + 4*i    RenderLight*  sorted_dynamic_lights[i]
world_lights + 0x028           RenderLight   m_Sunlight
world_lights + 0x000/0x00C/0x018/0x024   ambient_color / sunlight_color / sunlight / m_bSunlightValid
```
Per `RenderLight`: `+0x00` live `D3DLIGHT9` (view space, Y/Z swapped), `+0x6C` `cellID`, `+0x70` `LIGHTINFO` (world space), `+0xD8` `distancesq`.

For *which* lights are live on the current draw: `Render::curLightUsage[8]` (`{bool carryOver; int lightClass; int index;}`) plus `static_light_used[60]` / `dynamic_light_used[10]`.

For cell-resident (pre-pool) enumeration: walk `CObjCell::light_list` (`DArray<LIGHTOBJ const*>` at `CObjCell` + `num_lights`), or `CPartArray::lights` (`LIGHTLIST*` at `+0x2C`) per physics object.

**Best passive hooks:**
- **`PrimD3DRender::UpdateLightsInternal` @ `0x0059BEE0`** — post-hook: pool is final and view-space positions are fresh. Also reachable virtually via `Render::m_pRenderer->vfptr[10]` (`RenderVtbl` offset `0x28`) — safest, no code patch.
- **`Render::enable_active_lights` @ `0x0054CC90`** — post-hook: exact per-draw slot assignment.
- **`Render::insert_light` @ `0x0054DDC0`** — pre-hook: see every light *and* every light that gets dropped for exceeding the cap.

### (b) Add your own lights

Four options, cheapest first:

1. **Player headlamp (zero code):** write `SmartBox::s_fViewerLightIntensity` and `s_fViewerLightFalloff`, and optionally `viewer_light.color` / `.type`. Re-applied automatically by `SmartBox::set_viewer` every frame. Note `set_viewer` overwrites intensity/falloff each frame *from* those two globals — so patch the globals, not `viewer_light` directly.

2. **Post-hook `SmartBox::set_viewer` @ `0x00452C80`** (**recommended for world lights**). It runs after `num_dynamic_lights = 0` and after `CObjCell::add_dynamic_lights()`, so a trailing call to `Render::add_dynamic_light(&myLightInfo, cellId, &frame)` per plugin light survives exactly one frame and re-adds cleanly. Correct lifetime, correct sort order, no leaks. Combine with raising `Render::max_dynamic_lights`.

3. **Post-hook `CObjCell::add_static_to_global_lights` @ `0x0052BF60`** for lights bound to a specific cell (persist until cell change), or `CObjCell::add_light` @ `0x0052BDE0` to inject a `LIGHTOBJ` into a cell's `light_list` permanently (mirrors what `CPartArray::InitLights` does — you own the `LIGHTINFO` + `LIGHTOBJ` allocations).

4. **Turn on an existing DAT object's lights:** call `CPhysicsObj::set_lights(obj, 1, 0)` @ `0x005107C0`, or set `PhysicsState |= 0x800` via `set_state`. Instantly lights every unlit wall torch whose Setup has `num_lights`.

**Constructing a `LIGHTINFO` correctly:**
```c
LIGHTINFO li;                       // 104 bytes, must be stable memory (add_* stores a Frame::combine result,
                                    //  but CObjCell::add_light stores the POINTER — keep it alive)
li.type = 0;                        // POINT_LIGHT
li.offset = { qw=1, qx=qy=qz=0, m_fl2gv={0}, m_fOrigin = {x,y,z} };
Frame::cache(&li.offset);           // MANDATORY — fills m_fl2gv
li.viewerspace_location = {0,0,0};  // computed by UpdateLightsInternal
li.color = {r,g,b};                 // 0..1 floats; will be round-tripped through 8-bit
li.intensity = 1.0f;                // Diffuse = color * intensity (can exceed 1.0 for overbright)
li.falloff   = 10.0f;               // Range = falloff * rangeAdjust(1.5)
li.cone_angle= 360.0f;
Render::add_dynamic_light(&li, objcell_id, &worldFrame);
```
For SPOT: `type=2`, call `LIGHTINFO::SetDirection(&li, &dir)` @ `0x00452740` after `Frame::cache`, set `cone_angle` (Theta==Phi, so no soft edge unless you also patch `config_hardware_light`).

### (c) Raise the per-draw light limit

Three independent ceilings; lift in order:

**Tier 1 — pool caps (trivial, no code patch):**
Write `Render::max_static_lights` ≤ 60 and `Render::max_dynamic_lights` ≤ 10. **Do not exceed** — `static_lights[60]`/`dynamic_lights[10]` are fixed arrays inside `Render::world_lights` and `insert_light` will corrupt adjacent globals. Also re-hook `Render::SetDegradeLevelInternal` @ `0x0054CFD0` (post-hook) or it will stomp your values on any quality-slider change.

**Tier 1.5 — bigger pools:** allocate a replacement `LightParms` (`0x3E6C` bytes, or larger with wider arrays), run `LightParms::LightParms` @ `0x0054E3B0` on it, initialize the `sorted_*` pointer tables, then patch every absolute reference to `Render::world_lights` (they're all immediates in `add_static_light`, `add_dynamic_light`, `enable_active_lights`, `minimize_object_lighting`, `minimize_envcell_lighting`, `restore_all_lighting`, `UpdateLightsInternal`, `InitializeLights`) to point at yours.

**Tier 2 — the 8-slot hardware ceiling (the real limit).** Three things must change together:
1. **`Render::minimize_object_lighting` @ `0x0054E090`** — the immediate `8` in `if (v0 >= 8 || ...)`. Simplest: replace the whole function with your own selection routine (it has a clean `void()` cdecl signature and only touches `world_lights`, `local_object_center/radius`, `static_light_used`, `dynamic_light_used`, and the three `add_active_light`/`reset`/`enable` calls).
2. **`Render::curLightUsage` / `Render::prevLightUsage`** — both `HWLightUsage[8]`. Relocate to plugin memory and repatch the loop bounds. The bounds are encoded as **absolute addresses of the next global** (`&Render::ymin` = `0x8460BC`, `&Render::bh` = `0x8662D0`, `&Render::xmax` = `0x8460C0`) compared against a walking pointer — you must patch those immediates in `reset_active_lights_state` (`0x0054CA10`), `add_active_light` (`0x0054CBC0`), and `enable_active_lights` (`0x0054CC90`). `reset_active_lights_state` is fully unrolled (20 explicit dword copies), so a full function replacement is cleaner than immediate-patching.
3. **Check `RenderDeviceCaps::MaxActiveLights`** and `RenderDeviceD3D::m_State.FFLightEnable[]` array bounds before going past 8 — `SetFFLightEnable` indexes `m_State.FFLightEnable[_Index]` unchecked. Most D3D9 HW reports 8; some report `0xFFFFFFFF` (unlimited) under HW T&L, but SW vertex processing gives you as many as you want at CPU cost.

**Realistic alternative:** keep 8 slots and hook **`Render::minimize_object_lighting`** to implement a *better* 8-light choice (true nearest-by-intensity-weighted-distance rather than first-overlap, or importance ordering by `intensity/distancesq`). Usually a bigger visual win than raising the count.

**Also set `lightCacheing = 0`** whenever you mutate `RenderLight` contents in place — with caching on, `enable_active_lights` skips `IDirect3DDevice9::SetLight` for any slot whose `(lightClass,index)` matched last frame, and your edits never reach D3D.

### (d) Override attenuation / light math

**`PrimD3DRender::config_hardware_light` @ `0x0059BD40`** is the single choke point. Signature `int __cdecl (int light_index, _D3DLIGHT9 *out, unsigned cellID, LIGHTINFO *in)` — clean cdecl, easy detour. Post-hook and rewrite `out`:
- `Attenuation0/1/2` → e.g. `{1, 0, k}` for physically-plausible inverse-square (currently `{0, 1, 0}`, pure linear)
- `Range` (currently `falloff * rangeAdjust`)
- `Specular` (currently forced black — enabling it gives specular highlights from torches)
- `Ambient` (currently forced black — per-light ambient fill)
- `Theta` (currently `== Phi`, hard cone edge; set `Theta < Phi` for penumbra)
- `Diffuse.a` — never written, leaves stale data
- Fix the Y/Z axis swap if you're feeding your own world-space data

**Cheaper global knobs (no detour):** `rangeAdjust` (`0x00820CC4`) scales all light ranges; `ambientBoostFactor` (`0x00820CC8`) scales ambient.

**Ambient quality fixes:**
- Detour `SmartBox::SetWorldAmbientLight` @ `0x004530E0` to fix the `rgb.r * intensity` bug (should scale `.g`/`.b` too) and to override the hardcoded dungeon `0.2f / 0xFFFFFFFF`.
- Detour `PrimD3DRender::UpdateLightsInternal` @ `0x0059BEE0` (or `Render::m_pRenderer->vfptr[10]`) and call `RenderDeviceD3D::SetFFAmbientColor32` @ `0x005A3EB0` yourself to skip the double 8-bit quantization.

**Per-vertex static lighting (separate path):** `D3DPolyRender::SetStaticLightingVertexColors(MeshBuffer*, Position&)` @ `0x0059E0F0` and `calc_point_light(CUSTOM_D3D_VERTEX2*, float&r, float&g, float&b, const LIGHTINFO&)` @ `0x0059D900` bake light into vertex colors for envcell meshes (`MeshBuffer::burnedInStaticLights`). If you add static lights and envcells look unlit, this is why — it's a separate, CPU-side lighting path that must be invalidated/re-run.