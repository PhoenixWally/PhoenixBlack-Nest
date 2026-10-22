@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================================
echo   PhoenixBlackNest - Industrial GPU Nesting
echo ========================================================
echo.

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
    echo [ERROR] No se encontro node_modules\electron.
    echo         Ejecuta primero:  npm install
    echo.
    pause
    exit /b 1
)

set "PYTHONNOUSERSITE=1"
set "PYTHONUTF8=1"
if exist "%~dp0runtime\python\python.exe" set "PHOENIXBLACKNEST_PYTHON=%~dp0runtime\python\python.exe"

"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo [ERROR] Electron termino con codigo %RC%.
    echo         Revisa la consola de arriba: los fallos de GPU, Python o carga de UI
    echo         se registran con prefijos [UNCAUGHT], [UI], [GPU Worker] o [UNHANDLED].
    pause
)
exit /b %RC%
