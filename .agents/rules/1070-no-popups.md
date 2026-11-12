---
trigger: always_on
---

# Screen-Safety & Resource Rules: Dual Environment Profiles

## Profile A — Vast.ai Linux Cloud GPU Workstation (`linux` / `/workspace/wb`)
1. **Parallelism & Concurrency**:
   - Utilize all CPU cores (`mold`, `sccache` active): `CARGO_BUILD_JOBS=$(nproc)`, `HB_TEST_JOBS=$(nproc)`.
   - `heavy_lock.mjs` auto-scales child heap to 3072 MB on >=32 GiB systems.
2. **Headless EGL GPU Testing**:
   - Run tests on local NVIDIA GPU via headless Chromium (`--headless=new --use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --mute-audio --window-position=-32000,-32000`). Never use `--enable-logging`.
3. **Storage & Ephemeral Safety**:
   - NVMe is ephemeral. Run `/usr/local/bin/save-sccache-to-pool` before terminating instances.

## Profile B — Windows 1070 Box (`desktop-4anudo2`)
1. **Zero Screen Pop-Ups / Taskbar Flashes / Audio**:
   - A person uses this Windows GTX 1070 machine (`desktop-4anudo2`). Never allow any console, terminal, or browser window to pop up on screen or flash on the taskbar.
   - Always pass `-NoNewWindow` or `-WindowStyle Hidden` to `Start-Process`.
   - Always wrap interactive scheduled tasks (`schtasks /it`) with `wscript.exe //B //Nologo C:\tmp\hbbench\hidden-run.vbs <script.bat>`.
   - Launch test Chrome off-screen and muted (`--window-position=-32000,-32000 --mute-audio --user-data-dir=C:\tmp\hbbench\<profile>`), **never** pass `--enable-logging`, and always run `C:\tmp\hbbench\noflash.ps1` hidden to remove its taskbar button via `ITaskbarList::DeleteTab`.
   - Never kill the owner's browser (`taskkill /IM chrome.exe` is forbidden); use `C:\tmp\hbbench\hbbench-kill.ps1` to kill only `*C:\tmp\hbbench\*` Chrome processes. Never OS-mute the machine.
2. **One Heavy Job at a Time**:
   - Run at most ONE heavy job (full JS test gate `node harness/run-js-headless.mjs`, real-GPU Chrome session, or `dotnet build`) at a time across all agents.
   - Parallel subagents may run targeted single tests (`node test_x.mjs`) only.
3. **Storage & ACE Connectivity**:
   - Keep `C:` clean; write all temporary/scratch files to `D:\Temp` (junctioned at `C:\Temp`).
   - Connect to `wbterminal`'s ACE server via `bridge_url=ws://192.168.2.79:8080/` (or `ws://100.116.47.66:8080/`) with `server_host=127.0.0.1&server_port=9000`.
