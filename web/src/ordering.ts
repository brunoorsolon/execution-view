import type { OrderingMode } from '../../src/core/types.js';

/** One-line explanation of the linear order, shown above the Execution order table. */
export function orderingExplanation(mode: OrderingMode): string {
  if (mode === 'waves') {
    return 'Order runs wave by wave; within a wave, by priority and critical path.';
  }
  return (
    'Order favours priority labels and the critical path: an issue from a later wave can come ' +
    'before an earlier-wave issue once its prerequisites are done. Waves show what can run in parallel.'
  );
}
