import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchViews,
  fetchReleaseRepositories,
  fetchReleaseJobs,
  fetchReleaseJob,
  fetchReleasePlan,
  prepareRelease,
} from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('release caller boundary', () => {
  it('uses only configured IDs and a fresh session CSRF proof for preparation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ username: 'operator', csrfToken: 'session-proof' }))
      .mockResolvedValueOnce(Response.json({ jobId: 'tracked-job' }));
    vi.stubGlobal('fetch', fetch);
    await expect(prepareRelease('repo / ?')).resolves.toEqual({ jobId: 'tracked-job' });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      'api/session',
      'api/releases/repositories/repo%20%2F%20%3F/prepare',
    ]);
    const init = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ accept: 'application/json', 'x-csrf-token': 'session-proof' });
    expect(init.body).toBeUndefined();
  });

  it('does not submit preparation without browser session proof', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ username: 'operator', csrfToken: null }));
    vi.stubGlobal('fetch', fetch);
    await expect(prepareRelease('app')).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads repositories, bounded history, job and plan without issuing a write', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', fetch);
    await fetchReleaseRepositories();
    await fetchReleaseJobs('repo/1');
    await fetchReleaseJob('job/1');
    await fetchReleasePlan('plan/1');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      'api/releases/repositories',
      'api/releases/repositories/repo%2F1/jobs?limit=25',
      'api/releases/jobs/job%2F1',
      'api/releases/plans/plan%2F1',
    ]);
    expect(fetch.mock.calls.every(([, init]) => init.method === undefined)).toBe(true);
  });
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
