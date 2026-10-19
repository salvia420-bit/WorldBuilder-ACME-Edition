@echo off
rem flag-bench.mjs launcher (runs in the INTERACTIVE session via schtasks /it).
rem Profile dir name comes from profile.txt so each run gets a fresh profile.
rem 2026-10-12: refuse to start Chrome while a person is using the box (hbgate.ps1 -> gate.log).
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Temp\hbbench\hbgate.ps1
if errorlevel 1 exit /b 1
set /p PROF=<D:\Temp\hbbench\profile.txt
rem 2026-10-19: uncapped.txt present = uncapped frame rate (rAF no longer waits for vblank), so fps
rem measures the slowest stage instead of snapping to the 8.33 ms grid of the 120 Hz display.
set UNCAP=
if exist D:\Temp\hbbench\uncapped.txt set UNCAP=--disable-frame-rate-limit --disable-gpu-vsync
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --mute-audio --user-data-dir=D:\Temp\hbbench\%PROF% --window-position=-32000,-32000 --window-size=1280,720 --no-first-run --no-default-browser-check --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows %UNCAP% about:blank
