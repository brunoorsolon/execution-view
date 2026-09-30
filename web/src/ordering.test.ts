import { describe, expect, it } from 'vitest';
import { orderingExplanation } from './ordering.js';

describe('orderingExplanation', () => {
  it('explains that priority mode can interleave waves', () => {
    const text = orderingExplanation('priority');
    expect(text).toContain('priority labels and the critical path');
    expect(text).toContain('later wave can come before an earlier-wave issue');
    expect(text).toContain('Waves show what can run in parallel.');
  });

  it('explains wave-by-wave order', () => {
    expect(orderingExplanation('waves')).toBe(
      'Order runs wave by wave; within a wave, by priority and critical path.',
    );
  });

  it('gives different text for each mode', () => {
    expect(orderingExplanation('priority')).not.toBe(orderingExplanation('waves'));
  });
});
