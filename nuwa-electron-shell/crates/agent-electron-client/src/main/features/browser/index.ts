import { dialog, powerMonitor } from "electron";
import type { WebContents } from "electron";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import {
  BROWSER_FEATURE_SETTING,
  BROWSER_IPC,
} from "@shared/features/browser/contract";
import type { AgentSessionParticipant } from "../_kit/agentSessions";
import type {
  DesktopFeature,
  FeatureContext,
  FeatureMcpServerEntry,
} from "../_kit/types";
import {
  AgentBrowserController,
  type AgentBrowserActionRequest,
  type AgentBrowserAuthorizationRequest,
  type RevokeReason,
} from "./agent/controller";
import { BrowserGateway } from "./agent/gateway";
import { AGENT_BROWSER_RELAY, AGENT_BROWSER_SERVER } from "./agent/tools";
import {
  createBrowserWindows,
  type BrowserPage,
  type BrowserPageOptions,
} from "./windows";

let active: {
  windows: ReturnType<typeof createBrowserWindows>;
  available(): boolean;
  revokeOpener(contents: WebContents): void;
} | null = null;
export const isDesktopBrowserAvailable = (): boolean => {
  try {
    return active?.available() === true;
  } catch {
    return false;
  }
};
export const refreshDesktopBrowserWindows = (): void =>
  active?.windows.refresh();
export function createDesktopBrowserPage(
  options: BrowserPageOptions
): BrowserPage | null {
  return isDesktopBrowserAvailable() ? active!.windows.open(options) : null;
}

/**
 * A page opened a new window/tab through the host policy. The destination is a
 * different WebContents, so the authorized opener must be re-authorized.
 */
