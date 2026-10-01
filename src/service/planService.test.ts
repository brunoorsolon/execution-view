import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AppConfig, ResolvedSource } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import type { FetchResult, Issue, IssueProvider, ListOptions, RepoRef } from '../core/types.js';
import { contentHash } from '../core/hash.js';
import { createProvider } from '../providers/index.js';
import { PlanService, UnknownViewError } from './planService.js';

const DEMO_CONFIG = fileURLToPath(new URL('../../config.demo.yaml', import.meta.url));

function demoConfig(ttlSeconds?: number): AppConfig {
  const config = loadConfig({ path: DEMO_CONFIG, env: {} });
  if (ttlSeconds !== undefined) config.cache.ttlSeconds = ttlSeconds;
  return config;
}

/** Wraps a provider and counts calls. */
function counting(inner: IssueProvider): IssueProvider & { list: number; get: number } {
  const wrapper = {
    kind: inner.kind,
    list: 0,
    get: 0,
    listOpenIssues(repo: RepoRef, options: ListOptions): Promise<FetchResult> {
      wrapper.list++;
      return inner.listOpenIssues(repo, options);
    },
    getIssue(repo: RepoRef, number: number): Promise<Issue | null> {
      wrapper.get++;
      return inner.getIssue(repo, number);
    },
  };
  return wrapper;
}

function fixedClock(start = Date.UTC(2026, 0, 1)): {
  now: () => Date;
  advance: (ms: number) => void;
} {
  let t = start;
  return { now: () => new Date(t), advance: (ms) => void (t += ms) };
}

function demoService(ttl?: number, clock = fixedClock()) {
  const providers: ReturnType<typeof counting>[] = [];
  const service = new PlanService(demoConfig(ttl), {
    now: clock.now,
    providerFor: (source: ResolvedSource) => {
      const p = counting(createProvider(source));
      providers.push(p);
      return p;
    },
  });
  return { service, providers, clock };
}

