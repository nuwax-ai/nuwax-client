/**
 * Benchmark tasks. Each task is a deterministic "programmatic agent" that behaves like a
 * typical model: it reacts only to what tool replies say, never to control-layer internals.
 *
 * Deliberate, documented agent habits (identical in every run):
 *  - Issues several writes in a row after one observation (form filling, button sequences).
 *  - When told to observe first, observes the same target and retries the same intent once.
 *  - On a driver refusal, re-observes and re-resolves the element before trying again.
 *  - W1: first click uses the default (trusted) browser input route, as the tool docs suggest.
 *  - W3: after a navigation, first reuses a ref from the previous page (a common model slip).
 */
import fs from "node:fs";
import http from "node:http";
import { spawnSync } from "node:child_process";
import type { CallResult } from "./harness";
import type { CuaScope } from "../../../overlay/crates/agent-electron-client/src/shared/types/cuaRuntime";

export interface BenchContext {
  root: string;
  scope: CuaScope;
  call(tool: string, args?: Record<string, unknown>): Promise<CallResult>;
  sleep(ms: number): Promise<void>;
}
type Outcome = { success: boolean; detail?: string };

// ---------------------------------------------------------------- fixtures
const events: string[] = [];
let base = "";
const PAGES: Record<string, string> = {
  "/form": `<!doctype html><title>Bench Form</title><form method="post" action="/submitted">
    <label>Name <input name="name"></label><label>Email <input name="email"></label>
    <label>City <input name="city"></label><button type="submit">Submit</button></form>`,
  "/submitted": `<!doctype html><title>Submitted</title><p>Thanks</p>`,
  "/long": `<!doctype html><title>Long</title><ul>${Array.from({ length: 60 }, (_, i) =>
    `<li style="height:60px">Item ${i + 1}${i === 49 ? ` <button onclick="fetch('/picked',{method:'POST'})">Pick me</button>` : ""}</li>`).join("")}</ul>`,
  "/a": `<!doctype html><title>Page A</title><p>Start</p><button onclick="fetch('/wrong',{method:'POST'})">Cancel</button><a href="/b">Go to B</a>`,
  "/b": `<!doctype html><title>Page B</title><p>Second</p><button onclick="fetch('/confirmed',{method:'POST'})">Confirm</button>`,
};
async function fixtures(): Promise<string> {
  if (base) return base;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (req.method === "POST") events.push(`${req.url}${body ? `?${body}` : ""}`);
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGES[req.url ?? ""] ?? PAGES["/submitted"]);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  server.unref();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return base;
}
const took = (prefix: string) => events.find((e) => e.startsWith(prefix));

// ---------------------------------------------------------------- shared agent habits
const PROFILE = "/tmp/cu-bench/chrome-profile";

/** A separate Chrome instance with its own profile; never the user's own browser. */
async function testChromeWindow(ctx: BenchContext) {
  const find = () => spawnSync("pgrep", ["-f", `user-data-dir=${PROFILE}`]).stdout.toString().trim().split("\n").map(Number).filter(Boolean);
  if (!find().length) {
    fs.mkdirSync(PROFILE, { recursive: true });
    spawnSync("open", ["-na", "Google Chrome", "--args", `--user-data-dir=${PROFILE}`, "--remote-debugging-port=0",
      "--no-first-run", "--no-default-browser-check", "--new-window", "about:blank"]);
    await ctx.sleep(4000);
  }
  for (const pid of find()) {
    const wins = await ctx.call("list_windows", { pid });
    const w = (wins.sc?.windows ?? []).find((x: any) => x.is_on_screen && x.bounds?.height > 100);
    if (w) return { pid: w.pid as number, windowId: w.window_id as number };
  }
  throw new Error("test chrome window not found");
}

