# hbgate.ps1 - box-side launch gate (2026-10-12): exit 0 only when nobody is using the 1070.
# hbprobe-launch.bat / hbbench-launch.bat call it BEFORE starting test Chrome, so every laptop driver
# (sess/academy/coldboot/hbprobe/hbsess/hbbench/flag-bench) inherits the owner rule even if it never
# asks the laptop-side watcher (coldboot/gate1070.sh). Refuses when the idlewatch heartbeat is
# missing or stale (we cannot tell), there was keyboard/mouse input in the last 15 min, a desktop
# browser of theirs is open, or other processes hold the 3D engine >= 35 % (a gamepad player).
# A browser-only refusal is re-checked twice, 3 s apart: our own Chrome that is still exiting briefly
# shows no command line and reads as theirs (same false positive watch1070.sh debounces).
# Every decision is appended to D:\Temp\hbbench\gate.log.
$why = @(); $line = ''
for ($try = 0; $try -lt 3; $try++) {
  $line = "$((& 'D:\Temp\hbbench\hbwho.ps1') | Select-Object -Last 1)"
  $kv = @{}
  foreach ($p in ($line -split ' ')) { $a = $p -split '=', 2; if ($a.Count -eq 2) { $kv[$a[0]] = [double]$a[1] } }
  $why = @()
  if (-not $kv.ContainsKey('hbage') -or $kv['hbage'] -lt 0 -or $kv['hbage'] -gt 40) { $why += 'idle heartbeat missing or stale' }
  elseif ($kv['idle'] -lt 900) { $why += "keyboard/mouse input $([int]$kv['idle'])s ago" }
  if ($kv['gpu3d_other'] -ge 35) { $why += "their GPU load $($kv['gpu3d_other'])%" }
  $browserOnly = ($kv['browsers'] -gt 0) -and ($why.Count -eq 0)
  if ($kv['browsers'] -gt 0) { $why += 'a browser of theirs is open' }
  if (-not $browserOnly) { break }
  Start-Sleep -Seconds 3
}
$verdict = if ($why.Count) { 'REFUSE ' + ($why -join '; ') } else { 'OK' }
Add-Content -Path 'D:\Temp\hbbench\gate.log' -Value "$(Get-Date -Format o) $verdict | $line"
if ($why.Count) { exit 1 } else { exit 0 }
