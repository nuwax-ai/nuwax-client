; Included from CHECK_APP_RUNNING only after installUtil.nsh has defined its
; macros. Keep the pinned vendor template untouched and replace just this call.
!ifndef NUWAX_OLD_UNINSTALLER_OVERRIDE
!define NUWAX_OLD_UNINSTALLER_OVERRIDE
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  StrCpy $R4 "$PLUGINSDIR\nuwax-old-shell.txt"
  !if "${ROOT_KEY}" == "HKEY_CURRENT_USER"
    StrCpy $R4 "$PLUGINSDIR\nuwax-old-current.txt"
  !endif
  ${if} ${FileExists} "$R4"
    ; Prepare has already preserved this exact registered installation. New
    ; installers own the fallback, so a damaged old executable cannot lock all
    ; future installs into the vendor's app-running retry loop.
    StrCpy $R6 "$windowsRegisteredCurrentPath"
    ${if} $installMode == "all"
      !if "${ROOT_KEY}" != "HKEY_CURRENT_USER"
        StrCpy $R6 "$windowsRegisteredMachinePath"
      !endif
    ${endif}
    StrCpy $R5 "$R6\${UNINSTALL_FILENAME}"
    StrCpy $R7 "/currentuser"
    ${if} $installMode == "all"
      !if "${ROOT_KEY}" != "HKEY_CURRENT_USER"
        StrCpy $R7 "/allusers"
      !endif
    ${endif}
    StrCpy $R0 2
    ${if} ${FileExists} "$R5"
      ClearErrors
      CopyFiles /SILENT "$R5" "$PLUGINSDIR\nuwax-legacy-uninstaller.exe"
      ${ifNot} ${Errors}
        ClearErrors
        ExecWait '"$PLUGINSDIR\nuwax-legacy-uninstaller.exe" /S /KEEP_APP_DATA --updated $R7 _?=$R6' $R0
        ${if} ${Errors}
          StrCpy $R0 2
        ${endif}
      ${endif}
    ${endif}
    DetailPrint "Legacy uninstaller exit=$R0; validating preserved directory before replacement."
    ${if} $R0 != 0
      StrCpy $R1 "Legacy executable could not remove the preserved installation; validating complete-package fallback."
      !insertmacro nuwaxLogRecoveryFailure LegacyUninstaller
    ${endif}
    !insertmacro nuwaxRecoveryScripts
    ; Re-read all working registers: external processes/plugins may overwrite
    ; them. StatePath plus manifest bind Detach to the prepared directory.
    StrCpy $R4 "$PLUGINSDIR\nuwax-old-shell.txt"
    !if "${ROOT_KEY}" == "HKEY_CURRENT_USER"
      StrCpy $R4 "$PLUGINSDIR\nuwax-old-current.txt"
    !endif
    StrCpy $R6 "CurrentUser"
    ${if} $installMode == "all"
      !if "${ROOT_KEY}" != "HKEY_CURRENT_USER"
        StrCpy $R6 "LocalMachine"
      !endif
    ${endif}
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\normalize-old-install.ps1" -Action Detach -StatePath "$R4" -RegistryScope "$R6"`
    Pop $R0
    Pop $R1
    ${if} $R0 != 0
      !insertmacro nuwaxLogRecoveryFailure Detach
      SetErrors
    ${else}
      DetailPrint "$R1"
      ClearErrors
    ${endif}
  ${else}
    ; No registered old install was prepared. Retain normal fresh-install
    ; behavior; unresolved registrations were rejected before this point.
    Push "${ROOT_KEY}"
    Call uninstallOldVersion
  ${endif}
!macroend
!endif
