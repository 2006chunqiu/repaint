@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo   已生成 .env。想接真模型就填进 Key，只想先看看效果可以直接继续。
  echo.
)

where node >nul 2>nul
if errorlevel 1 (
  echo   没有找到 node。请先安装 Node.js 18 或更高版本：https://nodejs.org
  pause
  exit /b 1
)

node server\server.js
pause
