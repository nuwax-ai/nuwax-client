/**
 * NUWAX_/CODEX_ 环境变量别名的收敛工具。
 *
 * 适配器与 harness 的 `resolveEnvAlias` 在两种拼写同时存在、取值不同时会直接
 * 报错；客户端把某个 env 改成 NUWAX_ 拼写时，必须同时清掉遗留的 CODEX_ 版本，
 * 否则用户/后端残留的旧拼写会让引擎启动失败（2026-11-09 review P1）。
 */

/** 读取并清除一对别名，返回当前生效值（NUWAX_ 优先）。 */
export function takeAliasedEnv(
  env: Record<string, string>,
  name: string,
): string | undefined {
  const nuwax = `NUWAX_${name}`;
  const codex = `CODEX_${name}`;
  const value = env[nuwax] ?? env[codex];
  delete env[nuwax];
  delete env[codex];
  return value;
}


export interface CodexRouteSources {
  /** 请求里显式下发的 base url / api key。 */
  configBaseUrl?: string;
  configApiKey?: string;
  /** 进程/应用环境里的 OPENAI_BASE_URL / OPENAI_API_KEY（合并前捕获）。 */
  envBaseUrl?: string;
  envApiKey?: string;
  /** 后端经 agent_config.env 下发的 OPENAI_* 对（与进程环境分开捕获）。 */
  backendEnvBaseUrl?: string;
  backendEnvApiKey?: string;
  /** 后端经 agent_config.env 下发的别名值（已收敛过拼写）。 */
  backendBaseUrl?: string;
  backendApiKey?: string;
}

export interface CodexRoute {
  baseUrl?: string;
  apiKey?: string;
  /** 端点与凭据取自同一来源，便于日志与测试断言。 */
  source: "env" | "config" | "backend" | "none";
}

/**
 * 让 base url 与 api key 来自同一路由。
 *
 * 历史优先级是 OPENAI_BASE_URL → config.baseUrl，凭据却是 config.apiKey 优先；
 * 两者同时存在且指向不同端点时，凭据会被配到别的端点上（2026-11-09 review）。
 * 这里保持 URL 的既有优先级，只把凭据绑定到 URL 的来源。
 */
export function resolveCodexRoute(sources: CodexRouteSources): CodexRoute {
  const candidates: CodexRoute[] = [
    {baseUrl: sources.envBaseUrl, apiKey: sources.envApiKey, source: "env"},
    {baseUrl: sources.configBaseUrl, apiKey: sources.configApiKey, source: "config"},
    {baseUrl: sources.backendEnvBaseUrl, apiKey: sources.backendEnvApiKey, source: "backend"},
    {baseUrl: sources.backendBaseUrl, apiKey: sources.backendApiKey, source: "backend"},
  ].filter(candidate => candidate.baseUrl !== undefined) as CodexRoute[];

  // A key belongs to its own endpoint only. Borrowing a key from another
  // source would send one gateway's credential to another gateway
  // (2026-11-09 review P1), so prefer a complete pair and fall back to the
  // first URL without a key: that route then authenticates by its own rules
  // (or fails loudly) instead of leaking the credential.
  const complete = candidates.find(candidate => candidate.apiKey !== undefined);
  if (complete !== undefined) return complete;
  if (candidates.length > 0) return candidates[0];

  // No endpoint at all: the key can only be used against the engine default.
  return {
    apiKey: sources.configApiKey ?? sources.backendApiKey ?? sources.envApiKey,
    source: "none",
  };
}
