#!/usr/bin/env node
'use strict';
/*
 * electron-builder가 만든 dist/win-unpacked 에
 *   1) exe 아이콘/버전 정보 삽입 (resedit, wine 불필요)
 *   2) NSIS로 설치 파일 생성 (build/installer.nsi)
 * Linux/macOS/Windows 어디서나 동작. makensis 경로는 MAKENSIS 환경변수로 지정 가능.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const ResEdit = require('resedit');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;
const unpacked = path.join(root, 'dist', 'win-unpacked');
const exe = path.join(unpacked, `${pkg.productName}.exe`);
if (!fs.existsSync(exe)) { console.error(`없음: ${exe} (먼저 electron-builder --win dir 실행)`); process.exit(1); }

// 1) 아이콘 + 버전 정보
{
  const data = fs.readFileSync(exe);
  const exeObj = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exeObj);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split('.').map(n => parseInt(n, 10) || 0);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: pkg.productName, FileDescription: pkg.productName, CompanyName: 'dasaft',
    LegalCopyright: 'dasaft', OriginalFilename: `${pkg.productName}.exe`, InternalName: pkg.name,
    FileVersion: version, ProductVersion: version
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exeObj);
  fs.writeFileSync(exe, Buffer.from(exeObj.generate()));
  console.log('exe 아이콘/버전 정보 적용:', exe);
}

// 2) NSIS
function findMakensis() {
  if (process.env.MAKENSIS) return process.env.MAKENSIS;
  const candidates = [
    path.join(os.homedir(), '.cache', 'electron-builder', 'nsis', 'nsis-3.0.4.1', process.platform === 'darwin' ? 'mac' : 'linux', 'makensis'),
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'nsis', 'nsis-3.0.4.1', 'Bin', 'makensis.exe'),
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe'
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return 'makensis';
}
const makensis = findMakensis();
const env = { ...process.env };
// electron-builder가 내려받은 NSIS 번들은 NSISDIR이 있어야 Include/Plugins를 찾는다.
if (makensis.includes('nsis-3.0.4.1')) env.NSISDIR = path.resolve(path.dirname(makensis), process.platform === 'win32' ? '..' : '..');
const flag = process.platform === 'win32' ? '/' : '-';
const out = path.join(root, 'dist', `ClinicSignageSetup-${version}.exe`);
execFileSync(makensis, [
  `${flag}V2`, `${flag}DVERSION=${version}`, `${flag}DSRCDIR=${unpacked}`, `${flag}DOUTFILE=${out}`,
  path.join(__dirname, 'installer.nsi')
], { stdio: 'inherit', env, cwd: __dirname });
console.log('설치 파일 생성:', out);
