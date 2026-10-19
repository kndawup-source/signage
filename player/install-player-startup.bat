@echo off
setlocal
cd /d "%~dp0"
if not exist player-url.txt (echo player-url.example.txt를 player-url.txt로 복사하고 URL을 입력하세요.& pause & exit /b 1)
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
>"%STARTUP%\Clinic-Signage-Player.cmd" echo @echo off
>>"%STARTUP%\Clinic-Signage-Player.cmd" echo call "%~dp0start-player-kiosk.bat"
echo 자동실행 등록 완료: Windows 로그인 후 플레이어가 자동 실행됩니다.
echo AC 전원 사용 시 화면 끄기/절전/최대절전이 사용 안 함으로 설정되었습니다.
pause
