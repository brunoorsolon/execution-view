import { describe, expect, it } from 'vitest';
import { createGitHubProvider } from './github.js';
import { HttpError, type FetchLike } from './http.js';

const API = 'https://api.github.com';
const TOKEN = 'ghp_TOPSECRETTOKEN';
const REPO = { owner: 'acme', repo: 'api' };

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

type Route = (url: URL, call: number) => Response | undefined;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response('', { status: code, headers });
}

function makeFetch(route: Route) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const res = route(new URL(url), calls.length);
    if (!res) return status(404);
    return res;
  }) as FetchLike;
  return { fetch: fetchFn, calls };
}

function ghIssue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    html_url: `https://github.com/acme/api/issues/${number}`,
    body: null,
    labels: [],
    assignees: [],
    milestone: null,
    repository_url: `${API}/repos/acme/api`,
    ...extra,
  };
}

function provider(route: Route, extra: { token?: string | null; concurrency?: number } = {}) {
  const { fetch, calls } = makeFetch(route);
  const sleeps: number[] = [];
  const p = createGitHubProvider({
    token: 'token' in extra ? (extra.token ?? null) : TOKEN,
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(extra.concurrency ? { concurrency: extra.concurrency } : {}),
  });
  return { p, calls, sleeps };
}

const NONE = { native: false, subIssues: false };
const isDeps = (c: Recorded) => c.url.includes('/dependencies/blocked_by');
const isSubs = (c: Recorded) => c.url.includes('/sub_issues');

