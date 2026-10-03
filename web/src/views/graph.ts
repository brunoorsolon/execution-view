import type { IssueKey, PlanNode, Point, Snapshot } from '../../../src/core/types.js';
import { clear, h, icon, svg } from '../dom.js';
import { displayStatus, shortKey, plural } from '../format.js';
import {
  GEOMETRY,
  computeHighlight,
  edgeId,
  edgePath,
  ensureVisible,
  fitTransform,
  indirectEdges,
  packLayout,
  panBy,
  wheelZoomFactor,
  zoomAt,
  type Highlight,
  type PackedLayout,
  type Transform,
} from '../graph-model.js';
import { NARROW_HEADER_PX, compactTextScale, isCompact } from '../lod.js';
import { priorityName } from '../priority.js';
import type { AppState, SnapshotIndex } from '../state.js';
import { effectiveViewId } from '../state.js';
import {
  avatars,
  getIndex,
  otherLabels,
  priorityTag,
  statusBadges,
  visibleKeys,
  type View,
  type ViewCtx,
} from './shared.js';

const G = GEOMETRY;
/** Height of the sticky wave header strip above the canvas. */
const HEAD_H = 44;
const DRAG_THRESHOLD = 4;
/** Width covered by the details panel (incl. margins) when it is open. */
const PANEL_W = 404;
/** The graph opens at 100%, unless the whole graph fits at this zoom or more. */
const FIT_ON_OPEN = 0.85;
/** Start/end x offset so an edge ends at the card border, not under it. */
const EDGE_INSET = 1;
const MARKERS = ['default', 'crit', 'cyc', 'up', 'down', 'hover', 'indirect'] as const;
type Marker = (typeof MARKERS)[number];

interface EdgeEl {
  from: IssueKey;
  to: IssueKey;
  id: string;
  el: SVGPathElement;
  base: Marker;
  shown: boolean;
}

interface Built {
  snapshot: Snapshot;
  index: SnapshotIndex;
  cards: Map<IssueKey, HTMLElement>;
  edges: EdgeEl[];
}

export interface GraphView extends View {
  /** Fits the whole (filtered) graph in the pane. */
  fit(): void;
}

