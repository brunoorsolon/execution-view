import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseJob, ReleasePlan, ReleasePlanWarning } from '../../../src/core/release.js';
import { createReleasesView, publishBlocker } from './releases.js';

// ---------------------------------------------------------------------------
// Minimal DOM, enough for the Releases view. Node's vitest environment has no
// document; the view only needs create/append/attribute/listener/query support.
// ---------------------------------------------------------------------------

class FakeText {
  constructor(private readonly data: string) {}
  get textContent(): string {
    return this.data;
  }
}

const focused: FakeElement[] = [];

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly childNodes: (FakeElement | FakeText)[] = [];
  value = '';
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  get hidden(): boolean {
    return this.attributes.has('hidden');
  }
  set hidden(value: boolean) {
    if (value) this.setAttribute('hidden', '');
    else this.attributes.delete('hidden');
  }
  get disabled(): boolean {
    return this.attributes.has('disabled');
  }
  set disabled(value: boolean) {
    if (value) this.setAttribute('disabled', '');
    else this.attributes.delete('disabled');
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn({});
  }
  focus(): void {
    focused.push(this);
  }
  append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const node of nodes)
      this.childNodes.push(typeof node === 'string' ? new FakeText(node) : node);
  }
  removeChild(node: FakeElement | FakeText): void {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
  }
  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.childNodes.length = 0;
    if (value !== '') this.childNodes.push(new FakeText(value));
  }
  querySelector(selector: string): FakeElement | null {
    const tag = selector.toLowerCase();
    for (const node of this.childNodes) {
      if (!(node instanceof FakeElement)) continue;
      if (node.tagName === tag) return node;
      const nested = node.querySelector(tag);
      if (nested !== null) return nested;
    }
    return null;
  }
}

beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
  };
});

afterAll(() => {
  delete (globalThis as { document?: unknown }).document;
});

beforeEach(() => {
  vi.useFakeTimers();
  focused.length = 0;
  (globalThis as { location?: unknown }).location = {
    hash: '#/releases/app',
    assign: (): void => undefined,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as { location?: unknown }).location;
});

