import type { ProviderKind, Snapshot } from '../../src/core/types.js';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError('Network error: could not reach the execution-view server.', 0);
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
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('The server returned an invalid response.', res.status);
  }
}

export function fetchViews(): Promise<ViewSummary[]> {
  return request<ViewSummary[]>(`${API}/views`);
}

/** Server settings for the UI; `refreshMinutes` 0 means no automatic refresh. */
export function fetchSettings(): Promise<{ refreshMinutes: number }> {
  return request<{ refreshMinutes: number }>(`${API}/settings`);
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
export function fetchSession(): Promise<{ username: string }> {
  return request<{ username: string }>(`${API}/session`);
}

export function exportUrl(viewId: string, format: ExportFormat): string {
  return `${API}/views/${encodeURIComponent(viewId)}/export.${format}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
