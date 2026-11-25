'use strict';
/*
 * Clinic Signage Player — Windows / macOS 설치형 TV 송출 앱
 *
 * 웹 플레이어(player.html)를 키오스크 전체화면으로 띄우고 24시간 송출에 필요한
 * 것들(자동 실행, 절전 방지, 크래시/무응답 자동 복구, 오프라인 재시도, 커서 숨김,
 * 외부 사이트 이동 차단)을 담당한다. 재생/캐시/업데이트 로직은 웹 플레이어가 그대로 맡는다.
 *
 * 처음 켜면 TV 화면에 6자리 연결 코드가 뜬다. 병원 관리자 화면의 디스플레이 설정에서
 * 그 코드를 입력하면 자동으로 그 디스플레이의 영상을 송출한다. (주소 직접 입력도 가능)
 *
 * 단축키 (어느 화면에서나) — 켤 때마다 화면 아래에 10초간 안내가 나온다
 *   Ctrl+Shift+F12 (mac: Cmd+Shift+F12) : 설정 화면
 *   Ctrl+Shift+R   (mac: Cmd+Shift+R)   : 새로고침
 *   Ctrl+Shift+Q   (mac: Cmd+Shift+Q)   : 종료
 * 윈도우 작업표시줄 / 맥 메뉴 막대의 아이콘 메뉴에서도 같은 기능을 쓸 수 있다.
 *
 * 명령줄 (대량 설치용)
 *   --player-url="https://.../player.html?key=UUID"
 *   --key=UUID [--base-url=https://signage-lake.vercel.app]
 *   --no-autostart   --reset
 */
const { app, BrowserWindow, ipcMain, powerSaveBlocker, session, screen, Menu, Tray, nativeImage, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://signage-lake.vercel.app';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_MS = 15000;
const UNRESPONSIVE_GRACE_MS = 30000;
const HEALTH_INTERVAL_MS = 60000;
const HEALTH_TIMEOUT_MS = 20000;
const HINT_MS = 10000;
const MOD = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
const HINT_TEXT = `설정 ${MOD}+Shift+F12  ·  새로고침 ${MOD}+Shift+R  ·  종료 ${MOD}+Shift+Q`;
const LOCAL_PAGES = ['setup.html', 'offline.html', 'pairing.html'];

// ---- Chromium 플래그: 무인 자동재생 + 백그라운드 스로틀 방지 -----------------
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (process.platform === 'win32') app.setAppUserModelId('com.dasaft.clinicsignage.player');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let mainWindow = null;
let tray = null;
let allowQuit = false;
let confirmTimer=null, confirmBusy=false;
let mode = 'player'; // 'player' | 'setup' | 'offline' | 'pairing'
let retryTimer = null;
let unresponsiveTimer = null;
let healthTimer = null;
let dailyTimer = null;
let blockerId = null;
let startupHintShown = false;
let lastHintAt = 0;
let supabaseConfigCache = null; // { base, url, key, at }

// ---- 로그 (userData/logs/player.log, 1MB 회전) ---------------------------------
function logFile() { return path.join(app.getPath('userData'), 'logs', 'player.log'); }
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1'); } catch (_) {}
    fs.appendFileSync(file, line);
  } catch (_) {}
  if (!app.isPackaged) process.stdout.write(line);
}

// ---- 설정 ------------------------------------------------------------------
function configPath() { return path.join(app.getPath('userData'), 'player-config.json'); }
function defaultConfig() { return { playerUrl: '', baseUrl: DEFAULT_BASE_URL, deviceId: '', autoStart: true, dailyReloadHour: 4, displayIndex: 0 }; }
function readConfig() {
  try { return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; }
  catch (_) { return defaultConfig(); }
}
function writeConfig(cfg) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file); // 전원 차단 중에도 설정 파일이 반쯤 써지지 않도록
}
/** 이 PC의 고유 기기 ID (연결 코드 발급용). 한 번 만들면 유지 */
function deviceId() {
  const cfg = readConfig();
  if (/^[A-Za-z0-9_-]{16,64}$/.test(cfg.deviceId || '')) return cfg.deviceId;
  cfg.deviceId = crypto.randomBytes(24).toString('base64url');
  writeConfig(cfg);
  return cfg.deviceId;
}

