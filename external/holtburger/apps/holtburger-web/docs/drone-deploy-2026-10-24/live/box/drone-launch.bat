@echo off
rem drone-launch.bat (2026-10-24) - owner-authorized ON-SCREEN test Chrome for the Drone Deploy
rem smoke and eye test (PLAN 9.4 step 6, 9.6). MUTED: no sound may reach the box's user.
rem Own profile (hbb-drone, removed by drone-live.mjs kill and by hbbench-kill.ps1), CDP :9333.
rem Launch it hidden, never as a bare .bat task action (that opens a console on the owner's desktop):
rem   wscript.exe //B //Nologo D:\Temp\hbbench\hidden-run.vbs D:\Temp\hbbench\drone-launch.bat
rem No --enable-logging (it opens Chrome's log console on Windows).
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --mute-audio --user-data-dir=D:\Temp\hbbench\hbb-drone --start-maximized --no-first-run --no-default-browser-check --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows about:blank
