/**
 * Level of detail for the graph: pure helpers, no DOM.
 *
 * Below `COMPACT_BELOW` zoom the cards switch to a compact form (key and title
 * on a status-tinted card) whose text is counter-scaled so that it stays about
 * TARGET_PX tall on screen. The view only sets a CSS variable and a class, so
 * zooming never rebuilds the cards.
 */

/** Zooms strictly below this use the compact cards. */
export const COMPACT_BELOW = 0.7;
/** Wanted on-screen size (px) of the compact title. */
export const TARGET_PX = 12;
/** Font size (CSS px) of the compact title before scaling. */
export const BASE_FONT_PX = 13;
/** Largest counter-scale of the compact text. */
export const MAX_TEXT_SCALE = 2.4;
/** A wave header narrower than this (on screen) hides its issue count. */
export const NARROW_HEADER_PX = 150;

export function isCompact(zoom: number): boolean {
  return zoom < COMPACT_BELOW;
}

/** Multiplier for the compact card text at `zoom`; 1 in detail mode. */
export function compactTextScale(zoom: number): number {
  if (!isCompact(zoom)) return 1;
  const scale = TARGET_PX / (BASE_FONT_PX * Math.max(zoom, 0.01));
  return Math.round(Math.min(MAX_TEXT_SCALE, Math.max(1, scale)) * 100) / 100;
}
