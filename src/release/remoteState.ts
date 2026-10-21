/**
 * Read-only classification of remote tag and release state (source specification section 8).
 *
 * Tag state comes from the verified SSH origin: a successful `ls-remote` of the exact tag ref is
 * the authoritative remote answer, so an empty listing is absence while a transport, host-key or
 * access failure is `unknown`. A present tag is read as its real Git object, so annotated vs
 * lightweight, a signature, the target commit, the tag name, the actual tagger and the exact
 * annotation message are all proven from object bytes instead of inferred from a summary.
 *
 * Release state comes from the release HTTP client: the by-tag endpoint carries the full record,
 * and its `404` is only accepted as absence when a bounded complete release listing agrees. A
 * listing that fails, is truncated by the page bound, or names the tag while the endpoint denied
 * it leaves the state `unknown`. The record's URL identity, tag, title, exact body bytes, stable
 * flags and empty asset set must all match, and the actual author is retained.
 *
 * Nothing here writes: no tag, ref, release or state record is created, retried or deleted, and
 * every failure becomes a typed, bounded reason the plan records.
 */

import type {
  ReleaseIntendedAction,
  ReleaseObjectExpectation,
  ReleaseObservation,
  ReleaseRepositoryIdentity,
  ReleaseTagExpectation,
  ReleaseTagObservation,
  ReleaseTagger,
} from '../core/release.js';
import { releaseNotesDigest } from '../core/releaseDigest.js';
import type { ReleaseCheckout, ReleaseRemoteTag } from './checkout.js';
import { ReleaseForgeError, type ReleaseForgeClient } from './forgeClient.js';

/** A stable machine-readable reason a remote object is not `exact` or not `absent`. */
export type ReleaseRemoteStateReasonCode =
  | 'tag-unreadable'
  | 'tag-not-annotated'
  | 'tag-signed'
  | 'tag-target-mismatch'
  | 'tag-content-mismatch'
  | 'tag-object-mismatch'
  | 'release-unreadable'
  | 'release-listing-unproven'
  | 'release-contradictory'
  | 'release-identity-unverified'
  | 'release-content-mismatch'
  | 'release-has-assets'
  | 'release-without-tag';

/** Why an observation is `conflict` or `unknown`. Bounded and redacted; safe to persist. */
export interface ReleaseRemoteStateReason {
  code: ReleaseRemoteStateReasonCode;
  message: string;
}

/** One tag observation plus every reason it is not exact. */
export interface ReleaseTagCheck {
  tag: ReleaseTagObservation;
  reasons: ReleaseRemoteStateReason[];
}

/** One release observation plus every reason it is not exact. */
export interface ReleaseObjectCheck {
  release: ReleaseObservation;
  reasons: ReleaseRemoteStateReason[];
}

/**
 * The combined section 8 classification of one repository.
 *
 * `reasons` is non-empty exactly when the permutation is blocked; a blocked classification
 * permits no action, and each reason names what diverged or could not be proven.
 */
export interface ReleaseRemoteStateObservation {
  tag: ReleaseTagObservation;
  release: ReleaseObservation;
  /** The mutations this permutation permits. Empty means "mutate nothing". */
  actions: ReleaseIntendedAction[];
  reasons: ReleaseRemoteStateReason[];
}

export interface ObserveReleaseRemoteStateOptions {
  /** Verified release repository identity; an unverified identity cannot be classified against. */
  repository: ReleaseRepositoryIdentity;
  /** Checkout over the verified origin; the only tag reader. */
  checkout: Pick<ReleaseCheckout, 'readRemoteTag'>;
  /** Release HTTP client over the verified forge origin. */
  forge: ReleaseForgeClient;
  tag: ReleaseTagExpectation;
  release: ReleaseObjectExpectation;
  maxListPages?: number;
}

/** Page size requested from the release listing. */
const LIST_PAGE_LIMIT = 50;

/**
 * Upper bound for release-listing pages examined to disprove a `404`. A repository with more
 * releases than this bound cannot have absence proven, so its release state stays `unknown`.
 */
export const MAX_RELEASE_LIST_PAGES = 5;

