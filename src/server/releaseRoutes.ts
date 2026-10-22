/**
 * Release HTTP routes (source specification section 10), mounted behind the application login
 * and release access gate. Execution belongs to the durable engine, not the HTTP connection.
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
import { ReleaseApproval, ReleaseApprovalError } from '../release/approval.js';
import { ReleaseReconciliation } from '../release/reconciliation.js';
import { ReleaseStateError, ReleaseStateStore } from '../service/releaseState.js';
import {
  ReleaseOwnershipError,
  repositoryOperationKey,
  type ReleaseRepositoryKey,
} from '../service/releaseOwnership.js';
import { sanitizeUrl } from '../providers/http.js';

/** The admission state release execution needs; `ReleaseOwnership` satisfies it. */
export interface ReleaseExecutionGate {
  readonly accepting: boolean;
}

export interface ReleaseMount {
  runtime: ReleaseRuntime;
  gate: ReleaseExecutionGate;
  preparation?: ReleasePreparation;
  approval?: ReleaseApproval;
  reconciliation?: ReleaseReconciliation;
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

function sanitizeJob(job: ReleaseJob, scrub: (text: string) => string): ReleaseJob {
  return job.blocker === undefined
    ? job
    : { ...job, blocker: { ...job.blocker, message: scrub(job.blocker.message) } };
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
    const jobs: ReleaseJob[] = [];
    for (const jobId of store.listJobIds()) {
      const belongsById = jobId.startsWith(jobPrefix);
      try {
        const job = store.readJob(jobId);
        if (
          belongsById ||
          (job.planId !== null && store.readPlan(job.planId).payload.repository.repositoryId === id)
        ) {
          jobs.push(job);
        }
      } catch (error) {
        if (!belongsById && error instanceof ReleaseStateError && error.code === 'not-found') {
          continue;
        }
        throw error;
      }
    }
    return jobs;
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
      return {
        items: jobs.slice(offset, offset + limit).map((job) => sanitizeJob(job, scrub)),
        limit,
        offset,
        total: jobs.length,
      };
    },
  );

  app.get<{ Params: { planId: string } }>('/api/releases/plans/:planId', async (request) => {
    const plan = store.readPlan(request.params.planId);
    repository(plan.payload.repository.repositoryId);
    return plan;
  });

  app.post<{ Params: { planId: string } }>(
    '/api/releases/plans/:planId/publish',
    { bodyLimit: 1024 },
    async (request, reply) => {
      const body = request.body;
      if (
        typeof body !== 'object' || body === null || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !('digest' in body) ||
        typeof body.digest !== 'string' || !/^[0-9a-f]{64}$/.test(body.digest) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.params.planId)
      ) {
        throw new RouteError('invalid-request', 'publication accepts only a valid digest');
      }
      if (!gate.accepting || mount.approval === undefined) {
        throw new RouteError('execution-unavailable', 'release execution is unavailable');
      }
      const plan = store.readPlan(request.params.planId);
      repository(plan.payload.repository.repositoryId);
      // The shared access gate has verified this configured application identity.
      const job = await mount.approval.approve(
        { planId: request.params.planId, digest: body.digest },
        config.server.basicAuth?.username ?? null,
      );
      return reply.code(202).send({
        ...sanitizeJob(job, scrub),
        statusUrl: `/api/releases/jobs/${encodeURIComponent(job.jobId)}`,
      });
    },
  );

  app.post<{ Params: { jobId: string } }>(
    '/api/releases/jobs/:jobId/reconcile',
    { bodyLimit: 1024 },
    async (request, reply) => {
      if (request.body !== undefined && request.body !== null && request.body !== '') {
        throw new RouteError('invalid-request', 'reconciliation does not accept a request body');
      }
      if (!gate.accepting || mount.reconciliation === undefined) {
        throw new RouteError('execution-unavailable', 'release execution is unavailable');
      }
      publicationJob(request.params.jobId);
      const job = await mount.reconciliation.reconcile(request.params.jobId);
      return reply.code(202).send({
        ...sanitizeJob(job, scrub),
        statusUrl: `/api/releases/jobs/${encodeURIComponent(job.jobId)}`,
      });
    },
  );

  const publicationJob = (jobId: string): ReleaseJob => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) {
      throw new RouteError('invalid-request', 'invalid release job ID');
    }
    const job = store.readJob(jobId);
    if (job.planId !== null) repository(store.readPlan(job.planId).payload.repository.repositoryId);
    if (job.kind !== 'publish' || job.planId === null) {
      throw new RouteError('attempt-unresolved', 'this job has no publication evidence');
    }
    return job;
  };

  app.get<{ Params: { jobId: string } }>(
    '/api/releases/jobs/:jobId/receipt',
    async (request, reply) => {
      publicationJob(request.params.jobId);
      if (mount.reconciliation === undefined) {
        throw new RouteError('execution-unavailable', 'release receipt reader is unavailable');
      }
      return reply.type('text/plain; charset=utf-8').send(
        scrub(mount.reconciliation.receipt(request.params.jobId)),
      );
    },
  );

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
    return sanitizeJob(job, scrub);
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
  if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
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
  if (error instanceof ReleaseOwnershipError) {
    return {
      status: 503,
      body: { code: 'execution-unavailable', error: 'release execution is unavailable' },
    };
  }
  if (
    error instanceof RouteError ||
    error instanceof ReleasePreparationError ||
    error instanceof ReleaseApprovalError
  ) {
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
