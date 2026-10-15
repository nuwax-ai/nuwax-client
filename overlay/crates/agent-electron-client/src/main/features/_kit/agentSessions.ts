/**
 * Agent 会话参与者：特性在 Agent 引擎的会话生命周期上挂接能力（如为会话签发独立凭据），
 * 引擎只认识这里的组合对象，不认识任何具体特性。
 *
 * 参与者在每次调用时按当前注册表惰性解析：引擎可能先于特性注册构造，不能在构造时定型。
 * 未启用的特性保留的 MCP 条目会在会话建立前剥离，避免引擎绕过宿主直连旧配置。
 */

export type AgentMcpServer = {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
};

export interface AgentSessionPreparation {
  bind(sessionId: string): void;
  cancel(): void;
}

export interface AgentSessionParticipant {
  /** 可原地改写 servers（替换或移除本特性的条目）。 */
  prepare(servers: AgentMcpServer[]): AgentSessionPreparation;
  /** 开始一轮 prompt；返回 0 表示本轮不参与。 */
  start(sessionId: string): number;
  finish(sessionId: string, turn: number, cancelled: boolean): void;
  cancel(sessionId: string): void;
  remove(sessionId: string): void;
  destroy(): void;
}

export interface AgentTurn {
  /** 本轮是否有任何参与者在场。 */
  readonly active: boolean;
  readonly turns: ReadonlyMap<string, number>;
}

export interface AgentSessions {
  setup<T>(servers: AgentMcpServer[], work: () => Promise<T>, sessionId: (result: T) => string): Promise<T>;
  start(sessionId: string): AgentTurn;
  finish(sessionId: string, turn: AgentTurn, cancelled?: boolean): void;
  cancel(sessionId: string): void;
  remove(sessionId: string): void;
  destroy(): void;
}

export interface AgentSessionSource {
  /** 当前已注册特性提供的参与者工厂（按注册表顺序）。 */
  factories(): ReadonlyMap<string, () => AgentSessionParticipant>;
  /** 未启用特性保留的 MCP 条目名。 */
  reservedInactive(): ReadonlySet<string>;
}

export function createAgentSessions(source: AgentSessionSource): AgentSessions {
  const instances = new Map<string, AgentSessionParticipant>();
  const participants = () => {
    for (const [featureId, factory] of source.factories()) {
      if (!instances.has(featureId)) instances.set(featureId, factory());
    }
    return [...instances.entries()];
  };

  return {
    async setup(servers, work, sessionId) {
      const reserved = source.reservedInactive();
      for (let index = servers.length - 1; index >= 0; index--) {
        if (reserved.has(servers[index].name)) servers.splice(index, 1);
      }
      const prepared: AgentSessionPreparation[] = [];
      try {
        for (const [, participant] of participants()) prepared.push(participant.prepare(servers));
        const result = await work();
        const id = sessionId(result);
        for (const item of prepared) item.bind(id);
        return result;
      } catch (error) {
        for (const item of prepared) item.cancel();
        throw error;
      }
    },
    start(sessionId) {
      const turns = new Map<string, number>();
      for (const [featureId, participant] of participants()) {
        const turn = participant.start(sessionId);
        if (turn) turns.set(featureId, turn);
      }
      return { active: turns.size > 0, turns };
    },
    finish(sessionId, turn, cancelled = false) {
      for (const [featureId, value] of turn.turns) instances.get(featureId)?.finish(sessionId, value, cancelled);
    },
    cancel(sessionId) {
      for (const participant of instances.values()) participant.cancel(sessionId);
    },
    remove(sessionId) {
      for (const participant of instances.values()) participant.remove(sessionId);
    },
    destroy() {
      for (const participant of instances.values()) participant.destroy();
      instances.clear();
    },
  };
}
