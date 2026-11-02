import { describe, expect, it } from "vitest";
import { getAcpEngineProfile, isOpencodeAcpEngine } from "./engineProfile";

describe("ACP engine profiles", () => {
  it.each(["nuwaxcode", "codex-cli", "opencode"])(
    "keeps OpenCode configuration and prompt behavior for %s",
    (engine) => {
      expect(getAcpEngineProfile(engine)).toMatchObject({
        family: "opencode-acp",
        usesOpencodeSpawnConfig: true,
        usesOpencodePromptBehaviors: true,
      });
    },
  );
  it.each(["claude-code", "claude-code-acp-ts", "__custom_agent__"])(
    "does not inject OpenCode configuration for %s",
    (engine) => {
      expect(isOpencodeAcpEngine(engine)).toBe(false);
      expect(getAcpEngineProfile(engine).usesOpencodePromptBehaviors).toBe(
        false,
      );
    },
  );
});
