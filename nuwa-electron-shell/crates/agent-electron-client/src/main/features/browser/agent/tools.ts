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
      "Ask the user to authorize one ordinary tab in the Nuwax built-in browser. The user chooses and approves the tab in a native dialog; do not ask for passwords or try to bypass it. Returns the authorized page origin and title. If this session already controls a tab, it returns that tab; call nuwax_browser_release_access before choosing another.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          maxLength: 500,
          description:
            "Short reason shown to the user, e.g. what task needs the page.",
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
] as const;

/** Stdio MCP relay: one local socket, one session grant, no retries after connect. */
export const AGENT_BROWSER_RELAY = `
const fs=require('node:fs'),net=require('node:net');
const s=net.connect({host:'127.0.0.1',port:Number(process.env.NUWAX_BROWSER_PORT)});
s.on('connect',()=>{s.write(JSON.stringify({token:fs.readFileSync(process.env.NUWAX_BROWSER_KEY,'utf8'),grant:process.env.NUWAX_BROWSER_SESSION?fs.readFileSync(process.env.NUWAX_BROWSER_SESSION,'utf8'):undefined})+'\\n');process.stdin.pipe(s);s.pipe(process.stdout);});
s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end());
`;
