!include nsDialogs.nsh

Var nuwaxDeleteLocalData
Var nuwaxDeleteDataCheckbox
Var nuwaxDataPage
Var nuwaxDataProfile
Var nuwaxDataRoaming
Var nuwaxDataLocal

!macro nuwaxUninstallStrings
  LangString nuwaxUninstallTitle 2052 "卸载女娲Nuwax"
  LangString nuwaxUninstallInfo 2052 "默认保留本地数据，重新安装后可继续使用。安装目录中的个人文件和外部项目不会删除。"
  LangString nuwaxDeleteDataLabel 2052 "同时删除当前 Windows 用户的本地数据（不可恢复）"
  LangString nuwaxDeleteDataScope 2052 "勾选后删除此账号的设置、登录信息、会话、应用内工作区与缓存："
  LangString nuwaxUninstallTitle 1028 "解除安裝女媧Nuwax"
  LangString nuwaxUninstallInfo 1028 "預設保留本機資料，重新安裝後可繼續使用。安裝目錄中的個人檔案與外部專案不會刪除。"
  LangString nuwaxDeleteDataLabel 1028 "同時刪除目前 Windows 使用者的本機資料（無法復原）"
  LangString nuwaxDeleteDataScope 1028 "勾選後刪除此帳號的設定、登入資訊、工作階段、應用程式內工作區與快取："
  LangString nuwaxUninstallTitle 1033 "Uninstall Nuwax"
  LangString nuwaxUninstallInfo 1033 "Local data is kept by default for reinstallation. Personal files in the installation directory and external projects are retained."
  LangString nuwaxDeleteDataLabel 1033 "Also delete this Windows user's local data (cannot be undone)"
  LangString nuwaxDeleteDataScope 1033 "Deletes this account's settings, sign-in data, sessions, app-managed workspaces and caches:"
  LangString nuwaxUninstallTitle 1041 "Nuwax のアンインストール"
  LangString nuwaxUninstallInfo 1041 "再インストールに備え、ローカルデータは既定で保持されます。インストール先の個人ファイルと外部プロジェクトは削除しません。"
  LangString nuwaxDeleteDataLabel 1041 "現在の Windows ユーザーのローカルデータも削除する（復元不可）"
  LangString nuwaxDeleteDataScope 1041 "このアカウントの設定、ログイン情報、セッション、アプリ内ワークスペースとキャッシュを削除します："
!macroend

!macro customUnInit
  !insertmacro windowsInitUninstallPath
  StrCpy $nuwaxDeleteLocalData 0
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${ifNot} ${Errors}
    !insertmacro nuwaxStopStandaloneUninstall "Use the local-data checkbox in the uninstall wizard; --delete-app-data is not supported."
  ${endif}
  ClearErrors
  ${ifNot} ${isUpdated}
    ; Elevate before displaying the choice, so an inner instance never loses
    ; a checked state or silently applies it to a different account.
    ${if} $installMode == "all"
    ${andIfNot} ${UAC_IsAdmin}
      !insertmacro UAC_RunElevated
      ${if} $0 != 0
        SetErrorLevel $0
      ${else}
        SetErrorLevel $2
      ${endif}
      Quit
    ${endif}
  ${endif}
  SetShellVarContext current
  StrCpy $nuwaxDataProfile $PROFILE
  StrCpy $nuwaxDataRoaming $APPDATA
  StrCpy $nuwaxDataLocal $LOCALAPPDATA
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

