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

## 처음 연결 (연결 코드)
1. 설치 후 실행하면 TV 화면에 **6자리 연결 코드**가 크게 나온다 (10분마다 자동 갱신)
2. 병원 관리자 화면 → 디스플레이 선택 → **설치형 플레이어 연결**에 코드 입력 → 연결
3. TV에 "연결되었습니다"가 나오고 몇 초 뒤 송출 시작
- 주소를 직접 넣으려면 연결 코드 화면 왼쪽 아래 **주소 직접 입력 · 설정**
- DB에 `supabase/v2.35.85-tv-pairing.sql` 적용 필요

## 설정 / 종료
- 켤 때마다 화면 아래에 10초간 단축키 안내가 나온다 (Esc·Alt+F4를 누를 때도 다시 표시)
- 설정 `Ctrl+Shift+F12` · 새로고침 `Ctrl+Shift+R` · 종료 `Ctrl+Shift+Q` (mac은 Ctrl 대신 Cmd)
- 윈도우 작업표시줄 / 맥 메뉴 막대 아이콘 메뉴: 설정 열기 · 새로고침 · 다른 디스플레이로 다시 연결 · 종료

## Windows
- 설치: `ClinicSignageSetup-1.1.0.exe` 실행 → 관리자 권한 불필요 (사용자 폴더에 설치)
- 첫 실행 시 TV에 나오는 연결 코드를 관리자 화면에 입력
- 무인/대량 설치:
  ```
  ClinicSignageSetup-1.1.0.exe /S /URL=https://signage-lake.vercel.app/player.html?key=TV키
  ClinicSignageSetup-1.1.0.exe /S /KEY=TV키
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
