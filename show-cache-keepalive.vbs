' 缓存保温 显示控制台脚本
' 功能：把正在跑的缓存保温实例的命令行窗口调出来（无窗口/pm2 启动的那种调不出来，会提示看日志）。

Option Explicit
Dim sh, fso, here, ps1, outFile, tmpDir, showMsg, text, ts

showMsg = Not WScript.Arguments.Named.Exists("silent")
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\_show-cache-keepalive.ps1"
tmpDir = here & "\.tmp"
If Not fso.FolderExists(tmpDir) Then fso.CreateFolder tmpDir
outFile = tmpDir & "\show-console.txt"

If Not fso.FileExists(ps1) Then
    If showMsg Then MsgBox "找不到 _show-cache-keepalive.ps1：" & ps1, 16, "显示缓存保温窗口"
    WScript.Quit 1
End If

If fso.FileExists(outFile) Then fso.DeleteFile outFile, True

sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """ -OutFile """ & outFile & """", 0, True

text = ""
If fso.FileExists(outFile) Then
    Set ts = fso.OpenTextFile(outFile, 1, False, -2)
    If Not ts.AtEndOfStream Then text = ts.ReadAll
    ts.Close
End If

If text = "" Then text = "没有拿到结果（脚本可能执行失败）。"
If showMsg Then MsgBox text, 64, "显示缓存保温窗口"
WScript.Quit 0
