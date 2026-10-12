@echo off
setlocal

REM ---------------------------------------------------------------------------
REM PBIP Lineage Explorer - one-click launcher (Windows)
REM
REM Double-click this file. It will:
REM   1. check Node.js is available
REM   2. install dependencies the first time only
REM   3. start the local server and open your browser
REM
REM Nothing is uploaded anywhere - the server is local to this machine and your
REM PBIP files are read entirely inside the browser.
REM ---------------------------------------------------------------------------

cd /d "%~dp0"

echo ============================================
echo   PBIP Lineage Explorer
echo ============================================
echo.

REM --- 1. Node.js present? -----------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto no_node

for /f "delims=" %%v in ('node --version 2^>nul') do set NODE_VERSION=%%v
echo Node.js %NODE_VERSION% detected.
echo.

REM --- 2. Dependencies installed? ----------------------------------------------
if exist "node_modules\vite\package.json" goto have_deps

echo First run - installing dependencies. This takes a few minutes.
echo (Only happens once.)
echo.
call npm install
if errorlevel 1 goto install_failed
echo.
echo Dependencies installed.
echo.

:have_deps

REM --- 3. Launch ----------------------------------------------------------------
echo Starting the local server...
echo.
echo   Your browser should open automatically.
echo   If it does not, open:  http://localhost:5173
echo.
echo   Use Chrome or Edge - Firefox and Safari cannot open folders.
echo.
echo   Leave this window open while using the tool.
echo   Press Ctrl+C here (or just close the window) to stop.
echo.

REM Give Vite a moment to bind the port before opening the browser.
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start "" http://localhost:5173"

call npm run dev

echo.
echo Server stopped.
pause
exit /b 0

REM --- Error paths --------------------------------------------------------------
:no_node
echo [!] Node.js was not found on this machine.
echo.
echo     PBIP Lineage Explorer needs Node.js to serve the page locally.
echo     It is free and installing it does not change anything else.
echo.
echo     Download the "LTS" version from:  https://nodejs.org
echo.
echo     On a managed work computer you may need to install it through your
echo     company software centre, or ask IT.
echo.
echo     After installing, close this window and double-click start.bat again.
echo.
pause
exit /b 1

:install_failed
echo.
echo [!] "npm install" did not finish successfully.
echo.
echo     Common causes:
echo       - no internet connection, or a proxy blocking the npm registry
echo       - a corporate firewall requiring npm proxy configuration
echo.
echo     Try running  npm install  in this folder to see the full error.
echo.
pause
exit /b 1
