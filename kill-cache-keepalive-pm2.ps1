<#
.SYNOPSIS
  清理缓存保温进程。只杀 pm2：pm2 应用 + pm2 daemon。不碰直启进程、不查端口。

.PARAMETER KeepDaemon
  保留 pm2 daemon。daemon 不可达时拒绝执行：那种状态下强杀后会被 autorestart 拉回。

.PARAMETER DryRun
  只列清单，不动手，也不调 pm2（EPERM 状态下连 ping 都会新 spawn 一个 daemon）。

.PARAMETER NoPause
  结束时不等待回车。

.OUTPUTS
  退出码：0 = 清理干净或演练结束；2 = 仍有残留；3 = 参数组合无法保证清理。
#>
[CmdletBinding()]
param(
  [switch] $KeepDaemon,
  [switch] $DryRun,
  [switch] $NoPause
)

. (Join-Path $PSScriptRoot '_keepalive-common.ps1')
$ErrorActionPreference = 'Continue'

$isAdmin = $false
try { $isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }

Say ''
Say '缓存保温 · 清理（只杀 pm2：应用 + daemon，不碰直启进程与端口）'
Say ("  身份  " + $(if ($isAdmin) { '管理员' } else { '普通权限（杀 pm2 daemon 需要管理员）' }))
if (-not $isAdmin) {
  Say '  ⚠️  杀 pm2 daemon 需要管理员权限。请右键「以管理员身份运行」本脚本，或运行 kill-cache-keepalive-pm2.bat（快捷方式已勾选管理员）。' -ForegroundColor Red
}
Say ("  模式  " + $(if ($DryRun) { '演练（不动手，也不调 pm2）' } else { '执行' }) + $(if ($KeepDaemon) { ' · 保留 pm2 daemon' } else { '' }))
Say ''

$pm2Exe = Find-Pm2
$nodes = Get-NodeTable

# ── 1) pm2 应用
$targetPids = $null
$daemonOk = $false
$pipe = Test-PipeCapture
if (-not $pm2Exe) { Say '[1/2] pm2 应用：找不到 pm2 → 跳过' }
elseif ($DryRun) { Say '[1/2] pm2 应用：[dry-run] 不调 pm2' }
elseif ($pipe) { Say '[1/2] pm2 应用：输出被重定向，不调 pm2（会 spawn daemon 并挂死调用方）' }
else {
  $ping = Invoke-Pm2 $pm2Exe @('ping')
  if ($ping.Ok -and $ping.Code -eq 0) {
    $daemonOk = $true
    $targetPids = Get-Pm2TargetPids $pm2Exe
    if ($targetPids -and $targetPids.Count -gt 0) {
      Say "[1/2] pm2 应用：delete $($script:Pm2App)（pid $($targetPids -join ',')）"
      $r = Invoke-Pm2 $pm2Exe @('delete', $script:Pm2App)
      if (-not $r.Ok -or $r.Code -ne 0) { Say "  pm2 delete 未成功：$((($r.Err + $r.Out) -replace '\s+', ' ').Trim())" }
    }
    else { Say "[1/2] pm2 应用：pm2 里没有本插件的 $($script:Pm2App)" }
  }
  else { Say '[1/2] pm2 应用：daemon 不可达（connect EPERM）→ 跳过' }
}

# ── 2) pm2 daemon
Say ''
Say '[2/2] pm2 daemon'
$daemons = @(Get-Pm2Daemons $nodes)
if ($KeepDaemon) { Say "  保留（-KeepDaemon）；当前 $($daemons.Count) 个" }
elseif ($daemons.Count -eq 0) { Say '  无' }
else {
  Say "  发现 $($daemons.Count) 个 —— 同一 daemon 管理的其他 pm2 应用也会被停止"
  foreach ($p in $daemons) { Stop-One $p 'pm2 daemon' -DryRun:$DryRun }
}

# ── 安全闸：-KeepDaemon 与「daemon 不可达」不能同时成立
if ($KeepDaemon -and -not $DryRun -and -not $daemonOk) {
  Say ''
  Say '[拒绝] -KeepDaemon 与「daemon 不可达」同时成立时无法保证清理：' -ForegroundColor Red
  Say '       pm2 托管的 keepalive 被强杀后，存活 daemon 会按 autorestart 拉回来（最多 10 次）。'
  Say '       去掉 -KeepDaemon 重跑（默认连 daemon 一起清）。'
  Hold-Open -NoPause:$NoPause
  exit 3
}

Say ''
if ($DryRun) { Say '（演练模式：上面都是"将杀"清单，未执行任何清理）' -ForegroundColor DarkGray }
elseif ($script:stopFailed -gt 0) { Say "清理完成，但有 $($script:stopFailed) 个杀不掉（多半需要管理员）。" -ForegroundColor Yellow }
else { Say '清理完成。' -ForegroundColor Green }

Hold-Open -NoPause:$NoPause
if ($DryRun) { exit 0 }
if ($script:stopFailed -gt 0) { exit 2 }
exit 0