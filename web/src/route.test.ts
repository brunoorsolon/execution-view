import { describe, expect, it } from 'vitest';
import { parseHash, serializeHash, type Route } from './route.js';

describe('parseHash', () => {
  it('parses view, tab and query', () => {
    expect(parseHash('#/view/demo/order?q=label%3AP1%20login')).toEqual({
      viewId: 'demo',
      tab: 'order',
      q: 'label:P1 login',
    });
  });

  it('defaults the tab to graph and tolerates a missing "#"', () => {
    expect(parseHash('/view/demo')).toEqual({ viewId: 'demo', tab: 'graph', q: '' });
    expect(parseHash('#/view/demo/nonsense')).toEqual({ viewId: 'demo', tab: 'graph', q: '' });
  });

  it('gives the default route for empty or unknown hashes', () => {
    const empty = { viewId: null, tab: 'graph', q: '' };
    expect(parseHash('')).toEqual(empty);
    expect(parseHash('#')).toEqual(empty);
    expect(parseHash('#/')).toEqual(empty);
    expect(parseHash('#/something/else')).toEqual(empty);
  });

  it('keeps the query even when no view is given', () => {
    expect(parseHash('#/?q=abc')).toEqual({ viewId: null, tab: 'graph', q: 'abc' });
  });

  it('decodes ids and survives malformed escapes', () => {
    expect(parseHash('#/view/my%20view/problems').viewId).toBe('my view');
    expect(parseHash('#/view/%E0%A4%A/problems').viewId).toBe('%E0%A4%A');
  });
});

describe('serializeHash', () => {
  it('serializes view, tab and query', () => {
    expect(serializeHash({ viewId: 'demo', tab: 'problems', q: '' })).toBe('#/view/demo/problems');
    expect(serializeHash({ viewId: 'demo', tab: 'graph', q: 'label:P1 #3' })).toBe(
      '#/view/demo/graph?q=label%3AP1%20%233',
    );
    expect(serializeHash({ viewId: null, tab: 'graph', q: '' })).toBe('#/');
  });

  it('round-trips with parseHash', () => {
    const routes: Route[] = [
      { viewId: 'demo', tab: 'order', q: 'acme/api#4' },
      { viewId: 'a b/c', tab: 'graph', q: 'c++ "quoted" & more' },
      { viewId: 'x', tab: 'problems', q: '' },
      { viewId: null, tab: 'graph', q: 'only-query' },
      { viewId: 'demo', tab: 'graph', q: 'parent:#71 label:P0' },
    ];
    for (const r of routes) expect(parseHash(serializeHash(r))).toEqual(r);
  });
});
