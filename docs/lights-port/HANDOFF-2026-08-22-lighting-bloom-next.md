# HANDOFF — AcmeLights next phase: dynamic lights (P3), selection (P4), bloom redesign (P5)

## UPDATE 2026-08-22 (later) — P5 BLOOM SHIPPED + LIVE-VALIDATED (zero-detour redesign)

The bloom redesign is DONE and eye-validated on the 1070. The fix was neither (A) nor (B): the
research doc's "zero-detour option" won — `SmartBox::m_renderingCallback`, the client's own
`void(__cdecl*)()` slot at **SmartBox+276** (instance via ACBindings static `SmartBox::smartbox`
@0x0083DA58), invoked at the tail of RenderNormalMode right after the final FlushAlphaList: the
exact post-3D/pre-UI boundary, scene open, 3D viewport current — and NO trampoline at all.
`Services/RenderCallback.cs` owns the slot; the UpdateLightsInternal heartbeat re-asserts the
pointer once per frame (SmartBox::Reset zeroes it on teleport/relog), and `bloom=0/1` live-toggles
install/clear. The unchanged BloomCompositor pipeline (StretchRect + bright/blur/composite inside
the open scene) runs indefinitely — the old ~1s fault really was the EndFrame cdecl trampoline
itself. Validated live: dungeon torch bloom + Holtburg portal glow, UI unbloomed, stable through
teleports (Reset re-assert proven), toggle returns byte-identical-modulo-flicker frames. A/B
captures taildropped to the owner. The `extrahooks=2` EndFrame mode is REMOVED from the code.
Also fixed two more `long.MinValue` throttle-overflow bugs (NativeHooks.LogSafe, BloomCompositor).
Bloom stays default-off in lights.cfg pending the owner's aesthetic verdict; knobs proven live
(threshold 0.55 / intensity 2.0 / radius 3 reads clearly at night; tune outdoors by day).
Remaining lanes: **P3** (torch-on quick win → object enumeration → spell/portal/glow lights),
**P4** (importance-ranked slot selection), env-geo 4.P3 walk eye-test.

## UPDATE 2026-08-22 (evening) — P3 torch-on BUILT + walk live-verified; lit-lantern eye-shot pending

`Services/TorchLights.cs` (cfg `torchlights`: 0 off · 1 light-unlit · 2 extinguish-diagnostic; default
0): a 4 Hz scan from the rendering callback walks **CObjectMaint::object_table** (the intrusive
LongHash of every live CPhysicsObj — chain via node+4, CPhysicsObj IS the node) and calls
`CPhysicsObj::set_lights(obj,1,0)` @0x005107C0 on anything whose CSetup has `num_lights` but
PhysicsState 0x800 unset. Live-verified at Holtburg: `torch-on scan 100 objs, 2 with setup lights,
lit 0` — walk + offsets correct, everything in view already lit. Hard-won facts:
- **SmartBox::num_objects/objects is VESTIGIAL** (only zeroed in Reset, never appended). Do not
  enumerate from it. m_pObjMaint is SmartBox+172; object_table at CObjectMaint+132; HashBase
  {table_mask@4, key_shift@8, buckets@12, table_size@16}. CPartArray: setup@84, lights@112
  (the research doc's +0x2C sketch was WRONG — PDB wins).
- **PrimD3DRender::UpdateLightsInternal STALLS when the scene's light set is static** (observed:
  a near-lightless cell froze it for minutes while EndScene kept firing). Anything that must run
  per-frame (cfg reload, slot re-assert) now ALSO lives in the rendering callback, which fires
  every in-world frame unconditionally.
- **ACE defaults `LightsStatus ?? false`** (WorldObject_Networking.cs:646): weenies lacking the
  bool AND the 0x800 bit in their PhysicsState int ship DARK even with setup lights. Confirmed
  candidates: Lantern wcid 42227/42236/42245 (setup 0x020001BC: warm 250/215/156 light,
  intensity 100, falloff 3), spawned in Society Stronghold Basement (8A03).
- **8A03 Society Stronghold Basement renders BLACK on the D:\ac-dat-test client** — the cell never
  draws (RenderNormalMode's callback never fires there, so neither bloom nor the scan run; likely
  the env-geo test dats lack the cell). The chat rig still works there — that's how we escaped.
  Don't use it for eye-tests; the char logs back in wherever it was left.
- **The remaining P3-quick-win validation** (one command, blocked when the owner went active at
  ~10:18): at Holtburg with `torchlights=1`, `@create 42227` via the chat rig → the log should
  say `lit 1` and the framedump should show a warm lantern glow. `torchlights=2` should then
  extinguish Holtburg's two lit lamps (symmetric proof). Rig gotcha: `acdt-schat.ps1` ABORTS
  when the box user is active (ABORT-USER-ACTIVE in schat.log) — always check schat.log, and
  probe idle first via `schtasks /run /tn acdtidleq` → `C:\Temp\acdt\idle.txt`.
