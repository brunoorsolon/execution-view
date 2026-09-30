import { describe, expect, it } from 'vitest';
import {
  HttpError,
  createHttpClient,
  createLimiter,
  parseLinkHeader,
  sanitizeUrl,
  type FetchLike,
} from './http.js';

const BASE = 'https://api.example.test';
const TOKEN = 'ghp_SUPERSECRET123';

type Handler = (url: string, call: number) => Response | Error;

function fakeFetch(handler: Handler): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const r = handler(url, urls.length);
    if (r instanceof Error) throw r;
    return r;
  }) as FetchLike;
  return { fetch: fetchFn, urls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function setup(handler: Handler, extra: { now?: () => number; maxRetries?: number } = {}) {
  const sleeps: number[] = [];
  const { fetch, urls } = fakeFetch(handler);
  const client = createHttpClient({
    baseUrl: BASE + '/',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { client, sleeps, urls };
}

describe('parseLinkHeader', () => {
  it('parses next and last', () => {
    const m = parseLinkHeader(
      '<https://x.test/a?page=2&per_page=100>; rel="next", <https://x.test/a?page=5>; rel="last"',
    );
    expect(m.get('next')).toBe('https://x.test/a?page=2&per_page=100');
    expect(m.get('last')).toBe('https://x.test/a?page=5');
  });

  it('handles null, empty, unquoted rel and multi-rel', () => {
    expect(parseLinkHeader(null).size).toBe(0);
    expect(parseLinkHeader('').size).toBe(0);
    expect(parseLinkHeader('<https://x.test/n>; rel=next').get('next')).toBe('https://x.test/n');
    const m = parseLinkHeader('<https://x.test/n>; rel="next last"');
    expect(m.get('next')).toBe('https://x.test/n');
    expect(m.get('last')).toBe('https://x.test/n');
  });

  it('ignores links without rel and keeps commas inside URLs', () => {
    const m = parseLinkHeader('<https://x.test/skip>; title="t", <https://x.test/a,b>; rel="next"');
    expect(m.get('next')).toBe('https://x.test/a,b');
    expect(m.size).toBe(1);
  });
});

describe('sanitizeUrl', () => {
  it('drops query, fragment and credentials', () => {
    expect(sanitizeUrl('https://u:p@h.test/a/b?access_token=zzz#f')).toBe('https://h.test/a/b');
    expect(sanitizeUrl('/a/b?token=zzz')).toBe('/a/b');
  });
});

describe('createHttpClient.getJson', () => {
  it('returns data, headers and status, sending configured headers', async () => {
    let seenHeaders: unknown;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      seenHeaders = init?.headers;
      return json({ ok: true }, { headers: { 'x-a': '1' } });
    }) as unknown as FetchLike;
    const client = createHttpClient({
      baseUrl: BASE,
      headers: { Accept: 'application/json' },
      fetch: fetchFn,
    });
    const res = await client.getJson<{ ok: boolean }>('/x');
    expect(res.data).toEqual({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-a')).toBe('1');
    expect(seenHeaders).toEqual({ Accept: 'application/json' });
  });

  it('honours Retry-After on 429 and then succeeds', async () => {
    const { client, sleeps, urls } = setup((_u, n) =>
      n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : json([1]),
    );
    const res = await client.getJson<number[]>('/x');
    expect(res.data).toEqual([1]);
    expect(urls).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
  });

  it('caps Retry-After at 60 seconds', async () => {
    const { client, sleeps } = setup((_u, n) =>
      n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '3600' } }) : json({}),
    );
    await client.getJson('/x');
    expect(sleeps).toEqual([60_000]);
  });

  it('uses exponential backoff 500, 1000, 2000 and throws after 3 retries on 5xx', async () => {
    const { client, sleeps, urls } = setup(() => new Response('boom', { status: 503 }));
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect(urls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect((err as HttpError).message).toContain('GET https://api.example.test/x');
    expect((err as HttpError).message).toContain('503');
  });

  it('caps backoff at 10 seconds', async () => {
    const { client, sleeps } = setup(() => new Response('', { status: 502 }), { maxRetries: 8 });
    await client.getJson('/x').catch(() => undefined);
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it('retries network errors (TypeError) and recovers', async () => {
    const { client, sleeps } = setup((_u, n) =>
      n < 3 ? new TypeError('fetch failed') : json([2]),
    );
    const res = await client.getJson<number[]>('/x');
    expect(res.data).toEqual([2]);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('throws HttpError with status 0 when network errors persist, without the token', async () => {
    const { client } = setup(
      () => new TypeError(`fetch failed for Bearer ${TOKEN}`, { cause: new Error(TOKEN) }),
    );
    const err = await client.getJson('/x?access_token=abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
    expect((err as HttpError).message).not.toContain(TOKEN);
    expect((err as HttpError).message).not.toContain('access_token');
  });

  it('does not retry other errors (404) and never leaks token or query in the message', async () => {
    const { client, urls } = setup(() => new Response('nope', { status: 404 }));
    const err = await client.getJson('/repos/a/b?token=querysecret').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const e = err as HttpError;
    expect(e.status).toBe(404);
    expect(urls).toHaveLength(1);
    expect(e.message).toBe('GET https://api.example.test/repos/a/b failed with status 404');
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain('querysecret');
    expect(e.url).toBe('https://api.example.test/repos/a/b');
    expect(String(e.stack)).not.toContain(TOKEN);
  });

  it('waits for the rate-limit reset on 403 when it is close', async () => {
    const nowMs = 1_700_000_000_000;
    const reset = String(nowMs / 1000 + 30);
    const { client, sleeps } = setup(
      (_u, n) =>
        n === 1
          ? new Response('', {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
            })
          : json({ ok: 1 }),
      { now: () => nowMs },
    );
    await client.getJson('/x');
    expect(sleeps).toEqual([31_000]);
  });

  it('throws a clear rate-limit error when the reset is too far away', async () => {
    const nowMs = 1_700_000_000_000;
    const reset = String(nowMs / 1000 + 3600);
    const { client, sleeps, urls } = setup(
      () =>
        new Response('', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
        }),
      { now: () => nowMs },
    );
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toMatch(/rate limit exceeded/);
    expect(sleeps).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it('does not retry a plain 403', async () => {
    const { client, sleeps, urls } = setup(() => new Response('', { status: 403 }));
    const err = await client.getJson('/x').catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(403);
    expect(urls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('refuses absolute URLs on another origin (no credential leak)', async () => {
    const { client, urls } = setup(() => json([]));
    await expect(client.getJson('https://evil.test/steal?x=1')).rejects.toThrow(/origin differs/);
    expect(urls).toHaveLength(0);
  });

  it('throws HttpError on invalid JSON', async () => {
    const { client } = setup(() => new Response('<html>', { status: 200 }));
    await expect(client.getJson('/x')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('createHttpClient.getPaginatedLink', () => {
  it('follows Link rel="next" across pages', async () => {
    const { client, urls } = setup((url) => {
      if (url.endsWith('/list?per_page=2')) {
        return json([1, 2], { headers: { link: `<${BASE}/list?per_page=2&page=2>; rel="next"` } });
      }
      if (url.endsWith('page=2')) {
        return json([3, 4], { headers: { link: `<${BASE}/list?per_page=2&page=3>; rel="next"` } });
      }
      return json([5]);
    });
    expect(await client.getPaginatedLink<number>('/list?per_page=2')).toEqual([1, 2, 3, 4, 5]);
    expect(urls).toHaveLength(3);
  });

  it('rejects a non-array body and a pagination loop', async () => {
    const a = setup(() => json({ nope: true }));
    await expect(a.client.getPaginatedLink('/x')).rejects.toBeInstanceOf(HttpError);
    const b = setup(() => json([1], { headers: { link: `<${BASE}/x>; rel="next"` } }));
    await expect(b.client.getPaginatedLink('/x')).rejects.toThrow(/did not terminate/);
  });
});

describe('createLimiter', () => {
  it('never runs more than N calls at once and preserves results', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('keeps going after a rejection and rejects invalid concurrency', async () => {
    const limit = createLimiter(1);
    const bad = limit(() => Promise.reject(new Error('x')));
    const good = limit(async () => 'ok');
    await expect(bad).rejects.toThrow('x');
    await expect(good).resolves.toBe('ok');
    await expect(
      limit(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(() => createLimiter(0)).toThrow();
  });
});
