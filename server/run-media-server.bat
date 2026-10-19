@echo off
setlocal
cd /d "%~dp0"
:loop
node media-server.js
if errorlevel 1 echo [%date% %time%] Media server stopped. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
