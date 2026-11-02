import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, shell } from "electron";

const APP_ID = "com.nuwax-ai.nuwax";
const RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const runFile = promisify(execFile);

export interface StartupEntry {
  kind: "run" | "shortcut";
  name: string;
  target: string;
  appId?: string;
  hive?: "CurrentUser" | "LocalMachine";
  view?: "Registry32" | "Registry64";
  command?: string;
  unreadable?: boolean;
}

export interface WindowsStartupStore {
  list(): Promise<StartupEntry[]>;
  remove(entry: StartupEntry): Promise<void>;
}

function localExe(value: string): string | null {
  if (
    !/^[a-z]:\\/i.test(value) ||
    path.win32.basename(value).toLowerCase() !== "nuwax.exe"
  )
    return null;
  return path.win32.normalize(value).toLowerCase();
}

export function startupCommandTarget(command: string): string {
  // Unquoted paths with spaces are ambiguous to Windows; never guess ownership.
  return (
    command.match(/^\s*"([^"]+)"(?:\s|$)/)?.[1] ??
    command.match(/^\s*([a-z]:\\[^\s"]+\.exe)(?:\s|$)/i)?.[1] ??
    ""
  );
}

export function isOwnedStartupEntry(
  entry: StartupEntry,
  knownExecutables: string[],
): boolean {
  const target = localExe(entry.target);
  if (!target) return false;
  const identity = entry.kind === "run" ? entry.name : entry.appId;
  if (identity?.toLowerCase() === APP_ID) return true;
  if (entry.kind === "shortcut" && identity) return false;
  const name = entry.name.replace(/\.lnk$/i, "").toLowerCase();
  return (
    ["nuwax", "女娲nuwax"].includes(name) &&
    knownExecutables.some((exe) => localExe(exe) === target)
  );
}

export async function removeOwnedWindowsStartup(
  store: WindowsStartupStore,
  knownExecutables: string[],
): Promise<void> {
  let failed = false;
  let firstFailure: unknown;
  const remember = (error: unknown) => {
    if (!failed) firstFailure = error;
    failed = true;
  };
  for (const entry of await store.list()) {
    if (entry.unreadable) {
      remember(
        new Error(
          "Cannot inspect a suspected product startup entry or Startup folder",
        ),
      );
    } else if (isOwnedStartupEntry(entry, knownExecutables)) {
      try {
        await store.remove(entry);
      } catch (error) {
        remember(error);
      }
    }
  }
  const remaining = await store.list();
  if (failed) throw firstFailure;
  if (remaining.some((entry) => entry.unreadable)) {
    throw new Error(
      "Cannot inspect a suspected product startup entry or Startup folder",
    );
  }
  if (remaining.some((entry) => isOwnedStartupEntry(entry, knownExecutables))) {
    throw new Error("Owned Windows startup entries remain");
  }
}

async function powershell(script: string): Promise<string> {
  const system =
    process.arch === "ia32" && process.env.PROCESSOR_ARCHITEW6432
      ? "Sysnative"
      : "System32";
  const executable = path.win32.join(
    process.env.SystemRoot || "C:\\Windows",
    system,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await runFile(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
          script,
        "utf16le",
      ).toString("base64"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return stdout.trim();
}

function registryData(entry: StartupEntry): string {
  return Buffer.from(JSON.stringify(entry), "utf8").toString("base64");
}

export function createWindowsStartupStore(
  startupFolders: string[],
  runPowerShell = powershell,
): WindowsStartupStore {
  const observedProductLinks = new Set<string>();
  const suspectedProductLink = (name: string, file: string) =>
    ["nuwax", "女娲nuwax", APP_ID].includes(
      name.replace(/\.lnk$/i, "").toLowerCase(),
    ) || observedProductLinks.has(file.toLowerCase());
  return {
    async list() {
      const raw =
        await runPowerShell(`$entries=@(); foreach($hive in @('CurrentUser','LocalMachine')) {
        foreach($view in @('Registry32','Registry64')) {
          $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$hive,[Microsoft.Win32.RegistryView]$view);
          $key=$null; try { $key=$base.OpenSubKey('${RUN_KEY}'); if($key) {
            foreach($name in $key.GetValueNames()) { $value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);
              if($value -is [string]) { $entries+=@{kind='run';name=$name;command=$value;hive=$hive;view=$view} }
            }
          }} finally { if($key){$key.Dispose()}; $base.Dispose() }
        }
      }; ConvertTo-Json -InputObject @($entries) -Compress`);
      const entries: StartupEntry[] = JSON.parse(raw || "[]").map(
        (entry: StartupEntry) => ({
          ...entry,
          target: startupCommandTarget(entry.command || ""),
        }),
      );
      for (const folder of startupFolders) {
        let names: string[];
        try {
          if (
            !/^[a-z]:\\/i.test(folder) ||
            (await fs.lstat(folder)).isSymbolicLink()
          )
            throw new Error(
              "Startup folder is not an ordinary local directory",
            );
          names = await fs.readdir(folder);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          // Preserve partial inventory so readable Run/link entries can still be removed.
          entries.push({
            kind: "shortcut",
            name: folder,
            target: "",
            unreadable: true,
          });
          continue;
        }
        for (const name of names.filter((name) => /\.lnk$/i.test(name))) {
          const file = path.win32.join(folder, name);
          try {
            const stat = await fs.lstat(file);
            if (!stat.isFile()) {
              if (stat.isSymbolicLink() && suspectedProductLink(name, file)) {
                entries.push({
                  kind: "shortcut",
                  name,
                  target: "",
                  command: file,
                  unreadable: true,
                });
              }
              continue;
            }
            const link = shell.readShortcutLink(file);
            if (link.appUserModelId?.toLowerCase() === APP_ID)
              observedProductLinks.add(file.toLowerCase());
            entries.push({
              kind: "shortcut",
              name,
              target: link.target,
              appId: link.appUserModelId,
              command: file,
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            // Unknown broken aliases are not ours to alter. Product-named or previously
            // identified links remain an explicit verification failure, never a silent opt-out.
            if (suspectedProductLink(name, file)) {
              entries.push({
                kind: "shortcut",
                name,
                target: "",
                command: file,
                unreadable: true,
              });
            }
          }
        }
      }
      return entries;
    },
    async remove(entry) {
      if (entry.kind === "shortcut") {
        const file = entry.command!;
        const link = shell.readShortcutLink(file);
        if (
          link.target !== entry.target ||
          (link.appUserModelId || "") !== (entry.appId || "")
        )
          throw new Error("Startup shortcut changed during removal");
        await fs.unlink(file);
        return;
      }
      // Re-read the observed, unexpanded value before deleting it.
      await runPowerShell(`$e=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${registryData(entry)}'))|ConvertFrom-Json;
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Enum]::Parse([Microsoft.Win32.RegistryHive],$e.hive),[Enum]::Parse([Microsoft.Win32.RegistryView],$e.view));
        $key=$null; try { $key=$base.OpenSubKey('${RUN_KEY}',$true); if($key) {
          $value=$key.GetValue($e.name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);
          if($null -ne $value) { if($value -cne $e.command){throw 'Startup value changed during removal'}; $key.DeleteValue($e.name,$false) }
        }} finally { if($key){$key.Dispose()}; $base.Dispose() }`);
    },
  };
}

export async function cleanupWindowsAutoLaunch(): Promise<void> {
  const names = ["Nuwax", "女娲Nuwax"];
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA &&
      path.win32.join(process.env.LOCALAPPDATA, "Programs"),
  ].filter((value): value is string => !!value);
  const known = [
    app.getPath("exe"),
    ...roots.flatMap((root) =>
      names.map((name) => path.win32.join(root, name, "Nuwax.exe")),
    ),
  ];
  const folders = [
    path.win32.join(
      app.getPath("appData"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
    ),
  ];
  if (process.env.ProgramData)
    folders.push(
      path.win32.join(
        process.env.ProgramData,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
      ),
    );
  await removeOwnedWindowsStartup(createWindowsStartupStore(folders), known);
}
