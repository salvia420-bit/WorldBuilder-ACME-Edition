@echo off
rem play.bat — ACME r8 kit launcher (fresh-install loud-fail, mechanism B —
rem DESIGN-fresh-install-loud-fail-2026-08-19.md). client_highres.dat is
rem LOAD-BEARING after the HIFI split: the portal no longer carries the
rem superseded texture copies, and the client's absent-file mount path is a
rem graceful no-op by design — a kit missing the highres would render missing
rem textures SILENTLY. This launcher refuses to start the client unless every
rem dat is present at its manifest size.
rem
rem kit-manifest.txt lines:  <filename>|<exact-size-in-bytes>
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not exist kit-manifest.txt (
  powershell -NoProfile -Command "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.MessageBox]::Show('kit-manifest.txt is missing — this install is incomplete. Re-download the kit.','ACME kit',0,16)"
  exit /b 1
)

set BAD=
for /f "usebackq tokens=1,2 delims=|" %%A in ("kit-manifest.txt") do (
  if not exist "%%A" (
    set BAD=!BAD!%%A missing^;
  ) else (
    for %%S in ("%%A") do if not "%%~zS"=="%%B" set BAD=!BAD!%%A wrong size ^(%%~zS, expected %%B^)^;
  )
)

if defined BAD (
  powershell -NoProfile -Command "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.MessageBox]::Show('This install is incomplete — the game will NOT start:'+[char]10+[char]10+'%BAD%'+[char]10+'Re-download the kit or restore the named file(s).','ACME kit — missing DAT files',0,16)"
  exit /b 1
)

start "" acclient.exe %*
exit /b 0
