import { describe, expect, it } from 'vitest';
import { createGiteaProvider } from './gitea.js';
import { HttpError, type FetchLike } from './http.js';

const ROOT = 'https://gitea.example.com';
const API = `${ROOT}/api/v1`;
const TOKEN = 'gt_TOPSECRETTOKEN';
const REPO = { owner: 'acme', repo: 'api' };
const ISSUES_PATH = '/api/v1/repos/acme/api/issues';

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

function gtIssue(number: number, extra: Record<string, unknown> = {}) {
  return {
    id: 1000 + number,
    number,
    title: `Issue ${number}`,
    state: 'open',
    html_url: `${ROOT}/acme/api/issues/${number}`,
    body: '',
    labels: [],
    assignees: null,
    milestone: null,
    pull_request: null,
    repository: { id: 1, name: 'api', owner: 'acme', full_name: 'acme/api' },
    ...extra,
  };
}

function range(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => gtIssue(from + i));
}

function provider(route: Route, extra: { token?: string | null; concurrency?: number } = {}) {
  const { fetch, calls } = makeFetch(route);
  const sleeps: number[] = [];
  const p = createGiteaProvider({
    baseUrl: ROOT,
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
const NATIVE = { native: true, subIssues: false };
const isDeps = (c: Recorded) => c.url.includes('/dependencies');

describe('listOpenIssues: listing', () => {
  it('paginates over 3 pages (50, 50, 7) and stops on the short page', async () => {
    const { p, calls } = provider((url) => {
      if (url.pathname !== ISSUES_PATH) return undefined;
      const page = url.searchParams.get('page');
      if (page === '1') return json(range(1, 50));
      if (page === '2') return json(range(51, 50));
      if (page === '3') return json(range(101, 7));
      return undefined;
    });
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res.issues).toHaveLength(107);
    expect(res.issues.map((i) => i.number).slice(0, 3)).toEqual([1, 2, 3]);
    expect(res.issues[106]!.number).toBe(107);
    expect(res.warnings).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/repos/acme/api/issues?state=open&type=issues&limit=50&page=1`,
      `${API}/repos/acme/api/issues?state=open&type=issues&limit=50&page=2`,
      `${API}/repos/acme/api/issues?state=open&type=issues&limit=50&page=3`,
    ]);
  });

  it('after exactly one full page, requests a second page and stops on the empty one', async () => {
    const { p, calls } = provider((url) =>
      url.searchParams.get('page') === '1' ? json(range(1, 50)) : json([]),
    );
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res.issues).toHaveLength(50);
    expect(calls).toHaveLength(2);
  });

  it('makes a single request for an empty repository', async () => {
    const { p, calls } = provider(() => json([]));
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res).toEqual({ issues: [], warnings: [] });
    expect(calls).toHaveLength(1);
  });

  it('stops after 1000 pages instead of looping forever', async () => {
    const full = range(1, 50);
    const { p, calls } = provider(() => json(full));
    const err = await p.listOpenIssues(REPO, NONE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toContain('pagination did not terminate');
    expect(calls).toHaveLength(1000);
  });

  it('filters out pull requests', async () => {
    const { p } = provider(() =>
      json([gtIssue(1), gtIssue(2, { pull_request: { merged: false } }), gtIssue(3)]),
    );
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res.issues.map((i) => i.number)).toEqual([1, 3]);
  });

  it('pages on the raw item count even when a full page is all pull requests', async () => {
    const page1 = range(1, 50).map((i) => ({ ...i, pull_request: { merged: true } }));
    const { p, calls } = provider((url) =>
      url.searchParams.get('page') === '1' ? json(page1) : json([gtIssue(60)]),
    );
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res.issues.map((i) => i.number)).toEqual([60]);
    expect(calls).toHaveLength(2);
  });

  it('maps fields: number (not id), sorted unique labels and assignees, milestone', async () => {
    const { p } = provider(() =>
      json([
        gtIssue(9),
        gtIssue(5, {
          id: 424242,
          title: 'Hello',
          body: 'text body',
          html_url: `${ROOT}/Acme/API/issues/5`,
          labels: [{ name: 'zeta' }, { name: 'alpha' }, { name: 'zeta' }, { name: 'P1' }],
          assignees: [{ login: 'bob' }, { login: 'alice' }, { login: 'bob' }],
          milestone: { id: 3, title: 'v1' },
        }),
      ]),
    );
    const res = await p.listOpenIssues({ owner: 'Acme', repo: 'API' }, NONE);
    expect(res.issues.map((i) => i.number)).toEqual([5, 9]);
    expect(res.issues[0]).toEqual({
      key: 'acme/api#5',
      repo: { owner: 'acme', repo: 'api' },
      number: 5,
      title: 'Hello',
      state: 'open',
      url: `${ROOT}/Acme/API/issues/5`,
      body: 'text body',
      labels: ['P1', 'alpha', 'zeta'],
      assignees: ['alice', 'bob'],
      milestone: 'v1',
      nativeRelations: [],
    });
  });

  it('handles null assignees, null milestone, null body and null labels', async () => {
    const { p } = provider(() =>
      json([gtIssue(1, { assignees: null, milestone: null, body: null, labels: null })]),
    );
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res.issues[0]).toMatchObject({
      body: '',
      labels: [],
      assignees: [],
      milestone: null,
      url: `${ROOT}/acme/api/issues/1`,
    });
  });

  it('throws on a non-array body', async () => {
    const { p } = provider(() => json({ message: 'nope' }));
    await expect(p.listOpenIssues(REPO, NONE)).rejects.toBeInstanceOf(HttpError);
  });

  it('ignores options.subIssues', async () => {
    const { p, calls } = provider(() => json([gtIssue(1)]));
    await p.listOpenIssues(REPO, { native: false, subIssues: true });
    expect(calls).toHaveLength(1);
  });
});

describe('request construction', () => {
  it('sends Accept, User-Agent and `Authorization: token X`', async () => {
    const { p, calls } = provider(() => json([]));
    await p.listOpenIssues(REPO, NONE);
    expect(calls[0]!.headers).toMatchObject({
      Accept: 'application/json',
      'User-Agent': 'execution-view',
      Authorization: `token ${TOKEN}`,
    });
  });

  it('omits Authorization when the token is null', async () => {
    const { p, calls } = provider(() => json([]), { token: null });
    await p.listOpenIssues(REPO, NONE);
    expect(Object.keys(calls[0]!.headers).map((k) => k.toLowerCase())).not.toContain(
      'authorization',
    );
    expect(calls[0]!.headers['Accept']).toBe('application/json');
  });

  it.each([
    ['https://gitea.example.com', 'https://gitea.example.com/api/v1'],
    ['https://gitea.example.com/', 'https://gitea.example.com/api/v1'],
    ['https://gitea.example.com///', 'https://gitea.example.com/api/v1'],
    ['https://example.com/gitea', 'https://example.com/gitea/api/v1'],
    ['https://example.com/gitea/', 'https://example.com/gitea/api/v1'],
  ])('builds the API base from %s', async (baseUrl, api) => {
    const { fetch, calls } = makeFetch(() => json([]));
    const p = createGiteaProvider({ baseUrl, token: null, fetch });
    await p.listOpenIssues(REPO, NONE);
    await p.getIssue(REPO, 3);
    expect(calls[0]!.url).toBe(
      `${api}/repos/acme/api/issues?state=open&type=issues&limit=50&page=1`,
    );
    expect(calls[1]!.url).toBe(`${api}/repos/acme/api/issues/3`);
  });

  it('lowercases owner and repo in request paths', async () => {
    const { p, calls } = provider(() => json([]));
    await p.listOpenIssues({ owner: 'Acme', repo: 'API' }, NONE);
    expect(new URL(calls[0]!.url).pathname).toBe(ISSUES_PATH);
  });
});

describe('listOpenIssues: native dependencies', () => {
  const route: Route = (url) => {
    if (url.pathname === ISSUES_PATH) return json([gtIssue(1), gtIssue(2), gtIssue(3)]);
    if (url.pathname === `${ISSUES_PATH}/2/dependencies`)
      return json([
        gtIssue(9, { repository: { name: 'lib', owner: 'Other', full_name: 'Other/lib' } }),
        gtIssue(1),
        gtIssue(1),
        gtIssue(4),
      ]);
    if (url.pathname === `${ISSUES_PATH}/1/dependencies`) return json([]);
    if (url.pathname === `${ISSUES_PATH}/3/dependencies`) return json([]);
    return undefined;
  };

  it('turns dependencies into sorted, deduped blocked-by relations (cross-repo lowercased)', async () => {
    const { p, calls } = provider(route);
    const res = await p.listOpenIssues(REPO, NATIVE);
    expect(res.warnings).toEqual([]);
    expect(res.issues.map((i) => i.nativeRelations)).toEqual([
      [],
      [
        { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 1 }, source: 'native' },
        { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 4 }, source: 'native' },
        { kind: 'blocked-by', ref: { owner: 'other', repo: 'lib', number: 9 }, source: 'native' },
      ],
      [],
    ]);
    const deps = calls.filter(isDeps).map((c) => c.url);
    expect(deps).toHaveLength(3);
    expect(deps).toContain(`${API}/repos/acme/api/issues/2/dependencies?limit=50&page=1`);
  });

  it('falls back to full_name, then to the listed repo, when owner/name are missing', async () => {
    const { p } = provider((url) => {
      if (url.pathname === ISSUES_PATH) return json([gtIssue(1)]);
      return json([
        gtIssue(5, { repository: { full_name: 'Foo/Bar' } }),
        gtIssue(6, { repository: null }),
        gtIssue(7, { repository: undefined }),
        gtIssue(8, { repository: { full_name: 'garbage' } }),
      ]);
    });
    const res = await p.listOpenIssues(REPO, NATIVE);
    expect(res.issues[0]!.nativeRelations.map((r) => r.ref)).toEqual([
      { owner: 'acme', repo: 'api', number: 6 },
      { owner: 'acme', repo: 'api', number: 7 },
      { owner: 'acme', repo: 'api', number: 8 },
      { owner: 'foo', repo: 'bar', number: 5 },
    ]);
  });

  it('paginates the dependencies endpoint', async () => {
    const { p, calls } = provider((url) => {
      if (url.pathname === ISSUES_PATH) return json([gtIssue(1)]);
      const page = url.searchParams.get('page');
      return page === '1' ? json(range(100, 50)) : json(range(150, 3));
    });
    const res = await p.listOpenIssues(REPO, NATIVE);
    expect(res.issues[0]!.nativeRelations).toHaveLength(53);
    expect(calls.filter(isDeps)).toHaveLength(2);
  });

  it('a 404 on the first probe gives exactly one warning and no further dependency calls', async () => {
    const { p, calls } = provider((url) =>
      url.pathname === ISSUES_PATH ? json([gtIssue(1), gtIssue(2), gtIssue(3)]) : status(404),
    );
    const res = await p.listOpenIssues(REPO, NATIVE);
    expect(res.issues).toHaveLength(3);
    expect(res.issues.every((i) => i.nativeRelations.length === 0)).toBe(true);
    expect(res.warnings).toEqual([
      {
        code: 'native-unsupported',
        message:
          'Issue dependencies are not available for acme/api (the dependencies endpoint returned 404). Enable dependencies in the repository settings (Settings → Issues → Enable dependencies) or instance config [service] DEFAULT_ENABLE_DEPENDENCIES. Native relations are skipped.',
        issues: [],
      },
    ]);
    expect(calls.filter(isDeps)).toHaveLength(1);
  });

  it('a later isolated 404 only skips that issue', async () => {
    const { p } = provider((url) => {
      if (url.pathname === ISSUES_PATH) return json([gtIssue(1), gtIssue(2), gtIssue(3)]);
      if (url.pathname.includes('/issues/2/')) return status(404);
      return json([gtIssue(7)]);
    });
    const res = await p.listOpenIssues(REPO, NATIVE);
    expect(res.warnings).toEqual([]);
    expect(res.issues.map((i) => i.nativeRelations.length)).toEqual([1, 0, 1]);
  });

  it('makes no dependency calls when native is off', async () => {
    const { p, calls } = provider(route);
    const res = await p.listOpenIssues(REPO, NONE);
    expect(calls.filter(isDeps)).toHaveLength(0);
    expect(res.issues.every((i) => i.nativeRelations.length === 0)).toBe(true);
  });

  it('makes no dependency calls and no warning for a repo without issues', async () => {
    const { p, calls } = provider(() => json([]));
    const res = await p.listOpenIssues(REPO, NATIVE);
    expect(res).toEqual({ issues: [], warnings: [] });
    expect(calls).toHaveLength(1);
  });

  it('propagates non-404 errors from the dependencies endpoint', async () => {
    const { p } = provider((url) =>
      url.pathname === ISSUES_PATH ? json([gtIssue(1)]) : status(500),
    );
    const err = await p.listOpenIssues(REPO, NATIVE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
  });

  it('never exceeds the concurrency limit for dependency requests', async () => {
    let active = 0;
    let peak = 0;
    const listing = range(1, 15);
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === ISSUES_PATH) return json(listing);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return json([]);
    }) as FetchLike;
    const p = createGiteaProvider({ baseUrl: ROOT, token: null, fetch: fetchFn, concurrency: 3 });
    await p.listOpenIssues(REPO, NATIVE);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('getIssue', () => {
  it('maps a single issue in any state, with empty nativeRelations and no extra calls', async () => {
    const { p, calls } = provider((url) =>
      url.pathname === `${ISSUES_PATH}/4`
        ? json(gtIssue(4, { state: 'closed', labels: [{ name: 'b' }, { name: 'a' }] }))
        : undefined,
    );
    const issue = await p.getIssue({ owner: 'Acme', repo: 'API' }, 4);
    expect(issue).toMatchObject({
      key: 'acme/api#4',
      state: 'closed',
      labels: ['a', 'b'],
      nativeRelations: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/repos/acme/api/issues/4`);
  });

  it('returns null on 404, 410 and pull requests', async () => {
    const { p } = provider((url) => {
      if (url.pathname.endsWith('/1')) return status(404);
      if (url.pathname.endsWith('/2')) return status(410);
      return json(gtIssue(3, { pull_request: { merged: true } }));
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
  it('reports kind gitea', () => {
    expect(provider(() => json([])).p.kind).toBe('gitea');
  });

  it('retries a 503 with Retry-After and then succeeds', async () => {
    const { p, sleeps, calls } = provider((_url, n) =>
      n === 1 ? status(503, { 'retry-after': '2' }) : json([gtIssue(1)]),
    );
    const res = await p.listOpenIssues(REPO, NONE);
    expect(res.issues).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('keeps the token out of errors when retries are exhausted', async () => {
    const { p, calls } = provider(() => status(502));
    const err = await p.listOpenIssues(REPO, NONE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(4);
    expect((err as HttpError).message).not.toContain(TOKEN);
    expect((err as HttpError).url).not.toContain(TOKEN);
    expect(String((err as HttpError).stack)).not.toContain(TOKEN);
  });

  it('keeps the token out of network error messages', async () => {
    const fetchFn = (async () => {
      throw new TypeError(`fetch failed (Authorization: token ${TOKEN})`);
    }) as unknown as FetchLike;
    const p = createGiteaProvider({
      baseUrl: ROOT,
      token: TOKEN,
      fetch: fetchFn,
      sleep: async () => {},
    });
    const err = await p.getIssue(REPO, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).not.toContain(TOKEN);
  });

  it('keeps the token out of a failing dependencies call', async () => {
    const { p } = provider((url) =>
      url.pathname === ISSUES_PATH ? json([gtIssue(1)]) : status(500),
    );
    const err = await p.listOpenIssues(REPO, NATIVE).catch((e: unknown) => e);
    expect((err as HttpError).message).not.toContain(TOKEN);
  });
});
