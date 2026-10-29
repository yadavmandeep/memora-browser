import { MemoraElement } from '../dom/node.js';
import type { MemoraPage } from '../engine/page.js';
import { elementsFromPoint, isFocusable, setTextValue } from './dom-compat.js';

// CDP Input domain on top of Memora's DOM: mouse events are hit-tested against the synthetic
// layout (see dom-compat.ts), keyboard/text input goes to document.activeElement.

interface MouseState {
  pressedTarget: MemoraElement | null;
  hoverTarget: MemoraElement | null;
}

const mouseStates: WeakMap<MemoraPage, MouseState> = new WeakMap();

function mouseState(page: MemoraPage): MouseState {
  let s = mouseStates.get(page);
  if (!s) {
    s = { pressedTarget: null, hoverTarget: null };
    mouseStates.set(page, s);
  }
  return s;
}

function pageEvent(page: MemoraPage, ctor: string, type: string, init: Record<string, any>): any {
  // Build the event in the page realm so handlers see a regular Event instance
  try {
    const C = page.sandbox.evaluateRaw(`globalThis.${ctor} || globalThis.Event`);
    if (typeof C === 'function') return new C(type, init);
  } catch {
    // fall through to a plain object
  }
  return { type, ...init, defaultPrevented: false };
}

function fire(page: MemoraPage, target: MemoraElement, ctor: string, type: string, init: Record<string, any> = {}): boolean {
  const event = pageEvent(page, ctor, type, { bubbles: true, cancelable: true, composed: true, ...init });
  try { (event as any).__pwTrustedSynthetic = true; } catch { /* frozen */ }
  return target.dispatchEvent(event);
}

const BUTTONS: Record<string, number> = { left: 0, middle: 1, right: 2, back: 3, forward: 4 };

function modifiers(mask: number = 0) {
  return { altKey: !!(mask & 1), ctrlKey: !!(mask & 2), metaKey: !!(mask & 4), shiftKey: !!(mask & 8) };
}

export async function dispatchMouseEvent(page: MemoraPage, params: any): Promise<void> {
  const state = mouseState(page);
  const x = Number(params.x) || 0;
  const y = Number(params.y) || 0;
  const target = elementsFromPoint(page.document, x, y)[0];
  if (!target) return;
  const init = {
    clientX: x, clientY: y, screenX: x, screenY: y,
    button: BUTTONS[params.button] ?? 0,
    buttons: params.buttons || 0,
    detail: params.clickCount || 0,
    ...modifiers(params.modifiers),
  };

  switch (params.type) {
    case 'mouseMoved': {
      if (state.hoverTarget !== target) {
        if (state.hoverTarget && state.hoverTarget.isConnected) fire(page, state.hoverTarget, 'MouseEvent', 'mouseout', init);
        state.hoverTarget = target;
        fire(page, target, 'MouseEvent', 'mouseover', init);
      }
      fire(page, target, 'PointerEvent', 'pointermove', init);
      fire(page, target, 'MouseEvent', 'mousemove', init);
      return;
    }
    case 'mousePressed': {
      state.pressedTarget = target;
      fire(page, target, 'PointerEvent', 'pointerdown', init);
      const notPrevented = fire(page, target, 'MouseEvent', 'mousedown', init);
      if (notPrevented) {
        let focusTarget: MemoraElement | null = target;
        while (focusTarget && focusTarget.nodeType === 1 && !isFocusable(focusTarget)) focusTarget = focusTarget.parentNode;
        const doc: any = page.document;
        if (focusTarget && focusTarget.nodeType === 1) focusTarget.focus();
        else if (doc.activeElement && doc.activeElement !== doc.body && typeof doc.activeElement.blur === 'function') doc.activeElement.blur();
      }
      return;
    }
    case 'mouseReleased': {
      fire(page, target, 'PointerEvent', 'pointerup', init);
      fire(page, target, 'MouseEvent', 'mouseup', init);
      const pressed = state.pressedTarget;
      state.pressedTarget = null;
      if (!pressed || (params.button && params.button !== 'left')) {
        if (params.button === 'right') fire(page, target, 'MouseEvent', 'contextmenu', init);
        return;
      }
      // click goes to the common ancestor of press and release targets
      let clickTarget: MemoraElement | null = pressed;
      while (clickTarget && !clickTarget.contains(target)) clickTarget = clickTarget.parentNode;
      if (!clickTarget || clickTarget.nodeType !== 1) return;
      if ((params.clickCount || 1) === 2) {
        await page.activate(clickTarget);
        if (clickTarget.isConnected) fire(page, clickTarget, 'MouseEvent', 'dblclick', { ...init, detail: 2 });
        return;
      }
      // Browser default actions: links, form submission, checkboxes, <option>s
      await page.activate(clickTarget);
      return;
    }
    case 'mouseWheel':
      fire(page, target, 'WheelEvent', 'wheel', { ...init, deltaX: params.deltaX || 0, deltaY: params.deltaY || 0 });
      return;
  }
}

