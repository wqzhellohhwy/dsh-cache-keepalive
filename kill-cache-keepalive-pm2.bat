@echo off
rem ============ kill-cache-keepalive-pm2.bat : run the .ps1 next to it ============
rem Usage: kill-cache-keepalive-pm2.bat [-Force] [-KeepDaemon] [-DryRun] [-NoPause]
rem Meant for a shortcut with "Run as administrator" checked (killing the pm2 daemon needs admin).
rem ASCII-only on purpose so it renders in any console code page.
setlocal EnableExtensions
cd /d "%~dp0"
set "PS1=%~dp0kill-cache-keepalive-pm2.ps1"
if not exist "%PS1%" goto :nops1
set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%PWSH%" for %%i in (pwsh.exe) do set "PWSH=%%~$PATH:i"
if not exist "%PWSH%" set "PWSH=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PWSH%" goto :nopwsh
"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %ERRORLEVEL%
:nops1
echo [FAIL] kill-cache-keepalive-pm2.ps1 not found next to this file.
pause
exit /b 1
:nopwsh
echo [FAIL] no PowerShell found.
pause
exit /b 1
