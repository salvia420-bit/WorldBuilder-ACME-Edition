# Sky-I-A probe memo — 2026-05-11

Empirical findings for Workstream Sky-I-A. Drives the production fix in
Sky-I-B.

## Hypothesis under test

> "Sky-D stacks per-mesh sphere placement (`celestialPosition` * 900) on
> top of AC's pre-positioned vertex coords (sun verts at x∈[1844,1974]),
> putting the sun's world position at ~(2800, 1875, -900) — far beyond
> camera frustum."

**Status: PARTIALLY CONFIRMED, but the actual condition is far worse
than the hypothesis described.** The double-transform exists, but a
second compounding bug — `begin_angle`/`end_angle` treated as RADIANS
when the dat ships them as DEGREES — produces wildly out-of-range
headings (e.g. `heading=−7.65 rad ≈ −438°` for the sun at t=0.05) that
multiply against the 30× `CELESTIAL_BODY_SCALE` and the 1909-unit
mesh-native AABB center, sending the sun's worldCenter to
**(59124, 54269, −87511)** at the foredawn probe — **80,284 units from
camera, vs camera.far=5000 (16× past the far-clip plane)**.

## Source-code findings (Probe 1)

Six load-bearing questions, sourced from the vendored client-side
sources in `external/GDL/PhatSDK/` and the ACE server-side stub in
`external/ACE/Source/`. ACE doesn't render — `RegionDesc.cs:13` is just
a `SkyDesc SkyInfo` field — so all rendering semantics come from PhatSDK.

### Q1: Are sky-cell objects rendered in their own coordinate frame separate from world geometry?

**Yes** — confirmed structurally, with the caveat that the vendored
source's actual cell-frame usage for sky is UNFINISHED.

`external/GDL/PhatSDK/GameSky.h:32-34` declares two `CEnvCell` pointers
held as members of `GameSky`:

```cpp
SmartArray<CelestialPosition> sky_obj_pos; // 0x00
SmartArray<class CPhysicsObj *> sky_obj;   // 0x0C
SmartArray<DWORD> property_array;          // 0x18
class CEnvCell *before_sky_cell;           // 0x24
class CEnvCell *after_sky_cell;            // 0x28
```

`GameSky.cpp:8-9` constructs both as fresh empty cells (`new CEnvCell`).
`GameSky.cpp:68` (inside `MakeObject`) attaches the per-SkyObject
`CPhysicsObj` to one of these two cells via `AddObjectToSingleCell`.

Each `CEnvCell` inherits from `CObjCell` and has its own `Position pos`
member (`external/GDL/PhatSDK/ObjCell.h:92`) — `Position` carries a
`Frame` (origin + orientation) that the cell uses for `globaltolocal` /
`localtolocal` transforms (`external/GDL/PhatSDK/EnvCell.cpp:181, 377,
470, 487, 506`). So sky objects sit inside an EnvCell coordinate frame
that is structurally separate from the landblock world.

### Q2: Is the sky cell anchored at camera or at world origin?

**Not resolved in vendored source.** The two sky-cells are
default-constructed (`GameSky.cpp:8-9`). Their `pos.frame` is therefore
the zero Frame. The reference code that would re-anchor them per-frame
lives in `GameSky::UseTime()` (`GameSky.cpp:20-50`) which is wrapped in
`#if 0 // UNFINISHED` and additionally calls a `CalcDrawFrame(skydesc->m_DrawVec)`
method/member that does not exist on any of our parsed `SkyDesc`,
`SkyTimeOfDay`, or `SkyObject` structs (`external/GDL/PhatSDK/SkyDesc.h:42-94`).

The user's prior hypothesis — sky cell anchored at the camera (Garry's
Mod 3D-skybox pattern) — is plausible architecturally (cells are
relocatable; the cell-frame would slide with the player so celestials
never recede), but **the vendored source neither confirms nor refutes
it**. Documented as an open question for Sky-I-B; recommend continuing
with the camera-anchor design (user pick) because:

- It is the only design that explains the small pre-baked vertex AABBs
  (sun at x∈[1844,1974] = ~130×225×260 unit-sized mesh, sensible
  apparent-size at a 2km cell-radius).
- It is the only design that allows the cloud band's authored
  20,174-unit cylinder to remain inside the cell.
- It matches retail client behaviour where the player walks across the
  world without the sun receding.

