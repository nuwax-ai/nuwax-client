/** ACP engine families determine configuration and prompt retry behavior. */
export type AcpEngineFamily = "opencode-acp" | "claude-code-acp" | "unknown";

const OPENCODE_ENGINE_IDS = new Set(["nuwaxcode", "codex-cli", "opencode"]);
const CLAUDE_CODE_ENGINE_IDS = new Set(["claude-code", "claude-code-acp-ts"]);

export function getAcpEngineProfile(engineId: string) {
  const family: AcpEngineFamily = OPENCODE_ENGINE_IDS.has(engineId)
    ? "opencode-acp"
    : CLAUDE_CODE_ENGINE_IDS.has(engineId)
      ? "claude-code-acp"
      : "unknown";
  return {
    family,
    usesOpencodeSpawnConfig: family === "opencode-acp",
    usesOpencodePromptBehaviors: family === "opencode-acp",
  } as const;
}

export function isOpencodeAcpEngine(engineId: string): boolean {
  return getAcpEngineProfile(engineId).family === "opencode-acp";
}