function normalizeBaseUrl(input) {
  const raw = String(input || '').trim() || DEFAULT_BASE_URL;
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('서버 주소 형식이 올바르지 않습니다.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('서버 주소는 http(s)여야 합니다.');
  return u.origin;
}

/** 사용자가 넣은 값(전체 URL 또는 TV 키)을 검증된 플레이어 URL로 바꾼다. */
function normalizePlayerUrl(input, baseUrl = DEFAULT_BASE_URL) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('플레이어 주소 또는 TV 키를 입력하세요.');
  if (UUID_RE.test(raw)) return normalizePlayerUrl(`${normalizeBaseUrl(baseUrl)}/player.html?key=${raw.toLowerCase()}`);
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('주소 형식이 올바르지 않습니다.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('http(s) 주소만 사용할 수 있습니다.');
  if (u.username || u.password) throw new Error('주소에 계정 정보를 넣을 수 없습니다.');
  const key = u.searchParams.get('key') || '';
  if (!UUID_RE.test(key)) throw new Error('주소에 올바른 TV 키(?key=...)가 없습니다.');
  if (!/\/player\.html$/i.test(u.pathname)) throw new Error('player.html 주소여야 합니다.');
  return u.toString();
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(a);
    if (!m) continue;
    out[m[1].toLowerCase()] = m[2] === undefined ? true : m[2].replace(/^"|"$/g, '');
  }
  return out;
}

function applyArgs(argv) {
  const args = parseArgs(argv);
  let cfg = readConfig();
  let changed = false;
  if (args.reset) { cfg = { ...defaultConfig(), deviceId: cfg.deviceId }; changed = true; }
  try {
    if (typeof args['base-url'] === 'string') { cfg.baseUrl = normalizeBaseUrl(args['base-url']); changed = true; }
    if (typeof args['player-url'] === 'string') { cfg.playerUrl = normalizePlayerUrl(args['player-url']); changed = true; }
    else if (typeof args.key === 'string') { cfg.playerUrl = normalizePlayerUrl(args.key, cfg.baseUrl); changed = true; }
  } catch (e) { log('명령줄 설정 무시:', e.message); }
  if (args['no-autostart']) { cfg.autoStart = false; changed = true; }
  if (changed) { if(cfg.pendingPairing && (cfg.pendingPairing.playerUrl!==cfg.playerUrl || cfg.pendingPairing.baseUrl!==cfg.baseUrl)) delete cfg.pendingPairing; writeConfig(cfg); }
  return cfg;
}

function applyAutoStart(enabled) {
  if (!app.isPackaged) return; // 개발 실행 중에는 등록하지 않음
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    // Windows: 설치 프로그램이 쓰는 HKCU\...\Run 값 이름과 동일하게 맞춘다.
    if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: !!enabled, name: 'ClinicSignagePlayer', path: process.execPath, args: [] });
    else app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: false });
  } catch (e) { log('자동 실행 등록 실패', e); }
}

