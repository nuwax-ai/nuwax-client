/** Settings expose nested toggles; persist one channel to avoid invalid combinations. */
export type UpdateChannel = "stable" | "beta" | "dev";
export const UPDATE_CHANNEL_SETTING_KEY = "update_channel";
/** Main-process intent, bound to the installed version and the chosen subscription. */
export const UPDATE_CHANNEL_SWITCH_SETTING_KEY = "update_channel_switch";

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "beta" || value === "dev";
}

export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return isUpdateChannel(value) ? value : "stable";
}

export function getReleaseChannel(version: string): UpdateChannel | null {
  const prerelease = version.split("+")[0].split("-").slice(1).join("-");
  if (!prerelease) return "stable";
  if (/^beta\.[1-9]\d*$/.test(prerelease)) return "beta";
  if (/^alpha\.[1-9]\d*$/.test(prerelease)) return "dev";
  return null;
}

/** Dev is an explicit subscription, independent of the faster Beta test stream. */
export function allowsUpdateVersion(channel: UpdateChannel, version: string): boolean {
  const release = getReleaseChannel(version);
  if (channel === "dev") return release === "dev";
  return release === "stable" || (channel === "beta" && release === "beta");
}
