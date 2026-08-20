<#
  kit-gate.ps1 — headless Windows gate for the ACME r8 kit's two player-facing
  mechanisms. Runs entirely on files in its own folder: it never launches the
  client, never touches the display, and is safe to run with a person at the box.

  ARM A — acme-patch-client.ps1 (the kit's exe delivery: the player patches their
          OWN retail acclient.exe; the kit ships no client bytes).
    A1 pristine retail exe  -> patched, sha256 == the gated shipping exe
    A2 run again            -> idempotent no-op, rc 0
    A3 -Verify on pristine  -> rc 1 (reports unpatched)
    A4 a foreign/short file  -> REFUSES, rc 1, nothing written

  ARM B — play.bat (fresh-install loud-fail, mechanism B)
    B1 all dats + patched exe -> KIT-OK, rc 0
    B2 a dat missing          -> LOUD-FAIL, rc 1, no launch
    B3 a dat at the wrong size-> LOUD-FAIL, rc 1, no launch
    B4 an unpatched exe       -> LOUD-FAIL, rc 1, no launch

  usage: powershell -ExecutionPolicy Bypass -File kit-gate.ps1 -RetailExe <path> -ExpectedSha <sha256>
#>
param(
  [string]$RetailExe = "retail-orig.exe",
  [string]$ExpectedSha = "6c3232ea7496cb743f591a03f887d9e46b1f8260b1ee67770ee3adceadbd5f37",
  [string]$WorkDir = ""
)
$ErrorActionPreference = "Continue"
if (-not $WorkDir) { $WorkDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $WorkDir
# .NET APIs ([IO.File], Resolve-Path on relative paths from .NET) use the PROCESS
# current directory, which Set-Location does NOT move. Without this line the
# harness writes its stand-in files somewhere else entirely and every arm that
# mutates a file silently tests nothing (that defect made arm B3 read PASS-shaped
# on a file it never shortened).
[Environment]::CurrentDirectory = (Get-Location).Path
$RetailExe = (Resolve-Path -LiteralPath $RetailExe).Path

$pass = 0; $fail = 0
function Check($name, $cond, $detail) {
  if ($cond) { Write-Host ("PASS  {0,-38} {1}" -f $name, $detail); $script:pass++ }
  else       { Write-Host ("FAIL  {0,-38} {1}" -f $name, $detail); $script:fail++ }
}
function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function RunPatcher([string[]]$a) {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File ".\acme-patch-client.ps1" @a 2>&1
  return @{ rc = $LASTEXITCODE; out = ($out -join "`n") }
}
function RunPlay([hashtable]$env0) {
  $old = @{}
  foreach ($k in $env0.Keys) { $old[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $env0[$k]) }
  $out = & cmd.exe /c "play.bat" 2>&1
  $rc = $LASTEXITCODE
  foreach ($k in $old.Keys) { [Environment]::SetEnvironmentVariable($k, $old[$k]) }
  return @{ rc = $rc; out = ($out -join "`n") }
}

Write-Host "== ACME kit gate =="
Write-Host ("   workdir     {0}" -f $WorkDir)
Write-Host ("   retail exe  {0}  sha256 {1}" -f $RetailExe, (Sha $RetailExe))
Write-Host ("   expecting   {0}" -f $ExpectedSha)
Write-Host ""

# ---- ARM A ----------------------------------------------------------------
Copy-Item -LiteralPath $RetailExe -Destination ".\acclient.exe" -Force
Remove-Item ".\acclient.exe.acme-orig.bak" -ErrorAction SilentlyContinue

$r = RunPatcher @("-Exe", "acclient.exe")
$sha = Sha ".\acclient.exe"
Check "A1 patch pristine exe" ($r.rc -eq 0 -and $sha -eq $ExpectedSha) ("rc=" + $r.rc + " sha=" + $sha.Substring(0,12) + "…")
Check "A1b backup kept" (Test-Path ".\acclient.exe.acme-orig.bak") "acclient.exe.acme-orig.bak"
Check "A1c backup is the original" ((Sha ".\acclient.exe.acme-orig.bak") -eq (Sha $RetailExe)) "backup == retail input"

$r = RunPatcher @("-Exe", "acclient.exe")
$sha2 = Sha ".\acclient.exe"
Check "A2 idempotent re-run" ($r.rc -eq 0 -and $sha2 -eq $ExpectedSha -and $r.out -match "Already patched") ("rc=" + $r.rc)

Copy-Item -LiteralPath $RetailExe -Destination ".\pristine.exe" -Force
$r = RunPatcher @("-Exe", "pristine.exe", "-Verify")
Check "A3 -Verify on pristine refuses" ($r.rc -eq 1 -and $r.out -match "still original") ("rc=" + $r.rc)
$r = RunPatcher @("-Exe", "acclient.exe", "-Verify")
Check "A3b -Verify on patched passes" ($r.rc -eq 0 -and $r.out -match "fully patched") ("rc=" + $r.rc)

$bytes = [IO.File]::ReadAllBytes($RetailExe)
[IO.File]::WriteAllBytes(".\foreign.exe", $bytes[0..1999])
$before = Sha ".\foreign.exe"
$r = RunPatcher @("-Exe", "foreign.exe")
Check "A4 foreign file refused" ($r.rc -eq 1 -and (Sha ".\foreign.exe") -eq $before -and $r.out -match "REFUSED") ("rc=" + $r.rc)
Remove-Item ".\foreign.exe", ".\pristine.exe" -ErrorAction SilentlyContinue

# ---- ARM B ----------------------------------------------------------------
# stand-in dats: play.bat's rule is name+exact size, so small files exercise it
# byte-for-byte the same way the 1.8 GB kit does.
$dats = @{ "client_portal.dat" = 4096; "client_highres.dat" = 8192; "client_cell_1.dat" = 2048 }
function ResetDats {
  foreach ($n in $dats.Keys) {
    $b = New-Object byte[] $dats[$n]
    [IO.File]::WriteAllBytes((Join-Path (Get-Location) $n), $b)
  }
  $lines = foreach ($n in $dats.Keys) { "{0}|{1}" -f $n, $dats[$n] }
  Set-Content -Path ".\kit-manifest.txt" -Value $lines -Encoding ASCII
}
ResetDats
$env0 = @{ ACME_KIT_CHECK_ONLY = "1"; ACME_KIT_CHECK_SILENT = "1" }

$r = RunPlay $env0
Check "B1 complete kit -> KIT-OK" ($r.rc -eq 0 -and $r.out -match "KIT-OK") ("rc=" + $r.rc + " " + ($r.out -replace "`n"," ").Trim())

Remove-Item ".\client_highres.dat"
$r = RunPlay $env0
Check "B2 highres missing -> refuse" ($r.rc -eq 1 -and $r.out -match "LOUD-FAIL" -and $r.out -match "client_highres.dat missing") ("rc=" + $r.rc + " " + ($r.out -replace "`n"," ").Trim())

ResetDats
[IO.File]::WriteAllBytes(".\client_portal.dat", (New-Object byte[] 4095))
Check "B3-setup file really shortened" ((Get-Item ".\client_portal.dat").Length -eq 4095) ((Get-Item ".\client_portal.dat").Length)
$r = RunPlay $env0
Check "B3 short dat -> refuse" ($r.rc -eq 1 -and $r.out -match "LOUD-FAIL" -and $r.out -match "wrong size") ("rc=" + $r.rc + " " + ($r.out -replace "`n"," ").Trim())

ResetDats
[IO.File]::WriteAllBytes(".\client_cell_1.dat", (New-Object byte[] 9999))
$r = RunPlay $env0
Check "B3b oversized dat -> refuse" ($r.rc -eq 1 -and $r.out -match "LOUD-FAIL" -and $r.out -match "wrong size") ("rc=" + $r.rc + " " + ($r.out -replace "`n"," ").Trim())

ResetDats
Copy-Item -LiteralPath $RetailExe -Destination ".\acclient.exe" -Force
$r = RunPlay $env0
Check "B4 unpatched exe -> refuse" ($r.rc -eq 1 -and $r.out -match "LOUD-FAIL" -and $r.out -match "not patched") ("rc=" + $r.rc + " " + ($r.out -replace "`n"," ").Trim())

# restore the patched exe and re-confirm the pass path (order-independence)
$r = RunPatcher @("-Exe", "acclient.exe", "-NoBackup")
$r = RunPlay $env0
Check "B5 repatched -> KIT-OK again" ($r.rc -eq 0 -and $r.out -match "KIT-OK") ("rc=" + $r.rc)

Write-Host ""
Write-Host ("RESULT: {0} pass / {1} fail" -f $pass, $fail)
if ($fail -gt 0) { exit 1 } else { exit 0 }
