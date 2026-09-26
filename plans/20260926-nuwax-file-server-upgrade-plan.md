# nuwax-file-server 升级计划

## 目标

将客户端开发及打包使用的内置文件服务从 1.5.2 升级到当前 npm latest / Git main 的 1.5.3，并将原为 1.4.4 的 npm 兜底版本同步对齐。

## 实施

1. 保留现有商业功能 WIP；备份 sources 缓存仓的未跟踪 package-lock.json。
2. 更新 overlay 的 dependencyChecker.ts 中 installVersion、npmFallback 及注释，仅同步这一文件到基座工作树。
3. 执行 prepare:nuwax-file-server，重新安装、构建和复制 Git main（0cffa11）至 resources。源码与产物是忽略的本地缓存，不提交基座或调整 gitlink。
4. 核对源码版本、resources 版本和 commit 标记；运行现有依赖测试，以及随机端口/临时工作区下的真实上传、文件列表、ZIP 下载契约验收。
5. 检查 overlay 一致性、check:pin 与 diff 空白。现有已运行客户端/安装包需重启或重新打包才能使用新资源，不据此宣称安装包已验收。

## 验证结果

- `prepare:nuwax-file-server` 成功；sources 与 resources 均为 1.5.3，`resources/.commit-hash` 与源码 HEAD 均为 `0cffa11c7340b032a69121f60bff8194ebbd2d13`。
- 原 sources 未跟踪锁文件已备份到 `/var/folders/j7/83v2j_nd2ll9s4v4kf1j2dwc0000gn/T/nuwax-file-server-upgrade-backup-qk0oeeir/package-lock.json`。
- 独立 verifier 跑现有 `dependencies.test.ts`：35/35 通过。该测试覆盖依赖属性；版本与 fallback 由配置检查及源码/resources 版本断言确认。
- 现有 `file-server-contract.cjs` 通过：真实 multipart 上传、文件列表、ZIP 下载解压后字节一致（68 字节，SHA256 `4b10f25b022a4d92a04ced289a519f8ff16be1c8ae2dd23441e157c30993b88e`）。
- 临时扩展契约 smoke 通过：单层列表 `type=file,limit=1`、`type=dir,limit=1`、`type=file,limit=0`，同时检查 type/limit 回显、条目数与 isDir。
- overlay 检查 75 个文件一致；`check:pin` 通过；diff 空白检查通过。未调整 gitlink。
- 上游 `npm audit --omit=dev` 报告 5 项生产依赖告警（1 low、3 moderate、1 high），涉及 diff、js-yaml、node-cron、pm2、uuid；未执行可能破坏兼容性的 audit fix。
- 已运行客户端尚未重启，新安装包与 Windows 运行未验证。当前证据为本机源码/资源构建与独立临时服务契约验证。
