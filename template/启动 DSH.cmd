@echo off
setlocal
chcp 65001 >nul
"%~dp0runtime\node\node.exe" "%~dp0portable\launcher.mjs" start %*
if errorlevel 1 pause
