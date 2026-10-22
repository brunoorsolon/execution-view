import type { ResolvedReleaseRepository } from '../config/schema.js';
import { contentHash } from '../core/hash.js';

/** Bind operator policy and push endpoint without storing credential paths or secret bytes. */
export function releaseConfigurationDigest(
  repository: ResolvedReleaseRepository,
  baseUrl: string,
): string {
  return contentHash({ repository, baseUrl });
}
