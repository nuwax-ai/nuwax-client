# 女娲Nuwax 1.0.21（beta）

修复部分 Windows 机器上 Codex 引擎会话报「Failed to create engine: failed to initialize sqlite state runtime」的问题。

## 变更

### 引擎

- Codex 引擎状态目录隔离：Windows 上 Codex 引擎此前在用户真实 `~/.codex` 下初始化 SQLite 状态库，本机已有的损坏状态库、与其他 Codex 进程并发的文件锁都会直接导致引擎启动失败（`failed to initialize sqlite state runtime`，进程退出码 1）。现通过 `CODEX_HOME`/`CODEX_SQLITE_HOME` 将 Codex 配置与全部 SQLite 数据库指向客户端管理的按项目隔离目录，不再读写用户本机 `~/.codex`，与本机其他 Codex 安装互不干扰。

## 升级须知

- 含 1.0.20 全部变更及此前 beta 版全部变更。
- 数据目录 `~/.nuwax`、更新通道不变，存量 beta 客户端可直接在线更新。
- Windows beta 包为未签名构建（正式版手签）；SmartScreen 提示「未知发布者」选「仍要运行」。mac 双架构自动签名+公证。
