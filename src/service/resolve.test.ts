import { describe, expect, it } from 'vitest';
import type { ResolvedSource, ResolvedView } from '../config/schema.js';
import { DEFAULT_KEYWORDS } from '../core/parser.js';
import { makeKey } from '../core/keys.js';
import type {
  FetchResult,
  Issue,
  IssueKey,
  IssueProvider,
  IssueState,
  ListOptions,
  RawRelation,
  RepoRef,
} from '../core/types.js';
import { LOOKUP_CONCURRENCY, MAX_EXTERNAL_FETCHES, resolveView } from './resolve.js';

interface MakeOpts {
  state?: IssueState;
  body?: string;
  labels?: string[];
  milestone?: string | null;
  native?: string[];
  nativeRelations?: RawRelation[];
  title?: string;
}

function mk(key: string, opts: MakeOpts = {}): Issue {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key)!;
  const repo = { owner: m[1]!, repo: m[2]! };
  const number = Number(m[3]);
  const nativeRelations: RawRelation[] = [
    ...(opts.native ?? []).map((k): RawRelation => {
      const p = /^([^/]+)\/([^#]+)#(\d+)$/.exec(k)!;
      return {
        kind: 'blocked-by',
        ref: { owner: p[1]!, repo: p[2]!, number: Number(p[3]) },
        source: 'native',
      };
    }),
    ...(opts.nativeRelations ?? []),
  ];
  return {
    key: makeKey(repo, number),
    repo,
    number,
    title: opts.title ?? `Issue ${key}`,
    state: opts.state ?? 'open',
    url: `https://web.test/${repo.owner}/${repo.repo}/issues/${number}`,
    body: opts.body ?? '',
    labels: opts.labels ?? [],
    assignees: [],
    milestone: opts.milestone ?? null,
    updatedAt: null,
    nativeRelations,
  };
}

class FakeProvider implements IssueProvider {
  readonly kind = 'fixture' as const;
  readonly getCalls: string[] = [];
  readonly listCalls: { repo: string; options: ListOptions }[] = [];
  private readonly issues = new Map<string, Issue>();
  readonly throwing = new Set<string>();
  listWarnings: FetchResult['warnings'] = [];

  constructor(issues: Issue[]) {
    for (const i of issues) this.issues.set(i.key, i);
  }

  async listOpenIssues(repo: RepoRef, options: ListOptions): Promise<FetchResult> {
    this.listCalls.push({ repo: `${repo.owner}/${repo.repo}`, options });
    const issues = [...this.issues.values()]
      .filter((i) => i.state === 'open' && i.repo.owner === repo.owner && i.repo.repo === repo.repo)
      .sort((a, b) => a.number - b.number);
    return { issues, warnings: this.listWarnings };
  }

  async getIssue(repo: RepoRef, number: number): Promise<Issue | null> {
    const key = makeKey(repo, number);
    this.getCalls.push(key);
    if (this.throwing.has(key)) throw new Error(`boom ${key}`);
    return this.issues.get(key) ?? null;
  }
}

const SOURCE: ResolvedSource = {
  id: 's',
  kind: 'fixture',
  baseUrl: '',
  webUrl: 'https://web.test',
  token: null,
  path: null,
};

function view(over: Partial<ResolvedView> = {}, deps: Partial<ResolvedView['dependencies']> = {}) {
  const v: ResolvedView = {
    id: 'v',
    title: 'V',
    source: 's',
    repos: [{ owner: 'a', repo: 'r' }],
    dependencies: {
      native: true,
      body: true,
      subIssues: false,
      keywords: DEFAULT_KEYWORDS,
      ...deps,
    },
    scope: { labels: [], excludeLabels: [], milestones: [] },
    ordering: { priorityLabels: ['P0'], mode: 'priority' },
    ...over,
  };
  return v;
}

function edgesOf(input: { edges: { from: string; to: string; sources: string[] }[] }): string[] {
  return input.edges.map((e) => `${e.from}->${e.to}[${e.sources.join(',')}]`);
}

describe('resolveView: basics', () => {
  it('returns open issues sorted, viewId and priorityLabels', async () => {
    const provider = new FakeProvider([mk('a/r#2'), mk('a/r#1'), mk('a/r#3', { state: 'closed' })]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(input.viewId).toBe('v');
    expect(input.priorityLabels).toEqual(['P0']);
    expect(input.orderingMode).toBe('priority');
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'a/r#2']);
    expect(input.externalKeys).toEqual([]);
    expect(input.edges).toEqual([]);
    expect(input.warnings).toEqual([]);
  });

  it('fetches repos in sorted order, passes list options and carries warnings', async () => {
    const provider = new FakeProvider([mk('a/r#1'), mk('a/z#1'), mk('b/a#1')]);
    provider.listWarnings = [{ code: 'native-unsupported', message: 'no native', issues: [] }];
    const v = view(
      {
        repos: [
          { owner: 'b', repo: 'a' },
          { owner: 'a', repo: 'z' },
          { owner: 'a', repo: 'r' },
        ],
      },
      { subIssues: true },
    );
    const { input } = await resolveView(v, SOURCE, provider);
    expect(provider.listCalls.map((c) => c.repo)).toEqual(['a/r', 'a/z', 'b/a']);
    expect(provider.listCalls[0]!.options).toEqual({ native: true, subIssues: true });
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'a/z#1', 'b/a#1']);
    expect(input.warnings.filter((w) => w.code === 'native-unsupported')).toHaveLength(3);
  });
});

