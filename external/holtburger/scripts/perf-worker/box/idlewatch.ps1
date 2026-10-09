# idlewatch.ps1 - input-idle heartbeat for the laptop-side "is a person on the 1070?" monitor.
# Runs hidden in the logged-on user's session (schtasks /it -> wscript idlewatch.vbs), because
# GetLastInputInfo only sees the calling session's input (SSH runs in another session).
# Every 5 s it overwrites D:\Temp\hbbench\idle.txt with "<unix-ts> <idle-seconds> <pid>".
# Writes nothing else and reads no window titles. Exits after 16 h or when idlewatch.stop exists.
Add-Type @'
using System; using System.Runtime.InteropServices;
public class IdleW { [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
 [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);
 [DllImport("kernel32.dll")] public static extern uint GetTickCount();
 public static uint Ms() { LII l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return unchecked(GetTickCount() - l.dwTime); } }
'@
$out = 'D:\Temp\hbbench\idle.txt'; $stop = 'D:\Temp\hbbench\idlewatch.stop'
Remove-Item $stop -ErrorAction SilentlyContinue
$end = (Get-Date).AddHours(16)
while ((Get-Date) -lt $end -and -not (Test-Path $stop)) {
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  "$ts $([int]([IdleW]::Ms()/1000)) $PID" | Set-Content -Path $out -Encoding ascii
  Start-Sleep -Seconds 5
}
Remove-Item $out -ErrorAction SilentlyContinue
