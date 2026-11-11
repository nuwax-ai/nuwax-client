# Agent Desktop 1.2.0 随包许可清单

固定上游源码为 `2b0a7334fc111730454b726e6800aa41cdafc093`，许可为 Apache-2.0。该许可允许商用、修改与闭源分发；分发时仍须保留 LICENSE、适用的归属/NOTICE，并说明修改，不提供 Vercel 商标或背书授权。依据：[上游许可证](https://github.com/vercel-labs/agent-desktop/blob/2b0a7334fc111730454b726e6800aa41cdafc093/LICENSE)、[Apache 2.0 正文](https://www.apache.org/licenses/LICENSE-2.0)。这是许可证与分发材料核对，不构成零侵权保证。

## 数据范围

- `inventory.json` 绑定上游版本、npm 归档完整性、源码 revision 和 Cargo.lock SHA256。
- 从实际 CLI 及平台 helper 的 normal/build 依赖闭包得到 141 个 crates.io 包；不包含测试、FFI SDK 或其他未随包的目标。Mac 两架构各 57 个，Windows x64 为 77 个，Linux 两架构各 115 个。
- 每个 crate 的原始归档均按 Cargo.lock 校验 SHA256；许可证与版权文本来自该精确归档。`accessibility-sys`、`uiautomation`、`uiautomation_derive` 归档未收录许可文件，补取其 `.cargo_vcs_info.json` 对应的固定上游提交，来源和文本 SHA256 均记录在清单中。
- 许可主要是 MIT、Apache-2.0、Zlib、0BSD、Unlicense。`unicode-ident` 还须同时遵守 Unicode-3.0，相关全文已保留。没有因为这组实际 crate 依赖要求公开 Nuwax 主程序源码。
- Rust 标准库发行归属也随包：上游 Mac/Linux 预编译资源按其固定工作流采用 1.89.0；Nuwax Windows 源码构建固定为 1.97.1。全文来自官方发行包的 `COPYRIGHT-library.html`，保留其中其他平台及第三方材料的完整说明；清单记录原 HTML 的 SHA256。

## 修改与界面

Windows 通过 `third-party/patches/agent-desktop-windows-no-focus.patch` 修改 UI Automation 隐式焦点行为；补丁在修改文件中明确标明 Nuwax 修改，页面显示“已修改”与具体说明。Mac/Linux 使用原生上游二进制，按平台显示未修改。

完整清单在包装阶段合并到 `resources/third-party/third-party-notices.json`，全文在 `licenses/`；客户端“开源信息”可搜索并展开说明、读取许可证全文。正式发布在签名前生成、签名后只读核验。既有 capture 源码归档只随包一份，不重复复制。

## 更新方式

在仓外检出上述精确 revision 并获取 Cargo.lock 的依赖后运行：

```sh
RUSTUP_TOOLCHAIN=1.97.1 cargo fetch --locked --manifest-path /path/to/upstream/Cargo.toml
RUSTUP_TOOLCHAIN=1.97.1 node scripts/generate-agent-desktop-notices.mjs --source /path/to/upstream
node --test scripts/agent-desktop-notices.test.mjs scripts/third-party-notices.test.mjs
```

生成器保留已核对的 Rust 标准库声明；调整编译器版本时，需要从对应官方发行包重新提取标准库许可并更新 `runtimes`，不能沿用旧版本声明。Windows 实际 `source.json.nativeBuild.toolchain` 与声明版本不匹配时，严格生成会失败。

更新任何许可文本后同步其 SHA256，并更新 `source-components.json` 中的清单 SHA256。打包过程只消费已审查、已提交的文本，不联网猜测许可证。版本、资源身份、未知许可或证据完整性不符时拒绝入包。
