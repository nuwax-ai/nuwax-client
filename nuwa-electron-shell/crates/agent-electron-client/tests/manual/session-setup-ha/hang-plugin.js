// 复现用：让 nuwaxcode 在加载本工作目录的项目级插件时永远不返回。
// 引擎每个目录只初始化一次，卡在这里之后 session/load、session/new 都不会有响应，
// 同进程里其他目录不受影响 —— 与 2026-11-25 同事日志里会话 1759004 的现象一致。
//
// 用法：把本文件拷到某个会话工作目录的 .opencode/plugins/hang.js。
// 用完务必删除；probe.mjs hangdir 会自动放一份并在结束时清理临时目录。
export default async function hang() {
  await new Promise(() => {});
  return {};
}
