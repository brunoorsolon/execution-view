/**
 * Release identity verification: prove which forge, account and repository a configured release
 * repository would publish to, before any plan or mutation trusts a forge observation.
 *
 * The check is read-only and total: every failure is a typed release blocker, never an exception
 * escaping with a token, authorization header or response body in its message. No tag or release
 * write path exists here, and a forge outage only blocks release capability.
 */

import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import type { AppConfig, ResolvedReleaseRepository } from '../config/schema.js';
import type { ReleaseAccountIdentity, ReleaseRepositoryIdentity } from '../core/release.js';
import {
  ReleaseForgeError,
  SUPPORTED_GITEA_VERSION,
  createReleaseForgeClient,
  type ReleaseBlocker,
  type ReleaseForgeFetch,
} from './forgeClient.js';

export interface VerifiedReleaseIdentity {
  /** Exact forge version that proved the supported publication target. */
  serverVersion: string;
  account: ReleaseAccountIdentity;
  repository: ReleaseRepositoryIdentity;
}

export type ReleaseIdentityCheck =
  { ok: true; identity: VerifiedReleaseIdentity } | { ok: false; blocker: ReleaseBlocker };

export interface VerifyReleaseIdentityOptions {
  /** Loaded application configuration; supplies the allowlisted repository and its Gitea source. */
  config: AppConfig;
  /** Local release runtime; the only source of the dedicated release token. */
  runtime: ReleaseRuntime;
  /** Allowlisted release repository id. Never a browser-supplied repository path or URL. */
  repositoryId: string;
  fetch?: ReleaseForgeFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A server-provided name, made safe for a diagnostic: no control characters, bounded length. */
function safeName(value: unknown, max = 64): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '?').trim();
  if (cleaned === '') return null;
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function malformed(detail: string): ReleaseForgeError {
  return new ReleaseForgeError('malformed-response', `release forge response: ${detail}`);
}

function parseAccount(raw: unknown, baseUrl: string): ReleaseAccountIdentity {
  if (!isRecord(raw)) throw malformed('/user did not return a JSON object');
  const login = safeName(raw['login']);
  const id = positiveId(raw['id']);
  if (login === null || id === null) {
    throw malformed('/user did not return a login and a positive numeric account id');
  }
  return { forge: 'gitea', baseUrl, login, forgeUserId: id };
}

/** Only the supported Gitea release target may prove release identity. */
function parseVersion(raw: unknown): string {
  if (!isRecord(raw)) throw malformed('/version did not return a JSON object');
  const version = safeName(raw['version'], 40);
  if (version === null) throw malformed('/version did not return a version string');
  if (/forgejo/i.test(version)) {
    throw new ReleaseForgeError(
      'unsupported-forge',
      `the release forge identifies as Forgejo ("${version}"); only Gitea ${SUPPORTED_GITEA_VERSION} is supported`,
    );
  }
  if (version !== SUPPORTED_GITEA_VERSION) {
    throw new ReleaseForgeError(
      'unsupported-version',
      `the release forge reports version "${version}"; only Gitea ${SUPPORTED_GITEA_VERSION} is supported`,
    );
  }
  return version;
}

function parseRepository(
  raw: unknown,
  configured: ResolvedReleaseRepository,
): { forgeRepositoryId: number; defaultBranch: string } {
  if (!isRecord(raw)) throw malformed('/repos/{owner}/{repo} did not return a JSON object');
  const id = positiveId(raw['id']);
  if (id === null) throw malformed('/repos/{owner}/{repo} did not return a numeric repository id');
  const expected = `${configured.repo.owner}/${configured.repo.repo}`;
  const fullName = safeName(raw['full_name'], 200);
  if (fullName === null || fullName.toLowerCase() !== expected) {
    throw new ReleaseForgeError(
      'repository-mismatch',
      `the release token sees repository "${fullName ?? '?'}" but releases.repositories[${configured.id}] configures "${expected}"`,
    );
  }
  const defaultBranch = safeName(raw['default_branch'], 200);
  if (defaultBranch === null)
    throw malformed('/repos/{owner}/{repo} did not return a default branch');
  return { forgeRepositoryId: id, defaultBranch };
}

