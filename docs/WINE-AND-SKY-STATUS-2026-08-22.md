# Wine + Chorizite feasibility, and the DAT-sky reset question — 2026-08-22

## UPDATE (Vulkan/DXVK) — the T4 renders the client on HARDWARE; volumetric compositor initializes on-GPU then crashes in readback

The "wine = software GL, hopeless for real rendering" conclusion was **wrong** — that was WineD3D
over 32-bit software GL. **DXVK (D3D9/D3D11 → Vulkan) runs the 32-bit AC client on the Tesla T4
in hardware.** Proven on the buildbox:
- `/etc/vulkan/icd.d/nvidia_icd.json` registers `libGLX_nvidia.so.0`; both i386 and x86_64
  `libGLX_nvidia.so.550.54.15` + the i386 Vulkan loader are present. 64-bit `vulkaninfo` sees
  `Tesla T4` (Vulkan 1.3.277).
- Staging DXVK 2.4.1 `d3d9.dll` next to acclient + `WINEDLLOVERRIDES="d3d9=n"`: DXVK logs
  `DXVK: v2.4.1`, `Skipping CPU adapter: llvmpipe`, `Device : Tesla T4` — the client renders
  char-select + world on the T4 via `winevulkan.dll` → NVIDIA. (Kit already had this `d3d9.dll` +
  `dxvk.conf`; ref repo github.com/mrmackdaddy79-a11y/AC-Vulkan-Reshade-NoCrash-Fix — AC+DXVK on
  Windows, main gotcha is a texture-leak OOM fixed by DXVK memory mgmt + a 4GB/LAA patch; no
  dxvk.conf/registry tweaks needed.)

**The volumetric AcmeSky live path reaches the GPU too, then crashes.** With DXVK 2.4.1
`d3d11.dll`+`dxgi.dll` staged + `WINEDLLOVERRIDES=...,d3d11=n,dxgi=n` and the **native Microsoft
`d3dcompiler_47`** installed (winetricks standalone — wine's builtin vkd3d-shader HLSL compiler
choked with `E5005: Function "frac" is not defined`), the compositor fully initialized:
`LIVE D3D11 device created (adapter='NVIDIA Tesla T4', featureLevel=Level_11_0)`, `LIVE clouds
ready`, `LIVE atmosphere ready`, `warmup -> READY`. But once `LiveSkyCompositor.Frame()` runs
in-world, the client dies with a **native access violation** (`Unhandled page fault on write
access to 233CB000 at 656DB910`) — no managed exception, so the compositor's try/catch can't
catch it. Per the takram agent, this readback→upload path (`RenderAndUpload`: D3D11 CopyResource
→ Map(Read) → memcpy into a DXVK D3D9 `Dynamic`/`Default` dynamic texture via LockRect →
fullscreen quad) has very likely never actually executed before, so this is its first run. The
write fault points at the **D3D9 upload memcpy** (`LiveSkyCompositor.cs` ~617-652): a DXVK D3D9
dynamic-texture `LockRect` pitch/pointer that doesn't match the assumed `w*4` row size would
overflow. **Confirmed the crash is in the COMMON readback path, not the clouds:** re-run with
`sky.cfg clouds=0` (atmosphere-only) still faults at the **identical instruction `656DB910`**
(only the write target varies — 233CB000 then 3324E000), so it is one specific memcpy/copy in
`RenderAndUpload`, independent of the cloud pass. Next-debug (needs a rebuild): log
`staging RowPitch` and the D3D9 `locked.Pitch` vs `w*4` right before the row-copy loop, clamp the
per-row copy to `min(srcPitch, dstPitch, w*4)`, and confirm the D3D9 upload texture create
(`Dynamic`/`Default`, A8R8G8B8) round-trips under DXVK d3d9 (DXVK may hand back a differently
pitched/sized lock than WineD3D did in the never-run-before path). Half-res readback (the takram
Rank-1) is the other lever and would shrink the copy footprint.

**Significance:** DXVK unlocks real-GPU validation of the takram volumetric path **on the buildbox
T4** — no 1070 needed for the takram Rank-0. The environment is preserved on the box (DXVK dlls in
`D:\ac-dat-test` + wine system32, native d3dcompiler_47 in the prefix, launch script
`/tmp/inject-dxvk.sh`); a follow-up restarts and resumes. Baked AcmeSky + AcmeLights + torch-on
all still work under DXVK (the client's D3D9 is DXVK's; the Chorizite inline hooks are
device-independent).

---


## UPDATE (later same day) — INJECTION NOW WORKS under wine (base-aware injector)

The base-aware injector was built (`AcmeInject/`, x86 .NET 8) and **proven on the buildbox T4**.
It replaces the prebuilt `AcmeInject.exe`: instead of calling the injector DLL's `Bootstrap` at
its *local* address, it reads the injector's *remote* base from the `LoadLibraryW` thread exit
code and calls `Bootstrap` at `remoteBase + BootstrapRVA` (RVA parsed from the export table).
Result: `Injector remote base: 0x10000000 -> Bootstrap 0x10004E9E; Bootstrap returned 0; Client
resumed.` — no fault. In acclient the injector loads at its preferred 0x10000000 (free in the
sparse client); the base-aware call lands correctly.

