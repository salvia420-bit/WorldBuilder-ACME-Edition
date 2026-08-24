# Installer / launcher design decisions — 2026-08-24

Owner decisions this session, recorded so the eventual installer build has a spec
and the packaging change is tracked against `docs/dat-patch/community-norms.md`.

## Decisions

1. **The plugin pack ships INSIDE the single release archive** — not a separate
   download. The dats + patcher + launcher + the Acme plugin pack are one
   download. Installing the plugin pack stays optional (don't copy the plugin
   folder / launch with the plain launcher = stock client), but it is present in
   the archive.
2. **Linux is terminal** — no GUI. The paste-ready command flow in
   `INSTALL-LINUX-WINE.md` is the Linux experience; the tooling is scriptable
   shell + the Python patcher, not an Avalonia app.
3. **Both installers operate programmatically; the Windows one takes arguments.**
   The patcher/launcher must be drivable non-interactively (exit codes, flags,
   quiet mode) so it can be scripted, wrapped, or CI-checked — not only
   double-clicked. The Windows launcher accepts client arguments and passes them
   through (already true of `play.bat`).
4. Not called "YOLO mode." (An all-in-one convenience path is fine; the name is
   not.)

## Community-norms tension to resolve before release (owner call)

Bundling the plugin pack means the archive now contains **third-party binaries**,
which is precisely the thing the preservation dev community criticizes in other
people's installers. Enumerated from the reference machine (read-only survey,
2026-08-24):

- **Ours** (fine to ship): `AcmeLights.dll`, `AcmeSky.dll`, `AcmeRagdoll.dll`
  and their configs.
- **Third-party** (the sensitive set): the Chorizite runtime (`AcmeInject.exe`,
  `Chorizite.*.dll`), `FASM.DLL` / `FASMX64.DLL` (the flat assembler),
  `SharpGen.Runtime*.dll`, `Vortice.DirectX/D3DCompiler/Mathematics.dll` (.NET
  D3D bindings). None are Turbine/WB content — no retail-IP problem — but they
  are other projects' compiled output.

Two norms-clean ways to ship the plugin pack, for the owner to pick:

- **(A) Bundle with prominent provenance** (the owner's stated preference —
  "ships inside the same release archive"). Requirement to satisfy the
  criticism: a `THIRD-PARTY.md` / provenance manifest in the archive listing
  every non-Acme binary with its upstream project, version, license, upstream
  URL, and sha256, and `SHA256SUMS.txt` covering them. The point of the
  criticism is *opacity*, not convenience — full provenance answers it. Also
  requires .NET 8 Desktop Runtime on the player's machine (Chorizite is managed);
  either document the dependency or the launcher fetches it from Microsoft's
  official URL with a consent prompt (never bundle the MS runtime installer).
- **(B) Fetch Chorizite from its authentic upstream release on first plugin
  launch** (consent screen: name, version, source URL, published hash), shipping
  only the Acme DLLs in the archive. Maximally norms-clean, at the cost of a
  network step and a moving upstream. Kept here as the fallback if (A) draws
  pushback.

Default plan of record: **(A)** per the owner decision, gated on the provenance
manifest existing in the archive.

## Architecture (agreed shape, for when the launcher is built)

- **A launcher-configurator, NOT a resident service.** Two facts make a
  background process unnecessary: injection is *launch-time* (`AcmeInject.exe`
  spawns the client suspended, writes the bootstrap at the child's remote base,
  resumes — there is no attach-to-running, no persistence, nothing survives the
  session), and `lights.cfg` *hot-reloads at ~1 Hz inside the game*, so an
  external tool tunes live by writing the file and needs no hook into the running
  client. Close the launcher after starting the game and nothing is lost.
- **Injection is per-launch, not "once injected always injected."** Launch via
  the plain path = byte-stock client. Launch via the injector = plugins for that
  session only. There is deliberately **no mid-session un-inject**: the mirror
  diet's native detour is load-bearing once any mirror is freed, and unhooking
  live detours is exactly the crash class we spent this week eliminating.
  "Dismount" = relaunch without injection (a two-second operation). Mid-session
  *functional* disable already exists via the live knobs (and the startup-gated
  ones install nothing when 0 at boot).
- **Status / "green light" is cheap and honest.** The launcher knows which mode
  it launched, and the plugins self-report in `data/logs/log.txt`
  (`hook installed` ×N, `memgov probe OK`, `diet probe OK`, and
  `FAULT — self-disabled`). A log tail turns that into an honest indicator —
  "Injected · 8 hooks · diet active · 412 MB freed" vs "Vanilla", with an
  amber/red state on a `FAULT` line (more useful than a plain green dot). Prefer
  external file/log-based status over Chorizite's in-game PluginManagerUI, which
  currently throws a NullRef on init every session.
