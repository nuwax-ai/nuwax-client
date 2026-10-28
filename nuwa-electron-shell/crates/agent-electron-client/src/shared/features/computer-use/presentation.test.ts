import { describe, expect, it } from "vitest";
import {
  canPreviewCuaTask,
  canShowCuaOverlay,
  cuaOverlayNotice,
  cuaReasonKey,
  isCuaLivePhase,
} from "./presentation";

describe("Computer Use overlay liveness and notices", () => {
  it("keeps running and paused work live", () => {
    expect(isCuaLivePhase("running")).toBe(true);
    expect(isCuaLivePhase("paused", { reason: "userPaused" })).toBe(true);
  });

  it("keeps the overlay up through emergency-stop drain and a stuck helper", () => {
    expect(isCuaLivePhase("stopped", { controlPending: true })).toBe(true);
    expect(isCuaLivePhase("failed", { controlPending: true, reason: "helperStillRunning" })).toBe(true);
    expect(isCuaLivePhase("failed", { reason: "helperStillRunning" })).toBe(true);
    expect(isCuaLivePhase("stopped")).toBe(false);
    expect(isCuaLivePhase("completed")).toBe(false);
    expect(isCuaLivePhase("idle")).toBe(false);
  });

  it("hides the host card for multiwindow, idle, and finished sessions", () => {
    expect(canShowCuaOverlay({ phase: "running", taskId: "t" })).toBe(true);
    expect(canShowCuaOverlay({ phase: "stopped", taskId: "t", controlPending: true })).toBe(true);
    expect(canShowCuaOverlay({ phase: "running", taskId: "t", multiwindow: true })).toBe(false);
    expect(canShowCuaOverlay({ phase: "running", taskId: null })).toBe(false);
    expect(canShowCuaOverlay({ phase: "completed", taskId: "t" })).toBe(false);
  });

  it("previews only bound window tasks, including the stop tail", () => {
    const bound = { scope: { kind: "window" as const, pid: 1, windowId: 2, label: "A" } };
    expect(canPreviewCuaTask({ phase: "paused", ...bound })).toBe(true);
    expect(canPreviewCuaTask({ phase: "stopped", controlPending: true, ...bound })).toBe(true);
    expect(canPreviewCuaTask({ phase: "running", scope: { kind: "desktop" } })).toBe(false);
    expect(canPreviewCuaTask({ phase: "paused", scope: { kind: "window", pid: 0, windowId: 0, label: "" } })).toBe(false);
  });

  it("maps unknown IPC codes to generic and keeps operational pauses off the slim card", () => {
    expect(cuaReasonKey("loginRequired")).toBe("loginRequired");
    expect(cuaReasonKey("operationFailed")).toBe("operationFailed");
    expect(cuaReasonKey("sensitiveTarget")).toBe("sensitiveTarget");
    expect(cuaReasonKey("notARealCode")).toBe("generic");
    expect(cuaOverlayNotice("permissionsRequired")).toBe("permissionsRequired");
    expect(cuaOverlayNotice("uncertainResult")).toBe("uncertainResult");
    expect(cuaOverlayNotice("noProgress")).toBeNull();
    expect(cuaOverlayNotice("userPaused")).toBeNull();
    expect(cuaOverlayNotice("userTakingControl")).toBeNull();
  });
});
