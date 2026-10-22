import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReleaseJob, ReleasePlan } from '../core/release.js';
import { main, type CliDeps, type CliIo } from './main.js';
import { RELEASE_EXIT } from './releases.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_ENV = 'FORGE_DESK_AUTH';
const MATERIAL = 'operator:s3cret-value';

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

interface Stub {
  url: string;
  requests: Recorded[];
  close: () => Promise<void>;
}

type Reply = { status: number; body?: unknown } | { status: number; text: string };

function reply(recorded: Recorded): Reply {
  return { status: 404, body: { code: 'not-found', error: 'unknown release resource' } };
}

const stubs: Stub[] = [];
async function startStub(handle: (request: Recorded) => Reply | Promise<Reply>): Promise<Stub> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const recorded: Recorded = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body,
      };
      requests.push(recorded);
      void Promise.resolve()
        .then(() => handle(recorded))
        .then(
          (answer) => {
            const payload = 'text' in answer ? answer.text : JSON.stringify(answer.body ?? null);
            response.writeHead(answer.status, {
              'content-type': 'text' in answer ? 'text/plain; charset=utf-8' : 'application/json',
            });
            response.end(payload);
          },
          () => request.socket.destroy(),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stub: Stub = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  stubs.push(stub);
  return stub;
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ev-releases-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const stub of stubs.splice(0)) await stub.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PLAN: ReleasePlan = {
  planId: 'plan-1',
  digest: 'a'.repeat(64),
  approvalDeadline: '2026-01-02T04:04:05.000Z',
  preparedAt: '2026-01-02T03:04:05.000Z',
  payload: {
    contractVersion: 1,
    stateSchemaVersion: 1,
    repository: {
      repositoryId: 'app',
      forge: 'gitea',
      baseUrl: 'https://git.example.com',
      owner: 'acme',
      repo: 'app',
      forgeRepositoryId: 7,
      defaultBranch: 'main',
    },
    account: {
      forge: 'gitea',
      baseUrl: 'https://git.example.com',
      login: 'release-bot',
      forgeUserId: 3,
    },
    tagger: { name: 'Forge Desk', email: 'forge-desk@example.com' },
    candidate: { commit: 'b'.repeat(40), branch: 'main' },
    baseline: { tag: 'v1.2.3', commit: 'c'.repeat(40), stableTags: ['v1.2.2', 'v1.2.3'] },
    ci: {
      workflowPath: '.gitea/workflows/ci.yml',
      runId: 42,
      headCommit: 'b'.repeat(40),
      branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    },
    notes: { text: '## Changes\n\n- one exact note line', digest: 'd'.repeat(64), source: 'file' },
    title: 'Release v1.2.4',
    tagName: 'v1.2.4',
    actions: [
      { kind: 'create-tag', tag: 'v1.2.4' },
      { kind: 'create-release', tag: 'v1.2.4' },
    ],
    warnings: [{ code: 'no-baseline', message: 'a warning the reviewer must see' }],
    blockers: [],
    tag: { state: 'absent', name: 'v1.2.4', commit: null, objectId: null, tagger: null },
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
  },
};

function jobOf(state: ReleaseJob['state'], extra: Partial<ReleaseJob> = {}): ReleaseJob {
  return {
    jobId: 'publish-1',
    kind: 'publish',
    planId: PLAN.planId,
    planDigest: PLAN.digest,
    state,
    step: state === 'running' ? 'observing-tag' : null,
    remote: { tag: 'absent', release: 'absent' },
    errorCode: null,
    ...extra,
  };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  opts: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    confirm?: (question: string) => Promise<boolean>;
  } = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: opts.env ?? { [AUTH_ENV]: MATERIAL },
    cwd: opts.cwd ?? ROOT,
    isTTY: false,
  };
  const deps: CliDeps = {
    releasePollMs: 1,
    ...(opts.confirm === undefined ? {} : { confirm: opts.confirm }),
  };
  const code = await main(argv, io, deps);
  return { code, stdout, stderr };
}

