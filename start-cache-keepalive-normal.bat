@echo off
cd /d "%~dp0"
set "CK_YES_I_WILL_PAY=1"

rem Single-instance guard: panel port 19388 is fixed. If something is already
rem listening on it, another daemon is running - starting a second one makes two
rem loops warm the same session seconds apart (second warm misses the cache).
rem Usage must stay ASCII-only (console code page).
netstat -ano | findstr /C:":19388" | findstr /C:"LISTEN" >nul 2>&1
if not errorlevel 1 (
  echo [cache-keepalive] Already running on http://127.0.0.1:19388/ - not starting a second daemon.
  exit /b 0
)

node cli\keepalive.mjs --serve --auto --open
