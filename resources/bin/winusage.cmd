@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\WinUsage.exe" "%~dp0..\app.asar\out\main\cli.js" %*
exit /b %ERRORLEVEL%