!macro customUnWelcomePage
  !include "${BUILD_RESOURCES_DIR}\windows-per-user-install.nsh"
  UninstPage custom un.nuwaxDataPageCreate un.nuwaxDataPageLeave
  Function un.nuwaxDataPageCreate
    ${if} ${isUpdated}
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "$(nuwaxUninstallTitle)" "$(nuwaxUninstallInfo)"
    nsDialogs::Create 1018
    Pop $nuwaxDataPage
    ${if} $nuwaxDataPage == error
      !insertmacro nuwaxStopStandaloneUninstall "Unable to show uninstall data options. No files were removed."
    ${endif}
    ${NSD_CreateLabel} 0 0 100% 35u "$(nuwaxUninstallInfo)$\r$\n$INSTDIR"
    Pop $R0
    ${NSD_CreateCheckbox} 0 45u 100% 25u "$(nuwaxDeleteDataLabel)"
    Pop $nuwaxDeleteDataCheckbox
    ${NSD_SetState} $nuwaxDeleteDataCheckbox $nuwaxDeleteLocalData
    ${NSD_CreateLabel} 0 80u 100% 65u "$(nuwaxDeleteDataScope)$\r$\n$nuwaxDataProfile\.${APP_PACKAGE_NAME}$\r$\n$nuwaxDataRoaming\${PRODUCT_FILENAME}$\r$\n$nuwaxDataLocal\${APP_PACKAGE_NAME}-updater"
    Pop $R0
    nsDialogs::Show
  FunctionEnd
  Function un.nuwaxDataPageLeave
    ${NSD_GetState} $nuwaxDeleteDataCheckbox $nuwaxDeleteLocalData
  FunctionEnd
!macroend

!macro nuwaxExtractUninstallInventory
  !ifndef NUWAX_UNINSTALL_MANIFEST
    !ifdef APP_64
      !ifdef APP_ARM64
        !error "Nuwax uninstall inventories require separate architecture installers."
      !endif
      !ifdef APP_32
        !error "Nuwax uninstall inventories require separate architecture installers."
      !endif
      !define NUWAX_UNINSTALL_MANIFEST "${PROJECT_DIR}\dist\installer-uninstall\payload-x64.json"
    !else
      !ifdef APP_ARM64
        !define NUWAX_UNINSTALL_MANIFEST "${PROJECT_DIR}\dist\installer-uninstall\payload-arm64.json"
      !else
        !define NUWAX_UNINSTALL_MANIFEST "${PROJECT_DIR}\dist\installer-uninstall\payload-ia32.json"
      !endif
    !endif
  !endif
  File /oname=$PLUGINSDIR\uninstall-payload.json "${NUWAX_UNINSTALL_MANIFEST}"
!macroend

!macro nuwaxRemoveOwnedFiles
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ${ifNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
    !insertmacro nuwaxStopStandaloneUninstall "卸载程序缺失，卸载已停止，原安装文件和卸载登记未删除。"
  ${endif}
  File /oname=$PLUGINSDIR\uninstall-data.ps1 "${BUILD_RESOURCES_DIR}\uninstall-data.ps1"
  !insertmacro nuwaxExtractUninstallInventory
  StrCpy $R3 ""
  ${if} $nuwaxDeleteLocalData == 1
    StrCpy $R3 "-DeleteLocalData"
  ${endif}
  SetShellVarContext current
  ; The inventory pass runs in a hidden PowerShell process; explain the wait.
  DetailPrint "正在检查并移除程序文件，请稍候；文件较多时需要数分钟..."
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\uninstall-data.ps1" -InstallDir "$INSTDIR" -ManifestPath "$PLUGINSDIR\uninstall-payload.json" -ProfileDir "$PROFILE" -RoamingDir "$APPDATA" -LocalDir "$LOCALAPPDATA" $R3`
  Pop $R0
  Pop $R1
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
  ${if} $R0 != 0
    !insertmacro nuwaxLogRecoveryFailure Uninstall
    !insertmacro nuwaxStopStandaloneUninstall "卸载未完成，程序文件可能被占用或路径不安全。个人文件与卸载入口已保留，请解除占用后重试。"
  ${endif}
  DetailPrint "$R1"
  ClearErrors
  ${if} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
    Delete "$INSTDIR\${UNINSTALL_FILENAME}"
    ${if} ${Errors}
      !insertmacro nuwaxStopStandaloneUninstall "无法移除卸载程序，卸载入口已保留，请重试。"
    ${endif}
  ${endif}
  ; Only an empty application directory is removed. Unknown files stay at
  ; their original paths even when the app-managed data checkbox was checked.
  RMDir "$INSTDIR"
  ClearErrors
!macroend
