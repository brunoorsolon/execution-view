import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import { contentHash } from '../core/hash.js';
import {
  RELEASE_CONTRACT_VERSION,
  RELEASE_STATE_SCHEMA_VERSION,
  type ReleaseErrorCode,
  type ReleaseIntent,
  type ReleaseJob,
  type ReleasePlan,
} from '../core/release.js';
import {
  ReleaseOwnership,
  ReleaseOwnershipError,
  repositoryOperationKey,
} from '../service/releaseOwnership.js';
import { ReleaseStateError, ReleaseStateStore } from '../service/releaseState.js';
import { activePublications, attemptReceipt, recoverable, samePublication } from './attempts.js';
import { releaseConfigurationDigest } from './configuration.js';
import type { ReleasePublication } from './publication.js';

export interface ReleaseApprovalOptions {
  config: AppConfig;
  runtime: ReleaseRuntime;
  ownership: ReleaseOwnership;
  store: ReleaseStateStore;
  /** Only newly durable approvals start execution; retries and startup never replay writes. */
  publication?: Pick<ReleasePublication, 'execute'>;
}

export class ReleaseApprovalError extends Error {
  constructor(
    readonly code: ReleaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReleaseApprovalError';
  }
}

function optional<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof ReleaseStateError && error.code === 'not-found') return undefined;
    throw error;
  }
}

/** Durable admission, optionally connected to publication by the server. Retries never execute. */
export class ReleaseApproval {
  constructor(private readonly options: ReleaseApprovalOptions) {
    if (
      options.store.stateDir !== options.runtime.stateDir ||
      options.ownership.stateDir !== options.runtime.stateDir
    ) {
      throw new ReleaseApprovalError('execution-unavailable', 'release state owners disagree');
    }
  }

