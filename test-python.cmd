@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Run Run-Python.cmd once to create the virtual environment.
  pause
  exit /b 1
)
.venv\Scripts\python.exe -m unittest discover -s tests -v
pause
