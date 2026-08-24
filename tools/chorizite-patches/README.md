# Chorizite patches

`external/chorizite/` is a **vendored, gitignored** copy of the Chorizite runtime
(built here, not tracked). Any change we make to it must be captured as a patch
in this directory so it survives a re-vendor and is reviewable.

Apply from the repo root: `git apply tools/chorizite-patches/<name>.patch`
(paths are relative to `external/chorizite/`).

| patch | what | proven |
|---|---|---|
| `dx-attach-init.patch` | drive Chorizite's one-time `Startup` (plugin load) from the per-frame `EndScene` hook, not only from `OnDeviceDisplayModeChange`'s first fire — so injecting into an ALREADY-RUNNING client (attach-by-PID: multi-box / ThwargLauncher / Decal) loads the plugins. `_didInit`-guarded, so the spawn-injection path is unchanged. | 1070, 2026-08-24 — full plugin parity with spawn (see `docs/install/INSTALLER-DESIGN-2026-08-24.md`) |
| `per-pid-log.patch` | `ChoriziteLogger` writes `log-<pid>.txt` instead of a shared `log.txt`, so multi-boxed clients don't interleave into one file (the launcher reads one client's log by PID). `AcmeLights/Lib/AsyncLog.cs` uses the identical name so both sets of lines land in the same per-client file. | builds clean; fleet log-separation test owed |
