# Clinic Signage v2.35.84 — 코드 리뷰 반영

## 적용 순서
1. DB 백업
2. Supabase SQL Editor에서 `supabase/v2.35.84-login-hardening.sql` 실행 (기존 DB). 신규 설치는 `schema.sql`에 포함됨.
3. `DELETE_FILES.txt`에 적힌 파일 삭제 (`js/admin.js`, `api/r2-delete.js`)
4. `node scripts/check-release.js` → OK 확인 후 Vercel 배포
5. 확인
   - 병원 주소(`/hospital.html?site=코드`)에서 병원 PIN 로그인 / 기본 주소에서 슈퍼어드민 로그인
   - 병원 영상 1개 업로드 (Content-Length 서명 적용 후 첫 업로드)
   - TV 1대가 2.35.84로 자동 갱신되는지 (최대 수 분, 재생 안전 지점에서 새로고침)

## 변경
- **TV 자동 업데이트 복구**: `player-release.json`이 실제 배포 버전보다 낮아 TV가 새 버전을 감지하지 못하던 문제. 이번 버전부터 2.35.84로 일치.
- **로그인 반복 시도 차단 강화** (`pin_login`)
  - 병원 주소에서는 그 병원 PIN만, 기본 주소에서는 슈퍼어드민 PIN만 검사.
  - 대상별 잠금 추가: 같은 병원(또는 슈퍼어드민)에 15분 안에 10번 틀리면 15분 잠금. 기기 ID·IP를 바꿔도 우회 불가. 잠금 발생은 감사 로그(action=security)에 기록.
  - 슈퍼어드민이 병원 PIN을 새로 설정하면 해당 병원 잠금은 즉시 해제.
  - PIN 자리수 정책은 변경 없음.
- **병원 PIN 설정 속도** (`admin_set_site_staff_pin`): "다른 병원에서 사용 중인 PIN" 검사 제거. 병원마다 bcrypt를 한 번씩 돌려 병원 수가 늘면 시간 초과로 실패할 수 있었음. 로그인이 병원 코드로 분리되어 PIN이 겹쳐도 안전.
- **업로드 용량 실제 적용**: 업로드 서명에 파일 크기(Content-Length) 포함. 신고한 크기와 다른 파일은 R2가 거부. 영상/도면/건물 이미지 모두 적용. 제한값(병원 350MB, 슈퍼어드민 2GB, 도면 12MB, 건물 4MB)은 그대로.
- `api/hospital-video-presign.js`: 화면에서 쓰지 않는 구 경로였는데 병원 계정에 2GB를 허용하고 있었음 → `r2-presign`으로 위임해 같은 규칙 적용.
- `api/_lib/auth.js`: Vercel Preview/Development 배포에 환경변수가 없으면 운영 Supabase에 붙지 않고 503. Production은 기존과 동일.
- `api/native-playlist.js`: 설치형 TV 상태 조회 간격 50~70초 → 110~130초 (웹 플레이어 120초와 맞춤).
- `server/media-server.js`: `Range: bytes=-N`(끝에서 N바이트) 요청 처리 오류 수정.
- 삭제: `js/admin.js`(어디서도 로드하지 않음), `api/r2-delete.js`(아무 작업도 하지 않는 구 API, 화면 미사용).
- 추가: `desktop-player/` Windows/macOS 설치형 플레이어, `.github/workflows/desktop-player.yml`.

## 주의
- 슈퍼어드민은 병원 주소로는 로그인되지 않음. 병원 화면에서 세션이 만료되면 기본 주소에서 로그인 후 병원으로 이동.
- 누군가 일부러 틀린 PIN을 계속 넣으면 그 병원(또는 슈퍼어드민) 로그인이 15분씩 잠길 수 있음. 반복 대입을 막는 대가. 감사 로그로 확인 가능.
- Content-Length 서명은 botocore(AWS SDK)와 서명값 일치 확인. 운영 R2 실업로드는 배포 후 1회 확인 필요.
- 로컬 Postgres에서 schema.sql + 이번 SQL 적용, 로그인/잠금/PIN 설정 시나리오 확인. 운영 Supabase에서는 미실행.
