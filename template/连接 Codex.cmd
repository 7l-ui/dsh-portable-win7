@echo off
setlocal
chcp 65001 >nul
if "%~1"=="--register" goto register
echo 便携 DSH 的可选 Codex 接入。下面仅显示配置，不修改当前 Codex。
"%~dp0runtime\node\node.exe" "%~dp0portable\mcp.mjs" --config
echo.
echo 要在这台电脑注册，请运行："%~f0" --register
echo 注册后重新打开 Codex 并新建任务。移动便携包后需重新配置路径。
if "%~1"=="" pause
exit /b 0
:register
"%~dp0runtime\node\node.exe" "%~dp0portable\mcp.mjs" %*
exit /b %errorlevel%
