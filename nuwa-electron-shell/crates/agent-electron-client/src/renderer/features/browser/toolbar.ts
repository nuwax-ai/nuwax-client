import type {
  BrowserCommand,
  BrowserState,
  BrowserWindowBridge,
} from "@shared/features/browser/contract";
import "./toolbar.css";
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
  current = state;
  document.title = state.title || "Nuwax";
  document.body.classList.toggle("dark", state.dark);
  element("title").textContent = state.title;
  element("domain").textContent = state.domain;
  element("location").title = state.url;
  element<HTMLButtonElement>("back").disabled = !state.canGoBack;
  element<HTMLButtonElement>("forward").disabled = !state.canGoForward;
  element("reload").textContent = state.loading ? "×" : "↻";
  element("pin").setAttribute("aria-pressed", String(state.pinned));
  element("error").hidden = !state.error;
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
  }))
    label(id, l[key]);
  label("reload", l[state.loading ? "stop" : "reload"]);
  label("pin", l[state.pinned ? "unpin" : "pin"]);
  element<HTMLInputElement>("query").placeholder = l.find;
  label("query", l.find);
  element("urlLabel").textContent = l.url;
  for (const id of ["retry", "external", "copy"])
    element(id).textContent = l[id];
  element("copyUrl").textContent = l.copy;
  label("closeAddress", l.close);
  if (state.finding && !wasFinding) {
    element<HTMLInputElement>("query").focus();
    element<HTMLInputElement>("query").select();
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
button("copyUrl", () => run({ type: "copy" }));
button("location", () => {
  element<HTMLInputElement>("url").value = current?.url ?? "";
  element<HTMLDialogElement>("address").showModal();
  element<HTMLInputElement>("url").select();
});
button("closeAddress", () => element<HTMLDialogElement>("address").close());
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
