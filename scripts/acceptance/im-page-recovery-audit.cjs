/** Read-only recovery checks for the separately maintained IM page socket. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const client = path.join(root, "nuwa-electron-shell/crates/agent-electron-client");
const imSocket = path.join(root, "nuwax/submodules/nuwax-im/nuwax-im-web/src/ws/ImSocket.ts");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-im-recovery-audit-"));
const output = path.join(dir, "audit.test.cjs");
try {
  require(path.join(client, "node_modules/esbuild")).buildSync({
    stdin: {
      resolveDir: root,
      loader: "ts",
      contents: `
        import assert from "node:assert/strict";
        import test from "node:test";
        import { ImSocket } from ${JSON.stringify(imSocket)};

        class Socket {
          static OPEN = 1;
          static instances = [];
          readyState = 0;
          onopen = null;
          onmessage = null;
          onclose = null;
          onerror = null;
          constructor() { Socket.instances.push(this); }
          send() {}
          close() { this.readyState = 3; }
          open() { this.readyState = 1; this.onopen?.(); }
          ack() { this.onmessage?.({data: JSON.stringify({v: 1, op: 1001, body: {heartbeatInterval: 5}})}); }
        }
        const values = new Map();
        globalThis.localStorage = globalThis.sessionStorage = {
          getItem: key => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, value),
          removeItem: key => values.delete(key),
        };
        globalThis.window = {location: {protocol: "https:", host: "im.example.test"}};
        globalThis.WebSocket = Socket;

        test("IM page recovers a half-open connection without a close event", t => {
          t.mock.timers.enable({apis: ["setTimeout", "setInterval", "Date"]});
          Socket.instances = [];
          const receiver = new ImSocket();
          try {
            receiver.connect(null);
            Socket.instances[0].open();
            Socket.instances[0].ack();
            for (let tick = 0; tick < 20; tick++) t.mock.timers.tick(1000);
            assert.ok(Socket.instances.length > 1, "No PONG/close event: still connected after four heartbeat periods");
          } finally { receiver.disconnect(); }
        });

        test("IM page retries a handshake that never receives CONNECT_ACK", t => {
          t.mock.timers.enable({apis: ["setTimeout", "setInterval", "Date"]});
          Socket.instances = [];
          const receiver = new ImSocket();
          try {
            receiver.connect(null);
            Socket.instances[0].open();
            for (let tick = 0; tick < 60; tick++) t.mock.timers.tick(1000);
            assert.ok(Socket.instances.length > 1, "No CONNECT_ACK/close event: still connecting after one minute");
          } finally { receiver.disconnect(); }
        });
      `,
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const result = spawnSync(process.execPath, ["--test", output], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
