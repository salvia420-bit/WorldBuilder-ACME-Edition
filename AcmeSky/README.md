# AcmeSky

> **2026-08-23 — "the clouds look nothing like retail" root cause: the plugin was stuck in
> DIAGNOSTIC MODE, and nobody could get it out.**
>
> `Live`, `TestGradient`, `DiagFrameLog` and the time override were **environment-variable-only**
> statics (`ACMESKY_LIVE=1`, `ACMESKY_TESTGRADIENT=0`, …). The injected acclient inherits **no**
> environment from the launcher — that is the documented reason `SkyConfig` / `sky.cfg` exists in
> the first place — so every deployed build booted with the env defaults
> `testGradient=True diag=True live=False`, i.e.:
> * the **takram volumetric compositor was OFF** (the whole M1/M2/M3 sky nobody ever saw in the
>   deployed client), and
> * the primitive baked fallback painted a **hardcoded orange/blue diagnostic band** instead of
>   the time-of-day palette.
> `sky.cfg` had **no key** for any of them, so it could not be fixed without a rebuild.
>
> All four are now `sky.cfg` keys, hot-reloaded once per second, shipping as
> **`live = 1`, `testgradient = 0`, `diag = 1`**, plus two new screenshot overrides
> (`skytimeoverride`, `skyweatheroverride`) because the in-game clock belongs to the vanilla ACE
> server and cannot be set. The baked fallback was rebuilt against the retail decomp at the same
> time — see *Baked cloud path* below.

> **2026-08-22 code-only investigation — BLACK SKY root cause + cloud seam-line fix (both landed, 1070 eye-test pending):**
> 1. **Black sky**: `ACMESKY_LIVE=1` routed the backdrop through `LiveSkyCompositor`, which was
>    constructed + warmed **lazily inside the GameSky::Draw detour** — i.e. on the native render
>    thread, where the Vortice assembly load / D3DCompile throws `0x80131509` (the exact
>    ALC-load-on-native-thread fault AcmeLights hit with the same compiler). `SkyHook`'s
>    catch-all swallowed the throw every frame → retail sky suppressed, nothing drawn, nothing
>    logged. FIX: the compositor is now created and `Warmup()`ed on the managed thread in
>    `SkyRenderer`'s ctor (Initialize), and `Render` falls back to the BAKED dome path when the
>    live path is missing/dead — the sky can no longer be silently black.
> 2. **Straight line across the clouds** (clouds "strictly stop"): the weather tile is ~90 km in
>    the sky and the visible cap spans ~2 tiles, so the `local_weather_nasa` (AcmeSky's sky.cfg
>    DEFAULT `wxmap=nasa`!) wrap seam projects as a hard line — the NASA/dereth crops are not
>    wrap-tileable (seam-step 2.7× / 6.4× the interior gradient; takram's procedural default
>    measures 0.9 = seamless; upstream clouds.glsl carries `TODO: Tile and fix seams`).
>    Holtburger dodges it by DEFAULTING to the tileable takram map (`?wxMap=nasa` opt-in has the
>    same seam). FIX: `Tools/bake_cloud_assets.py` now roll-blend-tileizes any non-tileable
>    weather map at bake time (96 px smoothstep band ≈ 17 km transition; `.tileable.png`
>    references emitted beside the bins). Holtburger can adopt the same pngs. The gold-plated
>    runtime alternative (iq texture-repetition / hextile in `sampleWeather`) remains open.

A Chorizite client plugin that **replaces the retail Asheron's Call sky** with a baked
NASA/takram sky rendered on the client's own fixed-function Direct3D 9 device. It suppresses
the retail sky with a single inline detour and draws, in its place, a palette-driven
atmosphere dome, layered cloud domes, and a night star dome — with correct terrain/building
occlusion, world-fixed orientation, and per-layer parallax.

This is the **plugin route** for the sky. The retail client is plain fixed-function D3D9 with
zero programmable shaders, so live raymarched volumetrics are impossible; AcmeSky renders
**baked assets** (offline-rendered on the buildbox T4) as textured domes.

> Status: **compiling foundation.** The whole pipeline is wired and builds clean. Full
> in-client validation is deferred to a 1070 injection session (see *In-client test procedure*).
> Everything not yet run against a live client is called out under *Unverified*.

---

## Build

```
DOTNET_ROLL_FORWARD=LatestMajor ~/.local/bin/dotnet build AcmeSky -c Release
```