const rel = (url: string, command: string, id: string, ...rest: string[]): string[] => [
  'releases',
  command,
  id,
  '--server',
  url,
  '--auth-env',
  AUTH_ENV,
  ...rest,
];

const planGet = { status: 200, body: PLAN } as const;
const accepted = (jobId: string) => ({
  status: 202,
  body: { jobId, statusUrl: `/api/releases/jobs/${jobId}` },
});

/** Run the real executable, so its non-interactive wiring is what the assertions see. */
async function runExecutable(args: string[], env: Record<string, string>): Promise<Run> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT, 'src/cli/index.ts'), ...args],
    { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code: code ?? -1, stdout, stderr };
}

describe('executable', () => {
  it('runs without a planning config and never prompts where nobody can answer', async () => {
    const stub = await startStub(() => planGet);
    const result = await runExecutable(
      ['releases', 'publish', PLAN.planId, '--server', stub.url, '--auth-env', AUTH_ENV],
      { [AUTH_ENV]: MATERIAL },
    );
    expect(result.code).toBe(RELEASE_EXIT.cancelled);
    expect(result.stdout).toContain(PLAN.payload.notes.text);
    expect(result.stderr).toContain('--approve');
    expect(stub.requests.every((request) => request.method === 'GET')).toBe(true);
  }, 30_000);

  it('publishes the reviewed digest through the real routes', async () => {
    const stub = await startStub((request) =>
      request.method === 'GET' ? planGet : accepted('publish-1'),
    );
    const result = await runExecutable(
      [
        'releases',
        'publish',
        PLAN.planId,
        '--server',
        stub.url,
        '--auth-env',
        AUTH_ENV,
        '--approve',
        PLAN.digest,
      ],
      { [AUTH_ENV]: MATERIAL },
    );
    expect(result.code).toBe(0);
    const post = stub.requests.find((request) => request.method === 'POST')!;
    expect(post.headers.authorization).toBe(
      `Basic ${Buffer.from(MATERIAL, 'utf8').toString('base64')}`,
    );
    expect(JSON.parse(post.body)).toEqual({ digest: PLAN.digest });
    expect(result.stdout).toContain('accepted job publish-1');
  }, 30_000);
});

