# Computer Use 控制层基准测试

用真实的 Nuwax Computer Use 守护进程，加上进程内运行的产品网关（`mcpGateway.ts`）和状态机（`taskController.ts`），由一个**固定规则的程序化 Agent** 执行任务。改造前后跑的是同一套动作，所以结果差异只来自控制层。

这套测试不调用大模型。它衡量的是控制层带来的打断和额外开销，不衡量模型本身的能力。

## 前提

- macOS，已安装 `/Applications/Nuwax Computer Use.app`（正式签名，已获得辅助功能和屏幕录制授权）。
- 安装了 Google Chrome。测试会另起一个独立的 Chrome 实例（临时用户目录 `/tmp/cu-bench/chrome-profile`，打开调试端口），**不会碰你自己在用的浏览器**。
- 已执行过 `npm run overlay:sync`（基座依赖里需要有 esbuild）。

## 运行

先生成与产品一致的策略文件，再经 LaunchServices 拉起守护进程（授权归 Nuwax Computer Use），最后跑任务。Nuwax Computer Use 不在 `/Applications` 时，用环境变量 `CU_HELPER_APP` 指定它的路径。

```bash
node scripts/computer-use/bench/run.mjs --policy-out /tmp/cu-bench/policy.yaml
```

```bash
node scripts/computer-use/bench/daemon.cjs start /tmp/cu-bench/policy.yaml
```

```bash
node scripts/computer-use/bench/run.mjs --label after
```

只跑部分任务时加 `--tasks N1,W1`。结果写入 `/tmp/cu-bench/results-<label>-<时间>.json`。用完后停掉守护进程：

```bash
node scripts/computer-use/bench/daemon.cjs stop
```

## 任务

| # | 内容 | 考察点 |
|---|---|---|
| N1 | 点击计算器按钮算 6×7，读显示值验证 | 连续写操作和"先观察"门禁 |
| N2 | 在 Chrome 窗口里用桌面滚动工具翻长页面，再点按钮 | 参数完全相同的连续滚动（"重复动作"判定） |
| W1 | 通过浏览器通道填 3 个字段并提交 | 浏览器通道；默认的可信输入路径被拒绝后改用 dom_event |
| W2 | 通过浏览器通道滚动到可视区，再点按钮 | 浏览器滚动 |
| W3 | 点链接跳到新页面，先误用旧页面的引用，再纠正 | 引用过期后能否自己恢复 |

程序化 Agent 的习惯（每次运行都一样）写在 `tasks.ts` 的文件头。暂停后的"人工恢复"由脚本模拟用户点恢复：网关恢复传输通道，状态机执行 `resume()`；如果状态机拒绝恢复，任务记为失败。

## 已知差异

- 产品里的暂停会停掉守护进程，恢复时重新拉起；脚本只重建网关到守护进程的传输通道，不重启守护进程。浏览器绑定在两种情况下都会失效，所以对 Agent 来说行为一致。
- 不覆盖会话凭据、控制条界面和登录生命周期，这些已有各自的单元测试和真机验收。
