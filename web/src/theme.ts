/**
 * Per-browser UI preferences, stored in localStorage (a convenience; it may be
 * unavailable). The colour theme's "system" follows `prefers-color-scheme`;
 * "light" and "dark" set `data-theme` on <html>, which the stylesheet's tokens
 * key on. The graph line mode picks which lines the graph draws.
 */

import type { LineMode } from './graph-model.js';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'forge-desk:theme';
const LINES_KEY = 'forge-desk:lines';
// Keys from before the Forge Desk rename. Remove them, and the fallback in the login page, in the
// major release that moves the image path, with the `execution-view` CLI alias.
const LEGACY_KEY = 'execution-view:theme';
const LEGACY_LINES_KEY = 'execution-view:lines';

/** Reads a preference, moving a value saved under its pre-rename key to the new key. */
function read(key: string, legacyKey: string): string | null {
  const v = localStorage.getItem(key);
  if (v !== null) return v;
  const old = localStorage.getItem(legacyKey);
  if (old !== null) {
    try {
      localStorage.setItem(key, old);
      localStorage.removeItem(legacyKey);
    } catch {
      // storage full: keep the old key and its value; the move runs again on the next read
    }
  }
  return old;
}

export function loadTheme(): ThemePref {
  try {
    const v = read(KEY, LEGACY_KEY);
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
    // The new choice replaces a pre-rename value, which would otherwise come back on reload.
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

export function loadLineMode(): LineMode {
  try {
    const v = read(LINES_KEY, LEGACY_LINES_KEY);
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
