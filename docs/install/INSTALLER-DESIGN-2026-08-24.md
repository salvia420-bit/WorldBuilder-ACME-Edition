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

### Suggested surface (one program, four modes; active only when the player is
using it, never while they play)

| mode | does | when |
|---|---|---|
| install | verify kit (manifest + shas), patch the player's own exe, optional all-in-one convenience path (dependency fetch with consent) | once |
| play | plain vs injected launch, per-plugin toggles (folder presence), green-light panel from the log tail | at launch |
| tune | live `lights.cfg` knob editor, named profiles, "shipped defaults" / "stock" one-clicks | optional, live |
| fix | the doc troubleshooting ladder as runnable checks (exe verify, dat sizes, ini polarity, renderer string, log-tail with known-bad patterns) + rollback | when broken |

Windows: arg-driven so every mode is scriptable. Linux: the same operations as
shell + the Python patcher (already `--verify` / `--check-kit` / `--quiet` /
exit-code driven).

## Non-negotiables carried from the crash/diet work

- Never add a mid-session un-inject or live detour-removal path.
- Keep `-rodat` on with the injector (dat self-repair off).
- The kit patchers must keep reproducing the canonical exe byte-for-byte
  (`check_ps1_table.py` GATE 2); any patch-set change re-runs that gate.
