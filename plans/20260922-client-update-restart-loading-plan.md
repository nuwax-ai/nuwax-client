# 重启更新 loading 遮罩（更新徽标 downloaded 态点击无反馈）

- 日期：2026-09-22 · 状态：实施中
- 现象（用户 QA v1.0.25→v1.0.26 实测）：点「重启更新」没反应——按钮 spinner 只在
  hover 卡存续期间可见、鼠标移开即无任何反馈；壳侧 `installUpdate()` 要先 await
  清理链（树杀引擎，上限 10s）再 `quitAndInstall`，期间 UI 全静默，数秒~数十秒后
  应用「自己」退出安装，被误读为按钮失效。

## 根因

- 壳 `autoUpdater.installUpdate`：markQuitting → await cleanup（≤10s）→ quitAndInstall，
  IPC promise 清理完才 resolve，退出前无任何用户可见状态。
- 前端 `ClientVersionBadge`：busy 只作用于 hover 卡按钮/徽标小 spinner，且
  `install()` 丢弃宿主回包，dev/MSI 失败（success:false）也静默复位。

## 改法（前端单侧，壳不动）

| 文件（nuwax 前端仓） | 改动 |
| --- | --- |
| utils/hostBridge/index.ts | `updater.install` 改为返回宿主原始回包 `{success,error} \| null`（对齐 download 同款） |
| features/client-shell/clientUpdateService.ts | `install()` 透传 `{success, error}`，不再吞结果 |
| features/client-shell/ClientVersionBadge.tsx | 点击「重启更新」→ 全屏 Modal 遮罩（Spin + 「正在重启更新」+ 提示语，zIndex 3000、不可关）；成功 → 遮罩保留到进程退出（防闪回正常 UI）；失败 → 收遮罩、浮出错误 + 「知道了」关闭 |
| locales/i18n/5 语言文件 | 新增 4 键：`installing` / `installingHint` / `installFailed` / `close` |
| 两个测试文件 | install mock 回包改对象；补遮罩出现/成功保留/失败浮出用例 |

## 交付链

worktree 基于 origin/feat-dong.0930 尖端 19061ed49（勿碰主检出，codex bug2537 WIP 在途）→
fix + build(dist) 两提交推 `HEAD:feat-dong.0930`（dist 跟平源码尖重建，dist 在 gitignore 须
add -f --no-verify）→ 外层 `git update-index --cacheinfo` bump nuwax pin（不 checkout 主检出
子模块）→ 提交外层 release/v1.0.x。

## 验证

`npx vitest run src/features/client-shell src/utils`（worktree 内）+ tsc 基线核对；
打包版实测留 QA（点击→遮罩即现→应用退出安装）。
