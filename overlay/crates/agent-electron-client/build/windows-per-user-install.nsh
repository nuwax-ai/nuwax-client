!ifndef NUWAX_WINDOWS_PER_USER_INSTALL_NSH
!define NUWAX_WINDOWS_PER_USER_INSTALL_NSH
; Loaded after multiUser.nsh, before the assisted page callbacks are emitted.
; Builder 25's System::Store can crash in System.dll before the first page
; (electron-builder#7921). Save only the registers used by this folder lookup,
; and copy the returned string with a bound instead of reading a fixed array.
!ifndef INSTALL_MODE_PER_ALL_USERS
  !macroundef setInstallModePerUser
  !macro setInstallModePerUser
    StrCpy $installMode CurrentUser
    SetShellVarContext current
    ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $perUserInstallationFolder != ""
      StrCpy $INSTDIR $perUserInstallationFolder
    ${else}
      Push $0
      Push $1
      Push $2
      StrCpy $0 "$LocalAppData\Programs"
      StrCpy $2 0
      System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
      ${if} $1 == 0
      ${andif} $2 != 0
        System::Call 'kernel32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN}) p.r1'
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      ${endif}
      StrCpy $INSTDIR "$0\${APP_FILENAME}"
      Pop $2
      Pop $1
      Pop $0
    ${endif}
    ; Preserve vendor /D handling and the existing-installation lookup above.
    ${StdUtils.GetParameter} $R0 "D" ""
    ${if} $R0 != ""
      StrCpy $INSTDIR $R0
    ${endif}
  !macroend
!endif
!endif
