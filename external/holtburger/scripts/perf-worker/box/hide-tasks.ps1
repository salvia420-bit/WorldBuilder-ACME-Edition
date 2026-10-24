# hide-tasks.ps1 (2026-10-24): route every hb* scheduled task through hidden-run.vbs so
# launching it never opens a console window on the owner's desktop. Idempotent.
$vbs = 'D:\Temp\hbbench\hidden-run.vbs'
Get-ScheduledTask | Where-Object { $_.TaskName -like 'hb*' } | ForEach-Object {
  $t = $_; $a = $t.Actions[0]
  if ($a.Execute -match 'wscript') { "keep  $($t.TaskName) => $($a.Execute) $($a.Arguments)"; return }
  $orig = ($a.Execute + ' ' + $a.Arguments).Trim()
  $new = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo $vbs $orig"
  Set-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Action $new | Out-Null
  $chk = (Get-ScheduledTask -TaskName $t.TaskName).Actions[0]
  "moved $($t.TaskName) => $($chk.Execute) $($chk.Arguments)"
}
