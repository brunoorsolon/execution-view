import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_KEYWORDS, configFromEnv, loadConfig, parseConfig } from './load.js';

const MIN = `
sources:
  - id: gh
    kind: github
views:
  - id: v
    source: gh
    repos: [Acme/API]
`;

function withSource(sourceLines: string): string {
  return `
sources:
${sourceLines}
views:
  - id: v
    source: ${/id: (\S+)/.exec(sourceLines)![1]}
    repos: [a/b]
`;
}

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

describe('parseConfig defaults', () => {
  it('applies every default', () => {
    const cfg = parseConfig(MIN, {});
    expect(cfg.server).toEqual({ host: '0.0.0.0', port: 8080, basicAuth: null });
    expect(cfg.cache).toEqual({ ttlSeconds: 300 });
    expect(cfg.ui).toEqual({ refreshMinutes: 5 });
    expect(cfg.webhooks).toBeNull();
    expect(cfg.sources).toEqual([
      {
        id: 'gh',
        kind: 'github',
        baseUrl: 'https://api.github.com',
        webUrl: 'https://github.com',
        token: null,
        path: null,
      },
    ]);
    expect(cfg.views).toEqual([
      {
        id: 'v',
        title: 'v',
        source: 'gh',
        repos: [{ owner: 'acme', repo: 'api' }],
        dependencies: { native: true, body: true, subIssues: false, keywords: DEFAULT_KEYWORDS },
        scope: { labels: [], excludeLabels: [], milestones: [] },
        ordering: { priorityLabels: [], mode: 'priority' },
      },
    ]);
    expect(cfg.warnings).toEqual([]);
  });

  it('does not share the default keyword arrays', () => {
    const cfg = parseConfig(MIN, {});
    cfg.views[0]!.dependencies.keywords.blocks.push('x');
    expect(DEFAULT_KEYWORDS.blocks).toEqual(['blocks', 'blocking', 'required by']);
  });

  it('lowercases, dedupes and sorts repos', () => {
    const cfg = parseConfig(
      MIN.replace('[Acme/API]', '[Zed/Web, acme/api, ACME/API, acme/Web]'),
      {},
    );
    expect(cfg.views[0]!.repos).toEqual([
      { owner: 'acme', repo: 'api' },
      { owner: 'acme', repo: 'web' },
      { owner: 'zed', repo: 'web' },
    ]);
  });

  it('accepts a partial keywords object, filling missing kinds from the defaults', () => {
    const cfg = parseConfig(
      `${MIN}    dependencies:\n      keywords:\n        blockedBy: [needs]\n`,
      {},
    );
    expect(cfg.views[0]!.dependencies.keywords).toEqual({
      blockedBy: ['needs'],
      blocks: DEFAULT_KEYWORDS.blocks,
    });
  });

  it('accepts dependencies.body as a boolean or strict', () => {
    expect(parseConfig(MIN, {}).views[0]!.dependencies.body).toBe(true);
    expect(
      parseConfig(`${MIN}    dependencies:\n      body: false\n`, {}).views[0]!.dependencies.body,
    ).toBe(false);
    expect(
      parseConfig(`${MIN}    dependencies:\n      body: strict\n`, {}).views[0]!.dependencies.body,
    ).toBe('strict');
  });

  it('rejects an invalid dependencies.body', () => {
    const e = errorOf(() => parseConfig(`${MIN}    dependencies:\n      body: yes\n`, {}));
    expect(e.message).toContain('body');
  });

  it('uses an explicit title, scope and priority labels', () => {
    const cfg = parseConfig(
      `${MIN}    title: My view
    scope:
      labels: [a]
      excludeLabels: [b]
      milestones: [m1]
    ordering:
      priorityLabels: [P0, P1]
`,
      {},
    );
    const v = cfg.views[0]!;
    expect(v.title).toBe('My view');
    expect(v.scope).toEqual({ labels: ['a'], excludeLabels: ['b'], milestones: ['m1'] });
    expect(v.ordering.priorityLabels).toEqual(['P0', 'P1']);
  });

  it('defaults ordering.mode to priority and accepts waves', () => {
    expect(parseConfig(MIN, {}).views[0]!.ordering.mode).toBe('priority');
    expect(
      parseConfig(`${MIN}    ordering:\n      mode: priority\n`, {}).views[0]!.ordering.mode,
    ).toBe('priority');
    const cfg = parseConfig(`${MIN}    ordering:\n      mode: waves\n`, {});
    expect(cfg.views[0]!.ordering).toEqual({ priorityLabels: [], mode: 'waves' });
  });

  it('rejects an invalid ordering.mode', () => {
    const e = errorOf(() => parseConfig(`${MIN}    ordering:\n      mode: fastest\n`, {}));
    expect(e.message).toContain('ordering.mode');
  });
});

