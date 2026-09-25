# RealtimeGUI Benchmark -- Human Evaluation
# Local static file server for Windows, using the built-in PowerShell (no installation needed).
# It serves the folder that contains this script and opens your browser automatically.
# Keep the console window open while you play; close it (or press Ctrl+C) to stop the server.

# -NoBrowser: start the server without opening a browser window (used by automated checks).
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-PortFree([int]$p) {
  try {
    $t = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $t.Start(); $t.Stop(); return $true
  } catch { return $false }
}

# Pick a free port in a small range so several people on one machine do not collide.
$Port = 0
foreach ($p in 8765..8785) { if (Test-PortFree $p) { $Port = $p; break } }
if ($Port -eq 0) { Write-Host "No free port found in 8765-8785. Close other servers and retry." -ForegroundColor Red; exit 1 }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  Write-Host ("Cannot start the local server on port $Port : " + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Tip: close other programs that use this port, then run this file again."
  exit 1
}

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   RealtimeGUI Benchmark -- Human Evaluation (local server)" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   Address  : $url" -ForegroundColor Green
Write-Host ""
Write-Host "   >>> KEEP THIS WINDOW OPEN while you play. <<<" -ForegroundColor Yellow
Write-Host "   >>> Close this window (or press Ctrl+C) to stop the server. <<<" -ForegroundColor Yellow
Write-Host ""
Write-Host "   If the browser did not open automatically, open it yourself and"
Write-Host "   type / paste this address:  $url"
Write-Host ""
if (-not $NoBrowser) { try { Start-Process $url } catch { } }

$mime = @{
  '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'
  '.js'='application/javascript; charset=utf-8'; '.mjs'='application/javascript; charset=utf-8'
  '.css'='text/css; charset=utf-8'; '.json'='application/json; charset=utf-8'
  '.txt'='text/plain; charset=utf-8'; '.md'='text/plain; charset=utf-8'
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.gif'='image/gif'
  '.svg'='image/svg+xml'; '.ico'='image/x-icon'; '.woff2'='font/woff2'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $rel = [System.Uri]::UnescapeDataString($req.Url.LocalPath).TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $res.StatusCode = 403
    } elseif (Test-Path $full -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] }
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
  } catch {
    try { $res.StatusCode = 500 } catch { }
  } finally {
    try { $res.OutputStream.Close() } catch { }
  }
}
