import { describe, expect, it } from 'vitest';
import { compareKeys, compareRefs, makeKey, parseKey } from './keys.js';
import type { IssueRef } from './types.js';

describe('makeKey', () => {
  it('builds owner/repo#number', () => {
    expect(makeKey({ owner: 'acme', repo: 'api' }, 12)).toBe('acme/api#12');
  });

  it('lowercases uppercase input', () => {
    expect(makeKey({ owner: 'Acme', repo: 'API-Server' }, 7)).toBe('acme/api-server#7');
  });
});

describe('parseKey', () => {
  it('parses valid keys', () => {
    expect(parseKey('acme/api#12')).toEqual({ repo: { owner: 'acme', repo: 'api' }, number: 12 });
    expect(parseKey('a/b#1')).toEqual({ repo: { owner: 'a', repo: 'b' }, number: 1 });
  });

  it('accepts dots, dashes and underscores in names', () => {
    expect(parseKey('my-org/my_repo.js#100')).toEqual({
      repo: { owner: 'my-org', repo: 'my_repo.js' },
      number: 100,
    });
  });

  it('round-trips with makeKey', () => {
    const key = 'acme/api#345';
    const { repo, number } = parseKey(key);
    expect(makeKey(repo, number)).toBe(key);
  });

  it.each([
    'foo',
    '',
    'a/b#',
    'a/b#x',
    'a/b#1x',
    'a/b#-1',
    'a/b#1.5',
    'a#1',
    '/b#1',
    'a/#1',
    'a/b/c#1',
    'a b/c#1',
    'a/b#0',
    '#1',
    'a/b#99999999999999999999',
  ])('throws on malformed key %j', (key) => {
    expect(() => parseKey(key)).toThrow();
  });
});

describe('compareKeys', () => {
  it('compares numbers numerically, not lexicographically', () => {
    expect(compareKeys('a/b#2', 'a/b#10')).toBeLessThan(0);
    expect(compareKeys('a/b#10', 'a/b#2')).toBeGreaterThan(0);
  });

  it('compares owner/repo before number', () => {
    expect(compareKeys('a/b#100', 'a/c#1')).toBeLessThan(0);
    expect(compareKeys('b/a#1', 'a/z#999')).toBeGreaterThan(0);
  });

  it('compares owner before repo', () => {
    expect(compareKeys('a/z#1', 'b/a#1')).toBeLessThan(0);
  });

  it('returns 0 for equal keys', () => {
    expect(compareKeys('a/b#5', 'a/b#5')).toBe(0);
  });

  it('uses code-unit order, not locale order', () => {
    // '-' (0x2d) sorts before '.' (0x2e) and both before letters; uppercase would sort before lowercase.
    expect(compareKeys('a/b-c#1', 'a/b.c#1')).toBeLessThan(0);
    expect(compareKeys('a/b_c#1', 'a/bc#1')).toBeLessThan(0);
  });

  it('sorts a list into a stable total order', () => {
    const keys = ['b/a#1', 'a/b#10', 'a/b#2', 'a/a#3', 'a/b#1'];
    expect([...keys].sort(compareKeys)).toEqual(['a/a#3', 'a/b#1', 'a/b#2', 'a/b#10', 'b/a#1']);
    expect([...keys].reverse().sort(compareKeys)).toEqual([...keys].sort(compareKeys));
  });
});

describe('compareRefs', () => {
  const local = (number: number): IssueRef => ({ owner: null, repo: null, number });
  const ref = (owner: string, repo: string, number: number): IssueRef => ({ owner, repo, number });

  it('sorts null owner/repo first', () => {
    expect(compareRefs(local(99), ref('a', 'a', 1))).toBeLessThan(0);
    expect(compareRefs(ref('a', 'a', 1), local(99))).toBeGreaterThan(0);
  });

  it('compares two null refs by number', () => {
    expect(compareRefs(local(2), local(10))).toBeLessThan(0);
    expect(compareRefs(local(10), local(2))).toBeGreaterThan(0);
    expect(compareRefs(local(3), local(3))).toBe(0);
  });

  it('compares owner/repo before number', () => {
    expect(compareRefs(ref('a', 'b', 100), ref('a', 'c', 1))).toBeLessThan(0);
    expect(compareRefs(ref('b', 'a', 1), ref('a', 'z', 9))).toBeGreaterThan(0);
  });

  it('compares numbers numerically within a repo', () => {
    expect(compareRefs(ref('a', 'b', 2), ref('a', 'b', 10))).toBeLessThan(0);
    expect(compareRefs(ref('a', 'b', 4), ref('a', 'b', 4))).toBe(0);
  });

  it('sorts a mixed list', () => {
    const refs = [ref('b', 'a', 1), local(5), ref('a', 'b', 10), local(2), ref('a', 'b', 2)];
    expect([...refs].sort(compareRefs)).toEqual([
      local(2),
      local(5),
      ref('a', 'b', 2),
      ref('a', 'b', 10),
      ref('b', 'a', 1),
    ]);
  });
});
