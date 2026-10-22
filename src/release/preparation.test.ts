import { execFileSync } from 'node:child_process';
import {
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
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config/load.js';
import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import type { ReleaseJob, ReleasePlan } from '../core/release.js';
import { releasePlanDigest } from '../core/releaseDigest.js';
import { acquireReleaseOwnership, type ReleaseOwnership } from '../service/releaseOwnership.js';
import { ReleaseStateStore } from '../service/releaseState.js';
import { ReleasePreparation } from './preparation.js';

const PATH = process.env['PATH'];
const NOTES = '# Changes\n\n- Exact committed bytes: é\n';
const TOKEN = 'release_canary_93_do_not_persist';
const BASE = 'https://gitea.example.test';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  process.env['PATH'] = PATH;
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
  const config = parseConfig(
    `
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
`,
    { PASSWORD: 'password', PLANNING: 'read-token', RELEASE: TOKEN },
  );
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
  const fetch = async (input: string, init: RequestInit) => {
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
    if (path.endsWith('/actions/runs')) {
      await ciWait;
      return json({
        total_count: 1,
        workflow_runs: [
          {
            id: 9,
            head_sha: commit,
            head_branch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            path: 'validate.yaml@refs/heads/main',
            repository: { id: 42, full_name: 'acme/api' },
          },
        ],
      });
    }
    if (path.includes('/releases/tags/')) {
      return json(release, release === null ? releaseStatus : 200);
    }
    if (path.endsWith('/releases')) return json(release === null ? [] : [release]);
    throw new Error(`unexpected read ${path}`);
  };
  const service = (state = store, ownership: ReleaseOwnership = owner) =>
    new ReleasePreparation({ config, runtime, ownership, store: state, fetch });
  return {
    root,
    remote,
    work,
    stateDir,
    store,
    service,
    owner,
    methods,
    sshLog,
    commit,
    runtime,
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
