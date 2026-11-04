import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { FeatureSettings } from "../_kit/types";
import type { ShellAccess, ShellDomain, ShellChange } from "@shared/features/shell-capabilities/contract";
import { shellError, type ShellThemeService, type ShellAuthoringContext, type ShellLinkPreference } from "./ports";

export type PluginOperation = "list" | "install" | "enable" | "disable" | "remove" | "configure";
export interface ShellToolPorts {
  themes(): ShellThemeService | null;
  themeAuthoring(): ShellAuthoringContext;
  linkPreference: ShellLinkPreference;
  settings: FeatureSettings;
  plugins?(operation: PluginOperation, input: { target?: string; expectedRevision?: number; patch?: Record<string, unknown> }, signal: AbortSignal): Promise<unknown>;
  check(domain?: ShellDomain): void;
  record?(change: Pick<ShellChange, "domain" | "operation" | "status">): void;
}
const id = z.string().min(1).max(100);
const revision = z.number().int().positive();
const version = z.string().regex(/^[a-f0-9]{64}$/);
const edit = {
  themeId: id, expectedRevision: revision, expectedVersion: version,
  changes: z.array(z.object({ path: z.string().min(1).max(240), content: z.string().max(7 * 1024 * 1024).nullable(), encoding: z.enum(["utf8", "base64"]).optional() }).strict()).min(1).max(500),
};
const settingsVersion = (value: string) => createHash("sha256").update(value).digest("hex");

