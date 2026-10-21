/**
 * The SSH endpoint of a release repository: the login, host, effective port and normalized
 * repository path a Git SSH read would reach.
 *
 * Parsing is shared because two independently trusted inputs must name the same endpoint: the
 * configured origin and the `ssh_url` the authenticated forge reports. Comparing raw strings
 * would accept or reject the same endpoint depending on `ssh://` versus scp-style spelling.
 */

export interface SshEndpoint {
  /** SSH login the endpoint names, or null when it leaves the login to the ssh default. */
  user: string | null;
  host: string;
  /** Effective port, "22" when the form does not name one. */
  port: string;
  /** Lowercased `owner/repo` path without a leading slash or trailing `.git`. */
  path: string;
}

function normalizePath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/** Parses both an `ssh://` URL and scp-style `[user@]host:path` spelling. */
export function parseSshEndpoint(raw: string): SshEndpoint | null {
  if (/^ssh:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.hostname === '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      return null;
    }
    return {
      user: url.username === '' ? null : url.username,
      host: url.hostname.toLowerCase(),
      port: url.port === '' ? '22' : url.port,
      path: normalizePath(url.pathname),
    };
  }
  const scp = /^(?:([^@/\s]+)@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/.exec(raw);
  if (scp === null) return null;
  return {
    user: scp[1] ?? null,
    host: scp[2]!.toLowerCase(),
    port: '22',
    path: normalizePath(scp[3]!),
  };
}

/** True only when both inputs name the same login, host, port and repository path. */
export function sameSshEndpoint(a: SshEndpoint, b: SshEndpoint): boolean {
  return a.user === b.user && a.host === b.host && a.port === b.port && a.path === b.path;
}