describe('PlanService: demo end to end', () => {
  it('produces the documented plan', async () => {
    const { service } = demoService();
    const snap = await service.getSnapshot('demo');
    const plan = snap.plan;

    expect(snap.viewId).toBe('demo');
    expect(snap.title).toBe('Acme demo roadmap');
    expect(snap.priorityLabels).toEqual(['P0', 'P1', 'P2']);
    expect(snap.orderingMode).toBe('priority');
    expect(plan.viewId).toBe('demo');
    expect(plan.stats).toEqual({
      total: 23,
      ready: 4,
      blocked: 14,
      unschedulable: 5,
      external: 0,
      edges: 34,
      waves: 7,
    });

    expect(plan.waves).toEqual([
      ['acme/api#2', 'acme/web#2', 'acme/api#3', 'acme/web#5'],
      ['acme/api#4', 'acme/api#10'],
      ['acme/api#5', 'acme/web#3', 'acme/api#16'],
      ['acme/api#6', 'acme/api#7'],
      ['acme/web#4', 'acme/web#6', 'acme/api#8', 'acme/api#9'],
      ['acme/web#8', 'acme/api#15'],
      ['acme/web#9'],
    ]);

    expect(plan.order).toEqual([
      'acme/api#2',
      'acme/api#4',
      'acme/web#2',
      'acme/api#3',
      'acme/api#5',
      'acme/api#6',
      'acme/web#5',
      'acme/web#3',
      'acme/web#4',
      'acme/web#6',
      'acme/web#8',
      'acme/api#7',
      'acme/api#8',
      'acme/api#9',
      'acme/api#15',
      'acme/web#9',
      'acme/api#10',
      'acme/api#16',
    ]);

    expect(plan.criticalPath).toEqual([
      'acme/api#2',
      'acme/api#4',
      'acme/api#5',
      'acme/api#6',
      'acme/api#8',
      'acme/api#15',
      'acme/web#9',
    ]);

    expect(plan.cycles).toEqual([['acme/api#11', 'acme/api#12', 'acme/api#13']]);
    expect(plan.unschedulable).toEqual([
      'acme/api#11',
      'acme/api#12',
      'acme/api#13',
      'acme/api#14',
      'acme/web#7',
    ]);

    expect(plan.warnings.map((w) => w.code)).toEqual([
      'blocked-by-cycle',
      'cycle',
      'dangling-reference',
    ]);
    const byCode = new Map(plan.warnings.map((w) => [w.code, w]));
    expect(byCode.get('blocked-by-cycle')!.issues).toEqual(['acme/api#14', 'acme/web#7']);
    expect(byCode.get('cycle')!.issues).toEqual(['acme/api#11', 'acme/api#12', 'acme/api#13']);
    expect(byCode.get('dangling-reference')!.issues).toEqual(['acme/api#10']);
    expect(byCode.get('dangling-reference')!.message).toBe(
      'acme/api#10 references acme/api#99, which does not exist or is not accessible',
    );
  });

  it('assigns the documented statuses, waves, orders and priorities', async () => {
    const { service } = demoService();
    const { plan } = await service.getSnapshot('demo');
    const node = (key: string) => plan.nodes.find((n) => n.key === key)!;

    expect(plan.nodes).toHaveLength(23);
    expect(plan.nodes.every((n) => !n.external)).toBe(true);
    expect(plan.nodes.map((n) => n.key)).not.toContain('acme/api#1');
    expect(plan.nodes.map((n) => n.key)).not.toContain('acme/web#1');

    const ready = plan.nodes.filter((n) => n.status === 'ready').map((n) => n.key);
    expect(ready).toEqual(['acme/api#2', 'acme/api#3', 'acme/web#2', 'acme/web#5']);
    expect(node('acme/api#11').status).toBe('in-cycle');
    expect(node('acme/api#14').status).toBe('blocked-by-cycle');
    expect(node('acme/web#7').status).toBe('blocked-by-cycle');
    expect(node('acme/api#11').wave).toBeNull();
    expect(node('acme/api#11').order).toBeNull();

    expect(node('acme/api#6').blockedBy).toEqual(['acme/api#2', 'acme/api#3', 'acme/api#5']);
    expect(node('acme/web#3').blockedBy).toEqual(['acme/api#4', 'acme/web#2', 'acme/web#5']);
    expect(node('acme/web#4').blockedBy).toEqual(['acme/api#6', 'acme/web#3', 'acme/web#5']);
    expect(node('acme/web#6').blockedBy).toEqual(['acme/api#6', 'acme/web#5']);
    expect(node('acme/api#16').blockedBy).toEqual(['acme/api#4']);
    expect(node('acme/api#10').blockedBy).toEqual(['acme/api#2']);
    expect(node('acme/api#2').blockedBy).toEqual([]);

    expect(node('acme/api#2').priority).toBe(0);
    expect(node('acme/api#3').priority).toBe(1);
    expect(node('acme/web#6').priority).toBe(1);
    expect(node('acme/api#16').priority).toBe(3);
    expect(node('acme/api#9').wave).toBe(4);
    expect(node('acme/web#9').order).toBe(15);
  });

  it('produces the documented edges with sources', async () => {
    const { service } = demoService();
    const { plan } = await service.getSnapshot('demo');
    expect(plan.edges).toHaveLength(34);
    const find = (from: string, to: string) =>
      plan.edges.find((e) => e.from === from && e.to === to);
    expect(find('acme/api#2', 'acme/api#6')!.sources).toEqual(['native']);
    expect(find('acme/api#3', 'acme/api#6')!.sources).toEqual(['body']);
    expect(find('acme/api#6', 'acme/api#9')!.sources).toEqual(['body', 'native']);
    expect(find('acme/api#11', 'acme/api#13')!.sources).toEqual(['native']);
    expect(find('acme/web#3', 'acme/web#8')!.sources).toEqual(['native']);
    expect(find('acme/api#6', 'acme/web#6')!.sources).toEqual(['body']);
    // closed prerequisites produce no edge
    expect(plan.edges.some((e) => e.from === 'acme/api#1' || e.from === 'acme/web#1')).toBe(false);
    // dangling reference produces no edge
    expect(plan.edges.some((e) => e.from === 'acme/api#99')).toBe(false);
  });

  it('computes a layout that covers every node', async () => {
    const { service } = demoService();
    const snap = await service.getSnapshot('demo');
    expect(snap.layout.nodes.map((n) => n.key)).toEqual(snap.plan.nodes.map((n) => n.key));
    expect(snap.layout.edges).toHaveLength(snap.plan.edges.length);
  });

  it('keeps the demo contentHash in priority mode', async () => {
    const { service } = demoService();
    const snap = await service.getSnapshot('demo');
    expect(snap.contentHash).toBe(
      'e65915280f17fb5d65c72e4ea75d62cc77dd08b00268a9f820ecd2bfef3cb3b0',
    );
  });

  it('orders the demo wave by wave in waves mode', async () => {
    const config = demoConfig();
    config.views[0]!.ordering.mode = 'waves';
    const service = new PlanService(config, {
      now: fixedClock().now,
      providerFor: (source: ResolvedSource) => createProvider(source),
    });
    const snap = await service.getSnapshot('demo');
    expect(snap.orderingMode).toBe('waves');
    const { plan } = snap;
    expect(plan.order).toHaveLength(18);
    const waveOf = new Map(plan.nodes.map((n) => [n.key, n.wave]));
    const waves = plan.order.map((k) => waveOf.get(k)!);
    expect(waves).toEqual([...waves].sort((a, b) => a - b));
    expect(plan.order).toEqual(plan.waves.flat());

    const { service: priorityService } = demoService();
    const priority = await priorityService.getSnapshot('demo');
    // The waves themselves are the same set of issues in both modes; only their order differs.
    const sorted = (waves: string[][]) => waves.map((w) => [...w].sort());
    expect(sorted(plan.waves)).toEqual(sorted(priority.plan.waves));
    expect(snap.contentHash).not.toBe(priority.contentHash);
  });

  it('gives the same contentHash across two fresh services, whatever the clock', async () => {
    const a = await demoService(undefined, fixedClock(0)).service.getSnapshot('demo');
    const b = await demoService(undefined, fixedClock(1e12)).service.getSnapshot('demo');
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(contentHash({ plan: a.plan, layout: a.layout }));
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.fetchedAt).not.toBe(b.fetchedAt);
    expect(JSON.stringify(a.plan)).toBe(JSON.stringify(b.plan));
  });

  it('reports the scenario with only acme/web in the view', async () => {
    const config = demoConfig();
    config.views[0]!.repos = [{ owner: 'acme', repo: 'web' }];
    const service = new PlanService(config, { now: fixedClock().now });
    const { plan } = await service.getSnapshot('demo');
    const external = plan.nodes.filter((n) => n.external).map((n) => n.key);
    // Note: test/fixtures/README.md also lists acme/api#3 here, but that issue only
    // declares `Blocks: #6` on itself. Nothing in acme/web or in the fetched external
    // issues references it, so it cannot be discovered without listing acme/api
    // (ARCHITECTURE section 13 step 3 only fetches referenced keys).
    expect(external).toEqual([
      'acme/api#2',
      'acme/api#4',
      'acme/api#5',
      'acme/api#6',
      'acme/api#7',
      'acme/api#8',
      'acme/api#9',
      'acme/api#11',
      'acme/api#12',
      'acme/api#13',
      'acme/api#14',
      'acme/api#15',
    ]);
    const keys = plan.nodes.map((n) => n.key);
    expect(keys).not.toContain('acme/api#10');
    expect(keys).not.toContain('acme/api#16');
    expect(keys.filter((k) => k.startsWith('acme/web#'))).toHaveLength(8);
  });

  it('reports the scenario with excludeLabels [infra]', async () => {
    const config = demoConfig();
    config.views[0]!.scope.excludeLabels = ['infra'];
    const service = new PlanService(config, { now: fixedClock().now });
    const { plan } = await service.getSnapshot('demo');
    const keys = plan.nodes.map((n) => n.key);
    expect(keys).toContain('acme/api#3');
    expect(plan.nodes.find((n) => n.key === 'acme/api#3')!.external).toBe(true);
    expect(keys).not.toContain('acme/api#15');
    expect(keys).not.toContain('acme/web#9');
  });

  it('reports the scenario with native: false', async () => {
    const config = demoConfig();
    config.views[0]!.dependencies.native = false;
    const service = new PlanService(config, { now: fixedClock().now });
    const { plan } = await service.getSnapshot('demo');
    expect(plan.cycles).toEqual([]);
    expect(plan.unschedulable).toEqual([]);
  });
});