Two more wine-only environment gaps had to be fixed before the ACME plugins would load and run:
1. **`%TEMP%\chorizite` must exist** — Chorizite's `AssemblyPluginLoadContext` ctor does
   `Directory.GetDirectories(Path.GetTempPath() + "chorizite")` (Chorizite.Core .../AssemblyLoader/
   AssemblyPluginLoadContext.cs:36), which throws `DirectoryNotFoundException` under wine (a real
   Windows install has it). `mkdir ~/acwine/drive_c/users/<user>/Temp/chorizite` fixes it — every
   plugin failed to load without it.
2. **Plugin asset dirs need the execute/traverse bit** — the Chorizite tree was shipped as a
   Windows `Compress-Archive` zip; `unzip` gave directories mode `drw-` (no `x`), so wine couldn't
   traverse into `plugins/AcmeSky/assets/` → `palettesLoaded=False` → black sky. `find … -type d
   -exec chmod u+rwx` fixes it. Also the AcmeSky `assets/sky/**` tree (palettes + textures) was
   **missing from the 1070 zip entirely** and had to be shipped from the repo.

With those, on the buildbox under wine: **AcmeLights runs fully** (per-frame light pool,
flicker, ambient fix — `frame#17629 static=38/60 … flicker=1`), **AcmeRagdoll arms** (`ready.
Creatures will ragdoll on death`), and **AcmeSky loads + installs its GameSky::Draw hook and
suppresses the retail sky** (`palettesLoaded=True`, detour firing both phases). The Chorizite UI
stack (RmlUi/Lua/PluginManagerUI/AC) still fails to load under wine on a separate path issue, but
the three ACME plugins don't depend on it.

**AcmeSky baked sky — FIXED (was black under wine).** Instrumenting `SkyRenderer.Render` with a
logging guard revealed the exact throw: `System.IO.FileLoadException: Could not load … 'Chorizite.
ACBindings' … operation is not legal in the current state (0x80131509)`. `ClientState` (device
ptr / camera / time) dereferences ACBindings statics from inside the `GameSky::Draw` detour on the
client's native render thread, and a **lazy** ACBindings assembly/ALC load there throws
0x80131509 — the identical fault AcmeLights/AcmeRagdoll already avoid with `WarmupAcBindings`,
which AcmeSky was missing. SkyHook's catch-all swallowed it, so Render bailed every frame: retail
sky suppressed, nothing drawn → black. Invisible on Windows (another plugin had already loaded
ACBindings); under wine AcmeSky's detour was first to touch it. Fix: `WarmupAcBindings()` in
`AcmeSkyPlugin.Initialize` (commit 9e625712), plus the pre-draw logging guard so a future silent
bail is diagnosable. **PROVEN**: AcmeSky now draws its baked blue daytime sky + cloud layers
in-world under wine (`frame after=0 time=0.500 sunEl=58.8 dayness=1.00 atmoDrawn=1`), forced to
noon via `ACMESKY_SKY_TIME=0.5`. The full stack — base-aware inject + AcmeLights + AcmeRagdoll +
AcmeSky, all rendering — works end to end under wine on the T4.

Note this is likely the same class of bug behind the user's original "acmeskies appear black"
report even on the 1070 whenever AcmeSky's detour wins the race to touch ACBindings first; the
warmup makes it deterministic everywhere.

The recipe below (the pre-injection assessment) still stands; the base-aware injector removes its
blocker #2, and the temp-dir + asset-perms fixes are new prerequisites.

---


Code-only + buildbox-hands-on session. Two questions were owed:
1. Can the injected Chorizite client (AcmeLights/AcmeSky) run under wine on the buildbox T4?
   (Needed anyway; would also fulfil the owed lantern test + gauge AcmeSky.)
2. Did earlier "takram-sky-in-the-DATs" work leave any in-use DAT set showing non-retail
   (e.g. night/patched) skies for players who don't use the AcmeSky plugin?

## 1. Wine — non-injected client WORKS; Chorizite injection is BLOCKED (fixable)

### Non-injected acclient under wine: fully working on the T4
- `acclient.kit.exe` logs into the laptop's ACE, enters the world, and renders a complete
  retail scene — terrain, buildings, and a **normal daytime retail sky** — via WineD3D on the
  Tesla T4. Live screenshot at Holtburg confirms it. This is the recommended exe.
- `acclient.eor.patched.exe` (compressed-portal variant) reaches the world too but then
  **crashes in `ImgTex::MergeTexture` (map RVA 0x0013E5D0)**, a landscape texture-merge path
  WineD3D mishandles; low texture detail did not avoid it. Prefer `acclient.kit.exe`.
