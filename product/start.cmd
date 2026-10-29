@echo off
setlocal
cd /d "%~dp0"
if exist "src-tauri\target\release\photo-all.exe" (
  start "" "src-tauri\target\release\photo-all.exe"
  exit /b
)
if exist "src-tauri\target\debug\photo-all.exe" (
  start "" "src-tauri\target\debug\photo-all.exe"
  exit /b
)
echo First build: npm install
echo Then: npm run build
echo Then: cd src-tauri
echo cargo build --features custom-protocol
pause
endlocal