const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const TAGGER = /^(.+) <([^<>]+)> (\d+) [+-]\d{4}$/;
const SIGNATURE = /^-----BEGIN (?:PGP|SSH) SIGNATURE-----$/m;
/** Longest tagger name or e-mail retained from an observed tag object. */
const MAX_TAGGER_FIELD = 200;

function reason(code: ReleaseRemoteStateReasonCode, message: string): ReleaseRemoteStateReason {
  return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Neutralizes an echoed value before it enters a persisted reason. */
function bounded(value: string, maxLength = 80): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '?');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

function absentTag(name: string): ReleaseTagObservation {
  return { state: 'absent', name, commit: null, objectId: null, tagger: null };
}

function absentRelease(): ReleaseObservation {
  return {
    state: 'absent',
    tag: null,
    title: null,
    notesDigest: null,
    draft: null,
    prerelease: null,
    author: null,
    assets: null,
  };
}

/**
 * The exact annotation message a remote tag object records.
 *
 * Git stores the prepared message with one trailing newline that `git tag` adds and strips again
 * when displaying it, so that single conventional newline is removed before comparison. Every
 * other byte must match.
 */
function annotationMessage(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

interface ParsedTagObject {
  target: string | null;
  targetType: string | null;
  name: string | null;
  tagger: ReleaseTagger | null;
  message: string;
}

/** Reads the raw annotated tag object. Header lines are ASCII; the message must be exact UTF-8. */
function parseTagObject(bytes: Buffer): ParsedTagObject | string {
  const separator = bytes.indexOf('\n\n');
  if (separator < 0) return 'the annotated tag object carried no header/body separator';
  const header = bytes.subarray(0, separator).toString('utf8');
  let message: string;
  try {
    message = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(separator + 2));
  } catch {
    return 'the annotated tag message was not valid UTF-8';
  }
  const parsed: ParsedTagObject = {
    target: null,
    targetType: null,
    name: null,
    tagger: null,
    message,
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) {
      const value = line.slice('object '.length);
      if (!OBJECT_ID.test(value)) return 'the annotated tag object named no valid target object';
      parsed.target = value;
    } else if (line.startsWith('type ')) {
      parsed.targetType = line.slice('type '.length);
    } else if (line.startsWith('tag ')) {
      parsed.name = line.slice('tag '.length);
    } else if (line.startsWith('tagger ')) {
      const match = TAGGER.exec(line.slice('tagger '.length));
      if (match !== null) {
        const [, name = '', email = ''] = match;
        if (name.length <= MAX_TAGGER_FIELD && email.length <= MAX_TAGGER_FIELD) {
          parsed.tagger = { name, email };
        }
      }
    }
  }
  if (parsed.target === null) return 'the annotated tag object named no target object';
  return parsed;
}

/** Classifies one remote tag against the planned immutable tag content. */
export function classifyTag(
  observed: ReleaseRemoteTag,
  expected: ReleaseTagExpectation,
): ReleaseTagCheck {
  const base = {
    name: expected.name,
    commit: observed.objectType === 'commit' ? observed.objectId : null,
    objectId: observed.objectId,
    tagger: null,
  };
  if (observed.objectType !== 'tag' || observed.bytes === null) {
    return {
      tag: { ...base, state: 'conflict' },
      reasons: [
        reason(
          'tag-not-annotated',
          `refs/tags/${bounded(expected.name)} exists but is a ${observed.objectType}, not an annotated tag`,
        ),
      ],
    };
  }
  const parsed = parseTagObject(observed.bytes);
  if (typeof parsed === 'string') {
    return {
      tag: { ...base, state: 'unknown', objectId: null },
      reasons: [reason('tag-unreadable', parsed)],
    };
  }
  const tag: ReleaseTagObservation = {
    state: 'exact',
    name: expected.name,
    commit: parsed.target,
    objectId: observed.objectId,
    tagger: parsed.tagger,
  };
  const reasons: ReleaseRemoteStateReason[] = [];
  if (parsed.targetType !== 'commit') {
    reasons.push(
      reason(
        'tag-target-mismatch',
        `the annotated tag targets a ${String(parsed.targetType)}, not the planned commit`,
      ),
    );
  }
  if (parsed.target !== expected.commit) {
    reasons.push(
      reason(
        'tag-target-mismatch',
        `the annotated tag targets ${String(parsed.target)}, not the planned commit ${expected.commit}`,
      ),
    );
  }
  if (parsed.name !== null && parsed.name !== expected.name) {
    reasons.push(
      reason(
        'tag-content-mismatch',
        `the annotated tag object is named "${bounded(parsed.name)}", not "${bounded(expected.name)}"`,
      ),
    );
  }
  if (SIGNATURE.test(parsed.message)) {
    reasons.push(
      reason('tag-signed', 'the annotated tag carries a signature, which the plan never approves'),
    );
  }
  if (annotationMessage(parsed.message) !== expected.message) {
    reasons.push(
      reason(
        'tag-content-mismatch',
        'the annotated tag annotation message is not the planned exact message',
      ),
    );
  }
  if (expected.objectId !== null && observed.objectId !== expected.objectId) {
    reasons.push(
      reason(
        'tag-object-mismatch',
        `the remote tag object is ${observed.objectId}, not the frozen planned object ${expected.objectId}`,
      ),
    );
  }
  return { tag: reasons.length === 0 ? tag : { ...tag, state: 'conflict' }, reasons };
}

