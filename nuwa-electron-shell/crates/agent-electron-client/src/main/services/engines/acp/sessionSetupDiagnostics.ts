/**
 * 会话建立结果的诊断缓冲（进程内，最近若干条），供导出日志时带上。
 *
 * 只记录「出过状况」的建立过程：失败、重建过进程、隔离过 home、恢复变慢。
 * 健康的每次建会话不进缓冲——那类信息在主日志的 [SessionSetup] 摘要里已经有。
 */

export interface SessionSetupDiagnosticRecord {
  at: string;
  engineKey: string;
  projectId?: string;
  sessionId?: string;
  ok: boolean;
  /** 失败原因（ok=false 时） */
  reason?: string;
  /** 未能恢复原会话的原因（降级后仍成功时） */
  fallbackReason?: string;
  setupPath: string;
  loadMs: number | null;
  newAttemptsMs: number[];
  recycled: string[];
  quarantined: boolean;
  slowRestore: boolean;
  breakerOpened: boolean;
  totalMs: number;
  /** 判为卡死时附带的引擎日志尾部（已脱敏） */
  engineLogTail?: string[];
}

export interface SessionSetupDiagnosticsSnapshot {
  generatedAt: string;
  maxRecords: number;
  records: SessionSetupDiagnosticRecord[];
}

export const SESSION_SETUP_DIAGNOSTICS_MAX_RECORDS = 20;

const records: SessionSetupDiagnosticRecord[] = [];

export type SessionSetupDiagnosticInput = Omit<
  SessionSetupDiagnosticRecord,
  "at"
>;

/** 是否值得进诊断缓冲：失败，或者经历过重建/隔离/慢恢复。 */
export function isNotableSessionSetupOutcome(
  input: Pick<
    SessionSetupDiagnosticInput,
    "ok" | "recycled" | "quarantined" | "slowRestore" | "breakerOpened"
  >,
): boolean {
  return (
    !input.ok ||
    input.recycled.length > 0 ||
    input.quarantined ||
    input.slowRestore ||
    input.breakerOpened
  );
}

/** 记录里带数组，浅拷贝挡不住调用方事后改动；入库和出库都各复制一份。 */
function cloneRecord(
  record: SessionSetupDiagnosticRecord,
): SessionSetupDiagnosticRecord {
  return {
    ...record,
    newAttemptsMs: [...record.newAttemptsMs],
    recycled: [...record.recycled],
    engineLogTail: record.engineLogTail ? [...record.engineLogTail] : undefined,
  };
}

export function recordSessionSetupOutcome(
  input: SessionSetupDiagnosticInput,
  now: Date = new Date(),
): void {
  if (!isNotableSessionSetupOutcome(input)) return;
  records.push(cloneRecord({ at: now.toISOString(), ...input }));
  while (records.length > SESSION_SETUP_DIAGNOSTICS_MAX_RECORDS) {
    records.shift();
  }
}

export function getSessionSetupDiagnostics(
  now: Date = new Date(),
): SessionSetupDiagnosticsSnapshot {
  return {
    generatedAt: now.toISOString(),
    maxRecords: SESSION_SETUP_DIAGNOSTICS_MAX_RECORDS,
    records: records.map(cloneRecord),
  };
}

/** 测试用：清空缓冲。 */
export function clearSessionSetupDiagnosticsForTests(): void {
  records.length = 0;
}