describe('webUrl derivation', () => {
  it('github.com, with and without trailing slash', () => {
    for (const base of ['https://api.github.com', 'https://api.github.com/']) {
      const cfg = parseConfig(withSource(`  - id: gh\n    kind: github\n    baseUrl: ${base}`), {});
      expect(cfg.sources[0]!.baseUrl).toBe('https://api.github.com');
      expect(cfg.sources[0]!.webUrl).toBe('https://github.com');
    }
  });

  it('GHES strips /api/v3', () => {
    const cfg = parseConfig(
      withSource('  - id: ghe\n    kind: github\n    baseUrl: https://ghe.example.com/api/v3/'),
      {},
    );
    expect(cfg.sources[0]!.baseUrl).toBe('https://ghe.example.com/api/v3');
    expect(cfg.sources[0]!.webUrl).toBe('https://ghe.example.com');
  });

  it('gitea uses baseUrl, trailing slashes stripped', () => {
    const cfg = parseConfig(
      withSource('  - id: gt\n    kind: gitea\n    baseUrl: https://gitea.example.com//'),
      {},
    );
    expect(cfg.sources[0]!.baseUrl).toBe('https://gitea.example.com');
    expect(cfg.sources[0]!.webUrl).toBe('https://gitea.example.com');
  });

  it('an explicit webUrl wins and has trailing slashes stripped', () => {
    const cfg = parseConfig(
      withSource(
        '  - id: gt\n    kind: gitea\n    baseUrl: http://10.0.0.5:3000\n    webUrl: https://git.example.com/',
      ),
      {},
    );
    expect(cfg.sources[0]!.webUrl).toBe('https://git.example.com');
  });

  it('fixture has empty baseUrl and webUrl unless given', () => {
    const plain = parseConfig(withSource('  - id: f\n    kind: fixture\n    path: a.json'), {});
    expect(plain.sources[0]!.baseUrl).toBe('');
    expect(plain.sources[0]!.webUrl).toBe('');
    const given = parseConfig(
      withSource('  - id: f\n    kind: fixture\n    path: a.json\n    webUrl: https://x.test/'),
      {},
    );
    expect(given.sources[0]!.webUrl).toBe('https://x.test');
  });
});

describe('tokens', () => {
  const src = (extra: string) => withSource(`  - id: gh\n    kind: github\n${extra}`);

  it('reads tokenEnv from the environment', () => {
    const cfg = parseConfig(src('    tokenEnv: MY_TOKEN'), { MY_TOKEN: 'abc' });
    expect(cfg.sources[0]!.token).toBe('abc');
    expect(cfg.warnings).toEqual([]);
  });

  it('a missing tokenEnv gives a null token and a warning', () => {
    const cfg = parseConfig(src('    tokenEnv: MY_TOKEN'), {});
    expect(cfg.sources[0]!.token).toBeNull();
    expect(cfg.warnings).toHaveLength(1);
    expect(cfg.warnings![0]).toContain('MY_TOKEN');
    expect(cfg.warnings![0]).toContain('"gh"');
  });

  it('allows an inline token', () => {
    const cfg = parseConfig(src('    token: inline'), {});
    expect(cfg.sources[0]!.token).toBe('inline');
  });

  it('tokenEnv wins over the inline token when set, else the inline token is used', () => {
    const both = src('    tokenEnv: MY_TOKEN\n    token: inline');
    expect(parseConfig(both, { MY_TOKEN: 'fromenv' }).sources[0]!.token).toBe('fromenv');
    const missing = parseConfig(both, {});
    expect(missing.sources[0]!.token).toBe('inline');
  });
});

describe('validation errors', () => {
  it('duplicate source id', () => {
    const e = errorOf(() =>
      parseConfig(
        `
sources:
  - { id: gh, kind: github }
  - { id: gh, kind: github }
views:
  - { id: v, source: gh, repos: [a/b] }
`,
        {},
      ),
    );
    expect(e.message).toContain('sources[1].id: duplicate source id "gh"');
  });

  it('duplicate view id', () => {
    const e = errorOf(() =>
      parseConfig(
        `
sources:
  - { id: gh, kind: github }
views:
  - { id: v, source: gh, repos: [a/b] }
  - { id: v, source: gh, repos: [a/c] }
`,
        {},
      ),
    );
    expect(e.message).toContain('views[1].id: duplicate view id "v"');
  });

  it('unknown source', () => {
    const e = errorOf(() =>
      parseConfig(
        `
sources:
  - { id: gh, kind: github }
  - { id: gt, kind: gitea, baseUrl: 'https://g.test' }
views:
  - { id: v, source: gh2, repos: [a/b] }
`,
        {},
      ),
    );
    expect(e.message).toContain('views[0].source: unknown source "gh2" (known: gh, gt)');
  });

  it('bad repo format', () => {
    const e = errorOf(() => parseConfig(MIN.replace('[Acme/API]', '[acme/api, nonsense]'), {}));
    expect(e.message).toContain('views[0].repos[1]: invalid repo "nonsense" (expected owner/repo)');
  });

  it('requires at least one repo', () => {
    const e = errorOf(() => parseConfig(MIN.replace('[Acme/API]', '[]'), {}));
    expect(e.message).toContain('views[0].repos');
    expect(e.message).toContain('at least one repo');
  });

  it('bad ids', () => {
    const e = errorOf(() => parseConfig(MIN.replace('id: v', 'id: Bad_Id'), {}));
    expect(e.message).toContain('views[0].id: invalid id "Bad_Id"');
    const e2 = errorOf(() => parseConfig(MIN.replace('id: gh', 'id: -x'), {}));
    expect(e2.message).toContain('sources[0].id: invalid id "-x"');
  });

  it('gitea requires baseUrl and fixture requires path', () => {
    const g = errorOf(() => parseConfig(withSource('  - id: gt\n    kind: gitea'), {}));
    expect(g.message).toContain('sources[0].baseUrl: baseUrl is required for gitea sources');
    const f = errorOf(() => parseConfig(withSource('  - id: f\n    kind: fixture'), {}));
    expect(f.message).toContain('sources[0].path: path is required for fixture sources');
  });

  it('aggregates several issues into one message', () => {
    const e = errorOf(() =>
      parseConfig(
        `
server: { port: 70000 }
sources:
  - { id: gh, kind: nope }
views:
  - { id: v, source: gh, repos: [bad] }
`,
        {},
      ),
    );
    expect(e.message).toContain('server.port');
    expect(e.message).toContain('sources[0].kind');
    expect(e.message).toContain('views[0].repos[0]');
  });

  it('rejects unknown keys, invalid YAML and empty documents', () => {
    expect(errorOf(() => parseConfig(MIN + '    bogus: 1\n', {})).message).toContain('bogus');
    expect(errorOf(() => parseConfig('a: [', {})).message).toContain('Invalid YAML');
    expect(errorOf(() => parseConfig('', {})).message).toContain('sources');
  });

  it('accepts any whole cache.ttlSeconds, however large, and rejects a fraction', () => {
    const big = parseConfig(`cache: { ttlSeconds: 10000000000000000 }\n${MIN}`, {});
    expect(big.cache.ttlSeconds).toBe(1e16);
    const e = errorOf(() => parseConfig(`cache: { ttlSeconds: 1.5 }\n${MIN}`, {}));
    expect(e.message).toContain('cache.ttlSeconds');
  });
});

