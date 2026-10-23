import { randomBytes } from "node:crypto";
import { CUA_REASON_KEYS } from "@shared/features/computer-use/presentation";

const previewClientSource = String.raw`
const labels = __CUA_LABELS__, api = window.cuaControls;
let runtime = null, selected = null, expanded = true, windows = [], revision = -1, blob = null, lastFrame = 0, sequence = 0;
const frames = /* @__PURE__ */ new Map();
const icons = { pause: '<path d="M7 5v10M13 5v10"/>', resume: '<path d="m7 4 9 6-9 6Z"/>', takeover: '<path d="M8 10V4a1.5 1.5 0 0 1 3 0v5-1a1.5 1.5 0 0 1 3 0v1a1.5 1.5 0 0 1 3 0v4c0 3-2 5-5 5h-1c-2 0-3-1-4-2l-3-4a1.5 1.5 0 0 1 2-2l2 2"/>', stop: '<rect x="5" y="5" width="10" height="10" rx="1.5"/>', expand: '<path d="M4 8V4h4m4 0h4v4M4 12v4h4m4 0h4v-4"/>', collapse: '<path d="m6 8 4 4 4-4"/>' };
const icon = (name) => '<svg viewBox="0 0 20 20">' + icons[name] + "</svg>";
const el = (id) => document.getElementById(id), text = (tag, value) => {
  const n = document.createElement(tag);
  n.textContent = value;
  return n;
};
for (const id of ["pause", "resume", "stop", "takeover"]) {
  el(id).innerHTML = icon(id);
  el(id).append(text("span", labels["preview." + (id === "takeover" ? "takeoverShort" : id)]));
  el(id).title = labels[id === "takeover" ? "preview.takeover" : id];
  el(id).setAttribute("aria-label", el(id).title);
}
el("close").title = labels["preview.close"];
el("close").setAttribute("aria-label", labels["preview.close"]);
el("close").onclick = () => api.close();
let drag = null, presentationPosition = null;
const dragHandle = document.querySelector("header");
dragHandle.addEventListener("pointerdown", event => {
  if (event.button !== 0 || event.target.closest("button")) return;
  if (!presentationPosition) return;
  drag = { id: event.pointerId, x: event.screenX, y: event.screenY, start: presentationPosition };
  dragHandle.setPointerCapture(event.pointerId);
});
dragHandle.addEventListener("pointermove", event => {
  if (!drag || event.pointerId !== drag.id) return;
  void api.move({ x: drag.start.x + event.screenX - drag.x, y: drag.start.y + event.screenY - drag.y }).then(p => { if (p?.position) presentationPosition = p.position; });
});
const endDrag = () => { drag = null; };
dragHandle.addEventListener("pointerup", endDrag);
dragHandle.addEventListener("pointercancel", endDrag);
for (const [id, action] of [["compactTakeover", "takeover"], ["compactStop", "stop"]]) {
  el(id).innerHTML = icon(action);
  el(id).title = labels[action === "takeover" ? "preview.takeover" : "stop"];
  el(id).setAttribute("aria-label", el(id).title);
  el(id).onclick = () => selected && run(selected, action);
}
el("all").title = labels["multiwindow.stopAll"];
el("all").setAttribute("aria-label", labels["multiwindow.stopAll"]);
el("refresh").textContent = labels["scope.refresh"];
el("recover").textContent = labels.recover;
el("menuTitle").textContent = labels.title;
el("taskMenu").title = labels["preview.select"];
el("taskMenu").setAttribute("aria-label", labels["preview.select"]);
el("selected").setAttribute("aria-label", labels["preview.select"]);
document.addEventListener("keydown", event => { if (event.key === "Escape") el("tasksPanel").hidden = true; });
document.addEventListener("pointerdown", event => {
  if (!event.target.closest("#tasksPanel, #taskMenu")) el("tasksPanel").hidden = true;
});
function clearFrame() {
  el("image").hidden = true;
  el("image").removeAttribute("src");
  blob = null;
  lastFrame = 0;
  sequence = 0;
}
function present(p) {
  if (!p) return;
  if (selected !== p.taskId || expanded !== p.expanded) {
    clearFrame();
    el("status").textContent = labels["preview.loading"];
  }
  if (p.position) presentationPosition = p.position;
  selected = p.taskId;
  expanded = p.expanded;
  document.body.classList.toggle("compact", !expanded);
  if (!expanded) el("tasksPanel").hidden = true;
  el("toggle").innerHTML = icon(expanded ? "collapse" : "expand");
  el("toggle").title = labels[expanded ? "preview.collapse" : "preview.expand"];
  el("toggle").setAttribute("aria-label", el("toggle").title);
  el("title").title = labels[expanded ? "preview.select" : "preview.expand"];
  if (runtime) draw(runtime, true);
}
async function run(id, action, value) {
  try {
    const r = await api.taskAction(id, action, value);
    el("error").textContent = r?.success === false ? labels["reason." + r.error] || labels["reason.generic"] : "";
    draw(await api.getRuntime(), true);
  } catch {
    el("error").textContent = labels["reason.generic"];
  }
}
const choose = (id) => api.setPresentation(id, expanded).then(present);
function drawStack() {
  const stack = el("stack");
  stack.replaceChildren();
  const live = (runtime?.tasks || []).filter((t) => ["running", "paused"].includes(t.phase));
  const others = live.filter((t) => t.taskId !== selected).slice(0, 2);
  document.body.classList.toggle("stacked", others.length > 0);
  document.body.classList.toggle("stacked-three", others.length > 1);
  for (const task of others) {
    const back = document.createElement("button");
    back.title = task.scope?.label || labels["scope.choose"];
    back.setAttribute("aria-label", back.title);
    back.style.setProperty("--task-color", task.color);
    const cached = frames.get(task.taskId);
    if (cached) {
      const image = document.createElement("img");
      image.src = cached.url;
      image.alt = "";
      back.append(image);
      back.title += " \xB7 " + new Date(cached.capturedAt).toLocaleTimeString();
    } else {
      const placeholder = text("div", labels["preview.noPreview"]);
      placeholder.className = "back-placeholder";
      back.append(placeholder);
    }
    const caption = text("span", task.scope?.label || labels["scope.choose"]);
    caption.className = "back-caption";
    back.append(caption);
    back.onclick = () => choose(task.taskId);
    stack.append(back);
  }
}
function draw(s, force = false) {
  if (!s || !force && s.revision <= revision) return;
  runtime = s;
  revision = s.revision;
  const tasks = (s.tasks || []).filter(task => ["running", "paused"].includes(task.phase));
  for (const [id, cached] of frames) {
    const task = tasks.find((t) => t.taskId === id);
    if (!task || !["running", "paused"].includes(task.phase) || task.bindingId !== cached.bindingId || task.epoch !== cached.epoch || task.reason === "screenLocked") {
      URL.revokeObjectURL(cached.url);
      frames.delete(id);
      if (id === selected) clearFrame();
    }
  }
  if (!tasks.some((t) => t.taskId === selected)) selected = tasks[0]?.taskId || null;
  const current = tasks.find((t) => t.taskId === selected);
  document.body.classList.toggle("is-paused", current?.phase === "paused");
  document.body.classList.toggle("is-running", current?.phase === "running");
  document.body.classList.toggle("is-pending", !!current?.controlPending);
  const select = el("selected");
  select.replaceChildren();
  for (const task of tasks) {
    const o = text("option", (task.scope?.label || labels["scope.choose"]) + " \xB7 " + labels["phase." + task.phase]);
    o.value = task.taskId;
    select.append(o);
  }
  select.value = selected || "";
  el("title").textContent = current?.scope?.label || labels.title;
  el("mode").textContent = current ? labels[current.controlPending ? "preview.handoff" :
    current.phase === "running" ? "preview.running" : "phase." + current.phase] : "";
  el("dot").style.background = current?.color || "#4f8cff";
  el("taskCount").textContent = tasks.length > 1 ? String(tasks.length) : "";
  const quickAction = current?.phase === "running" ? "pause" : "resume";
  el("quick").innerHTML = icon(quickAction);
  el("quick").title = labels[quickAction];
  el("quick").setAttribute("aria-label", labels[quickAction]);
  el("quick").disabled = !current || !["running", "paused"].includes(current.phase) || current.controlPending || !current.scope?.windowId;
  const terminal = !current || ["stopped", "completed", "failed"].includes(current.phase);
  el("pause").hidden = terminal || current.phase !== "running";
  el("pause").disabled = !!current?.controlPending;
  el("resume").hidden = terminal || current.phase !== "paused";
  el("resume").disabled = !!current?.controlPending;
  el("takeover").disabled = terminal || !!current?.controlPending || !current?.scope?.windowId;
  el("stop").disabled = terminal;
  el("compactStop").disabled = terminal;
  el("compactTakeover").disabled = terminal || !!current?.controlPending || !current?.scope?.windowId;
  if (terminal) {
    clearFrame();
    el("status").textContent = labels["preview.ended"];
  } else if (current.controlPending) {
    clearFrame();
    el("status").textContent = labels["preview.handoff"];
  }
  el("recover").hidden = !s.recoverable;
  el("recover").disabled = !!s.controlPending;
  const root = el("tasks");
  const settingsOpen = root.querySelector("article.selected details")?.open ?? false;
  root.replaceChildren();
  for (const task of tasks) {
    const row = document.createElement("article");
    row.style.borderColor = task.color;
    row.classList.toggle("selected", task.taskId === selected);
    const pick = document.createElement("button");
    pick.className = "pick";
    const dot = text("span", "");
    dot.className = "task-dot";
    dot.style.background = task.color;
    pick.append(dot);
    const name = text("span", task.scope?.label || labels["scope.choose"]);
    name.className = "task-name";
    pick.append(name);
    const phase = text("span", labels["phase." + task.phase]);
    phase.className = "phase";
    pick.append(phase);
    pick.onclick = () => {
      choose(task.taskId);
      el("tasksPanel").hidden = true;
    };
    row.append(pick);
    const reorder = text("div", "");
    reorder.className = "reorder";
    for (const direction of [-1, 1]) {
      const button = text("button", direction < 0 ? "↑" : "↓");
      button.title = labels[direction < 0 ? "preview.moveEarlier" : "preview.moveLater"];
      button.setAttribute("aria-label", button.title);
      const index = tasks.indexOf(task), next = index + direction;
      button.disabled = next < 0 || next >= tasks.length;
      button.onclick = () => {
        const ids = tasks.map(t => t.taskId);
        [ids[index], ids[next]] = [ids[next], ids[index]];
        // Display order does not change the execution revision. Refresh this
        // view explicitly after the acknowledged presentation-only mutation.
        void api.reorder(ids).then(order => order && api.getRuntime().then(s => draw(s, true)));
      };
      reorder.append(button);
    }
    row.append(reorder);
    const detail = document.createElement("div");
    detail.className = "detail";
    const target = document.createElement("select");
    target.setAttribute("aria-label", labels["scope.choose"]);
    const empty = text("option", labels["scope.choose"]);
    empty.value = "";
    target.append(empty);
    const available = [...windows];
    if (task.scope?.windowId && !available.some((w) => w.pid === task.scope.pid && w.windowId === task.scope.windowId)) available.push(task.scope);
    for (const w of available) {
      const o = text("option", w.label);
      o.value = w.pid + ":" + w.windowId;
      target.append(o);
    }
    target.value = task.scope?.windowId ? task.scope.pid + ":" + task.scope.windowId : "";
    const ended = ["stopped", "completed", "failed"].includes(task.phase);
    target.disabled = ended || task.controlPending || task.phase === "running";
    target.onchange = () => {
      const w = available.find((w2) => w2.pid + ":" + w2.windowId === target.value);
      if (w) run(task.taskId, "bind", { pid: w.pid, windowId: w.windowId });
    };
    detail.append(target);
    if (!ended) {
      const b = text("button", labels[task.mode === "background" ? "multiwindow.useForeground" : "multiwindow.useBackground"]);
      b.disabled = task.controlPending;
      b.onclick = () => run(task.taskId, "mode", task.mode === "background" ? "foreground" : "background");
      detail.append(b);
    }
    const settings = document.createElement("details");
    settings.className = "target-settings";
    settings.open = task.taskId === selected && (settingsOpen || !task.scope?.windowId);
    settings.append(text("summary", labels["preview.windowSettings"]), detail);
    row.append(settings);
    if (task.reason || task.controlPending) row.append(text("p", task.controlPending ? labels.stopping : labels["reason." + task.reason] || labels["reason.generic"]));
    root.append(row);
  }
  drawStack();
  if (current && !current.scope?.windowId) el("tasksPanel").hidden = false;
}
api.onPreview((update) => {
  if (update.taskId !== selected || !expanded) return;
  if (["ended", "permissionsRequired"].includes(update.status)) {
    for (const f2 of frames.values()) URL.revokeObjectURL(f2.url);
    frames.clear();
    drawStack();
  }
  const task = runtime?.tasks?.find((t) => t.taskId === selected);
  if (!task || task.controlPending || !["running", "paused"].includes(task.phase)) {
    clearFrame();
    return;
  }
  if (update.status !== "ready" || !update.frame) {
    clearFrame();
    el("status").textContent = labels["preview." + update.status] || labels["preview.unavailable"];
    return;
  }
  const f = update.frame;
  if (f.sequence <= sequence || f.bindingId !== task.bindingId || f.epoch !== task.epoch) return;
  sequence = f.sequence;
  const bytes = Uint8Array.from(atob(f.jpeg), (c) => c.charCodeAt(0));
  const next = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  el("image").src = next;
  el("image").hidden = false;
  const previous = frames.get(selected);
  if (previous) URL.revokeObjectURL(previous.url);
  frames.set(selected, { url: next, bindingId: f.bindingId, epoch: f.epoch, capturedAt: f.capturedAt });
  while (frames.size > 3) {
    const oldest = [...frames.keys()].find((id) => id !== selected);
    URL.revokeObjectURL(frames.get(oldest).url);
    frames.delete(oldest);
  }
  blob = next;
  lastFrame = f.capturedAt;
  el("status").textContent = "";
  drawStack();
});
setInterval(() => {
  if (!lastFrame) return;
  const age = Date.now() - lastFrame;
  if (age > 5e3) {
    clearFrame();
    el("status").textContent = labels["preview.unavailable"];
  } else if (age > 2e3) el("status").textContent = labels["preview.delayed"];
}, 500);
el("selected").onchange = () => choose(el("selected").value);
el("toggle").onclick = () => api.setPresentation(selected, !expanded).then(present);
el("title").onclick = () => {
  if (!expanded) api.setPresentation(selected, true).then(present);
  else el("taskMenu").click();
};
el("taskMenu").onclick = async () => {
  if (!expanded) { present(await api.setPresentation(selected, true)); el("tasksPanel").hidden = false; }
  else el("tasksPanel").hidden = !el("tasksPanel").hidden;
};
el("quick").onclick = () => selected && run(selected, runtime?.tasks?.find(t => t.taskId === selected)?.phase === "running" ? "pause" : "resume");
for (const action of ["pause", "resume", "stop", "takeover"]) el(action).onclick = () => selected && run(selected, action);
el("all").onclick = () => api.action("stop");
el("recover").onclick = () => api.action("recover");
async function refresh() {
  windows = await api.listWindows();
  draw(await api.getRuntime(), true);
}
el("refresh").onclick = () => refresh().catch(() => {
});
api.onRuntime(draw);
api.onPresentation(present);
api.getRuntime().then((s) => draw(s, true));
api.getPresentation().then(present);
refresh().catch(() => {
});
window.addEventListener("unload", () => {
  clearFrame();
  for (const f of frames.values()) URL.revokeObjectURL(f.url);
  frames.clear();
});
`;

