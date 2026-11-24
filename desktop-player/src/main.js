'use strict';
/*
 * Clinic Signage Player — Windows / macOS 설치형 TV 송출 앱
 *
 * 웹 플레이어(player.html)를 키오스크 전체화면으로 띄우고 24시간 송출에 필요한
 * 것들(자동 실행, 절전 방지, 크래시/무응답 자동 복구, 오프라인 재시도, 커서 숨김,
 * 외부 사이트 이동 차단)을 담당한다. 재생/캐시/업데이트 로직은 웹 플레이어가 그대로 맡는다.
 *
 * 단축키 (플레이어 화면에서)
 *   Ctrl+Shift+F12 (mac: Cmd+Shift+F12) : 설정 화면
 *   Ctrl+Shift+Q   (mac: Cmd+Shift+Q)   : 종료
 *   Ctrl+Shift+R   (mac: Cmd+Shift+R)   : 새로고침
 *
 * 명령줄 (대량 설치용)
 *   --player-url="https://.../player.html?key=UUID"
 *   --key=UUID [--base-url=https://signage-lake.vercel.app]
 *   --no-autostart   --reset
 */
const { app, BrowserWindow, ipcMain, powerSaveBlocker, session, screen, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_BASE_URL = 'https://signage-lake.vercel.app';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_MS = 15000;
const UNRESPONSIVE_GRACE_MS = 30000;
const HEALTH_INTERVAL_MS = 60000;
const HEALTH_TIMEOUT_MS = 20000;

// ---- Chromium 플래그: 무인 자동재생 + 백그라운드 스로틀 방지 -----------------
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (process.platform === 'win32') app.setAppUserModelId('com.dasaft.clinicsignage.player');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let mainWindow = null;
let allowQuit = false;
let mode = 'player'; // 'player' | 'setup' | 'offline'
let retryTimer = null;
let unresponsiveTimer = null;
let healthTimer = null;
let dailyTimer = null;
let blockerId = null;

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
function defaultConfig() { return { playerUrl: '', autoStart: true, dailyReloadHour: 4, displayIndex: 0 }; }
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

/** 사용자가 넣은 값(전체 URL 또는 TV 키)을 검증된 플레이어 URL로 바꾼다. */
function normalizePlayerUrl(input, baseUrl = DEFAULT_BASE_URL) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('플레이어 주소 또는 TV 키를 입력하세요.');
  if (UUID_RE.test(raw)) {
    const base = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    return normalizePlayerUrl(`${base}/player.html?key=${raw.toLowerCase()}`);
  }
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
  if (args.reset) { cfg = defaultConfig(); changed = true; }
  try {
    if (typeof args['player-url'] === 'string') { cfg.playerUrl = normalizePlayerUrl(args['player-url']); changed = true; }
    else if (typeof args.key === 'string') { cfg.playerUrl = normalizePlayerUrl(args.key, args['base-url']); changed = true; }
  } catch (e) { log('명령줄 설정 무시:', e.message); }
  if (args['no-autostart']) { cfg.autoStart = false; changed = true; }
  if (changed) writeConfig(cfg);
  return cfg;
}

function applyAutoStart(enabled) {
  if (!app.isPackaged) return; // 개발 실행 중에는 등록하지 않음
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    // Windows: 설치 프로그램이 쓰는 HKCU\...\Run 값 이름과 동일하게 맞춘다.
    if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: !!enabled, name: 'ClinicSignagePlayer', path: process.execPath, args: [] });
    else app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: false });
  }
  catch (e) { log('자동 실행 등록 실패', e); }
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

  mainWindow.on('close', (e) => { if (!allowQuit) { e.preventDefault(); log('창 닫기 차단 (종료는 Ctrl+Shift+Q)'); } });
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
    if (mode === 'player') wc.insertCSS('html,body,*{cursor:none!important}').catch(() => {});
  });
  wc.on('console-message', (_e, level, message) => { if (level >= 3) log('[page]', String(message).slice(0, 500)); });

  startPage();
}

function isAllowedNavigation(url) {
  if (url.startsWith('file:')) {
    try {
      const p = path.normalize(decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
      return [path.join(__dirname, 'setup.html'), path.join(__dirname, 'offline.html')].some(f => path.normalize(f).toLowerCase() === p.toLowerCase());
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

function startPage() {
  const cfg = readConfig();
  if (!cfg.playerUrl) return showSetup();
  showPlayer();
}

function showPlayer() {
  if (!mainWindow) return;
  clearTimeout(retryTimer);
  mode = 'player';
  setKiosk(true);
  const url = readConfig().playerUrl;
  log('플레이어 로드', url);
  mainWindow.loadURL(url).catch(() => {}); // 실패는 did-fail-load에서 처리
}

function showSetup() {
  if (!mainWindow) return;
  clearTimeout(retryTimer);
  mode = 'setup';
  setKiosk(false);
  mainWindow.setFullScreen(false);
  const { workArea } = screen.getPrimaryDisplay();
  const w = Math.min(720, workArea.width), h = Math.min(640, workArea.height);
  mainWindow.setBounds({ x: workArea.x + Math.round((workArea.width - w) / 2), y: workArea.y + Math.round((workArea.height - h) / 2), width: w, height: h });
  mainWindow.loadFile(path.join(__dirname, 'setup.html'));
}

function showOffline(reason) {
  if (!mainWindow) return;
  mode = 'offline';
  mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { reason: String(reason || ''), retry: String(RETRY_MS / 1000) } }).catch(() => {});
  scheduleRetry(RETRY_MS);
}

function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!mainWindow) { createWindow(); return; }
    if (mainWindow.webContents.isCrashed()) { try { mainWindow.destroy(); } catch (_) {} mainWindow = null; createWindow(); return; }
    if (mode === 'setup') return;
    showPlayer();
  }, ms);
}

