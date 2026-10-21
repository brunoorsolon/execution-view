/**
 * Patch-only release metadata derived from the selected candidate.
 *
 * Everything here comes from Git objects the container already fetched (`./checkout.ts`) plus
 * remote tag observations a caller supplies: no local working-tree file, browser text or host
 * checkout contributes a version, a title or a notes byte. The derived objects are deeply frozen,
 * so the tag name, annotation message and exact notes an approval will bind cannot be edited
 * afterwards by a later step in the same preparation.
 *
 * Stable tags are canonical `vMAJOR.MINOR.PATCH` names without leading zeroes and at most 128
 * characters; every other observed name is retained as an observation and never selects the
 * version. Notes are the exact committed `RELEASE_NOTES.md` bytes when that path is a regular
 * file, otherwise bullets of the committed subjects from the baseline to the candidate, oldest
 * first. Notes above the configured bound, or above what this checkout can read, block with
 * `notes-too-large` rather than being truncated.
 */

import { type ReleaseBaseline, type ReleaseCandidate, type ReleaseNotes } from '../core/release.js';
import { createReleaseNotes } from '../core/releaseDigest.js';
import type { ReleaseCheckout } from './checkout.js';
import type { ReleaseGitBlocker, ReleaseGitBlockerCode } from './gitProcess.js';

/**
 * Upper bound for the exact notes bytes of one release. Oversized notes block preparation with
 * `notes-too-large`; notes are never truncated, because a shortened body would become a different
 * released artifact than the one that was reviewed.
 */
export const DEFAULT_MAX_NOTES_BYTES = 256 * 1024;

/** The one committed path that may supply release notes verbatim. */
export const RELEASE_NOTES_PATH = 'RELEASE_NOTES.md';

/**
 * A stable tag observed on the remote. `peeledCommit` is the commit an annotated tag points at,
 * already resolved by the caller, so its ancestry can be proved against the candidate. It is
 * checked only for a name that could select the version.
 */
export interface ObservedTag {
  name: string;
  peeledCommit: string;
}

export type ReleaseMetadataBlockerCode =
  | ReleaseGitBlockerCode
  | 'invalid-request'
  | 'candidate-invalid'
  | 'tag-invalid'
  | 'version-unsupported'
  | 'baseline-not-ancestor'
  | 'baseline-unavailable'
  | 'notes-empty'
  | 'notes-invalid-utf8'
  | 'notes-bom'
  | 'notes-nul'
  | 'notes-too-large'
  | 'notes-unsupported-mode';

/** Why metadata could not be derived. Safe to log, return or persist: no secret enters it. */
export interface ReleaseMetadataBlocker {
  code: ReleaseMetadataBlockerCode;
  /** Bounded English text. Never a truncated value presented as if it were the real one. */
  message: string;
}

/** The immutable approval content of one prepared release, in the shared contract's shapes. */
export interface ReleaseMetadata {
  candidate: ReleaseCandidate;
  /** Canonical next version, and therefore the tag name, title and annotation message. */
  version: string;
  title: string;
  tagMessage: string;
  baseline: ReleaseBaseline;
  notes: ReleaseNotes;
  /** Observed tag names that are not canonical stable versions, sorted. Never version inputs. */
  otherTags: string[];
}

export type ReleaseMetadataResult =
  { ok: true; value: ReleaseMetadata } | { ok: false; blocker: ReleaseMetadataBlocker };

export interface DeriveReleaseMetadataOptions {
  /** The container-owned checkout that fetched this candidate. */
  checkout: ReleaseCheckout;
  /** The candidate already selected from the verified remote default branch. */
  candidate: ReleaseCandidate;
  /** Every tag name observed on the remote, canonical or not. */
  tags: readonly ObservedTag[];
  /** Configured notes bound; defaults to `DEFAULT_MAX_NOTES_BYTES`. */
  maxNotesBytes?: number;
}

const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
/** Longest canonical tag name that may select the version, matching the supplied publisher. */
const MAX_TAG_NAME_LENGTH = 128;
/** Longest observed tag name carried as an observation; a longer name is unsafe metadata. */
const MAX_OBSERVED_TAG_LENGTH = 1024;
const COMMIT_ID = /^[0-9a-f]{40}$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const SYMLINK_MODE = '120000';

