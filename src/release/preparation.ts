/**
 * Read-only preparation, shared by future HTTP/CLI callers. `prepare` durably admits a job and
 * returns before its reads finish. Work belongs to the state owner, not the request connection.
 * Inspect the job and its immutable plan through the store. There is no publication interface.
 */
import { randomUUID } from 'node:crypto';
import type { AppConfig, ResolvedReleaseRepository } from '../config/schema.js';
import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import { contentHash } from '../core/hash.js';
import {
  RELEASE_CONTRACT_VERSION,
  RELEASE_STATE_SCHEMA_VERSION,
  type ReleaseErrorCode,
  type ReleaseJob,
  type ReleasePlan,
  type ReleasePlanPayload,
  type ReleasePlanWarning,
} from '../core/release.js';
import { releasePlanDigest } from '../core/releaseDigest.js';
import {
  ReleaseOwnership,
  repositoryOperationKey,
  type ReleaseRepositoryKey,
} from '../service/releaseOwnership.js';
import { ReleaseStateError, ReleaseStateStore } from '../service/releaseState.js';
import { createReleaseCheckout } from './checkout.js';
import { discoverReleaseCi } from './ci.js';
import { createReleaseForgeClient, type ReleaseForgeFetch } from './forgeClient.js';
import { verifyReleaseIdentity } from './identity.js';
import { deriveReleaseMetadata, type ReleaseMetadata, type ObservedTag } from './metadata.js';
import { observeReleaseRemoteState } from './remoteState.js';

export interface ReleasePreparationOptions {
  config: AppConfig;
  runtime: ReleaseRuntime;
  ownership: ReleaseOwnership;
  store: ReleaseStateStore;
  fetch?: ReleaseForgeFetch;
}

export class ReleasePreparationError extends Error {
  constructor(
    readonly code: ReleaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReleasePreparationError';
  }
}

class Blocked extends Error {
  constructor(
    readonly blocker: ReleasePlanWarning,
    readonly code: ReleaseErrorCode = 'repository-ineligible',
  ) {
    super(blocker.message);
  }
}

function value<T>(result: { ok: true; value: T } | { ok: false; blocker: ReleasePlanWarning }): T {
  if (!result.ok) throw new Blocked(result.blocker);
  return result.value;
}

/** Job prefixes retain repository membership even before a plan exists, without changing schema 1. */
function prefix(key: ReleaseRepositoryKey): string {
  return `prepare-${contentHash(repositoryOperationKey(key)).slice(0, 32)}-`;
}

function stableTags(tags: ObservedTag[]): ObservedTag[] {
  return tags
    .filter(
      (tag) =>
        tag.name.length <= 128 &&
        /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag.name),
    )
    .sort((left, right) => {
      const a = left.name.slice(1).split('.').map(BigInt);
      const b = right.name.slice(1).split('.').map(BigInt);
      for (let i = 0; i < 3; i++) {
        if (a[i]! < b[i]!) return -1;
        if (a[i]! > b[i]!) return 1;
      }
      return 0;
    });
}

export class ReleasePreparation {
  private readonly pending = new Map<string, Promise<ReleaseJob>>();

  constructor(private readonly options: ReleasePreparationOptions) {
    if (
      options.ownership.stateDir !== options.runtime.stateDir ||
      options.store.stateDir !== options.runtime.stateDir
    ) {
      throw new ReleasePreparationError(
        'execution-unavailable',
        'release state and execution owner disagree',
      );
    }
  }