- Rig: Xorg :1 on the T4, `DISPLAY=:1 wine …`, `ffmpeg -f x11grab` capture, `xdotool` clicks
  (we own the display — none of the 1070's focus/mute gymnastics apply).

### Chorizite injection: the injector's base-address assumption fails under wine
`AcmeInject.exe` → `Chorizite.Injector.dll!LaunchInjected`: it CreateProcess-SUSPENDs acclient,
remotely `LoadLibraryW`s the injector, then `CreateRemoteThread`s at the injector's **local**
`Bootstrap` address (`localBase + 0x4E9E`). Result: **`Unhandled page fault on read access to
072E4E9E`** — 0x4E9E is Bootstrap's RVA; 0x072E0000 is the injector's base *in the .NET launcher*.
In acclient the injector maps at a different base, so the remote thread lands on garbage.

The injector assumes its DLL loads at the **same base in launcher and target**. It ships with
ASLR on (`DllCharacteristics 0x0140`, preferred base 0x10000000). Binary-patch attempts, all
failed:
- Clear the ASLR bit (→0x0100): **same crash** — 0x10000000 is occupied in the .NET launcher,
  so wine still relocates the injector to 0x072E0000; acclient still differs.
- Rebase ImageBase to 0x072E0000: **`E_OUTOFMEMORY`** loading the injector — collides with the
  CLR's own heap.

Conclusion: **no single fixed base is free in both a .NET-CLR launcher process and the sparse
acclient**, so no PE patch fixes this robustly. The correct fix is a **base-aware injector**:
read the remote HMODULE from the injected `LoadLibraryW`'s thread exit code (= the injector's
*remote* base), then `CreateRemoteThread` at `remoteBase + BootstrapRVA`. `AcmeInject`'s source
is not in the repo (its PDB path is a scratchpad build), so the next step is to add a small
standalone base-aware injector to the repo (or obtain AcmeInject's source and fix its P/Invoke
path). Until then, injection — and therefore the lantern test and any AcmeSky/AcmeLights
in-client validation — stays **1070-only**.

### DX11→DX9 concern (the user's instinct was right)
Even with injection fixed, on this box:
- AcmeSky **baked** domes (fixed-function D3D9) and AcmeLights **P1–P3** (light structs, no
  shaders) would render under WineD3D. Set `ACMESKY_TESTGRADIENT=0`; do **not** set `ACMESKY_LIVE`.
- AcmeSky **live** path (its own D3D11 device + ps_5_0 + per-frame full-res readback) and
  AcmeLights **bloom** (ps_2_0) are **hopeless here**: 32-bit GL on the box is MESA **software**
  (llvmpipe) — no NVIDIA compat32, no 32-bit Vulkan/DXVK. The single highest-value box upgrade
  for real 32-bit rendering is installing NVIDIA `:i386`/compat32 GL libs.

## 2. DAT skies — NO RESET NEEDED; non-plugin players already get retail skies

Record-level audit (WorldBuilder.Terminal oracle, full 113-record sky-asset closure vs
`~/ac_base_dats`) plus direct visual proof:
- Every **served / staged / shippable** DAT set is **sky-vanilla**: the live ACE-served portal
  (`dat-patch-r9/…`, sha 1c773046 = r10-headfix), the r7 pair, the ragdoll-pilot portal that
  went to the 1070's `D:\ac-dat-test`, the ACME player-kit smoke build, and all r5–r10 staging
  portals — 0 of 113 sky assets differ from retail.
- **Visual confirmation**: the non-injected wine client (using the buildbox's r-lineage
  `client_portal.dat`, sha b1a10eef) renders a **normal retail daytime sky**, not a takram/night
  sky.
- The only sky-patched artifact is `/mnt/wbterminal2/dat-patch-sky/ARCHIVED-dataonly/
  client_portal.skytest.dat` (sha 3b007a90) — DayGroup-0 palette recolor + two cloud
  RenderSurfaces (`0x06003896`, `0x060037AF`) to DXT5. It is archived off-tree, referenced by
  nothing, and was **never served**.
- The AcmeSky plugin is client-side and additive (it detours `GameSky::Draw @ 0x00507A50` at
  runtime); without it installed, the retail DAT sky draws normally.

The retail day-sky "tell" for any future DAT check: Region `0x13000000`
`dayGroups[0].skyTime[0]` = `dirColor (220,220,220)`, `ambColor (200,100,255)`, fog `0/400`
(patched tell: `dirColor (140,158,217)`, `ambColor (76,102,173)`, fog `150/2400`).

**Contingency** (only if a sky-patched portal ever lands in a served dir — identify by Region
`skySha != b93a6ef91c0d8cf8` or the two cloud surfaces reporting DXT5@256): restore
**record-level**, not whole-file (the r-portals carry other wanted patches) — `region-import-json`
the retail Region + re-import the two cloud RenderSurfaces from `~/ac_base_dats`, never compress
a 0x13/0x01 record, verify 0/113 + the 120 s ACE survival gate, then repoint `Config.js`
`DatFilesDirectory`. `~/ace-server` and `~/ac_base_dats` are never edited.

## Buildbox state after this session
Repo synced to `integ/all-20260813` (44fab9e2). Wine kit intact under `~/acwine/drive_c/` (x86
.NET8 at `C:\dotnet-x86`, the Chorizite tree, `D:` symlink to `~/d-drive`). Injector DLL
restored to shipping bytes (ImageBase 0x10000000, ASLR on). UserPreferences restored to VeryHigh.
Instance **stopped** (billing off, disk kept).
