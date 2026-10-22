/**
 * Container-owned release candidate checkout.
 *
 * The backend, not a browser or an incidental host checkout, selects the candidate: this module
 * fetches only the configured, already-verified SSH origin, into a private bare cache under the
 * release state directory, and resolves the remote default-branch head from what was fetched.
 * No caller supplies a commit, a URL, a refspec or a filesystem path outside the cache.
 *
 * Object reads are limited to committed objects. Preparation may create an unreferenced local
 * annotated tag object. Nothing here pushes a ref, checks out a working tree or follows a symlink.
 */

import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedReleaseRepository } from '../config/schema.js';
import type { ReleaseTagger } from '../core/release.js';
import type { ObservedTag } from './metadata.js';
import type { VerifiedReleaseIdentity } from './identity.js';
import { parseSshEndpoint, sameSshEndpoint } from './sshEndpoint.js';
import {
  ReleaseGitError,
  releaseGitBlocker,
  runReleaseGit,
  type ReleaseGitResult,
} from './gitProcess.js';

/** The remote default-branch commit selected for a new release. */
export interface ReleaseCandidate {
  /** Full commit id read from the fetched remote default-branch ref. */
  commit: string;
  /** Default branch the candidate was fetched from, as proven by release identity. */
  branch: string;
}

/** One tag as read from the verified remote origin. */
export interface ReleaseRemoteTag {
  /** Object id the remote tag ref points at: the tag object, or the commit of a lightweight tag. */
  objectId: string;
  /** Type Git reports for that object, so a lightweight tag is never mistaken for an annotated one. */
  objectType: 'tag' | 'commit' | 'tree' | 'blob';
  /** Raw annotated tag object bytes, or null when the ref points at a commit or other object. */
  bytes: Buffer | null;
}

/** One committed tree entry. `mode` is Git's tree mode, so a caller can reject symlinks or files. */
export interface ReleaseEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit' | 'tag';
  /** Object bytes, or null for a tree, commit or tag entry. */
  bytes: Buffer | null;
}

export interface ReleaseCheckoutOptions {
  /** Private release state directory; the cache lives under `<stateDir>/checkout`. */
  stateDir: string;
  /** Allowlisted release repository from configuration. */
  repository: ResolvedReleaseRepository;
  /** Identity already verified through the release HTTP client. */
  identity: VerifiedReleaseIdentity;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Interruption signal from job cancellation or shutdown. */
  signal?: AbortSignal;
}

export interface ReleaseCheckout {
  /** Fetches and resolves the verified remote default-branch head. */
  fetchCandidate(): Promise<ReleaseGitResult<ReleaseCandidate>>;
  /** Complete bounded SSH tag listing, including peeled annotated targets. */
  listRemoteTags(): Promise<ReleaseGitResult<ObservedTag[]>>;
  /** Prepare an unreferenced local tag object for the sealed candidate. Never pushes a ref. */
  prepareTag(
    name: string,
    tagger: ReleaseTagger,
    createdAt: string,
    /** Server-recorded recovery commit, which must still be reachable from the fetched head. */
    recoveryCommit?: string,
  ): Promise<ReleaseGitResult<string>>;
  /**
   * Reads one committed entry at `<commit>:<path>`, or null when the path is absent. Only
   * history reachable from this instance's last successfully fetched candidate is readable.
   * With `content: false` only the Git mode and type are read, so classifying an entry (for
   * example to detect a symlink) never depends on the blob's size.
   */
  readEntry(
    commit: string,
    path: string,
    options?: { content?: boolean },
  ): Promise<ReleaseGitResult<ReleaseEntry | null>>;
  /**
   * Every committed path at `<commit>`, in Git order. Used to prove that one workflow file, not a
   * same-named file elsewhere in the tree, is the one a run executed. Bounded by the child
   * output bound like every other release Git read.
   */
  listPaths(commit: string): Promise<ReleaseGitResult<string[]>>;
  /**
   * True when `ancestor` is reachable from `descendant`. Both are full commit ids, and the
   * descendant must belong to the fetched candidate, so a tag observation can be placed against
   * the candidate history without trusting a caller-supplied answer.
   */
  isAncestor(ancestor: string, descendant: string): Promise<ReleaseGitResult<boolean>>;
  /**
   * NUL-separated commit subjects of `<from>..<to>`, oldest first, or of `<to>` when `from` is
   * null. Raw bytes: the caller decides whether they are valid text.
   */
  readCommitSubjects(from: string | null, to: string): Promise<ReleaseGitResult<Buffer>>;
  /**
   * The candidate this checkout last fetched, or null before a successful fetch. Metadata is
   * derived only for this commit, so a stale or caller-invented candidate is never substituted.
   */
  candidate(): ReleaseCandidate | null;
  /**
   * Reads one tag from the verified remote origin, or null when the remote authors an absence.
   * Nothing is written to the remote, and no object outside this tag is fetched.
   */
  readRemoteTag(name: string): Promise<ReleaseGitResult<ReleaseRemoteTag | null>>;
}

