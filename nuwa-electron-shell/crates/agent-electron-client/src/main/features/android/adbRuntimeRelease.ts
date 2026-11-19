import type { AdbRuntimeRelease } from "./adbRuntime";

// Pin the mirrored archives and installed files to the verified upstream bytes.
// Upstream catalogue: https://dl.google.com/android/repository/repository2-1.xml
const VERSION = "37.0.1";
const MIRROR = "https://s3.nuwax.com:9443/nuwaclaw/nuwax-electron/dependencies/adb";
const RELEASE = `${MIRROR}/${VERSION}/platform-tools_r${VERSION}`;
const releases = {
  darwin: {
    version: VERSION,
    platform: "darwin",
    url: RELEASE + "-darwin.zip",
    bytes: 16110554,
    sha256: "ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d",
    executable: "adb",
    files: {
      "adb": {
        bytes: 18844128,
        sha256: "1811e253b21b12cbfda7201ebaf86c10e7ddcb5c606a7a81f7c82b4c429c2d3b",
      },
      "NOTICE.txt": {
        bytes: 1152421,
        sha256: "356cc66516060e4da6bdc53e6f0bbb8e8101673f326b73c68d535eddd04dd7b1",
      },
    },
  },
  win32: {
    version: VERSION,
    platform: "win32",
    url: RELEASE + "-win.zip",
    bytes: 8044989,
    sha256: "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99",
    executable: "adb.exe",
    files: {
      "adb.exe": {
        bytes: 8273560,
        sha256: "b4a6b455702684652cccf7b46258b29e653538904359a58fd4931cf3ef286b3f",
      },
      "AdbWinApi.dll": {
        bytes: 108184,
        sha256: "c1d653030b4bde65d3e07e4d0b0979e17be56df1436cdd15528630f27808050d",
      },
      "AdbWinUsbApi.dll": {
        bytes: 73368,
        sha256: "0710e894d9b40f71a670c13c694079d564c92c1279da382cfe4850983aaebe1b",
      },
      "libwinpthread-1.dll": {
        bytes: 243016,
        sha256: "f2044c755e39efc5d47f47c5a942178dd6d79dc8945bb182dc8753d10e2a4269",
      },
      "NOTICE.txt": {
        bytes: 1154131,
        sha256: "38ec8c6f5b7799c223ffeab1f9e81c2d5fc67b5e56d6424f649630ca1ee1a811",
      },
    },
  },
  linux: {
    version: VERSION,
    platform: "linux",
    url: RELEASE + "-linux.zip",
    bytes: 9054187,
    sha256: "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1",
    executable: "adb",
    files: {
      "adb": {
        bytes: 10642368,
        sha256: "a902be8f45c6c62e76c9efaf6947a0fa747c9cabd89a2ac8e0d16ecb30b3ed01",
      },
      "lib64/libc++.so": {
        bytes: 1533896,
        sha256: "6cb165d671ced6a719b153b72e5d1b0a9cfd488badccc92d0aee55eda294f8ff",
      },
      "NOTICE.txt": {
        bytes: 1175837,
        sha256: "c29da8f704720fa1d3d802b834b86d9c023f20ae2596a8f2a4e17ed5490b17ae",
      },
    },
  },
} satisfies Record<string, AdbRuntimeRelease>;

export function platformToolsRelease(
  platform = process.platform,
  arch = process.arch,
): AdbRuntimeRelease | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return releases.darwin;
  if (arch !== "x64") return null;
  if (platform === "win32") return releases.win32;
  if (platform === "linux") return releases.linux;
  return null;
}