export function createGraphView(ctx: ViewCtx): GraphView {
  const pane = h('div', { class: 'pane graph-pane' });
  const heads = h('div', { class: 'col-heads', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'stage', role: 'application', 'aria-label': 'Dependency graph' });
  const canvas = h('div', { class: 'canvas' });
  const bands = h('div', { class: 'bands' });
  const edgesSvg = svg('svg', { class: 'edges' });
  const indirectG = svg('g');
  const directG = svg('g');
  edgesSvg.append(markerDefs(), indirectG, directG);
  canvas.append(bands, edgesSvg);
  stage.append(canvas);
  const noMatch = h('div', { class: 'no-match', hidden: true });

  const zoomLabel = h('button', {
    class: 'zoom-label',
    type: 'button',
    title: 'Reset to 100%',
    onclick: () => zoomTo(1),
  });
  const zoomCtl = h(
    'div',
    { class: 'graph-chrome zoom-ctl' },
    h(
      'button',
      {
        class: 'btn btn-ghost btn-icon',
        type: 'button',
        title: 'Zoom out',
        'aria-label': 'Zoom out',
        onclick: () => zoomBy(1 / 1.2),
      },
      icon('minus'),
    ),
    zoomLabel,
    h(
      'button',
      {
        class: 'btn btn-ghost btn-icon',
        type: 'button',
        title: 'Zoom in',
        'aria-label': 'Zoom in',
        onclick: () => zoomBy(1.2),
      },
      icon('plus'),
    ),
    h('span', { class: 'divider' }),
    h(
      'button',
      { class: 'btn btn-ghost', type: 'button', title: 'Fit the graph (F)', onclick: () => fit() },
      icon('fit'),
      'Fit',
    ),
  );
  const legItem = (cls: string, label: string): HTMLElement =>
    h('span', { class: 'li' }, h('span', { class: cls }), label);
  const legend = h(
    'div',
    { class: 'graph-chrome legend', 'aria-hidden': 'true' },
    legItem('sq st-ready', 'Ready'),
    legItem('sq st-in-progress', 'In progress'),
    legItem('sq st-blocked', 'Blocked'),
    legItem('sq st-in-cycle', 'In cycle'),
    legItem('sq st-blocked-by-cycle', 'Blocked by cycle'),
    h('span', { class: 'vr' }),
    legItem('ln ln-crit', 'Critical path'),
    legItem('ln ln-up', 'Prerequisites'),
    legItem('ln ln-down', 'Dependents'),
    legItem('ln ln-indirect', 'Through hidden issues'),
  );
  pane.append(stage, heads, noMatch, legend, zoomCtl);

  let built: Built | null = null;
  let packed: PackedLayout | null = null;
  let packedFor: Set<IssueKey> | null | undefined;
  let indirect: EdgeEl[] = [];
  let headEls: { el: HTMLElement; x: number }[] = [];
  let t: Transform = { x: 16, y: 0, k: 1 };
  let needsOpen = true;
  let lastViewId: string | null = null;
  let visible = false;
  let highlight: Highlight | null = null;
  let highlightKey: IssueKey | null = null;
  let lastSelected: IssueKey | null = null;
  let reflowTimer: number | undefined;

  // ------------------------------------------------------------ transform

  function applyTransform(): void {
    canvas.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
    zoomLabel.textContent = `${Math.round(t.k * 100)}%`;
    const compact = isCompact(t.k);
    pane.classList.toggle('compact', compact);
    pane.style.setProperty('--cs', String(compactTextScale(t.k)));
    for (const { el, x } of headEls) {
      el.style.transform = `translateX(${t.x + (x - 2) * t.k}px)`;
      el.style.width = `${G.cardW * t.k}px`;
      el.classList.toggle('narrow', G.cardW * t.k < NARROW_HEADER_PX);
    }
  }

  function size(): { width: number; height: number } {
    return { width: stage.clientWidth, height: stage.clientHeight };
  }

  function contentSize(): { width: number; height: number } {
    return { width: packed?.width ?? 0, height: packed?.height ?? 0 };
  }

  function fit(): void {
    const s = size();
    if (s.width === 0 || packed === null || packed.width === 0) return;
    t = fitTransform(contentSize(), s, 16);
    t = { ...t, y: 0 };
    applyTransform();
  }

  function zoomBy(factor: number): void {
    const s = size();
    t = zoomAt(t, factor, s.width / 2, s.height / 2);
    applyTransform();
  }

  function zoomTo(k: number): void {
    t = zoomAt(t, k / t.k, 16, 0);
    applyTransform();
  }

  /** Opens at 100% (top-left), or fitted when the whole graph is readable fitted. */
  function openView(): void {
    const s = size();
    const c = contentSize();
    if (s.width === 0 || c.width === 0) return;
    const k = Math.min((s.width - 32) / c.width, (s.height - 16) / c.height);
    if (k >= FIT_ON_OPEN) fit();
    else {
      t = { x: 16, y: 0, k: 1 };
      applyTransform();
    }
    needsOpen = false;
  }

  /** After a filter, brings the content back when it left the visible area. */
  function keepInView(): void {
    const s = size();
    const c = contentSize();
    const right = t.x + c.width * t.k;
    const bottom = t.y + c.height * t.k;
    if (t.x > s.width * 0.6 || right < s.width * 0.2 || t.y > s.height * 0.4 || bottom < 40) {
      t = { ...t, x: 16, y: 0 };
    }
    applyTransform();
  }

  function reveal(key: IssueKey): void {
    const p = packed?.pos.get(key);
    const s = size();
    if (p === undefined || s.width === 0) return;
    const panelOpen = ctx.store.get().selected !== null && s.width > 640;
    const region = {
      x: 0,
      y: 0,
      width: Math.max(200, s.width - (panelOpen ? PANEL_W : 0)),
      height: s.height - 56,
    };
    const next = ensureVisible(t, { x: p.x, y: p.y, width: G.cardW, height: G.cardH }, region);
    if (next === t) return;
    t = next;
    canvas.classList.add('glide');
    applyTransform();
    window.setTimeout(() => canvas.classList.remove('glide'), 360);
  }

  // ---------------------------------------------------------------- input

  let pointer: {
    id: number;
    x: number;
    y: number;
    sx: number;
    sy: number;
    panning: boolean;
  } | null = null;
  let dragged = false;

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointer = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      sx: e.clientX,
      sy: e.clientY,
      panning: false,
    };
    dragged = false;
  });
  stage.addEventListener('pointermove', (e) => {
    if (pointer === null || e.pointerId !== pointer.id) return;
    if (!pointer.panning) {
      if (Math.hypot(e.clientX - pointer.sx, e.clientY - pointer.sy) < DRAG_THRESHOLD) return;
      pointer.panning = true;
      dragged = true;
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('panning');
    }
    t = panBy(t, e.clientX - pointer.x, e.clientY - pointer.y);
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    applyTransform();
  });
  const endPointer = (e: PointerEvent): void => {
    if (pointer === null || e.pointerId !== pointer.id) return;
    if (pointer.panning && stage.hasPointerCapture(e.pointerId))
      stage.releasePointerCapture(e.pointerId);
    pointer = null;
    stage.classList.remove('panning');
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  // Wheel and trackpad scroll pan; Ctrl/Cmd + wheel and pinch (ctrlKey) zoom.
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = stage.getBoundingClientRect();
        t = zoomAt(
          t,
          wheelZoomFactor(e.deltaY, e.deltaMode, true),
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
      } else {
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size().height : 1;
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        t = panBy(t, -dx * unit, -dy * unit);
      }
      applyTransform();
    },
    { passive: false },
  );

  stage.addEventListener('click', (e) => {
    if (dragged) {
      dragged = false;
      return;
    }
    if (!(e.target as Element).closest('.card')) ctx.actions.select(null);
  });

  new ResizeObserver(() => {
    if (visible && needsOpen && built !== null) openView();
    else applyTransform();
  }).observe(stage);

  // ---------------------------------------------------------------- build

  function build(snapshot: Snapshot, index: SnapshotIndex): Built {
    for (const c of canvas.querySelectorAll('.card')) c.remove();
    clear(directG);
    const cards = new Map<IssueKey, HTMLElement>();
    for (const n of snapshot.plan.nodes) {
      const card = buildCard(n, snapshot, index);
      cards.set(n.key, card);
      canvas.append(card);
    }
    const edges: EdgeEl[] = snapshot.plan.edges.map((e) => {
      const id = edgeId(e.from, e.to);
      const cyc =
        index.nodes.get(e.from)?.status === 'in-cycle' &&
        index.nodes.get(e.to)?.status === 'in-cycle';
      const base: Marker = cyc ? 'cyc' : index.criticalEdges.has(id) ? 'crit' : 'default';
      const el = svg('path', {
        class: `edge${base === 'default' ? '' : ` ${base}`}`,
        'marker-end': `url(#arrow-${base})`,
      });
      directG.append(el);
      return { from: e.from, to: e.to, id, el, base, shown: true };
    });
    return { snapshot, index, cards, edges };
  }

  function buildCard(n: PlanNode, snapshot: Snapshot, index: SnapshotIndex): HTMLElement {
    const prio = priorityName(snapshot, n);
    const labels = otherLabels(n, prio);
    const card = h(
      'div',
      {
        class: `card st-${displayStatus(n)}${n.external ? ' external' : ''}`,
        style: `width:${G.cardW}px;height:${G.cardH}px`,
        tabindex: 0,
        role: 'button',
        'data-key': n.key,
        'aria-label': `${n.key}: ${n.title}`,
      },
      h(
        'div',
        { class: 'card-top' },
        h('span', { class: 'card-key' }, shortKey(n.key, index.multiRepo)),
        index.criticalNodes.has(n.key)
          ? h('span', { class: 'card-crit', title: 'On the critical path' }, icon('critical', 13))
          : null,
        n.external ? h('span', { class: 'badge st-external' }, 'External') : null,
        prio !== null ? priorityTag(prio, n.priority) : null,
        h('span', { class: 'rel' }),
      ),
      h('p', { class: 'card-title', title: n.title }, n.title),
      h(
        'div',
        { class: 'card-foot' },
        statusBadges(n),
        h('span', { class: 'labels' }, labels.join(', ')),
        n.assignees.length > 0 ? avatars(n.assignees, 2) : null,
      ),
    );
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dragged) {
        dragged = false;
        return;
      }
      ctx.actions.select(ctx.store.get().selected === n.key ? null : n.key);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        ctx.actions.select(n.key);
      }
    });
    card.addEventListener('mouseenter', () => hoverEdges(n.key, true));
    card.addEventListener('mouseleave', () => hoverEdges(n.key, false));
    return card;
  }

  function hoverEdges(key: IssueKey, on: boolean): void {
    if (ctx.store.get().selected !== null) return;
    for (const e of [...(built?.edges ?? []), ...indirect]) {
      if (!e.shown || (e.from !== key && e.to !== key)) continue;
      e.el.classList.toggle('hover', on);
      e.el.setAttribute('marker-end', `url(#arrow-${on ? 'hover' : e.base})`);
      if (on && e.base !== 'indirect') directG.append(e.el);
    }
  }

  function edgeD(a: Point, b: Point): string {
    return edgePath(
      [
        { x: a.x + G.cardW, y: a.y + G.cardH / 2 },
        { x: b.x - EDGE_INSET, y: b.y + G.cardH / 2 },
      ],
      G.cardH / 2 + G.rowGap / 2,
    );
  }

  /** Places the visible cards, wave headers, bands and edges. */
  function relayout(b: Built, keys: Set<IssueKey> | null): void {
    const { snapshot, index } = b;
    const plan = snapshot.plan;
    packed = packLayout(snapshot.layout.nodes, keys, G);
    canvas.style.width = `${packed.width}px`;
    canvas.style.height = `${packed.height}px`;
    edgesSvg.setAttribute('width', String(packed.width));
    edgesSvg.setAttribute('height', String(packed.height));

    clear(bands);
    clear(heads);
    headEls = [];
    for (const col of packed.columns) {
      const unsched = col.layer >= plan.waves.length;
      bands.append(
        h('div', {
          class: `band${col.layer % 2 === 1 ? ' alt' : ''}${unsched ? ' unsched' : ''}`,
          style: `left:${col.x - 12}px;width:${G.cardW + 24}px;height:${packed.height}px`,
        }),
      );
      const total = unsched ? plan.unschedulable.length : (plan.waves[col.layer]?.length ?? 0);
      const shown = col.keys.length;
      const sub =
        shown < total
          ? `${shown} of ${total}`
          : unsched
            ? `${plural(total, 'issue')} in or behind a cycle`
            : total > 1
              ? `${total} in parallel`
              : '1 issue';
      const el = h(
        'div',
        { class: `col-head${unsched ? ' unsched' : ''}` },
        h('strong', null, unsched ? 'Unschedulable' : `Wave ${col.layer + 1}`),
        h('span', null, sub),
      );
      headEls.push({ el, x: col.x });
      heads.append(el);
    }

    for (const [key, card] of b.cards) {
      const p = packed.pos.get(key);
      card.hidden = p === undefined;
      if (p !== undefined) card.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    for (const e of b.edges) {
      const from = packed.pos.get(e.from);
      const to = packed.pos.get(e.to);
      e.shown = from !== undefined && to !== undefined;
      e.el.style.display = e.shown ? '' : 'none';
      if (from !== undefined && to !== undefined) e.el.setAttribute('d', edgeD(from, to));
    }

    clear(indirectG);
    indirect = [];
    if (keys !== null) {
      for (const e of indirectEdges(index.adjacency.out, keys)) {
        const el = svg('path', {
          class: 'edge indirect',
          d: edgeD(packed.pos.get(e.from)!, packed.pos.get(e.to)!),
          'marker-end': 'url(#arrow-indirect)',
        });
        el.append(
          svg(
            'title',
            null,
            `${shortKey(e.from, index.multiRepo)} to ${shortKey(e.to, index.multiRepo)}, through hidden issues`,
          ),
        );
        indirectG.append(el);
        indirect.push({ ...e, id: `${e.from}~${e.to}`, el, base: 'indirect', shown: true });
      }
    }
    legend.classList.toggle('with-indirect', indirect.length > 0);

    noMatch.hidden = packed.columns.length > 0;
    if (packed.columns.length === 0) {
      clear(noMatch);
      noMatch.append(
        h(
          'div',
          { class: 'box' },
          h('div', { class: 'glyph' }, icon('filter', 20)),
          h('h2', null, 'No issues match this filter'),
          h('p', null, h('code', null, ctx.store.get().route.q.trim())),
          h(
            'button',
            { class: 'btn', type: 'button', onclick: () => ctx.actions.setQuery('') },
            'Clear filter',
          ),
        ),
      );
    }
  }

  // --------------------------------------------------------- state -> DOM

  function applySelection(state: AppState, b: Built): void {
    const selected = state.selected;
    if (selected !== highlightKey) {
      highlightKey = selected;
      highlight =
        selected !== null && b.index.nodes.has(selected)
          ? computeHighlight(b.index.adjacency, b.snapshot.plan.edges, selected)
          : null;
    }
    pane.classList.toggle('has-selection', highlight !== null);
    for (const [key, card] of b.cards) {
      const isSel = key === selected;
      const up = highlight?.up.has(key) ?? false;
      const down = highlight?.down.has(key) ?? false;
      card.classList.toggle('selected', isSel);
      card.classList.toggle('hl-up', up && !isSel);
      card.classList.toggle('hl-down', down && !isSel);
      card.querySelector('.rel')!.textContent = isSel
        ? 'Selected'
        : up
          ? 'Prerequisite'
          : down
            ? 'Dependent'
            : '';
      card.setAttribute('aria-pressed', String(isSel));
    }
    for (const e of [...b.edges, ...indirect]) {
      if (!e.shown) continue;
      let role: 'up' | 'down' | null = null;
      if (highlight !== null && selected !== null) {
        const isUp = highlight.up.has(e.from) && (highlight.up.has(e.to) || e.to === selected);
        const isDown =
          highlight.down.has(e.to) && (highlight.down.has(e.from) || e.from === selected);
        role = isUp ? 'up' : isDown ? 'down' : null;
      }
      e.el.classList.remove('hover');
      e.el.classList.toggle('up', role === 'up');
      e.el.classList.toggle('down', role === 'down');
      e.el.classList.toggle('dim', highlight !== null && role === null);
      const marker: Marker =
        role ?? (highlight !== null && e.base !== 'indirect' ? 'default' : e.base);
      e.el.setAttribute('marker-end', `url(#arrow-${marker})`);
      if (role !== null && e.base !== 'indirect') directG.append(e.el);
    }
    // Keep the stacking order stable when nothing is highlighted.
    if (highlight === null) for (const e of b.edges) directG.append(e.el);
  }

  const update: View['update'] = (state) => {
    const tabVisible = state.route.tab === 'graph';
    const wasVisible = visible;
    pane.hidden = !tabVisible;
    const index = getIndex(state);
    visible = tabVisible && state.snapshot !== null && index !== null;

    const viewId = effectiveViewId(state);
    if (state.snapshot !== null && index !== null) {
      const keys = visibleKeys(state, index);
      const rebuilt = built === null || built.snapshot !== state.snapshot;
      if (rebuilt) {
        if (lastViewId !== viewId) needsOpen = true;
        lastViewId = viewId;
        built = build(state.snapshot, index);
        highlightKey = null;
        highlight = null;
      }
      if (rebuilt || packedFor !== keys) {
        const filterChange = !rebuilt;
        packedFor = keys;
        if (filterChange) {
          pane.classList.add('reflow');
          window.clearTimeout(reflowTimer);
          reflowTimer = window.setTimeout(() => pane.classList.remove('reflow'), 360);
        }
        relayout(built!, keys);
        if (filterChange && visible) keepInView();
      }
    } else {
      built = null;
    }
    if (built === null) return;

    applySelection(state, built);
    if (visible && needsOpen && stage.clientWidth > 0) openView();
    else if (visible && !wasVisible) applyTransform();

    const selChanged = state.selected !== lastSelected;
    lastSelected = state.selected;
    if (visible && state.selected !== null && (selChanged || !wasVisible)) reveal(state.selected);
  };

  return { el: pane, update, fit };
}

function markerDefs(): SVGDefsElement {
  const defs = svg('defs');
  for (const kind of MARKERS) {
    defs.append(
      svg(
        'marker',
        {
          id: `arrow-${kind}`,
          viewBox: '0 0 10 10',
          refX: 9,
          refY: 5,
          markerWidth: 9,
          markerHeight: 9,
          markerUnits: 'userSpaceOnUse',
          orient: 'auto',
        },
        svg('path', { d: 'M1 1.5 L9 5 L1 8.5 Z', class: `arrow arrow-${kind}` }),
      ),
    );
  }
  return defs;
}
