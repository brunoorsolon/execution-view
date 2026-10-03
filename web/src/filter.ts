import type { NodeStatus } from '../../src/core/types.js';
import { displayStatus, type DisplayStatus } from './format.js';

/**
 * The filter query language. One query drives every view; the filter menu only
 * writes qualifiers into the same text.
 *
 *  - free text: title or key contains it (case-insensitive)
 *  - `#12`: issue number, in any repository; `owner/repo#12` or `repo#12`: issue key
 *  - `parent:#71`, `parent:71` or `parent:owner/repo#71`: the issue itself and every
 *    issue that names it in `parents`
 *  - `status:ready`: ready, in-progress, blocked, cycle (in-cycle), blocked-by-cycle,
 *    unschedulable (both cycle statuses), external
 *  - `priority:P0`, `priority:none`
 *  - `label:backend`, `label:"good first issue"`
 *  - `assignee:bob` or `@bob` (`-@bob` excludes)
 *  - `milestone:"v1.0 Launch"`
 *  - `repo:web` or `repo:acme/web`
 *  - `is:critical` (on the critical path); `is:` also takes the status values
 *  - `no:assignee`, `no:milestone`, `no:label`, `no:priority`
 *  - a leading `-` excludes: `-label:docs`
 *
 * Values of one field are alternatives (`status:ready,blocked`, or the field
 * repeated); different fields, excluded values and text terms must all match.
 */

export interface FilterTarget {
  key: string;
  number: number;
  title: string;
  labels: readonly string[];
  assignees: readonly string[];
  milestone: string | null;
  /** `owner/repo` */
  repo: string;
  status: NodeStatus;
  external: boolean;
  /** Configured priority label, null when none. */
  priority: string | null;
  critical: boolean;
  /** Keys of the issues that name this one in `parents`. */
  parents: readonly string[];
}

export type Field =
  'status' | 'label' | 'assignee' | 'milestone' | 'repo' | 'priority' | 'is' | 'no' | 'parent';

const FIELDS: Record<string, Field> = {
  status: 'status',
  label: 'label',
  assignee: 'assignee',
  milestone: 'milestone',
  repo: 'repo',
  priority: 'priority',
  is: 'is',
  no: 'no',
  parent: 'parent',
};

export type TextTerm =
  | { kind: 'number'; value: number }
  | { kind: 'key'; value: string }
  | { kind: 'text'; value: string };

export interface Query {
  /** Field -> accepted values: lowercase value -> value as typed. Any one must match. */
  include: Map<Field, Map<string, string>>;
  /** Excluded values (lowercase); none may match. */
  exclude: { field: Field; values: string[] }[];
  text: TextTerm[];
}

