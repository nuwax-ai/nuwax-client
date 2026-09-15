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

!macro customHeader
  Name "女娲Nuwax"
!macroend
