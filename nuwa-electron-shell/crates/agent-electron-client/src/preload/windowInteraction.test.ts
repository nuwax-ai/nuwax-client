import { describe, expect, it, vi } from "vitest";
import { installWindowInteraction } from "./windowInteraction";

function fixture(tagName = "INPUT") {
  const listeners = new Map<string, (event: Event) => void>();
  const outsideEvents: Event[] = [];
  class MouseEvent extends Event {
    constructor(type: string, public options: MouseEventInit) { super(type, options); }
  }
  const body = { dispatchEvent: vi.fn((event: Event) => {
    outsideEvents.push(event);
    listeners.get(event.type)?.(event);
  }) };
  const doc = {
    body, documentElement: {}, activeElement: body as unknown,
    hasFocus: vi.fn(() => true), getSelection: vi.fn(),
  };
  const editor = {
    tagName, type: "text", value: "draft text", selectionStart: 2, selectionEnd: 5,
    selectionDirection: "backward", isConnected: true, isContentEditable: tagName === "DIV",
    disabled: false, readOnly: false, closest: vi.fn(() => null), contains: vi.fn(() => true),
    focus: vi.fn(() => { doc.activeElement = editor; }),
    blur: vi.fn(() => { doc.activeElement = body; }), setSelectionRange: vi.fn(),
  };
  doc.activeElement = editor;
  const view = {
    MouseEvent, PointerEvent: MouseEvent,
    addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
  };
  const update = installWindowInteraction(doc as unknown as Document, view as unknown as Window & typeof globalThis);
  return { doc, editor, update, outsideEvents, fire: (type: string, isTrusted = true) => listeners.get(type)?.({ isTrusted } as Event) };
}

describe("切窗清理与编辑焦点恢复", () => {
  it.each(["INPUT", "TEXTAREA"])("失焦收起浮层、释放 %s 焦点，切回保留文本及选区", (tag) => {
    const f = fixture(tag);
    f.update(false);
    f.update(false);
    expect(f.editor.blur).toHaveBeenCalledOnce();
    expect(f.outsideEvents.map((event) => event.type)).toEqual(["pointerdown", "mousedown"]);
    expect(f.outsideEvents.every((event) => event.bubbles)).toBe(true);
    f.update(true);
    f.fire("focus");
    expect(f.editor.focus.mock.calls).toEqual([[{ preventScroll: true }]]);
    expect(f.editor.setSelectionRange.mock.calls).toEqual([[2, 5, "backward"]]);
    expect(f.editor.value).toBe("draft text");
  });

  it("原生获焦早于 DOM 获焦时等待后者，内部失焦不会另存恢复目标", () => {
    const f = fixture();
    f.update(false);
    f.doc.hasFocus.mockReturnValue(false);
    f.update(true);
    expect(f.editor.focus).not.toHaveBeenCalled();
    f.doc.hasFocus.mockReturnValue(true);
    f.fire("focus");
    expect(f.editor.focus).toHaveBeenCalledOnce();
    f.fire("blur");
    f.fire("focus");
    expect(f.editor.focus).toHaveBeenCalledOnce();
  });

  it.each(["pointerdown", "keydown"])("新的用户 %s 放弃旧焦点，合成外部事件不会放弃", (type) => {
    const f = fixture();
    f.update(false);
    f.fire(type);
    f.update(true);
    expect(f.editor.focus).not.toHaveBeenCalled();
  });

  it.each(["removed", "disabled", "readonly", "inert", "other-focus"])("%s 时不抢焦点", (state) => {
    const f = fixture();
    f.update(false);
    if (state === "removed") f.editor.isConnected = false;
    if (state === "disabled") f.editor.disabled = true;
    if (state === "readonly") f.editor.readOnly = true;
    if (state === "inert") f.editor.closest.mockReturnValue({} as never);
    if (state === "other-focus") f.doc.activeElement = {};
    f.update(true);
    expect(f.editor.focus).not.toHaveBeenCalled();
  });

  it("文本在后台更新时不回写过期光标位置", () => {
    const f = fixture();
    f.update(false);
    f.editor.value = "new content";
    f.update(true);
    expect(f.editor.focus).toHaveBeenCalledOnce();
    expect(f.editor.setSelectionRange).not.toHaveBeenCalled();
    expect(f.editor.value).toBe("new content");
  });

  it("不会恢复临时按钮的 focus 或触发 click", () => {
    const f = fixture("BUTTON");
    f.update(false);
    f.update(true);
    expect(f.editor.blur).toHaveBeenCalledOnce();
    expect(f.editor.focus).not.toHaveBeenCalled();
    expect(f.outsideEvents.map((event) => event.type)).not.toContain("click");
  });

  it("富文本编辑器恢复仍位于原编辑器内的 Range", () => {
    const f = fixture("DIV");
    const range = { startContainer: { isConnected: true }, endContainer: { isConnected: true } };
    const selection = { rangeCount: 1, anchorNode: {}, focusNode: {}, getRangeAt: () => ({ cloneRange: () => range }), removeAllRanges: vi.fn(), addRange: vi.fn() };
    f.doc.getSelection.mockReturnValue(selection);
    f.update(false);
    f.update(true);
    expect(f.editor.focus).toHaveBeenCalledOnce();
    expect(selection.addRange).toHaveBeenCalledWith(range);
  });
});
