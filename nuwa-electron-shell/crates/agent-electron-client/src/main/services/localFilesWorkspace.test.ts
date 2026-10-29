import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLocalFilesWorkspace } from "./localFilesWorkspace";

let base: string;
beforeEach(async () => { base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nuwax-local-cwd-"))); });
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });
const directory = async (...parts: string[]) => {
  const target = path.join(base, ...parts); await fs.mkdir(target, { recursive: true }); return target;
};
describe("本机文件工作区事实源", () => {
  it("实际 session.cwd 优先于创建时目录；多个实际目录不猜测", async () => {
    const actual = await directory("actual"); const old = await directory("old");
    expect(await resolveLocalFilesWorkspace({ cId: "42", workspacePath: old }, { base, getSessionDirectory: () => actual })).toBe(actual);
    expect(await resolveLocalFilesWorkspace({ cId: "42", projectId: "99", workspacePath: old }, { base, getSessionDirectory: id => id === "42" ? actual : old })).toBeNull();
  });
  it("冷启动明确 workspacePath 可定位历史文件，不要求引擎已恢复", async () => {
    const selected = await directory("中文 空格");
    expect(await resolveLocalFilesWorkspace({ cId: "42", workspacePath: selected }, { base, getSessionDirectory: () => null })).toBe(selected);
  });
  it("按会话标识只接受唯一目录命中；跨用户歧义不返回默认根", async () => {
    const first = await directory("computer-project-workspace", "alice", "42");
    const deps = { base, getSessionDirectory: () => null };
    expect(await resolveLocalFilesWorkspace({ cId: "42" }, deps)).toBe(first);
    await directory("computer-project-workspace", "bob", "42");
    expect(await resolveLocalFilesWorkspace({ cId: "42" }, deps)).toBeNull();
    expect(await resolveLocalFilesWorkspace({ cId: "absent" }, deps)).toBeNull();
  });
  it("normalProject 使用项目 ID，不能落到同名会话的平铺目录", async () => {
    const normal = await directory("computer-project-workspace", "alice", "normalProject", "99");
    await directory("computer-project-workspace", "alice", "42");
    const deps = { base, getSessionDirectory: () => null };
    expect(await resolveLocalFilesWorkspace({ cId: "42", projectId: "99", serviceType: "computer-normal-project" }, deps)).toBe(normal);
    expect(await resolveLocalFilesWorkspace({ cId: "42", serviceType: "computer-normal-project" }, deps)).toBeNull();
  });
  it("未知路径、相对 workspacePath 和含分隔符标识不会返回 HOME 或工作区总根", async () => {
    const deps = { base, getSessionDirectory: () => null };
    expect(await resolveLocalFilesWorkspace({ cId: "../other", workspacePath: "relative" }, deps)).toBeNull();
    expect(await resolveLocalFilesWorkspace({ cId: "42", workspacePath: path.join(base, "missing") }, deps)).toBeNull();
  });
});
