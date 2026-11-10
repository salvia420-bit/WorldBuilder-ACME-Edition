---
name: holtburger-1070
description: >-
  Runbook and workflow for developing, benchmarking, and testing holtburger-web on the Windows GTX 1070 laptop (desktop-4anudo2) with zero screen pop-ups, zero taskbar flashes, muted audio, local SSD asset serving, and live ACE server connection to wbterminal. Use whenever running holtburger-web tests, real-GPU Chrome sessions, Playwright harnesses, or ACE network checks.
---

# Holtburger 1070 Runbook & Screen-Safety Skill (`desktop-4anudo2`)

This machine (`desktop-4anudo2`, Tailscale `100.127.215.75`, LAN `192.168.2.200`) is the owner's active Windows desktop with the fleet's real GPU (**NVIDIA GeForce GTX 1070**, Intel Core i7-7700HQ 4C/8T, 16 GB RAM).

## 1. The 4-Layer "Nothing Pops Up On Screen" Architecture (`C:\tmp\hbbench\`)

Whenever launching any browser, scheduled task, or background helper on this machine, **all four layers** of screen/audio isolation must be respected:

1. **Layer 1 — Console Suppression (`C:\tmp\hbbench\hidden-run.vbs`)**:
   - Windows Scheduled Tasks run with `/it` (interactive session, required for D3D11 GPU access) normally open a visible `cmd.exe` or `powershell.exe` window when their action is a `.bat` or `.ps1`.
   - Always invoke scheduled task actions via `wscript.exe` (a GUI-subsystem binary that never creates a console window) running `hidden-run.vbs`, which calls `WScript.Shell.Run("%ComSpec% /c ...", 0, True)` (`0` = `SW_HIDE`):
     ```cmd
     wscript.exe //B //Nologo C:\tmp\hbbench\hidden-run.vbs C:\tmp\hbbench\hbprobe-launch.bat
     ```
   - In PowerShell scripts run directly by the agent, always pass `-NoNewWindow` or `-WindowStyle Hidden` to `Start-Process`.

