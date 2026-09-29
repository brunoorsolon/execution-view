/**
 * Tiny DOM helpers. Text is only ever attached as text nodes or via
 * setAttribute, never as HTML, so issue data cannot inject markup.
 */

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

/** Inline SVG icon from a path (24x24 viewBox, stroke style). */
export function icon(pathD: string, size = 14): SVGSVGElement {
  const s = svg('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    class: 'icon',
  });
  s.append(svg('path', { d: pathD }));
  return s;
}

export const ICONS = {
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M4 20h16',
  chevron: 'm6 9 6 6 6-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  graph:
    'M5 6a2 2 0 1 0 0 .01M19 6a2 2 0 1 0 0 .01M12 18a2 2 0 1 0 0 .01M6.5 7.5 11 16M17.5 7.5 13 16',
  close: 'M6 6l12 12M18 6 6 18',
  fit: 'M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  alert:
    'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
} as const;
