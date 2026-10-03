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

  it('EV_BASIC_AUTH overrides, splitting on the first colon', () => {
    const cfg = parseConfig(auth('    username: admin\n    password: pw'), {
      EV_BASIC_AUTH: 'bob:pa:ss',
    });
    expect(cfg.server.basicAuth).toEqual({ username: 'bob', password: 'pa:ss' });
    const plain = parseConfig(MIN, { EV_BASIC_AUTH: 'bob:pw' });
    expect(plain.server.basicAuth).toEqual({ username: 'bob', password: 'pw' });
  });

  it('rejects a malformed EV_BASIC_AUTH', () => {
    expect(errorOf(() => parseConfig(MIN, { EV_BASIC_AUTH: 'nocolon' })).message).toContain(
      'EV_BASIC_AUTH',
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

  it('EV_WEBHOOK_SECRET overrides the file, and enables webhooks without a block', () => {
    const cfg = parseConfig(hooks('  secret: inline'), { EV_WEBHOOK_SECRET: 'override' });
    expect(cfg.webhooks).toEqual({ secret: 'override' });
    expect(parseConfig(MIN, { EV_WEBHOOK_SECRET: 'only-env' }).webhooks).toEqual({
      secret: 'only-env',
    });
  });

  it('EV_WEBHOOK_SECRET also works in env-only mode', () => {
    const cfg = configFromEnv({
      EV_PROVIDER: 'github',
      EV_REPOS: 'a/b',
      EV_WEBHOOK_SECRET: 's',
    });
    expect(cfg.webhooks).toEqual({ secret: 's' });
    expect(configFromEnv({ EV_PROVIDER: 'github', EV_REPOS: 'a/b' }).webhooks).toBeNull();
  });

  it('rejects unknown keys', () => {
    expect(errorOf(() => parseConfig(hooks('  bogus: 1'), {})).message).toContain('bogus');
  });
});

describe('EV_* overrides', () => {
  it('EV_HOST, EV_PORT, EV_CACHE_TTL and EV_REFRESH_MINUTES override the file', () => {
    const yaml = `server: { host: 1.2.3.4, port: 9000 }\ncache: { ttlSeconds: 10 }\nui: { refreshMinutes: 15 }\n${MIN}`;
    const base = parseConfig(yaml, {});
    expect(base.server).toMatchObject({ host: '1.2.3.4', port: 9000 });
    expect(base.cache.ttlSeconds).toBe(10);
    expect(base.ui.refreshMinutes).toBe(15);
    const cfg = parseConfig(yaml, {
      EV_HOST: 'localhost',
      EV_PORT: '3000',
      EV_CACHE_TTL: '0',
      EV_REFRESH_MINUTES: '0',
    });
    expect(cfg.server).toMatchObject({ host: 'localhost', port: 3000 });
    expect(cfg.cache.ttlSeconds).toBe(0);
    expect(cfg.ui.refreshMinutes).toBe(0);
  });

  it('validates EV_PORT and EV_CACHE_TTL', () => {
    for (const port of ['0', '65536', 'abc', '1.5', '-1']) {
      expect(errorOf(() => parseConfig(MIN, { EV_PORT: port })).message).toContain('EV_PORT');
    }
    expect(parseConfig(MIN, { EV_PORT: '65535' }).server.port).toBe(65535);
    for (const ttl of ['-1', 'x', '2.5']) {
      expect(errorOf(() => parseConfig(MIN, { EV_CACHE_TTL: ttl })).message).toContain(
        'EV_CACHE_TTL',
      );
    }
    for (const minutes of ['-1', 'x', '2.5', '1441']) {
      expect(errorOf(() => parseConfig(MIN, { EV_REFRESH_MINUTES: minutes })).message).toContain(
        'EV_REFRESH_MINUTES',
      );
    }
    expect(parseConfig(MIN, { EV_REFRESH_MINUTES: '1440' }).ui.refreshMinutes).toBe(1440);
    expect(
      errorOf(() => parseConfig(`ui: { refreshMinutes: 1441 }\n${MIN}`, {})).message,
    ).toContain('refreshMinutes');
  });

  it('treats empty values as unset', () => {
    const cfg = parseConfig(MIN, { EV_PORT: '', EV_HOST: '  ' });
    expect(cfg.server).toMatchObject({ host: '0.0.0.0', port: 8080 });
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

  it('path precedence: opts.path, then EV_CONFIG, then <cwd>/config.yaml', () => {
    const mk = (name: string, id: string) =>
      writeFileSync(
        join(dir, name),
        `sources: [{ id: gh, kind: github }]\nviews: [{ id: ${id}, source: gh, repos: [a/b] }]\n`,
      );
    mk('config.yaml', 'fromcwd');
    mk('env.yaml', 'fromenv');
    mk('opt.yaml', 'fromopt');
    expect(loadConfig({ env: {}, cwd: dir }).views[0]!.id).toBe('fromcwd');
    expect(loadConfig({ env: { EV_CONFIG: 'env.yaml' }, cwd: dir }).views[0]!.id).toBe('fromenv');
    expect(
      loadConfig({ path: 'opt.yaml', env: { EV_CONFIG: 'env.yaml' }, cwd: dir }).views[0]!.id,
    ).toBe('fromopt');
  });

  it('errors on an explicit path that does not exist', () => {
    const missing = join(dir, 'nope.yaml');
    const e = errorOf(() =>
      loadConfig({ path: missing, env: { EV_PROVIDER: 'github' }, cwd: dir }),
    );
    expect(e.message).toContain('Config file not found');
    expect(e.message).toContain(missing);
    const e2 = errorOf(() => loadConfig({ env: { EV_CONFIG: 'nope.yaml' }, cwd: dir }));
    expect(e2.message).toContain('Config file not found');
  });

  it('prefixes validation errors with the file path', () => {
    writeFileSync(join(dir, 'config.yaml'), 'sources: []\nviews: []\n');
    const e = errorOf(() => loadConfig({ env: {}, cwd: dir }));
    expect(e.message).toContain(join(dir, 'config.yaml'));
    expect(e.message).toContain('at least one source is required');
  });

  it('fails clearly with neither a file nor EV_PROVIDER', () => {
    const e = errorOf(() => loadConfig({ env: {}, cwd: dir }));
    expect(e.message).toBe(
      'No configuration found: create config.yaml (see config.example.yaml), set EV_CONFIG, or set EV_PROVIDER and EV_REPOS for env-only mode',
    );
  });

  describe('env-only mode', () => {
    it('github with the GITHUB_TOKEN fallback', () => {
      const cfg = loadConfig({
        env: { EV_PROVIDER: 'github', EV_REPOS: 'Acme/API, acme/web,', GITHUB_TOKEN: 'ghtok' },
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

    it('EV_TOKEN wins over GITHUB_TOKEN', () => {
      const cfg = loadConfig({
        env: { EV_PROVIDER: 'github', EV_REPOS: 'a/b', EV_TOKEN: 'ev', GITHUB_TOKEN: 'gh' },
        cwd: dir,
      });
      expect(cfg.sources[0]!.token).toBe('ev');
    });

    it('gitea with base URL, token fallback, view options and overrides', () => {
      const cfg = loadConfig({
        env: {
          EV_PROVIDER: 'gitea',
          EV_REPOS: 'team/app',
          EV_BASE_URL: 'https://gitea.example.com/',
          GITEA_TOKEN: 'gttok',
          GITHUB_TOKEN: 'ignored',
          EV_VIEW_ID: 'main',
          EV_VIEW_TITLE: 'Main view',
          EV_PRIORITY_LABELS: 'P0, P1 ,P2',
          EV_SUB_ISSUES: 'true',
          EV_PORT: '9090',
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

    it('EV_ORDERING_MODE selects the ordering mode (default priority)', () => {
      const base = { EV_PROVIDER: 'github', EV_REPOS: 'a/b' };
      expect(loadConfig({ env: base, cwd: dir }).views[0]!.ordering.mode).toBe('priority');
      const cfg = loadConfig({ env: { ...base, EV_ORDERING_MODE: 'waves' }, cwd: dir });
      expect(cfg.views[0]!.ordering.mode).toBe('waves');
      const upper = loadConfig({ env: { ...base, EV_ORDERING_MODE: 'Priority' }, cwd: dir });
      expect(upper.views[0]!.ordering.mode).toBe('priority');
    });

    it('rejects an invalid EV_ORDERING_MODE with a readable message', () => {
      const e = errorOf(() =>
        loadConfig({
          env: { EV_PROVIDER: 'github', EV_REPOS: 'a/b', EV_ORDERING_MODE: 'fastest' },
          cwd: dir,
        }),
      );
      expect(e.message).toBe('EV_ORDERING_MODE: expected "priority" or "waves" (got "fastest")');
    });

    it('gitea without EV_BASE_URL is an error', () => {
      const e = errorOf(() =>
        loadConfig({ env: { EV_PROVIDER: 'gitea', EV_REPOS: 'a/b' }, cwd: dir }),
      );
      expect(e.message).toContain('baseUrl is required');
    });

    it('a missing EV_REPOS is an error', () => {
      const e = errorOf(() => loadConfig({ env: { EV_PROVIDER: 'github' }, cwd: dir }));
      expect(e.message).toContain('EV_REPOS');
    });

    it('rejects a bad EV_PROVIDER, EV_REPOS entry and EV_SUB_ISSUES', () => {
      expect(
        errorOf(() => loadConfig({ env: { EV_PROVIDER: 'gitlab', EV_REPOS: 'a/b' }, cwd: dir }))
          .message,
      ).toContain('EV_PROVIDER');
      expect(
        errorOf(() => loadConfig({ env: { EV_PROVIDER: 'github', EV_REPOS: 'oops' }, cwd: dir }))
          .message,
      ).toContain('invalid repo "oops"');
      expect(
        errorOf(() =>
          loadConfig({
            env: { EV_PROVIDER: 'github', EV_REPOS: 'a/b', EV_SUB_ISSUES: 'maybe' },
            cwd: dir,
          }),
        ).message,
      ).toContain('EV_SUB_ISSUES');
    });

    it('a config file takes precedence over EV_PROVIDER', () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'sources: [{ id: gh, kind: github }]\nviews: [{ id: filev, source: gh, repos: [a/b] }]\n',
      );
      const cfg = loadConfig({ env: { EV_PROVIDER: 'github', EV_REPOS: 'x/y' }, cwd: dir });
      expect(cfg.views[0]!.id).toBe('filev');
    });
  });
});

describe('config.example.yaml', () => {
  it('parses successfully', () => {
    const text = readFileSync(new URL('../../config.example.yaml', import.meta.url), 'utf8');
    const cfg = parseConfig(
      text,
      { GITHUB_TOKEN: 't', GITEA_TOKEN: 't', EV_BASIC_AUTH_PASSWORD: 'pw' },
      { baseDir: '/repo' },
    );
    expect(cfg.warnings).toEqual([]);
    expect(cfg.sources.map((s) => s.id)).toEqual(['gh', 'gt', 'demo']);
    expect(cfg.views.map((v) => v.id)).toEqual(['platform', 'self-hosted', 'demo']);
    expect(cfg.server.basicAuth).toEqual({ username: 'admin', password: 'pw' });
    expect(cfg.sources[2]!.path).toBe('/repo/test/fixtures/demo.json');
  });
});
