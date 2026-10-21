/**
 * Read-only HTTP client for the release forge.
 *
 * It is deliberately separate from the planning provider client: authenticated release reads must
 * never follow a redirect with the credential attached, never buffer an unbounded response, never
 * retry a request the server may already have acted on, and never leave the configured forge
 * origin. Errors carry a stable blocker code and a message from which the token is removed.
 */

import { sanitizeUrl } from '../providers/http.js';
import { isLoopbackHost } from '../config/schema.js';

/** A blocker code is a stable machine-readable reason a release capability is unavailable. */
export type ReleaseBlockerCode =
  | 'release-disabled'
  | 'unknown-repository'
  | 'shared-planning-token'
  | 'invalid-credential'
  | 'insecure-forge-origin'
  | 'ssh-origin-mismatch'
  | 'unsupported-forge'
  | 'unsupported-version'
  | 'account-mismatch'
  | 'repository-mismatch'
  | 'malformed-response'
  | 'response-too-large'
  | 'redirect-refused'
  | 'unauthenticated'
  | 'http-error'
  | 'network-error'
  | 'invalid-request'
  | 'release-unavailable'
  | 'internal-error';

/** Why a release capability check failed. Safe to log, return to a caller or persist. */
export interface ReleaseBlocker {
  code: ReleaseBlockerCode;
  /** Redacted, bounded English text. Never contains a token, header or response body. */
  message: string;
}

/** The only identity the supported publication target accepts. */
export const SUPPORTED_GITEA_VERSION = '1.26.1';

/** Upper bound for one release-forge response body. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Upper bound for one release-forge request, including the body read. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export type ReleaseForgeFetch = (input: string, init: RequestInit) => Promise<Response>;

export class ReleaseForgeError extends Error {
  readonly code: ReleaseBlockerCode;
  /** HTTP status, or 0 for a network, redirect or protocol failure. */
  readonly status: number;

  constructor(code: ReleaseBlockerCode, message: string, status = 0) {
    super(message);
    this.name = 'ReleaseForgeError';
    this.code = code;
    this.status = status;
  }
}

export interface ReleaseForgeClientOptions {
  /** Forge root from the release repository's Gitea source, e.g. https://gitea.example.com (`/gitea` subpaths work). */
  baseUrl: string;
  /** Dedicated release token from the loaded release runtime. Never a planning token, never empty. */
  token: string;
  fetch?: ReleaseForgeFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ReleaseForgeClient {
  /** GETs `<baseUrl>/api/v1<path>` with the release token. Only a path starting with "/" is accepted. */
  getJson<T>(path: string): Promise<T>;
}

/** Control characters would let a value forge a log line or a header. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Removes every secret from outward text. Callers must route server-derived text through this. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('***');
  }
  return out;
}

/**
 * A credential value from the runtime: no surrounding whitespace, no control characters. Never
 * falls back to an anonymous request, which could not prove which account would publish.
 */
function requireToken(raw: string): string {
  const token = raw.trim();
  if (token === '') {
    throw new ReleaseForgeError(
      'invalid-credential',
      'no dedicated release token is configured; anonymous access cannot verify release identity',
    );
  }
  if (CONTROL_CHARS.test(token)) {
    throw new ReleaseForgeError(
      'invalid-credential',
      'the dedicated release token contains control characters',
    );
  }
  return token;
}

/** TLS everywhere except an isolated loopback test deployment; no credentials in the URL. */
function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ReleaseForgeError(
      'insecure-forge-origin',
      `release forge origin "${raw}" is not an absolute URL`,
    );
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ReleaseForgeError(
      'insecure-forge-origin',
      `release forge origin ${sanitizeUrl(raw)} must not contain credentials, a query or a fragment`,
    );
  }
  const https = url.protocol === 'https:';
  const loopbackHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (!https && !loopbackHttp) {
    throw new ReleaseForgeError(
      'insecure-forge-origin',
      `release forge origin ${sanitizeUrl(raw)} must use https (plain http is allowed only for an isolated loopback test deployment)`,
    );
  }
  return url.toString().replace(/\/+$/, '');
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // A body that is already closed or unreadable needs no cleanup.
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** Reads a body with a byte bound, so a hostile or broken forge cannot exhaust memory. */
async function readBoundedText(res: Response, describe: string, maxBytes: number): Promise<string> {
  const declared = parseContentLength(res.headers.get('content-length'));
  if (declared !== null && declared > maxBytes) {
    await discardBody(res);
    throw new ReleaseForgeError(
      'response-too-large',
      `${describe} declared ${declared} bytes, above the ${maxBytes}-byte release response bound`,
      res.status,
    );
  }
  const body = res.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The bound is already exceeded; a failed cancel adds nothing.
      }
      throw new ReleaseForgeError(
        'response-too-large',
        `${describe} exceeded the ${maxBytes}-byte release response bound`,
        res.status,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Reads the body, turning a stream failure into a redacted release error. A body read can reject
 * after the response headers arrived, and that rejection may name the credential.
 */
async function readResponseText(
  res: Response,
  describe: string,
  maxBytes: number,
  redact: (text: string) => string,
): Promise<string> {
  try {
    return await readBoundedText(res, describe, maxBytes);
  } catch (err) {
    if (err instanceof ReleaseForgeError) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    throw new ReleaseForgeError(
      'network-error',
      redact(`${describe} failed while reading the response: ${cause}`),
      res.status,
    );
  }
}

export function createReleaseForgeClient(opts: ReleaseForgeClientOptions): ReleaseForgeClient {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const token = requireToken(opts.token);
  const redact = (text: string): string => redactSecrets(text, [token]);
  const fetchFn: ReleaseForgeFetch = opts.fetch ?? (async (input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const apiBase = `${baseUrl}/api/v1`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `token ${token}`,
    'User-Agent': 'forge-desk',
  };

  async function getJson<T>(path: string): Promise<T> {
    // Callers pass fixed API paths. An absolute URL would allow a redirect or an API-returned
    // link to move the credential to another host, so only a rooted path is accepted.
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new ReleaseForgeError(
        'invalid-request',
        `release reads accept only an absolute API path, got "${redact(sanitizeUrl(String(path)))}"`,
      );
    }
    const url = apiBase + path;
    const describe = `GET ${redact(sanitizeUrl(url))}`;

    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new ReleaseForgeError('network-error', redact(`${describe} failed: ${cause}`));
    }

    const status = res.status;
    if (status >= 300 && status < 400) {
      await discardBody(res);
      // Gitea's API never needs a redirect. Following one could forward the token to whatever
      // host the response names, so any redirect blocks the capability instead.
      throw new ReleaseForgeError(
        'redirect-refused',
        `${describe} was answered with a redirect (status ${status}); the release token is never forwarded to another location`,
        status,
      );
    }
    if (status < 200 || status >= 300) {
      await discardBody(res);
      const code = status === 401 || status === 403 ? 'unauthenticated' : 'http-error';
      throw new ReleaseForgeError(code, `${describe} failed with status ${status}`, status);
    }

    const text = await readResponseText(res, describe, maxBytes, redact);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ReleaseForgeError(
        'malformed-response',
        `${describe} returned invalid JSON (status ${status})`,
        status,
      );
    }
  }

  return { getJson };
}
