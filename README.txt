Clinic Signage TV 영상별 버튼 미표시 핫픽스 (v2.35.82)

원인: 이전 JS에는 모든 영상 행의 버튼이 있지만 실제 화면은 이전 버전이 로드된 상태일 가능성이 높음.
이번 배포는 hospital.js와 CSS를 포함하고 HTML/버전 참조를 함께 2.35.82로 올려 브라우저 캐시를 우회합니다.

적용: ZIP의 동일 상대 경로 파일을 모두 배포하세요. 파일 일부만 적용하면 배포 버전 불일치가 발생합니다.
Vercel 배포 후 Ctrl+Shift+R, 브라우저 Network에서 hospital.js?v=2.35.82가 200인지 확인하세요.
또한 Network Response에서 data-tv-remove-video 문구가 포함되는지 확인하세요.
없으면 배포 경로나 캐시가 원인입니다.

데이터 동작: 기본 재생목록은 편집 후 명시적 저장, TV 개별 수동 송출은 서버 RPC로 제거, 우선 송출은 설정 편집 안내. R2 원본은 삭제하지 않습니다.
TV 수동 송출 제거 RPC는 직전 핫픽스의 supabase/hospital-remove-room-manual-video.sql을 실행한 경우에만 동작합니다.

정적 검사: node --check / node scripts/check-release.js 통과. 실제 Edge 및 DB 테스트 미실시.
