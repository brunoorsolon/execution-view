import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/load.js';
import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import type { AppConfig, ResolvedReleaseRepository } from '../config/schema.js';
import { contentHash } from '../core/hash.js';
import {
  RELEASE_CONTRACT_VERSION,
  RELEASE_STATE_SCHEMA_VERSION,
  type ReleaseJob,
  type ReleasePlanPayload,
} from '../core/release.js';
import { createReleaseNotes, releasePlanDigest } from '../core/releaseDigest.js';
import type { ReleaseIdentityCheck } from '../release/identity.js';
import { ReleasePreparationError, type ReleasePreparation } from '../release/preparation.js';
import { repositoryOperationKey } from '../service/releaseOwnership.js';
import { ReleaseStateStore } from '../service/releaseState.js';
import { PlanService } from '../service/planService.js';
import { buildApp } from './app.js';

const DEMO_CONFIG = fileURLToPath(new URL('../../config.demo.yaml', import.meta.url));
const PUBLIC_HOST = 'forge-desk.example.com';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const LOGIN = { username: 'admin', password: 's3cret' };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function repository(id = 'app'): ResolvedReleaseRepository {
  return {
    id,
    source: 'gt',
    repo: { owner: 'example', repo: 'app' },
    origin: 'ssh://git@gitea.example.com/example/app.git',
    token: { kind: 'file', path: '/run/secrets/release-token' },
    expectedApiUser: 'release-bot',
    ci: { workflowPath: '.gitea/workflows/validate.yaml' },
    ssh: {
      privateKeyFile: '/run/secrets/release-key',
      knownHostsFile: '/run/secrets/known-hosts',
    },
    tagger: { name: 'Release Bot', email: 'releases@example.com' },
  };
}

function runtime(repositories = [repository()]): ReleaseRuntime {
  return {
    publicOrigin: PUBLIC_ORIGIN,
    stateDir: '/var/lib/forge-desk',
    repositories: repositories.map((config) => ({ config, token: `token-${config.id}-secret` })),
  };
}

function identity(id = 'app'): ReleaseIdentityCheck {
  return {
    ok: true,
    identity: {
      serverVersion: '1.26.1',
      account: {
        forge: 'gitea',
        baseUrl: 'https://gitea.example.com',
        login: 'release-bot',
        forgeUserId: 7,
      },
      repository: {
        repositoryId: id,
        forge: 'gitea',
        baseUrl: 'https://gitea.example.com',
        owner: 'example',
        repo: 'app',
        forgeRepositoryId: 42,
        defaultBranch: 'main',
      },
      ssh: { user: 'git', host: 'gitea.example.com', port: '22', path: 'example/app' },
    },
  };
}

function config(releasesEnabled = true, repositories = [repository()]): AppConfig {
  const cfg = loadConfig({ path: DEMO_CONFIG, env: {} });
  cfg.server.basicAuth = { ...LOGIN };
  cfg.sources.push({
    id: 'gt',
    kind: 'gitea',
    baseUrl: 'https://gitea.example.com',
    webUrl: 'https://gitea.example.com',
    token: null,
    path: null,
  });
  cfg.releases = releasesEnabled
    ? {
        enabled: true,
        publicOrigin: PUBLIC_ORIGIN,
        stateDir: '/var/lib/forge-desk',
        repositories,
      }
    : { enabled: false };
  return cfg;
}

interface SetupOptions {
  releasesEnabled?: boolean;
  repositories?: ResolvedReleaseRepository[];
  runtime?: ReleaseRuntime;
  accepting?: boolean;
  verify?: (opts: { repositoryId: string }) => Promise<ReleaseIdentityCheck>;
  mount?: boolean;
  webhookSecret?: string;
  api?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const cfg = config(opts.releasesEnabled ?? true, opts.repositories ?? [repository()]);
  if (opts.webhookSecret !== undefined) cfg.webhooks = { secret: opts.webhookSecret };
  const loaded = opts.runtime ?? runtime(opts.repositories ?? [repository()]);
  const verify = vi.fn(
    opts.verify ??
      (({ repositoryId }: { repositoryId: string }) => Promise.resolve(identity(repositoryId))),
  );
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ev-release-state-'));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const store = new ReleaseStateStore({ stateDir });
  const prepare = vi.fn(async () => ({
    jobId: 'prepare-test',
    kind: 'prepare' as const,
    planId: null,
    planDigest: null,
    state: 'queued' as const,
    step: null,
    remote: { tag: 'unknown' as const, release: 'unknown' as const },
    errorCode: null,
  }));
  const webDir = mkdtempSync(path.join(tmpdir(), 'ev-release-web-'));
  cleanups.push(() => rmSync(webDir, { recursive: true, force: true }));
  const app: FastifyInstance = buildApp(cfg, new PlanService(cfg), {
    webDir,
    ...(opts.mount === false
      ? {}
      : {
          releases: {
            runtime: loaded,
            gate: { accepting: opts.accepting ?? true },
            ...(opts.api
              ? { store, preparation: { prepare } as unknown as ReleasePreparation }
              : {}),
            verifyIdentity: verify,
          },
        }),
  });
  cleanups.push(() => app.close());
  return { app, cfg, verify, store, prepare };
}