  /** Only an allowlisted ID enters; no candidate, notes, digest, path or cancellation signal does. */
  prepare(repositoryId: string): Promise<ReleaseJob> {
    const { config, runtime, ownership } = this.options;
    const configured = runtime.repositories.find(
      (entry) => entry.config.id === repositoryId,
    )?.config;
    const source = config.sources.find((entry) => entry.id === configured?.source);
    if (configured === undefined || source?.kind !== 'gitea' || source.baseUrl === undefined) {
      return Promise.reject(new ReleasePreparationError('not-found', 'unknown release repository'));
    }
    if (!ownership.accepting) {
      return Promise.reject(
        new ReleasePreparationError(
          'execution-unavailable',
          'release execution is not accepting work',
        ),
      );
    }
    const existing = this.pending.get(repositoryId);
    if (existing !== undefined) return existing;
    const key: ReleaseRepositoryKey = {
      forge: 'gitea',
      baseUrl: source.baseUrl,
      owner: configured.repo.owner,
      repo: configured.repo.repo,
    };
    let resolve!: (job: ReleaseJob) => void;
    let reject!: (error: Error) => void;
    const admitted = new Promise<ReleaseJob>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.pending.set(repositoryId, admitted);
    try {
      void ownership
        .runExclusive(key, async () => {
          const { store } = this.options;
          // Interrupted preparation is safe to repeat: it had no remote effects or approval.
          const interrupted = store
            .listJobs()
            .find(
              (job) =>
                job.kind === 'prepare' &&
                job.jobId.startsWith(prefix(key)) &&
                job.planId === null &&
                (job.state === 'queued' || job.state === 'running'),
            );
          const job: ReleaseJob = interrupted ?? {
            jobId: `${prefix(key)}${randomUUID()}`,
            kind: 'prepare',
            planId: null,
            planDigest: null,
            state: 'queued',
            step: null,
            remote: { tag: 'unknown', release: 'unknown' },
            errorCode: null,
          };
          store.writeJob(job);
          resolve(structuredClone(job));
          await this.run(configured, key, job);
        })
        .catch(() => {
          reject(
            new ReleasePreparationError(
              'internal-error',
              'release preparation could not be durably admitted',
            ),
          );
        })
        .finally(() => {
          this.pending.delete(repositoryId);
        });
    } catch {
      this.pending.delete(repositoryId);
      reject(
        new ReleasePreparationError(
          'execution-unavailable',
          'release execution gate refused preparation',
        ),
      );
    }
    return admitted;
  }

