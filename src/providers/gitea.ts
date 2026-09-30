import { compareRefs, makeKey } from '../core/keys.js';
import type {
  FetchResult,
  Issue,
  IssueProvider,
  IssueRef,
  ListOptions,
  PlanWarning,
  RawRelation,
  RepoRef,
} from '../core/types.js';
import { HttpError, createHttpClient, createLimiter, type FetchLike } from './http.js';

export interface GiteaProviderOptions {
  /** Instance root, e.g. https://gitea.example.com or https://example.com/gitea. The API is at `<baseUrl>/api/v1`. */
  baseUrl: string;
  /** Browser root. Accepted for config symmetry; issue URLs come from `html_url`. */
  webUrl?: string;
  /** null = anonymous access. */
  token: string | null;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for rate-limit waits. */
  now?: () => number;
  /** Max concurrent per-issue dependency requests. Default 4. */
  concurrency?: number;
}

interface GtLabel {
  name?: unknown;
}
interface GtUser {
  login?: unknown;
}
interface GtRepositoryMeta {
  owner?: unknown;
  name?: unknown;
  full_name?: unknown;
}
interface GtIssue {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  html_url?: unknown;
  body?: unknown;
  labels?: unknown;
  assignees?: unknown;
  milestone?: { title?: unknown } | null;
  pull_request?: unknown;
  repository?: GtRepositoryMeta | null;
}

/** Page size sent as `limit`. Gitea's default MAX_RESPONSE_ITEMS is 50. */
const PAGE_SIZE = 50;
const MAX_PAGES = 1000;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(cmp);
}

function lowerRepo(repo: RepoRef): RepoRef {
  return { owner: repo.owner.toLowerCase(), repo: repo.repo.toLowerCase() };
}

function repoPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mapIssue(raw: GtIssue, repo: RepoRef): Issue {
  if (
    typeof raw.number !== 'number' ||
    !Number.isSafeInteger(raw.number) ||
    typeof raw.title !== 'string'
  ) {
    throw new Error(`Unexpected Gitea issue payload in ${repo.owner}/${repo.repo}`);
  }
  const labels: string[] = [];
  if (Array.isArray(raw.labels)) {
    for (const l of raw.labels as Array<GtLabel | null>) {
      if (l && typeof l.name === 'string' && l.name !== '') labels.push(l.name);
    }
  }
  const assignees: string[] = [];
  if (Array.isArray(raw.assignees)) {
    for (const a of raw.assignees as Array<GtUser | null>) {
      if (a && typeof a.login === 'string' && a.login !== '') assignees.push(a.login);
    }
  }
  const milestone =
    raw.milestone && typeof raw.milestone.title === 'string' ? raw.milestone.title : null;
  return {
    key: makeKey(repo, raw.number),
    repo,
    number: raw.number,
    title: raw.title,
    state: raw.state === 'closed' ? 'closed' : 'open',
    url: typeof raw.html_url === 'string' ? raw.html_url : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    labels: sortedUnique(labels),
    assignees: sortedUnique(assignees),
    milestone,
    nativeRelations: [],
  };
}

/** Owner/repo from `repository.owner` + `repository.name`, else `repository.full_name`, else `fallback`. */
function refFromItem(item: GtIssue, fallback: RepoRef): IssueRef | null {
  if (typeof item.number !== 'number' || !Number.isSafeInteger(item.number)) return null;
  let owner = fallback.owner;
  let repo = fallback.repo;
  const meta = isPlainObject(item.repository) ? (item.repository as GtRepositoryMeta) : null;
  if (meta) {
    const ownerName =
      typeof meta.owner === 'string'
        ? meta.owner
        : isPlainObject(meta.owner) && typeof meta.owner.login === 'string'
          ? meta.owner.login
          : '';
    if (ownerName !== '' && typeof meta.name === 'string' && meta.name !== '') {
      owner = ownerName.toLowerCase();
      repo = meta.name.toLowerCase();
    } else if (typeof meta.full_name === 'string') {
      const slash = meta.full_name.indexOf('/');
      if (slash > 0 && slash < meta.full_name.length - 1) {
        owner = meta.full_name.slice(0, slash).toLowerCase();
        repo = meta.full_name.slice(slash + 1).toLowerCase();
      }
    }
  }
  return { owner, repo, number: item.number };
}

function sourceRank(s: RawRelation['source']): number {
  return s === 'native' ? 0 : s === 'body' ? 1 : 2;
}

function compareRelations(a: RawRelation, b: RawRelation): number {
  return (
    cmp(a.kind, b.kind) || compareRefs(a.ref, b.ref) || sourceRank(a.source) - sourceRank(b.source)
  );
}