/** The only ref this module writes: a private, container-owned view of the remote branch. */
const CANDIDATE_REF = 'refs/forge-desk/candidate';

/** A second private ref, so observing a remote tag never disturbs the sealed candidate. */
const OBSERVED_TAG_REF = 'refs/forge-desk/observed-tag';

/**
 * The cache's configuration is derived state, so it is rewritten before every read. A cache that
 * was tampered with cannot keep `url.*.insteadOf` rewrites, extra `protocol.*.allow` permissions,
 * include paths or credential settings that would move the verified origin elsewhere.
 */
const CACHE_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tbare = true',
  '\tfilemode = true',
  '\tlogallrefupdates = false',
  '',
].join('\n');

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
const SAFE_TAG = /^[A-Za-z0-9._+-]+$/;
const SAFE_REPO_PATH = /^[A-Za-z0-9._/-]+$/;
const COMMIT_ID = /^[0-9a-f]{40}$/;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Neutralizes an echoed value before it can enter a diagnostic or a log line. */
function bounded(value: string): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '?');
  return cleaned.length > 64 ? `${cleaned.slice(0, 64)}…` : cleaned;
}

/** A branch name becomes a refspec, so it must be a plain Git branch name, not an option. */
function assertSafeBranch(branch: string): string {
  const unsafe =
    branch === '' ||
    !SAFE_BRANCH.test(branch) ||
    branch.startsWith('/') ||
    branch.startsWith('-') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('//') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.split('/').some((segment) => segment === '' || segment.startsWith('.'));
  if (unsafe) {
    throw new ReleaseGitError(
      'git-unsafe-revision',
      `the verified default branch "${bounded(branch)}" is not a safe Git branch name, so no candidate can be selected`,
    );
  }
  return branch;
}

/** A committed path becomes a pathspec, so glob and pathspec magic are refused rather than escaped. */
function assertSafePath(path: string): string {
  if (
    path === '' ||
    !SAFE_REPO_PATH.test(path) ||
    path.startsWith('/') ||
    path.startsWith('-') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ReleaseGitError(
      'git-invalid-request',
      `release object path "${bounded(path)}" must be a plain repository-relative path`,
    );
  }
  return path;
}

/** A tag name becomes a refspec and a pattern, so it must be a plain tag name, not an option. */
function assertSafeTag(name: string): string {
  const unsafe =
    name === '' ||
    !SAFE_TAG.test(name) ||
    name.startsWith('-') ||
    name.includes('..') ||
    name.includes('@{') ||
    name.endsWith('.') ||
    name.endsWith('.lock');
  if (unsafe) {
    throw new ReleaseGitError(
      'git-unsafe-revision',
      `the remote tag name "${bounded(name)}" is not a safe Git tag name`,
    );
  }
  return name;
}

function assertSafeCommit(commit: string): string {
  if (!COMMIT_ID.test(commit)) {
    throw new ReleaseGitError(
      'git-unsafe-revision',
      `release object reads need a full commit id, got "${bounded(commit)}"`,
    );
  }
  return commit;
}

