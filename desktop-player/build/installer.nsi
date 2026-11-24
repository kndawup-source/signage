; Clinic Signage Player — Windows 설치 프로그램 (NSIS 3, 관리자 권한 불필요)
;
; 일반 설치 : ClinicSignageSetup-x.y.z.exe
; 무인 설치 : ClinicSignageSetup-x.y.z.exe /S /URL=https://signage-lake.vercel.app/player.html?key=TV키
;             (/URL 대신 /KEY=TV키 도 가능. 설치 후 해당 주소로 바로 송출 시작)
; 무인 제거 : "%LOCALAPPDATA%\Programs\ClinicSignagePlayer\Uninstall.exe" /S

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!ifndef VERSION
  !define VERSION "1.1.0"
!endif
!ifndef SRCDIR
  !define SRCDIR "..\dist\win-unpacked"
!endif
!ifndef OUTFILE
  !define OUTFILE "..\dist\ClinicSignageSetup-${VERSION}.exe"
!endif

!define APPNAME   "Clinic Signage Player"
!define EXENAME   "Clinic Signage Player.exe"
!define REGKEY    "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClinicSignagePlayer"
!define RUNNAME   "ClinicSignagePlayer"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\ClinicSignagePlayer"
InstallDirRegKey HKCU "${REGKEY}" "InstallLocation"
BrandingText "Clinic Signage Player ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1042 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1042 "FileDescription" "${APPNAME} 설치"
VIAddVersionKey /LANG=1042 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1042 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1042 "CompanyName" "dasaft"
VIAddVersionKey /LANG=1042 "LegalCopyright" "dasaft"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXENAME}"
!define MUI_FINISHPAGE_RUN_TEXT "지금 플레이어 실행"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"

Var ArgUrl
Var ArgKey

!macro KillApp
  nsExec::Exec 'taskkill /F /T /IM "${EXENAME}"'
  Pop $0
  Sleep 800
!macroend

Function .onInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/URL=" $ArgUrl
  ClearErrors
  ${GetOptions} $R0 "/KEY=" $ArgKey
  ClearErrors
FunctionEnd

Section "Install"
  SetShellVarContext current
  !insertmacro KillApp
  SetOutPath "$INSTDIR"
  ; 이전 버전 파일 정리 (설정/캐시는 %APPDATA%에 있으므로 유지됨)
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SRCDIR}\*.*"
  File "icon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${EXENAME}" "" "$INSTDIR\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\${APPNAME}\플레이어 설정 초기화.lnk" "$INSTDIR\${EXENAME}" "--reset" "$INSTDIR\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\${APPNAME}\제거.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXENAME}" "" "$INSTDIR\icon.ico" 0

  ; 로그인 시 자동 실행 (앱 설정에서 끄면 앱이 이 값을 지움)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${RUNNAME}" '"$INSTDIR\${EXENAME}"'

  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "dasaft"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${REGKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${REGKEY}" "EstimatedSize" "$0"

  ; 무인 설치 시 주소를 넘겨받았으면 바로 실행
  ${If} $ArgUrl != ""
    Exec '"$INSTDIR\${EXENAME}" "--player-url=$ArgUrl"'
  ${ElseIf} $ArgKey != ""
    Exec '"$INSTDIR\${EXENAME}" "--key=$ArgKey"'
  ${ElseIf} ${Silent}
    Exec '"$INSTDIR\${EXENAME}"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro KillApp
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${RUNNAME}"
  DeleteRegKey HKCU "${REGKEY}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR"
  ; 송출 설정과 영상 캐시(%APPDATA%\Clinic Signage Player)는 재설치를 위해 남겨 둔다.
SectionEnd
