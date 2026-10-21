!ifndef WINDOWS_INSTALL_PATH_NSH
!define WINDOWS_INSTALL_PATH_NSH
!include LogicLib.nsh

Var windowsRegisteredCurrentPath
Var windowsRegisteredMachinePath
Var windowsCurrentPathStatus
Var windowsMachinePathStatus
Var windowsCommandLineInstallPath

!macro windowsNormalizeInstallDirectory INPUT OUTPUT
  StrCpy ${OUTPUT} ""
  StrCpy $R9 ${INPUT} 2 1
  ${if} $R9 == ":\"
    GetFullPathName ${OUTPUT} "${INPUT}"
    StrCpy $R9 ${OUTPUT} 1 -1
    ${while} $R9 == "\"
      StrCpy ${OUTPUT} ${OUTPUT} -1
      StrCpy $R9 ${OUTPUT} 1 -1
    ${endwhile}
    StrLen $R9 ${OUTPUT}
    ${if} $R9 <= 3
    ${orif} ${OUTPUT} == "$WINDIR"
    ${orif} ${OUTPUT} == "$PROGRAMFILES"
    ${orif} ${OUTPUT} == "$PROGRAMFILES64"
    ${orif} ${OUTPUT} == "$PROFILE"
    ${orif} ${OUTPUT} == "$APPDATA"
    ${orif} ${OUTPUT} == "$LOCALAPPDATA"
      StrCpy ${OUTPUT} ""
    ${endif}
  ${endif}
!macroend

!macro windowsValidateInstallDirectory INPUT OUTPUT
  StrCpy ${OUTPUT} ""
  StrCpy $R9 ${INPUT} 2 1
  ${if} $R9 == ":\"
    ; The parent installer may already have preserved the application's files
    ; outside this directory. Its registered uninstaller remains until removal.
    ; A complete installer can repair a missing uninstaller. An existing
    ; directory still needs this product's payload identity; a nonexistent
    ; directory is accepted only as the already-registered path candidate.
    StrCpy $R9 ""
    ${if} ${FileExists} "${INPUT}\${UNINSTALL_FILENAME}"
      StrCpy $R9 "identified"
    ${elseif} ${FileExists} "${INPUT}\${PRODUCT_FILENAME}.exe"
    ${andif} ${FileExists} "${INPUT}\resources\app.asar"
      StrCpy $R9 "identified"
    ${else}
      System::Call 'kernel32::GetFileAttributesW(w "${INPUT}")i.s ?e'
      Pop $R4
      Pop $R3
      ${if} $R3 == -1
        ${if} $R4 == 2
        ${orif} $R4 == 3
          StrCpy $R9 "missing"
        ${endif}
      ${endif}
    ${endif}
    ${if} $R9 != ""
    !insertmacro windowsNormalizeInstallDirectory ${INPUT} ${OUTPUT}
    ${endif}
  ${endif}
!macroend

; Check both registry views. An unreadable key is not evidence of absence.
; The caller preserves $0/$1 and initializes $R9 to zero.
!macro windowsCheckUninstallKey ROOT_KEY REGISTRY_KEY
  ; KEY_READ with KEY_WOW64_64KEY, then KEY_WOW64_32KEY.
  StrCpy $R4 "0x20119"
  ${while} $R4 != ""
    !if "${ROOT_KEY}" == "HKCU"
      System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${REGISTRY_KEY}", i 0, i $R4, *p .r0)i.r1'
    !else if "${ROOT_KEY}" == "HKLM"
      System::Call 'advapi32::RegOpenKeyExW(p 0x80000002, w "${REGISTRY_KEY}", i 0, i $R4, *p .r0)i.r1'
    !else
      !error "Unsupported installation registry root: ${ROOT_KEY}"
    !endif
    ${if} $1 == 0
      System::Call 'advapi32::RegCloseKey(p r0)i'
      StrCpy $R9 "1"
    ${elseif} $1 != 2
    ${andif} $1 != 3
      StrCpy $R9 "1"
    ${endif}
    ${if} $R4 == "0x20119"
      StrCpy $R4 "0x20219"
    ${else}
      StrCpy $R4 ""
    ${endif}
  ${endwhile}