Output is a lean plugin: `bin/net8.0/AcmeSky.dll` + `manifest.json` + `assets/sky/`. Every
framework/host assembly (Chorizite.Core, ACBindings, Reloaded.Hooks, Autofac,
Logging.Abstractions) is referenced `ExcludeAssets="runtime"` and bound to the copy already
resident in the acclient process — the plugin ships **only** its own dll and its baked assets.

---

## The verified mechanism

- **Suppress point = `GameSky::Draw`** — `void __thiscall GameSky::Draw(GameSky* this, int after)`,
  decomp `ac-headers/acclient.c:308475`, ACBindings `GameSky.cs` Offset `0x00507A50`.
- It is called **twice** per frame from `LScape::draw`: `Draw(sky, 0)` **before** the world
  (the backdrop the world overdraws) and `Draw(sky, 1)` **after** the world (weather in front).
- A Reloaded.Hooks inline detour that **returns early** (never calls the original) kills the
  entire retail sky — both phases — in one cut. Inside that detour is exactly the frame slot
  to draw our sky for the matching phase.
- The client is **fixed-function D3D9, zero shaders** (verified: no CreatePixel/VertexShader;
  `Direct3DCreate9`, not 9Ex). So the sky is drawn the fixed-function way: `SetTransform`
  WORLD/VIEW/PROJ, `SetTexture`, `SetRenderState`, `SetTextureStageState`, `SetFVF`,
  `DrawPrimitiveUP` of generated textured domes.

---

## Architecture (files)

```
AcmeSkyPlugin.cs            IPluginCore entry. Client-env only. Wires palette+loader+renderer+hook,
                           installs the hook on the render thread, tears down on the render thread.

Lib/
  D3D9.cs                  Device + texture vtable slot indices; all FF render/stage/sampler/
                           transform/FVF/format/pool constants (public d3d9types.h ABI). ARGB packer.
  Device.cs                Typed wrapper over a raw IDirect3DDevice9* — calls FF methods through the
                           COM vtable with unmanaged fn pointers (no marshalling). CreateTexture.
  ClientState.cs           Live memory reads: D3D device ptr (RenderDeviceD3D+1128), camera matrices +
                           viewport + derived camera world pos (m_GState), time-of-day, weather flag.
  DomeMesh.cs              Generates sky domes as expanded triangle lists (VertexPT/VertexPC) with
                           equirect UVs; +Z up world frame. One tessellation, two outputs.
  SigScan.cs               Dependency-free in-process byte-pattern scanner over acclient.exe.

Model/
  SkyLayer.cs              One cloud dome's config: texture, radius, scroll velocity, parallax factor,
                           alpha, blend mode, resolved texture handle. The unit of the layer stack.
  SkyPaletteData.cs        skytime_<class>.json shape + time-of-day interpolation -> atmosphere Sample.

Services/
  SkyHook.cs               THE hook. Reloaded.Hooks detour on GameSky::Draw. Sig-scan -> VA resolution.
                           Suppresses retail sky, calls SkyRenderer.Render(after). Thiscall stub.
  SkyRenderer.cs           Owns atmosphere dome, star dome, ordered cloud layers + their textures.
                           Draw order/occlusion, device-loss handling, per-frame draw.
  RenderStateGuard.cs      Snapshot/restore of EVERY FF state the sky touches (the #1 invariant).
  TextureLoader.cs         Uploads .askytex raw BGRA -> IDirect3DTexture9 (CreateTexture+LockRect+copy).
  SkyPalette.cs            Loads the six skytime_*.json palettes; hands out the current Sample.

assets/sky/                Baked assets shipped next to the dll (see "Assets").
tools/make_askytex.py      PNG -> .askytex converter (offline; regenerate/add plates with this).
```

### Hook wiring (`SkyHook`)

```
LScape::draw
  ├─ GameSky::Draw(sky, 0)   ── detoured ──▶  GameSky_DrawImpl(this, 0)
  │                                             ├─ (Suppress) original NOT called → retail sky gone
  │                                             └─ SkyRenderer.Render(0) → atmosphere+stars+clouds
  │   … world (terrain/buildings) draws here, overwriting our backdrop where nearer …
  └─ GameSky::Draw(sky, 1)   ── detoured ──▶  GameSky_DrawImpl(this, 1)
                                                ├─ (Suppress) original NOT called → retail weather gone
                                                └─ SkyRenderer.Render(1) → reserved (no-op today)
```

