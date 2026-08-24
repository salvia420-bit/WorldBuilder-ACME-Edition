@echo off
rem play.bat - ACME r8 kit launcher (fresh-install loud-fail, mechanism B -
rem DESIGN-fresh-install-loud-fail-2026-08-19.md). client_highres.dat is
rem LOAD-BEARING after the HIFI split: the portal no longer carries the
rem superseded texture copies, and the client's absent-file mount path is a
rem graceful no-op by design - a kit missing the highres would render missing
rem textures SILENTLY. This launcher refuses to start the client unless every
rem dat is present at its manifest size AND acclient.exe carries the ACME
rem patch set (an unpatched exe never mounts client_highres.dat at all, which
rem after the split is the same silent-missing-textures failure).
rem
rem kit-manifest.txt lines:  <filename>|<exact-size-in-bytes>
rem   (dats only - the kit ships no client executable; you patch your own,
rem    see patch-my-client.bat)
rem
rem NOTE ON STYLE: every file test lives in the :checkone subroutine and no
rem message text contains parentheses. Both are deliberate - cmd parses a
rem whole ( ... ) block at once, so a ')' inside an expanded variable, or a
rem caret-escaped '(' inside a nested block, silently mangles the block. That
rem defect shipped in the first draft: the wrong-size arm never fired and the
rem missing-file arm died with "'.' was unexpected at this time" instead of
rem refusing. Caught by tools/dat-patch/kit/kit-gate.ps1 arms B2/B3.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not exist kit-manifest.txt (
  set MSG=kit-manifest.txt is missing - this install is incomplete. Re-download the kit.
  goto :loudfail
)

set BAD=
for /f "usebackq tokens=1,2 delims=|" %%A in ("kit-manifest.txt") do call :checkone "%%A" "%%B"

if defined BAD (
  set MSG=This install is incomplete - the game will NOT start.  Problem: !BAD!  Re-download the kit or restore the named files.
  goto :loudfail
)

rem --- exe patch state -------------------------------------------------------
rem The ACME kit redistributes no client bytes: acme-patch-client.ps1 patches
rem the player's own retail acclient.exe. -Verify -Quiet reports rc 0 only when
rem all patch sites are present - idempotent, so an already-patched exe passes.
if exist acme-patch-client.ps1 (
  if not exist acclient.exe (
    set MSG=acclient.exe is missing - copy the ACME kit files into your Asheron's Call install folder, don't run them from the download folder.
    goto :loudfail
  )
  powershell -NoProfile -ExecutionPolicy Bypass -File "acme-patch-client.ps1" -Verify -Quiet -Exe "acclient.exe" >nul 2>&1
  if errorlevel 1 (
    set MSG=Your acclient.exe is not patched for this release - run patch-my-client.bat once, then start the game again.  Without the patch the client never loads client_highres.dat and most textures would be missing.
    goto :loudfail
  )
)

rem ACME_KIT_CHECK_ONLY=1: verify and report, never launch - gate/CI.
if defined ACME_KIT_CHECK_ONLY (
  echo KIT-OK
  exit /b 0
)
start "" acclient.exe %*
exit /b 0

:checkone
set N=%~1
set S=%~2
if not exist "%N%" (
  set BAD=!BAD!%N% missing;
  exit /b 0
)
set ACT=
for %%F in ("%N%") do set ACT=%%~zF
if not "!ACT!"=="%S%" set BAD=!BAD!%N% wrong size !ACT! expected %S%;
exit /b 0

:loudfail
rem ACME_KIT_CHECK_SILENT=1: headless gate mode - same refusal path, console
rem message instead of the blocking MessageBox, used by the box gate over ssh.
if defined ACME_KIT_CHECK_SILENT (
  echo LOUD-FAIL: !MSG!
  exit /b 1
)
powershell -NoProfile -Command "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.MessageBox]::Show('!MSG!'.Replace('  ',[char]10+[char]10),'ACME kit - install problem',0,16)"
exit /b 1
