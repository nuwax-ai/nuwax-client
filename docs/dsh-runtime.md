# DS-Bot / DSH 插件运行宿主

客户端设置中的「DS-Bot」先选择并授权 Nuwax 模型，再打开独立窗口。关闭窗口保留后台运行；「停止」关闭当前账号的自动恢复。应用退出、账号失效或换域会先撤销本轮模型及浏览器权限，再结束所属进程。原有 Nuwax 会话引擎继续运行。

运行包位于 `nuwa-electron-shell/crates/dsh-runtime`，固定 DS-Bot 0.2.7、DSH 0.2.1-rc.5 和完整 npm lock。`host.mjs` 使用公开 `runProfile` 组合 Base、Web App、Voice、Nuwax Provider 和原 DS-Bot Bundle；用户插件由原生 Plugin Manager 安装和管理。核心 Bundle 从安装包优先解析，DS-Bot / DSH 自更新关闭。第三方插件按受信本地代码运行，进程隔离不提供系统沙箱。

宿主特性 `dsh-runtime` 仅向客户端设置页提供管理 IPC。插件窗口使用独立持久会话分区和专用 preload，不加载商业桥。数据目录是产品档案下的 `dsh-runtime/<sha256(服务域+账号)>`，不读取个人 DSH 或其他产品数据。Bot 浏览器分区进一步包含 Bot ID，外部页不获得插件 preload。文档代次、IPC 所有者、浏览器租约和自动化令牌随生命周期失效，已有 CDP 连接在销毁时结束。

平台模型目录、授权和 Key 操作由主进程的 `FeaturePlatform` 完成。专用 Key 只在主进程内存中使用，设置仅保存 Key ID 和模型 ID。插件 Provider 取得代次绑定的回环令牌，转发 OpenAI / Anthropic 原生请求及 SSE；请求模型必须在授权范围内，登出立即撤权。上游协议、工具、图像、推理及用量由固定版本 pi-ai 适配器承载；不按名称推断协议或思考参数。不支持外部调用、文本会话或工具调用的模型在授权页注明原因。真实模型目录可能包含配置或额度失效的模型，仍需按通路联调。

Office 使用上游锁定的 Node 24.21.0、Python 3.12.14、wheel 哈希和 Office 技能，LibreOffice Kit 固定 0.1.5。语音使用原语音 Bundle 的 SenseVoice / Silero 本地模型，原生库随包，权重由插件首次明确准备时下载并验证。权限仅授予插件窗口的顶层音频请求，macOS 包包含麦克风用途及 entitlement；播报沿用系统 speech synthesis。

开发准备在仓库根执行 `npm run prepare:dsh`；完整 setup / dev / pack 会准备此资源。`node scripts/check-dsh-resources.mjs` 检查当前平台的锁版、语音原生库和 Office 引擎。资源来源与修改记录在 `vendor/UPSTREAM.json`；完整第三方目录、许可证和 Office 的聚合许可证随资源保留。macOS 的 afterPack 钩子在应用封装签名前签署嵌套原生库及解释器。

定向验证：

```sh
npm --prefix nuwa-electron-shell/crates/dsh-runtime test
npm --prefix nuwa-electron-shell/crates/dsh-runtime run smoke
node nuwa-electron-shell/crates/dsh-runtime/test/plugin-smoke.mjs
# 以下命令的工作目录是 crates/dsh-runtime
node test/office-smoke.mjs
node test/voice-smoke.mjs
# Electron 源码级窗口 / 浏览器验证的工作目录是 agent-electron-client
node node_modules/electron/cli.js tests/dsh-desktop-smoke.mjs
```

`smoke` 使用真实 DSH 与 DS-Bot、固定响应的测试模型，验证工具续轮、Bot 消息、记忆、定时任务和重启恢复。`plugin-smoke` 验证额外插件安装、Host / Client 发现、启停及移除。Office 实际创建和编辑三种文档，完成 PDF 转换、图片渲染和公式重算。voice 验证固定哈希模型的准备、取消、重试及本地转写；系统生成的音频不能替代真实麦克风验收。Electron 用隔离测试档案验证原 DS-Bot Client 渲染、Cookie 隔离和 CDP 自动化。

`test/platform-runtime.mjs` / `platform-contract.mjs` 是明确触发的测试环境联调入口，接收已经登录的调用通道，创建限模型的临时 Key 并在 finally 删除。凭据不进入文件或证据。平台真实工具续轮、权限、用量和账单必须独立验收；本地测试、doctor 和进程启动不能替代安装包和跨平台验收。

CI 增加五平台 DSH 资源与原生 Office 验证。安装包沿用独立 package-validation 流程、已有版本和四次启动限制，不创建发布，不变更更新指针。本特性独立分支交付，未自动合入发布线。
