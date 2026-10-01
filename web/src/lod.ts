/**
 * Level of detail for the graph: pure helpers, no DOM.
 *
 * Below `COMPACT_BELOW` zoom the cards switch to a compact form (status stripe,
 * key and one line of title) whose text is counter-scaled so that it stays
 * legible on screen. The counter-scaling is quantised into a few zoom buckets:
 * the compact text of every bucket is rendered once, and the view only toggles
 * a class on the root when the bucket changes.
 */

import type { Rect, Size } from './graph-model.js';

/** Zooms strictly below this use the compact cards. */
export const COMPACT_BELOW = 0.75;
/** Wanted on-screen text size (px) of compact cards and wave headers. */
export const TARGET_PX = 12;
/** Font size (SVG units) of the title in the detailed card. */
export const BASE_FONT_PX = 13;
/** Largest counter-scale of the compact text (multiplier of BASE_FONT_PX). */
export const MAX_TEXT_SCALE = 2.5;
/** Upper zoom bounds of the compact buckets; the last one ends at COMPACT_BELOW. */
export const BUCKET_EDGES: readonly number[] = [0.28, 0.4, 0.55, COMPACT_BELOW];
/** Lower bound of the first bucket (the minimum zoom of the graph). */
const LOWEST_ZOOM = 0.2;

export type LodMode = 'detail' | 'compact';

export interface Lod {
  mode: LodMode;
  /** Multiplier of BASE_FONT_PX for compact text; 1 in detail mode. */
  textScale: number;
  /** Compact bucket index (0 = most zoomed out); -1 in detail mode. */
  bucket: number;
}

export const BUCKET_COUNT = BUCKET_EDGES.length;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Text scale for a bucket, computed at the geometric middle of its zoom range. */
export function bucketTextScale(bucket: number): number {
  const hi = BUCKET_EDGES[bucket] ?? COMPACT_BELOW;
  const lo = bucket <= 0 ? LOWEST_ZOOM : (BUCKET_EDGES[bucket - 1] ?? LOWEST_ZOOM);
  const rep = Math.sqrt(lo * hi);
  return clamp(TARGET_PX / (rep * BASE_FONT_PX), 1, MAX_TEXT_SCALE);
}

export function lodFor(zoom: number): Lod {
  if (!(zoom < COMPACT_BELOW)) return { mode: 'detail', textScale: 1, bucket: -1 };
  let bucket = BUCKET_EDGES.findIndex((edge) => zoom < edge);
  if (bucket < 0) bucket = BUCKET_COUNT - 1;
  return { mode: 'compact', textScale: bucketTextScale(bucket), bucket };
}

/** The key line of a compact card is this fraction of the title font size. */
const KEY_RATIO = 0.8;
/** Height of the two compact lines in units of the title font size (key ratio included). */
const BLOCK_FACTOR = 1.12 + 1.02 * KEY_RATIO;
const CARD_PAD = 8;

export interface CompactFonts {
  /** Title font size, SVG units. */
  title: number;
  /** Key font size, SVG units. */
  key: number;
}

/**
 * Font sizes (SVG units) of the compact key and title: the scaled base size,
 * limited so that both lines still fit inside a card of `cardHeight`.
 */
export function compactFonts(textScale: number, cardHeight: number): CompactFonts {
  const wanted = BASE_FONT_PX * clamp(textScale, 1, MAX_TEXT_SCALE);
  const fits = Math.floor((cardHeight - CARD_PAD) / BLOCK_FACTOR);
  const title = Math.min(wanted, Math.max(BASE_FONT_PX, fits));
  return { title, key: Math.round(title * KEY_RATIO * 10) / 10 };
}

/** Baselines (y) of the key line and the title line, the two lines centred in the card. */
export function compactBaselines(
  fonts: CompactFonts,
  cardHeight: number,
): { key: number; title: number } {
  const block = 1.02 * fonts.key + 1.12 * fonts.title;
  const top = Math.max(2, (cardHeight - block) / 2);
  const key = top + fonts.key * 0.8;
  return { key, title: key + fonts.key * 0.22 + fonts.title * 0.9 };
}

/** Font size (SVG units) of the wave column headers: constant on screen while zooming. */
export function headerFontSize(zoom: number, minPx = 12, maxPx = 24): number {
  const px = clamp(TARGET_PX / Math.max(zoom, 0.01), minPx, maxPx);
  return Math.round(px * 2) / 2;
}

// ---------------------------------------------------------------------------
// Tooltip placement
// ---------------------------------------------------------------------------

export interface TooltipPlacement {
  x: number;
  y: number;
  side: 'below' | 'above';
}

/**
 * Position (top-left, in the coordinates of `bounds`) of a tooltip of size
 * `tip` next to `anchor`. It opens below the anchor, or above when there is no
 * room below and more room above, and is always clamped inside `bounds`.
 */
export function tooltipPosition(
  anchor: Rect,
  tip: Size,
  bounds: Size,
  gap = 8,
  margin = 8,
): TooltipPlacement {
  const maxX = Math.max(margin, bounds.width - tip.width - margin);
  const maxY = Math.max(margin, bounds.height - tip.height - margin);
  const below = anchor.y + anchor.height + gap;
  const above = anchor.y - gap - tip.height;
  const fitsBelow = below + tip.height + margin <= bounds.height;
  const fitsAbove = above >= margin;
  const roomBelow = bounds.height - (anchor.y + anchor.height);
  const side = fitsBelow || (!fitsAbove && roomBelow >= anchor.y) ? 'below' : 'above';
  return {
    x: clamp(anchor.x, margin, maxX),
    y: clamp(side === 'below' ? below : above, margin, maxY),
    side,
  };
}