describe('resolveView: references', () => {
  it('drops a closed dependency without a warning or a node', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { state: 'closed' }),
      mk('a/r#2', { body: 'Depends on #1' }),
    ]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#2']);
    expect(input.edges).toEqual([]);
    expect(input.warnings).toEqual([]);
    expect(provider.getCalls).toEqual(['a/r#1']);
  });

  it('drops a blocks relation pointing at a closed issue silently', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { state: 'closed' }),
      mk('a/r#2', { body: 'Blocks: #1' }),
    ]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(input.edges).toEqual([]);
    expect(input.warnings).toEqual([]);
  });

  it('warns about a dangling reference, once per declaring/ref pair', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { body: 'Depends on #99, #99', native: ['a/r#99'] }),
      mk('a/r#2', { body: 'Depends on #99' }),
    ]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(input.edges).toEqual([]);
    expect(input.warnings).toEqual([
      {
        code: 'dangling-reference',
        message: 'a/r#1 references a/r#99, which does not exist or is not accessible',
        issues: ['a/r#1'],
      },
      {
        code: 'dangling-reference',
        message: 'a/r#2 references a/r#99, which does not exist or is not accessible',
        issues: ['a/r#2'],
      },
    ]);
  });

  it('resolves a null-owner ref against the declaring issue repo', async () => {
    const provider = new FakeProvider([
      mk('a/r#1'),
      mk('a/other#1'),
      mk('a/other#2', { body: 'Depends on #1' }),
    ]);
    const v = view({
      repos: [
        { owner: 'a', repo: 'r' },
        { owner: 'a', repo: 'other' },
      ],
    });
    const { input } = await resolveView(v, SOURCE, provider);
    expect(edgesOf(input)).toEqual(['a/other#1->a/other#2[body]']);
  });

  it('turns an open ref outside the view into an external node and resolves it transitively', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { body: 'Depends on x/y#5' }),
      mk('x/y#5', { body: 'Blocked by: #6\nBlocks: a/r#1' }),
      mk('x/y#6', { body: '- Depends on z/w#7', native: ['x/y#8'] }),
      mk('x/y#8', { state: 'closed' }),
      mk('z/w#7'),
      mk('z/w#9'), // unrelated open issue, never referenced
    ]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'x/y#5', 'x/y#6', 'z/w#7']);
    expect(input.externalKeys).toEqual(['x/y#5', 'x/y#6', 'z/w#7']);
    expect(edgesOf(input)).toEqual([
      'x/y#5->a/r#1[body]',
      'x/y#6->x/y#5[body]',
      'z/w#7->x/y#6[body]',
    ]);
    expect(input.warnings).toEqual([]);
    expect(provider.getCalls).toEqual(['x/y#5', 'x/y#6', 'x/y#8', 'z/w#7']);
  });

  it('memoizes getIssue: at most one call per key', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { body: 'Depends on x/y#5, x/y#404' }),
      mk('a/r#2', { body: 'Depends on x/y#5, x/y#404' }),
      mk('a/r#3', { body: 'Blocks: x/y#5', native: ['x/y#5'] }),
      mk('x/y#5', { body: 'Depends on x/y#404' }),
    ]);
    await resolveView(view(), SOURCE, provider);
    const counts = new Map<string, number>();
    for (const k of provider.getCalls) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect(counts.get('x/y#5')).toBe(1);
    expect(counts.get('x/y#404')).toBe(1);
  });

  it('never calls getIssue for keys that are in the open set', async () => {
    const provider = new FakeProvider([mk('a/r#1'), mk('a/r#2', { body: 'Depends on #1' })]);
    await resolveView(view(), SOURCE, provider);
    expect(provider.getCalls).toEqual([]);
  });

  it('keeps a self reference as a self-loop edge for the plan engine', async () => {
    const provider = new FakeProvider([mk('a/r#1', { body: 'Depends on #1' })]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(edgesOf(input)).toEqual(['a/r#1->a/r#1[body]']);
  });

  it('merges sources of the same edge', async () => {
    const provider = new FakeProvider([
      mk('a/r#1'),
      mk('a/r#2', { body: 'Depends on #1', native: ['a/r#1'] }),
      mk('a/r#3', {
        body: 'Depends on #1',
        nativeRelations: [
          { kind: 'blocked-by', ref: { owner: null, repo: null, number: 1 }, source: 'sub-issue' },
        ],
      }),
    ]);
    const { input } = await resolveView(view({}, { subIssues: true }), SOURCE, provider);
    expect(edgesOf(input)).toEqual(['a/r#1->a/r#2[body,native]', 'a/r#1->a/r#3[body,sub-issue]']);
  });

  it('parses URL references using the web host of the source, port included', async () => {
    const provider = new FakeProvider([
      mk('a/r#1'),
      mk('a/r#2', { body: 'Depends on https://web.test:3000/a/r/issues/1' }),
      mk('a/r#3', { body: 'Depends on https://web.test/a/r/issues/1' }),
    ]);
    const withPort = { ...SOURCE, webUrl: 'https://web.test:3000' };
    const r1 = await resolveView(view(), withPort, provider);
    expect(edgesOf(r1.input)).toEqual(['a/r#1->a/r#2[body]']);
    const noHost = { ...SOURCE, webUrl: '' };
    const r2 = await resolveView(view(), noHost, provider);
    expect(r2.input.edges).toEqual([]);
  });
});