/** Classifies one tag read, mapping a failed read to an `unknown` tag that blocks publication. */
export async function observeTagState(
  checkout: Pick<ReleaseCheckout, 'readRemoteTag'>,
  expected: ReleaseTagExpectation,
): Promise<ReleaseTagCheck> {
  const read = await checkout.readRemoteTag(expected.name);
  if (!read.ok) {
    return {
      tag: { state: 'unknown', name: expected.name, commit: null, objectId: null, tagger: null },
      reasons: [
        reason(
          'tag-unreadable',
          `the remote tag could not be read (${bounded(read.blocker.code)}): ${bounded(read.blocker.message, 200)}`,
        ),
      ],
    };
  }
  if (read.value === null) return { tag: absentTag(expected.name), reasons: [] };
  return classifyTag(read.value, expected);
}

/**
 * The observed release URL must belong to the verified repository: the same forge origin and a
 * path under the configured owner/repository's release pages. A link the client cannot validate
 * leaves the release identity unproven, so it can never be `exact`.
 */
function releaseUrlVerified(raw: unknown, repository: ReleaseRepositoryIdentity): boolean {
  if (typeof raw !== 'string') return false;
  let url: URL;
  let base: URL;
  try {
    url = new URL(raw);
    base = new URL(repository.baseUrl);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return false;
  }
  if (url.protocol !== base.protocol || url.host !== base.host) return false;
  const basePath = base.pathname.replace(/\/+$/, '');
  const prefix = `${basePath}/${repository.owner}/${repository.repo}/releases/`.toLowerCase();
  return url.pathname.toLowerCase().startsWith(prefix);
}

/**
 * Classifies one release record against the planned immutable release content. Every field the
 * plan approves must match byte for byte, and the record must prove the stable, asset-free,
 * repository-verified shape; anything unprovable is `unknown`, anything divergent `conflict`.
 */
