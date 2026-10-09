# hbwho.ps1 - one status line for the laptop's "is a person on the 1070?" monitor.
# idle = seconds since the logged-on user's last keyboard/mouse input (from idlewatch.ps1's heartbeat),
# hbage = heartbeat age (stale = watcher died), locked = LogonUI up, browsers = desktop browser windows
# that are not our D:\Temp\hbbench\ test Chrome, gpu3d_other / gpu3d_mine = 3D engine % of other
# processes vs our test Chrome (a gamepad player shows up here, not in idle).
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$hb = Get-Content D:\Temp\hbbench\idle.txt -ErrorAction SilentlyContinue
if ($hb) { $f = "$hb" -split ' '; $idle = [int]$f[1]; $age = $now - [int64]$f[0] } else { $idle = -1; $age = -1 }
$locked = [int][bool](Get-Process LogonUI -ErrorAction SilentlyContinue)
$procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='firefox.exe'")
$roots = @($procs | Where-Object { $_.CommandLine -like '*D:\Temp\hbbench\*' } | ForEach-Object { $_.ProcessId })
$ours = @($procs | Where-Object { $roots -contains $_.ProcessId -or $roots -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })
$browsers = @($procs | Where-Object { $ours -notcontains $_.ProcessId -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--no-startup-window' }).Count
$other = 0.0; $mine = 0.0
$samples = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
foreach ($s in $samples) {
  if ($s.InstanceName -match 'pid_(\d+)_') { if ($ours -contains [int]$matches[1]) { $mine += $s.CookedValue } else { $other += $s.CookedValue } }
}
$rb = [int][bool](Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue)
"idle=$idle hbage=$age locked=$locked browsers=$browsers roblox=$rb gpu3d_other=$([math]::Round($other,1)) gpu3d_mine=$([math]::Round($mine,1)) ourchrome=$($ours.Count)"
