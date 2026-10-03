import type { DependencySource, IssueKey, NodeStatus } from '../../src/core/types.js';

/** Display order of a link's declared sources, most authoritative first. */
const SOURCE_ORDER: readonly DependencySource[] = ['native', 'body', 'sub-issue'];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Human relative time ("just now", "5 min ago", "3 h ago", "2 d ago"). Future times count as now. */
export function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const diff = Math.max(0, nowMs - t);
  if (diff < 5 * SECOND) return 'just now';
  if (diff < MINUTE) return `${Math.floor(diff / SECOND)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  return `${Math.floor(diff / DAY)} d ago`;
}

/** Absolute local time for tooltips; falls back to the raw string. */
export function absoluteTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/** Readable text for a link's declared sources ("native", "body", "native + body"). */
export function sourceLabel(sources: readonly DependencySource[]): string {
  return SOURCE_ORDER.filter((s) => sources.includes(s)).join(' + ');
}

export function shortHash(hash: string, length = 8): string {
  return hash.slice(0, length);
}

/** The number part of a canonical key ("owner/repo#12" gives "12"). */
export function keyNumber(key: IssueKey): string {
  return key.slice(key.lastIndexOf('#') + 1);
}

/** `#N` for single-repo views, the full `owner/repo#N` otherwise. */
export function displayKey(key: IssueKey, multiRepo: boolean): string {
  return multiRepo ? key : `#${keyNumber(key)}`;
}

/** Compact form for small cards: `#N`, or `repo#N` (no owner) for multi-repo views. */
export function shortKey(key: IssueKey, multiRepo: boolean): string {
  return multiRepo ? key.slice(key.indexOf('/') + 1) : `#${keyNumber(key)}`;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export type DisplayStatus = NodeStatus | 'in-progress' | 'spec' | 'map';

/** Exact label match, case-insensitive, with either `:` or `/` as separator. */
function hasLabel(labels: readonly string[], name: string, value: string): boolean {
  return labels.some((label) => {
    const lower = label.toLowerCase();
    return lower === `${name}:${value}` || lower === `${name}/${value}`;
  });
}

export function isClaimed(labels: readonly string[]): boolean {
  return hasLabel(labels, 'agent', 'claimed');
}

/** A decomposed spec carries `spec:decomposed` or `spec/decomposed`. */
export function isSpec(labels: readonly string[]): boolean {
  return hasLabel(labels, 'spec', 'decomposed');
}

/** A Wayfinder map carries `wayfinder:map` or `wayfinder/map`. */
export function isMap(labels: readonly string[]): boolean {
  return hasLabel(labels, 'wayfinder', 'map');
}

/**
 * The workflow status a label implies, most specific first: Spec and Map take
 * precedence over In progress. Null when no workflow label applies.
 */
export function workflowStatus(labels: readonly string[]): 'in-progress' | 'spec' | 'map' | null {
  if (isSpec(labels)) return 'spec';
  if (isMap(labels)) return 'map';
  if (isClaimed(labels)) return 'in-progress';
  return null;
}

/**
 * Workflow labels change presentation, not the planner's dependency status:
 * blocked and cycle statuses stay visible. Spec and Map hide Ready, and take
 * precedence over In progress.
 */
export function displayStatus(node: {
  status: NodeStatus;
  labels: readonly string[];
}): DisplayStatus {
  if (node.status !== 'ready') return node.status;
  return workflowStatus(node.labels) ?? 'ready';
}

export function statusLabel(status: DisplayStatus): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'in-progress':
      return 'In progress';
    case 'spec':
      return 'Spec';
    case 'map':
      return 'Map';
    case 'blocked':
      return 'Blocked';
    case 'in-cycle':
      return 'In cycle';
    case 'blocked-by-cycle':
      return 'Blocked by cycle';
  }
}