/** Prepare (attach) + bind; repeated whenever the agent sees a stale binding. */
async function bindBrowser(ctx: BenchContext) {
  const w = await testChromeWindow(ctx);
  await act(ctx, "browser_prepare", () => ({ pid: w.pid, window_id: w.windowId, strategy: { kind: "existing_profile" } }),
    () => ctx.call("get_window_state", { pid: w.pid, window_id: w.windowId }));
  const bind = await ctx.call("get_browser_state", { pid: w.pid, window_id: w.windowId });
  if (bind.kind !== "ok") throw new Error(`bind failed: ${bind.code}`);
  return { ...w, target: bind.sc.target_id as string, tab: (bind.sc.tabs.find((t: any) => t.active) ?? bind.sc.tabs[0]).tab_id as string };
}

const stale = (r: CallResult) => r.kind === "refused" && /binding_stale|browser_consent_required/.test(r.code ?? r.text);

/** Generic loop: act; if told to observe, observe and retry; if refused, let caller re-resolve. */
async function act(ctx: BenchContext, tool: string, args: () => Record<string, unknown>, observe: () => Promise<unknown>) {
  let r: CallResult | undefined;
  for (let i = 0; i < 3; i++) {
    r = await ctx.call(tool, args());
    if (r.kind === "gateway" && r.code === "observationRequired") { await observe(); continue; }
    return r;
  }
  return r!;
}

function tokenFor(state: CallResult, labels: string[]) {
  const el = (state.sc?.elements ?? []).find((e: any) => labels.includes(e.label));
  if (!el) throw new Error(`element not found: ${labels.join("/")}`);
  return el.element_token as string;
}
function refFor(state: CallResult, pred: (r: any) => boolean) {
  const all = [...(state.sc?.refs ?? []), ...(state.sc?.content_refs ?? [])];
  return all.find(pred);
}

