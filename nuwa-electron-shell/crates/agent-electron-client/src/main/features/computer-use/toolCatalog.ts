import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

export type CuaTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
const exec = promisify(execFile);
let cached: { key: string; value: Promise<CuaTool[]> } | undefined;

/** Inspect the shipped protocol without starting a daemon, GUI or permission gate. */
export function readCuaToolCatalog(executable: string): Promise<CuaTool[]> {
  const stat = fs.statSync(executable);
  const key = `${executable}:${stat.size}:${stat.mtimeMs}`;
  if (cached?.key === key) return cached.value;
  const value = exec(executable, ["dump-docs", "--type", "mcp"], {
    timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" },
  }).then(({ stdout }) => {
    const doc = JSON.parse(stdout);
    if (typeof doc.version !== "string" || !Array.isArray(doc.tools) || !doc.tools.length || doc.tools.length > 512) throw new Error("helperProtocolInvalid");
    return doc.tools.map((tool: Record<string, unknown>) => {
      if (typeof tool.name !== "string" || !tool.input_schema || typeof tool.input_schema !== "object" || Array.isArray(tool.input_schema))
        throw new Error("helperProtocolInvalid");
      return { name: tool.name, description: typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: tool.input_schema as Record<string, unknown> };
    });
  });
  cached = { key, value };
  void value.catch(() => { if (cached?.value === value) cached = undefined; });
  return value;
}