describe('listOpenIssues: listing', () => {
  it('paginates across 3 pages via Link headers and sorts by number', async () => {
    const { p, calls } = provider((url) => {
      if (url.pathname !== '/repos/acme/api/issues') return undefined;
      const page = url.searchParams.get('page') ?? '1';
      const next = (n: number) =>
        `<${API}/repos/acme/api/issues?state=open&per_page=100&page=${n}>`;
      if (page === '1')
        return json([ghIssue(9), ghIssue(3)], { headers: { link: `${next(2)}; rel="next"` } });
      if (page === '2')
        return json([ghIssue(7)], {
          headers: { link: `${next(3)}; rel="next", ${next(3)}; rel="last"` },
        });
      return json([ghIssue(1)]);
    });
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res.issues.map((i) => i.number)).toEqual([1, 3, 7, 9]);
    expect(res.warnings).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe(`${API}/repos/acme/api/issues?state=open&per_page=100`);
  });

  it('filters out pull requests', async () => {
    const { p } = provider(() =>
      json([ghIssue(1), ghIssue(2, { pull_request: { url: 'x' } }), ghIssue(3)]),
    );
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res.issues.map((i) => i.number)).toEqual([1, 3]);
  });

  it('maps and normalizes fields', async () => {
    const { p } = provider(() =>
      json([
        ghIssue(5, {
          title: 'Hello',
          body: 'text body',
          html_url: 'https://ghe.example.com/Acme/API/issues/5',
          labels: ['zeta', { name: 'alpha' }, { name: 'zeta' }, { name: 'P1' }, { color: 'x' }],
          assignees: [{ login: 'bob' }, { login: 'alice' }, { login: 'bob' }],
          milestone: { title: 'v1', number: 2 },
        }),
        ghIssue(6),
      ]),
    );
    const res = await p.listOpenIssues({ owner: 'Acme', repo: 'API' }, NONE);
    expect(res.issues[0]).toEqual({
      key: 'acme/api#5',
      repo: { owner: 'acme', repo: 'api' },
      number: 5,
      title: 'Hello',
      state: 'open',
      url: 'https://ghe.example.com/Acme/API/issues/5',
      body: 'text body',
      labels: ['P1', 'alpha', 'zeta'],
      assignees: ['alice', 'bob'],
      milestone: 'v1',
      nativeRelations: [],
    });
    expect(res.issues[1]).toMatchObject({ body: '', labels: [], assignees: [], milestone: null });
  });

  it('sends the GitHub headers and Bearer token', async () => {
    const { p, calls } = provider(() => json([]));
    await p.listOpenIssues(REPO, NONE);
    expect(calls[0]!.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'execution-view',
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it('omits Authorization when the token is null', async () => {
    const { p, calls } = provider(() => json([]), { token: null });
    await p.listOpenIssues(REPO, NONE);
    expect(Object.keys(calls[0]!.headers).map((k) => k.toLowerCase())).not.toContain(
      'authorization',
    );
    expect(calls[0]!.headers['Accept']).toBe('application/vnd.github+json');
  });

  it('uses a custom baseUrl (GHES)', async () => {
    const { fetch, calls } = makeFetch(() => json([]));
    const p = createGitHubProvider({
      baseUrl: 'https://ghe.example.com/api/v3/',
      token: null,
      fetch,
    });
    await p.listOpenIssues(REPO, NONE);
    expect(calls[0]!.url).toBe(
      'https://ghe.example.com/api/v3/repos/acme/api/issues?state=open&per_page=100',
    );
  });
});

describe('listOpenIssues: native dependencies', () => {
  it('fetches only where the summary says > 0 or is absent', async () => {
    const { p, calls } = provider((url) => {
      if (url.pathname === '/repos/acme/api/issues') {
        return json([
          ghIssue(1, { issue_dependencies_summary: { total_blocked_by: 0, total_blocking: 2 } }),
          ghIssue(2, { issue_dependencies_summary: { total_blocked_by: 1 } }),
          ghIssue(3), // summary absent
        ]);
      }
      if (url.pathname === '/repos/acme/api/issues/2/dependencies/blocked_by') {
        return json([ghIssue(1)]);
      }
      if (url.pathname === '/repos/acme/api/issues/3/dependencies/blocked_by') {
        return json([]);
      }
      return undefined;
    });
    const res = await p.listOpenIssues(REPO, { native: true, subIssues: false });
    const depCalls = calls.filter(isDeps).map((c) => new URL(c.url).pathname);
    expect(depCalls.sort()).toEqual([
      '/repos/acme/api/issues/2/dependencies/blocked_by',
      '/repos/acme/api/issues/3/dependencies/blocked_by',
    ]);
    expect(calls.filter(isDeps)[0]!.url).toContain('per_page=100');
    expect(res.issues[0]!.nativeRelations).toEqual([]);
    expect(res.issues[1]!.nativeRelations).toEqual([
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 1 }, source: 'native' },
    ]);
    expect(res.issues[2]!.nativeRelations).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('does not call dependencies at all when native is off', async () => {
    const { p, calls } = provider(() => json([ghIssue(1)]));
    await p.listOpenIssues(REPO, NONE);
    expect(calls.filter(isDeps)).toHaveLength(0);
  });

  it('handles cross-repo blockers, missing repository_url, pagination, sorting and dedupe', async () => {
    const { p } = provider((url) => {
      if (url.pathname === '/repos/acme/api/issues') return json([ghIssue(1)]);
      if (url.pathname === '/repos/acme/api/issues/1/dependencies/blocked_by') {
        if (url.searchParams.get('page') === '2') {
          return json([
            { number: 8, repository_url: `${API}/repos/Acme/API` },
            { number: 8, repository_url: `${API}/repos/acme/api` }, // duplicate
          ]);
        }
        return json(
          [
            { number: 12, repository_url: `${API}/repos/Other/Lib` },
            { number: 4 }, // no repository_url: the listed repo
          ],
          { headers: { link: `<${API}${url.pathname}?per_page=100&page=2>; rel="next"` } },
        );
      }
      return undefined;
    });
    const res = await p.listOpenIssues(REPO, { native: true, subIssues: false });
    expect(res.issues[0]!.nativeRelations).toEqual([
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 4 }, source: 'native' },
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 8 }, source: 'native' },
      { kind: 'blocked-by', ref: { owner: 'other', repo: 'lib', number: 12 }, source: 'native' },
    ]);
  });

  it('a 404 on dependencies gives exactly one warning and no further dependency calls', async () => {
    const { p, calls } = provider((url) => {
      if (url.pathname === '/repos/acme/api/issues') {
        return json(Array.from({ length: 10 }, (_, i) => ghIssue(i + 1)));
      }
      return undefined; // 404 for everything else
    });
    const res = await p.listOpenIssues(REPO, { native: true, subIssues: false });
    expect(calls.filter(isDeps)).toHaveLength(1);
    expect(new URL(calls.filter(isDeps)[0]!.url).pathname).toContain('/issues/1/');
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatchObject({ code: 'native-unsupported', issues: [] });
    expect(res.warnings[0]!.message).toContain('acme/api');
    expect(res.warnings[0]!.message).toContain('GitHub Enterprise Server');
    expect(res.issues).toHaveLength(10);
    expect(res.issues.every((i) => i.nativeRelations.length === 0)).toBe(true);
  });

  it('propagates non-404 errors from the dependencies endpoint', async () => {
    const { p } = provider((url) =>
      url.pathname === '/repos/acme/api/issues' ? json([ghIssue(1)]) : status(500),
    );
    const err = await p.listOpenIssues(REPO, { native: true, subIssues: false }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
  });

  it('never exceeds the concurrency limit for relation requests', async () => {
    let active = 0;
    let peak = 0;
    const listing = Array.from({ length: 15 }, (_, i) => ghIssue(i + 1));
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/acme/api/issues') return json(listing);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return json([]);
    }) as FetchLike;
    const p = createGitHubProvider({ token: null, fetch: fetchFn, concurrency: 3 });
    await p.listOpenIssues(REPO, { native: true, subIssues: false });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('listOpenIssues: sub-issues', () => {
  const route: Route = (url) => {
    if (url.pathname === '/repos/acme/api/issues') {
      return json([
        ghIssue(1, { sub_issues_summary: { total: 2, completed: 0, percent_completed: 0 } }),
        ghIssue(2, { sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 } }),
        ghIssue(3),
      ]);
    }
    if (url.pathname === '/repos/acme/api/issues/1/sub_issues') {
      return json([ghIssue(2), { number: 40, repository_url: `${API}/repos/acme/web` }]);
    }
    if (url.pathname === '/repos/acme/api/issues/3/sub_issues') return json([]);
    return undefined;
  };

  it('adds sub-issue blocked-by relations on the parent when enabled', async () => {
    const { p, calls } = provider(route);
    const res = await p.listOpenIssues(REPO, { native: false, subIssues: true });
    expect(
      calls
        .filter(isSubs)
        .map((c) => new URL(c.url).pathname)
        .sort(),
    ).toEqual(['/repos/acme/api/issues/1/sub_issues', '/repos/acme/api/issues/3/sub_issues']);
    expect(calls.filter(isDeps)).toHaveLength(0);
    expect(res.issues[0]!.nativeRelations).toEqual([
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 2 }, source: 'sub-issue' },
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'web', number: 40 }, source: 'sub-issue' },
    ]);
    expect(res.issues[1]!.nativeRelations).toEqual([]);
  });

  it('makes no sub-issue calls when disabled', async () => {
    const { p, calls } = provider(route);
    const res = await p.listOpenIssues(REPO, NONE);
    expect(calls.filter(isSubs)).toHaveLength(0);
    expect(res.issues.every((i) => i.nativeRelations.length === 0)).toBe(true);
  });

  it('combines native and sub-issue relations, sorted by (kind, ref, source)', async () => {
    const { p } = provider((url) => {
      if (url.pathname === '/repos/acme/api/issues') return json([ghIssue(1), ghIssue(2)]);
      if (url.pathname === '/repos/acme/api/issues/1/dependencies/blocked_by')
        return json([ghIssue(2)]);
      if (url.pathname === '/repos/acme/api/issues/1/sub_issues')
        return json([ghIssue(2), ghIssue(3)]);
      return json([]);
    });
    const res = await p.listOpenIssues(REPO, { native: true, subIssues: true });
    expect(res.issues[0]!.nativeRelations).toEqual([
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 2 }, source: 'native' },
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 2 }, source: 'sub-issue' },
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 3 }, source: 'sub-issue' },
    ]);
  });

  it('a 404 on sub_issues gives one native-unsupported warning and stops', async () => {
    const { p, calls } = provider((url) => {
      if (url.pathname === '/repos/acme/api/issues') {
        return json([ghIssue(1), ghIssue(2), ghIssue(3)]);
      }
      return undefined;
    });
    const res = await p.listOpenIssues(REPO, { native: false, subIssues: true });
    expect(calls.filter(isSubs)).toHaveLength(1);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatchObject({ code: 'native-unsupported', issues: [] });
    expect(res.warnings[0]!.message).toContain('acme/api');
    expect(res.warnings[0]!.message).toContain('ub-issues');
  });

  it('native 404 does not prevent sub-issues from being fetched', async () => {
    const { p } = provider((url) => {
      if (url.pathname === '/repos/acme/api/issues') return json([ghIssue(1)]);
      if (url.pathname === '/repos/acme/api/issues/1/sub_issues') return json([ghIssue(2)]);
      return undefined;
    });
    const res = await p.listOpenIssues(REPO, { native: true, subIssues: true });
    expect(res.warnings).toHaveLength(1);
    expect(res.issues[0]!.nativeRelations).toEqual([
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 2 }, source: 'sub-issue' },
    ]);
  });
});

