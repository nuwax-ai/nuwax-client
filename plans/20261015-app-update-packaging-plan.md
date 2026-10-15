# app-update.yml 打包修复

问题：macOS 发布先以 `--dir` 构建签名应用，再公证和 `--prepackaged` 封装。builder 25.1.8 在 `--dir` 下没有 dmg/zip target，跳过本地升级配置；第二次封装也不再运行 afterPack。用户要求所有后续打包保留升级文件。

1. 统一商业 updater 配置：generic feed 来自 client.config.mjs，缓存固定为隔离的 nuwax-updater；使用 afterPack 在签名前写入并校验，覆盖 --dir。
2. stable / Beta / QA、本地 pack 与商业旧 dist 入口使用同一配置；公证续跑只验证，绝不修改已签名应用。
3. 上传前核验解包应用、macOS ZIP 和只读挂载的 DMG 内实际文件；文件缺失、损坏或身份错误即失败。
4. 增加缺失配置、错误 feed/cache、--dir 和归档验证测试，检查已安装 builder 的真实 hook 顺序；随 Win10 兼容修复出新 Beta。原本已缺文件的安装需完整包覆盖安装。
