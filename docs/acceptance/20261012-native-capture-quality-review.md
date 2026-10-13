# 原生截图与录屏提交前质量自查

日期：2026-10-12。依据 `.agents/skills/pre-commit-quality-review/SKILL.md` 与根 `REVIEW.md`；范围为本轮截图/录屏、特性接缝、资源及 IM 接入文档。结论：技术代码可提交并开展开发客户端提测；正式安装包受声明缺口阻塞，不作为发布批准。

| 三问 | 结论与证据 |
| --- | --- |
| 功能逻辑内聚 | 状态/单会话在 `captureService.ts:109`；结果、页面所有权与代次在 `capture/index.ts:114`；录制落盘在 `recordingSink.ts:31`；物理像素/DIP、控件定位集中在 `windowGeometry.ts` 与 `shared/features/capture/windowPlacement.ts`。IM 回填控制器只处理业务附件目标，客户端不持有 IM 会话 ID。 |
| 分层正确 | 外层 overlay 为商业实现唯一落点，基座仅有同步文件；接缝经 `main/features/index.ts`、`preload/features/index.ts` 与 renderer 特性入口接入。公开类型来自前端契约，主进程文件路径不穿桥。`check-feature-boundaries`、`check:pin`、前端 `lint:arch` 通过。 |
| 便于维护 | 请求参数有严格解析；selector/recorder 校验精确 WebContents、主 frame 与生成 URL；0600 文件、0700 目录、4 MiB 结果读块、128 MiB 录制待写内存上限；订阅/窗口/文件均有成对清理。图标保留本地化 tooltip/aria-label；独立 IM 示例及交接文档含取消、失效、超限与回填规则。 |

五遍走查重点：信任校验延用宿主当前顶层 document；host 与业务 IPC 分离；Promise 完成结果只归原调用方；登录/换域/全页导航与显示器移除防止迟到结果；二进制锁定来源/SHA256/许可证；测试包含实际 DOM/IPC 与编码/解码证据，不以 mock 代替安装包验收。

验证数字与提测范围见 [提测单](20261012-native-capture-qa.md)。社区检查在隔离副本执行，补齐测试需要的既有 MCP 编译资源后通过；前端隔离副本生成 Umi 类型后通过，未修改基座/前端业务代码来消除存量问题。

需后续处理：13 项旧组件声明/许可证缺口、Windows/真实安装包、HDR、全屏工具条排除、实际 IM 菜单上传发送。质量门没有降低、未强推、未发布、未把无关 IM/资料库/产物 pin 纳入提交。
