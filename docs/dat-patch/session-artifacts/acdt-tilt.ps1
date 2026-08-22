# One-shot camera tilt: idle-guarded, focuses the test acclient, HOLDS a key
# (default PageUp = AC look-up) for HoldMs, restores focus.
param([int]$Vk = 0x21, [int]$Sc = 0x49, [int]$HoldMs = 3000)
$ErrorActionPreference = 'Continue'
$out = 'C:\Temp\acdt'
function Log($m) { ("{0} {1}" -f (Get-Date -Format o), $m) | Add-Content -Path (Join-Path $out 'tilt.log') }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WA3 {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public KI ki; public ulong pad; }
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static uint IdleMs() {
    var li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    GetLastInputInfo(ref li);
    return (uint)Environment.TickCount - li.dwTime;
  }
  static INPUT K(ushort vk, ushort sc, uint flags) {
    var i = new INPUT(); i.type = 1; i.ki.wVk = vk; i.ki.wScan = sc; i.ki.dwFlags = flags; return i;
  }
  public static void Hold(ushort vk, ushort sc, bool ext, int holdMs) {
    uint f = ext ? 1u : 0u;
    SendInput(1, new INPUT[]{ K(vk, sc, f) }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(holdMs);
    SendInput(1, new INPUT[]{ K(vk, sc, f | 2u) }, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
$idle = [WA3]::IdleMs()
Log "idle ms=$idle vk=$Vk hold=$HoldMs"
if ($idle -lt 2000) { Log 'ABORT-USER-ACTIVE'; exit 1 }
$p = Get-Process acclient -ErrorAction Stop | Select-Object -First 1
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Log 'NO-CLIENT-WINDOW'; exit 1 }
$prev = [WA3]::GetForegroundWindow()
[WA3]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500
[WA3]::Hold([uint16]$Vk, [uint16]$Sc, $true, $HoldMs)
Log "tilt sent"
Start-Sleep -Milliseconds 300
if ($prev -ne [IntPtr]::Zero) { [WA3]::SetForegroundWindow($prev) | Out-Null }
Log "focus restored"
