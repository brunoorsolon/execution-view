import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLineMode, loadTheme } from './theme.js';

function stubStorage(entries: Record<string, string>): Map<string, string> {
  const store = new Map(Object.entries(entries));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preferences saved before the Forge Desk rename', () => {
  it('keep the theme and line mode and move them to the new keys', () => {
    const store = stubStorage({ 'execution-view:theme': 'dark', 'execution-view:lines': 'all' });

    expect(loadTheme()).toBe('dark');
    expect(loadLineMode()).toBe('all');
    expect(Object.fromEntries(store)).toEqual({
      'forge-desk:theme': 'dark',
      'forge-desk:lines': 'all',
    });
  });

  it('lose to a value already saved under the new key', () => {
    stubStorage({ 'forge-desk:theme': 'light', 'execution-view:theme': 'dark' });

    expect(loadTheme()).toBe('light');
  });
});
