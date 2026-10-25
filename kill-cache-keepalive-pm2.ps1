# 兼容壳：等价 kill-cache-keepalive.ps1 -Pm2。文件名为历史约定，快捷方式与 README 都引用它。
[CmdletBinding()]
param(
  [switch] $Force,
  [switch] $KeepDaemon,
  [switch] $DryRun,
  [switch] $NoPause
)

$impl = Join-Path $PSScriptRoot 'kill-cache-keepalive.ps1'
if (-not (Test-Path -LiteralPath $impl)) { Write-Host "[失败] 找不到 $impl"; exit 1 }
& $impl -Pm2 -Force:$Force -KeepDaemon:$KeepDaemon -DryRun:$DryRun -NoPause:$NoPause
exit $LASTEXITCODE
