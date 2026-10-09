import { beforeAll, describe, expect, it } from 'vitest';
import type { IssueKey, LayoutNode, PlanNode, Snapshot } from '../../../src/core/types.js';
import { DEFAULT_ROUTE } from '../route.js';
import { INITIAL_STATE, Store, type AppState } from '../state.js';
import type { Actions, ViewCtx } from './shared.js';

// graph.ts pulls in menu.ts, which listens on `document` at module load, so the
// stub is installed before the view is imported (see beforeAll).
let createGraphView: typeof import('./graph.js').createGraphView;

// ---------------------------------------------------------------------------
// Minimal DOM, enough for the graph view. Node's vitest environment has no
// document; the view needs elements, classes, inline styles and descendant
// lookups, and nothing else.
// ---------------------------------------------------------------------------

class FakeStyle {
  [key: string]: unknown;
  setProperty(name: string, value: string): void {
    this[name] = value;
  }
}

class FakeText {
  constructor(readonly textContent: string) {}
  remove(): void {}
}

type FakeChild = FakeElement | FakeText;

class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly children: FakeChild[] = [];
  readonly style = new FakeStyle();
  hidden = false;
  clientWidth = 1024;
  clientHeight = 768;
  private classes = new Set<string>();
  private parent: FakeElement | null = null;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  readonly classList = {
    add: (...cs: string[]): void => cs.forEach((c) => this.classes.add(c)),
    remove: (...cs: string[]): void => cs.forEach((c) => this.classes.delete(c)),
    toggle: (c: string, on?: boolean): boolean => {
      const value = on ?? !this.classes.has(c);
      if (value) this.classes.add(c);
      else this.classes.delete(c);
      return value;
    },
    contains: (c: string): boolean => this.classes.has(c),
  };

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === 'class') this.classes = new Set(value.split(' ').filter((c) => c !== ''));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  append(...nodes: FakeChild[]): void {
    for (const n of nodes) {
      if (n instanceof FakeElement) {
        n.remove();
        n.parent = this;
      }
      this.children.push(n);
    }
  }
  removeChild(node: FakeChild): void {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    if (node instanceof FakeElement) node.parent = null;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  get firstChild(): FakeChild | null {
    return this.children[0] ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const cls = selector.slice(1);
    return this.children.flatMap((c) =>
      c instanceof FakeElement
        ? c.classes.has(cls)
          ? [c, ...c.querySelectorAll(selector)]
          : c.querySelectorAll(selector)
        : [],
    );
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  scrollIntoView(): void {}
}

beforeAll(async () => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(text),
    addEventListener: () => undefined,
  };
  (globalThis as { window?: unknown }).window = {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
  };
  ({ createGraphView } = await import('./graph.js'));
});

// ---------------------------------------------------------------------------
// Fixture: wave 0 holds #1 and #2, wave 1 holds #3. #2 is the most depended on.
// ---------------------------------------------------------------------------

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

const nodes = [
  node('o/r#1', { wave: 0, order: 1, blocks: ['o/r#9'] }),
  node('o/r#2', { wave: 0, order: 0, blocks: ['o/r#8', 'o/r#9'] }),
  node('o/r#3', { wave: 1, order: 2 }),
];

// The server's rows put #2 above #1, so a wave stacked by issue number differs
// from one stacked by execution order.
const layout: LayoutNode[] = [
  { key: 'o/r#1', x: 0, y: 0, width: 1, height: 1, layer: 0, row: 1 },
  { key: 'o/r#2', x: 0, y: 0, width: 1, height: 1, layer: 0, row: 0 },
  { key: 'o/r#3', x: 0, y: 0, width: 1, height: 1, layer: 1, row: 0 },
];

const snapshot = {
  viewId: 'v',
  title: 'V',
  fetchedAt: '2026-01-01T00:00:00Z',
  contentHash: 'h'.repeat(64),
  priorityLabels: [],
  orderingMode: 'priority',
  plan: {
    viewId: 'v',
    nodes,
    edges: [],
    order: ['o/r#2', 'o/r#1', 'o/r#3'],
    waves: [['o/r#2', 'o/r#1'], ['o/r#3']],
    cycles: [],
    unschedulable: [],
    criticalPath: [],
    warnings: [],
    stats: { total: 3, ready: 3, blocked: 0, unschedulable: 0, external: 0, edges: 0, waves: 2 },
  },
  layout: { width: 0, height: 0, nodes: layout, edges: [] },
} as unknown as Snapshot;

function state(sort: AppState['route']['sort']): AppState {
  return {
    ...INITIAL_STATE,
    views: [{ id: 'v', title: 'V', source: 's', kind: 'fixture', repos: ['o/r'] }],
    route: { ...DEFAULT_ROUTE, tab: 'graph', viewId: 'v', sort },
    status: 'ready',
    loadedViewId: 'v',
    snapshot,
  };
}

function view(): { el: FakeElement; update: (s: AppState) => void } {
  const ctx: ViewCtx = { store: new Store(state('number')), actions: {} as Actions };
  const graph = createGraphView(ctx);
  return {
    el: graph.el as unknown as FakeElement,
    update: (s) => graph.update(s, s),
  };
}

function headers(el: FakeElement): { transform: unknown; width: unknown }[] {
  return el
    .querySelectorAll('.col-head')
    .map((h) => ({ transform: h.style.transform ?? '', width: h.style.width ?? '' }));
}

function cardRows(el: FakeElement): Record<string, unknown> {
  return Object.fromEntries(
    el.querySelectorAll('.card').map((c) => [c.getAttribute('data-key') ?? '', c.style.transform]),
  );
}

describe('createGraphView', () => {
  it('stacks a wave column in the chosen order and keeps the wave headers aligned', () => {
    const g = view();
    // The default order is the issue number, so #1 sits above #2 even though the
    // server's rows are the other way around.
    g.update(state('number'));
    const before = headers(g.el);
    expect(before).toEqual([
      { transform: 'translateX(218px)', width: '256px' },
      { transform: 'translateX(546px)', width: '256px' },
    ]);
    expect(cardRows(g.el)).toEqual({
      'o/r#1': 'translate(20px, 20px)',
      'o/r#2': 'translate(20px, 160px)',
      'o/r#3': 'translate(348px, 20px)',
    });

    // The execution order puts the server's rows back.
    g.update(state('execution'));
    expect(cardRows(g.el)).toEqual({
      'o/r#1': 'translate(20px, 160px)',
      'o/r#2': 'translate(20px, 20px)',
      'o/r#3': 'translate(348px, 20px)',
    });
    // relayout() rebuilds the sticky headers, which carry the pan and zoom.
    expect(headers(g.el)).toEqual(before);

    // A key sort puts the most depended-on issue first.
    g.update(state('dependents'));
    expect(cardRows(g.el)).toEqual({
      'o/r#1': 'translate(20px, 160px)',
      'o/r#2': 'translate(20px, 20px)',
      'o/r#3': 'translate(348px, 20px)',
    });
    expect(headers(g.el)).toEqual(before);
  });
});
