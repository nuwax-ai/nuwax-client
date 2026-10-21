; ---------------------------------------------------------------------------
; Nuwax 商业版 NSIS 定制：安装向导显示中文营销名「女娲Nuwax」
;
; 背景：productName 一个值同时决定「显示名」与「产物文件名」，而商业身份要求
; 文件名/包名一律 ASCII（Nuwax-Setup-*.exe / Nuwax.app / deb 包名 nuwax），
; 故 productName 必须保持 ASCII "Nuwax"，中文名在向导 UI 层单独覆盖。
;
; 机制：electron-builder 的 common.nsh 先执行
;     BrandingText "${PRODUCT_NAME} ${VERSION}"   ← 底部版本行
;     Name "${PRODUCT_NAME}"                      ← 向导标题与正文
; 而本文件的 customHeader 宏由 installer.nsi 在其**之后**插入；NSIS 中后写的
; 同名指令覆盖先写的，统一标题、正文和底部版本行的用户可见名称。
;
; 卸载程序文件名走 PRODUCT_FILENAME（同为 ASCII），与 autoUpdater 的
; app.getName() → "Nuwax" 对齐，改动不影响自动更新查找卸载程序。
; NSIS Unicode 默认开启（nsis.unicode !== false），中文字面量安全。
; ---------------------------------------------------------------------------

!include "${BUILD_RESOURCES_DIR}\uninstall-options.nsh"
!include "${BUILD_RESOURCES_DIR}\windows-install-path.nsh"

!macro preInit
  !ifndef BUILD_UNINSTALLER
    ; NSIS removes its /D tail from $CMDLINE before initMultiUser runs.
    ; Capture it from Windows before any scope callback resets INSTDIR.
    System::Call 'kernel32::GetCommandLineW() w .R0'
    ${GetOptions} $R0 "/D=" $R1
    ${ifNot} ${Errors}
      ; GetOptions treats '/' as a delimiter; use it only to detect /D.
      ; NSIS has already parsed its full tail into INSTDIR, including spaces
      ; and forward slashes. Canonicalize that value before scope callbacks.
      GetFullPathName $windowsCommandLineInstallPath "$INSTDIR"
    ${else}
      StrCpy $windowsCommandLineInstallPath ""
    ${endif}
    ClearErrors
    !insertmacro check64BitAndSetRegView
    !insertmacro windowsRepairRegisteredPaths
  !endif
!macroend

; This hook runs before assistedInstaller emits the install-mode page functions.
!macro customWelcomePage
  !include "${BUILD_RESOURCES_DIR}\windows-maintenance.nsh"
  !include "${BUILD_RESOURCES_DIR}\windows-per-user-install.nsh"
!macroend

!macro customHeader
  !include "${BUILD_RESOURCES_DIR}\windows-maintenance.nsh"
  !include "${BUILD_RESOURCES_DIR}\windows-per-user-install.nsh"
  Name "女娲Nuwax"
  BrandingText "女娲Nuwax ${VERSION}"
  !insertmacro nuwaxUninstallStrings
  !insertmacro windowsInstallPathStrings
  ; Cleanup is an explicit, default-off choice; never inherit builder's
  ; unconditional data deletion, including while an old version is updated.
  !ifdef DELETE_APP_DATA_ON_UNINSTALL
    !undef DELETE_APP_DATA_ON_UNINSTALL
  !endif
!macroend

!macro nuwaxStopStandaloneUninstall MESSAGE
  DetailPrint "${MESSAGE}"
  ${ifNot} ${Silent}
    MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}"
  ${endif}
  SetErrorLevel 2
  Quit
!macroend

; nsExec captures the useful PowerShell error in R1. Keep it after the wizard
; exits, including failures before a recovery directory has been created.
!macro nuwaxLogRecoveryFailure ACTION
  DetailPrint "${ACTION} failed: exit=$R0"
  DetailPrint "$R1"
  ClearErrors
  FileOpen $R2 "$TEMP\Nuwax-installer-recovery.log" a
  ${ifNot} ${Errors}
    FileSeek $R2 0 END
    FileWrite $R2 "$\r$\n${VERSION} ${ACTION} exit=$R0$\r$\n$R1$\r$\n"
    FileClose $R2
  ${endif}
!macroend

!macro nuwaxRequireSafeInstallTarget
  !insertmacro windowsNormalizeInstallDirectory $INSTDIR $R1
  ${if} $R1 == ""
    StrCpy $R0 2
    StrCpy $R1 "Installation target is not a safe local application directory."
    !insertmacro nuwaxLogRecoveryFailure InstallTarget
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!include "${BUILD_RESOURCES_DIR}\shortcut-repair.nsh"