export function classifyRelease(
  raw: unknown,
  expected: ReleaseObjectExpectation,
  repository: ReleaseRepositoryIdentity,
): ReleaseObjectCheck {
  if (!isRecord(raw)) {
    return {
      release: { ...absentRelease(), state: 'unknown' },
      reasons: [reason('release-unreadable', 'the release response was not a JSON object')],
    };
  }
  const tag = typeof raw['tag_name'] === 'string' ? raw['tag_name'] : null;
  const title = typeof raw['name'] === 'string' ? raw['name'] : null;
  const body = typeof raw['body'] === 'string' ? raw['body'] : null;
  const draft = typeof raw['draft'] === 'boolean' ? raw['draft'] : null;
  const prerelease = typeof raw['prerelease'] === 'boolean' ? raw['prerelease'] : null;
  const author =
    isRecord(raw['author']) && typeof raw['author']['login'] === 'string'
      ? raw['author']['login']
      : null;
  const assets = Array.isArray(raw['assets']) ? raw['assets'].length : null;
  const release: ReleaseObservation = {
    state: 'unknown',
    tag,
    title,
    notesDigest: body === null ? null : releaseNotesDigest(body),
    draft,
    prerelease,
    author,
    assets,
  };

  const unprovable: string[] = [];
  if (tag === null) unprovable.push('tag name');
  if (title === null) unprovable.push('title');
  if (body === null) unprovable.push('notes body');
  if (draft === null || prerelease === null) unprovable.push('stable flags');
  if (assets === null) unprovable.push('asset set');
  if (unprovable.length > 0) {
    return {
      release,
      reasons: [
        reason(
          'release-unreadable',
          `the release response did not prove its ${unprovable.join(', ')}`,
        ),
      ],
    };
  }
  if (!releaseUrlVerified(raw['html_url'], repository)) {
    return {
      release,
      reasons: [
        reason(
          'release-identity-unverified',
          'the release URL does not belong to the verified repository, so its identity is unproven',
        ),
      ],
    };
  }

  const reasons: ReleaseRemoteStateReason[] = [];
  if (tag !== expected.tag) {
    reasons.push(
      reason(
        'release-content-mismatch',
        `the release record names tag "${bounded(String(tag))}", not "${bounded(expected.tag)}"`,
      ),
    );
  }
  if (title !== expected.title) {
    reasons.push(
      reason(
        'release-content-mismatch',
        `the release title is not the planned exact title "${bounded(expected.title)}"`,
      ),
    );
  }
  if (release.notesDigest !== expected.notesDigest) {
    reasons.push(
      reason(
        'release-content-mismatch',
        'the release notes body is not the planned exact notes bytes',
      ),
    );
  }
  if (draft !== false || prerelease !== false) {
    reasons.push(
      reason(
        'release-content-mismatch',
        'the release is a draft or prerelease, but the plan approves neither flag',
      ),
    );
  }
  if (assets !== 0) {
    reasons.push(
      reason('release-has-assets', `the release carries ${String(assets)} asset(s), not none`),
    );
  }
  return {
    release:
      reasons.length === 0 ? { ...release, state: 'exact' } : { ...release, state: 'conflict' },
    reasons,
  };
}

type ListingResult = { kind: 'found' } | { kind: 'absent' } | { kind: 'unproven'; detail: string };

function releasesPath(repository: ReleaseRepositoryIdentity): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/releases`;
}

/**
 * Searches a bounded, complete release listing for the tag.
 *
 * The release token holds release write permission for the repository, so the listing includes
 * drafts. Only an empty page ends the listing, so a server that serves a smaller page than the
 * requested limit cannot make a non-empty remainder look like absence.
 */
async function findListedRelease(
  forge: ReleaseForgeClient,
  repository: ReleaseRepositoryIdentity,
  tag: string,
  maxPages: number,
): Promise<ListingResult> {
  for (let page = 1; page <= maxPages; page += 1) {
    let raw: unknown;
    try {
      raw = await forge.getJson<unknown>(
        `${releasesPath(repository)}?limit=${LIST_PAGE_LIMIT}&page=${page}`,
      );
    } catch (err) {
      const detail = err instanceof ReleaseForgeError ? err.message : 'the listing request failed';
      return { kind: 'unproven', detail };
    }
    if (!Array.isArray(raw)) {
      return { kind: 'unproven', detail: 'the release listing was not a JSON array' };
    }
    if (raw.length === 0) return { kind: 'absent' };
    for (const entry of raw) {
      if (isRecord(entry) && entry['tag_name'] === tag) return { kind: 'found' };
    }
  }
  return {
    kind: 'unproven',
    detail: `more than ${maxPages * LIST_PAGE_LIMIT} releases are listed, so this tag's absence could not be proven`,
  };
}

/**
 * Observes one release through the release client.
 *
 * A `404` from the by-tag endpoint is only absence when the listing agrees; a listing failure,
 * a page bound, or a listing that names the tag leaves the state `unknown` so no caller can
 * mistake an inaccessible or contradictory response for an absent release.
 */