- Sequence bring-up cost: every plugin change = taskkill acclient → deploy DLL → **wait ~150 s**
  for ACE to drop the session → acdtinject → 45 s → acdtvclick2 (clicks ENTER at char select;
  the client auto-selects the last character) → refresh pid.txt.

Written 2026-08-22. Continues `PLAN-2026-08-22-acmelights.md` + the two research reports in
this dir (`research-holtburger-lighting.md`, `research-retail-light-machinery.md`,
`research-bloom-hook-point.md`). All work is on `integ/all-20260813`.

## UPDATE 2026-08-22 (late) — capture rig proven, bloom crash isolated, P0-P2 seen live

Live session on the freed 1070 produced key findings (folded into the sections below):
- **P0-P2 VISUALLY CONFIRMED** in a dungeon (Krau Li's Labyrinth): static torch pool populates
  (4 then 15 wall-torch lights), dungeon ambient 0.20, `indoorSun` flips to 0 indoors, flame
  flicker active. Two 1080p torch-lit-corridor captures taildropped to the owner.
- **The backbuffer CAPTURE RIG WORKS** and is committed (`Services/DumpService.cs`): a
  `RenderDeviceD3D::EndScene` @0x005A0E10 POST-hook does `GetRenderTargetData(backbuffer ->
  D3DPOOL_SYSTEMMEM surface)` -> 32bpp BMP to `C:\Temp\acdt\framedump-N.bmp`. The scene is
  CLOSED at EndScene so the readback is legal. Enable with `dump=1` + `extrahooks=1`. Pull with
  scp, convert BMP->PNG, `tailscale file cp ... redmi-note-13-5g:`.
- **The bloom crash is the `SceneTool::EndFrame` cdecl(byte) DETOUR itself**, not the StretchRect
  and not state restore. Proof: `extrahooks=0` (P0-P2 only) is stable indefinitely; `extrahooks=1`
  (adds only the EndScene thiscall detour) is ALSO stable and drives the capture every frame;
  bloom (which adds the EndFrame detour) dies ~1s after frame 1. So the EndScene thiscall trampoline
  is fine but the EndFrame cdecl-with-byte-arg trampoline destabilizes the client. **Redirect the
  bloom redesign: run the bloom passes from the EndScene hook (scene closed -> StretchRect legal
  too), NOT EndFrame.** But note EndScene runs AFTER the UI in this client, so to bloom only the 3D
  scene, capture the world at EndScene of the WORLD pass, or bracket your own EndScene/BeginScene —
  see the bloom section, option (A), now the clear front-runner.
- **Ops lessons**: (1) the DumpService throttle used `long.MinValue` init -> `now - MinValue`
  overflows negative -> throttle never passes -> silent no-op (same bug fixed in AcmeSky; use
  `-Stopwatch.Frequency`). (2) Repeated force-kill injects leave MULTIPLE zombie acclient
  processes AND ACE ghost sessions -> "Cannot have two accounts logged on". Fix: `taskkill /im
  acclient.exe /f` (kills ALL), verify zero, wait ~150s for ACE to drop the ghosts, then ONE
  inject. Refresh `C:\Temp\acdt\pid.txt` with the live PID before the chat rig. (3) `@telepoi`
  names must be exact (`Green Mire Grave` was rejected); `@teleloc <cell> <x> <y> <z> [q]` from an
  LSD spawnMap coordinate is reliable (LSD `spawnMaps/*.json` -> `value.weenies[].pos`).
  (4) first-person `.` toggle via SendInput needs ext=false (the acdt-tilt.ps1 hardcodes ext=true
  for PageUp; it did not toggle — fix the scancode/ext for a first-person shot).

## Where things stand (do not redo)

- **AcmeLights P0–P2 SHIPPED + live-validated on the 1070** (plugin `AcmeLights/`): two inline
  detours — `PrimD3DRender::UpdateLightsInternal` @0x0059BEE0 (per-frame heartbeat) and
  `SmartBox::SetWorldAmbientLight` @0x004530E0 (ambient funnel). Working, default-on:
  raised pools (max_static 60 / max_dynamic 10), holtburger flame-flicker on warm point lights,
  retail ambient red-bias fix, dungeon-ambient override, viewer headlamp (cfg `headlamp`).
  19k+ frames, zero crashes. Live config `C:\Temp\acdt\lights.cfg` (1/s reload; keys in
  `Lib/LightsConfig.cs`). All addresses via ACBindings statics (map-build-correct).
- **P5 bloom BUILT but SHELVED (default off)** — see the bloom section below for the exact blocker.
- **P3 / P4 NOT STARTED.**
- **env-geo 4.P3** is a separate lane, automated gates all green (see
  `docs/dat-patch/reports/envgeo-recut-2026-08-22.md`); its only open gate is the 1070 walk eye-test.

## The validation rig now available (owner-confirmed 2026-08-22)

- **1070 is free to use** for full-screen, real-GPU sessions (not just off-screen).
- **Teleport to exact coords**: `@teleloc <cell> <x> <y> <z> [qw qx qy qz]` (same number order as
  `@loc`; cell hex ±0x). `@telepoi <POI|list>` for named towns/dungeons. Driven via the chat rig:
  write the line to `C:\Temp\acdt\chat.txt`, refresh `C:\Temp\acdt\pid.txt` with the live acclient
  PID (schat reads it; it goes stale across sessions — this bit us), then `schtasks /run /tn acdtschat`
  (focus + SendInput). tailnet1 = Developer so admin commands work.
- **First-person camera**: the `.` key toggles first person — send it via a key-hold task
  (`C:\Temp\acdt-tilt.ps1` pattern, or a one-shot SendInput of VK_OEM_PERIOD 0xBE). Reason about
  where the character stands relative to the phenomenon (torch on a wall, portal, caster) and
  teleport so it's in frame; first-person removes the third-person avatar from the shot.
- **Taildrop to the owner's redmi**: `tailscale file cp <files> redmi-note-13-5g:` (device is on the
  tailnet; PNG works). Convert BMP→PNG with PIL first.
