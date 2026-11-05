import { createHash } from 'node:crypto'

// This adapter is tied to the npm-locked Client. Upgrades must review each product entry again.
export const BOT_CLIENT_SHA256 = '8d25c9a5e036cdd5c6d3bf27977ef3a49848b407e9eb2f225a12faeb55a633df'
const marker = '// Nuwax DS Bot workbench profile v1\n'

export function botClientProfile(source) {
  if (createHash('sha256').update(source).digest('hex') !== BOT_CLIENT_SHA256) throw new Error('Unsupported DS Bot Client source; review the Nuwax workbench adapter')
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw new Error('DS Bot workbench adapter anchor changed')
    source = source.replace(from, to)
  }
  replace('function readMode(storage = globalThis.localStorage) {', 'function readMode(storage = globalThis.localStorage) {\n  if (globalThis.nuwaxBotHost) return "bot";')
  replace('setSurface: (mode) => {', 'setSurface: (mode) => {\n      if (globalThis.nuwaxBotHost && mode !== "bot") return;')
  replace('actions.setSurface ? (0, import_react47.createElement)(', '!globalThis.nuwaxBotHost && actions.setSurface ? (0, import_react47.createElement)(')
  replace('const groups = [\n    [\n      [t("Usage"), GaugeIcon,', 'const groups = globalThis.nuwaxBotHost ? [[\n    [t("Usage"), GaugeIcon, () => actions.openSettings("usage")],\n    [t("Automation tasks"), ClockIcon, () => actions.selectPanel("schedules")],\n    [t("Bot settings"), GearIcon, () => actions.openSettings("general")],\n    [t("Harness settings"), SlidersIcon, () => globalThis.nuwaxBotHost.openSettings()]\n  ]] : [\n    [\n      [t("Usage"), GaugeIcon,')
  replace('actions.signInEntry = () => ctx.slots.entries?.("settings.models.sign-in")?.[0] ?? null;', 'actions.signInEntry = () => globalThis.nuwaxBotHost ? null : ctx.slots.entries?.("settings.models.sign-in")?.[0] ?? null;')
  replace('actions.openHarnessSettings = openHarnessSettings;', 'actions.openHarnessSettings = globalThis.nuwaxBotHost ? () => globalThis.nuwaxBotHost.openSettings() : openHarnessSettings;')
  replace('actions.openHarnessModels = () => {', 'actions.openHarnessModels = () => {\n    if (globalThis.nuwaxBotHost) return globalThis.nuwaxBotHost.openSettings();')
  replace('if ((roster.agents ?? []).length === 0 && actions.addAgent) {', 'if (!globalThis.nuwaxBotHost && (roster.agents ?? []).length === 0 && actions.addAgent) {')
  replace('const pages = SETTINGS_PAGES.filter(([key]) => key !== "models" || actions.providers !== void 0);', 'const pages = SETTINGS_PAGES.filter(([key]) => globalThis.nuwaxBotHost ? !["models", "connectors"].includes(key) : key !== "models" || actions.providers !== void 0);')
  replace('dsh?.current ? (0, import_react45.createElement)(Row3, { label: "DeepSeek Harness"', '!globalThis.nuwaxBotHost && dsh?.current ? (0, import_react45.createElement)(Row3, { label: "DeepSeek Harness"')
  // Translate product-owned navigation copy; upstream credits and diagnostics stay intact.
  source = source.replaceAll('"Harness settings"', '"Nuwax settings"').replaceAll('"Harness 设置"', '"Nuwax 设置"')
    .replaceAll('"Open Harness settings"', '"Open Nuwax settings"').replaceAll('"打开 Harness 设置"', '"打开 Nuwax 设置"')
    .replaceAll('"Models, providers, and the rest of DeepSeek Harness"', '"Model authorization and plugins in Nuwax"')
    .replaceAll('"模型、服务商和 DeepSeek Harness 的其他设置"', '"Nuwax 中的模型授权与插件设置"')
  return marker + source
}