2. **Layer 2 — Off-Screen Window & Flag Discipline (`hbprobe-launch.bat` / `hbbench-launch.bat`)**:
   - Real-GPU Chrome must be launched via `start ""` inside the hidden batch script so it gets a normal window show state (required for ANGLE D3D11 rendering) while positioned completely off-screen at `-32000,-32000`:
     ```cmd
     start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --mute-audio --user-data-dir=C:\tmp\hbbench\%PROF% --window-position=-32000,-32000 --window-size=1280,720 --no-first-run --no-default-browser-check --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows about:blank
     ```
   - **NEVER pass `--enable-logging`** to Chrome on Windows (discovered 2026-10-24: `--enable-logging` causes Chrome to spawn its own visible console window on the owner's desktop).
   - **Always pass `--mute-audio`** (never mute Windows OS master volume, which would mute the owner).

3. **Layer 3 — Taskbar Orange-Flash Suppression (`C:\tmp\hbbench\noflash.ps1`)**:
   - A window launched from a background task requests foreground focus; Windows denies it and flashes its taskbar button orange on the owner's taskbar even when the window is at `-32000,-32000`.
   - `FlashWindowEx(FLASHW_STOP)` alone does not clear that highlight. `C:\tmp\hbbench\noflash.ps1` enumerates windows with `L <= -30000 || T <= -30000`, calls `FlashWindowEx(FLASHW_STOP)`, and calls `ITaskbarList::DeleteTab(hwnd)` to remove the taskbar button completely while leaving the window rendering for CDP.
   - Always launch `noflash.ps1` hidden right after starting test Chrome:
     ```cmd
     start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File C:\tmp\hbbench\noflash.ps1
     ```

4. **Layer 4 — Presence Gate & Safe Teardown (`hbgate.ps1`, `hbwho.ps1`, `hbbench-kill.ps1`)**:
   - Before starting real-GPU Chrome, `C:\tmp\hbbench\hbgate.ps1` checks `C:\tmp\hbbench\hbwho.ps1` (which reads `C:\tmp\hbbench\idle.txt` from `idlewatch.ps1`). It refuses if keyboard/mouse input occurred within 15 minutes (`idle < 900`), if an owner browser is open (`browsers > 0`), or if `gpu3d_other >= 35%`—unless `C:\tmp\hbbench\gate-owner-ok.txt` contains a non-expired ISO-8601 timestamp from an owner-requested run.
   - **Teardown**: Never run `taskkill /IM chrome.exe` or `Stop-Process -Name chrome`. Always kill ONLY test Chrome matching `C:\tmp\hbbench\`:
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File C:\tmp\hbbench\hbbench-kill.ps1
     ```

---

## 2. Local Stack & Network Topology (`desktop-4anudo2` <-> `wbterminal`)

| Component | Location | Details |
|---|---|---|
| **Repo Root** | `D:\WorldBuilder-ACME-Edition` | Also junctioned at `D:\Clones\WorldBuilder-ACME-Edition-master` |
| **Holtburger Web** | `D:\WorldBuilder-ACME-Edition\external\holtburger\apps\holtburger-web` | WASM built in `pkg/`; JS served live |
| **Baked Assets (`dist`)** | `D:\hb-serve\dist\current` | Junctioned to `holtburger-dist-hires-bc7m-xu7t2` (14+ GB SSD bake) and `external\holtburger\dist` |
| **Local Asset Server** | `127.0.0.1:8765` | `py -3.13 D:\WorldBuilder-ACME-Edition\external\holtburger\scripts\serve.py --bind 127.0.0.1 --port 8765` |
| **ACE Server & `wsbridge`** | `wbterminal` (`192.168.2.79` LAN / `100.116.47.66` Tailscale) | `wsbridge` on `:8080` (`ws://192.168.2.79:8080/`) -> ACE UDP `127.0.0.1:9000` (login) / `9001` (world) |
| **Scratch Space** | `D:\Temp` (junctioned at `C:\Temp`) | `D:` has ~442 GiB free (95% buffer). Keep `C:` clean (~16.8 GiB free). |

---

## 3. Common Workflows

### A. Run Targeted Unit Tests (Fast, Headless Node)
```powershell
Set-Location D:\WorldBuilder-ACME-Edition\external\holtburger\apps\holtburger-web
node tests/account_boot.test.mjs
```

### B. Start Local `serve.py` Background Server (No Window)
```powershell
$proc = Start-Process -FilePath "py" -ArgumentList "-3.13 D:\WorldBuilder-ACME-Edition\external\holtburger\scripts\serve.py --bind 127.0.0.1 --port 8765" -NoNewWindow -PassThru
```

### C. Connect `holtburger-web` to `wbterminal`'s ACE Server
Use URL parameters:
```text
http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&bridge_url=ws://192.168.2.79:8080/&server_host=127.0.0.1&server_port=9000
```
To verify ACE + `wsbridge` + WASM handshake end-to-end (7-point M4 suite):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Temp\verify_m4_ace.ps1
```

### D. Launch Off-Screen Real-GPU Chrome on Port 9333
1. If the owner explicitly requested a live 1070 run in the current session, set the override window (e.g., 2 hours):
   ```powershell
   (Get-Date).AddHours(2).ToString("o") | Set-Content -Path C:\tmp\hbbench\gate-owner-ok.txt -Encoding ascii
   "hbb-session" | Set-Content -Path C:\tmp\hbbench\profile.txt -Encoding ascii
   ```
2. Launch via scheduled task `hbprobe` (which runs `wscript.exe //B //Nologo C:\tmp\hbbench\hidden-run.vbs C:\tmp\hbbench\hbprobe-launch.bat`):
   ```powershell
   schtasks /run /tn hbprobe
   ```
3. Verify CDP is listening on `http://127.0.0.1:9333/json/version` and that the renderer is `ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)` (never SwiftShader).
4. Always clean up when finished:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\tmp\hbbench\hbbench-kill.ps1
   ```
