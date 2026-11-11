import type { BrowserState, BrowserCommand } from "@shared/features/browser/contract";

/** Titles are page input: build nodes with textContent, never HTML. */
export function createTabStrip(run: (command: BrowserCommand) => void) {
  const strip = document.getElementById("tabs")!;
  const active = document.getElementById("pageIdentity")!;
  const inactive = new Map<number, HTMLElement>();
  let previousActive: number | undefined;
  return (state: BrowserState) => {
    if (!state.tabs) return;
    const live = new Set(state.tabs.map((tab) => tab.id));
    for (const [id, node] of inactive) {
      if (!live.has(id) || id === state.activeTabId) {
        node.remove();
        inactive.delete(id);
      }
    }
    state.tabs.forEach((tab, index) => {
      let node = active;
      if (tab.id !== state.activeTabId) {
        node = inactive.get(tab.id)!;
        if (!node) {
          node = document.createElement("div");
          node.className = "browserTab";
          const select = document.createElement("button");
          select.className = "selectTab";
          select.setAttribute("role", "tab");
          select.setAttribute("aria-selected", "false");
          select.addEventListener("click", () => run({ type: "tab-activate", id: tab.id }));
          const title = document.createElement("span");
          title.className = "tabTitle";
          const icon = document.getElementById("pageIcon")!.cloneNode(true) as SVGElement;
          icon.removeAttribute("id");
          icon.classList.add("tabIcon");
          icon.setAttribute("aria-hidden", "true");
          select.append(icon, title);
          const close = document.createElement("button");
          close.className = "closeTab";
          close.append(document.getElementById("closeTab")!.firstElementChild!.cloneNode(true));
          close.addEventListener("click", () => run({ type: "tab-close", id: tab.id }));
          node.append(select, close);
          inactive.set(tab.id, node);
        }
        node.querySelector(".tabTitle")!.textContent = tab.title;
        const select = node.querySelector(".selectTab")!;
        select.setAttribute("aria-label", tab.title);
        select.setAttribute("title", tab.title);
        node.querySelector(".closeTab")!.setAttribute("aria-label", `${state.labels.close}: ${tab.title}`);
      }
      node.dataset.tabId = String(tab.id);
      node.dataset.loading = String(tab.loading);
      if (strip.children[index] !== node) strip.insertBefore(node, strip.children[index] ?? null);
    });
    if (previousActive !== state.activeTabId) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
      previousActive = state.activeTabId;
    }
  };
}
