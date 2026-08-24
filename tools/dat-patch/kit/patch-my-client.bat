@echo off
rem patch-my-client.bat - one-time client patch for the ACME kit.
rem
rem The kit ships NO client executable (community norm: patch over your own
rem install). This applies the ACME byte patches to YOUR acclient.exe, keeping
rem a backup as acclient.exe.acme-orig.bak. Safe to run twice - sites already
rem patched are left alone.
setlocal
cd /d "%~dp0"
if not exist acclient.exe (
  echo.
  echo   acclient.exe not found in this folder.
  echo   Copy the ACME kit files into your Asheron's Call install folder first,
  echo   then run this from there.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "acme-patch-client.ps1" -Exe "acclient.exe"
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  echo   The client was NOT patched - nothing was written. See the message above.
) else (
  echo   Done. Start the game with play.bat.
)
echo.
pause
exit /b %RC%
