@echo off
chcp 65001 >nul
title GapGraph 开发模式
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 npm。请先安装 Node.js ^( https://nodejs.org ^) 并重新打开命令行。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 首次运行，正在安装依赖，请稍候...
  call npm install --ignore-scripts
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络。
    pause
    exit /b 1
  )
  call node node_modules\electron\install.js
)

echo.
echo 正在启动 GapGraph ... 关闭本窗口即停止。
echo.
call npm run dev

echo.
echo 应用已退出。若上方有红色报错，请截图反馈。
pause
