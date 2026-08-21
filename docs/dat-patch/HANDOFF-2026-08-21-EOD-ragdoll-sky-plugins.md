# HANDOFF — 2026-08-21 EOD (Chorizite PLUGINS: ragdoll deaths shipped-quality; live sky atmosphere OUTSTANDING)

Session arc: pivoted off the pure DAT-patch line into **two new Chorizite plugins** injected
into the retail acclient — `AcmeRagdoll` (runtime physics ragdoll deaths for every creature)
and `AcmeSky` (a live in-process D3D11 renderer that replaces the retail sky). AcmeRagdoll is in
good shape (owner-confirmed, incl. the flying-creature case). AcmeSky's live Bruneton atmosphere
RENDERS but has two outstanding orientation/scattering bugs — see §2.4. Also committed the
big-head + INDEX16 regression-lane fixes from earlier. Owner closed the client at session end.

All on `integ/all-20260813`. This is the plugin-workstream companion to
`HANDOFF-2026-08-21-r10.md` (the DAT lineage) and `PLAN-2026-08-18-hedonic-allocation.md`
(the fill roadmap); the DAT line is summarized in §3, remaining work in §4.

---

## 1. AcmeRagdoll — GOOD SHAPE (owner-confirmed)

A Chorizite plugin (`AcmeRagdoll/`) that makes creatures ragdoll on death via inline detours on
the client's own per-part pose pipeline. Owner verdict this session: "wasp death passed and
ragdoll is in good shape."

### What it does (all landed + tested on the 1070)
- **Death-start ragdoll** — hook `CPhysicsObj::DoInterpretedMotion @ 0x0050F540` (motion-START
  choke point), filter `motion == 0x40000011` (Dead) → the body crumples via physics from the
  instant of the death hit, not after the canned animation. `MotionDone @ 0x00510880` is kept as
  an anim-END fallback arm. `CPartArray::UpdateParts @ 0x00519C20` is the per-part overwrite,
  armed only while a ragdoll is live. Toggle `RagdollSettings.ArmOnDeathStart` (default true).
- **Corpse continuity (the death-hit ragdoll BECOMES the corpse)** — AC replaces a dying creature
  with a separate corpse object; the plugin records the creature's live verlet sim state
  (`ExportState`/`RestoreState`) keyed by (num_parts, objcell, quantized world XY) and hands it to
  the corpse so it continues the exact fall/settle instead of re-crumpling or snapping to the
  canned corpse pose. `HandoffMaxDistXY = 6.0` yd, window 8 s.
- **Deferred zero-position arm** — the corpse's Dead motion fires at object-create while its
  `m_position` is still 0; those arms are held as `PENDING-nopos` and resolved to `CORPSE-handoff`
  a frame or two later once positioned (they never re-arm otherwise). Fixed the "corpse is the old
  canned pose / both bodies present / death-hit skipped" reports.
