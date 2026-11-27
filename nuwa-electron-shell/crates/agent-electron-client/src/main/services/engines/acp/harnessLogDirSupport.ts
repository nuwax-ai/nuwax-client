/**
 * 适配器对 `NUWAX_HARNESS_LOG_DIR` 的支持判断。
 *
 * 适配器会把该变量转成 `-c log_dir=<dir>` 传给引擎；更早的版本不认识它，
 * 变量会被静默忽略，引擎日志仍写进每个项目隔离的 `CODEX_HOME`。
 * 客户端据此在启动时提示一次，避免"配了但没生效"没人发现。
 */

/** 首个消费 `NUWAX_HARNESS_LOG_DIR` 的适配器版本（`HarnessLogDir.ts` 随该版本发布）。 */
export const HARNESS_LOG_DIR_MIN_ADAPTER_VERSION = "1.2.59";

type Version = [number, number, number];

/**
 * 解析 `x.y.z` 的核心版本号，忽略预发布后缀与构建元数据。
 *
 * 无法解析时返回 null：宁可当作"不支持"（提示一次），也不假装能力已就位。
 */
export function parseAdapterVersion(version: string | null | undefined): Version | null {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec((version ?? "").trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 适配器是否会把 `NUWAX_HARNESS_LOG_DIR` 传给引擎。 */
export function adapterSupportsHarnessLogDir(version: string | null | undefined): boolean {
    const actual = parseAdapterVersion(version);
    const minimum = parseAdapterVersion(HARNESS_LOG_DIR_MIN_ADAPTER_VERSION);
    if (!actual || !minimum) return false;
    for (let index = 0; index < minimum.length; index += 1) {
        if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
    }
    return true;
}
