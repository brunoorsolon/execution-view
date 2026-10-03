import { describe, expect, it } from 'vitest';
import {
  compileFilter,
  hasQualifier,
  parseQuery,
  qualifierCount,
  toggleQualifier,
  type FilterTarget,
} from './filter.js';

const issue = (
  key: string,
  title: string,
  labels: string[] = [],
  extra: Partial<FilterTarget> = {},
): FilterTarget => ({
  key,
  number: Number(key.slice(key.indexOf('#') + 1)),
  title,
  labels,
  assignees: [],
  milestone: null,
  repo: key.slice(0, key.indexOf('#')),
  status: 'blocked',
  external: false,
  priority: null,
  critical: false,
  parents: [],
  ...extra,
});

const login = issue('acme/web#3', 'Login page', ['P0', 'ui'], {
  assignees: ['erin'],
  milestone: 'v0.2 Core API',
  priority: 'P0',
});
const auth = issue('acme/api#4', 'Implement authentication with JWT', ['P0', 'security'], {
  assignees: ['alice', 'bob'],
  milestone: 'v0.1 Foundations',
  priority: 'P0',
  critical: true,
});
const other = issue('acme/api#13', 'Job dashboard', ['P1'], {
  status: 'in-cycle',
  priority: 'P1',
});
const schema = issue('acme/api#2', 'Design database schema', [], { status: 'ready' });

describe('parseQuery', () => {
  it('splits qualifiers, mentions and text terms', () => {
    const q = parseQuery('label:P1 @bob #12 acme/api#4 login -label:docs');
    expect([...q.include.entries()].map(([f, v]) => [f, [...v.values()]])).toEqual([
      ['label', ['P1']],
      ['assignee', ['bob']],
    ]);
    expect(q.exclude).toEqual([{ field: 'label', values: ['docs'] }]);
    expect(q.text).toEqual([
      { kind: 'number', value: 12 },
      { kind: 'key', value: 'acme/api#4' },
      { kind: 'text', value: 'login' },
    ]);
  });

  it('supports quoted values, comma lists and ignores empty ones', () => {
    const q = parseQuery('milestone:"v1.0 Launch" status:ready,blocked label: ');
    expect([...q.include.get('milestone')!.values()]).toEqual(['v1.0 Launch']);
    expect([...q.include.get('status')!.keys()]).toEqual(['ready', 'blocked']);
    expect(q.include.has('label')).toBe(false);
  });

  it('treats unknown fields as text', () => {
    expect(parseQuery('foo:bar').text).toEqual([{ kind: 'text', value: 'foo:bar' }]);
  });
});

