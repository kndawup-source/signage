@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js LTS가 필요합니다.& pause & exit /b 1)
if not exist config.json (echo config.json을 먼저 만들어주세요.& pause & exit /b 1)
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
>"%STARTUP%\Clinic-Signage-Media-Server.cmd" echo @echo off
>>"%STARTUP%\Clinic-Signage-Media-Server.cmd" echo call "%~dp0run-media-server.bat"
echo 자동실행 등록 완료: Windows 로그인 후 영상 서버가 자동으로 시작됩니다.
pause
