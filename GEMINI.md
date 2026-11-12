# Antigravity Workspace Rules — `WorldBuilder-ACME-Edition` & `holtburger`

This repository operates under two distinct hardware and execution profiles. Identify your active environment (`process.platform === "linux"` vs `"win32"`) and adhere strictly to the corresponding profile.

---

## Profile A — Vast.ai Linux Cloud GPU Workstation (`linux` / `/workspace/wb`)
*Active when running on Linux / Vast.ai instances (e.g. 18–24+ CPU cores, 62+ GiB RAM, NVIDIA RTX GPU).*

1. **Host Concurrency & Full Native Parallelism**:
   - Utilize available CPU cores and high RAM: use `mold` linker and `sccache` (pre-configured via `/etc/profile.d/wb-dev-pool.sh`).
   - Set `CARGO_BUILD_JOBS=$(nproc)` (e.g. `-j20`) and `HB_TEST_JOBS=$(nproc)` (e.g. `--jobs=20` on `run-js-headless.mjs`).
   - Heap sizing: `heavy_lock.mjs` auto-scales `DEFAULT_TEST_HEAP_MB = 3072` on >=32 GiB hosts.
2. **Local GPU & Headless EGL Chromium**:
   - Local NVIDIA GPU is available (`/dev/nvidia0` + `/dev/dri/renderD128`).
   - Launch Chromium via headless EGL: `--headless=new --use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --mute-audio --window-position=-32000,-32000`.
   - Never pass `--enable-logging`.
3. **Persistence & Ephemeral NVMe Safety**:
   - Cloud NVMe storage is ephemeral. Always commit and `git push` to your branch/remote.
   - Run `/usr/local/bin/save-sccache-to-pool` to sync sccache artifacts and Playwright browsers to Google Drive (`gdrive:wb-dev-pool/bundles/`) before instance termination.

---

## Profile B — Windows `desktop-4anudo2` GTX 1070 Box (`win32` / `desktop-4anudo2`)
*Active when running on the Windows GTX 1070 laptop (Intel Core i7-7700HQ 4C/8T, 16 GB RAM, GTX 1070 8 GB VRAM).*

### 1. MANDATORY: Zero Screen Pop-Ups, Zero Taskbar Flashes, Zero Audio
- **A person uses this machine.** Nothing may ever pop up on the screen, flash on the taskbar, or play audio.
- **Subprocesses & PowerShell / Node**: Always pass `-NoNewWindow` or `-WindowStyle Hidden` to `Start-Process` and `windowsHide: true` to Node `child_process`.
- **Scheduled Tasks (`schtasks /it`)**: Never invoke a `.bat`, `cmd.exe`, or `powershell.exe` directly as a task action (it opens a visible console window). Always route through:
  `wscript.exe //B //Nologo C:\tmp\hbbench\hidden-run.vbs <launcher.bat>`
  (Verify all `hb*` and `wls*` tasks with `C:\tmp\hbbench\hide-tasks.ps1`).
