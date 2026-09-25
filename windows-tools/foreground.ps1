param([string]$Match = "", [switch]$Activate, [switch]$Maximize)

# Window titles are non-ASCII here; force UTF-8 on stdout so the Node caller
# (which decodes as UTF-8) sees real titles instead of mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Reports (and optionally forces) the Windows foreground window.
# No -Match  -> print the current foreground window title.
# -Match X   -> find top-level windows whose title contains X, optionally force one
#               to the foreground (AttachThreadInput trick beats the foreground lock),
#               then print the resulting foreground window title.
# Keep this file ASCII-only: PowerShell 5.1 reads BOM-less UTF-8 as GBK.

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

function Get-Title([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 1024
  [void][Fg]::GetWindowText($h, $sb, 1024)
  return $sb.ToString()
}

if ($Match -eq "") {
  Write-Output (Get-Title ([Fg]::GetForegroundWindow()))
  exit 0
}

$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Match*" }
foreach ($p in $procs) {
  $h = $p.MainWindowHandle
  if ($Activate) {
    # Without -Maximize this only raises the window. With -Maximize: restore **only when the
    # window is actually iconified** (SW_RESTORE on a maximized window would undo it — measured
    # 2026-09-25), then maximize. Necessary because a window that was minimized keeps reporting
    # outerWidth=0 to the page even after CDP sets its state to `maximized`.
    if ($Maximize) {
      if ([Fg]::IsIconic($h)) { [void][Fg]::ShowWindow($h, 9) }
      [void][Fg]::ShowWindow($h, 3)
    }
    $fgH = [Fg]::GetForegroundWindow()
    $tmpPid = 0
    $fgTid = [Fg]::GetWindowThreadProcessId($fgH, [ref]$tmpPid)
    $myTid = [Fg]::GetCurrentThreadId()
    [void][Fg]::AttachThreadInput($myTid, $fgTid, $true)
    [void][Fg]::SetForegroundWindow($h)
    [void][Fg]::AttachThreadInput($myTid, $fgTid, $false)
  }
}

Write-Output (Get-Title ([Fg]::GetForegroundWindow()))