Everything is drawn in the **after=0** slot (before the world) so the world's own depth test
overwrites our sky exactly where geometry is nearer — **free, correct terrain occlusion**,
identical to how retail's DEPTHTEST_ALWAYS backdrop behaves. The **after=1** slot is reserved
for future front-facing precipitation; its retail weather is still suppressed.

Engine: **Reloaded.Hooks 4.3.3**, the same inline-detour engine the Chorizite native
bootstrapper already loads (`external/chorizite/.../Hooks/HookBase.cs`, `DirectXHooks.cs`,
`ACClientHooks.cs`). The detour is a `[UnmanagedCallersOnly]` **thiscall** stub, mirroring
Chorizite's `Client_Cleanup_Impl`.

### Address resolution (`SkyHook.Resolve`)

Prefer a **signature scan** of the main module (`SigScan.FindInMainModule`), fall back to the
ACBindings/decomp VA `0x00507A50`. The default signature is a **placeholder** (`SkyHook.Signature
= null`) — we have no copy of the shipping `acclient.exe` here to extract real prologue bytes,
so today resolution uses the known VA. **Capture the prologue bytes at `0x00507A50` during the
1070 session and set `SkyHook.Signature`** to make resolution build-independent.

---

## Device / camera / time / weather access (`Lib/ClientState.cs`)

All plain memory reads of client globals, safe to call from inside the detour on the render thread:

| What | Source (ACBindings / decomp) |
|---|---|
| `IDirect3DDevice9*` | `RenderDevice::render_device` = `(RenderDevice**)0x00870340`, then **+1128** (`RenderDeviceD3D::m_pDirect3DDevice`; cross-checked in AcmeRedline + Chorizite `DirectXHooks`). Re-read each frame → survives device Reset/recreate. |
| Camera matrices | `m_GState.WorldToViewMatrix` / `ViewToClipMatrix` (`RenderDevice.cs:55-57`). VIEW/PROJ pushed to the device unchanged so the sky is **world-fixed in orientation** (turning the view pans across it). |
| Camera world position | translation of `Invert(WorldToView)` — used to center each dome on the camera and to drive per-layer parallax. |
| Viewport | `m_viewportWidth/Height` (`RenderDevice.cs:101-102`). |
| Time of day | `GameTime::current_game_time` = `(GameTime**)0x008EE9C8` → `present_time_in_day_unit` (float, 0..1 day fraction; decomp `acclient.c:463274`). |
| Weather flag | `GameSky::s_weatherEnabled` = `(byte*)0x0081DD3C`. |

The matrices are AC's FF D3D transforms — row-major, row-vector multiply — identical layout to
`System.Numerics.Matrix4x4`, exactly as AcmeRedline's `Lib/Projection.cs` documents.

---

## What's implemented vs. documented extensions

**Implemented now:**
- `GameSky::Draw` suppress-hook (both phases), sig-scan → VA resolution.
- **Atmosphere dome** — full sphere, per-vertex diffuse gradient recomputed each frame from the
  Bruneton palette (`fog_color` at horizon → `amb_color` at zenith, smoothstepped), tinted by
  time-of-day, drawn opaque behind everything.
- **Cloud domes** — an **N-layer stack** (default 2: a low broken deck at r=700 + high cirrus at
  r=1100), each a camera-centered dome textured with a NASA plate, alpha-blended, **scrolling**
  (per-layer `ScrollVel`) with **per-layer parallax** (`ParallaxFactor` × camera XY), day/night
  tinted, painter-ordered far→near. Adding a third layer is one `SkyLayer` in `BuildDefaultLayers`.
- **Star dome** — equirect star texture, additive, **faded in at night** by sun elevation.
- Full FF state **save/restore**, **device-loss** handling (managed-pool textures + device-ptr-change reload).

**Documented extensions (clean seams left for them):**
- More cloud layers / parallax tuning — add `SkyLayer`s; `ParallaxFactor`/`Radius`/`ScrollVel` are per-layer.
- **Weather-state selection & transitions** — `SkyRenderer.WeatherClass` picks the palette + look;
  today it defaults to `clear`. Wire it to real weather (blend two classes over time; pick the cloud
  plate per class from `weather_manifest.json`). `IsWeatherEnabled()` is read but only a bool.
- **after=1 front precipitation** — the reserved second phase.
- **Proper dome-UV remap** of the cloud plates (azimuthal + rim-feather) — today's UVs are a
  first-pass equirect map; the plates are rough and not yet tileable (wrap seams expected).
