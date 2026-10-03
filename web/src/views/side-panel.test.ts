import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IssueKey, PlanNode, Snapshot } from '../../../src/core/types.js';
import { DEFAULT_ROUTE } from '../route.js';
import { INITIAL_STATE, type AppState } from '../state.js';
import { createSidePanel } from './side-panel.js';
import type { ViewCtx } from './shared.js';

// ---------------------------------------------------------------------------
// Minimal DOM, enough for the details panel. Node's vitest environment has no
// document; the panel only needs create/append/attribute/classList/listeners.
// ---------------------------------------------------------------------------

class FakeText {
  constructor(private readonly data: string) {}
  get textContent(): string {
    return this.data;
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly childNodes: (FakeElement | FakeText)[] = [];
  scrollTop = 0;
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly classList = {
    add: (c: string): void => void this.classes.add(c),
    remove: (c: string): void => void this.classes.delete(c),
    contains: (c: string): boolean => this.classes.has(c),
    toggle: (c: string, on?: boolean): boolean => {
      const value = on ?? !this.classes.has(c);
      if (value) this.classes.add(c);
      else this.classes.delete(c);
      return value;
    },
  };
  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn({});
  }
  append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const n of nodes) this.childNodes.push(typeof n === 'string' ? new FakeText(n) : n);
  }
  removeChild(node: FakeElement | FakeText): void {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
  }
  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.childNodes.length = 0;
    if (v !== '') this.childNodes.push(new FakeText(v));
  }
  querySelector(): null {
    return null;
  }
}

beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
  };
});

afterAll(() => {
  delete (globalThis as { document?: unknown }).document;
});

function descendants(el: FakeElement, pred: (e: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  const visit = (node: FakeElement): void => {
    if (pred(node)) found.push(node);
    for (const child of node.childNodes) if (child instanceof FakeElement) visit(child);
  };
  visit(el);
  return found;
}

interface RelSection {
  heading: string;
  keys: string[];
  /** Entries with a click handler, so a test can activate one. */
  entries: FakeElement[];
  empty: boolean;
}

/** The rendered relation sections, keyed by heading text without the count. */
function relations(el: FakeElement): RelSection[] {
  const sections = descendants(
    el,
    (e) => e.getAttribute('class')?.startsWith('rel-section') ?? false,
  );
  return sections.map((section) => {
    const h3 = descendants(section, (e) => e.tagName === 'h3')[0];
    const items = descendants(section, (e) => e.getAttribute('class') === 'rel-item');
    return {
      heading: (h3?.textContent ?? '').replace(/\d+$/, ''),
      keys: items.map(
        (b) => descendants(b, (e) => e.getAttribute('class') === 'card-key')[0]?.textContent ?? '',
      ),
      entries: items,
      empty: descendants(section, (e) => e.getAttribute('class') === 'rel-empty').length > 0,
    };
  });
}

function section(rels: RelSection[], heading: string): RelSection | undefined {
  return rels.find((r) => r.heading === heading);
}

// ---------------------------------------------------------------------------
// Fixture: #2 names #1 as its Parent; #3 has no hierarchy.
// ---------------------------------------------------------------------------

function node(key: string, extra: Partial<PlanNode> = {}): PlanNode {
  return {
    key,
    repo: { owner: 'o', repo: 'r' },
    number: Number(key.split('#')[1]),
    title: key,
    url: `https://x/${key}`,
    labels: [],
    assignees: [],
    milestone: null,
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

const snapshot: Snapshot = {
  viewId: 'v',
  title: 'V',
  fetchedAt: '2026-01-01T00:00:00Z',
  contentHash: 'h'.repeat(64),
  priorityLabels: [],
  orderingMode: 'priority',
  plan: {
    viewId: 'v',
    nodes: [
      node('o/r#1', { title: 'Map', children: ['o/r#2'] }),
      node('o/r#2', { title: 'Child work', parents: ['o/r#1'] }),
      node('o/r#3', { title: 'Standalone' }),
    ],
    edges: [],
    order: ['o/r#1', 'o/r#2', 'o/r#3'],
    waves: [['o/r#1', 'o/r#2', 'o/r#3']],
    cycles: [],
    unschedulable: [],
    criticalPath: [],
    warnings: [],
    stats: { total: 3, ready: 3, blocked: 0, unschedulable: 0, external: 0, edges: 0, waves: 1 },
  },
  layout: { width: 10, height: 10, nodes: [], edges: [] },
};

function stateWith(selected: IssueKey): AppState {
  return { ...INITIAL_STATE, snapshot, selected, route: { ...DEFAULT_ROUTE, tab: 'graph' } };
}

function panelWith(onSelect: (key: IssueKey | null) => void) {
  const ctx = {
    store: {},
    actions: {
      select: onSelect,
      showInGraph() {},
      setTab() {},
      setView() {},
      setQuery() {},
      refresh() {},
      reload() {},
    },
  } as unknown as ViewCtx;
  return createSidePanel(ctx);
}

describe('details panel hierarchy', () => {
  it('shows the parent on a child and the children on a parent', () => {
    const panel = panelWith(() => {});
    const el = panel.el as unknown as FakeElement;

    panel.update(stateWith('o/r#2'), INITIAL_STATE);
    expect(section(relations(el), 'Parent')?.keys).toEqual(['#1']);
    expect(section(relations(el), 'Children')?.keys).toEqual([]);

    panel.update(stateWith('o/r#1'), INITIAL_STATE);
    expect(section(relations(el), 'Children')?.keys).toEqual(['#2']);
    expect(section(relations(el), 'Parent')?.keys).toEqual([]);
  });

  it('selects the related issue when its entry is clicked', () => {
    const selected: (IssueKey | null)[] = [];
    const panel = panelWith((key) => selected.push(key));
    const el = panel.el as unknown as FakeElement;

    panel.update(stateWith('o/r#1'), INITIAL_STATE);
    section(relations(el), 'Children')?.entries[0]?.click();

    panel.update(stateWith('o/r#2'), INITIAL_STATE);
    section(relations(el), 'Parent')?.entries[0]?.click();

    expect(selected).toEqual(['o/r#2', 'o/r#1']);
  });

  it('reads None for an issue with no parent or children', () => {
    const panel = panelWith(() => {});
    const el = panel.el as unknown as FakeElement;
    panel.update(stateWith('o/r#3'), INITIAL_STATE);

    const rels = relations(el);
    expect(section(rels, 'Parent')).toMatchObject({ keys: [], empty: true });
    expect(section(rels, 'Children')).toMatchObject({ keys: [], empty: true });
  });
});
