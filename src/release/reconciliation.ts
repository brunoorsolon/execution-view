import { randomUUID } from 'node:crypto';
import { contentHash } from '../core/hash.js';
import {
  RELEASE_CONTRACT_VERSION,
  RELEASE_STATE_SCHEMA_VERSION,
  type ReleaseJob,
  type ReleaseObservation,
  type ReleaseReceipt,
  type ReleaseTagObservation,
} from '../core/release.js';
import { repositoryOperationKey } from '../service/releaseOwnership.js';
import { createReleaseCheckout } from './checkout.js';
import { createReleaseForgeClient } from './forgeClient.js';
import { verifyReleaseIdentity } from './identity.js';
import { observeReleaseRemoteState } from './remoteState.js';
import { activePublications, attemptReceipt, publicationIntent } from './attempts.js';
import { ReleasePreparationError, type ReleasePreparationOptions } from './preparation.js';

const INSPECT =
  'Inspect the original plan, approval intent and receipt. Resolve identity, access or conflicting remote evidence, then reconcile again (reads only). Do not retry publication or modify remote objects automatically.';
const ARTIFACT =
  'Receipt finalization failed. Keep the original plan and intent; restore private durable storage and reconcile again (reads only). Remote exactness is not durable success.';

/** Remote reads only. Every invocation has its own immutable receipt; no queued write is run. */
export class ReleaseReconciliation {
  private readonly pending = new Map<string, Promise<ReleaseJob>>();

  constructor(private readonly options: ReleasePreparationOptions) {
    if (
      options.ownership.stateDir !== options.runtime.stateDir ||
      options.store.stateDir !== options.runtime.stateDir
    ) {
      throw new ReleasePreparationError('execution-unavailable', 'release state owners disagree');
    }
  }

  async reconcileInterrupted(): Promise<void> {
    const jobs = activePublications(this.options.store).filter((job) => job.state !== 'complete');
    await Promise.all(jobs.map((job) => this.reconcile(job.jobId)));
  }

  reconcile(jobId: string): Promise<ReleaseJob> {
    const pending = this.pending.get(jobId);
    if (pending !== undefined) return pending;
    const result = this.inspect(jobId).finally(() => this.pending.delete(jobId));
    this.pending.set(jobId, result);
    return result;
  }

  private async inspect(jobId: string): Promise<ReleaseJob> {
    const { ownership, store } = this.options;
    const original = store.readJob(jobId);
    if (original.kind !== 'publish' || original.planId === null) {
      throw new ReleasePreparationError(
        'attempt-unresolved',
        'Publication has no recoverable plan. Inspect the durable job and restore its original plan before reconciliation.',
      );
    }
    const plan = store.readPlan(original.planId);
    return ownership.runExclusive(plan.payload.repository, () => this.reconcileAdmitted(jobId));
  }