// ---------------------------------------------------------------- tasks
export const TASKS: Record<string, (ctx: BenchContext) => Promise<Outcome>> = {
  /** N1: Calculator 6×7 by clicking buttons; verify the display reads 42. */
  async N1(ctx) {
    const launched = await act(ctx, "launch_app", () => ({ bundle_id: "com.apple.calculator" }),
      () => ctx.call("get_desktop_state", {}));
    const pid = launched.sc?.pid as number;
    if (!pid) return { success: false, detail: `launch_app: ${launched.kind} ${launched.code ?? ""}` };
    await ctx.sleep(800);
    const win = (await ctx.call("list_windows", { pid })).sc?.windows?.find((w: any) => w.is_on_screen);
    if (!win) return { success: false, detail: "calculator window not found" };
    let st!: CallResult;
    const observe = async () => { st = await ctx.call("get_window_state", { pid, window_id: win.window_id }); };
    await observe();
    for (const labels of [["全部清除", "清除"], ["6"], ["乘"], ["7"], ["等于"]]) {
      let r = await act(ctx, "click", () => ({ pid, window_id: win.window_id, element_token: tokenFor(st, labels) }), observe);
      if (r.kind !== "ok") { await observe(); r = await act(ctx, "click", () => ({ pid, window_id: win.window_id, element_token: tokenFor(st, labels) }), observe); }
    }
    await observe();
    const line = st.text.split("\n").find((l) => l.includes("编辑字段")) ?? "";
    return { success: /"42"/.test(line), detail: line.trim() };
  },

  /** N2: Long page in a native window via the pixel wheel path (identical args each time) + AX click. */
  async N2(ctx) {
    const url = `${await fixtures()}/long`;
    const b = await bindBrowser(ctx);
    await ctx.call("browser_navigate", { target_id: b.target, tab_id: b.tab, url });
    await ctx.sleep(800);
    let st!: CallResult;
    const observe = async () => { st = await ctx.call("get_window_state", { pid: b.pid, window_id: b.windowId }); };
    await observe();
    const bounds = (await ctx.call("list_windows", { pid: b.pid })).sc?.windows?.find((w: any) => w.window_id === b.windowId)?.bounds;
    // The AX tree also lists off-screen web content, clamped to the window edge with a 1px height.
    const visible = () => (st.sc?.elements ?? []).find((e: any) => e.label === "Pick me" && e.role === "AXButton" &&
      bounds && e.frame && e.frame.h > 5 && e.frame.y >= bounds.y + 80 && e.frame.y + e.frame.h <= bounds.y + bounds.height);
    for (let i = 0; i < 12 && !visible(); i++) {
      // Without a target, key-based scrolling is refused when the browser owns another window.
      await act(ctx, "scroll", () => ({ pid: b.pid, window_id: b.windowId, direction: "down", x: 300, y: 400, amount: 3 }), observe);
      await observe();
    }
    const button = visible();
    if (!button) return { success: false, detail: "button never became visible" };
    await act(ctx, "click", () => ({ pid: b.pid, window_id: b.windowId, element_token: visible()!.element_token }), observe);
    await ctx.sleep(500);
    return { success: !!took("/picked") };
  },

  /** W1: fill a 3-field form through the browser channel and submit. */
  async W1(ctx) {
    const url = `${await fixtures()}/form`;
    let b = await bindBrowser(ctx);
    let snap!: CallResult;
    const observe = async () => {
      snap = await ctx.call("get_browser_state", { target_id: b.target, tab_id: b.tab });
      if (stale(snap)) { b = await bindBrowser(ctx); snap = await ctx.call("get_browser_state", { target_id: b.target, tab_id: b.tab }); }
    };
    await ctx.call("browser_navigate", { target_id: b.target, tab_id: b.tab, url });
    await observe();
    const values: Record<string, string> = { name: "Ada", email: "ada@example.com", city: "Paris" };
    for (const [field, text] of Object.entries(values)) {
      const ref = () => refFor(snap, (r) => r.label === `name=${field}`)?.ref;
      let r = await act(ctx, "browser_type", () => ({ target_id: b.target, tab_id: b.tab, ref: ref(), text, replace: true }), observe);
      if (r.kind !== "ok") { await observe(); r = await act(ctx, "browser_type", () => ({ target_id: b.target, tab_id: b.tab, ref: ref(), text, replace: true }), observe); }
    }
    const submit = () => refFor(snap, (r) => r.label === "type=submit")?.ref;
    let r = await act(ctx, "browser_click", () => ({ target_id: b.target, tab_id: b.tab, ref: submit() }), observe);
    if (r.kind !== "ok") {
      await observe();
      r = await act(ctx, "browser_click", () => ({ target_id: b.target, tab_id: b.tab, ref: submit(), input_route: "dom_event" }), observe);
    }
    await ctx.sleep(800);
    const posted = took("/submitted");
    return { success: !!posted && posted.includes("Ada") && posted.includes("Paris"), detail: posted };
  },

  /** W2: long list through the browser channel; scroll by ref until the button is in view. */
  async W2(ctx) {
    const url = `${await fixtures()}/long`;
    let b = await bindBrowser(ctx);
    let snap!: CallResult;
    const observe = async () => {
      snap = await ctx.call("get_browser_state", { target_id: b.target, tab_id: b.tab, snapshot_format: "semantic_v2" });
      if (stale(snap)) { b = await bindBrowser(ctx); snap = await ctx.call("get_browser_state", { target_id: b.target, tab_id: b.tab, snapshot_format: "semantic_v2" }); }
    };
    await ctx.call("browser_navigate", { target_id: b.target, tab_id: b.tab, url });
    await observe();
    const button = () => refFor(snap, (r) => r.name === "Pick me" && r.role === "button");
    // Only refs that declare the pointer action can be scrolled; the button is the one here.
    for (let i = 0; i < 12 && button()?.visibility !== "in_viewport"; i++) {
      await act(ctx, "browser_pointer", () => ({ target_id: b.target, tab_id: b.tab, action: "scroll", ref: button()?.ref, delta_y: 900, input_route: "dom_event" }), observe);
      await observe();
    }
    if (button()?.visibility !== "in_viewport") return { success: false, detail: "button never in viewport" };
    await act(ctx, "browser_click", () => ({ target_id: b.target, tab_id: b.tab, ref: button()!.ref, input_route: "dom_event" }), observe);
    await ctx.sleep(500);
    return { success: !!took("/picked") };
  },

  /** W3: follow a link, then (slip) reuse an old ref, recover, and confirm on page B. */
  async W3(ctx) {
    const url = `${await fixtures()}/a`;
    let b = await bindBrowser(ctx);
    let snap!: CallResult;
    const observe = async () => {
      snap = await ctx.call("get_browser_state", { target_id: b.target, tab_id: b.tab });
      if (stale(snap)) { b = await bindBrowser(ctx); snap = await ctx.call("get_browser_state", { target_id: b.target, tab_id: b.tab }); }
    };
    await ctx.call("browser_navigate", { target_id: b.target, tab_id: b.tab, url });
    await observe();
    const pageA = snap;
    const link = () => refFor(snap, (r) => r.node === "a" || /href/.test(r.label ?? ""))?.ref;
    await act(ctx, "browser_click", () => ({ target_id: b.target, tab_id: b.tab, ref: link(), input_route: "dom_event" }), observe);
    await ctx.sleep(800);
    const oldButton = refFor(pageA, (r) => r.node === "button")?.ref;
    const slip = await act(ctx, "browser_click", () => ({ target_id: b.target, tab_id: b.tab, ref: oldButton, input_route: "dom_event" }), observe);
    await observe();
    const confirm = () => refFor(snap, (r) => r.node === "button")?.ref;
    await act(ctx, "browser_click", () => ({ target_id: b.target, tab_id: b.tab, ref: confirm(), input_route: "dom_event" }), observe);
    await ctx.sleep(500);
    return { success: !!took("/confirmed") && !took("/wrong"), detail: `slip=${slip.kind}:${slip.code ?? ""}` };
  },
};

