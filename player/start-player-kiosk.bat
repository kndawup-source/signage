@echo off
setlocal
cd /d "%~dp0"
if not exist player-url.txt (echo player-url.example.txt를 player-url.txt로 복사하고 이 진료실의 플레이어 URL을 넣으세요.& pause & exit /b 1)
set /p PLAYER_URL=<player-url.txt
if "%PLAYER_URL%"=="" (echo player-url.txt가 비어 있습니다.& pause & exit /b 1)
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" (echo Google Chrome을 찾을 수 없습니다.& pause & exit /b 1)
set "PROFILE=%LOCALAPPDATA%\ClinicSignagePlayer"
start "" "%CHROME%" --user-data-dir="%PROFILE%" --kiosk --no-first-run --disable-session-crashed-bubble --disable-translate --autoplay-policy=no-user-gesture-required --app="%PLAYER_URL%"
