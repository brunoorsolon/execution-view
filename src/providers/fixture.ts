import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { compareRefs, makeKey, parseKey } from '../core/keys.js';
import type {
  FetchResult,
  Issue,
  IssueProvider,
  ListOptions,
  RawRelation,
  RepoRef,
} from '../core/types.js';

export interface FixtureProviderOptions {
  /** Path of the JSON fixture file. */
  path: string;
  /** Base of the browser URLs. Default `https://fixture.local`. */
  webUrl?: string;
}

const DEFAULT_WEB_URL = 'https://fixture.local';

const fixtureIssueSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().min(1),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  body: z.string().nullish(),
  labels: z.array(z.string()).nullish(),
  assignees: z.array(z.string()).nullish(),
  milestone: z.string().nullish(),
  blockedBy: z.array(z.string()).nullish(),
});

/** Top-level extra fields (such as `_comment`) are ignored. */
const fixtureFileSchema = z.object({
  issues: z.array(z.unknown()),
});

function sortedUnique(values: readonly string[]): string[] {
  // The default sort compares UTF-16 code units, which is what we want.
  return [...new Set(values)].sort();
}

function formatZodIssues(error: z.ZodError, prefix: string): string {
  return error.issues
    .map((i) => {
      const where = i.path.length > 0 ? `${prefix}.${i.path.join('.')}` : prefix;
      return `${where}: ${i.message}`;
    })
    .join('; ');
}

interface ParsedFixture {
  /** Every issue, sorted by key (owner/repo, then number). */
  issues: Issue[];
}

function parseFixture(text: string, file: string): ParsedFixture {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Fixture file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const top = fixtureFileSchema.safeParse(json);
  if (!top.success) {
    throw new Error(
      `Invalid fixture file ${file}: expected { "issues": [...] } (${formatZodIssues(top.error, '$')})`,
    );
  }

  const seen = new Map<string, number>();
  const issues: Issue[] = [];
  top.data.issues.forEach((raw, index) => {
    const label = `issues[${index}]`;
    const parsed = fixtureIssueSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid fixture file ${file}: ${formatZodIssues(parsed.error, label)}`);
    }
    const f = parsed.data;
    const repo: RepoRef = { owner: f.owner.toLowerCase(), repo: f.repo.toLowerCase() };
    const key = makeKey(repo, f.number);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `Invalid fixture file ${file}: ${label} duplicates ${key} (already defined at issues[${first}])`,
      );
    }
    seen.set(key, index);

    const nativeRelations: RawRelation[] = (f.blockedBy ?? []).map((blockedKey, j) => {
      try {
        const p = parseKey(blockedKey);
        return {
          kind: 'blocked-by' as const,
          ref: { owner: p.repo.owner, repo: p.repo.repo, number: p.number },
          source: 'native' as const,
        };
      } catch {
        throw new Error(
          `Invalid fixture file ${file}: ${label}.blockedBy[${j}] is not a valid issue key ` +
            `(expected "owner/repo#number"): ${JSON.stringify(blockedKey)}`,
        );
      }
    });
    nativeRelations.sort((a, b) => compareRefs(a.ref, b.ref));

    issues.push({
      key,
      repo,
      number: f.number,
      title: f.title,
      state: f.state,
      url: '',
      body: f.body ?? '',
      labels: sortedUnique(f.labels ?? []),
      assignees: sortedUnique(f.assignees ?? []),
      milestone: f.milestone ?? null,
      nativeRelations,
    });
  });
  return { issues };
}

/**
 * Provider backed by a JSON file: `{ "issues": [...] }`. No network access.
 * The file is read and validated lazily on first use, then cached.
 */
export function createFixtureProvider(opts: FixtureProviderOptions): IssueProvider {
  const webUrl = (opts.webUrl ?? DEFAULT_WEB_URL).replace(/\/+$/, '');
  let cache: Promise<ParsedFixture> | null = null;

  function load(): Promise<ParsedFixture> {
    if (cache === null) {
      const pending = readFile(opts.path, 'utf8')
        .catch((err: unknown) => {
          throw new Error(
            `Cannot read fixture file ${opts.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .then((text) => parseFixture(text, opts.path));
      cache = pending;
      // Do not cache failures, so a fixed file can be picked up on the next call.
      pending.catch(() => {
        if (cache === pending) cache = null;
      });
    }
    return cache;
  }

  function toIssue(issue: Issue, includeNative: boolean): Issue {
    return {
      ...issue,
      url: `${webUrl}/${issue.repo.owner}/${issue.repo.repo}/issues/${issue.number}`,
      labels: [...issue.labels],
      assignees: [...issue.assignees],
      nativeRelations: includeNative
        ? issue.nativeRelations.map((r) => ({ ...r, ref: { ...r.ref } }))
        : [],
    };
  }

  return {
    kind: 'fixture',

    async listOpenIssues(repo: RepoRef, options: ListOptions): Promise<FetchResult> {
      const { issues } = await load();
      const owner = repo.owner.toLowerCase();
      const name = repo.repo.toLowerCase();
      const open = issues
        .filter((i) => i.state === 'open' && i.repo.owner === owner && i.repo.repo === name)
        .sort((a, b) => a.number - b.number)
        .map((i) => toIssue(i, options.native));
      return { issues: open, warnings: [] };
    },

    async getIssue(repo: RepoRef, number: number): Promise<Issue | null> {
      const { issues } = await load();
      const key = makeKey(repo, number);
      const found = issues.find((i) => i.key === key);
      return found ? toIssue(found, true) : null;
    },
  };
}
