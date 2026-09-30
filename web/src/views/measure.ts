/** Text measuring for SVG (which has no automatic ellipsis). Browser only. */

let canvasCtx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

function context(): CanvasRenderingContext2D | null {
  if (canvasCtx === undefined) {
    try {
      canvasCtx = document.createElement('canvas').getContext('2d');
    } catch {
      canvasCtx = null;
    }
  }
  return canvasCtx;
}

export function measureText(text: string, font: string): number {
  const cacheKey = `${font}|${text}`;
  const cached = widthCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const ctx = context();
  let width: number;
  if (ctx) {
    ctx.font = font;
    width = ctx.measureText(text).width;
  } else {
    // Fallback: rough average glyph width.
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
    width = text.length * size * 0.56;
  }
  widthCache.set(cacheKey, width);
  return width;
}

/** Shortens `text` with an ellipsis so it fits in `maxWidth` pixels. */
export function truncateToWidth(text: string, maxWidth: number, font: string): string {
  if (maxWidth <= 0) return '';
  if (measureText(text, font) <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(text.slice(0, mid).trimEnd() + ellipsis, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ellipsis : text.slice(0, lo).trimEnd() + ellipsis;
}

export interface Fonts {
  sans: string;
  mono: string;
}

/** Font families resolved from the CSS custom properties, so canvas matches the stylesheet. */
export function readFonts(): Fonts {
  const style = getComputedStyle(document.documentElement);
  return {
    sans: style.getPropertyValue('--font-sans').trim() || 'sans-serif',
    mono: style.getPropertyValue('--font-mono').trim() || 'monospace',
  };
}
