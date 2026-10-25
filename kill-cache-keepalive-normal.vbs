' 缓存保温 停止脚本（WMI 轻量版）
' 特点：不调 PowerShell、不自动提权 —— 360 主动防御不会把它当 dropper 报毒。
' 用法：双击即可（普通权限能杀你自己起的实例）；pm2 daemon 是管理员起的时，
'       改用 kill-cache-keepalive.lnk（已勾「以管理员身份运行」）。加 /silent 不弹框。

Option Explicit
Dim sh, wmi, col, p, cmd, re, killed, failed, showMsg, tag

showMsg = Not WScript.Arguments.Named.Exists("silent")
Set sh = CreateObject("WScript.Shell")

' 判据与 ps1 的 Test-IsKeepaliveCmd 同源：node 必须是首个可执行文件，紧跟的脚本参数以 cli/keepalive.mjs 结尾。
' 不能只匹配 "keepalive.mjs" —— 编辑器、grep、别的脚本的命令行里也会带这串字。
Set re = New RegExp
re.Pattern = "^(node(\.exe)?|""[^""]*node(\.exe)?"")\s+(""?[^""\s]*cli[\\/]keepalive\.mjs)"
re.IgnoreCase = True

Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set col = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")

killed = ""
failed = ""
For Each p In col
    cmd = p.CommandLine
    If Not IsNull(cmd) Then
        If re.Test(cmd) Then
            tag = "cli\keepalive.mjs"
            If InStr(LCase(cmd), "cli/keepalive.mjs") > 0 Then tag = "cli/keepalive.mjs"
            If sh.Run("taskkill /PID " & p.ProcessId & " /T /F", 0, True) = 0 Then
                If killed = "" Then
                    killed = p.ProcessId
                Else
                    killed = killed & ", " & p.ProcessId
                End If
            Else
                If failed = "" Then
                    failed = p.ProcessId
                Else
                    failed = failed & ", " & p.ProcessId
                End If
            End If
        End If
    End If
Next

If showMsg Then
    If killed <> "" Then
        MsgBox "缓存保温已停止（PID: " & killed & "）。", 64, "停止缓存保温"
    ElseIf failed <> "" Then
        MsgBox "有进程杀不掉（PID: " & failed & "），需要管理员身份。" & vbCrLf & vbCrLf & _
               "请用 kill-cache-keepalive.lnk（已勾「以管理员身份运行」）再试一次。", 48, "停止缓存保温"
    Else
        MsgBox "没有找到正在运行的缓存保温实例（端口 19388-19392）。", 64, "停止缓存保温"
    End If
End If
WScript.Quit 0
