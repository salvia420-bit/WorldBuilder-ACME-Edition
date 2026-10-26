@echo off
rem hbprobe launcher (INTERACTIVE session via schtasks /it). Fresh profile + window size from files.
rem 2026-10-12: refuse to start Chrome while a person is using the box (hbgate.ps1 -> gate.log).
rem 2026-10-24: NO --enable-logging. On Windows it makes Chrome open a console for its log output
rem (the launcher has exited before Chrome could attach to it), and that window popped up on the
rem owner's desktop full of update_service_dialer_win.cc errors. Never re-add it here.
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Temp\hbbench\hbgate.ps1
if errorlevel 1 exit /b 1
set /p PROF=<D:\Temp\hbbench\profile.txt
rem 2026-10-19: uncapped.txt present = uncapped frame rate (rAF no longer waits for vblank), so fps
rem measures the slowest stage instead of snapping to the 8.33 ms grid of the 120 Hz display.
set UNCAP=
if exist D:\Temp\hbbench\uncapped.txt set UNCAP=--disable-frame-rate-limit --disable-gpu-vsync
if not exist D:\Temp\hbbench\logs mkdir D:\Temp\hbbench\logs
rem 2026-10-25: experimental Chrome arms, all OFF unless their file exists (hbsess.mjs boot writes or
rem deletes them on every boot): angle.txt = ANGLE backend (d3d11 | vulkan | gl | d3d11on12; absent = d3d11),
rem disablefeatures.txt = comma-led extra --disable-features names (e.g. ,SkiaGraphite),
rem extraflags.txt = more switches appended as-is (e.g. --enable-webgl-draft-extensions).
set ANGLE=d3d11
if exist D:\Temp\hbbench\angle.txt set /p ANGLE=<D:\Temp\hbbench\angle.txt
set DISFX=
if exist D:\Temp\hbbench\disablefeatures.txt set /p DISFX=<D:\Temp\hbbench\disablefeatures.txt
set EXTRA=
if exist D:\Temp\hbbench\extraflags.txt set /p EXTRA=<D:\Temp\hbbench\extraflags.txt
set WS=1280,720
if exist D:\Temp\hbbench\winsize.txt set /p WS=<D:\Temp\hbbench\winsize.txt
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --use-angle=%ANGLE% --ignore-gpu-blocklist --mute-audio --user-data-dir=D:\Temp\hbbench\%PROF% --window-position=-32000,-32000 --window-size=%WS% --no-first-run --no-default-browser-check --disable-features=CalculateNativeWinOcclusion%DISFX% --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows %UNCAP% %EXTRA% about:blank
rem 2026-10-24: keep the off-screen window off the owner's taskbar (Windows lit its button orange:
rem a background window asking for the foreground). noflash.ps1 removes its button; /b = this hidden console.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File D:\Temp\hbbench\noflash.ps1
