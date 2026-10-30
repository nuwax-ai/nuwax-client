import { randomBytes } from "node:crypto";
import { CUA_OVERLAY_NOTICE_REASONS, CUA_REASON_KEYS } from "@shared/features/computer-use/presentation";

const previewClientSource = String.raw`
const labels = __CUA_LABELS__, api = window.cuaControls;
const notices = new Set(__CUA_NOTICES__);
const livePhase = task => ['running', 'paused'].includes(task.phase)
  || (!!task.controlPending && ['stopped', 'failed'].includes(task.phase))
  || (task.phase === 'failed' && task.reason === 'helperStillRunning');
let runtime = null, selected = null, revision = -1, lastFrame = 0;
const frames = new Map();
const icons = { pause: '<path d="M7 5v10M13 5v10"/>', resume: '<path d="m7 4 9 6-9 6Z"/>', stop: '<rect x="5" y="5" width="10" height="10" rx="1.5"/>' };
const icon = name => '<svg viewBox="0 0 20 20">' + icons[name] + '</svg>';
const el = id => document.getElementById(id);
const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
for (const id of ['pause', 'resume', 'stop']) {
  el(id).innerHTML = icon(id);
  el(id).append(text('span', labels['preview.' + id]));
  el(id).title = labels['preview.' + id];
  el(id).setAttribute('aria-label', el(id).title);
}
el('confirm').textContent = labels['confirmAllow'];
el('close').title = labels['preview.close'];
el('close').setAttribute('aria-label', labels['preview.close']);
el('close').onclick = () => api.close();
el('viewport').title = labels['preview.takeover'];
el('viewport').setAttribute('aria-label', labels['preview.takeover']);
let drag = null, presentationPosition = null, suppressClickUntil = 0;
for (const dragHandle of [document.querySelector('header'), el('viewport')]) {
  dragHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || dragHandle !== el('viewport') && event.target.closest('button') || !presentationPosition) return;
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY, start: presentationPosition, moved: false };
    dragHandle.setPointerCapture(event.pointerId);
  });
  dragHandle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    void api.move({ x: drag.start.x + dx, y: drag.start.y + dy })
      .then(p => { if (p?.position) presentationPosition = p.position; });
  });
  const endDrag = () => { if (drag?.moved) suppressClickUntil = Date.now() + 250; drag = null; };
  dragHandle.addEventListener('pointerup', endDrag);
  dragHandle.addEventListener('pointercancel', endDrag);
  dragHandle.addEventListener('lostpointercapture', endDrag);
}
function clearFrame() {
  el('image').hidden = true;
  el('image').removeAttribute('src');
  lastFrame = 0;
}
function present(p) {
  if (!p) return;
  if (selected !== p.taskId) {
    clearFrame(); el('status').textContent = labels['preview.loading'];
  }
  if (p.position) presentationPosition = p.position;
  selected = p.taskId;
  if (runtime) draw(runtime, true);
}
async function run(id, action) {
  try {
    const result = await api.taskAction(id, action);
    const next = await api.getRuntime();
    draw(next, true);
    el('error').textContent = result?.success === false ? labels['reason.' + result.error] || labels['reason.generic'] : el('error').textContent;
  } catch { el('error').textContent = labels['reason.generic']; }
}
async function activate(id) {
  const task = runtime?.tasks?.find(task => task.taskId === id);
  if (!task || !task.scope?.windowId) return;
  try {
    present(await api.setPresentation(id));
    if (task.controlPending || !['running', 'paused'].includes(task.phase)) return;
    // Selecting a layer changes presentation order only. Native activation still
    // uses the host's revoke -> drain -> exact takeover path.
    const ids = (runtime.tasks || []).filter(task => ['running', 'paused'].includes(task.phase)).map(task => task.taskId);
    await api.reorder([id, ...ids.filter(other => other !== id)]);
    await run(id, 'takeover');
  } catch { el('error').textContent = labels['reason.generic']; }
}
function drawStack() {
  const stack = el('stack'); stack.replaceChildren();
  const live = (runtime?.tasks || []).filter(livePhase);
  const others = live.filter(task => task.taskId !== selected).slice(0, 3);
  document.body.style.setProperty('--stack-space', others.length * 8 + 'px');
  document.body.classList.toggle('stacked', others.length > 0);
  for (const [index, task] of others.entries()) {
    const back = document.createElement('button');
    back.title = task.scope?.label || labels['scope.choose'];
    back.setAttribute('aria-label', back.title);
    back.style.setProperty('--task-color', task.color);
    back.style.setProperty('--offset', (index + 1) * 8 + 'px');
    back.style.setProperty('--remaining', (others.length - index - 1) * 8 + 'px');
    back.style.zIndex = String(3 - index);
    const cached = frames.get(task.taskId);
    if (cached) { const image = document.createElement('img'); image.src = cached.url; image.alt = ''; back.append(image); }
    back.append(text('span', task.scope?.label || labels['scope.choose']));
    back.onclick = () => activate(task.taskId);
    stack.append(back);
  }
}
function draw(state, force = false) {
  if (!state || !force && state.revision <= revision) return;
  runtime = state; revision = state.revision;
  const tasks = (state.tasks || []).filter(livePhase);
  for (const [id, cached] of frames) {
    const task = tasks.find(task => task.taskId === id);
    if (!task || task.controlPending || task.bindingId !== cached.bindingId || task.epoch !== cached.epoch || task.reason === 'screenLocked') {
      URL.revokeObjectURL(cached.url); frames.delete(id);
      if (id === selected) clearFrame();
    }
  }
  if (!tasks.some(task => task.taskId === selected)) selected = tasks[0]?.taskId || null;
  const current = tasks.find(task => task.taskId === selected);
  document.body.classList.toggle('is-paused', current?.phase === 'paused');
  document.body.classList.toggle('is-running', current?.phase === 'running');
  document.body.classList.toggle('is-pending', !!current?.controlPending);
  el('pauseHint').hidden = current?.phase !== 'paused' || !!current.controlPending;
  el('pauseHint').textContent = labels['phase.paused'];
  el('pauseHint').title = current?.reason ? labels['reason.' + current.reason] || '' : '';
  el('title').textContent = current?.scope?.label || labels.title;
  el('title').title = labels['preview.takeover'];
  el('title').setAttribute('aria-label', labels['preview.takeover']);
  el('phase').textContent = current ? labels[current.controlPending ? 'preview.handoff' : 'phase.' + current.phase] : '';
  el('dot').style.background = current?.color || '#4f8cff';
  const terminal = !current;
  const locked = terminal || !!current.controlPending;
  el('title').disabled = locked || !current?.scope?.windowId;
  el('viewport').disabled = locked || !current?.scope?.windowId;
  el('pause').hidden = terminal || current.phase !== 'running';
  el('resume').hidden = terminal || current.phase !== 'paused';
  el('pause').disabled = locked; el('resume').disabled = locked;
  el('confirm').hidden = terminal || current.reason !== 'confirmationRequired';
  el('confirm').disabled = locked;
  // Stop remains usable while a pause, handoff, or emergency-stop drain is pending.
  el('stop').disabled = terminal;
  if (terminal || current.controlPending) {
    clearFrame(); el('status').textContent = labels[terminal ? 'preview.ended' : 'preview.handoff'];
    el('error').textContent = '';
  } else if (current.reason && notices.has(current.reason)) {
    el('error').textContent = labels['reason.' + current.reason] || labels['reason.generic'];
  } else {
    el('error').textContent = '';
  }
  drawStack();
}
api.onPreview(update => {
  const id = update.taskId;
  const task = runtime?.tasks?.find(task => task.taskId === id);
  const remove = () => {
    const old = frames.get(id); if (old) URL.revokeObjectURL(old.url);
    frames.delete(id); if (id === selected) clearFrame(); drawStack();
  };
  if (!task || task.controlPending || !livePhase(task)) { remove(); return; }
  if (update.status !== 'ready' || !update.frame) {
    remove();
    if (id === selected) el('status').textContent = labels['preview.' + update.status] || labels['preview.unavailable'];
    return;
  }
  const frame = update.frame;
  if (frame.bindingId !== task.bindingId || frame.epoch !== task.epoch || frame.sequence <= (frames.get(id)?.sequence ?? 0)) return;
  const bytes = Uint8Array.from(atob(frame.jpeg), value => value.charCodeAt(0));
  const next = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  const previous = frames.get(id); if (previous) URL.revokeObjectURL(previous.url);
  frames.set(id, { url: next, bindingId: frame.bindingId, epoch: frame.epoch, sequence: frame.sequence, capturedAt: frame.capturedAt });
  if (id === selected) {
    lastFrame = frame.capturedAt;
    el('image').src = next; el('image').hidden = false; el('status').textContent = '';
  }
  while (frames.size > 4) {
    const oldest = [...frames.keys()].find(other => other !== selected);
    URL.revokeObjectURL(frames.get(oldest).url); frames.delete(oldest);
  }
  drawStack();
});
setInterval(() => {
  const now = Date.now();
  for (const [id, frame] of frames) if (now - frame.capturedAt > 5e3) {
    URL.revokeObjectURL(frame.url); frames.delete(id);
  }
  drawStack();
  if (!lastFrame) return;
  const age = now - lastFrame;
  if (age > 5e3) { clearFrame(); el('status').textContent = labels['preview.unavailable']; }
  else if (age > 2e3) el('status').textContent = labels['preview.delayed'];
}, 500);

el('title').onclick = () => activate(selected);
el('viewport').onclick = () => { if (Date.now() >= suppressClickUntil) void activate(selected); };
for (const action of ['pause', 'resume', 'stop', 'confirm']) el(action).onclick = () => selected && run(selected, action);
api.onRuntime(draw); api.onPresentation(present);
api.getRuntime().then(state => draw(state, true));
api.getPresentation().then(present);
window.addEventListener('unload', () => { clearFrame(); for (const frame of frames.values()) URL.revokeObjectURL(frame.url); frames.clear(); });
`;

