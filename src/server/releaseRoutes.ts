/**
 * Release HTTP routes (source specification section 10). This slice mounts the private runtime
 * and its access gate plus the repository capability read; plan, job, publish and reconcile
 * routes belong to later slices.
 *
 * Every outward value is sanitized: no token, key, header, credential-bearing URL or private
 * filesystem path leaves this module, and a forge outage becomes a repository blocker rather
 * than an error that could take the process or Planning down.
 */

import type { FastifyInstance } from 'fastify';
import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import type { AppConfig } from '../config/schema.js';
import type { ReleaseBlocker } from '../release/forgeClient.js';
import { verifyReleaseIdentity, type ReleaseIdentityCheck } from '../release/identity.js';
import { sanitizeUrl } from '../providers/http.js';

/** The admission state release execution needs; `ReleaseOwnership` satisfies it. */
export interface ReleaseExecutionGate {
  readonly accepting: boolean;
}

export interface ReleaseMount {
  runtime: ReleaseRuntime;
  gate: ReleaseExecutionGate;
  /** Identity check for repository capability; overridable in tests. */
  verifyIdentity?: (options: {
    config: AppConfig;
    runtime: ReleaseRuntime;
    repositoryId: string;
  }) => Promise<ReleaseIdentityCheck>;
}

/** One configured release repository and whether release execution could use it now. */
export interface ReleaseRepositoryCapability {
  /** Configured allowlist id; the only repository selector a caller may send. */
  id: string;
  /** Display identity of the configured forge repository. */
  repo: string;
  source: string;
  forge: string;
  capability: 'available' | 'blocked';
  blockers: ReleaseBlocker[];
}

/**
 * The release state directory, secrets and secret paths never belong in a response or a log line.
 * Messages from the identity check are already token-redacted; this covers the local values a
 * future blocker could echo.
 */
function scrubber(runtime: ReleaseRuntime): (text: string) => string {
  const privateValues = [
    runtime.stateDir,
    ...runtime.repositories.flatMap((repository) => [
      repository.token,
      repository.config.ssh.privateKeyFile,
      repository.config.ssh.knownHostsFile,
      repository.config.token.kind === 'file' ? repository.config.token.path : '',
    ]),
  ].filter((value) => value !== '');
  return (text) => {
    let out = text;
    for (const value of privateValues) out = out.split(value).join('***');
    return out;
  };
}

/**
 * Register `GET /api/releases/repositories`. The caller has already enforced the release access
 * gate; this route only reports what the configured allowlist can currently do.
 */
export function registerReleaseRoutes(
  app: FastifyInstance,
  config: AppConfig,
  mount: ReleaseMount,
): void {
  const { runtime, gate } = mount;
  const verify = mount.verifyIdentity ?? verifyReleaseIdentity;
  const scrub = scrubber(runtime);

  app.get('/api/releases/repositories', async (): Promise<ReleaseRepositoryCapability[]> => {
    return await Promise.all(
      runtime.repositories.map(async (repository): Promise<ReleaseRepositoryCapability> => {
        const configured = repository.config;
        const blockers: ReleaseBlocker[] = [];
        if (!gate.accepting) {
          blockers.push({
            code: 'release-unavailable',
            message:
              'release execution is unavailable: this process does not own the release state directory or is shutting down',
          });
        } else {
          // A forge outage, bad credential or unsupported server is a blocker for this
          // repository only; Planning routes keep working.
          const check = await verify({ config, runtime, repositoryId: configured.id });
          if (!check.ok) blockers.push(check.blocker);
        }
        const source = config.sources.find((s) => s.id === configured.source);
        return {
          id: configured.id,
          repo: `${configured.repo.owner}/${configured.repo.repo}`,
          source: configured.source,
          forge: source === undefined ? '' : sanitizeUrl(source.baseUrl),
          capability: blockers.length === 0 ? 'available' : 'blocked',
          blockers: blockers.map((blocker) => ({
            code: blocker.code,
            message: scrub(blocker.message),
          })),
        };
      }),
    );
  });
}
