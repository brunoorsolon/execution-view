import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config/load.js';
import { PlanService } from '../service/planService.js';
import { buildApp } from '../server/app.js';
import { startServer } from '../server/index.js';
import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import type { ReleaseJob, ReleasePlan } from '../core/release.js';
import { releasePlanDigest } from '../core/releaseDigest.js';
import { acquireReleaseOwnership, type ReleaseOwnership } from '../service/releaseOwnership.js';
import { ReleaseStateStore } from '../service/releaseState.js';
import { ReleasePreparation } from './preparation.js';
import { ReleaseApproval } from './approval.js';
import { ReleaseReconciliation } from './reconciliation.js';
import { ReleasePublication } from './publication.js';

const PATH = process.env['PATH'];
const NOTES = '# Changes\n\n- Exact committed bytes: é\n';
const TOKEN = 'release_canary_93_do_not_persist';
const BASE = 'https://gitea.example.test';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  process.env['PATH'] = PATH;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Actual Author',
      GIT_AUTHOR_EMAIL: 'author@example.test',
      GIT_COMMITTER_NAME: 'Actual Author',
      GIT_COMMITTER_EMAIL: 'author@example.test',
    },
  }).trim();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fixture(
  options: { baseline?: boolean; sameCandidate?: boolean; notes?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'preparation-93-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  const stateDir = join(root, 'state');
  mkdirSync(work);
  mkdirSync(stateDir, { mode: 0o700 });
  git(work, 'init', '--initial-branch=main', '--quiet');
  mkdirSync(join(work, '.gitea/workflows'), { recursive: true });
  writeFileSync(join(work, '.gitea/workflows/validate.yaml'), 'name: validate\non: push\n');
  writeFileSync(join(work, 'RELEASE_NOTES.md'), options.notes ?? NOTES);
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'Initial');
  if (options.baseline) git(work, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  if (!options.sameCandidate) {
    writeFileSync(join(work, 'next.txt'), 'next\n');
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', 'Next');
  }
  const commit = git(work, 'rev-parse', 'HEAD');
  git(root, 'clone', '--bare', '--quiet', work, remote);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sshLog = join(root, 'ssh.log');
  writeFileSync(sshLog, '');
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${sshLog}'\nfor arg do last=$arg; done\ncase "$last" in *git-upload-pack*) exec git-upload-pack '${remote}';; *) exit 91;; esac\n`,
    { mode: 0o755 },
  );
  process.env['PATH'] = `${bin}:${PATH}`;
  const configYaml = `
server:
  basicAuth: {username: admin, passwordEnv: PASSWORD}
sources:
  - {id: gt, kind: gitea, baseUrl: ${BASE}, tokenEnv: PLANNING}
views:
  - {id: app, source: gt, repos: [acme/api]}
releases:
  enabled: true
  publicOrigin: https://desk.example.test
  stateDir: ${stateDir}
  repositories:
    - id: app
      source: gt
      repo: acme/api
      origin: ssh://git@gitea.example.test/acme/api.git
      apiTokenEnv: RELEASE
      expectedApiUser: release-bot
      ci: {workflowPath: .gitea/workflows/validate.yaml}
      ssh: {privateKeyFile: ${root}/key, knownHostsFile: ${root}/hosts}
      tagger: {name: Configured Bot, email: bot@example.test}
`;
  const config = parseConfig(configYaml, {
    PASSWORD: 'password',
    PLANNING: 'read-token',
    RELEASE: TOKEN,
  });
  if (!config.releases.enabled) throw new Error('fixture release config missing');
  const runtime: ReleaseRuntime = {
    publicOrigin: config.releases.publicOrigin,
    stateDir,
    repositories: config.releases.repositories.map((entry) => ({ config: entry, token: TOKEN })),
  };
  const owner = await acquireReleaseOwnership({ stateDir });
  cleanups.push(async () => {
    await owner.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const store = new ReleaseStateStore({ stateDir });
  let release: unknown = null;
  let failPath = '';
  let releaseStatus = 404;
  let ciWait: Promise<void> = Promise.resolve();
  const methods: string[] = [];
  const creates: Array<{ input: string; init: RequestInit }> = [];
  let create: (input: string, init: RequestInit) => Promise<Response> = async () => json({}, 500);
  const baseFetch = async (input: string, init: RequestInit) => {
    methods.push(init.method ?? 'GET');
    const path = new URL(input).pathname;
    if (path === failPath) return json({ secret: TOKEN }, 500);
    if (path.endsWith('/version')) return json({ version: '1.26.1' });
    if (path.endsWith('/user')) return json({ id: 7, login: 'release-bot' });
    if (path === '/api/v1/repos/acme/api') {
      return json({
        id: 42,
        full_name: 'acme/api',
        name: 'api',
        default_branch: 'main',
        ssh_url: 'git@gitea.example.test:acme/api.git',
      });
    }
    if (path.endsWith('/actions/runs') || path.endsWith('/actions/runs/9')) {
      await ciWait;
      const run = {
        id: 9,
        head_sha: commit,
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        path: 'validate.yaml@refs/heads/main',
        repository: { id: 42, full_name: 'acme/api' },
      };
      return json(path.endsWith('/9') ? run : { total_count: 1, workflow_runs: [run] });
    }
    if (path.includes('/releases/tags/')) {
      return json(release, release === null ? releaseStatus : 200);
    }
    if (path.endsWith('/releases')) return json(release === null ? [] : [release]);
    throw new Error(`unexpected read ${path}`);
  };
  let transform: (path: string, body: Record<string, unknown>) => unknown = (_path, body) => body;
  const fetch = async (input: string, init: RequestInit) => {
    if (init.method === 'POST') {
      methods.push('POST');
      creates.push({ input, init });
      return create(input, init);
    }
    const response = await baseFetch(input, init);
    return json(
      transform(new URL(input).pathname, (await response.json()) as Record<string, unknown>),
      response.status,
    );
  };
  const service = (state = store, ownership: ReleaseOwnership = owner) =>
    new ReleasePreparation({ config, runtime, ownership, store: state, fetch });
  return {
    root,
    config,
    configYaml,
    fetch,
    remote,
    work,
    stateDir,
    store,
    service,
    owner,
    methods,
    creates,
    onCreate(handler: typeof create) {
      create = handler;
    },
    sshLog,
    commit,
    runtime,
    alterResponse(change: typeof transform) {
      transform = change;
    },
    enablePush(mode = 'success') {
      const actions: Record<string, string> = {
        reject: 'exit 1',
        timeout: 'sleep 60',
        lost: `git-receive-pack '${remote}'; exit 1`,
        'timeout-after': `git-receive-pack '${remote}'; sleep 60`,
        conflict: `git -C '${remote}' update-ref refs/tags/v0.1.0 '${commit}'; exec git-receive-pack '${remote}'`,
        'success-absent': `git-receive-pack '${remote}'; git -C '${remote}' update-ref -d refs/tags/v0.1.0`,
      };
      const action = actions[mode] ?? `exec git-receive-pack '${remote}'`;
      writeFileSync(
        join(bin, 'ssh'),
        `#!/bin/sh\nprintf '%s\\n' "$@" >> '${sshLog}'\nfor arg do last=$arg; done\ncase "$last" in *git-upload-pack*) exec git-upload-pack '${remote}';; *git-receive-pack*) ${action};; *) exit 91;; esac\n`,
        { mode: 0o755 },
      );
    },
    publication: (state = store, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
      new ReleasePublication({ config, runtime, ownership: owner, store: state, fetch, ...extra }),
    reconciliation: (state = store, ownership: ReleaseOwnership = owner) =>
      new ReleaseReconciliation({ config, runtime, ownership, store: state, fetch }),
    setRelease(tag = 'v0.1.0') {
      release = {
        id: 1,
        tag_name: tag,
        name: tag,
        body: NOTES,
        draft: false,
        prerelease: false,
        assets: [],
        author: { login: 'Actual Author' },
        url: `${BASE}/api/v1/repos/acme/api/releases/1`,
        html_url: `${BASE}/acme/api/releases/tag/${tag}`,
      };
    },
    fail(path: string) {
      failPath = path;
    },
    unknownRelease() {
      releaseStatus = 403;
    },
    holdCi(promise: Promise<void>) {
      ciWait = promise;
    },
  };
}

async function terminal(store: ReleaseStateStore, job: ReleaseJob): Promise<ReleaseJob> {
  for (let tries = 0; tries < 500; tries++) {
    const current = store.readJob(job.jobId);
    if (!['queued', 'running'].includes(current.state)) return current;
    await delay(10);
  }
  throw new Error(`job ${job.jobId} did not settle`);
}

async function prepared(
  f: Awaited<ReturnType<typeof fixture>>,
  service = f.service(),
): Promise<ReleasePlan> {
  const result = await terminal(f.store, await service.prepare('app'));
  expect(result, JSON.stringify(result)).toMatchObject({ state: 'complete', errorCode: null });
  return f.store.readPlan(result.planId!);
}

function noRemoteWrites(f: Awaited<ReturnType<typeof fixture>>) {
  expect(new Set(f.methods)).toEqual(new Set(['GET']));
  expect(readFileSync(f.sshLog, 'utf8')).not.toContain('receive-pack');
}

describe('release publication through HTTP', () => {
  function http(f: Awaited<ReturnType<typeof fixture>>, store = f.store) {
    const publication = f.publication(store);
    const execute = vi.spyOn(publication, 'execute');
    const approval = new ReleaseApproval({
      config: f.config,
      runtime: f.runtime,
      ownership: f.owner,
      store,
      publication,
    });
    const app = buildApp(f.config, new PlanService(f.config), {
      releases: {
        runtime: f.runtime,
        gate: f.owner,
        store,
        preparation: f.service(store),
        approval,
        reconciliation: f.reconciliation(store),
      },
    });
    cleanups.push(async () => {
      await app.close();
    });
    const headers = { authorization: `Basic ${Buffer.from('admin:password').toString('base64')}` };
    return { app, headers, execute };
  }

  it('prepares, publishes once despite duplicate/lost-response retries, and reads the durable receipt', async () => {
    const f = await fixture();
    f.enablePush();
    f.onCreate(async () => {
      f.setRelease();
      return json({}, 201);
    });
    const { app, headers, execute } = http(f);
    const preparation = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories/app/prepare',
      headers,
    });
    expect(preparation.statusCode).toBe(202);
    const ready = await terminal(f.store, f.store.readJob(preparation.json().jobId));
    const planResponse = await app.inject({ url: `/api/releases/plans/${ready.planId}`, headers });
    expect(planResponse.statusCode).toBe(200);
    const plan = planResponse.json<ReleasePlan>();
    const submit = () =>
      app.inject({
        method: 'POST',
        url: `/api/releases/plans/${plan.planId}/publish`,
        headers,
        payload: { digest: plan.digest },
      });
    const [accepted, duplicate] = await Promise.all([submit(), submit()]);
    expect(accepted.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().jobId).toBe(accepted.json().jobId);
    expect(execute).toHaveBeenCalledTimes(1);
    const result = await terminal(f.store, f.store.readJob(accepted.json().jobId));
    expect(result).toMatchObject({ state: 'complete', remote: { tag: 'exact', release: 'exact' } });
    // Treat the first response as lost: a later retry must return the original durable job.
    const retried = await submit();
    expect(retried.json().jobId).toBe(result.jobId);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.creates).toHaveLength(1);
    expect(readFileSync(f.sshLog, 'utf8').match(/git-receive-pack/g)).toHaveLength(1);
    const receipt = await app.inject({
      url: `/api/releases/jobs/${result.jobId}/receipt`,
      headers,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.body).toContain('Outcome complete');
    expect(receipt.body).toContain('Actual Author');
    expect(receipt.body).toContain(NOTES);
    for (const value of [TOKEN, f.stateDir, f.runtime.repositories[0]!.config.ssh.privateKeyFile])
      expect(receipt.body).not.toContain(value);
  });

  it('never starts an existing queued approval on retry and reconciles uncertain work read-only', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    const approval = new ReleaseApproval({
      config: f.config,
      runtime: f.runtime,
      ownership: f.owner,
      store: f.store,
    });
    const original = await approval.approve({ planId: plan.planId, digest: plan.digest }, 'admin');
    const { app, headers, execute } = http(f);
    const retry = await app.inject({
      method: 'POST',
      url: `/api/releases/plans/${plan.planId}/publish`,
      headers,
      payload: { digest: plan.digest },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().jobId).toBe(original.jobId);
    expect(execute).not.toHaveBeenCalled();
    const reconcile = () =>
      app.inject({
        method: 'POST',
        url: `/api/releases/jobs/${original.jobId}/reconcile`,
        headers,
      });
    const [first, second] = await Promise.all([reconcile(), reconcile()]);
    expect(first.statusCode).toBe(202);
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(first.json()).toMatchObject({
      kind: 'reconcile',
      state: 'blocked',
      remote: { tag: 'absent', release: 'absent' },
    });
    const receipt = await app.inject({
      url: `/api/releases/jobs/${original.jobId}/receipt`,
      headers,
    });
    expect(receipt.body).toContain('fresh recovery plan');
    noRemoteWrites(f);
  });

  it('keeps runtime blockers and failed finalization in accepted jobs and honest receipts', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    f.enablePush();
    f.onCreate(async () => {
      f.setRelease();
      return json({}, 201);
    });
    const store = new ReleaseStateStore({ stateDir: f.stateDir });
    vi.spyOn(store, 'writeReceipt').mockImplementation(() => {
      throw new Error('private storage failed');
    });
    const { app, headers } = http(f, store);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/releases/plans/${plan.planId}/publish`,
      headers,
      payload: { digest: plan.digest },
    });
    expect(accepted.statusCode).toBe(202);
    const result = await terminal(f.store, f.store.readJob(accepted.json().jobId));
    expect(result).toMatchObject({
      state: 'internal-error',
      errorCode: 'internal-error',
      remote: { tag: 'exact', release: 'exact' },
    });
    const receipt = await app.inject({
      url: `/api/releases/jobs/${result.jobId}/receipt`,
      headers,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.body).toContain('Receipt finalization failed');
    expect(receipt.body).not.toContain('Outcome complete');
    expect(f.creates).toHaveLength(1);
  });

  it('rejects stale digests, expiry, ineligible plans and unresolved attempts without remote effects', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    const { app, headers, execute } = http(f);
    const submit = (planId: string, digest: string) =>
      app.inject({
        method: 'POST',
        url: `/api/releases/plans/${planId}/publish`,
        headers,
        payload: { digest },
      });
    const stale = await submit(plan.planId, 'f'.repeat(64));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('plan-stale');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(plan.approvalDeadline) + 1);
    const expired = await submit(plan.planId, plan.digest);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().code).toBe('plan-expired');
    vi.useRealTimers();
    const blockedPayload = {
      ...plan.payload,
      blockers: [{ code: 'test-blocker', message: 'not eligible' }],
    };
    const blocked = f.store.writePlan({
      ...plan,
      planId: 'blocked-plan',
      payload: blockedPayload,
      digest: releasePlanDigest(blockedPayload),
    });
    const ineligible = await submit(blocked.planId, blocked.digest);
    expect(ineligible.statusCode).toBe(409);
    expect(ineligible.json().code).toBe('repository-ineligible');
    f.store.writeJob({
      jobId: 'orphan-publication',
      kind: 'publish',
      planId: plan.planId,
      planDigest: plan.digest,
      state: 'needs-inspection',
      step: null,
      remote: { tag: 'unknown', release: 'unknown' },
      errorCode: 'attempt-unresolved',
    });
    const unresolved = await submit(plan.planId, plan.digest);
    expect(unresolved.statusCode).toBe(409);
    expect(unresolved.json().code).toBe('attempt-unresolved');
    expect(execute).not.toHaveBeenCalled();
    noRemoteWrites(f);
  });
});

describe('tracked release preparation', () => {
  it.each([false, true])('prepares immutable first/later plans (baseline=%s)', async (baseline) => {
    const f = await fixture({ baseline });
    const refsBefore = git(f.remote, 'show-ref');
    const plan = await prepared(f);
    expect(plan.payload).toMatchObject({
      candidate: { commit: f.commit, branch: 'main' },
      tagName: baseline ? 'v0.1.1' : 'v0.1.0',
      notes: { text: NOTES },
      ci: { runId: 9 },
      account: { forgeUserId: 7 },
      repository: { forgeRepositoryId: 42 },
      blockers: [],
      tagger: { name: 'Configured Bot' },
      tag: { state: 'absent' },
    });
    expect(plan.payload.actions.map((action) => action.kind)).toEqual([
      'create-tag',
      'create-release',
    ]);
    expect(plan.digest).toBe(releasePlanDigest(plan.payload));
    expect(Date.parse(plan.approvalDeadline) - Date.parse(plan.preparedAt!)).toBe(30 * 60_000);
    const raw = git(
      join(f.stateDir, 'checkout/app.git'),
      'cat-file',
      'tag',
      plan.payload.tag.objectId!,
    );
    expect(raw).toContain(`object ${f.commit}\ntype commit\ntag ${plan.payload.tagName}`);
    expect(raw).toContain(
      `tagger Configured Bot <bot@example.test> ${Date.parse(plan.preparedAt!) / 1000} +0000`,
    );
    expect(new ReleaseStateStore({ stateDir: f.stateDir }).readPlan(plan.planId)).toEqual(plan);
    const clone = f.store.readPlan(plan.planId);
    clone.payload.notes.text = 'caller tampering';
    expect(f.store.readPlan(plan.planId)).toEqual(plan);
    expect(git(f.remote, 'show-ref')).toBe(refsBefore);
    expect(JSON.stringify(plan)).not.toContain(TOKEN);
    noRemoteWrites(f);
  });

  it('routes repeated API preparation through the durable job and exposes its plan', async () => {
    const f = await fixture();
    let release!: () => void;
    f.holdCi(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const app = buildApp(f.config, new PlanService(f.config), {
      logger: false,
      webDir: f.root,
      releases: {
        runtime: f.runtime,
        gate: f.owner,
        store: f.store,
        preparation: f.service(),
      },
    });
    cleanups.push(() => app.close());
    const headers = {
      authorization: `Basic ${Buffer.from('admin:password').toString('base64')}`,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories/app/prepare',
      headers,
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories/app/prepare',
      headers,
    });
    expect(first.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().jobId).toBe(first.json().jobId);
    expect(first.json().statusUrl).toBe(`/api/releases/jobs/${first.json().jobId}`);
    release();

    let status = await app.inject({ url: first.json().statusUrl, headers });
    for (
      let tries = 0;
      tries < 500 && ['queued', 'running'].includes(status.json().state);
      tries++
    ) {
      await delay(10);
      status = await app.inject({ url: first.json().statusUrl, headers });
    }
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: 'complete', kind: 'prepare' });
    expect(status.json().planId).toBeTruthy();
    const plan = await app.inject({ url: `/api/releases/plans/${status.json().planId}`, headers });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().digest).toBe(f.store.readPlan(status.json().planId).digest);
    expect(plan.json().payload.candidate.commit).toBe(f.commit);
    noRemoteWrites(f);
  });

  it('redacts an unsafe checkout path from blocked API job and history responses', async () => {
    const f = await fixture();
    const checkoutCache = join(f.stateDir, 'checkout');
    mkdirSync(checkoutCache, { mode: 0o755 });
    chmodSync(checkoutCache, 0o755);
    const app = buildApp(f.config, new PlanService(f.config), {
      logger: false,
      webDir: f.root,
      releases: {
        runtime: f.runtime,
        gate: f.owner,
        store: f.store,
        preparation: f.service(),
      },
    });
    cleanups.push(() => app.close());
    const headers = {
      authorization: `Basic ${Buffer.from('admin:password').toString('base64')}`,
    };
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/releases/repositories/app/prepare',
      headers,
    });
    expect(accepted.statusCode).toBe(202);

    let status = await app.inject({ url: accepted.json().statusUrl, headers });
    for (
      let tries = 0;
      tries < 500 && ['queued', 'running'].includes(status.json().state);
      tries++
    ) {
      await delay(10);
      status = await app.inject({ url: accepted.json().statusUrl, headers });
    }
    expect(status.json()).toMatchObject({
      state: 'blocked',
      blocker: { code: 'git-unsafe-cache' },
    });
    const history = await app.inject({
      url: '/api/releases/repositories/app/jobs?limit=1',
      headers,
    });
    for (const response of [status, history]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(f.stateDir);
    }
    expect(status.json().blocker.message).toContain('***');
    noRemoteWrites(f);
  });

  it('deduplicates requests and restores frozen plans across restarts', async () => {
    const f = await fixture();
    let release!: () => void;
    f.holdCi(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const service = f.service();
    const first = await service.prepare('app');
    expect((await service.prepare('app')).jobId).toBe(first.jobId);
    release();
    const done = await terminal(f.store, first);
    const original = f.store.readPlan(done.planId!);
    await f.owner.shutdown();
    rmSync(join(f.stateDir, 'checkout'), { recursive: true, force: true });
    const restarted = await acquireReleaseOwnership({ stateDir: f.stateDir });
    cleanups.push(async () => {
      await restarted.shutdown();
    });
    const plan = await prepared(
      f,
      f.service(new ReleaseStateStore({ stateDir: f.stateDir }), restarted),
    );
    expect(plan).toEqual(original);
    noRemoteWrites(f);
  });

  it('independently verifies an existing candidate as no-op without incrementing it', async () => {
    const f = await fixture({ baseline: true, sameCandidate: true });
    f.setRelease();
    const plan = await prepared(f);
    const tagger = git(f.remote, 'for-each-ref', '--format=%(taggername)', 'refs/tags/v0.1.0');
    expect(plan.payload).toMatchObject({
      tagName: 'v0.1.0',
      actions: [],
      tag: { state: 'exact', tagger: { name: tagger } },
      release: { state: 'exact', author: 'Actual Author' },
    });
    noRemoteWrites(f);
  });

  it('returns the original no-op version even when a newer stable tag targets another commit', async () => {
    const f = await fixture({ baseline: true });
    const older = git(f.remote, 'rev-parse', 'v0.1.0^{}');
    git(f.remote, 'tag', '-a', 'v0.1.1', older, '-m', 'v0.1.1');
    git(f.remote, 'tag', '-f', '-a', 'v0.1.0', f.commit, '-m', 'v0.1.0');
    f.setRelease();
    const refs = git(f.remote, 'show-ref');
    expect((await prepared(f)).payload).toMatchObject({
      tagName: 'v0.1.0',
      actions: [],
      candidate: { commit: f.commit },
      tag: { state: 'exact' },
      release: { state: 'exact' },
    });
    expect(git(f.remote, 'show-ref')).toBe(refs);
    noRemoteWrites(f);
  });

  it('blocks an incomplete existing candidate rather than deriving a next patch', async () => {
    const f = await fixture({ baseline: true, sameCandidate: true });
    const done = await terminal(f.store, await f.service().prepare('app'));
    expect(done).toMatchObject({ state: 'blocked', errorCode: 'attempt-unresolved' });
    expect(f.store.readPlan(done.planId!).payload).toMatchObject({
      tagName: 'v0.1.0',
      actions: [],
      blockers: [expect.objectContaining({ code: 'attempt-unresolved' })],
    });
    noRemoteWrites(f);
  });

  it.each(['/api/v1/user', '/api/v1/repos/acme/api/actions/runs'])(
    'blocks inaccessible input %s',
    async (path) => {
      const f = await fixture();
      f.fail(path);
      const done = await terminal(f.store, await f.service().prepare('app'));
      expect(done).toMatchObject({
        state: 'blocked',
        planId: null,
        errorCode: 'repository-ineligible',
      });
      expect(JSON.stringify(done)).not.toContain(TOKEN);
      noRemoteWrites(f);
    },
  );

  it('blocks invalid committed metadata and unknown observations', async () => {
    const invalid = await fixture({ notes: '\u0000invalid' });
    const done = await terminal(invalid.store, await invalid.service().prepare('app'));
    expect(done).toMatchObject({ state: 'blocked', planId: null, blocker: { code: 'notes-nul' } });
    const f = await fixture();
    f.unknownRelease();
    const unknown = await terminal(f.store, await f.service().prepare('app'));
    expect(unknown.state).toBe('blocked');
    expect(f.store.readPlan(unknown.planId!).payload).toMatchObject({
      actions: [],
      release: { state: 'unknown' },
    });
    noRemoteWrites(f);
  });

  it.each(['needs-inspection', 'complete'] as const)(
    'blocks publication state %s without verified completion evidence',
    async (state) => {
      const f = await fixture();
      const plan = await prepared(f);
      f.store.writeJob({
        jobId: 'uncertain-publication',
        kind: 'publish',
        planId: plan.planId,
        planDigest: plan.digest,
        state,
        step: 'creating-tag',
        remote: { tag: 'unknown', release: 'absent' },
        errorCode: 'attempt-unresolved',
      });
      const done = await terminal(f.store, await f.service().prepare('app'));
      expect(done).toMatchObject({
        state: 'blocked',
        errorCode: 'attempt-unresolved',
        planId: null,
      });
      expect(f.store.readPlan(plan.planId)).toEqual(plan);
      noRemoteWrites(f);
    },
  );

  it('never completes failed storage writes and safely resumes interrupted reads', async () => {
    const f = await fixture();
    let fail = false;
    const failing = new ReleaseStateStore({
      stateDir: f.stateDir,
      fsync: (fd) => {
        if (fail) throw new Error('disk failure');
        fsyncSync(fd);
      },
    });
    let release!: () => void;
    f.holdCi(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const admitted = await f.service(failing).prepare('app');
    // Stop at a real input read, then fail every subsequent durable write.
    while (f.store.readJob(admitted.jobId).step !== 'reading-ci') await delay(10);
    fail = true;
    release();
    await f.owner.shutdown();
    expect(f.store.readJob(admitted.jobId).state).not.toBe('complete');
    const restarted = await acquireReleaseOwnership({ stateDir: f.stateDir });
    cleanups.push(async () => {
      await restarted.shutdown();
    });
    const service = f.service(f.store, restarted);
    const resumed = await service.prepare('app');
    expect(resumed.jobId).toBe(admitted.jobId);
    expect((await terminal(f.store, resumed)).state).toBe('complete');
    noRemoteWrites(f);
  });

  it('keeps the same immutable plan after a final-job synchronization failure', async () => {
    const f = await fixture();
    let failed = false;
    const failing = new ReleaseStateStore({
      stateDir: f.stateDir,
      fsync: (fd) => {
        if (!failed && fstatSync(fd).isFile()) {
          const record = JSON.parse(readFileSync(`/proc/self/fd/${fd}`, 'utf8'));
          if (record.kind === 'job' && record.body.state === 'complete') {
            failed = true;
            throw new Error('final job sync failed');
          }
        }
        fsyncSync(fd);
      },
    });
    const done = await terminal(f.store, await f.service(failing).prepare('app'));
    expect(done).toMatchObject({ state: 'internal-error', errorCode: 'internal-error' });
    const frozen = f.store.readPlan(done.planId!);
    expect(await prepared(f)).toEqual(frozen);
    noRemoteWrites(f);
  });

  it('does not reuse a plan after approval-relevant policy changes', async () => {
    const f = await fixture();
    const first = await prepared(f);
    f.runtime.repositories[0]!.config.tagger = {
      name: 'Replacement Bot',
      email: 'other@example.test',
    };
    const second = await prepared(f);
    expect(second.planId).not.toBe(first.planId);
    expect(second.digest).not.toBe(first.digest);
    expect(second.payload.tagger.name).toBe('Replacement Bot');
    expect(f.store.readPlan(first.planId)).toEqual(first);
    noRemoteWrites(f);
  });

  it('re-inspects completed candidates and blocks disappearing remote evidence', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    // A separate publisher puts the exact prepared object into the disposable remote.
    const raw = git(
      join(f.stateDir, 'checkout/app.git'),
      'cat-file',
      'tag',
      plan.payload.tag.objectId!,
    );
    const objectId = execFileSync('git', ['hash-object', '-w', '-t', 'tag', '--stdin'], {
      cwd: f.remote,
      input: `${raw}\n`,
      encoding: 'utf8',
    }).trim();
    git(f.remote, 'update-ref', `refs/tags/${plan.payload.tagName}`, objectId);
    f.setRelease();
    const published: ReleaseJob = {
      jobId: 'completed-publication',
      kind: 'publish',
      planId: plan.planId,
      planDigest: plan.digest,
      state: 'complete',
      step: 'finished',
      remote: { tag: 'exact', release: 'exact' },
      errorCode: null,
    };
    f.store.writeJob(published);
    f.store.writeReceipt({
      receiptId: 'completed-receipt',
      jobId: published.jobId,
      planId: plan.planId,
      planDigest: plan.digest,
      contractVersion: 1,
      stateSchemaVersion: 1,
      state: 'complete',
      remote: published.remote,
      errorCode: null,
    });
    expect((await prepared(f)).payload.actions).toEqual([]);
    git(f.remote, 'update-ref', '-d', `refs/tags/${plan.payload.tagName}`);
    const missing = await terminal(f.store, await f.service().prepare('app'));
    expect(missing).toMatchObject({ state: 'blocked', errorCode: 'attempt-unresolved' });
    expect(f.store.readPlan(missing.planId!).payload.actions).toEqual([]);
    noRemoteWrites(f);
  });

  it('refuses unknown repositories, a closed gate, and failed durable admission', async () => {
    const f = await fixture();
    await expect(f.service().prepare('../arbitrary')).rejects.toMatchObject({ code: 'not-found' });
    const failing = new ReleaseStateStore({
      stateDir: f.stateDir,
      fsync: () => {
        throw new Error('disk');
      },
    });
    await expect(f.service(failing).prepare('app')).rejects.toMatchObject({
      code: 'internal-error',
    });
    await f.owner.shutdown();
    await expect(f.service().prepare('app')).rejects.toMatchObject({
      code: 'execution-unavailable',
    });
    expect(f.methods).toEqual([]);
  });
});

// Exercise approval through the same real preparation, state store and ownership gate.
describe('durable approval admission', () => {
  function approval(f: Awaited<ReturnType<typeof fixture>>, store = f.store, ownership = f.owner) {
    return new ReleaseApproval({ config: f.config, runtime: f.runtime, store, ownership });
  }

  function request(plan: ReleasePlan) {
    return { planId: plan.planId, digest: plan.digest };
  }

  function variant(
    f: Awaited<ReturnType<typeof fixture>>,
    original: ReleasePlan,
    change: (plan: ReleasePlan) => void,
  ) {
    const plan = structuredClone(original);
    plan.planId = 'variant';
    change(plan);
    plan.digest = releasePlanDigest(plan.payload);
    f.store.writePlan(plan);
    return plan;
  }

  it('binds one durable intent and job, serializes duplicate callers, and survives a lost response/restart', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    const reads = f.methods.length;
    const refs = git(f.remote, 'show-ref');
    const [first, duplicate] = await Promise.all([
      approval(f).approve(request(plan), 'admin'),
      approval(f).approve(request(plan), 'admin'),
    ]);
    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      kind: 'publish',
      state: 'queued',
      planId: plan.planId,
      planDigest: plan.digest,
    });
    const intent = f.store.readIntent(plan.planId);
    expect(intent).toMatchObject({
      jobId: first.jobId,
      planId: plan.planId,
      planDigest: plan.digest,
      operator: 'admin',
      approvedActions: plan.payload.actions,
    });
    expect(Date.parse(intent.approvedAt)).toBeLessThan(Date.parse(plan.approvalDeadline));
    expect(Date.parse(intent.approvedAt)).toBeGreaterThanOrEqual(Date.parse(plan.preparedAt!));
    await f.owner.shutdown();
    const restarted = await acquireReleaseOwnership({ stateDir: f.stateDir });
    cleanups.push(async () => {
      await restarted.shutdown();
    });
    const store = new ReleaseStateStore({ stateDir: f.stateDir });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(plan.approvalDeadline) + 1);
    expect(await approval(f, store, restarted).approve(request(plan), 'admin')).toEqual(first);
    vi.useRealTimers();
    expect(store.readIntent(plan.planId)).toEqual(intent);
    expect(store.listJobs().filter((job) => job.kind === 'publish')).toEqual([first]);
    expect(f.methods).toHaveLength(reads);
    expect(git(f.remote, 'show-ref')).toBe(refs);
    noRemoteWrites(f);
  });

  it.each([null, '', 'somebody-else', 'admin\n'])(
    'rejects unauthenticated actor %j without admission',
    async (actor) => {
      const f = await fixture();
      const plan = await prepared(f);
      await expect(approval(f).approve(request(plan), actor)).rejects.toMatchObject({
        code: 'not-authenticated',
      });
      expect(f.store.listJobs().filter((job) => job.kind === 'publish')).toEqual([]);
    },
  );

  it.each([
    null,
    [],
    {},
    { planId: '../escape', digest: 'a'.repeat(64) },
    { planId: 'p', digest: 'bad' },
    { planId: 'p', digest: 'a'.repeat(64), operator: 'admin' },
  ])('rejects malformed request %j', async (input) => {
    const f = await fixture();
    await expect(approval(f).approve(input, 'admin')).rejects.toMatchObject({
      code: 'invalid-request',
    });
    expect(f.store.listJobs()).toEqual([]);
  });

  it('rejects unknown plans and a forged digest, even on a duplicate', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    await expect(
      approval(f).approve({ planId: 'missing', digest: plan.digest }, 'admin'),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      approval(f).approve({ ...request(plan), digest: 'f'.repeat(64) }, 'admin'),
    ).rejects.toMatchObject({ code: 'plan-stale' });
    const job = await approval(f).approve(request(plan), 'admin');
    await expect(
      approval(f).approve({ ...request(plan), digest: 'f'.repeat(64) }, 'admin'),
    ).rejects.toMatchObject({ code: 'plan-stale' });
    expect(f.store.readIntent(plan.planId).jobId).toBe(job.jobId);
  });

  it.each([
    'expired',
    'blocker',
    'unknown',
    'actions',
    'legacy',
    'legacy-config',
    'future',
    'config',
  ] as const)('rejects %s plans before intent', async (failure) => {
    const f = await fixture();
    const original = await prepared(f);
    const plan = variant(f, original, (p) => {
      if (failure === 'expired') {
        p.preparedAt = new Date(Date.now() - 31 * 60_000).toISOString();
        p.approvalDeadline = new Date(Date.parse(p.preparedAt) + 30 * 60_000).toISOString();
      }
      if (failure === 'future') {
        p.preparedAt = new Date(Date.now() + 60_000).toISOString();
        p.approvalDeadline = new Date(Date.parse(p.preparedAt) + 30 * 60_000).toISOString();
      }
      if (failure === 'blocker') {
        p.payload.blockers = [{ code: 'blocked', message: 'Unresolved evidence' }];
      }
      if (failure === 'unknown') p.payload.tag.state = 'unknown';
      if (failure === 'actions') p.payload.actions = [];
      if (failure === 'legacy') delete p.preparedAt;
      if (failure === 'legacy-config') delete p.payload.configurationDigest;
      if (failure === 'config') p.payload.ci.workflowPath = '.gitea/workflows/other.yml';
    });
    await expect(approval(f).approve(request(plan), 'admin')).rejects.toMatchObject({
      code:
        failure === 'expired'
          ? 'plan-expired'
          : failure === 'config' || failure === 'legacy-config'
            ? 'plan-stale'
            : 'repository-ineligible',
    });
    expect(f.store.listJobs().filter((job) => job.kind === 'publish')).toEqual([]);
    expect(() => f.store.readIntent(plan.planId)).toThrow();
    noRemoteWrites(f);
  });

  it('blocks a competing plan and preparation until the accepted attempt is reconciled', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    const other = variant(f, plan, () => {});
    await approval(f).approve(request(plan), 'admin');
    await expect(approval(f).approve(request(other), 'admin')).rejects.toMatchObject({
      code: 'attempt-unresolved',
    });
    const result = await terminal(f.store, await f.service().prepare('app'));
    expect(result).toMatchObject({ state: 'blocked', errorCode: 'attempt-unresolved' });
    noRemoteWrites(f);
  });

  it('accepts an independently prepared no-op without inventing actions', async () => {
    const f = await fixture({ baseline: true, sameCandidate: true });
    f.setRelease();
    const plan = await prepared(f);
    expect(plan.payload.actions).toEqual([]);
    const job = await approval(f).approve(request(plan), 'admin');
    expect(f.store.readIntent(plan.planId)).toMatchObject({
      jobId: job.jobId,
      approvedActions: [],
    });
    noRemoteWrites(f);
  });

  it('requires a receipt for earlier completion and rejects stale actions for that version', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    const other = variant(f, plan, () => {});
    const accepted = await approval(f).approve(request(plan), 'admin');
    const complete: ReleaseJob = {
      ...accepted,
      state: 'complete',
      step: 'finished',
      remote: { tag: 'exact', release: 'exact' },
    };
    f.store.writeJob(complete);
    await expect(approval(f).approve(request(other), 'admin')).rejects.toMatchObject({
      code: 'attempt-unresolved',
    });
    f.store.writeReceipt({
      receiptId: 'completed',
      jobId: complete.jobId,
      planId: plan.planId,
      planDigest: plan.digest,
      contractVersion: 1,
      stateSchemaVersion: 1,
      state: 'complete',
      remote: complete.remote,
      errorCode: null,
    });
    await expect(approval(f).approve(request(other), 'admin')).rejects.toMatchObject({
      code: 'plan-stale',
    });
    expect(await approval(f).approve(request(plan), 'admin')).toEqual(complete);
    noRemoteWrites(f);
  });

  it('fails closed on corrupt stored content and a closed ownership gate', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    const file = join(f.stateDir, 'plans', `${plan.planId}.json`);
    const original = readFileSync(file, 'utf8');
    const record = JSON.parse(original);
    record.body.payload.notes.text = 'unapproved notes';
    writeFileSync(file, JSON.stringify(record));
    await expect(approval(f).approve(request(plan), 'admin')).rejects.toMatchObject({
      code: 'internal-error',
    });
    writeFileSync(file, original);
    await f.owner.shutdown();
    await expect(approval(f).approve(request(plan), 'admin')).rejects.toMatchObject({
      code: 'execution-unavailable',
    });
    expect(f.store.listJobs().filter((job) => job.kind === 'publish')).toEqual([]);
  });

  it.each(['job', 'intent', 'queue'] as const)(
    'keeps %s persistence failure ineligible and never replays it on retry',
    async (failure) => {
      const f = await fixture();
      const plan = await prepared(f);
      const writeJob = f.store.writeJob.bind(f.store);
      if (failure === 'intent') {
        vi.spyOn(f.store, 'writeIntent').mockImplementation(() => {
          throw new Error('secret storage diagnostic');
        });
      } else {
        vi.spyOn(f.store, 'writeJob').mockImplementation((job) => {
          if (failure === 'job' || job.state === 'queued') {
            throw new Error('secret storage diagnostic');
          }
          return writeJob(job);
        });
      }
      await expect(approval(f).approve(request(plan), 'admin')).rejects.toMatchObject({
        code: 'internal-error',
        message: 'approval evidence could not be safely persisted or read',
      });
      vi.restoreAllMocks();
      const store = new ReleaseStateStore({ stateDir: f.stateDir });
      const jobs = store.listJobs().filter((job) => job.kind === 'publish');
      expect(jobs.every((job) => job.state === 'needs-inspection')).toBe(true);
      if (failure === 'intent') {
        await expect(approval(f, store).approve(request(plan), 'admin')).rejects.toMatchObject({
          code: 'attempt-unresolved',
        });
        expect(() => store.readIntent(plan.planId)).toThrow();
      } else if (failure === 'queue') {
        const intent = store.readIntent(plan.planId);
        expect(await approval(f, store).approve(request(plan), 'admin')).toEqual(jobs[0]);
        expect(store.readIntent(plan.planId)).toEqual(intent);
      } else {
        expect(jobs).toEqual([]);
        expect(() => store.readIntent(plan.planId)).toThrow();
      }
      noRemoteWrites(f);
    },
  );

  it.each([false, true])(
    'restores inspection after queue sync failure or fences admission (restore failure=%s)',
    async (restoreFailure) => {
      const f = await fixture();
      const plan = await prepared(f);
      let queuedWrite = false;
      let queueFailed = false;
      const store = new ReleaseStateStore({
        stateDir: f.stateDir,
        fsync(fd) {
          if (queuedWrite && fstatSync(fd).isDirectory()) {
            queueFailed = true;
            throw new Error('queue directory sync failed');
          }
          fsyncSync(fd);
        },
      });
      const write = store.writeJob.bind(store);
      vi.spyOn(store, 'writeJob').mockImplementation((job) => {
        queuedWrite = job.state === 'queued';
        if (restoreFailure && queueFailed) throw new Error('disk stopped accepting writes');
        return write(job);
      });
      const failed = approval(f, store).approve(request(plan), 'admin');
      const duplicate = approval(f).approve(request(plan), 'admin');
      const results = await Promise.allSettled([failed, duplicate]);
      expect(results[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'internal-error' },
      });
      const intent = f.store.readIntent(plan.planId);
      if (restoreFailure) {
        expect(results[1]).toMatchObject({
          status: 'rejected',
          reason: { code: 'execution-unavailable' },
        });
        expect(f.owner.accepting).toBe(false);
        await expect(approval(f).approve(request(plan), 'admin')).rejects.toMatchObject({
          code: 'execution-unavailable',
        });
      } else {
        const job = f.store.readJob(intent.jobId);
        expect(job).toMatchObject({ state: 'needs-inspection', errorCode: 'attempt-unresolved' });
        expect(results[1]).toEqual({ status: 'fulfilled', value: job });
        await f.owner.shutdown();
        const restarted = await acquireReleaseOwnership({ stateDir: f.stateDir });
        cleanups.push(async () => {
          await restarted.shutdown();
        });
        const reopened = new ReleaseStateStore({ stateDir: f.stateDir });
        expect(await approval(f, reopened, restarted).approve(request(plan), 'admin')).toEqual(job);
        expect(reopened.readIntent(plan.planId)).toEqual(intent);
      }
      noRemoteWrites(f);
    },
  );

  it('does not accept a visible intent after failed directory synchronization until retry synchronizes it', async () => {
    const f = await fixture();
    const plan = await prepared(f);
    let syncingIntent = false;
    const store = new ReleaseStateStore({
      stateDir: f.stateDir,
      fsync(fd) {
        if (syncingIntent && fstatSync(fd).isDirectory()) throw new Error('disk unavailable');
        fsyncSync(fd);
      },
    });
    const write = store.writeIntent.bind(store);
    vi.spyOn(store, 'writeIntent').mockImplementation((intent) => {
      syncingIntent = true;
      return write(intent);
    });
    await expect(approval(f, store).approve(request(plan), 'admin')).rejects.toMatchObject({
      code: 'internal-error',
    });
    const intent = f.store.readIntent(plan.planId);
    expect(f.store.readJob(intent.jobId).state).toBe('needs-inspection');
    await expect(approval(f, store).approve(request(plan), 'admin')).rejects.toMatchObject({
      code: 'internal-error',
    });
    const recovered = await approval(f).approve(request(plan), 'admin');
    expect(recovered).toMatchObject({ jobId: intent.jobId, state: 'needs-inspection' });
    expect(f.store.readIntent(plan.planId)).toEqual(intent);
    noRemoteWrites(f);
  });
});

describe('read-only publication reconciliation and original-version recovery', () => {
  async function accepted(f: Awaited<ReturnType<typeof fixture>>) {
    const plan = await prepared(f);
    const approval = new ReleaseApproval({
      config: f.config,
      runtime: f.runtime,
      store: f.store,
      ownership: f.owner,
    });
    const job = await approval.approve({ planId: plan.planId, digest: plan.digest }, 'admin');
    return { plan, job, approval };
  }

  function installTag(f: Awaited<ReturnType<typeof fixture>>, plan: ReleasePlan) {
    const bytes = execFileSync('git', ['cat-file', 'tag', plan.payload.tag.objectId!], {
      cwd: join(f.stateDir, 'checkout/app.git'),
    });
    const objectId = execFileSync('git', ['hash-object', '-w', '-t', 'tag', '--stdin'], {
      cwd: f.remote,
      input: bytes,
      encoding: 'utf8',
    }).trim();
    git(f.remote, 'update-ref', `refs/tags/${plan.payload.tagName}`, objectId);
  }

  async function acceptedWithTag(f: Awaited<ReturnType<typeof fixture>>) {
    const original = await accepted(f);
    installTag(f, original.plan);
    await f.reconciliation().reconcile(original.job.jobId);
    const plan = await prepared(f);
    const job = await original.approval.approve(
      { planId: plan.planId, digest: plan.digest },
      'admin',
    );
    return { plan, job };
  }

  it.each(['queued', 'running', 'needs-inspection', 'internal-error'] as const)(
    'restarts %s jobs as read-only exact/no-op and re-inspects completed candidates',
    async (state) => {
      const f = await fixture();
      const { plan, job } = await accepted(f);
      installTag(f, plan);
      f.setRelease();
      f.store.writeJob({ ...job, state, step: 'creating-release' });
      const intent = f.store.readIntent(plan.planId);
      await f.owner.shutdown();
      const owner = await acquireReleaseOwnership({ stateDir: f.stateDir });
      cleanups.push(async () => {
        await owner.shutdown();
      });
      const store = new ReleaseStateStore({ stateDir: f.stateDir });
      const recovery = f.reconciliation(store, owner);
      const refs = git(f.remote, 'show-ref');
      await recovery.reconcileInterrupted();
      const completed = store.readJob(job.jobId);
      expect(completed).toMatchObject({
        state: 'complete',
        remote: { tag: 'exact', release: 'exact' },
      });
      const receipt = store.readReceipt(completed.reconciliationJobId!);
      expect(receipt).toMatchObject({
        state: 'complete',
        evidence: {
          publicationJobId: job.jobId,
          operator: 'admin',
          tag: { objectId: plan.payload.tag.objectId },
          release: { author: 'Actual Author' },
        },
      });
      expect(store.readIntent(plan.planId)).toEqual(intent);
      const noOp = await prepared(f, f.service(store, owner));
      expect(noOp.payload).toMatchObject({
        tagName: plan.payload.tagName,
        candidate: plan.payload.candidate,
        notes: plan.payload.notes,
        actions: [],
      });
      expect(recovery.receipt(job.jobId)).toContain(NOTES);
      expect(recovery.receipt(job.jobId)).not.toContain(TOKEN);
      expect(git(f.remote, 'show-ref')).toBe(refs);
      noRemoteWrites(f);
    },
  );

  it.each([false, true])('recovers original content (tag exists=%s)', async (tagExists) => {
    const f = await fixture();
    const { plan, job, approval } = await accepted(f);
    if (tagExists) installTag(f, plan);
    const reconciliation = f.reconciliation();
    const result = await reconciliation.reconcile(job.jobId);
    expect(result).toMatchObject({
      state: 'blocked',
      remote: { tag: tagExists ? 'exact' : 'absent', release: 'absent' },
    });
    expect(reconciliation.receipt(job.jobId)).toContain('fresh recovery plan');
    const originalIntent = f.store.readIntent(plan.planId);
    writeFileSync(
      join(f.work, 'RELEASE_NOTES.md'),
      'New notes that must not replace the original.\n',
    );
    git(f.work, 'add', '.');
    git(f.work, 'commit', '--quiet', '-m', 'After original publication');
    const head = git(f.work, 'rev-parse', 'HEAD');
    git(f.remote, 'fetch', '--quiet', f.work, '+refs/heads/main:refs/heads/main');
    const recovery = await prepared(f);
    expect(recovery.planId).not.toBe(plan.planId);
    expect(recovery.digest).not.toBe(plan.digest);
    expect(recovery.payload).toMatchObject({
      recovery: { jobId: job.jobId, defaultBranchHead: head },
      candidate: plan.payload.candidate,
      notes: plan.payload.notes,
      tagName: plan.payload.tagName,
      tag: { objectId: plan.payload.tag.objectId },
    });
    expect(recovery.payload.actions.map((action) => action.kind)).toEqual(
      tagExists ? ['create-release'] : ['create-tag', 'create-release'],
    );
    expect(f.store.listJobs().filter((entry) => entry.kind === 'publish')).toHaveLength(1);
    const next = await approval.approve(
      { planId: recovery.planId, digest: recovery.digest },
      'admin',
    );
    expect(next.jobId).not.toBe(job.jobId);
    expect(f.store.readIntent(recovery.planId).approvedActions).toEqual(recovery.payload.actions);
    expect(f.store.readIntent(plan.planId)).toEqual(originalIntent);
    // A second interrupted recovery still retains the same content and needs another approval.
    await reconciliation.reconcile(next.jobId);
    const again = await prepared(f);
    expect(again.payload.recovery?.jobId).toBe(next.jobId);
    expect(again.payload.notes).toEqual(plan.payload.notes);
    noRemoteWrites(f);
  });

  it('starts read-only recovery without waiting for a forge', async () => {
    const f = await fixture();
    const { job } = await accepted(f);
    await f.owner.shutdown();
    writeFileSync(join(f.root, 'key'), 'test key', { mode: 0o600 });
    writeFileSync(join(f.root, 'hosts'), 'test hosts', { mode: 0o600 });
    const configPath = join(f.root, 'config.yaml');
    writeFileSync(configPath, f.configYaml);
    const originalFetch = globalThis.fetch;
    let resumeForge!: () => void;
    const forgeWait = new Promise<void>((resolve) => {
      resumeForge = resolve;
    });
    globalThis.fetch = (async (input: string, init: RequestInit) => {
      await forgeWait;
      return f.fetch(input, init);
    }) as typeof globalThis.fetch;
    cleanups.push(async () => {
      globalThis.fetch = originalFetch;
    });
    const server = await startServer({
      configPath,
      env: {
        PASSWORD: 'password',
        PLANNING: 'read-token',
        RELEASE: TOKEN,
        EV_HOST: '127.0.0.1',
        EV_PORT: '43197',
      },
    });
    cleanups.push(async () => {
      resumeForge();
      await server.close();
    });
    expect((await server.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect(f.store.readJob(job.jobId).state).toBe('queued');
    resumeForge();
    for (let tries = 0; tries < 500; tries++) {
      if (f.store.readJob(job.jobId).reconciliationJobId !== undefined) break;
      await delay(10);
    }
    expect(f.store.readJob(job.jobId)).toMatchObject({
      state: 'blocked',
      remote: { tag: 'absent', release: 'absent' },
    });
    noRemoteWrites(f);
  });

  it('blocks recovery when the original candidate is no longer reachable', async () => {
    const f = await fixture();
    const { job } = await accepted(f);
    await f.reconciliation().reconcile(job.jobId);
    git(f.remote, 'update-ref', 'refs/heads/main', git(f.work, 'rev-parse', 'HEAD~1'));
    const result = await terminal(f.store, await f.service().prepare('app'));
    expect(result).toMatchObject({ state: 'blocked', errorCode: 'attempt-unresolved' });
    expect(result.blocker?.message).toContain('not reachable');
    noRemoteWrites(f);
  });

  it.each(['conflict', 'unknown', 'malformed', 'contradictory', 'identity', 'missing-intent'])(
    'blocks %s evidence without admitting ordinary publication',
    async (failure) => {
      const f = await fixture();
      const { plan, job, approval } = await accepted(f);
      if (failure === 'conflict') {
        git(f.remote, 'update-ref', `refs/tags/${plan.payload.tagName}`, f.commit);
      }
      if (failure === 'unknown') f.unknownRelease();
      if (failure === 'malformed') f.setRelease('wrong-tag');
      if (failure === 'contradictory') f.setRelease();
      if (failure === 'identity') f.fail('/api/v1/user');
      if (failure === 'missing-intent') rmSync(join(f.stateDir, 'intents', `${plan.planId}.json`));
      const result = await f.reconciliation().reconcile(job.jobId);
      expect(['needs-inspection', 'internal-error']).toContain(result.state);
      expect(result.blocker?.message).toMatch(/Inspect|inspect/);
      const preparedJob = await terminal(f.store, await f.service().prepare('app'));
      expect(['blocked', 'internal-error']).toContain(preparedJob.state);
      const ordinary = structuredClone(plan);
      ordinary.planId = 'ordinary-plan';
      f.store.writePlan(ordinary);
      await expect(
        approval.approve({ planId: ordinary.planId, digest: ordinary.digest }, 'admin'),
      ).rejects.toMatchObject({ code: 'attempt-unresolved' });
      noRemoteWrites(f);
    },
  );

  it.each(['receipt', 'receipt-sync', 'original-job'])(
    'keeps exact remote effects honest after %s finalization failure, then recovers by reads',
    async (checkpoint) => {
      const f = await fixture();
      const { plan, job } = await accepted(f);
      installTag(f, plan);
      f.setRelease();
      let syncingReceipt = false;
      const store = new ReleaseStateStore({
        stateDir: f.stateDir,
        fsync(fd) {
          if (syncingReceipt && fstatSync(fd).isDirectory()) throw new Error('disk');
          fsyncSync(fd);
        },
      });
      if (checkpoint === 'receipt') {
        vi.spyOn(store, 'writeReceipt').mockImplementation(() => {
          throw new Error('disk');
        });
      }
      if (checkpoint === 'receipt-sync') {
        const write = store.writeReceipt.bind(store);
        vi.spyOn(store, 'writeReceipt').mockImplementation((receipt) => {
          syncingReceipt = true;
          return write(receipt);
        });
      }
      if (checkpoint === 'original-job') {
        const write = store.writeJob.bind(store);
        vi.spyOn(store, 'writeJob').mockImplementation((record) => {
          if (record.jobId === job.jobId && record.state === 'complete') throw new Error('disk');
          return write(record);
        });
      }
      const result = await f.reconciliation(store).reconcile(job.jobId);
      expect(result).toMatchObject({
        state: 'internal-error',
        remote: { tag: 'exact', release: 'exact' },
      });
      expect(f.store.readJob(job.jobId).state).not.toBe('complete');
      expect(f.store.readIntent(plan.planId).jobId).toBe(job.jobId);
      const retry = await f.reconciliation().reconcile(job.jobId);
      expect(retry.state).toBe('complete');
      noRemoteWrites(f);
    },
  );

  it('deduplicates concurrent reads and refuses malformed history', async () => {
    const f = await fixture();
    const { job } = await accepted(f);
    const engine = f.reconciliation();
    const [first, second] = await Promise.all([
      engine.reconcile(job.jobId),
      engine.reconcile(job.jobId),
    ]);
    expect(first.jobId).toBe(second.jobId);
    const file = join(f.stateDir, 'jobs', `${job.jobId}.json`);
    writeFileSync(file, '{broken json');
    chmodSync(file, 0o600);
    await expect(engine.reconcileInterrupted()).rejects.toMatchObject({ code: 'malformed-record' });
    await expect(f.service().prepare('app')).rejects.toMatchObject({ code: 'internal-error' });
    noRemoteWrites(f);
  });

  it('pushes the frozen tag once after timely acceptance, even after expiry', async () => {
    const f = await fixture();
    const { plan, job } = await accepted(f);
    f.enablePush();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(plan.approvalDeadline) + 60_000);
    const engine = f.publication();
    const result = await engine.execute(job.jobId);
    expect(result).toMatchObject({ state: 'blocked', remote: { tag: 'exact', release: 'absent' } });
    expect(git(f.remote, 'rev-parse', `refs/tags/${plan.payload.tagName}`)).toBe(
      plan.payload.tag.objectId,
    );
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)')).toBe(
      'refs/heads/main\nrefs/tags/v0.1.0',
    );
    const receipt = f.reconciliation().receipt(job.jobId);
    expect(receipt).toContain('create-tag');
    expect(receipt).toContain('create-release');
    expect(receipt).toContain('fresh recovery plan');
    expect(receipt).not.toContain(TOKEN);
    await Promise.all([engine.execute(job.jobId), f.publication().execute(job.jobId)]);
    expect(readFileSync(f.sshLog, 'utf8').match(/git-receive-pack/g)).toHaveLength(1);
    expect(new Set(f.methods)).toEqual(new Set(['GET', 'POST']));
    expect(f.creates).toHaveLength(1);
  });

  it.each([
    ['reject', 'absent'],
    ['timeout', 'absent'],
    ['interrupt', 'absent'],
    ['lost', 'exact'],
    ['timeout-after', 'exact'],
    ['conflict', 'conflict'],
    ['unreadable', 'exact'],
    ['success-absent', 'absent'],
  ])('independently reconciles %s without retry or false completion', async (mode, tagState) => {
    const f = await fixture();
    const { plan, job } = await accepted(f);
    f.enablePush(mode === 'interrupt' ? 'timeout' : mode);
    if (mode === 'unreadable') {
      f.alterResponse((path, body) => {
        if (
          path.includes('/releases') &&
          readFileSync(f.sshLog, 'utf8').includes('git-receive-pack')
        ) {
          throw new Error(`unreadable ${TOKEN}`);
        }
        return body;
      });
    }
    const controller = new AbortController();
    const task = f
      .publication(f.store, { signal: controller.signal, timeoutMs: 500 })
      .execute(job.jobId);
    if (mode === 'interrupt') {
      for (
        let i = 0;
        i < 500 && !readFileSync(f.sshLog, 'utf8').includes('git-receive-pack');
        i++
      ) {
        await delay(10);
      }
      controller.abort();
    }
    const result = await task;
    expect(result.state).toBe(
      mode === 'conflict' || mode === 'unreadable' ? 'needs-inspection' : 'blocked',
    );
    expect(result.remote.tag).toBe(tagState);
    expect(result.remote.release).toBe(mode === 'unreadable' ? 'unknown' : 'absent');
    expect(f.store.readIntent(plan.planId).jobId).toBe(job.jobId);
    const log = readFileSync(f.sshLog, 'utf8');
    expect(log.slice(log.indexOf('git-receive-pack'))).toContain('git-upload-pack');
    await f.publication().execute(job.jobId);
    expect(readFileSync(f.sshLog, 'utf8').match(/git-receive-pack/g)).toHaveLength(1);
    expect(f.reconciliation().receipt(job.jobId)).not.toContain(TOKEN);
    if (mode === 'timeout') {
      installTag(f, plan); // A late effect is discoverable, never a reason to replay the write.
      await f.reconciliation().reconcile(job.jobId);
      expect(f.store.readJob(job.jobId).remote.tag).toBe('exact');
      expect(readFileSync(f.sshLog, 'utf8').match(/git-receive-pack/g)).toHaveLength(1);
    }
  });

  it.each([
    'account',
    'repository',
    'default-branch',
    'origin',
    'tagger',
    'workflow',
    'ci-result',
    'ci-commit',
    'candidate',
    'stable-tags',
    'baseline-target',
    'existing-tag',
    'release',
    'missing-intent',
    'corrupt-plan',
  ])('stops before mutation when %s changes', async (fact) => {
    const f = await fixture({ baseline: fact === 'baseline-target' });
    const { plan, job } = await accepted(f);
    f.enablePush();
    const configured = f.runtime.repositories[0]!.config;
    if (fact === 'origin') configured.origin = 'ssh://other@gitea.example.test/acme/api.git';
    if (fact === 'tagger') configured.tagger.name = 'Changed Bot';
    if (fact === 'workflow') configured.ci.workflowPath = '.gitea/workflows/other.yaml';
    if (fact === 'candidate') {
      writeFileSync(join(f.work, 'advanced'), 'new');
      git(f.work, 'add', '.');
      git(f.work, 'commit', '--quiet', '-m', 'Advanced');
      git(f.work, 'push', '--quiet', f.remote, 'main');
    }
    if (fact === 'stable-tags') git(f.remote, 'tag', 'v0.9.0');
    if (fact === 'baseline-target') {
      git(f.remote, 'update-ref', 'refs/tags/v0.1.0', f.commit);
    }
    if (fact === 'existing-tag') installTag(f, plan);
    if (fact === 'release') f.setRelease();
    if (fact === 'missing-intent') rmSync(join(f.stateDir, 'intents', `${plan.planId}.json`));
    if (fact === 'corrupt-plan') {
      const file = join(f.stateDir, 'plans', `${plan.planId}.json`);
      writeFileSync(file, '{malformed');
      await expect(f.publication().execute(job.jobId)).rejects.toMatchObject({
        code: 'malformed-record',
      });
      noRemoteWrites(f);
      return;
    }
    f.alterResponse((path, body) => {
      if (fact === 'account' && path.endsWith('/user')) return { ...body, id: 8 };
      if (fact === 'repository' && path === '/api/v1/repos/acme/api') return { ...body, id: 43 };
      if (fact === 'default-branch' && path === '/api/v1/repos/acme/api') {
        return { ...body, default_branch: 'other' };
      }
      if (fact === 'ci-result' && path.endsWith('/actions/runs/9')) {
        return { ...body, conclusion: 'failure' };
      }
      if (fact === 'ci-commit' && path.endsWith('/actions/runs/9')) {
        return { ...body, head_sha: 'a'.repeat(40) };
      }
      return body;
    });
    const result = await f.publication().execute(job.jobId);
    expect(result).toMatchObject({ state: 'blocked', errorCode: 'plan-stale' });
    expect(result.blocker?.message).toBeTruthy();
    noRemoteWrites(f);
  });

  it.each(['intent', 'attempt-marker', 'receipt'])(
    'fails safely on durable %s failure',
    async (checkpoint) => {
      const f = await fixture();
      const { plan, job } = await accepted(f);
      f.enablePush();
      if (checkpoint === 'intent') {
        vi.spyOn(f.store, 'writeIntent').mockImplementation(() => {
          throw new Error('disk');
        });
      }
      if (checkpoint === 'receipt') {
        vi.spyOn(f.store, 'writeReceipt').mockImplementation(() => {
          throw new Error('disk');
        });
      }
      if (checkpoint === 'attempt-marker') {
        const write = f.store.writeJob.bind(f.store);
        vi.spyOn(f.store, 'writeJob').mockImplementation((record) => {
          if (record.step === 'creating-tag') throw new Error('disk');
          return write(record);
        });
      }
      const result = await f.publication().execute(job.jobId);
      expect(result.state).toBe('internal-error');
      expect(f.store.readIntent(plan.planId).jobId).toBe(job.jobId);
      await f.publication().execute(job.jobId);
      if (checkpoint === 'receipt') {
        expect(result.remote.tag).toBe('exact');
        expect(readFileSync(f.sshLog, 'utf8').match(/git-receive-pack/g)).toHaveLength(1);
      } else noRemoteWrites(f);
    },
  );

  it.each(['candidate', 'configuration', 'account'])(
    'renews %s after slow CI reads before any push',
    async (fact) => {
      const f = await fixture();
      const { job } = await accepted(f);
      f.enablePush();
      let ciRead = false;
      f.alterResponse((path, body) => {
        if (path.endsWith('/actions/runs/9')) {
          ciRead = true;
          if (fact === 'candidate') {
            writeFileSync(join(f.work, 'advanced'), 'new');
            git(f.work, 'add', '.');
            git(f.work, 'commit', '--quiet', '-m', 'Advanced during CI');
            git(f.work, 'push', '--quiet', f.remote, 'main');
          }
          if (fact === 'configuration') {
            f.runtime.repositories[0]!.config.origin =
              'ssh://changed@gitea.example.test/acme/api.git';
          }
        }
        return fact === 'account' && ciRead && path.endsWith('/user') ? { ...body, id: 8 } : body;
      });
      const result = await f.publication().execute(job.jobId);
      expect(result).toMatchObject({ state: 'blocked', errorCode: 'plan-stale' });
      noRemoteWrites(f);
    },
  );

  it.each(['timeout', 'timeout-after'])(
    'reconciles %s inside the admitted operation during actual owner shutdown',
    async (mode) => {
      const f = await fixture();
      const { job } = await accepted(f);
      f.enablePush(mode);
      const controller = new AbortController();
      const running = f.publication(f.store, { signal: controller.signal }).execute(job.jobId);
      let launched = false;
      for (let i = 0; i < 500; i++) {
        launched = readFileSync(f.sshLog, 'utf8').includes('git-receive-pack');
        const effectReady =
          mode === 'timeout' ||
          git(f.remote, 'for-each-ref', '--format=%(refname)').includes('refs/tags/v0.1.0');
        if (launched && effectReady) break;
        await delay(10);
      }
      expect(launched).toBe(true);
      const shutdown = f.owner.shutdown();
      expect(f.owner.accepting).toBe(false);
      controller.abort();
      const result = await running;
      const remote = { tag: mode === 'timeout' ? 'absent' : 'exact', release: 'absent' };
      expect(result).toMatchObject({ state: 'blocked', remote });
      expect(f.store.readReceipt(result.reconciliationJobId!)).toMatchObject({
        state: 'blocked',
        remote,
        evidence: { publicationJobId: job.jobId, interruptedStep: 'creating-tag' },
      });
      expect(await shutdown).toEqual({ drained: true, pending: [], lockReleased: true });
      const log = readFileSync(f.sshLog, 'utf8');
      expect(log.slice(log.indexOf('git-receive-pack'))).toContain('git-upload-pack');
      expect(log.match(/git-receive-pack/g)).toHaveLength(1);
      expect(new Set(f.methods)).toEqual(new Set(['GET']));
    },
  );

  it('keeps an exact existing tag/release as a durably verified no-op', async () => {
    const f = await fixture({ baseline: true, sameCandidate: true });
    f.setRelease();
    const { job } = await accepted(f);
    const result = await f.publication().execute(job.jobId);
    expect(result).toMatchObject({
      state: 'complete',
      remote: { tag: 'exact', release: 'exact' },
    });
    expect(f.store.readReceipt(result.reconciliationJobId!).evidence?.release.author).toBe(
      'Actual Author',
    );
    expect(result.attemptedEffects ?? []).toEqual([]);
    noRemoteWrites(f);
  });

  it.each([false, true])(
    'creates the approved release once (existing tag=%s)',
    async (existing) => {
      const f = await fixture();
      const { plan, job } = await (existing ? acceptedWithTag(f) : accepted(f));
      f.enablePush();
      f.onCreate(async (input, init) => {
        expect(input).toBe(`${BASE}/api/v1/repos/acme/api/releases`);
        expect(init.redirect).toBe('manual');
        expect(init.headers).toMatchObject({
          Authorization: `token ${TOKEN}`,
          'Content-Type': 'application/json',
        });
        expect(JSON.parse(init.body as string)).toEqual({
          tag_name: plan.payload.tagName,
          name: plan.payload.title,
          body: plan.payload.notes.text,
          draft: false,
          prerelease: false,
        });
        expect(git(f.remote, 'rev-parse', `refs/tags/${plan.payload.tagName}`)).toBe(
          plan.payload.tag.objectId,
        );
        expect(f.store.readJob(job.jobId)).toMatchObject({
          state: 'running',
          step: 'creating-release',
        });
        expect(f.store.readIntent(plan.planId).jobId).toBe(job.jobId);
        f.setRelease();
        return new Response('not evidence', { status: 201 });
      });
      const write = f.store.writeJob.bind(f.store);
      vi.spyOn(f.store, 'writeJob').mockImplementation((record) => {
        if (record.jobId === job.jobId && record.state === 'complete') {
          expect(f.store.readReceipt(record.reconciliationJobId!).remote).toEqual({
            tag: 'exact',
            release: 'exact',
          });
        }
        return write(record);
      });
      const result = await f.publication().execute(job.jobId);
      expect(result).toMatchObject({
        state: 'complete',
        remote: { tag: 'exact', release: 'exact' },
      });
      const effects = existing ? ['create-release'] : ['create-tag', 'create-release'];
      expect(f.store.readReceipt(result.reconciliationJobId!).evidence).toMatchObject({
        attemptedEffects: effects.map((kind) => ({ kind, tag: plan.payload.tagName })),
        release: { author: 'Actual Author' },
      });
      await Promise.all([f.publication().execute(job.jobId), f.publication().execute(job.jobId)]);
      expect(f.creates).toHaveLength(1);
      expect(readFileSync(f.sshLog, 'utf8').match(/git-receive-pack/g) ?? []).toHaveLength(
        existing ? 0 : 1,
      );
      expect(f.reconciliation().receipt(job.jobId)).not.toContain(TOKEN);
    },
  );

  it.each([
    ['error', false],
    ['error', true],
    ['lost', false],
    ['lost', true],
    ['silent', false],
    ['silent', true],
    ['timeout', false],
    ['timeout', true],
    ['conflict', true],
    ['unreadable', true],
    ['tag-disappears', true],
  ])('independently proves create outcome after %s (remote effect=%s)', async (mode, effect) => {
    const f = await fixture();
    const { plan, job } = await acceptedWithTag(f);
    f.onCreate(async (_input, init) => {
      if (effect) f.setRelease();
      if (mode === 'conflict')
        f.alterResponse((path, body) =>
          path.includes('/releases/tags/') ? { ...body, body: 'conflicting notes' } : body,
        );
      if (mode === 'unreadable') f.unknownRelease();
      if (mode === 'unreadable') f.fail('/api/v1/repos/acme/api/releases/tags/v0.1.0');
      if (mode === 'tag-disappears') git(f.remote, 'update-ref', '-d', 'refs/tags/v0.1.0');
      if (mode === 'lost') throw new Error(`lost ${TOKEN}`);
      if (mode === 'timeout') {
        await new Promise<void>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error(`timeout ${TOKEN}`)), {
            once: true,
          });
        });
      }
      return new Response('', { status: mode === 'error' ? 500 : 201 });
    });
    const result = await f.publication(f.store, { timeoutMs: 50 }).execute(job.jobId);
    const exact = effect && !['conflict', 'unreadable', 'tag-disappears'].includes(mode);
    expect(result.state).toBe(exact ? 'complete' : effect ? 'needs-inspection' : 'blocked');
    expect(result.remote.release).toBe(
      mode === 'conflict'
        ? 'conflict'
        : mode === 'unreadable'
          ? 'unknown'
          : effect
            ? 'exact'
            : 'absent',
    );
    expect(result.remote.tag).toBe(mode === 'tag-disappears' ? 'absent' : 'exact');
    expect(f.store.readReceipt(result.reconciliationJobId!).evidence?.attemptedEffects).toEqual([
      { kind: 'create-release', tag: plan.payload.tagName },
    ]);
    await f.publication().execute(job.jobId);
    expect(f.creates).toHaveLength(1);
    expect(f.reconciliation().receipt(job.jobId)).not.toContain(TOKEN);
    if (!exact) expect(f.reconciliation().receipt(job.jobId)).toMatch(/recovery|reconcile|Inspect/);
    if (mode === 'lost' && !effect) {
      f.setRelease(); // Late effect: only new reads, never another POST.
      await f.reconciliation().reconcile(job.jobId);
      expect(f.store.readJob(job.jobId).state).toBe('complete');
      expect(f.creates).toHaveLength(1);
    }
  });

  it.each([
    'tag-disappears',
    'release-conflict',
    'identity',
    'ci',
    'candidate',
    'configuration',
    'intent',
  ])('blocks release creation when %s changes during the tag attempt', async (fact) => {
    const f = await fixture();
    const { plan, job } = await accepted(f);
    f.enablePush();
    let changed = false;
    f.alterResponse((path, body) => {
      if (
        !changed &&
        path.endsWith('/actions/runs/9') &&
        readFileSync(f.sshLog, 'utf8').includes('git-receive-pack')
      ) {
        changed = true;
        if (fact === 'tag-disappears') git(f.remote, 'update-ref', '-d', 'refs/tags/v0.1.0');
        if (fact === 'release-conflict') f.setRelease();
        if (fact === 'configuration') f.runtime.repositories[0]!.config.tagger.name = 'changed';
        if (fact === 'intent') rmSync(join(f.stateDir, 'intents', `${plan.planId}.json`));
        if (fact === 'candidate') {
          writeFileSync(join(f.work, 'advance'), 'new');
          git(f.work, 'add', '.');
          git(f.work, 'commit', '--quiet', '-m', 'Advanced during push');
          git(f.work, 'push', '--quiet', f.remote, 'main');
        }
      }
      if (changed && fact === 'identity' && path.endsWith('/user')) return { ...body, id: 8 };
      if (changed && fact === 'ci' && path.endsWith('/actions/runs/9'))
        return { ...body, conclusion: 'failure' };
      if (fact === 'release-conflict' && path.includes('/releases/tags/'))
        return { ...body, name: 'unapproved title' };
      return body;
    });
    const result = await f.publication().execute(job.jobId);
    expect(result.state).not.toBe('complete');
    expect(f.creates).toHaveLength(0);
    expect(readFileSync(f.sshLog, 'utf8').match(/git-receive-pack/g)).toHaveLength(1);
  });

  it.each(['intent', 'attempt-marker', 'receipt', 'publication-complete'])(
    'does not claim successful release after %s storage failure',
    async (checkpoint) => {
      const f = await fixture();
      const { plan, job } = await acceptedWithTag(f);
      f.onCreate(async () => {
        f.setRelease();
        return json({}, 201);
      });
      if (checkpoint === 'intent')
        vi.spyOn(f.store, 'writeIntent').mockImplementation(() => {
          throw new Error('disk');
        });
      if (checkpoint === 'receipt')
        vi.spyOn(f.store, 'writeReceipt').mockImplementation(() => {
          throw new Error('disk');
        });
      const write = f.store.writeJob.bind(f.store);
      vi.spyOn(f.store, 'writeJob').mockImplementation((record) => {
        if (checkpoint === 'attempt-marker' && record.step === 'creating-release')
          throw new Error('disk');
        if (
          checkpoint === 'publication-complete' &&
          record.jobId === job.jobId &&
          record.state === 'complete'
        )
          throw new Error('disk');
        return write(record);
      });
      const result = await f.publication().execute(job.jobId);
      expect(result.state).toBe('internal-error');
      expect(f.creates).toHaveLength(['intent', 'attempt-marker'].includes(checkpoint) ? 0 : 1);
      expect(f.store.readIntent(plan.planId).jobId).toBe(job.jobId);
      await f.publication().execute(job.jobId);
      vi.restoreAllMocks();
      if (!['intent', 'attempt-marker'].includes(checkpoint)) {
        await f.reconciliation().reconcile(job.jobId);
        expect(f.store.readJob(job.jobId).state).toBe('complete');
        expect(f.creates).toHaveLength(1);
      }
    },
  );

  it.each([false, true])(
    'drains independent reads during release-request shutdown (effect=%s)',
    async (effect) => {
      const f = await fixture();
      const { job } = await acceptedWithTag(f);
      const controller = new AbortController();
      let shutdown: ReturnType<typeof f.owner.shutdown> | undefined;
      f.onCreate(async (_input, init) => {
        if (effect) f.setRelease();
        shutdown = f.owner.shutdown();
        const rejected = new Promise<never>((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(new Error('interrupted')), {
            once: true,
          }),
        );
        controller.abort();
        return rejected;
      });
      const result = await f.publication(f.store, { signal: controller.signal }).execute(job.jobId);
      expect(result.state).toBe(effect ? 'complete' : 'blocked');
      expect(f.store.readReceipt(result.reconciliationJobId!).remote.release).toBe(
        effect ? 'exact' : 'absent',
      );
      expect(await shutdown).toEqual({ drained: true, pending: [], lockReleased: true });
      expect(f.creates).toHaveLength(1);
    },
  );

  it('requires fresh original-version approval after an uncertain absent effect', async () => {
    const f = await fixture();
    const { plan, job, approval } = await accepted(f);
    f.enablePush('reject');
    await f.publication().execute(job.jobId);
    writeFileSync(join(f.work, 'advanced'), 'new');
    git(f.work, 'add', '.');
    git(f.work, 'commit', '--quiet', '-m', 'Advanced before recovery');
    git(f.work, 'push', '--quiet', f.remote, 'main');
    const recovery = await prepared(f);
    expect(recovery.payload.recovery?.jobId).toBe(job.jobId);
    expect(recovery.payload.tag.objectId).toBe(plan.payload.tag.objectId);
    const acceptedRecovery = await approval.approve(
      { planId: recovery.planId, digest: recovery.digest },
      'admin',
    );
    f.enablePush();
    const result = await f.publication().execute(acceptedRecovery.jobId);
    expect(result.remote).toEqual({ tag: 'exact', release: 'absent' });
    expect(git(f.remote, 'rev-parse', 'refs/tags/v0.1.0')).toBe(plan.payload.tag.objectId);
    expect(readFileSync(f.sshLog, 'utf8').match(/git-receive-pack/g)).toHaveLength(2);
  });
});
