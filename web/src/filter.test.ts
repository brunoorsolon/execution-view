import { describe, expect, it } from 'vitest';
import { compileFilter, parseQuery, type FilterTarget } from './filter.js';

const issue = (key: string, title: string, labels: string[] = []): FilterTarget => ({
  key,
  number: Number(key.slice(key.indexOf('#') + 1)),
  title,
  labels,
});

const login = issue('acme/web#3', 'Login page', ['P0', 'ui']);
const auth = issue('acme/api#4', 'Implement authentication with JWT', ['P0', 'security']);
const other = issue('acme/api#13', 'Job dashboard', ['P1']);

describe('parseQuery', () => {
  it('parses each term kind', () => {
    expect(parseQuery('label:P1 #12 acme/api#4 login')).toEqual([
      { kind: 'label', value: 'p1' },
      { kind: 'number', value: 12 },
      { kind: 'key', value: 'acme/api#4' },
      { kind: 'text', value: 'login' },
    ]);
  });
  it('supports quoted label values and ignores empty ones', () => {
    expect(parseQuery('label:"good first issue"')).toEqual([
      { kind: 'label', value: 'good first issue' },
    ]);
    expect(parseQuery('label: ')).toEqual([]);
    expect(parseQuery('   ')).toEqual([]);
  });
});

describe('compileFilter', () => {
  it('is null for an empty query', () => {
    expect(compileFilter('')).toBeNull();
    expect(compileFilter('  ')).toBeNull();
    expect(compileFilter('label:')).toBeNull();
  });

  it('matches the title substring, case-insensitively', () => {
    const f = compileFilter('LOGIN')!;
    expect(f(login)).toBe(true);
    expect(f(auth)).toBe(false);
    expect(compileFilter('auth')!(auth)).toBe(true);
  });

  it('matches several words in any order (AND)', () => {
    const f = compileFilter('jwt implement')!;
    expect(f(auth)).toBe(true);
    expect(f(login)).toBe(false);
  });

  it('matches labels exactly and case-insensitively', () => {
    const f = compileFilter('label:p0')!;
    expect(f(login)).toBe(true);
    expect(f(auth)).toBe(true);
    expect(f(other)).toBe(false);
    expect(compileFilter('label:P')!(login)).toBe(false);
    expect(compileFilter('LABEL:UI')!(login)).toBe(true);
  });

  it('matches #N by issue number, in any repository', () => {
    const f = compileFilter('#4')!;
    expect(f(auth)).toBe(true);
    expect(f(issue('acme/web#4', 'x'))).toBe(true);
    expect(f(other)).toBe(false);
    expect(f(issue('acme/api#41', 'x'))).toBe(false);
  });

  it('matches owner/repo#N exactly, case-insensitively', () => {
    const f = compileFilter('Acme/API#4')!;
    expect(f(auth)).toBe(true);
    expect(f(issue('acme/web#4', 'x'))).toBe(false);
  });

  it('matches a repository fragment through the key', () => {
    const f = compileFilter('acme/web')!;
    expect(f(login)).toBe(true);
    expect(f(auth)).toBe(false);
  });

  it('combines term kinds with AND', () => {
    const f = compileFilter('label:P0 auth')!;
    expect(f(auth)).toBe(true);
    expect(f(login)).toBe(false);
  });
});
