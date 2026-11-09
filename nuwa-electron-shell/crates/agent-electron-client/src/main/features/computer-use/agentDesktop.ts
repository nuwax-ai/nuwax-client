import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CuaTool } from "./toolCatalog";
import { CuaAdapterTransport } from "./driverTransport";
import type { DesktopEnvelope, DesktopRun } from "./agentDesktopProcess";
import { isSensitiveObservation } from "./cuaPrivacy";
import { sensitiveUiRefusal } from "./cuaSafety";

type Args = Record<string, any>;
type Window = { pid: number; window_id: number; id: string; process_instance: string; app_name: string; title: string; foreground: boolean; bounds: unknown; visible: boolean };
type Binding = { context: Args; target: Window; revoked: boolean };
type Observation = { snapshot: string; target: Window; refs: Map<number, string>; elements: Args[]; binding?: string; epoch?: number };
type Lease = { home: string; abort: AbortController; observation?: Observation; calls: Set<Promise<unknown>>; task?: string };
const record = (value: unknown): Args => value && typeof value === "object" && !Array.isArray(value) ? value as Args : {};
const success = (structuredContent: Args) => ({ structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] });
const refused = (code: string) => ({ ...success({ status: "refused", code, refusal: { code }, retryable: false }), isError: true });
const uncertain = () => ({ ...success({ status: "uncertain", code: "outcomeUnknown", retryable: false }), isError: true });
const TARGET = { pid: { type: "integer", minimum: 1 }, window_id: { type: "integer", minimum: 1 } };
const ELEMENT = { ...TARGET, snapshot_id: { type: "string" }, element_index: { type: "integer", minimum: 0 }, element_token: { type: "string" } };
function tool(name: string, description: string, properties: Args, required: string[] = []): CuaTool {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

/** Only reviewed, window/ref-scoped commands enter the shared CUA gateway. */
export const AGENT_DESKTOP_TOOLS: CuaTool[] = [
  tool("list_windows", "List accessible application windows. Observe one window before acting.", {}),
  ...["get_window_state", "get_accessibility_tree"].map(name => tool(name,
    (name === "get_accessibility_tree" ? "Supplementary tree read; use get_window_state before any write. " : "") +
    "Read the accessibility tree of exactly one window. Use the returned snapshot_id and element_index for actions; observe again after an action.", TARGET, ["pid", "window_id"])),
  tool("get_desktop_state", "List available windows; select one with get_window_state before acting.", TARGET),
  ...["click", "double_click", "right_click"].map(name => tool(name, "Act on an exact element from the latest window observation. Headless semantic delivery only.", ELEMENT, ["pid", "window_id", "snapshot_id", "element_index"])),
  tool("set_value", "Replace an editable element's value through accessibility.", { ...ELEMENT, value: { type: "string", maxLength: 131072 } }, ["pid", "window_id", "snapshot_id", "element_index", "value"]),
  tool("type_text", "Insert text into an exact editable element from the latest observation.", { ...ELEMENT, text: { type: "string", maxLength: 131072 } }, ["pid", "window_id", "snapshot_id", "element_index", "text"]),
  tool("scroll", "Scroll the observed element semantically.", { ...ELEMENT, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 100 } }, ["pid", "window_id", "snapshot_id", "element_index", "direction"]),
  tool("check_permissions", "Check the selected engine's current OS permissions without prompting.", {}),
  tool("health_report", "Read selected engine availability.", {}),
  tool("get_config", "Read selected engine capabilities.", {}),
];