describe('release authentication', () => {
  it('requires exactly one authentication source', async () => {
    const stub = await startStub(reply);
    const both = await run([
      'releases',
      'prepare',
      'app',
      '--server',
      stub.url,
      '--auth-env',
      AUTH_ENV,
      '--auth-file',
      'creds.txt',
    ]);
    expect(both.code).toBe(RELEASE_EXIT.cancelled);
    expect(both.stderr).toContain('exactly one');
    expect(stub.requests).toHaveLength(0);
  });

  it('requires a server', async () => {
    const result = await run(['releases', 'status', 'job-1', '--auth-env', AUTH_ENV]);
    expect(result.code).toBe(RELEASE_EXIT.cancelled);
    expect(result.stderr).toContain('--server');
  });

  it('reads the private file and sends it only as an Authorization header', async () => {
    const stub = await startStub(() => ({ status: 200, body: jobOf('complete') }));
    const dir = tmp();
    const file = path.join(dir, 'credentials');
    writeFileSync(file, `${MATERIAL}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    const result = await run(
      ['releases', 'status', 'job-1', '--server', stub.url, '--auth-file', 'credentials'],
      { cwd: dir },
    );
    expect(result.code).toBe(0);
    const record = stub.requests[0]!;
    expect(record.headers.authorization).toBe(
      `Basic ${Buffer.from(MATERIAL, 'utf8').toString('base64')}`,
    );
    expect(record.headers.cookie).toBeUndefined();
    expect(result.stdout).not.toContain(MATERIAL);
    expect(result.stderr).not.toContain(MATERIAL);
    expect(result.stdout).not.toContain(Buffer.from(MATERIAL, 'utf8').toString('base64'));
  });

  it('refuses a credentials file that group or others can read', async () => {
    const stub = await startStub(() => ({ status: 200, body: jobOf('complete') }));
    const dir = tmp();
    const file = path.join(dir, 'credentials');
    writeFileSync(file, `${MATERIAL}\n`);
    chmodSync(file, 0o644);
    const result = await run(
      ['releases', 'status', 'job-1', '--server', stub.url, '--auth-file', 'credentials'],
      { cwd: dir },
    );
    expect(result.code).toBe(RELEASE_EXIT.cancelled);
    expect(result.stderr).toContain('0600');
    expect(stub.requests).toHaveLength(0);
  });

  it('reports a missing environment variable without its value', async () => {
    const stub = await startStub(() => ({ status: 200, body: jobOf('complete') }));
    const result = await run(rel(stub.url, 'status', 'job-1'), { env: {} });
    expect(result.code).toBe(RELEASE_EXIT.cancelled);
    expect(result.stderr).toContain(AUTH_ENV);
    expect(stub.requests).toHaveLength(0);
  });

  it('takes no password argument', async () => {
    const stub = await startStub(() => ({ status: 200, body: jobOf('complete') }));
    const result = await run([...rel(stub.url, 'status', 'job-1'), '--password', 'hunter2']);
    expect(result.code).toBe(RELEASE_EXIT.cancelled);
    expect(result.stderr).toContain('--password');
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses credentials inside the server URL instead of echoing them', async () => {
    const result = await run(
      [
        'releases',
        'status',
        'job-1',
        '--server',
        'https://user:pw@127.0.0.1:9',
        '--auth-env',
        AUTH_ENV,
      ],
      { env: { [AUTH_ENV]: MATERIAL } },
    );
    expect(result.code).toBe(RELEASE_EXIT.cancelled);
    expect(result.stderr).toContain('must not carry credentials');
    expect(result.stderr).not.toContain('pw');
  });

  it('sends no credential to a non-loopback plain-HTTP server', async () => {
    // Both would fail DNS, so an exit 2 rather than a transport error proves the gate fired first.
    for (const server of ['http://release.example.test', 'http://127.attacker.example']) {
      const result = await run(
        [
          'releases',
          'publish',
          PLAN.planId,
          '--server',
          server,
          '--auth-env',
          AUTH_ENV,
          '--approve',
          PLAN.digest,
        ],
        { env: { [AUTH_ENV]: MATERIAL } },
      );
      expect(result.code).toBe(RELEASE_EXIT.cancelled);
      expect(result.stderr).toContain('--server must use https');
      expect(result.stderr).not.toContain(MATERIAL);
      expect(result.stdout).toBe('');
    }
  });

  it('admits https and loopback http', async () => {
    // A refused connection on an admitted scheme proves the URL passed the transport gate.
    const result = await run(
      ['releases', 'status', 'job-1', '--server', 'https://127.0.0.1:1', '--auth-env', AUTH_ENV],
      { env: { [AUTH_ENV]: MATERIAL } },
    );
    expect(result.code).toBe(RELEASE_EXIT.internal);
    expect(result.stderr).toContain('cannot reach the server');
    expect(result.stderr).not.toContain('must use https');
  });
});

describe('prepare', () => {
  it('starts preparation through the server route and reports acceptance', async () => {
    const stub = await startStub(() => accepted('prepare-1'));
    const result = await run(rel(stub.url, 'prepare', 'app'));
    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/releases/repositories/app/prepare',
      body: '',
    });
    expect(result.stdout).toContain('accepted job prepare-1');
    expect(result.stdout).not.toContain('published');
  });

  it('prints the accepted job as JSON', async () => {
    const stub = await startStub(() => accepted('prepare-1'));
    const result = await run(rel(stub.url, 'prepare', 'app', '--json'));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      jobId: 'prepare-1',
      statusUrl: '/api/releases/jobs/prepare-1',
    });
  });

  it('waits for the job and reports the final result', async () => {
    let reads = 0;
    const stub = await startStub((request) => {
      if (request.method === 'POST') return accepted('prepare-1');
      reads += 1;
      return {
        status: 200,
        body: jobOf(reads === 1 ? 'running' : 'complete', {
          jobId: 'prepare-1',
          kind: 'prepare',
        }),
      };
    });
    const result = await run(rel(stub.url, 'prepare', 'app', '--wait'));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('accepted job prepare-1');
    expect(result.stdout).toContain('Job prepare-1');
    expect(result.stdout).toContain('complete');
    expect(result.stderr).toContain('running');
  });

  it('prints one JSON document per command, including while waiting', async () => {
    const stub = await startStub((request) =>
      request.method === 'POST'
        ? accepted('prepare-1')
        : { status: 200, body: jobOf('complete', { jobId: 'prepare-1', kind: 'prepare' }) },
    );
    const result = await run(rel(stub.url, 'prepare', 'app', '--json', '--wait'));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ jobId: 'prepare-1', state: 'complete' });
  });
});

describe('plan', () => {
  it('shows the exact plan and its notes', async () => {
    const stub = await startStub(() => planGet);
    const result = await run(rel(stub.url, 'plan', PLAN.planId));
    expect(result.code).toBe(0);
    expect(stub.requests[0]).toMatchObject({
      method: 'GET',
      path: `/api/releases/plans/${PLAN.planId}`,
    });
    for (const expected of [
      PLAN.digest,
      'acme/app',
      'v1.2.4',
      'Release v1.2.4',
      `ci.yml run 42`,
      'release-bot',
      'Tagger: Forge Desk',
      'create-tag v1.2.4, create-release v1.2.4',
      'no-baseline: a warning the reviewer must see',
      'Blockers: none',
      PLAN.approvalDeadline,
      PLAN.payload.notes.text,
    ]) {
      expect(result.stdout).toContain(expected);
    }
  });

  it('prints the exact server JSON', async () => {
    const stub = await startStub(() => planGet);
    const result = await run(rel(stub.url, 'plan', PLAN.planId, '--json'));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(PLAN);
  });

  it('shows repository-controlled control bytes inertly, keeping JSON exact', async () => {
    const hostile: ReleasePlan = {
      ...PLAN,
      payload: {
        ...PLAN.payload,
        title: 'release\u001b[2Jtitle',
        notes: { text: 'before\u001b[2J\u001b[H\rafter', digest: 'd'.repeat(64), source: 'file' },
      },
    };
    const stub = await startStub(() => ({ status: 200, body: hostile }));
    const human = await run(rel(stub.url, 'plan', PLAN.planId));
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain('\u001b');
    expect(human.stdout).not.toContain('\r');
    expect(human.stdout).toContain('before\\u001b[2J\\u001b[H\\u000dafter');
    expect(human.stdout).toContain('release\\u001b[2Jtitle');

    const machine = await run(rel(stub.url, 'plan', PLAN.planId, '--json'));
    expect(machine.code).toBe(0);
    expect(JSON.parse(machine.stdout).payload.notes.text).toBe('before\u001b[2J\u001b[H\rafter');
  });
});

describe('publish', () => {
  it('shows the plan, asks with default No and submits the reviewed digest', async () => {
    const stub = await startStub((request) =>
      request.method === 'GET' ? planGet : accepted('publish-1'),
    );
    const questions: string[] = [];
    const result = await run(rel(stub.url, 'publish', PLAN.planId), {
      confirm: (question) => {
        questions.push(question);
        return Promise.resolve(true);
      },
    });
    expect(result.code).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('acme/app v1.2.4');
    expect(questions[0]).toContain(PLAN.digest);
    expect(questions[0]).toContain('[y/N]');
    expect(result.stdout).toContain(PLAN.payload.notes.text);
    const post = stub.requests.find((request) => request.method === 'POST')!;
    expect(post.path).toBe(`/api/releases/plans/${PLAN.planId}/publish`);
    expect(JSON.parse(post.body)).toEqual({ digest: PLAN.digest });
    expect(result.stdout).toContain('accepted job publish-1');
    expect(result.stdout).not.toContain('published');
  });

  it('cancels before submission when the answer is not yes', async () => {
    const stub = await startStub(() => planGet);
    const result = await run(rel(stub.url, 'publish', PLAN.planId), {
      confirm: () => Promise.resolve(false),
    });
    expect(result.code).toBe(RELEASE_EXIT.cancelled);
    expect(result.stderr).toContain('cancelled before submission');
    expect(stub.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('requires --approve when nothing can answer interactively', async () => {
    const stub = await startStub(() => planGet);
    const result = await run(rel(stub.url, 'publish', PLAN.planId));
    expect(result.code).toBe(RELEASE_EXIT.cancelled);
    expect(result.stderr).toContain('--approve');
    expect(stub.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('submits a matching digest non-interactively', async () => {
    const stub = await startStub((request) =>
      request.method === 'GET' ? planGet : accepted('publish-1'),
    );
    const result = await run(rel(stub.url, 'publish', PLAN.planId, '--approve', PLAN.digest));
    expect(result.code).toBe(0);
    const post = stub.requests.find((request) => request.method === 'POST')!;
    expect(JSON.parse(post.body)).toEqual({ digest: PLAN.digest });
  });

  it('prints only the server response as JSON', async () => {
    const stub = await startStub((request) =>
      request.method === 'GET' ? planGet : accepted('publish-1'),
    );
    const result = await run(
      rel(stub.url, 'publish', PLAN.planId, '--approve', PLAN.digest, '--json'),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      jobId: 'publish-1',
      statusUrl: '/api/releases/jobs/publish-1',
    });
  });

  it('shows the plan before an interactive answer in JSON mode', async () => {
    const stub = await startStub((request) =>
      request.method === 'GET' ? planGet : accepted('publish-1'),
    );
    const result = await run(rel(stub.url, 'publish', PLAN.planId, '--json'), {
      confirm: () => Promise.resolve(true),
    });
    expect(result.code).toBe(0);
    // stdout stays one JSON document; the review the operator approves is on stderr.
    expect(JSON.parse(result.stdout)).toEqual({
      jobId: 'publish-1',
      statusUrl: '/api/releases/jobs/publish-1',
    });
    expect(result.stderr).toContain(PLAN.digest);
    expect(result.stderr).toContain(PLAN.payload.notes.text);
    expect(stub.requests.some((request) => request.method === 'POST')).toBe(true);
  });

  it('refuses a digest that is not the reviewed plan', async () => {
    const stub = await startStub(() => planGet);
    const result = await run(rel(stub.url, 'publish', PLAN.planId, '--approve', 'e'.repeat(64)));
    expect(result.code).toBe(RELEASE_EXIT.cancelled);
    expect(result.stderr).toContain('is not the digest of plan plan-1');
    expect(stub.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('reports a completed job after waiting', async () => {
    const stub = await startStub((request) => {
      if (request.method === 'GET' && request.path.startsWith('/api/releases/plans/'))
        return planGet;
      if (request.method === 'POST') return accepted('publish-1');
      return { status: 200, body: jobOf('complete') };
    });
    const result = await run(
      rel(stub.url, 'publish', PLAN.planId, '--approve', PLAN.digest, '--wait'),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Job publish-1');
  });

  it('exits 4 when the publication answer is lost after submission', async () => {
    const stub = await startStub((request) => {
      if (request.method === 'GET') return planGet;
      throw new Error('drop the connection instead of answering');
    });
    const result = await run(rel(stub.url, 'publish', PLAN.planId, '--approve', PLAN.digest));
    expect(result.code).toBe(RELEASE_EXIT.unproved);
    expect(result.stderr).toContain('cannot reach the server');
    expect(result.stderr).not.toContain(MATERIAL);
  });
});

describe('status', () => {
  it('maps a terminal job state to its exit code', async () => {
    const cases: [ReleaseJob['state'], number][] = [
      ['complete', 0],
      ['blocked', RELEASE_EXIT.blocked],
      ['needs-inspection', RELEASE_EXIT.unproved],
      ['internal-error', RELEASE_EXIT.internal],
      ['running', 0],
    ];
    for (const [state, code] of cases) {
      const stub = await startStub(() => ({ status: 200, body: jobOf(state) }));
      const result = await run(rel(stub.url, 'status', 'publish-1'));
      expect(result.code).toBe(code);
      expect(stub.requests[0]!.path).toBe('/api/releases/jobs/publish-1');
    }
  });

  it('prints the job as JSON', async () => {
    const stub = await startStub(() => ({
      status: 200,
      body: jobOf('needs-inspection', {
        errorCode: 'attempt-unresolved',
        attemptedEffects: [{ kind: 'create-tag', tag: 'v1.2.4' }],
      }),
    }));
    const result = await run(rel(stub.url, 'status', 'publish-1', '--json'));
    expect(result.code).toBe(RELEASE_EXIT.unproved);
    expect(JSON.parse(result.stdout)).toMatchObject({
      jobId: 'publish-1',
      state: 'needs-inspection',
      attemptedEffects: [{ kind: 'create-tag', tag: 'v1.2.4' }],
    });
  });

  it('follows a queued job when asked to wait', async () => {
    const states: ReleaseJob['state'][] = ['queued', 'running', 'complete'];
    let reads = 0;
    const stub = await startStub(() => {
      const state = states[Math.min(reads, states.length - 1)] as ReleaseJob['state'];
      reads += 1;
      return { status: 200, body: jobOf(state) };
    });
    const result = await run(rel(stub.url, 'status', 'publish-1', '--wait'));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Job publish-1');
    expect(result.stdout).toContain('complete');
    expect(reads).toBe(3);
  });
});

describe('reconcile', () => {
  it('starts a read-only reconciliation job', async () => {
    const stub = await startStub(() => accepted('reconcile-1'));
    const result = await run(rel(stub.url, 'reconcile', 'publish-1'));
    expect(result.code).toBe(0);
    expect(stub.requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/releases/jobs/publish-1/reconcile',
    });
    expect(result.stdout).toContain('accepted job reconcile-1');
  });

  it('exits 3 for an unresolved attempt', async () => {
    const stub = await startStub(() => ({
      status: 409,
      body: { code: 'attempt-unresolved', error: 'no reconciliation evidence' },
    }));
    const result = await run(rel(stub.url, 'reconcile', 'publish-1'));
    expect(result.code).toBe(RELEASE_EXIT.blocked);
    expect(result.stderr).toContain('attempt-unresolved');
  });
});

describe('server failures', () => {
  it.each([
    [400, 'invalid-request', RELEASE_EXIT.cancelled],
    [401, 'not-authenticated', RELEASE_EXIT.cancelled],
    [403, 'origin-rejected', RELEASE_EXIT.cancelled],
    [404, 'not-found', RELEASE_EXIT.cancelled],
    [409, 'plan-stale', RELEASE_EXIT.blocked],
    [410, 'plan-expired', RELEASE_EXIT.blocked],
    [503, 'execution-unavailable', RELEASE_EXIT.blocked],
    [500, 'internal-error', RELEASE_EXIT.internal],
  ])('maps HTTP %s (%s) to its exit code', async (status, code, exitCode) => {
    const stub = await startStub(() => ({ status, body: { code, error: 'server says no' } }));
    const result = await run(rel(stub.url, 'status', 'publish-1'));
    expect(result.code).toBe(exitCode);
    expect(result.stderr).toContain(code);
  });

  it('exits 5 when a read cannot reach the server', async () => {
    const stub = await startStub(() => planGet);
    const url = stub.url;
    await stub.close();
    const result = await run(rel(url, 'status', 'publish-1'));
    expect(result.code).toBe(RELEASE_EXIT.internal);
    expect(result.stderr).toContain('cannot reach the server');
  });
});