function descendants(el: FakeElement, predicate: (node: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  const visit = (node: FakeElement): void => {
    if (predicate(node)) found.push(node);
    for (const child of node.childNodes) if (child instanceof FakeElement) visit(child);
  };
  visit(el);
  return found;
}

function button(view: FakeElement, text: string): FakeElement {
  const match = descendants(
    view,
    (node) =>
      node.tagName === 'button' &&
      (node.textContent === text || node.textContent.startsWith(`${text} `)),
  )[0];
  if (match === undefined) throw new Error(`missing button: ${text}`);
  return match;
}

function buttonStartsWith(view: FakeElement, prefix: string): FakeElement | undefined {
  return descendants(
    view,
    (node) => node.tagName === 'button' && node.textContent.startsWith(prefix),
  )[0];
}

/** Flushes pending microtasks of the view's promise chains. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

interface Call {
  path: string;
  init: RequestInit | undefined;
}

function stubFetch(handler: (path: string, init: RequestInit | undefined) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    try {
      return Promise.resolve(handler(path, init));
    } catch (error) {
      return Promise.reject(error);
    }
  });
  return calls;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIGEST = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

function planFixture(
  overrides: {
    approvalDeadline?: string;
    blockers?: ReleasePlanWarning[];
    recovery?: { jobId: string; defaultBranchHead: string; tagCreatedAt: string };
  } = {},
): ReleasePlan {
  return {
    planId: 'plan-1',
    digest: DIGEST,
    approvalDeadline: overrides.approvalDeadline ?? '2999-01-01T00:00:00.000Z',
    preparedAt: '2026-01-01T00:00:00.000Z',
    payload: {
      contractVersion: 1,
      stateSchemaVersion: 1,
      repository: {
        repositoryId: 'app',
        forge: 'gitea',
        baseUrl: 'https://gitea.example.test',
        owner: 'example',
        repo: 'app',
        forgeRepositoryId: 7,
        defaultBranch: 'main',
      },
      account: {
        forge: 'gitea',
        baseUrl: 'https://gitea.example.test',
        login: 'release-bot',
        forgeUserId: 9,
      },
      tagger: { name: 'Forge Desk Release Bot', email: 'releases@example.test' },
      candidate: { commit: COMMIT, branch: 'main' },
      baseline: { tag: null, commit: null, stableTags: [] },
      ci: {
        workflowPath: '.gitea/workflows/validate.yaml',
        runId: 12,
        headCommit: COMMIT,
        branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
      },
      notes: {
        text: '## Changes\n\n- one committed change',
        digest: 'c'.repeat(64),
        source: 'file',
      },
      title: 'v0.1.0',
      tagName: 'v0.1.0',
      actions: [
        { kind: 'create-tag', tag: 'v0.1.0' },
        { kind: 'create-release', tag: 'v0.1.0' },
      ],
      warnings: [],
      blockers: overrides.blockers ?? [],
      tag: {
        state: 'absent',
        name: 'v0.1.0',
        commit: null,
        objectId: 'd'.repeat(40),
        tagger: null,
      },
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
      ...(overrides.recovery === undefined ? {} : { recovery: overrides.recovery }),
    },
  };
}

function jobFixture(overrides: Partial<ReleaseJob> = {}): ReleaseJob {
  return {
    jobId: 'publish-1',
    kind: 'publish',
    planId: 'plan-1',
    planDigest: DIGEST,
    state: 'queued',
    step: null,
    remote: { tag: 'absent', release: 'absent' },
    errorCode: null,
    ...overrides,
  };
}

const REPOSITORY = {
  id: 'app',
  repo: 'example/app',
  source: 'gt',
  forge: 'https://gitea.example.test',
  capability: 'available',
  blockers: [],
};

const SESSION = () => Response.json({ username: 'operator', csrfToken: 'session-proof' });

function reads(plan: ReleasePlan): (path: string, init: RequestInit | undefined) => Response {
  return (path, init) => {
    if (path === 'api/session') return SESSION();
    if (path === 'api/releases/repositories') return Response.json([REPOSITORY]);
    if (path.startsWith('api/releases/repositories/app/jobs'))
      return Response.json({ items: [], total: 0, limit: 25, offset: 0 });
    if (path === 'api/releases/plans/plan-1') return Response.json(plan);
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
  };
}

// ---------------------------------------------------------------------------
// Approval submission
// ---------------------------------------------------------------------------

describe('publish action', () => {
  it('names the repository and version and submits the displayed digest once', async () => {
    const plan = planFixture();
    const calls = stubFetch((path, init) =>
      path === 'api/releases/plans/plan-1/publish'
        ? Response.json(jobFixture(), { status: 202 })
        : reads(plan)(path, init),
    );
    const view = createReleasesView();
    await view.open({ repositoryId: 'app', jobId: null, planId: 'plan-1' });

    const publishButton = button(view.el, 'Publish example/app v0.1.0');
    expect(publishButton.disabled).toBe(false);
    // The review shows the byte-for-byte digest the client submits.
    expect(view.el.textContent).toContain(DIGEST);

    publishButton.click();
    publishButton.click();
    await settle();

    const submits = calls.filter((call) => call.init?.method === 'POST');
    expect(submits).toHaveLength(1);
    expect(submits[0]?.path).toBe('api/releases/plans/plan-1/publish');
    expect(submits[0]?.init?.body).toBe(JSON.stringify({ digest: DIGEST }));
    expect(submits[0]?.init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-csrf-token': 'session-proof',
    });
  });

  it('disables publish with a readable reason for blockers and expired plans', async () => {
    for (const plan of [
      planFixture({ blockers: [{ code: 'ci-missing', message: 'no successful run' }] }),
      planFixture({ approvalDeadline: '2000-01-01T00:00:00.000Z' }),
    ]) {
      const calls = stubFetch(reads(plan));
      const view = createReleasesView();
      await view.open({ repositoryId: 'app', jobId: null, planId: 'plan-1' });
      const publishButton = button(view.el, 'Publish example/app v0.1.0');
      expect(publishButton.disabled).toBe(true);
      expect(view.el.textContent).toContain('Publish unavailable:');
      expect(view.el.textContent).toContain(
        plan.payload.blockers.length > 0 ? 'ci-missing' : 'the plan expired at',
      );
      publishButton.click();
      await settle();
      expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
      view.close();
    }
  });

  it('refuses to submit an approval that expires while the plan is on screen', async () => {
    const deadline = new Date(Date.now() + 1000).toISOString();
    const plan = planFixture({ approvalDeadline: deadline });
    const calls = stubFetch(reads(plan));
    const view = createReleasesView();
    await view.open({ repositoryId: 'app', jobId: null, planId: 'plan-1' });
    const publishButton = button(view.el, 'Publish example/app v0.1.0');
    expect(publishButton.disabled).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    publishButton.click();
    await settle();

    expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    expect(publishButton.disabled).toBe(true);
    expect(view.el.textContent).toContain('the plan expired at');
  });

  it('reports which fact changed and offers a fresh preparation for a stale plan', async () => {
    const plan = planFixture();
    const calls = stubFetch((path, init) =>
      path === 'api/releases/plans/plan-1/publish'
        ? Response.json(
            {
              code: 'plan-stale',
              error: 'The default-branch candidate or recovery reachability changed.',
            },
            { status: 409 },
          )
        : reads(plan)(path, init),
    );
    const view = createReleasesView();
    await view.open({ repositoryId: 'app', jobId: null, planId: 'plan-1' });
    button(view.el, 'Publish example/app v0.1.0').click();
    await settle();

    expect(view.el.textContent).toContain('This plan is stale');
    expect(view.el.textContent).toContain(
      'The default-branch candidate or recovery reachability changed.',
    );
    expect(buttonStartsWith(view.el, 'Prepare a fresh plan')).toBeDefined();
    expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('disables publish while an accepted publication is unresolved', async () => {
    const plan = planFixture();
    stubFetch((path, init) => {
      if (path === 'api/releases/jobs/publish-1')
        return Response.json(
          jobFixture({
            state: 'needs-inspection',
            step: 'observing-tag',
            errorCode: 'attempt-unresolved',
            remote: { tag: 'unknown', release: 'unknown' },
            attemptedEffects: [{ kind: 'create-tag', tag: 'v0.1.0' }],
            blocker: { code: 'tag-push-returned', message: 'One non-force tag push returned.' },
          }),
        );
      return reads(plan)(path, init);
    });
    const view = createReleasesView();
    await view.open({ repositoryId: 'app', jobId: 'publish-1', planId: 'plan-1' });

    const publishButton = button(view.el, 'Publish example/app v0.1.0');
    expect(publishButton.disabled).toBe(true);
    expect(view.el.textContent).toContain('Publish unavailable: an accepted publication');
  });
});

// ---------------------------------------------------------------------------
// Progress and recovery
// ---------------------------------------------------------------------------

describe('progress polling', () => {
  it('reads job state until a terminal state and never writes', async () => {
    const plan = planFixture();
    const states: ReleaseJob[] = [
      jobFixture(),
      jobFixture({ state: 'running', step: 'creating-tag' }),
      jobFixture({
        state: 'complete',
        step: 'finished',
        remote: { tag: 'exact', release: 'exact' },
        blocker: { code: 'verified-no-op', message: 'exact' },
      }),
    ];
    const jobCalls: string[] = [];
    stubFetch((path, init) => {
      if (path === 'api/releases/jobs/publish-1') {
        jobCalls.push(path);
        const next = states[Math.min(jobCalls.length - 1, states.length - 1)]!;
        return Response.json(next);
      }
      return reads(plan)(path, init);
    });
    const view = createReleasesView();
    await view.open({ repositoryId: 'app', jobId: 'publish-1', planId: 'plan-1' });

    expect(jobCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(jobCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(jobCalls).toHaveLength(3);
    // Terminal states stop polling.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(jobCalls).toHaveLength(3);
    expect(view.el.textContent).toContain('Publication outcome');
    expect(buttonStartsWith(view.el, 'Reconcile (read-only)')).toBeUndefined();
    expect(buttonStartsWith(view.el, 'View receipt (read-only)')).toBeDefined();

    // Reopening reads status from the server again; it never re-submits an approval.
    await view.open({ repositoryId: 'app', jobId: 'publish-1', planId: 'plan-1' });
    expect(jobCalls).toHaveLength(4);
  });

  it('shows the original attempt, offers read-only reconciliation and the receipt', async () => {
    const plan = planFixture();
    let publication = jobFixture({
      state: 'needs-inspection',
      step: 'observing-tag',
      errorCode: 'attempt-unresolved',
      remote: { tag: 'unknown', release: 'unknown' },
      attemptedEffects: [{ kind: 'create-tag', tag: 'v0.1.0' }],
      blocker: {
        code: 'tag-push-returned',
        message: 'One non-force tag push returned; independent inspection is required.',
      },
    });
    const calls = stubFetch((path, init) => {
      if (path === 'api/releases/jobs/publish-1') return Response.json(publication);
      if (path === 'api/releases/jobs/publish-1/reconcile') {
        return Response.json(
          {
            ...jobFixture(),
            jobId: 'reconcile-1',
            kind: 'reconcile',
            state: 'complete',
            step: 'finished',
            remote: { tag: 'exact', release: 'exact' },
            blocker: { code: 'verified-no-op', message: 'Exact tag and release were observed.' },
          },
          { status: 202 },
        );
      }
      if (path === 'api/releases/jobs/publish-1/receipt')
        return new Response('Publication publish-1; outcome complete', { status: 200 });
      return reads(plan)(path, init);
    });
    const view = createReleasesView();
    await view.open({ repositoryId: 'app', jobId: 'publish-1', planId: 'plan-1' });

    const text = view.el.textContent;
    expect(text).toContain(COMMIT);
    expect(text).toContain('v0.1.0');
    expect(text).toContain('create-tag: v0.1.0');
    expect(text).toContain('one committed change');
    expect(text).toContain('One non-force tag push returned');
    expect(buttonStartsWith(view.el, 'Reconcile (read-only)')).toBeDefined();
    expect(buttonStartsWith(view.el, 'Prepare a fresh plan')).toBeDefined();

    button(view.el, 'Reconcile (read-only)').click();
    await settle();
    const reconciles = calls.filter(
      (call) => call.path === 'api/releases/jobs/publish-1/reconcile',
    );
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]?.init?.method).toBe('POST');
    expect(reconciles[0]?.init?.headers).toMatchObject({ 'x-csrf-token': 'session-proof' });
    expect(calls.filter((call) => call.path.endsWith('/publish'))).toHaveLength(0);

    // The original publication now carries the reconciled state and its receipt.
    publication = jobFixture({
      state: 'complete',
      step: 'finished',
      remote: { tag: 'exact', release: 'exact' },
    });
    button(view.el, 'View receipt (read-only)').click();
    await settle();
    expect(view.el.textContent).toContain('Publication publish-1; outcome complete');
    const receipt = descendants(
      view.el,
      (node) => node.tagName === 'pre' && node.getAttribute('aria-label') === 'Publication receipt',
    )[0];
    expect(receipt?.hidden).toBe(false);
    expect(receipt?.getAttribute('tabindex')).toBe('0');
    expect(focused).toContain(receipt);
  });

  it('explains the changed fact of a stale executing publication and never offers reconciliation', async () => {
    const plan = planFixture();
    stubFetch((path, init) => {
      if (path === 'api/releases/jobs/publish-1')
        return Response.json(
          jobFixture({
            state: 'blocked',
            step: 'finished',
            errorCode: 'plan-stale',
            blocker: {
              code: 'plan-stale',
              message: 'The observed stable tags or baseline target changed.',
            },
          }),
        );
      return reads(plan)(path, init);
    });
    const view = createReleasesView();
    await view.open({ repositoryId: 'app', jobId: 'publish-1', planId: 'plan-1' });

    expect(view.el.textContent).toContain('This plan is stale');
    expect(view.el.textContent).toContain('The observed stable tags or baseline target changed.');
    expect(buttonStartsWith(view.el, 'Prepare a fresh plan')).toBeDefined();
    expect(buttonStartsWith(view.el, 'Reconcile (read-only)')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Announced status and keyboard-reachable controls
// ---------------------------------------------------------------------------

describe('accessibility', () => {
  it('announces status and keeps the review controls reachable', async () => {
    const plan = planFixture();
    stubFetch(reads(plan));
    const view = createReleasesView();
    await view.open({ repositoryId: 'app', jobId: null, planId: 'plan-1' });

    const status = descendants(
      view.el,
      (node) => node.tagName === 'p' && node.getAttribute('role') === 'status',
    )[0];
    expect(status?.getAttribute('aria-live')).toBe('polite');
    const notes = descendants(
      view.el,
      (node) =>
        node.tagName === 'pre' && node.getAttribute('aria-label') === 'Complete release notes',
    )[0];
    expect(notes?.getAttribute('tabindex')).toBe('0');
    expect(view.el.textContent).toContain('one committed change');
    for (const control of descendants(view.el, (node) => node.tagName === 'button')) {
      expect(control.getAttribute('type')).toBe('button');
    }
  });

  it('reports why publish is unavailable without a DOM review', () => {
    expect(publishBlocker(planFixture())).toBeNull();
    expect(
      publishBlocker(planFixture({ blockers: [{ code: 'identity', message: 'mismatch' }] })),
    ).toContain('identity');
    expect(publishBlocker(planFixture(), Date.parse('3000-01-01T00:00:00.000Z'))).toContain(
      'expired',
    );
  });
});
