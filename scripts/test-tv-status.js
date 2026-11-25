#!/usr/bin/env node
'use strict';
// TV 상태 공통 판정(Signage.tvStatus) 단위 테스트.  node scripts/test-tv-status.js
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'common.js'), 'utf8');
const storage = new Map();
const ctx = {
  console, URL, Date, Math, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { onLine: true }, location: { origin: 'https://x', href: 'https://x/', search: '' },
  document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }), body: { appendChild() {} }, visibilityState: 'visible' },
  addEventListener() {}, removeEventListener() {}, fetch: async () => ({ ok: false })
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const S = ctx.Signage;

// 2026-11-25(수) 10:00 KST = 01:00Z  (평일 운영시간 안)
const OPEN = Date.parse('2026-11-25T01:00:00Z');
// 2026-11-25(수) 22:00 KST = 13:00Z  (평일 운영시간 밖)
const NIGHT = Date.parse('2026-11-25T13:00:00Z');
const ago = (now, min) => new Date(now - min * 60000).toISOString();
const settings = {}; // 비어 있으면 DB 기본값(평일 09~20시)

let pass = 0, fail = 0;
function check(name, room, now, expectCat, expectKey, opts = {}) {
  const t = S.tvStatus(room, { now, settings, ...opts });
  const ok = t.cat === expectCat && (!expectKey || t.key === expectKey);
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} → ${t.cat}/${t.key} (${t.catLabel} · ${t.label})${ok ? '' : `  기대 ${expectCat}/${expectKey || '*'}`}`);
}
const playing = (now) => ({ last_seen_at: ago(now, 1), player_status: { playback_state: 'playing', reported_at: ago(now, 1) } });

check('설치 전 (보고 기록 없음)', { name: 'a' }, OPEN, 'unpaired', 'unpaired');
check('설치 전 · 밤', { name: 'a' }, NIGHT, 'unpaired', 'unpaired');
check('정상 재생', playing(OPEN), OPEN, 'live', 'live');
check('비상 영상 재생', { last_seen_at: ago(OPEN, 1), player_status: { playback_state: 'emergency' } }, OPEN, 'live', 'live');
check('운영시간 중 꺼짐', { last_seen_at: ago(OPEN, 60), player_status: { playback_state: 'playing' } }, OPEN, 'issue', 'offline');
check('운영시간 후 꺼짐', { last_seen_at: ago(NIGHT, 60), player_status: { playback_state: 'playing' } }, NIGHT, 'standby', 'idle');
check('운영시간 정보 없음 + 꺼짐 (보수적)', { last_seen_at: ago(NIGHT, 60), player_status: {} }, NIGHT, 'issue', 'offline', { settings: null });
check('조기 종료한 날 꺼짐', { last_seen_at: ago(OPEN, 60), player_status: {} }, OPEN, 'standby', 'idle', { settings: { early_closed_date: '2026-11-25' } });
check('비활성 병원 꺼짐', { last_seen_at: ago(OPEN, 60), player_status: {} }, OPEN, 'standby', 'idle', { settings: { weekday_enabled: false, saturday_enabled: false, sunday_enabled: false } });
check('TV별 운영시간(18시 종료) 후 꺼짐', { last_seen_at: ago(OPEN, 60), operating_override: true, operating_weekday_enabled: true, operating_weekday_start: '07:00', operating_weekday_end: '09:30', player_status: {} }, OPEN, 'standby', 'idle');
check('운영시간 외 (플레이어 보고)', { last_seen_at: ago(NIGHT, 1), player_status: { mode: 'closed', playback_state: 'closed' } }, NIGHT, 'standby', 'idle');
check('일시정지', { last_seen_at: ago(OPEN, 1), paused: true, player_status: { playback_state: 'paused' } }, OPEN, 'standby', 'idle');
check('재생 대기', { last_seen_at: ago(OPEN, 1), player_status: { playback_state: 'idle' } }, OPEN, 'standby', 'idle');
check('재생 오류', { last_seen_at: ago(OPEN, 1), player_status: { playback_state: 'error', error: 'x' } }, OPEN, 'issue', 'error');
check('캐시 오류', { last_seen_at: ago(OPEN, 1), player_status: { playback_state: 'playing', offline_cache_error: 'quota' } }, OPEN, 'issue', 'error');
check('보고 지연 8분', { last_seen_at: ago(OPEN, 8), player_status: { playback_state: 'playing' } }, OPEN, 'issue', 'delayed');
check('PC 네트워크 끊김 보고', { last_seen_at: ago(OPEN, 1), player_status: { playback_state: 'playing', online: false } }, OPEN, 'issue', 'delayed');
check('업데이트 대기 (정상)', { last_seen_at: ago(OPEN, 1), player_status: { playback_state: 'playing', update_pending_version: '2.35.86' } }, OPEN, 'live', 'live');
check('배포 버전 불일치', { last_seen_at: ago(OPEN, 1), player_status: { playback_state: 'playing', update_error: 'version_mismatch:2.35.85->2.35.86' } }, OPEN, 'issue', 'update');
check('제어 적용 실패(ack)', playing(OPEN), OPEN, 'issue', 'error', { ack: { status: 'error' } });
check('직접 관리 · 확인됨', { display_control_mode: 'manual', manual_check_status: 'checked' }, OPEN, 'manual', 'manual');
check('직접 관리 · 확인 필요', { display_control_mode: 'manual' }, OPEN, 'manual', 'manual-warn');
check('직접 관리 · 보고 없음도 직접 관리', { display_control_mode: 'manual', last_seen_at: null }, NIGHT, 'manual');
check('원격+수동(hybrid) 꺼짐', { display_control_mode: 'hybrid', last_seen_at: ago(OPEN, 60), player_status: {} }, OPEN, 'issue', 'offline');

check('연결 해제 tombstone', {last_seen_at:ago(OPEN,1),player_status:{pairing_reset:true}},OPEN,'unpaired','unpaired');
check('운영시간 외 보고 지연', {last_seen_at:ago(NIGHT,8),player_status:{playback_state:'playing'}},NIGHT,'standby','idle');
check('운영시간 외 탭 숨김', {last_seen_at:ago(NIGHT,1),player_status:{visibility_state:'hidden'}},NIGHT,'standby','idle');
check('운영시간 외 네트워크 오류', {last_seen_at:ago(NIGHT,1),player_status:{online:false}},NIGHT,'standby','idle');
check('운영시간 외 업데이트 오류', {last_seen_at:ago(NIGHT,1),player_status:{update_error:'version_mismatch:x'}},NIGHT,'standby','idle');
check('연결 해제 뒤 정상 보고',playing(OPEN),OPEN,'live','live');

// 합계 일치: 임의 TV 500대
const rooms = [];
const kinds = [
  () => ({}), () => playing(OPEN), () => ({ last_seen_at: ago(OPEN, 60), player_status: {} }),
  () => ({ display_control_mode: 'manual' }), () => ({ last_seen_at: ago(OPEN, 1), paused: true, player_status: { playback_state: 'paused' } }),
  () => ({ last_seen_at: ago(OPEN, 1), player_status: { playback_state: 'error', error: 'e' } })
];
for (let i = 0; i < 500; i++) rooms.push({ id: String(i), ...kinds[i % kinds.length]() });
const c = S.tvStatusCounts(rooms, { now: OPEN, settings });
const sum = S.TV_CATEGORY_ORDER.reduce((a, k) => a + c[k], 0);
const sumOk = sum === c.total && c.total === rooms.length;
if (sumOk) pass++; else fail++;
console.log(`${sumOk ? 'PASS' : 'FAIL'}  분류 합계 = 전체 TV 수                → ${S.TV_CATEGORY_ORDER.map(k => `${S.TV_CATEGORY_LABEL[k]} ${c[k]}`).join(' / ')} = ${sum} / 전체 ${rooms.length}`);
const labelsOk = JSON.stringify(Object.values(S.TV_CATEGORY_LABEL)) === JSON.stringify(['정상 송출', '대기 중', '미연결', '확인 필요', '직접 관리']);
if (labelsOk) pass++; else fail++;
console.log(`${labelsOk ? 'PASS' : 'FAIL'}  분류 문구 5가지`);

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
