import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/load.js';
import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import type { AppConfig } from '../config/schema.js';
import type { ReleaseCiEvidence, ReleaseRepositoryIdentity } from '../core/release.js';
import { discoverReleaseCi, verifyReleaseCi, type ReleaseCiPathLister } from './ci.js';
import {
  createReleaseForgeClient,
  type ReleaseForgeClient,
  type ReleaseForgeFetch,
} from './forgeClient.js';
import { verifyReleaseIdentity } from './identity.js';

const RELEASE_TOKEN = 'canary_release_token_7f3a91';
const PLANNING_TOKEN = 'canary_planning_token_11bb02';
const BASE = 'https://gitea.example.test';
const WORKFLOW = '.gitea/workflows/validate.yaml';
const COMMIT = '3f1c0a5e8b2d47c9a6f0b13e5d8c2a7f4b9e0d61';
const OTHER_COMMIT = '9a8b7c6d5e4f30211203f4e5d6c7b8a990817263';

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
        workflowPath: ${WORKFLOW}
      ssh:
        privateKeyFile: /run/secrets/forge-desk-key
        knownHostsFile: /run/secrets/forge-desk-known-hosts
      tagger:
        name: Forge Desk Release Bot
        email: releases@example.test
`;

const ENV = {
  PLANNING_TOKEN_ENV: PLANNING_TOKEN,
  RELEASE_TOKEN_ENV: RELEASE_TOKEN,
  EV_BASIC_AUTH_PASSWORD: 'canary_login_password_2c9e',
};

function releaseConfig(): AppConfig {
  return parseConfig(RELEASE_YAML, ENV);
}

function runtimeFor(config: AppConfig): ReleaseRuntime {
  if (!config.releases.enabled) return { publicOrigin: '', stateDir: '', repositories: [] };
  return {
    publicOrigin: config.releases.publicOrigin,
    stateDir: config.releases.stateDir,
    repositories: config.releases.repositories.map((c) => ({ config: c, token: RELEASE_TOKEN })),
  };
}

const IDENTITY: ReleaseRepositoryIdentity = {
  repositoryId: 'app',
  forge: 'gitea',
  baseUrl: BASE,
  owner: 'acme',
  repo: 'api',
  forgeRepositoryId: 1001,
  defaultBranch: 'main',
};

const CANDIDATE = { commit: COMMIT, branch: 'main' };

const BOUND: ReleaseCiEvidence = {
  workflowPath: WORKFLOW,
  runId: 40,
  headCommit: COMMIT,
  branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
};

/** One Gitea Actions run as the release forge reports it. */
function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12,
    head_sha: COMMIT,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    path: 'validate.yaml@refs/heads/main',
    repository: { id: 1001, full_name: 'acme/api' },
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function runList(totalCount: number, runs: unknown[]): Response {
  return json({ total_count: totalCount, workflow_runs: runs });
}

/** Serves the run list by the requested page and limit, so pagination is real. */
function pagedRuns(
  totalCount: number,
  runs: unknown[],
  override?: (url: URL) => Response | undefined,
): (url: URL) => Response {
  return (url) => {
    const overridden = override?.(url);
    if (overridden !== undefined) return overridden;
    const page = Number(url.searchParams.get('page') ?? '1');
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const start = (page - 1) * limit;
    return runList(totalCount, runs.slice(start, start + limit));
  };
}

interface Forge {
  fetch: ReleaseForgeFetch;
  requests: URL[];
  methods: string[];
}

/** A candidate tree containing exactly the given committed paths. */
function candidateTree(paths: string[]): ReleaseCiPathLister {
  return () => Promise.resolve({ ok: true, value: paths });
}

/** The usual candidate: the `.gitea` workflow file. */
const GITEA_TREE = candidateTree([WORKFLOW]);
/** A candidate that only contains the `.github` workflow file. */
const GITHUB_TREE = candidateTree(['.github/workflows/validate.yaml']);
/** A candidate containing the same file name in both workflow directories. */
const BOTH_TREES = candidateTree([WORKFLOW, '.github/workflows/validate.yaml']);

/** A read-only forge whose handler serves run pages or a single run. */
function forge(handler: (url: URL) => Response): Forge {
  const requests: URL[] = [];
  const methods: string[] = [];
  const fetch: ReleaseForgeFetch = (input, init) => {
    const url = new URL(input);
    requests.push(url);
    methods.push(init.method ?? 'GET');
    try {
      return Promise.resolve(handler(url));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  return { fetch, requests, methods };
}

function client(fetch: ReleaseForgeFetch, maxResponseBytes?: number): ReleaseForgeClient {
  return createReleaseForgeClient({
    baseUrl: BASE,
    token: RELEASE_TOKEN,
    fetch,
    timeoutMs: 1_000,
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
  });
}

function listRequests(requests: URL[]): URL[] {
  return requests.filter((url) => url.pathname === '/api/v1/repos/acme/api/actions/runs');
}

describe('discoverReleaseCi', () => {
  it('follows every page and selects the highest numeric qualifying run id', async () => {
    const listed = [
      run({ id: 12 }),
      run({ id: 7, status: 'in_progress', conclusion: '' }),
      run({ id: 40 }),
      // Higher id, but another workflow: it must not win.
      run({ id: 99, path: 'other.yaml@refs/heads/main' }),
      // Higher id, but failed: it must not win either.
      run({ id: 500, conclusion: 'failure' }),
    ];
    const fixture = forge(pagedRuns(listed.length, listed));

    const result = await discoverReleaseCi({
      client: client(fixture.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      pageSize: 2,
    });

    expect(result).toEqual({
      ok: true,
      evidence: {
        workflowPath: WORKFLOW,
        runId: 40,
        headCommit: COMMIT,
        branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
      },
    });
    const pages = listRequests(fixture.requests);
    expect(pages.map((url) => url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(pages.map((url) => url.searchParams.get('limit'))).toEqual(['2', '2', '2']);
    expect(pages.every((url) => url.searchParams.get('head_sha') === COMMIT)).toBe(true);
    // Read-only discovery: no request can mutate or trigger anything.
    expect(fixture.methods.every((method) => method === 'GET')).toBe(true);
    expect(fixture.requests.some((url) => /releases|\/tags/.test(url.pathname))).toBe(false);
  });

  it('binds the configured workflow to the unique committed path the run names', async () => {
    const listedRun = run({ id: 40, path: 'validate.yaml@refs/heads/main' });
    const serveRuns = (url: URL) =>
      /\/actions\/runs\/40$/.test(url.pathname) ? json(listedRun) : runList(1, [listedRun]);

    const fixture = forge(serveRuns);
    const bound = await discoverReleaseCi({
      client: client(fixture.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error('expected evidence');
    // The evidence keeps the configured path; the run is matched by the file name it reports.
    expect(bound.evidence.workflowPath).toBe(WORKFLOW);
    const reRead = await verifyReleaseCi({
      client: client(fixture.fetch),
      identity: IDENTITY,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      evidence: bound.evidence,
    });
    expect(reRead.ok).toBe(true);
    // Provenance is re-read, not remembered: both calls list the candidate tree again.
    expect(fixture.requests.some((url) => url.pathname.endsWith('/actions/workflows'))).toBe(false);

    // A nested workflow inside a workflow directory binds by its reported identifier.
    const nestedPath = '.gitea/workflows/nested/validate.yaml';
    const nestedRun = run({ id: 40, path: 'nested/validate.yaml@refs/heads/main' });
    const nested = await discoverReleaseCi({
      client: client(forge(() => runList(1, [nestedRun])).fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: nestedPath,
      listPaths: candidateTree([nestedPath]),
    });
    expect(nested.ok).toBe(true);
    if (!nested.ok) throw new Error('expected evidence');
    expect(nested.evidence.workflowPath).toBe(nestedPath);

    // A `.github` workflow binds that file when the candidate contains only that file.
    const githubPath = '.github/workflows/validate.yaml';
    const github = await discoverReleaseCi({
      client: client(forge(serveRuns).fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: githubPath,
      listPaths: GITHUB_TREE,
    });
    expect(github.ok).toBe(true);
    if (!github.ok) throw new Error('expected evidence');
    expect(github.evidence.workflowPath).toBe(githubPath);

    // A run path naming the whole repository path resolves to the same committed file, so it is
    // accepted rather than read as a different workflow.
    const fullPath = await discoverReleaseCi({
      client: client(
        forge(() => runList(1, [run({ id: 40, path: `${WORKFLOW}@refs/heads/main` })])).fetch,
      ),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(fullPath.ok).toBe(true);
  });

  it('refuses a same-named workflow that is not the configured committed path', async () => {
    // The candidate has no configured workflow file; the only file with that name sits in another
    // directory, so a run reporting `validate.yaml` executed that other file.
    const elsewhere = candidateTree(['ci/workflows/validate.yaml']);
    const listedRun = run({ id: 40, path: 'validate.yaml@refs/heads/main' });
    const serveRuns = (url: URL) =>
      /\/actions\/runs\/40$/.test(url.pathname) ? json(listedRun) : runList(1, [listedRun]);

    const discovery = await discoverReleaseCi({
      client: client(forge(serveRuns).fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: elsewhere,
    });
    expect(discovery.ok).toBe(false);
    if (discovery.ok) throw new Error('expected a blocker');
    expect(discovery.blocker.code).toBe('ci-workflow-mismatch');

    const reRead = await verifyReleaseCi({
      client: client(forge(serveRuns).fetch),
      identity: IDENTITY,
      workflowPath: WORKFLOW,
      listPaths: elsewhere,
      evidence: BOUND,
    });
    expect(reRead.ok).toBe(false);
    if (reRead.ok) throw new Error('expected a blocker');
    expect(reRead.blocker.code).toBe('ci-evidence-changed');

    // A run path that does not name the verified default branch is not this workflow's push run.
    const otherRef = await discoverReleaseCi({
      client: client(
        forge(() => runList(1, [run({ id: 40, path: 'validate.yaml@refs/pull/7/head' })])).fetch,
      ),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(otherRef.ok).toBe(false);
    if (otherRef.ok) throw new Error('expected a blocker');
    expect(otherRef.blocker.code).toBe('ci-workflow-mismatch');
  });

  it('blocks when several committed files could be the run workflow', async () => {
    // Two committed files end with the identifier the run reports, so which one executed cannot be
    // proved for this candidate, whichever directory the server is configured to run.
    const listedRun = run({ id: 40, path: 'validate.yaml@refs/heads/main' });
    const serveRuns = (url: URL) =>
      /\/actions\/runs\/40$/.test(url.pathname) ? json(listedRun) : runList(1, [listedRun]);

    const trees = [
      ['both workflow directories', BOTH_TREES],
      ['a server-specific directory', candidateTree([WORKFLOW, 'ci/workflows/validate.yaml'])],
    ] as const;
    for (const [name, tree] of trees) {
      for (const designated of [
        '.gitea/workflows/validate.yaml',
        '.github/workflows/validate.yaml',
      ]) {
        const label = `${name}, ${designated}`;
        const discovery = await discoverReleaseCi({
          client: client(forge(serveRuns).fetch),
          identity: IDENTITY,
          candidate: CANDIDATE,
          workflowPath: designated,
          listPaths: tree,
        });
        expect(discovery.ok, label).toBe(false);
        if (discovery.ok) throw new Error(`expected a blocker for ${label}`);
        expect(discovery.blocker.code, label).toBe('ci-workflow-mismatch');

        const reRead = await verifyReleaseCi({
          client: client(forge(serveRuns).fetch),
          identity: IDENTITY,
          workflowPath: designated,
          listPaths: tree,
          evidence: { ...BOUND, workflowPath: designated },
        });
        expect(reRead.ok, label).toBe(false);
        if (reRead.ok) throw new Error(`expected a blocker for ${label}`);
        expect(reRead.blocker.code, label).toBe('ci-evidence-changed');
      }
    }

    // A same-named file with another name elsewhere in the candidate does not block.
    const unrelated = await discoverReleaseCi({
      client: client(forge(serveRuns).fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: candidateTree([WORKFLOW, 'docs/other.yaml']),
    });
    expect(unrelated.ok).toBe(true);
  });

  it('blocks when the candidate tree cannot establish the workflow file', async () => {
    const listedRun = run({ id: 40, path: 'validate.yaml@refs/heads/main' });
    const serveRuns = (url: URL) =>
      /\/actions\/runs\/40$/.test(url.pathname) ? json(listedRun) : runList(1, [listedRun]);

    const failures: Array<[string, ReleaseCiPathLister]> = [
      [
        'git read failed',
        () =>
          Promise.resolve({ ok: false, blocker: { code: 'git-failed', message: 'git failed' } }),
      ],
      ['tree reader threw', () => Promise.reject(new Error('boom'))],
    ];
    for (const [name, listPaths] of failures) {
      const result = await discoverReleaseCi({
        client: client(forge(serveRuns).fetch),
        identity: IDENTITY,
        candidate: CANDIDATE,
        workflowPath: WORKFLOW,
        listPaths,
      });
      expect(result.ok, name).toBe(false);
      if (result.ok) throw new Error(`expected a blocker for ${name}`);
      expect(result.blocker.code, name).toBe('ci-tree-unavailable');
    }

    // A candidate with no file named like the run's workflow cannot prove the workflow.
    const empty = await discoverReleaseCi({
      client: client(forge(serveRuns).fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: candidateTree(['README.md']),
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('expected a blocker');
    expect(empty.blocker.code).toBe('ci-workflow-mismatch');
  });

  it('binds the evidence to the verified repository, candidate, branch and configured workflow', async () => {
    const listed = [run({ id: 40 })];
    const fixture = forge(pagedRuns(1, listed));

    const result = await discoverReleaseCi({
      client: client(fixture.fetch),
      identity: IDENTITY,
      candidate: { commit: COMMIT, branch: 'main' },
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });

    expect(result).toEqual({ ok: true, evidence: BOUND });
    const runs = listRequests(fixture.requests);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.searchParams.get('head_sha')).toBe(COMMIT);
  });

  it('blocks every nonqualifying run state with a stable, distinct error', async () => {
    const cases: Array<[string, () => Response, string]> = [
      ['no run for the commit', () => runList(0, []), 'ci-run-missing'],
      ['unreadable run list', () => json({}, 403), 'unauthenticated'],
      ['run list not exposed', () => new Response('', { status: 404 }), 'ci-run-missing'],
      [
        'still running',
        () => runList(1, [run({ status: 'in_progress', conclusion: '' })]),
        'ci-run-pending',
      ],
      ['failed', () => runList(1, [run({ conclusion: 'failure' })]), 'ci-run-failed'],
      ['cancelled', () => runList(1, [run({ conclusion: 'cancelled' })]), 'ci-run-failed'],
      [
        'another workflow',
        () => runList(1, [run({ path: 'ci.yaml@refs/heads/main' })]),
        'ci-workflow-mismatch',
      ],
      [
        'not a push run',
        () => runList(1, [run({ event: 'pull_request', path: 'validate.yaml@refs/pull/7/head' })]),
        'ci-event-mismatch',
      ],
      [
        'another branch',
        () => runList(1, [run({ head_branch: 'release', path: `${WORKFLOW}@refs/heads/release` })]),
        'ci-branch-mismatch',
      ],
      ['another commit', () => runList(1, [run({ head_sha: OTHER_COMMIT })]), 'ci-commit-mismatch'],
      [
        'another repository',
        () => runList(1, [run({ repository: { id: 2002, full_name: 'acme/other' } })]),
        'repository-mismatch',
      ],
    ];

    for (const [name, handler, code] of cases) {
      const fixture = forge(handler);
      const result = await discoverReleaseCi({
        client: client(fixture.fetch),
        identity: IDENTITY,
        candidate: CANDIDATE,
        workflowPath: WORKFLOW,
        listPaths: GITEA_TREE,
      });
      expect(result.ok, name).toBe(false);
      if (result.ok) throw new Error(`expected a blocker for ${name}`);
      expect(result.blocker.code, name).toBe(code);
      expect(result.blocker.message).not.toContain(RELEASE_TOKEN);
    }
  });

  it('never echoes a credential the forge returns in a run path', async () => {
    // A hostile or broken server can put anything in a run path; the blocker must not repeat it,
    // because it can be the dedicated release token.
    const listed = forge(() =>
      runList(1, [run({ id: 40, path: `${RELEASE_TOKEN}@refs/heads/main` })]),
    );
    const result = await discoverReleaseCi({
      client: client(listed.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a blocker');
    expect(result.blocker.message).not.toContain(RELEASE_TOKEN);
  });

  it('blocks a malformed run or run list instead of accepting the readable parts', async () => {
    const malformed: Array<[string, unknown]> = [
      ['missing total', { workflow_runs: [] }],
      ['total not a number', { total_count: '1', workflow_runs: [] }],
      ['negative total', { total_count: -1, workflow_runs: [] }],
      ['runs not a list', { total_count: 1, workflow_runs: {} }],
      ['run not an object', { total_count: 1, workflow_runs: ['run'] }],
      [
        'run without a status',
        { total_count: 1, workflow_runs: [{ ...run(), status: undefined }] },
      ],
      [
        'run with a padded branch',
        { total_count: 1, workflow_runs: [run({ head_branch: ' main' })] },
      ],
      [
        'run without a repository id',
        { total_count: 1, workflow_runs: [run({ repository: { full_name: 'acme/api' } })] },
      ],
      [
        'run with a control character',
        { total_count: 1, workflow_runs: [run({ event: 'push\u0000' })] },
      ],
      ['not json', 'not-a-json-body'],
    ];

    for (const [field, body] of malformed) {
      const response =
        typeof body === 'string'
          ? new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
          : json(body);
      const fixture = forge(() => response);
      const result = await discoverReleaseCi({
        client: client(fixture.fetch),
        identity: IDENTITY,
        candidate: CANDIDATE,
        workflowPath: WORKFLOW,
        listPaths: GITEA_TREE,
      });
      expect(result.ok, field).toBe(false);
      if (result.ok) throw new Error(`expected a blocker for ${field}`);
      expect(result.blocker.code, field).toBe('malformed-response');
    }
  });

  it('accepts the last run when the page bound is filled exactly and refuses unbounded bounds', async () => {
    const listed = [run({ id: 2 }), run({ id: 9 })];
    const exact = forge(pagedRuns(2, listed));
    const exactResult = await discoverReleaseCi({
      client: client(exact.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      pageSize: 1,
      maxPages: 2,
    });
    expect(exactResult.ok).toBe(true);
    if (!exactResult.ok) throw new Error('expected evidence');
    expect(exactResult.evidence.runId).toBe(9);

    for (const bounds of [{ maxPages: 1e9 }, { maxRuns: 1e9 }]) {
      const unbounded = forge(() => runList(1, [run()]));
      const result = await discoverReleaseCi({
        client: client(unbounded.fetch),
        identity: IDENTITY,
        candidate: CANDIDATE,
        workflowPath: WORKFLOW,
        listPaths: GITEA_TREE,
        ...bounds,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a blocker');
      expect(result.blocker.code).toBe('invalid-request');
      expect(unbounded.requests).toHaveLength(0);
    }
  });

  it('accepts an equivalent forge origin spelling and refuses another port', async () => {
    const fixture = forge((url) =>
      /\/actions\/runs\/40$/.test(url.pathname) ? json(run({ id: 40 })) : runList(1, [run()]),
    );
    const explicitPort = createReleaseForgeClient({
      baseUrl: 'https://gitea.example.test:443',
      token: RELEASE_TOKEN,
      fetch: fixture.fetch,
    });
    expect(explicitPort.baseUrl).toBe(BASE);

    for (const call of [
      () =>
        discoverReleaseCi({
          client: explicitPort,
          identity: { ...IDENTITY, baseUrl: 'https://gitea.example.test:443' },
          candidate: CANDIDATE,
          workflowPath: WORKFLOW,
          listPaths: GITEA_TREE,
        }),
      () =>
        verifyReleaseCi({
          client: explicitPort,
          identity: { ...IDENTITY, baseUrl: 'https://gitea.example.test:443' },
          workflowPath: WORKFLOW,
          listPaths: GITEA_TREE,
          evidence: BOUND,
        }),
    ]) {
      const result = await call();
      expect(result.ok).toBe(true);
    }

    const otherPort = forge(() => runList(1, [run()]));
    const sameHostOtherPort = createReleaseForgeClient({
      baseUrl: 'https://gitea.example.test:8443',
      token: RELEASE_TOKEN,
      fetch: otherPort.fetch,
    });
    const refused = await discoverReleaseCi({
      client: sameHostOtherPort,
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a blocker');
    expect(refused.blocker.code).toBe('invalid-request');
    expect(otherPort.requests).toHaveLength(0);
  });

  it('refuses a client for another forge origin before any request', async () => {
    const fixture = forge(() => runList(1, [run()]));
    const otherOrigin = createReleaseForgeClient({
      baseUrl: 'https://gitea-other.example.test',
      token: RELEASE_TOKEN,
      fetch: fixture.fetch,
    });

    for (const call of [
      () =>
        discoverReleaseCi({
          client: otherOrigin,
          identity: IDENTITY,
          candidate: CANDIDATE,
          workflowPath: WORKFLOW,
          listPaths: GITEA_TREE,
        }),
      () =>
        verifyReleaseCi({
          client: otherOrigin,
          identity: IDENTITY,
          workflowPath: WORKFLOW,
          listPaths: GITEA_TREE,
          evidence: BOUND,
        }),
    ]) {
      const result = await call();
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a blocker');
      expect(result.blocker.code).toBe('invalid-request');
    }
    expect(fixture.requests).toHaveLength(0);
  });

  it('blocks a page larger than the requested page size', async () => {
    const fixture = forge(() => runList(3, [run({ id: 1 }), run({ id: 2 }), run({ id: 3 })]));
    const result = await discoverReleaseCi({
      client: client(fixture.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      pageSize: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a blocker');
    expect(result.blocker.code).toBe('malformed-response');
  });

  it('fails closed when bounded pagination cannot cover the reported runs', async () => {
    const listed = [run({ id: 1 }), run({ id: 2 }), run({ id: 3 }), run({ id: 4 })];
    const exhausted = forge(pagedRuns(4, listed));
    const exhaustedResult = await discoverReleaseCi({
      client: client(exhausted.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      pageSize: 2,
      maxPages: 1,
    });
    expect(exhaustedResult.ok).toBe(false);
    if (exhaustedResult.ok) throw new Error('expected a blocker');
    expect(exhaustedResult.blocker.code).toBe('ci-discovery-incomplete');

    const emptyPage = forge(
      pagedRuns(4, listed, (url) =>
        url.searchParams.get('page') === '2' ? runList(4, []) : undefined,
      ),
    );
    const emptyResult = await discoverReleaseCi({
      client: client(emptyPage.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      pageSize: 2,
    });
    expect(emptyResult.ok).toBe(false);
    if (emptyResult.ok) throw new Error('expected a blocker');
    expect(emptyResult.blocker.code).toBe('ci-discovery-incomplete');

    const repeated = forge(
      pagedRuns(4, listed, (url) =>
        url.searchParams.get('page') === '2'
          ? runList(4, [run({ id: 1 }), run({ id: 9 })])
          : undefined,
      ),
    );
    const repeatedResult = await discoverReleaseCi({
      client: client(repeated.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      pageSize: 2,
    });
    expect(repeatedResult.ok).toBe(false);
    if (repeatedResult.ok) throw new Error('expected a blocker');
    expect(repeatedResult.blocker.code).toBe('ci-evidence-conflict');

    const changedTotal = forge(
      pagedRuns(4, listed, (url) =>
        url.searchParams.get('page') === '2' ? runList(5, listed.slice(2)) : undefined,
      ),
    );
    const changedResult = await discoverReleaseCi({
      client: client(changedTotal.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      pageSize: 2,
    });
    expect(changedResult.ok).toBe(false);
    if (changedResult.ok) throw new Error('expected a blocker');
    expect(changedResult.blocker.code).toBe('ci-evidence-conflict');
  });

  it('refuses a run set above the enumeration bound instead of truncating it', async () => {
    const fixture = forge(() => runList(9, [run({ id: 1 })]));
    const result = await discoverReleaseCi({
      client: client(fixture.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      maxRuns: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a blocker');
    expect(result.blocker.code).toBe('ci-evidence-too-large');
  });

  it('refuses an unusable designated workflow or candidate before any request', async () => {
    for (const [workflowPath, code] of [
      ['/etc/validate.yaml', 'ci-workflow-invalid'],
      ['../validate.yaml', 'ci-workflow-invalid'],
      ['workflows/validate.sh', 'ci-workflow-invalid'],
    ] as const) {
      const fixture = forge(() => runList(1, [run()]));
      const result = await discoverReleaseCi({
        client: client(fixture.fetch),
        identity: IDENTITY,
        candidate: CANDIDATE,
        workflowPath,
        listPaths: GITEA_TREE,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a blocker');
      expect(result.blocker.code).toBe(code);
      expect(fixture.requests).toHaveLength(0);
    }

    const fixture = forge(() => runList(1, [run()]));
    const shortCommit = await discoverReleaseCi({
      client: client(fixture.fetch),
      identity: IDENTITY,
      candidate: { commit: 'abc123', branch: 'main' },
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(shortCommit.ok).toBe(false);
    if (shortCommit.ok) throw new Error('expected a blocker');
    expect(shortCommit.blocker.code).toBe('invalid-request');

    const oversizedPage = await discoverReleaseCi({
      client: client(fixture.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      pageSize: 500,
    });
    expect(oversizedPage.ok).toBe(false);
    if (oversizedPage.ok) throw new Error('expected a blocker');
    expect(oversizedPage.blocker.code).toBe('invalid-request');
    expect(fixture.requests).toHaveLength(0);

    const otherBranch = await discoverReleaseCi({
      client: client(fixture.fetch),
      identity: IDENTITY,
      candidate: { commit: COMMIT, branch: 'release' },
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(otherBranch.ok).toBe(false);
    if (otherBranch.ok) throw new Error('expected a blocker');
    expect(otherBranch.blocker.code).toBe('ci-branch-mismatch');
  });

  it('blocks a forge failure, redirect or oversized response without leaking the token', async () => {
    const outage = forge(() => {
      throw new TypeError(`fetch failed for token ${RELEASE_TOKEN}`);
    });
    const outageResult = await discoverReleaseCi({
      client: client(outage.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(outageResult.ok).toBe(false);
    if (outageResult.ok) throw new Error('expected a blocker');
    expect(outageResult.blocker.code).toBe('network-error');
    expect(outageResult.blocker.message).not.toContain(RELEASE_TOKEN);

    const redirected = forge(
      () => new Response('', { status: 307, headers: { location: 'https://evil.test/collect' } }),
    );
    const redirectResult = await discoverReleaseCi({
      client: client(redirected.fetch),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(redirectResult.ok).toBe(false);
    if (redirectResult.ok) throw new Error('expected a blocker');
    expect(redirectResult.blocker.code).toBe('redirect-refused');
    // Only the run list was redirected; the redirect target was never contacted.
    expect(listRequests(redirected.requests)).toHaveLength(1);
    expect(redirected.requests.some((url) => url.hostname === 'evil.test')).toBe(false);

    const oversized = forge(() =>
      json({ total_count: 1, workflow_runs: [run()], pad: 'x'.repeat(500) }),
    );
    const oversizedResult = await discoverReleaseCi({
      client: client(oversized.fetch, 200),
      identity: IDENTITY,
      candidate: CANDIDATE,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });
    expect(oversizedResult.ok).toBe(false);
    if (oversizedResult.ok) throw new Error('expected a blocker');
    expect(oversizedResult.blocker.code).toBe('response-too-large');
  });

  it('proves the configured push workflow and exact commit of the verified repository', async () => {
    const config = releaseConfig();
    // The verified default branch drives the expected workflow ref, so a run bound to another
    // branch of the same workflow cannot satisfy the plan.
    const runs = [
      run({ id: 12, head_branch: 'develop', path: 'validate.yaml@refs/heads/develop' }),
      run({ id: 31, head_branch: 'develop', path: 'validate.yaml@refs/heads/develop' }),
    ];
    const fixture = forge((url) => {
      switch (url.pathname) {
        case '/api/v1/user':
          return json({ id: 42, login: 'release-bot' });
        case '/api/v1/version':
          return json({ version: '1.26.1' });
        case '/api/v1/repos/acme/api':
          return json({
            id: 1001,
            full_name: 'acme/api',
            default_branch: 'develop',
            ssh_url: 'git@gitea.example.test:acme/api.git',
          });
        case '/api/v1/repos/acme/api/actions/runs':
          return runList(runs.length, runs);
        default:
          return new Response('not found', { status: 404 });
      }
    });

    const verified = await verifyReleaseIdentity({
      config,
      runtime: runtimeFor(config),
      repositoryId: 'app',
      fetch: fixture.fetch,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error('expected verified identity');

    const result = await discoverReleaseCi({
      client: client(fixture.fetch),
      identity: verified.identity.repository,
      candidate: { commit: COMMIT, branch: 'develop' },
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
    });

    expect(result).toEqual({
      ok: true,
      evidence: {
        workflowPath: WORKFLOW,
        runId: 31,
        headCommit: COMMIT,
        branch: 'develop',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
      },
    });
    const list = listRequests(fixture.requests);
    expect(list).toHaveLength(1);
    expect(list[0]?.searchParams.get('head_sha')).toBe(COMMIT);
    expect(fixture.methods.every((method) => method === 'GET')).toBe(true);
  });
});

describe('verifyReleaseCi', () => {
  function directRun(body: unknown, status = 200): { fixture: Forge; client: ReleaseForgeClient } {
    const fixture = forge(() => (status === 200 ? json(body) : new Response('', { status })));
    return { fixture, client: client(fixture.fetch) };
  }

  it('reads the exact bound run again and proves it still qualifies', async () => {
    const { fixture, client: releaseClient } = directRun(run({ id: 40 }));

    const result = await verifyReleaseCi({
      client: releaseClient,
      identity: IDENTITY,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      evidence: BOUND,
    });

    expect(result).toEqual({ ok: true, evidence: BOUND });
    const runRequests = fixture.requests.filter((url) => /\/actions\/runs\/40$/.test(url.pathname));
    expect(runRequests).toHaveLength(1);
    expect(runRequests[0]?.pathname).toBe('/api/v1/repos/acme/api/actions/runs/40');
    expect(runRequests[0]?.search).toBe('');
    expect(fixture.methods.every((method) => method === 'GET')).toBe(true);
  });

  it('blocks when the bound run no longer proves the same evidence', async () => {
    const cases: Array<[string, unknown, number?]> = [
      ['still running', run({ id: 40, status: 'in_progress', conclusion: '' })],
      ['now failing', run({ id: 40, conclusion: 'failure' })],
      ['another commit', run({ id: 40, head_sha: OTHER_COMMIT })],
      [
        'another branch ref',
        run({ id: 40, head_branch: 'main', path: 'validate.yaml@refs/heads/release' }),
      ],
      ['another workflow', run({ id: 40, path: 'other.yaml@refs/heads/main' })],
      ['not a push run', run({ id: 40, event: 'pull_request' })],
      ['another run id', run({ id: 41 })],
      ['another repository', run({ id: 40, repository: { id: 2002, full_name: 'acme/other' } })],
      ['gone', {}, 404],
    ];

    for (const [name, body, status] of cases) {
      const { client: releaseClient } = directRun(body, status);
      const result = await verifyReleaseCi({
        client: releaseClient,
        identity: IDENTITY,
        workflowPath: WORKFLOW,
        listPaths: GITEA_TREE,
        evidence: BOUND,
      });
      expect(result.ok, name).toBe(false);
      if (result.ok) throw new Error(`expected a blocker for ${name}`);
      const code = name === 'another repository' ? 'repository-mismatch' : 'ci-evidence-changed';
      expect(result.blocker.code, name).toBe(code);
      expect(result.blocker.message).not.toContain(RELEASE_TOKEN);
    }
  });

  it('blocks an unreadable, malformed or oversized re-read with a stable error', async () => {
    const failing = forge(() => json({ message: 'internal' }, 500));
    const failingResult = await verifyReleaseCi({
      client: client(failing.fetch),
      identity: IDENTITY,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      evidence: BOUND,
    });
    expect(failingResult.ok).toBe(false);
    if (failingResult.ok) throw new Error('expected a blocker');
    expect(failingResult.blocker.code).toBe('http-error');
    expect(failingResult.blocker.message).not.toContain(RELEASE_TOKEN);

    const malformed = forge(() => json({ ...run({ id: 40 }), head_sha: undefined }));
    const malformedResult = await verifyReleaseCi({
      client: client(malformed.fetch),
      identity: IDENTITY,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      evidence: BOUND,
    });
    expect(malformedResult.ok).toBe(false);
    if (malformedResult.ok) throw new Error('expected a blocker');
    expect(malformedResult.blocker.code).toBe('malformed-response');

    const oversized = forge(() => json({ ...run({ id: 40 }), pad: 'x'.repeat(500) }));
    const oversizedResult = await verifyReleaseCi({
      client: client(oversized.fetch, 200),
      identity: IDENTITY,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      evidence: BOUND,
    });
    expect(oversizedResult.ok).toBe(false);
    if (oversizedResult.ok) throw new Error('expected a blocker');
    expect(oversizedResult.blocker.code).toBe('response-too-large');
  });

  it('never rewrites bound evidence it cannot prove', async () => {
    const { fixture, client: releaseClient } = directRun(run({ id: 99 }));

    const result = await verifyReleaseCi({
      client: releaseClient,
      identity: IDENTITY,
      workflowPath: WORKFLOW,
      listPaths: GITEA_TREE,
      evidence: { ...BOUND, runId: 99, workflowPath: '.gitea/workflows/other.yaml' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a blocker');
    expect(result.blocker.code).toBe('ci-evidence-changed');
    // The mismatch is decided before any request: the bound workflow is not the configured one.
    expect(fixture.requests).toHaveLength(0);
  });

  it('blocks malformed bound evidence before any request', async () => {
    const cases = [
      { ...BOUND, runId: 0 },
      { ...BOUND, headCommit: 'abc123' },
      { ...BOUND, branch: 'release' },
      // A bound record that claims a cancelled/other status must not be provable either.
      { ...BOUND, status: 'in_progress' } as unknown as ReleaseCiEvidence,
    ];
    for (const evidence of cases) {
      const { fixture, client: releaseClient } = directRun(run({ id: 40 }));
      const result = await verifyReleaseCi({
        client: releaseClient,
        identity: IDENTITY,
        workflowPath: WORKFLOW,
        listPaths: GITEA_TREE,
        evidence,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a blocker');
      expect(result.blocker.code).toBe('ci-evidence-changed');
      expect(fixture.requests).toHaveLength(0);
    }
  });
});
