/**
 * Access gate for release routes (source specification section 12).
 *
 * Release routes are stricter than the planning API because they can act with a dedicated write
 * credential. Two caller kinds are accepted:
 *
 * - A browser caller proves a live login session, the configured public Host, and a same-origin
 *   Origin, and a mutating request also carries the CSRF token bound to that session.
 * - A CLI caller proves an explicit Authorization header and sends no session cookie. It needs no
 *   Origin or CSRF proof because another site cannot make a browser attach that header, and a
 *   cookie-less request has no ambient authority to forge.
 *
 * Forwarded headers never decide who may publish: only the request's own Host and Origin count.
 */

import { safeEqual } from './auth.js';

/** Header carrying the session-bound CSRF token on browser mutations. */
export const CSRF_HEADER = 'x-csrf-token';

/** Methods that cannot change release state and so need no CSRF proof. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type Headers = Record<string, string | string[] | undefined>;

export interface ReleaseAccessDeps {
  /** Operator-approved external origin, e.g. `https://forge-desk.example.com`. */
  publicOrigin: string;
  /** CSRF token bound to a live session cookie, or null when no live session accompanies it. */
  sessionCsrf(cookie: string | undefined): string | null;
  /** True when the cookie carries a session cookie at all, even an expired or unknown one. */
  hasSessionCookie(cookie: string | undefined): boolean;
  /** Whether an explicit Authorization header proves the configured application login. */
  headerAuthenticated(header: string | undefined): boolean;
}

export type ReleaseAccess =
  | { ok: true; mode: 'browser' | 'cli' }
  | {
      ok: false;
      status: 401 | 403;
      code:
        | 'unauthenticated'
        | 'forbidden-origin'
        | 'missing-csrf'
        | 'invalid-csrf'
        | 'mixed-credentials';
      message: string;
    };

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function reject(
  status: 401 | 403,
  code: Extract<ReleaseAccess, { ok: false }>['code'],
  message: string,
): ReleaseAccess {
  return { ok: false, status, code, message };
}

/**
 * Decide whether a request may use a release route. The caller has already resolved the
 * application login, so a rejection here names the release-specific proof that is missing.
 */
export function checkReleaseAccess(
  method: string,
  headers: Headers,
  deps: ReleaseAccessDeps,
): ReleaseAccess {
  const authorization = header(headers, 'authorization');
  const cookie = header(headers, 'cookie');
  const sessionCsrf = deps.sessionCsrf(cookie);

  if (authorization !== undefined) {
    // A session cookie beside an explicit header would mix ambient browser authority with a
    // credential, so the request cannot be classified as either caller kind.
    if (deps.hasSessionCookie(cookie)) {
      return reject(
        403,
        'mixed-credentials',
        'release requests must not combine a session cookie with an Authorization header',
      );
    }
    if (!deps.headerAuthenticated(authorization)) {
      return reject(401, 'unauthenticated', 'invalid application credentials');
    }
    return { ok: true, mode: 'cli' };
  }

  if (sessionCsrf === null) {
    return reject(401, 'unauthenticated', 'release access requires the application login');
  }

  const publicOrigin = new URL(deps.publicOrigin);
  const host = header(headers, 'host');
  if (host === undefined || host.toLowerCase() !== publicOrigin.host.toLowerCase()) {
    return reject(403, 'forbidden-origin', 'release requests must use the configured public host');
  }

  // A browser sends exactly the origin, never a path; anything else is a foreign or forged value.
  const origin = header(headers, 'origin');
  if (origin !== undefined && origin !== publicOrigin.origin) {
    return reject(403, 'forbidden-origin', 'release requests must come from the configured origin');
  }

  if (!SAFE_METHODS.has(method.toUpperCase())) {
    if (origin === undefined) {
      return reject(
        403,
        'forbidden-origin',
        'a release request that changes state must state its Origin',
      );
    }
    const provided = header(headers, CSRF_HEADER);
    if (provided === undefined || provided === '') {
      return reject(
        403,
        'missing-csrf',
        'a release request that changes state needs its CSRF token',
      );
    }
    if (!safeEqual(provided, sessionCsrf)) {
      return reject(403, 'invalid-csrf', 'the CSRF token does not belong to this session');
    }
  }

  return { ok: true, mode: 'browser' };
}
