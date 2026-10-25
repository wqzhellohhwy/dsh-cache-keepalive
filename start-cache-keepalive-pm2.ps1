<#
.SYNOPSIS
  用 pm2 拉起 / 管理缓存保温（dsh-cache-keepalive），并在窗口里给出可见反馈。

.PARAMETER Action
  up        确保在跑：不在 pm2 里就 start，已存在就 restart（刷新代码/配置）。默认。
  restart   强制重启（不存在则启动）
  stop      停止并从 pm2 列表中移除
  status    只看状态，不动进程
  logs      实时跟踪日志（Ctrl+C 退出）
  open      只打开面板

.PARAMETER NoPause
  结束时不等待回车（给脚本/自动化调用）。
#>
[CmdletBinding()]
param(
  [ValidateSet('up', 'restart', 'stop', 'status', 'logs', 'open')]
  [string] $Action = 'up',
  [switch] $NoPause
)

. (Join-Path $PSScriptRoot '_keepalive-common.ps1')
$ErrorActionPreference = 'Stop'

function Fail([string] $m) {
  Say ''
  Write-Host "[失败] $m" -ForegroundColor Red
  Hold-Open -NoPause:$NoPause
  exit 1
}

Set-Location -LiteralPath $script:SelfDir
$eco = @('ecosystem.config.cjs', 'ecosystem.config.js') |
  ForEach-Object { Join-Path $script:SelfDir $_ } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $eco) { Fail "找不到 pm2 配置文件（ecosystem.config.cjs）：$($script:SelfDir)" }
$ecoName = [IO.Path]::GetFileName($eco)

$pm2 = Find-Pm2
if (-not $pm2) { Fail '找不到 pm2。先装：npm i -g pm2' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'PATH 里没有 node（pm2 需要它跑 keepalive.mjs）' }

Say ''
Say '缓存保温 · pm2 启动器' -ForegroundColor Cyan
Say "  插件目录  $($script:SelfDir)"
Say "  配置      $ecoName"
Say "  pm2       $pm2"
Say "  动作      $Action"
Say ''

# daemon 预检放在 ps1 里（原先在 bat）：不可达时起会注册第二份、每次调用还会再 spawn 一个 daemon
# 输出被管道/文件捕获时一律不碰 pm2：daemon 冷启动会让它继承那根写端句柄，调用方等 EOF 就永不返回（2026-10-25 实测 >60s）
if (Test-PipeCapture) {
  Fail ('本脚本是交互式启动器，输出被重定向/管道捕获时不调 pm2（daemon 会继承写端句柄，导致调用方挂死）。' +
    '请在窗口里双击 start-cache-keepalive-pm2.bat 运行；自动化请直接用 pm2 命令。')
}

$pingTimeout = if ($Action -eq 'stop') { 10000 } else { 60000 }
$ping = Invoke-Pm2 $pm2 @('ping') $pingTimeout
if (-not ($ping.Ok -and $ping.Code -eq 0)) {
  if ($Action -in @('up', 'restart')) {
    Fail ('pm2 daemon 不可达（connect EPERM \\\.\\pipe\\rpc.sock）。先右键「以管理员身份运行」' +
      (Join-Path $script:SelfDir 'kill-cache-keepalive-pm2.bat') + '，再重试。')
  }
  Say '  pm2 daemon 不可达 → 本动作不依赖它，继续' -ForegroundColor DarkYellow
}

$logFile = Join-Path $env:USERPROFILE '.pm2\logs\keepalive-out.log'

switch ($Action) {
  'up' {
    $d = Invoke-Pm2 $pm2 @('describe', $script:Pm2App)
    if ($d.Ok -and $d.Code -eq 0) {
      Say '已在 pm2 中 → 重启（刷新代码/配置）' -ForegroundColor Yellow
      $r = Invoke-Pm2 $pm2 @('restart', $script:Pm2App)
    }
    else {
      Say "首次启动 → pm2 start $ecoName" -ForegroundColor Yellow
      $r = Invoke-Pm2 $pm2 @('start', $eco)
    }
    if (-not $r.Ok -or $r.Code -ne 0) { Fail "pm2 命令失败：$((($r.Err + $r.Out) -replace '\s+', ' ').Trim())" }
  }
  'restart' {
    $d = Invoke-Pm2 $pm2 @('describe', $script:Pm2App)
    if ($d.Ok -and $d.Code -eq 0) { $r = Invoke-Pm2 $pm2 @('restart', $script:Pm2App) }
    else { $r = Invoke-Pm2 $pm2 @('start', $eco) }
    if (-not $r.Ok -or $r.Code -ne 0) { Fail "pm2 命令失败：$((($r.Err + $r.Out) -replace '\s+', ' ').Trim())" }
  }
  'stop' {
    Say '  正在停止…' -ForegroundColor DarkGray
    $d = Invoke-Pm2 $pm2 @('describe', $script:Pm2App) 10000
    if ($d.Ok -and $d.Code -eq 0) {
      $null = Invoke-Pm2 $pm2 @('delete', $script:Pm2App) 10000
      Say '已从 pm2 中移除。'
    }
    elseif (-not $d.Ok) {
      Say '  pm2 daemon 无响应（可能正在启动中），跳过 pm2 侧清理。'
    }
    else { Say '（本来就不在 pm2 里）' }
  }
  'logs' {
    Say '日志跟踪中 —— Ctrl+C 退出' -ForegroundColor DarkGray
    & $pm2 logs $script:Pm2App --lines 40
    exit 0
  }
}

if ($Action -in @('up', 'restart', 'status')) { Say ''; & $pm2 list }

# 注册校验必须在 Hold-Open 之前（否则回车后还要再等一次 pm2 往返）
if ($Action -in @('up', 'restart')) {
  $r = Invoke-Pm2 $pm2 @('pid', $script:Pm2App)
  $kp = (($r.Out + '') -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
  if (-not $kp -or $kp.Trim() -eq '0') {
    Fail "keepalive 没有注册进 pm2 —— 启动并没有真正成功。看日志：$logFile（.err 同名）"
  }
  Say "校验  pm2 已注册，pid $($kp.Trim())" -ForegroundColor DarkGray
}

if ($Action -eq 'stop') {
  Say ''
  Say '已停止，并从 pm2 列表中移除。' -ForegroundColor Yellow
  Say '重新启动：start-cache-keepalive-pm2.bat'
  Hold-Open -NoPause:$NoPause
  exit 0
}

$panel = $null
if (Test-Path -LiteralPath $logFile) {
  $hits = @(Select-String -LiteralPath $logFile -Pattern 'http://127\.0\.0\.1:\d+/api/cache-keepalive/panel' -ErrorAction SilentlyContinue)
  if ($hits.Count -gt 0) { $panel = $hits[-1].Matches[-1].Value }
}
if (-not $panel) { $panel = 'http://127.0.0.1:19388/api/cache-keepalive/panel' }

Say ''
Say "面板  $panel" -ForegroundColor Green
Say "日志  $logFile"
Say '      （.err 同名）'
Say '停止  start-cache-keepalive-pm2.bat stop'
Say '开机自启  pm2 save  然后  pm2 startup（按提示再执行一行）'

if ($Action -eq 'open') {
  Say ''
  Say '正在用默认浏览器打开面板…'
  Start-Process $panel
}

Say ''
Hold-Open -NoPause:$NoPause
exit 0