describe('compileFilter', () => {
  it('is null for an empty query', () => {
    expect(compileFilter('')).toBeNull();
    expect(compileFilter('  ')).toBeNull();
    expect(compileFilter('label:')).toBeNull();
  });

  it('matches the title substring, case-insensitively, words with AND', () => {
    expect(compileFilter('LOGIN')!(login)).toBe(true);
    expect(compileFilter('LOGIN')!(auth)).toBe(false);
    expect(compileFilter('jwt implement')!(auth)).toBe(true);
    expect(compileFilter('jwt implement')!(login)).toBe(false);
  });

  it('matches labels exactly and case-insensitively', () => {
    const f = compileFilter('label:p0')!;
    expect(f(login)).toBe(true);
    expect(f(auth)).toBe(true);
    expect(f(other)).toBe(false);
    expect(compileFilter('label:P')!(login)).toBe(false);
    expect(compileFilter('LABEL:UI')!(login)).toBe(true);
  });

  it('matches #N by number in any repository, and keys exactly or by repo name', () => {
    expect(compileFilter('#4')!(auth)).toBe(true);
    expect(compileFilter('#4')!(issue('acme/api#41', 'x'))).toBe(false);
    expect(compileFilter('Acme/API#4')!(auth)).toBe(true);
    expect(compileFilter('acme/api#4')!(issue('acme/web#4', 'x'))).toBe(false);
    expect(compileFilter('api#4')!(auth)).toBe(true);
    expect(compileFilter('api#4')!(issue('acme/web#4', 'x'))).toBe(false);
  });

  it('matches a repository fragment through the key', () => {
    expect(compileFilter('acme/web')!(login)).toBe(true);
    expect(compileFilter('acme/web')!(auth)).toBe(false);
  });

  it('filters by status, with aliases', () => {
    expect(compileFilter('status:ready')!(schema)).toBe(true);
    expect(compileFilter('status:ready')!(auth)).toBe(false);
    expect(compileFilter('status:cycle')!(other)).toBe(true);
    expect(compileFilter('status:unschedulable')!(other)).toBe(true);
    expect(compileFilter('is:blocked')!(auth)).toBe(true);
    expect(compileFilter('status:external')!(issue('x/y#1', 't', [], { external: true }))).toBe(
      true,
    );
  });

  it('separates claimed work from ready work without hiding dependency problems', () => {
    const claimed = issue('acme/api#5', 'Claimed work', ['AGENT:CLAIMED'], { status: 'ready' });
    expect(compileFilter('status:ready')!(claimed)).toBe(false);
    expect(compileFilter('status:in-progress')!(claimed)).toBe(true);
    expect(compileFilter('is:in-progress')!(claimed)).toBe(true);
    expect(compileFilter('-status:in-progress')!(claimed)).toBe(false);
    expect(compileFilter('status:ready,in-progress')!(claimed)).toBe(true);
    expect(compileFilter('status:in-progress')!(schema)).toBe(false);
    for (const labels of [[], ['agent:claimed-later'], ['claimed']]) {
      const unclaimed = { ...claimed, labels, assignees: ['alice'] };
      expect(compileFilter('status:ready')!(unclaimed)).toBe(true);
      expect(compileFilter('status:in-progress')!(unclaimed)).toBe(false);
    }
    for (const status of ['blocked', 'in-cycle', 'blocked-by-cycle'] as const) {
      const blocked = { ...claimed, status };
      expect(compileFilter(`status:${status}`)!(blocked)).toBe(true);
      expect(compileFilter('status:ready')!(blocked)).toBe(false);
      expect(compileFilter('status:in-progress')!(blocked)).toBe(false);
    }
    expect(claimed.status).toBe('ready');
  });

  it('accepts slash-form workflow labels and filters specs and maps', () => {
    const claimed = issue('acme/api#5', 'Slash claimed', ['agent/claimed'], { status: 'ready' });
    expect(compileFilter('status:in-progress')!(claimed)).toBe(true);
    expect(compileFilter('status:ready')!(claimed)).toBe(false);

    const spec = issue('acme/api#6', 'Spec', ['spec/decomposed'], { status: 'ready' });
    const map = issue('acme/api#7', 'Map', ['wayfinder/map'], { status: 'ready' });
    expect(compileFilter('status:spec')!(spec)).toBe(true);
    expect(compileFilter('is:spec')!(spec)).toBe(true);
    expect(compileFilter('status:ready')!(spec)).toBe(false);
    expect(compileFilter('status:map')!(map)).toBe(true);
    expect(compileFilter('is:map')!(map)).toBe(true);
    expect(compileFilter('status:ready')!(map)).toBe(false);

    const blockedSpec = { ...spec, status: 'blocked' as const };
    expect(compileFilter('status:blocked')!(blockedSpec)).toBe(true);
    expect(compileFilter('status:spec')!(blockedSpec)).toBe(false);
  });

  it('treats values of one field as alternatives and different fields as AND', () => {
    const f = compileFilter('status:ready,cycle')!;
    expect(f(schema)).toBe(true);
    expect(f(other)).toBe(true);
    expect(f(auth)).toBe(false);
    expect(compileFilter('status:ready status:cycle')!(other)).toBe(true);
    expect(compileFilter('priority:P0 @erin')!(login)).toBe(true);
    expect(compileFilter('priority:P0 @erin')!(auth)).toBe(false);
  });

  it('filters by assignee, milestone, repo, priority and critical path', () => {
    expect(compileFilter('assignee:BOB')!(auth)).toBe(true);
    expect(compileFilter('@bob')!(login)).toBe(false);
    expect(compileFilter('milestone:"v0.2 core api"')!(login)).toBe(true);
    expect(compileFilter('repo:web')!(login)).toBe(true);
    expect(compileFilter('repo:acme/api')!(login)).toBe(false);
    expect(compileFilter('priority:none')!(schema)).toBe(true);
    expect(compileFilter('priority:p1')!(other)).toBe(true);
    expect(compileFilter('is:critical')!(auth)).toBe(true);
    expect(compileFilter('is:critical')!(login)).toBe(false);
  });

  it('matches a parent by number, in every form, together with its direct children', () => {
    const spec = issue('acme/web#71', 'Router-first power plane spec', [], { status: 'ready' });
    const child = issue('acme/web#72', 'Power plane implementation', [], {
      parents: ['acme/web#71'],
    });
    const grandchild = issue('acme/web#73', 'Grandchild', [], { parents: ['acme/web#72'] });
    for (const q of ['parent:#71', 'parent:71', 'parent:acme/web#71']) {
      expect(compileFilter(q)!(spec)).toBe(true);
      expect(compileFilter(q)!(child)).toBe(true);
      expect(compileFilter(q)!(grandchild)).toBe(false);
    }
    expect(compileFilter('parent:api#71')!(child)).toBe(false);
    expect(compileFilter('parent:71')!(issue('acme/api#71', 'Same number elsewhere'))).toBe(true);
  });

  it('excludes parents, lists alternatives and combines with other fields', () => {
    const child = issue('acme/web#72', 'Child', [], { parents: ['acme/web#71'] });
    const ready = issue('acme/web#74', 'Ready child', [], {
      status: 'ready',
      parents: ['acme/web#71'],
    });
    expect(compileFilter('-parent:71')!(child)).toBe(false);
    expect(compileFilter('-parent:71')!(issue('acme/web#75', 'Lone'))).toBe(true);
    expect(compileFilter('parent:70,71')!(child)).toBe(true);
    expect(compileFilter('parent:71 status:ready')!(child)).toBe(false);
    expect(compileFilter('parent:71 status:ready')!(ready)).toBe(true);
  });

  it('supports no: and exclusions', () => {
    expect(compileFilter('no:assignee')!(other)).toBe(true);
    expect(compileFilter('no:assignee')!(auth)).toBe(false);
    expect(compileFilter('no:milestone')!(other)).toBe(true);
    expect(compileFilter('no:label')!(schema)).toBe(true);
    expect(compileFilter('no:priority')!(schema)).toBe(true);
    expect(compileFilter('-label:ui')!(login)).toBe(false);
    expect(compileFilter('-label:ui')!(auth)).toBe(true);
    expect(compileFilter('label:P0 -@x -status:ready,cycle')!(auth)).toBe(true);
  });
});

