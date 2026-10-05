# Kill ONLY flag-bench Chrome (profile under D:\Temp\hbbench\), never the
# person's own browser. Filters on chrome.exe so this script can't match itself.
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*D:\Temp\hbbench\*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Drop old bench profiles (keep the disk from filling over many runs).
Get-ChildItem D:\Temp\hbbench -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'hbb-*' } |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
