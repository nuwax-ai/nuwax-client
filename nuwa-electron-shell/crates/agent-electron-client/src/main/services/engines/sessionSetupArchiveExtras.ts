/**
 * 「导出日志」时在日志目录之外一并打包的诊断条目。
 *
 * - diagnostics/session-setup.json：会话建立出过状况的最近记录（失败、重建、隔离、慢恢复）。
 * - engine-logs/…/opencode.log：各引擎 home 里的引擎日志尾部。nuwaxcode 1.17.11 不读
 *   OPENCODE_LOG_DIR，这份日志不在 <appData>/logs 下，而会话建立卡死时最需要看它。
 *
 * 放在 engines 层而不是 utils：它要读引擎侧的诊断缓冲和引擎日志，
 * utils 不应该反过来依赖 engines。
 */

import type { LogArchiveExtra } from "../utils/logArchive";
import {
  ENGINE_LOG_EXPORT_TAIL_BYTES,
  collectEngineLogFiles,
  type EngineLogFile,
} from "./acp/engineLogCollector";
import {
  getSessionSetupDiagnostics,
  type SessionSetupDiagnosticsSnapshot,
} from "./acp/sessionSetupDiagnostics";

export const SESSION_SETUP_DIAGNOSTICS_ENTRY = "diagnostics/session-setup.json";

export function buildDiagnosticArchiveExtras(deps: {
  diagnostics?: SessionSetupDiagnosticsSnapshot;
  engineLogFiles?: EngineLogFile[];
  tailBytes?: number;
} = {}): LogArchiveExtra[] {
  const diagnostics = deps.diagnostics ?? getSessionSetupDiagnostics();
  const engineLogFiles = deps.engineLogFiles ?? collectEngineLogFiles();
  const tailBytes = deps.tailBytes ?? ENGINE_LOG_EXPORT_TAIL_BYTES;
  return [
    {
      name: SESSION_SETUP_DIAGNOSTICS_ENTRY,
      content: Buffer.from(JSON.stringify(diagnostics, null, 2), "utf8"),
    },
    ...engineLogFiles.map((file) => ({
      name: file.archiveName,
      source: file.source,
      tailBytes,
    })),
  ];
}
