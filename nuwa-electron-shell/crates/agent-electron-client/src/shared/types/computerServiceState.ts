/** 宿主服务状态只提示补拉电脑列表；在线候选仍由后端列表接口决定。 */
export interface ComputerServiceStateCommand {
  type: "computer-service-state";
  phase: string;
  sandboxId?: string;
}

/** reg/v2 的 SandboxConfigDto.id 与 select/list 的 sandboxId 是同一配置主键。 */
export function normalizeComputerSandboxId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return undefined;
  const normalized = value.replace(/^0+/, "");
  return normalized || undefined;
}

/** 拣出协议字段，禁止错误对象、注册凭据等随状态广播或晚订阅重播。 */
export function parseComputerServiceStateCommand(
  value: unknown,
): ComputerServiceStateCommand | null {
  if (!value || typeof value !== "object") return null;
  const command = value as Record<string, unknown>;
  if (command.type !== "computer-service-state" ||
      typeof command.phase !== "string" || !/^[a-z][a-z-]*$/.test(command.phase)) {
    return null;
  }
  const sandboxId = typeof command.sandboxId === "string"
    ? normalizeComputerSandboxId(command.sandboxId) : undefined;
  if (command.sandboxId !== undefined && sandboxId === undefined) return null;
  return {
    type: "computer-service-state",
    phase: command.phase,
    ...(sandboxId === undefined ? {} : { sandboxId }),
  };
}