- **Capture is the open problem**: GDI screenshots return a FROZEN backbuffer for a D3D9 client
  (memory §chrome/1070). AcmeSky solved this by reading back its OWN D3D11 RT. AcmeLights changes
  the CLIENT's render, so a capture must read back the client backbuffer. **The safe readback point
  is a `RenderDeviceD3D::Flip` @0x005A0F60 ENTRY hook** (scene already EndScene'd in EndFrame, so
  `GetRenderTargetData(backbuffer → D3DPOOL_SYSTEMMEM surface)` is legal there — unlike inside the
  open scene). Add a `dump=1` cfg that, on the Flip hook, GetRenderTargetData's the backbuffer to a
  cached sysmem surface, LockRect, and writes a rotating BMP to `C:\Temp\acdt`. This same hook is
  ALSO the natural home for the bloom redesign (see below).

## P5 bloom — the blocker and the redesign

**What's built** (`AcmeLights/Services/BloomCompositor.cs`, `BloomShaders.cs`, `Lib/D3D9.cs`,
`Lib/Device.cs`, `Lib/ClientState.cs`): hook `SceneTool::EndFrame(bool)` @0x0043FCD0 (cdecl, entry —
post-3D, pre-UI); ps_2_0 bright-pass + separable-gaussian blur + additive composite; runtime HLSL
compile via Vortice.D3DCompiler. Two real bugs already fixed and worth remembering:
1. **0x80131509 ALC-load fault** — Vortice.D3DCompiler cannot be *loaded* on the native detour
   thread. FIXED by precompiling the shader bytecode on the managed thread in `Initialize()`
   (`BloomCompositor.PrecompileShaders`), detour only calls `CreatePixelShader(bytes)`.
2. **Pixel-shader vtable slots were off by one** — correct D3D9: CreatePixelShader=106,
   SetPixelShader=107, SetPixelShaderConstantF=109 (105 is GetIndices). Fixed in `Lib/D3D9.cs`.

**The blocker**: the pipeline executes ONE frame correctly (trace: CreateStateBlock → StretchRect
hr=0 → bright → composite → "RenderBloom returned ok", client alive through frame 1), then the
client faults within ~1 s — through BOTH manual state restore AND a full `D3DSBT_ALL` StateBlock
apply. Because a complete state restore does not help, the fault is **not** render-state. Leading
suspect: **`StretchRect` (backbuffer→texture) is illegal inside the client's open
`BeginScene`/`EndScene` pair** — `hr=0` at call time, but the driver faults at `Present`. At
`SceneTool::EndFrame` entry the scene is still open (BeginScene ran in `StartFrame`; EndScene runs
near the *end* of EndFrame).

**Redesign options (pick one, validate with the dump rig + eyes):**
- **(A, recommended) Move the whole pass to a `RenderDeviceD3D::EndScene`-adjacent point where the
  scene is closed.** Hook EndScene @0x005A0E10 (same one Chorizite overlays at) at ENTRY: at that
  moment the world+? — CAUTION: EndScene in this client runs AFTER the UI (RenderUI::RenderObjects
  is earlier in EndFrame), so bloom there would bloom the UI too. To bloom only the 3D scene you
  need a closed-scene readback of the world BEFORE the UI. So: **hook EndFrame entry only to
  `GetRenderTargetData`/StretchRect-free CAPTURE is still in-scene** → same restriction.
  The clean fix is to **`EndScene()` yourself at EndFrame entry, do the bloom passes (scene closed →
  StretchRect legal), then `BeginScene()` again** before calling OriginalFunction (which draws the
  UI and its own EndScene). Test that an extra EndScene/BeginScene pair is tolerated (it usually is).
