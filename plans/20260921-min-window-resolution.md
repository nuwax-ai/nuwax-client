# 窗口最小分辨率支持（商业版 1200×720）

- 日期：2026-09-21 · 状态：已实施，全链验证通过（tsc 205≈基线本批零错误 / 商业门禁
  1450 passed 18 skipped / mac dev 真机探针 600×500→1200×720、1000×650→1200×720）
- 定案口径（会话内与用户确认）：
  - 最小窗口尺寸 **1200×720 DIP**（宽度硬底线 >768：前端 `MOBILE_BREAKPOINT=768` 纯 `innerWidth` 判定、resize 实时切换、无 desktop 豁免，穿越即整页切移动端布局）；
  - 最低支持屏幕 1280×720；默认窗口 1240×800 不动；
  - 依据：宽 1200 对齐前端多栏 html 地板（global.less / Chat 普通态），150% 网页缩放下 innerWidth=800 仍 >768；高 720 保顶栏避让+消息区+输入框可用。

## 落点（全 overlay 单仓，外层 nuwax-client；基座不动）

商业专属行为归 overlay（d4ab22b3 定案；基座 env 旋钮路线曾被否决 revert 384b5e88）。基座
`shared/constants.ts`（DEFAULT_WINDOW_MIN_* 800×600）变更频繁且承载品牌/端口/域种子，整文件
overlay 冻结漂移风险大，弃用；改走既有 boot 钩子先例（powerPolicy）：

| 文件（overlay/） | 改动 |
| --- | --- |
| main/ipc/nuwaxBridgeHandlers.ts | 导出 `NUWAX_MAIN_WINDOW_MIN_WIDTH/HEIGHT=1200/720` + `applyMainWindowMinSize`；`registerNuwaxBridgeHandlers` 挂 `app.on("browser-window-created")` 统一补设（钩子先于 createWindow 执行拿不到窗口实例；Electron 40 已移除 `getLastWebPreferences`，事件期无法按 webPreferences 分型，主窗口含 mac activate 重建/webview 弹窗/session 独立窗口一并抬到商业下限——弹窗承载同一前端同受 768 断点约束，session 窗基座 600×400 被有意覆盖）；`native:openWindow` 独立窗口构造参数加同款 minWidth/minHeight（事件之外的双保险） |
| main/ipc/nuwaxBridgeHandlers.minWindowSize.test.ts | 新增：事件接线 + 统一补设断言 + 销毁窗口静默 + openWindow 构造 min 断言 |

不受影响（有意）：社区版（基座 DEFAULT_WINDOW_MIN_* 800×600 未动）。

## 验证

1. `node scripts/sync-overlay.js` → tsc 总数 205≈基线、本批文件零错误 → `npx vitest run`
   （商业门禁 1450 passed | 18 skipped，含新增 5 用例，修复前后各跑一轮）。
2. dev 冒烟（mac 真机，base:dev 重启后 AppleScript System Events）：
   - 第一轮探针钳到 800×600（基座旧值）→ 定位：**browser-window-created 在构造参数
     应用之前触发**，同步 setMinimumSize 被构造参数盖回；修复 = 推迟 `setImmediate`
     再设（构造完成的下一轮事件循环）。
   - 修复后：设 600×500 → 实得 1200×720；设 1000×650 → 实得 1200×720。OS 级钳制生效。
3. dev 常驻树已按标准形态重拉（base:dev direct，nohup 日志 /tmp/nuwax-dev-electron.log）。

## 操作记录坑（复用价值）

- zsh 无引号变量**不分词**：`kill $PIDS`（pgrep 多行输出）整串被当一个 PID 报 illegal pid，
  批量清理必须 `pgrep -f "patter[n]" | xargs kill -9`（字符类技巧同时防自匹配）。
- AppleScript 变量名 `before`/`after` 是保留字，赋值报语法错误。

