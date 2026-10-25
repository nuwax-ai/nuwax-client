# 本机文件直访桥

候选状态（2026-10-25）：`codex/local-files-3023-readiness` 恢复本机文件能力，默认开启；`features.local-files.enabled=false` 在重启后关闭。仅商业版 Nuwax 生效，仍要求受信业务文档、登录及本机身份。当前发布线/已安装包是否包含本改动须按实际提交核对，不能将此候选说明当作已上线。安装包与真实账户验收尚未完成。

Nuwax 客户端 `NuwaClawBridge.localFiles` 可选扩展，候选 `apiVersion=2`，增加 `writable` 与可选 `updateFiles`。API v1 继续提供原读能力；旧壳只有 pickDirectory，必须先探测 getCapabilities。桥只接受当前受信顶层文档、有效登录、本机注册身份及当前登录代次。

## 调用

```ts
const api = window.NuwaClawBridge?.localFiles;
if (!api?.getCapabilities) return;
const caps = await api.getCapabilities();
if (!caps.available || caps.sandboxId !== selectedSandboxId) return;
const resolved = await api.resolveContext({ cId, sandboxId: selectedSandboxId, workspacePath });
if (!resolved.success) return;
const { contextId } = resolved.data;
const target = { contextId, path: 'docs/report.html' };
const preview = await api.preparePreview(target);
if (preview.success) {
  // url 可用于 fetch、img、audio、video、sandboxed iframe；baseUrl 为授权资源根。
  showPreview(preview.data.url);
  // 关闭、切源、卸载时释放；不要把 url 写入会话、日志或 localStorage。
  await api.releasePreview(preview.data.grantId);
}
await api.releaseContext(contextId);
```

文件面板通过 `apiUpdateStaticFile` 自动分流；直接调用宿主时先判断 `caps.apiVersion >= 2 && caps.writable && api.updateFiles`，然后如 `api.updateFiles(contextId, [{ name: 'docs/note.txt', operation: 'modify', contents: '新内容' }])`。`delete` 将条目交给系统回收站，不接收永久删除标志。

统一结果 `success:true,data` / `success:false,code,error?`。代码包括 untrusted/unavailable/not-local/invalid-argument/context-unresolved/expired/not-found/already-exists/conflict/permission-denied/file-service-unavailable/canceled/failed。旧桥、非本机或目录无法确定才选择原 API；已经确定本机的文件错误、取消、过期直接显示。本机只读桥缺写能力时不转发云端写请求。

## 能力与数据

- resolveContext 输入 cId、sandboxId，以及可选 workspacePath/projectId/serviceType/userId。userId 为业务会话用户 ID，不能传设备注册 ID。目录由主进程按 session.cwd、明确 workspacePath、唯一历史目录解析。
- listFiles/searchFiles 从主进程读取配置端口的本机 file-server，使用同一 customTargetDir，保留原列表/搜索响应；不传平台 cookie/token。
- stat/preparePreview/openPath/revealInFolder/saveFile 接受 `{contextId,path}`。相对 path 在工作区内；明确的本机绝对文件遵循“存在即读”。Windows 盘符/UNC 只在 Windows 宿主按本机语义解析。
- updateFiles(contextId, changes) 接入现有文件面板的 create/modify/rename/delete。写路径限定真实工作区，不能操作工作区本身或经目录链接越界；文本保存用临时文件替换并保留权限，新建与重命名拒绝已有目标。删除使用系统回收站，失败直接反馈，保留现有界面确认。
- 写批次在主进程串行执行，逐项原子保存，不承诺跨文件事务。每批最多 1,000 项、文本总量 16MiB；修改只支持普通文本文件，符号链接代码视图保持只读。上传、ZIP 导入和 Git 操作仍走既有接口。
- preparePreview 返回 `{grantId,url,baseUrl,mime,bytes}`。`nuwax-local://<随机grant>/<相对资源路径>` 的自动子资源只能在其真实授权根内，不沿软链接逃出。
- saveFile/exportWorkspace 可传 operationId，用 cancel(operationId) 中断。保存对话框取消返回 `success:true,data:{canceled:true}`。输出先写临时文件，完整成功后替换目标。
- exportWorkspace 是完整文件系统工作区导出：含隐藏项、硬链文件、空目录，软链仅保存为链接条目，无100MiB上限；不打包本次输出或临时文件，不读取FIFO/设备/socket。

## 预览隔离与生命周期

媒体 GET/HEAD/单段 Range 流式读取，没有50MB预览限制；文本/Office解析仍保留原预算。HTML iframe 使用 `allow-scripts allow-same-origin`，不得取得宿主桥、业务 cookie、网关授权或导航业务页面。主进程单一请求门验证 owner，CORS只允许对应业务文档源；CSP不绕过。

feature在第一个业务 renderer 导航前注册 protocol handler；首次读取才注册在Electron40会导致已运行renderer不能识别scheme。协议权限必须 pre-ready 声明，关闭特性时仅留下惰性声明，不装IPC/handler，不发放grant。

预览来源按所属 WebContents 与稳定的 frameTreeNodeId 保留，文档地址或 renderer 进程变化不会清除该约束。唯一请求门与凭据过滤器共用这份来源；导航事件在加载前拒绝跳出当前授权的文档（包括 data/blob）。释放 grant 后保留来源限制，顶层文档替换或窗口销毁才清理。

ZIP 在遍历前解析工作区与目标父目录的真实路径，保存目录经过符号链接或 Windows junction 时仍排除本次目标和临时文件。最终目标的 basename 保留，替换目标链接本身而非其指向的文件。

前端搜索遇到本机访问错误时显示错误并允许重试；同一会话切换电脑或本机上下文代次时清空旧结果、丢弃迟到响应。明确选中的本机符号链接可按实际文件预览，代码视图保持只读，自动相对资源仍受授权根限制。

登出/换域/旧文档/关闭预览撤销授权并主动关闭所有流；不能依赖 Electron Request.signal 接收浏览器取消。相同文档内的history/hash变更不等同完整document navigation。

前端统一消费 `features/client-shell/localFileService` 与页面上下文Hook，业务组件不另写宿主身份/目录推导链。

## 验证入口

- `node scripts/acceptance/local-files-electron.mjs`：真实 Electron runtime smoke，隔离 profile、本机 metadata fixture、读写 IPC、H.264 播放/seek 和完整 ZIP。需要已安装的 ffmpeg（可用 `NUWAX_QA_FFMPEG` 指定路径）；Electron 可用 `NUWAX_QA_ELECTRON` 指定。保存、系统打开、回收站适配器均使用夹具，报告写 `.cache/acceptance/local-files-electron.json`，不代表系统回收站或实包验收。
- Windows 无仓库检出时：开发机运行 `--bundle-only <dir>`，将目录及 `scripts/acceptance/local-files-electron-windows.ps1` 复制到 Windows，用 `-BundleDir <dir> -ElectronExe <electron.exe>` 执行；报告与日志位于其 WorkDir。
- `npm run test:commercial` / 独立社区副本 `npm run base:test`；`npm run check:pin`、`npm run host-bridge:check`、feature boundaries。
- 本工作分支的开发/打包使用 `--frontend source`。真实账户、签名安装包与 Windows 真机验收须分别记录。