export function taskPreviewWindowHtml(t: (key: string) => string) {
  const keys = ['title', 'confirmAllow', 'scope.choose', 'reason.generic', 'phase.running', 'phase.paused', 'phase.stopped', 'phase.failed',
    'preview.close', 'preview.pause', 'preview.resume', 'preview.stop', 'preview.takeover',
    'preview.loading', 'preview.unavailable', 'preview.minimized', 'preview.permissionsRequired', 'preview.helperUpgradeRequired',
    'preview.delayed', 'preview.ended', 'preview.handoff', ...CUA_REASON_KEYS.map(key => 'reason.' + key)];
  const labels = JSON.stringify(Object.fromEntries(keys.map(key => [key, t('Claw.Cua.' + key)]))).replace(/</g, '\\u003c');
  const notices = JSON.stringify([...CUA_OVERLAY_NOTICE_REASONS]).replace(/</g, '\\u003c');
  const nonce = randomBytes(16).toString('hex');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
:root{color-scheme:light dark;--text:#25252d;--muted:#868692;--glass:#fffffff7;--line:#e8e8ed;--hover:#25252d08;--accent:#6558f5;--danger:#cf4b55;--danger-bg:#e05a6317;--preview-inset:10px;--stack-space:0px}
*{box-sizing:border-box}body{margin:0;overflow:hidden;background:transparent;color:var(--text);font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none}
button{font:inherit;color:inherit;cursor:pointer;-webkit-app-region:no-drag}button:disabled{opacity:.4;cursor:default}[hidden]{display:none!important}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.shell{position:absolute;z-index:4;inset:var(--preview-inset) var(--preview-inset) calc(var(--preview-inset) + var(--stack-space)) calc(var(--preview-inset) + var(--stack-space));border:1px solid var(--line);border-radius:10px;background:var(--glass);overflow:hidden;box-shadow:0 2px 6px #17172b12}
header{position:absolute;inset:0 0 auto;height:32px;z-index:2;background:var(--glass);backdrop-filter:blur(12px);display:flex;align-items:center;gap:6px;padding:0 6px 0 9px;cursor:grab;touch-action:none;opacity:0;pointer-events:none;transition:opacity .12s ease}header:active{cursor:grabbing}
#dragHandle{font-size:14px;color:var(--muted);opacity:.6;flex:none}#dot{width:5px;height:5px;border-radius:50%;flex:none}
#title{flex:1;min-width:0;text-align:left;padding:0;border:0;background:transparent;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#phase{color:var(--muted);font-size:10px;white-space:nowrap}.icon{display:flex;align-items:center;justify-content:center;width:24px;height:25px;padding:0;border:0;border-radius:7px;background:transparent;flex:none}.icon:hover{background:var(--hover)}#close svg{width:13px;height:13px}
#viewport{touch-action:none;position:absolute;inset:0;display:grid;place-items:center;padding:0;border:0;overflow:hidden;border-radius:inherit;background:var(--hover)}
#viewport:not(:disabled):hover{outline:1px solid var(--accent);outline-offset:-1px}#image{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;pointer-events:none;border-radius:6px}
#status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:12px;text-align:center;color:var(--muted);font-size:11px;line-height:1.6;background:var(--glass)}#status:empty{display:none}
#toolbar{position:absolute;z-index:2;bottom:8px;opacity:0;pointer-events:none;left:8px;right:8px;display:flex;align-items:center;gap:6px;height:26px;transform:translateY(3px);transition:opacity .12s ease,transform .12s ease}#toolbar button{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;height:26px;padding:0 8px;border:1px solid var(--line);border-radius:5px;background:var(--glass);backdrop-filter:blur(8px);font-size:11px;white-space:nowrap}#toolbar #stop{color:var(--danger)}#toolbar #stop:hover{background:var(--danger-bg)}
#stack{position:absolute;inset:0;pointer-events:none}#stack button{position:absolute;inset:calc(var(--preview-inset) + var(--offset)) calc(var(--preview-inset) + var(--offset)) calc(var(--preview-inset) + var(--remaining)) calc(var(--preview-inset) + var(--remaining));padding:0;border:1px solid var(--line);border-left:3px solid var(--task-color);box-shadow:0 2px 6px #17172b12;border-radius:8px;background:var(--glass);overflow:hidden;pointer-events:auto}#stack img{width:100%;height:100%;object-fit:contain;opacity:.9}#stack span{position:absolute;right:2px;bottom:2px;max-width:95%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;color:var(--muted)}
#error{position:absolute;z-index:8;bottom:47px;left:9px;right:9px;max-height:72px;overflow:auto;margin:0;padding:7px 9px;font-size:11px;line-height:1.5;color:var(--danger);background:var(--glass);border:1px solid var(--danger-bg);border-radius:8px}#error:empty{display:none}
.shell:hover header,.shell:focus-within header{opacity:1;pointer-events:auto}
.shell:hover #toolbar,.shell:has(:focus-visible) #toolbar{opacity:1;pointer-events:auto;transform:translateY(0)}
#pauseHint{position:absolute;z-index:1;top:7px;left:7px;padding:3px 6px;border:1px solid var(--line);border-radius:4px;background:var(--glass);color:var(--muted);font-size:10px;pointer-events:none}.shell:hover #pauseHint,.shell:has(:focus-visible) #pauseHint{opacity:0}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media(prefers-color-scheme:dark){:root{--text:#eeeef2;--muted:#a0a0ad;--glass:#25252cf7;--line:#ffffff15;--hover:#ffffff0a;--accent:#8175ff;--danger:#f08c94;--danger-bg:#e05a6324}}
  </style></head><body><div id="stack"></div><main class="shell">
  <button id="viewport"><img id="image" hidden alt=""><span id="status" role="status"></span></button>
  <span id="pauseHint" hidden role="status"></span>
  <div id="toolbar"><button id="pause"></button><button id="resume"></button><button id="confirm" hidden></button><button id="stop"></button></div>
  <header><span id="dragHandle" aria-hidden="true">⠿</span><span id="dot"></span><button id="title"></button><span id="phase"></span><button id="close" class="icon"><svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
  <p id="error" role="alert"></p></main><script nonce="${nonce}">
${previewClientSource.replace('__CUA_LABELS__', labels).replace('__CUA_NOTICES__', notices)}
  </script></body></html>`;
}
