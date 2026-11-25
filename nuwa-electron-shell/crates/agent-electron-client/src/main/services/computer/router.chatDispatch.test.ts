/**
 * handleComputerChat — promptDispatched 与 project session registry 守卫
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import type { AcpChatHttpResult } from "@shared/types/computerTypes";

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../bootstrap/logConfig", () => ({
  getPerfLogger: () => ({ info: vi.fn() }),
}));

vi.mock("../engines/perf/firstTokenTrace", () => ({
  firstTokenTrace: { trace: vi.fn() },
}));

vi.mock("../startupPorts", () => ({
  getConfiguredPorts: () => ({ fileServer: 18080, computer: 60006 }),
}));

vi.mock("../packages/fileServerHealth", () => ({
  checkFileServerHealth: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("./devcomputerAutoReload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./devcomputerAutoReload")>()),
  shouldAutoReload: vi.fn(() => false),
  reloadEngineForRequest: vi.fn(),
  attachReloadedToChatResult: vi.fn((result: unknown) => result),
}));

vi.mock("./ensureChatSessionId", () => ({
  ensureSessionIdFromRegistry: vi.fn(),
}));

vi.mock("./closeStaleSseForChat", () => ({
  closeStaleSseBeforeChat: vi.fn(),
}));

const mockEnsureEngine = vi.fn();
const mockChat = vi.fn();

vi.mock("../engines/unifiedAgent", () => ({
  agentService: {
    isReady: true,
    ensureEngineForRequest: (...args: unknown[]) => mockEnsureEngine(...args),
  },
}));

const mockRememberProjectSession = vi.fn();
vi.mock("./projectSessionRegistry", () => ({
  rememberProjectSession: (...args: unknown[]) =>
    mockRememberProjectSession(...args),
}));

const mockBindSessionFirstTokenContext = vi.fn();
vi.mock("./sseManager", () => ({
  bindSessionFirstTokenContext: (...args: unknown[]) =>
    mockBindSessionFirstTokenContext(...args),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

import * as fs from "fs";
import { handleComputerChat, handleRequest } from "./router";
import { chatDispatchCoordinator } from "./chatDispatchCoordinator";
import { sessionSetupRecoveryState } from "../engines/acp/acpSessionRecovery";

function mockResponse(): ServerResponse & { body?: string } {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(function (this: { body?: string }, chunk?: string) {
      this.body = chunk;
    }),
  } as unknown as ServerResponse & { body?: string };
  return res;
}

const baseChatBody = {
  user_id: "6",
  project_id: "proj-router-001",
  session_id: "ses_router_test",
  request_id: "rid-router-001",
  prompt: "hello",
};

describe("retired Computer routes", () => {
  it.each([
    "/computer/gui-agent/vision-model",
    "/computer/gui-agent/displays",
    "/computer/gui-agent/display",
    "/unknown",
  ])("completes %s with the standard 404 response", async (url) => {
    const res = mockResponse();
    await handleRequest(
      { url, method: "GET", headers: {} } as IncomingMessage,
      res,
    );
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    expect(JSON.parse(res.body!)).toMatchObject({
      code: "NOT_FOUND",
      success: false,
    });
  });
});

describe("handleComputerChat promptDispatched", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatDispatchCoordinator.reset();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockEnsureEngine.mockResolvedValue({
      engineName: "nuwaxcode",
      chat: mockChat,
    });
  });

  it("promptDispatched false 时不更新 project session registry", async () => {
    mockChat.mockResolvedValue({
      code: "0000",
      message: "success",
      data: {
        project_id: "proj-router-001",
        session_id: "ses_superseded",
        request_id: "rid-router-001",
      },
      tid: null,
      success: true,
      promptDispatched: false,
    } satisfies AcpChatHttpResult);

    const res = mockResponse();
    await handleComputerChat(
      {} as IncomingMessage,
      res,
      { ...baseChatBody },
      "computer",
    );

    expect(mockRememberProjectSession).not.toHaveBeenCalled();
    expect(mockBindSessionFirstTokenContext).not.toHaveBeenCalled();
  });

  it("promptDispatched true 时更新 registry 与 first-token 上下文", async () => {
    mockChat.mockResolvedValue({
      code: "0000",
      message: "success",
      data: {
        project_id: "proj-router-001",
        session_id: "ses_dispatched",
        request_id: "rid-router-001",
      },
      tid: null,
      success: true,
      promptDispatched: true,
    } satisfies AcpChatHttpResult);

    const res = mockResponse();
    await handleComputerChat(
      {} as IncomingMessage,
      res,
      { ...baseChatBody },
      "computer",
    );

    expect(mockRememberProjectSession).toHaveBeenCalledWith(
      "proj-router-001",
      "ses_dispatched",
    );
    expect(mockBindSessionFirstTokenContext).toHaveBeenCalledWith(
      "ses_dispatched",
      expect.objectContaining({
        requestId: "rid-router-001",
        projectId: "proj-router-001",
        engine: "nuwaxcode",
      }),
    );
  });

  it("HTTP JSON 响应不包含 promptDispatched 内部字段", async () => {
    mockChat.mockResolvedValue({
      code: "0000",
      message: "success",
      data: {
        project_id: "proj-router-001",
        session_id: "ses_dispatched",
        request_id: "rid-router-001",
      },
      tid: null,
      success: true,
      promptDispatched: true,
    } satisfies AcpChatHttpResult);

    const res = mockResponse();
    await handleComputerChat(
      {} as IncomingMessage,
      res,
      { ...baseChatBody },
      "computer",
    );

    expect(res.body).toBeDefined();
    const parsed = JSON.parse(res.body!);
    expect(parsed.promptDispatched).toBeUndefined();
    expect(parsed.data.session_id).toBe("ses_dispatched");
  });
});

describe("handleComputerChat session setup（session-setup-ha）", () => {
  const successResult: AcpChatHttpResult = {
    code: "0000",
    message: "success",
    data: {
      project_id: "proj-router-001",
      session_id: "ses_dispatched",
      request_id: "rid-router-001",
    },
    tid: null,
    success: true,
    promptDispatched: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    chatDispatchCoordinator.reset();
    sessionSetupRecoveryState.reset();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockEnsureEngine.mockResolvedValue({
      engineName: "nuwaxcode",
      chat: mockChat,
    });
    mockChat.mockResolvedValue(successResult);
  });

  afterEach(() => {
    sessionSetupRecoveryState.reset();
  });

  it("熔断期内直接返回结构化失败，不建引擎、不进 chat", async () => {
    sessionSetupRecoveryState.openBreaker(
      "proj-router-001",
      "engine_env_hang",
      Date.now(),
    );

    const res = mockResponse();
    await handleComputerChat(
      {} as IncomingMessage,
      res,
      { ...baseChatBody },
      "computer",
    );

    expect(mockEnsureEngine).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
    const parsed = JSON.parse(res.body!);
    expect(parsed).toMatchObject({
      code: "5000",
      success: false,
      data: {
        project_id: "proj-router-001",
        session_id: "ses_router_test",
        request_id: "rid-router-001",
        fallback_reason: "engine_env_hang",
      },
    });
    expect(parsed.data.error).toBe(parsed.message);
    expect(parsed.data.need_fallback).toBeUndefined();
  });

  it("熔断过期后恢复正常分发", async () => {
    sessionSetupRecoveryState.openBreaker(
      "proj-router-001",
      "engine_env_hang",
      Date.now() - 6 * 60_000,
    );

    const res = mockResponse();
    await handleComputerChat(
      {} as IncomingMessage,
      res,
      { ...baseChatBody },
      "computer",
    );

    expect(mockEnsureEngine).toHaveBeenCalledTimes(1);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.body!).success).toBe(true);
  });

  it("引擎初始化超时按会话建立失败返回 engine_init_timeout", async () => {
    mockEnsureEngine.mockRejectedValue(
      new Error(
        "Failed to create engine for project proj-router-001: handshake timed out after 10000ms",
      ),
    );

    const res = mockResponse();
    await handleComputerChat(
      {} as IncomingMessage,
      res,
      { ...baseChatBody },
      "computer",
    );

    const parsed = JSON.parse(res.body!);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(parsed).toMatchObject({
      code: "5000",
      success: false,
      data: { fallback_reason: "engine_init_timeout", reloaded: false },
    });
    expect(parsed.data.error).toBe(parsed.message);
    expect(parsed.message).not.toContain("handshake timed out");
  });

  it("引擎初始化的其他错误维持原有信封", async () => {
    mockEnsureEngine.mockRejectedValue(
      new Error("Workspace directory does not exist: /missing"),
    );

    const res = mockResponse();
    await handleComputerChat(
      {} as IncomingMessage,
      res,
      { ...baseChatBody },
      "computer",
    );

    const parsed = JSON.parse(res.body!);
    expect(parsed).toMatchObject({
      code: "5000",
      success: false,
      message: "Workspace directory does not exist: /missing",
    });
    expect(parsed.data?.fallback_reason).toBeUndefined();
  });

  it("把进入 handler 的时刻传给 chat，作为恢复链路总时限的起点", async () => {
    const before = Date.now();

    const res = mockResponse();
    await handleComputerChat(
      {} as IncomingMessage,
      res,
      { ...baseChatBody },
      "computer",
    );

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "proj-router-001" }),
      expect.anything(),
      { chainStartedAtMs: expect.any(Number) },
    );
    const startedAt = mockChat.mock.calls[0][2].chainStartedAtMs as number;
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
  });
});
