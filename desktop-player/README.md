# Clinic Signage Player (Windows / macOS 설치형)

웹 플레이어(`player.html?key=TV키`)를 키오스크 전체화면으로 띄우는 설치형 앱.
재생·오프라인 캐시·원격 업데이트는 기존 웹 플레이어가 그대로 하고, 이 앱은 24시간 무인 송출에 필요한 것만 담당한다.

| 기능 | 내용 |
|---|---|
| 자동 실행 | 로그인 시 자동 시작 (설정에서 끔 가능) |
| 절전 방지 | 실행 중 화면/시스템 절전 차단 |
| 자동 복구 | 렌더러 크래시 3초 후, 무응답 30초 지속 시, 60초 헬스체크 실패 시 재시작 |
| 오프라인 | 첫 로드 실패 시 "연결 대기" 화면 → 15초마다 재시도 (이후엔 웹 플레이어 SW 캐시로 재생) |
| 정기 새로고침 | 매일 04:00~04:30 사이 1회 (설정에서 시각 변경/해제) |
| 키오스크 | 커서 숨김, Esc/F11/창 닫기 차단, 외부 사이트 이동·팝업 차단 |
| 다중 모니터 | 출력 화면 선택, 모니터 연결/해제 시 위치 재조정 |

## 단축키 (송출 화면)
- 설정: `Ctrl+Shift+F12` (mac `Cmd+Shift+F12`)
- 새로고침: `Ctrl+Shift+R`
- 종료: `Ctrl+Shift+Q`

## Windows
- 설치: `ClinicSignageSetup-1.0.0.exe` 실행 → 관리자 권한 불필요 (사용자 폴더에 설치)
- 첫 실행 시 플레이어 주소(또는 TV 키) 입력
- 무인/대량 설치:
  ```
  ClinicSignageSetup-1.0.0.exe /S /URL=https://signage-lake.vercel.app/player.html?key=TV키
  ClinicSignageSetup-1.0.0.exe /S /KEY=TV키
  ```
- 제거: 설정 > 앱 > Clinic Signage Player, 또는 `Uninstall.exe /S`
- 설정·영상 캐시 위치: `%APPDATA%\Clinic Signage Player` (제거해도 유지 → 재설치 시 바로 송출)
- 코드서명이 없어 SmartScreen "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**

## macOS
- `.dmg`(CI 빌드) 또는 `.zip`을 열어 앱을 **응용 프로그램** 폴더로 옮긴 뒤 실행
- 애플 실리콘(M1~M4)은 `mac-arm64`, 인텔 맥은 `mac-x64`
- 서명/공증 전 빌드는 처음 한 번 터미널에서:
  ```
  xattr -dr com.apple.quarantine "/Applications/Clinic Signage Player.app"
  codesign --force --deep -s - "/Applications/Clinic Signage Player.app"
  ```
  (CI에서 ad-hoc 서명된 dmg는 첫 줄만 필요. Developer ID 서명+공증 빌드는 둘 다 불필요)
- 로그인 자동 실행이 안 붙으면: 시스템 설정 > 일반 > 로그인 항목에 앱 추가

## 명령줄 옵션
```
--player-url="https://.../player.html?key=UUID"
--key=UUID [--base-url=https://signage-lake.vercel.app]
--no-autostart
--reset          (설정 초기화 → 설정 화면)
```

## 빌드
```
npm ci
npm run dist:win   # Windows: electron-builder dir + build/win-finish.js(아이콘 적용 + NSIS)
npm run dist:mac   # macOS 에서만 dmg 가능
```
저장소 루트에 `.github/workflows/desktop-player.yml`을 두면 GitHub Actions에서 Windows/macOS 설치 파일을 함께 만든다.
macOS 정식 배포(경고 없이 설치)는 Apple Developer ID(연 $99) 인증서를 Secrets에 넣으면 서명+공증까지 자동.

로그: `%APPDATA%\Clinic Signage Player\logs\player.log` / `~/Library/Application Support/Clinic Signage Player/logs/player.log`