function planPayload(repositoryId = 'app'): ReleasePlanPayload {
  return {
    contractVersion: RELEASE_CONTRACT_VERSION,
    stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION,
    repository: {
      repositoryId,
      forge: 'gitea',
      baseUrl: 'https://gitea.example.com',
      owner: 'example',
      repo: 'app',
      forgeRepositoryId: 42,
      defaultBranch: 'main',
    },
    account: {
      forge: 'gitea',
      baseUrl: 'https://gitea.example.com',
      login: 'release-bot',
      forgeUserId: 7,
    },
    tagger: { name: 'Release Bot', email: 'releases@example.com' },
    candidate: { commit: 'a'.repeat(40), branch: 'main' },
    baseline: { tag: null, commit: null, stableTags: [] },
    ci: {
      workflowPath: '.gitea/workflows/validate.yaml',
      runId: 123,
      headCommit: 'a'.repeat(40),
      branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    },
    notes: createReleaseNotes('Release v0.1.0\n', 'file'),
    title: 'v0.1.0',
    tagName: 'v0.1.0',
    actions: [
      { kind: 'create-tag', tag: 'v0.1.0' },
      { kind: 'create-release', tag: 'v0.1.0' },
    ],
    warnings: [],
    tag: { state: 'absent', name: 'v0.1.0', commit: null, objectId: null, tagger: null },
    release: {
      state: 'absent',
      tag: null,
      title: null,
      notesDigest: null,
      draft: null,
      prerelease: null,
      author: null,
      assets: null,
    },
  };
}

function basic(): string {
  return `Basic ${Buffer.from(`${LOGIN.username}:${LOGIN.password}`).toString('base64')}`;
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  return String(res.headers['set-cookie']).split(';')[0] as string;
}