/** Adapter owns process identities and ref namespaces. It never accepts raw commands or output paths. */
export class AgentDesktopAdapter {
  private active = false;
  private generation = 0;
  private nextWindow = 1;
  private windowIds = new Map<string, number>();
  private bindings = new Map<string, Binding>();
  private leases = new Map<string, Lease>();
  private controls = new AbortController();
  private controlCalls = new Set<Promise<unknown>>();
  constructor(private run: DesktopRun, private home: string) {}
  get running() { return this.active; }
  start() { this.active = true; this.generation++; this.controls = new AbortController(); }
  async stop() {
    this.active = false; this.controls.abort();
    for (const lease of this.leases.values()) lease.abort.abort();
    await Promise.allSettled([...this.controlCalls, ...[...this.leases.values()].flatMap(lease => [...lease.calls])]);
    for (const lease of this.leases.values()) fs.rmSync(lease.home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    this.leases.clear(); this.bindings.clear(); this.windowIds.clear();
    this.controls = new AbortController();
  }
  private async invoke(args: string[], lease?: Lease, input?: string): Promise<DesktopEnvelope> {
    const signal = lease?.abort.signal ?? this.controls.signal;
    if (signal.aborted) throw new Error("operationCancelled");
    const calls = lease?.calls ?? this.controlCalls;
    const call = this.run(args, { home: lease?.home ?? path.join(this.home, "control"), signal, input });
    calls.add(call);
    try { return await call; } finally { calls.delete(call); }
  }
  async permissions(guide = false) {
    const reply = await this.invoke(["permissions", ...(guide ? ["--guide"] : [])]);
    const data = record(reply.data), value = (key: string) => data[key]?.state === "granted" ? true : data[key]?.state === "denied" ? false : null;
    return { accessibility: value("accessibility"), screenRecording: value("screen_recording") };
  }
  private async windows(lease?: Lease): Promise<Window[]> {
    const reply = await this.invoke(["list-windows"], lease);
    if (!reply.ok || !Array.isArray(reply.data)) throw new Error("targetClosed");
    return reply.data.filter((item: Args) => item.accessible === true && item.visible !== false &&
      Number.isSafeInteger(item.pid) && item.pid > 0 && typeof item.id === "string" &&
      typeof item.process_instance === "string" && item.process_instance.length > 0).slice(0, 250).map((item: Args) => {
      const key = `${item.process_instance}:${item.id}`;
      let window_id = this.windowIds.get(key);
      if (!window_id) { window_id = this.nextWindow++; this.windowIds.set(key, window_id); }
      return { pid: item.pid, window_id, id: item.id, process_instance: item.process_instance,
        app_name: String(item.app_name ?? ""), title: String(item.title ?? ""), foreground: item.is_focused === true,
        bounds: item.bounds, visible: item.visible === true };
    });
  }
  private async target(args: Args, lease?: Lease) {
    if (!Number.isSafeInteger(args.pid) || !Number.isSafeInteger(args.window_id)) throw new Error("scopeViolation");
    const target = (await this.windows(lease)).find(item => item.pid === args.pid && item.window_id === args.window_id);
    if (!target) throw new Error("targetClosed");
    return target;
  }
  private sameWindow(a: Window, b: Window) { return a.id === b.id && a.pid === b.pid && a.process_instance === b.process_instance; }
  private bindingContext(context: Args) {
    if (typeof context.task_id !== "string" || typeof context.binding_id !== "string" || !Number.isSafeInteger(context.epoch) ||
      context.epoch < 1 || context.host_pid !== process.pid || !["background", "foreground"].includes(context.mode)) throw new Error("scopeViolation");
    return context;
  }
  private matches(a: Args, b: Args) {
    return ["task_id", "binding_id", "host_pid", "epoch", "pid", "window_id", "mode"].every(key => a[key] === b[key]);
  }
  private sameBinding(a: Args, b: Args) {
    return ["task_id", "binding_id", "host_pid", "pid", "window_id", "mode"].every(key => a[key] === b[key]);
  }
  private async revoke(taskId: string) {
    const binding = this.bindings.get(taskId);
    if (binding) binding.revoked = true;
    const leases = [...this.leases.values()].filter(lease => lease.task === taskId);
    for (const lease of leases) { lease.observation = undefined; lease.abort.abort(); }
    await Promise.allSettled(leases.flatMap(lease => [...lease.calls]));
    return { drained: true };
  }
  async request(method: string, name?: string, raw?: Args): Promise<{ ok: boolean; result?: Args; error?: string }> {
    try {
      if (method === "metadata") return { ok: this.active, result: { driver_version: "agent-desktop/1.2.0" } };
      if (!this.active) return { ok: false, error: "daemonNotReady" };
      const args = record(raw);
      if (method === "call") {
        if (name === "list_windows") return { ok: true, result: success({ windows: await this.windows() }) };
        if (name === "check_permissions") return { ok: true, result: success(await this.permissions()) };
        return { ok: false, error: "toolNotAllowed" };
      }
      if (method !== "nuwax_task") return { ok: false, error: "toolNotAllowed" };
      if (name === "states") return { ok: true, result: { tasks: await Promise.all([...this.bindings.values()].map(async binding => {
        const context = binding.context;
        const current = await this.target(context).catch(() => null);
        return { ...context, window: { valid: !!current && this.sameWindow(current, binding.target),
          foreground: current?.foreground, visible: current?.visible, bounds: current?.bounds } };
      })) } };
      const context = this.bindingContext(args), old = this.bindings.get(context.task_id);
      if (name === "bind") {
        const epoch = old?.context.epoch, generation = this.generation;
        const target = await this.target(context);
        if (!this.active || generation !== this.generation || old !== this.bindings.get(context.task_id) || old?.context.epoch !== epoch)
          return { ok: false, error: "operationCancelled" };
        if (context.mode !== "background") return { ok: false, error: "engineCapabilityUnsupported" };
        if (old?.revoked && context.epoch <= old.context.epoch) return { ok: false, error: "scopeViolation" };
        if (old && (!this.matches(old.context, context) || !this.sameWindow(old.target, target))) {
          if (context.epoch <= old.context.epoch) return { ok: false, error: "scopeViolation" };
          await this.revoke(context.task_id);
        }
        this.bindings.set(context.task_id, { context: { ...context }, target, revoked: false });
        return { ok: true, result: { bound: true } };
      }
      // Host pause/stop advances the task epoch before requesting native drain.
      // A newer revoke retires every older lease; it never re-arms the binding.
      if (name === "revoke" && old && this.sameBinding(old.context, context) && context.epoch >= old.context.epoch) {
        old.context = { ...context };
        return { ok: true, result: await this.revoke(context.task_id) };
      }
      if (!old || !this.matches(old.context, context)) return { ok: false, error: "scopeViolation" };
      if (name === "status") return { ok: true, result: { drained: old.revoked && ![...this.leases.values()].some(lease => lease.task === context.task_id && lease.calls.size) } };
      if (name === "forget") { await this.revoke(context.task_id); this.bindings.delete(context.task_id); return { ok: true }; }
      if (name === "window") {
        const current = await this.target(context);
        return { ok: true, result: { valid: this.sameWindow(current, old.target), foreground: current.foreground } };
      }
      if (name === "takeover" && old.revoked) {
        const current = await this.target(context);
        if (!this.sameWindow(current, old.target)) return { ok: false, error: "targetClosed" };
        const reply = await this.invoke(["--headed", "focus-window", "--app", current.app_name, "--window-id", current.id]);
        return { ok: reply.ok, result: { activated: reply.ok && reply.data?.disposition?.delivery === "delivered_verified" } };
      }
      return { ok: false, error: "engineCapabilityUnsupported" };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "operationFailed" }; }
  }
  transport() {
    const id = randomUUID(), lease: Lease = { home: path.join(this.home, String(this.generation), id), abort: new AbortController(), calls: new Set() };
    this.leases.set(id, lease);
    return new CuaAdapterTransport(async message => {
      if (message.method === "initialize") return { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "nuwax-agent-desktop-adapter", version: "1.0.0" } };
      if (message.method === "tools/list") return { tools: AGENT_DESKTOP_TOOLS };
      if (message.method === "notifications/initialized" || message.method === "ping") return {};
      if (message.method !== "tools/call") throw new Error("toolNotAllowed");
      return this.call(String(message.params?.name), record(message.params?.arguments), lease);
    }, async () => {
      lease.abort.abort(); await Promise.allSettled([...lease.calls]);
      fs.rmSync(lease.home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); this.leases.delete(id);
    });
  }
  private async call(name: string, args: Args, lease: Lease) {
    let write = false;
    try {
      if (!this.active || lease.abort.signal.aborted) return refused("operationCancelled");
      if (!AGENT_DESKTOP_TOOLS.some(tool => tool.name === name)) return refused("toolNotAllowed");
      if (name === "get_config" || name === "health_report") return success({ status: "ok", engine: "agent-desktop", headless: true, physical_input: false, preview: false, browser: false });
      if (name === "check_permissions") return success(await this.permissions());
      if (name === "list_windows" || name === "get_desktop_state" && !args.pid) return success({ windows: await this.windows(lease) });
      const target = await this.target(args, lease);
      const context = args._nuwax_task ? this.bindingContext(record(args._nuwax_task)) : undefined;
      const binding = context ? this.bindings.get(context.task_id) : undefined;
      if (context && (!binding || binding.revoked || !this.matches(binding.context, context) || !this.sameWindow(binding.target, target))) return refused("scopeViolation");
      if (binding) { lease.task = context!.task_id; if (target.foreground) return refused("user_in_control"); }
      if (["get_window_state", "get_accessibility_tree", "get_desktop_state"].includes(name)) {
        lease.observation = undefined;
        const reply = await this.invoke(["snapshot", "--app", target.app_name, "--window-id", target.id, "--include-bounds", "--timeout-ms", "8000"], lease);
        if (!reply.ok) return refused(reply.error?.code ?? "observationFailed");
        if (isSensitiveObservation(reply.data)) return refused("sensitiveObservation");
        const data = record(reply.data);
        const after = await this.target(args, lease);
        if (!this.sameWindow(target, after) || data.app !== target.app_name ||
          data.pid !== undefined && data.pid !== target.pid || data.process_instance !== undefined && data.process_instance !== target.process_instance ||
          (typeof data.window === "object" ? data.window?.id : data.window_id) !== target.id) return refused("scopeViolation");
        if (lease.abort.signal.aborted || binding?.revoked) return refused("operationCancelled");
        const snapshot = "s" + randomBytes(4).toString("hex"), refs = new Map<number, string>(), elements: Args[] = [];
        const walk = (node: Args) => {
          const index = elements.length;
          const ref = typeof node.ref_id === "string" && /^@s[a-zA-Z0-9]+:e\d+$/.test(node.ref_id) ? node.ref_id : undefined;
          elements.push({ element_index: index, ...(ref ? { element_token: `${snapshot}:${index}` } : {}),
            role: node.role, name: node.name, value: node.value, description: node.description, frame: node.bounds,
            available_actions: node.available_actions });
          if (ref) refs.set(index, ref);
          if (Array.isArray(node.children)) for (const child of node.children) walk(record(child));
        };
        walk(record(data.tree));
        lease.observation = { snapshot, target, refs, elements, binding: context?.binding_id, epoch: context?.epoch };
        return success({ status: "ok", snapshot_id: snapshot, pid: target.pid, window_id: target.window_id,
          app: target.app_name, title: target.title, elements, complete: data.complete === true });
      }
      const evidence = lease.observation;
      const token = typeof args.element_token === "string" ? /^(s[0-9a-f]{8}):(\d+)$/.exec(args.element_token) : undefined;
      const snapshot = args.snapshot_id ?? token?.[1], index = args.element_index ?? (token ? Number(token[2]) : undefined);
      if (!evidence || snapshot !== evidence.snapshot || !Number.isSafeInteger(index) || !this.sameWindow(evidence.target, target) ||
        evidence.binding !== context?.binding_id || evidence.epoch !== context?.epoch ||
        token && (token[1] !== snapshot || Number(token[2]) !== index)) return refused("staleObservation");
      const ref = evidence.refs.get(index);
      if (!ref) return refused("scopeViolation");
      if (sensitiveUiRefusal(name === "type_text" ? "set_value" : name, args, evidence.elements[index], { app: target.app_name, title: target.title }))
        return refused("sensitiveTarget");
      if (args.delivery_mode === "foreground") return refused("engineCapabilityUnsupported");
      const command = ({ click: "click", double_click: "double-click", right_click: "right-click", set_value: "set-value", type_text: "type", scroll: "scroll" } as Args)[name];
      if (!command) return refused("toolNotAllowed");
      const argv = [command, ref];
      let input: string | undefined;
      if (["set_value", "type_text"].includes(name)) {
        input = name === "set_value" ? args.value : args.text;
        if (typeof input !== "string" || Buffer.byteLength(input) > 131072) return refused("scopeViolation");
        argv.push("--stdin");
      }
      if (name === "scroll") {
        if (!["up", "down", "left", "right"].includes(args.direction) || args.amount !== undefined && (!Number.isInteger(args.amount) || args.amount < 1 || args.amount > 100)) return refused("scopeViolation");
        argv.push("--direction", args.direction, "--amount", String(args.amount ?? 3));
      }
      if (lease.abort.signal.aborted || binding?.revoked) return refused("operationCancelled");
      write = true; lease.observation = undefined;
      const reply = await this.invoke(argv, lease, input);
      const delivery = (reply.ok ? reply.data?.disposition : reply.error?.disposition)?.delivery;
      if (delivery === "not_delivered") return refused(reply.error?.code ?? "actionRefused");
      if (!reply.ok || delivery !== "delivered_verified") return uncertain();
      return success({ status: "ok", effect: "delivered_verified" });
    } catch (error) {
      return write ? uncertain() : refused(error instanceof Error ? error.message : "operationFailed");
    }
  }
}
