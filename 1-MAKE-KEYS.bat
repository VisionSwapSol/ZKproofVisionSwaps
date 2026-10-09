@echo off
title VisionSwap - make keys
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is missing. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules (echo Installing VisionSwap's tools, one moment... & call npm.cmd install --no-audit --no-fund)
node --import tsx ops\keys.ts
echo.
pause
