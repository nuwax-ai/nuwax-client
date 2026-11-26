import path from "node:path";
import { createWriteStream } from "node:fs";
import {
  lstat,
  open,
  opendir,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";

/** 日志目录之外要一并打包的条目（如引擎日志、诊断摘要）。 */
export interface LogArchiveExtra {
  /** ZIP 内路径（相对包根，不带前导斜杠） */
  name: string;
  /** 直接写入的内容（与 source 二选一） */
  content?: Buffer;
  /** 要打包的文件；给了 tailBytes 且文件更大时只取末尾 */
  source?: string;
  tailBytes?: number;
}

function isSafeArchiveName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith("/") &&
    !/^[A-Za-z]:/.test(name) &&
    !name.split("/").some((segment) => segment === "" || segment === "..")
  );
}

async function appendExtra(
  archive: ZipArchive,
  extra: LogArchiveExtra,
): Promise<void> {
  if (!isSafeArchiveName(extra.name)) {
    throw new Error(`Unsafe archive entry name: ${extra.name}`);
  }
  if (extra.content) {
    archive.append(extra.content, { name: extra.name });
    return;
  }
  if (!extra.source) return;
  // 附加条目是锦上添花：读不到就跳过，不能因此让整份主日志导不出
  try {
    await appendExtraFile(archive, extra.source, extra.name, extra.tailBytes);
  } catch {
    // 见上
  }
}

async function appendExtraFile(
  archive: ZipArchive,
  source: string,
  name: string,
  tailBytes?: number,
): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(source);
  } catch {
    // 收集之后、打包之前被清掉：跳过
    return;
  }
  // 只带普通文件；链接的目标可能在日志目录之外
  if (!stat.isFile()) return;
  if (tailBytes && stat.size > tailBytes) {
    const length = tailBytes;
    const buffer = Buffer.alloc(length);
    const handle = await open(source, "r");
    try {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        length,
        stat.size - length,
      );
      archive.append(buffer.subarray(0, bytesRead), {
        name,
        mode: stat.mode,
        date: stat.mtime,
      });
    } finally {
      await handle.close();
    }
    return;
  }
  archive.file(source, {
    name,
    mode: stat.mode,
    date: stat.mtime,
  });
}

/** 流式压缩日志目录（可附加日志目录之外的条目）；成功后才替换目标文件，符号链接只归档链接本身。 */
export async function exportLogArchive(
  source: string,
  destination: string,
  extras: LogArchiveExtra[] = [],
): Promise<void> {
  const root = await realpath(source);
  const parent = await realpath(path.dirname(destination));
  destination = path.join(parent, path.basename(destination));
  const relative = path.relative(root, destination);
  // 防止覆盖源日志，以及把正在写入的 ZIP 或历史导出包再次打进日志包。
  if (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  ) {
    throw new Error("Save the log archive outside the logs directory");
  }

  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const completion = pipeline(archive, output);
  // 输出错误可能早于目录遍历结束，立即接住拒绝，随后统一收尾。
  void completion.catch(() => undefined);
  archive.on("warning", (error: Error) => archive.destroy(error));

  const visit = async (directory: string, name: string): Promise<void> => {
    const info = await lstat(directory);
    archive.append(Buffer.alloc(0), {
      name: `${name}/`,
      mode: info.mode,
      date: info.mtime,
    });
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const entryName = `${name}/${entry.name}`;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        archive.symlink(entryName, await readlink(absolute), stat.mode);
      } else if (stat.isDirectory()) {
        await visit(absolute, entryName);
      } else if (stat.isFile()) {
        archive.file(absolute, {
          name: entryName,
          mode: stat.mode,
          date: stat.mtime,
        });
      }
    }
  };

  try {
    await visit(root, "logs");
    for (const extra of extras) {
      await appendExtra(archive, extra);
    }
    await Promise.all([archive.finalize(), completion]);
    await rename(temporary, destination);
  } catch (error) {
    archive.destroy(
      error instanceof Error ? error : new Error("Log archive failed"),
    );
    output.destroy();
    await completion.catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}