function normalizeRelations(relations: RawRelation[]): RawRelation[] {
  const sorted = [...relations].sort(compareRelations);
  return sorted.filter((r, i) => i === 0 || compareRelations(sorted[i - 1]!, r) !== 0);
}

function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

export function createGiteaProvider(opts: GiteaProviderOptions): IssueProvider {
  const apiBase = `${opts.baseUrl.replace(/\/+$/, '')}/api/v1`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'execution-view',
  };
  if (opts.token !== null) headers.Authorization = `token ${opts.token}`;

  const client = createHttpClient({
    baseUrl: apiBase,
    headers,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const limit = createLimiter(opts.concurrency ?? 4);

  /**
   * Gitea paginates with `limit`/`page` and sends no Link header we rely on. The server may
   * silently cap `limit` (`[api] MAX_RESPONSE_ITEMS`), so a page shorter than PAGE_SIZE does not
   * mean the last page. Stop rules:
   * 1. `X-Total-Count` present: stop once that many raw items were fetched, or on an empty page.
   * 2. Otherwise: stop on an empty page, or on a page shorter than the first page (the
   *    effective server limit).
   */
  async function getPaged<T>(path: string): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const safe = `${apiBase}${path.split('?')[0]}`;
    const items: T[] = [];
    let firstPageSize = 0;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        throw new HttpError(`GET ${safe} failed: pagination did not terminate`, 0, safe);
      }
      const { data, headers, status } = await client.getJson<T[]>(
        `${path}${sep}limit=${PAGE_SIZE}&page=${page}`,
      );
      if (!Array.isArray(data)) {
        throw new HttpError(`GET ${safe} returned a non-array JSON body`, status, safe);
      }
      for (const item of data) items.push(item);
      if (data.length === 0) return items;
      const totalHeader = headers.get('x-total-count')?.trim() ?? '';
      if (/^\d+$/.test(totalHeader)) {
        if (items.length >= Number(totalHeader)) return items;
      } else {
        if (page === 1) firstPageSize = data.length;
        if (data.length < firstPageSize) return items;
      }
    }
  }

  /**
   * Fetches the dependencies of each issue. The first issue goes alone: a 404 there means the
   * endpoint is unavailable, and nothing else is requested. Later 404s only skip that issue.
   * Returns null when unsupported.
   */
  async function fetchDependencies(
    repo: RepoRef,
    issues: Issue[],
  ): Promise<Map<number, GtIssue[]> | null> {
    const results = new Map<number, GtIssue[]>();
    const fetchOne = (issue: Issue): Promise<GtIssue[]> =>
      limit(() => getPaged<GtIssue>(`${repoPath(repo)}/issues/${issue.number}/dependencies`));
    const [first, ...rest] = issues;
    if (!first) return results;
    try {
      results.set(first.number, await fetchOne(first));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    await Promise.all(
      rest.map(async (issue) => {
        try {
          results.set(issue.number, await fetchOne(issue));
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }),
    );
    return results;
  }

  async function listOpenIssues(repoIn: RepoRef, options: ListOptions): Promise<FetchResult> {
    const repo = lowerRepo(repoIn);
    const rawItems = await getPaged<GtIssue>(`${repoPath(repo)}/issues?state=open&type=issues`);

    const issues: Issue[] = [];
    for (const raw of rawItems) {
      if (!isPlainObject(raw) || raw.pull_request) continue;
      issues.push(mapIssue(raw, repo));
    }
    issues.sort((a, b) => a.number - b.number);

    const warnings: PlanWarning[] = [];
    if (options.native) {
      const found = await fetchDependencies(repo, issues);
      if (found === null) {
        warnings.push({
          code: 'native-unsupported',
          message: `Issue dependencies are not available for ${repo.owner}/${repo.repo} (the dependencies endpoint returned 404). Gitea: enable issue dependencies in the repository settings (the exact location varies by Gitea version) or set [service] DEFAULT_ENABLE_DEPENDENCIES = true in app.ini. Native relations are skipped.`,
          issues: [],
        });
      } else {
        for (const issue of issues) {
          const relations: RawRelation[] = [];
          for (const item of found.get(issue.number) ?? []) {
            if (!isPlainObject(item)) continue;
            const ref = refFromItem(item, repo);
            if (ref) relations.push({ kind: 'blocked-by', ref, source: 'native' });
          }
          issue.nativeRelations = normalizeRelations(relations);
        }
      }
    }
    return { issues, warnings };
  }

  async function getIssue(repoIn: RepoRef, number: number): Promise<Issue | null> {
    const repo = lowerRepo(repoIn);
    try {
      const { data } = await client.getJson<GtIssue>(`${repoPath(repo)}/issues/${number}`);
      if (!isPlainObject(data) || data.pull_request) return null;
      return mapIssue(data, repo);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
  }

  return { kind: 'gitea', listOpenIssues, getIssue };
}
