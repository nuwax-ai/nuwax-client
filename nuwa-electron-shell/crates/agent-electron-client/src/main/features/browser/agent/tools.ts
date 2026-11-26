/**
 * Agent 浏览器 MCP 契约。
 *
 * 工具名、参数与说明是模型可见的全部入口；这里没有原始 CDP、JavaScript 求值或
 * 任意调试端点。每个动作都要求最近一次 observation，并在主进程重新校验页面归属。
 */
export const AGENT_BROWSER_SERVER = "nuwax-browser";

export const AGENT_BROWSER_TOOLS = [
  {
    name: "nuwax_browser_request_access",
    description:
      "Ask the user to authorize one ordinary tab in the Nuwax built-in browser. The user explicitly approves the tab in a native dialog; do not ask for passwords or try to bypass it. Returns the authorized page origin, title and tabId when it is in your own agent window. Pass tabId from nuwax_browser_list_tabs to target your own active tab; without tabId the user chooses among ordinary user tabs. Agent-owned windows are never listed as user tabs. If this session already controls a tab, it returns that tab; call nuwax_browser_release_access before choosing another.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          maxLength: 500,
          description:
            "Short reason shown to the user, e.g. what task needs the page.",
        },
        tabId: {
          type: "string",
          maxLength: 128,
          description:
            "Optional opaque tabId from nuwax_browser_list_tabs in your own agent window. Must be the active tab.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "nuwax_browser_release_access",
    description:
      "Stop controlling the authorized tab. Use when the task no longer needs the browser; the user can also revoke at any time.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "nuwax_browser_observe",
    description:
      "Observe the authorized tab. Returns an observationId and a bounded accessibility outline with numbered elements, roles, names and static text. The same outline is returned in the text content and in structuredContent.outline; use only the elements actually returned and never guess an element index or page structure. Screenshots are off by default for privacy and model compatibility; set screenshot=true only when a visual check is necessary. A screenshot is supplemental and never replaces the text outline. Observe again after navigation, after three writes, or when an action asks you to.",
    inputSchema: {
      type: "object",
      properties: {
        screenshot: {
          type: "boolean",
          description:
            "Request an additional screenshot. Defaults to false; text outline is always returned.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "nuwax_browser_click",
    description:
      "Click one element from the most recent observation. The user must approve every click in a native dialog; if declined, stop and do not retry. The click is sent at most once. If the result says uncertain, do not retry; observe again after re-authorization. Do not click payment, credential or destructive controls unless the user explicitly asked.",
    inputSchema: {
      type: "object",
      properties: {
        observationId: {
          type: "string",
          description: "Exact observationId from your most recent observation.",
        },
        element: {
          type: "integer",
          minimum: 0,
          maximum: 10000,
          description: "Element index from that observation.",
        },
      },
      required: ["observationId", "element"],
      additionalProperties: false,
    },
  },
  {
    name: "nuwax_browser_type",
    description:
      "Focus an element from the most recent observation and type text into it through the browser input pipeline. The user must approve every typing action in a native dialog; the dialog never shows the typed text. If declined, stop and do not retry. Set submit=true only when the user asked to submit the form. Do not type passwords, API keys or other secrets.",
    inputSchema: {
      type: "object",
      properties: {
        observationId: {
          type: "string",
          description: "Exact observationId from your most recent observation.",
        },
        element: {
          type: "integer",
          minimum: 0,
          maximum: 10000,
          description: "Element index from that observation.",
        },
        text: { type: "string", minLength: 1, maxLength: 2000 },
        submit: {
          type: "boolean",
          description: "Press Enter after typing. Defaults to false.",
        },
      },
      required: ["observationId", "element", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "nuwax_browser_scroll",
    description:
      "Scroll the authorized page with a mouse wheel at the viewport center. Observe again if the visible content changes.",
    inputSchema: {
      type: "object",
      properties: {
        observationId: {
          type: "string",
          description: "Exact observationId from your most recent observation.",
        },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: {
          type: "integer",
          minimum: 100,
          maximum: 2000,
          description: "Wheel delta in CSS pixels. Defaults to 600.",
        },
      },
      required: ["observationId", "direction"],
      additionalProperties: false,
    },
  },
  {
    name: "nuwax_browser_navigate",
    description:
      "Navigate the authorized tab to an HTTP(S) URL on the same site. The user must approve every navigation in a native dialog; if declined, stop and do not retry. Cross-site navigation is refused until the user authorizes the destination; redirects that leave the site also end control.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2048 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "nuwax_browser_open_window",
    description:
      "Open or reuse the agent's own dedicated browser window and load an HTTP(S) URL in a new tab. The user must approve the exact URL in a native dialog before it loads. One dedicated window per agent session; user windows and other agent sessions' windows are never accessible. The tool returns opaque windowId and tabId values. Opening the tab does not grant page access: use nuwax_browser_request_access with its tabId before observing or acting.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2048 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "nuwax_browser_list_tabs",
    description:
      "List tabs in the agent's own dedicated browser window with opaque tabIds, titles, URLs and the active tab. Never lists user windows or another agent session's windows.",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", maxLength: 128 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nuwax_browser_open_tab",
    description:
      "Open a new tab in the agent's own dedicated browser window and load an HTTP(S) URL. The user must approve the exact URL before it loads. Requires an existing agent window; use nuwax_browser_open_window first. The new tab becomes active and invalidates the previous page authorization.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2048 },
        windowId: { type: "string", maxLength: 128 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "nuwax_browser_switch_tab",
    description:
      "Switch to a tab in the agent's own dedicated browser window. The previous page authorization and observation are invalidated; call nuwax_browser_request_access with the new tabId before observing or acting. User and other-session tabs are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "nuwax_browser_close_tab",
    description:
      "Close a tab in the agent's own dedicated browser window. Uses the page's beforeunload path and respects cancellation. If the tab is not actually destroyed, the result reports closed=false with requested/cancelled rather than claiming success. Never closes user or other-session tabs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "nuwax_browser_close_window",
    description:
      "Close the agent's own dedicated browser window through the window manager's beforeunload path. User windows and other agent sessions' windows are never closed. If the window is not actually destroyed, the result reports closed=false with requested/cancelled. Leaving a turn does not close this window; the user can inspect the result.",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string", maxLength: 128 },
      },
      additionalProperties: false,
    },
  },
] as const;

/** Tools handled by the dedicated-window manager rather than the page controller. */
export const AGENT_WINDOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  "nuwax_browser_open_window",
  "nuwax_browser_list_tabs",
  "nuwax_browser_open_tab",
  "nuwax_browser_switch_tab",
  "nuwax_browser_close_tab",
  "nuwax_browser_close_window",
]);

/** Stdio MCP relay: one local socket, one session grant, no retries after connect. */
export const AGENT_BROWSER_RELAY = `
const fs=require('node:fs'),net=require('node:net');
const s=net.connect({host:'127.0.0.1',port:Number(process.env.NUWAX_BROWSER_PORT)});
s.on('connect',()=>{s.write(JSON.stringify({token:fs.readFileSync(process.env.NUWAX_BROWSER_KEY,'utf8'),grant:process.env.NUWAX_BROWSER_SESSION?fs.readFileSync(process.env.NUWAX_BROWSER_SESSION,'utf8'):undefined})+'\\n');process.stdin.pipe(s);s.pipe(process.stdout);});
s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end());
`;