- **Dependencies come from authentic sources with consent, never bundled**
  (except our own code and, per decision A, the vetted third-party runtime with
  its provenance manifest): .NET runtime from Microsoft's URL; on Linux, wine and
  32-bit drivers via the player's own package manager (display the exact
  `apt`/`pacman`/`dnf` command, offer to run it); DXVK from its official GitHub
  release. The criticism is about opacity — show the player the name, source, and
  hash of everything before it lands.

### Suggested surface (one program, four tabs; active only when the player is
using it, never while they play)

Tab order (owner, 2026-08-24): **Play first** (used daily), then **Tune**, then
**Fix**, then **Install last** (used once).

| tab | does | when |
|---|---|---|
| play | pick which install(s) to launch, plain vs injected, per-plugin toggles, a per-PID status list (see multi-client below) | daily / at launch |
| tune | live `lights.cfg` knob editor, named profiles, "shipped defaults" / "stock" one-clicks | optional, live |
| fix | the doc troubleshooting ladder as runnable checks (exe verify, dat sizes, ini polarity, renderer string, log-tail with known-bad patterns) + rollback | when broken |
| install | verify kit (manifest + shas), patch the player's own exe(s), optional all-in-one convenience path (dependency fetch with consent) | once |

Windows: arg-driven so every mode is scriptable. Linux: the same operations as
shell + the Python patcher (already `--verify` / `--check-kit` / `--quiet` /
exit-code driven).

## Multi-client / ThwargLauncher (owner requirement: adapt to existing setups,
don't force a change)

Ground truth (2026-08-24): the exe byte-patches are a **static file patch** —
once an `acclient.exe` is patched it is patched for *every* launcher (a shortcut,
ThwargLauncher, our program). `AcmeInject.exe` is **spawn-injection**
(`CreateProcessW(CREATE_SUSPENDED)` → LoadLibraryW/Bootstrap via
`CreateRemoteThread` → `ResumeThread`), one client per invocation, taking
`--args`/`ACMEINJECT_ARGS` + client path; there is **no attach-to-running** path
today. `lights.cfg` resolves `ACMELIGHTS_CONFIG` → `C:\Temp\acdt\lights.cfg` →
`~/.acdt/lights.cfg` — a shared default with a per-instance env override already
available. Chorizite's `log.txt` is a **single shared file**.

This yields a clean two-layer split:

- **Universal layer = dats + exe patches. Launch-agnostic, so multi-boxing
  already "just works" with ThwargLauncher and every other tool** — because a
  patched exe stays patched no matter who launches it. Our program's only job
  here is *patch every `acclient.exe` the person uses*. The Install tab must:
  - accept **multiple install directories** (the redundant-dir topology) and
    patch each one's exe, and equally support **one install launched N times**;
  - offer to **read ThwargLauncher's configured install list** and patch each
    (opt-in), so a TL user changes nothing;
  - never assume a single canonical install path.
  This layer is the shipping-critical part and is fully compatible today.

- **Plugin layer = the only thing that needs the launch.** Because injection
  owns process creation, plugins reach only clients *we* (or AcmeInject) launch.
  A ThwargLauncher-launched client gets the full visual upgrade (dats + 4K +
  patches) but **not** plugins, unless one of:
  1. **Point ThwargLauncher at `AcmeInject.exe` instead of `acclient.exe`**
     (AcmeInject then spawns+injects the real client with TL's pass-through
     args). **VERIFIED viable 2026-08-24** against the TL source vendored at
     `/mnt/wbterminal2/vendor/ThwargLauncher` — see "ThwargLauncher launch
     mechanics (verified)" below. Adapts to their setup, least engineering. Needs
     a small AcmeInject change + is **mutually exclusive with TL's Decal
     injection** (both want process creation). The preferred path for non-Decal
     multi-boxers.
  2. **Our launcher multi-boxes injected clients itself** by invoking AcmeInject
     N times (each spawns its own). Works today; competes with TL rather than
     adapting to it — offer it, don't force it.
  3. **Attach-by-PID injection** (v1.5): add an attach path to AcmeInject
     (`OpenProcess` an existing client + the same LoadLibraryW/Bootstrap remote
     thread) so plugins can attach to a client launched by *anything*. This is
     the real "plugins for whatever you launched" answer; it needs a PID-picker
     and per-PID logging, and turns the launcher into an optional background
     helper for that use only.
  **DECISION (owner, 2026-08-24): option 3 only — one mechanism that covers
  everyone (single-box, multi-box, ThwargLauncher, Decal), because three parallel
  paths breed "it's not working" confusion.** The bar the owner set: it has to
  *actually* just work — "works sometimes" is worse than offering clear choices.
  See the attach-viability assessment below; it clears the critical architectural
  bar but has two residual risks to close before we bank on it.