export function notifyAgentBrowserNewWindow(opener: WebContents): void {
  try {
    active?.revokeOpener(opener);
  } catch {
    /* Best effort: the controller also watches the opener directly. */
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Tab titles are untrusted page input; keep them on one dialog line. */
function safeLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function confirmAgentBrowserAccess(
  ctx: FeatureContext,
  request: AgentBrowserAuthorizationRequest,
): Promise<number | null> {
  const t = (key: string) => ctx.translate?.(key) ?? key;
  const labels = {
    title: t("Claw.Browser.agentRequestTitle"),
    message: t("Claw.Browser.agentRequestMessage"),
    session: t("Claw.Browser.agentRequestSession"),
    unknownSession: t("Claw.Browser.agentRequestUnknownSession"),
    reason: t("Claw.Browser.agentRequestReason"),
    noReason: t("Claw.Browser.agentNoReason"),
    cancel: t("Claw.Browser.agentDeny"),
  };
  const pages = request.pages;
  const buttons = pages.map(
    (page, index) =>
      `${index + 1}. ${truncate(safeLabel(page.title || page.origin), 40)}`,
  );
  buttons.push(labels.cancel);
  const detail = [
    `${labels.session}: ${request.conversationId ?? labels.unknownSession}`,
    `${labels.reason}: ${
      request.reason ? JSON.stringify(safeLabel(request.reason)) : labels.noReason
    }`,
    "",
    ...pages.flatMap((page, index) => [
      `${index + 1}. ${safeLabel(page.title || page.origin)}`,
      `   ${safeLabel(page.url)}`,
    ]),
  ].join("\n");
  const parent =
    pages.find((page) => page.window && !page.window.isDestroyed())?.window ??
    (() => {
      try {
        return ctx.windows?.getMain?.() ?? undefined;
      } catch {
        return undefined;
      }
    })();
  const options = {
    type: "question" as const,
    title: labels.title,
    message: labels.message,
    detail,
    buttons,
    // Consent must be deliberate: Enter/cancel does not authorize.
    defaultId: pages.length,
    cancelId: pages.length,
    noLink: true,
  };
  try {
    if (parent && !parent.isDestroyed()) {
      if (parent.isMinimized()) parent.restore();
      parent.show();
      parent.focus();
    }
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return result.response >= 0 && result.response < pages.length
      ? result.response
      : null;
  } catch {
    return null;
  }
}

async function confirmAgentBrowserAction(
  ctx: FeatureContext,
  request: AgentBrowserActionRequest,
): Promise<boolean> {
  const t = (key: string) => ctx.translate?.(key) ?? key;
  const labels = {
    title: t("Claw.Browser.agentActionTitle"),
    message: t("Claw.Browser.agentActionMessage"),
    session: t("Claw.Browser.agentRequestSession"),
    unknownSession: t("Claw.Browser.agentRequestUnknownSession"),
    site: t("Claw.Browser.agentActionSite"),
    action: t("Claw.Browser.agentActionKind"),
    click: t("Claw.Browser.agentActionClick"),
    type: t("Claw.Browser.agentActionType"),
    navigate: t("Claw.Browser.agentActionNavigate"),
    submit: t("Claw.Browser.agentActionSubmit"),
    element: t("Claw.Browser.agentActionElement"),
    target: t("Claw.Browser.agentActionTarget"),
    noText: t("Claw.Browser.agentActionNoText"),
    allow: t("Claw.Browser.agentAllowAction"),
    deny: t("Claw.Browser.agentDeny"),
  };
  const { action } = request;
  const actionText =
    action.kind === "click"
      ? labels.click
      : action.kind === "type"
        ? labels.type
        : labels.navigate;
  const element = action.element
    ? `${safeLabel(action.element.role)}${action.element.name ? ` ${JSON.stringify(truncate(safeLabel(action.element.name), 80))}` : ""}`
    : "";
  const detail = [
    `${labels.session}: ${request.conversationId ?? labels.unknownSession}`,
    `${labels.site}: ${request.page.origin}`,
    `${labels.action}: ${actionText}`,
    ...(element ? [`${labels.element}: ${element}`] : []),
    ...(action.kind === "navigate" && action.url
      ? [`${labels.target}: ${safeLabel(action.url)}`]
      : []),
    ...(action.submit ? [labels.submit] : []),
    ...(action.kind === "type" ? [labels.noText] : []),
  ].join("\n");
  const parent =
    request.window && !request.window.isDestroyed()
      ? request.window
      : (() => {
          try {
            return ctx.windows?.getMain?.() ?? undefined;
          } catch {
            return undefined;
          }
        })();
  const options = {
    type: "question" as const,
    title: labels.title,
    message: labels.message,
    detail,
    buttons: [labels.allow, labels.deny],
    // Default and Escape deny the action.
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  try {
    if (parent && !parent.isDestroyed()) {
      if (parent.isMinimized()) parent.restore();
      parent.show();
      parent.focus();
    }
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return result.response === 0;
  } catch {
    return false;
  }
}

export const browserFeature: DesktopFeature = {
  id: "browser",
  products: ["nuwax"],
  enabledByDefault: true,
  bridge: { namespaces: ["browser"] },
  agentServers: [AGENT_BROWSER_SERVER],
  register(ctx) {
    const windows = createBrowserWindows(ctx);
    let disposed = false;
    const controller = new AgentBrowserController({
      pages: {
        list: () => windows.listAgentPages(),
        resolve: (contents) => windows.resolveAgentPage(contents),
        activate: (contents) => windows.activateAgentPage(contents),
      },
      enabled: () => {
        try {
          return ctx.settings.read(BROWSER_FEATURE_SETTING) !== false;
        } catch {
          return false;
        }
      },
      log: ctx.log,
      confirm: (request) => confirmAgentBrowserAccess(ctx, request),
      confirmAction: (request) => confirmAgentBrowserAction(ctx, request),
    });
    windows.configureAgent?.({
      state: (contentsId) => controller.stateFor(contentsId),
      revokeAll: () => controller.revokeAll("revokedByUser"),
      revoke: (contents) => controller.revokePage(contents, "revokedByUser"),
    });

    type BrowserGrant = {
      secret: string;
      file: string;
      sessionId: string | null;
      /** One fresh generation per agent turn; null outside start..finish. */
      owner: string | null;
      active: boolean;
      turn: number;
      conversationId: string | null;
    };
    const grants = new Map<string, BrowserGrant>();
    const endGrantTurn = (grant: BrowserGrant, reason: RevokeReason) => {
      const owner = grant.owner;
      grant.active = false;
      grant.owner = null;
      if (owner) controller.revokeOwner(owner, reason);
    };
    const releaseGrant = (grant: BrowserGrant) => {
      if (grant.active) endGrantTurn(grant, "sessionEnded");
      grants.delete(grant.secret);
      try {
        rmSync(grant.file, { force: true });
      } catch {
        ctx.log?.warn?.("[Browser] Failed to remove agent grant");
      }
    };
    const revokeAllGrants = () => {
      for (const grant of [...grants.values()]) {
        endGrantTurn(grant, "sessionEnded");
        releaseGrant(grant);
      }
    };
    const gateway = new BrowserGateway({
      owner: (grant) => grants.get(grant),
      call: (input) =>
        controller.call(
          input.owner,
          input.conversationId,
          input.tool,
          input.args,
          input.signal,
        ),
      cancel: (owner) => controller.cancelOwner(owner),
      disconnect: (grant) => {
        const record = grants.get(grant);
        if (!record) return;
        // The session transport is gone: end its current turn and keep the file
        // so a restarted transport can authenticate for the next turn.
        endGrantTurn(record, "disconnected");
      },
    });

    const scratchId = randomUUID();
    try {
      // Clean relay/key/grant files left by a previous crash.
      ctx.scratch?.sweep?.(24 * 60 * 60 * 1000);
    } catch {
      /* Scratch cleanup is best effort. */
    }
    let directory = "";
    let entry: FeatureMcpServerEntry | null = null;
    let starting: Promise<void> | null = null;
    const initialize = () =>
      (starting ??= (async () => {
        if (disposed) throw new Error("disposed");
        const node = ctx.agent?.resolveNodeBinary?.() ?? null;
        if (!node || !ctx.scratch) throw new Error("agentHostUnavailable");
        directory = ctx.scratch.create(scratchId);
        const keyFile = path.join(directory, "key");
        const relay = path.join(directory, "relay.cjs");
        const token = randomBytes(32).toString("hex");
        writeFileSync(keyFile, token, { mode: 0o600 });
        writeFileSync(relay, AGENT_BROWSER_RELAY, { mode: 0o600 });
        const port = await gateway.listen(token);
        entry = {
          command: node,
          args: [relay],
          env: {
            NUWAX_BROWSER_PORT: String(port),
            NUWAX_BROWSER_KEY: keyFile,
          },
          enabled: true,
        };
      })().catch((error) => {
        starting = null;
        throw error;
      }));
    if (ctx.agent?.setLocalMcpServer) {
      void initialize()
        .then(async () => {
          if (disposed) return;
          if (entry)
            await ctx.agent.setLocalMcpServer(AGENT_BROWSER_SERVER, entry);
        })
        .catch((error) => {
          ctx.log?.warn?.("[Browser] Agent browser MCP unavailable", error);
        });
    }

    const offParticipant =
      ctx.agent?.registerSessionParticipant?.(
        (): AgentSessionParticipant => {
          const sessions = new Map<string, BrowserGrant>();
          const owned = new Set<BrowserGrant>();
          const namespace = randomUUID();
          const nextOwner = () => `${namespace}:${randomUUID()}`;
          const dropGrant = (grant: BrowserGrant) => {
            endGrantTurn(grant, "sessionEnded");
            releaseGrant(grant);
            owned.delete(grant);
          };
          return {
            prepare(servers) {
              for (let index = servers.length - 1; index >= 0; index--)
                if (servers[index].name === AGENT_BROWSER_SERVER)
                  servers.splice(index, 1);
              let featureEnabled = true;
              try {
                featureEnabled =
                  ctx.settings.read(BROWSER_FEATURE_SETTING) !== false;
              } catch {
                featureEnabled = false;
              }
              if (!entry || disposed || !directory || !featureEnabled)
                return { bind() {}, cancel() {} };
              const secret = randomBytes(32).toString("hex");
              const file = path.join(directory, randomUUID());
              try {
                writeFileSync(file, secret, { mode: 0o600 });
              } catch {
                return { bind() {}, cancel() {} };
              }
              const grant: BrowserGrant = {
                secret,
                file,
                sessionId: null,
                owner: null,
                active: false,
                turn: 0,
                conversationId: null,
              };
              grants.set(secret, grant);
              owned.add(grant);
              servers.push({
                name: AGENT_BROWSER_SERVER,
                command: entry.command,
                args: entry.args,
                env: Object.entries({
                  ...(entry.env ?? {}),
                  NUWAX_BROWSER_SESSION: file,
                }).map(([name, value]) => ({ name, value })),
              });
              return {
                bind(sessionId) {
                  if (!grants.has(grant.secret)) return;
                  const previous = sessions.get(sessionId);
                  if (previous && previous !== grant) dropGrant(previous);
                  grant.sessionId = sessionId;
                  sessions.set(sessionId, grant);
                  try {
                    grant.conversationId =
                      ctx.agent?.resolveConversationId?.(sessionId) ?? null;
                  } catch {
                    grant.conversationId = null;
                  }
                },
                cancel() {
                  if (!grants.has(grant.secret)) return;
                  dropGrant(grant);
                },
              };
            },
            start(sessionId) {
              const grant = sessions.get(sessionId);
              if (!grant || !grants.has(grant.secret)) return 0;
              if (grant.active) endGrantTurn(grant, "turnEnded");
              grant.owner = nextOwner();
              grant.active = true;
              grant.turn += 1;
              if (!grant.conversationId) {
                try {
                  grant.conversationId =
                    ctx.agent?.resolveConversationId?.(sessionId) ?? null;
                } catch {
                  grant.conversationId = null;
                }
              }
              return grant.turn;
            },
            finish(sessionId, turn) {
              const grant = sessions.get(sessionId);
              if (!grant || !grant.active || grant.turn !== turn) return;
              // A turn ending is a stop: page binding, pending authorization and
              // any in-flight action are revoked before the next call.
              endGrantTurn(grant, "turnEnded");
            },
            cancel(sessionId) {
              const grant = sessions.get(sessionId);
              if (!grant) return;
              endGrantTurn(grant, "turnCancelled");
            },
            remove(sessionId) {
              const grant = sessions.get(sessionId);
              sessions.delete(sessionId);
              if (grant) dropGrant(grant);
            },
            destroy() {
              // Only this participant's grants; another engine must stay alive.
              for (const grant of [...owned]) dropGrant(grant);
              owned.clear();
              sessions.clear();
            },
          };
        },
      ) ?? (() => {});

    const syncActivity = () => {
      try {
        ctx.activities?.set(
          controller.activeCount() > 0
            ? {
                actions: [
                  {
                    id: "stop",
                    labelKey: "Claw.Browser.agentStop",
                    run: () => controller.revokeAll("revokedByUser"),
                  },
                ],
              }
            : null,
        );
      } catch {
        /* The tray board is not part of the security boundary. */
      }
    };
    const offChanged = controller.onChanged(() => {
      try {
        windows.refresh?.();
      } catch {
        /* Window refresh is best effort after a revocation. */
      }
      syncActivity();
    });

    const revokeEverything = () => {
      controller.revokeAll("sessionEnded");
      revokeAllGrants();
      syncActivity();
    };
    // Lock/suspend means the user is no longer present to watch the tab. Keep
    // the session grant so the same session can ask again after unlock.
    const revokeWhileAbsent = () => {
      controller.revokeAll("revokedByUser");
      syncActivity();
    };
    try {
      powerMonitor?.on?.("lock-screen", revokeWhileAbsent);
      powerMonitor?.on?.("suspend", revokeWhileAbsent);
    } catch {
      /* Absence signals are unavailable on some Linux sessions. */
    }
    const instance = {
      windows,
      available: () => ctx.settings.read(BROWSER_FEATURE_SETTING) !== false,
      revokeOpener: (contents: WebContents) => controller.revokePage(contents, "newWindow"),
    };
    active = instance;
    const capabilities = () => ({ available: isDesktopBrowserAvailable() });

    const offInvalidated =
      ctx.lifecycle?.onSessionInvalidated?.(revokeEverything) ?? (() => {});
    const offSession =
      ctx.lifecycle?.onSessionEnd?.(() => {
        windows.closeAll();
        revokeEverything();
      }) ?? (() => {});
    const offStopping =
      ctx.lifecycle?.onServicesStopping?.(async () => {
        revokeEverything();
        try {
          await ctx.agent?.setLocalMcpServer?.(AGENT_BROWSER_SERVER, null);
        } catch {
          /* The entry is already unusable without a live gateway. */
        }
      }) ?? (() => {});
    const offQuit =
      ctx.lifecycle?.onQuit?.(async () => {
        revokeEverything();
        try {
          await ctx.agent?.setLocalMcpServer?.(AGENT_BROWSER_SERVER, null);
        } catch {
          /* Best effort during quit. */
        }
      }) ?? (() => {});
    // Register before the engine starts so a session created at boot can see
    // the browser MCP server; the initial fire-and-forget above is best effort.
    const offStarting =
      ctx.lifecycle?.onServicesStarting?.(async () => {
        try {
          await initialize();
          if (entry)
            await ctx.agent?.setLocalMcpServer?.(AGENT_BROWSER_SERVER, entry);
        } catch (error) {
          ctx.log?.warn?.("[Browser] Agent browser MCP unavailable", error);
        }
      }) ?? (() => {});

    let removed = false;
    const dispose = () => {
      if (removed) return;
      removed = true;
      disposed = true;
      try {
        void ctx.agent
          ?.setLocalMcpServer?.(AGENT_BROWSER_SERVER, null)
          ?.catch?.(() => {});
      } catch {
        /* The database may already be closing. */
      }
      if (active === instance) active = null;
      offChanged();
      offParticipant();
      offInvalidated();
      offSession();
      offStarting();
      offStopping();
      offQuit();
      try {
        powerMonitor?.removeListener?.("lock-screen", revokeWhileAbsent);
        powerMonitor?.removeListener?.("suspend", revokeWhileAbsent);
      } catch {
        /* Best effort during shutdown. */
      }
      controller.dispose();
      windows.dispose();
      revokeAllGrants();
      syncActivity();
      gateway.close();
      if (directory) {
        try {
          ctx.scratch?.remove?.(scratchId);
        } catch {
          /* Scratch cleanup is retried by the host on next boot. */
        }
      }
      ctx.ipc.dispose();
      ctx.hostIpc.dispose();
    };

    try {
      ctx.ipc.handle(BROWSER_IPC.capabilities, capabilities, {
        available: false,
      });
      ctx.hostIpc.handle(BROWSER_IPC.hostCapabilities, capabilities, {
        available: false,
      });
    } catch (error) {
      dispose();
      throw error;
    }
    return { dispose };
  },
};