function activeEditable(page: MemoraPage): MemoraElement | null {
  const el: any = (page.document as any).activeElement;
  if (!el || el.nodeType !== 1) return null;
  if (el.tagName === 'input' || el.tagName === 'textarea' || el.isContentEditable) return el;
  return null;
}

function currentText(el: MemoraElement): string {
  if (el.tagName === 'textarea' && !el.hasAttribute('value')) return el.textContent;
  if (el.tagName !== 'input' && el.tagName !== 'textarea') return el.textContent;
  return el.value;
}

function editText(page: MemoraPage, el: MemoraElement, replacement: string, mode: 'insert' | 'backspace' | 'delete'): void {
  const value = currentText(el);
  const anyEl = el as any;
  let start = Math.min(anyEl.__selStart ?? value.length, value.length);
  let end = Math.min(anyEl.__selEnd ?? value.length, value.length);
  if (start === end) {
    if (mode === 'backspace' && start > 0) start--;
    if (mode === 'delete' && end < value.length) end++;
  }
  const inputType = mode === 'insert' ? 'insertText' : mode === 'backspace' ? 'deleteContentBackward' : 'deleteContentForward';
  if (!fire(page, el, 'InputEvent', 'beforeinput', { data: mode === 'insert' ? replacement : null, inputType })) return;
  const next = value.slice(0, start) + replacement + value.slice(end);
  if (el.tagName === 'input' || el.tagName === 'textarea') setTextValue(el, next);
  else el.textContent = next;
  anyEl.__selStart = anyEl.__selEnd = start + replacement.length;
  fire(page, el, 'InputEvent', 'input', { data: mode === 'insert' ? replacement : null, inputType, cancelable: false });
}

export function insertText(page: MemoraPage, text: string): void {
  const el = activeEditable(page);
  if (el && text) editText(page, el, text, 'insert');
}

// Enter in a single-line input submits its form (implicit submission)
async function implicitSubmit(page: MemoraPage, input: MemoraElement): Promise<void> {
  const form = page.formOwner(input);
  if (!form) return;
  const submitter = form.querySelectorAll('button, input').find(b => {
    const t = (b.getAttribute('type') || '').toLowerCase();
    return (b.tagName === 'button' && (t === '' || t === 'submit')) || (b.tagName === 'input' && (t === 'submit' || t === 'image'));
  });
  if (submitter) {
    if (!submitter.hasAttribute('disabled')) await page.activate(submitter);
    return;
  }
  await page.submitForm(form);
}

export async function dispatchKeyEvent(page: MemoraPage, params: any): Promise<void> {
  const doc: any = page.document;
  const target: MemoraElement | null = doc.activeElement || doc.body;
  if (!target) return;
  const init = {
    key: params.key || '', code: params.code || '', location: params.location || 0,
    keyCode: params.windowsVirtualKeyCode || 0, repeat: !!params.autoRepeat,
    ...modifiers(params.modifiers),
  };
  if (params.type === 'keyUp') {
    fire(page, target, 'KeyboardEvent', 'keyup', init);
    return;
  }
  if (params.type === 'char') {
    if (params.text) insertText(page, params.text);
    return;
  }
  const notPrevented = fire(page, target, 'KeyboardEvent', 'keydown', init);
  if (!notPrevented) return;
  const editable = activeEditable(page);
  const key = params.key;
  const commands: string[] = params.commands || [];
  if (editable && (commands.includes('selectAll') || ((init.ctrlKey || init.metaKey) && (key === 'a' || key === 'A')))) {
    const anyEl = editable as any;
    anyEl.__selStart = 0;
    anyEl.__selEnd = currentText(editable).length;
    return;
  }
  if (key === 'Enter') {
    if (editable && editable.tagName === 'textarea') editText(page, editable, '\n', 'insert');
    else if (editable && editable.tagName === 'input') await implicitSubmit(page, editable);
    else if (target.tagName === 'a' || target.tagName === 'button') await page.activate(target);
    return;
  }
  if (key === 'Backspace' && editable) { editText(page, editable, '', 'backspace'); return; }
  if (key === 'Delete' && editable) { editText(page, editable, '', 'delete'); return; }
  if (key === ' ' && !editable && target.nodeType === 1 && (target.tagName === 'button' || target.tagName === 'input')) {
    await page.activate(target);
    return;
  }
  if (params.type === 'keyDown' && params.text && !(init.ctrlKey || init.metaKey)) {
    fire(page, target, 'KeyboardEvent', 'keypress', { ...init, charCode: params.text.charCodeAt(0) });
    if (editable) editText(page, editable, params.text, 'insert');
  }
}
