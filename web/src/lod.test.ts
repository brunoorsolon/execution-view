import { describe, expect, it } from 'vitest';
import {
  BASE_FONT_PX,
  BUCKET_COUNT,
  COMPACT_BELOW,
  MAX_TEXT_SCALE,
  TARGET_PX,
  bucketTextScale,
  compactBaselines,
  compactFonts,
  headerFontSize,
  lodFor,
  tooltipPosition,
} from './lod.js';

describe('lodFor', () => {
  it('uses the detailed card at or above the threshold', () => {
    expect(lodFor(COMPACT_BELOW)).toEqual({ mode: 'detail', textScale: 1, bucket: -1 });
    expect(lodFor(1).mode).toBe('detail');
    expect(lodFor(3).textScale).toBe(1);
  });

  it('uses the compact card just below the threshold', () => {
    const lod = lodFor(COMPACT_BELOW - 0.001);
    expect(lod.mode).toBe('compact');
    expect(lod.bucket).toBe(BUCKET_COUNT - 1);
  });

  it('puts zooms into increasing buckets', () => {
    expect(lodFor(0.2).bucket).toBe(0);
    expect(lodFor(0.279).bucket).toBe(0);
    expect(lodFor(0.28).bucket).toBe(1);
    expect(lodFor(0.45).bucket).toBe(2);
    expect(lodFor(0.6).bucket).toBe(3);
  });

  it('keeps the text scale within [1, MAX_TEXT_SCALE] and non-increasing with zoom', () => {
    let prev = Infinity;
    for (let z = 0.2; z < COMPACT_BELOW; z += 0.01) {
      const { textScale } = lodFor(z);
      expect(textScale).toBeGreaterThanOrEqual(1);
      expect(textScale).toBeLessThanOrEqual(MAX_TEXT_SCALE);
      expect(textScale).toBeLessThanOrEqual(prev);
      prev = textScale;
    }
  });

  it('clamps the scale at the maximum when zoomed far out', () => {
    expect(lodFor(0.2).textScale).toBe(MAX_TEXT_SCALE);
    expect(bucketTextScale(0)).toBe(MAX_TEXT_SCALE);
  });

  it('keeps the on-screen size of the text near the target inside a bucket', () => {
    const { textScale } = lodFor(0.6);
    const px = BASE_FONT_PX * textScale * 0.6;
    expect(px).toBeGreaterThan(TARGET_PX * 0.75);
    expect(px).toBeLessThan(TARGET_PX * 1.25);
  });
});

describe('compactFonts', () => {
  it('scales the base size, with a smaller key line', () => {
    const f = compactFonts(1, 64);
    expect(f.title).toBe(BASE_FONT_PX);
    expect(f.key).toBeLessThan(f.title);
    expect(compactFonts(1.5, 64).title).toBeCloseTo(19.5);
  });

  it('never exceeds what fits in the card height', () => {
    expect(compactFonts(MAX_TEXT_SCALE, 64).title).toBe(28);
    expect(compactFonts(MAX_TEXT_SCALE, 30).title).toBe(BASE_FONT_PX);
  });

  it('clamps an out-of-range scale', () => {
    expect(compactFonts(0.1, 64).title).toBe(BASE_FONT_PX);
    expect(compactFonts(50, 64).title).toBe(28);
  });
});

describe('compactBaselines', () => {
  it('keeps both lines inside the card', () => {
    for (const scale of [1, 1.5, 2, MAX_TEXT_SCALE]) {
      const f = compactFonts(scale, 64);
      const { key, title } = compactBaselines(f, 64);
      expect(key - f.key * 0.8).toBeGreaterThanOrEqual(0);
      expect(title + f.title * 0.25).toBeLessThanOrEqual(64);
      expect(title).toBeGreaterThan(key + f.title * 0.5);
    }
  });
});

describe('headerFontSize', () => {
  it('counter-scales the header and clamps it', () => {
    expect(headerFontSize(1)).toBe(12);
    expect(headerFontSize(3)).toBe(12);
    expect(headerFontSize(0.5)).toBe(24);
    expect(headerFontSize(0.2)).toBe(24);
    expect(headerFontSize(0.6)).toBe(20);
  });
});

describe('tooltipPosition', () => {
  const bounds = { width: 800, height: 600 };
  const tip = { width: 280, height: 120 };

  it('opens below the anchor, aligned to its left edge', () => {
    const p = tooltipPosition({ x: 100, y: 100, width: 120, height: 34 }, tip, bounds);
    expect(p).toEqual({ x: 100, y: 142, side: 'below' });
  });

  it('flips above when there is no room below', () => {
    const p = tooltipPosition({ x: 100, y: 500, width: 120, height: 34 }, tip, bounds);
    expect(p.side).toBe('above');
    expect(p.y).toBe(500 - 8 - 120);
  });

  it('clamps horizontally inside the bounds', () => {
    expect(tooltipPosition({ x: 760, y: 100, width: 120, height: 34 }, tip, bounds).x).toBe(512);
    expect(tooltipPosition({ x: -50, y: 100, width: 120, height: 34 }, tip, bounds).x).toBe(8);
  });

  it('stays inside the bounds when the anchor is off screen', () => {
    for (const y of [-300, -20, 0, 300, 590, 900]) {
      const p = tooltipPosition({ x: 300, y, width: 120, height: 34 }, tip, bounds);
      expect(p.y).toBeGreaterThanOrEqual(8);
      expect(p.y + tip.height).toBeLessThanOrEqual(bounds.height - 8);
    }
  });

  it('pins to the margin when the tooltip is larger than the bounds', () => {
    const p = tooltipPosition(
      { x: 10, y: 10, width: 50, height: 30 },
      { width: 900, height: 700 },
      bounds,
    );
    expect(p.x).toBe(8);
    expect(p.y).toBe(8);
  });
});
