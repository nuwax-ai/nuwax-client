# Release 修复回灌 Alpha

## 范围与顺序

- 将客户端 `release/v3.1.0` 的修复历史合入 `alpha/v3.1.0`，保留 Alpha 的 DSH、主题、Android 与 Agent Desktop 实机修复。
- Alpha 出包等待当前 Beta 发布完成；之后按现有 Dev/Alpha 版本序列发布，再在 Mac DBG 与 Windows DBG 验收真实安装包和完整会话任务。
- 本次合入先固定 Release 提交 `4d5a0c39af6d67c74c9cad67f93c1d7e297b3159`；发 Alpha 前再核对该分支是否新增需同步的修复。

## 冲突与前端来源

- Agent Desktop 在两条分支分别加入：重复添加冲突保留 Alpha 上已完成的投递语义、重复撤销与 Windows 不抢焦点修复。
- `.gitmodules` 继续声明前端消费线 `alpha/v3.1.0`；资源准备保留 DSH 独立缓存键，不改变 CUA/capture 配方。
- 原 Alpha 客户端 pin `478947c81e549df6d559269fc42e3162efde8487` 是 Alpha.4 前端 PR 的特性分支提交，未包含当时 Alpha 主线已有的 Release 修复；对应产物戳还停在 `f614f7700`。
- 更新到该前端 PR 的合并提交 `911755868448124644bb9d5cde4037300a1488ce`。已用 Git 祖先关系核对：它同时包含旧 Alpha pin 与 Release 前端 pin `84f496bdfc389e9cfb6a6643781f21b8c4cfedd1`。固定历史提交，保留 Alpha 体验功能，并避免额外追入之后的登录页改动。
- 重新构建并提交匹配此源码的产物，双 pin 同批提交；不重写仍被引用的产物历史。前端差异不包含终端持久化、跨会话保活或多终端实现。

## 验证

- 检查宿主桥契约、共享主题快照、主进程类型、商业与脚本门禁及前端源代码门禁。
- 通过集成 PR 跑 CI，绿后合入 Alpha；再沿固定 tag 发布完整五平台安装包。
- 真机以新 Alpha 包内资源与进程为准，完整验证观察、中文填写、点击、后置观察、暂停/停止与引擎切换；源码与独立原生探针结果不替代安装包验收。
