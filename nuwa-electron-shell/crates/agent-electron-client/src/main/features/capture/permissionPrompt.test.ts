import { describe, expect, it, vi } from "vitest";
const mock = { open: vi.fn() };
import { createScreenPermissionPrompt } from "./permissionPrompt";
it("routes concurrent permission failures to one guide without requesting system access", async () => {
  mock.open.mockReturnValue(true);
  const prompt = createScreenPermissionPrompt({
    openGuide: () => mock.open("screen_recording"),
    log: { warn: vi.fn() },
  });
  const first = prompt();
  expect(prompt()).toBe(first);
  await first;
  expect(mock.open).toHaveBeenCalledWith("screen_recording");
  expect(mock.open).toHaveBeenCalledTimes(1);
  await prompt();
  expect(mock.open).toHaveBeenCalledTimes(2);
});
