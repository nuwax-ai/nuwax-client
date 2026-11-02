export type Platform = "darwin" | "linux" | "win32";

type CommandProbe = {
  command: string;
  args: string[];
};

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly isWindows: boolean;
  readonly isMacOS: boolean;
  readonly isLinux: boolean;
  readonly pathDelimiter: ":" | ";";
  readonly commandLocator: "which" | "where";
  getCommandProbe(command: string): CommandProbe;
}

export function isSupportedPlatform(value: string): value is Platform {
  return value === "darwin" || value === "linux" || value === "win32";
}

export function getCurrentPlatform(): Platform {
  return isSupportedPlatform(process.platform) ? process.platform : "linux";
}

class RuntimePlatformAdapter implements PlatformAdapter {
  readonly isWindows: boolean;
  readonly isMacOS: boolean;
  readonly isLinux: boolean;
  readonly pathDelimiter: ":" | ";";
  readonly commandLocator: "which" | "where";

  constructor(readonly platform: Platform) {
    this.isWindows = platform === "win32";
    this.isMacOS = platform === "darwin";
    this.isLinux = platform === "linux";
    this.pathDelimiter = this.isWindows ? ";" : ":";
    this.commandLocator = this.isWindows ? "where" : "which";
  }

  getCommandProbe(command: string): CommandProbe {
    return {
      command: this.commandLocator,
      args: [command],
    };
  }
}

export function createPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
): PlatformAdapter {
  const resolvedPlatform = isSupportedPlatform(platform) ? platform : "linux";
  return new RuntimePlatformAdapter(resolvedPlatform);
}
