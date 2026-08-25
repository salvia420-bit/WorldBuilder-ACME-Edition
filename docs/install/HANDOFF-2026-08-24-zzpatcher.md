# HANDOFF 2026-08-24 — z-z patcher (launcher/plugin-manager/tuner) + knob-preview rendering

Continues the ACME shipping push. This session built **z-z patcher** (`AcmeLauncher/`,
ships `zzpatcher.exe`) and started the live knob-preview. Everything is committed except the
ragdoll-preview WIP (committed WITH this handoff). Recent commits: `fcfac21e` down to
`fd397757`. Team model used: **1 Fable builder at a time, an Opus agent reviews/signs off,
orchestrator (main) fleet-tests on the 1070**. Owner granted multi-agent clearance for the
preview work.

## What z-z patcher IS (owner-settled this session)

A **plugin control panel + tuner + patcher — NOT a game launcher and NOT a login client.**
Rationale (owner): ThwargLauncher already owns login+multi-box and is community-trusted; the
owner is unknown to players, so asking for their AC password is a trust liability we don't
need. Our value (dat patches + plugins) needs no login. So z-z patcher:
- never launches the game, never handles server/account/password.
- attaches the ACME plugins to a client the player launched THEMSELVES (ThwargLauncher/Decal/
  shortcut), via the proven attach-by-PID path.
- tunes the plugin cfgs and manages which plugins run.
Four tabs (owner order): **Plugins · Tune · Fix · Install**.

## The injection backbone (SHIPPED, fleet-proven on the 1070)