/** The configured origin must be the endpoint the verified repository identity describes. */
function assertVerifiedOrigin(
  configured: ResolvedReleaseRepository,
  identity: VerifiedReleaseIdentity,
): string {
  const at = `releases.repositories[${configured.id}]`;
  const repository = identity.repository;
  if (
    repository.repositoryId !== configured.id ||
    repository.owner !== configured.repo.owner ||
    repository.repo !== configured.repo.repo
  ) {
    throw new ReleaseGitError(
      'git-repository-mismatch',
      `${at}: the verified repository identity does not name the configured repository`,
    );
  }
  if (CONTROL_CHARS.test(configured.origin) || /\s/.test(configured.origin)) {
    throw new ReleaseGitError(
      'git-unsafe-origin',
      `${at}.origin must not contain whitespace or control characters`,
    );
  }
  const endpoint = parseSshEndpoint(configured.origin);
  if (
    !/^ssh:\/\//i.test(configured.origin) ||
    endpoint === null ||
    !sameSshEndpoint(endpoint, identity.ssh) ||
    endpoint.path !== `${configured.repo.owner}/${configured.repo.repo}`.toLowerCase()
  ) {
    throw new ReleaseGitError(
      'git-unsafe-origin',
      `${at}.origin is not the configured repository's verified SSH endpoint`,
    );
  }
  return configured.origin;
}

/**
 * Verifies a private directory. The cache directories are created; the state directory must
 * already exist, so a vanished release volume fails closed instead of being silently recreated.
 */
function ensurePrivateDirectory(dir: string, create: boolean): void {
  if (create) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new ReleaseGitError('git-unsafe-cache', `release checkout cache "${dir}" is unusable`);
    }
  }
  let info;
  try {
    info = lstatSync(dir);
  } catch {
    throw new ReleaseGitError('git-unsafe-cache', `release path "${dir}" could not be inspected`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new ReleaseGitError(
      'git-unsafe-cache',
      `release path "${dir}" must be a private directory owned by the runtime user`,
    );
  }
}

function cachePaths(stateDir: string, repositoryId: string): { checkout: string; cache: string } {
  const checkout = join(stateDir, 'checkout');
  return { checkout, cache: join(checkout, `${repositoryId}.git`) };
}

function resetCacheConfig(cacheDir: string): void {
  const config = join(cacheDir, 'config');
  const temp = join(cacheDir, 'config.forge-desk');
  try {
    rmSync(temp, { force: true });
    writeFileSync(temp, CACHE_CONFIG, { mode: 0o600 });
    renameSync(temp, config);
  } catch {
    throw new ReleaseGitError(
      'git-unsafe-cache',
      `release checkout cache "${cacheDir}" configuration could not be reset`,
    );
  }
}

function firstLine(stdout: Buffer): string {
  return stdout.toString('utf8').trim();
}

