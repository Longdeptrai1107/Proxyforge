@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto usepython
py -3 --version >nul 2>nul
if errorlevel 1 goto usepython
py -3 -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>nul
if errorlevel 1 goto usepython
py -3 -m venv .venv 2>nul
if not exist .venv\Scripts\python.exe goto usepython
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto failed
goto run
:usepython
where python >nul 2>nul
if errorlevel 1 (
  echo Install Python 3.11 or newer: https://python.org/
  pause
  exit /b 1
)
python -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>nul
if errorlevel 1 (
  echo Python 3.11 or newer is required.
  pause
  exit /b 1
)
python -m venv .venv 2>nul
if not exist .venv\Scripts\python.exe goto failed
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto failed
:run
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Web.ps1
if errorlevel 1 goto failed
goto end
:failed
echo Python setup failed. See README.md for manual instructions.
pause
exit /b 1
:end
