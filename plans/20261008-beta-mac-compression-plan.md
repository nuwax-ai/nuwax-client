# Beta macOS 压缩配置对齐

v3.0.11-beta.4 的 Windows/Linux 构建已成功，Mac 仍在打包。检查固定基座的 run-build-electron.js，构建命令显式使用 compression=maximum；stable workflow 通过 ELECTRON_BUILDER_COMPRESSION_LEVEL=1 覆盖，beta 缺少对应配置。实际 SDK 25.1.8 的 ZIP/7z 参数生成器支持该覆盖。

- beta 的所有 macOS 构建使用与 stable 相同的压缩级别 1，保留 DMG/ZIP、完整资源、签名、公证和来源验证。
- 执行实际 workflow 的构建命令夹具，核对 Mac 两架构与非 Mac 分支，并调用固定 SDK 验证有效 ZIP/7z 压缩参数。
- actionlint 与脚本检查通过后提交；GitHub 三轨门禁通过后合入发布线。
- v3.0.11-beta.4 继续用已冻结的 21f4500f 构建，不取消或移动 tag。新配置从下一个 tag 生效；压缩级别下降会增加 Mac 包体，沿用 stable 已验证的取舍。
- 等本轮五平台和镜像同步完成，将 Windows 修复证据、Mac 实际耗时及 S3 校验性能补入发布验收文档；真实客户端验证由用户进行。

本地验证：17 项 beta/QA workflow 测试全部通过，无 skip；四 workflow 的 actionlint 1.7.12 与 diff 检查通过。隔离工作区用 NUWAX_TEST_BUILDER_CLIENT_DIR 只读复用已安装的 25.1.8，直接调用 computeZipCompressArgs/compute7zCompressArgs，验证 maximum 默认 level 9、执行实际 workflow 后 Mac 两架构有效 level 1、Windows/Linux 不注入该覆盖。

三问：内聚——压缩覆盖仅在既有 Mac 构建分支；分层——沿用 builder 官方环境配置，不改客户端、来源或更新协议；可维护——真实命令与固定 SDK 回归覆盖有效参数，签名/公证步骤和三个 gitlink 未变。合并仍等待 GitHub 三轨门禁。
