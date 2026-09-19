import { useEffect, useRef } from 'react';

/**
 * 键盘流基础设施。
 *
 * 键盘是这套界面的主输入方式，不是"也支持快捷键"那种点缀 ——
 * 熟练后卖一笔货应在 3 秒内录完，全程不碰鼠标（docs/04）。
 *
 * 两条纪律：
 *
 * 1. **在输入框里也要响应功能键。** F1–F9 不是打字内容，老板手停在
 *    数量框上时按 F8 必须直接结账。但 Esc 之外的普通键要让给输入框。
 *
 * 2. **数字键直选只在搜索框为空时生效**，否则输商品数量会误触发。
 */

export type HotkeyHandler = (event: KeyboardEvent) => void;

const FUNCTION_KEY = /^F\d{1,2}$/;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export interface HotkeyOptions {
  /** 在输入框里也触发。功能键默认 true，其余默认 false */
  whileTyping?: boolean;
  enabled?: boolean;
}

/**
 * 绑一个快捷键。key 用 KeyboardEvent.key 的值：'F8'、'Escape'、'Enter'、'1'。
 */
export function useHotkey(key: string, handler: HotkeyHandler, options: HotkeyOptions = {}): void {
  const saved = useRef(handler);
  saved.current = handler;

  const { enabled = true } = options;
  const whileTyping = options.whileTyping ?? FUNCTION_KEY.test(key);

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== key) return;
      // 带修饰键的不算 —— Ctrl+F 是浏览器查找，别抢
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (!whileTyping && isTypingTarget(event.target)) return;

      // 功能键的默认行为（F1 帮助、F3 查找…）必须挡掉，否则会弹出浏览器面板
      if (FUNCTION_KEY.test(key)) event.preventDefault();

      saved.current(event);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, whileTyping, enabled]);
}

/** 一次绑一组：{ F1: fn, Escape: fn } */
export function useHotkeys(map: Record<string, HotkeyHandler>, options: HotkeyOptions = {}): void {
  const saved = useRef(map);
  saved.current = map;

  const { enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      const handler = saved.current[event.key];
      if (!handler) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      const isFn = FUNCTION_KEY.test(event.key);
      const whileTyping = options.whileTyping ?? isFn;
      if (!whileTyping && isTypingTarget(event.target)) return;

      if (isFn) event.preventDefault();
      handler(event);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, options.whileTyping]);
}

/**
 * 把焦点送回某个元素。
 *
 * 卖货页的节奏是「搜索 → 回车 → 数量 → 回车 → 焦点自动回搜索框」，
 * 焦点回不去，键盘流就断了。
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