; Standalone failures stop before registration cleanup and keep the uninstaller
; for retry. Updates retain the atomic rename/restore path of the parent installer.
!macro nuwaxRecoveryScripts
  InitPluginsDir
  File /oname=$PLUGINSDIR\normalize-old-install.ps1 "${BUILD_RESOURCES_DIR}\normalize-old-install.ps1"
  File /oname=$PLUGINSDIR\installer-backup-retention.ps1 "${BUILD_RESOURCES_DIR}\installer-backup-retention.ps1"
!macroend


!macro customRemoveFiles
  !insertmacro windowsRequireRegisteredPath
  ${if} ${isUpdated}
    ; The old uninstaller is the trusted source of its own payload inventory.
    ; Legacy uninstallers leave no proof and their backups remain protected.
    !insertmacro nuwaxRecoveryScripts
    !insertmacro nuwaxExtractUninstallInventory
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\normalize-old-install.ps1" -Action RecordPayload -InstallDir "$INSTDIR" -StatePath "$PLUGINSDIR\nuwax-payload-state.txt" -PayloadInventoryPath "$PLUGINSDIR\uninstall-payload.json"`
    Pop $R0
    Pop $R1
    ${if} $R0 != 0
      !insertmacro nuwaxLogRecoveryFailure RecordPayload
    ${endif}
    ClearErrors
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}

    RMDir /r $INSTDIR
  ${else}
    !insertmacro nuwaxRemoveOwnedFiles
  ${endif}
!macroend

; electron-builder 25's default CHECK_APP_RUNNING only stops matching Nuwax.exe
; processes. The Electron main process owns several helper trees, so a surviving
; child can keep the install directory locked and make the stock retry loop fail.
; First request a graceful shutdown of the app tree, then force-stop that tree if
; it does not exit within the app's 10-second shutdown-cleanup window.
!macro nuwaxFindAppProcess RESULT
  ${if} $installMode == "all"
    ; The assisted installer chooses the install mode at runtime. In this mode,
    ; another Windows user's Nuwax process can hold the shared directory open.
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" ${RESULT}
  ${else}
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" ${RESULT}
  ${endif}
!macroend

; Match the same registry lookup and install directory used by installUtil.nsh's
; uninstallOldVersion. The old uninstaller deletes its entire install directory,
; including user workspaces when they were placed there. Preserve every entry
; outside that directory before invoking it.
!macro nuwaxPrepareOldInstall ROOT_KEY STATE_FILE
  StrCpy $R5 "$windowsRegisteredCurrentPath"
  StrCpy $R6 "CurrentUser"
  ${if} $installMode == "all"
    !if "${ROOT_KEY}" != "HKEY_CURRENT_USER"
      StrCpy $R5 "$windowsRegisteredMachinePath"
      StrCpy $R6 "LocalMachine"
    !endif
  ${endif}
  ${if} $R5 != ""
    DetailPrint "正在保全原安装并检查恢复状态，请稍候；所有个人文件将保留..."
    !insertmacro nuwaxRecoveryScripts
    SectionGetSize 0 $R7
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\normalize-old-install.ps1" -Action Prepare -AllowMissingUninstaller $nuwaxRepairConfirmed -RequiredSpaceKB "$R7" -InstallDir "$R5" -StatePath "$PLUGINSDIR\${STATE_FILE}" -RegistryScope "$R6" -InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}"`
    Pop $R0
    Pop $R1
    DetailPrint "$R1"
    StrCpy $R3 $R1 16
    ${if} $R3 == "RECOVERY_WARNING"
      StrCpy $nuwaxRecoveryWarning "1"
    ${endif}
    ${if} $R0 != 0
      !insertmacro nuwaxLogRecoveryFailure Prepare
      ${ifNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "旧版文件保全未完成。请解除占用或使用完整安装包的维护选项重试。现存文件与备份已保留。详情：$TEMP\Nuwax-installer-recovery.log"
      ${endif}
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}
!macroend

!macro nuwaxRestoreOldInstall STATE_FILE
  ${if} ${FileExists} "$PLUGINSDIR\${STATE_FILE}"
    !insertmacro nuwaxRecoveryScripts
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\normalize-old-install.ps1" -Action Restore -StatePath "$PLUGINSDIR\${STATE_FILE}"`
    Pop $R0
    Pop $R1
    ${if} $R0 != 0
      !insertmacro nuwaxLogRecoveryFailure Restore
      MessageBox MB_OK|MB_ICONSTOP "新版已安装，但旧版工作区自动恢复失败。旧文件保留在旧安装目录旁的 Nuwax-installer-recovery 目录，请联系支持。错误码：$R0" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
    ${if} $R1 != ""
      DetailPrint "$R1"
    ${endif}
  ${endif}
