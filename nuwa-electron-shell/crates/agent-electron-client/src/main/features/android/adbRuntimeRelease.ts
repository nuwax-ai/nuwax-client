import type { AdbRuntimeRelease } from "./adbRuntime";
import mirror from "./adbRuntimeMirror.json";

type MirrorAsset = Omit<AdbRuntimeRelease, "platform" | "version" | "url" | "sourceUrl"> & {
  name: string;
};

export function platformToolsRelease(
  platform = process.platform,
  arch = process.arch,
): AdbRuntimeRelease | null {
  const key = platform + "-" + arch;
  const asset = (mirror.platforms as Record<string, MirrorAsset>)[key];
  if (!asset) return null;
  const { name, ...archive } = asset;
  const base = `${mirror.baseUrl}/${mirror.version}`;
  return {
    ...archive,
    platform: key,
    version: mirror.version,
    url: `${base}/${name}`,
    sourceUrl: `${base}/${mirror.source}`,
  };
}