!macroend

; A private directory hint can outlive a removed per-user installation. The
; vendor reads that hint before selecting scope, even without an uninstall
; entry. Remove only this orphaned value: existing directories, uninstall
; metadata, unavailable drives and access errors must keep the safety stop.
!macro windowsRemoveOrphanedInstallLocation ROOT_KEY INSTALL_PATH
  Push $0
  Push $1
  StrCpy $R9 "0"
  !insertmacro windowsCheckUninstallKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !insertmacro windowsCheckUninstallKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  StrCpy $R3 ${INSTALL_PATH} 2 1
  ${if} $R9 == "0"
  ${andif} $R3 == ":\"
    StrCpy $R5 "${INSTALL_PATH}"
    StrLen $R3 $R5
    ${if} $R3 > 3
      StrCpy $R3 $R5 3
      System::Call 'kernel32::GetDriveTypeW(w "$R3")i.s'
      Pop $R3
      ${if} $R3 == 3
        System::Call 'kernel32::GetFileAttributesW(w "$R5")i.r0 ?e'
        Pop $R4
        ${if} $0 == -1
          ${if} $R4 == 2
          ${orif} $R4 == 3
            ClearErrors
            DeleteRegValue ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation
            ${ifNot} ${Errors}
              DetailPrint "Removed orphaned installation directory hint (${ROOT_KEY}): ${INSTALL_PATH}"
              StrCpy ${INSTALL_PATH} ""
            ${endif}
          ${endif}
        ${endif}
      ${endif}
    ${endif}
  ${endif}
  ClearErrors
  Pop $1
  Pop $0
!macroend

!macro windowsWriteRegisteredPath ROOT_KEY INSTALL_PATH
  WriteRegStr ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation "${INSTALL_PATH}"
  WriteRegStr ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" InstallLocation "${INSTALL_PATH}"
  !if "${ROOT_KEY}" == "HKLM"
    WriteRegStr ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" UninstallString '$\"${INSTALL_PATH}\${UNINSTALL_FILENAME}$\" /allusers'
    WriteRegStr ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '$\"${INSTALL_PATH}\${UNINSTALL_FILENAME}$\" /allusers /S'
  !else
    WriteRegStr ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" UninstallString '$\"${INSTALL_PATH}\${UNINSTALL_FILENAME}$\" /currentuser'
    WriteRegStr ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '$\"${INSTALL_PATH}\${UNINSTALL_FILENAME}$\" /currentuser /S'
  !endif
!macroend

; The uninstall command is also present in older installs whose private
; InstallLocation value is missing. Resolve its executable without evaluating
; command-line arguments, and accept only this product's local installation.
!macro windowsResolveRegisteredPath ROOT_KEY RESULT STATUS
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  StrCpy ${RESULT} ""
  StrCpy ${STATUS} "none"
  StrCpy $R8 ""
  ReadRegStr $R0 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $R0 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R0 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${endif}
  ReadRegStr $R6 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R0 == ""
  ${andif} $R6 != ""
    !insertmacro windowsRemoveOrphanedInstallLocation ${ROOT_KEY} $R6
  ${endif}
  ${if} $R0 != ""
  ${orif} $R6 != ""
    StrCpy ${STATUS} "invalid"
  ${endif}
  StrCpy $R1 $R0 1
  ${if} $R1 == '$\"'
    StrCpy $R2 1
    StrCpy $R3 ""
    StrCpy $R4 "0"
    ${while} $R2 < ${NSIS_MAX_STRLEN}
      StrCpy $R1 $R0 1 $R2
      ${if} $R1 == ""
        StrCpy $R3 ""
        ${break}
      ${endif}
      ${if} $R1 == '$\"'
        StrCpy $R4 "1"
        ${break}
      ${endif}
      StrCpy $R3 "$R3$R1"
      IntOp $R2 $R2 + 1
    ${endwhile}
    StrCpy $R1 $R3 2 1
    ${if} $R4 == "1"
    ${andif} $R1 == ":\"
      StrLen $R2 $R3
      ${while} $R2 > 2
        IntOp $R2 $R2 - 1
        StrCpy $R1 $R3 1 $R2
        ${if} $R1 == "\"
          ${break}
        ${endif}
      ${endwhile}
      IntOp $R1 $R2 + 1
      StrCpy $R4 $R3 "" $R1
      StrCpy $R5 $R3 $R2
      ${if} $R4 == "${UNINSTALL_FILENAME}"
        !insertmacro windowsValidateInstallDirectory $R5 $R8
      ${endif}
    ${endif}
  ${endif}
  !insertmacro windowsValidateInstallDirectory $R6 $R7
  ${if} $R8 != ""
  ${andif} $R7 != ""
  ${andif} $R8 != $R7
    StrCpy ${STATUS} "conflict"
  ${else}
    ${if} $R8 == ""
      StrCpy $R8 $R7
    ${endif}
    ${if} $R8 != ""
      StrCpy ${RESULT} $R8
      StrCpy ${STATUS} "resolved"
      ; An unelevated outer installer may not write HKLM. Keep the resolved
      ; path in memory; the elevated instance repeats the registration repair.
      !insertmacro windowsWriteRegisteredPath ${ROOT_KEY} $R8
    ${endif}
  ${endif}
  ClearErrors
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro windowsRepairRegisteredPaths
  !insertmacro windowsResolveRegisteredPath HKCU $windowsRegisteredCurrentPath $windowsCurrentPathStatus
  !insertmacro windowsResolveRegisteredPath HKLM $windowsRegisteredMachinePath $windowsMachinePathStatus
