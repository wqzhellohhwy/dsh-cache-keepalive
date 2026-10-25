<#
.SYNOPSIS
  清理缓存保温进程。只杀 normal：直启 node 进程 + 端口兜底。不碰 pm2。

.PARAMETER DryRun
  只列清单，不动手。

.PARAMETER NoPause
  结束时不等待回车。

.OUTPUTS
  退出码：0 = 清理干净或演练结束；2 = 仍有残留。
#>
[CmdletBinding()]
param(
  [switch] $DryRun,
  [switch] $NoPause
)

. (Join-Path $PSScriptRoot '_keepalive-common.ps1')
$ErrorActionPreference = 'Continue'

Say ''
Say '缓存保温 · 清理（只杀 normal：直启进程 + 端口，不碰 pm2）'
Say ("  模式  " + $(if ($DryRun) { '演练（不动手）' } else { '执行' }))
Say ''

$nodes = Get-NodeTable
$listen = Get-ListenInRange

# ── 1) 进程
Say ''
Say '[1/2] 进程'
$victims = @{}
foreach ($p in @(Get-DirectKeepalive $nodes)) { $victims[[int]$p.ProcessId] = 'node 直跑 cli\keepalive.mjs' }
if ($victims.Count -eq 0) { Say '  无' }
else { foreach ($k in @($victims.Keys)) { Stop-One $nodes[$k] $victims[$k] -DryRun:$DryRun } }

# ── 2) 端口兜底（用开头那份快照，不再逐端口查）
Say ''
Say '[2/2] 面板端口兜底复查 19388-19392'
foreach ($c in $listen) {
  $p = $nodes[[int]$c.OwningProcess]
  if (-not $p) { continue }
  if ($victims.Contains([int]$p.ProcessId)) { continue }
  if (Test-IsKeepaliveCmd $p.CommandLine) { Stop-One $p "占着端口 $($c.LocalPort)" -DryRun:$DryRun }
}

Say ''
if ($DryRun) { Say '（演练模式：上面都是"将杀"清单，未执行任何清理）' -ForegroundColor DarkGray }
elseif ($script:stopFailed -gt 0) { Say "清理完成，但有 $($script:stopFailed) 个杀不掉（多半需要管理员）。" -ForegroundColor Yellow }
else { Say '清理完成。' -ForegroundColor Green }

Hold-Open -NoPause:$NoPause
if ($DryRun) { exit 0 }
if ($script:stopFailed -gt 0) { exit 2 }
exit 0