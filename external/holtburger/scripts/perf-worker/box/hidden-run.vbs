' hidden-run.vbs - run a box launcher (.bat) with NO console window (2026-10-24).
'
' The 1070 is the owner's own desktop. `schtasks /it` runs a task's action in the
' interactive session, and a .bat always gets a console, so every test-Chrome
' launch flashed a cmd window on their screen (owner: "find a permanent solution
' so that terminal doesnt pop up"). wscript.exe is a GUI-subsystem host - it never
' opens a console - and Run(..., 0, ...) starts the batch HIDDEN; anything the
' batch runs in its console (hbgate.ps1's powershell) stays hidden with it. Chrome
' is started by the batch's `start ""`, which gives it a fresh, normal show state,
' so the off-screen window still renders. Same pattern as idlewatch.vbs.
'
' Scheduled-task action (scripts/perf-worker/*.mjs create it this way):
'   wscript.exe //B //Nologo D:\Temp\hbbench\hidden-run.vbs D:\Temp\hbbench\hbprobe-launch.bat
' The batch's exit code is the task's result (hbgate refusal = 1).
Option Explicit
Dim sh, cmd, i
If WScript.Arguments.Count = 0 Then WScript.Quit 2
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
Set sh = CreateObject("WScript.Shell")
' One more pair of quotes round the whole line: with more than two quote marks
' cmd /c strips the first and the last, which mangled `powershell -File x.ps1`
' (a lone "x.bat" survived, so the batch launchers never showed it).
WScript.Quit sh.Run("%ComSpec% /c """ & cmd & """", 0, True)
