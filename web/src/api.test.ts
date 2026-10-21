import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchViews } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('network failures', () => {
  it('names Forge Desk when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const error: unknown = await fetchViews().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(
      'Network error: could not reach the Forge Desk server.',
    );
  });
});
