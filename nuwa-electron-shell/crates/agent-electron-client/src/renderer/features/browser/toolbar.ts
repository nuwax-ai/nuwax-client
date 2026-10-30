import {
  BROWSER_TOOLBAR_HEIGHT,
  BROWSER_AUXILIARY_BAR_HEIGHT,
  type BrowserCommand,
  type BrowserState,
  type BrowserWindowBridge,
} from "@shared/features/browser/contract";
import "./toolbar.css";
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
const run = (command: BrowserCommand) => {
  void bridge.command(command).catch(() => {});
};
const button = (id: string, action: () => void) =>
  element(id).addEventListener("click", action);
const label = (id: string, value: string) => {
  const node = element(id);
  node.title = value;
  node.setAttribute("aria-label", value);
};
function render(state: BrowserState) {
  const wasFinding = current?.finding;
  const wasAddressOpen = current?.addressOpen;
  current = state;
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
  element("reload").textContent = state.loading ? "×" : "↻";
  element("pin").setAttribute("aria-pressed", String(state.pinned));
  element("error").hidden = !state.error;
  element("loadingState").hidden = !state.initialLoading;
  element("loadingText").textContent = state.labels.loading;
  element("errorMessage").textContent = state.error;
  element("findbar").hidden = !state.finding;
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
    minimize: "minimize",
    closeWindow: "close",
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
  if (state.finding && !wasFinding) {
    element<HTMLInputElement>("query").focus();
    element<HTMLInputElement>("query").select();
  }
  if (state.addressOpen && !wasAddressOpen) {
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
button("menu", () => run({ type: "menu" }));
button("pin", () => run({ type: "pin" }));
button("retry", () => run({ type: "reload" }));
button("external", () => run({ type: "external" }));
button("copy", () => run({ type: "copy" }));
button("copyLink", () => run({ type: "copy" }));
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
window.addEventListener("unload", unsubscribe, { once: true });
void bridge
  .getState()
  .then((state) => {
    if (state) render(state);
  })
  .catch(() => {});