describe('resolveView: lookup concurrency', () => {
  it('never has more than LOOKUP_CONCURRENCY getIssue calls in flight and stays deterministic', async () => {
    expect(LOOKUP_CONCURRENCY).toBe(4);
    const refs = Array.from({ length: 25 }, (_, i) => `x/y#${i + 1}`);
    const issues = [
      mk('a/r#1', { body: `Depends on ${refs.join(', ')}` }),
      ...refs.map((k) => mk(k, { state: Number(k.split('#')[1]) % 2 === 0 ? 'closed' : 'open' })),
    ];
    const baseline = await resolveView(view(), SOURCE, new FakeProvider(issues));

    class GatedProvider extends FakeProvider {
      inFlight = 0;
      maxInFlight = 0;
      readonly gates: (() => void)[] = [];
      override async getIssue(repo: RepoRef, number: number): Promise<Issue | null> {
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        await new Promise<void>((resolve) => this.gates.push(resolve));
        try {
          return await super.getIssue(repo, number);
        } finally {
          this.inFlight--;
        }
      }
    }
    const provider = new GatedProvider(issues);
    const done = resolveView(view(), SOURCE, provider);
    // Release the pending lookups one at a time, newest first, until all 25 have completed.
    let released = 0;
    while (released < refs.length) {
      await new Promise((r) => setTimeout(r, 0));
      const gate = provider.gates.pop();
      if (gate === undefined) continue;
      released++;
      gate();
    }
    const { input } = await done;

    expect(provider.maxInFlight).toBeGreaterThan(1);
    expect(provider.maxInFlight).toBeLessThanOrEqual(LOOKUP_CONCURRENCY);
    expect(provider.getCalls).toHaveLength(refs.length);
    expect([...provider.getCalls].sort()).toEqual([...refs].sort());
    expect(input).toEqual(baseline.input);
  });
});