function blocker(code: ReleaseMetadataBlockerCode, message: string): ReleaseMetadataBlocker {
  return { code, message };
}

/** Neutralizes a value echoed from an observation before it can enter a diagnostic. */
function bounded(value: string): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '?');
  return cleaned.length > 64 ? `${cleaned.slice(0, 64)}…` : cleaned;
}

/** Decodes bytes as UTF-8, or returns null instead of replacing undecodable bytes. */
function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Canonical decimal comparison: no leading zeroes, so length then bytes orders numerically. */
function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareVersion(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < 3; index += 1) {
    const order = compareDecimal(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  return 0;
}

interface StableVersion {
  name: string;
  commit: string;
  parts: [string, string, string];
}

/** Splits observations into selectable canonical versions and retained noncanonical names. */
function classifyTags(
  tags: readonly ObservedTag[],
): { stable: StableVersion[]; other: string[] } | ReleaseMetadataBlocker {
  const stable: StableVersion[] = [];
  const other: string[] = [];
  const seen = new Map<string, string>();
  for (const tag of tags) {
    if (tag === null || typeof tag !== 'object') {
      return blocker('tag-invalid', 'a remote tag observation was not a name and commit pair');
    }
    const { name, peeledCommit } = tag;
    if (typeof name !== 'string' || typeof peeledCommit !== 'string') {
      return blocker('tag-invalid', 'a remote tag observation was not a name and commit pair');
    }
    if (name === '' || CONTROL_CHARS.test(name) || name.length > MAX_OBSERVED_TAG_LENGTH) {
      return blocker(
        'tag-invalid',
        `the observed tag name "${bounded(name)}" is empty, too long or contains control characters`,
      );
    }
    const previous = seen.get(name);
    if (previous !== undefined) {
      if (previous !== peeledCommit) {
        return blocker(
          'tag-invalid',
          `the observed tag "${bounded(name)}" resolved to two different commits`,
        );
      }
      continue;
    }
    seen.set(name, peeledCommit);
    const match = STABLE_TAG.exec(name);
    // Only a name that could select the version has to resolve to a commit: every other
    // observation is retained for later conflict checks without blocking the release.
    if (match === null || name.length > MAX_TAG_NAME_LENGTH) {
      other.push(name);
      continue;
    }
    if (!COMMIT_ID.test(peeledCommit)) {
      return blocker(
        'tag-invalid',
        `the observed stable tag "${bounded(name)}" does not resolve to a full commit id`,
      );
    }
    stable.push({ name, commit: peeledCommit, parts: [match[1]!, match[2]!, match[3]!] });
  }
  stable.sort((left, right) => compareVersion(left.parts, right.parts));
  other.sort();
  return { stable, other };
}

/** Exact notes bytes, or the blocker that proves they are not publishable. */
function validateNotes(bytes: Buffer, maxNotesBytes: number): string | ReleaseMetadataBlocker {
  if (bytes.byteLength > maxNotesBytes) {
    return blocker(
      'notes-too-large',
      `the release notes are ${bytes.byteLength} bytes, above the configured ${maxNotesBytes}-byte bound; preparation is blocked rather than truncating them`,
    );
  }
  if (bytes.byteLength === 0) {
    return blocker('notes-empty', 'the release notes are empty, so there is nothing to publish');
  }
  if (bytes.subarray(0, BOM.byteLength).equals(BOM)) {
    return blocker('notes-bom', 'the release notes start with a UTF-8 byte-order mark');
  }
  if (bytes.includes(0)) {
    return blocker('notes-nul', 'the release notes contain a NUL byte');
  }
  const text = decodeUtf8(bytes);
  if (text === null) {
    return blocker('notes-invalid-utf8', 'the release notes are not valid UTF-8');
  }
  return text;
}

/** The heading-and-bullets fallback the supplied publisher uses, from committed subjects only. */
function subjectNotes(
  subjects: Buffer,
  candidateCommit: string,
  version: string,
  maxNotesBytes: number,
): string | ReleaseMetadataBlocker {
  const decoded = decodeUtf8(subjects);
  if (decoded === null) {
    return blocker('notes-invalid-utf8', 'a committed commit subject is not valid UTF-8');
  }
  const bullets = decoded
    .split('\0')
    .filter((subject) => subject !== '')
    .map((subject) => `- ${subject}`);
  if (bullets.length === 0) bullets.push(`- Release ${candidateCommit.slice(0, 12)}`);
  const text = `# ${version}\n\n${bullets.join('\n')}\n`;
  return validateNotes(Buffer.from(text, 'utf8'), maxNotesBytes);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * A notes read the checkout's Git output bound refused is the oversized-notes case: those notes
 * are above what this checkout can read, so the caller sees `notes-too-large` rather than an
 * unrelated Git bound. Any other read failure keeps its own code.
 */
function notesBlocker(blocker: ReleaseGitBlocker, what: string): ReleaseMetadataBlocker {
  if (blocker.code === 'git-output-too-large') {
    return {
      code: 'notes-too-large',
      message: `${what} is larger than this checkout can read; preparation is blocked rather than truncating the release notes`,
    };
  }
  return { code: blocker.code, message: `reading ${what} failed: ${blocker.message}` };
}

/**
 * Derives version, title, annotation message and exact notes for one candidate.
 *
 * A failure is a typed blocker, never a fallback to another version, another candidate or a
 * silently regenerated notes body.
 */
export async function deriveReleaseMetadata(
  options: DeriveReleaseMetadataOptions,
): Promise<ReleaseMetadataResult> {
  if (options === null || typeof options !== 'object') {
    return {
      ok: false,
      blocker: blocker(
        'invalid-request',
        'release metadata needs a release checkout, its candidate and the observed remote tags',
      ),
    };
  }
  const { checkout, candidate, tags } = options;
  if (typeof checkout?.candidate !== 'function') {
    return {
      ok: false,
      blocker: blocker('invalid-request', 'release metadata needs a release checkout'),
    };
  }
  const maxNotesBytes = options.maxNotesBytes ?? DEFAULT_MAX_NOTES_BYTES;
  if (!Number.isSafeInteger(maxNotesBytes) || maxNotesBytes < 1) {
    return {
      ok: false,
      blocker: blocker(
        'invalid-request',
        'the configured notes bound must be a positive byte count',
      ),
    };
  }
  if (!Array.isArray(tags)) {
    return {
      ok: false,
      blocker: blocker('invalid-request', 'the observed remote tags must be an array'),
    };
  }
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.commit !== 'string' ||
    !COMMIT_ID.test(candidate.commit) ||
    typeof candidate.branch !== 'string' ||
    candidate.branch === '' ||
    CONTROL_CHARS.test(candidate.branch)
  ) {
    return {
      ok: false,
      blocker: blocker(
        'candidate-invalid',
        'the selected candidate is not a full commit and branch',
      ),
    };
  }
  // The candidate is never taken on trust: only the commit this checkout actually fetched may
  // become immutable release metadata, so a stale or caller-invented candidate fails here.
  const fetched = checkout.candidate();
  if (fetched === null) {
    return {
      ok: false,
      blocker: blocker(
        'candidate-invalid',
        'the release candidate must be fetched before its metadata is derived',
      ),
    };
  }
  if (fetched.commit !== candidate.commit || fetched.branch !== candidate.branch) {
    return {
      ok: false,
      blocker: blocker(
        'candidate-invalid',
        `the supplied candidate ${bounded(candidate.commit)} on ${bounded(candidate.branch)} is not the candidate this checkout fetched (${fetched.commit} on ${bounded(fetched.branch)})`,
      ),
    };
  }

  const classified = classifyTags(tags);
  if ('code' in classified) return { ok: false, blocker: classified };
  const { stable, other } = classified;

  const highest = stable.length === 0 ? null : stable[stable.length - 1]!;
  const version =
    highest === null
      ? 'v0.1.0'
      : `v${highest.parts[0]}.${highest.parts[1]}.${BigInt(highest.parts[2]) + 1n}`;
  // The increment can outgrow the canonical name the classifier accepts, which would make the
  // published tag unrecognizable to the next preparation. Refuse it instead of returning
  // metadata whose own version can never become the next baseline.
  if (version.length > MAX_TAG_NAME_LENGTH) {
    return {
      ok: false,
      blocker: blocker(
        'version-unsupported',
        `the next version "${bounded(version)}" is ${version.length} characters, longer than the supported ${MAX_TAG_NAME_LENGTH}-character stable tag name`,
      ),
    };
  }
  const baseline: ReleaseBaseline =
    highest === null
      ? { tag: null, commit: null, stableTags: [] }
      : {
          tag: highest.name,
          commit: highest.commit,
          stableTags: stable.map((entry) => entry.name),
        };

  if (highest !== null) {
    const ancestry = await checkout.isAncestor(highest.commit, candidate.commit);
    if (!ancestry.ok) {
      // Only a Git read that cannot place the baseline object in the candidate history becomes
      // `baseline-unavailable`; an interruption or timeout keeps its own code.
      const missing = ancestry.blocker.code === 'git-failed';
      return {
        ok: false,
        blocker: blocker(
          missing ? 'baseline-unavailable' : ancestry.blocker.code,
          missing
            ? `the baseline tag "${highest.name}" cannot be checked inside the fetched candidate history: ${ancestry.blocker.message}`
            : `checking the baseline tag "${highest.name}" against the candidate failed: ${ancestry.blocker.message}`,
        ),
      };
    }
    if (!ancestry.value) {
      return {
        ok: false,
        blocker: blocker(
          'baseline-not-ancestor',
          `the baseline tag "${highest.name}" (${highest.commit}) is not an ancestor of the candidate ${candidate.commit}`,
        ),
      };
    }
  }

  // The mode decides the notes source before any blob is read: a symlink's target text is not
  // release notes, so it is never read and can never make the notes look oversized.
  const entry = await checkout.readEntry(candidate.commit, RELEASE_NOTES_PATH, { content: false });
  if (!entry.ok) {
    return {
      ok: false,
      blocker: notesBlocker(entry.blocker, `${RELEASE_NOTES_PATH} at the candidate`),
    };
  }

  let notes: ReleaseNotes;
  const committed = entry.value;
  if (committed !== null && committed.mode !== SYMLINK_MODE) {
    if (!REGULAR_FILE_MODES.has(committed.mode) || committed.type !== 'blob') {
      return {
        ok: false,
        blocker: blocker(
          'notes-unsupported-mode',
          `${RELEASE_NOTES_PATH} at the candidate is not a regular file (${committed.type}, mode ${committed.mode})`,
        ),
      };
    }
    const content = await checkout.readEntry(candidate.commit, RELEASE_NOTES_PATH);
    if (!content.ok) {
      return {
        ok: false,
        blocker: notesBlocker(content.blocker, `${RELEASE_NOTES_PATH} at the candidate`),
      };
    }
    const bytes = content.value?.bytes ?? null;
    if (bytes === null) {
      return {
        ok: false,
        blocker: blocker(
          'notes-unsupported-mode',
          `${RELEASE_NOTES_PATH} at the candidate was not readable as a regular file`,
        ),
      };
    }
    const validated = validateNotes(bytes, maxNotesBytes);
    if (typeof validated !== 'string') return { ok: false, blocker: validated };
    notes = createReleaseNotes(validated, 'file');
  } else {
    // Absent, or a symlink at the notes path: the committed history supplies the notes instead.
    const subjects = await checkout.readCommitSubjects(baseline.commit, candidate.commit);
    if (!subjects.ok) {
      return {
        ok: false,
        blocker: notesBlocker(subjects.blocker, 'the committed release note subjects'),
      };
    }
    const generated = subjectNotes(subjects.value, candidate.commit, version, maxNotesBytes);
    if (typeof generated !== 'string') return { ok: false, blocker: generated };
    notes = createReleaseNotes(generated, 'commit-subjects');
  }

  return {
    ok: true,
    value: deepFreeze({
      candidate: { commit: candidate.commit, branch: candidate.branch },
      version,
      title: version,
      tagMessage: version,
      baseline,
      notes,
      otherTags: other,
    }),
  };
}
