!ifndef NUWAX_WINDOWS_MAINTENANCE_NSH
!define NUWAX_WINDOWS_MAINTENANCE_NSH
!ifndef BUILD_UNINSTALLER
!include nsDialogs.nsh
Var nuwaxMaintenanceAction
Var nuwaxMaintenanceRepair
Var nuwaxMaintenanceUninstall
Var nuwaxMaintenanceProtect
Var nuwaxMaintenancePage
Var nuwaxRepairConfirmed
Var nuwaxRecoveryWarning

!macro nuwaxInitMaintenance
  StrCpy $nuwaxMaintenanceAction ""
  StrCpy $nuwaxRepairConfirmed ""
  StrCpy $nuwaxRecoveryWarning ""
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/REPAIR" $R1
  ${ifNot} ${Errors}
    StrCpy $nuwaxMaintenanceAction "repair"
    StrCpy $nuwaxRepairConfirmed "-Repair"
  ${endif}
  ClearErrors
  ${GetOptions} $R0 "/UNINSTALL" $R1
  ${ifNot} ${Errors}
    StrCpy $nuwaxMaintenanceAction "uninstall"
  ${endif}
  ClearErrors
  ${if} ${isUpdated}
  ${andif} $nuwaxMaintenanceAction != ""
    MessageBox MB_OK|MB_ICONSTOP "维护操作不能与自动升级参数一起使用。"
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro nuwaxConfirmMaintenanceTarget
  ; Explicit repair can choose between the two existing directory candidates.
  ; Registration provides identity for a partial installation with no remaining
  ; executable. A new arbitrary path or different scope is never authorized.
  ${if} $nuwaxRepairConfirmed != ""
    ReadRegStr $R5 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    !insertmacro windowsNormalizeInstallDirectory $R5 $R6
    ReadRegStr $R5 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
    Push $R5
    Call GetInQuotes
    Pop $R5
    Push $R5
    Call GetFileParent
    Pop $R7
    StrCpy $R8 ""
    ${if} $R5 == "$R7\${UNINSTALL_FILENAME}"
      !insertmacro windowsNormalizeInstallDirectory $R7 $R8
    ${endif}
    GetFullPathName $R2 "$INSTDIR"
    ${if} $R2 == $R6
    ${orif} $R2 == $R8
      ${if} $installMode == "all"
        StrCpy $windowsRegisteredMachinePath "$R2"
        StrCpy $windowsMachinePathStatus "resolved"
      ${else}
        StrCpy $windowsRegisteredCurrentPath "$R2"
        StrCpy $windowsCurrentPathStatus "resolved"
      ${endif}
    ${endif}
  ${endif}
!macroend