describe('toggleQualifier', () => {
  it('adds and removes values, keeping other terms', () => {
    let q = toggleQualifier('login', 'status', 'ready');
    expect(q).toBe('login status:ready');
    q = toggleQualifier(q, 'status', 'blocked');
    expect(q).toBe('login status:ready,blocked');
    expect(hasQualifier(q, 'status', 'BLOCKED')).toBe(true);
    q = toggleQualifier(q, 'status', 'ready');
    expect(q).toBe('login status:blocked');
    expect(toggleQualifier(q, 'status', 'blocked')).toBe('login');
  });

  it('merges @mentions into assignee and quotes values with spaces', () => {
    expect(toggleQualifier('@bob x', 'assignee', 'erin')).toBe('x assignee:bob,erin');
    expect(toggleQualifier('', 'milestone', 'v1.0 Launch')).toBe('milestone:"v1.0 Launch"');
    expect(toggleQualifier('milestone:"v1.0 Launch"', 'milestone', 'v1.0 launch')).toBe('');
  });

  it('leaves exclusions of the same field alone', () => {
    expect(toggleQualifier('-label:docs', 'label', 'ui')).toBe('-label:docs label:ui');
  });
});

describe('qualifierCount', () => {
  it('counts included and excluded values', () => {
    expect(qualifierCount('login')).toBe(0);
    expect(qualifierCount('status:ready,blocked @bob -label:docs')).toBe(4);
  });
});
