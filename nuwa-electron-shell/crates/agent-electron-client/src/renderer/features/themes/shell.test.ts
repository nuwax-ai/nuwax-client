import { expect, it, vi } from "vitest";
import { defaultTokens } from "@shared/features/themes/core";
import type { HostThemeSnapshot } from "@shared/types/hostBridge";
const h = vi.hoisted(() => ({
  apply: vi.fn().mockReturnValue(true),
  dispose: vi.fn(),
}));
vi.mock("@shared/features/themes/core/dom", () => ({
  createThemeApplicator: () => h,
}));
import { createShellThemeApplicator } from "./shell";
it("lets semantic root variables pass the legacy body mode rules and restores body on disposal", () => {
  const props = new Map<string, string>([["--color-primary", "old"]]);
  let mode: string | null = "light";
  const body = {
    style: {
      getPropertyValue: (key: string) => props.get(key) ?? "",
      getPropertyPriority: () => "",
      setProperty: (key: string, value: string) => props.set(key, value),
      removeProperty: (key: string) => props.delete(key),
    },
    getAttribute: () => mode,
    setAttribute: (_key: string, value: string) => {
      mode = value;
    },
    removeAttribute: () => {
      mode = null;
    },
  };
  const applicator = createShellThemeApplicator({
    body,
    documentElement: {},
  } as unknown as Document);
  applicator.apply({
    revision: 1,
    mode: "dark",
    tokens: defaultTokens.dark,
  } as unknown as HostThemeSnapshot);
  expect(mode).toBe("dark");
  expect(props.get("--color-primary")).toBe("inherit");
  expect(props.get("--color-bg-header")).toBe("var(--nuwax-elevated-bg)");
  h.apply.mockReturnValueOnce(false);
  expect(applicator.apply({ mode: "light" } as HostThemeSnapshot)).toBe(false);
  expect(mode).toBe("dark");
  applicator.dispose();
  expect(h.dispose).toHaveBeenCalledOnce();
  expect(mode).toBe("light");
  expect([...props]).toEqual([["--color-primary", "old"]]);
});
