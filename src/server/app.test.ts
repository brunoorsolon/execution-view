import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/load.js';
import type { AppConfig, ResolvedSource } from '../config/schema.js';
import type { FetchResult, Issue, IssueProvider, ListOptions, RepoRef } from '../core/types.js';
import { createProvider } from '../providers/index.js';
import { PlanService } from '../service/planService.js';
import { buildApp } from './app.js';

const DEMO_CONFIG = fileURLToPath(new URL('../../config.demo.yaml', import.meta.url));
const TOKEN = 'ghp_SuperSecretToken123';

function demoConfig(mutate?: (c: AppConfig) => void): AppConfig {
  const config = loadConfig({ path: DEMO_CONFIG, env: {} });
  mutate?.(config);
  return config;
}

interface FakeProvider extends IssueProvider {
  list: number;
  fail: Error | null;
}

/** The real fixture provider, plus a call counter and an optional failure. */
function fake(source: ResolvedSource): FakeProvider {
  const inner = createProvider(source);
  const wrapper: FakeProvider = {
    kind: inner.kind,
    list: 0,
    fail: null,
    listOpenIssues(repo: RepoRef, options: ListOptions): Promise<FetchResult> {
      wrapper.list++;
      if (wrapper.fail !== null) return Promise.reject(wrapper.fail);
      return inner.listOpenIssues(repo, options);
    },
    getIssue(repo: RepoRef, number: number): Promise<Issue | null> {
      return inner.getIssue(repo, number);
    },
  };
  return wrapper;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function setup(opts: { config?: AppConfig; webDir?: string } = {}) {
  const config = opts.config ?? demoConfig();
  const providers: FakeProvider[] = [];
  const service = new PlanService(config, {
    providerFor: (source) => {
      const p = fake(source);
      providers.push(p);
      return p;
    },
  });
  const app: FastifyInstance = buildApp(config, service, {
    webDir: opts.webDir ?? path.join(tmpdir(), 'ev-no-such-web-dir'),
  });
  cleanups.push(() => app.close());
  return { app, providers, config };
}

function tempWebDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ev-web-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>UI</title><p>INDEX</p>');
  writeFileSync(path.join(dir, 'app.js'), 'console.log("app");');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'x.css'), 'body{}');
  return dir;
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

describe('health and views', () => {
  it('GET /healthz', async () => {
    const { app } = setup();
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/views lists the demo view with no-store', async () => {
    const { app } = setup();
    const res = await app.inject('/api/views');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual([
      {
        id: 'demo',
        title: 'Acme demo roadmap',
        source: 'demo',
        kind: 'fixture',
        repos: ['acme/api', 'acme/web'],
      },
    ]);
  });
});

describe('snapshot and refresh', () => {
  it('returns the snapshot with ETag and no-store', async () => {
    const { app } = setup();
    const res = await app.inject('/api/views/demo/snapshot');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const snap = res.json();
    expect(snap.viewId).toBe('demo');
    expect(snap.plan.nodes).toHaveLength(23);
    expect(snap.layout.nodes).toHaveLength(23);
    expect(res.headers['etag']).toBe(`"${snap.contentHash}"`);
  });

  it('serves from the cache unless refresh is requested', async () => {
    const { app, providers } = setup();
    await app.inject('/api/views/demo/snapshot');
    await app.inject('/api/views/demo/snapshot');
    const p = providers[0] as FakeProvider;
    expect(p.list).toBe(2); // one call per repo, fetched once
    await app.inject('/api/views/demo/snapshot?refresh=1');
    expect(p.list).toBe(4);
    await app.inject('/api/views/demo/snapshot?refresh=true');
    expect(p.list).toBe(6);
    await app.inject('/api/views/demo/snapshot?refresh=0');
    expect(p.list).toBe(6);
  });

  it('POST /api/views/:id/refresh forces a refresh', async () => {
    const { app, providers } = setup();
    await app.inject('/api/views/demo/snapshot');
    const p = providers[0] as FakeProvider;
    const before = p.list;
    const res = await app.inject({ method: 'POST', url: '/api/views/demo/refresh' });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan.nodes).toHaveLength(23);
    expect(p.list).toBeGreaterThan(before);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 304 when If-None-Match matches the content hash', async () => {
    const { app } = setup();
    const first = await app.inject('/api/views/demo/snapshot');
    const etag = first.headers['etag'] as string;

    const same = await app.inject({
      url: '/api/views/demo/snapshot',
      headers: { 'if-none-match': etag },
    });
    expect(same.statusCode).toBe(304);
    expect(same.body).toBe('');
    expect(same.headers['etag']).toBe(etag);
    expect(same.headers['cache-control']).toBe('no-store');

    const list = await app.inject({
      url: '/api/views/demo/snapshot',
      headers: { 'if-none-match': `"other", W/${etag}` },
    });
    expect(list.statusCode).toBe(304);

    const star = await app.inject({
      url: '/api/views/demo/snapshot',
      headers: { 'if-none-match': '*' },
    });
    expect(star.statusCode).toBe(304);

    const different = await app.inject({
      url: '/api/views/demo/snapshot',
      headers: { 'if-none-match': '"deadbeef"' },
    });
    expect(different.statusCode).toBe(200);
    expect(different.json().contentHash).toBe(JSON.parse(first.body).contentHash);
  });
});