async function login(app: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    payload: `username=${LOGIN.username}&password=${LOGIN.password}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(res.statusCode).toBe(303);
  const cookie = cookieOf(res);
  const session = await app.inject({ url: '/api/session', headers: { cookie } });
  return { cookie, csrf: session.json().csrfToken as string };
}

/** A browser request from the configured public origin. */
function browser(cookie: string, extra: Record<string, string> = {}) {
  return { cookie, host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, ...extra };
}

describe('release routes exist only for an enabled, owned runtime', () => {
  it('does not register release routes when releases are disabled', async () => {
    const { app, verify } = setup({ releasesEnabled: false });
    for (const headers of [
      { authorization: basic() },
      { authorization: basic(), host: PUBLIC_HOST },
    ]) {
      for (const request of [
        { url: '/api/releases/repositories' },
        { method: 'POST' as const, url: '/api/releases/repositories/app/prepare' },
        { url: '/api/releases/repositories/app/jobs' },
        { url: '/api/releases/plans/plan-1' },
        { url: '/api/releases/jobs/job-1' },
      ]) {
        const res = await app.inject({ ...request, headers });
        expect(res.statusCode, JSON.stringify({ headers, request })).toBe(404);
      }
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not register release routes without the loaded runtime', async () => {
    const { app } = setup({ mount: false });
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: { authorization: basic() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('keeps /healthz liveness-only and unauthenticated', async () => {
    const { app } = setup();
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('release authentication', () => {
  it('rejects a request with no application credentials', async () => {
    const { app, verify } = setup();
    const res = await app.inject({ url: '/api/releases/repositories' });
    expect(res.statusCode).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it('accepts an explicit Authorization header for a CLI caller without session cookies', async () => {
    const { app } = setup();
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: { authorization: basic() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects a wrong CLI Authorization header', async () => {
    const { app } = setup();
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: {
        authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a foreign Origin even when an Authorization header authenticates the caller', async () => {
    const { app } = setup();
    for (const method of ['GET', 'POST']) {
      const res = await app.inject({
        method: method as 'GET' | 'POST',
        url: '/api/releases/repositories',
        headers: { authorization: basic(), host: PUBLIC_HOST, origin: 'https://evil.example.com' },
      });
      expect(res.statusCode, method).toBe(403);
      expect(res.json().code, method).toBe('forbidden-origin');
    }
    // An origin-less CLI call and a same-origin browser-style call still pass.
    for (const headers of [
      { authorization: basic() },
      { authorization: basic(), origin: PUBLIC_ORIGIN },
    ]) {
      const res = await app.inject({ url: '/api/releases/repositories', headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(200);
    }
  });

  it('refuses a request that mixes a session cookie with an Authorization header', async () => {
    const { app } = setup();
    const { cookie } = await login(app);
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: { cookie, authorization: basic(), host: PUBLIC_HOST },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('mixed-credentials');
  });

  it('accepts a browser session from the configured public Host and Origin', async () => {
    const { app } = setup();
    const { cookie } = await login(app);
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: browser(cookie),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a browser request whose Host is not the configured public host', async () => {
    const { app } = setup();
    const { cookie } = await login(app);
    for (const host of ['evil.example.com', `${PUBLIC_HOST}:8443`, undefined]) {
      const res = await app.inject({
        url: '/api/releases/repositories',
        headers: { cookie, origin: PUBLIC_ORIGIN, ...(host === undefined ? {} : { host }) },
      });
      expect(res.statusCode, String(host)).toBe(403);
      expect(res.json().code, String(host)).toBe('forbidden-origin');
    }
  });

  it('ignores arbitrary forwarding headers when deciding the public host', async () => {
    const { app } = setup();
    const { cookie } = await login(app);
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: {
        cookie,
        host: 'internal.local:3000',
        origin: PUBLIC_ORIGIN,
        'x-forwarded-host': PUBLIC_HOST,
        'x-forwarded-proto': 'https',
        'x-forwarded-origin': PUBLIC_ORIGIN,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden-origin');
  });

  it('rejects a foreign browser Origin', async () => {
    const { app } = setup();
    const { cookie } = await login(app);
    for (const origin of ['https://evil.example.com', 'null', `${PUBLIC_ORIGIN}/path`]) {
      const res = await app.inject({
        url: '/api/releases/repositories',
        headers: { cookie, host: PUBLIC_HOST, origin },
      });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json().code, origin).toBe('forbidden-origin');
    }
  });
});

describe('release CSRF gate', () => {
  it('rejects a browser mutation without Origin or CSRF proof', async () => {
    const { app } = setup();
    const { cookie, csrf } = await login(app);
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories',
      headers: { cookie, host: PUBLIC_HOST },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json().code).toBe('forbidden-origin');

    const noToken = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories',
      headers: browser(cookie),
    });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().code).toBe('missing-csrf');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories',
      headers: browser(cookie, { 'x-csrf-token': `${csrf}x` }),
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().code).toBe('invalid-csrf');
  });

  it('rejects another session CSRF token', async () => {
    const { app } = setup();
    const first = await login(app);
    const second = await login(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories',
      headers: browser(first.cookie, { 'x-csrf-token': second.csrf }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('invalid-csrf');
  });

  it.each(['/api/releases/repositories', '/api/releases/plans/test/publish'])(
    'does not expose publication through a proven browser mutation at %s',
    async (url) => {
      const { app } = setup();
      const { cookie, csrf } = await login(app);
      const res = await app.inject({
        method: 'POST',
        url,
        headers: browser(cookie, { 'x-csrf-token': csrf }),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found' });
    },
  );

  it('does not let a webhook signature authenticate a release request', async () => {
    const { app } = setup({ webhookSecret: 'webhook-secret' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories',
      headers: {
        host: PUBLIC_HOST,
        'x-gitea-signature': 'a'.repeat(64),
        'x-hub-signature-256': `sha256=${'a'.repeat(64)}`,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('leaves the planning API usable for a session without release proof', async () => {
    const { app } = setup();
    const { cookie } = await login(app);
    const res = await app.inject({ url: '/api/views', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });
});

describe('release repository capability', () => {
  it('reports only configured ids, display identity, capability and blockers', async () => {
    const { app } = setup();
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: { authorization: basic() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: 'app',
        repo: 'example/app',
        source: 'gt',
        forge: 'https://gitea.example.com/',
        capability: 'available',
        blockers: [],
      },
    ]);
    for (const secret of ['token-app-secret', '/run/secrets', '/var/lib/forge-desk']) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('reports a forge outage as a repository blocker without failing the request', async () => {
    const { app } = setup({
      verify: () =>
        Promise.resolve({
          ok: false,
          blocker: { code: 'network-error', message: 'GET /api/v1/user failed: fetch failed' },
        }),
    });
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: { authorization: basic() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].capability).toBe('blocked');
    expect(res.json()[0].blockers).toEqual([
      { code: 'network-error', message: 'GET /api/v1/user failed: fetch failed' },
    ]);
  });

  it('reports repositories independently', async () => {
    const repositories = [repository('app'), repository('site')];
    const { app } = setup({
      repositories,
      runtime: runtime(repositories),
      verify: ({ repositoryId }) =>
        Promise.resolve(
          repositoryId === 'app'
            ? identity('app')
            : {
                ok: false,
                blocker: {
                  code: 'account-mismatch',
                  message: 'the release token names another account',
                },
              },
        ),
    });
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: { authorization: basic() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: { id: string; capability: string }) => [r.id, r.capability])).toEqual(
      [
        ['app', 'available'],
        ['site', 'blocked'],
      ],
    );
  });

  it('reports execution unavailable while this process is not the owner, without checking a forge', async () => {
    const { app, verify } = setup({ accepting: false });
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: { authorization: basic() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].capability).toBe('blocked');
    expect(res.json()[0].blockers[0].code).toBe('release-unavailable');
    expect(verify).not.toHaveBeenCalled();
  });

  it('starts preparation only for an allowlisted id and exposes bounded read routes', async () => {
    const { app, prepare, store } = setup({ api: true });
    const headers = { authorization: basic(), host: PUBLIC_HOST };
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories/app/prepare',
      headers,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({
      jobId: 'prepare-test',
      statusUrl: '/api/releases/jobs/prepare-test',
    });
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(prepare).toHaveBeenCalledWith('app');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories/other/prepare',
      headers,
    });
    expect(unknown.statusCode).toBe(404);
    expect(prepare).toHaveBeenCalledTimes(1);

    const history = await app.inject({
      url: '/api/releases/repositories/app/jobs?limit=2',
      headers,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual({ items: [], limit: 2, offset: 0, total: 0 });

    const invalidPage = await app.inject({
      url: '/api/releases/repositories/app/jobs?limit=1000',
      headers,
    });
    expect(invalidPage.statusCode).toBe(400);
    expect(invalidPage.json().code).toBe('invalid-request');

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories/app/prepare',
      headers,
      payload: {},
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json().code).toBe('invalid-request');

    const unsupportedType = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories/app/prepare',
      headers: { ...headers, 'content-type': 'text/plain' },
      payload: 'unexpected',
    });
    expect(unsupportedType.statusCode).toBe(400);
    expect(unsupportedType.json().code).toBe('invalid-request');
    expect(prepare).toHaveBeenCalledTimes(1);

    const planBody = planPayload();
    const plan = {
      planId: 'plan-test',
      digest: releasePlanDigest(planBody),
      approvalDeadline: '2026-10-22T12:00:00.000Z',
      payload: planBody,
    };
    store.writePlan(plan);
    const key = {
      forge: 'gitea' as const,
      baseUrl: 'https://gitea.example.com',
      owner: 'example',
      repo: 'app',
    };
    const prefix = `prepare-${contentHash(repositoryOperationKey(key)).slice(0, 32)}-`;
    const makeJob = (suffix: string): ReleaseJob => ({
      jobId: `${prefix}${suffix}`,
      kind: 'prepare',
      planId: plan.planId,
      planDigest: plan.digest,
      state: 'complete',
      step: 'finished',
      remote: { tag: 'absent', release: 'absent' },
      errorCode: null,
    });
    const newest = makeJob('z-job');
    const older = makeJob('a-job');
    store.writeJob(newest);
    store.writeJob(older);

    const storedPlan = await app.inject({ url: '/api/releases/plans/plan-test', headers });
    expect(storedPlan.statusCode).toBe(200);
    expect(storedPlan.json()).toEqual(plan);
    expect(storedPlan.json().payload.notes.text).toBe('Release v0.1.0\n');

    const storedJob = await app.inject({ url: `/api/releases/jobs/${newest.jobId}`, headers });
    expect(storedJob.statusCode).toBe(200);
    expect(storedJob.json()).toEqual(newest);

    const otherBody = planPayload('other');
    const otherPlan = {
      planId: 'plan-other',
      digest: releasePlanDigest(otherBody),
      approvalDeadline: '2026-10-22T12:00:00.000Z',
      payload: otherBody,
    };
    store.writePlan(otherPlan);
    store.writeJob({
      jobId: 'foreign-job',
      kind: 'publish',
      planId: otherPlan.planId,
      planDigest: otherPlan.digest,
      state: 'queued',
      step: null,
      remote: { tag: 'unknown', release: 'unknown' },
      errorCode: null,
    });
    rmSync(path.join(store.stateDir, 'plans', 'plan-other.json'));

    const page = await app.inject({
      url: '/api/releases/repositories/app/jobs?limit=1&offset=1',
      headers,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ items: [older], limit: 1, offset: 1, total: 2 });

    const hiddenPlan = await app.inject({ url: '/api/releases/plans/plan-other', headers });
    expect(hiddenPlan.statusCode).toBe(404);
    expect(hiddenPlan.json().code).toBe('not-found');

    for (const url of [
      '/api/releases/plans/plan-test',
      `/api/releases/jobs/${newest.jobId}`,
      '/api/releases/repositories/app/jobs',
    ]) {
      const unauthenticated = await app.inject({ url });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json().code).toBe('not-authenticated');
      expect(unauthenticated.headers['cache-control']).toBe('no-store');
    }

    const missingPlan = await app.inject({ url: '/api/releases/plans/missing', headers });
    expect(missingPlan.statusCode).toBe(404);
    expect(missingPlan.json().code).toBe('not-found');
    expect(missingPlan.headers['cache-control']).toBe('no-store');
  });

  it('redacts private state paths from persisted job and history diagnostics', async () => {
    const { app, store } = setup({ api: true });
    const key = {
      forge: 'gitea' as const,
      baseUrl: 'https://gitea.example.com',
      owner: 'example',
      repo: 'app',
    };
    const jobId = `prepare-${contentHash(repositoryOperationKey(key)).slice(0, 32)}-unsafe`;
    store.writeJob({
      jobId,
      kind: 'prepare',
      planId: null,
      planDigest: null,
      state: 'blocked',
      step: 'finished',
      remote: { tag: 'unknown', release: 'unknown' },
      errorCode: 'repository-ineligible',
      blocker: {
        code: 'git-unsafe-cache',
        message: 'release path "/var/lib/forge-desk/checkout/app.git" is not private',
      },
    });
    const headers = { authorization: basic(), host: PUBLIC_HOST };
    const job = await app.inject({ url: `/api/releases/jobs/${jobId}`, headers });
    const history = await app.inject({ url: '/api/releases/repositories/app/jobs', headers });
    for (const response of [job, history]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('/var/lib/forge-desk');
      expect(response.body).toContain('***');
    }
  });

  it('returns stable conflicts and unavailable errors for rejected preparation', async () => {
    const { app, prepare } = setup({ api: true });
    const headers = { authorization: basic(), host: PUBLIC_HOST };
    prepare.mockRejectedValueOnce(
      new ReleasePreparationError('repository-ineligible', 'repository is busy or ineligible'),
    );
    const ineligible = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories/app/prepare',
      headers,
    });
    expect(ineligible.statusCode).toBe(409);
    expect(ineligible.json().code).toBe('repository-ineligible');

    const unavailable = setup({ api: true, accepting: false });
    const rejected = await unavailable.app.inject({
      method: 'POST',
      url: '/api/releases/repositories/app/prepare',
      headers,
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().code).toBe('execution-unavailable');
    expect(unavailable.prepare).not.toHaveBeenCalled();
  });

  it('scrubs a blocker that echoes a token or a private path', async () => {
    const { app } = setup({
      verify: () =>
        Promise.resolve({
          ok: false,
          blocker: {
            code: 'malformed-response',
            message:
              'token token-app-secret at /var/lib/forge-desk with /run/secrets/release-key was rejected',
          },
        }),
    });
    const res = await app.inject({
      url: '/api/releases/repositories',
      headers: { authorization: basic() },
    });
    expect(res.statusCode).toBe(200);
    for (const secret of ['token-app-secret', '/var/lib/forge-desk', '/run/secrets/release-key']) {
      expect(res.body).not.toContain(secret);
    }
    expect(res.json()[0].blockers[0].message).toContain('***');
  });
});
