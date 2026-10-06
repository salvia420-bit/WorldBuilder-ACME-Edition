@echo off
rem hbprobe launcher (INTERACTIVE session via schtasks /it). Fresh profile + window size from files.
set /p PROF=<D:\Temp\hbbench\profile.txt
if not exist D:\Temp\hbbench\logs mkdir D:\Temp\hbbench\logs
set WS=1280,720
if exist D:\Temp\hbbench\winsize.txt set /p WS=<D:\Temp\hbbench\winsize.txt
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --mute-audio --user-data-dir=D:\Temp\hbbench\%PROF% --window-position=-32000,-32000 --window-size=%WS% --no-first-run --no-default-browser-check --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows --enable-logging --v=0 --log-file=D:\Temp\hbbench\logs\%PROF%.log about:blank