/**
 * Window-scope tasks: the user selected the (test) browser window in Computer Use. The agent
 * attaches and binds it without naming ids, works on its tab, and twice tries to leave it.
 */
export const WINDOW_TASKS: Record<string, (ctx: BenchContext) => Promise<Outcome>> = {
  async WS(ctx) {
    const url = `${await fixtures()}/form`;
    const look = () => ctx.call("get_window_state", {});
    await act(ctx, "browser_prepare", () => ({ strategy: { kind: "existing_profile" } }), look);
    const bind = await ctx.call("get_browser_state", {});
    if (bind.kind !== "ok") return { success: false, detail: `bind: ${bind.kind} ${bind.code ?? ""}` };
    const b = { target: bind.sc.target_id as string, tab: (bind.sc.tabs.find((t: any) => t.active) ?? bind.sc.tabs[0]).tab_id as string };
    let snap!: CallResult;
    const observe = async () => { snap = await ctx.call("get_browser_state", { target_id: b.target, tab_id: b.tab }); };
    await act(ctx, "browser_navigate", () => ({ target_id: b.target, tab_id: b.tab, url }), observe);
    await observe();
    for (const [field, text] of Object.entries({ name: "Grace", email: "grace@example.com", city: "Oslo" })) {
      await act(ctx, "browser_type", () => ({ target_id: b.target, tab_id: b.tab, ref: refFor(snap, (r) => r.label === `name=${field}`)?.ref, text, replace: true }), observe);
    }
    const escapeTab = await ctx.call("browser_click", { target_id: "bt-not-bound", tab_id: "tab-x", ref: "p1:1" });
    const escapeLaunch = await ctx.call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } });
    await observe();
    await act(ctx, "browser_click", () => ({ target_id: b.target, tab_id: b.tab, ref: refFor(snap, (r) => r.label === "type=submit")?.ref, input_route: "dom_event" }), observe);
    await ctx.sleep(800);
    const posted = took("/submitted?name=Grace");
    const escapesRefused = escapeTab.code === "scopeViolation" && escapeLaunch.code === "scopeViolation";
    return { success: !!posted && escapesRefused, detail: `posted=${!!posted} escapes=${escapeTab.code},${escapeLaunch.code}` };
  },
};