  /**
   * The transport supplies authenticatedOperator from its verified application login, never
   * from request data. The request contains only the stored plan ID and reviewed digest.
   * A returned job is accepted, not published; retries never enqueue or resume execution.
   */
  async approve(request: unknown, authenticatedOperator: string | null): Promise<ReleaseJob> {
    const { config, ownership, store } = this.options;
    if (
      typeof authenticatedOperator !== 'string' ||
      authenticatedOperator.trim() === '' ||
      authenticatedOperator.length > 256 ||
      /[\x00-\x1f\x7f]/.test(authenticatedOperator) ||
      authenticatedOperator !== config.server.basicAuth?.username
    ) {
      throw new ReleaseApprovalError(
        'not-authenticated',
        'approval requires the application login',
      );
    }
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      throw new ReleaseApprovalError('invalid-request', 'approval requires a plan ID and digest');
    }
    const input = request as Record<string, unknown>;
    const { planId, digest } = input;
    if (
      Object.keys(input).some((key) => key !== 'planId' && key !== 'digest') ||
      typeof planId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(planId) ||
      typeof digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(digest)
    ) {
      throw new ReleaseApprovalError(
        'invalid-request',
        'approval requires a valid plan ID and digest',
      );
    }
    try {
      const plan = optional(() => store.readPlan(planId));
      if (plan === undefined) throw new ReleaseApprovalError('not-found', 'unknown release plan');
      return await ownership.runExclusive(plan.payload.repository, async () => {
        if (!ownership.accepting) {
          throw new ReleaseApprovalError(
            'execution-unavailable',
            'release execution is unavailable',
          );
        }
        // Read again under the same gate used by preparation and future execution.
        const stored = store.readPlan(planId);
        if (stored.digest !== digest) {
          throw new ReleaseApprovalError('plan-stale', 'the digest does not match the stored plan');
        }
        const intent = optional(() => store.readIntent(planId));
        if (intent !== undefined) return this.existing(stored, intent);
        assertReleasePlanEligible(stored, this.options);
        const jobs = activePublications(store);
        let recoveryFound = false;
        for (const job of jobs) {
          if (job.kind !== 'publish') continue;
          if (job.planId === null) {
            throw new ReleaseApprovalError(
              'attempt-unresolved',
              'publication evidence needs inspection',
            );
          }
          const previous = store.readPlan(job.planId);
          if (
            repositoryOperationKey(previous.payload.repository) !==
            repositoryOperationKey(stored.payload.repository)
          ) {
            continue;
          }
          const receipt = attemptReceipt(store, job);
          if (stored.payload.recovery?.jobId === job.jobId) {
            if (
              job.state !== 'blocked' ||
              !recoverable(receipt) ||
              !samePublication(previous, stored)
            ) {
              throw new ReleaseApprovalError(
                'attempt-unresolved',
                'the original recovery evidence changed; reconcile and prepare again',
              );
            }
            recoveryFound = true;
            continue;
          }
          if (job.planId === planId || job.state !== 'complete') {
            throw new ReleaseApprovalError(
              'attempt-unresolved',
              'a prior publication needs inspection',
            );
          }
          if (
            receipt?.state !== 'complete' ||
            receipt.planId !== job.planId ||
            receipt.remote.tag !== 'exact' ||
            receipt.remote.release !== 'exact'
          ) {
            throw new ReleaseApprovalError(
              'attempt-unresolved',
              'publication completion needs inspection',
            );
          }
          if (
            previous.payload.tagName === stored.payload.tagName &&
            stored.payload.actions.length > 0
          ) {
            throw new ReleaseApprovalError(
              'plan-stale',
              'this version already has a completed publication',
            );
          }
        }
        if (stored.payload.recovery !== undefined && !recoveryFound) {
          throw new ReleaseApprovalError(
            'attempt-unresolved',
            'recovery no longer names the active original attempt',
          );
        }
        const approvedAt = new Date().toISOString();
        if (Date.parse(approvedAt) >= Date.parse(stored.approvalDeadline)) {
          throw new ReleaseApprovalError('plan-expired', 'the plan approval deadline has passed');
        }
        const job: ReleaseJob = {
          jobId: `publish-${randomUUID()}`,
          kind: 'publish',
          planId,
          planDigest: digest,
          state: 'needs-inspection',
          step: 'verifying-approval',
          remote: { tag: stored.payload.tag.state, release: stored.payload.release.state },
          errorCode: 'attempt-unresolved',
        };
        // Reserve the job before intent: any interrupted admission blocks later publication.
        store.writeJob(job);
        store.writeIntent({
          intentId: `intent-${randomUUID()}`,
          planId,
          planDigest: digest,
          jobId: job.jobId,
          operator: authenticatedOperator,
          approvedActions: structuredClone(stored.payload.actions),
          approvedAt,
          contractVersion: RELEASE_CONTRACT_VERSION,
          stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION,
        });
        // Replacement can be visible even when its directory sync fails.
        try {
          const accepted = store.writeJob({ ...job, state: 'queued', step: null, errorCode: null });
          // Execution queues behind this repository gate and survives the HTTP connection.
          void this.options.publication?.execute(accepted.jobId).catch(() => undefined);
          return accepted;
        } catch (error) {
          try {
            store.writeJob(job);
          } catch {
            // Uncertain storage cannot admit more work; restart requires read-only reconciliation.
            void ownership.shutdown().catch(() => undefined);
          }
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof ReleaseApprovalError) throw error;
      if (error instanceof ReleaseOwnershipError) {
        throw new ReleaseApprovalError('execution-unavailable', 'release execution is unavailable');
      }
      throw new ReleaseApprovalError(
        'internal-error',
        'approval evidence could not be safely persisted or read',
      );
    }
  }

  private existing(plan: ReleasePlan, intent: ReleaseIntent): ReleaseJob {
    const { store } = this.options;
    const job = store.readJob(intent.jobId);
    const accepted = Date.parse(intent.approvedAt);
    if (
      job.kind !== 'publish' ||
      job.planId !== plan.planId ||
      job.planDigest !== plan.digest ||
      intent.planDigest !== plan.digest ||
      !Number.isFinite(accepted) ||
      plan.preparedAt === undefined ||
      accepted < Date.parse(plan.preparedAt) ||
      accepted >= Date.parse(plan.approvalDeadline) ||
      contentHash(intent.approvedActions) !== contentHash(plan.payload.actions)
    ) {
      throw new ReleaseApprovalError(
        'attempt-unresolved',
        'stored approval evidence needs inspection',
      );
    }
    // A visible record may follow a failed directory sync. Re-establish durability, not execution.
    store.writeIntent(intent);
    return store.writeJob(job);
  }
}

/** Shared admission/execution policy check; expiry applies to acceptance, not an accepted job. */
export function assertReleasePlanEligible(
  plan: ReleasePlan,
  { config, runtime }: Pick<ReleaseApprovalOptions, 'config' | 'runtime'>,
): void {
  const { payload } = plan;
  const configured = runtime.repositories.find(
    (entry) => entry.config.id === payload.repository.repositoryId,
  )?.config;
  const source = config.sources.find((entry) => entry.id === configured?.source);
  if (!config.releases.enabled || configured === undefined || source?.kind !== 'gitea') {
    throw new ReleaseApprovalError(
      'repository-ineligible',
      'the release repository is unavailable',
    );
  }
  if (
    !config.releases.repositories.some(
      (entry) => entry.id === configured.id && contentHash(entry) === contentHash(configured),
    ) ||
    source.baseUrl !== payload.repository.baseUrl ||
    configured.repo.owner !== payload.repository.owner ||
    configured.repo.repo !== payload.repository.repo ||
    configured.expectedApiUser !== payload.account.login ||
    configured.ci.workflowPath !== payload.ci.workflowPath ||
    contentHash(configured.tagger) !== contentHash(payload.tagger) ||
    payload.configurationDigest !== releaseConfigurationDigest(configured, source.baseUrl)
  ) {
    throw new ReleaseApprovalError(
      'plan-stale',
      'release repository configuration changed since preparation (push origin, SSH credentials/trust, API credential selector, CI policy or tagger); prepare a new plan',
    );
  }
  if (
    plan.preparedAt === undefined ||
    !Number.isFinite(Date.parse(plan.preparedAt)) ||
    Date.parse(plan.preparedAt) > Date.now() ||
    Date.parse(plan.approvalDeadline) !== Date.parse(plan.preparedAt) + 30 * 60_000 ||
    payload.blockers === undefined ||
    payload.blockers.length > 0 ||
    !['absent', 'exact'].includes(payload.tag.state) ||
    !['absent', 'exact'].includes(payload.release.state) ||
    (payload.tag.state === 'absent' && payload.release.state === 'exact') ||
    payload.tag.objectId === null
  ) {
    throw new ReleaseApprovalError(
      'repository-ineligible',
      'the stored plan is not eligible for approval',
    );
  }
  const actions = [
    ...(payload.tag.state === 'absent' ? [{ kind: 'create-tag', tag: payload.tagName }] : []),
    ...(payload.release.state === 'absent'
      ? [{ kind: 'create-release', tag: payload.tagName }]
      : []),
  ];
  if (contentHash(actions) !== contentHash(payload.actions)) {
    throw new ReleaseApprovalError(
      'repository-ineligible',
      'the stored plan actions are inconsistent',
    );
  }
}
