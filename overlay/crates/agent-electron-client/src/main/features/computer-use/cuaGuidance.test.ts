import { describe, expect, it } from "vitest";
import { CUA_AGENT_CURSOR_ENABLE, cuaInstructions, cuaMergeInstructions, cuaRejectionText, cuaToolDescription } from "./cuaGuidance";

const desktop = { kind: "desktop" } as const;
const windowScope = { kind: "window", pid: 20, windowId: 40, label: "App" } as const;

describe("cuaGuidance", () => {
  it("states the observe → element_index → verify recipe", () => {
    const text = cuaInstructions(desktop);
    expect(text).toContain("Observe first");
    expect(text).toContain("element_index");
    expect(text).toContain("last resort");
    expect(text).toContain("Agent cursor");
    expect(text).toContain("blacklisted");
    expect(text).toContain("confirmationRequired");
    expect(text).not.toContain("ask the user to select that browser window in Computer Use (window mode)");
  });

  it("rejects window-mode pixels as scopeViolation, not a miss", () => {
    const text = cuaInstructions(windowScope);
    expect(text).toContain("scopeViolation");
    expect(text).toContain("element_index");
    expect(cuaToolDescription(windowScope, "click", undefined)).toContain("element_index");
    expect(cuaRejectionText("scopeViolation")).toContain("pixel coordinates");
  });

  it("merges instructions once and exposes the host cursor enable payload", () => {
    const first = cuaMergeInstructions(desktop, "extra");
    expect(cuaMergeInstructions(desktop, first)).toBe(first);
    expect(CUA_AGENT_CURSOR_ENABLE).toEqual({ name: "set_agent_cursor_enabled", arguments: { enabled: true } });
  });
});
