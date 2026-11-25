#!/usr/bin/env node
/**
 * 延迟应答 initialize 的最小 MCP stdio 服务（NDJSON JSON-RPC）。
 *
 * 用法：node slow-mcp-server.mjs <延迟毫秒>
 * 用来复现「MCP 冷启动很慢」：nuwaxcode 的 session/load 与 session/new 都要等
 * MCP 服务连上才返回，所以宿主侧的恢复超时必须覆盖这段延迟。
 */

import readline from "node:readline";

const delayMs = Number(process.argv[2] ?? 20_000);

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return; // 通知不需要应答
    if (message.method === "initialize") {
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
            capabilities: {},
            serverInfo: { name: "slow-mcp", version: "0.0.1" },
          },
        });
      }, delayMs);
      return;
    }
    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  });
