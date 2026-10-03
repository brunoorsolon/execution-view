import { describe, expect, it } from 'vitest';
import {
  displayKey,
  displayStatus,
  isClaimed,
  isMap,
  isSpec,
  keyNumber,
  plural,
  relativeTime,
  shortHash,
  shortKey,
  statusLabel,
  workflowStatus,
} from './format.js';

const NOW = Date.parse('2026-01-10T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe('relativeTime', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(relativeTime(ago(0), NOW)).toBe('just now');
    expect(relativeTime(ago(4_000), NOW)).toBe('just now');
    expect(relativeTime(ago(12_000), NOW)).toBe('12s ago');
    expect(relativeTime(ago(59_000), NOW)).toBe('59s ago');
    expect(relativeTime(ago(60_000), NOW)).toBe('1 min ago');
    expect(relativeTime(ago(5 * 60_000 + 30_000), NOW)).toBe('5 min ago');
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3 h ago');
    expect(relativeTime(ago(23 * 3_600_000), NOW)).toBe('23 h ago');
    expect(relativeTime(ago(24 * 3_600_000), NOW)).toBe('1 d ago');
    expect(relativeTime(ago(10 * 86_400_000), NOW)).toBe('10 d ago');
  });

  it('treats future timestamps as now and bad input as unknown', () => {
    expect(relativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe('just now');
    expect(relativeTime('not a date', NOW)).toBe('unknown');
  });
});

describe('keys and labels', () => {
  it('shows #N for single-repo views and the full key otherwise', () => {
    expect(displayKey('acme/api#12', false)).toBe('#12');
    expect(displayKey('acme/api#12', true)).toBe('acme/api#12');
    expect(keyNumber('acme/api#12')).toBe('12');
  });
  it('drops the owner in short keys', () => {
    expect(shortKey('acme/api#12', false)).toBe('#12');
    expect(shortKey('acme/api#12', true)).toBe('api#12');
  });
  it('shortens hashes', () => {
    expect(shortHash('0123456789abcdef')).toBe('01234567');
    expect(shortHash('abc')).toBe('abc');
  });
  it('pluralizes', () => {
    expect(plural(1, 'issue')).toBe('1 issue');
    expect(plural(0, 'issue')).toBe('0 issues');
    expect(plural(4, 'issue')).toBe('4 issues');
  });
  it('names statuses', () => {
    expect(statusLabel('ready')).toBe('Ready');
    expect(statusLabel('in-progress')).toBe('In progress');
    expect(statusLabel('spec')).toBe('Spec');
    expect(statusLabel('map')).toBe('Map');
    expect(statusLabel('in-cycle')).toBe('In cycle');
    expect(statusLabel('blocked-by-cycle')).toBe('Blocked by cycle');
  });
});

describe('displayStatus', () => {
  const node = (status: 'ready' | 'blocked', labels: string[]) => ({ status, labels });

  it('recognizes both separators of every workflow label, case-insensitively', () => {
    expect(isClaimed(['agent:claimed'])).toBe(true);
    expect(isClaimed(['Agent/CLAIMED'])).toBe(true);
    expect(isSpec(['spec:decomposed'])).toBe(true);
    expect(isSpec(['SPEC/decomposed'])).toBe(true);
    expect(isMap(['wayfinder:map'])).toBe(true);
    expect(isMap(['Wayfinder/MAP'])).toBe(true);
    for (const looser of [
      'agent-claimed',
      'agent:claim',
      'xagent:claimed',
      'spec-decomposed',
      'spec:decompose',
      'spec/decomposed:extra',
      'wayfinder-maps',
      'wayfinder:maps',
    ]) {
      expect(isClaimed([looser])).toBe(false);
      expect(isSpec([looser])).toBe(false);
      expect(isMap([looser])).toBe(false);
    }
  });

  it('shows Spec and Map instead of Ready, and over In progress', () => {
    expect(displayStatus(node('ready', []))).toBe('ready');
    expect(displayStatus(node('ready', ['agent:claimed']))).toBe('in-progress');
    expect(displayStatus(node('ready', ['spec/decomposed']))).toBe('spec');
    expect(displayStatus(node('ready', ['wayfinder:map']))).toBe('map');
    expect(displayStatus(node('ready', ['agent/claimed', 'spec:decomposed']))).toBe('spec');
    expect(displayStatus(node('ready', ['agent:claimed', 'wayfinder/map']))).toBe('map');
  });

  it('keeps blocked and cycle precedence while still reporting the label', () => {
    expect(displayStatus(node('blocked', ['spec/decomposed']))).toBe('blocked');
    expect(displayStatus({ status: 'in-cycle', labels: ['wayfinder/map'] })).toBe('in-cycle');
    expect(workflowStatus(['spec/decomposed'])).toBe('spec');
    expect(workflowStatus(['wayfinder/map'])).toBe('map');
    expect(workflowStatus(['agent/claimed'])).toBe('in-progress');
    expect(workflowStatus([])).toBeNull();
  });
});
