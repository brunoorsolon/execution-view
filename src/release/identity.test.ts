import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/load.js';
import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import type { AppConfig } from '../config/schema.js';
import { PlanService } from '../service/planService.js';
import { buildApp } from '../server/app.js';
import type { FetchResult, ListOptions, RepoRef } from '../core/types.js';
import { verifyReleaseIdentity } from './identity.js';
import type { ReleaseForgeFetch } from './forgeClient.js';

const RELEASE_TOKEN = 'canary_release_token_7f3a91';
const PLANNING_TOKEN = 'canary_planning_token_11bb02';
const BASE = 'https://gitea.example.test';

const RELEASE_YAML = `
server:
  basicAuth:
    username: admin
    passwordEnv: EV_BASIC_AUTH_PASSWORD
sources:
  - id: gt
    kind: gitea
    baseUrl: ${BASE}
    tokenEnv: PLANNING_TOKEN_ENV
views:
  - id: app
    source: gt
    repos: [acme/api]
releases:
  enabled: true
  publicOrigin: https://forge-desk.example.test
  stateDir: /var/lib/forge-desk
  repositories:
    - id: app
      source: gt
      repo: acme/api
      origin: ssh://git@gitea.example.test/acme/api.git
      apiTokenEnv: RELEASE_TOKEN_ENV
      expectedApiUser: release-bot
      ci:
        workflowPath: .gitea/workflows/validate.yaml
      ssh:
        privateKeyFile: /run/secrets/forge-desk-key
        knownHostsFile: /run/secrets/forge-desk-known-hosts
      tagger:
        name: Forge Desk Release Bot
        email: releases@example.test
`;

const LOGIN_PASSWORD = 'canary_login_password_2c9e';
const ENV = {
  PLANNING_TOKEN_ENV: PLANNING_TOKEN,
  RELEASE_TOKEN_ENV: RELEASE_TOKEN,
  EV_BASIC_AUTH_PASSWORD: LOGIN_PASSWORD,
};
const LOGIN_HEADER = `Basic ${Buffer.from(`admin:${LOGIN_PASSWORD}`).toString('base64')}`;

function releaseConfig(yaml: string = RELEASE_YAML, env = ENV): AppConfig {
  return parseConfig(yaml, env);
}

function runtimeFor(config: AppConfig, token = RELEASE_TOKEN): ReleaseRuntime {
  if (!config.releases.enabled) return { publicOrigin: '', stateDir: '', repositories: [] };
  return {
    publicOrigin: config.releases.publicOrigin,
    stateDir: config.releases.stateDir,
    repositories: config.releases.repositories.map((c) => ({ config: c, token })),
  };
}

interface Call {
  path: string;
  method: string;
}

type Routes = Record<string, () => Response>;

