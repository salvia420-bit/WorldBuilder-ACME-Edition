# deskshot.ps1 - screenshot of the interactive desktop + every visible top-level window (title, pid, process, class).
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[W]::SetProcessDPIAware() | Out-Null
$out = New-Object System.Collections.Generic.List[string]
[W]::EnumWindows({ param($h, $l)
  if ([W]::IsWindowVisible($h)) {
    $t = New-Object System.Text.StringBuilder 512; [W]::GetWindowText($h, $t, 512) | Out-Null
    $c = New-Object System.Text.StringBuilder 256; [W]::GetClassName($h, $c, 256) | Out-Null
    $p = 0; [W]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
    $pn = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
    if ($t.Length -gt 0 -or $c.ToString() -eq 'ConsoleWindowClass') { $out.Add("pid=$p proc=$pn class=$($c.ToString()) rect=$($r.L),$($r.T),$($r.R),$($r.B) title=[$($t.ToString())]") }
  }; return $true }, [IntPtr]::Zero) | Out-Null
$out | Set-Content -Path 'D:\Temp\hbbench\deskwin.txt' -Encoding UTF8
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save('D:\Temp\hbbench\desk.png', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
