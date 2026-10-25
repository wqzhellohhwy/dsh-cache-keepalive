' 缓存保温 停止脚本 (通过端口)
' 功能：找到占用 19388-19392 的缓存保温进程并终止（支持多个 PID），结果弹框。
' 用法：双击即可（自动请求管理员权限）；加 /silent 则不弹框。
' 实现：直接用 Exec 同步调 kill-cache-keepalive.ps1，从 stdout 的 "pid=" 片段取被杀 PID（不靠重定向文件，避开 cmd 引号地狱）。

Option Explicit
' ========== 自动请求管理员权限 ==========
Dim args, arg, cmd
Dim shellApp

If Not WScript.Arguments.Named.Exists("elevated") Then
    cmd = """" & WScript.ScriptFullName & """"
    For Each arg In WScript.Arguments
        cmd = cmd & " """ & arg & """"
    Next
    cmd = cmd & " /elevated"

    Set shellApp = CreateObject("Shell.Application")
    shellApp.ShellExecute "wscript.exe", cmd, "", "runas", 1
    WScript.Quit
End If
' ========== 提权完毕，继续执行 ==========
Dim sh, fso, here, ps1, showMsg, exec, output, lines, i, line, pos, num, killed
showMsg = Not WScript.Arguments.Named.Exists("silent")
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\kill-cache-keepalive.ps1"

If Not fso.FileExists(ps1) Then
    If showMsg Then MsgBox "找不到 kill-cache-keepalive.ps1：" & ps1, 16, "停止缓存保温"
    WScript.Quit 1
End If

Set exec = sh.Exec("powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """ -Pm2 -NoPause")
output = exec.StdOut.ReadAll

' 只认 ASCII 片段 "pid="，中文部分可能因编码变乱码，不影响定位
killed = ""
lines = Split(output, vbCrLf)
For i = 0 To UBound(lines)
    line = lines(i)
    pos = InStr(line, "pid=")
    If pos > 0 Then
        num = ""
        pos = pos + 4
        Do While pos <= Len(line)
            Dim ch
            ch = Mid(line, pos, 1)
            If ch >= "0" And ch <= "9" Then
                num = num & ch
                pos = pos + 1
            Else
                Exit Do
            End If
        Loop
        If num <> "" Then
            If killed = "" Then
                killed = num
            Else
                killed = killed & ", " & num
            End If
        End If
    End If
Next

If showMsg Then
    If killed <> "" Then
        MsgBox "缓存保温已停止（PID: " & killed & "）。", 64, "停止缓存保温"
    Else
        MsgBox "没有找到正在运行的缓存保温实例（端口 19388-19392）。", 64, "停止缓存保温"
    End If
End If
WScript.Quit 0
