# stable v3.0.6 打包提速计划

## 目标

在保持来源、签名、公证、更新兼容性和安装包验收门禁的前提下，减少正式版五平台构建时长。基线为 v3.0.3：macOS x64 job 约 1 小时 42 分，`Build Electron app` 约 80 分钟，其中 DMG blockmap 到 ZIP blockmap 约 55 分钟；前端在每个平台重复构建约 5–8 分钟。

## 实施

1. 从 tag 的 `nuwax-dist` gitlink 装载前端产物，校验 checkout 提交、纯净状态、`version.json` 与 `nuwax` 源码 pin；保持打包目录结构不变。正式版五平台的前端目录 SHA256 必须一致。beta 暂保留源码构建。
2. 仅在正式版 macOS 构建步骤设置 electron-builder 25.1.8 ZIP 压缩级别为 1，继续产出 DMG 与 ZIP 并完成签名、公证。
3. 五平台 CI 成功后单独签名 Windows。用 v3.0.6 Draft 的五平台清单及签名安装包验证来源、哈希、安装后资料库/女娲智联点击及刷新、macOS/Windows 更新兼容性。记录与 v3.0.3/v3.0.5 的 job、ZIP 阶段和包体大小对比。
4. 验收通过后单独同步 stable；失败时保持 Draft，源码修复另升版本，不移动 v3.0.6 tag。

## 质量门

`npm run test:scripts`；真实双 pin 的 `prepare-nuwax-dist --pinned` 演练；workflow YAML 解析；v3.0.6 CI 三项源码门禁、五平台打包和来源清单均成功。最终以真实安装包验收和镜像指针核验为发布结论。
