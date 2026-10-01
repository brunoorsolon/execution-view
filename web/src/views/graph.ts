import type { IssueKey, LayoutNode, PlanNode, Snapshot } from '../../../src/core/types.js';
import { append, clear, h, icon, ICONS, svg } from '../dom.js';
import { displayKey, shortKey, statusLabel } from '../format.js';
import { priorityName } from '../priority.js';
import {
  edgePath,
  computeHighlight,
  edgeId,
  ensureVisible,
  fitTransform,
  IDENTITY,
  panBy,
  transformAttr,
  wheelZoomFactor,
  zoomAt,
  type Highlight,
  type Transform,
} from '../graph-model.js';
import {
  BUCKET_COUNT,
  bucketTextScale,
  compactBaselines,
  compactFonts,
  headerFontSize,
  lodFor,
  tooltipPosition,
  type Lod,
} from '../lod.js';
import type { AppState } from '../state.js';
import { effectiveViewId, type SnapshotIndex } from '../state.js';
import { measureText, readFonts, truncateToWidth, type Fonts } from './measure.js';
import { createSidePanel } from './side-panel.js';
import {
  filteredOut,
  filterFor,
  getIndex,
  labelChip,
  statusPill,
  type View,
  type ViewCtx,
} from './shared.js';

/** Vertical space above the layout for the wave column headers. */
const HEADER_H = 36;
const DRAG_THRESHOLD = 4;
/** Width taken by the floating side panel (incl. margin), excluded from "visible" area. */
const PANEL_W = 344;
/** Hover time before the node tooltip appears. */
const TOOLTIP_DELAY_MS = 150;

interface Built {
  snapshot: Snapshot;
  index: SnapshotIndex;
  nodeEls: Map<IssueKey, SVGGElement>;
  edgeEls: { id: string; from: IssueKey; to: IssueKey; el: SVGPathElement }[];
  baseEdges: SVGGElement;
  hlEdges: SVGGElement;
  contentW: number;
  contentH: number;
}