const TOKEN_RE = /-?[a-z]+:"[^"]*"|"[^"]*"|\S+/gi;
const QUALIFIER_RE = /^(-?)([a-z]+):(.*)$/i;
const NUMBER_RE = /^#(\d+)$/;
const KEY_RE = /^[^\s#"]+#\d+$/;
const MENTION_RE = /^@[^\s@]+$/;

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function fieldOf(name: string): Field | undefined {
  return Object.hasOwn(FIELDS, name.toLowerCase()) ? FIELDS[name.toLowerCase()] : undefined;
}

function tokens(q: string): string[] {
  return q.match(TOKEN_RE) ?? [];
}

export function parseQuery(q: string): Query {
  const include = new Map<Field, Map<string, string>>();
  const exclude: Query['exclude'] = [];
  const text: TextTerm[] = [];
  const add = (field: Field, value: string): void => {
    const values = include.get(field) ?? new Map<string, string>();
    values.set(value.toLowerCase(), value);
    include.set(field, values);
  };
  for (const raw of tokens(q)) {
    const m = QUALIFIER_RE.exec(raw);
    const field = m ? fieldOf(m[2]!) : undefined;
    if (m && field) {
      const rest = m[3]!;
      const values = (rest.startsWith('"') ? [unquote(rest)] : rest.split(','))
        .map((v) => v.trim())
        .filter((v) => v !== '');
      if (m[1] === '-') {
        if (values.length > 0) exclude.push({ field, values: values.map((v) => v.toLowerCase()) });
      } else {
        for (const v of values) add(field, v);
      }
      continue;
    }
    if (MENTION_RE.test(raw)) {
      add('assignee', raw.slice(1));
      continue;
    }
    if (raw.startsWith('-') && MENTION_RE.test(raw.slice(1))) {
      exclude.push({ field: 'assignee', values: [raw.slice(2).toLowerCase()] });
      continue;
    }
    const num = NUMBER_RE.exec(raw);
    if (num) {
      text.push({ kind: 'number', value: Number(num[1]) });
      continue;
    }
    if (KEY_RE.test(raw)) {
      text.push({ kind: 'key', value: raw.toLowerCase() });
      continue;
    }
    const value = unquote(raw).trim().toLowerCase();
    if (value !== '' && value !== '-') text.push({ kind: 'text', value });
  }
  return { include, exclude, text };
}

const STATUSES: Record<string, readonly DisplayStatus[]> = {
  ready: ['ready'],
  'in-progress': ['in-progress'],
  blocked: ['blocked'],
  cycle: ['in-cycle'],
  'in-cycle': ['in-cycle'],
  'blocked-by-cycle': ['blocked-by-cycle'],
  unschedulable: ['in-cycle', 'blocked-by-cycle'],
};

/** Whether one qualifier value (lowercase) matches the target. */
export function matchesQualifier(field: Field, value: string, t: FilterTarget): boolean {
  switch (field) {
    case 'status':
      return value === 'external' ? t.external : (STATUSES[value] ?? []).includes(displayStatus(t));
    case 'label':
      return t.labels.some((l) => l.toLowerCase() === value);
    case 'assignee':
      return t.assignees.some((a) => a.toLowerCase() === value);
    case 'milestone':
      return (t.milestone ?? '').toLowerCase() === value;
    case 'repo': {
      const repo = t.repo.toLowerCase();
      return repo === value || repo.slice(repo.indexOf('/') + 1) === value;
    }
    case 'priority':
      return value === 'none' ? t.priority === null : (t.priority ?? '').toLowerCase() === value;
    case 'is':
      return value === 'critical' ? t.critical : matchesQualifier('status', value, t);
    case 'parent': {
      // A parent is matched by the issue itself and by every issue it parents.
      const num = /^#?(\d+)$/.exec(value);
      if (num) {
        const n = Number(num[1]);
        return t.number === n || t.parents.some((p) => numberFromKey(p) === n);
      }
      return matchesKey(t.key, value) || t.parents.some((p) => matchesKey(p, value));
    }
    case 'no':
      if (value === 'assignee') return t.assignees.length === 0;
      if (value === 'milestone') return t.milestone === null || t.milestone === '';
      if (value === 'label' || value === 'labels') return t.labels.length === 0;
      if (value === 'priority') return t.priority === null;
      return false;
  }
}

function numberFromKey(key: string): number {
  return Number(key.slice(key.lastIndexOf('#') + 1));
}

/** Whether a key matches a value as typed: exact, or with a bare repo name. */
function matchesKey(key: string, value: string): boolean {
  const k = key.toLowerCase();
  return k === value || k.endsWith(`/${value}`);
}

function matchesText(term: TextTerm, t: FilterTarget): boolean {
  const key = t.key.toLowerCase();
  switch (term.kind) {
    case 'number':
      return t.number === term.value;
    case 'key':
      return key === term.value || key.endsWith(`/${term.value}`);
    case 'text':
      return t.title.toLowerCase().includes(term.value) || key.includes(term.value);
  }
}

export function matchesQuery(query: Query, t: FilterTarget): boolean {
  for (const [field, values] of query.include) {
    if (![...values.keys()].some((v) => matchesQualifier(field, v, t))) return false;
  }
  for (const { field, values } of query.exclude) {
    if (values.some((v) => matchesQualifier(field, v, t))) return false;
  }
  return query.text.every((term) => matchesText(term, t));
}

export function isEmptyQuery(query: Query): boolean {
  return query.include.size === 0 && query.exclude.length === 0 && query.text.length === 0;
}

/** null when the query is empty (nothing is filtered). */
export function compileFilter(q: string): ((target: FilterTarget) => boolean) | null {
  const query = parseQuery(q);
  if (isEmptyQuery(query)) return null;
  return (target) => matchesQuery(query, target);
}

/** Whether `field:value` is one of the included values of the query. */
export function hasQualifier(q: string, field: Field, value: string): boolean {
  return parseQuery(q).include.get(field)?.has(value.toLowerCase()) ?? false;
}

/** Number of qualifier values in the query (included and excluded), for a badge. */
export function qualifierCount(q: string): number {
  const query = parseQuery(q);
  let n = query.exclude.length;
  for (const values of query.include.values()) n += values.size;
  return n;
}

/**
 * Adds `field:value` to the query, or removes it when present, keeping every
 * other term as typed. The field's values are rewritten as one
 * `field:a,b` token (values with spaces get their own quoted token).
 */
export function toggleQualifier(q: string, field: Field, value: string): string {
  const values = new Map(parseQuery(q).include.get(field) ?? []);
  const lower = value.toLowerCase();
  if (values.has(lower)) values.delete(lower);
  else values.set(lower, value);
  const kept = tokens(q).filter((raw) => {
    const m = QUALIFIER_RE.exec(raw);
    if (m && m[1] === '' && fieldOf(m[2]!) === field) return false;
    return !(field === 'assignee' && MENTION_RE.test(raw));
  });
  const all = [...values.values()];
  const plain = all.filter((v) => !/[\s,"]/.test(v));
  const spaced = all.filter((v) => /[\s,"]/.test(v));
  const added: string[] = [];
  if (plain.length > 0) added.push(`${field}:${plain.join(',')}`);
  for (const v of spaced) added.push(`${field}:"${v.replace(/"/g, '')}"`);
  return [...kept, ...added].join(' ');
}