!macroend

!macro windowsRequireRegisteredPath
  StrCpy $R0 $windowsCurrentPathStatus
  StrCpy $R7 $windowsRegisteredCurrentPath
  ${if} $installMode == "all"
    StrCpy $R0 $windowsMachinePathStatus
    StrCpy $R7 $windowsRegisteredMachinePath
  ${endif}
  ; Shared bytes registered in both scopes have no single safe owner.
  ${if} $windowsRegisteredCurrentPath != ""
  ${andif} $windowsRegisteredCurrentPath == $windowsRegisteredMachinePath
    StrCpy $R0 "conflict"
  ${endif}
  !ifndef BUILD_UNINSTALLER
    ${if} ${Silent}
    ${andif} $windowsRegisteredCurrentPath != ""
    ${andif} $windowsRegisteredMachinePath != ""
    ${andif} $windowsCommandLineInstallPath == ""
    ${andifNot} ${isForCurrentUser}
    ${andifNot} ${isForAllUsers}
      StrCpy $R0 "conflict"
    ${endif}
    !insertmacro windowsNormalizeInstallDirectory $INSTDIR $R8
    ${if} $R7 != ""
    ${andif} $R8 != $R7
      StrCpy $R0 "conflict"
    ${elseif} $nuwaxMaintenanceAction != ""
    ${andif} $R7 == ""
      StrCpy $R0 "conflict"
    ${endif}
  !endif
  ${if} $R0 == "invalid"
  ${orif} $R0 == "conflict"
    DetailPrint "Cannot safely resolve the registered installation path ($R0)."
    FileOpen $R1 "$TEMP\Nuwax-installer-recovery.log" a
    ${ifNot} ${Errors}
      FileSeek $R1 0 END
      FileWrite $R1 "$\r$\n${VERSION} phase=ResolvePath status=$R0 scope=$installMode current=$windowsRegisteredCurrentPath machine=$windowsRegisteredMachinePath$\r$\n"
      FileClose $R1
    ${endif}
    ${ifNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "$(windowsInstallPathInvalid)"
    ${endif}
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro windowsInstallPathStrings
  LangString windowsInstallPathInvalid 2052 "无法确认原安装位置，或安装登记指向不同目录。请使用原安装目录修复安装后重试。未删除原安装文件。"
  LangString windowsInstallPathInvalid 1028 "無法確認原安裝位置，或安裝登記指向不同目錄。請使用原安裝目錄修復安裝後重試。未刪除原安裝檔案。"
  !define WINDOWS_INSTALL_PATH_INVALID_EN "The original installation path is missing or inconsistent. Repair the installation in its original directory and retry. Existing files were not removed."
  LangString windowsInstallPathInvalid 1033 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1031 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1036 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 3082 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1042 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1040 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1043 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1030 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1053 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1044 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1035 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1049 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 2070 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1046 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1045 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1058 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1029 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1051 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1038 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1025 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1055 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1054 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  LangString windowsInstallPathInvalid 1066 "${WINDOWS_INSTALL_PATH_INVALID_EN}"
  !undef WINDOWS_INSTALL_PATH_INVALID_EN
  LangString windowsInstallPathInvalid 1041 "元のインストール先を確認できないか、登録先が一致しません。元の場所で修復してから再試行してください。既存のファイルは削除していません。"
!macroend

!macro windowsRefreshRegisteredPaths
  !insertmacro windowsRepairRegisteredPaths
  !ifndef INSTALL_MODE_PER_ALL_USERS
    ${if} $windowsRegisteredCurrentPath != ""
      StrCpy $perUserInstallationFolder $windowsRegisteredCurrentPath
      StrCpy $hasPerUserInstallation "1"
    ${endif}
  !endif
  !ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED
    ${if} $windowsRegisteredMachinePath != ""
      StrCpy $perMachineInstallationFolder $windowsRegisteredMachinePath
      !ifndef INSTALL_MODE_PER_ALL_USERS
        StrCpy $hasPerMachineInstallation "1"
      !endif
    ${endif}
  !endif
!macroend

!macro windowsInitRegisteredPaths
  !insertmacro windowsRefreshRegisteredPaths
  !insertmacro windowsApplyExplicitInstallMode
  !ifndef INSTALL_MODE_PER_ALL_USERS
    ; Recover an otherwise invisible all-users install before the vendor's
    ; silent-upgrade elevation check. Explicit scope flags remain authoritative.
    ${if} $windowsMachinePathStatus != "none"
    ${andif} $windowsCurrentPathStatus == "none"
    ${andifNot} ${isForCurrentUser}
      StrCpy $installMode "all"
      SetShellVarContext all
      StrCpy $R0 "$windowsCommandLineInstallPath"
      ${if} $R0 == ""
      ${andif} $windowsRegisteredMachinePath != ""
        StrCpy $INSTDIR $windowsRegisteredMachinePath
      ${endif}
    ${endif}
  !endif
  ; initMultiUser can have selected a fallback before HKLM was writable. Keep
  ; explicit /D intact, otherwise use the resolved directory for this scope.
  StrCpy $R0 "$windowsCommandLineInstallPath"
  ${if} $R0 != ""
    StrCpy $INSTDIR "$R0"
  ${endif}
  ${if} $R0 == ""
    ${if} $installMode == "all"
    ${andif} $windowsRegisteredMachinePath != ""
      StrCpy $INSTDIR $windowsRegisteredMachinePath
    ${elseif} $installMode != "all"
    ${andif} $windowsRegisteredCurrentPath != ""
      StrCpy $INSTDIR $windowsRegisteredCurrentPath
    ${endif}
  ${endif}
  !ifmacrodef nuwaxResolvePendingInstall
    !insertmacro nuwaxResolvePendingInstall
  !endif
  StrCpy $R0 "$windowsCommandLineInstallPath"
  ${if} ${isUpdated}
    ; The updater supplies the running executable's directory. It can repair
    ; missing/stale metadata only when this product's uninstaller is present;
    ; never replace a different, still-valid registered installation.
    !insertmacro windowsValidateInstallDirectory $R0 $R1
    ${if} $R1 != ""
      StrCpy $INSTDIR $R1
      ${if} $installMode == "all"
      ${andif} $R1 != $windowsRegisteredCurrentPath
        ${if} $windowsMachinePathStatus == "none"
        ${orif} $windowsMachinePathStatus == "invalid"
          !insertmacro windowsWriteRegisteredPath HKLM $R1
          StrCpy $windowsRegisteredMachinePath $R1
          StrCpy $windowsMachinePathStatus "resolved"
          !ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED
            StrCpy $perMachineInstallationFolder $R1
          !endif
        ${endif}
      ${elseif} $installMode != "all"
      ${andif} $R1 != $windowsRegisteredMachinePath
        ${if} $windowsCurrentPathStatus == "none"
        ${orif} $windowsCurrentPathStatus == "invalid"
          !insertmacro windowsWriteRegisteredPath HKCU $R1
          StrCpy $windowsRegisteredCurrentPath $R1
          StrCpy $windowsCurrentPathStatus "resolved"
          !ifndef INSTALL_MODE_PER_ALL_USERS
            StrCpy $perUserInstallationFolder $R1
          !endif
        ${endif}
      ${endif}
    ${endif}
    ${if} $windowsRegisteredMachinePath != ""
    ${andif} $INSTDIR == $windowsRegisteredMachinePath
      ${if} ${isForCurrentUser}
        StrCpy $windowsCurrentPathStatus "conflict"
      ${else}
        StrCpy $installMode "all"
        SetShellVarContext all
      ${endif}
      !ifndef INSTALL_MODE_PER_ALL_USERS
        StrCpy $hasPerMachineInstallation "1"
        StrCpy $hasPerUserInstallation "0"
      !endif
    ${elseif} $windowsRegisteredCurrentPath != ""
    ${andif} $INSTDIR == $windowsRegisteredCurrentPath
      ${if} ${isForAllUsers}
        StrCpy $windowsMachinePathStatus "conflict"
      ${else}
        StrCpy $installMode "CurrentUser"
        SetShellVarContext current
      ${endif}
      !ifndef INSTALL_MODE_PER_ALL_USERS
        StrCpy $hasPerMachineInstallation "0"
        StrCpy $hasPerUserInstallation "1"
      !endif
    ${elseif} $windowsRegisteredCurrentPath != ""
    ${orif} $windowsRegisteredMachinePath != ""
      ; A running copy must not be redirected to another installation directory.
      StrCpy $windowsCurrentPathStatus "conflict"
      StrCpy $windowsMachinePathStatus "conflict"
    ${endif}
  ${endif}
!macroend

!macro windowsInitUninstallPath
  ; Unlike the installer, the old uninstaller has no /D argument. The parent
  ; passes _?=, which initMultiUser may overwrite; resolve its selected scope
  ; directly rather than comparing that temporary/default INSTDIR to /D.
  !insertmacro windowsRefreshRegisteredPaths
  !insertmacro windowsApplyExplicitInstallMode
  !ifndef INSTALL_MODE_PER_ALL_USERS
    ${if} $windowsMachinePathStatus != "none"
    ${andif} $windowsCurrentPathStatus == "none"
    ${andifNot} ${isForCurrentUser}
      StrCpy $installMode "all"
      SetShellVarContext all
    ${endif}
  !endif
  ${if} $installMode == "all"
    ${if} $windowsMachinePathStatus == "none"
      StrCpy $windowsMachinePathStatus "invalid"
    ${endif}
  ${else}
    ${if} $windowsCurrentPathStatus == "none"
      StrCpy $windowsCurrentPathStatus "invalid"
    ${endif}
  ${endif}
  !insertmacro windowsRequireRegisteredPath
  ${if} $installMode == "all"
    ${if} $windowsRegisteredMachinePath != ""
      StrCpy $INSTDIR $windowsRegisteredMachinePath
    ${endif}
  ${else}
    ${if} $windowsRegisteredCurrentPath != ""
      StrCpy $INSTDIR $windowsRegisteredCurrentPath
    ${endif}
  ${endif}
!macroend

!macro windowsSelectUpdateInstallMode
  ${if} ${isUpdated}
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

!macro windowsApplyExplicitInstallMode
  ; Builder's chained GetOptions calls can retain the first lookup's error
  ; flag when both scopes exist. Its default can then override /currentuser.
  ; StdUtils tests each explicit flag independently in both entry points.
  !ifndef INSTALL_MODE_PER_ALL_USERS
    ${if} ${isForCurrentUser}
      !insertmacro setInstallModePerUser
    ${elseif} ${isForAllUsers}
      !insertmacro setInstallModePerAllUsers
    ${endif}
  !endif
!macroend
!endif
