# 把正在跑的缓存保温实例的控制台窗口调出来。由 show-cache-keepalive.vbs 以隐藏窗口调用，结果写 -OutFile。
param([string] $OutFile = '')

. (Join-Path $PSScriptRoot '_keepalive-common.ps1')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CkCon {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@ -ErrorAction SilentlyContinue

$lines = New-Object System.Collections.ArrayList
$nodes = Get-NodeTable
$listen = Get-ListenInRange
$targets = @{}
foreach ($c in $listen) {
  $p = $nodes[[int]$c.OwningProcess]
  if ($p -and (Test-IsKeepaliveCmd $p.CommandLine)) { $targets[[int]$p.ProcessId] = [int]$c.LocalPort }
}

if ($targets.Count -eq 0) {
  [void]$lines.Add('没有找到正在运行的缓存保温实例（端口 19388-19392）。')
}
else {
  # 自己的控制台要先放掉，否则 AttachConsole 会因「已附着」失败。本脚本由 vbs 以无窗口方式跑，放掉无副作用。
  $null = [CkCon]::FreeConsole()
  foreach ($k in @($targets.Keys)) {
    $port = $targets[$k]
    $attached = [CkCon]::AttachConsole([uint32]$k)
    $h = if ($attached) { [CkCon]::GetConsoleWindow() } else { [IntPtr]::Zero }
    if ($attached) { $null = [CkCon]::FreeConsole() }
    if ($h -ne [IntPtr]::Zero) {
      $null = [CkCon]::ShowWindow($h, 9)
      $null = [CkCon]::SetForegroundWindow($h)
      [void]$lines.Add("已显示 pid $k（端口 $port）的控制台窗口。")
    }
    else {
      [void]$lines.Add("pid $k（端口 $port）没有控制台窗口 —— 它是无窗口 / pm2 方式启动的，窗口调不出来。")
    }
  }
  if (-not ($lines | Where-Object { $_ -match '已显示' })) {
    [void]$lines.Add('')
    [void]$lines.Add('看日志：')
    [void]$lines.Add('  ' + (Join-Path $env:DSH_HOME 'cache-keepalive\cli-serve.log'))
    [void]$lines.Add('  ' + (Join-Path $env:USERPROFILE '.pm2\logs\keepalive-out.log'))
    [void]$lines.Add('或者直接开面板：http://127.0.0.1:<端口>/api/cache-keepalive/panel')
  }
}

$text = ($lines -join "`r`n")
if ($OutFile) {
  Set-Content -LiteralPath $OutFile -Value $text -Encoding utf8
}
else {
  Write-Host $text
}