### Attach-by-PID viability (assessed against Chorizite source, 2026-08-24)

**The critical unknown — does Chorizite tolerate attach to a running client, or
was it built to load at startup? — resolves in favor of attach.**
`Chorizite.NativeClientBootstrapper/StandaloneLoader.Init` →
`DirectXHooks.Init` (`Hooks/DirectXHooks.cs:53-55`) installs its hooks on
`RenderDeviceD3D::EndScene` and `…OnDeviceDisplayModeChange` **by byte
signature** (`CreateHook<…>(…, "## 56 8B F1 …")`), i.e. on static client code
that exists from process start and is called every frame — it does **NOT**
intercept `Direct3DCreate9`/`CreateDevice` (a one-time startup event). The D3D
device pointer is captured *lazily* from the first `EndScene` after init
(`StandaloneLoader.Startup(unmanagedD3DPtr)`), and the WndProc hook installs
lazily on that first frame too (`DirectXHooks.cs:87`). Our own AcmeLights hooks
are the same shape (Reloaded.Hooks, signature/VA-located, on repeatedly-called
static functions). **So attaching to an already-running client initializes
Chorizite + the plugins on the next rendered frame, with the live device — no
startup event is missed.** This is what makes "one mechanism for everyone" real.

The code change is small: AcmeInject already does the hard part (LoadLibraryW +
base-aware Bootstrap via `CreateRemoteThread`). Attach swaps
`CreateProcessW(CREATE_SUSPENDED)` for `OpenProcess(<existing pid>)`; the
remote-thread injection is identical.

**Two residual risks decide "just works" vs "works sometimes" — neither is a
showstopper, but both must be closed before committing:**

1. **Live-patch race (TESTABLE — the make-or-break, must test before we bank on
   it).** Spawn-injection installs every prologue detour while the client's main
   thread is *suspended* (zero race). Attach installs ~10 detours (Chorizite's +
   ours) into a **live** render loop — patching a function prologue while the
   render thread is executing that function crashes. Whether Reloaded.Hooks
   patches safely on a live thread (it can suspend threads around the write) is
   the one thing we must **verify by testing an actual attach**, not assume. If
   Reloaded's live-patch isn't safe, the fix is known (suspend the render thread
   around hook install, or install from a hook-driven safe point), but we need
   the test to know whether that work is needed. This is the exact "does it just
   work" question and it is answerable on the fleet.
2. **AV/EDR blocking (ENVIRONMENTAL — inherent to all injection, can't be fully
   eliminated).** `OpenProcess`+`WriteProcessMemory`+`CreateRemoteThread` is the
   textbook injection signature; some players' security software will block it.
   This is true of the *current* spawn-injector too (attaching to a running
   foreign process is marginally more flagged than spawning your own child).
   Mitigations: code-sign the injector, and document an AV allowlist step. Honest
   bar: this will not be 100% on every machine — but it is the same exposure the
   plugin pack already has, not new to attach. The universal dats+patches layer
   has zero injection and is unaffected, so a blocked inject degrades to
   "full visual upgrade, no plugins," never to "broken game."