describe('getIssue', () => {
  it('maps a single issue in any state, with empty nativeRelations and no extra calls', async () => {
    const { p, calls } = provider((url) =>
      url.pathname === '/repos/acme/api/issues/7'
        ? json(ghIssue(7, { state: 'closed', labels: [{ name: 'b' }, { name: 'a' }] }))
        : undefined,
    );
    const issue = await p.getIssue({ owner: 'ACME', repo: 'api' }, 7);
    expect(issue).toMatchObject({
      key: 'acme/api#7',
      state: 'closed',
      labels: ['a', 'b'],
      nativeRelations: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/repos/acme/api/issues/7`);
  });

  it('returns null on 404, 410 and pull requests', async () => {
    const { p } = provider((url) => {
      if (url.pathname.endsWith('/1')) return status(404);
      if (url.pathname.endsWith('/2')) return status(410);
      if (url.pathname.endsWith('/3')) return json(ghIssue(3, { pull_request: { url: 'x' } }));
      return undefined;
    });
    expect(await p.getIssue(REPO, 1)).toBeNull();
    expect(await p.getIssue(REPO, 2)).toBeNull();
    expect(await p.getIssue(REPO, 3)).toBeNull();
  });

  it('throws on other errors', async () => {
    const { p } = provider(() => status(401));
    await expect(p.getIssue(REPO, 1)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('retries and error hygiene', () => {
  it('retries a 429 with Retry-After and then succeeds', async () => {
    const { p, sleeps, calls } = provider((_url, n) =>
      n === 1 ? status(429, { 'retry-after': '3' }) : json([ghIssue(1)]),
    );
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res.issues).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it('throws HttpError when 5xx retries are exhausted, without leaking the token', async () => {
    const { p, calls, sleeps } = provider(() => status(502));
    const err = await p.listOpenIssues(REPO, NONE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect((err as HttpError).message).not.toContain(TOKEN);
    expect((err as HttpError).url).not.toContain(TOKEN);
    expect(String((err as HttpError).stack)).not.toContain(TOKEN);
  });

  it('keeps the token out of network error messages', async () => {
    const fetchFn = (async () => {
      throw new TypeError(`fetch failed (Authorization: Bearer ${TOKEN})`);
    }) as unknown as FetchLike;
    const p = createGitHubProvider({ token: TOKEN, fetch: fetchFn, sleep: async () => {} });
    const err = await p.getIssue(REPO, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).not.toContain(TOKEN);
  });

  it('keeps the token out of a 404 HttpError from a dependencies call', async () => {
    const { p } = provider((url) =>
      url.pathname === '/repos/acme/api/issues' ? json([ghIssue(1)]) : status(500),
    );
    const err = await p.listOpenIssues(REPO, { native: true, subIssues: false }).catch((e) => e);
    expect((err as HttpError).message).not.toContain(TOKEN);
  });
});
