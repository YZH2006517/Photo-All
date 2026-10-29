@echo off
setlocal
set PYTHONDONTWRITEBYTECODE=1
cd /d "%~dp0"
if exist "%~dp0python\pythonw.exe" (
  if "%~1"=="" ("%~dp0python\pythonw.exe" app.py) else ("%~dp0python\pythonw.exe" app.py --receive "%~1")
  goto finish
)
if defined PHOTOALL_PYTHON (
  if "%~1"=="" ("%PHOTOALL_PYTHON%" app.py) else ("%PHOTOALL_PYTHON%" app.py --receive "%~1")
  goto finish
)
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  if "%~1"=="" ("%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" app.py) else ("%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" app.py --receive "%~1")
  goto finish
)
if "%~1"=="" (py -3 app.py) else (py -3 app.py --receive "%~1")
:finish
if errorlevel 1 pause
endlocal
