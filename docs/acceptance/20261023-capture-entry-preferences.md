# 截图与录屏入口、偏好及 IM 回填

日期：2026-10-23。状态：实现和本地源码验证完成；IM 已合入并推送 main，PC Web 按用户授权合入 feat-2026.9.30；客户端本地提交，未发包，未做 Windows/Linux 安装包与真实业务会话验收。

## 实现

- 截图服务不再等待 FFmpeg 视频资源验证；同分辨率多屏复用采集请求，窗口缩略图并发准备，不额外缩放原生像素。尚无 Windows 真机耗时对比。
- 隐藏客户端窗口为持久化配置，默认关闭；结束时只恢复本会话实际隐藏的窗口。
- macOS 默认 Command+Shift+A 截图、Command+Shift+R 录屏；Windows/Linux 为 Ctrl+Shift+A/R。两组应用内快捷键可修改，拒绝保留命令和相互冲突，设置保存后原生菜单和自绘菜单同步。
- 应用菜单显示截图、MP4、GIF。交互入口 action 决定初始模式；浮层切换保留冻结帧和选区。入口使用相机、摄像机、GIF 胶片图标，标签为截图/录屏/GIF。
- IM 按钮及聚焦输入框的快捷键共用原生桥。截图/GIF 复用内联图片流程，视频进入待发送附件，均不自动发送。触发和读块期间校验原会话；离开原会话时复制剪贴板，不写入新会话。无 IM 焦点走宿主预览，可复制或保存。
- 受信 sender/frame 认领有 200ms 时限，授予后才允许页面开始，过期请求不能在宿主回退后再次启动采集。固定 screenshot/record API 语义保持；只有显式 interactive 开放类型切换。
- 独立 IM 已合并到远端 main `50134c2`；保留最新 main 的 NW-009 旧客户端/浏览器截图降级。PC Web 更新 IM gitlink 与 adapter.pin，并按新 main 重制适配补丁；原生回填实现由 IM main 提供，不在适配层重复维护。客户端前端 pin 随本批前端合并更新。

## 验证证据

- 客户端截图、设置、菜单测试 420/420；之后新增交互 IPC 权限用例，index.test.ts 24/24，服务/入口补充回归通过。另有 preload、特性注册、受信桥和语言回归 75/75。
- 合并最新 main 后，独立 IM 全量 2406/2406（零依赖 61、编译运行 2345），platform 模式生产构建通过。
- 合并最新 feat-2026.9.30 后，PC Web 微应用回归 118/118、会话全量回归 1186/1186；新 IM pin + 重制适配补丁 + qiankun overlay 的原生回填、旧桥兼容及 hooks 顺序回归 16/16。主站分层检查通过，97 项既有豁免不变。微应用构建/升级脚本回归 75/75；登记的两项微应用生产构建通过，资料库适配类型基线 72/72、零新增；PC Web 主包生产构建通过；提交钩子要求的上游两处测试文件 Promise 等价修正回归 4/4，lint/格式化/commit-msg 钩子通过。
- 隔离 Electron 真实 Chromium 输入回归通过：截图/MP4/GIF 切换保留选区、PNG 导出、标注编辑、窄屏布局、录制控制条、合成三屏。只使用合成画面，不等同物理多屏或真实录屏验收。
- main/renderer 构建、导入边界、check:pin、overlay 一致性、宿主桥快照及三层 diff 空白检查通过。
- TypeScript 全库存在当前基线错误；用内存文件覆盖对本批改动做前后对比，基线 245、当前 245、零新增。

## 保留的限制

此前旧 pin 适配副本全量 IM 测试中的 dev405Discipline 失败：该上游测试要求独立 IM 的 index.html 有既定最低长度；产品既有 qiankun overlay 替换为较短入口后不满足该断言。本批没有修改该入口或放宽测试；新 main 独立 IM 全量通过，新的适配产物构建及本批相关测试通过，未重新跑适配副本全部纪律测试。

Windows 启动实际耗时、三系统真实快捷键/输入焦点、真实截图与录屏回填、混合 DPI/Wayland、安装包验收仍待实机验证。没有据此宣称已发布或生产验收完成。

## 合并前质量自查

三问结论：可合并。

- 内聚：`overlay/crates/agent-electron-client/src/main/features/capture/captureService.ts:154` 统一控制采集忙状态、切换、取消和恢复；IM `nuwax-im-web/src/lib/nativeCapture.ts:17` 集中维护原会话校验、读块、复制回退和 finally 释放。新旧桥按增量能力选择一条路径，不重复采集。
- 分层：`overlay/crates/agent-electron-client/src/main/ipc/settingsHandlers.ts:21` 在主进程验证设置并发出菜单刷新事件；IM `nuwax-im-web/src/components/ChatWindow.tsx:3132` 只认领聚焦输入框的快捷键，桥传输由 lib 负责，图片/视频继续消费既有草稿入口。
- 维护：`overlay/crates/agent-electron-client/src/shared/features/capture/preferences.ts:1` 是默认键与解析规则的维护点；`overlay/crates/agent-electron-client/src/main/features/capture/shortcutRouting.ts:16` 校验 sender/frame 与时限。IM 主契约追加可选方法，适配层只维护 qiankun 差异，pin 与 gitlink 配对。

## 提交关系

- 独立 IM：`50134c2`，已合并并推送 `origin/main`。
- PC Web：`cddc1e941`，已合并并推送 `origin/feat-2026.9.30`，更新 IM pin；客户端源码 gitlink 跟随此合并提交。提交钩子对传入文件的格式和导入顺序调整一并保留。
- 商业实现保存在客户端 overlay，不提交同步副本到 nuwa-electron-shell 基座。
