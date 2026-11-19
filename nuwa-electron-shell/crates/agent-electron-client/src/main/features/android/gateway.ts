import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { AndroidController } from "./controller";

export const ANDROID_RELAY = `
const fs=require('node:fs'),net=require('node:net');
const s=net.connect({host:'127.0.0.1',port:Number(process.env.NUWAX_ANDROID_PORT)});
s.on('connect',()=>{s.write(JSON.stringify({token:fs.readFileSync(process.env.NUWAX_ANDROID_KEY,'utf8'),grant:process.env.NUWAX_ANDROID_SESSION?fs.readFileSync(process.env.NUWAX_ANDROID_SESSION,'utf8'):undefined})+'\\n');process.stdin.pipe(s);s.pipe(process.stdout);});
s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end());
`;
const observationId = {
  type: "string",
  description:
    "Exact observationId from your most recent screenshot (valid for 30 seconds and one action).",
};
const coordinate = {
  type: "integer",
  minimum: 0,
  description: "Pixel coordinate in the original screenshot.",
};
const schema = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
export const ANDROID_TOOLS = [
  {
    name: "android_screenshot",
    description:
      "Observe the Android phone explicitly selected by the user. Returns its original PNG, dimensions and observationId. Never unlock the phone or bypass device authorization. Stop if the user takes over.",
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "android_tap",
    description:
      "Tap a pixel observed in your most recent phone screenshot. Requires a new screenshot after each action. Do not retry uncertain writes automatically.",
    inputSchema: schema({ observationId, x: coordinate, y: coordinate }),
  },
  {
    name: "android_swipe",
    description:
      "Swipe on the selected phone, using original screenshot pixels.",
    inputSchema: schema(
      {
        observationId,
        x: coordinate,
        y: coordinate,
        endX: coordinate,
        endY: coordinate,
        durationMs: { type: "integer", minimum: 100, maximum: 2000 },
      },
      ["observationId", "x", "y", "endX", "endY"],
    ),
  },
  {
    name: "android_key",
    description:
      "Press Back, Home or Recent apps on the selected phone. No arbitrary key codes or unlocking.",
    inputSchema: schema({
      observationId,
      key: { type: "string", enum: ["BACK", "HOME", "APP_SWITCH"] },
    }),
  },
  {
    name: "android_type_text",
    description:
      "Type printable ASCII text into the field you observed and focused. Unicode/Chinese input and the literal sequence %s are unsupported; do not submit automatically.",
    inputSchema: schema({
      observationId,
      text: { type: "string", minLength: 1, maxLength: 1000 },
    }),
  },
];

export class AndroidGateway {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  constructor(
    private controller: AndroidController,
    private owner: (grant: string) => string | null | undefined,
  ) {}
  async listen(token: string) {
    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      let buffer = "",
        authenticated = false,
        grant = "";
      const boundOwner = () => (grant ? this.owner(grant) : null);
      const pending = new Set<string | number>();
      const authTimer = setTimeout(() => socket.destroy(), 5000);
      authTimer.unref();
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      socket.on("close", () => {
        clearTimeout(authTimer);
        this.sockets.delete(socket);
        const owner = boundOwner();
        if (owner) this.controller.cancel(owner);
      });
      const send = (data: unknown) => {
        if (!socket.destroyed) socket.write(JSON.stringify(data) + "\n");
      };
      const handle = async (raw: string) => {
        let rpc: Record<string, any>;
        try {
          rpc = JSON.parse(raw);
          if (!rpc || typeof rpc !== "object" || Array.isArray(rpc))
            throw Error();
        } catch {
          socket.destroy();
          return;
        }
        if (!authenticated) {
          const supplied =
            typeof rpc.token === "string"
              ? Buffer.from(rpc.token)
              : Buffer.alloc(0);
          const expected = Buffer.from(token);
          if (
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected)
          ) {
            socket.destroy();
            return;
          }
          if (rpc.grant !== undefined) {
            grant = typeof rpc.grant === "string" ? rpc.grant : "";
            if (!grant || this.owner(grant) === undefined) {
              socket.destroy();
              return;
            }
          }
          authenticated = true;
          clearTimeout(authTimer);
          return;
        }
        if (rpc.method === "notifications/cancelled") {
          const owner = boundOwner();
          if (owner && pending.has(rpc.params?.requestId))
            this.controller.cancel(owner);
          return;
        }
        if (rpc.id === undefined) return;
        const id = rpc.id;
        if (
          (typeof id !== "string" && typeof id !== "number") ||
          rpc.jsonrpc !== "2.0" ||
          pending.has(id) ||
          pending.size >= 8
        ) {
          socket.destroy();
          return;
        }
        pending.add(id);
        try {
          let result: unknown;
          if (rpc.method === "initialize")
            result = {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "nuwax-android", version: "1.0.0" },
            };
          else if (rpc.method === "ping") result = {};
          else if (rpc.method === "tools/list")
            result = { tools: ANDROID_TOOLS };
          else if (rpc.method === "tools/call") {
            // 每次检查凭据仍有效；工具参数不能指定目标或会话。
            const owner = boundOwner();
            if (!owner) throw new Error("notAuthorized");
            try {
              result = await this.controller.call(
                owner,
                rpc.params?.name,
                rpc.params?.arguments ?? {},
              );
            } catch (error) {
              result = {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      error instanceof Error
                        ? error.message
                        : "operationFailed",
                  },
                ],
              };
            }
          } else {
            send({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: "Method not found" },
            });
            return;
          }
          send({ jsonrpc: "2.0", id, result });
        } catch {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "notAuthorized" },
          });
        } finally {
          pending.delete(id);
        }
      };
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 64 * 1024) {
          socket.destroy();
          return;
        }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.trim()) void handle(line).catch(() => socket.destroy());
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () => this.controller.stop("gatewayFailed"));
    this.server = server;
    return (server.address() as net.AddressInfo).port;
  }
  close() {
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
    this.server = null;
  }
}
