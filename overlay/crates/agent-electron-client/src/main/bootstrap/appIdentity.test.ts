import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { configureCommercialAppIdentity } from "./appIdentity";

describe("commercial system name and existing profile identity", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    it(`${platform} changes the visible name without moving the existing profile`, () => {
      const app = { setName: vi.fn(), setPath: vi.fn(), getPath: vi.fn(() => "/profile") };
      configureCommercialAppIdentity(app, "女娲Nuwax", platform);
      expect(app.setName).toHaveBeenCalledWith(platform === "darwin" ? "女娲Nuwax" : "Nuwax");
      expect(app.setPath).toHaveBeenCalledWith("userData", path.join("/profile", "Nuwax"));
    });
  }
});
