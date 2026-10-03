/**
 * Per-browser UI preferences, stored in localStorage (a convenience; it may be
 * unavailable). The colour theme's "system" follows `prefers-color-scheme`;
 * "light" and "dark" set `data-theme` on <html>, which the stylesheet's tokens
 * key on. The graph line mode picks which lines the graph draws.
 */

import type { LineMode } from './graph-model.js';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'execution-view:theme';
const LINES_KEY = 'execution-view:lines';

export function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

export function saveTheme(pref: ThemePref): void {
  applyTheme(pref);
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

export function loadLineMode(): LineMode {
  try {
    const v = localStorage.getItem(LINES_KEY);
    return v === 'selected' || v === 'all' ? v : 'dependencies';
  } catch {
    return 'dependencies';
  }
}

export function saveLineMode(mode: LineMode): void {
  try {
    localStorage.setItem(LINES_KEY, mode);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}