describe('resolveView: cap and errors', () => {
  it('caps getIssue calls and emits one external-unresolved warning', async () => {
    const total = MAX_EXTERNAL_FETCHES + 5;
    const refs = Array.from({ length: total }, (_, i) => `x/y#${i + 1}`);
    const issues = [
      mk('a/r#1', { body: `Depends on ${refs.join(', ')}` }),
      ...refs.map((k) => mk(k)),
    ];
    const provider = new FakeProvider(issues);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(provider.getCalls).toHaveLength(MAX_EXTERNAL_FETCHES);
    const w = input.warnings.filter((x) => x.code === 'external-unresolved');
    expect(w).toHaveLength(1);
    // the first 200 in compareKeys order are fetched, the rest are unresolved
    const expected: IssueKey[] = Array.from({ length: 5 }, (_, i) => `x/y#${i + 201}`);
    expect(w[0]!.issues).toEqual(expected);
    expect(input.issues).toHaveLength(1 + MAX_EXTERNAL_FETCHES);
  });

  it('counts transitive fetches against the cap', async () => {
    const chain: Issue[] = [mk('a/r#1', { body: 'Depends on x/y#1' })];
    for (let i = 1; i <= MAX_EXTERNAL_FETCHES + 3; i++) {
      chain.push(mk(`x/y#${i}`, { body: `Depends on #${i + 1}` }));
    }
    const provider = new FakeProvider(chain);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(provider.getCalls).toHaveLength(MAX_EXTERNAL_FETCHES);
    const w = input.warnings.filter((x) => x.code === 'external-unresolved');
    expect(w).toHaveLength(1);
    expect(w[0]!.issues).toEqual([`x/y#${MAX_EXTERNAL_FETCHES + 1}`]);
  });

  it('turns a throwing getIssue into a fetch-error warning and a placeholder node', async () => {
    const provider = new FakeProvider([mk('a/r#1', { body: 'Depends on x/y#5' })]);
    provider.throwing.add('x/y#5');
    const { input } = await resolveView(view(), SOURCE, provider);
    const placeholder = input.issues.find((i) => i.key === 'x/y#5')!;
    expect(placeholder.title).toBe('(unavailable)');
    expect(placeholder.state).toBe('open');
    expect(placeholder.url).toBe('https://web.test/x/y/issues/5');
    expect(placeholder.nativeRelations).toEqual([]);
    expect(input.externalKeys).toEqual(['x/y#5']);
    expect(edgesOf(input)).toEqual(['x/y#5->a/r#1[body]']);
    expect(input.warnings).toHaveLength(1);
    expect(input.warnings[0]!.code).toBe('fetch-error');
    expect(input.warnings[0]!.message).toContain('boom x/y#5');
    expect(input.warnings[0]!.issues).toEqual(['x/y#5']);
  });

  it('uses an empty url for a placeholder when there is no web url', async () => {
    const provider = new FakeProvider([mk('a/r#1', { body: 'Depends on x/y#5' })]);
    provider.throwing.add('x/y#5');
    const { input } = await resolveView(view(), { ...SOURCE, webUrl: '' }, provider);
    expect(input.issues.find((i) => i.key === 'x/y#5')!.url).toBe('');
  });
});