export function createGraphView(ctx: ViewCtx): View {
  const pane = h('div', { class: 'graph-pane' });
  const svgEl = svg('svg', { class: 'graph-svg', role: 'img', 'aria-label': 'Dependency graph' });
  const viewport = svg('g', { class: 'viewport' });
  svgEl.append(markerDefs(), viewport);

  const zoomLabel = h('span', { class: 'zoom-label' }, '100%');
  const controls = h(
    'div',
    { class: 'graph-controls' },
    h(
      'button',
      {
        class: 'btn btn-icon',
        type: 'button',
        title: 'Zoom out',
        'aria-label': 'Zoom out',
        onclick: () => zoomBy(1 / 1.25),
      },
      icon(ICONS.minus),
    ),
    zoomLabel,
    h(
      'button',
      {
        class: 'btn btn-icon',
        type: 'button',
        title: 'Zoom in',
        'aria-label': 'Zoom in',
        onclick: () => zoomBy(1.25),
      },
      icon(ICONS.plus),
    ),
    h(
      'button',
      { class: 'btn btn-fit', type: 'button', title: 'Fit graph to view', onclick: () => fit() },
      icon(ICONS.fit),
      'Fit',
    ),
  );
  const legend = h(
    'div',
    { class: 'graph-legend', 'aria-hidden': 'true' },
    legendItem('swatch status-ready', 'Ready'),
    legendItem('swatch status-blocked', 'Blocked'),
    legendItem('swatch status-in-cycle', 'In cycle'),
    legendItem('swatch status-blocked-by-cycle', 'Blocked by cycle'),
    legendItem('swatch external', 'External'),
    legendItem('swatch critical', 'Critical path'),
  );
  const side = createSidePanel(ctx);
  const tooltip = h('div', { class: 'graph-tooltip', role: 'tooltip', hidden: true });
  pane.append(svgEl, legend, controls, tooltip, side.el);

  let built: Built | null = null;
  let transform: Transform = IDENTITY;
  let needsFit = true;
  let lastViewId: string | null = null;
  let visible = false;
  let highlight: Highlight | null = null;
  let highlightKey: IssueKey | null = null;
  let suppressReveal = false;
  let lastSelected: IssueKey | null = null;

  // ------------------------------------------------------------------ transform

  function applyTransform(): void {
    viewport.setAttribute('transform', transformAttr(transform));
    zoomLabel.textContent = `${Math.round(transform.k * 100)}%`;
    applyLod();
    positionTooltip();
  }

  /**
   * Level of detail: only classes and one CSS variable change while zooming
   * (and only when the mode, the compact bucket or the header size changes),
   * the SVG is never rebuilt.
   */
  let lod: Lod | null = null;
  let headFont = 0;
  function applyLod(): void {
    const next = lodFor(transform.k);
    if (lod === null || next.mode !== lod.mode || next.bucket !== lod.bucket) {
      svgEl.classList.toggle('lod-compact', next.mode === 'compact');
      for (let b = 0; b < BUCKET_COUNT; b++) svgEl.classList.toggle(`lod-b${b}`, next.bucket === b);
      lod = next;
    }
    const head = headerFontSize(transform.k);
    if (head !== headFont) {
      headFont = head;
      svgEl.style.setProperty('--head-fs', `${head}px`);
    }
  }

  // ------------------------------------------------------------------ tooltip

  let tooltipKey: IssueKey | null = null;
  let tooltipTimer: number | undefined;

  function hideTooltip(): void {
    window.clearTimeout(tooltipTimer);
    tooltipTimer = undefined;
    tooltipKey = null;
    tooltip.hidden = true;
  }

  function scheduleTooltip(key: IssueKey): void {
    window.clearTimeout(tooltipTimer);
    if (pointer?.panning) return;
    tooltipTimer = window.setTimeout(() => showTooltip(key), TOOLTIP_DELAY_MS);
  }

  function showTooltip(key: IssueKey): void {
    const snapshot = built?.snapshot;
    const node = built?.index.nodes.get(key);
    if (built === null || snapshot === undefined || node === undefined || pointer?.panning) return;
    const prio = priorityName(snapshot, node);
    clear(tooltip);
    append(tooltip, [
      h(
        'div',
        { class: 'tip-head' },
        h('span', { class: 'tip-key' }, displayKey(node.key, true)),
        node.external ? h('span', { class: 'tag tag-external' }, 'external') : null,
      ),
      h('div', { class: 'tip-title' }, node.title),
      h(
        'div',
        { class: 'tip-facts' },
        statusPill(statusLabel(node.status), node.status),
        h('span', null, node.wave === null ? 'Unschedulable' : `Wave ${node.wave + 1}`),
        prio !== null ? h('span', null, `Priority: ${prio}`) : null,
      ),
      node.labels.length > 0
        ? h('div', { class: 'chips' }, ...node.labels.map((l) => labelChip(l)))
        : null,
      node.assignees.length > 0 || node.milestone !== null
        ? h(
            'div',
            { class: 'tip-meta' },
            [node.assignees.map((a) => `@${a}`).join(' '), node.milestone ?? '']
              .filter((t) => t !== '')
              .join('  ·  '),
          )
        : null,
    ]);
    tooltipKey = key;
    tooltip.hidden = false;
    positionTooltip();
  }

  /** Places the tooltip next to its node (not the mouse), inside the pane. */
  function positionTooltip(): void {
    if (tooltipKey === null || built === null) return;
    const ln = built.index.layout.get(tooltipKey);
    if (ln === undefined) return;
    const k = transform.k;
    const anchor = {
      x: transform.x + ln.x * k,
      y: transform.y + (ln.y + HEADER_H) * k,
      width: ln.width * k,
      height: ln.height * k,
    };
    const pos = tooltipPosition(
      anchor,
      { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
      size(),
    );
    tooltip.style.left = `${Math.round(pos.x)}px`;
    tooltip.style.top = `${Math.round(pos.y)}px`;
    tooltip.dataset.side = pos.side;
  }

  function size(): { width: number; height: number } {
    return { width: pane.clientWidth, height: pane.clientHeight };
  }

  function fit(): void {
    if (built === null) return;
    const s = size();
    if (s.width === 0 || s.height === 0) return;
    transform = fitTransform({ width: built.contentW, height: built.contentH }, s);
    applyTransform();
  }

  function zoomBy(factor: number): void {
    const s = size();
    transform = zoomAt(transform, factor, s.width / 2, s.height / 2);
    applyTransform();
  }

  function reveal(key: IssueKey): void {
    if (built === null) return;
    const ln = built.index.layout.get(key);
    const s = size();
    if (ln === undefined || s.width === 0) return;
    const panelOpen = ctx.store.get().selected !== null;
    const region = {
      x: 0,
      y: 0,
      width: Math.max(200, s.width - (panelOpen ? PANEL_W : 0)),
      height: s.height,
    };
    transform = ensureVisible(
      transform,
      { x: ln.x, y: ln.y + HEADER_H, width: ln.width, height: ln.height },
      region,
    );
    applyTransform();
  }

  // -------------------------------------------------------------------- input

  let pointer: {
    id: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    panning: boolean;
  } | null = null;
  let dragged = false;

  svgEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointer = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      panning: false,
    };
    dragged = false;
  });
  svgEl.addEventListener('pointermove', (e) => {
    if (pointer === null || e.pointerId !== pointer.id) return;
    if (!pointer.panning) {
      if (Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY) < DRAG_THRESHOLD)
        return;
      pointer.panning = true;
      dragged = true;
      hideTooltip();
      svgEl.setPointerCapture(e.pointerId);
      svgEl.classList.add('panning');
    }
    transform = panBy(transform, e.clientX - pointer.x, e.clientY - pointer.y);
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    applyTransform();
  });
  const endPointer = (e: PointerEvent): void => {
    if (pointer === null || e.pointerId !== pointer.id) return;
    if (pointer.panning && svgEl.hasPointerCapture(e.pointerId))
      svgEl.releasePointerCapture(e.pointerId);
    pointer = null;
    svgEl.classList.remove('panning');
  };
  svgEl.addEventListener('pointerleave', hideTooltip);
  svgEl.addEventListener('pointerup', endPointer);
  svgEl.addEventListener('pointercancel', endPointer);

  svgEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = svgEl.getBoundingClientRect();
      transform = zoomAt(
        transform,
        wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey),
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      applyTransform();
    },
    { passive: false },
  );

  // Click on the background clears the selection (a drag does not count).
  svgEl.addEventListener('click', (e) => {
    if (dragged) {
      dragged = false;
      return;
    }
    if (!(e.target as Element).closest('.node')) ctx.actions.select(null);
  });

  new ResizeObserver(() => {
    if (visible && needsFit && built !== null) {
      fit();
      if (pane.clientWidth > 0) needsFit = false;
    }
  }).observe(pane);

  // ------------------------------------------------------------------- build

  function build(snapshot: Snapshot, index: SnapshotIndex): Built {
    hideTooltip();
    clear(viewport);
    const fonts = readFonts();
    const { layout, plan } = snapshot;
    const contentW = layout.width;
    const contentH = layout.height + HEADER_H;

    // Column bands and headers.
    const colsG = svg('g', { class: 'columns' });
    const layerX = new Map<number, { x: number; w: number }>();
    for (const ln of layout.nodes)
      if (!layerX.has(ln.layer)) layerX.set(ln.layer, { x: ln.x, w: ln.width });
    const layers = [...layerX.keys()].sort((a, b) => a - b);
    for (const layer of layers) {
      const { x, w } = layerX.get(layer)!;
      const unsched = layer >= plan.waves.length;
      const count = unsched ? plan.unschedulable.length : (plan.waves[layer]?.length ?? 0);
      colsG.append(
        svg('rect', {
          class: `col-band${unsched ? ' col-unsched' : ''}${layer % 2 === 1 ? ' alt' : ''}`,
          x: x - 12,
          y: 0,
          width: w + 24,
          height: contentH,
        }),
        svg(
          'text',
          { class: `col-head${unsched ? ' col-unsched' : ''}`, x: x, y: 23 },
          svg('tspan', { class: 'col-title' }, unsched ? 'Unschedulable' : `Wave ${layer + 1}`),
          svg('tspan', { class: 'col-count', dx: '0.45em' }, String(count)),
        ),
      );
    }

    // Edges, in two groups so highlighted ones can be raised.
    const baseEdges = svg('g', { class: 'edges' });
    const hlEdges = svg('g', { class: 'edges edges-hl' });
    const edgeEls: Built['edgeEls'] = [];
    layout.edges.forEach((le) => {
      const toUnsched = index.unschedulable.has(le.to);
      const id = edgeId(le.from, le.to);
      const cls = ['edge'];
      if (toUnsched) cls.push('edge-cycle');
      if (index.criticalEdges.has(id)) cls.push('crit');
      const path = svg('path', {
        class: cls.join(' '),
        d: edgePath(le.points),
        'marker-end': 'url(#arrow-default)',
      });
      edgeEls.push({ id, from: le.from, to: le.to, el: path });
      baseEdges.append(path);
    });

    // Nodes.
    const nodesG = svg('g', { class: 'nodes' });
    const nodeEls = new Map<IssueKey, SVGGElement>();
    for (const ln of layout.nodes) {
      const node = index.nodes.get(ln.key);
      if (node === undefined) continue;
      const g = buildNode(ln, node, snapshot, index, fonts);
      nodeEls.set(ln.key, g);
      nodesG.append(g);
    }

    const content = svg('g', { transform: `translate(0 ${HEADER_H})` }, baseEdges, hlEdges, nodesG);
    // Columns are drawn in un-shifted coordinates (they own the header band).
    viewport.append(colsG, content);
    return { snapshot, index, nodeEls, edgeEls, baseEdges, hlEdges, contentW, contentH };
  }

  function buildNode(
    ln: LayoutNode,
    n: PlanNode,
    snapshot: Snapshot,
    index: SnapshotIndex,
    fonts: Fonts,
  ): SVGGElement {
    const w = ln.width;
    const hgt = ln.height;
    const keyFont = `600 12px ${fonts.mono}`;
    const titleFont = `500 13px ${fonts.sans}`;
    const metaFont = `11px ${fonts.sans}`;
    const chipFont = `600 10px ${fonts.sans}`;
    const padL = 14;
    const padR = 10;

    const keyText = displayKey(n.key, index.multiRepo);
    const keyW = measureText(keyText, keyFont);

    // Label chips: priority label first, max 2 + "+k", only what fits next to the key.
    const prio = priorityName(snapshot, n)?.toLowerCase() ?? null;
    const labels = [...n.labels].sort((a, b) => {
      const pa = a.toLowerCase() === prio ? 0 : 1;
      const pb = b.toLowerCase() === prio ? 0 : 1;
      return pa - pb || (a < b ? -1 : a > b ? 1 : 0);
    });
    const avail = w - padL - padR - keyW - 10;
    const chipW = (text: string): number => Math.ceil(measureText(text, chipFont)) + 12;
    let shown = labels.slice(0, 2).map((l) => truncateToWidth(l, 70, chipFont));
    const total = (): number => {
      const rest = labels.length - shown.length;
      const parts = shown.map(chipW);
      if (rest > 0) parts.push(chipW(`+${rest}`));
      return parts.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * 4;
    };
    while (shown.length > 0 && total() > avail) shown = shown.slice(0, -1);
    const chipTexts = [...shown];
    if (labels.length - shown.length > 0 && total() <= avail)
      chipTexts.push(`+${labels.length - shown.length}`);

    const g = svg('g', {
      class: `node status-${n.status}${n.external ? ' external' : ''}`,
      transform: `translate(${ln.x} ${ln.y})`,
      tabindex: 0,
      role: 'button',
      'data-key': n.key,
      'aria-label': `${n.key} ${n.title}`,
    });
    g.append(svg('rect', { class: 'card', width: w, height: hgt, rx: 7 }));
    const r = 7;
    g.append(
      svg('path', {
        class: 'stripe',
        d: `M${r} 0H4V${hgt}H${r}A${r} ${r} 0 0 1 0 ${hgt - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`,
      }),
    );
    // Detailed content. It is hidden (display: none) by `.lod-compact` on the root.
    const detail = svg('g', { class: 'lod-detail' });
    g.append(detail);
    detail.append(svg('text', { class: 'node-key', x: padL, y: 22 }, keyText));

    let cx = w - padR;
    for (let i = chipTexts.length - 1; i >= 0; i--) {
      const text = chipTexts[i]!;
      const cw = chipW(text);
      cx -= cw;
      const isMore =
        text.startsWith('+') && i === chipTexts.length - 1 && labels.length > shown.length;
      detail.append(
        svg(
          'g',
          { class: `chip-g${isMore ? ' chip-more' : ''}`, transform: `translate(${cx} 9)` },
          svg('rect', { width: cw, height: 16, rx: 8 }),
          svg('text', { x: cw / 2, y: 11.5, 'text-anchor': 'middle' }, text),
        ),
      );
      cx -= 4;
    }

    detail.append(
      svg(
        'text',
        { class: 'node-title', x: padL, y: 41 },
        truncateToWidth(n.title, w - padL - padR, titleFont),
      ),
    );

    const meta = [
      n.assignees.length > 0 ? n.assignees.map((a) => `@${a}`).join(' ') : '',
      n.milestone ?? '',
    ]
      .filter((s) => s !== '')
      .join('  ·  ');
    if (meta !== '') {
      detail.append(
        svg(
          'text',
          { class: 'node-meta', x: padL, y: 56 },
          truncateToWidth(meta, w - padL - padR, metaFont),
        ),
      );
    }

    // Compact content: the key and one line of title per zoom bucket, each with
    // a font size that keeps the text legible at that bucket's zoom. The bucket
    // shown is picked by a class on the root.
    for (let b = 0; b < BUCKET_COUNT; b++) {
      const fs = compactFonts(bucketTextScale(b), hgt);
      const y = compactBaselines(fs, hgt);
      const maxW = w - padL - padR;
      g.append(
        svg(
          'g',
          { class: `lod-c lod-b${b}` },
          svg(
            'text',
            { class: 'c-key', x: padL, y: y.key, 'font-size': fs.key },
            truncateToWidth(
              shortKey(n.key, index.multiRepo),
              maxW,
              `600 ${fs.key}px ${fonts.mono}`,
            ),
          ),
          svg(
            'text',
            { class: 'c-title', x: padL, y: y.title, 'font-size': fs.title },
            truncateToWidth(n.title, maxW, `500 ${fs.title}px ${fonts.sans}`),
          ),
        ),
      );
    }

    g.addEventListener('mouseenter', () => scheduleTooltip(n.key));
    g.addEventListener('mouseleave', hideTooltip);
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dragged) {
        dragged = false;
        return;
      }
      suppressReveal = true;
      ctx.actions.select(n.key);
    });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        suppressReveal = true;
        ctx.actions.select(n.key);
      }
    });
    return g;
  }

  // ------------------------------------------------------------- state -> DOM

  function applyState(state: AppState): void {
    if (built === null) return;
    const { index, nodeEls, edgeEls, baseEdges, hlEdges } = built;
    const selected = state.selected;
    if (selected !== highlightKey) {
      highlightKey = selected;
      highlight =
        selected !== null && index.nodes.has(selected)
          ? computeHighlight(index.adjacency, built.snapshot.plan.edges, selected)
          : null;
    }
    const out = filteredOut(state, index);
    const filtering = filterFor(state.route.q) !== null;
    svgEl.classList.toggle('has-selection', highlight !== null);
    svgEl.classList.toggle('has-filter', filtering);

    for (const [key, el] of nodeEls) {
      const isSel = key === selected;
      const up = highlight?.up.has(key) ?? false;
      const down = highlight?.down.has(key) ?? false;
      el.classList.toggle('selected', isSel);
      el.classList.toggle('hl-up', up && !isSel);
      el.classList.toggle('hl-down', down && !isSel);
      el.classList.toggle('dim', highlight !== null && !isSel && !up && !down);
      el.classList.toggle('filtered', out.has(key));
      el.setAttribute('aria-pressed', String(isSel));
    }
    for (const e of edgeEls) {
      const role = highlight?.edges.get(e.id);
      e.el.classList.toggle('edge-up', role === 'up' || role === 'both');
      e.el.classList.toggle('edge-down', role === 'down');
      e.el.classList.toggle('dim', highlight !== null && role === undefined);
      e.el.classList.toggle('filtered', out.has(e.from) || out.has(e.to));
      const marker =
        role === 'up' || role === 'both'
          ? 'up'
          : role === 'down'
            ? 'down'
            : e.el.classList.contains('edge-cycle')
              ? 'cycle'
              : e.el.classList.contains('crit') && highlight === null
                ? 'crit'
                : 'default';
      e.el.setAttribute('marker-end', `url(#arrow-${marker})`);
      const target = role !== undefined ? hlEdges : baseEdges;
      if (e.el.parentNode !== target) target.append(e.el);
    }
    // Keep the stacking order stable inside the base group.
    if (highlight === null) for (const e of edgeEls) baseEdges.append(e.el);
  }

  const update: View['update'] = (state, prev) => {
    const tabVisible = state.route.tab === 'graph';
    const wasVisible = visible;
    visible = tabVisible && state.status !== 'error' && state.snapshot !== null;
    pane.hidden = !tabVisible;

    const viewId = effectiveViewId(state);
    const index = getIndex(state);
    if (state.snapshot !== null && index !== null) {
      if (built === null || built.snapshot !== state.snapshot) {
        if (lastViewId !== viewId) needsFit = true;
        lastViewId = viewId;
        built = build(state.snapshot, index);
        highlightKey = null;
        highlight = null;
        applyTransform();
      }
    } else {
      built = null;
    }
    if (built === null) return;

    applyState(state);
    side.update(state, prev);

    if (visible && needsFit && pane.clientWidth > 0) {
      fit();
      needsFit = false;
    }
    const selChanged = state.selected !== lastSelected;
    lastSelected = state.selected;
    if (visible && state.selected !== null && (selChanged || !wasVisible)) {
      if (suppressReveal) suppressReveal = false;
      else reveal(state.selected);
    } else if (selChanged) {
      suppressReveal = false;
    }
  };

  return { el: pane, update };
}

function legendItem(swatchClass: string, text: string): HTMLElement {
  return h('span', { class: 'legend-item' }, h('span', { class: swatchClass }), text);
}

function markerDefs(): SVGDefsElement {
  const defs = svg('defs');
  for (const kind of ['default', 'cycle', 'crit', 'up', 'down']) {
    defs.append(
      svg(
        'marker',
        {
          id: `arrow-${kind}`,
          viewBox: '0 0 10 10',
          refX: 9,
          refY: 5,
          markerWidth: 8,
          markerHeight: 8,
          markerUnits: 'userSpaceOnUse',
          orient: 'auto',
        },
        svg('path', { d: 'M0 1.5 L9 5 L0 8.5 Z', class: `arrow arrow-${kind}` }),
      ),
    );
  }
  return defs;
}