!macroend

; installUtil's built-in retry message treats every nonzero old uninstaller
; result as an app lock. If it still fails after preservation, put the old
; program and user files back before aborting the new installation.
!macro nuwaxCheckOldUninstallResult STATE_FILE
  StrCpy $R8 0
  ${if} ${Errors}
    StrCpy $R8 1
  ${endif}
  ${if} $R0 != 0
    StrCpy $R8 1
  ${endif}
  ${if} $R8 == 1
    StrCpy $R8 "missing"
    StrCpy $R6 "CurrentUser"
    ${if} $installMode == "all"
      !if "${STATE_FILE}" == "nuwax-old-shell.txt"
        StrCpy $R6 "LocalMachine"
      !endif
    ${endif}
    ${if} ${FileExists} "$PLUGINSDIR\${STATE_FILE}"
      !insertmacro nuwaxRecoveryScripts
      nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\normalize-old-install.ps1" -Action Rollback -StatePath "$PLUGINSDIR\${STATE_FILE}" -RegistryScope "$R6" -InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}"`
      Pop $R8
      Pop $R9
      DetailPrint "$R9"
    ${endif}
    ${if} $R8 == 0
      MessageBox MB_OK|MB_ICONSTOP "旧版卸载失败，已恢复原有安装文件。新版安装已停止，请联系支持。" /SD IDOK
    ${elseif} $R8 == "missing"
      MessageBox MB_OK|MB_ICONSTOP "旧版卸载失败，未找到自动恢复记录。新版安装已停止，请联系支持。" /SD IDOK
    ${else}
      MessageBox MB_OK|MB_ICONSTOP "旧版卸载失败，自动恢复未完成。旧文件保留在旧安装目录旁的 Nuwax-installer-recovery 目录，请联系支持。恢复码：$R8" /SD IDOK
    ${endif}
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro nuwaxCheckOldUninstallResult nuwax-old-shell.txt
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro nuwaxCheckOldUninstallResult nuwax-old-current.txt
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !ifmacrodef uninstallOldVersion
      !include "${BUILD_RESOURCES_DIR}\windows-old-uninstaller.nsh"
    !endif
  !endif
  !ifndef BUILD_UNINSTALLER
    ; Scope callbacks can reparse /D; restore its full (possibly spaced) value.
    !insertmacro windowsInitRegisteredPaths
    !insertmacro nuwaxRequireSafeInstallTarget
    !insertmacro nuwaxConfirmMaintenanceTarget
    !insertmacro windowsRequireRegisteredPath
  !endif
  ${if} $EXEFILE != "${APP_EXECUTABLE_FILENAME}"
    !insertmacro nuwaxFindAppProcess $R0
    ${if} $R0 == 0
      ${ifNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK customDoStopApp
        Quit
        customDoStopApp:
      ${endIf}

      DetailPrint `Closing running "${PRODUCT_NAME}" and its child processes...`
      System::Call 'kernel32::GetCurrentProcessId() i.R2'

      ; Give app-side cleanup (which can take up to 10 seconds) time to finish.
      ${if} $installMode == "all"
        nsExec::Exec `taskkill /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $R2"`
      ${else}
        nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $R2" /fi "USERNAME eq %USERNAME%"`
      ${endif}
      Pop $R0

      StrCpy $R1 0
      customWaitForAppExit:
        !insertmacro nuwaxFindAppProcess $R0
        ${if} $R0 != 0
          Goto customAppClosed
        ${endIf}
        ${if} $R1 >= 10
          Goto customForceAppTree
        ${endIf}
        Sleep 1000
        IntOp $R1 $R1 + 1
        Goto customWaitForAppExit

      ; The app did not exit cleanly. Force-stop the process tree so helper
      ; processes do not keep files in the installation directory open.
      customForceAppTree:
      StrCpy $R1 0
      customForceAppTreeLoop:
        ${if} $installMode == "all"
          nsExec::Exec `taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $R2"`
        ${else}
          nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $R2" /fi "USERNAME eq %USERNAME%"`
        ${endif}
        Pop $R0
        Sleep 1000
        !insertmacro nuwaxFindAppProcess $R0
        ${if} $R0 != 0
          Goto customAppClosed
        ${endIf}
        IntOp $R1 $R1 + 1
        ${if} $R1 < 3
          Goto customForceAppTreeLoop
        ${endIf}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY customForceAppTreeLoop
        Quit

      customAppClosed:
    ${endIf}

    !ifndef BUILD_UNINSTALLER
      ; An unprivileged all-users outer instance must let the elevated inner
      ; instance perform preservation. Current-user and already-elevated
      ; installs prepare exactly the registrations that installSection removes.
      ${if} $installMode != "all"
      ${orIf} ${UAC_IsAdmin}
        !insertmacro nuwaxUpdateShortcuts Capture
        !insertmacro nuwaxPrepareOldInstall SHELL_CONTEXT nuwax-old-shell.txt
        ${if} $installMode == "all"
          !insertmacro nuwaxPrepareOldInstall HKEY_CURRENT_USER nuwax-old-current.txt
        ${endIf}
      ${endif}
    !endif
  ${endIf}