- **(B) Render-to-texture from the start**: hook `SceneTool::BeginScene`/`StartFrame`, redirect RT0
  to a plugin texture for the whole 3D pass, then at EndFrame composite it back with bloom and let
  the UI draw to the real backbuffer. More invasive; most correct; avoids StretchRect entirely.
- **(C) Use `GetRenderTargetData` to a sysmem surface + upload to a texture** instead of StretchRect
  — but GetRenderTargetData has the same in-scene caveat; only helps if paired with (A)'s closed scene.

Ship bloom default-off until one of these is eye-validated. Knobs already wired: `bloom`,
`bloomthreshold`, `bloomknee`, `bloomintensity`, `bloomradius`. The `Trace()` crash-surviving file
(`C:\Temp\acdt\bloomtrace.txt`, first 4 frames) is invaluable for the next attempt — keep it.

## P3 — dynamic lights for spells / portals / projectiles / glowing creatures (the headline)

Neither retail nor holtburger creates lights for these (they use emissive + bloom). So P3 is NEW
content. The retail machinery to use (all in `research-retail-light-machinery.md`):
- **Inject via a `SmartBox::set_viewer` @0x00452C80 POST-hook** — it runs after the per-frame
  dynamic-light wipe+refill, so appending `Render::add_dynamic_light(&LIGHTINFO, cellId, &frame)`
  per tracked object survives exactly one frame and re-adds cleanly (correct lifetime, no leak).
  Raise `max_dynamic_lights` (already done, =10) to budget them. `Frame::cache()` on every
  injected LIGHTINFO is MANDATORY (see CreatureMode::AddLight reference).
- **Object enumeration is the missing research** — the next session must map how to walk the
  client's visible-object set and classify: portals (setup-id table; purple ~0x8060FF), war-spell
  projectiles in flight (missile/spell-projectile setups; color by school), spell impacts
  (brief 300–500 ms decaying light on PlayScript/impact), glowing creatures (wisps/Virindi/Shadow
  fragments by setup id). Start from CObjectMaint / the physics-object hash; cross-ref
  `research-retail-light-machinery.md` §4 (PhysicsState 0x800 LIGHTS_ON, SetLightHook) and the
  wcid/setup tables in `$LSD`. **This needs an Explore pass + live eye-tuning** (do the colors and
  associations look right) — exactly what the freed 1070 + first-person capture rig is for now.
- Cheapest first win to prove the path: **turn on existing wall-torch DAT lights** that ship unlit —
  `CPhysicsObj::set_lights(obj,1,0)` @0x005107C0 (or PhysicsState |= 0x800). Instantly lights every
  torch whose Setup has num_lights, with zero new content, and validates the whole add-light loop.

## P4 — better per-draw selection (optional, after P3)

Replace `Render::minimize_object_lighting` @0x0054E090 (clean `void()` cdecl) with importance-ranked
top-8 (score = attenuated intensity at object center) instead of first-8-overlap; optionally enable
per-light specular + spot penumbra via a `config_hardware_light` @0x0059BD40 post-hook. Static
wall-torch FLICKER also lands here (owning the slot selection lets us drop the carryOver bit so the
per-frame Diffuse edits reach D3D without needing the unverified `lightCacheing` global).

## First concrete steps for the next session
1. Add the `dump=1` Flip-hook backbuffer capture (safe, closed-scene GetRenderTargetData) — unblocks
   ALL visual validation and gives taildrop media.
2. Capture P0–P2 working (teleport to a torch-lit dungeon, `.` first-person, dump, taildrop) to
   confirm flicker + ambient look right — the one validation still owed on the shipped features.
3. Bloom redesign (A): EndScene/BeginScene-bracket the passes at EndFrame entry; capture; taildrop.
4. P3: torch-on quick win → object-enumeration Explore pass → spell/portal/glow taxonomy → tune.

## Key files
`AcmeLights/AcmeLightsPlugin.cs`, `Services/{LightManager,NativeHooks,BloomCompositor,BloomShaders}.cs`,
`Lib/{LightsConfig,LightsSettings,AddressResolver,D3D9,Device,ClientState}.cs`. Deploy set +
config in `AcmeLights/README.md`. Chat/teleport rig tasks on the 1070: `acdtinject`, `acdtvclick2`,
`acdtschat` (+ `acdt-schat.ps1`, needs fresh `pid.txt`), `acdttilt` (`acdt-tilt.ps1`, key-hold).
