import { powerMonitor } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  ANDROID_IPC,
  type AndroidStatus,
} from "@shared/features/android/contract";
import type { AgentSessionParticipant } from "../_kit/agentSessions";
import type { DesktopFeature, FeatureMcpServerEntry } from "../_kit/types";
import { AndroidController } from "./controller";
import { ANDROID_RELAY, AndroidGateway } from "./gateway";

export const androidFeature: DesktopFeature = {
  id: "android",
  products: ["nuwax"],
  enabledByDefault: true,
  agentServers: ["nuwax-android"],
  register(ctx) {
    const grants = new Map<string, { owner: string | null; file: string }>();
    const controller = new AndroidController(
      () => ctx.session.isAuthenticated(),
      () => {
        ctx.activities.set(
          controller.status().enabled
            ? {
                actions: [
                  {
                    id: "stop",
                    labelKey: "Claw.Android.stop",
                    run: () => {
                      void stop();
                    },
                  },
                ],
              }
            : null,
        );
      },
    );
    const gateway = new AndroidGateway(
      controller,
      (grant) => grants.get(grant)?.owner,
    );
    const scratchId = randomUUID();
    let entry: FeatureMcpServerEntry | null = null,
      directory = "",
      generation = 0,
      disposed = false;
    let starting: Promise<void> | null = null,
      queue = Promise.resolve();
    const revoke = (grant: string) => {
      const value = grants.get(grant);
      grants.delete(grant);
      if (value?.owner) controller.cancel(value.owner);
      if (value) {
        try {
          rmSync(value.file, { force: true });
        } catch {
          ctx.log.warn("android: revoked credential cleanup failed");
        }
      }
    };
    const revokeAll = () => {
      for (const grant of grants.keys()) revoke(grant);
    };
    const sync = () => {
      queue = queue
        .catch(() => undefined)
        .then(async () => {
          try {
            await ctx.agent.setLocalMcpServer(
              "nuwax-android",
              !disposed && controller.status().enabled ? entry : null,
            );
          } catch {
            controller.stop("gatewayFailed");
            revokeAll();
            await ctx.agent
              .setLocalMcpServer("nuwax-android", null)
              .catch(() => undefined);
          }
        });
      return queue;
    };
    const stop = async () => {
      ++generation;
      controller.stop();
      revokeAll();
      await sync();
      return controller.status();
    };
    const initialize = () =>
      (starting ??= (async () => {
        const node = ctx.agent.resolveNodeBinary();
        if (!node) throw new Error("nodeMissing");
        directory = ctx.scratch.create(scratchId);
        const keyFile = path.join(directory, "key"),
          relay = path.join(directory, "relay.cjs");
        const token = randomBytes(32).toString("hex");
        writeFileSync(keyFile, token, { mode: 0o600 });
        writeFileSync(relay, ANDROID_RELAY, { mode: 0o600 });
        const port = await gateway.listen(token);
        entry = {
          command: node,
          args: [relay],
          env: { NUWAX_ANDROID_PORT: String(port), NUWAX_ANDROID_KEY: keyFile },
          enabled: true,
        };
      })().catch((error) => {
        starting = null;
        throw error;
      }));
    const failedStatus = (error: unknown): AndroidStatus => ({
      ...controller.status(),
      error: error instanceof Error ? error.message : "operationFailed",
    });
    ctx.hostIpc.handle(ANDROID_IPC.status, () => controller.status(), {
      enabled: false,
      serial: null,
      adbPath: "",
    });
    ctx.hostIpc.handle(
      ANDROID_IPC.discover,
      async (_event, input: unknown) => {
        try {
          return await controller.discover(
            typeof input === "string" ? input : "",
          );
        } catch (error) {
          return { devices: [], adbPath: "", error: failedStatus(error).error };
        }
      },
      { devices: [], adbPath: "", error: "notAuthorized" },
    );
    ctx.hostIpc.handle(
      ANDROID_IPC.enable,
      async (_event, input: unknown) => {
        const current = ++generation;
        revokeAll();
        try {
          if (!input || typeof input !== "object")
            throw new Error("invalidArguments");
          const value = input as Record<string, unknown>;
          if (
            typeof value.adbPath !== "string" ||
            typeof value.serial !== "string"
          )
            throw new Error("invalidArguments");
          await controller.enable({
            adbPath: value.adbPath,
            serial: value.serial,
          });
          await initialize();
          if (disposed || current !== generation) throw new Error("cancelled");
          await sync();
          return controller.status();
        } catch (error) {
          if (current === generation) {
            controller.stop();
            await sync();
          }
          return failedStatus(error);
        }
      },
      { enabled: false, serial: null, adbPath: "", error: "notAuthorized" },
    );
    ctx.hostIpc.handle(ANDROID_IPC.stop, () => stop(), {
      enabled: false,
      serial: null,
      adbPath: "",
    });
    const offParticipant = ctx.agent.registerSessionParticipant(
      (): AgentSessionParticipant => {
        const owned = new Set<string>();
        const namespace = randomUUID();
        const ownerKey = (sessionId: string) => `${namespace}:${sessionId}`;
        const release = (owner?: string) => {
          for (const grant of [...owned])
            if (!owner || grants.get(grant)?.owner === owner) {
              revoke(grant);
              owned.delete(grant);
            }
        };
        let turn = 0;
        const turns = new Map<string, number>();
        return {
          prepare(servers) {
            for (let i = servers.length - 1; i >= 0; i--)
              if (servers[i].name === "nuwax-android") servers.splice(i, 1);
            if (!entry || !controller.status().enabled || disposed)
              return { bind() {}, cancel() {} };
            const grant = randomBytes(32).toString("hex"),
              file = path.join(directory, randomUUID());
            writeFileSync(file, grant, { mode: 0o600 });
            owned.add(grant);
            grants.set(grant, { owner: null, file });
            servers.push({
              name: "nuwax-android",
              command: entry.command,
              args: entry.args,
              env: Object.entries({
                ...entry.env,
                NUWAX_ANDROID_SESSION: file,
              }).map(([name, value]) => ({ name, value })),
            });
            return {
              bind(owner) {
                const value = grants.get(grant);
                if (value) value.owner = ownerKey(owner);
              },
              cancel() {
                revoke(grant);
                owned.delete(grant);
              },
            };
          },
          start(owner) {
            if (
              ![...owned].some(
                (grant) => grants.get(grant)?.owner === ownerKey(owner),
              ) ||
              !controller.status().enabled
            )
              return 0;
            controller.start(ownerKey(owner));
            turns.set(owner, ++turn);
            return turn;
          },
          finish(owner, value) {
            if (turns.get(owner) === value) {
              turns.delete(owner);
              controller.cancel(ownerKey(owner));
            }
          },
          cancel(owner) {
            turns.delete(owner);
            controller.cancel(ownerKey(owner));
          },
          remove(owner) {
            turns.delete(owner);
            release(ownerKey(owner));
          },
          destroy() {
            release();
          },
        };
      },
    );
    const invalidate = () => {
      void stop().catch(() => undefined);
    };
    const offInvalidated = ctx.lifecycle.onSessionInvalidated(invalidate);
    const offSession = ctx.lifecycle.onSessionEnd(invalidate);
    const offStopping = ctx.lifecycle.onServicesStopping(async () => {
      await stop();
    });
    const offQuit = ctx.lifecycle.onQuit(async () => {
      await stop();
    });
    powerMonitor.on("lock-screen", invalidate);
    powerMonitor.on("suspend", invalidate);
    // 只清理本特性的过期临时凭据，不启动 ADB 或读取手机。
    ctx.scratch.sweep(24 * 60 * 60 * 1000);
    void sync();
    return {
      async dispose() {
        disposed = true;
        await stop();
        offParticipant();
        offInvalidated();
        offSession();
        offStopping();
        offQuit();
        powerMonitor.removeListener("lock-screen", invalidate);
        powerMonitor.removeListener("suspend", invalidate);
        await starting?.catch(() => undefined);
        gateway.close();
        if (directory) ctx.scratch.remove(scratchId);
        ctx.hostIpc.dispose();
        ctx.activities.set(null);
      },
    };
  },
};
