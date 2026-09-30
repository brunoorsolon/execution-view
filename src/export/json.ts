import type { Snapshot } from '../core/types.js';

export function toJson(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, null, 2) + '\n';
}
