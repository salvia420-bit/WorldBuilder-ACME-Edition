# noflash.ps1 - keep the off-screen test Chrome off the owner's taskbar (2026-10-24).
#
# A browser window launched from a background task asks for the foreground; Windows refuses (the
# owner is using the desktop) and lights its taskbar button orange - on the owner's screen, though
# the window itself sits at -32000. FlashWindowEx(FLASHW_STOP) does not clear that highlight, so
# this removes the off-screen window's taskbar BUTTON (ITaskbarList.DeleteTab) and stops any flash.
# The window keeps rendering exactly as before; CDP drives it as before. It touches only windows
# that are fully off-screen (left or top edge <= -30000), never one of the owner's, and repeats
# for -Seconds because a relog or a new window can bring a button back. Started HIDDEN by the
# launchers (hbprobe-launch.bat / hbbench-launch.bat, run through hidden-run.vbs).
param([int]$Seconds = 900)
Add-Type @"
using System; using System.Runtime.InteropServices;
[ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITaskbarList { void HrInit(); void AddTab(IntPtr h); void DeleteTab(IntPtr h); void ActivateTab(IntPtr h); void SetActiveAlt(IntPtr h); }
[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")] class TaskbarListCls { }
public static class NoFlash {
  [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO f);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  static ITaskbarList tb;
  public static int Hide() {
    if (tb == null) { tb = (ITaskbarList)new TaskbarListCls(); tb.HrInit(); }
    int n = 0;
    EnumWindows((h, l) => {
      RECT r;
      if (IsWindowVisible(h) && GetWindowRect(h, out r) && (r.L <= -30000 || r.T <= -30000)) {
        FLASHWINFO f = new FLASHWINFO(); f.cbSize = (uint)Marshal.SizeOf(f); f.hwnd = h; f.dwFlags = 0; // FLASHW_STOP
        FlashWindowEx(ref f);
        tb.DeleteTab(h); n++;
      }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) { [NoFlash]::Hide() | Out-Null; Start-Sleep -Milliseconds 1500 }