describe('resolveView: toggles and directions', () => {
  const issues = () => [
    mk('a/r#1'),
    mk('a/r#2'),
    mk('a/r#3', { body: 'Depends on #1', native: ['a/r#2'] }),
  ];

  it('uses both sources by default', async () => {
    const { input } = await resolveView(view(), SOURCE, new FakeProvider(issues()));
    expect(edgesOf(input)).toEqual(['a/r#1->a/r#3[body]', 'a/r#2->a/r#3[native]']);
  });

  it('native: false ignores native relations', async () => {
    const { input } = await resolveView(
      view({}, { native: false }),
      SOURCE,
      new FakeProvider(issues()),
    );
    expect(edgesOf(input)).toEqual(['a/r#1->a/r#3[body]']);
  });

  it('body: false ignores body relations', async () => {
    const { input } = await resolveView(
      view({}, { body: false }),
      SOURCE,
      new FakeProvider(issues()),
    );
    expect(edgesOf(input)).toEqual(['a/r#2->a/r#3[native]']);
  });

  it('honours custom keywords', async () => {
    const provider = new FakeProvider([mk('a/r#1'), mk('a/r#2', { body: 'Needs: #1' })]);
    const v = view({}, { keywords: { blockedBy: ['needs'], blocks: [] } });
    const { input } = await resolveView(v, SOURCE, provider);
    expect(edgesOf(input)).toEqual(['a/r#1->a/r#2[body]']);
  });

  it('blocked-by X ref Y gives Y -> X and blocks X ref Y gives X -> Y', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { body: 'Depends on #2' }),
      mk('a/r#2'),
      mk('a/r#3', { body: 'Blocks: #4' }),
      mk('a/r#4'),
    ]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(edgesOf(input)).toEqual(['a/r#2->a/r#1[body]', 'a/r#3->a/r#4[body]']);
  });

  it('applies body toggles to external issues too', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { body: 'Depends on x/y#1' }),
      mk('x/y#1', { body: 'Depends on x/y#2' }),
      mk('x/y#2'),
    ]);
    const { input } = await resolveView(view({}, { body: false }), SOURCE, provider);
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1']);
  });
});

describe('resolveView: strict relation lines and parents', () => {
  it('body: strict reads only relation lines and ignores the legacy forms', async () => {
    const provider = new FakeProvider([
      mk('a/r#1'),
      mk('a/r#2'),
      mk('a/r#3', {
        body: 'Blocked by: [#1]\nDepends on #2\n## Dependencies\n- No implementation dependency on #2\n',
      }),
    ]);
    const { input } = await resolveView(view({}, { body: 'strict' }), SOURCE, provider);
    expect(edgesOf(input)).toEqual(['a/r#1->a/r#3[body]']);
  });

  it('body: true keeps reading the legacy forms', async () => {
    const provider = new FakeProvider([mk('a/r#1'), mk('a/r#2', { body: 'Depends on #1' })]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(edgesOf(input)).toEqual(['a/r#1->a/r#2[body]']);
  });

  it('a Parent line links child and parent without an edge or a lookup', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { body: 'Parent: [a/r#2]' }),
      mk('a/r#2'),
      mk('a/r#3', { body: 'Parent: [x/y#9] ignored when missing from the snapshot' }),
    ]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(input.parentLinks).toEqual([
      { parent: 'a/r#2', child: 'a/r#1' },
      { parent: 'x/y#9', child: 'a/r#3' },
    ]);
    expect(edgesOf(input)).toEqual([]);
    expect(provider.getCalls).toEqual([]);
    expect(input.warnings).toEqual([]);
  });

  it('relation lines are read even when the keyword lists are empty', async () => {
    const provider = new FakeProvider([
      mk('a/r#1'),
      mk('a/r#2', { body: 'Blocked by: [#1]\nParent: [#3]\nDepends on #1' }),
      mk('a/r#3'),
    ]);
    const keywords = { blockedBy: [], blocks: [] };
    for (const body of [true, 'strict'] as const) {
      const { input } = await resolveView(view({}, { body, keywords }), SOURCE, provider);
      expect(edgesOf(input)).toEqual(['a/r#1->a/r#2[body]']);
      expect(input.parentLinks).toEqual([{ parent: 'a/r#3', child: 'a/r#2' }]);
    }
  });
});

