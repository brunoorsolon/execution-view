import type { IssueKey, IssueRef, RepoRef } from './types.js';

/** Plain code-unit comparison (never localeCompare). */
function cmp<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Builds the canonical key "owner/repo#number". owner and repo are lowercased. */
export function makeKey(repo: RepoRef, number: number): IssueKey {
  return `${repo.owner}/${repo.repo}#${number}`.toLowerCase();
}

const KEY_RE = /^([^/#\s]+)\/([^/#\s]+)#([0-9]+)$/;

/** Parses a canonical key. Throws on malformed input. */
export function parseKey(key: IssueKey): { repo: RepoRef; number: number } {
  const m = KEY_RE.exec(key);
  if (!m) {
    throw new Error(`Malformed issue key: ${JSON.stringify(key)}`);
  }
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Malformed issue key (bad issue number): ${JSON.stringify(key)}`);
  }
  return { repo: { owner: m[1]!.toLowerCase(), repo: m[2]!.toLowerCase() }, number };
}

/** Total order on keys: owner/repo by code unit, then number numerically. */
export function compareKeys(a: IssueKey, b: IssueKey): number {
  const pa = parseKey(a);
  const pb = parseKey(b);
  return (
    cmp(`${pa.repo.owner}/${pa.repo.repo}`, `${pb.repo.owner}/${pb.repo.repo}`) ||
    cmp(pa.number, pb.number)
  );
}

/** Orders refs: null owner/repo first, then owner/repo by code unit, then number. */
export function compareRefs(a: IssueRef, b: IssueRef): number {
  const aNull = a.owner === null || a.repo === null;
  const bNull = b.owner === null || b.repo === null;
  if (aNull !== bNull) return aNull ? -1 : 1;
  if (!aNull && !bNull) {
    const c = cmp(`${a.owner}/${a.repo}`, `${b.owner}/${b.repo}`);
    if (c !== 0) return c;
  }
  return cmp(a.number, b.number);
}
