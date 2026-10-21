import { createHash, timingSafeEqual } from 'node:crypto';

/** The session cookie set by the login form. */
export const SESSION_COOKIE = 'ev_session';

/** Constant-time string comparison that does not leak the length (compares digests). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function credentialsMatch(
  username: string,
  password: string,
  expected: { username: string; password: string },
): boolean {
  // Evaluate both comparisons so timing does not reveal which one failed.
  const userOk = safeEqual(username, expected.username);
  const passOk = safeEqual(password, expected.password);
  return userOk && passOk;
}

export function checkBasicAuth(
  header: string | undefined,
  expected: { username: string; password: string },
): boolean {
  if (header === undefined) return false;
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header);
  if (match === null) return false;
  const decoded = Buffer.from(match[1] as string, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const username = colon === -1 ? decoded : decoded.slice(0, colon);
  const password = colon === -1 ? '' : decoded.slice(colon + 1);
  return credentialsMatch(username, password, expected) && colon !== -1;
}

export function sessionToken(cookie: string | undefined): string | null {
  const match = /(?:^|;\s*)ev_session=([A-Za-z0-9_-]+)/.exec(cookie ?? '');
  return match === null ? null : (match[1] as string);
}