- **Real-GPU Chrome (`C:\tmp\hbbench\`)**:
  - Always launch off-screen and muted: `--window-position=-32000,-32000 --mute-audio --user-data-dir=C:\tmp\hbbench\<profile> --no-first-run --no-default-browser-check --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows`.
  - **NEVER pass `--enable-logging`** (on Windows, `--enable-logging` pops up a visible console window).
  - Always run `C:\tmp\hbbench\noflash.ps1` hidden alongside test Chrome so `ITaskbarList::DeleteTab` removes the off-screen window's taskbar button before Windows can flash it orange.
  - Respect `C:\tmp\hbbench\hbgate.ps1` (`idle >= 900s`, `browsers == 0`, `gpu3d_other < 35%`, or `C:\tmp\hbbench\gate-owner-ok.txt` expiry when owner-requested).
  - **Kill ONLY our test Chrome**: run `powershell -NoProfile -ExecutionPolicy Bypass -File C:\tmp\hbbench\hbbench-kill.ps1` (filters `CommandLine -like '*C:\tmp\hbbench\*'`). **NEVER** `taskkill /IM chrome.exe` or `Stop-Process -Name chrome`. Never OS-mute the box.
- **Headless Playwright**: Always run with `headless: true` and `['--mute-audio', '--window-position=-32000,-32000']`.

### 2. Concurrency, Memory & Heavy-Job Limits (Adapted from Dell `wbterminal/CLAUDE.md`)
- **One heavy job at a time (`harness/lib/heavy_lock.mjs`)**:
  - Heavy = full JS gate (`node harness/run-js-headless.mjs`), `cargo build` / `cargo test` / `wasm-pack`, real-GPU Chrome session, or `dotnet build`.
  - Lock file: `%TEMP%\hb-heavy.lock` (`D:\Temp\hb-heavy.lock`).
  - Memory gate: requires **`>= 2,560 MB` (`2.5 GiB`, `HB_MIN_FREE_MB=2560`)** free RAM before starting; each JS gate child runs with `--max-old-space-size=1536` (`HB_TEST_HEAP_MB=1536`).
  - Rust builds: never run `--workspace`; always scope to `-p <crate>` with `-j6` (`CARGO_HOME=D:\.cargo`, `RUSTUP_HOME=D:\.rustup`, `CARGO_TARGET_DIR=D:\cargo-target`), and remove `D:\cargo-target` after large debug test runs.
  - Parallel subagents may read, edit, and run **targeted single tests only** (`node tests/x.test.mjs`). They must NOT launch browsers, run the full JS gate, or run builds. Put this rule and Rule #1 verbatim in every subagent prompt.

### 3. Paths, Toolchains, Storage & Network
- **Workspace root**: `D:\WorldBuilder-ACME-Edition` (also junctioned at `D:\Clones\WorldBuilder-ACME-Edition-master` and `D:\home\wbterminal\WorldBuilder-ACME-Edition`).
- **Holtburger web client**: `D:\WorldBuilder-ACME-Edition\external\holtburger\apps\holtburger-web`.
- **Baked dist**: `D:\hb-serve\dist\current` (`D:\hb-serve\dist\holtburger-dist-hires-bc7m-xu7t2`), junctioned into `external\holtburger\dist` and `apps\holtburger-web\dist`.
- **Toolchains on `D:\` (`0` cache on `C:\`)**:
  - `node` (`v18.12.0` primary for M3 gate) and `node20` (`D:\nodejs\node.exe` `v20.20.2` LTS for `film.mjs`).
  - `cargo` / `rustc` (`1.99.1` + `wasm32-unknown-unknown`) & `wasm-pack` (`0.15.1`) in `D:\.cargo\bin`.
  - `playwright-core` (`1.59.1`) in `D:\node_modules\playwright-core` (and junctioned at `D:\home\wbterminal\.npm\_npx\e41f203b7505f1fb\node_modules\playwright-core`).
  - `ffmpeg` (`8.0.1`) in `D:\home\wbterminal\bin\ffmpeg.exe` (`FILM_FFMPEG`).
- **Scratch & Storage Buffers**: `D:\Temp` (junctioned from `C:\Temp`; `D:\Temp\hbbench` -> `C:\tmp\hbbench`). Keep `C:` clean (`>= 15 GiB` free, `0` `.cargo`/`.rustup`) and `D:` `>= 440 GiB` (`>= 90%`) free.
- **ACE Server & WebSocket Bridge (on `wbterminal`)**:
  - `wbterminal` (`192.168.2.79` LAN / `100.116.47.66` Tailscale) runs ACE (`127.0.0.1:9000` / `:9001`) and `wsbridge` (`ws://192.168.2.79:8080/` or `ws://100.116.47.66:8080/`).
  - Local asset server: `py -3.13 D:\WorldBuilder-ACME-Edition\external\holtburger\scripts\serve.py --bind 127.0.0.1 --port 8765` (never use `--allow-missing` for visual/film gates).
- **WorldBuilder.Terminal**:
  - `dotnet D:\WorldBuilder-ACME-Edition\WorldBuilder.Terminal\bin\Release\net8.0\WorldBuilder.Terminal.dll --stdin`
