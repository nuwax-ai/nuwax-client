; ---------------------------------------------------------------------------
; Nuwax 商业版 NSIS 定制：安装向导显示中文营销名「女娲Nuwax」
;
; 背景：productName 一个值同时决定「显示名」与「产物文件名」，而商业身份要求
; 文件名/包名一律 ASCII（Nuwax-Setup-*.exe / Nuwax.app / deb 包名 nuwax），
; 故 productName 必须保持 ASCII "Nuwax"，中文名只能在向导 UI 层单独覆盖。
;
; 机制：electron-builder 的 common.nsh 先执行
;     BrandingText "${PRODUCT_NAME} ${VERSION}"   ← 底部版本行
;     Name "${PRODUCT_NAME}"                      ← 向导标题与正文
; 而本文件的 customHeader 宏由 installer.nsi 在其**之后**插入；NSIS 中后写的
; 同名指令覆盖先写的 → 只重写 Name 即可让标题/正文变中文。
;
; ⚠️ 刻意不重写 BrandingText：底部「Nuwax 1.0.4」保持 ASCII（产品要求）。
; 卸载程序文件名走 PRODUCT_FILENAME（同为 ASCII），与 autoUpdater 的
; app.getName() → "Nuwax" 对齐，改动不影响自动更新查找卸载程序。
; NSIS Unicode 默认开启（nsis.unicode !== false），中文字面量安全。
; ---------------------------------------------------------------------------

!include "${BUILD_RESOURCES_DIR}\uninstall-options.nsh"

!macro customHeader
  Name "女娲Nuwax"
  !insertmacro nuwaxUninstallStrings
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
    FileWrite $R2 "$\r$\n${VERSION} ${ACTION} exit=$R0$\r$\n$R1$\r$\n"
    FileClose $R2
  ${endif}
!macroend

; Standalone failures stop before registration cleanup and keep the uninstaller
; for retry. Updates retain the atomic rename/restore path of the parent installer.
!macro customRemoveFiles
  ${if} ${isUpdated}
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
  ; This macro also expands from customInit, before installUtil.nsh is included.
  ; Use NSIS registry reads and the functions that installUtil defines later.
  ReadRegStr $R3 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $R3 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R3 ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${endif}

  ${if} $R3 != ""
    Push $R3
    Call GetInQuotes
    Pop $R4
    ReadRegStr $R5 ${ROOT_KEY} "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R5 == ""
    ${andIf} $R4 != ""
      Push $R4
      Call GetFileParent
      Pop $R5
    ${endif}

    ; Registry data can be stale or malformed. Never let uninstallOldVersion
    ; delete a directory that has not passed the preservation step.
    StrCpy $R7 0
    ${if} $R5 != ""
    ${andIf} $R4 != ""
      StrCpy $R6 $R5 1 -1
      ${if} $R6 == "\"
        StrCpy $R5 $R5 -1
      ${endif}
      ${StdUtils.GetDrivePart} $R6 "$R5"
      ${if} $R5 != "$R6"
      ${andIf} $R5 != "$R6\"
      ${andIf} $R4 == "$R5\${UNINSTALL_FILENAME}"
      ${andIf} ${FileExists} "$R4"
        StrCpy $R7 1
      ${endif}
    ${endif}

    ${if} $R7 != 1
      MessageBox MB_OK|MB_ICONSTOP "无法安全确认旧版安装路径，已停止升级并保留原有文件。请联系支持。"
      SetErrorLevel 2
      Quit
    ${endif}

    ; A missing InstallLocation is normal for older per-user installs. Its
    ; ReadRegStr leaves NSIS's error flag set even after GetFileParent supplies
    ; a verified path; do not carry that stale flag into the upgrade steps.
    ClearErrors
    DetailPrint `Preserving old "${PRODUCT_NAME}" installation in $R5 (${ROOT_KEY})`
    File /oname=$PLUGINSDIR\normalize-old-install.ps1 "${BUILD_RESOURCES_DIR}\normalize-old-install.ps1"
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\normalize-old-install.ps1" -Action Prepare -InstallDir "$R5" -StatePath "$PLUGINSDIR\${STATE_FILE}"`
    Pop $R0
    Pop $R1
    ${if} $R0 != 0
      !insertmacro nuwaxLogRecoveryFailure Prepare
      MessageBox MB_OK|MB_ICONSTOP "旧版安装文件保全失败，升级已停止。原文件或备份保留在旧安装目录旁的 Nuwax-installer-recovery 目录。错误码：$R0。详情：$TEMP\Nuwax-installer-recovery.log"
      SetErrorLevel 2
      Quit
    ${endif}
    ${if} $R1 != ""
      DetailPrint "$R1"
    ${endif}
  ${endif}