/** A planning credential must never satisfy a release identity check. */
function assertDedicatedToken(config: AppConfig, token: string, repositoryId: string): void {
  const shared = config.sources.some(
    (s) => s.token !== null && s.token.trim() !== '' && s.token.trim() === token,
  );
  if (shared) {
    throw new ReleaseForgeError(
      'shared-planning-token',
      `releases.repositories[${safeName(repositoryId) ?? '?'}]: the release token must be dedicated, not a planning source token`,
    );
  }
}

async function verify(opts: VerifyReleaseIdentityOptions): Promise<VerifiedReleaseIdentity> {
  const releases = opts.config.releases;
  if (!releases.enabled) {
    throw new ReleaseForgeError(
      'release-disabled',
      'releases are disabled in this configuration; no release identity can be verified',
    );
  }
  const configured = releases.repositories.find((r) => r.id === opts.repositoryId);
  const loaded = opts.runtime.repositories.find((r) => r.config.id === opts.repositoryId);
  if (configured === undefined || loaded === undefined) {
    throw new ReleaseForgeError(
      'unknown-repository',
      `release repository "${safeName(opts.repositoryId) ?? '?'}" is not in the configured release allowlist`,
    );
  }

  const token = loaded.token.trim();
  assertDedicatedToken(opts.config, token, configured.id);

  const source = opts.config.sources.find((s) => s.id === configured.source);
  if (source === undefined || source.kind !== 'gitea' || source.baseUrl === '') {
    throw new ReleaseForgeError(
      'unknown-repository',
      `releases.repositories[${configured.id}]: source "${safeName(configured.source) ?? '?'}" is not a configured gitea source`,
    );
  }

  // The configured SSH push origin must name the same forge host we authenticate against.
  const forgeHost = hostOf(source.baseUrl);
  const originHost = hostOf(configured.origin);
  if (forgeHost === null || originHost !== forgeHost) {
    throw new ReleaseForgeError(
      'ssh-origin-mismatch',
      `releases.repositories[${configured.id}].origin: SSH host "${originHost ?? '?'}" must match the configured forge host "${forgeHost ?? '?'}"`,
    );
  }

  const client = createReleaseForgeClient({
    baseUrl: source.baseUrl,
    token,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
  });
  const baseUrl = source.baseUrl;

  const account = parseAccount(await client.getJson<unknown>('/user'), baseUrl);
  if (account.login.toLowerCase() !== configured.expectedApiUser.toLowerCase()) {
    throw new ReleaseForgeError(
      'account-mismatch',
      `the release token authenticates as "${account.login}" but releases.repositories[${configured.id}].expectedApiUser is "${configured.expectedApiUser}"`,
    );
  }

  // The version gate precedes the repository read: an unsupported server's repository
  // observation must not be trusted even when the slug happens to match.
  const serverVersion = parseVersion(await client.getJson<unknown>('/version'));

  const path = `/repos/${encodeURIComponent(configured.repo.owner)}/${encodeURIComponent(configured.repo.repo)}`;
  let rawRepository: unknown;
  try {
    rawRepository = await client.getJson<unknown>(path);
  } catch (err) {
    if (err instanceof ReleaseForgeError && err.status === 404) {
      throw new ReleaseForgeError(
        'repository-mismatch',
        `releases.repositories[${configured.id}]: "${configured.repo.owner}/${configured.repo.repo}" is not visible to the release token (404), so its identity is unproven`,
        404,
      );
    }
    throw err;
  }
  const repository = parseRepository(rawRepository, configured);

  return {
    serverVersion,
    account,
    repository: {
      repositoryId: configured.id,
      forge: 'gitea',
      baseUrl,
      owner: configured.repo.owner,
      repo: configured.repo.repo,
      forgeRepositoryId: repository.forgeRepositoryId,
      defaultBranch: repository.defaultBranch,
    },
  };
}

/**
 * Verify the configured release identity through read-only forge requests. Every outcome is
 * returned: a forge outage, bad credential, wrong account, unsupported server, or redirect
 * becomes `{ ok: false, blocker }` and never disturbs Planning.
 */
export async function verifyReleaseIdentity(
  opts: VerifyReleaseIdentityOptions,
): Promise<ReleaseIdentityCheck> {
  try {
    return { ok: true, identity: await verify(opts) };
  } catch (err) {
    if (err instanceof ReleaseForgeError) {
      return { ok: false, blocker: { code: err.code, message: err.message } };
    }
    // An unexpected failure could carry a response body or header in its message.
    return {
      ok: false,
      blocker: {
        code: 'internal-error',
        message: 'release identity verification failed unexpectedly',
      },
    };
  }
}