describe('basicAuth', () => {
  const auth = (lines: string) =>
    `${MIN.replace('sources:', `server:\n  basicAuth:\n${lines}\nsources:`)}`;

  it('via passwordEnv', () => {
    const cfg = parseConfig(auth('    username: admin\n    passwordEnv: PW'), { PW: 's3cret' });
    expect(cfg.server.basicAuth).toEqual({ username: 'admin', password: 's3cret' });
  });

  it('via inline password', () => {
    const cfg = parseConfig(auth('    username: admin\n    password: pw'), {});
    expect(cfg.server.basicAuth).toEqual({ username: 'admin', password: 'pw' });
  });

  it('errors when no password is available', () => {
    const e = errorOf(() => parseConfig(auth('    username: admin'), {}));
    expect(e.message).toContain('server.basicAuth');
    const e2 = errorOf(() => parseConfig(auth('    username: admin\n    passwordEnv: PW'), {}));
    expect(e2.message).toContain('PW');
  });

  it('rejects an empty username and an unknown key', () => {
    expect(
      errorOf(() => parseConfig(auth('    username: ""\n    password: pw'), {})).message,
    ).toContain('server.basicAuth.username');
    expect(
      errorOf(() => parseConfig(auth('    username: admin\n    password: pw\n    role: x'), {}))
        .message,
    ).toContain('role');
  });

  it('FD_BASIC_AUTH overrides, splitting on the first colon', () => {
    const cfg = parseConfig(auth('    username: admin\n    password: pw'), {
      FD_BASIC_AUTH: 'bob:pa:ss',
    });
    expect(cfg.server.basicAuth).toEqual({ username: 'bob', password: 'pa:ss' });
    const plain = parseConfig(MIN, { FD_BASIC_AUTH: 'bob:pw' });
    expect(plain.server.basicAuth).toEqual({ username: 'bob', password: 'pw' });
  });

  it('rejects a malformed FD_BASIC_AUTH', () => {
    expect(errorOf(() => parseConfig(MIN, { FD_BASIC_AUTH: 'nocolon' })).message).toContain(
      'FD_BASIC_AUTH',
    );
  });
});

describe('webhooks', () => {
  const hooks = (lines: string) => MIN.replace('sources:', `webhooks:\n${lines}\nsources:`);

  it('is disabled by default', () => {
    const cfg = parseConfig(MIN, {});
    expect(cfg.webhooks).toBeNull();
    expect(cfg.warnings).toEqual([]);
  });

  it('via secretEnv', () => {
    const cfg = parseConfig(hooks('  secretEnv: HOOK'), { HOOK: 'from-env' });
    expect(cfg.webhooks).toEqual({ secret: 'from-env' });
    expect(cfg.warnings).toEqual([]);
  });

  it('via inline secret', () => {
    const cfg = parseConfig(hooks('  secret: inline'), {});
    expect(cfg.webhooks).toEqual({ secret: 'inline' });
  });

  it('secretEnv wins over the inline secret when its variable is set', () => {
    const text = hooks('  secretEnv: HOOK\n  secret: inline');
    expect(parseConfig(text, { HOOK: 'from-env' }).webhooks).toEqual({ secret: 'from-env' });
    const fallback = parseConfig(text, {});
    expect(fallback.webhooks).toEqual({ secret: 'inline' });
    expect(fallback.warnings).toEqual([]);
  });

  it('a missing env var warns and disables webhooks', () => {
    const cfg = parseConfig(hooks('  secretEnv: HOOK'), { HOOK: '  ' });
    expect(cfg.webhooks).toBeNull();
    expect(cfg.warnings).toHaveLength(1);
    expect(cfg.warnings![0]).toContain('HOOK');
    expect(cfg.warnings![0]).toContain('webhooks are disabled');
  });

  it('a block without any secret warns and disables webhooks', () => {
    const cfg = parseConfig(hooks('  secret: ""'), {});
    expect(cfg.webhooks).toBeNull();
    expect(cfg.warnings![0]).toContain('no secret');
  });

  it('FD_WEBHOOK_SECRET overrides the file, and enables webhooks without a block', () => {
    const cfg = parseConfig(hooks('  secret: inline'), { FD_WEBHOOK_SECRET: 'override' });
    expect(cfg.webhooks).toEqual({ secret: 'override' });
    expect(parseConfig(MIN, { FD_WEBHOOK_SECRET: 'only-env' }).webhooks).toEqual({
      secret: 'only-env',
    });
  });

  it('FD_WEBHOOK_SECRET also works in env-only mode', () => {
    const cfg = configFromEnv({
      FD_PROVIDER: 'github',
      FD_REPOS: 'a/b',
      FD_WEBHOOK_SECRET: 's',
    });
    expect(cfg.webhooks).toEqual({ secret: 's' });
    expect(configFromEnv({ FD_PROVIDER: 'github', FD_REPOS: 'a/b' }).webhooks).toBeNull();
  });

  it('rejects unknown keys', () => {
    expect(errorOf(() => parseConfig(hooks('  bogus: 1'), {})).message).toContain('bogus');
  });
});

