import type { ResolvedSource, ResolvedView } from '../config/schema.js';
import { compareKeys, makeKey, parseKey } from '../core/keys.js';
import { parseBodyRelations } from '../core/parser.js';
import type { PlanInput } from '../core/plan.js';
import type {
  DependencyEdge,
  DependencySource,
  Issue,
  IssueKey,
  IssueProvider,
  IssueRef,
  PlanWarning,
  RawRelation,
  RepoRef,
} from '../core/types.js';

/** Maximum number of `getIssue` calls made for issues that are not in the open set. */
export const MAX_EXTERNAL_FETCHES = 200;

export interface ResolveResult {
  input: PlanInput;
}

/** A relation with its declaring issue and the fully qualified key it points to. */
interface PendingRelation {
  declaring: IssueKey;
  refKey: IssueKey;
  kind: RawRelation['kind'];
  source: DependencySource;
}

type Lookup = 'closed' | 'missing' | 'unresolved';

function cmp<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRepos(a: RepoRef, b: RepoRef): number {
  return cmp(`${a.owner}/${a.repo}`, `${b.owner}/${b.repo}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function webHostsOf(webUrl: string): string[] {
  if (webUrl === '') return [];
  try {
    return [new URL(webUrl).host.toLowerCase()];
  } catch {
    return [];
  }
}

function lowerSet(values: string[]): Set<string> {
  return new Set(values.map((v) => v.toLowerCase()));
}

function inScope(issue: Issue, scope: ResolvedView['scope']): boolean {
  const labels = new Set(issue.labels.map((l) => l.toLowerCase()));
  const include = lowerSet(scope.labels);
  if (include.size > 0 && ![...include].some((l) => labels.has(l))) return false;
  const exclude = lowerSet(scope.excludeLabels);
  if ([...exclude].some((l) => labels.has(l))) return false;
  const milestones = lowerSet(scope.milestones);
  if (milestones.size > 0) {
    if (issue.milestone === null || !milestones.has(issue.milestone.toLowerCase())) return false;
  }
  return true;
}

function placeholderIssue(key: IssueKey, webUrl: string): Issue {
  const { repo, number } = parseKey(key);
  const base = webUrl.replace(/\/+$/, '');
  return {
    key,
    repo,
    number,
    title: '(unavailable)',
    state: 'open',
    url: base === '' ? '' : `${base}/${repo.owner}/${repo.repo}/issues/${number}`,
    body: '',
    labels: [],
    assignees: [],
    milestone: null,
    nativeRelations: [],
  };
}

/**
 * Turn the open issues of a view (plus the issues they reference) into a
 * `PlanInput`. Implements ARCHITECTURE section 13, steps 1 to 5. Every
 * iteration runs over sorted collections, so the result does not depend on
 * API response order.
 */
export async function resolveView(
  view: ResolvedView,
  source: ResolvedSource,
  provider: IssueProvider,
): Promise<ResolveResult> {
  const warnings: PlanWarning[] = [];
  const webHosts = webHostsOf(source.webUrl);
  const { keywords } = view.dependencies;

  // Step 1: the open issues of every view repo, in sorted repo order.
  const repos = [...view.repos].sort(compareRepos);
  const nodes = new Map<IssueKey, Issue>();
  const inViewOpen = new Set<IssueKey>();
  for (const repo of repos) {
    const result = await provider.listOpenIssues(repo, {
      native: view.dependencies.native,
      subIssues: view.dependencies.subIssues,
    });
    warnings.push(...result.warnings);
    for (const issue of result.issues) {
      if (issue.state !== 'open' || nodes.has(issue.key)) continue;
      nodes.set(issue.key, issue);
      inViewOpen.add(issue.key);
    }
  }

  // Step 2: relations of one issue.
  const relationsOf = (issue: Issue): RawRelation[] => {
    const out: RawRelation[] = [];
    for (const rel of issue.nativeRelations) {
      if (rel.source === 'sub-issue' ? view.dependencies.subIssues : view.dependencies.native) {
        out.push(rel);
      }
    }
    if (view.dependencies.body) {
      out.push(...parseBodyRelations(issue.body, { keywords, webHosts }));
    }
    return out;
  };
  const qualify = (ref: IssueRef, declaring: Issue): IssueKey =>
    makeKey(
      { owner: ref.owner ?? declaring.repo.owner, repo: ref.repo ?? declaring.repo.repo },
      ref.number,
    );

  // Step 3: breadth-first resolution of references that are not in the open set.
  const pending: PendingRelation[] = [];
  const lookups = new Map<IssueKey, Lookup>();
  const unresolved: IssueKey[] = [];
  let fetches = 0;

  let level: Issue[] = [...nodes.values()].sort((a, b) => compareKeys(a.key, b.key));
  while (level.length > 0) {
    const unknown = new Set<IssueKey>();
    for (const issue of level) {
      for (const rel of relationsOf(issue)) {
        const refKey = qualify(rel.ref, issue);
        pending.push({ declaring: issue.key, refKey, kind: rel.kind, source: rel.source });
        if (!nodes.has(refKey) && !lookups.has(refKey)) unknown.add(refKey);
      }
    }
    const keys = [...unknown].sort(compareKeys);
    const allowed = Math.max(0, MAX_EXTERNAL_FETCHES - fetches);
    const toFetch = keys.slice(0, allowed);
    for (const key of keys.slice(allowed)) {
      lookups.set(key, 'unresolved');
      unresolved.push(key);
    }
    fetches += toFetch.length;

    const outcomes = await Promise.all(
      toFetch.map(async (key) => {
        const { repo, number } = parseKey(key);
        try {
          return { key, issue: await provider.getIssue(repo, number), error: null };
        } catch (err) {
          return { key, issue: null, error: errorMessage(err) };
        }
      }),
    );

    const next: Issue[] = [];
    for (const { key, issue, error } of outcomes) {
      if (error !== null) {
        warnings.push({
          code: 'fetch-error',
          message: `Could not fetch ${key}: ${error}`,
          issues: [key],
        });
        nodes.set(key, placeholderIssue(key, source.webUrl));
      } else if (issue === null) {
        lookups.set(key, 'missing');
      } else if (issue.state === 'closed') {
        lookups.set(key, 'closed');
      } else {
        // Trust our own qualified key: the provider's issue must be the one we asked for.
        nodes.set(key, issue.key === key ? issue : { ...issue, key });
        next.push(nodes.get(key)!);
      }
    }
    level = next.sort((a, b) => compareKeys(a.key, b.key));
  }

  if (unresolved.length > 0) {
    unresolved.sort(compareKeys);
    warnings.push({
      code: 'external-unresolved',
      message: `Stopped after ${MAX_EXTERNAL_FETCHES} lookups of issues outside the view; ${unresolved.length} referenced issue(s) were not resolved: ${unresolved.join(', ')}`,
      issues: unresolved,
    });
  }

  // Step 4: edges, dangling references.
  const edgeSources = new Map<
    string,
    { from: IssueKey; to: IssueKey; sources: Set<DependencySource> }
  >();
  const dangling = new Set<string>();
  const sortedPending = pending.sort(
    (a, b) =>
      compareKeys(a.declaring, b.declaring) ||
      compareKeys(a.refKey, b.refKey) ||
      cmp(a.kind, b.kind) ||
      cmp(a.source, b.source),
  );
  for (const rel of sortedPending) {
    if (nodes.has(rel.refKey)) {
      const from = rel.kind === 'blocked-by' ? rel.refKey : rel.declaring;
      const to = rel.kind === 'blocked-by' ? rel.declaring : rel.refKey;
      const id = `${from}\u0000${to}`;
      let entry = edgeSources.get(id);
      if (entry === undefined) {
        entry = { from, to, sources: new Set() };
        edgeSources.set(id, entry);
      }
      entry.sources.add(rel.source);
    } else if (lookups.get(rel.refKey) === 'missing') {
      const id = `${rel.declaring}\u0000${rel.refKey}`;
      if (dangling.has(id)) continue;
      dangling.add(id);
      warnings.push({
        code: 'dangling-reference',
        message: `${rel.declaring} references ${rel.refKey}, which does not exist or is not accessible`,
        issues: [rel.declaring],
      });
    }
    // closed (satisfied) and unresolved (already warned about) relations are dropped.
  }
  const allEdges: DependencyEdge[] = [...edgeSources.values()]
    .map((e) => ({ from: e.from, to: e.to, sources: [...e.sources].sort() }))
    .sort((a, b) => compareKeys(a.from, b.from) || compareKeys(a.to, b.to));

  // Step 5: scope. Plan nodes = in-scope issues plus their transitive open prerequisites.
  const predecessors = new Map<IssueKey, IssueKey[]>();
  for (const e of allEdges) {
    const list = predecessors.get(e.to);
    if (list === undefined) predecessors.set(e.to, [e.from]);
    else list.push(e.from);
  }
  const scoped = new Set<IssueKey>();
  for (const key of [...inViewOpen].sort(compareKeys)) {
    if (inScope(nodes.get(key)!, view.scope)) scoped.add(key);
  }
  const included = new Set<IssueKey>(scoped);
  const stack = [...scoped];
  while (stack.length > 0) {
    const key = stack.pop()!;
    for (const pred of predecessors.get(key) ?? []) {
      if (!included.has(pred)) {
        included.add(pred);
        stack.push(pred);
      }
    }
  }

  const keys = [...included].sort(compareKeys);
  const input: PlanInput = {
    viewId: view.id,
    issues: keys.map((k) => nodes.get(k)!),
    externalKeys: keys.filter((k) => !scoped.has(k)),
    edges: allEdges.filter((e) => included.has(e.from) && included.has(e.to)),
    // Drop problems that concern issues which are not part of the plan.
    warnings: warnings.filter(
      (w) =>
        (w.code !== 'dangling-reference' && w.code !== 'fetch-error') ||
        w.issues.every((k) => included.has(k)),
    ),
    priorityLabels: [...view.ordering.priorityLabels],
  };
  return { input };
}
