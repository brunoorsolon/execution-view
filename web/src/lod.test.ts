import { describe, expect, it } from 'vitest';
import {
  BASE_FONT_PX,
  COMPACT_BELOW,
  MAX_TEXT_SCALE,
  TARGET_PX,
  compactTextScale,
  isCompact,
} from './lod.js';

describe('isCompact', () => {
  it('switches strictly below the threshold', () => {
    expect(isCompact(COMPACT_BELOW)).toBe(false);
    expect(isCompact(1)).toBe(false);
    expect(isCompact(COMPACT_BELOW - 0.001)).toBe(true);
  });
});

describe('compactTextScale', () => {
  it('is 1 in detail mode', () => {
    expect(compactTextScale(1)).toBe(1);
    expect(compactTextScale(COMPACT_BELOW)).toBe(1);
  });

  it('keeps the compact title near the target size on screen', () => {
    for (const z of [0.4, 0.5, 0.6, 0.69]) {
      const px = BASE_FONT_PX * compactTextScale(z) * z;
      expect(px).toBeGreaterThan(TARGET_PX * 0.95);
      expect(px).toBeLessThan(TARGET_PX * 1.05);
    }
  });

  it('stays within [1, MAX_TEXT_SCALE] and never grows with zoom', () => {
    let prev = Infinity;
    for (let z = 0.05; z < COMPACT_BELOW; z += 0.01) {
      const s = compactTextScale(z);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(MAX_TEXT_SCALE);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
    expect(compactTextScale(0.1)).toBe(MAX_TEXT_SCALE);
  });
});