- Sun/moon discs.

---

## Assets (`assets/sky/`)

Loaded at runtime from beside the dll. Two kinds:

- **`.askytex`** — a trivial raw BGRA container (8-byte magic `ASKYTEX1`, `uint32` w/h/format,
  then `w*h*4` BGRA rows). Pre-decoded **offline** by `tools/make_askytex.py` so the injected
  plugin needs **zero managed image decoder** (no ImageSharp/System.Drawing) in-process — upload
  is a straight `LockRect` + memcpy. Shipped: `cloud_low_broken`, `cloud_cirrus_clear` (512²),
  `stars_equirect` (1024×512). Regenerate/add with the converter.
- **`skytime_*.json`** — the six buildbox Bruneton palettes, loaded verbatim.

Source of the bakes: `/mnt/wbterminal2/dat-patch-sky/` (`PROVENANCE.txt`, `weather_manifest.json`).
Textures are created in **D3DPOOL_MANAGED** so a plain device Reset restores them automatically;
a *changed* device pointer (full re-create) is detected and triggers a reload.

---

## Runtime configuration (`C:\Temp\acdt\sky.cfg`)

**The injected acclient inherits no environment variables.** Everything tunable therefore lives in
a plain `key = value` file that the plugin re-reads **once per second**, so it can be edited while
the client is running. Copy `assets/sky/atmosphere/sky.cfg.example` to `C:\Temp\acdt\sky.cfg`
(the same dir AcmeRagdoll reads `ragdoll.cfg` from). Search order:
`%ACMESKY_SKY_CONFIG%` → `C:\Temp\acdt\sky.cfg` → `C:\Temp\acdt\skyaxis.txt` → `~/.acdt/sky.cfg`.

The four that decide *what you actually see*:

| key | default | meaning |
|---|---|---|
| `live` | `1` | `1` = takram volumetric clouds + Bruneton atmosphere (D3D11 → readback → D3D9). `0` = the baked-dome fallback. Read at plugin init (the D3D11 device must be created on the managed thread), so changing it needs a relaunch. |
| `testgradient` | `0` | Baked path only. `1` paints a hardcoded orange/blue diagnostic band instead of the palette. |
| `skytimeoverride` | `-1` | `0..1` forced time-of-day (`0.25` sunrise, `0.5` noon, `0.75` sunset), `-1` = the game clock. Hot. Alias `time`. **This is the only way to choose the sky's time**: the clock comes from the vanilla ACE server and must not be modified. |
| `skyweatheroverride` | `auto` | `clear\|scattered\|broken\|overcast\|rain\|storm` — pins the baked palette + cloud stack *and* the live path's coverage/FAIR-vs-STORM look. `auto` follows the client's `GameSky::s_weatherEnabled`. Hot. |

Everything else (`exposure`, `cloudcover`, `cloudminstep`, `stars`, `dump`, …) is documented inline
in `sky.cfg.example`.

**Live-path crash sentinel.** The D3D11→CPU→D3D9 readback has a history of faulting *natively*
under DXVK, which no managed `catch` can intercept. Since `live` now defaults on, the compositor
drops `C:\Temp\acdt\acmesky-live-crashed.flag` before its first upload and deletes it after ~300
good composites (or on a clean unload). If that file is present at startup, the previous session
died in the live path and the plugin boots the **baked fallback** instead of crash-looping. Delete
it to re-arm.

---

## Baked cloud path — retail-derived (fallback renderer)

Reworked 2026-08-23 against the retail decomp after the live path proved to have never been
running in the deployed client. What retail actually does (`acclient.c`; symbols to verify):

- `GameSky::Draw` sets `zfar*4`, `DEPTHTEST_ALWAYS` + no z-write, and draws DAT-authored sky
  objects as ordinary `CPhysicsObj`s. There is **no procedural sky code at all**.
- The cloud layer is gfxobj **`0x01004C36`**: a 9-vertex / 12-triangle drooping canopy — apex
  `(0,0,+780)` uv `(2.5,2.5)`, inner ring `(±5044.63, ±5044.63, +487.5)`, outer rim
  `(±10087.7, ±10087.7, −400)`, uv `0.482…4.518`. That is a **256² plate tiled ~4× over 20175
  units** on a plane ~780 above the eye ⇒ tile ≈ 5000 units ⇒ **`uvScale = 780/5000 = 0.156`**,
  which is `SkyRenderer.RetailUvScale`. The rim bottoms out at −1.6° elevation and bounds the UV
  density there — reproduced by `HorizonCapDeg = 4.4` + a fade over −2°…6°.
