import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, parseHash, serializeHash, type Route } from './route.js';

describe('parseHash', () => {
  it('parses view, tab and query', () => {
    expect(parseHash('#/view/demo/order?q=label%3AP1%20login')).toEqual({
      viewId: 'demo',
      tab: 'order',
      q: 'label:P1 login',
      sort: 'number',
    });
  });

  it('parses the sort mode, including the server order, and ignores an unknown one', () => {
    expect(parseHash('#/view/demo/graph?sort=dependents').sort).toBe('dependents');
    expect(parseHash('#/view/demo/graph?sort=execution').sort).toBe('execution');
    expect(parseHash('#/view/demo/graph?sort=nonsense').sort).toBe('number');
    expect(parseHash('#/view/demo/graph?sort=').sort).toBe('number');
  });

  it('defaults to the issue-number order', () => {
    expect(DEFAULT_ROUTE.sort).toBe('number');
    expect(parseHash('#/view/demo/graph').sort).toBe('number');
  });

  it('defaults the tab to graph and tolerates a missing "#"', () => {
    expect(parseHash('/view/demo')).toEqual({
      viewId: 'demo',
      tab: 'graph',
      q: '',
      sort: 'number',
    });
    expect(parseHash('#/view/demo/nonsense')).toEqual({
      viewId: 'demo',
      tab: 'graph',
      q: '',
      sort: 'number',
    });
  });

  it('gives the default route for empty or unknown hashes', () => {
    const empty = { viewId: null, tab: 'graph', q: '', sort: 'number' };
    expect(parseHash('')).toEqual(empty);
    expect(parseHash('#')).toEqual(empty);
    expect(parseHash('#/')).toEqual(empty);
    expect(parseHash('#/something/else')).toEqual(empty);
  });

  it('keeps the query even when no view is given', () => {
    expect(parseHash('#/?q=abc')).toEqual({ viewId: null, tab: 'graph', q: 'abc', sort: 'number' });
  });

  it('decodes ids and survives malformed escapes', () => {
    expect(parseHash('#/view/my%20view/problems').viewId).toBe('my view');
    expect(parseHash('#/view/%E0%A4%A/problems').viewId).toBe('%E0%A4%A');
  });
});

describe('serializeHash', () => {
  it('serializes view, tab and query', () => {
    expect(serializeHash({ viewId: 'demo', tab: 'problems', q: '', sort: 'number' })).toBe(
      '#/view/demo/problems',
    );
    expect(serializeHash({ viewId: 'demo', tab: 'graph', q: 'label:P1 #3', sort: 'number' })).toBe(
      '#/view/demo/graph?q=label%3AP1%20%233',
    );
    expect(serializeHash({ viewId: null, tab: 'graph', q: '', sort: 'number' })).toBe('#/');
  });

  it('appends a non-default sort mode to the query string', () => {
    expect(serializeHash({ viewId: 'demo', tab: 'order', q: '', sort: 'updated' })).toBe(
      '#/view/demo/order?sort=updated',
    );
    expect(serializeHash({ viewId: 'demo', tab: 'order', q: 'label:P1', sort: 'prereq' })).toBe(
      '#/view/demo/order?q=label%3AP1&sort=prereq',
    );
    expect(serializeHash({ viewId: 'demo', tab: 'order', q: '', sort: 'execution' })).toBe(
      '#/view/demo/order?sort=execution',
    );
  });

  it('round-trips with parseHash', () => {
    const routes: Route[] = [
      { viewId: 'demo', tab: 'order', q: 'acme/api#4', sort: 'number' },
      { viewId: 'a b/c', tab: 'graph', q: 'c++ "quoted" & more', sort: 'updated' },
      { viewId: 'x', tab: 'problems', q: '', sort: 'execution' },
      { viewId: null, tab: 'graph', q: 'only-query', sort: 'dependents' },
      { viewId: 'demo', tab: 'graph', q: 'parent:#71 label:P0', sort: 'number' },
    ];
    for (const r of routes) expect(parseHash(serializeHash(r))).toEqual(r);
  });
});
