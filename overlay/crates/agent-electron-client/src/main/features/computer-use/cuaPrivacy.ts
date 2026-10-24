import fs from "node:fs";
import path from "node:path";

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const SENSITIVE = /AXSecureTextField|securetextfield|lock.?screen|loginwindow|password.?field/i;

export function cuaScreenshotHome(dataHome: string): string {
  return dataHome;
}

export function isSensitiveObservation(payload: unknown): boolean {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  return SENSITIVE.test(text);
}

export function redactObservationContent<T extends { type: string; text?: string; mimeType?: string }>(
  content: T[],
): T[] {
  if (!content.some((part) => part.type === "image" || part.mimeType?.startsWith("image/") || isSensitiveObservation(part.text)))
    return content;
  return content.map((part) => {
    if (part.type === "image" || part.mimeType?.startsWith("image/")) {
      return { type: "text", text: "Computer Use: sensitive frame withheld (password field or lock screen). Observe a different window." } as T;
    }
    if (typeof part.text === "string" && isSensitiveObservation(part.text)) {
      return { ...part, text: part.text.replace(/data:image\/[a-zA-Z0+/=.-]+/g, "[redacted-screenshot]") };
    }
    return part;
  });
}

export function listLocalScreenshotNames(home: string, io: Pick<typeof fs, "existsSync" | "readdirSync" | "statSync"> = fs): string[] {
  if (!io.existsSync(home)) return [];
  const names: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || names.length >= 80) return;
    for (const entry of io.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(full, depth + 1);
      else if (entry.isFile() && IMAGE.test(entry.name)) names.push(path.relative(home, full));
      if (names.length >= 80) return;
    }
  };
  walk(home, 0);
  return names.sort();
}

/** 任务结束后清掉超过 maxAgeMs 的本机截图；默认 24h。 */
export function cleanupStaleScreenshots(
  home: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
  io: Pick<typeof fs, "existsSync" | "readdirSync" | "statSync" | "rmSync"> = fs,
): number {
  if (!io.existsSync(home)) return 0;
  let removed = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of io.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(full, depth + 1);
      else if (entry.isFile() && IMAGE.test(entry.name)) {
        const age = now - io.statSync(full).mtimeMs;
        if (age >= maxAgeMs) {
          io.rmSync(full, { force: true });
          removed++;
        }
      }
    }
  };
  walk(home, 0);
  return removed;
}
