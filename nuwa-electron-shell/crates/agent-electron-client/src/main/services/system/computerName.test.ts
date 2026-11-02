import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ hostname: "MBP128.local", development: false }));
vi.mock("os", () => ({ hostname: () => state.hostname }));
vi.mock("@shared/constants", () => ({ get IS_DEV_PROFILE() { return state.development; } }));
import { getClientHostname, getComputerName } from "./computerName";

beforeEach(() => { state.hostname = "MBP128.local"; state.development = false; });
describe("computer names", () => {
  it("keeps installed registration and raw hostname behavior", () => {
    expect(getComputerName()).toBe("MBP128");
    expect(getClientHostname()).toBe("MBP128.local");
  });
  it.each(["MBP128.local", "MBP128", "MBP128.LOCAL"])("development registration and display agree for %s", hostname => {
    state.hostname = hostname; state.development = true;
    expect(getComputerName()).toBe("MBP128 Dev");
    expect(getClientHostname()).toBe("MBP128 Dev");
  });
});