### Q3: What axis is "up" in the sky cell?

**Not directly stated; inferred +Z from world consistency.**
`external/GDL/PhatSDK/LandDefs.cpp:223` stores `sky_height` as the
world's vertical cap (with `outside_val = sky_height + 1.0f`). The
world is +Z-up (`scene3d/index.js:75` rotates by `-π/2` around X to
land Z-up→Y-up for three.js). The cloud band's AABB `z∈[-400, 780]`
is roughly horizontal-plane symmetric, consistent with +Z being the
vertical axis the band sits on. **No source declaration; high
confidence by structural analogy.**

### Q4: Are `begin_angle / end_angle` rotation values (radians? degrees?), and around what axis?

**DEGREES, around the world Z (sky-cell up) axis.** This is THE
load-bearing finding.

Source evidence:
- `external/GDL/PhatSDK/SkyDesc.cpp:181-182` declares `begin_angle` and
  `end_angle` as raw `float` reads; the parser applies NO unit
  conversion. The PhatSDK fields are uncommented.
- `external/DatReaderWriter/DatReaderWriter/dats.xml:2825-2826` declares
  `<field name="BeginAngle" type="float"/>` and `<field name="EndAngle"
  type="float"/>` — also unitless.
- `external/holtburger/apps/holtburger-web/scene3d/sky_lighting.js:15-22`
  documents Sky-C's analogous calibration finding: "`dir_heading` +
  `dir_pitch` are DEGREES in the wire-from-DAT path (despite the
  wasm-side d.ts docstring claiming radians)." Sky-C converts via
  `* π / 180` before using.

Real wire data (verified via
`cargo test --release region_1_first_day_groups_sky_object_gfx_object_ids_have_gfx_obj_prefix
-- --nocapture` against retail `client_portal.dat`):

| SkyObject | begin_time | end_time | begin_angle | end_angle |
|---|---|---|---|---|
| sun `0x01001F67` | 0.04 | 0.21 | **-20** | **190** |
| moon `0x01001F6A` | 0 | 0.23 | **-20** | **190** |
| stars `0x01001348` | 0.16 | 0.94 | **-23** | **203** |
| base shells / cloud band / SetupModel | 0 | 0 | 0 | 0 |

`-20° → 190°` describes an east-west horizon arc starting just before
due east (-20° from north) and ending just after due west (190° from
north = ESE going clockwise) — a 210° sweep across the sky dome. In
**radians**, `lerp_angle_radians(-20, 190, p=0.058)` returns ≈ -7.65 —
which is the live `state.heading` we observed at t=0.05 (sun's window
opens at begin_time=0.04, so p=0.0588). That's a unit error.

This unit error is in
`external/holtburger/crates/holtburger-world/src/sky.rs::evaluate_sky_object`
lines 720-722, 742-744 — both code paths call `lerp_angle_radians(
sky_object.begin_angle, sky_object.end_angle, p)` without applying any
degrees→radians conversion. The downstream `SkyObjectSnapshot::heading`
is doc'd as "Heading on the sky dome (radians)"
(`sky.rs:217-219`) — that doc is right about the destination unit;
what's wrong is the input arithmetic.

**Rotation axis**: not stated in source. The PhatSDK
`CelestialPosition` struct (`GameSky.h:8-19`) carries separate
`heading` and `rotation` floats:

```cpp
class CelestialPosition {
public:
  DWORD gfx_id;
  DWORD pes_id;
  float heading;
  float rotation;
  Vector tex_velocity;
  ...
};
```

— `heading` (the visible-arc position) and `rotation` (a per-keyframe
spin) are separate. By analogy with Sky-C's directional-light path
(world XY plane measured from +Y north, CW), Sky-I-B should use AC-Z
as the rotation axis. **HIGH confidence by Sky-C analogy + structural
fit.**

### Q5: Are multiple visible SkyObjects each rotated independently, or do they share one cell rotation?

**Independently.** Each `SkyObject` carries its own
`begin_angle/end_angle/begin_time/end_time` per
`external/GDL/PhatSDK/SkyDesc.cpp:175-189`. The
`SmartArray<CelestialPosition>` in
`external/GDL/PhatSDK/GameSky.h:30` holds one entry per SkyObject in
the active DayGroup. Independent rotation is the only design
consistent with the sun/moon/stars having different begin/end_time
windows (sun visible 0.04-0.21, moon 0-0.23, stars 0.16-0.94).