- Scroll is **translation only** (`CPhysics::UpdateTexVelocity` → `CGfxObj::TexVelocity` →
  `D3DPolyRender::RenderMeshSubset` pushing `D3DTS_TEXTURE0` with `D3DTTFF_COUNT3`); retail never
  rotates cloud UVs. Dereth DayGroup 0's cloud `tex_velocity` is `(−0.013, +0.013)` uv/s — used
  verbatim for the low deck.
- Blending comes from the DAT `SurfaceType` via `D3DPolyRender::SetSurface`: normal clouds are
  `BASE1_IMAGE|ALPHA` ⇒ `SRCALPHA/INVSRCALPHA` with `TEXADDRESS_WRAP` (the storm cloud
  `0x01004C35` adds `ADDITIVE` ⇒ `SRCALPHA/ONE`).
- Time-of-day tint is **material state, not vertex colour**: `Emissive = luminosity/100`,
  `Diffuse = max_bright/100`, `alpha = 1 − transparent/100`, lerped between the two bracketing
  `SkyTimeOfDay` records by `SkyDesc::GetSky`. At Dereth's midnight record the cloud object has
  `transparent = 100`, and `CPhysicsPart::SetTranslucency` special-cases `1.0` by setting
  `draw_state |= 1` ⇒ `CPhysicsPart::Draw` **skips the part**. **Retail draws no clouds at
  night.** We fade the deck out on the same schedule.
- Weather = `SkyDesc::CalcPresentDayGroup`, a deterministic hash of the calendar date over the
  region's DayGroups (Dereth: Sunny ×6 / Clear ×3 / Cloudy ×3 / Rainy ×8). No server packet.

What that changed here: the deck now uses a **cloud-plane projection** (`DomeMesh.BuildCloudPlane`)
instead of the equirect star mapping — the old mapping wrapped a whole 360° of azimuth into one
texture width and collapsed it to a point at the zenith, which is what turned a 512px plate into
continent-sized wedges; per-vertex diffuse carries a palette-derived lit colour and the horizon
fade instead of a flat grey `TEXTUREFACTOR`; and the layer stack varies per weather class instead
of drawing one hardcoded overcast deck under every palette.

---

## State save/restore approach (`RenderStateGuard`)

The single most important correctness invariant: a leaked render state silently corrupts the
client's own rendering for the rest of the frame. `RenderStateGuard.Capture` snapshots **every**
FF state AcmeSky touches — render states (Z, blend, cull, fog, lighting, alpha-test, specular,
color-vertex/-write, ambient, clipping, texture-factor), texture-stage-0 states (color/alpha
ops + args, texture-transform flags, texcoord index), sampler-0 states (address, filters), the
WORLD/VIEW/PROJ/TEXTURE0 transforms, the FVF, and the bound stage-0 texture — with `Get*`, then
`Restore` puts them all back with `Set*`. This mirrors AcmeRedline's `BeginTintState`/`EndTintState`
discipline. (Stream source is deliberately not saved: `DrawPrimitiveUP` nulls stream 0 and the
client rebinds its own before its next indexed draw.)

---

## In-client test procedure (1070 injection session)