export function createShellMcpServer(access: ShellAccess, ports: ShellToolPorts) {
  const server = new McpServer({ name: "nuwax-shell", version: "1.0.0" });
  // SDK v1 accepts Zod 3/4 through a deeply recursive overload. Keep that
  // compatibility boundary here; our own shape still infers each handler's input.
  const register = server.registerTool.bind(server) as unknown as (name: string,
    config: { description: string; inputSchema: z.ZodRawShape; annotations: { readOnlyHint: boolean; openWorldHint: boolean } },
    callback: (args: unknown, extra: { signal: AbortSignal }) => Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }>) => unknown;
  const themes = () => { const service = ports.themes(); if (!service) throw new Error("Themes are unavailable"); return service; };
  function tool<S extends z.ZodRawShape>(name: string, domain: ShellDomain | undefined, description: string, schema: S,
    run: (args: z.infer<z.ZodObject<S>>, check: () => void, signal: AbortSignal) => Promise<unknown> | unknown, readOnly = false) {
    if (domain && !access[domain]) return;
    register(name, { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, openWorldHint: domain === "extensions" } }, async (args, extra) => {
      const check = () => { ports.check(domain); if (extra.signal.aborted) throw new Error("Shell operation canceled"); };
      let admitted = false, recorded = false;
      const operation = name === "extensions_manage" && args && typeof args === "object" && "operation" in args ? `extensions_${String(args.operation)}` : name;
      const record = (status: ShellChange["status"]) => {
        if (admitted && !recorded && !readOnly && domain) { recorded = true; ports.record?.({ domain, operation, status }); }
      };
      try {
        check();
        admitted = true;
        const value = await run(z.object(schema).strict().parse(args), check, extra.signal);
        const failed = value && typeof value === "object" && "application" in value && value.application === "failed";
        const saved = value && typeof value === "object" && "application" in value && value.application === "restart-required";
        record(failed ? "failed" : saved ? "saved" : "applied");
        check();
        return { ...(failed ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(value) }] };
      } catch (error) {
        record(extra.signal.aborted ? "canceled" : "failed");
        return { isError: true, content: [{ type: "text" as const, text: shellError(error) }] };
      }
    });
  }
  tool("shell_capabilities", undefined, "Discover the Nuwax host capabilities the user has authorized. This service cannot change its own permissions.", {}, () => ({
    access, domains: { themes: "Personal theme files, validation, hot reload and history", settings: "Declared desktop preferences", extensions: "Native DSH bundle management" },
    mutationPolicy: "Read current versions before changing. Copy builtins and linked folders to personal themes. Report actual results; only the user can expand access.",
  }), true);
  tool("themes_context", "themes", "Read themes, selection, revision, editable token names, defaults and package format before making changes.", {}, () => {
    const state = themes().state();
    const { tokenNames, defaultTokens, surfaces } = ports.themeAuthoring();
    return { revision: state.revision, selection: state.selection, themes: state.themes, history: themes().history(), tokenNames, defaultTokens, surfaces,
      packageFormat: { manifest: "theme.json (schemaVersion: 1, id, name, version, variants: { light?: { tokens, styles? }, dark?: { tokens, styles? } })",
        tokens: "JSON object using tokenNames; omitted tokens inherit defaults", styles: "CSS files scoped to declared surfaces; use [data-theme-part] and --nuwax-* variables. Remote URLs, @import and executable content are forbidden.",
        assets: "Local images/fonts in the same package", editing: "themes_read_files returns versions. Builtin/linked themes must be copied with themes_copy before modification." } };
  }, true);
  tool("themes_read_files", "themes", "Read complete validated theme files and optimistic concurrency versions. JSON/CSS/README are UTF-8; assets are base64.", { themeId: id }, async ({ themeId }) => {
    const current = await themes().readForEdit(themeId);
    return { ...current, files: Object.entries(current.files).map(([path, content]) => /\.(json|css|md)$/.test(path)
      ? { path, content: Buffer.from(content, "base64").toString("utf8"), encoding: "utf8" } : { path, content, encoding: "base64" }) };
  }, true);
  tool("themes_copy", "themes", "Create a managed personal copy of a builtin, linked or installed theme. Does not select it automatically.", {
    sourceId: id, themeId: id, name: z.string().min(1).max(80), expectedRevision: revision, expectedVersion: version,
  }, (args, check) => themes().copyForEdit(args, check));
  tool("themes_validate", "themes", "Validate complete candidate multi-file changes without writing. Null content deletes a file.", edit, args => themes().previewChanges(args), true);
  tool("themes_apply_changes", "themes", "Validate and atomically apply all changes to one managed personal theme. Saves durable undo history and hot reloads the active theme.", edit, (args, check) => themes().applyChanges(args, check));
  tool("themes_select", "themes", "Select a theme and light/dark/system mode. Requires the current revision from themes_context.", {
    themeId: id, mode: z.enum(["light", "dark", "system"]), expectedRevision: revision,
  }, ({ themeId, mode, expectedRevision }, check) => themes().select(themeId, mode, false, expectedRevision, check));
  tool("themes_history", "themes", "Read available durable theme restore points, newest first.", {}, () => ({ revision: themes().state().revision, history: themes().history() }), true);
  tool("themes_rollback", "themes", "Restore files and selection from a saved theme edit. Read the target theme files first to obtain its current version.", {
    historyId: z.string().uuid(), expectedRevision: revision, expectedVersion: version,
  }, (args, check) => themes().restore(args, check));
  tool("shell_settings_get", "settings", "Read the declared desktop settings and their writable schema. Only listed settings can be changed.", {}, () => {
    const value = ports.linkPreference.normalize(ports.settings.read(ports.linkPreference.key));
    return { version: settingsVersion(value), values: { linkOpenMode: value }, schema: { linkOpenMode: { type: "string", enum: ["in-app", "system"], effect: "Next link opening", recovery: "Set the previous value with shell_settings_update" } } };
  }, true);
  tool("shell_settings_update", "settings", "Change the declared link opening preference. Returns the previous value for restoration. Does not accept arbitrary settings keys.", {
    expectedVersion: version, linkOpenMode: z.enum(["in-app", "system"]),
  }, (args, check) => {
    const previous = ports.linkPreference.normalize(ports.settings.read(ports.linkPreference.key));
    if (settingsVersion(previous) !== args.expectedVersion) throw new Error("Settings version conflict; read again");
    check();
    if (!ports.settings.write(ports.linkPreference.key, args.linkOpenMode)) throw new Error("Settings could not be saved");
    return { applied: true, effect: "Next link opening", previous: { linkOpenMode: previous }, version: settingsVersion(args.linkOpenMode) };
  });
  tool("extensions_list", "extensions", "Read native DSH bundles, their state, protected core bundles and restart requirements. DS-Bot must be running.", {}, (_args, _check, signal) => {
    if (!ports.plugins) throw new Error("DSH plugin management is unavailable");
    return ports.plugins("list", {}, signal);
  }, true);
  tool("extensions_manage", "extensions", "Install or manage a trusted DSH bundle through the native Plugin Manager. Installed code runs locally. Protected runtime bundles cannot be changed. Native results distinguish saved changes from running state.", {
    operation: z.enum(["install", "enable", "disable", "remove"]), target: z.string().min(1).max(500),
  }, ({ operation, target }, check, signal) => {
    check();
    if (!ports.plugins) throw new Error("DSH plugin management is unavailable");
    return ports.plugins(operation, { target }, signal);
  });
  tool("extensions_configure", "extensions", "Update the public live settings of a third-party plugin using its declared schema and revision from extensions_list. Core host/model configuration is protected and secrets are redacted by DSH.", {
    target: id, expectedRevision: z.number().int().nonnegative(), patch: z.record(z.unknown()),
  }, (args, check, signal) => {
    check();
    if (!ports.plugins) throw new Error("DSH plugin management is unavailable");
    return ports.plugins("configure", args, signal);
  });
  return server;
}
