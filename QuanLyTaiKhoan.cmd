@echo off
cd /d "%~dp0"
if not exist "QLTK.jar" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-manager.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
start "" javaw -jar "%~dp0QLTK.jar"