Baseline the render on the owner GPU; AcmeSky is a real-GPU eye test (do it off-screen/headless
on `:9333`, never on the 1070 user's screen; match their chrome by `--user-data-dir`; no sound).

1. **Capture the signature (one-time):** dump the bytes at `0x00507A50` in the shipping client,
   set `SkyHook.Signature` to a ~10-byte prologue pattern, rebuild. (Until then it uses the VA.)
2. **Inject** the plugin (drop `AcmeSky/` in the plugin dir; confirm manifest loads, log shows
   `acmesky: GameSky::Draw hook installed at 0x00507A50` then `retail sky suppressed, baked sky armed`).
3. **Enter world.** Confirm the retail sky is **gone** and replaced by the baked atmosphere +
   clouds + (if night) stars. No crash, no corruption of world rendering (watch for wrong colors
   / missing fog / z-fighting on normal objects → a leaked render state).
4. **`/time` day↔night** (or wait / use the time-adjust): confirm the atmosphere gradient shifts
   day→dusk→night, clouds darken, **stars fade in** at night and out by day.
5. **Occlusion turn-test:** stand near a large building / hill. Confirm clouds are **occluded by
   terrain and buildings** (they sit behind the world, not painted over it).
6. **World-fixed test:** turn the camera in a full circle. Confirm the sky **pans across the view**
   (world-anchored) and is **not glued to the heading**; the clouds/stars stay put as you rotate.
7. **Parallax test:** run a straight line; confirm the two cloud layers drift **relative to each
   other** slightly (inter-layer parallax), not as one rigid dome.
8. **Device-reset test:** alt-tab / change resolution (forces `IDirect3DDevice9::Reset`); confirm
   the sky returns intact (managed-pool restore / device-ptr reload) with no crash.
9. **Unload test:** unload the plugin; confirm the retail sky returns (hook `Disable()` routes
   `GameSky::Draw` back to the original) and the client stays stable.

---

## Top risks

1. **State save/restore correctness.** A single leaked render/stage/sampler state corrupts the
   client's own draws for the rest of the frame. `RenderStateGuard` is exhaustive by design; any
   new state a future draw touches **must** be added to both `Capture` and `Restore`.
2. **Device Reset / recreate.** We use managed-pool textures (auto-restored on Reset) and detect a
   changed device pointer to reload; but we don't hook `Reset` ourselves, so a recreate is only
   noticed on the next frame's device-ptr read. On a genuine recreate the old textures are dropped
   without Release (releasing into a freed device would crash) — a one-time leak of the old
   device's resources, which die with that device anyway.
3. **Depth handling given the DEPTHTEST_ALWAYS backdrop slot.** We draw with Z-writes OFF and
   ZFunc=ALWAYS in the pre-world slot so the world overdraws us. If the frame's depth clear or draw
   order differs from the assumed LScape sequence, occlusion could invert (sky over world) — the
   occlusion turn-test (step 5) is the check.
4. **Clouds behind terrain.** Follows from (3): clouds live in the after=0 backdrop precisely so
   terrain occludes them. If a future change moves any cloud layer to after=1 it will paint over
   the world.
5. **Calling-convention / address of the thiscall detour.** The detour ABI (`CallConvThiscall`)
   and the fallback VA are modeled on ACBindings + Chorizite precedent but not run here; a wrong
   convention or a build-shifted VA crashes on the first sky frame. The sig-scan (step 1) removes
   the VA risk.

---

## Unverified (no live client available in this environment)

- **The detour actually fires and suppresses** — `GameSky::Draw` VA `0x00507A50`, the thiscall
  ABI (`[Function(MicrosoftThiscall)]` delegate + `CallConvThiscall` stub, per Chorizite's working
  `Client_Cleanup`), and Reloaded's reverse-wrapper behaviour are all from precedent, not a run.
- **`SkyHook.Signature` default is a placeholder** (null → VA fallback). Real prologue bytes must
  be captured from the client binary.
- **Reloaded.Hooks / Autofac / Logging.Abstractions resolve from the in-process (host) copies** at
  runtime (`ExcludeAssets="runtime"`). The bootstrapper loads Reloaded.Hooks 4.3.3 into the default
  ALC, which a child plugin ALC resolves against; not exercised here.
- **`present_time_in_day_unit` is the 0..1 day fraction** used for the palette axis (confirmed by
  decomp as `(t-begin)/(day_length-begin)`, but the exact phase offset vs. the palette's `time`
  keyframes is not eyeballed).
- **The FF pipeline draws the domes as intended** — vertex-diffuse gradient with Lighting off,
  texture-factor tint/fade, COUNT2 texture-transform UV scroll, additive stars — all standard FF
  but unrun against this client's device.
- **Camera-world-position from `Invert(WorldToView)`** and the dome centering/parallax math are
  unrun (AcmeRedline validates the same matrices for projection but not this use).
- **Cloud plates are a rough first pass** — equirect UVs (not the proper azimuthal dome remap),
  not tileable (wrap seams expected), no weather-class selection yet (defaults to `clear`).
- **Unload safety:** `IHook.Disable()` routes calls back to the original but Reloaded has no full
  uninstall; the detour stub (a `[UnmanagedCallersOnly]` method in this collectible ALC) must not
  be re-entered after unload. Tested behaviour of Disable() across a plugin reload is unverified —
  prefer a client restart over a hot reload while armed, as AcmeRedline concludes for its own hooks.
```
