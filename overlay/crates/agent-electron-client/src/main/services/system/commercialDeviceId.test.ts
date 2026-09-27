import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import * as path from "path";
import * as fs from "fs";

const mocks = vi.hoisted(() => ({
  home: "",
  platform: "darwin" as NodeJS.Platform,
  execFileSync: vi.fn(),
  hostname: vi.fn(),
}));
vi.mock("child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("os", async (importOriginal) => ({
  ...await importOriginal<typeof import("os")>(),
  homedir: () => mocks.home,
  platform: () => mocks.platform,
  hostname: mocks.hostname,
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@shared/constants", () => ({ APP_DATA_DIR_NAME: ".nuwax" }));

const actualFs = await vi.importActual<typeof import("fs")>("fs");
const actualOs = await vi.importActual<typeof import("os")>("os");
const { getCommercialDeviceId } = await import("./commercialDeviceId");
const UUID = "a1b2c3d4-e5f6-4789-abcd-0123456789ab";
const hash = (raw: string) => createHash("sha256").update(raw + "nuwax:device:v1").digest("hex");
const identityFile = () => path.join(mocks.home, ".nuwax", "device-id");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.home = actualFs.mkdtempSync(path.join(actualOs.tmpdir(), "nuwax-device-id-"));
  mocks.platform = "darwin";
  mocks.execFileSync.mockReset().mockReturnValue(`"IOPlatformUUID" = "${UUID.toUpperCase()}"\n`);
  mocks.hostname.mockReturnValue("same-computer-name");
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(actualFs.readFileSync);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actualFs.writeFileSync);
});
afterEach(() => actualFs.rmSync(mocks.home, { recursive: true, force: true }));

describe("commercial hardware device identity", () => {
  it("keeps the existing macOS hardware hash and stores only the hash", () => {
    expect(getCommercialDeviceId()).toBe(hash(UUID));
    expect(actualFs.readFileSync(identityFile(), "utf8")).toBe(hash(UUID) + "\n");
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it("uses Windows SMBIOS UUID with a bounded, hidden system PowerShell call", () => {
    mocks.platform = "win32";
    mocks.execFileSync.mockReturnValue(` \r\n${UUID.toUpperCase()}\r\n`);
    expect(getCommercialDeviceId()).toBe(hash(UUID));
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/WindowsPowerShell\\v1\.0\\powershell\.exe$/),
      expect.arrayContaining(["-NoProfile", "-NonInteractive", expect.stringContaining("Win32_ComputerSystemProduct")]),
      expect.objectContaining({ timeout: 5000, windowsHide: true }),
    );
  });

  it("uses the Linux DMI UUID when readable", () => {
    mocks.platform = "linux";
    vi.mocked(fs.readFileSync).mockImplementation(((file: string, ...args: unknown[]) =>
      file === "/sys/class/dmi/id/product_uuid" ? UUID.toUpperCase() + "\n" :
        (actualFs.readFileSync as Function)(file, ...args)) as typeof fs.readFileSync);
    expect(getCommercialDeviceId()).toBe(hash(UUID));
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it("keeps the pinned identity across restarts, renames and hardware read failures", () => {
    const first = getCommercialDeviceId();
    mocks.hostname.mockReturnValue("renamed-computer");
    mocks.execFileSync.mockReset().mockImplementation(() => { throw new Error("hardware unavailable"); });
    expect(getCommercialDeviceId()).toBe(first);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.hostname).not.toHaveBeenCalled();
  });

  it("rebuilds the same Windows hardware identity after application data is removed", () => {
    mocks.platform = "win32";
    mocks.execFileSync.mockReturnValue(UUID);
    const first = getCommercialDeviceId();
    actualFs.unlinkSync(identityFile());
    expect(getCommercialDeviceId()).toBe(first);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
  });

  it("gives computers with identical names different hardware identities", () => {
    const first = getCommercialDeviceId();
    actualFs.unlinkSync(identityFile());
    mocks.execFileSync.mockReturnValue('"IOPlatformUUID" = "01234567-89ab-4cde-abcd-0123456789ab"');
    expect(getCommercialDeviceId()).not.toBe(first);
    expect(mocks.hostname).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-uuid", "00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"])(
    "rejects invalid hardware UUID %s and pins a valid installation identity", (invalid) => {
      mocks.platform = "win32";
      mocks.execFileSync.mockReturnValueOnce(invalid).mockReturnValueOnce(`MachineGuid    REG_SZ    ${UUID}\r\n`);
      const first = getCommercialDeviceId();
      expect(first).toBe(hash(UUID));
      mocks.execFileSync.mockReset().mockReturnValue("01234567-89ab-4cde-abcd-0123456789ab");
      expect(getCommercialDeviceId()).toBe(first);
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    },
  );

  it("falls back from denied Linux DMI to a valid system machine-id", () => {
    mocks.platform = "linux";
    vi.mocked(fs.readFileSync).mockImplementation(((file: string, ...args: unknown[]) => {
      if (file === "/sys/class/dmi/id/product_uuid") throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (file === "/var/lib/dbus/machine-id") return "00000000000000000000000000000000";
      if (file === "/etc/machine-id") return "a1b2c3d4e5f64789abcd0123456789ab\n";
      return (actualFs.readFileSync as Function)(file, ...args);
    }) as typeof fs.readFileSync);
    expect(getCommercialDeviceId()).toBe(hash("a1b2c3d4e5f64789abcd0123456789ab"));
  });

  it("pins a random fallback when no valid machine identity exists", () => {
    mocks.platform = "win32";
    mocks.execFileSync.mockImplementation(() => { throw new Error("unavailable"); });
    const first = getCommercialDeviceId();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(hash("same-computer-name"));
    mocks.execFileSync.mockReset().mockReturnValue(UUID);
    expect(getCommercialDeviceId()).toBe(first);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it("uses an existing identity if another process creates the file first", () => {
    const winner = hash("existing-device");
    vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
      actualFs.writeFileSync(file, winner + "\n");
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    });
    expect(getCommercialDeviceId()).toBe(winner);
  });

  it("fails explicitly instead of registering an unpersisted identity", () => {
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => getCommercialDeviceId()).toThrow("disk full");
  });

  it("does not replace a corrupt pinned identity", () => {
    actualFs.mkdirSync(path.dirname(identityFile()), { recursive: true });
    actualFs.writeFileSync(identityFile(), "broken");
    expect(() => getCommercialDeviceId()).toThrow("Stored device identity is invalid");
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });
});
