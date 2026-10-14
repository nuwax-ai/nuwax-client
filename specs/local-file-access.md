# 规格：local-file-access

- 对应 intent：plans/20261012-local-file-access-intent.md
- 状态：实施方案已由用户接受

## 架构
新增 local-files 特性，复用独立的 _kit；主进程组合根注入当前域、登录态、本机 sandbox ID、真实 cwd 和配置端口。前端适配收敛在 features/client-shell。桥契约事实源为前端 hostBridge.ts，壳快照由脚本生成。

## 数据与路由
前端传 cId、sandboxId 与明确工作区/项目上下文；主进程绑定 owner 文档及登录代次。实际 cwd 优先，其次 workspacePath，再唯一历史目录命中，禁止设备 ID 推导用户目录。列表和搜索由主进程调用本机 file-server，明确 customTargetDir，不传云端 cookie/token；字节由 fs 提供。

## 协议
nuwax-local://<grant>/<relative-path>，GET/HEAD/单段 Range，标准 MIME、长度、206/416。授权绑定 owner、文档、代次、真实资源根；路径只解码一次，拒绝 NUL、编码分隔符及授权根越界。显式文件按存在即读，自动子资源不沿链接逃逸。仅当前业务 session 装 handler；启动前声明标准/secure/fetch/cors/stream 权限，不 bypassCSP，不启用 ServiceWorker。

协议归属校验接入唯一业务请求监听器。HTML 独立源和 sandbox，不暴露宿主桥；预览来源不得借业务 cookie 或跳转业务文档。日志隐藏 grant。release/导航/destroyed/会话结束/dispose 主动关闭流；不能只依赖 Electron Request.signal。

## 保存与导出
保存对话框选择目标后，临时文件复制/打包成功再替换目标。完整 ZIP 包括隐藏项、硬链文件、空目录，软链保存为条目，排除输出和临时文件，不设 100MiB 上限；取消/错误删除残留，磁盘权限错误直接反馈。

## 降级与异常
旧桥、非本机、上下文不能可靠解析时走原 API。已明确本机后文件缺失、权限失败、取消和过期句柄直接失败。列搜不可把 file-server 拒连当空目录，不另起注册/服务链。

## 测试
覆盖本机/远端路由、真实 cwd/历史目录、可信文档与代次、跨 owner、GET/HEAD/Range、路径和链接、release/流关闭、保存取消、完整 ZIP。前端覆盖所有文件入口及相对资源、OpenUI、路径点击。社区测试只在隔离副本。Mac/Windows 实际 Electron 单独验收。

## 已否决路线
不短路业务 gateway，不让 webview 直连 file-server，不以全文件 Blob 替代流式媒体，不复用当前过滤/100MiB ZIP 接口。
