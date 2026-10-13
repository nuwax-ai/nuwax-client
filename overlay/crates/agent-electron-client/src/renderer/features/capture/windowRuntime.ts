import type { CaptureAnnotation, AnnotationPoint, createAnnotationPainter, createAnnotationHistory } from './annotations';
import type { CaptureWindowBridge, CaptureRect, RecordingControlState } from '../../../shared/features/capture/windowContract';

/** All native-window UI runs inside this closure; no network, node or shared app state. */
export async function mountCaptureWindow(
  makePainter: typeof createAnnotationPainter,
  makeHistory: typeof createAnnotationHistory,
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
    buttonVisual(stop, 'stop', labels.stop, true); buttonVisual(cancel, 'cancel', labels.cancel);
    bar.append(status, timer, pause, stop, cancel); document.body.append(bar);
    if (config.presentation === 'preview') document.body.append(node('div', 'dockHint', labels.linuxRecordingHint));
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
  const previewPresentation = config.presentation === 'preview';
  const workArea = config.workArea;
  const painter = makePainter();
  const history = makeHistory<CaptureAnnotation>();
  let frame = config.image;
  const displayFrame = config.image;
  let image = new Image();
  let mode: 'screen' | 'window' | 'region' = 'region';
  let crop: CaptureRect | null = null;
  let tool: CaptureAnnotation['tool'] | 'select' | null = null;
  let active: CaptureAnnotation | null = null;
  let selectedIndex: number | null = null;
  let annotationDrag: { index: number; original: CaptureAnnotation; start: AnnotationPoint; handle: number | null; moved: boolean } | null = null;
  let propertyChange: { index: number; value: CaptureAnnotation } | null = null;
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
  const toolGroup = node('div', 'toolGroup'), historyGroup = node('div', 'historyGroup');
  toolBar.append(toolGroup, historyGroup);
  const properties = node('div', 'toolbar properties');
  const styleCaption = node('span', 'styleCaption');
  const palette = node('div', 'palette');
  properties.append(styleCaption, palette);
  const modeGroup = node('div', 'modeGroup'), actionGroup = node('div', 'actionGroup');
  top.append(modeGroup, actionGroup);
  const dockHint = node('div', 'dockHint', labels.annotationHint);
  const dock = node('div', 'selectionDock'); dock.append(toolBar, properties, top, dockHint);
  const hint = node('div', 'hint', labels.selectHint);
  const tooltip = node('div', 'tooltip'); tooltip.hidden = true; tooltip.setAttribute('role', 'tooltip');
  const dimensions = node('div', 'dimensions');
  const magnifier = node('canvas', 'magnifier'); magnifier.width = 160; magnifier.height = 160;
  const textInput = node('input', 'textInput'); textInput.placeholder = labels.textHint;
  textInput.style.userSelect = 'text';
  let pendingText: CaptureAnnotation | null = null;
  let pendingTextIndex: number | null = null;
  document.body.append(dock, hint, dimensions, magnifier, textInput, tooltip);
  if (config.recordingHint) document.body.append(node('div', 'recordingNotice', config.recordingHint));
  const sourceGrid = node('div', 'sourceGrid'); document.body.append(sourceGrid);
  const buttons: Record<string, HTMLButtonElement> = {};
  const button = (parent: HTMLElement, key: string, title: string, action: () => void) => {
    const b = node('button'); b.dataset.action = key; b.onclick = action;
    buttonVisual(b, key === 'confirm' && captureMode === 'record' ? 'record' : key, title, ['screen', 'window', 'region', 'confirm'].includes(key));
    buttons[key] = b; parent.append(b); return b;
  };
  function hideTooltip() { tooltip.hidden = true; }
  function showTooltip(target: EventTarget | null) {
    if (!(target instanceof Element) || drag || active || dock.style.visibility === 'hidden') return;
    const button = target.closest('button');
    if (!button || !dock.contains(button) || button.disabled) { hideTooltip(); return; }
    const label = button.getAttribute('aria-label');
    if (!label) return;
    const shortcut = button.dataset.action === 'confirm' ? 'Enter' : button.dataset.action === 'cancel' ? 'Esc' : '';
    tooltip.textContent = shortcut ? `${label} · ${shortcut}` : label;
    const display = displayFrame.selection.displayBounds;
    const area = previewPresentation ? { x: 0, y: 0, width: innerWidth, height: innerHeight }
      : { ...workArea, x: workArea.x - (display?.x ?? 0), y: workArea.y - (display?.y ?? 0) };
    tooltip.style.maxWidth = `${Math.max(1, area.width - 16)}px`;
    tooltip.hidden = false;
    const anchor = button.getBoundingClientRect();
    const minX = area.x + 8, maxX = area.x + area.width - tooltip.offsetWidth - 8;
    const minY = area.y + 8, maxY = area.y + area.height - tooltip.offsetHeight - 8;
    const above = anchor.top - tooltip.offsetHeight - 7;
    tooltip.style.left = `${Math.max(minX, Math.min(maxX, anchor.x + (anchor.width - tooltip.offsetWidth) / 2))}px`;
    tooltip.style.top = `${Math.max(minY, Math.min(maxY, above >= minY ? above : anchor.bottom + 7))}px`;
  }
  dock.addEventListener('pointerover', (e) => showTooltip(e.target));
  dock.addEventListener('pointerleave', hideTooltip);
  dock.addEventListener('pointerdown', hideTooltip);
  dock.addEventListener('focusin', (e) => showTooltip(e.target));
  dock.addEventListener('focusout', hideTooltip);
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
  const pixelScale = () => frame.width / bounds().width;
  function selectedAnnotation() {
    if (selectedIndex === null) return null;
    return annotationDrag && active ? active : propertyChange?.value ?? history.values()[selectedIndex] ?? null;
  }
  function handles(annotation: CaptureAnnotation) {
    if (annotation.tool === 'text') return [];
    if (annotation.tool === 'arrow') return [annotation.points[0], annotation.points[annotation.points.length - 1]];
    const b = painter.bounds(context, annotation);
    return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
  }
  function hitHandle(p: AnnotationPoint): number | null {
    const annotation = selectedAnnotation();
    if (!annotation) return null;
    const index = handles(annotation).findIndex(h => Math.hypot(h.x - p.x, h.y - p.y) <= 7 * pixelScale());
    return index < 0 ? null : index;
  }
  function hitAnnotation(p: AnnotationPoint): number | null {
    if (!crop || p.x < crop.x || p.x > crop.x + crop.width || p.y < crop.y || p.y > crop.y + crop.height) return null;
    const annotations = history.values();
    for (let i = annotations.length - 1; i >= 0; i--) {
      if (painter.hitTest(context, annotations[i], p, 5 * pixelScale())) return i;
    }
    return null;
  }
  function syncProperties(annotation: CaptureAnnotation) {
    color.value = annotation.color;
    width.value = String(annotation.width / pixelScale());
    if (annotation.tool === 'text') fontSize.value = String(Math.round((annotation.fontSize ?? Math.max(12, annotation.width * 7)) / pixelScale()));
  }
  function placeDock() {
    hideTooltip();
    const r = bounds();
    const selected = crop ? { x: r.x + crop.x / frame.width * r.width, y: r.y + crop.y / frame.height * r.height,
      width: crop.width / frame.width * r.width, height: crop.height / frame.height * r.height } : null;
    const display = displayFrame.selection.displayBounds;
    const area = previewPresentation ? { x: 0, y: 0, width: innerWidth, height: innerHeight }
      : { ...workArea, x: workArea.x - (display?.x ?? 0), y: workArea.y - (display?.y ?? 0) };
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
      const x = Math.max(area.x + 4, Math.min(area.x + area.width - dimensions.offsetWidth - 4, selected.x));
      const minY = area.y + 4, maxY = area.y + area.height - dimensions.offsetHeight - 4;
      const candidates = [selected.y - dimensions.offsetHeight - 6, selected.y + selected.height + 6, selected.y + 6]
        .map(y => Math.max(minY, Math.min(maxY, y)));
      const y = candidates.find(y => x + dimensions.offsetWidth <= position.x || x >= position.x + position.width
        || y + dimensions.offsetHeight <= position.y || y >= position.y + position.height);
      // 底边选区的面板会翻到上方，尺寸标签同步让位，避免透在工具栏后面。
      dimensions.hidden = y === undefined;
      dimensions.style.left = `${x}px`; dimensions.style.top = `${y ?? candidates[0]}px`;
    }
  }
  function draw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, frame.width, frame.height);
    if (crop) { context.save(); context.beginPath(); context.rect(crop.x, crop.y, crop.width, crop.height); context.clip(); }
    history.values().forEach((annotation, index) => {
      if (index === pendingTextIndex) return;
      painter.draw(context, annotationDrag?.index === index && active ? active : propertyChange?.index === index ? propertyChange.value : annotation);
    });
    if (active && !annotationDrag) painter.draw(context, active);
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
    const selected = selectedAnnotation();
    if (selected && !pendingText) {
      const b = painter.bounds(context, selected), scale = pixelScale();
      maskContext.save(); maskContext.strokeStyle = '#36d5ae'; maskContext.lineWidth = scale;
      maskContext.setLineDash([4 * scale, 3 * scale]); maskContext.strokeRect(b.x, b.y, b.width, b.height);
      maskContext.setLineDash([]); maskContext.fillStyle = '#fff';
      for (const handle of handles(selected)) {
        maskContext.fillRect(handle.x - 3 * scale, handle.y - 3 * scale, 6 * scale, 6 * scale);
        maskContext.strokeRect(handle.x - 3 * scale, handle.y - 3 * scale, 6 * scale, 6 * scale);
      }
      maskContext.restore();
    }
    dimensions.hidden = !crop;
    toolBar.hidden = !crop || captureMode === 'record';
    buttons.confirm.disabled = !crop || crop.width < 1 || crop.height < 1 || busy;
    buttons.undo.disabled = !history.canUndo(); buttons.redo.disabled = !history.canRedo();
    buttons.deleteAnnotation.disabled = selectedIndex === null;
    const styleTool = pendingText?.tool ?? selected?.tool ?? (tool === 'select' ? null : tool);
    properties.hidden = !crop || captureMode === 'record' || !styleTool;
    dockHint.hidden = !crop || captureMode === 'record';
    if (styleTool && styleCaption.dataset.tool !== styleTool) {
      styleCaption.dataset.tool = styleTool;
      styleCaption.replaceChildren(makeIcon(styleTool), node('span', '', labels[styleTool]));
    }
    fontControl.hidden = styleTool !== 'text'; widthControl.hidden = styleTool === 'text';
    palette.hidden = styleTool === 'mosaic'; color.disabled = styleTool === 'mosaic';
    widthValue.value = `${width.value} px`;
    for (const swatch of swatches) {
      const chosen = swatch.dataset.color === color.value;
      swatch.classList.toggle('selected', chosen); swatch.setAttribute('aria-pressed', String(chosen));
    }
    for (const preset of fontPresets) {
      const chosen = Number(preset.dataset.size) === Number(fontSize.value);
      preset.classList.toggle('selected', chosen); preset.setAttribute('aria-pressed', String(chosen));
    }
    for (const key of ['screen', 'window', 'region', 'select', 'rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic']) {
      const selected = ['screen', 'window', 'region'].includes(key) ? mode === key : tool === key;
      buttons[key].classList.toggle('selected', selected); buttons[key].setAttribute('aria-pressed', String(selected));
    }
    hint.textContent = sourceError || (crop ? labels.annotationHint : labels.selectHint);
    placeDock();
    if (sourceError) hint.hidden = false;
  }
  function finishText(commit = true) {
    const operation = pendingText;
    if (!operation) return;
    const index = pendingTextIndex, text = textInput.value;
    pendingText = null; pendingTextIndex = null;
    if (commit) {
      if (index === null && text.trim()) { selectedIndex = history.values().length; history.push({ ...operation, text }); }
      else if (index !== null) {
        const original = history.values()[index];
        if (!text.trim()) { history.replace(index, null); selectedIndex = null; }
        else if (text !== original.text || operation.fontSize !== original.fontSize || operation.color !== original.color) history.replace(index, { ...operation, text });
      }
    }
    textInput.value = ''; textInput.style.display = 'none'; textInput.blur(); draw();
  }
  function placeTextInput() {
    if (!pendingText) return;
    const scale = pixelScale(), r = bounds(), point = pendingText.points[0];
    textInput.style.font = `${(pendingText.fontSize ?? Math.max(12, pendingText.width * 7)) / scale}px sans-serif`;
    textInput.style.color = pendingText.color;
    const channels = pendingText.color.match(/[a-f\d]{2}/gi)?.map(value => parseInt(value, 16)) ?? [255, 255, 255];
    const brightness = channels[0] * .299 + channels[1] * .587 + channels[2] * .114;
    textInput.style.backgroundColor = brightness < 135 ? '#f3f6fa' : '#18222f';
    textInput.style.textShadow = 'none';
    textInput.style.width = `${Math.min(innerWidth - 16, Math.max(180, painter.bounds(context, { ...pendingText, text: textInput.value }).width / scale + 22))}px`;
    textInput.style.left = `${Math.max(0, Math.min(innerWidth - textInput.offsetWidth, r.x + point.x / scale - 7))}px`;
    textInput.style.top = `${Math.max(0, Math.min(innerHeight - textInput.offsetHeight, r.y + point.y / scale - 7))}px`;
  }
  function beginText(annotation: CaptureAnnotation, index: number | null) {
    pendingText = { ...annotation }; pendingTextIndex = index; selectedIndex = index; tool = 'text';
    syncProperties(annotation); textInput.value = annotation.text ?? ''; textInput.style.display = 'block';
    placeTextInput(); draw(); textInput.focus({ preventScroll: true });
    if (index !== null) textInput.select();
  }
  function finishPropertyChange() {
    if (!propertyChange) return;
    const original = history.values()[propertyChange.index], value = propertyChange.value;
    if (original.color !== value.color || original.width !== value.width || original.fontSize !== value.fontSize) history.replace(propertyChange.index, value);
    propertyChange = null;
  }
  function changeProperties(patch: Partial<Pick<CaptureAnnotation, 'color' | 'width' | 'fontSize'>>) {
    if (pendingText) { pendingText = { ...pendingText, ...patch }; placeTextInput(); }
    else if (selectedIndex !== null) propertyChange = { index: selectedIndex, value: { ...(propertyChange?.value ?? history.values()[selectedIndex]), ...patch } };
    draw();
  }
  function stepHistory(redo = false) {
    finishText(); finishPropertyChange(); selectedIndex = null;
    redo ? history.redo() : history.undo(); draw();
  }
  function deleteSelected() {
    finishText(); finishPropertyChange();
    if (selectedIndex !== null) history.replace(selectedIndex, null);
    selectedIndex = null; draw();
  }
  textInput.onblur = () => finishText();
  textInput.oninput = () => placeTextInput();
  textInput.onkeydown = (e) => {
    e.stopPropagation();
    // 候选词确认的 Enter 必须交给输入法，不能提前结束文字标注。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finishText(e.key === 'Enter'); }
  };
  function clear() { finishText(false); propertyChange = null; selectedIndex = null; annotationDrag = null; history.clear(); active = null; tool = null; }
  function full() { crop = { x: 0, y: 0, width: frame.width, height: frame.height }; clear(); draw(); }
  button(modeGroup, 'screen', previewPresentation ? labels.entireSource : labels.screen, () => { void chooseDisplay('screen'); });
  button(modeGroup, 'window', labels.window, () => { mode = 'window'; sourceError = config.sources.some((source) => source.kind === 'window') ? '' : labels.loadFailed; crop = null; clear(); sourceGrid.hidden = false; draw(); });
  if (config.presentation === 'preview') buttons.window.hidden = true;
  button(modeGroup, 'region', labels.region, () => { void chooseDisplay('region'); });
  button(actionGroup, 'cancel', labels.cancel, () => bridge.action('cancel'));
  async function confirm() {
    if (!crop || busy || crop.width < 1 || crop.height < 1) return;
    finishText();
    finishPropertyChange();
    busy = true; active = null; draw();
    const output = node('canvas'); output.width = crop.width; output.height = crop.height;
    output.getContext('2d')!.drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    try { await bridge.finish({ crop, ...(captureMode === 'still' ? { png: output.toDataURL('image/png') } : {}) }); }
    finally { busy = false; }
  }
  button(actionGroup, 'confirm', captureMode === 'record' ? labels.record : labels.confirm, () => { void confirm(); });
  buttons.confirm.classList.add('primary');
  button(toolGroup, 'select', labels.select, () => { finishText(); finishPropertyChange(); tool = 'select'; draw(); });
  for (const key of ['rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic'] as const) {
    button(toolGroup, key, labels[key], () => { finishText(); finishPropertyChange(); selectedIndex = null; tool = tool === key ? 'select' : key; draw(); });
  }
  const swatches = ['#ff3b52', '#f6c445', '#36d5ae', '#4d9fff', '#ffffff'].map(value => {
    const swatch = node('button', 'swatch'); swatch.dataset.color = value;
    swatch.style.backgroundColor = value; swatch.setAttribute('aria-label', `${labels.color} ${value}`);
    // 快捷样式按钮保留文字输入焦点，避免点击时先触发 blur 提交文字。
    swatch.onpointerdown = (e) => e.preventDefault();
    swatch.onclick = () => { color.value = value; changeProperties({ color: value }); finishPropertyChange(); draw(); };
    palette.append(swatch); return swatch;
  });
  const color = node('input'); color.type = 'color'; color.value = '#ff3b52'; color.title = labels.color; color.setAttribute('aria-label', labels.color); palette.append(color);
  const widthControl = node('label', 'widthControl'); widthControl.title = labels.lineWidth;
  const width = node('input'); width.type = 'range'; width.min = '1'; width.max = '8'; width.value = '2'; width.title = labels.lineWidth; width.setAttribute('aria-label', labels.lineWidth);
  const widthValue = node('output', 'widthValue'); widthControl.append(width, widthValue); properties.append(widthControl);
  const fontControl = node('label', 'fontSizeControl'); fontControl.title = labels.fontSize;
  const fontSize = node('input'); fontSize.type = 'number'; fontSize.min = '8'; fontSize.max = '144'; fontSize.value = '14'; fontSize.dataset.action = 'fontSize'; fontSize.setAttribute('aria-label', labels.fontSize);
  fontControl.append(node('span', '', 'Aa'), fontSize);
  const fontPresets = [14, 24, 36].map(value => {
    const preset = node('button', 'fontPreset', String(value)); preset.type = 'button'; preset.dataset.size = String(value);
    preset.setAttribute('aria-label', `${labels.fontSize} ${value}`);
    preset.onpointerdown = (e) => e.preventDefault();
    preset.onclick = () => { fontSize.value = String(value); changeProperties({ fontSize: value * pixelScale() }); finishPropertyChange(); draw(); };
    fontControl.append(preset); return preset;
  });
  properties.append(fontControl);
  color.oninput = () => changeProperties({ color: color.value });
  width.oninput = () => changeProperties({ width: Number(width.value) * pixelScale() });
  fontSize.oninput = () => { const value = Number(fontSize.value); if (Number.isFinite(value) && value >= 8 && value <= 144) changeProperties({ fontSize: value * pixelScale() }); };
  for (const input of [color, width, fontSize]) input.onchange = () => { finishPropertyChange(); draw(); };
  fontSize.onchange = () => {
    const selected = selectedAnnotation(), value = Number(fontSize.value);
    const fallback = selected?.tool === 'text' ? (selected.fontSize ?? Math.max(12, selected.width * 7)) / pixelScale() : 14;
    const normalized = fontSize.value.trim() && Number.isFinite(value) ? Math.round(Math.max(8, Math.min(144, value))) : fallback;
    fontSize.value = String(normalized); changeProperties({ fontSize: normalized * pixelScale() }); finishPropertyChange(); draw();
  };
  button(historyGroup, 'deleteAnnotation', labels.deleteAnnotation, deleteSelected);
  button(historyGroup, 'undo', labels.undo, () => stepHistory());
  button(historyGroup, 'redo', labels.redo, () => stepHistory(true));
  for (const control of dock.querySelectorAll('button')) control.removeAttribute('title');
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
    const r = bounds();
    if (crop && !drag || e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) { magnifier.hidden = true; return; }
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
    hideTooltip();
    // 阻止画布抢焦点，并在切换标注前提交当前编辑。
    e.preventDefault(); finishText(); finishPropertyChange();
    mask.setPointerCapture(e.pointerId);
    const p = point(e);
    const handle = hitHandle(p), hit = hitAnnotation(p);
    const index = handle !== null ? selectedIndex : hit;
    const existing = index === null ? null : history.values()[index];
    if (crop && existing && (handle !== null || tool === 'select' || existing.tool === tool)) {
      selectedIndex = index; syncProperties(existing);
      annotationDrag = { index: index!, original: existing, start: p, handle, moved: false };
    } else if (crop && tool && tool !== 'select') {
      selectedIndex = null;
      const a = clipped(p); const scale = frame.width / bounds().width;
      active = { tool, points: [a], width: Number(width.value) * scale, color: color.value };
      if (tool === 'text') {
        const annotation = { ...active, fontSize: Math.max(8, Math.min(144, Number(fontSize.value) || 14)) * scale };
        active = null; beginText(annotation, null);
      }
    } else if (!crop && mode === 'region') { drag = p; crop = rect(p, p); clear(); }
    else selectedIndex = null;
    draw();
  };
  mask.onpointermove = (e) => {
    const p = point(e);
    if (drag) crop = rect(drag, p);
    else if (annotationDrag && crop) {
      const { original, start, handle } = annotationDrag;
      if (Math.hypot(p.x - start.x, p.y - start.y) > 2 * pixelScale()) annotationDrag.moved = true;
      if (annotationDrag.moved) {
        const b = painter.bounds(context, original), next = clipped(p);
        if (handle !== null && original.tool === 'arrow') {
          active = { ...original, points: original.points.map((point, index) => index === handle ? next : point) };
        } else if (handle !== null) {
          const opposite = handles(original)[(handle + 2) % 4];
          const target = rect(opposite, next);
          if (target.width >= pixelScale() && target.height >= pixelScale()) active = painter.resize(context, original, target);
        } else {
          // 超长文字按锚点限制；其余图形整体保留在当前选区内。
          const w = Math.min(b.width, crop.width), h = Math.min(b.height, crop.height);
          const dx = Math.max(crop.x - b.x, Math.min(crop.x + crop.width - b.x - w, p.x - start.x));
          const dy = Math.max(crop.y - b.y, Math.min(crop.y + crop.height - b.y - h, p.y - start.y));
          active = { ...original, points: original.points.map(point => ({ x: point.x + dx, y: point.y + dy })) };
        }
      }
    }
    else if (active) {
      const next = clipped(p);
      if (active.tool === 'pen') active.points.push(next);
      else active.points = [active.points[0], next];
    }
    if (drag || active) draw();
    if (!drag && !annotationDrag && !active) {
      const handle = hitHandle(p), hit = hitAnnotation(p);
      const existing = hit === null ? null : history.values()[hit];
      mask.style.cursor = handle !== null ? (handle % 2 ? 'nesw-resize' : 'nwse-resize')
        : existing && (tool === 'select' || existing.tool === tool) ? 'move' : tool === 'text' ? 'text' : 'crosshair';
    }
    showMagnifier(e, p);
  };
  // 每个显示器有独立的选区窗口；跨屏后旧窗口必须撤掉放大框。
  mask.onpointerleave = () => { magnifier.hidden = true; };
  window.addEventListener('blur', () => { magnifier.hidden = true; hideTooltip(); });
  mask.onpointerup = () => {
    drag = null;
    if (annotationDrag) {
      const current = annotationDrag; annotationDrag = null;
      if (current.moved && active) history.replace(current.index, active);
      active = null;
      if (!current.moved && current.original.tool === 'text') beginText(current.original, current.index);
    } else if (active) { selectedIndex = history.values().length; history.push(active); active = null; tool = 'select'; }
    if (crop && (crop.width < 1 || crop.height < 1)) crop = null;
    if (crop && !tool) tool = 'select';
    magnifier.hidden = true; draw();
  };
  document.onkeydown = (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') {
      if (annotationDrag) { annotationDrag = null; active = null; draw(); }
      else if (selectedIndex !== null) { selectedIndex = null; draw(); }
      else bridge.action('cancel');
    }
    else if (e.key === 'Enter') { e.preventDefault(); void confirm(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIndex !== null) { e.preventDefault(); deleteSelected(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); stepHistory(e.shiftKey); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); stepHistory(true); }
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
    layoutImage();
  }
  function layoutImage() {
    const screenSource = frame.selection.sourceKind === 'screen' && !previewPresentation;
    viewport.classList.toggle('fitted', !screenSource);
    const ratio = frame.width / frame.height;
    const viewWidth = screenSource ? innerWidth : Math.min(innerWidth - 80, (innerHeight - 160) * ratio);
    const viewHeight = screenSource ? innerHeight : viewWidth / ratio;
    viewport.style.width = `${viewWidth}px`; viewport.style.height = `${viewHeight}px`;
    viewport.style.left = `${(innerWidth - viewWidth) / 2}px`; viewport.style.top = `${(innerHeight - viewHeight) / 2}px`;
  }
  await loadImage();
  window.addEventListener('resize', () => { layoutImage(); draw(); });
  magnifier.hidden = true; draw();
}
