import type { AppConfig, ResolvedSource, ResolvedView } from '../config/schema.js';
import { contentHash } from '../core/hash.js';
import { computeLayout } from '../core/layout.js';
import { buildPlan } from '../core/plan.js';
import type { IssueProvider, ProviderKind, Snapshot } from '../core/types.js';
import { createProvider } from '../providers/index.js';
import { resolveView } from './resolve.js';

export class UnknownViewError extends Error {
  readonly viewId: string;
  constructor(viewId: string) {
    super(`Unknown view: ${viewId}`);
    this.name = 'UnknownViewError';
    this.viewId = viewId;
  }
}

export interface PlanServiceDeps {
  providerFor?: (source: ResolvedSource) => IssueProvider;
  now?: () => Date;
}

export interface ViewSummary {
  id: string;
  title: string;
  source: string;
  kind: ProviderKind;
  repos: string[];
}

interface CacheEntry {
  snapshot: Snapshot;
  expiresAt: number;
}

export class PlanService {
  private readonly config: AppConfig;
  private readonly providerFor: (source: ResolvedSource) => IssueProvider;
  private readonly now: () => Date;
  private readonly views = new Map<string, ResolvedView>();
  private readonly sources = new Map<string, ResolvedSource>();
  private readonly providers = new Map<string, IssueProvider>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<Snapshot>>();
  /** Bumped by invalidate(), so a fetch that started earlier is not cached. */
  private generation = 0;

  constructor(config: AppConfig, deps: PlanServiceDeps = {}) {
    this.config = config;
    this.providerFor = deps.providerFor ?? ((source) => createProvider(source));
    this.now = deps.now ?? (() => new Date());
    for (const s of config.sources) this.sources.set(s.id, s);
    for (const v of config.views) this.views.set(v.id, v);
  }

  listViews(): ViewSummary[] {
    return this.config.views.map((v) => ({
      id: v.id,
      title: v.title,
      source: v.source,
      kind: this.sourceOf(v).kind,
      repos: v.repos.map((r) => `${r.owner}/${r.repo}`),
    }));
  }

  /** Ids (sorted) of the views whose repos include `fullName` (`owner/repo`, any case). */
  viewsForRepo(fullName: string): string[] {
    const wanted = fullName.toLowerCase();
    return this.config.views
      .filter((v) => v.repos.some((r) => `${r.owner}/${r.repo}`.toLowerCase() === wanted))
      .map((v) => v.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async getSnapshot(viewId: string, opts: { refresh?: boolean } = {}): Promise<Snapshot> {
    const view = this.views.get(viewId);
    if (view === undefined) throw new UnknownViewError(viewId);

    if (opts.refresh !== true) {
      const cached = this.cache.get(viewId);
      if (cached !== undefined) {
        if (this.now().getTime() < cached.expiresAt) return cached.snapshot;
        this.cache.delete(viewId);
      }
    }

    const running = this.inFlight.get(viewId);
    if (running !== undefined) return running;

    const generation = this.generation;
    const promise = this.build(view).then(
      (result) => {
        this.inFlight.delete(viewId);
        const ttlMs = this.config.cache.ttlSeconds * 1000;
        if (ttlMs > 0 && generation === this.generation) {
          this.cache.set(viewId, { snapshot: result.snapshot, expiresAt: result.at + ttlMs });
        }
        return result.snapshot;
      },
      (err: unknown) => {
        this.inFlight.delete(viewId);
        throw err;
      },
    );
    this.inFlight.set(viewId, promise);
    return promise;
  }

  /** Drop cached snapshots (one view, or all). In-flight fetches are left running. */
  invalidate(viewId?: string): void {
    this.generation++;
    if (viewId === undefined) this.cache.clear();
    else this.cache.delete(viewId);
  }

  private sourceOf(view: ResolvedView): ResolvedSource {
    const source = this.sources.get(view.source);
    if (source === undefined) {
      throw new Error(`View "${view.id}" refers to unknown source "${view.source}"`);
    }
    return source;
  }

  private provider(source: ResolvedSource): IssueProvider {
    let provider = this.providers.get(source.id);
    if (provider === undefined) {
      provider = this.providerFor(source);
      this.providers.set(source.id, provider);
    }
    return provider;
  }

  private async build(view: ResolvedView): Promise<{ snapshot: Snapshot; at: number }> {
    const source = this.sourceOf(view);
    const { input } = await resolveView(view, source, this.provider(source));
    const plan = buildPlan(input);
    const layout = computeLayout(plan);
    const at = this.now();
    const snapshot: Snapshot = {
      viewId: view.id,
      title: view.title,
      fetchedAt: at.toISOString(),
      contentHash: contentHash({ plan, layout }),
      priorityLabels: [...view.ordering.priorityLabels],
      orderingMode: view.ordering.mode,
      plan,
      layout,
    };
    return { snapshot, at: at.getTime() };
  }
}