- `AcmeInject.exe` (x86 .NET8) is the ONLY injection code; the GUI shells to it.
  - `--attach <pid>` attaches into an already-running client (option 3 — covers single-box,
    multi-box, ThwargLauncher, Decal). PROVEN: attaching a live in-world client loads all
    plugins (AcmeLights+Sky+Ragdoll), diet freed 402MB, stable, no live-patch-race crash.
  - Requires the Chorizite fix `tools/chorizite-patches/dx-attach-init.patch` (drive one-time
    `Startup` from the per-frame EndScene hook, not only the device-mode-change first fire —
    else plugins don't load on attach). `external/chorizite` is vendored+gitignored; changes
    are tracked as validated patches under `tools/chorizite-patches/`.
  - `--list` (Toolhelp enum, tri-state injected/plain/**unknown**), idempotency guard
    (fail-SAFE: unknown state refuses rather than risk a double-inject crash; retries
    ERROR_BAD_LENGTH), `--attach-all`, per-PID logging (`log-{pid}.txt` — a Chorizite patch
    `per-pid-log.patch` + AsyncLog). Exit codes 23 already-injected / 24 no-clients / 25
    attach-all-partial / 26 unknown-state-refused / 27 enumerate-failed.
- ThwargLauncher integration (verified against vendored source at
  `/mnt/wbterminal2/vendor/ThwargLauncher`): TL has a user-set "AC Client File Location"
  (any exe) and launches ACE with `-a <acct> -v <pw> -h <addr> -rodat on|off`. With attach
  (option 3) TL users change NOTHING — they launch as usual, z-z patcher attaches after.
  Design record: `docs/install/INSTALLER-DESIGN-2026-08-24.md`.

## Launcher state (SHIPPED, GUI+headless fleet-proven; `zzpatcher.exe` 71.7MB self-contained)

- **Code-only WPF** (no XAML — builds on this Linux box), thin shell over AcmeInject + file IO.
  Self-contained single-file publish pinned in csproj (`dotnet publish -c Release` →
  one exe, no .NET prereq).
- **Plugins tab**: intro "Launch AC the way you always do (ThwargLauncher, a shortcut, etc)…";
  running-client list (tri-state dots); "Enable plugins on selected" (gated to a plain
  selected client) + "Enable on all". **Available Plugins** box: per-plugin enable checkbox
  (Chorizite has no enable flag → enable/disable MOVES the folder between
  `<ChoriziteDir>\plugins\` and `plugins-disabled\`, effective next injection), Install
  (folder or .zip — zip-slip verified closed by .NET8 framework guard + extract-to-temp/
  copy-by-basename), Uninstall. Disabling OR uninstalling AcmeLights warns it carries the
  memory-crash protection.
- **Tune tab**: 147 knobs across three cfgs, split into **Lights/Sky/Ragdoll** nested sub-tabs
  (each own Filter + Reset-all; global Load-Recommended/Save/Load-profile). Metadata
  GENERATED from plugin source by `AcmeLauncher/tools/gen_knobs.py` → `Knobs.Generated.cs`
  (exact counts 84/35/28 fail-loud, so it can't drift). Simple uniform rows
  (name · value · min–max · default · reset). Owner paradigm: simple, offline-first.
- **Headless/scriptable**: `--list · --attach <pid> · --attach-all · --tune k=v` (cfg-routed;
  ambiguous names like `dump` require `sky.dump=`). Redirection-safe (GetFileType check so a
  WinExe's stdout reaches `> file`; do NOT AttachConsole when already redirected).
- **Fleet-proven**: `--list`/`--attach`/idempotency (exit 23), `--tune` routes to the right
  cfg with clamping/validation/color-hex/toggle, GUI renders all tabs, Tune 147 rows.
- ⚠ **cfg path = first EXISTING** of `<ENV>` → `C:\Temp\acdt\<cfg>.cfg` → `~/.acdt` (matches
  the plugins). A test that env-points at a NON-existent path still writes the existing
  `C:\Temp\acdt` file — this session accidentally clobbered the owner's `lights.cfg`
  `memlowmb` + added sky keys, then restored (memlowmb=1300). To test cfg writes without
  touching owner cfgs, PRE-CREATE the env-pointed files so they win resolution.

## Ragdoll live-preview — WIP (committed with this handoff; NOT yet Opus-reviewed)

Design: `docs/install/PREVIEW-DESIGN-2026-08-24.md` (excellent, grounded — READ §1.1 + §2).
Key insight: the ragdoll death fall **IS the plugin's own pure-C# physics sim**, so the
preview **compiles the same `AcmeRagdoll/Sim/*.cs` files in unchanged** → bit-identical fall.
No DATs at runtime; ~7 baked skeleton snapshots + the shipped 693 profiles.

- **Files**: `AcmeLauncher/Preview/{Preview.cs (IKnobPreview), RagdollPreview.cs}`,
  `tools/gen_preview_skeletons.py` (bakes via existing `tools/dat-patch/{datlib,motionlib}`,
  NO new DAT parsing), `preview_skeletons.json` (embedded; Drudge baked), csproj
  `<Compile Include="..\AcmeRagdoll\Sim\*.cs" Link=…/>` + `<EmbeddedResource>`, Ui.cs mounts
  it in the Ragdoll Tune seam driven by the existing `WriteAndCache`→`PushPreview` funnel.
- **WORKS (fleet-screenshotted + video taildropped to redmi)**: turntable stick-skeleton
  runs the real `RagdollSim` (Drudge), seeded from the baked death-beat pose, death-shaping
  knobs live, **replay-same-seed** + New-seed, idle bob (idleamp/idlehz), body picker, honest
  caption, 30fps DispatcherTimer that fully stops (0 CPU) when the tab's away. Builds +
  publishes clean.
- **GAPS (remaining vs §2)**:
  1. **Hit-spring layer NOT built** (the big one) → Hit/Walk modes + energy-pool bar missing;
     `springk/springdamp/pool*/gait*` knobs parsed but not visualized. Blocked on the
     OWNER DECISION below.
  2. Only Drudge (biped) baked — generator ready for the other 6 archetypes (Olthoi 0x02000F95
     is REQUIRED, it's what GaitMotion targets; Wisp/quadruped/avian/serpent/blob), each needs
     its Setup+death DIDs in `BODIES`.
  3. No explicit mode strip `[Auto|Idle|Hit|Walk|Death]` (currently auto Death→hold + idle).
  4. No Δ-ghost; PreviewHost mounted directly in the ragdoll seam (no shared GridSplitter/
     auto-follow across cfgs yet).
  5. **Framing polish** — the skeleton renders small and low in the pane; scale up + center.

### ⏳ OPEN OWNER DECISION (blocks Hit/Walk/pool)
The hit-spring math (`AcmeRagdoll/Services/LiveMotionRegistry.cs` Integrate 1134-1171,
PoolGain/VisualGain 1179-1192, pool decay, impulse-shaping) is welded to native pointers. Two
paths (owner to pick):
- **Transcribe** into `AcmeLauncher/Preview/SpringMotionMirror.cs` (source lines pinned in a
  header) — no plugin touch, but can drift. (Session default was "don't touch the plugin"; the
  builder did NOT transcribe it either, so it's stubbed.)
- **Refactor** the plugin: extract the pure pieces into `AcmeRagdoll/Sim/SpringMotion.cs`, have
  LiveMotionRegistry call it, link into the launcher (zero drift, plugin gains testability) —
  touches the shipped ragdoll plugin, NEEDS an in-game smoke test on the 1070.
Also open: does the stick-skeleton death-fall direction look right to the owner before
investing in completing spring modes + more skeletons + framing.

## Rendering roadmap (design doc §3/§4) — NOT started
- **Sky** (~2-3d): day/night gradient + noise clouds + stars in a small `WriteableBitmap`;
  quality/perf knobs (iters/res/steps/TAA) get an honest **cost meter**, not fake visuals.
- **Lighting** (~3-4d): ACViewer (MonoGame/GPL-3) too heavy to embed → hand-roll a 2.5-D
  dungeon-corridor lightmap: per-pixel intensity/d + retail Range clip + real flicker waveform
  + real bloom bright-pass/knee/blur, CPU in a `WriteableBitmap`.
- Shared: ONE `IKnobPreview` pane per Tune sub-tab, auto-follow the active cfg, zero new NuGet
  deps, <3% core animating / 0% stopped, pause when hidden. Ballooning traps named in §5
  (no real meshes/DAT textures, no volumetric port, no MonoGame).

## Fleet / ops notes (memory/fleet-runbooks.md is the canonical rig doc)
- 1070 = `<user>@<gpu-box-ip>`. **CHECK IDLE FIRST** (`schtasks /run /tn acdtidle` →
  `type C:\Temp\acdt\idle.txt`); a HUMAN uses it intermittently — at handoff an `acclient.exe`
  (pid 10512, not ours) appeared → human likely back, so DON'T run box tests until clear.
  Off-screen/headless discipline; D:\Temp for scratch; never taskkill their chrome/client.
- GUI test trick: scheduled task (`/it`) launches WPF into the interactive session;
  **UI Automation** (`AutomationElement.FromHandle` + `SelectionItemPattern.Select`) is the
  reliable way to switch tabs (pixel-clicks miss in the headless session). Inner Tune tabs are
  named "Ragdoll (ragdoll.cfg)" etc — match by substring.
- Animation capture: burst PrintWindow frames → ffmpeg (winget path
  `…Gyan.FFmpeg…\ffmpeg-8.0.1-full_build\bin\ffmpeg.exe`) → mp4 → `tailscale file cp <f>
  redmi-note-13-5g:` (phone asleep = "not replying, trying anyway" is fine).
- WinExe headless output needs the GetFileType redirection guard (see launcher notes).

## Immediate next steps
1. Owner: pick the spring-layer path + confirm ragdoll direction (above).
2. Opus-review the ragdoll-preview WIP once the spring layer + framing are in.
3. Complete ragdoll (spring modes/pool bar, more archetypes, mode strip, framing), fleet-video.
4. Then sky, then lighting (design §3/§4).
5. Packaging (not started): bundle plugin pack + zzpatcher into the release archive with
   `THIRD-PARTY-PROVENANCE.md` + per-file shas; clear the license-audit checklist
   (Reloaded.* possible copyleft, SixLabors.ImageSharp split-license) before shipping.
6. Player docs exist: `INSTALL-WINDOWS.md`, `INSTALL-LINUX-WINE.md` (both fact-checked;
   the kit patchers now ship all 9 exe patches incl. dat-align-lfa).
