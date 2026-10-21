@echo off
setlocal
cd /d "%~dp0"
echo ========================================================
echo   Iniciando PhoenixBlackNest (Arquitectura Desacoplada GPU)
echo ========================================================
echo.
set "PYTHONNOUSERSITE=1"
set "PYTHONUTF8=1"
if exist "%~dp0runtime\python\python.exe" set "PHOENIXBLACKNEST_PYTHON=%~dp0runtime\python\python.exe"
if exist "%~dp0node_modules\electron\dist\electron.exe" (
    "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
) else (
    call "%~dp0node_modules\.bin\electron.cmd" "%~dp0."
)
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Fallo al iniciar Electron.
    pause
)
