import { ipcRenderer } from "electron";

// This sandboxed preload is loaded only by the shell-owned find surface.
window.addEventListener("DOMContentLoaded", () => {
  const query = document.querySelector<HTMLInputElement>("#query")!;
  const count = document.querySelector<HTMLOutputElement>("#count")!;
  const send = (type: "input" | "next" | "previous" | "close") =>
    ipcRenderer.send("webview-find:command", { type, text: query.value });
  query.addEventListener("input", () => send("input"));
  for (const type of ["previous", "next", "close"] as const)
    document.getElementById(type)!.addEventListener("click", () => send(type));
  document.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      send(event.shiftKey ? "previous" : "next");
    }
  });
  ipcRenderer.on("webview-find:focus", () => { query.focus(); query.select(); });
  ipcRenderer.on("webview-find:count", (_event, result: { activeMatchOrdinal: number; matches: number }) => {
    count.textContent = `${result.activeMatchOrdinal}/${result.matches}`;
  });
});
