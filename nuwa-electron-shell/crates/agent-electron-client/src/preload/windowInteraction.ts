/** 仅由原生窗口沿驱动，webview 内部切换焦点不应被当作离开客户端。 */
export function installWindowInteraction(
  doc: Document,
  view: Window & typeof globalThis,
): (focused: boolean) => void {
  type EditingPosition = {
    element: HTMLElement;
    value?: string;
    start?: number | null;
    end?: number | null;
    direction?: "forward" | "backward" | "none" | null;
    range?: Range;
  };
  let hostFocused = true;
  let saved: EditingPosition | null = null;

  const isTextControl = (
    element: Element,
  ): element is HTMLInputElement | HTMLTextAreaElement =>
    element.tagName === "TEXTAREA" ||
    (element.tagName === "INPUT" &&
      ["text", "search", "email", "url", "tel", "password", "number"].includes(
        (element as HTMLInputElement).type,
      ));

  const restore = () => {
    if (!hostFocused || !saved || !doc.hasFocus()) return;
    const position = saved;
    saved = null;
    const element = position.element;
    const active = doc.activeElement;
    if (
      !element.isConnected || element.closest("[inert]") ||
      (active && active !== doc.body && active !== doc.documentElement && active !== element)
    ) return;
    if (isTextControl(element) && (element.disabled || element.readOnly)) return;
    // focus 不滚动页面；值已变时不回写旧的光标偏移，更不回写输入内容。
    element.focus({ preventScroll: true });
    if (doc.activeElement !== element) return;
    if (
      isTextControl(element) && element.value === position.value &&
      position.start != null && position.end != null
    ) {
      element.setSelectionRange(position.start, position.end, position.direction ?? undefined);
    } else if (
      position.range && position.range.startContainer.isConnected &&
      position.range.endContainer.isConnected &&
      element.contains(position.range.startContainer) && element.contains(position.range.endContainer)
    ) {
      const selection = doc.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(position.range);
    }
  };

  // 原生获焦 IPC 可能早于 guest 的 DOM focus；后者只补齐同一次恢复。
  view.addEventListener("focus", restore);
  const abandon = (event: Event) => {
    if (event.isTrusted) saved = null;
  };
  view.addEventListener("pointerdown", abandon, true);
  view.addEventListener("keydown", abandon, true);

  return (focused) => {
    if (focused === hostFocused) return;
    hostFocused = focused;
    if (focused) {
      restore();
      return;
    }
    const element = doc.activeElement as HTMLElement | null;
    saved = null;
    if (element && isTextControl(element)) {
      saved = {
        element,
        value: element.value,
        start: element.selectionStart,
        end: element.selectionEnd,
        direction: element.selectionDirection,
      };
    } else if (element?.isContentEditable) {
      const selection = doc.getSelection();
      saved = { element };
      if (selection?.rangeCount && element.contains(selection.anchorNode) && element.contains(selection.focusNode)) {
        saved.range = selection.getRangeAt(0).cloneRange();
      }
    }
    element?.blur();
    // rc-trigger 等监听 pointerdown/mousedown 判定 clickoutside。目标为空白 body，
    // 不发送 click/键盘事件，以免触发按钮、关闭模态框或提交表单。
    const target = doc.body;
    target?.dispatchEvent(new view.PointerEvent("pointerdown", {
      bubbles: true, button: 0, clientX: -1, clientY: -1,
      pointerType: "mouse", isPrimary: true,
    }));
    target?.dispatchEvent(new view.MouseEvent("mousedown", {
      bubbles: true, button: 0, clientX: -1, clientY: -1,
    }));
  };
}
