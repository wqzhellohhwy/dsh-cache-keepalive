# 缓存保温启停脚本公共件：进程/端口探测与 pm2 调用封装。四个入口 dot-source 本文件，不直接运行。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script:PanelPortLo = 19388
$script:PanelPortHi = 19392
$script:SelfDir = $PSScriptRoot
$script:Pm2App = 'keepalive'
$script:stopFailed = 0   # Stop-One 的失败计数（清理脚本的退出码判据）

function Say([string] $s) { Write-Host $s }

function Get-NodeTable {
  $h = @{}
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
    $h[[int]$p.ProcessId] = $p
  }
  $h
}

function Get-ListenInRange {
  @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -ge $script:PanelPortLo -and $_.LocalPort -le $script:PanelPortHi })
}

function Get-DirectKeepalive($nodes) { @($nodes.Values | Where-Object { Test-IsKeepaliveCmd $_.CommandLine }) }
function Get-Pm2Daemons($nodes) { @($nodes.Values | Where-Object { $_.CommandLine -match 'pm2\\lib\\Daemon' }) }
function Get-Pm2Forks($nodes) { @($nodes.Values | Where-Object { $_.CommandLine -match 'ProcessContainerFork' }) }

# 只认「node 直接跑本插件的 cli\keepalive.mjs」这一种命令行：
# 首个可执行文件必须是 node，且紧跟的脚本参数以 cli/keepalive.mjs 结尾。
# 不能用宽松的 -match 'keepalive.mjs' —— 任何命令行里带这串字样的进程（编辑器、grep、别的脚本）都会被误杀。
function Test-IsKeepaliveCmd([string] $cmd) {
  if (-not $cmd) { return $false }
  $cmd -match '^(?:"[^"]*node(?:\.exe)?"|node(?:\.exe)?)\s+"?[^"\s]*cli[\\/]keepalive\.mjs'
}

function Stop-One($proc, [string] $why, [switch] $DryRun) {
  if ($DryRun) { Say "  [dry-run] 将杀 pid=$($proc.ProcessId)  ($why)"; return }
  try {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    Say "  已杀 pid=$($proc.ProcessId)  ($why)"
  }
  catch { $script:stopFailed += 1; Say "  杀失败 pid=$($proc.ProcessId)：$($_.Exception.Message)" }
}

function Find-Pm2 {
  $p = Join-Path $env:APPDATA 'npm\pm2.cmd'
  if (Test-Path -LiteralPath $p) { return $p }
  $c = Get-Command pm2 -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $null
}

# pm2 唯一调用出口：-PassThru + WaitForExit + 输出落文件。
# 禁用两件事：① -Wait（等整棵进程树，pm2 daemon 是 detached 子孙 → 永等）；② 管道捕获 stdout（daemon 冷启动继承写端 → 永不 EOF）。两者实测均挂死 >60s。
function Invoke-Pm2([string] $Pm2, [string[]] $Params, [int] $TimeoutMs = 60000) {
  $dir = Join-Path $script:SelfDir '.tmp'
  if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
  $out = Join-Path $dir "pm2-$PID-out.txt"
  $err = Join-Path $dir "pm2-$PID-err.txt"
  try {
    $p = Start-Process -FilePath $Pm2 -ArgumentList $Params -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $done = $p.WaitForExit($TimeoutMs)
    [pscustomobject]@{
      Ok   = $done
      Code = $(if ($done) { $p.ExitCode } else { -1 })
      Out  = $(if (Test-Path -LiteralPath $out) { Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue } else { '' })
      Err  = $(if (Test-Path -LiteralPath $err) { Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue } else { '' })
    }
  }
  catch { [pscustomobject]@{ Ok = $false; Code = -1; Out = ''; Err = $_.Exception.Message } }
  finally { Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue }
}

# 只认本插件的 pm2 应用：按 app 名（ecosystem.config.cjs 里的 name）问 pm2 要 pid。
# 不解析 jlist 的 JSON —— 它的键大小写冲突（username/USERNAME）会让 ConvertFrom-Json 直接失败，-AsHashtable 又不兼容 5.1。
# 返回 $null = daemon 不可达（归属无法确认，调用方不得据此杀 pm2 托管进程，更不得凭 ProcessContainerFork 一杀了之）；空数组 = 可达但没有本插件应用。
function Get-Pm2TargetPids([string] $Pm2) {
  $r = Invoke-Pm2 $Pm2 @('pid', $script:Pm2App)
  if (-not $r.Ok -or $r.Code -ne 0) { return $null }
  $pids = @()
  foreach ($line in (($r.Out + '') -split "`r?`n")) {
    $t = $line.Trim()
    if ($t -match '^\d+$' -and [int]$t -ne 0) { $pids += [int]$t }
  }
  , $pids
}

function Hold-Open([switch] $NoPause) { if (-not $NoPause) { $null = Read-Host '按回车关闭窗口' } }

# stdout 被管道/文件捕获时为真。此环境下启动 pm2 daemon 会让 daemon 继承那根写端句柄（Windows 句柄表继承，不受 stdio 重定向影响），
# 调用方等到 EOF 就永不返回。故本环境下不主动 spawn daemon。
function Test-PipeCapture { [Console]::IsOutputRedirected }
