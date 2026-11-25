/**
 * 单元测试: acpSessionSetup — session id 形态校验与 cwd/title 推导
 *
 * 有序解析（memory → load → new，含超时与重建）的用例在 acpSessionRecovery.test.ts。
 */

import { describe, it, expect, vi } from "vitest";
import * as path from "path";
import {
  buildWorkDirAndProjectDir,
  isSessionIdCompatibleWithEngine,
  type SessionSetupDeps,
} from "./acpSessionSetup";

function makeDeps(): Pick<SessionSetupDeps, "logTag" | "workspaceDir"> {
  return {
    logTag: "[test]",
    workspaceDir: "/workspace",
  };
}

describe("isSessionIdCompatibleWithEngine", () => {
  it("nuwaxcode only accepts ses_*", () => {
    expect(
      isSessionIdCompatibleWithEngine(
        "ses_010f31944ffe3OywvJ8AmMo0lT",
        "nuwaxcode",
      ),
    ).toBe(true);
    expect(
      isSessionIdCompatibleWithEngine(
        "41c20e6b-f7df-4a9f-beea-cd375bc320eb",
        "nuwaxcode",
      ),
    ).toBe(false);
    expect(isSessionIdCompatibleWithEngine("persisted-sess", "nuwaxcode")).toBe(
      false,
    );
  });

  it("claude-code rejects ses_* but accepts UUID and other ids", () => {
    expect(
      isSessionIdCompatibleWithEngine(
        "ses_010f31944ffe3OywvJ8AmMo0lT",
        "claude-code",
      ),
    ).toBe(false);
    expect(
      isSessionIdCompatibleWithEngine(
        "41c20e6b-f7df-4a9f-beea-cd375bc320eb",
        "claude-code",
      ),
    ).toBe(true);
    expect(
      isSessionIdCompatibleWithEngine("persisted-sess", "claude-code"),
    ).toBe(true);
  });

  it("unknown engines allow load (timeout fallback)", () => {
    expect(
      isSessionIdCompatibleWithEngine(
        "41c20e6b-f7df-4a9f-beea-cd375bc320eb",
        "codex-cli",
      ),
    ).toBe(true);
    expect(isSessionIdCompatibleWithEngine("ses_abc", "codex-cli")).toBe(true);
  });
});

describe("buildWorkDirAndProjectDir（三轨）", () => {
  it("标识符轨道：维持 workspace 拼接，workDirId 兼作 title", () => {
    const { workDirId, projectDir } = buildWorkDirAndProjectDir(makeDeps(), {
      user_id: "u1",
      project_id: "p1",
      agent_work_dir: "my-proj",
      prompt: "hi",
    });
    expect(workDirId).toBe("my-proj");
    expect(projectDir).toBe(
      path.join("/workspace", "computer-project-workspace", "u1", "my-proj"),
    );
  });

  it("绝对路径轨道：projectDir 直通原值，title 用 basename", () => {
    const abs = "/Users/me/my-project";
    const { workDirId, projectDir } = buildWorkDirAndProjectDir(makeDeps(), {
      user_id: "u1",
      project_id: "p1",
      agent_work_dir: abs,
      prompt: "hi",
    });
    expect(workDirId).toBe("my-project");
    expect(projectDir).toBe(abs);
  });

  it("project_id 兜底同样按形态分流", () => {
    const { projectDir } = buildWorkDirAndProjectDir(makeDeps(), {
      user_id: "u1",
      project_id: "/Users/me/fallback-dir",
      prompt: "hi",
    });
    expect(projectDir).toBe("/Users/me/fallback-dir");
  });

  it("normalProject 轨道：service_type=computer-normal-project 时目录多一层 normalProject/", () => {
    const { workDirId, projectDir } = buildWorkDirAndProjectDir(makeDeps(), {
      user_id: "u1",
      project_id: "p1",
      agent_work_dir: "np-9",
      service_type: "computer-normal-project",
      prompt: "hi",
    });
    expect(workDirId).toBe("np-9");
    expect(projectDir).toBe(
      path.join(
        "/workspace",
        "computer-project-workspace",
        "u1",
        "normalProject",
        "np-9",
      ),
    );
  });

  it("normalProject 轨道：camelCase service_type 旧词同样命中", () => {
    const { projectDir } = buildWorkDirAndProjectDir(makeDeps(), {
      user_id: "u1",
      project_id: "p1",
      agent_work_dir: "np-9",
      service_type: "normalProject",
      prompt: "hi",
    });
    expect(projectDir).toContain("normalProject");
  });

  it("normalProject 轨道：容器物化形态归一为 pid（防御绕过 router 校验的调用方）", () => {
    const { workDirId, projectDir } = buildWorkDirAndProjectDir(makeDeps(), {
      user_id: "u1",
      project_id: "p1",
      agent_work_dir: "/home/user/normalProject/np-9",
      prompt: "hi",
    });
    expect(workDirId).toBe("np-9");
    expect(projectDir).toBe(
      path.join(
        "/workspace",
        "computer-project-workspace",
        "u1",
        "normalProject",
        "np-9",
      ),
    );
  });

  it("normalProject + 本机自选绝对目录：维持绝对路径轨道（agentWorkspacePath 覆盖场景）", () => {
    const abs = "/Users/me/picked-dir";
    const { workDirId, projectDir } = buildWorkDirAndProjectDir(makeDeps(), {
      user_id: "u1",
      project_id: "p1",
      agent_work_dir: abs,
      service_type: "computer-normal-project",
      prompt: "hi",
    });
    expect(workDirId).toBe("picked-dir");
    expect(projectDir).toBe(abs);
  });

  it("无 service_type 的存量请求维持标识符轨道（回归锁）", () => {
    const { projectDir } = buildWorkDirAndProjectDir(makeDeps(), {
      user_id: "u1",
      project_id: "p1",
      agent_work_dir: "plain-proj",
      prompt: "hi",
    });
    expect(projectDir).toBe(
      path.join("/workspace", "computer-project-workspace", "u1", "plain-proj"),
    );
  });
});