- **Airborne fall-to-ground** — a creature killed in mid-air (e.g. a wasp) no longer leaves a
  floating corpse. Terrain height comes from the client's own `CLandCell::find_terrain_poly @
  0x00533A30` (pattern copied from `CLandBlock::adjust_scene_obj_height`, acclient.c:352215; solve
  the walkable triangle's plane for Z). Airborne = lowest-part world-Z above terrain by
  `AirborneEps = 0.5` yd; the body then falls under gravity (`WorldGravity 9.8`, `MaxFallSpeed 40`)
  in world space, slope-aware (lands at the terrain height for its XY), carried through the corpse
  handoff so the corpse also ends grounded. Logs `ragdoll FALL ... class=AIRBORNE/LANDED`.
- **Corpse hold** — `HoldMillis = 900_000` (15 min, was 30 s) so the ragdoll pose persists past
  corpse-despawn instead of reverting to the canned Dead pose; despawned corpses are still reaped
  early by the despawn sweep, id-reuse guarded by `e.Obj != owner`.

### Files (all in `AcmeRagdoll/`)
`Services/NativeHooks.cs` (3 hooks), `Services/RagdollRegistry.cs` (registry, handoff, airborne
fall, terrain lookup), `Sim/RagdollSim.cs` (+ ExportState/RestoreState), `Lib/AddressResolver.cs`
(the 3 VAs + terrain VA), `Lib/RagdollSettings.cs` (ArmOnDeathStart), `AcmeRagdollPlugin.cs`
(Initialize + `WarmupAcBindings`).

### Tunable constants (top of RagdollRegistry, if the owner reports issues)
`AirborneEps 0.5` (raise if a grounded death on a steep slope misclassifies as airborne),
`HandoffMaxDistXY 6.0`, `HandoffWindowMillis 8000`, `PendingFramesMax 30`, `PendingTimeoutMillis
2000`, `HoldMillis 900_000`. Diagnostic log classes to watch on the 1070: `CREATURE-crumple`,
`PENDING-nopos`, `CORPSE-handoff`, `SKIP-nopos (gave up)`, `FALL … AIRBORNE/LANDED`.

### Deferred (owner said "leave it for now")
- Death variety scale-out (owner wanted ~25 ragdoll variants per monster class; parked until the
  POC is solid — it now is). The death-start hook and the sim seed already vary the fall direction
  per object; a real variety pass is future work.
- These POC creatures (Mukkir/Mosswart/Drudge) carry 4 DAT-patched death-animation variants; the
  ragdoll rides on top of whichever variant plays (the overwrite wins each frame).

---

## 2. AcmeSky — live in-process sky; M0 PROVEN, M1 atmosphere OUTSTANDING

A Chorizite plugin (`AcmeSky/`) that suppresses the retail sky and renders a replacement on a
PRIVATE Direct3D 11 device inside acclient, composited onto the client's fixed-function D3D9
backbuffer. Chosen because the retail client is pure fixed-function D3D9 (no shaders — verified),
so takram's real shaders can't run on the client's own device; a private D3D11 context can.

### 2.1 Hook + suppression
`SkyHook` detours `GameSky::Draw @ 0x00507A50` (`[UnmanagedCallersOnly(CallConvMemberFunction)]`),
returns early to suppress BOTH retail sky phases, and calls the compositor in the `after==0`
(backdrop) slot so terrain overdraws it for free occlusion.

### 2.2 Milestone 0 — compositor plumbing: PROVEN on the 1070
Private D3D11 device (Vortice.Windows) renders a fullscreen pass to a `B8G8R8A8_UNORM` offscreen
RT → CopyResource to a staging texture → CPU readback → upload to a `D3DUSAGE_DYNAMIC /
A8R8G8B8 / D3DPOOL_DEFAULT` D3D9 texture → draw as an `XYZRHW|TEX1` fullscreen quad wrapped in
`RenderStateGuard`. CONFIRMED live: D3D11 device coexists with the client's D3D9 device (GTX 1070,
FL11_0), readback + composite works (matching pitches), no crash, animated test pattern visible.
This de-risked the whole approach. `ACMESKY_TESTPATTERN=1` (or output modes) still reaches it.

### 2.3 Milestone 1 — Bruneton atmosphere: RENDERS (daytime), needs orientation/seam fixes
Faithful HLSL port of holtburger-web's Bruneton precomputed-scattering sky: baked LUTs shipped as
`.bin` (transmittance 256×64, scattering 256×128×32, irradiance 64×16, R16G16B16A16F; converter
`AcmeSky/Tools/bake_atmosphere_luts.py`), per-pixel camera ray → ECEF (km), analytic sun/moon
disc, exposure×5 + AgX tonemap, HLSL compiled at runtime by D3DCompiler (falls back to the M0
pattern on compile/LUT failure rather than crashing). It DOES render a blue daytime sky.

Porting bible (for M2 clouds / M3 stars): **`docs/sky-port/holtburger-sky-porting-spec.md`**.

### 2.4 ⚠ THE TWO OUTSTANDING SKY BUGS (start here next session)
Diagnosed live on the 1070 with the owner's eyes (screenshots are useless mid-session — see §5):

1. **Ray basis rotated — "up" conflated with world-NORTH, not screen-top.** In the AC ray-viz
   (`output=4`: R=east, G=north, B=up) the BLUE (up) is toward world-north, not overhead; the
   atmosphere gradient runs sideways ("flip it on its side" — owner). Ray reconstruction variants
   `raymode = 0..8` (matrix transposes + NDC swap/negate/rotate) do NOT fix it, so it is NOT a
   simple NDC roll. Strong suspicion: a **view-space axis-convention** mismatch (AC render/view
   space Z-up vs the reconstruction assuming Y-up, or the camera up-vector), which NDC tricks can't
   correct. Next: audit `invView` / the AC→view convention; try a raymode that remaps the AC-space
   axes of the reconstructed ray (put up in the right slot); `raymode 9` (SV_Position) was not yet
   tried. `AcmeRedline/Lib/Projection.cs` is the verified forward-projection reference.

2. **Hard seam in the atmosphere, absent from the ray-viz → it's in the SCATTERING MATH.** The
   real sky (`output=0`) shows a sharp line splitting it into two very different colors at EVERY
   raymode; the ray-viz (`output=4`) has NO seam. So the seam is NOT in the ray reconstruction —
   it is a discontinuity inside the Bruneton scattering (audit `GetScatteringTextureUvwzFromRMuMuSNu`,
   the nu/mu computation, the `intersectsGround` branch, the mu_s clamp, or the 4D→3D nu-slice
   packing of the scattering texture; also any atan2 azimuth wrap). Fix this independently of #1.

### 2.5 Live tuning is via a FILE, not env vars
Injected acclient does NOT inherit the launcher `.bat`'s env vars (verified). All AcmeSky knobs
live-reload from **`C:\Temp\acdt\sky.cfg`** once/second (template
`AcmeSky/assets/sky/atmosphere/sky.cfg.example`). Keys: `output` (0=real atmosphere, 4=AC ray-viz,
5=shader ray-viz), `raymode` (0..9, table in sky.cfg.example), `axis` (AC→shader, default
`x,z,-y`), `time` (0..1), `exposure` (default 5). The per-frame `acmesky: LIVE frame …` log prints
live rayMode/output/axis + sample pixels read from the actual RT (use it, not screenshots).

### 2.6 Client clock is stuck → sky forced to noon
`ClientState.GetTimeOfDay()` reads `present_time_in_day_unit` and returns 0 (offset unresolved),
pinning the real clock at midnight. Code falls back to midday (`t<=0 → 0.5`) so the atmosphere is
daytime. Real day/night needs the GameTime offset fixed (or set `time=` in sky.cfg). Not blocking.

---

## 3. Chorizite plugin infrastructure — durable learnings (both plugins)

These were the hard-won unlocks; re-use them for any future acclient plugin:
- **Ship `Chorizite.ACBindings` WITH the plugin** (`ProjectReference … Private="true"`, NOT
  `ExcludeAssets="runtime"`). The host loads Core/Reloaded/Autofac but NOT ACBindings; if it's
  absent from the plugin's `.deps.json`, the ALC throws FileNotFound at runtime even though the
  dll sits in the folder. Same rule for Vortice.* (AcmeSky).
- **Detour ABI**: `[Function(CallingConventions.MicrosoftThiscall)]` delegate with **`nint`**
  pointer params (ACBindings struct-pointer params fail Reloaded's reverse-wrapper reflection),
  impl `[UnmanagedCallersOnly(CallConvs = { typeof(CallConvMemberFunction) })]` — **MemberFunction,
  NOT Thiscall** (Thiscall delivered garbage args and crashed). Recover the struct pointer by cast
  inside the body.
- **Ship `FASM.DLL` + `FASMX64.DLL`** (Reloaded's x86 trampoline assembler): reference Reloaded
  `ExcludeAssets="runtime"` (bind host's managed dll) but NOT `native` (do ship FASM).
- **Native-detour thread can't LOAD an assembly** (`0x80131509`): eager-load ACBindings +
  `RuntimeHelpers.PrepareMethod` the detour hot path in `Initialize()` (see `WarmupAcBindings`).
- **Env vars set in the launcher bat do NOT reach acclient** → use a live-reloaded config file.
- **Install hooks DIRECTLY in `Initialize()`**, not via `IChoriziteBackend.Invoke` (its
  `_invokeQueue` isn't drained in the injected client — AcmeSky's hook silently never installed
  until this was fixed).

### The 1070 injection/test rig (owner's GTX-1070; owner powers it on)
- Headless inject: `C:\Temp\acdt-inject.bat` runs `AcmeInject.exe` (x86 net8 console P/Invoking
  `LaunchInjected` from `Chorizite.Injector.dll`), launching `D:\ac-dat-test\acclient.exe -h
  100.116.47.66 -p 9000 -a tailnet1 -v tailnet1 -rodat off` with the plugins. Task `acdtinject`.
- **Single-login**: kill acclient/AcmeInject, wait ~40–70 s for the ACE session to clear BEFORE
  re-injecting, or you get a double-login "Account In Use" → crash/kick.
- Enter world: client auto-authenticates to char-select; task `acdtvclick2` clicks ENTER
  (fractional 0.43, 0.655). In-world ≈ 900 MB+ WS; char-select ≈ 130–400 MB.
- Deploy: `scp` the rebuilt `AcmeRagdoll.dll` / `AcmeSky.dll` (+ deps.json, LUTs, sky.cfg) to
  `C:\Games\Chorizite\plugins\{AcmeRagdoll,AcmeSky}\`; plugins load on the next inject (dll on disk
  doesn't affect a running session). Chorizite log: `C:\Games\Chorizite\data\logs\log.txt`.
- **Screenshots (`acdtcap`→`C:\Temp\acdt\sky.png`) go STALE within a session** — GDI can't grab
  the live D3D9 backbuffer, so it returns a frozen frame; they only differ across reinjects. Rely
  on the OWNER's eyes or the per-frame sample-pixel log for live tuning.
- Build (memory-safe, single project): `DOTNET_ROLL_FORWARD=LatestMajor
  /home/wbterminal/.local/bin/dotnet build AcmeSky/AcmeSky.csproj -c Release` (likewise AcmeRagdoll).
- The pre-existing `RmlUi / AC Client Interface / Plugin Manager UI` init errors in the log are the
  Chorizite 0.0.18 `get_Renderer` mismatch (other bundled plugins), NOT ours.

### AcmeInject
The x86 injector console lives in the scratchpad, deployed to `C:\Games\Chorizite\AcmeInject.exe`.
If it needs rebuilding: net8.0 x86 console P/Invoking `LaunchInjected(command_line,
working_directory, EntryPointParameters* {version=1,flags=0,dll_path=injector,entry_point="Bootstrap"},
1)` from `Chorizite.Injector.dll`.

---

## 4. Remaining work (this workstream + the DAT line)

### Plugins (this workstream)
1. **AcmeSky sky fixes (§2.4)** — the up-axis rotation AND the scattering seam. Highest priority
   to make the atmosphere shippable.
2. **AcmeSky M2/M3** — port takram clouds (M2) and Yale stars (M3) per the porting spec, after the
   atmosphere is correct.
3. **AcmeSky clock** — fix `GetTimeOfDay` (`present_time_in_day_unit` offset) for a real day/night
   cycle (currently forced to noon).
4. **AcmeRagdoll variety** — the ~25-deaths-per-class pass (deferred by owner).

### DAT line (from HANDOFF-2026-08-21-r10.md §"Loose ends" + hedonic PLAN §Phase 4)
- **4.P4 sample eye-test STILL PENDING** — the r10 subdiv-creature close-range check on
  `@create 7` Drudge / `@create 8` Mosswart / `@create 49051` Grievver. NOTE: those first two are
  exactly the creatures killed for ragdoll this session, so IF the 1070's
  `D:\ac-dat-test\client_portal.dat` was the r10 portal, the subdiv parts were incidentally on
  screen — but that was NOT verified here, so treat the formal 4.P4 eye-test as still open (needs
  the r10 portal copied to `D:\ac-dat-test\client_portal.dat` from
  `/mnt/wbterminal2/fill-2026-08-20/r9/client_portal.r10work.dat`, sha-checked). Then r10 → kit
  assembly (`assemble_kit.sh --tag r10`).
- **Regression fixes committed this session** (part of the r10/hedonic creature lanes):
  `creature_scaleout.py` + `creature_tranche.py` — big-head guard (PN tessellation bulges convex
  parts; `BULGE_TOL 0.10` reverts to facet_op if the drawn bbox grows >10%) + removed the unsafe
  `--compress` on server-read GfxObj (vanilla ACE has no record decompression → boot crash);
  `fill_import.py` + `highres_lane.py` — INDEX16 (paletted) textures upscaled by per-index nearest
  replication only, hard-guarded against RGBA-resample+requantize (which breaks recolor/transparency).
- **Hedonic Phase 4 remaining**: 4.P3 env re-cut (orientation veto + wider WALL_CLASSES;
  `PREP-envgeo-recut-lineage-2026-08-20.md`); 4.H1 creature/monster texture project (INDEX16
  depalettize + ClothingTable recolor — related to the INDEX16 fix above); dungeon-geometry
  backlog (6,236 wall clusters); 4.H4 selective 4096² (blocked on a view-distance input); icon
  probe; `replaceDrawing` WBT change (~5×→4× subdiv byte cost). Full ranking in the hedonic PLAN §2.

---

## 5. State at handoff
- **Owner closed the client.** The 1070 has the plugins deployed at
  `C:\Games\Chorizite\plugins\{AcmeRagdoll,AcmeSky}\`, `C:\Temp\acdt\sky.cfg` present (last set
  `output=0 raymode=8`), inject rig intact. `C:\Temp` was migrated to `D:\Temp` earlier (owner did
  it; the inject scripts still write `C:\Temp\acdt\` which exists and works).
- **ACE (laptop)**: was serving the r10work pair per the r10 handoff; unchanged by this session
  (plugin work is client-side only). Ragdoll/sky do not touch server or dats.
- **Repo**: this session's work committed on `integ/all-20260813` and pushed (AcmeRagdoll,
  AcmeSky, docs/sky-port, the 4 regression-lane scripts, this handoff).
- Do NOT confuse this with the DAT lineage: AcmeRagdoll/AcmeSky are additive client plugins; they
  change nothing about r9/r10 dats or the ACE server.
