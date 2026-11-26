@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-WinForms.ps1
if errorlevel 1 (
  pause
  exit /b 1
)
start "" winforms\ProxyForge.WinForms.exe