describe('resolveView: scope', () => {
  const base = () => [
    mk('a/r#1', { labels: ['infra'], milestone: 'v1' }),
    mk('a/r#2', { labels: ['feature'], milestone: 'v2', body: 'Depends on #1' }),
    mk('a/r#3', { labels: ['feature', 'Wip'], milestone: 'V1', body: 'Depends on #2' }),
    mk('a/r#4', { labels: ['other'] }), // unrelated
  ];
  const withScope = (scope: Partial<ResolvedView['scope']>) =>
    view({ scope: { labels: [], excludeLabels: [], milestones: [], ...scope } });

  it('labels: at least one, case-insensitive; prerequisites out of scope become external', async () => {
    const { input } = await resolveView(
      withScope({ labels: ['FEATURE'] }),
      SOURCE,
      new FakeProvider(base()),
    );
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'a/r#2', 'a/r#3']);
    expect(input.externalKeys).toEqual(['a/r#1']);
    expect(edgesOf(input)).toEqual(['a/r#1->a/r#2[body]', 'a/r#2->a/r#3[body]']);
  });

  it('excludeLabels: none of them, case-insensitive', async () => {
    const { input } = await resolveView(
      withScope({ excludeLabels: ['wip', 'other'] }),
      SOURCE,
      new FakeProvider(base()),
    );
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'a/r#2']);
    expect(input.externalKeys).toEqual([]);
  });

  it('milestones: in the list, case-insensitive; walks prerequisites transitively', async () => {
    const { input } = await resolveView(
      withScope({ milestones: ['v1'] }),
      SOURCE,
      new FakeProvider(base()),
    );
    // #1 (v1) and #3 (V1) are in scope; #2 (v2) is pulled in as #3's prerequisite.
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'a/r#2', 'a/r#3']);
    expect(input.externalKeys).toEqual(['a/r#2']);
  });

  it('excludes unrelated out-of-scope issues and dependents of out-of-scope issues', async () => {
    const { input } = await resolveView(
      withScope({ labels: ['infra'] }),
      SOURCE,
      new FakeProvider(base()),
    );
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1']);
    expect(input.externalKeys).toEqual([]);
    expect(input.edges).toEqual([]);
  });

  it('marks prerequisites in other repos as external and restricts edges to the node set', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { body: 'Depends on x/y#1' }),
      mk('x/y#1', { body: 'Depends on x/y#2' }),
      mk('x/y#2'),
      mk('x/y#3', { body: 'Depends on a/r#1' }), // dependent of an in-scope issue: not pulled in
    ]);
    const { input } = await resolveView(view(), SOURCE, provider);
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'x/y#1', 'x/y#2']);
    expect(input.externalKeys).toEqual(['x/y#1', 'x/y#2']);
    expect(input.edges.every((e) => e.from !== 'x/y#3' && e.to !== 'x/y#3')).toBe(true);
  });
  it('drops dangling and fetch-error warnings of issues outside the plan, keeps the others', async () => {
    const provider = new FakeProvider([
      mk('a/r#1', { labels: ['keep'], body: 'Depends on #98, x/y#5' }),
      mk('a/r#2', { labels: ['skip'], body: 'Depends on #99, x/y#6' }), // out of scope, unrelated
      mk('x/y#5'),
      mk('x/y#6'),
    ]);
    provider.throwing.add('x/y#6');
    provider.listWarnings = [{ code: 'native-unsupported', message: 'no native', issues: [] }];
    const { input } = await resolveView(
      view({ scope: { labels: ['keep'], excludeLabels: [], milestones: [] } }),
      SOURCE,
      provider,
    );
    expect(input.issues.map((i) => i.key)).toEqual(['a/r#1', 'x/y#5']);
    expect(input.warnings.map((w) => `${w.code}:${w.issues.join(',')}`)).toEqual([
      'native-unsupported:',
      'dangling-reference:a/r#1',
    ]);
  });
});
