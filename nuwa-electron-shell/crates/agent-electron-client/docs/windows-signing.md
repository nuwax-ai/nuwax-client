# Windows 签名实现与排障

当前产品的发布操作以仓库根 [Windows 签名指南](../../../../docs/sign-windows.md)和[发布规范](../../../../docs/release-channels.md)为准。本目录脚本属于同一仓库，不需要另行检出或更新其他基座项目。

## 标准流程

从仓库根运行 `npm run release -- --version X.Y.Z --stage sign`。发布入口核对目标 tag、五平台来源和 unsigned 安装包哈希，再把本仓已提交的签名工具交给 win-pc。SimplySign 手机认证仍由人工完成。

安装包验收通过后，再执行 `npm run release -- --tag vX.Y.Z --stage sync`。Beta Windows 包使用 CI 原产 unsigned EXE，不经过人工签名步骤。

## 实现位置

- `scripts/build/sign-release-win-v2.sh`：当前签名主入口，负责下载/缓存核验、签名、验签与上传。
- `scripts/build/sign-win.js`：调用签名工具并处理证书、时间戳等参数。
- `scripts/build/sign-release-win.sh`：保留的低层回退实现，不作为日常发布入口。

这些路径相对于客户端 crate。仓库根的 `sign:win`、`verify:sign:win` 转发入口会补齐当前产品的仓库、资产前缀和目标身份，避免依赖低层脚本的历史缺省值。

## Release 资产名与版本不匹配

核对发布 tag、`build-manifest-windows-x64.json`、unsigned 资产名与来源 SHA。使用根目录发布入口提供明确身份，不根据脚本内历史产品默认名推断当前资产。

## GitHub CLI 找不到或未认证

在 win-pc 的实际 Git Bash 签名会话检查 `gh --version` 与认证状态。桌面、SSH 和 Git Bash 的 PATH 可能不同；签名入口会按本仓配置传入 GitHub CLI 路径。修复该会话的可执行文件路径后续跑同一 tag，不重新生成安装包。

## SimplySign 与时间戳失败

确认签名机的 SimplySign Desktop 状态、手机认证及签名工具/证书环境。保留原 tag、来源哈希与下载缓存，恢复环境后续跑失败阶段，不移动 tag、不以另一个未核对来源的 EXE 替代。
