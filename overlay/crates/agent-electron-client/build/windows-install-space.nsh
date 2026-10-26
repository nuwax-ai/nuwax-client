!ifndef NUWAX_WINDOWS_INSTALL_SPACE_NSH
!define NUWAX_WINDOWS_INSTALL_SPACE_NSH
!ifndef BUILD_UNINSTALLER
Var nuwaxSpaceCode
Var nuwaxSpaceReport
Var nuwaxSpaceLabel

; The commercial include is read before the vendor declares installMode/x64
; helpers. Emit functions from customHeader after those declarations exist.
!macro nuwaxInstallSpaceFunctions
Function nuwaxCheckInstallSpace
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $R0 0
  !ifdef APP_32
    StrCpy $R0 "${APP_32_UNPACKED_SIZE}"
  !endif
  !ifdef APP_64
    ${if} ${RunningX64}
    ${orif} ${IsNativeARM64}
      StrCpy $R0 "${APP_64_UNPACKED_SIZE}"
    ${endif}
  !endif
  !ifdef APP_ARM64
    ${if} ${IsNativeARM64}
      StrCpy $R0 "${APP_ARM64_UNPACKED_SIZE}"
    ${endif}
  !endif
  ; Match the vendor's per-user updater cache even for an all-users install.
  SetShellVarContext current
  StrCpy $R1 "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
  InitPluginsDir
  File /oname=$PLUGINSDIR\installer-space.ps1 "${BUILD_RESOURCES_DIR}\installer-space.ps1"
  Delete "$PLUGINSDIR\nuwax-space-report.txt"
  StrCpy $R3 ""
  !ifndef ZIP_COMPRESSION
    StrCpy $R3 "-SevenZip"
  !endif
  nsExec::ExecToStack /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-space.ps1" -InstallDir "$INSTDIR" -TempPath "$PLUGINSDIR" -CachePath "$R1" -InstallerPath "$EXEPATH" -UnpackedSizeKB "$R0" -ReportPath "$PLUGINSDIR\nuwax-space-report.txt" $R3`
  Pop $nuwaxSpaceCode
  Pop $R1
  StrCpy $nuwaxSpaceReport ""
  ClearErrors
  FileOpen $R2 "$PLUGINSDIR\nuwax-space-report.txt" r
  ${ifNot} ${Errors}
    ${do}
      ClearErrors
      FileReadUTF16LE $R2 $R3
      ${if} ${Errors}
        ${exitdo}
      ${endif}
      StrCpy $nuwaxSpaceReport "$nuwaxSpaceReport$R3"
    ${loop}
    FileClose $R2
  ${endif}
  ${if} $nuwaxSpaceReport == ""
    StrCpy $nuwaxSpaceCode 2
    StrCpy $nuwaxSpaceReport "无法检查磁盘空间，请确认临时目录、安装磁盘及 Windows PowerShell 可用。$\r$\n$R1"
  ${endif}
  ${if} $nuwaxSpaceCode != 0
    DetailPrint "$nuwaxSpaceReport"
    ClearErrors
    FileOpen $R2 "$TEMP\Nuwax-installer-space.log" a
    ${ifNot} ${Errors}
      FileSeek $R2 0 END
      FileWriteUTF16LE $R2 "${VERSION} exit=$nuwaxSpaceCode $nuwaxSpaceReport$\r$\n"
      FileClose $R2
    ${endif}
  ${endif}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd
!macroend

!macro nuwaxRequireInstallSpace
  ${do}
    Call nuwaxCheckInstallSpace
    ${if} $nuwaxSpaceCode == 0
      ${exitdo}
    ${endif}
    SetErrorLevel 2
    ${if} ${Silent}
      Quit
    ${endif}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "安装前磁盘空间检查未通过。$\r$\n$nuwaxSpaceReport$\r$\n$\r$\n清理空间后点击重试，或取消本次安装后重新运行并选择安装位置。" IDRETRY +2
    Quit
  ${loop}
  SetErrorLevel 0
!macroend

!macro nuwaxInstallSpacePage
  Page custom nuwaxSpacePageCreate nuwaxSpacePageLeave
  Function nuwaxSpacePageCreate
    ; The stock directory normalization normally happens only at instfiles.
    ; Check that same final directory before showing a failure page.
    Call nuwaxInstFilesPre
    Call nuwaxCheckInstallSpace
    ${if} $nuwaxSpaceCode == 0
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "检查安装空间" "请清理磁盘空间，或返回修改安装位置。"
    nsDialogs::Create 1018
    Pop $R0
    ${if} $R0 == error
      SetErrorLevel 2
      Quit
    ${endif}
    ${NSD_CreateLabel} 0 0 100% 105u "$nuwaxSpaceReport"
    Pop $nuwaxSpaceLabel
    ${NSD_CreateButton} 0 110u 80u 20u "重新检查"
    Pop $R0
    ${NSD_OnClick} $R0 nuwaxSpacePageRetry
    GetDlgItem $R0 $HWNDPARENT 1
    EnableWindow $R0 0
    nsDialogs::Show
  FunctionEnd
  Function nuwaxSpacePageRetry
    Pop $R0
    Call nuwaxCheckInstallSpace
    ${NSD_SetText} $nuwaxSpaceLabel "$nuwaxSpaceReport"
    GetDlgItem $R0 $HWNDPARENT 1
    ${if} $nuwaxSpaceCode == 0
      EnableWindow $R0 1
    ${else}
      EnableWindow $R0 0
    ${endif}
  FunctionEnd
  Function nuwaxSpacePageLeave
    Call nuwaxCheckInstallSpace
    ${if} $nuwaxSpaceCode != 0
      ${NSD_SetText} $nuwaxSpaceLabel "$nuwaxSpaceReport"
      Abort
    ${endif}
  FunctionEnd
!macroend
!endif
!endif
