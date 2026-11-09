# Kill ONLY flag-bench Chrome (profile under C:\tmp\hbbench\), never the
# person's own browser. Filters on chrome.exe so this script can't match itself.
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*C:\tmp\hbbench\*' -or $_.CommandLine -like '*tmp\hbbench\*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Drop old bench profiles (keep the disk from filling over many runs).
Get-ChildItem C:\tmp\hbbench -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'hbb-*' } |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