### Q6: Is the rendering scale-preserving (no extra scale on the mesh) or does PhatSDK apply a sky-cell scale factor?

**Scale-preserving in PhatSDK.** No source-side reference to a
SkyDesc-level or sky-cell-level scale exists. The mesh AABBs are
authored at their final display size in the dat (sun ~225 units high
when an avatar is ~1.8 units tall — that's ~125× scaled, but
intentional: at a sky-cell-radius of ~2-3 km, a sun of ~225 units high
subtends ~5-7° of arc, matching AC retail's apparent solar disc
size).

The current `CELESTIAL_BODY_SCALE = 30.0` in `scene3d/sky_dome.js:89`
is an artefact of Sky-D's assumption that the meshes were authored
small-scale-centered (a few unit-radius primitives positioned via
sphere math). Real meshes are 1909-unit-pre-positioned 130-unit-sized.
Sky-I-B should remove this scale entirely (or set to 1.0).

## Live-scene findings (Probe 2)

`?skydebug=1` instrumentation added to
`apps/holtburger-web/scene3d/sky_dome.js`. Probe script:
`apps/holtburger-web/capture_skybox_probe_sky_i_a.cjs`. Single
Chromium spawn against the live ACE / wsbridge / web-proxy stack.
Four time-of-day overrides probed (t = 0.05, 0.50, 0.75, 0.00). Each
dump (one per probe) is in
`/mnt/wbterminal1/holtburger-captures/sky-i-a-probe/`.

### Camera + fog frustum

Consistent across all four probes (camera follows player; player
stationary post-/god):

```
camera.position = (32532.0, 96.8, -34561.4)   (three.js coords)
camera.fovDeg = 60
camera.near = 0.1
camera.far = 5000
fog.near = 0
fog.far = 400  (foredawn + midnight) ... 2400  (noon + afternoon)
```

`scene3d/index.js:121` constructs the perspective camera with
`far = 5000` (Phase 7.0 default). Fog far is the Sky-C-published
`fog_max` value lerped per keyframe.

### Headline number — sun world position at t=0.05 (foredawn)

```
nativeAabb (sun 0x01001F67):
  min = (1844.46, 1762.19, -130.00)
  max = (1974.46, 1987.36,  130.00)
  center = (1909.46, 1874.78,    0.00)

state (from getSkyObjectStates):
  heading = -7.647 rad   (= -438.1°)
  pitch   =  0.289 rad   (=  16.5°)

mesh transforms (Sky-D produces these):
  positionApplied = (31687.6, 353.0, -34738.6)
                  ≈ camera.position + 900 * (sin(h)*cos(p), sin(p), -cos(h)*cos(p))
  scaleApplied    = (30, 30, 30)
  worldMatrix.translation = (31687.6, 353.0, -34738.6)
  worldCenter = (59124.4, 54269.6, -87511.3)
  distanceFromCamera = 80284.2 units
```

Camera sees out to far=5000. Sun lands at distance=80284. Sun is
**16.06× past the camera far plane**. Even if fog.far were extended,
the camera frustum culls the sun entirely. The dome — at radius 1000,
draws as a back-side sphere centered at the camera — visually
occludes nothing because it has depthWrite=false + depthTest=false,
but the sun is so far outside the frustum it never enters the
fragment pipeline.

Moon at the same probe: distance=64192, **12.8× past far**.

### Headline numbers — all probes

