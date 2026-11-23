!ifndef NUWAX_WINDOWS_INSTALLER_RUNTIME_NSH
!define NUWAX_WINDOWS_INSTALLER_RUNTIME_NSH
!ifndef BUILD_UNINSTALLER
!define NUWAX_INSTALLER_LIFECYCLE_LOG "$TEMP\Nuwax-installer-lifecycle.log"
Var nuwaxInstallerPhase
Var nuwaxInstallerEvent
Var nuwaxUpdateAttempt

!macro nuwaxTraceInstaller EVENT
  StrCpy $nuwaxInstallerEvent "${EVENT}"
  Call nuwaxTraceInstaller
!macroend

!macro nuwaxInstallerPhase PHASE
  StrCpy $nuwaxInstallerPhase "${PHASE}"
  !insertmacro nuwaxTraceInstaller Checkpoint
!macroend

!macro nuwaxInstallerRuntimeFunctions
; UAC callbacks execute in the original user's wrapper, including when the
; elevated installer belongs to another administrator account.
Function nuwaxRecordInstallCompletion
  WriteRegStr HKCU "Software\${APP_PACKAGE_NAME}\InstallerResults\$0" Version "${VERSION}"
  WriteRegStr HKCU "Software\${APP_PACKAGE_NAME}\InstallerResults\$0" InstallPath "$INSTDIR"
  WriteRegStr HKCU "Software\${APP_PACKAGE_NAME}\InstallerResults\$0" Status "complete"
FunctionEnd

Function nuwaxTraceInstaller
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrCpy $R4 0
  IfErrors 0 +2
    StrCpy $R4 1
  GetErrorLevel $R1
  ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" CurrentBuildNumber
  ReadRegDWORD $R3 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" UBR
  ClearErrors
  FileOpen $R0 "${NUWAX_INSTALLER_LIFECYCLE_LOG}" a
  ${ifNot} ${Errors}
    FileSeek $R0 0 END
    FileWriteUTF16LE $R0 "version=${VERSION} transaction=$nuwaxUpdateAttempt window=$HWNDPARENT event=$nuwaxInstallerEvent phase=$nuwaxInstallerPhase build=$R2.$R3 scope=$installMode exit=$R1 path=$INSTDIR$\r$\n"
    FileClose $R0
  ${endif}
  ${if} $R4 == 1
    SetErrors
  ${else}
    ClearErrors
  ${endif}
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function .onGUIEnd
  !insertmacro nuwaxTraceInstaller Exit
FunctionEnd

Function .onInstSuccess
  !insertmacro nuwaxInstallerPhase Complete
FunctionEnd
!macroend

!macro nuwaxRecordUpdateCompletion
  ${if} ${isUpdated}
  ${andif} $nuwaxUpdateAttempt != ""
    Push $0
    StrCpy $0 "$nuwaxUpdateAttempt"
    ${if} ${UAC_IsInnerInstance}
      !insertmacro UAC_AsUser_Call Function nuwaxRecordInstallCompletion ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}
    ${else}
      Call nuwaxRecordInstallCompletion
    ${endif}
    Pop $0
  ${endif}
!macroend

!macro nuwaxRequireInstallerRuntime
  !insertmacro nuwaxInstallerPhase Runtime
  ${ifNot} ${AtLeastWin10}
    SetErrorLevel 2
    !insertmacro nuwaxTraceInstaller UnsupportedWindows
    ${ifNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "此版本需要 Windows 10 或更新版本，无法在当前系统安装。"
    ${endif}
    Quit
  ${endif}
  InitPluginsDir
  ClearErrors
  File /oname=$PLUGINSDIR\installer-runtime.ps1 "${BUILD_RESOURCES_DIR}\installer-runtime.ps1"
  ${if} ${Errors}
    StrCpy $R0 2
    StrCpy $R1 "Cannot extract the installer runtime check into the temporary directory."
  ${else}
    nsExec::ExecToStack /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-runtime.ps1"`
    Pop $R0
    Pop $R1
  ${endif}
  ${if} $R0 != 0
    !insertmacro nuwaxLogRecoveryFailure Runtime
    SetErrorLevel 2
    !insertmacro nuwaxTraceInstaller Failed
    ${ifNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Windows 安装环境检查未通过。请确认 Windows PowerShell、临时目录及组织的应用控制策略允许此安装包运行。$\r$\n$R1$\r$\n详情：$TEMP\Nuwax-installer-recovery.log"
    ${endif}
    Quit
  ${endif}
!macroend
!endif
!endif