describe('FD_* overrides', () => {
  it('FD_HOST, FD_PORT, FD_CACHE_TTL and FD_REFRESH_MINUTES override the file', () => {
    const yaml = `server: { host: 1.2.3.4, port: 9000 }\ncache: { ttlSeconds: 10 }\nui: { refreshMinutes: 15 }\n${MIN}`;
    const base = parseConfig(yaml, {});
    expect(base.server).toMatchObject({ host: '1.2.3.4', port: 9000 });
    expect(base.cache.ttlSeconds).toBe(10);
    expect(base.ui.refreshMinutes).toBe(15);
    const cfg = parseConfig(yaml, {
      FD_HOST: 'localhost',
      FD_PORT: '3000',
      FD_CACHE_TTL: '0',
      FD_REFRESH_MINUTES: '0',
    });
    expect(cfg.server).toMatchObject({ host: 'localhost', port: 3000 });
    expect(cfg.cache.ttlSeconds).toBe(0);
    expect(cfg.ui.refreshMinutes).toBe(0);
  });

  it('validates FD_PORT and FD_CACHE_TTL', () => {
    for (const port of ['0', '65536', 'abc', '1.5', '-1']) {
      expect(errorOf(() => parseConfig(MIN, { FD_PORT: port })).message).toContain('FD_PORT');
    }
    expect(parseConfig(MIN, { FD_PORT: '65535' }).server.port).toBe(65535);
    for (const ttl of ['-1', 'x', '2.5']) {
      expect(errorOf(() => parseConfig(MIN, { FD_CACHE_TTL: ttl })).message).toContain(
        'FD_CACHE_TTL',
      );
    }
    for (const minutes of ['-1', 'x', '2.5', '1441']) {
      expect(errorOf(() => parseConfig(MIN, { FD_REFRESH_MINUTES: minutes })).message).toContain(
        'FD_REFRESH_MINUTES',
      );
    }
    expect(parseConfig(MIN, { FD_REFRESH_MINUTES: '1440' }).ui.refreshMinutes).toBe(1440);
    expect(
      errorOf(() => parseConfig(`ui: { refreshMinutes: 1441 }\n${MIN}`, {})).message,
    ).toContain('refreshMinutes');
  });

  it('treats empty values as unset', () => {
    const cfg = parseConfig(MIN, { FD_PORT: '', FD_HOST: '  ' });
    expect(cfg.server).toMatchObject({ host: '0.0.0.0', port: 8080 });
  });
});

