import * as fs from "node:fs/promises";
import { constants, lstatSync, watch } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateThemePackage,
  resolveThemePackage,
  officialThemePackage,
  deepSeekThemePackage,
  assertInstallableThemeId,
  canonicalPath,
  limits,
} from "@shared/features/themes/core";
import type {
  HostThemeFiles,
  HostThemesState,
  HostThemePreference,
  HostThemeSnapshot,
  HostThemeInfo,
} from "@shared/types/hostBridge";

type Package = ReturnType<typeof validateThemePackage>;
type Entry = {
  files: HostThemeFiles;
  source: "installed" | "linked";
  directory: string;
};
type Registry = {
  entries: Record<string, Entry>;
  selection: HostThemesState["selection"];
  userSelected: boolean;
  revision: number;
};
export type ThemeDeps = {
  fs: typeof fs;
  watch: (directory: string, change: () => void) => () => void;
  safeMode?: boolean;
  systemDark: () => boolean;
  applyPreference: (mode: HostThemePreference) => void;
  changed: (revision: number) => void;
};
export const watchThemeDirectory: ThemeDeps["watch"] = (directory, change) => {
  const watchers: ReturnType<typeof watch>[] = [];
  // Watch the closest available ancestor so an unplugged drive or missing parent
  // can recover. Filter unrelated registry/stage/cache writes at every level.
  let ancestor = path.dirname(directory);
  while (true) {
    try {
      const expected = path.relative(ancestor, directory).split(path.sep)[0];
      watchers.push(
        watch(ancestor, (_event, name) => {
          if (!name || String(name) === expected) change();
        })
      );
      break;
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  try {
    if (lstatSync(directory).isDirectory())
      watchers.push(watch(directory, { recursive: true }, change));
  } catch {
    /* offline root is watched through the closest available ancestor */
  }
  for (const watcher of watchers) watcher.on("error", change);
  return () => {
    for (const watcher of watchers) watcher.close();
  };
};
const builtin = [officialThemePackage, deepSeekThemePackage];
const message = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? "Theme storage unavailable"
    : error instanceof Error
    ? error.message
    : "Theme operation failed";

export class ThemeService {
  private registry: Registry = {
    entries: {},
    selection: { themeId: officialThemePackage.manifest.id, mode: "light" },
    userSelected: false,
    revision: 1,
  };
  private error?: string;
  private errors = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private watchers: (() => void)[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private systemDark = false;
  readonly ready: Promise<void>;
  constructor(readonly directory: string, private deps: ThemeDeps) {
    this.systemDark = deps.systemDark();
    this.ready = this.load();
    this.queue = this.ready;
  }
  private package(id: string, registry = this.registry): Package {
    const found = builtin.find((pkg) => pkg.manifest.id === id);
    if (found) return found;
    const entry = Object.hasOwn(registry.entries, id)
      ? registry.entries[id]
      : undefined;
    if (!entry) throw new Error("Unknown theme");
    return validateThemePackage(entry.files);
  }
  private async load() {
    try {
      const file = path.join(this.directory, "registry.json");
      const metadata = await this.deps.fs.lstat(file);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 128 * 1024 * 1024
      )
        throw new Error("Invalid theme registry");
      const handle = await this.deps.fs.open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      let raw: Registry;
      try {
        const opened = await handle.stat();
        if (
          opened.ino !== metadata.ino ||
          opened.dev !== metadata.dev ||
          opened.size !== metadata.size
        )
          throw new Error("Theme registry changed");
        const data = Buffer.alloc(Number(opened.size) + 1);
        let size = 0;
        while (size < data.length) {
          const chunk = await handle.read(data, size, data.length - size, size);
          if (!chunk.bytesRead) break;
          size += chunk.bytesRead;
        }
        if (size !== metadata.size) throw new Error("Theme registry changed");
        try {
          raw = JSON.parse(data.subarray(0, size).toString("utf8")) as Registry;
        } catch {
          throw new Error("Invalid theme registry");
        }
      } finally {
        await handle.close();
      }
      if (
        !raw ||
        !raw.entries ||
        !Number.isSafeInteger(raw.revision) ||
        raw.revision < 1 ||
        typeof raw.userSelected !== "boolean"
      )
        throw new Error("Invalid theme registry");
      const entries: Registry["entries"] = {};
      for (const [id, entry] of Object.entries(raw.entries)) {
        assertInstallableThemeId(id);
        const pkg = validateThemePackage(entry.files);
        if (
          pkg.manifest.id !== id ||
          !["linked", "installed"].includes(entry.source) ||
          typeof entry.directory !== "string" ||
          !path.isAbsolute(entry.directory)
        )
          throw new Error("Invalid theme registry entry");
        if (
          entry.source === "installed" &&
          entry.directory !== this.managed(id)
        )
          throw new Error("Invalid managed directory");
        entries[id] = entry;
      }
      this.package(raw.selection?.themeId, { ...raw, entries });
      if (!["light", "dark", "system"].includes(raw.selection.mode))
        throw new Error("Invalid theme preference");
      this.registry = { ...raw, entries };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.error = message(error);
    }
    this.apply();
    this.refreshWatchers();
    // Keep cache readable even if every working directory is offline or invalid.
    for (const id of Object.keys(this.registry.entries))
      await this.reloadNow(id);
  }
  private managed(id: string) {
    return path.join(this.directory, "installed", id);
  }
  state(): HostThemesState {
    const r = this.registry;
    const info = (
      pkg: Package,
      source: HostThemeInfo["source"]
    ): HostThemeInfo => ({
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      description: pkg.manifest.description,
      modes: Object.keys(pkg.manifest.variants) as HostThemeInfo["modes"],
      source,
    });
    return structuredClone({
      revision: r.revision,
      selection: r.selection,
      hasUserSelection: r.userSelected,
      ...(this.deps.safeMode ? { recovery: true } : {}),
      snapshot: resolveThemePackage(
        this.deps.safeMode
          ? officialThemePackage
          : this.package(r.selection.themeId),
        r.selection.mode,
        this.systemDark,
        r.revision
      ) as HostThemeSnapshot,
      themes: [
        ...builtin.map((pkg) => info(pkg, "builtin")),
        ...Object.entries(r.entries).map(([id, entry]) =>
          info(this.package(id), entry.source)
        ),
      ],
      ...(this.error || this.errors.size
        ? { error: this.error ?? [...this.errors.values()].join("; ") }
        : {}),
    });
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.queue.then(() => {
      if (this.disposed) throw new Error("Themes disposed");
      return run();
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  private apply() {
    try {
      this.deps.applyPreference(this.registry.selection.mode);
      this.systemDark = this.deps.systemDark();
    } catch {
      /* committed theme remains readable if legacy settings fail */
    }
  }
  private publish() {
    try {
      this.deps.changed(this.registry.revision);
    } catch {
      /* subscribers cannot fail a committed transaction */
    }
  }
  private async persist(next: Registry) {
    await this.deps.fs.mkdir(this.directory, { recursive: true });
    const tmp = path.join(this.directory, `.registry-${randomUUID()}`);
    try {
      const encoded = JSON.stringify(next);
      if (Buffer.byteLength(encoded) > 128 * 1024 * 1024)
        throw new Error("Theme registry size limit");
      await this.deps.fs.writeFile(tmp, encoded, { flag: "wx" });
      await this.deps.fs.rename(
        tmp,
        path.join(this.directory, "registry.json")
      );
    } finally {
      await this.deps.fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
  private async commit(next: Registry, clearErrorFor?: string) {
    next.revision = this.registry.revision + 1;
    await this.persist(next);
    this.registry = next;
    this.error = undefined;
    if (clearErrorFor) this.errors.delete(clearErrorFor);
    this.apply();
    this.refreshWatchers();
    this.publish();
  }
  private next(): Registry {
    return structuredClone(this.registry);
  }
  async exportPackage(id: string) {
    await this.ready;
    return structuredClone(this.package(id).files) as HostThemeFiles;
  }
  has(id: string) {
    return Object.hasOwn(this.registry.entries, id);
  }
  private async ensureManagedRoot() {
    const installed = path.join(this.directory, "installed");
    await this.deps.fs.mkdir(installed, { recursive: true });
    const metadata = await this.deps.fs.lstat(installed);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Managed theme directory must not be a symlink");
  }
  install(
    files: HostThemeFiles,
    replace = false,
    confirm: () => Promise<boolean> = async () => true
  ) {
    return this.serial(async () => {
      const pkg = validateThemePackage(files);
      const id = pkg.manifest.id;
      assertInstallableThemeId(id);
      await this.ensureManagedRoot();
      if (this.has(id) && !replace) return { conflict: true, ok: false };
      if (this.has(id) && !(await confirm()))
        return { canceled: true, ok: false };
      const dest = this.managed(id),
        stage = path.join(this.directory, `.stage-${randomUUID()}`),
        backup = path.join(this.directory, `.backup-${randomUUID()}`);
      let backed = false,
        moved = false;
      await this.deps.fs.mkdir(stage, { recursive: true });
      try {
        for (const [name, base64] of Object.entries(pkg.files) as [
          string,
          string
        ][]) {
          const target = path.join(stage, name);
          await this.deps.fs.mkdir(path.dirname(target), { recursive: true });
          await this.deps.fs.writeFile(target, Buffer.from(base64, "base64"), {
            flag: "wx",
          });
        }
        await this.deps.fs.mkdir(path.dirname(dest), { recursive: true });
        try {
          await this.deps.fs.rename(dest, backup);
          backed = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await this.deps.fs.rename(stage, dest);
        moved = true;
        const next = this.next();
        next.entries[id] = {
          files: pkg.files,
          source: "installed",
          directory: dest,
        };
        this.normalize(next, id, next.selection.mode);
        await this.commit(next, id);
      } catch (error) {
        if (moved)
          await this.deps.fs.rm(dest, { recursive: true, force: true });
        if (backed) await this.deps.fs.rename(backup, dest);
        throw error;
      } finally {
        await this.deps.fs
          .rm(stage, { recursive: true, force: true })
          .catch(() => undefined);
      }
      await this.deps.fs
        .rm(backup, { recursive: true, force: true })
        .catch(() => undefined);
      return { ok: true, state: this.state() };
    });
  }
  private normalize(next: Registry, id: string, mode: HostThemePreference) {
    if (next.selection.themeId !== id) return;
    const modes = Object.keys(this.package(id, next).manifest.variants);
    next.selection.mode =
      modes.length === 1 ? (modes[0] as HostThemePreference) : mode;
  }
  select(id: string, mode: HostThemePreference, onlyIfUnselected = false) {
    return this.serial(async () => {
      if (onlyIfUnselected && this.registry.userSelected)
        return { ok: false, conflict: true, state: this.state() };
      this.package(id);
      if (!["light", "dark", "system"].includes(mode))
        throw new Error("Invalid theme preference");
      const next = this.next();
      next.selection = { themeId: id, mode };
      next.userSelected = true;
      this.normalize(next, id, mode);
      await this.commit(next);
      return { ok: true, state: this.state() };
    });
  }
  link(directory: string, confirm: () => Promise<boolean>) {
    return this.serial(async () => {
      const files = await this.readDirectory(directory);
      const root = await this.deps.fs.realpath(directory);
      const pkg = validateThemePackage(files),
        id = pkg.manifest.id;
      assertInstallableThemeId(id);
      if (this.has(id) && !(await confirm()))
        return { ok: false, canceled: true };
      const next = this.next();
      next.entries[id] = {
        files: pkg.files,
        source: "linked",
        directory: root,
      };
      this.normalize(next, id, next.selection.mode);
      const previous = this.has(id) ? this.registry.entries[id] : undefined;
      if (previous?.source === "installed") await this.ensureManagedRoot();
      const backup = path.join(this.directory, `.backup-${randomUUID()}`);
      let moved = false;
      const previousRoot =
        previous?.source === "installed"
          ? await this.deps.fs
              .realpath(previous.directory)
              .catch(() => previous.directory)
          : undefined;
      if (
        previous?.source === "installed" &&
        root !== previousRoot &&
        !root.startsWith(previousRoot + path.sep)
      ) {
        try {
          await this.deps.fs.rename(previous.directory, backup);
          moved = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      try {
        await this.commit(next, id);
      } catch (error) {
        if (moved && previous)
          await this.deps.fs.rename(backup, previous.directory);
        throw error;
      }
      if (moved)
        await this.deps.fs
          .rm(backup, { recursive: true, force: true })
          .catch(() => undefined);
      return { ok: true, state: this.state() };
    });
  }
  remove(id: string) {
    return this.serial(async () => {
      assertInstallableThemeId(id);
      const entry = this.has(id) ? this.registry.entries[id] : undefined;
      if (!entry) throw new Error("Unknown theme");
      const next = this.next();
      delete next.entries[id];
      if (next.selection.themeId === id)
        next.selection = {
          themeId: officialThemePackage.manifest.id,
          mode: "light",
        };
      const backup = path.join(this.directory, `.backup-${randomUUID()}`);
      let moved = false;
      if (entry.source === "installed") {
        await this.ensureManagedRoot();
        try {
          await this.deps.fs.rename(entry.directory, backup);
          moved = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      try {
        await this.commit(next, id);
      } catch (error) {
        if (moved) await this.deps.fs.rename(backup, entry.directory);
        throw error;
      }
      if (moved)
        await this.deps.fs
          .rm(backup, { recursive: true, force: true })
          .catch(() => undefined);
      return { ok: true, state: this.state() };
    });
  }
  async openDirectory(id: string) {
    await this.ready;
    const entry = this.has(id) ? this.registry.entries[id] : undefined;
    if (!entry) throw new Error("Builtin or unknown theme");
    return entry.directory;
  }
  async readDirectory(directory: string): Promise<HostThemeFiles> {
    const io = this.deps.fs;
    if (!(await io.lstat(directory)).isDirectory())
      throw new Error("Theme root must be a real directory");
    const root = await io.realpath(directory),
      files: HostThemeFiles = {};
    const pending: {
      rel: string;
      absolute: string;
      stat: Awaited<ReturnType<typeof fs.lstat>>;
    }[] = [];
    let total = 0,
      count = 0;
    const checkPath = async (absolute: string) => {
      const real = await io.realpath(absolute);
      if (!real.startsWith(root + path.sep))
        throw new Error("Theme path escape");
      for (
        let current = absolute;
        current !== root;
        current = path.dirname(current)
      ) {
        if ((await io.lstat(current)).isSymbolicLink())
          throw new Error("Theme symlinks forbidden");
      }
      if (!(await io.lstat(root)).isDirectory())
        throw new Error("Theme root changed");
    };
    const visit = async (relative: string) => {
      for (const name of await io.readdir(path.join(root, relative))) {
        if (name === ".DS_Store" || name === "__MACOSX") continue;
        const rel = relative ? `${relative}/${name}` : name;
        canonicalPath(rel);
        if (++count > limits.files * 2)
          throw new Error("Theme entry count limit");
        const absolute = path.join(root, rel),
          stat = await io.lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error("Theme symlinks forbidden");
        await checkPath(absolute);
        if (stat.isDirectory()) {
          await visit(rel);
          continue;
        }
        if (
          !stat.isFile() ||
          (!/\.(json|css|png|jpe?g|webp|woff2)$/.test(rel) &&
            rel !== "README.md")
        )
          throw new Error("Unsupported theme file");
        total += Number(stat.size);
        if (
          stat.size > limits.fileBytes ||
          total > limits.totalBytes ||
          pending.length >= limits.files
        )
          throw new Error("Theme file size/count limit");
        pending.push({ rel, absolute, stat });
      }
    };
    // Check the complete directory's metadata and limits before reading any contents.
    await visit("");
    for (const { rel, absolute, stat } of pending) {
      await checkPath(absolute);
      const handle = await io.open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      try {
        await checkPath(absolute);
        const actual = await handle.stat();
        if (
          !actual.isFile() ||
          actual.size !== stat.size ||
          actual.dev !== stat.dev ||
          actual.ino !== stat.ino
        )
          throw new Error("Theme changed during read");
        // Bounded reads also protect against a growing file during editing.
        const size = Number(stat.size),
          data = Buffer.alloc(size + 1);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await handle.read(
            data,
            offset,
            data.length - offset,
            offset
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== size) throw new Error("Theme changed during read");
        files[rel] = data.subarray(0, offset).toString("base64");
      } finally {
        await handle.close();
      }
    }
    return validateThemePackage(files).files;
  }
  reload(id: string) {
    return this.serial(() => this.reloadNow(id));
  }
  private async reloadNow(id: string) {
    const entry = this.has(id) ? this.registry.entries[id] : undefined;
    if (!entry) return;
    try {
      const files = await this.readDirectory(entry.directory);
      const pkg = validateThemePackage(files);
      if (pkg.manifest.id !== id) throw new Error("Linked theme ID changed");
      if (
        Object.keys(files).length === Object.keys(entry.files).length &&
        Object.entries(files).every(
          ([name, value]) => entry.files[name] === value
        ) &&
        !this.errors.has(id)
      )
        return;
      const next = this.next();
      next.entries[id].files = files;
      this.normalize(next, id, next.selection.mode);
      await this.commit(next, id);
    } catch (error) {
      this.errors.set(id, message(error));
      const next = this.next();
      next.revision++;
      await this.persist(next).catch(() => undefined);
      this.registry = next;
      this.refreshWatchers();
      this.publish();
    }
  }
  systemChanged() {
    return this.serial(async () => {
      if (this.registry.selection.mode !== "system") return;
      const dark = this.deps.systemDark();
      if (dark === this.systemDark) return;
      this.systemDark = dark;
      this.registry.revision++;
      this.publish();
    });
  }
  private refreshWatchers() {
    for (const off of this.watchers) {
      try {
        off();
      } catch {
        /* continue cleanup */
      }
    }
    this.watchers = [];
    if (this.disposed) return;
    for (const [id, entry] of Object.entries(this.registry.entries)) {
      try {
        this.watchers.push(
          this.deps.watch(entry.directory, () => {
            if (this.disposed) return;
            clearTimeout(this.timers.get(id));
            this.timers.set(
              id,
              setTimeout(() => {
                this.timers.delete(id);
                void this.reload(id).catch(() => undefined);
              }, 200)
            );
          })
        );
      } catch {
        /* retain cache, explicit reload remains possible */
      }
    }
  }
  async dispose() {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const off of this.watchers) {
      try {
        off();
      } catch {
        /* continue cleanup */
      }
    }
    this.watchers = [];
    await this.queue;
    for (const off of this.watchers) {
      try {
        off();
      } catch {
        /* continue cleanup */
      }
    }
    this.watchers = [];
  }
}
export { message as themeError };