Sun's world distance from camera (when sun is visible):
- t=0.05 (foredawn) — visible; **80,284 units** (16× past camera.far)
- t=0.50 (noon) — NOT visible (sun's window is 0.04..0.21; off after 0.21)
- t=0.75 (afternoon) — NOT visible
- t=0.00 (midnight) — NOT visible

Moon (visible 0..0.23):
- t=0.05 — visible; **64,192 units** (12.8× past camera.far)

Stars (visible 0.16..0.94):
- t=0.50 — visible at **31,513 units** (6.3× past far)
- t=0.75 — visible at **31,513 units**

Cloud band 0x01004C36 (always visible, properties bit 0x02 = scrolling
band per memory note `project_holtburger_skybox_properties_flags.md`):
- All four probes — **4,800 units** (consistent across probes, just past far=5000? actually below 5000 so frustum-visible — wait, 4800 < 5000 so it's IN frustum. Fog.far=2400 at noon will clip it though.)

Base shells `0x010015EE` / `0x010015EF`:
- Always at 7,350 / 14,862 units (past far).

SetupModel proxy `0x02000714`:
- Always at 900 units (inside frustum, but it's the 6.5cm physics
  anchor — invisible in practice; the per-state visibility flag
  evaluates true because begin==end==0 always-visible sentinel).

### Tally — which celestials are even within the view frustum?

| Object | camera.far=5000 | fog.far=400 (foredawn) | fog.far=2400 (noon) |
|---|---|---|---|
| sun (visible window) | NO — 80k | NO | n/a |
| moon (visible window) | NO — 64k | NO | n/a |
| stars (visible window) | NO — 32k | NO | NO |
| cloud band | YES — 4.8k | NO | NO |
| base shell 0x10015EE | NO — 7.3k | NO | NO |
| base shell 0x10015EF | NO — 14.9k | NO | NO |
| SetupModel proxy | YES — 900 | NO | YES (but 6cm mesh) |

**At no probe was any celestial body simultaneously inside camera.far
and not fully clipped by fog.** This fully explains the user's "they
don't visually appear" observation: the only mesh that's even close
enough to render (cloud band at 4800) is wrapped in 400-2400 unit fog
and rendered before it. The dome wraps the camera at radius 1000 with
depthTest=false and writes the horizon/zenith gradient — that's
literally everything the player sees.

### Cross-check: native AABBs match the Rust probe

Native AABBs read from each mesh's accumulated `geometry.boundingBox`
match the Sky-I-pre Rust probe's vertex-walk results EXACTLY:

| Object | Rust probe (sky_i_probe_sky_object_mesh_sizes) | JS probe (boundingBox) |
|---|---|---|
| sun 0x01001F67 | min (1844.46, 1762.19, -130) max (1974.46, 1987.36, 130) | identical |
| moon 0x01001F6A | min (1990.11, 288.29, -259) max (2143.53, 817.70, 259) | identical |

The asset pipeline (DAT → wasm → three.js BufferGeometry) is correct;
no spurious transform sneaks in between dat-parse and JS-render. The
problem is purely in Sky-D's render-time math.

## Confirmed architecture

1. **Sky-cell IS a separate coordinate frame** (PhatSDK
   `before_sky_cell`/`after_sky_cell` + their per-cell `Position pos`
   frames).
2. **Cell anchor** — **camera-anchored** is the only design consistent
   with the authored mesh sizes + cloud band's 20km cylinder. Source
   does not directly confirm; user pick stands.
3. **Up axis** — +Z in sky cell (matches AC world); celestial bodies
   live near the cell's XY-equator and pitch up.
4. **`begin_angle`/`end_angle` are DEGREES**, not radians. Rotation
   axis is AC's +Z (= sky-cell vertical).
5. **Per-SkyObject independent rotation** (each carries its own
   begin/end_time + begin/end_angle).
6. **No additional sky-cell scale** — meshes are authored at their
   display size. `CELESTIAL_BODY_SCALE` should be removed.

## Sky-I-B implementation recommendation

Three changes are minimally required. The user already picked all three
in the task brief; this section spells the implementation contract.

### (a) Refactor `getSkyObjectStates` to expose raw angle parameters

Replace cooked `heading`/`pitch` in `SkyObjectState` with raw
`beginAngleDeg`, `endAngleDeg`, `beginTime`, `endTime`, plus
`currentProgress` (a `[0,1]` lerp parameter for the visible window).
Keep `visible`, `gfxObjectId`, `transparent`, `luminosity`, `maxBright`,
`texOffsetX/Y`, `properties`.

Plumb these from `holtburger_world::SkyObjectSnapshot` — add the four
new fields beside the existing ones, write the raw values directly from
`SkyObject.begin_angle/end_angle/begin_time/end_time`. The Sky-D
renderer becomes the single owner of degrees→radians conversion + the
rotation-matrix construction. This avoids the mid-stream unit-conversion
question (`sky.rs::evaluate_sky_object` is the wrong place for the
deg→rad conversion because PhatSDK's authoritative
`CelestialPosition::heading` is itself in degrees — see Q4).

Pseudocode for the new state shape:

```rust
// crates/holtburger-world/src/sky.rs
pub struct SkyObjectSnapshot {
    pub gfx_object_id: u32,
    pub begin_angle_deg: f32,   // raw from dat
    pub end_angle_deg: f32,     // raw from dat
    pub begin_time: f32,        // raw from dat
    pub end_time: f32,          // raw from dat
    pub current_progress: f32,  // [0,1] lerp param across visible window
    pub tex_offset_x: f32,
    pub tex_offset_y: f32,
    pub transparent: f32,
    pub luminosity: f32,
    pub max_bright: f32,
    pub visible: bool,
    pub properties: u32,
}
```

`current_progress` math (mirrors today's `evaluate_sky_object`):
- always-visible (`begin == end`): `current_progress = 0.0`
- forward arc (`begin < end`): `(t - begin) / (end - begin)` when
  visible, else 0
- wrap-around (`end < begin`): `(t_anchor - begin) / span` with the
  `t < begin ? t + 1 : t` re-anchor

### (b) Camera-anchored sky cell (Garry's Mod 3D-skybox pattern)

In `sky_dome.js`, introduce a `this.skyCell = new THREE.Group()`
added under `scene` (not `worldRoot`) — this is the cell anchor.
Per-tick:

```js
this.skyCell.position.copy(camera.position);
// No rotation copy from camera — cell stays world-axis-aligned.
```

Each `SkyObjectGroup` becomes a direct child of `this.skyCell` (NOT
`scene` directly). Mesh transforms reset to identity:
- `mesh.position.set(0, 0, 0)` — vertices already carry the placement
- `mesh.scale.set(1, 1, 1)` — drop `CELESTIAL_BODY_SCALE`
- `mesh.rotation` — driven by the current progress + AC-Z mapping

For the AC-Z → three-Y axis remap: today's `worldRoot` uses
`rotation.x = -π/2` to rotate AC-Z into three.js +Y. Apply the same to
the sky cell (`this.skyCell.rotation.x = -π/2`) so the AC-authored
vertex coords land in the right orientation, OR rotate each SkyObject
individually around its three.js-Y (= AC-Z) axis. The first option is
simpler and matches the `worldRoot` pattern exactly.

Per-SkyObject rotation (replacing the per-frame
`celestialPosition` + `lookAt` math):

```js
const headingDeg = lerpDeg(
  s.beginAngleDeg,
  s.endAngleDeg,
  s.currentProgress
);
const headingRad = headingDeg * (Math.PI / 180);
// Inside skyCell (which already rotated -π/2 around X to land
// AC-Z = three-Y), AC-Z rotation = three-Y rotation:
mesh.rotation.set(0, headingRad, 0);
```

No `lookAt(camera)` — meshes are NOT billboards; their vertex layout
is direction-dependent (sun's vertex AABB is asymmetric in X+Y, moon
similarly). Billboarding wrecks the authored geometry.

### (c) Skip rendering the SetupModel proxy

`0x02000714` is the 6.5cm physics-script anchor for the moon
(`crates/holtburger-dat/src/file_type/region.rs:1283` test comment;
Sky-I-pre probe). Skip its mesh in `populateCelestialBodies`:

```js
const prefix = skyObjectId >>> 24;
if (prefix === 0x02) {
  continue; // physics-script anchor, NOT visible
}
```

### (d) Camera.far + fog.far implications

After (b)+(c), all celestial bodies live at their native distances
inside the sky cell — bounded by their vertex AABBs. Sun + moon
worldCenter (in cell-local space) is ~1900 units from the camera-
anchored cell origin. Cloud band is ~10,000 units across. The cell
needs to fit inside the camera frustum.

Options for clipping:

**Option α (recommended)**: render the sky cell into a separate camera
that has its own `far` and disables fog — a "true" 3D-skybox pass.
Render order: sky-cell-pass → world-pass. The sky-cell pass clears
nothing (writes to a clean depth buffer) so the world pass paints on
top of the sky background. ~30 lines of three.js.

**Option β (lighter)**: keep the single render pass. Extend
`camera.far` to 20,000+ (covers the 10k cloud-band cylinder), set
`scene.fog = null` for the sky meshes (already done via the per-mesh
`material.fog = false` in `populateCelestialBodies`'s loop at
`sky_dome.js:404-405`). With the dome at radius 1000 and
`depthTest=false`, sky meshes draw BEFORE the world; the world's
fog applies to world geometry but not the sky-cell children.

Recommend α — separates concerns cleanly, no impact on world-geometry
frustum sizing, matches the architectural pick the user articulated.
Implementation ~30 lines:

```js
this.skyCamera = new THREE.PerspectiveCamera(
  /* fov */ camera.fov,
  /* aspect */ camera.aspect,
  /* near */ 0.1,
  /* far */ 50000
);
// Per-frame: skyCamera.quaternion.copy(camera.quaternion) — match
// orientation but stay at origin (the cell IS at the camera).
renderer.autoClear = false;
renderer.clear();
renderer.render(skyScene, skyCamera);
renderer.clearDepth();
renderer.render(worldScene, camera);
```

### Putting it together — Sky-D new pseudocode

```js
// constructor
this.skyCell = new THREE.Group();
this.skyCell.name = "sky_cell";
this.skyCell.rotation.x = -Math.PI / 2;  // AC-Z → three-Y
this.scene.add(this.skyCell);

// populateCelestialBodies
for (const [id, bake] of skyAssets) {
  const prefix = id >>> 24;
  if (prefix === 0x02) continue;  // skip SetupModel proxy
  const group = buildSkyObjectGroup(bake, materialCache);
  // No scale; no position offset; identity-transform mesh.
  group.userData.sky_object_id = id;
  this.skyCell.add(group);
  this.skyObjectMeshes.set(id, group);
}

// tick
this.skyCell.position.copy(camera.position);
for (const s of session.getSkyObjectStates()) {
  const mesh = this.skyObjectMeshes.get(s.gfxObjectId);
  if (!mesh) continue;
  mesh.visible = s.visible;
  if (!s.visible) continue;
  // For animated arc bodies: rotate around AC-Z (= three-Y inside
  // skyCell after its -π/2 X-rotation).
  const headingDeg = lerpDeg(s.beginAngleDeg, s.endAngleDeg, s.currentProgress);
  mesh.rotation.set(0, 0, headingDeg * (Math.PI / 180));
  // (Apply transparent/luminosity/tex offsets via the same per-material
  // traversal as today.)
}
```

## Open questions for Sky-I-B

1. **Cell rotation axis under user navigation** — should the sky cell
   track the camera's yaw (so the sun stays at the same "compass
   bearing" as the player turns) or stay world-axis-aligned (sun
   stays at +X regardless of player heading)? AC retail behaviour:
   sun stays at compass bearing. The current proposal (skyCell with
   `rotation.x = -π/2` only) is world-axis-aligned. **Likely needs
   tweaking.**

2. **Pitch axis** — `SkyObject` carries no explicit pitch keyframes;
   today's `sky.rs` synthesizes `pitch = sin(p * π) * π/2`. With the
   raw-state refactor (Q4 above), the pitch synthesis moves to JS-side
   or stays in sky.rs as a derived `current_progress`-driven field.
   Recommendation: stay in sky.rs as a *cooked* `pitch_deg` field
   alongside the raw begin/end_angle, since pitch is a derivation —
   not a wire value — and there's no degrees-vs-radians question on
   it. **Confirm with eye-test.**

3. **`SkyObject.properties` bitfield** — `0x02` = scrolling cloud band
   (HIGH conf per `project_holtburger_skybox_properties_flags.md`).
   `0x04` = weather streak (MED). The properties may govern rotation
   axis or billboard behaviour per-object — not investigated here.
   **Defer to a separate workstream** unless Sky-I-B's eye-test
   reveals per-object behavioural differences.

4. **PhatSDK `CalcDrawFrame` reference math** — `GameSky.cpp:41` calls
   `CalcDrawFrame(&drawframe, skydesc->m_DrawVec)`. Neither
   `CalcDrawFrame` nor `m_DrawVec` exists in any vendored header. If
   Sky-I-B's eye-test shows residual misalignment vs retail behaviour,
   this is the most likely place additional source-of-truth lives —
   **may need a Discord-or-screenshot validation pass** to compare
   final orientation against retail screenshots.

5. **Cloud band's `tex_velocity` (-0.013, +0.013)** — already correctly
   plumbed via Sky-G (`mat.map.offset.set(tx, ty)` in
   `sky_dome.js:638-639`). Not a Sky-I question.

6. **Fog interaction** — with sky cell in a separate render pass
   (Option α), the sky cell is exempt from world fog by construction.
   The horizon→zenith gradient on the dome already comes from Sky-C's
   fog_color/amb_color. No further fog work required for Sky-I.