!macroend

; The assisted installer skips CHECK_APP_RUNNING in its elevated UAC inner
; instance. That is the process that actually uninstalls an all-users copy, so
; perform the same close and directory preflight before it reaches the section.
!macro customInit
  !insertmacro nuwaxInitMaintenance
  !insertmacro windowsInitRegisteredPaths
  !insertmacro nuwaxRequireSafeInstallTarget
  ${if} ${Silent}
  ${orif} ${isUpdated}
    !insertmacro nuwaxConfirmMaintenanceTarget
    !insertmacro windowsRequireRegisteredPath
  ${endif}
  ${if} $nuwaxMaintenanceAction != ""
  ${andif} $windowsCurrentPathStatus == "none"
  ${andif} $windowsMachinePathStatus == "none"
    SetErrorLevel 2
    Quit
  ${endif}
  ${if} ${isUpdated}
    SetAutoClose true
  ${endif}
  ${if} ${UAC_IsInnerInstance}
    !insertmacro setInstallModePerAllUsers
    !insertmacro windowsInitRegisteredPaths
    InitPluginsDir
    !insertmacro customCheckAppRunning
  ${endif}
!macroend

; 更新沿用正在运行副本的范围，首次安装仍由向导选择。/D 由更新器传入，
; initMultiUser 已将其解析到 INSTDIR；注册表同时存在两种安装时也不能换副本。
!macro customInstallMode
  !insertmacro windowsSelectUpdateInstallMode
!macroend

; builder 的目录规整回调在跳过目录页后仍运行，会给自定义旧路径追加产品名。
; 更新必须保持原目录；首装继续执行原模板的规整逻辑。
!macro customPageAfterChangeDir
  !insertmacro nuwaxMaintenancePage
  !ifdef allowToChangeInstallationDirectory
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define MUI_PAGE_CUSTOMFUNCTION_PRE nuwaxInstFilesPre
    Function nuwaxInstFilesPre
      ${ifNot} ${isUpdated}
      ${andif} $nuwaxMaintenanceAction == ""
        Call instFilesPre
      ${endif}
    FunctionEnd
  !endif
!macroend

; 只有成功安装后才进入完成页。升级直接以原桌面用户打开新版并跳过此页；
; 首装保留默认的运行复选框和完成按钮。静默更新仍由 vendor 的 installSection 启动。
!macro customFinishPage
  Function nuwaxStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function nuwaxFinishPagePre
    ${if} ${isUpdated}
      HideWindow
      Call nuwaxStartApp
      Abort
    ${endif}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE nuwaxFinishPagePre
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION nuwaxStartApp
  !insertmacro MUI_PAGE_FINISH
!macroend

; installSection invokes this after the old uninstaller, new payload extraction,
; and registry update. Restore every non-application entry at its old path;
; known Electron payload files remain in the persistent recovery directory.
!macro customInstall
  !insertmacro nuwaxRestoreOldInstall nuwax-old-shell.txt
  ${if} $installMode == "all"
    !insertmacro nuwaxRestoreOldInstall nuwax-old-current.txt
  ${endif}
  !insertmacro nuwaxUpdateShortcuts Repair
  ${if} $nuwaxRecoveryWarning == "1"
  ${andifNot} ${Silent}
    MessageBox MB_OK|MB_ICONEXCLAMATION "当前安装已修复，现存文件已保留。上次备份已丢失或无法自动恢复，其中的旧文件无法保证找回，请核对您的文件。诊断记录保留在原安装目录旁。"
  ${endif}
  !insertmacro nuwaxMaintenanceComplete
!macroend
