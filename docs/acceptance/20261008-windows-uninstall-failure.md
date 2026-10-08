# Windows 独立卸载失败处理验证（NUW-42）

## 已确认的源码缺口与本次修正

固定 electron-builder 25.1.8 的独立卸载分支在 `RMDir /r` 失败后仍继续清理快捷方式和登记。Windows 隔离夹具在 2026-10-08 16:02 北京时间复现：锁住假 payload 后返回 0、文件残留、登记与卸载程序被移除。这是条件性源码缺口，不是原机器报错的根因证明。

商业 overlay 的 `customRemoveFiles` 现保留 `--updated` 原子的改名/恢复分支。独立卸载在删除前备份卸载程序；移出安装目录后删除，立即检查失败与残留。失败则尝试恢复缺失的卸载程序，返回 2，并在登记/快捷方式清理前退出。无法备份时提前停止；无法恢复时明确提示需要原安装包修复，不写成功。

## 实际验证

2026-10-08 16:09 北京时间在 win-pc 执行 7 个 NSIS 夹具检查并通过：独立/升级锁文件失败、两个解锁后重试、两个正常删除、缺失卸载器时提前停止。锁文件失败保持登记，恢复的卸载器 SHA256 与原假文件一致；解锁重试才清登记。树外哨兵均不变。

夹具使用 NSIS 3.0.4.1、固定 vendor 删除段与当前 canonical hook，只创建新 Temp UUID 下的文本假 payload，并只操作 `HKCU\Software\NuwaxInstallerFixture\<UUID>`。未运行实际 Nuwax 卸载器或客户端，未修改用户安装和真实登记。测试报告保留源文件/编译器/生成 EXE 摘要。

复跑：

```bash
python3 scripts/acceptance/windows-uninstall-fixture.py --ssh-host win-pc --output-dir /absolute/owned/report-directory
```

Windows 本机可省略 `--ssh-host`，该本机入口尚未单独验证。需要已有 NSIS 3.0.4.1 缓存及 builder 25.1.8，工具不自动下载。`--baseline-header` 可指定修正前头文件复跑失败前证据。输出写入新 UUID 报告目录。

## 仍未完成

用户已反馈本人实机卸载成功无报错，原 BUG 的版本、机器和弹层仍须取得，不将本次修正扩大为普遍故障。夹具同样显示安装目录内未知工作区仍会被递归删除（U1）；本次没有修复此数据保全策略。ACL/备份恢复失败、特殊名称、中断和 all-users/UAC 尚未实测；真实新包卸载与安装性能仍待验收。本次不更改已发布包、版本号或 tag。
