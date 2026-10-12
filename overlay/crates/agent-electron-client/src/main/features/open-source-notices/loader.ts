/**
 * 声明数据加载器：从随包目录读取 `third-party-notices.json` 与许可证全文。
 *
 * - 候选目录按顺序找，第一个含声明文件的目录生效（打包态 / 开发态 / 环境变量覆盖）；
 * - 数据按不可信输入校验形状，坏数据返回 null，不抛错；
 * - 许可证全文路径必须是 `licenses/<安全文件名>.txt` 且属于某个已知组件，杜绝路径穿越；
 * - 全文有大小上限。
 */

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import type { NoticeComponent, NoticesDocument } from "@shared/features/open-source-notices/contract";

const NOTICES_FILE = "third-party-notices.json";
const SAFE_LICENSE_PATH = /^licenses\/[A-Za-z0-9._-]+\.txt$/;
const MAX_LICENSE_BYTES = 1024 * 1024;

export interface NoticesFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  statSync(path: string): { size: number };
}

export interface NoticesLoader {
  load(): NoticesDocument | null;
  licenseText(id: string): string | null;
}

const isString = (v: unknown): v is string => typeof v === "string";
const nullableString = (v: unknown): v is string | null | undefined =>
  v === null || v === undefined || typeof v === "string";

function parseComponent(raw: unknown): NoticeComponent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (!isString(c.id) || !isString(c.name)) return null;
  if (!nullableString(c.version) || !nullableString(c.license)) return null;
  if (!nullableString(c.homepage) || !nullableString(c.sourceUrl) || !nullableString(c.licenseText)) return null;
  const kind = c.kind === "npm" || c.kind === "binary" || c.kind === "framework" ? c.kind : null;
  if (!kind) return null;
  return {
    id: c.id,
    name: c.name,
    version: (c.version as string | null | undefined) ?? null,
    kind,
    usedBy: isString(c.usedBy) ? c.usedBy : "core",
    license: (c.license as string | null | undefined) ?? null,
    homepage: (c.homepage as string | null | undefined) ?? null,
    sourceUrl: (c.sourceUrl as string | null | undefined) ?? null,
    modified: c.modified === true,
    licenseText: (c.licenseText as string | null | undefined) ?? null,
    notes: nullableString(c.notes) ? ((c.notes as string | null | undefined) ?? null) : null,
  };
}

export function createNoticesLoader(
  candidateDirs: readonly string[],
  fs: NoticesFs = nodeFs,
): NoticesLoader {
  let cached: { dir: string; doc: NoticesDocument } | null | undefined;

  const load = (): { dir: string; doc: NoticesDocument } | null => {
    if (cached !== undefined) return cached;
    cached = null;
    for (const dir of candidateDirs) {
      const file = nodePath.join(dir, NOTICES_FILE);
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: unknown; components?: unknown };
        if (typeof raw.schema !== "number" || !Array.isArray(raw.components)) continue;
        const components = raw.components
          .map(parseComponent)
          .filter((c): c is NoticeComponent => c !== null);
        cached = { dir, doc: { schema: raw.schema, components } };
        return cached;
      } catch {
        continue;
      }
    }
    return cached;
  };

  return {
    load: () => load()?.doc ?? null,
    licenseText(id) {
      const loaded = load();
      if (!loaded) return null;
      const component = loaded.doc.components.find((c) => c.id === id);
      const rel = component?.licenseText;
      if (!rel || !SAFE_LICENSE_PATH.test(rel)) return null;
      const file = nodePath.join(loaded.dir, rel);
      try {
        if (!fs.existsSync(file) || fs.statSync(file).size > MAX_LICENSE_BYTES) return null;
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
  };
}
