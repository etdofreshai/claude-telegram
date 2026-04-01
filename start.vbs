Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\etgarcia\code\workspace"
WshShell.Run "cmd /c C:\Users\etgarcia\.local\bin\claude.exe --dangerously-skip-permissions --channels ""plugin:telegram@claude-plugins-official"" > C:\Users\etgarcia\code\background\claude-telegram\output.log 2>&1", 0, False