  private async run(
    configured: ResolvedReleaseRepository,
    key: ReleaseRepositoryKey,
    initial: ReleaseJob,
  ): Promise<void> {
    const { config, runtime, store } = this.options;
    let job = initial;
    const save = (patch: Partial<ReleaseJob>): void => {
      job = { ...job, ...patch };
      store.writeJob(job);
    };
    try {
      save({ state: 'running', step: 'verifying-identity', errorCode: null });
      const identityResult = await verifyReleaseIdentity({
        config,
        runtime,
        repositoryId: configured.id,
        ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      });
      if (!identityResult.ok) throw new Blocked(identityResult.blocker);
      const identity = identityResult.identity;
      const token = runtime.repositories.find((entry) => entry.config.id === configured.id)!.token;
      const forge = createReleaseForgeClient({
        baseUrl: identity.repository.baseUrl,
        token,
        ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      });
      const checkout = createReleaseCheckout({
        stateDir: runtime.stateDir,
        repository: configured,
        identity,
      });
      const priorPlans: ReleasePlan[] = [];
      // Plan identity is known before its write, so a crash between plan and job writes cannot
      // orphan immutable content and silently replace its frozen tag on the next read-only run.
      const ownPlanId = `plan-${job.jobId}`;
      try {
        priorPlans.push(store.readPlan(ownPlanId));
      } catch (error) {
        if (!(error instanceof ReleaseStateError) || error.code !== 'not-found') throw error;
      }
      const completed: ReleasePlan[] = [];
      for (const previous of store.listJobs()) {
        if (previous.planId === null) {
          // A publication without a plan cannot prove which repository it affects.
          if (previous.kind === 'publish') {
            throw new Blocked(
              {
                code: 'attempt-unresolved',
                message: 'a publication has no recoverable plan; inspect it before preparing',
              },
              'attempt-unresolved',
            );
          }
          continue;
        }
        const plan = store.readPlan(previous.planId);
        if (repositoryOperationKey(plan.payload.repository) !== repositoryOperationKey(key)) {
          continue;
        }
        if (previous.kind === 'publish') {
          if (previous.state !== 'complete') {
            throw new Blocked(
              {
                code: 'attempt-unresolved',
                message:
                  'an unresolved publication requires read-only reconciliation before preparation',
              },
              'attempt-unresolved',
            );
          }
          let receipt;
          try {
            receipt = store.readReceipt(previous.jobId);
          } catch {
            throw new Blocked(
              {
                code: 'attempt-unresolved',
                message: 'publication completion has no verified durable receipt',
              },
              'attempt-unresolved',
            );
          }
          if (
            receipt.state !== 'complete' ||
            receipt.planId !== plan.planId ||
            receipt.remote.tag !== 'exact' ||
            receipt.remote.release !== 'exact'
          ) {
            throw new Blocked(
              {
                code: 'attempt-unresolved',
                message: 'publication completion evidence needs inspection',
              },
              'attempt-unresolved',
            );
          }
          completed.push(plan);
        } else if (previous.kind === 'prepare') {
          priorPlans.push(plan);
        }
      }
      save({ step: 'reading-candidate' });
      const candidate = value(await checkout.fetchCandidate());
      const tags = value(await checkout.listRemoteTags());
      const stable = stableTags(tags);
      save({ step: 'reading-ci' });
      const ci = await discoverReleaseCi({
        client: forge,
        identity: identity.repository,
        candidate,
        workflowPath: configured.ci.workflowPath,
        listPaths: (commit) => checkout.listPaths(commit),
      });
      if (!ci.ok) throw new Blocked(ci.blocker);
      save({ step: 'deriving-metadata' });
      // Only the highest stable object's history is needed to prove baseline ancestry.
      const highest = stable.at(-1);
      if (highest !== undefined && value(await checkout.readRemoteTag(highest.name)) === null) {
        throw new Blocked(
          { code: 'plan-stale', message: 'the stable tag set changed during preparation' },
          'plan-stale',
        );
      }
      const recorded = completed.find((plan) => plan.payload.candidate.commit === candidate.commit);
      let metadata: ReleaseMetadata;
      if (recorded !== undefined) {
        const payload = recorded.payload;
        if (
          contentHash(payload.repository) !== contentHash(identity.repository) ||
          payload.candidate.branch !== candidate.branch
        ) {
          throw new Blocked(
            {
              code: 'plan-stale',
              message: 'completed candidate identity changed; inspect its original publication',
            },
            'plan-stale',
          );
        }
        metadata = {
          candidate,
          version: payload.tagName,
          title: payload.title,
          tagMessage: payload.tagName,
          notes: payload.notes,
          baseline: { ...payload.baseline, stableTags: stable.map((tag) => tag.name) },
          otherTags: [],
        };
      } else {
        // Any stable tag at this candidate, not just the highest version, takes precedence.
        const candidateTags = stable.filter((tag) => tag.peeledCommit === candidate.commit);
        if (candidateTags.length > 1) {
          throw new Blocked(
            {
              code: 'attempt-unresolved',
              message: 'multiple candidate versions need original-version inspection',
            },
            'attempt-unresolved',
          );
        }
        const existingTag = candidateTags[0];
        const earlier =
          existingTag === undefined ? tags : stable.slice(0, stable.indexOf(existingTag));
        const previous = existingTag === undefined ? undefined : earlier.at(-1);
        if (previous !== undefined) value(await checkout.readRemoteTag(previous.name));
        metadata = value(await deriveReleaseMetadata({ checkout, candidate, tags: earlier }));
        if (existingTag !== undefined) {
          if (metadata.version !== existingTag.name) {
            throw new Blocked(
              {
                code: 'attempt-unresolved',
                message: 'an existing candidate tag needs original-version inspection',
              },
              'attempt-unresolved',
            );
          }
          metadata = {
            ...metadata,
            baseline: { ...metadata.baseline, stableTags: stable.map((tag) => tag.name) },
          };
        }
      }
      save({ step: 'observing-tag' });
      const observation = await observeReleaseRemoteState({
        repository: identity.repository,
        checkout,
        forge,
        tag: {
          name: metadata.version,
          commit: candidate.commit,
          message: metadata.tagMessage,
          objectId: recorded?.payload.tag.objectId ?? null,
        },
        release: {
          tag: metadata.version,
          title: metadata.title,
          notesDigest: metadata.notes.digest,
        },
      });
      const alreadyTargeted =
        recorded !== undefined || stable.some((tag) => tag.peeledCommit === candidate.commit);
      const blockers: ReleasePlanWarning[] = [...observation.reasons];
      if (
        alreadyTargeted &&
        (observation.tag.state !== 'exact' || observation.release.state !== 'exact')
      ) {
        blockers.push({
          code: 'attempt-unresolved',
          message:
            'existing candidate publication is incomplete; reconcile its original version before preparing',
        });
      }
      const payload: ReleasePlanPayload = {
        contractVersion: RELEASE_CONTRACT_VERSION,
        stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION,
        repository: identity.repository,
        account: identity.account,
        tagger: { ...configured.tagger },
        candidate,
        baseline: metadata.baseline,
        ci: ci.evidence,
        notes: metadata.notes,
        title: metadata.title,
        tagName: metadata.version,
        actions: blockers.length === 0 ? observation.actions : [],
        warnings: [
          {
            code: 'point-in-time',
            message:
              'Remote observations are point-in-time evidence; publication must recheck freshness before any approved change.',
          },
        ],
        blockers,
        tag: observation.tag,
        release: observation.release,
      };
      // Reuse a compatible, unexpired result, preserving its object, creation time and deadline.
      const reusable = priorPlans.find((plan) => {
        if (plan.preparedAt === undefined || Date.parse(plan.approvalDeadline) <= Date.now()) {
          return false;
        }
        const comparable = structuredClone(plan.payload);
        if (comparable.tag.state === 'absent') comparable.tag.objectId = null;
        return contentHash(comparable) === contentHash(payload);
      });
      let plan = reusable;
      if (plan === undefined) {
        const preparedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
        if (payload.tag.state === 'absent' && blockers.length === 0) {
          payload.tag = {
            ...payload.tag,
            objectId: value(
              await checkout.prepareTag(metadata.version, configured.tagger, preparedAt),
            ),
          };
        }
        plan = {
          planId: ownPlanId,
          digest: releasePlanDigest(payload),
          preparedAt,
          approvalDeadline: new Date(Date.parse(preparedAt) + 30 * 60_000).toISOString(),
          payload,
        };
      }
      if (reusable?.payload.tag.state === 'absent') {
        const restored = value(
          await checkout.prepareTag(metadata.version, configured.tagger, reusable.preparedAt!),
        );
        if (restored !== reusable.payload.tag.objectId) {
          throw new Blocked(
            {
              code: 'plan-stale',
              message: 'the frozen prepared tag object could not be restored exactly',
            },
            'plan-stale',
          );
        }
      }
      if (contentHash(value(await checkout.listRemoteTags())) !== contentHash(tags)) {
        throw new Blocked(
          { code: 'plan-stale', message: 'the remote tag set changed during preparation' },
          'plan-stale',
        );
      }
      store.writePlan(plan);
      save({
        planId: plan.planId,
        planDigest: plan.digest,
        remote: { tag: observation.tag.state, release: observation.release.state },
        state: blockers.length === 0 ? 'complete' : 'blocked',
        step: 'finished',
        errorCode:
          blockers.length === 0
            ? null
            : alreadyTargeted
              ? 'attempt-unresolved'
              : 'repository-ineligible',
      });
    } catch (error) {
      const blocked = error instanceof Blocked;
      const detail = blocked
        ? error.blocker
        : {
            code: 'internal-error',
            message:
              'preparation failed to read or persist trusted evidence; inspect the durable job before retrying',
          };
      try {
        save({
          state: blocked ? 'blocked' : 'internal-error',
          step: 'finished',
          errorCode: blocked ? error.code : 'internal-error',
          blocker: detail,
        });
      } catch {
        // Failed finalization leaves queued/running evidence, never a reported success.
        // The next preparation may safely resume these read-only reads.
      }
    }
  }
}