function onKey(event, input) {
  if (input.type !== 'keyDown') return;
  const mod = process.platform === 'darwin' ? input.meta : input.control;
  if (!mod || !input.shift) {
    if (mode === 'player' && (input.key === 'Escape' || input.key === 'F11')) event.preventDefault();
    return;
  }
  const k = String(input.key).toLowerCase();
  if (k === 'q') { event.preventDefault(); quitApp(); }
  else if (k === 'f12') { event.preventDefault(); showSetup(); }
  else if (k === 'r') { event.preventDefault(); if (mode !== 'setup') showPlayer(); }
}

function quitApp() { allowQuit = true; app.quit(); }

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

// ---- IPC (설정 화면 전용) --------------------------------------------------
function fromSetupPage(event) {
  try { return new URL(event.senderFrame.url).protocol === 'file:'; } catch (_) { return false; }
}
ipcMain.handle('setup:get', (event) => {
  if (!fromSetupPage(event)) throw new Error('forbidden');
  const cfg = readConfig();
  return { ...cfg, version: app.getVersion(), platform: process.platform, defaultBaseUrl: DEFAULT_BASE_URL, displays: screen.getAllDisplays().map((d, i) => ({ index: i, label: `${i + 1}번 화면 (${d.size.width}×${d.size.height})` })), logPath: logFile() };
});
ipcMain.handle('setup:save', (event, input) => {
  if (!fromSetupPage(event)) throw new Error('forbidden');
  const cfg = readConfig();
  cfg.playerUrl = normalizePlayerUrl(input?.playerUrl, input?.baseUrl);
  cfg.autoStart = input?.autoStart !== false;
  const h = input?.dailyReloadHour;
  cfg.dailyReloadHour = h === null || h === '' || h === undefined ? null : Math.max(0, Math.min(23, Math.trunc(Number(h)) || 0));
  cfg.displayIndex = Math.max(0, Math.trunc(Number(input?.displayIndex) || 0));
  writeConfig(cfg);
  applyAutoStart(cfg.autoStart);
  scheduleDailyReload();
  const { bounds } = targetDisplay(cfg);
  mainWindow?.setBounds(bounds);
  setTimeout(showPlayer, 50);
  return { ok: true, playerUrl: cfg.playerUrl };
});
ipcMain.handle('setup:cancel', (event) => {
  if (!fromSetupPage(event)) throw new Error('forbidden');
  if (readConfig().playerUrl) setTimeout(showPlayer, 50);
  return { ok: !!readConfig().playerUrl };
});
ipcMain.handle('setup:quit', (event) => { if (!fromSetupPage(event)) throw new Error('forbidden'); quitApp(); });
ipcMain.handle('offline:retry', (event) => { if (!fromSetupPage(event)) throw new Error('forbidden'); showPlayer(); });

// ---- 앱 수명주기 -------------------------------------------------------------
app.on('second-instance', (_e, argv) => {
  const before = readConfig().playerUrl;
  const cfg = applyArgs(argv);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (cfg.playerUrl && cfg.playerUrl !== before) showPlayer();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const cfg = applyArgs(process.argv);
  applyAutoStart(cfg.autoStart);

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['fullscreen', 'screen-wake-lock', 'wake-lock', 'persistent-storage', 'storage-access'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ['fullscreen', 'screen-wake-lock', 'wake-lock', 'persistent-storage', 'storage-access'].includes(permission));

  blockerId = powerSaveBlocker.start('prevent-display-sleep');
  createWindow();
  startHealthCheck();
  scheduleDailyReload();
  screen.on('display-removed', () => { if (mode === 'player' && mainWindow) mainWindow.setBounds(targetDisplay(readConfig()).bounds); });
  screen.on('display-added', () => { if (mode === 'player' && mainWindow) mainWindow.setBounds(targetDisplay(readConfig()).bounds); });
  log(`시작 v${app.getVersion()} ${process.platform}/${process.arch}`);
});

app.on('child-process-gone', (_e, d) => { if (d.type === 'GPU') log('GPU 프로세스 종료', d); });
app.on('window-all-closed', () => { if (allowQuit) app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
app.on('before-quit', () => { allowQuit = true; if (blockerId !== null) powerSaveBlocker.stop(blockerId); });
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

module.exports = { normalizePlayerUrl, parseArgs }; // 테스트용
