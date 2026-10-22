export interface ReleaseRoute {
  repositoryId: string | null;
  jobId: string | null;
  planId: string | null;
}

/** Release selection is independent of the existing Planning URL contract. */
export function parseReleaseHash(hash: string): ReleaseRoute | null {
  const [path, query] = hash.split('?');
  if (path !== '#/releases' && !path?.startsWith('#/releases/')) return null;
  const params = new URLSearchParams(query);
  let repositoryId: string | null = null;
  try {
    repositoryId = decodeURIComponent(path.slice('#/releases/'.length)) || null;
  } catch {
    // Invalid shared links fall back to the repository selector.
  }
  return { repositoryId, jobId: params.get('job'), planId: params.get('plan') };
}

export function releaseHash(route: ReleaseRoute): string {
  const params = new URLSearchParams();
  if (route.jobId !== null) params.set('job', route.jobId);
  if (route.planId !== null) params.set('plan', route.planId);
  const repo = route.repositoryId === null ? '' : `/${encodeURIComponent(route.repositoryId)}`;
  return `#/releases${repo}${params.size === 0 ? '' : `?${params}`}`;
}