describe('EV_* names from before 3.0.1', () => {
  const deprecated = (warnings: string[] | undefined) =>
    (warnings ?? []).filter((w) => w.includes('is deprecated'));

  it('still apply alone, and each one warns with its FD_ name', () => {
    const cfg = parseConfig(MIN, { EV_PORT: '3000', EV_REFRESH_MINUTES: '5' });
    expect(cfg.server.port).toBe(3000);
    expect(cfg.ui.refreshMinutes).toBe(5);
    expect(deprecated(cfg.warnings)).toEqual([
      'EV_PORT is deprecated: rename it to FD_PORT',
      'EV_REFRESH_MINUTES is deprecated: rename it to FD_REFRESH_MINUTES',
    ]);
    expect(deprecated(parseConfig(MIN, { FD_PORT: '3000' }).warnings)).toEqual([]);
  });

  it('win over a conflicting FD_ value, such as the image default FD_PORT', () => {
    const cfg = parseConfig(MIN, {
      FD_HOST: '0.0.0.0',
      FD_PORT: '8080',
      EV_HOST: '127.0.0.1',
      EV_PORT: '9000',
    });
    expect(cfg.server).toMatchObject({ host: '127.0.0.1', port: 9000 });
    expect(deprecated(cfg.warnings)).toContain(
      'EV_PORT is deprecated: rename it to FD_PORT (EV_PORT overrides FD_PORT)',
    );
  });

  it('keep the login: FD_BASIC_AUTH and EV_BASIC_AUTH both enable it', () => {
    const login = { username: 'ops', password: 'pa:ss' };
    expect(parseConfig(MIN, { FD_BASIC_AUTH: 'ops:pa:ss' }).server.basicAuth).toEqual(login);
    expect(parseConfig(MIN, { EV_BASIC_AUTH: 'ops:pa:ss' }).server.basicAuth).toEqual(login);
    // A blank legacy value counts as unset, so a renamed FD_BASIC_AUTH still applies.
    expect(
      parseConfig(MIN, { EV_BASIC_AUTH: '', FD_BASIC_AUTH: 'ops:pa:ss' }).server.basicAuth,
    ).toEqual(login);
  });

  it('reject a malformed login value under the name that was set', () => {
    expect(errorOf(() => parseConfig(MIN, { FD_BASIC_AUTH: 'nocolon' })).message).toBe(
      'FD_BASIC_AUTH: expected "user:password"',
    );
    expect(errorOf(() => parseConfig(MIN, { EV_BASIC_AUTH: 'ops:' })).message).toBe(
      'EV_BASIC_AUTH: expected "user:password"',
    );
  });

  it('still drive env-only mode', () => {
    const cfg = configFromEnv({ EV_PROVIDER: 'github', EV_REPOS: 'a/b, c/d', EV_VIEW_ID: 'old' });
    expect(cfg.views[0]).toMatchObject({
      id: 'old',
      repos: [
        { owner: 'a', repo: 'b' },
        { owner: 'c', repo: 'd' },
      ],
    });
    expect(deprecated(cfg.warnings)).toHaveLength(3);
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ev-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves fixture paths relative to the config file directory', () => {
    const sub = join(dir, 'conf');
    mkdirSync(sub);
    writeFileSync(
      join(sub, 'my.yaml'),
      `
sources:
  - { id: demo, kind: fixture, path: ./data/demo.json }
  - { id: abs, kind: fixture, path: /abs/x.json }
views:
  - { id: v, source: demo, repos: [a/b] }
`,
    );
    const cfg = loadConfig({ path: join(sub, 'my.yaml'), env: {}, cwd: dir });
    expect(cfg.sources[0]!.path).toBe(resolve(sub, 'data/demo.json'));
    expect(cfg.sources[1]!.path).toBe('/abs/x.json');
  });

  it('path precedence: opts.path, then FD_CONFIG, then <cwd>/config.yaml', () => {
    const mk = (name: string, id: string) =>
      writeFileSync(
        join(dir, name),
        `sources: [{ id: gh, kind: github }]\nviews: [{ id: ${id}, source: gh, repos: [a/b] }]\n`,
      );
    mk('config.yaml', 'fromcwd');
    mk('env.yaml', 'fromenv');
    mk('opt.yaml', 'fromopt');
    expect(loadConfig({ env: {}, cwd: dir }).views[0]!.id).toBe('fromcwd');
    expect(loadConfig({ env: { FD_CONFIG: 'env.yaml' }, cwd: dir }).views[0]!.id).toBe('fromenv');
    expect(
      loadConfig({ path: 'opt.yaml', env: { FD_CONFIG: 'env.yaml' }, cwd: dir }).views[0]!.id,
    ).toBe('fromopt');
  });

  it('errors on an explicit path that does not exist', () => {
    const missing = join(dir, 'nope.yaml');
    const e = errorOf(() =>
      loadConfig({ path: missing, env: { FD_PROVIDER: 'github' }, cwd: dir }),
    );
    expect(e.message).toContain('Config file not found');
    expect(e.message).toContain(missing);
    const e2 = errorOf(() => loadConfig({ env: { FD_CONFIG: 'nope.yaml' }, cwd: dir }));
    expect(e2.message).toContain('Config file not found');
  });

  it('prefixes validation errors with the file path', () => {
    writeFileSync(join(dir, 'config.yaml'), 'sources: []\nviews: []\n');
    const e = errorOf(() => loadConfig({ env: {}, cwd: dir }));
    expect(e.message).toContain(join(dir, 'config.yaml'));
    expect(e.message).toContain('at least one source is required');
  });

  it('fails clearly with neither a file nor FD_PROVIDER', () => {
    const e = errorOf(() => loadConfig({ env: {}, cwd: dir }));
    expect(e.message).toBe(
      'No configuration found: create config.yaml (see config.example.yaml), set FD_CONFIG, or set FD_PROVIDER and FD_REPOS for env-only mode',
    );
  });

  describe('env-only mode', () => {
    it('github with the GITHUB_TOKEN fallback', () => {
      const cfg = loadConfig({
        env: { FD_PROVIDER: 'github', FD_REPOS: 'Acme/API, acme/web,', GITHUB_TOKEN: 'ghtok' },
        cwd: dir,
      });
      expect(cfg.sources).toEqual([
        {
          id: 'default',
          kind: 'github',
          baseUrl: 'https://api.github.com',
          webUrl: 'https://github.com',
          token: 'ghtok',
          path: null,
        },
      ]);
      expect(cfg.views).toHaveLength(1);
      expect(cfg.views[0]).toMatchObject({
        id: 'default',
        title: 'default',
        source: 'default',
        repos: [
          { owner: 'acme', repo: 'api' },
          { owner: 'acme', repo: 'web' },
        ],
        dependencies: { native: true, body: true, subIssues: false },
        ordering: { priorityLabels: [], mode: 'priority' },
      });
      expect(cfg.server).toEqual({ host: '0.0.0.0', port: 8080, basicAuth: null });
    });

    it('FD_TOKEN wins over GITHUB_TOKEN', () => {
      const cfg = loadConfig({
        env: { FD_PROVIDER: 'github', FD_REPOS: 'a/b', FD_TOKEN: 'ev', GITHUB_TOKEN: 'gh' },
        cwd: dir,
      });
      expect(cfg.sources[0]!.token).toBe('ev');
    });

    it('gitea with base URL, token fallback, view options and overrides', () => {
      const cfg = loadConfig({
        env: {
          FD_PROVIDER: 'gitea',
          FD_REPOS: 'team/app',
          FD_BASE_URL: 'https://gitea.example.com/',
          GITEA_TOKEN: 'gttok',
          GITHUB_TOKEN: 'ignored',
          FD_VIEW_ID: 'main',
          FD_VIEW_TITLE: 'Main view',
          FD_PRIORITY_LABELS: 'P0, P1 ,P2',
          FD_SUB_ISSUES: 'true',
          FD_PORT: '9090',
        },
        cwd: dir,
      });
      expect(cfg.sources[0]).toMatchObject({
        id: 'default',
        kind: 'gitea',
        baseUrl: 'https://gitea.example.com',
        webUrl: 'https://gitea.example.com',
        token: 'gttok',
      });
      expect(cfg.views[0]).toMatchObject({
        id: 'main',
        title: 'Main view',
        ordering: { priorityLabels: ['P0', 'P1', 'P2'] },
        dependencies: { subIssues: true },
      });
      expect(cfg.server.port).toBe(9090);
    });

    it('FD_ORDERING_MODE selects the ordering mode (default priority)', () => {
      const base = { FD_PROVIDER: 'github', FD_REPOS: 'a/b' };
      expect(loadConfig({ env: base, cwd: dir }).views[0]!.ordering.mode).toBe('priority');
      const cfg = loadConfig({ env: { ...base, FD_ORDERING_MODE: 'waves' }, cwd: dir });
      expect(cfg.views[0]!.ordering.mode).toBe('waves');
      const upper = loadConfig({ env: { ...base, FD_ORDERING_MODE: 'Priority' }, cwd: dir });
      expect(upper.views[0]!.ordering.mode).toBe('priority');
    });

    it('rejects an invalid FD_ORDERING_MODE with a readable message', () => {
      const e = errorOf(() =>
        loadConfig({
          env: { FD_PROVIDER: 'github', FD_REPOS: 'a/b', FD_ORDERING_MODE: 'fastest' },
          cwd: dir,
        }),
      );
      expect(e.message).toBe('FD_ORDERING_MODE: expected "priority" or "waves" (got "fastest")');
    });

    it('gitea without FD_BASE_URL is an error', () => {
      const e = errorOf(() =>
        loadConfig({ env: { FD_PROVIDER: 'gitea', FD_REPOS: 'a/b' }, cwd: dir }),
      );
      expect(e.message).toContain('baseUrl is required');
    });

    it('a missing FD_REPOS is an error', () => {
      const e = errorOf(() => loadConfig({ env: { FD_PROVIDER: 'github' }, cwd: dir }));
      expect(e.message).toContain('FD_REPOS');
    });

    it('rejects a bad FD_PROVIDER, FD_REPOS entry and FD_SUB_ISSUES', () => {
      expect(
        errorOf(() => loadConfig({ env: { FD_PROVIDER: 'gitlab', FD_REPOS: 'a/b' }, cwd: dir }))
          .message,
      ).toContain('FD_PROVIDER');
      expect(
        errorOf(() => loadConfig({ env: { FD_PROVIDER: 'github', FD_REPOS: 'oops' }, cwd: dir }))
          .message,
      ).toContain('invalid repo "oops"');
      expect(
        errorOf(() =>
          loadConfig({
            env: { FD_PROVIDER: 'github', FD_REPOS: 'a/b', FD_SUB_ISSUES: 'maybe' },
            cwd: dir,
          }),
        ).message,
      ).toContain('FD_SUB_ISSUES');
    });

    it('a config file takes precedence over FD_PROVIDER', () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'sources: [{ id: gh, kind: github }]\nviews: [{ id: filev, source: gh, repos: [a/b] }]\n',
      );
      const cfg = loadConfig({ env: { FD_PROVIDER: 'github', FD_REPOS: 'x/y' }, cwd: dir });
      expect(cfg.views[0]!.id).toBe('filev');
    });
  });
});

