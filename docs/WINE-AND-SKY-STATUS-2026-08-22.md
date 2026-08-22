# Wine + Chorizite feasibility, and the DAT-sky reset question — 2026-08-22

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