function forge(routes: Routes): { fetch: ReleaseForgeFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: ReleaseForgeFetch = (input, init) => {
    const path = new URL(input).pathname;
    calls.push({ path, method: init.method ?? 'GET' });
    const route = routes[path];
    return Promise.resolve(route ? route() : new Response('not found', { status: 404 }));
  };
  return { fetch, calls };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function identityRoutes(overrides: Partial<Record<string, () => Response>> = {}): Routes {
  return {
    '/api/v1/user': () => json({ id: 42, login: 'release-bot' }),
    '/api/v1/version': () => json({ version: '1.26.1' }),
    '/api/v1/repos/acme/api': () =>
      json({
        id: 1001,
        name: 'api',
        full_name: 'Acme/API',
        default_branch: 'main',
        ssh_url: 'git@gitea.example.test:acme/api.git',
      }),
    ...overrides,
  };
}

describe('verifyReleaseIdentity', () => {
  it('proves account, version and repository identity with read-only requests', async () => {
    const config = releaseConfig();
    const { fetch, calls } = forge(identityRoutes());

    const result = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch,
    });

    expect(result).toEqual({
      ok: true,
      identity: {
        serverVersion: '1.26.1',
        account: { forge: 'gitea', baseUrl: BASE, login: 'release-bot', forgeUserId: 42 },
        repository: {
          repositoryId: 'app',
          forge: 'gitea',
          baseUrl: BASE,
          owner: 'acme',
          repo: 'api',
          forgeRepositoryId: 1001,
          defaultBranch: 'main',
        },
      },
    });
    expect(calls).toEqual([
      { path: '/api/v1/user', method: 'GET' },
      { path: '/api/v1/version', method: 'GET' },
      { path: '/api/v1/repos/acme/api', method: 'GET' },
    ]);
    // Read-only capability: no tag or release request of any kind.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.some((c) => /releases|\/tags/.test(c.path))).toBe(false);
    // Returned capability data never carries a credential.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(RELEASE_TOKEN);
    expect(serialized).not.toContain(PLANNING_TOKEN);
  });

  it('blocks a token that authenticates as another account', async () => {
    const config = releaseConfig();
    const { fetch } = forge(
      identityRoutes({ '/api/v1/user': () => json({ id: 9, login: 'someone-else' }) }),
    );
    const result = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a blocker');
    expect(result.blocker.code).toBe('account-mismatch');
    expect(result.blocker.message).not.toContain(RELEASE_TOKEN);
  });

  it('blocks Forgejo and other Gitea versions before reading a repository', async () => {
    const config = releaseConfig();
    for (const [version, code] of [
      ['11.0.0+forgejo1', 'unsupported-forge'],
      ['1.25.0', 'unsupported-version'],
      ['1.26.1+build2', 'unsupported-version'],
    ] as const) {
      const { fetch, calls } = forge(
        identityRoutes({ '/api/v1/version': () => json({ version }) }),
      );
      const result = await verifyReleaseIdentity({
        config,
        runtime: runtimeFor(config),
        repositoryId: 'app',
        fetch,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a blocker');
      expect(result.blocker.code).toBe(code);
      expect(calls.map((c) => c.path)).not.toContain('/api/v1/repos/acme/api');
    }
  });

  it('blocks a repository slug or numeric identity that does not match the allowlist', async () => {
    const config = releaseConfig();
    const wrongSlug = forge(
      identityRoutes({
        '/api/v1/repos/acme/api': () => json({ id: 1001, full_name: 'acme/other' }),
      }),
    );
    const slugResult = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch: wrongSlug.fetch,
    });
    expect(slugResult.ok).toBe(false);
    if (slugResult.ok) throw new Error('expected a blocker');
    expect(slugResult.blocker.code).toBe('repository-mismatch');

    const noId = forge(
      identityRoutes({ '/api/v1/repos/acme/api': () => json({ full_name: 'acme/api' }) }),
    );
    const idResult = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch: noId.fetch,
    });
    expect(idResult.ok).toBe(false);
    if (idResult.ok) throw new Error('expected a blocker');
    expect(idResult.blocker.code).toBe('malformed-response');
  });

  it('treats an invisible repository as unproven, not as absence', async () => {
    const config = releaseConfig();
    const { fetch } = forge(
      identityRoutes({ '/api/v1/repos/acme/api': () => new Response('', { status: 404 }) }),
    );
    const result = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a blocker');
    expect(result.blocker.code).toBe('repository-mismatch');
  });

  it('refuses a token shared with a planning source before any request', async () => {
    const config = releaseConfig();
    const { fetch, calls } = forge(identityRoutes());
    const result = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config, PLANNING_TOKEN),
      repositoryId: 'app',
      fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a blocker');
    expect(result.blocker.code).toBe('shared-planning-token');
    expect(calls).toHaveLength(0);
  });

  it('blocks a forge outage or redirect as a redacted blocker, never a throw', async () => {
    const config = releaseConfig();
    const outage: ReleaseForgeFetch = () =>
      Promise.reject(new TypeError(`fetch failed for token ${RELEASE_TOKEN}`));
    const outageResult = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch: outage,
    });
    expect(outageResult.ok).toBe(false);
    if (outageResult.ok) throw new Error('expected a blocker');
    expect(outageResult.blocker.code).toBe('network-error');
    expect(outageResult.blocker.message).not.toContain(RELEASE_TOKEN);

    const redirected = forge(
      identityRoutes({
        '/api/v1/user': () =>
          new Response('', { status: 307, headers: { location: 'https://evil.test/collect' } }),
      }),
    );
    const redirectResult = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch: redirected.fetch,
    });
    expect(redirectResult.ok).toBe(false);
    if (redirectResult.ok) throw new Error('expected a blocker');
    expect(redirectResult.blocker.code).toBe('redirect-refused');
    expect(redirected.calls).toHaveLength(1);
  });

  it('blocks an SSH origin that is not the authenticated repository endpoint', async () => {
    const cases: Array<[string, string]> = [
      ['ssh://git@gitea-mirror.test/acme/api.git', 'git@gitea.example.test:acme/api.git'],
      ['ssh://git@gitea.example.test:2222/acme/api.git', 'git@gitea.example.test:acme/api.git'],
      ['ssh://git@gitea.example.test/acme/api.git', 'git@gitea.example.test:acme/other.git'],
    ];
    for (const [origin, sshUrl] of cases) {
      const config = releaseConfig(
        RELEASE_YAML.replace('ssh://git@gitea.example.test/acme/api.git', origin),
      );
      const { fetch } = forge(
        identityRoutes({
          '/api/v1/repos/acme/api': () =>
            json({
              id: 1001,
              full_name: 'acme/api',
              default_branch: 'main',
              ssh_url: sshUrl,
            }),
        }),
      );
      const result = await verifyReleaseIdentity({
        config,
        runtime: runtimeFor(config),
        repositoryId: 'app',
        fetch,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a blocker');
      expect(result.blocker.code).toBe('ssh-origin-mismatch');
    }
  });

  it('accepts a configured port that matches the reported SSH endpoint', async () => {
    const config = releaseConfig(
      RELEASE_YAML.replace(
        'ssh://git@gitea.example.test/acme/api.git',
        'ssh://git@gitea.example.test:2222/acme/api.git',
      ),
    );
    const { fetch } = forge(
      identityRoutes({
        '/api/v1/repos/acme/api': () =>
          json({
            id: 1001,
            full_name: 'acme/api',
            default_branch: 'main',
            ssh_url: 'ssh://git@gitea.example.test:2222/acme/api.git',
          }),
      }),
    );
    const result = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch,
    });
    expect(result.ok).toBe(true);
  });

  it('blocks disabled releases and an unknown repository id', async () => {
    const disabled = parseConfig(
      `
sources:
  - id: gt
    kind: gitea
    baseUrl: ${BASE}
views:
  - id: app
    source: gt
    repos: [acme/api]
`,
      ENV,
    );
    const { fetch } = forge(identityRoutes());
    const disabledResult = await verifyReleaseIdentity({
      config: disabled,
      runtime: runtimeFor(disabled),
      repositoryId: 'app',
      fetch,
    });
    expect(disabledResult.ok).toBe(false);
    if (disabledResult.ok) throw new Error('expected a blocker');
    expect(disabledResult.blocker.code).toBe('release-disabled');

    const config = releaseConfig();
    const unknownResult = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'other',
      fetch,
    });
    expect(unknownResult.ok).toBe(false);
    if (unknownResult.ok) throw new Error('expected a blocker');
    expect(unknownResult.blocker.code).toBe('unknown-repository');
  });

  it('redacts a forge value that echoes the release token', async () => {
    const config = releaseConfig();
    const echoLogin = forge(
      identityRoutes({ '/api/v1/user': () => json({ id: 42, login: RELEASE_TOKEN }) }),
    );
    const loginResult = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch: echoLogin.fetch,
    });
    expect(loginResult.ok).toBe(false);
    if (loginResult.ok) throw new Error('expected a blocker');
    expect(loginResult.blocker.message).not.toContain(RELEASE_TOKEN);

    const echoVersion = forge(
      identityRoutes({ '/api/v1/version': () => json({ version: RELEASE_TOKEN }) }),
    );
    const versionResult = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch: echoVersion.fetch,
    });
    expect(versionResult.ok).toBe(false);
    if (versionResult.ok) throw new Error('expected a blocker');
    expect(versionResult.blocker.message).not.toContain(RELEASE_TOKEN);
  });

  it('returns the reported default branch exactly and rejects oversized evidence', async () => {
    const config = releaseConfig();
    const branch = 'a'.repeat(200);
    const exact = forge(
      identityRoutes({
        '/api/v1/repos/acme/api': () =>
          json({
            id: 1001,
            full_name: 'acme/api',
            default_branch: branch,
            ssh_url: 'git@gitea.example.test:acme/api.git',
          }),
      }),
    );
    const ok = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch: exact.fetch,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('expected a verified identity');
    expect(ok.identity.repository.defaultBranch).toBe(branch);

    const tooLong = forge(
      identityRoutes({
        '/api/v1/repos/acme/api': () =>
          json({
            id: 1001,
            full_name: 'acme/api',
            default_branch: 'a'.repeat(201),
            ssh_url: 'git@gitea.example.test:acme/api.git',
          }),
      }),
    );
    const blocked = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch: tooLong.fetch,
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('expected a blocker');
    expect(blocked.blocker.code).toBe('malformed-response');
  });

  it('leaves Planning available while the forge is down', async () => {
    const config = releaseConfig();
    const service = new PlanService(config, {
      providerFor: () => ({
        kind: 'gitea',
        listOpenIssues: (_repo: RepoRef, _options: ListOptions): Promise<FetchResult> =>
          Promise.reject(new TypeError('forge is down')),
        getIssue: () => Promise.resolve(null),
      }),
    });
    const app = buildApp(config, service);
    try {
      const identity = await verifyReleaseIdentity({
        config,
        runtime: runtimeFor(config),
        repositoryId: 'app',
        fetch: () => Promise.reject(new TypeError('forge is down')),
      });
      expect(identity.ok).toBe(false);

      const health = await app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
      const views = await app.inject({
        method: 'GET',
        url: '/api/views',
        headers: { authorization: LOGIN_HEADER },
      });
      expect(views.statusCode).toBe(200);
      expect(views.json()).toEqual([
        { id: 'app', title: 'app', source: 'gt', kind: 'gitea', repos: ['acme/api'] },
      ]);
    } finally {
      await app.close();
    }
  });
});
