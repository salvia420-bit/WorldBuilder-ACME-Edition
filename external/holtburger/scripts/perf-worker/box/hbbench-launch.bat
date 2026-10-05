@echo off
rem flag-bench.mjs launcher (runs in the INTERACTIVE session via schtasks /it).
rem Profile dir name comes from profile.txt so each run gets a fresh profile.
set /p PROF=<D:\Temp\hbbench\profile.txt
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --mute-audio --user-data-dir=D:\Temp\hbbench\%PROF% --window-position=-32000,-32000 --window-size=1280,720 --no-first-run --no-default-browser-check --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows about:blank
