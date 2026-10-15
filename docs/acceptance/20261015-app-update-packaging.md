# app-update.yml 打包修复验收

## 结论

根因在 builder 25.1.8 的 PublishManager：macOS `--dir` 没有 dmg/zip target，内置 afterPack 不写升级配置；后续 `--prepackaged` 又跳过 doPack/afterPack。本机 `/Applications/Nuwax.app/Contents/Resources/app-update.yml` 也确实不存在。

商业打包现在统一配置 generic provider（feed 来自 client.config.mjs）和 `nuwax-updater` 缓存。自有 afterPack 在 builder 的内置 handler 后、签名前写入规范文件，`--dir` 同样执行。stable、Beta、QA、本地 pack 和商业旧 dist 均接入。公证/封装续跑只验证，禁止补写已签名应用。上传前检查解包资源、macOS ZIP 实际字节及只读挂载的 DMG，缺失或内容不符即阻止发布。

已安装且缺文件的旧版不能靠重试自动更新恢复，需要使用新完整包覆盖安装；不修改 `/Applications` 下现有签名应用。

## 验证

- 最终相关 44 项脚本测试通过，包含商业旧 dist 入口与公证/封装前拒绝缺文件的保护。
- 全量脚本测试 353 项通过（补充上述两项测试前），无跳过。
- 商业质量门 3054 项通过、18 跳过；基座 worktree / origin/main 纯净检查通过。
- 真实 electron-builder 25.1.8 + Electron 40.8.2，以 `--dir` 等价 API 构建原生 arm64 应用，实际 Resources 内配置存在且字段正确。
- 使用系统 zip 创建真实归档、hdiutil 创建真实 DMG，统一校验脚本成功读取 ZIP 内文件并只读挂载 DMG 核验。
- 本地 fixture 为无签名构建；Developer ID 签名、公证和五平台最终包验收由新 Beta CI 执行。

## 三问自查

1. 内聚：配置格式、feed 校验、cache 不变量及签名前生成集中于 `overlay/crates/agent-electron-client/scripts/build/app-update-config.cjs`，所有入口复用；归档验证集中于 `scripts/prepare-release-updater.mjs`。
2. 分层：打包层保证文件存在；运行期 autoUpdater 和通道选择不改。公证步骤仅验证，不修补签名内容。
3. 维护：路径解析集中覆盖各平台/架构；缺失、损坏、错误 feed/cache、真实 builder hook 顺序和 DMG 失败清理均有测试，上传前验证实际文件而非仅检查配置声明。

待新 Beta CI 全部通过后交付；Win10 目标系统兼容性仍由原反馈人复测。