describe('PlanService: listViews and errors', () => {
  it('lists views with owner/repo strings and the source kind', () => {
    const { service } = demoService();
    expect(service.listViews()).toEqual([
      {
        id: 'demo',
        title: 'Acme demo roadmap',
        source: 'demo',
        kind: 'fixture',
        repos: ['acme/api', 'acme/web'],
      },
    ]);
  });

  it('throws UnknownViewError for an unknown view', async () => {
    const { service } = demoService();
    await expect(service.getSnapshot('nope')).rejects.toBeInstanceOf(UnknownViewError);
    await expect(service.getSnapshot('nope')).rejects.toThrow(/nope/);
    expect(new UnknownViewError('x')).toBeInstanceOf(Error);
  });
});

describe('PlanService: cache', () => {
  it('serves a second call within the TTL from the cache', async () => {
    const { service, providers, clock } = demoService(300);
    const a = await service.getSnapshot('demo');
    const callsAfterFirst = providers[0]!.list;
    clock.advance(299_000);
    const b = await service.getSnapshot('demo');
    expect(b).toBe(a);
    expect(providers[0]!.list).toBe(callsAfterFirst);
    expect(providers).toHaveLength(1);
  });

  it('refetches after the TTL expires and updates fetchedAt from the injected clock', async () => {
    const { service, providers, clock } = demoService(300);
    const a = await service.getSnapshot('demo');
    expect(a.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
    const callsAfterFirst = providers[0]!.list;
    clock.advance(300_000);
    const b = await service.getSnapshot('demo');
    expect(b).not.toBe(a);
    expect(b.fetchedAt).toBe('2026-01-01T00:05:00.000Z');
    expect(b.contentHash).toBe(a.contentHash);
    expect(providers[0]!.list).toBe(callsAfterFirst * 2);
    // the provider is created once per source
    expect(providers).toHaveLength(1);
  });

  it('does not cache when ttlSeconds is 0', async () => {
    const { service, providers } = demoService(0);
    await service.getSnapshot('demo');
    const callsAfterFirst = providers[0]!.list;
    await service.getSnapshot('demo');
    expect(providers[0]!.list).toBe(callsAfterFirst * 2);
  });

  it('refresh: true bypasses the cache', async () => {
    const { service, providers } = demoService(300);
    const a = await service.getSnapshot('demo');
    const callsAfterFirst = providers[0]!.list;
    const b = await service.getSnapshot('demo', { refresh: true });
    expect(b).not.toBe(a);
    expect(providers[0]!.list).toBe(callsAfterFirst * 2);
    // and the refreshed snapshot is the cached one afterwards
    expect(await service.getSnapshot('demo')).toBe(b);
  });

  it('viewsForRepo lists the matching view ids, sorted, ignoring case', () => {
    const config = demoConfig();
    const demo = config.views[0]!;
    config.views.push(
      { ...demo, id: 'zeta', repos: [{ owner: 'acme', repo: 'web' }] },
      { ...demo, id: 'alpha', repos: [{ owner: 'acme', repo: 'web' }] },
      { ...demo, id: 'other', repos: [{ owner: 'x', repo: 'y' }] },
    );
    const service = new PlanService(config);
    expect(service.viewsForRepo('acme/api')).toEqual(['demo']);
    expect(service.viewsForRepo('Acme/Web')).toEqual(['alpha', 'demo', 'zeta']);
    expect(service.viewsForRepo('x/y')).toEqual(['other']);
    expect(service.viewsForRepo('acme/none')).toEqual([]);
    expect(service.viewsForRepo('')).toEqual([]);
  });

  it('invalidate drops the cache for one view or all views', async () => {
    const { service, providers } = demoService(300);
    const a = await service.getSnapshot('demo');
    service.invalidate('other');
    expect(await service.getSnapshot('demo')).toBe(a);
    service.invalidate('demo');
    const b = await service.getSnapshot('demo');
    expect(b).not.toBe(a);
    service.invalidate();
    const c = await service.getSnapshot('demo');
    expect(c).not.toBe(b);
    expect(providers).toHaveLength(1);
  });

  it('shares one fetch between concurrent calls, refresh included', async () => {
    const { service, providers } = demoService(300);
    const [a, b, c] = await Promise.all([
      service.getSnapshot('demo'),
      service.getSnapshot('demo'),
      service.getSnapshot('demo', { refresh: true }),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    // one fetch: one listOpenIssues call per view repo
    expect(providers[0]!.list).toBe(2);
  });

  it('does not cache failures', async () => {
    let fail = true;
    const inner = createProvider(demoConfig().sources[0]!);
    let lists = 0;
    const flaky: IssueProvider = {
      kind: 'fixture',
      async listOpenIssues(repo, options) {
        lists++;
        if (fail) throw new Error('provider down');
        return inner.listOpenIssues(repo, options);
      },
      getIssue: (repo, number) => inner.getIssue(repo, number),
    };
    const service = new PlanService(demoConfig(300), {
      providerFor: () => flaky,
      now: fixedClock().now,
    });
    await expect(service.getSnapshot('demo')).rejects.toThrow('provider down');
    const failedLists = lists;
    fail = false;
    const snap = await service.getSnapshot('demo');
    expect(snap.plan.stats.total).toBe(23);
    expect(lists).toBeGreaterThan(failedLists);
    // and now it is cached
    const before = lists;
    expect(await service.getSnapshot('demo')).toBe(snap);
    expect(lists).toBe(before);
  });

  it('rejects all concurrent callers of a failed fetch and then retries', async () => {
    let fail = true;
    const inner = createProvider(demoConfig().sources[0]!);
    const flaky: IssueProvider = {
      kind: 'fixture',
      async listOpenIssues(repo, options) {
        if (fail) throw new Error('provider down');
        return inner.listOpenIssues(repo, options);
      },
      getIssue: (repo, number) => inner.getIssue(repo, number),
    };
    const service = new PlanService(demoConfig(300), { providerFor: () => flaky });
    const results = await Promise.allSettled([
      service.getSnapshot('demo'),
      service.getSnapshot('demo'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    fail = false;
    await expect(service.getSnapshot('demo')).resolves.toBeDefined();
  });

  it('takes fetchedAt from the injected clock', async () => {
    const clock = fixedClock(Date.UTC(2030, 5, 15, 12, 30, 45, 123));
    const { service } = demoService(300, clock);
    const snap = await service.getSnapshot('demo');
    expect(snap.fetchedAt).toBe('2030-06-15T12:30:45.123Z');
  });
});

describe('PlanService: providers', () => {
  it('creates the provider lazily, once per source id', async () => {
    const config = demoConfig(0);
    const created: string[] = [];
    const inner = createProvider(config.sources[0]!);
    const service = new PlanService(config, {
      now: fixedClock().now,
      providerFor: (source) => {
        created.push(source.id);
        return inner;
      },
    });
    expect(created).toEqual([]);
    service.listViews();
    expect(created).toEqual([]);
    await service.getSnapshot('demo');
    await service.getSnapshot('demo');
    expect(created).toEqual(['demo']);
  });
});