  /** Internal engine entry: caller must already hold this repository's admitted ownership operation. */
  async reconcileAdmitted(jobId: string): Promise<ReleaseJob> {
    const { config, runtime, store } = this.options;
    const publication = store.readJob(jobId);
    if (publication.kind !== 'publish' || publication.planId === null) {
      throw new ReleasePreparationError(
        'attempt-unresolved',
        'publication has no recoverable plan',
      );
    }
    const plan = store.readPlan(publication.planId);
    let job: ReleaseJob = {
      jobId: `reconcile-${randomUUID()}`,
      kind: 'reconcile',
      publicationJobId: jobId,
      planId: plan.planId,
      planDigest: plan.digest,
      state: 'running',
      step: 'reconciling',
      remote: { tag: 'unknown', release: 'unknown' },
      errorCode: null,
    };
    store.writeJob(job);
    let tag: ReleaseTagObservation = {
      state: 'unknown',
      name: plan.payload.tagName,
      commit: null,
      objectId: null,
      tagger: null,
    };
    let release: ReleaseObservation = {
      state: 'unknown',
      tag: null,
      title: null,
      notesDigest: null,
      draft: null,
      prerelease: null,
      author: null,
      assets: null,
    };
    let instruction = INSPECT;
    try {
      const intent = publicationIntent(store, publication, plan);
      const configured = runtime.repositories.find(
        (entry) => entry.config.id === plan.payload.repository.repositoryId,
      );
      if (configured === undefined) throw new Error('repository is no longer configured');
      const identity = await verifyReleaseIdentity({
        config,
        runtime,
        repositoryId: configured.config.id,
        ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
      });
      if (!identity.ok) throw new Error('identity cannot be verified');
      if (
        contentHash(identity.identity.repository) !== contentHash(plan.payload.repository) ||
        contentHash(identity.identity.account) !== contentHash(plan.payload.account)
      ) {
        throw new Error('identity changed');
      }
      const observation = await observeReleaseRemoteState({
        repository: identity.identity.repository,
        checkout: createReleaseCheckout({
          stateDir: runtime.stateDir,
          repository: configured.config,
          identity: identity.identity,
        }),
        forge: createReleaseForgeClient({
          baseUrl: plan.payload.repository.baseUrl,
          token: configured.token,
          ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
        }),
        tag: {
          name: plan.payload.tagName,
          commit: plan.payload.candidate.commit,
          message: plan.payload.tagName,
          objectId: plan.payload.tag.objectId,
        },
        release: {
          tag: plan.payload.tagName,
          title: plan.payload.title,
          notesDigest: plan.payload.notes.digest,
        },
      });
      tag = observation.tag;
      release = observation.release;
      const exact = tag.state === 'exact' && release.state === 'exact';
      const missing = ['absent', 'exact'].includes(tag.state) && release.state === 'absent';
      const trusted = intent !== undefined;
      instruction = !trusted
        ? `Approval intent is missing. ${INSPECT}`
        : exact
          ? 'Exact tag and release were independently verified at this observation. No writes were replayed. Prepare re-inspects remote state; this receipt does not promise permanent immutability.'
          : missing
            ? 'Prepare a fresh recovery plan for the original version, candidate, tag and notes, then review and approve its new digest before any missing effect. The original candidate must remain reachable from the default branch. Late remote effects can still race with recovery.'
            : `${observation.reasons.map((reason) => reason.message).join(' ')} ${INSPECT}`;
      if (publication.step === 'creating-tag') {
        instruction = `${publication.blocker?.message ?? 'Tag push was attempted; its response was not durably recorded.'} ${instruction}`;
      }
      job = {
        ...job,
        state: trusted && exact ? 'complete' : missing && trusted ? 'blocked' : 'needs-inspection',
        remote: { tag: tag.state, release: release.state },
        errorCode: trusted && exact ? null : 'attempt-unresolved',
      };
      store.writeObservation({
        observationId: `observation-${randomUUID()}`,
        jobId: job.jobId,
        step: 'reconciling',
        remote: job.remote,
        observedAt: new Date().toISOString(),
      });
      const receipt: ReleaseReceipt = {
        receiptId: `receipt-${job.jobId}`,
        jobId: job.jobId,
        planId: plan.planId,
        planDigest: plan.digest,
        contractVersion: RELEASE_CONTRACT_VERSION,
        stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION,
        state: job.state,
        remote: job.remote,
        errorCode: job.errorCode,
        evidence: {
          publicationJobId: jobId,
          operator: intent?.operator ?? null,
          approvedAt: intent?.approvedAt ?? null,
          observedAt: new Date().toISOString(),
          interruptedStep: publication.step,
          tag,
          release,
          instruction,
        },
      };
      store.writeReceipt(receipt);
      job = {
        ...job,
        step: 'finished',
        blocker: { code: job.errorCode ?? 'verified-no-op', message: instruction },
      };
      store.writeJob(job);
      // Only a durable receipt may advance the original publication, including exact/no-op.
      store.writeJob({
        ...publication,
        state: job.state,
        step: 'finished',
        remote: job.remote,
        errorCode: job.errorCode,
        reconciliationJobId: job.jobId,
        blocker: job.blocker!,
      });
    } catch {
      job = {
        ...job,
        state: 'internal-error',
        step: 'finished',
        remote: { tag: tag.state, release: release.state },
        errorCode: 'internal-error',
        blocker: {
          code: 'internal-error',
          message: tag.state === 'unknown' && release.state === 'unknown' ? INSPECT : ARTIFACT,
        },
      };
      try {
        store.writeJob(job);
        store.writeJob({
          ...publication,
          state: 'internal-error',
          errorCode: 'internal-error',
          remote: job.remote,
          blocker: job.blocker!,
          reconciliationJobId: job.jobId,
        });
      } catch {
        // Intent survives; queued/running/old state never authorizes replay or success.
      }
    }
    return job;
  }

  /** Human-readable output joins immutable plan/intent with the latest structured receipt. */
  receipt(jobId: string): string {
    const { store } = this.options;
    const job = store.readJob(jobId);
    if (job.kind !== 'publish' || job.planId === null) throw new Error('not a publication');
    const plan = store.readPlan(job.planId);
    let receipt: ReleaseReceipt | undefined;
    try {
      receipt = attemptReceipt(store, job);
    } catch {
      // Do not print malformed or mismatched receipt content as verified evidence.
    }
    const p = plan.payload;
    return [
      `Publication ${job.jobId}; plan ${plan.planId}; digest ${plan.digest}`,
      `${repositoryOperationKey(p.repository)}; candidate ${p.candidate.commit}; version ${p.tagName}; title ${p.title}`,
      `API ${p.account.login} (${p.account.forgeUserId}); configured tagger ${p.tagger.name} <${p.tagger.email}>; CI run ${p.ci.runId}`,
      `Plan actions: ${p.actions.map((action) => action.kind).join(', ') || 'none'}`,
      `Outcome ${job.state}; tag ${job.remote.tag}; release ${job.remote.release}`,
      receipt?.evidence === undefined
        ? (job.blocker?.message ??
          'Receipt unavailable. Inspect durable intent and reconcile again (reads only).')
        : `Operator ${receipt.evidence.operator ?? 'unproven'}; approved ${receipt.evidence.approvedAt ?? 'unproven'}; observed ${receipt.evidence.observedAt}\nInterrupted step ${receipt.evidence.interruptedStep ?? 'not recorded'}\nObserved tagger ${receipt.evidence.tag.tagger?.name ?? 'unavailable'}; release author ${receipt.evidence.release.author ?? 'unavailable'}\n${receipt.evidence.instruction}`,
      `Notes digest ${p.notes.digest}\n${p.notes.text}`,
    ].join('\n\n');
  }
}
