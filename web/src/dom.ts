/**
 * Tiny DOM helpers. Text is only ever attached as text nodes or via
 * setAttribute, never as HTML, so issue data cannot inject markup.
 */

import { ICON_PATHS, type IconName } from './icons.js';

export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  /** Event handlers: `onclick`, `oninput`, ... */
  [key: string]: unknown;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(el: Element, props: Props | null | undefined): void {
  if (!props) return;
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') {
      el.setAttribute('class', String(value));
    } else if (name.startsWith('on') && typeof value === 'function') {
      el.addEventListener(name.slice(2), value as EventListener);
    } else if (value === true) {
      el.setAttribute(name, '');
    } else {
      el.setAttribute(name, String(value));
    }
  }
}

export function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(
      typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c,
    );
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Inline Phosphor icon (see icons.ts), coloured with `currentColor`. */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const s = svg('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'currentColor',
    'aria-hidden': 'true',
    class: 'icon',
  });
  s.append(svg('path', { d: ICON_PATHS[name] }));
  return s;
}
