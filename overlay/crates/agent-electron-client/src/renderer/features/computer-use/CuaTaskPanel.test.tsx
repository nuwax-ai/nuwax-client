import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("antd", () => ({
  Select: () => null, Space: ({ children }: any) => <div>{children}</div>, Tag: ({ children }: any) => <span>{children}</span>,
  Button: ({ children, disabled }: any) => <button disabled={disabled}>{children}</button>, message: { error: vi.fn() },
}));
import { CuaTaskPanel, CuaTaskSummary } from "./CuaTaskPanel";
const t = (key: string) => key;
describe("task details belong in the tray center", () => {
  it("shows count, action category and reason without exposing a tool name or input", () => {
    const html = renderToStaticMarkup(<CuaTaskSummary t={t} task={{ stepCount: 4, reason: "noProgress",
      steps: [{ tool: "set_value", outcome: "refused", arguments: "private input" }] } as any} />);
    expect(html).toContain("Claw.Cua.steps"); expect(html).toContain("Claw.Cua.outcome.refused");
    expect(html).toContain("Claw.Cua.reason.noProgress"); expect(html).not.toMatch(/private input|set_value/);
  });
  it("keeps target selection and mode in the center and disables preview before a target is bound", () => {
    const html = renderToStaticMarkup(<CuaTaskPanel api={{} as any} t={t} accept={vi.fn()}
      runtime={{ tasks: [{ taskId: "A", phase: "paused", mode: "background", stepCount: 0 }] } as any} />);
    expect(html).toContain("Claw.Cua.multiwindow.background");
    expect(html).toContain('<button disabled="">Claw.Cua.preview.expand</button>');
    expect(html).toContain("Claw.Cua.multiwindow.useForeground");
  });
});
