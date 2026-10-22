!ifndef BUILD_UNINSTALLER
!macro nuwaxProtectOtherShortcutTarget OUTPUT
  StrCpy ${OUTPUT} ""
  ${if} $windowsRegisteredCurrentPath != ""
  ${andif} $windowsRegisteredCurrentPath != $INSTDIR
    StrCpy ${OUTPUT} "$windowsRegisteredCurrentPath\${PRODUCT_FILENAME}.exe"
  ${elseif} $windowsRegisteredMachinePath != ""
  ${andif} $windowsRegisteredMachinePath != $INSTDIR
    StrCpy ${OUTPUT} "$windowsRegisteredMachinePath\${PRODUCT_FILENAME}.exe"
  ${endif}
!macroend
; This file is included before common.nsh defines APP_EXECUTABLE_FILENAME.
; PRODUCT_FILENAME is already supplied by electron-builder at that point.
; UAC callbacks run in the original user's installer instance, including when
; elevation used another account. Its PLUGINSDIR also owns that user's snapshot.
Function nuwaxRepairCurrentUserShortcuts
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  !insertmacro nuwaxProtectOtherShortcutTarget $R3
  InitPluginsDir
  File /oname=$PLUGINSDIR\repair-shortcuts.ps1 "${BUILD_RESOURCES_DIR}\repair-shortcuts.ps1"
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\repair-shortcuts.ps1" -Action "$0" -Scope CurrentUser -StatePath "$PLUGINSDIR\nuwax-user-shortcuts.json" -AppExe "$INSTDIR\${PRODUCT_FILENAME}.exe" -AppId "${APP_ID}" -ProtectedAppExe "$R3"`
  Pop $R0
  Pop $R1
  DetailPrint "$R1"
  ${if} $R0 != 0
    !insertmacro nuwaxLogRecoveryFailure ShortcutRepair
  ${endif}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function nuwaxRepairCommonShortcuts
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  !insertmacro nuwaxProtectOtherShortcutTarget $R3
  InitPluginsDir
  File /oname=$PLUGINSDIR\repair-shortcuts.ps1 "${BUILD_RESOURCES_DIR}\repair-shortcuts.ps1"
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\repair-shortcuts.ps1" -Action "$0" -Scope AllUsers -StatePath "$PLUGINSDIR\nuwax-common-shortcuts.json" -AppExe "$INSTDIR\${PRODUCT_FILENAME}.exe" -AppId "${APP_ID}" -ProtectedAppExe "$R3"`
  Pop $R0
  Pop $R1
  DetailPrint "$R1"
  ${if} $R0 != 0
    !insertmacro nuwaxLogRecoveryFailure ShortcutRepair
  ${endif}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

!macro nuwaxUpdateShortcuts ACTION
  Push $0
  StrCpy $0 "${ACTION}"
  ${if} $installMode == "all"
    Call nuwaxRepairCommonShortcuts
  ${endif}
  ${if} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Function nuwaxRepairCurrentUserShortcuts ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}
  ${else}
    Call nuwaxRepairCurrentUserShortcuts
  ${endif}
  Pop $0
!macroend
!endif