// ---- 연결 코드(페어링): 서버의 Supabase RPC 호출 --------------------------------
async function fetchText(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await net.fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' }); // 시스템 프록시 설정을 따른다
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally { clearTimeout(t); }
}
/** 서버의 js/config.js에서 Supabase 주소/공개 키를 읽는다 (서버 설정을 한 곳에서만 관리) */
async function supabaseConfig() {
  const base = normalizeBaseUrl(readConfig().baseUrl);
  if (supabaseConfigCache && supabaseConfigCache.base === base && Date.now() - supabaseConfigCache.at < 3600000) return supabaseConfigCache;
  const r = await fetchText(`${base}/js/config.js?t=${Date.now()}`);
  if (!r.ok) throw new Error(`server_http_${r.status}`);
  const url = /supabaseUrl\s*:\s*['"](https?:\/\/[^'"]+)['"]/.exec(r.text)?.[1];
  const key = /supabaseAnonKey\s*:\s*['"]([^'"]+)['"]/.exec(r.text)?.[1];
  if (!url || !key) throw new Error('server_config_missing');
  supabaseConfigCache = { base, url: url.replace(/\/+$/, ''), key, at: Date.now() };
  return supabaseConfigCache;
}
async function rpc(fn, body) {
  const c = await supabaseConfig();
  const r = await fetchText(`${c.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 404) throw new Error('server_not_ready'); // DB 업데이트 전
  if (!r.ok) throw new Error(`rpc_http_${r.status}`);
  return JSON.parse(r.text);
}

// ---- 창 ------------------------------------------------------------------
function targetDisplay(cfg) {
  const displays = screen.getAllDisplays();
  return displays[Math.max(0, Math.min(displays.length - 1, Number(cfg.displayIndex) || 0))] || screen.getPrimaryDisplay();
}

function createWindow() {
  const cfg = readConfig();
  const { bounds } = targetDisplay(cfg);
  mainWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    backgroundColor: '#000000',
    show: false,
    frame: false,
    autoHideMenuBar: true,
    title: 'Clinic Signage Player',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    log('창 닫기 차단 (종료는 Ctrl+Shift+Q)');
    showHint(5000); // 닫으려는 사람에게 방법을 보여준다
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (!isAllowedNavigation(url)) { e.preventDefault(); log('외부 이동 차단', url); } });
  wc.on('will-redirect', (e, url) => { if (!isAllowedNavigation(url)) { e.preventDefault(); log('외부 리다이렉트 차단', url); } });
  wc.on('before-input-event', onKey);

  wc.on('render-process-gone', (_e, details) => {
    log('렌더러 종료', details);
    if (details.reason === 'clean-exit') return;
    scheduleRetry(3000);
  });
  wc.on('unresponsive', () => {
    log('무응답 감지');
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = setTimeout(() => {
      log('무응답 지속 → 렌더러 재시작');
      try { wc.forcefullyCrashRenderer(); } catch (_) {}
      scheduleRetry(2000);
    }, UNRESPONSIVE_GRACE_MS);
  });
  wc.on('responsive', () => clearTimeout(unresponsiveTimer));

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED */ || mode !== 'player') return;
    log('로드 실패', code, desc, url);
    showOffline(desc);
  });
  wc.on('did-finish-load', () => {
    if (mode === 'player') {
      wc.insertCSS('html,body,*{cursor:none!important}').catch(() => {});
      if (!startupHintShown) { startupHintShown = true; showHint(HINT_MS); }
    }
  });
  wc.on('console-message', (_e, level, message) => { if (level >= 3) log('[page]', String(message).slice(0, 500)); });

  startPage();
}

/** 화면 아래에 단축키 안내를 잠깐 띄운다 (플레이어 화면 위에 덧씌움, 영상에는 영향 없음) */
function showHint(ms) {
  if (!mainWindow || mode !== 'player') return;
  const now = Date.now();
  if (now - lastHintAt < 3000) return;
  lastHintAt = now;
  const js = `(() => {
    const id = '__clinic_signage_hint';
    document.getElementById(id)?.remove();
    const d = document.createElement('div');
    d.id = id;
    d.textContent = ${JSON.stringify(HINT_TEXT)};
    Object.assign(d.style, { position: 'fixed', left: '50%', bottom: '4vh', transform: 'translateX(-50%)', zIndex: '2147483647',
      background: 'rgba(0,0,0,.75)', color: '#fff', font: '600 clamp(14px,1.4vw,24px)/1.4 "Malgun Gothic","Apple SD Gothic Neo",sans-serif',
      padding: '.6em 1.2em', borderRadius: '.6em', pointerEvents: 'none', transition: 'opacity .6s', whiteSpace: 'nowrap' });
    document.documentElement.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 700); }, ${Number(ms) || HINT_MS});
  })();`;
  mainWindow.webContents.executeJavaScript(js, false).catch(() => {});
}

function isAllowedNavigation(url) {
  if (url.startsWith('file:')) {
    try {
      const p = path.normalize(decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
      return LOCAL_PAGES.map(f => path.join(__dirname, f)).some(f => path.normalize(f).toLowerCase() === p.toLowerCase());
    } catch (_) { return false; }
  }
  const target = readConfig().playerUrl;
  if (!target) return false;
  try { return new URL(url).origin === new URL(target).origin; } catch (_) { return false; }
}

function setKiosk(on) {
  if (!mainWindow) return;
  if (process.platform === 'darwin') { mainWindow.setKiosk(on); }
  else { mainWindow.setFullScreen(on); mainWindow.setKiosk(on); }
  mainWindow.setAlwaysOnTop(on, 'screen-saver');
}

function fillTargetDisplay() {
  if (!mainWindow) return;
  mainWindow.setBounds(targetDisplay(readConfig()).bounds);
}

function startPage() {
  const cfg = readConfig();
  if (!cfg.playerUrl) return showPairing();
  showPlayer();
}

function showPlayer() {
  if (!mainWindow) return;
  const url = readConfig().playerUrl;
  if (!url) return showPairing();
  clearTimeout(retryTimer);
  mode = 'player';
  fillTargetDisplay();
  setKiosk(true);
  log('플레이어 로드');
  mainWindow.loadURL(url).catch(() => {}); // 실패는 did-fail-load에서 처리
  updateTrayMenu();
}

/** 처음 켰을 때: TV 화면 전체에 연결 코드를 크게 보여준다 */
function showPairing() {
  if (!mainWindow) return;
  clearTimeout(retryTimer);
  mode = 'pairing';
  fillTargetDisplay();
  setKiosk(true);
  mainWindow.loadFile(path.join(__dirname, 'pairing.html'));
  updateTrayMenu();
}

function showSetup() {
  if (!mainWindow) return;
  clearTimeout(retryTimer);
  mode = 'setup';
  setKiosk(false);
  mainWindow.setFullScreen(false);
  const { workArea } = screen.getPrimaryDisplay();
  const w = Math.min(720, workArea.width), h = Math.min(700, workArea.height);
  mainWindow.setBounds({ x: workArea.x + Math.round((workArea.width - w) / 2), y: workArea.y + Math.round((workArea.height - h) / 2), width: w, height: h });
  mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  mainWindow.show();
  mainWindow.focus();
  updateTrayMenu();
}

function showOffline(reason) {
  if (!mainWindow) return;
  mode = 'offline';
  mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { reason: String(reason || ''), retry: String(RETRY_MS / 1000), hint: HINT_TEXT } }).catch(() => {});
  scheduleRetry(RETRY_MS);
}

function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!mainWindow) { createWindow(); return; }
    if (mainWindow.webContents.isCrashed()) { try { mainWindow.destroy(); } catch (_) {} mainWindow = null; createWindow(); return; }
    if (mode === 'setup' || mode === 'pairing') return;
    showPlayer();
  }, ms);
}

function reloadPlayer() {
  if (mode === 'setup') return;
  if (mode === 'pairing') { showPairing(); return; }
  showPlayer();
}

function onKey(event, input) {
  if (input.type !== 'keyDown') return;
  const mod = process.platform === 'darwin' ? input.meta : input.control;
  if (!mod || !input.shift) {
    if (mode === 'player' && (input.key === 'Escape' || input.key === 'F11')) { event.preventDefault(); showHint(5000); }
    if (mode === 'player' && input.alt && input.key === 'F4') showHint(5000);
    return;
  }
  const k = String(input.key).toLowerCase();
  if (k === 'q') { event.preventDefault(); quitApp(); }
  else if (k === 'f12') { event.preventDefault(); showSetup(); }
  else if (k === 'r') { event.preventDefault(); reloadPlayer(); }
}

function quitApp() { allowQuit = true; app.quit(); }

// ---- 트레이(작업표시줄/메뉴 막대) 메뉴 ------------------------------------------
function createTray() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    if (process.platform === 'darwin') img = img.resize({ width: 18, height: 18 });
    tray = new Tray(img);
    tray.setToolTip('Clinic Signage Player');
    if (process.platform === 'win32') tray.on('click', () => tray.popUpContextMenu());
    updateTrayMenu();
  } catch (e) { log('트레이 아이콘 생성 실패', e); }
}
function updateTrayMenu() {
  if (!tray) return;
  const paired = !!readConfig().playerUrl;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Clinic Signage Player ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: '설정 열기', accelerator: `${MOD === 'Cmd' ? 'Command' : 'Ctrl'}+Shift+F12`, click: () => showSetup() },
    { label: '새로고침', accelerator: `${MOD === 'Cmd' ? 'Command' : 'Ctrl'}+Shift+R`, enabled: mode !== 'setup', click: () => reloadPlayer() },
    { label: paired ? '다른 디스플레이로 다시 연결 (연결 코드)' : '연결 코드 화면', click: () => showPairing() },
    { type: 'separator' },
    { label: '종료', accelerator: `${MOD === 'Cmd' ? 'Command' : 'Ctrl'}+Shift+Q`, click: () => quitApp() }
  ]));
}

// ---- 헬스체크: 렌더러가 살아 있는지 주기적으로 확인 ---------------------------
function startHealthCheck() {
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (!mainWindow || mode !== 'player') return;
    const wc = mainWindow.webContents;
    if (wc.isLoading()) return;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), HEALTH_TIMEOUT_MS); });
    const result = await Promise.race([wc.executeJavaScript('1+1', true).then(() => 'ok').catch(() => 'error'), timeout]);
    clearTimeout(timer);
    if (result !== 'ok') { log('헬스체크 실패', result); scheduleRetry(1000); }
  }, HEALTH_INTERVAL_MS);
}

// ---- 하루 한 번 새로고침 (장시간 실행 메모리 누적 방지) -------------------------
function scheduleDailyReload() {
  clearTimeout(dailyTimer);
  const hour = readConfig().dailyReloadHour;
  if (hour === null || hour === undefined || hour === '' || !Number.isInteger(Number(hour))) return;
  const now = new Date(), next = new Date(now);
  next.setHours(Number(hour), Math.floor(Math.random() * 30), 0, 0); // 0~29분 분산
  if (next <= now) next.setDate(next.getDate() + 1);
  dailyTimer = setTimeout(() => {
    log('정기 새로고침');
    if (mode === 'player' && mainWindow) mainWindow.webContents.reloadIgnoringCache();
    scheduleDailyReload();
  }, next - now);
}

// ---- IPC (로컬 화면 전용) ----------------------------------------------------
function fromLocalPage(event) {
  try { return new URL(event.senderFrame.url).protocol === 'file:'; } catch (_) { return false; }
}
function guard(event) { if (!fromLocalPage(event)) throw new Error('forbidden'); }

ipcMain.handle('setup:get', (event) => {
  guard(event);
  const cfg = readConfig();
  return {
    playerUrl: cfg.playerUrl, baseUrl: cfg.baseUrl || DEFAULT_BASE_URL, autoStart: cfg.autoStart, dailyReloadHour: cfg.dailyReloadHour, displayIndex: cfg.displayIndex,
    version: app.getVersion(), platform: process.platform, defaultBaseUrl: DEFAULT_BASE_URL, hint: HINT_TEXT,
    displays: screen.getAllDisplays().map((d, i) => ({ index: i, label: `${i + 1}번 화면 (${d.size.width}×${d.size.height})` })), logPath: logFile()
  };
});
function saveCommonSettings(cfg, input) {
  cfg.baseUrl = normalizeBaseUrl(input?.baseUrl || cfg.baseUrl);
  cfg.autoStart = input?.autoStart !== false;
  const h = input?.dailyReloadHour;
  cfg.dailyReloadHour = h === null || h === '' || h === undefined ? null : Math.max(0, Math.min(23, Math.trunc(Number(h)) || 0));
  cfg.displayIndex = Math.max(0, Math.trunc(Number(input?.displayIndex) || 0));
}
ipcMain.handle('setup:save', (event, input) => {
  guard(event);
  const cfg = readConfig();
  saveCommonSettings(cfg, input);
  cfg.playerUrl = normalizePlayerUrl(input?.playerUrl, cfg.baseUrl);
  delete cfg.pendingPairing;
  writeConfig(cfg);
  supabaseConfigCache = null;
  applyAutoStart(cfg.autoStart);
  scheduleDailyReload();
  setTimeout(showPlayer, 50);
  return { ok: true, playerUrl: cfg.playerUrl };
});
ipcMain.handle('setup:pair', (event, input) => {
  guard(event);
  const cfg = readConfig();
  delete cfg.pendingPairing;
  saveCommonSettings(cfg, input);
  writeConfig(cfg);
  supabaseConfigCache = null;
  applyAutoStart(cfg.autoStart);
  scheduleDailyReload();
  setTimeout(showPairing, 50);
  return { ok: true };
});
ipcMain.handle('setup:cancel', (event) => {
  guard(event);
  setTimeout(readConfig().playerUrl ? showPlayer : showPairing, 50);
  return { ok: true };
});
ipcMain.handle('setup:quit', (event) => { guard(event); quitApp(); });
ipcMain.handle('setup:open', (event) => { guard(event); setTimeout(showSetup, 50); return { ok: true }; });
ipcMain.handle('offline:retry', (event) => { guard(event); showPlayer(); });

ipcMain.handle('pair:info', (event) => {
  guard(event);
  const cfg = readConfig();
  return { version: app.getVersion(), platform: process.platform, hint: HINT_TEXT, baseUrl: cfg.baseUrl || DEFAULT_BASE_URL, hasPlayer: !!cfg.playerUrl };
});
ipcMain.handle('pair:request', async (event) => {
  guard(event);
  try {
    const r = await rpc('pairing_request', { p_device_id: deviceId() });
    return r && typeof r === 'object' ? r : { ok: false, error: 'bad_response', retry_after_sec: 15 };
  } catch (e) {
    log('연결 코드 요청 실패', e.message);
    return { ok: false, error: e.message === 'server_not_ready' ? 'server_not_ready' : 'network' };
  }
});
/** 서버에 "기기에 저장 완료"를 알린다. 실패해도 이미 저장한 키로 송출은 계속하고, 몇 번 재시도한다. */
async function confirmPairing() {
  if (confirmBusy) return;
  clearTimeout(confirmTimer);
  const cfg=readConfig(), pending=cfg.pendingPairing;
  if (!pending || pending.playerUrl!==cfg.playerUrl || pending.baseUrl!==cfg.baseUrl) return;
  confirmBusy=true;
  let terminal=false;
  try {
    const r=await rpc('pairing_confirm',{p_device_id:deviceId(),p_code:pending.code,p_player_key:pending.playerKey});
    terminal=!!r?.ok || ['expired','not_delivered','key_mismatch','invalid'].includes(r?.error);
    log(r?.ok?'연결 저장 확인 완료':'연결 저장 확인 응답',r?.error||'');
  } catch(e){log('연결 저장 확인 실패',e.message);}
  finally {
    confirmBusy=false;
    const latest=readConfig();
    if (latest.pendingPairing?.id===pending.id && terminal) {
      delete latest.pendingPairing;
      try { writeConfig(latest); } catch(e){log('연결 확인 상태 저장 실패',e.message);}
    }
    if(readConfig().pendingPairing) confirmTimer=setTimeout(confirmPairing,15000);
  }
}

ipcMain.handle('pair:poll', async (event, code) => {
  guard(event);
  if (!/^[0-9]{6}$/.test(String(code || ''))) return { ok: false, status: 'expired' };
  let r;
  try { r = await rpc('pairing_poll', { p_device_id: deviceId(), p_code: String(code) }); }
  catch (e) { return { ok: false, status: 'network' }; } // 같은 기기는 만료 전까지 다시 받을 수 있으므로 재시도하면 된다
  if (r?.status === 'paired' && UUID_RE.test(String(r.player_key || ''))) {
    // 1) 먼저 기기에 안전하게 저장 (임시 파일 → 이름 바꾸기)
    try {
      const cfg = readConfig();
      cfg.playerUrl = normalizePlayerUrl(String(r.player_key), cfg.baseUrl);
      cfg.pendingPairing={id:crypto.randomBytes(16).toString('hex'),code:String(code),playerKey:String(r.player_key),playerUrl:cfg.playerUrl,baseUrl:cfg.baseUrl};
      writeConfig(cfg);
    } catch (e) {
      log('연결 정보 저장 실패', e.message);
      return { ok: false, status: 'network' }; // 저장 못 했으면 확인을 보내지 않는다 → 다음 poll에서 다시 받음
    }
    log('연결 완료', r.site_name || '', r.room_name || '');
    // 2) 저장이 끝난 뒤에만 서버에 확인
    void confirmPairing();
    setTimeout(() => { startupHintShown = false; showPlayer(); }, 2500); // "연결됨" 화면을 잠깐 보여준 뒤 송출
    return { ok: true, status: 'paired', room_name: r.room_name || '', site_name: r.site_name || '' };
  }
  return { ok: true, status: r?.status || 'pending', ttl_sec: r?.ttl_sec };
});

// ---- 앱 수명주기 -------------------------------------------------------------
app.on('second-instance', (_e, argv) => {
  const before = readConfig().playerUrl;
  const cfg = applyArgs(argv);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (cfg.playerUrl && cfg.playerUrl !== before) showPlayer();
    else if (mode === 'player') showHint(HINT_MS); // 아이콘을 다시 눌렀다면 이미 실행 중임을 알려준다
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const cfg = applyArgs(process.argv);
  applyAutoStart(cfg.autoStart);

  const allowed = ['fullscreen', 'screen-wake-lock', 'wake-lock', 'persistent-storage', 'storage-access'];
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));

  blockerId = powerSaveBlocker.start('prevent-display-sleep');
  createWindow();
  void confirmPairing();
  createTray();
  startHealthCheck();
  scheduleDailyReload();
  const refit = () => { if ((mode === 'player' || mode === 'pairing') && mainWindow) fillTargetDisplay(); };
  screen.on('display-removed', refit);
  screen.on('display-added', refit);
  log(`시작 v${app.getVersion()} ${process.platform}/${process.arch}`);
});

app.on('child-process-gone', (_e, d) => { if (d.type === 'GPU') log('GPU 프로세스 종료', d); });
app.on('window-all-closed', () => { if (allowQuit) app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
app.on('before-quit', () => { allowQuit = true; if (blockerId !== null) powerSaveBlocker.stop(blockerId); });
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));
