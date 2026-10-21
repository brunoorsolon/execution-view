import { createHash } from 'node:crypto';
import { contentHash } from './hash.js';
import type { ReleaseNotes, ReleasePlanPayload } from './release.js';

/**
 * sha256 hex of the canonical JSON of the stored structured plan payload.
 *
 * Only the payload is hashed, so the digest covers approval content and nothing else. A
 * formatted rendering passed in place of the payload is rejected, and so is notes content whose
 * digest does not match its exact text: an accepted digest must always describe an intact
 * structured record the server stores.
 */
export function releasePlanDigest(payload: ReleasePlanPayload): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(
      'releasePlanDigest: expected a structured release plan payload, not formatted text',
    );
  }
  const notes = (payload as Partial<ReleasePlanPayload>).notes;
  if (typeof notes?.text !== 'string' || notes.digest !== releaseNotesDigest(notes.text)) {
    throw new Error(
      'releasePlanDigest: expected the stored structured payload whose notes digest matches its exact text',
    );
  }
  return contentHash(payload);
}

/** True only when `digest` is the digest of this exact structured payload. */
export function isReleasePlanDigest(payload: ReleasePlanPayload, digest: string): boolean {
  return releasePlanDigest(payload) === digest;
}

/** sha256 hex of the exact UTF-8 bytes of release notes, comparable with `sha256sum`. */
export function releaseNotesDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Notes whose digest is derived from the exact text, so the two can never disagree. */
export function createReleaseNotes(text: string, source: ReleaseNotes['source']): ReleaseNotes {
  return { text, source, digest: releaseNotesDigest(text) };
}