Also required (solvable, not risks): an **idempotency guard** (double-inject =
Chorizite loaded twice = crash; gate on a named mutex or a check that the
injector module isn't already present), and **per-PID logging** so multi-box
plugin logs don't interleave.

**Recommended next step before committing code:** a minimal attach prototype —
add an `--attach <pid>` path to AcmeInject, launch a client the plain way
(mimicking TL/Decal), attach, and confirm it initializes cleanly and repeatably
without crashing the render loop. That single test closes risk 1 and tells us
whether the "just works" bar is met as-is or needs the thread-suspend refinement.

### ThwargLauncher launch mechanics (verified against source, 2026-08-24)

Vendored read-only at `/mnt/wbterminal2/vendor/ThwargLauncher`
(`ThwargLauncher/ThwargLauncher/GameLaunching/GameLauncher.cs`,
`MainWindow/MainWindow.xaml`):

- **TL has a single user-set "AC Client File Location" field**
  (`ClientFileLocation`, a free path chosen via a file-browse dialog —
  `MainWindowViewModel.cs:670 ClientFileLocation = dlg.FileName`). It defaults to
  `acclient.exe` but the user can point it at **any exe**. So option 1 is
  genuinely available — no TL modification needed.
- **How TL launches** (`GameLauncher.cs:130-157`): `ProcessStartInfo` with
  `FileName = <ClientFileLocation>`, `Arguments = <generated>`,
  `WorkingDirectory = Path.GetDirectoryName(FileName)`. For an **ACE** server the
  generated args are exactly `-a <account> -v <password> -h <address> -rodat
  on|off` (`GameLauncher.cs:101`). (GDLE differs: `-h <ip> -p <port> -a
  <acct>:<pw> -rodat …`.)
- **The change AcmeInject needs** (currently `Program.cs` reads client args only
  from `--args`/`ACMEINJECT_ARGS`/cfg/`DefArgs` and ignores single-dash argv, and
  `DefClient` is a hardcoded dev path):
  1. **Pass-through argv** — treat any argv tokens that aren't AcmeInject's own
     `--`-flags as the client args to forward, so TL's `-a … -v … -h … -rodat …`
     reaches the real client. Clean split: AcmeInject flags are `--client
     --args --injector --workdir`; client flags are single-dash.
  2. **Default the client to `acclient.exe` next to AcmeInject's own exe** (or
     the working dir TL sets), not the `D:\ac-dat-test\...` dev default — so
     dropping `AcmeInject.exe` into the AC install folder "just works."
  3. **Resolve the Chorizite injector + runtime relative to AcmeInject's own
     directory** (`AppContext.BaseDirectory`), not the CWD — because TL sets CWD
     to the exe's folder, and the runtime must be found regardless of who
     launched.
- **Decal conflict (the real limitation):** TL can *itself* inject Decal
  (`GameLauncher.cs:145-155`, `ShouldWeUseDecal` → `LaunchInjected(… "DecalStartup")`).
  If a user has Decal enabled AND points ClientFileLocation at AcmeInject.exe, TL
  injects Decal into the *.NET injector process*, not the client — broken. So the
  point-TL-at-AcmeInject path **requires Decal OFF in TL**. Since a large share
  of AC players run Decal (mag-tools/Virindi/etc.), this makes **attach-by-PID
  injection (option 3) the right general answer for the Decal crowd**: let TL
  launch `acclient.exe` with Decal as usual, then attach our Chorizite plugins by
  PID afterward (native Decal + managed Chorizite coexist — different mechanisms).
- **`-rodat` gotcha for TL users:** TL's ACE branch emits `-rodat on` **or**
  `-rodat off` from the user's per-server setting. `-rodat off` is the
  writable-dat / DDD-repair bug we fixed by forcing read-only (see
  crash-investigation handoff). **TL users must set rodat to On.** (`-rodat on`
  should be equivalent to the `-rodat 1` our injector testing used; worth a
  confirm.)

Net: **option 1 is real for non-Decal multi-boxers** (small AcmeInject change,
no TL change); **option 3 (attach) is the general answer** and is the only way to
serve the Decal-using multi-box majority without making them drop Decal.

Multi-client hygiene items (regardless of the above):

- **Per-PID logging.** The shared `log.txt` interleaves and corrupts the
  green-light-from-log-tail approach with >1 injected client. Give each injected
  client its own log (PID in the filename) or prefix every line with the PID.
  Only matters for multi-box **with plugins**; plain multi-box writes no plugin
  log.
- **Status keyed off PID, not a single log.** The Play tab enumerates running
  `acclient.exe` processes and shows one row each: which install dir, patched?,
  injected?, diet active?/MB freed. For v1-without-attach the launcher knows the
  PIDs it launched injected; a plugin-published status (named pipe / shared
  memory / per-PID status file) generalizes it.
- **Shared `lights.cfg` is the right default** (tune once, all clients hot-reload
  within ~1 s). The existing `ACMELIGHTS_CONFIG` env already allows a
  per-instance profile (e.g. a bright "combat box" vs a minimal "crafting box");
  expose that in Tune as an advanced option, don't require it.
- **The memory diet is a multi-box SELLING POINT, not an afterthought.** N
  clients each carry ~1 GB working set; on a 1070-class 8 GB card the diet
  freeing ~400–500 MB *per client* is what makes 3–4-boxing viable. A 5090 user
  brute-forces it; the ~70% on 1070-or-better-but-not-5090 hardware are exactly
  who benefits. Surface "diet active, N MB reclaimed across M clients" in the
  status list.

## Non-negotiables carried from the crash/diet work

- Never add a mid-session un-inject or live detour-removal path.
- Keep `-rodat` on with the injector (dat self-repair off).
- The kit patchers must keep reproducing the canonical exe byte-for-byte
  (`check_ps1_table.py` GATE 2); any patch-set change re-runs that gate.
