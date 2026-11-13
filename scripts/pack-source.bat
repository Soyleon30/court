@echo off
setlocal
cd /d "%~dp0.."

echo Packing basketball-tactics source package...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0pack-source.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Pack failed with exit code %EXIT_CODE%.
) else (
  echo.
  echo Pack completed. Upload the generated dist\basketball-tactics-source_*.tar.gz file.
)
echo.
pause
exit /b %EXIT_CODE%