export async function observeReleaseState(
  forge: ReleaseForgeClient,
  repository: ReleaseRepositoryIdentity,
  expected: ReleaseObjectExpectation,
  options: { maxListPages?: number } = {},
): Promise<ReleaseObjectCheck> {
  const path = `${releasesPath(repository)}/tags/${encodeURIComponent(expected.tag)}`;
  try {
    return classifyRelease(await forge.getJson<unknown>(path), expected, repository);
  } catch (err) {
    if (!(err instanceof ReleaseForgeError)) {
      return {
        release: { ...absentRelease(), state: 'unknown' },
        reasons: [reason('release-unreadable', 'the release read failed unexpectedly')],
      };
    }
    if (err.status !== 404) {
      return {
        release: { ...absentRelease(), state: 'unknown' },
        reasons: [
          reason(
            'release-unreadable',
            `the release could not be read (${bounded(err.code)}): ${bounded(err.message, 200)}`,
          ),
        ],
      };
    }
    const listed = await findListedRelease(
      forge,
      repository,
      expected.tag,
      options.maxListPages ?? MAX_RELEASE_LIST_PAGES,
    );
    if (listed.kind === 'absent') return { release: absentRelease(), reasons: [] };
    const unknown: ReleaseObservation = { ...absentRelease(), state: 'unknown' };
    if (listed.kind === 'found') {
      return {
        release: { ...unknown, tag: expected.tag },
        reasons: [
          reason(
            'release-contradictory',
            `the release endpoint reported no release for tag "${bounded(expected.tag)}" while the release listing names it`,
          ),
        ],
      };
    }
    return {
      release: { ...unknown, tag: expected.tag },
      reasons: [
        reason(
          'release-listing-unproven',
          `a release absence for tag "${bounded(expected.tag)}" could not be proven: ${bounded(listed.detail, 200)}`,
        ),
      ],
    };
  }
}

/**
 * Maps the two observations onto the section 8 permitted outcomes.
 *
 * Any conflict or unknown, and a release that exists without its required exact tag, is blocked:
 * reasons are non-empty and no action is permitted. Only the three permitted permutations yield
 * the actions the approval may later carry out.
 */
export function combineRemoteState(
  tag: ReleaseTagCheck,
  release: ReleaseObjectCheck,
): ReleaseRemoteStateObservation {
  const reasons = [...tag.reasons, ...release.reasons];
  const observations = { tag: tag.tag, release: release.release };
  if (reasons.length > 0) return { ...observations, actions: [], reasons };
  if (tag.tag.state === 'absent' && release.release.state === 'absent') {
    return {
      ...observations,
      actions: [
        { kind: 'create-tag', tag: tag.tag.name },
        { kind: 'create-release', tag: tag.tag.name },
      ],
      reasons: [],
    };
  }
  if (tag.tag.state === 'exact' && release.release.state === 'absent') {
    return {
      ...observations,
      actions: [{ kind: 'create-release', tag: tag.tag.name }],
      reasons: [],
    };
  }
  if (tag.tag.state === 'exact' && release.release.state === 'exact') {
    return { ...observations, actions: [], reasons: [] };
  }
  // The only remaining combination is an absent tag with an existing release, which must block:
  // a release without its required exact tag is never repaired by this engine.
  return {
    ...observations,
    actions: [],
    reasons: [
      reason(
        'release-without-tag',
        `release "${bounded(release.release.tag ?? 'unknown')}" exists without its required exact tag "${bounded(tag.tag.name)}"`,
      ),
    ],
  };
}

/**
 * Observes and classifies the tag and release state of one verified repository. Read-only: no
 * remote object, local ref outside the private cache, or durable record is created here.
 */
export async function observeReleaseRemoteState(
  options: ObserveReleaseRemoteStateOptions,
): Promise<ReleaseRemoteStateObservation> {
  const tag = await observeTagState(options.checkout, options.tag);
  const release = await observeReleaseState(options.forge, options.repository, options.release, {
    ...(options.maxListPages !== undefined ? { maxListPages: options.maxListPages } : {}),
  });
  return combineRemoteState(tag, release);
}
