import { describe, expect, it, vi } from "vitest";
import { localXSocketPath, selectLinuxDisplayBackend, TEXT_INPUT_V3 } from "./linuxDisplayBackend";

const waylandSession = { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", DISPLAY: ":0" };
const argv = ["/opt/Nuwax/nuwax"];
const xServerPresent = (file: string) => file === "/tmp/.X11-unix/X0";

describe("Linux display backend", () => {
  it("leaves other platforms alone", () => {
    const query = vi.fn(() => false);
    const decision = selectLinuxDisplayBackend({ platform: "darwin", env: waylandSession, argv, query });
    expect(decision).toEqual({ platform: null, reason: "" });
    expect(query).not.toHaveBeenCalled();
  });

  it("never overrides a backend that was requested explicitly", () => {
    const query = vi.fn(() => false);
    for (const extra of [["--ozone-platform=wayland"], ["--ozone-platform", "wayland"], ["--ozone-platform-hint=auto"]]) {
      expect(selectLinuxDisplayBackend({ platform: "linux", env: waylandSession, argv: [...argv, ...extra], query }).platform).toBeNull();
    }
    for (const hint of ["auto", "wayland", "x11"]) {
      expect(selectLinuxDisplayBackend({ platform: "linux", env: { ...waylandSession, ELECTRON_OZONE_PLATFORM_HINT: hint }, argv, query }).platform).toBeNull();
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("stays native where the compositor offers text-input v3", () => {
    const query = vi.fn((_socketPath: string, name: string) => name === TEXT_INPUT_V3);
    const decision = selectLinuxDisplayBackend({ platform: "linux", env: waylandSession, argv, query, exists: xServerPresent });
    expect(decision.platform).toBeNull();
    expect(query).toHaveBeenCalledWith("/run/user/1000/wayland-0", TEXT_INPUT_V3);
  });

  it("falls back to X11 where the compositor offers no text-input v3", () => {
    const query = vi.fn(() => false);
    const decision = selectLinuxDisplayBackend({ platform: "linux", env: waylandSession, argv, query, exists: xServerPresent });
    expect(decision.platform).toBe("x11");
    expect(decision.reason).toMatch(/no input method/);
    // 远程桌面里常见的 DISPLAY=:10.0 也要认。
    expect(selectLinuxDisplayBackend({
      platform: "linux", env: { ...waylandSession, DISPLAY: ":10.0" }, argv, query,
      exists: (file) => file === "/tmp/.X11-unix/X10",
    }).platform).toBe("x11");
  });

  it("keeps native Wayland when there is no local X server to fall back to", () => {
    const query = vi.fn(() => false);
    for (const env of [
      { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000" },
      { ...waylandSession, DISPLAY: "remote-host:0" },
      { ...waylandSession, DISPLAY: "garbage" },
      { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    ]) {
      expect(selectLinuxDisplayBackend({ platform: "linux", env, argv, query, exists: xServerPresent }).platform).toBeNull();
    }
    // DISPLAY 指向的 socket 已经不在了：同样不能回退，否则客户端起不来。
    expect(selectLinuxDisplayBackend({ platform: "linux", env: waylandSession, argv, query, exists: () => false }).platform).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps the default when the compositor cannot be queried", () => {
    const query = vi.fn(() => null);
    const decision = selectLinuxDisplayBackend({ platform: "linux", env: waylandSession, argv, query, exists: xServerPresent });
    expect(decision.platform).toBeNull();
    expect(decision.reason).toMatch(/could not be queried/);
  });

  it("does nothing on an X11 session", () => {
    const query = vi.fn(() => false);
    const decision = selectLinuxDisplayBackend({
      platform: "linux", env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, argv, query, exists: xServerPresent,
    });
    expect(decision).toEqual({ platform: null, reason: "X11 session" });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("local X socket path", () => {
  it("maps a local display number to its socket and rejects anything else", () => {
    expect(localXSocketPath(":0")).toBe("/tmp/.X11-unix/X0");
    expect(localXSocketPath(":10.0")).toBe("/tmp/.X11-unix/X10");
    expect(localXSocketPath("unix:1")).toBe("/tmp/.X11-unix/X1");
    expect(localXSocketPath("remote-host:0")).toBeNull();
    expect(localXSocketPath("")).toBeNull();
    expect(localXSocketPath(undefined)).toBeNull();
  });
});