describe('config.example.yaml', () => {
  it('parses successfully', () => {
    const text = readFileSync(new URL('../../config.example.yaml', import.meta.url), 'utf8');
    const cfg = parseConfig(
      text,
      { GITHUB_TOKEN: 't', GITEA_TOKEN: 't', FD_BASIC_AUTH_PASSWORD: 'pw' },
      { baseDir: '/repo' },
    );
    expect(cfg.warnings).toEqual([]);
    expect(cfg.sources.map((s) => s.id)).toEqual(['gh', 'gt', 'demo']);
    expect(cfg.views.map((v) => v.id)).toEqual(['platform', 'self-hosted', 'demo']);
    expect(cfg.server.basicAuth).toEqual({ username: 'admin', password: 'pw' });
    expect(cfg.sources[2]!.path).toBe('/repo/test/fixtures/demo.json');
  });
});

describe('release configuration', () => {
  type Json = Record<string, any>;

  function rawConfig(): Json {
    return {
      server: { basicAuth: { username: 'admin', password: 'pw' } },
      sources: [
        {
          id: 'gt',
          kind: 'gitea',
          baseUrl: 'https://gitea.example.com',
          tokenEnv: 'GITEA_READ_TOKEN',
        },
      ],
      views: [{ id: 'v', source: 'gt', repos: ['example/app'] }],
      releases: {
        enabled: true,
        publicOrigin: 'https://forge-desk.example.com/',
        stateDir: '/var/lib/forge-desk',
        repositories: [
          {
            id: 'app',
            source: 'gt',
            repo: 'Example/App',
            origin: 'ssh://git@gitea.example.com/example/app.git',
            apiTokenFile: '/run/secrets/forge_desk_release_token',
            expectedApiUser: 'release-bot',
            ci: { workflowPath: '.gitea/workflows/validate.yaml' },
            ssh: {
              privateKeyFile: '/run/secrets/forge_desk_release_key',
              knownHostsFile: '/run/secrets/forge_desk_known_hosts',
            },
            tagger: { name: 'Forge Desk Release Bot', email: 'releases@example.com' },
          },
        ],
      },
    };
  }

  function withReleases(mutate?: (releases: Json, config: Json) => void): Json {
    const config = rawConfig();
    mutate?.(config['releases'], config);
    return config;
  }

  function releaseError(mutate?: (releases: Json, config: Json) => void): ConfigError {
    return errorOf(() => parseConfig(JSON.stringify(withReleases(mutate)), {}));
  }

  it('is disabled by default and keeps planning-only configs unchanged', () => {
    expect(parseConfig(MIN, {}).releases).toEqual({ enabled: false });
    const withoutLogin = withReleases((r) => {
      r['enabled'] = false;
    });
    delete withoutLogin['server'];
    expect(parseConfig(JSON.stringify(withoutLogin), {}).releases).toEqual({ enabled: false });
    expect(
      parseConfig(
        JSON.stringify({ sources: withoutLogin['sources'], views: withoutLogin['views'] }),
        {},
      ).releases,
    ).toEqual({ enabled: false });
    // A stale, partial release block left behind after disabling must not stop Planning.
    const partial = withReleases((r) => {
      r['enabled'] = false;
      r['repositories'] = [{ id: 'app' }];
    });
    delete partial['server'];
    expect(parseConfig(JSON.stringify(partial), {}).releases).toEqual({ enabled: false });
  });

  it('leaves environment-only deployments without release configuration', () => {
    const cfg = configFromEnv({
      FD_PROVIDER: 'gitea',
      FD_REPOS: 'example/app',
      FD_BASE_URL: 'https://gitea.example.com',
    });
    expect(cfg.releases).toEqual({ enabled: false });
  });

  it('resolves a valid opt-in release repository', () => {
    const cfg = parseConfig(JSON.stringify(withReleases()), {});
    expect(cfg.releases).toEqual({
      enabled: true,
      publicOrigin: 'https://forge-desk.example.com',
      stateDir: '/var/lib/forge-desk',
      repositories: [
        {
          id: 'app',
          source: 'gt',
          repo: { owner: 'example', repo: 'app' },
          origin: 'ssh://git@gitea.example.com/example/app.git',
          token: { kind: 'file', path: '/run/secrets/forge_desk_release_token' },
          expectedApiUser: 'release-bot',
          ci: { workflowPath: '.gitea/workflows/validate.yaml' },
          ssh: {
            privateKeyFile: '/run/secrets/forge_desk_release_key',
            knownHostsFile: '/run/secrets/forge_desk_known_hosts',
          },
          tagger: { name: 'Forge Desk Release Bot', email: 'releases@example.com' },
        },
      ],
    });
  });

  it('accepts either token selector and loopback HTTP only for a test origin', () => {
    const envToken = withReleases((r) => {
      const repo = r['repositories'][0];
      delete repo.apiTokenFile;
      repo.apiTokenEnv = 'RELEASE_TOKEN';
      r['publicOrigin'] = 'http://127.0.0.1:8080';
    });
    const cfg = parseConfig(JSON.stringify(envToken), {});
    expect(cfg.releases).toMatchObject({
      enabled: true,
      publicOrigin: 'http://127.0.0.1:8080',
      repositories: [{ token: { kind: 'env', name: 'RELEASE_TOKEN' } }],
    });
    expect(
      parseConfig(
        JSON.stringify(withReleases((r) => (r['publicOrigin'] = 'http://localhost:3000'))),
        {},
      ).releases,
    ).toMatchObject({ publicOrigin: 'http://localhost:3000' });
    // The stored origin is what a browser serializes, not the raw spelling.
    expect(
      parseConfig(
        JSON.stringify(withReleases((r) => (r['publicOrigin'] = 'HTTPS://DESK.EXAMPLE:443'))),
        {},
      ).releases,
    ).toMatchObject({ publicOrigin: 'https://desk.example' });
  });

  it('requires the application login', () => {
    expect(releaseError((_r, c) => delete c['server']).message).toContain('application login');
  });

  it('rejects an unsafe public origin', () => {
    expect(
      releaseError((r) => (r['publicOrigin'] = 'http://forge-desk.example.com')).message,
    ).toContain('loopback');
    expect(
      releaseError((r) => (r['publicOrigin'] = 'https://forge-desk.example.com/app')).message,
    ).toContain('without a path');
    expect(releaseError((r) => (r['publicOrigin'] = 'ftp://example.com')).message).toContain(
      'http://',
    );
    // A dotted prefix is a public name, not loopback.
    expect(releaseError((r) => (r['publicOrigin'] = 'http://127.evil.com')).message).toContain(
      'loopback',
    );
  });

  it('does not echo release values that may hold a credential', () => {
    const secret = 'super-secret-value';
    expect(
      releaseError(
        (r) =>
          (r['repositories'][0].origin = `ssh://git:${secret}@gitea.example.com/example/app.git`),
      ).message,
    ).not.toContain(secret);
    expect(releaseError((r) => (r['repositories'][0].apiTokenFile = secret)).message).not.toContain(
      secret,
    );
    expect(
      releaseError((r) => (r['publicOrigin'] = `https://user:${secret}@example.com`)).message,
    ).not.toContain(secret);
  });

  it('requires private absolute paths for state and secrets', () => {
    expect(releaseError((r) => delete r['stateDir']).message).toContain('stateDir');
    expect(releaseError((r) => (r['stateDir'] = 'relative/state')).message).toContain(
      'absolute path',
    );
    expect(releaseError((r) => (r['stateDir'] = '/var/lib/../lib/forge-desk')).message).toContain(
      'normalized',
    );
    expect(
      releaseError((r) => (r['repositories'][0].ssh.privateKeyFile = 'keys/release')).message,
    ).toContain('absolute path');
    expect(
      releaseError((r) => (r['repositories'][0].ssh.knownHostsFile = '/run/secrets/../x')).message,
    ).toContain('normalized');
  });

  it('requires unique repository ids bound to existing Gitea sources', () => {
    expect(releaseError((r) => (r['repositories'][0].id = 'Bad Id')).message).toContain('id');
    expect(
      releaseError((r) => r['repositories'].push({ ...r['repositories'][0] })).message,
    ).toContain('duplicate release repository id');
    expect(releaseError((r) => (r['repositories'][0].source = 'gh')).message).toContain(
      'unknown source',
    );
    expect(
      releaseError((_r, c) => {
        c['sources'][0].kind = 'github';
      }).message,
    ).toContain('gitea source');
  });

  it('requires at least one repository when enabled', () => {
    expect(releaseError((r) => (r['repositories'] = [])).message).toContain(
      'at least one release repository',
    );
  });

  it('accepts only a safe SSH origin for the configured repository', () => {
    expect(
      releaseError((r) => (r['repositories'][0].origin = 'git@gitea.example.com:example/app.git'))
        .message,
    ).toContain('ssh://');
    expect(
      releaseError(
        (r) => (r['repositories'][0].origin = 'ssh://git:pw@gitea.example.com/example/app.git'),
      ).message,
    ).toContain('password');
    expect(
      releaseError(
        (r) => (r['repositories'][0].origin = 'ssh://git@gitea.example.com/other/app.git'),
      ).message,
    ).toContain('must be /example/app');
    expect(
      releaseError((r) => (r['repositories'][0].origin = 'ssh://git@gitea.example.com/a/b/c.git'))
        .message,
    ).toContain('/owner/repo');
  });

  it('requires exactly one private token selector', () => {
    expect(
      releaseError((r) => (r['repositories'][0].apiTokenEnv = 'RELEASE_TOKEN')).message,
    ).toContain('exactly one of apiTokenFile or apiTokenEnv');
    expect(releaseError((r) => delete r['repositories'][0].apiTokenFile).message).toContain(
      'exactly one of apiTokenFile or apiTokenEnv',
    );
    expect(releaseError((r) => (r['repositories'][0].token = 'inline-secret')).message).toContain(
      'token',
    );
  });

  it('requires a designated repository workflow path', () => {
    expect(
      releaseError((r) => (r['repositories'][0].ci.workflowPath = '/etc/validate.yaml')).message,
    ).toContain('relative path');
    expect(
      releaseError((r) => (r['repositories'][0].ci.workflowPath = '../validate.yaml')).message,
    ).toContain('..');
    expect(
      releaseError((r) => (r['repositories'][0].ci.workflowPath = 'workflows/validate.sh')).message,
    ).toContain('.yml');
  });

  it('requires an explicit expected API user and a valid tagger', () => {
    expect(releaseError((r) => delete r['repositories'][0].expectedApiUser).message).toContain(
      'expectedApiUser',
    );
    expect(
      releaseError((r) => (r['repositories'][0].tagger.email = 'not-an-email')).message,
    ).toContain('email');
    expect(
      releaseError((r) => (r['repositories'][0].tagger.name = 'Bot\nInjected')).message,
    ).toContain('control characters');
    expect(
      releaseError((r) => (r['repositories'][0].tagger.email = 'bot\u0000@example.com')).message,
    ).toContain('control characters');
  });
});
