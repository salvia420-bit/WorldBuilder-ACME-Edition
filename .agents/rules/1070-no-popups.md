---
trigger: always_on
---
# Screen-safety rules (full detail: repo `GEMINI.md`, Profile B)

On the Windows 1070 box (`desktop-4anudo2`) a person is using the screen:
- Nothing may pop up, flash on the taskbar, or play audio. Hidden/`-NoNewWindow` processes, `windowsHide: true`,
  scheduled tasks only via `wscript.exe //B //Nologo C:\tmp\hbbench\hidden-run.vbs`.
- Test Chrome off-screen + muted with its own `--user-data-dir=C:\tmp\hbbench\<profile>`, never `--enable-logging`,
  `noflash.ps1` running hidden; kill only via `C:\tmp\hbbench\hbbench-kill.ps1` (never `taskkill /IM chrome.exe`). Never OS-mute.
- One heavy job at a time (full JS gate, builds, real-GPU Chrome). Subagents: targeted single tests only.
- Temp files on `D:\Temp`; ACE via `bridge_url=ws://192.168.2.79:8080/` (or `ws://100.116.47.66:8080/`), `server_host=127.0.0.1&server_port=9000`.

On Vast.ai (Linux) these limits do not apply — see `GEMINI.md` §0 and Profile A (run `scripts/vast/ace-up.sh` for a local ACE).
