import type { IssueKey, NodeStatus } from '../../src/core/types.js';

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

export function statusLabel(status: NodeStatus): string {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'blocked':
      return 'blocked';
    case 'in-cycle':
      return 'in cycle';
    case 'blocked-by-cycle':
      return 'blocked by cycle';
  }
}
