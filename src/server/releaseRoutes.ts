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
import { contentHash } from '../core/hash.js';
import {
  RELEASE_ERROR_HTTP_STATUS,
  type ReleaseErrorCode,
  type ReleaseJob,
} from '../core/release.js';
import type { AppConfig } from '../config/schema.js';
import type { ReleaseBlocker } from '../release/forgeClient.js';
import { verifyReleaseIdentity, type ReleaseIdentityCheck } from '../release/identity.js';
import { ReleasePreparation, ReleasePreparationError } from '../release/preparation.js';
import { ReleaseStateError, ReleaseStateStore } from '../service/releaseState.js';
import { repositoryOperationKey, type ReleaseRepositoryKey } from '../service/releaseOwnership.js';
import { sanitizeUrl } from '../providers/http.js';

/** The admission state release execution needs; `ReleaseOwnership` satisfies it. */
export interface ReleaseExecutionGate {
  readonly accepting: boolean;
}

export interface ReleaseMount {
  runtime: ReleaseRuntime;
  gate: ReleaseExecutionGate;
  preparation?: ReleasePreparation;
  store?: ReleaseStateStore;
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

  const store = mount.store;
  const preparation = mount.preparation;
  if (store === undefined || preparation === undefined) return;

  const repository = (id: string) => {
    const entry = runtime.repositories.find((item) => item.config.id === id);
    if (entry === undefined) throw new RouteError('not-found', 'unknown release repository');
    const source = config.sources.find((item) => item.id === entry.config.source);
    if (source?.kind !== 'gitea' || source.baseUrl === undefined) {
      throw new RouteError('internal-error', 'release repository configuration is unavailable');
    }
    const key: ReleaseRepositoryKey = {
      forge: 'gitea',
      baseUrl: source.baseUrl,
      owner: entry.config.repo.owner,
      repo: entry.config.repo.repo,
    };
    return { entry, key };
  };
  const repoJobs = (id: string): ReleaseJob[] => {
    const { key } = repository(id);
    const jobPrefix = `prepare-${contentHash(repositoryOperationKey(key)).slice(0, 32)}-`;
    return store.listJobs().filter((job) => {
      if (job.jobId.startsWith(jobPrefix)) return true;
      if (job.planId === null) return false;
      return store.readPlan(job.planId).payload.repository.repositoryId === id;
    });
  };

  app.post<{ Params: { id: string } }>(
    '/api/releases/repositories/:id/prepare',
    async (request, reply) => {
      if (request.body !== undefined && request.body !== null && request.body !== '') {
        throw new RouteError('invalid-request', 'preparation does not accept a request body');
      }
      if (!gate.accepting) {
        throw new RouteError('execution-unavailable', 'release execution is unavailable');
      }
      repository(request.params.id);
      const job = await preparation.prepare(request.params.id);
      return reply.code(202).send({
        jobId: job.jobId,
        statusUrl: `/api/releases/jobs/${encodeURIComponent(job.jobId)}`,
      });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/releases/repositories/:id/jobs',
    async (request) => {
      const { entry } = repository(request.params.id);
      const { limit, offset } = pagination(request.query.limit, request.query.offset);
      const jobs = repoJobs(entry.config.id).sort((a, b) => b.jobId.localeCompare(a.jobId));
      return { items: jobs.slice(offset, offset + limit), limit, offset, total: jobs.length };
    },
  );

  app.get<{ Params: { planId: string } }>('/api/releases/plans/:planId', async (request) => {
    const plan = store.readPlan(request.params.planId);
    repository(plan.payload.repository.repositoryId);
    return plan;
  });

  app.get<{ Params: { jobId: string } }>('/api/releases/jobs/:jobId', async (request) => {
    const job = store.readJob(request.params.jobId);
    if (job.planId !== null) {
      const plan = store.readPlan(job.planId);
      repository(plan.payload.repository.repositoryId);
    } else if (
      !runtime.repositories.some(({ config: item }) => {
        const source = config.sources.find((candidate) => candidate.id === item.source);
        if (source?.kind !== 'gitea' || source.baseUrl === undefined) return false;
        const key = {
          forge: 'gitea' as const,
          baseUrl: source.baseUrl,
          owner: item.repo.owner,
          repo: item.repo.repo,
        };
        return job.jobId.startsWith(
          `prepare-${contentHash(repositoryOperationKey(key)).slice(0, 32)}-`,
        );
      })
    ) {
      throw new RouteError('not-found', 'unknown release job');
    }
    return job;
  });
}

class RouteError extends Error {
  constructor(
    readonly code: ReleaseErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function pagination(limitText?: string, offsetText?: string): { limit: number; offset: number } {
  const limit = limitText === undefined ? 25 : Number(limitText);
  const offset = offsetText === undefined ? 0 : Number(offsetText);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100_000
  ) {
    throw new RouteError('invalid-request', 'limit must be 1–100 and offset must be 0–100000');
  }
  return { limit, offset };
}

export function releaseRouteError(
  error: unknown,
): { status: number; body: { code: ReleaseErrorCode; error: string } } | null {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (statusCode === 400 || statusCode === 413) {
    const code: ReleaseErrorCode = statusCode === 413 ? 'evidence-too-large' : 'invalid-request';
    return {
      status: 400,
      body: {
        code,
        error:
          code === 'invalid-request'
            ? 'malformed release request'
            : 'release request exceeds the size limit',
      },
    };
  }
  if (statusCode === 404)
    return { status: 404, body: { code: 'not-found', error: 'unknown release resource' } };
  if (error instanceof RouteError || error instanceof ReleasePreparationError) {
    return {
      status: RELEASE_ERROR_HTTP_STATUS[error.code],
      body: { code: error.code, error: error.message },
    };
  }
  if (error instanceof ReleaseStateError) {
    const code: ReleaseErrorCode =
      error.code === 'not-found' || error.code === 'invalid-id' ? 'not-found' : 'internal-error';
    return {
      status: RELEASE_ERROR_HTTP_STATUS[code],
      body: {
        code,
        error: code === 'not-found' ? 'unknown release resource' : 'release state is unavailable',
      },
    };
  }
  return null;
}
