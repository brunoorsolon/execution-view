import { describe, expect, it } from 'vitest';
import type { IssueKey, LayoutNode, PlanNode } from '../../src/core/types.js';
import { GEOMETRY, packLayout } from './graph-model.js';
import { isSortMode, rankLayoutRows, sortKeys, type SortMode } from './sort.js';

function node(key: IssueKey, extra: Partial<PlanNode> = {}): PlanNode {
  const [ownerRepo = '', num = '0'] = key.split('#');
  const [owner = '', repo = ''] = ownerRepo.split('/');
  return {
    key,
    repo: { owner, repo },
    number: Number(num),
    title: key,
    url: `https://x/${key}`,
    labels: [],
    assignees: [],
    milestone: null,
    updatedAt: null,
    external: false,
    status: 'ready',
    wave: 0,
    order: 0,
    blockedBy: [],
    blocks: [],
    parents: [],
    children: [],
    priority: 0,
    remainingDepth: 1,
    ...extra,
  };
}

function index(...nodes: PlanNode[]): Map<IssueKey, PlanNode> {
  return new Map(nodes.map((n) => [n.key, n]));
}

describe('isSortMode', () => {
  it('accepts the five modes and nothing else', () => {
    for (const m of ['execution', 'number', 'updated', 'prereq', 'dependents'])
      expect(isSortMode(m)).toBe(true);
    for (const m of ['', 'Number', 'size', null]) expect(isSortMode(m)).toBe(false);
  });
});

describe('sortKeys', () => {
  it('orders by issue number, lowest first, across repositories', () => {
    const a = node('acme/api#10');
    const b = node('acme/api#9');
    const c = node('acme/web#3');
    const d = node('acme/web#11');
    expect(sortKeys([a.key, b.key, c.key, d.key], index(a, b, c, d), 'number')).toEqual([
      'acme/web#3',
      'acme/api#9',
      'acme/api#10',
      'acme/web#11',
    ]);
  });

  it('breaks an issue-number tie by repository', () => {
    const a = node('acme/web#4');
    const b = node('acme/api#4');
    expect(sortKeys([a.key, b.key], index(a, b), 'number')).toEqual(['acme/api#4', 'acme/web#4']);
  });

  it('orders by last update, newest first, with unknown timestamps last', () => {
    const old = node('o/r#1', { updatedAt: '2026-01-01T00:00:00Z' });
    const recent = node('o/r#2', { updatedAt: '2026-03-01T00:00:00Z' });
    const middle = node('o/r#3', { updatedAt: '2026-02-01T00:00:00Z' });
    const unknown = node('o/r#4');
    const broken = node('o/r#5', { updatedAt: 'not a date' });
    expect(
      sortKeys(
        [old.key, recent.key, middle.key, unknown.key, broken.key],
        index(old, recent, middle, unknown, broken),
        'updated',
      ),
    ).toEqual(['o/r#2', 'o/r#3', 'o/r#1', 'o/r#4', 'o/r#5']);
  });

  it('compares timestamps as instants, not as text', () => {
    const zulu = node('o/r#1', { updatedAt: '2026-01-01T00:00:00Z' });
    const fraction = node('o/r#2', { updatedAt: '2026-01-01T00:00:00.500Z' });
    const offset = node('o/r#3', { updatedAt: '2026-01-01T01:00:00+01:00' });
    expect(
      sortKeys([zulu.key, fraction.key, offset.key], index(zulu, fraction, offset), 'updated'),
    ).toEqual(['o/r#2', 'o/r#1', 'o/r#3']);
  });

  it('orders by prerequisite count, most first', () => {
    const few = node('o/r#1', { blockedBy: ['o/r#9'] });
    const many = node('o/r#2', { blockedBy: ['o/r#8', 'o/r#9', 'o/r#10'] });
    const none = node('o/r#3');
    expect(sortKeys([few.key, many.key, none.key], index(few, many, none), 'prereq')).toEqual([
      'o/r#2',
      'o/r#1',
      'o/r#3',
    ]);
  });

  it('orders by dependent count, most first', () => {
    const few = node('o/r#1', { blocks: ['o/r#9'] });
    const many = node('o/r#2', { blocks: ['o/r#8', 'o/r#9'] });
    const none = node('o/r#3');
    expect(sortKeys([few.key, many.key, none.key], index(few, many, none), 'dependents')).toEqual([
      'o/r#2',
      'o/r#1',
      'o/r#3',
    ]);
  });

  it('breaks an equal count with the key order, and does not mutate the input', () => {
    const a = node('o/r#3', { blockedBy: ['o/r#9'] });
    const b = node('o/r#1', { blockedBy: ['o/r#8'] });
    const keys = [a.key, b.key];
    expect(sortKeys(keys, index(a, b), 'prereq')).toEqual(['o/r#1', 'o/r#3']);
    expect(keys).toEqual(['o/r#3', 'o/r#1']);
  });
});

describe('rankLayoutRows', () => {
  const layout: LayoutNode[] = [
    { key: 'o/r#3', x: 0, y: 0, width: 1, height: 1, layer: 0, row: 0 },
    { key: 'o/r#1', x: 0, y: 0, width: 1, height: 1, layer: 0, row: 1 },
    { key: 'o/r#2', x: 0, y: 0, width: 1, height: 1, layer: 1, row: 0 },
  ];

  it('keeps the server rows for the execution order', () => {
    expect(rankLayoutRows(layout, index(), 'execution')).toBe(layout);
  });

  it('rewrites each layer row to the sorted rank and keeps the layers apart', () => {
    const nodes = index(node('o/r#1'), node('o/r#2'), node('o/r#3'));
    expect(rankLayoutRows(layout, nodes, 'number')).toEqual([
      { key: 'o/r#1', layer: 0, row: 0 },
      { key: 'o/r#3', layer: 0, row: 1 },
      { key: 'o/r#2', layer: 1, row: 0 },
    ]);
  });

  it('makes packLayout stack a wave column in the chosen order', () => {
    const one = node('o/r#1', { updatedAt: '2026-06-01T00:00:00Z' });
    const two = node('o/r#2', { updatedAt: '2026-01-01T00:00:00Z' });
    const three = node('o/r#3', { updatedAt: '2026-03-01T00:00:00Z' });
    const nodes = index(one, two, three);
    const columns = (mode: SortMode): IssueKey[][] =>
      packLayout(rankLayoutRows(layout, nodes, mode), null, GEOMETRY).columns.map((c) => c.keys);
    expect(columns('execution')).toEqual([['o/r#3', 'o/r#1'], ['o/r#2']]);
    expect(columns('updated')).toEqual([['o/r#1', 'o/r#3'], ['o/r#2']]);
  });
});