!macroend

!macro nuwaxRestoreOldInstall STATE_FILE
  ${if} ${FileExists} "$PLUGINSDIR\${STATE_FILE}"
    File /oname=$PLUGINSDIR\normalize-old-install.ps1 "${BUILD_RESOURCES_DIR}\normalize-old-install.ps1"
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\normalize-old-install.ps1" -Action Restore -StatePath "$PLUGINSDIR\${STATE_FILE}"`
    Pop $R0
    Pop $R1
    ${if} $R0 != 0
      !insertmacro nuwaxLogRecoveryFailure Restore
      MessageBox MB_OK|MB_ICONSTOP "新版已安装，但旧版工作区自动恢复失败。旧文件保留在旧安装目录旁的 Nuwax-installer-recovery 目录，请联系支持。错误码：$R0"
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
    ${if} ${FileExists} "$PLUGINSDIR\${STATE_FILE}"
      File /oname=$PLUGINSDIR\normalize-old-install.ps1 "${BUILD_RESOURCES_DIR}\normalize-old-install.ps1"
      nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\normalize-old-install.ps1" -Action Rollback -StatePath "$PLUGINSDIR\${STATE_FILE}"`
      Pop $R8
      Pop $R9
      DetailPrint "$R9"
    ${endif}
    ${if} $R8 == 0
      MessageBox MB_OK|MB_ICONSTOP "旧版卸载失败，已恢复原有安装文件。新版安装已停止，请联系支持。"
    ${elseif} $R8 == "missing"
      MessageBox MB_OK|MB_ICONSTOP "旧版卸载失败，未找到自动恢复记录。新版安装已停止，请联系支持。"
    ${else}
      MessageBox MB_OK|MB_ICONSTOP "旧版卸载失败，自动恢复未完成。旧文件保留在旧安装目录旁的 Nuwax-installer-recovery 目录，请联系支持。恢复码：$R8"
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
  ${if} ${isUpdated}
    SetAutoClose true
  ${endif}
  ${if} ${UAC_IsInnerInstance}
    !insertmacro setInstallModePerAllUsers
    InitPluginsDir
    !insertmacro customCheckAppRunning
  ${endif}
!macroend

; 更新沿用正在运行副本的范围，首次安装仍由向导选择。/D 由更新器传入，
; initMultiUser 已将其解析到 INSTDIR；注册表同时存在两种安装时也不能换副本。
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $perMachineInstallationFolder != ""
    ${andIf} $INSTDIR == $perMachineInstallationFolder
      StrCpy $isForceMachineInstall "1"
    ${elseif} $perUserInstallationFolder != ""
    ${andIf} $INSTDIR == $perUserInstallationFolder
      StrCpy $isForceCurrentInstall "1"
    ${elseif} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

; builder 的目录规整回调在跳过目录页后仍运行，会给自定义旧路径追加产品名。
; 更新必须保持原目录；首装继续执行原模板的规整逻辑。
!macro customPageAfterChangeDir
  !ifdef allowToChangeInstallationDirectory
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define MUI_PAGE_CUSTOMFUNCTION_PRE nuwaxInstFilesPre
    Function nuwaxInstFilesPre
      ${ifNot} ${isUpdated}
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
!macroend