describe('exports', () => {
  const cases: Array<[string, string, string, string]> = [
    ['json', 'application/json', 'demo.json', '"viewId"'],
    ['md', 'text/markdown', 'demo.md', '# '],
    ['mmd', 'text/plain', 'demo.mmd', 'flowchart LR'],
    ['dot', 'text/vnd.graphviz', 'demo.dot', 'digraph'],
  ];

  it.each(cases)('export.%s', async (ext, contentType, filename, marker) => {
    const { app } = setup();
    const res = await app.inject(`/api/views/demo/export.${ext}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain(contentType);
    expect(res.headers['content-type']).toContain('charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`inline; filename="${filename}"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain(marker);
  });

  it('supports ?refresh=1', async () => {
    const { app, providers } = setup();
    await app.inject('/api/views/demo/export.md');
    const p = providers[0] as FakeProvider;
    const before = p.list;
    await app.inject('/api/views/demo/export.md?refresh=1');
    expect(p.list).toBeGreaterThan(before);
  });

  it('returns 404 for unknown formats', async () => {
    const { app } = setup();
    for (const ext of ['txt', 'mermaid', 'xml', 'toString', '']) {
      const res = await app.inject(`/api/views/demo/export.${ext}`);
      expect(res.statusCode, ext).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found' });
    }
  });
});

describe('errors', () => {
  it('returns 404 for an unknown view on every view route', async () => {
    const { app } = setup();
    const requests = [
      { method: 'GET' as const, url: '/api/views/nope/snapshot' },
      { method: 'POST' as const, url: '/api/views/nope/refresh' },
      { method: 'GET' as const, url: '/api/views/nope/export.json' },
      { method: 'GET' as const, url: '/api/views/nope/export.md' },
      { method: 'GET' as const, url: '/api/views/nope/export.mmd' },
      { method: 'GET' as const, url: '/api/views/nope/export.dot' },
    ];
    for (const req of requests) {
      const res = await app.inject(req);
      expect(res.statusCode, req.url).toBe(404);
      expect(res.json().error).toContain('nope');
    }
  });

  it('maps provider failures to 502 without leaking the token', async () => {
    const config = demoConfig((c) => {
      const source = c.sources[0] as ResolvedSource;
      source.token = TOKEN;
    });
    const failing = new Error(`request to https://x/?access_token=${TOKEN} failed (${TOKEN})`);
    const service = new PlanService(config, {
      providerFor: (source) => {
        const p = fake(source);
        p.fail = failing;
        return p;
      },
    });
    const app2 = buildApp(config, service);
    cleanups.push(() => app2.close());

    const urls = [
      { method: 'GET' as const, url: '/api/views/demo/snapshot' },
      { method: 'POST' as const, url: '/api/views/demo/refresh' },
      { method: 'GET' as const, url: '/api/views/demo/export.json' },
    ];
    for (const req of urls) {
      const res = await app2.inject(req);
      expect(res.statusCode, req.url).toBe(502);
      expect(res.body).not.toContain(TOKEN);
      expect(res.json().error).toBe('request to https://x/?access_token=*** failed (***)');
    }
  });

  it('does not cache a failed fetch', async () => {
    const config = demoConfig();
    const providers: FakeProvider[] = [];
    const service = new PlanService(config, {
      providerFor: (source) => {
        const p = fake(source);
        p.fail = new Error('boom');
        providers.push(p);
        return p;
      },
    });
    const app = buildApp(config, service);
    cleanups.push(() => app.close());
    expect((await app.inject('/api/views/demo/snapshot')).statusCode).toBe(502);
    (providers[0] as FakeProvider).fail = null;
    expect((await app.inject('/api/views/demo/snapshot')).statusCode).toBe(200);
  });

  it('returns 404 JSON for unknown API paths', async () => {
    const { app } = setup({ webDir: tempWebDir() });
    const res = await app.inject({ url: '/api/nope', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
  });
});

describe('basic auth', () => {
  function authed() {
    return setup({
      config: demoConfig((c) => {
        c.server.basicAuth = { username: 'admin', password: 's3cret' };
      }),
    });
  }

  it('rejects requests without credentials', async () => {
    const { app } = authed();
    const res = await app.inject('/api/views');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Basic realm="execution-view"');
    for (const url of ['/api/views/demo/snapshot', '/api/views/demo/export.md', '/', '/x']) {
      expect((await app.inject(url)).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/views/demo/refresh' })).statusCode).toBe(
      401,
    );
  });

  it('rejects wrong credentials', async () => {
    const { app } = authed();
    const wrong = [
      basic('admin', 'wrong'),
      basic('root', 's3cret'),
      basic('admin', ''),
      basic('admin', 's3cret-and-more'),
      basic('adm', 's3cret'),
      `Basic ${Buffer.from('admin').toString('base64')}`,
      'Basic !!!',
      'Bearer s3cret',
    ];
    for (const authorization of wrong) {
      const res = await app.inject({ url: '/api/views', headers: { authorization } });
      expect(res.statusCode, authorization).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Basic realm="execution-view"');
    }
  });

  it('accepts the right credentials, including a colon in the password', async () => {
    const { app } = authed();
    const ok = await app.inject({
      url: '/api/views',
      headers: { authorization: basic('admin', 's3cret') },
    });
    expect(ok.statusCode).toBe(200);

    const colon = setup({
      config: demoConfig((c) => {
        c.server.basicAuth = { username: 'admin', password: 'a:b:c' };
      }),
    });
    const res = await colon.app.inject({
      url: '/api/views',
      headers: { authorization: basic('admin', 'a:b:c') },
    });
    expect(res.statusCode).toBe(200);
  });

  it('exempts /healthz', async () => {
    const { app } = authed();
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('is off when basicAuth is null', async () => {
    const { app } = setup();
    expect((await app.inject('/api/views')).statusCode).toBe(200);
  });
});

describe('static UI', () => {
  it('serves index.html and assets', async () => {
    const { app } = setup({ webDir: tempWebDir() });
    const index = await app.inject('/');
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.body).toContain('INDEX');

    const js = await app.inject('/app.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.body).toBe('console.log("app");');

    const css = await app.inject('/assets/x.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
  });

  it('falls back to index.html for HTML navigation', async () => {
    const { app } = setup({ webDir: tempWebDir() });
    const res = await app.inject({
      url: '/some/deep/route',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('INDEX');
  });

  it('returns a JSON 404 for non-HTML requests and API paths', async () => {
    const { app } = setup({ webDir: tempWebDir() });
    const missingAsset = await app.inject({
      url: '/missing.js',
      headers: { accept: '*/*' },
    });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.json()).toEqual({ error: 'Not found' });

    const api = await app.inject('/api/nope');
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'Not found' });
    expect(api.headers['cache-control']).toBe('no-store');

    const post = await app.inject({
      method: 'POST',
      url: '/some/route',
      headers: { accept: 'text/html' },
    });
    expect(post.statusCode).toBe(404);
  });

  it('serves files added after startup, and a web dir created after startup', async () => {
    const dir = tempWebDir();
    const { app } = setup({ webDir: dir });
    expect((await app.inject('/assets/index-abc123.js')).statusCode).toBe(404);
    writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'export {};');
    const added = await app.inject('/assets/index-abc123.js');
    expect(added.statusCode).toBe(200);
    expect(added.body).toBe('export {};');

    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>REBUILT</p>');
    expect((await app.inject('/')).body).toContain('REBUILT');

    const late = path.join(tmpdir(), `ev-late-web-${process.pid}-${Date.now()}`);
    cleanups.push(() => rmSync(late, { recursive: true, force: true }));
    const { app: lateApp } = setup({ webDir: late });
    expect((await lateApp.inject('/')).body).toContain('not built');
    mkdirSync(path.join(late, 'assets'), { recursive: true });
    writeFileSync(path.join(late, 'index.html'), '<p>LATE</p>');
    writeFileSync(path.join(late, 'assets', 'a.js'), 'late');
    expect((await lateApp.inject('/')).body).toContain('LATE');
    expect((await lateApp.inject('/assets/a.js')).body).toBe('late');
    const deep = await lateApp.inject({ url: '/deep', headers: { accept: 'text/html' } });
    expect(deep.body).toContain('LATE');
  });

  it('sets cache headers: no-cache for index.html, immutable for assets', async () => {
    const { app } = setup({ webDir: tempWebDir() });
    expect((await app.inject('/')).headers['cache-control']).toBe('no-cache');
    expect((await app.inject('/index.html')).headers['cache-control']).toBe('no-cache');
    expect((await app.inject('/app.js')).headers['cache-control']).toBe('no-cache');
    const asset = await app.inject('/assets/x.css');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const fallback = await app.inject({
      url: '/some/route',
      headers: { accept: 'text/html' },
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.headers['cache-control']).toBe('no-cache');
    expect((await app.inject('/api/views')).headers['cache-control']).toBe('no-store');
  });

  it('keeps /healthz and /api/* ahead of the static wildcard', async () => {
    const dir = tempWebDir();
    mkdirSync(path.join(dir, 'api'));
    writeFileSync(path.join(dir, 'api', 'views'), 'STATIC');
    writeFileSync(path.join(dir, 'healthz'), 'STATIC');
    const { app } = setup({ webDir: dir });
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
    const views = await app.inject('/api/views');
    expect(views.body).not.toContain('STATIC');
    expect(Array.isArray(views.json())).toBe(true);
  });

  it('never serves files outside the web dir', async () => {
    const outer = mkdtempSync(path.join(tmpdir(), 'ev-outer-'));
    cleanups.push(() => rmSync(outer, { recursive: true, force: true }));
    writeFileSync(path.join(outer, 'secret.txt'), 'TOP-SECRET');
    const dir = path.join(outer, 'web');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'index.html'), '<p>INDEX</p>');
    const { app } = setup({ webDir: dir });
    const urls = [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/assets/../../secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/%252e%252e/secret.txt',
      '/..\\secret.txt',
    ];
    for (const url of urls) {
      for (const accept of ['*/*', 'text/html']) {
        const res = await app.inject({ url, headers: { accept } });
        expect(res.body, `${url} (${accept})`).not.toContain('TOP-SECRET');
        if (accept === '*/*') expect([400, 403, 404], url).toContain(res.statusCode);
      }
    }
  });

  it('applies basic auth to static files, except /healthz', async () => {
    const config = demoConfig((c) => {
      c.server.basicAuth = { username: 'u', password: 'p' };
    });
    const { app } = setup({ config, webDir: tempWebDir() });
    for (const url of ['/', '/app.js', '/assets/x.css', '/missing.js']) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Basic');
    }
    const ok = await app.inject({ url: '/app.js', headers: { authorization: basic('u', 'p') } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });

  it('starts and explains itself when the web dir is missing', async () => {
    const { app } = setup({ webDir: path.join(tmpdir(), 'ev-definitely-missing-dir') });
    const res = await app.inject('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('not built');
    expect(res.body).toContain('href="/api/views"');
    const other = await app.inject({ url: '/deep', headers: { accept: 'text/html' } });
    expect(other.statusCode).toBe(404);
  });
});

describe('webhooks', () => {
  const SECRET = 'wh-secret';
  const payload = (repo: string | null = 'acme/api', extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      action: 'edited',
      ...(repo === null ? {} : { repository: { full_name: repo } }),
      ...extra,
    });
  const hmac = (body: string | Buffer, secret = SECRET) =>
    createHmac('sha256', secret).update(body).digest('hex');
  const hooked = (mutate?: (c: AppConfig) => void) =>
    setup({
      config: demoConfig((c) => {
        c.webhooks = { secret: SECRET };
        mutate?.(c);
      }),
    });
  const post = (
    app: FastifyInstance,
    url: string,
    body: string | Buffer,
    headers: Record<string, string>,
  ) =>
    app.inject({
      method: 'POST',
      url,
      payload: body,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('a valid GitHub signature invalidates the view, so the next snapshot refetches', async () => {
    const { app, providers } = hooked();
    expect((await app.inject('/api/views/demo/snapshot')).statusCode).toBe(200);
    const provider = providers[0] as FakeProvider;
    const calls = provider.list;
    await app.inject('/api/views/demo/snapshot');
    expect(provider.list).toBe(calls); // cached

    const body = payload();
    const res = await post(app, '/api/webhooks/github', body, {
      'x-github-event': 'issues',
      'x-hub-signature-256': `sha256=${hmac(body)}`,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ invalidated: ['demo'] });
    expect(res.headers['cache-control']).toBe('no-store');

    await app.inject('/api/views/demo/snapshot');
    expect(provider.list).toBeGreaterThan(calls);
  });

  it('matches the repository case-insensitively and accepts a Buffer body', async () => {
    const { app } = hooked();
    const body = Buffer.from(payload('Acme/Web'));
    const res = await post(app, '/api/webhooks/github', body, {
      'x-github-event': 'issues',
      'x-hub-signature-256': `sha256=${hmac(body)}`,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ invalidated: ['demo'] });
  });

  it('the gitea route accepts X-Gitea-Signature', async () => {
    const { app } = hooked();
    const body = payload();
    const res = await post(app, '/api/webhooks/gitea', body, {
      'x-gitea-event': 'issues',
      'x-gitea-signature': hmac(body),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ invalidated: ['demo'] });
  });

  it('the gitea route accepts X-Forgejo-Signature', async () => {
    const { app } = hooked();
    const body = payload();
    const res = await post(app, '/api/webhooks/gitea', body, {
      'x-forgejo-event': 'issues',
      'x-forgejo-signature': hmac(body),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ invalidated: ['demo'] });
  });

  it('the gitea route accepts X-Hub-Signature-256', async () => {
    const { app } = hooked();
    const body = payload();
    const res = await post(app, '/api/webhooks/gitea', body, {
      'x-hub-signature-256': `sha256=${hmac(body)}`,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ invalidated: ['demo'] });
  });

  it('rejects a wrong, missing, malformed or differently-formatted signature with 401', async () => {
    const { app, providers } = hooked();
    const body = payload();
    const good = hmac(body);
    const cases: Array<[string, Record<string, string>]> = [
      ['/api/webhooks/github', { 'x-hub-signature-256': `sha256=${hmac(body, 'other')}` }],
      ['/api/webhooks/github', {}],
      ['/api/webhooks/github', { 'x-hub-signature-256': `sha256=${good.slice(0, 62)}` }],
      ['/api/webhooks/github', { 'x-hub-signature-256': 'sha256=zz' }],
      ['/api/webhooks/github', { 'x-hub-signature-256': good }], // prefix required
      ['/api/webhooks/github', { 'x-gitea-signature': good }], // wrong header for this route
      ['/api/webhooks/gitea', {}],
      ['/api/webhooks/gitea', { 'x-gitea-signature': hmac(body, 'other') }],
      ['/api/webhooks/gitea', { 'x-gitea-signature': `sha256=${good}` }], // plain hex only
      ['/api/webhooks/gitea', { 'x-forgejo-signature': '' }],
    ];
    for (const [url, headers] of cases) {
      const res = await post(app, url, body, headers);
      expect(res.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid signature' });
    }
    expect(providers).toHaveLength(0);
  });

  it('rejects a signature computed over a different body', async () => {
    const { app } = hooked();
    const signed = payload('acme/api');
    const res = await post(app, '/api/webhooks/github', payload('acme/web'), {
      'x-hub-signature-256': `sha256=${hmac(signed)}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('verifies the raw bytes, not a re-serialised body', async () => {
    const { app } = hooked();
    const body = '{ "repository":   {"full_name":"acme/api"} }';
    const res = await post(app, '/api/webhooks/github', body, {
      'x-hub-signature-256': `sha256=${hmac(body)}`,
    });
    expect(res.statusCode).toBe(202);
    const reformatted = await post(app, '/api/webhooks/github', JSON.stringify(JSON.parse(body)), {
      'x-hub-signature-256': `sha256=${hmac(body)}`,
    });
    expect(reformatted.statusCode).toBe(401);
  });

  it('does not exist without a secret', async () => {
    const { app } = setup();
    const body = payload();
    for (const url of ['/api/webhooks/github', '/api/webhooks/gitea']) {
      const res = await post(app, url, body, {
        'x-hub-signature-256': `sha256=${hmac(body)}`,
        'x-gitea-signature': hmac(body),
      });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('is exempt from basic auth; everything else still needs credentials', async () => {
    const { app } = hooked((c) => {
      c.server.basicAuth = { username: 'admin', password: 's3cret' };
    });
    const body = payload();
    const ok = await post(app, '/api/webhooks/github', body, {
      'x-hub-signature-256': `sha256=${hmac(body)}`,
    });
    expect(ok.statusCode).toBe(202);
    const okGitea = await post(app, '/api/webhooks/gitea', body, {
      'x-gitea-signature': hmac(body),
    });
    expect(okGitea.statusCode).toBe(202);
    const bad = await post(app, '/api/webhooks/github', body, {});
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: 'Invalid signature' });
    expect(bad.headers['www-authenticate']).toBeUndefined();

    // nothing else is exempt: other methods and paths, including look-alikes
    for (const [method, url] of [
      ['GET', '/api/webhooks/github'],
      ['GET', '/api/webhooks/gitea'],
      ['GET', '/api/views'],
      ['POST', '/api/views/demo/refresh'],
      ['POST', '/api/webhooks/github/'],
      ['POST', '/api/webhooks/other'],
      ['POST', '/api/webhooks'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Basic');
    }
  });

  it('stays behind basic auth when webhooks are not configured', async () => {
    const { app } = setup({
      config: demoConfig((c) => {
        c.server.basicAuth = { username: 'admin', password: 's3cret' };
      }),
    });
    const res = await post(app, '/api/webhooks/github', payload(), {});
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
  });

  it('rejects a body over 1 MB with 413', async () => {
    const { app } = hooked();
    const body = payload('acme/api', { padding: 'x'.repeat(1_048_576) });
    const res = await post(app, '/api/webhooks/github', body, {
      'x-hub-signature-256': `sha256=${hmac(body)}`,
    });
    expect(res.statusCode).toBe(413);
  });

  it('answers a GitHub ping with 200 and does not invalidate', async () => {
    const { app, providers } = hooked();
    await app.inject('/api/views/demo/snapshot');
    const provider = providers[0] as FakeProvider;
    const calls = provider.list;
    const body = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 });
    const res = await post(app, '/api/webhooks/github', body, {
      'x-github-event': 'ping',
      'x-hub-signature-256': `sha256=${hmac(body)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.inject('/api/views/demo/snapshot');
    expect(provider.list).toBe(calls);
    // an unsigned ping is still rejected
    const unsigned = await post(app, '/api/webhooks/github', body, { 'x-github-event': 'ping' });
    expect(unsigned.statusCode).toBe(401);
  });

  it('answers 202 with no views for an unknown repo or a payload without a repository', async () => {
    const { app } = hooked();
    for (const body of [
      payload('nobody/nothing'),
      payload(null),
      JSON.stringify([1, 2]),
      JSON.stringify({ repository: { full_name: 7 } }),
    ]) {
      const res = await post(app, '/api/webhooks/github', body, {
        'x-hub-signature-256': `sha256=${hmac(body)}`,
      });
      expect(res.statusCode, body).toBe(202);
      expect(res.json()).toEqual({ invalidated: [] });
    }
  });

  it('rejects a signed body that is not JSON with 400, and other content types with 415', async () => {
    const { app } = hooked();
    const body = 'not json';
    const res = await post(app, '/api/webhooks/github', body, {
      'x-hub-signature-256': `sha256=${hmac(body)}`,
    });
    expect(res.statusCode).toBe(400);
    const form = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload: 'payload=%7B%7D',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.statusCode).toBe(415);
  });

  it('does not change how the other routes parse JSON', async () => {
    const { app } = hooked();
    const res = await app.inject({
      method: 'POST',
      url: '/api/views/demo/refresh',
      payload: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
  });
});