export function createReleaseCheckout(options: ReleaseCheckoutOptions): ReleaseCheckout {
  const { checkout, cache } = cachePaths(options.stateDir, options.repository.id);
  /**
   * The candidate this checkout instance last fetched successfully. Object reads are rooted
   * here, so a failed fetch invalidates reads instead of leaving an older candidate readable.
   */
  let sealedCandidate: string | null = null;
  /** Default branch of the sealed candidate, as proven by release identity. */
  let sealedBranch: string | null = null;
  const ssh = options.repository.ssh;
  const git = (argv: readonly string[], operation: string, cwd: string, input?: Buffer) =>
    runReleaseGit(argv, {
      operation,
      cwd,
      ssh,
      ...(input !== undefined ? { input } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

  /** Creates the private cache and initializes it as a bare repository if it is not one yet. */
  const prepareCache = async (): Promise<void> => {
    ensurePrivateDirectory(options.stateDir, false);
    ensurePrivateDirectory(checkout, true);
    ensurePrivateDirectory(cache, true);
    await git(['init', '--bare', '--quiet'], 'prepare the release checkout cache', cache);
    resetCacheConfig(cache);
  };

  /**
   * Object and history reads are rooted in the sealed candidate, so an unrelated commit or one
   * left behind by an earlier fetch can never become release evidence.
   */
  const requireSealedCandidate = async (rev: string, operation: string): Promise<void> => {
    if (sealedCandidate === null) {
      throw new ReleaseGitError(
        'git-invalid-request',
        'read the release candidate before reading its objects',
      );
    }
    await prepareCache();
    const reachable = await git(
      ['rev-list', '--max-count=1', rev, '--not', sealedCandidate],
      operation,
      cache,
    );
    if (firstLine(reachable.stdout) !== '') {
      throw new ReleaseGitError(
        'git-unsafe-revision',
        'the requested object is not reachable from the fetched release candidate',
      );
    }
  };

  return {
    async fetchCandidate(): Promise<ReleaseGitResult<ReleaseCandidate>> {
      sealedCandidate = null;
      sealedBranch = null;
      try {
        const origin = assertVerifiedOrigin(options.repository, options.identity);
        const branch = assertSafeBranch(options.identity.repository.defaultBranch);
        await prepareCache();
        await git(
          [
            'fetch',
            '--quiet',
            '--no-tags',
            '--no-recurse-submodules',
            '--no-write-fetch-head',
            '--refmap=',
            origin,
            `+refs/heads/${branch}:${CANDIDATE_REF}`,
          ],
          'fetch the release candidate',
          cache,
        );
        // The candidate is read back from the private ref, never from FETCH_HEAD, a working-tree
        // HEAD, or a caller-supplied commit.
        const resolved = await git(
          ['rev-parse', '--verify', '--quiet', `${CANDIDATE_REF}^{commit}`],
          'resolve the release candidate',
          cache,
        );
        const commit = firstLine(resolved.stdout);
        if (!COMMIT_ID.test(commit)) {
          throw new ReleaseGitError(
            'git-malformed-response',
            'fetching the release candidate did not resolve a full commit id',
          );
        }
        sealedCandidate = commit;
        sealedBranch = branch;
        return { ok: true, value: { commit, branch } };
      } catch (err) {
        return { ok: false, blocker: releaseGitBlocker(err) };
      }
    },

    async listRemoteTags(): Promise<ReleaseGitResult<ObservedTag[]>> {
      try {
        const origin = assertVerifiedOrigin(options.repository, options.identity);
        await prepareCache();
        const listed = await git(
          ['ls-remote', '--tags', origin],
          'list remote release tags',
          cache,
        );
        const refs = new Map<string, string>();
        for (const line of listed.stdout.toString('utf8').split('\n').filter(Boolean)) {
          const match = /^([0-9a-f]{40})\trefs\/tags\/(.+)$/.exec(line);
          if (match === null || refs.has(match[2]!)) {
            throw new ReleaseGitError(
              'git-malformed-response',
              'remote tag listing was malformed or contradictory',
            );
          }
          refs.set(match[2]!, match[1]!);
        }
        const tags: ObservedTag[] = [];
        for (const [name, objectId] of refs) {
          if (name.endsWith('^{}')) {
            if (!refs.has(name.slice(0, -3))) {
              throw new ReleaseGitError(
                'git-malformed-response',
                'remote peeled tag had no tag ref',
              );
            }
            continue;
          }
          tags.push({ name, peeledCommit: refs.get(`${name}^{}`) ?? objectId });
        }
        return { ok: true, value: tags };
      } catch (err) {
        return { ok: false, blocker: releaseGitBlocker(err) };
      }
    },

    async prepareTag(name, tagger, createdAt, recoveryCommit): Promise<ReleaseGitResult<string>> {
      try {
        const tagName = assertSafeTag(name);
        const seconds = Math.floor(Date.parse(createdAt) / 1000);
        if (
          !Number.isSafeInteger(seconds) ||
          seconds < 0 ||
          [tagger.name, tagger.email].some(
            (value) =>
              value === '' ||
              value.length > 200 ||
              value.trim() !== value ||
              /[<>\x00-\x1f\x7f]/.test(value),
          )
        ) {
          throw new ReleaseGitError(
            'git-invalid-request',
            'prepared tag needs a safe tagger and creation time',
          );
        }
        if (sealedCandidate === null) {
          throw new ReleaseGitError(
            'git-invalid-request',
            'fetch the candidate before preparing its tag',
          );
        }
        const target =
          recoveryCommit === undefined ? sealedCandidate : assertSafeCommit(recoveryCommit);
        await requireSealedCandidate(target, 'verify the prepared tag candidate');
        const bytes = Buffer.from(
          `object ${target}\ntype commit\ntag ${tagName}\ntagger ${tagger.name} <${tagger.email}> ${seconds} +0000\n\n${tagName}\n`,
        );
        const prepared = await git(
          ['mktag'],
          'prepare the local annotated tag object',
          cache,
          bytes,
        );
        const objectId = firstLine(prepared.stdout);
        if (!COMMIT_ID.test(objectId)) {
          throw new ReleaseGitError(
            'git-malformed-response',
            'local tag preparation returned no object id',
          );
        }
        return { ok: true, value: objectId };
      } catch (err) {
        return { ok: false, blocker: releaseGitBlocker(err) };
      }
    },

    async readEntry(
      commit: string,
      path: string,
      options?: { content?: boolean },
    ): Promise<ReleaseGitResult<ReleaseEntry | null>> {
      try {
        const rev = assertSafeCommit(commit);
        const entryPath = assertSafePath(path);
        // Only objects the verified candidate reaches may be read, so an unrelated or
        // caller-invented commit cannot become release evidence.
        await requireSealedCandidate(rev, 'verify a release object belongs to the candidate');
        const listed = await git(
          ['ls-tree', '-z', '--full-tree', rev, '--', entryPath],
          'read a committed release entry',
          cache,
        );
        const entries = listed.stdout
          .toString('utf8')
          .split('\0')
          .filter((line) => line !== '');
        if (entries.length === 0) return { ok: true, value: null };
        if (entries.length !== 1) {
          throw new ReleaseGitError(
            'git-malformed-response',
            'a committed release path resolved to more than one tree entry',
          );
        }
        // Format: <mode> <type> <object id>\t<path>
        const match = /^([0-7]{6}) (blob|tree|commit|tag) ([0-9a-f]{40,64})\t(.*)$/.exec(
          entries[0]!,
        );
        if (match === null) {
          throw new ReleaseGitError(
            'git-malformed-response',
            'a committed release entry was not a valid tree entry',
          );
        }
        const mode = match[1]!;
        const type = match[2] as ReleaseEntry['type'];
        const objectId = match[3]!;
        if (match[4] !== entryPath) {
          throw new ReleaseGitError(
            'git-malformed-response',
            'a committed release entry named a different path than the one requested',
          );
        }
        if (type !== 'blob' || options?.content === false) {
          return { ok: true, value: { mode, type, bytes: null } };
        }
        const blob = await git(
          ['cat-file', 'blob', objectId],
          'read a committed release blob',
          cache,
        );
        return { ok: true, value: { mode, type, bytes: blob.stdout } };
      } catch (err) {
        return { ok: false, blocker: releaseGitBlocker(err) };
      }
    },

    async readRemoteTag(name: string): Promise<ReleaseGitResult<ReleaseRemoteTag | null>> {
      try {
        const tagName = assertSafeTag(name);
        const origin = assertVerifiedOrigin(options.repository, options.identity);
        await prepareCache();
        // A successful listing of this exact ref is the authoritative remote answer: an empty
        // result is absence, while a transport or access failure throws instead of reading as one.
        const listed = await git(
          ['ls-remote', '--tags', '--refs', origin, `refs/tags/${tagName}`],
          'list the remote tag',
          cache,
        );
        const lines = listed.stdout
          .toString('utf8')
          .split('\n')
          .filter((line) => line !== '');
        if (lines.length === 0) return { ok: true, value: null };
        const match = /^([0-9a-f]{40,64})\t(.+)$/.exec(lines[0]!);
        if (lines.length !== 1 || match === null || match[2] !== `refs/tags/${tagName}`) {
          throw new ReleaseGitError(
            'git-malformed-response',
            `listing refs/tags/${tagName} on the verified origin did not answer with that one tag`,
          );
        }
        const listedId = match[1]!;
        await git(
          [
            'fetch',
            '--quiet',
            '--no-tags',
            '--no-recurse-submodules',
            '--no-write-fetch-head',
            '--refmap=',
            origin,
            `+refs/tags/${tagName}:${OBSERVED_TAG_REF}`,
          ],
          'fetch the remote tag',
          cache,
        );
        const resolved = await git(
          ['rev-parse', '--verify', '--quiet', OBSERVED_TAG_REF],
          'resolve the remote tag',
          cache,
        );
        const objectId = firstLine(resolved.stdout);
        if (!OBJECT_ID.test(objectId)) {
          throw new ReleaseGitError(
            'git-malformed-response',
            'fetching the remote tag did not resolve a full object id',
          );
        }
        if (objectId !== listedId) {
          // The remote changed between the two reads, so neither answer can classify the tag.
          throw new ReleaseGitError(
            'git-malformed-response',
            'the remote tag moved between listing and fetching it',
          );
        }
        const typed = await git(['cat-file', '-t', objectId], 'read the remote tag type', cache);
        const objectType = firstLine(typed.stdout);
        if (
          objectType !== 'tag' &&
          objectType !== 'commit' &&
          objectType !== 'tree' &&
          objectType !== 'blob'
        ) {
          throw new ReleaseGitError(
            'git-malformed-response',
            'the remote tag resolved to an unsupported Git object type',
          );
        }
        if (objectType !== 'tag') return { ok: true, value: { objectId, objectType, bytes: null } };
        const object = await git(
          ['cat-file', 'tag', objectId],
          'read the remote tag object',
          cache,
        );
        return { ok: true, value: { objectId, objectType, bytes: object.stdout } };
      } catch (err) {
        return { ok: false, blocker: releaseGitBlocker(err) };
      }
    },

    async listPaths(commit: string): Promise<ReleaseGitResult<string[]>> {
      try {
        const rev = assertSafeCommit(commit);
        await requireSealedCandidate(rev, 'verify a release tree belongs to the candidate');
        const listed = await git(
          ['ls-tree', '-r', '-z', '--name-only', rev],
          'list committed release paths',
          cache,
        );
        // The child output bound already limits how many paths one listing can return.
        return {
          ok: true,
          value: listed.stdout
            .toString('utf8')
            .split('\0')
            .filter((path) => path !== ''),
        };
      } catch (err) {
        return { ok: false, blocker: releaseGitBlocker(err) };
      }
    },

    async isAncestor(ancestor: string, descendant: string): Promise<ReleaseGitResult<boolean>> {
      try {
        const from = assertSafeCommit(ancestor);
        const to = assertSafeCommit(descendant);
        await requireSealedCandidate(to, 'verify a release baseline belongs to the candidate');
        // An empty listing means every commit reachable from `from` is reachable from `to`.
        const listed = await git(
          ['rev-list', '--max-count=1', from, '--not', to],
          'verify a release baseline is an ancestor of the candidate',
          cache,
        );
        return { ok: true, value: firstLine(listed.stdout) === '' };
      } catch (err) {
        return { ok: false, blocker: releaseGitBlocker(err) };
      }
    },

    async readCommitSubjects(from: string | null, to: string): Promise<ReleaseGitResult<Buffer>> {
      try {
        const target = assertSafeCommit(to);
        const base = from === null ? null : assertSafeCommit(from);
        await requireSealedCandidate(
          target,
          'verify a release note range belongs to the candidate',
        );
        const logged = await git(
          ['log', '--reverse', '--format=%s', '-z', base === null ? target : `${base}..${target}`],
          'read committed release note subjects',
          cache,
        );
        return { ok: true, value: logged.stdout };
      } catch (err) {
        return { ok: false, blocker: releaseGitBlocker(err) };
      }
    },

    candidate(): ReleaseCandidate | null {
      if (sealedCandidate === null || sealedBranch === null) return null;
      return { commit: sealedCandidate, branch: sealedBranch };
    },
  };
}
