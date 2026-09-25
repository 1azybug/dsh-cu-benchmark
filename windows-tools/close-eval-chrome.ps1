# 关掉**评测专用**的 Chrome 实例：按 user-data-dir 精确匹配，绝不碰用户日常的 Chrome。
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-cu-eval-profile*' } |
  ForEach-Object {
    Write-Host ("killing pid " + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Write-Host "done"
