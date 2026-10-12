import type { CaptureAnnotation } from './annotations';
import type { CaptureWindowBridge, CaptureRect, RecordingControlState } from '../../../shared/features/capture/windowContract';

/** All native-window UI runs inside this closure; no network, node or shared app state. */
export async function mountCaptureWindow(
  makePainter: () => { draw(ctx: CanvasRenderingContext2D, annotation: CaptureAnnotation): void },
  makeHistory: <T>() => { values(): T[]; push(value: T): void; undo(): boolean; redo(): boolean; clear(): void; canUndo(): boolean; canRedo(): boolean },
  placeToolbar: (target: CaptureRect | null, area: CaptureRect, size: { width: number; height: number }) => CaptureRect,
  makeIcon: (name: string) => SVGSVGElement,
): Promise<void> {
  const bridge = (window as unknown as { NuwaxCaptureWindow: CaptureWindowBridge }).NuwaxCaptureWindow;
  const config = await bridge.init();
  if (!config) return;
  document.body.replaceChildren();
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag); if (cls) el.className = cls; if (text) el.textContent = text; return el;
  };
  const buttonVisual = (button: HTMLButtonElement, icon: string, label: string, showText = false) => {
    button.title = label; button.setAttribute('aria-label', label);
    button.classList.toggle('iconOnly', !showText);
    button.replaceChildren(makeIcon(icon));
    if (showText) button.append(node('span', '', label));
  };
  if (config.kind === 'border') {
    document.body.className = 'border';
    bridge.onState((state) => { document.body.dataset.state = state.state; });
    return;
  }
  const labels = config.labels;
  document.title = config.kind === 'selection' && config.mode === 'still' ? labels.screenshot : labels.record;
  if (config.kind === 'controls') {
    document.body.className = 'controlBody';
    const bar = node('div', 'controlBar');
    const status = node('span', 'status'); const timer = node('strong', 'timer');
    const pause = node('button', '', labels.pause); const stop = node('button', 'danger', labels.stop);
    const cancel = node('button', '', labels.cancel);
    buttonVisual(stop, 'stop', labels.stop); buttonVisual(cancel, 'cancel', labels.cancel);
    bar.append(status, timer, pause, stop, cancel); document.body.append(bar);
    let current = config.state;
    const update = (state: RecordingControlState) => {
      current = state;
      bar.dataset.state = state.state;
      status.textContent = labels[state.state];
      const seconds = Math.floor(Math.max(0, state.elapsedMs) / 1000);
      timer.textContent = state.state === 'countdown' ? String(state.countdown ?? 3) : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      const pauseIcon = state.state === 'paused' ? 'resume' : 'pause';
      if (pause.dataset.icon !== pauseIcon) {
        buttonVisual(pause, pauseIcon, labels[pauseIcon]); pause.dataset.icon = pauseIcon;
      }
      pause.disabled = !['recording', 'paused'].includes(state.state);
      stop.disabled = state.state === 'encoding' || state.state === 'countdown';
    };
    pause.onclick = () => bridge.action(current.state === 'paused' ? 'resume' : 'pause');
    stop.onclick = () => bridge.action('stop'); cancel.onclick = () => bridge.action('cancel');
    document.onkeydown = (e) => { if (e.key === 'Escape') bridge.action('cancel'); };
    bridge.onState(update); update(config.state); return;
  }
  const captureMode = config.mode;
  const workArea = config.workArea;
  const painter = makePainter();
  const history = makeHistory<CaptureAnnotation>();
  let frame = config.image;
  const displayFrame = config.image;
  let image = new Image();
  let mode: 'screen' | 'window' | 'region' = 'region';
  let crop: CaptureRect | null = null;
  let tool: CaptureAnnotation['tool'] | null = null;
  let active: CaptureAnnotation | null = null;
  let drag: { x: number; y: number } | null = null;
  let busy = false;
  let sourceError = '';
  const viewport = node('div', 'viewport');
  const canvas = node('canvas', 'frame'); const mask = node('canvas', 'mask');
  const context = canvas.getContext('2d')!;
  const maskContext = mask.getContext('2d')!;
  viewport.append(canvas, mask); document.body.append(viewport);
  const top = node('div', 'toolbar top');
  const toolBar = node('div', 'toolbar tools');
  const dock = node('div', 'selectionDock'); dock.append(toolBar, top);
  const hint = node('div', 'hint', labels.selectHint);
  const dimensions = node('div', 'dimensions');
  const magnifier = node('canvas', 'magnifier'); magnifier.width = 160; magnifier.height = 160;
  const textInput = node('input', 'textInput'); textInput.placeholder = labels.textHint;
  document.body.append(dock, hint, dimensions, magnifier, textInput);
  const sourceGrid = node('div', 'sourceGrid'); document.body.append(sourceGrid);
  const buttons: Record<string, HTMLButtonElement> = {};
  const button = (parent: HTMLElement, key: string, title: string, action: () => void) => {
    const b = node('button'); b.dataset.action = key; b.onclick = action;
    buttonVisual(b, key === 'confirm' && captureMode === 'record' ? 'record' : key, title, ['screen', 'window', 'region', 'confirm'].includes(key));
    buttons[key] = b; parent.append(b); return b;
  };
  function bounds() { return canvas.getBoundingClientRect(); }
  function point(e: MouseEvent) {
    const r = bounds();
    return { x: Math.max(0, Math.min(frame.width, (e.clientX - r.x) * frame.width / r.width)), y: Math.max(0, Math.min(frame.height, (e.clientY - r.y) * frame.height / r.height)) };
  }
  function rect(a: { x: number; y: number }, b: { x: number; y: number }): CaptureRect {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(a.x, b.x)) - Math.round(x), height: Math.round(Math.max(a.y, b.y)) - Math.round(y) };
  }
  function clipped(p: { x: number; y: number }) {
    if (!crop) return p;
    return { x: Math.max(crop.x, Math.min(crop.x + crop.width, p.x)), y: Math.max(crop.y, Math.min(crop.y + crop.height, p.y)) };
  }
  function placeDock() {
    const r = bounds();
    const selected = crop ? { x: r.x + crop.x / frame.width * r.width, y: r.y + crop.y / frame.height * r.height,
      width: crop.width / frame.width * r.width, height: crop.height / frame.height * r.height } : null;
    const display = displayFrame.selection.displayBounds;
    const area = { ...workArea, x: workArea.x - display.x, y: workArea.y - display.y };
    dock.style.maxWidth = `${Math.max(1, area.width - 24)}px`;
    const position = placeToolbar(selected, area, { width: dock.offsetWidth, height: dock.offsetHeight });
    dock.style.left = `${position.x}px`; dock.style.top = `${position.y}px`;
    // Hide while drawing so the controls cannot intercept the pointer or obscure
    // the area being selected. They reappear beside the final selection on release.
    dock.style.visibility = drag || active ? 'hidden' : 'visible';
    hint.style.left = `${area.x + area.width / 2}px`;
    hint.style.top = `${Math.max(area.y + 12, position.y - hint.offsetHeight - 12)}px`;
    hint.hidden = Boolean(crop);
    if (selected) {
      dimensions.style.left = `${Math.max(area.x + 4, Math.min(area.x + area.width - dimensions.offsetWidth - 4, selected.x))}px`;
      dimensions.style.top = `${Math.max(area.y + 4, selected.y - dimensions.offsetHeight - 6)}px`;
    }
  }
  function draw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, frame.width, frame.height);
    if (crop) { context.save(); context.beginPath(); context.rect(crop.x, crop.y, crop.width, crop.height); context.clip(); }
    for (const annotation of history.values()) painter.draw(context, annotation);
    if (active) painter.draw(context, active);
    if (crop) context.restore();
    maskContext.clearRect(0, 0, mask.width, mask.height);
    maskContext.fillStyle = 'rgba(0,0,0,.48)';
    maskContext.fillRect(0, 0, mask.width, mask.height);
    if (crop) {
      maskContext.clearRect(crop.x, crop.y, crop.width, crop.height);
      maskContext.strokeStyle = '#36d5ae'; maskContext.lineWidth = Math.max(1, frame.width / bounds().width);
      maskContext.strokeRect(crop.x, crop.y, crop.width, crop.height);
      dimensions.textContent = `${crop.width} × ${crop.height} px`;
    }
    dimensions.hidden = !crop;
    toolBar.hidden = !crop || captureMode === 'record';
    buttons.confirm.disabled = !crop || crop.width < 1 || crop.height < 1 || busy;
    buttons.undo.disabled = !history.canUndo(); buttons.redo.disabled = !history.canRedo();
    for (const key of ['screen', 'window', 'region', 'rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic']) {
      const selected = ['screen', 'window', 'region'].includes(key) ? mode === key : tool === key;
      buttons[key].classList.toggle('selected', selected); buttons[key].setAttribute('aria-pressed', String(selected));
    }
    hint.textContent = sourceError || (crop ? labels.annotationHint : labels.selectHint);
    placeDock();
    if (sourceError) hint.hidden = false;
  }
  function clear() { history.clear(); active = null; tool = null; textInput.style.display = 'none'; }
  function full() { crop = { x: 0, y: 0, width: frame.width, height: frame.height }; clear(); draw(); }
  button(top, 'screen', labels.screen, () => { void chooseDisplay('screen'); });
  button(top, 'window', labels.window, () => { mode = 'window'; sourceError = config.sources.some((source) => source.kind === 'window') ? '' : labels.loadFailed; crop = null; clear(); sourceGrid.hidden = false; draw(); });
  button(top, 'region', labels.region, () => { void chooseDisplay('region'); });
  button(top, 'cancel', labels.cancel, () => bridge.action('cancel'));
  async function confirm() {
    if (!crop || busy || crop.width < 1 || crop.height < 1) return;
    busy = true; active = null; draw();
    const output = node('canvas'); output.width = crop.width; output.height = crop.height;
    output.getContext('2d')!.drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    try { await bridge.finish({ crop, ...(captureMode === 'still' ? { png: output.toDataURL('image/png') } : {}) }); }
    finally { busy = false; }
  }
  button(top, 'confirm', captureMode === 'record' ? labels.record : labels.confirm, () => { void confirm(); });
  buttons.confirm.classList.add('primary');
  for (const key of ['rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic'] as const) {
    button(toolBar, key, labels[key], () => { tool = tool === key ? null : key; draw(); });
  }
  const color = node('input'); color.type = 'color'; color.value = '#ff3b52'; color.title = labels.color; toolBar.append(color);
  const width = node('input'); width.type = 'range'; width.min = '1'; width.max = '8'; width.value = '2'; width.title = labels.lineWidth; toolBar.append(width);
  button(toolBar, 'undo', labels.undo, () => { history.undo(); draw(); });
  button(toolBar, 'redo', labels.redo, () => { history.redo(); draw(); });
  sourceGrid.hidden = true;
  for (const source of config.sources.filter((s) => s.kind === 'window')) {
    const entry = node('button', 'source'); entry.dataset.source = source.id;
    const thumb = node('img'); thumb.src = source.thumbnail;
    entry.append(thumb, node('span', '', source.name));
    entry.onclick = async () => {
      if (busy) return;
      busy = true; sourceError = ''; hint.textContent = labels.loading;
      try {
        const chosen = await bridge.source(source.id);
        if (!chosen) { sourceError = labels.loadFailed; return; }
        frame = chosen; sourceGrid.hidden = true;
        await loadImage(); full();
      } catch { sourceError = labels.loadFailed; }
      finally { busy = false; draw(); }
    };
    sourceGrid.append(entry);
  }
  function showMagnifier(e: MouseEvent, p: { x: number; y: number }) {
    if (crop && !drag) { magnifier.hidden = true; return; }
    magnifier.hidden = false;
    magnifier.style.left = `${Math.max(0, Math.min(innerWidth - 170, e.clientX + 22))}px`;
    magnifier.style.top = `${Math.max(54, Math.min(innerHeight - 170, e.clientY + 22))}px`;
    const ctx = magnifier.getContext('2d')!; ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 160, 160);
    ctx.drawImage(image, p.x - 20, p.y - 20, 40, 40, 0, 0, 160, 160);
    ctx.strokeStyle = '#36d5ae'; ctx.beginPath(); ctx.moveTo(80, 0); ctx.lineTo(80, 160); ctx.moveTo(0, 80); ctx.lineTo(160, 80); ctx.stroke();
  }
  mask.onpointerdown = (e) => {
    if (busy || mode === 'window' && !sourceGrid.hidden) return;
    mask.setPointerCapture(e.pointerId);
    const p = point(e);
    if (crop && tool) {
      const a = clipped(p); const scale = frame.width / bounds().width;
      active = { tool, points: [a], width: Number(width.value) * scale, color: color.value };
      if (tool === 'text') {
        const operation = active; active = null;
        textInput.value = ''; textInput.style.display = 'block'; textInput.style.left = `${e.clientX}px`; textInput.style.top = `${e.clientY}px`; textInput.focus();
        const commit = () => { if (textInput.value.trim()) { operation.text = textInput.value; history.push(operation); } textInput.style.display = 'none'; textInput.onblur = null; draw(); };
        textInput.onblur = commit;
        textInput.onkeydown = (key) => { key.stopPropagation(); if (key.key === 'Enter') textInput.blur(); if (key.key === 'Escape') { textInput.value = ''; textInput.blur(); } };
      }
    } else if (mode === 'region') { drag = p; crop = rect(p, p); clear(); }
    draw();
  };
  mask.onpointermove = (e) => {
    const p = point(e);
    if (drag) crop = rect(drag, p);
    else if (active) {
      const next = clipped(p);
      if (active.tool === 'pen') active.points.push(next);
      else active.points = [active.points[0], next];
    }
    if (drag || active) draw();
    showMagnifier(e, p);
  };
  mask.onpointerup = () => {
    drag = null;
    if (active) { history.push(active); active = null; }
    if (crop && (crop.width < 1 || crop.height < 1)) crop = null;
    magnifier.hidden = true; draw();
  };
  document.onkeydown = (e) => {
    if (e.target === textInput) return;
    if (e.key === 'Escape') bridge.action('cancel');
    else if (e.key === 'Enter') { e.preventDefault(); void confirm(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); draw(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); history.redo(); draw(); }
  };
  async function chooseDisplay(nextMode: 'screen' | 'region') {
    if (busy) return;
    busy = true;
    try {
      mode = nextMode; sourceError = ''; sourceGrid.hidden = true;
      const restored = await bridge.source(displayFrame.selection.sourceId);
      if (!restored) return;
      frame = restored; await loadImage();
      crop = nextMode === 'screen' ? { x: 0, y: 0, width: frame.width, height: frame.height } : null;
      clear();
    } finally { busy = false; draw(); }
  }
  async function loadImage() {
    image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('capture image could not load')); image.src = frame.dataUrl; });
    canvas.width = mask.width = frame.width; canvas.height = mask.height = frame.height;
    // Screens fill their native display; selected windows are fitted without changing the pixels.
    const screenSource = frame.selection.sourceKind === 'screen';
    viewport.classList.toggle('fitted', !screenSource);
    const ratio = frame.width / frame.height;
    const viewWidth = screenSource ? innerWidth : Math.min(innerWidth - 80, (innerHeight - 160) * ratio);
    const viewHeight = screenSource ? innerHeight : viewWidth / ratio;
    viewport.style.width = `${viewWidth}px`; viewport.style.height = `${viewHeight}px`;
    viewport.style.left = `${(innerWidth - viewWidth) / 2}px`; viewport.style.top = `${(innerHeight - viewHeight) / 2}px`;
  }
  await loadImage();
  magnifier.hidden = true; draw();
}
