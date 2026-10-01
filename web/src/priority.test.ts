import { describe, expect, it } from 'vitest';
import { priorityName } from './priority.js';

describe('priorityName', () => {
  const snapshot = { priorityLabels: ['P0', 'P1', 'P2'] };

  it('returns the configured label at the priority index', () => {
    expect(priorityName(snapshot, { priority: 0 })).toBe('P0');
    expect(priorityName(snapshot, { priority: 2 })).toBe('P2');
  });

  it('returns null for the "no priority label" index', () => {
    expect(priorityName(snapshot, { priority: 3 })).toBeNull();
  });

  it('returns null when no priority labels are configured', () => {
    expect(priorityName({ priorityLabels: [] }, { priority: 0 })).toBeNull();
  });
});