!macro nuwaxRestoreFailedRegistration STATE_FILE SCOPE
  ${if} ${FileExists} "$PLUGINSDIR\${STATE_FILE}"
    !insertmacro nuwaxRecoveryScripts
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\normalize-old-install.ps1" -Action RestoreRegistration -StatePath "$PLUGINSDIR\${STATE_FILE}" -RegistryScope "${SCOPE}" -InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}"`
    Pop $R0
    Pop $R1
    !insertmacro nuwaxLogRecoveryFailure RestoreFailedRegistration
  ${endif}
!macroend

Function .onInstFailed
  ; Legacy uninstallers can remove registration before a later extraction
  ; fails. Restore the original values independently of file conflicts.
  ${if} $installMode == "all"
    !insertmacro nuwaxRestoreFailedRegistration nuwax-old-shell.txt LocalMachine
    !insertmacro nuwaxRestoreFailedRegistration nuwax-old-current.txt CurrentUser
  ${else}
    !insertmacro nuwaxRestoreFailedRegistration nuwax-old-shell.txt CurrentUser
  ${endif}
  SetErrorLevel 2
FunctionEnd

!macro nuwaxMaintenancePage
  Page custom nuwaxMaintenanceCreate nuwaxMaintenanceLeave
  Function nuwaxMaintenanceCreate
    ${if} ${isUpdated}
      Abort
    ${endif}
    !insertmacro windowsInitRegisteredPaths
    ${if} $windowsRegisteredCurrentPath == ""
    ${andif} $windowsRegisteredMachinePath == ""
    ${andif} $windowsCurrentPathStatus == "none"
    ${andif} $windowsMachinePathStatus == "none"
      ${if} $nuwaxMaintenanceAction != ""
        MessageBox MB_OK|MB_ICONSTOP "未找到可安全维护的 Nuwax 安装。请检查原安装位置或联系支持。"
        SetErrorLevel 2
        Quit
      ${endif}
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "维护女娲Nuwax" "修复安装、升级或卸载，默认保留本地数据。"
    nsDialogs::Create 1018
    Pop $nuwaxMaintenancePage
    ${if} $nuwaxMaintenancePage == error
      SetErrorLevel 2
      Quit
    ${endif}
    ${NSD_CreateLabel} 0 0 100% 35u "当前安装位置：$INSTDIR$\r$\n旧卸载器损坏时，将先修复程序再完成卸载。"
    Pop $R0
    ${NSD_CreateRadioButton} 0 40u 100% 18u "修复或升级（保留本地数据）"
    Pop $nuwaxMaintenanceRepair
    ${NSD_CreateRadioButton} 0 65u 100% 18u "卸载（必要时先修复，默认保留本地数据）"
    Pop $nuwaxMaintenanceUninstall
    ${if} $nuwaxMaintenanceAction == "uninstall"
      ${NSD_Check} $nuwaxMaintenanceUninstall
    ${else}
      ${NSD_Check} $nuwaxMaintenanceRepair
    ${endif}
    ${NSD_CreateCheckbox} 0 95u 100% 35u "上次恢复无法完成：保留旧备份和现存文件，另建事务修复。旧备份中的文件可能需要手动找回。"
    Pop $nuwaxMaintenanceProtect
    ${if} $nuwaxRepairConfirmed != ""
      ${NSD_Check} $nuwaxMaintenanceProtect
    ${endif}
    nsDialogs::Show
  FunctionEnd
  Function nuwaxMaintenanceLeave
    ${NSD_GetState} $nuwaxMaintenanceUninstall $R0
    ${if} $R0 == ${BST_CHECKED}
      StrCpy $nuwaxMaintenanceAction "uninstall"
    ${else}
      StrCpy $nuwaxMaintenanceAction "repair"
    ${endif}
    StrCpy $nuwaxRepairConfirmed ""
    ${NSD_GetState} $nuwaxMaintenanceProtect $R0
    ${if} $R0 == ${BST_CHECKED}
      StrCpy $nuwaxRepairConfirmed "-Repair"
    ${endif}
    !insertmacro nuwaxConfirmMaintenanceTarget
    !insertmacro windowsRequireRegisteredPath
    ${if} $installMode == "all"
      StrCpy $INSTDIR $windowsRegisteredMachinePath
    ${else}
      StrCpy $INSTDIR $windowsRegisteredCurrentPath
    ${endif}
  FunctionEnd
!macroend

!macro nuwaxMaintenanceComplete
  ${if} $nuwaxMaintenanceAction == "uninstall"
    ; Use the new payload's own uninstaller/inventory, never its inventory to
    ; infer ownership of a legacy or mixed installation. _?= makes this a
    ; synchronous child; no recovery mutex is held across this call.
    StrCpy $R3 "/currentuser"
    ${if} $installMode == "all"
      StrCpy $R3 "/allusers"
    ${endif}
    ${if} ${Silent}
      StrCpy $R3 "$R3 /S"
    ${endif}
    SetOutPath "$PLUGINSDIR"
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\${UNINSTALL_FILENAME}" "$PLUGINSDIR\nuwax-repaired-uninstaller.exe"
    ${if} ${Errors}
      StrCpy $R0 2
    ${else}
      ExecWait '"$PLUGINSDIR\nuwax-repaired-uninstaller.exe" $R3 _?=$INSTDIR' $R0
    ${endif}
    ${if} ${Errors}
      StrCpy $R0 2
    ${endif}
    ${if} $R0 != 0
      StrCpy $R1 "Repaired uninstall failed; the new uninstall entry and recovery files are retained."
      !insertmacro nuwaxLogRecoveryFailure MaintenanceUninstall
    ${endif}
    SetErrorLevel $R0
    Quit
  ${endif}
!macroend
!endif
!endif
