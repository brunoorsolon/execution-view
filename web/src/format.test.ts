import { describe, expect, it } from 'vitest';
import {
  displayKey,
  keyNumber,
  plural,
  relativeTime,
  shortHash,
  shortKey,
  statusLabel,
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
    expect(statusLabel('in-cycle')).toBe('in cycle');
    expect(statusLabel('blocked-by-cycle')).toBe('blocked by cycle');
  });
});