export function taskPreviewWindowHtml(t: (key: string) => string) {
  const keys = ["title", "pause", "resume", "stop", "recover", "stopping", "scope.choose", "scope.refresh", "reason.generic",
    "multiwindow.stopAll", "multiwindow.background", "multiwindow.foreground", "multiwindow.useForeground", "multiwindow.useBackground",
    "phase.running", "phase.paused", "phase.stopped", "phase.completed", "phase.failed",
    "preview.close", "preview.moveEarlier", "preview.moveLater", "preview.pause", "preview.resume", "preview.stop", "preview.takeoverShort", "preview.expand", "preview.collapse", "preview.takeover", "preview.loading", "preview.unavailable", "preview.minimized",
    "preview.permissionsRequired", "preview.helperUpgradeRequired", "preview.delayed", "preview.ended", "preview.select", "preview.handoff", "preview.running", "preview.windowSettings", "preview.noPreview",
    ...CUA_REASON_KEYS.map(key => "reason." + key)];
  const labels = JSON.stringify(Object.fromEntries(keys.map(key => [key, t("Claw.Cua." + key)]))).replace(/</g, "\\u003c");
  const nonce = randomBytes(16).toString("hex");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
:root{color-scheme:light dark;--text:#303237;--muted:#777c84;--glass:#ffffffec;--line:#00000012;--hover:#00000008;--accent:#625cf5}
*{box-sizing:border-box}body{margin:0;overflow:hidden;background:transparent;color:var(--text);font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none}
button,select{font:inherit;color:inherit}button{cursor:pointer;-webkit-app-region:no-drag}button:disabled{opacity:.35;cursor:default}[hidden]{display:none!important}
button:focus-visible,summary:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.shell{position:absolute;inset:36px 18px 35px;z-index:3}
#viewport{position:absolute;inset:0;display:grid;place-items:center;-webkit-app-region:no-drag}
#image{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;pointer-events:none;border-radius:8px;box-shadow:0 0 0 1px #00000010,0 12px 28px #00000026,0 2px 6px #00000012}
#status{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:32px 24px;background:var(--glass);border:1px solid var(--line);border-radius:10px;color:var(--muted);font-size:12px;line-height:1.7;box-shadow:0 10px 30px #00000018;backdrop-filter:blur(24px)}
#status:before{content:"";width:30px;height:23px;border:1.5px solid currentColor;border-top-width:5px;border-radius:5px;opacity:.4}#status:empty{display:none}
header{position:absolute;left:10px;right:auto;max-width:calc(100% - 20px);bottom:10px;height:24px;padding:0 8px;display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:12px;background:var(--glass);backdrop-filter:blur(20px);opacity:0;transition:opacity .16s;-webkit-app-region:no-drag}body:hover header,.shell:focus-within header,body.is-paused header{opacity:1}
#brand{display:none;font-size:12px;font-weight:650;letter-spacing:-.3px}#dot{width:5px;height:5px;border-radius:50%;background:#625cf5;flex:none}
#title{border:0;background:transparent;padding:0;text-align:left;min-width:0;max-width:210px;font-size:10px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;text-shadow:0 1px 8px #ffffff80}
#mode{font-size:10px;white-space:nowrap;color:var(--muted)}
#primary,#toolbar{position:absolute;top:-32px;height:28px;display:flex;align-items:center;gap:2px;opacity:0;transform:translateY(3px);transition:opacity .16s ease,transform .16s ease}
#primary{left:-3px}#toolbar{right:-3px}#primary,#toolbar{background:var(--glass);border-radius:9px;backdrop-filter:blur(24px);box-shadow:0 2px 9px #0000000d}
body:hover #primary,body:hover #toolbar,.shell:focus-within #primary,.shell:focus-within #toolbar{opacity:1;transform:none}
.icon,#toolbar button,#primary button{display:flex;align-items:center;justify-content:center;gap:4px;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--text);transition:background .12s}
#primary button:hover,#toolbar button:hover,.icon:hover{background:var(--glass);box-shadow:0 1px 6px #0000000a}
#primary button svg{width:19px;height:19px}#primary button span,#toolbar button span{display:none}
#toolbar .separator{height:13px;width:1px;margin:0 3px;background:var(--line)}
#toolbar #taskMenu{width:auto;min-width:28px;padding:0 5px}#toolbar #taskCount{display:inline;font-size:10px;font-weight:600}
#all{color:#996464!important}#all:hover,#stop:hover{color:#bf3e46!important}
#tasksPanel{position:absolute;top:2px;right:0;width:min(320px,100%);max-height:calc(100% + 26px);overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--glass);box-shadow:0 12px 32px #00000026;padding:6px;backdrop-filter:blur(28px);z-index:6;-webkit-app-region:no-drag}
.menu-head{display:flex;justify-content:space-between;align-items:center;padding:5px 7px 9px;font-size:11px;color:var(--muted)}.menu-head button{border:0;background:transparent;color:inherit;font-size:10px;padding:3px}
article{padding:8px;border-radius:8px;margin:2px 0}article.selected{background:var(--hover)}
.pick{display:flex;align-items:center;gap:7px;width:100%;border:0;background:transparent;padding:3px 0;text-align:left}
.task-dot{width:5px;height:5px;border-radius:50%;flex:none}.task-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.phase{font-size:10px;color:var(--muted)}
.target-settings{margin-top:7px;border-top:1px solid var(--line);padding-top:7px}.target-settings summary{cursor:pointer;font-size:10px;color:var(--muted);padding:2px 0}.detail{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.detail select{min-width:0;width:100%;background:transparent;border:1px solid var(--line);border-radius:6px;padding:5px;font-size:11px}.detail button{border:0;background:var(--hover);border-radius:6px;padding:5px 8px;font-size:10px}
article:not(.selected) .target-settings,article:not(.selected) p{display:none}article p{font-size:10px;color:var(--muted);line-height:1.5;margin:7px 0 0}
#error{position:absolute;bottom:8px;left:8px;right:8px;margin:0;padding:8px 10px;font-size:11px;line-height:1.5;color:#ae3542;background:var(--glass);border:1px solid #ae354220;border-radius:8px;box-shadow:0 2px 12px #00000012}#error:empty{display:none}
#selected{display:none}
#stack{position:absolute;inset:0;z-index:1;pointer-events:none}#stack button{position:absolute;top:66px;left:14px;width:calc(100% - 88px);height:calc(100% - 94px);padding:0;border:1px solid var(--line);border-radius:8px;background:var(--glass);box-shadow:0 8px 24px #00000020;overflow:hidden;pointer-events:auto;text-align:left;transition:filter .16s,transform .16s}
#stack button:hover{filter:brightness(1.025);transform:translate(-2px,2px)}#stack button:nth-child(2){top:52px;left:36px;width:calc(100% - 94px);height:calc(100% - 94px)}
#stack img{width:100%;height:100%;object-fit:contain;opacity:.9;pointer-events:none}.back-placeholder{position:absolute;inset:0;display:grid;place-items:center;background:linear-gradient(145deg,#f5f6f9,#e9ebef);font-size:11px;color:var(--muted)}
.back-caption{opacity:0;transition:opacity .16s;position:absolute;left:7px;right:7px;bottom:5px;max-width:calc(100% - 14px);width:max-content;border-left:2px solid var(--task-color);padding:2px 5px;font-size:9px;color:var(--muted);background:var(--glass);border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body:hover .back-caption,#stack button:focus-visible .back-caption{opacity:1}
body.stacked .shell{inset:36px 18px 62px 58px}body.stacked-three .shell{left:72px}
body.compact .shell{inset:2px 4px;border:1px solid var(--line);border-radius:19px;background:var(--glass);box-shadow:0 2px 8px #00000012;backdrop-filter:blur(24px)}
body.compact header{position:static;max-width:none;height:36px;padding:0 37px 0 11px;gap:7px;opacity:1;border:0;background:transparent;backdrop-filter:none}body.compact #brand{display:block}body.compact #title{font-size:11px;max-width:none}body.compact #mode{font-size:10px}body.compact #toolbar{top:4px;right:5px;opacity:1;transform:none;background:transparent;box-shadow:none;backdrop-filter:none}body.compact #toolbar>*:not(#all){display:none!important}
body.compact #stack,body.compact #viewport,body.compact #primary,body.compact #error{display:none}body:not(.compact) #quick,body:not(.compact) #toggle{display:none}
body.compact .icon{width:25px;height:25px;flex:none}body.compact #all{width:25px;height:25px}
@media(prefers-color-scheme:dark){:root{--text:#eeeef0;--muted:#a4a6af;--glass:#292a30ed;--line:#ffffff16;--hover:#ffffff0b}.back-placeholder{background:linear-gradient(145deg,#33353b,#27292e)}#title{text-shadow:0 1px 8px #0008}#image{box-shadow:0 0 0 1px #ffffff16,0 12px 28px #0006,0 2px 6px #0003}#error{color:#ff9ba5}}

.shell,body.stacked .shell,body.stacked-three .shell{inset:0;border:1px solid var(--line);border-radius:12px;background:var(--glass);overflow:hidden;box-shadow:0 2px 10px #00000012}
header{top:0;bottom:auto;left:0;right:0;max-width:none;height:34px;padding:0 7px;opacity:1;border:0;border-radius:0;background:transparent;cursor:grab;touch-action:none}
header:active{cursor:grabbing}#dragHandle{font-size:15px;color:var(--muted);flex:none}#title{font-size:11px;max-width:none;cursor:pointer}#mode{font-size:9px}#close{width:24px;height:24px;flex:none;margin-left:auto}
#viewport{inset:36px 8px 38px}#image{border-radius:6px;box-shadow:none}#status{box-shadow:none;border:0;padding:12px;font-size:11px;gap:8px}
#primary,#toolbar{top:auto;bottom:4px;opacity:1;transform:none;box-shadow:none;background:transparent;border-radius:0}#primary{left:8px}#toolbar{right:7px}#primary button,#toolbar button{width:27px;height:27px}#primary button span{display:inline;font-size:10px}#primary #takeover{width:auto;padding:0 6px}#stack,#all{display:none!important}
#tasksPanel{top:33px;right:4px;max-height:calc(100% - 40px);width:calc(100% - 8px);border-radius:8px;box-shadow:0 4px 12px #0002}.reorder{display:flex;gap:4px;margin-top:3px}.reorder button{border:0;border-radius:4px;background:var(--hover);font-size:11px;padding:2px 8px}
body.compact .shell{inset:0;border-radius:10px}body.compact header{position:static;height:38px;padding:0 7px;background:transparent}body.compact #brand{display:none}body.compact #toolbar{display:none}body.compact #close{display:flex}body.compact #mode{display:none}body.compact #title{font-size:11px}body.compact .icon{width:23px;height:23px}body:not(.compact) #toggle{display:flex}body:not(.compact) #compactTakeover,body:not(.compact) #compactStop{display:none}

@media(prefers-reduced-motion:reduce){*{transition:none!important}}
  </style></head><body><div id="stack"></div><main class="shell">
  <div id="viewport"><img id="image" hidden alt=""><span id="status" role="status"></span></div>
  <div id="primary"><button id="takeover" class="icon"></button></div>
  <div id="toolbar"><button id="pause"></button><button id="resume"></button><button id="stop"></button><span class="separator"></span><button id="taskMenu" class="icon"><svg viewBox="0 0 20 20"><rect x="3" y="6" width="11" height="10" rx="2"/><path d="M6 3h9a2 2 0 0 1 2 2v8"/></svg><span id="taskCount"></span></button><button id="all" class="icon"><svg viewBox="0 0 20 20"><path d="M7 3h6l4 4v6l-4 4H7l-4-4V7Z"/><path d="M8 8h4v4H8Z"/></svg></button></div>
  <header><span id="dragHandle" aria-hidden="true">⠿</span><span id="brand">Nuwax</span><span id="dot"></span><button id="title"></button><span id="mode"></span><button id="quick" class="icon"></button><button id="toggle" class="icon"></button><button id="compactTakeover" class="icon"></button><button id="compactStop" class="icon"></button><button id="close" class="icon"><svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
  <section id="tasksPanel" hidden><div class="menu-head"><span id="menuTitle"></span><span><button id="refresh"></button><button id="recover" hidden></button></span></div><div id="tasks"></div></section><select id="selected" aria-label="Task"></select><p id="error" role="alert"></p></main><script nonce="${nonce}">
${previewClientSource.replace("__CUA_LABELS__", labels)}
  </script></body></html>`;
}
