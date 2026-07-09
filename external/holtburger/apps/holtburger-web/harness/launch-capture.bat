@echo off
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=%LOCALAPPDATA%\wb-eyetest --no-first-run --remote-debugging-port=9334 --start-maximized "http://127.0.0.1:18765/apps/holtburger-web/index.html?nosw=1&renderer=3d&autoLogin=1&account=tailnet1&password=tailnet1&cmdInterp=on&slideCast=off&leashEchoGate=on"
