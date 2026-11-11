import {
  BROWSER_TOOLBAR_HEIGHT,
  BROWSER_AUXILIARY_BAR_HEIGHT,
  type BrowserCommand,
  type BrowserState,
  type BrowserWindowBridge,
} from "@shared/features/browser/contract";
import "./toolbar.css";
import { createTabStrip } from "./tabStrip";
document.documentElement.style.setProperty(
  "--toolbar-height",
  `${BROWSER_TOOLBAR_HEIGHT}px`,
);
document.documentElement.style.setProperty(
  "--auxiliary-bar-height",
  `${BROWSER_AUXILIARY_BAR_HEIGHT}px`,
);
const bridge = (window as unknown as { browserWindow: BrowserWindowBridge })
  .browserWindow;
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let current: BrowserState | null = null;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let lastFeedbackId = 0;
const run = (command: BrowserCommand) => {
  void bridge.command(command).catch(() => {});
};
const renderTabs = createTabStrip(run);
const button = (id: string, action: () => void) =>
  element(id).addEventListener("click", action);
const label = (id: string, value: string) => {
  const node = element(id);
  node.title = value;
  node.setAttribute("aria-label", value);
};
function render(state: BrowserState) {
  const tabChanged = current?.activeTabId !== state.activeTabId;
  const wasFinding = current?.finding;
  const findFocusRequested =
    current?.findFocusRequest !== state.findFocusRequest;
  const wasAddressOpen = current?.addressOpen;
  current = state;
  renderTabs(state);
  document.title = state.title || "Nuwax";
  document.body.classList.toggle("dark", state.dark);
  document.body.dataset.platform = state.platform;
  element("windowControls").hidden = state.platform === "darwin";
  const restored = state.maximized || state.fullscreen;
  element("maximizeIcon").toggleAttribute("hidden", restored);
  element("restoreIcon").toggleAttribute("hidden", !restored);
  element("title").textContent = state.title;
  element("domain").textContent = state.domain;
  element("domain").hidden = state.initialLoading;
  element("location").setAttribute("aria-expanded", String(state.addressOpen));
  element("address").hidden = !state.addressOpen;
  element<HTMLInputElement>("url").value = state.url;
  element<HTMLButtonElement>("back").disabled = !state.canGoBack;
  element<HTMLButtonElement>("forward").disabled = !state.canGoForward;
  element("navigation").hidden = !state.canGoBack && !state.canGoForward;
  element("reloadIcon").toggleAttribute("hidden", state.loading);
  element("stopIcon").toggleAttribute("hidden", !state.loading);
  element("pin").setAttribute("aria-pressed", String(state.pinned));
  element("error").hidden = !state.error;
  element("loadingState").hidden = !state.initialLoading;
  element("loadingText").textContent = state.labels.loading;
  element("errorMessage").textContent = state.error;
  element("findbar").hidden = !state.finding;
  element("search").setAttribute("aria-expanded", String(state.finding));
  // 主进程关闭查找时会清空匹配；输入框也结束本轮查询，避免重开后旧词配 0/0。
  if (!state.finding && wasFinding)
    element<HTMLInputElement>("query").value = "";
  if (tabChanged) {
    element<HTMLInputElement>("query").value = state.findText ?? "";
    clearTimeout(feedbackTimer);
    element("feedback").hidden = true;
  }
  element("matches").textContent = `${state.activeMatch}/${state.matches}`;
  const l = state.labels;
  for (const [id, key] of Object.entries({
    back: "back",
    forward: "forward",
    menu: "more",
    previous: "findPrevious",
    next: "findNext",
    closefind: "close",
    location: "url",
    copyLink: "copy",
    search: "find",
    minimize: "minimize",
    closeWindow: "close",
    closeTab: "close",
  }))
    label(id, l[key]);
  element("location").title = `${l.url}: ${state.url}`;
  label("maximize", l[restored ? "restore" : "maximize"]);
  label("reload", l[state.loading ? "stop" : "reload"]);
  label("pin", l[state.pinned ? "unpin" : "pin"]);
  element<HTMLInputElement>("query").placeholder = l.find;
  label("query", l.find);
  element("urlLabel").textContent = l.url;
  for (const id of ["retry", "external", "copy"])
    element(id).textContent = l[id];
  label("closeAddress", l.close);
  if (state.copyFeedback && state.copyFeedback.id > lastFeedbackId) {
    lastFeedbackId = state.copyFeedback.id;
    clearTimeout(feedbackTimer);
    element("feedbackText").textContent =
      l[state.copyFeedback.success ? "copyDone" : "copyFailed"];
    element("feedbackSuccess").hidden = !state.copyFeedback.success;
    element("feedback").hidden = false;
    feedbackTimer = setTimeout(() => {
      element("feedback").hidden = true;
    }, 2200);
  }
  if (state.finding && (tabChanged || !wasFinding || findFocusRequested)) {
    element<HTMLInputElement>("query").focus();
    element<HTMLInputElement>("query").select();
  }
  if (state.addressOpen && (tabChanged || !wasAddressOpen)) {
    element<HTMLInputElement>("url").focus();
    element<HTMLInputElement>("url").select();
  } else if (
    !state.addressOpen &&
    wasAddressOpen &&
    document.activeElement?.closest("#address")
  ) {
    element("location").focus();
  }
}
button("back", () => run({ type: "back" }));
button("forward", () => run({ type: "forward" }));
button("reload", () => run({ type: current?.loading ? "stop" : "reload" }));
button("menu", () => {
  const { x } = element("pageIdentity").getBoundingClientRect();
  run({ type: "menu", x });
});
button("pin", () => run({ type: "pin" }));
button("retry", () => run({ type: "reload" }));
button("external", () => run({ type: "external" }));
button("copy", () => run({ type: "copy" }));
button("copyLink", () => run({ type: "copy" }));
button("closeTab", () => {
  if (current) run({ type: "tab-close", id: current.activeTabId });
});
button("search", () => run({ type: "find-open" }));
button("location", () =>
  run({ type: current?.addressOpen ? "address-close" : "address-open" }),
);
button("closeAddress", () => run({ type: "address-close" }));
button("minimize", () => run({ type: "window-minimize" }));
button("maximize", () => run({ type: "window-maximize" }));
button("closeWindow", () => run({ type: "window-close" }));
const find = (forward = true, next = false) =>
  run({
    type: "find",
    text: element<HTMLInputElement>("query").value,
    forward,
    next,
  });
element("query").addEventListener("input", () => find());
element("query").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    find(!event.shiftKey, true);
  }
});
button("previous", () => find(false, true));
button("next", () => find(true, true));
button("closefind", () => run({ type: "find-close" }));
const unsubscribe = bridge.onState(render);
window.addEventListener("unload", () => {
  clearTimeout(feedbackTimer);
  unsubscribe();
}, { once: true });
void bridge
  .getState()
  .then((state) => {
    // 推送可能先于初始请求返回；不能用旧快照覆盖已经显示的新状态。
    if (state && !current) render(state);
  })
  .catch(() => {});
