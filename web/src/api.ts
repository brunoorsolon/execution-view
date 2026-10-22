import type { ProviderKind, Snapshot } from '../../src/core/types.js';
import type { ReleaseJob, ReleasePlan, ReleasePlanWarning } from '../../src/core/release.js';

/** Shape of one entry of `GET /api/views` (ARCHITECTURE section 13/14). */
export interface ViewSummary {
  id: string;
  title: string;
  source: string;
  kind: ProviderKind;
  repos: string[];
}

export type ExportFormat = 'json' | 'md' | 'mmd' | 'dot';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Relative URLs, so the UI also works when it is served below a sub-path.
const API = 'api';

async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { accept: 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError('Network error: could not reach the Forge Desk server.', 0);
  }
  if (res.status === 401) {
    // The session ended (logout or a server restart): log in again, keeping the shared link.
    location.assign(`login${location.hash}`);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`.trim();
    try {
      const body: unknown = await res.json();
      if (body !== null && typeof body === 'object' && 'error' in body) {
        const err = (body as { error: unknown }).error;
        if (typeof err === 'string' && err !== '') message = err;
      }
    } catch {
      // not JSON: keep the status line
    }
    throw new ApiError(message, res.status);
  }
  return res;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('The server returned an invalid response.', res.status);
  }
}

async function requestText(path: string): Promise<string> {
  return await (await send(path)).text();
}

/** Session-bound CSRF proof for every release mutation; signing in again is required. */
async function csrfHeaders(): Promise<Record<string, string>> {
  const { csrfToken } = await fetchSession();
  if (csrfToken === null) throw new ApiError('Sign in again before changing a release.', 403);
  return { 'x-csrf-token': csrfToken };
}

export function fetchViews(): Promise<ViewSummary[]> {
  return request<ViewSummary[]>(`${API}/views`);
}

export interface Settings {
  /** 0 means no automatic refresh. */
  refreshMinutes: number;
  /** The running server's package version. */
  version: string;
}

let settings: Promise<Settings> | undefined;

/** Server settings for the UI, fetched once per page load. */
export function fetchSettings(): Promise<Settings> {
  return (settings ??= request<Settings>(`${API}/settings`));
}

export function fetchSnapshot(viewId: string): Promise<Snapshot> {
  return request<Snapshot>(`${API}/views/${encodeURIComponent(viewId)}/snapshot`);
}

export function refreshSnapshot(viewId: string): Promise<Snapshot> {
  return request<Snapshot>(`${API}/views/${encodeURIComponent(viewId)}/refresh`, {
    method: 'POST',
  });
}

/** The signed-in user; fails with 404 when the server has no login. */
export function fetchSession(): Promise<{ username: string; csrfToken: string | null }> {
  return request(`${API}/session`);
}

export interface ReleaseRepository {
  id: string;
  repo: string;
  source: string;
  forge: string;
  capability: 'available' | 'blocked';
  blockers: ReleasePlanWarning[];
}

export function fetchReleaseRepositories(): Promise<ReleaseRepository[]> {
  return request(`${API}/releases/repositories`);
}

export async function prepareRelease(repositoryId: string): Promise<{ jobId: string }> {
  return request(`${API}/releases/repositories/${encodeURIComponent(repositoryId)}/prepare`, {
    method: 'POST',
    headers: await csrfHeaders(),
  });
}

/**
 * Submits the digest of the plan on screen. The server accepts only the stored digest, so a
 * changed or stale plan is rejected instead of publishing something the operator did not see.
 */
export async function publishRelease(planId: string, digest: string): Promise<ReleaseJob> {
  return request(`${API}/releases/plans/${encodeURIComponent(planId)}/publish`, {
    method: 'POST',
    headers: { ...(await csrfHeaders()), 'content-type': 'application/json' },
    body: JSON.stringify({ digest }),
  });
}

/** Starts one read-only remote reconciliation; it never publishes a missing effect. */
export async function reconcileRelease(jobId: string): Promise<ReleaseJob> {
  return request(`${API}/releases/jobs/${encodeURIComponent(jobId)}/reconcile`, {
    method: 'POST',
    headers: await csrfHeaders(),
  });
}

/** The plain-text receipt of one publication, converted to text nodes by the caller. */
export function fetchReleaseReceipt(jobId: string): Promise<string> {
  return requestText(`${API}/releases/jobs/${encodeURIComponent(jobId)}/receipt`);
}

export function fetchReleaseJobs(
  repositoryId: string,
): Promise<{ items: ReleaseJob[]; total: number }> {
  return request(`${API}/releases/repositories/${encodeURIComponent(repositoryId)}/jobs?limit=25`);
}

export function fetchReleaseJob(jobId: string): Promise<ReleaseJob> {
  return request(`${API}/releases/jobs/${encodeURIComponent(jobId)}`);
}

export function fetchReleasePlan(planId: string): Promise<ReleasePlan> {
  return request(`${API}/releases/plans/${encodeURIComponent(planId)}`);
}

export function exportUrl(viewId: string, format: ExportFormat): string {
  return `${API}/views/${encodeURIComponent(viewId)}/export.${format}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
