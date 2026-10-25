# 规格：本机文件面板读写

- 对应 intent：`plans/20261025-local-file-management-intent.md`
- 继承 `local-file-access.md` 的文档、会话、sandbox、协议和授权边界；本规格取代其“写操作保持原接口”的本机行为。

## 接入与契约

前端继续在 `features/client-shell/localFileService` 判定本机，`apiUpdateStaticFile` 统一分流，页面不复制宿主判断。前端 `hostBridge.ts` 是类型事实源，经脚本生成商业 overlay 快照。

localFiles API v2 增加可选 `updateFiles(contextId, changes)` 和 `writable` 能力。变更项为现有文件操作的最小子集：name、operation(create/modify/rename/delete)、contents、isDir、renameFrom。主进程验证全部参数后，串行执行同一 runtime 的变更；每项文件保存原子提交，批次不承诺跨文件事务。旧本机只读桥不能因缺写能力而把写请求转到云端。

## 文件语义

- 新建文件/目录必须不存在；不递归创建未显示的父目录。
- 编辑仅文本普通文件，保留权限；临时文件写完并再次校验文档与文件身份/修改时间后替换，取消和失败清临时文件。
- 重命名保留文件内容、目录和链接本身，不覆盖目标；同批父目录重命名不展开成逐个子项修改。
- 删除调用 Electron `shell.trashItem`，现有界面确认保留；回收站错误直接失败，不以 `rm` 兜底。
- 所有写路径在真实工作区内，拒绝工作区根、相对越界和目录软链越界；编辑不写入软链指向的其他文件。读取、显式系统打开沿用原规格。
- 登出/导航/文档失效会使排队请求过期；已交给系统回收站的原生操作无法撤销，不承诺事务回滚。

## 验证

注册三态、真实临时文件增改/重命名/删除、原文件保留、冲突、路径/链接边界、跨 owner、过期队列、前端本机/远端/旧桥分流与失败不回云端；修复并运行隔离 Electron 的协议/桥集成脚本。商业/社区质量门、宿主类型快照和特性边界分开检查。安装包及系统回收站真实 UI 仍需两平台验收。
