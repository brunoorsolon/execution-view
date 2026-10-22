import { contentHash } from '../core/hash.js';
import type { ReleaseIntent, ReleaseJob, ReleasePlan, ReleaseReceipt } from '../core/release.js';
import { ReleaseStateError, type ReleaseStateStore } from '../service/releaseState.js';

export function optionalRecord<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof ReleaseStateError && error.code === 'not-found') return undefined;
    throw error;
  }
}

/** Recovery may change observations and freshness evidence, never original publication content. */
export function samePublication(original: ReleasePlan, recovery: ReleasePlan): boolean {
  const fields = (plan: ReleasePlan) => {
    const p = plan.payload;
    return [
      p.repository,
      p.account,
      p.tagger,
      p.candidate,
      p.tagName,
      p.title,
      p.notes,
      p.tag.objectId,
    ];
  };
  return contentHash(fields(original)) === contentHash(fields(recovery));
}

export function attemptReceipt(
  store: ReleaseStateStore,
  job: ReleaseJob,
): ReleaseReceipt | undefined {
  let receiptJobId = job.jobId;
  if (job.reconciliationJobId !== undefined) {
    const reconciliation = store.readJob(job.reconciliationJobId);
    if (
      reconciliation.kind !== 'reconcile' ||
      reconciliation.publicationJobId !== job.jobId ||
      reconciliation.planId !== job.planId ||
      reconciliation.planDigest !== job.planDigest
    ) {
      throw new Error('reconciliation binding is invalid');
    }
    if (reconciliation.state === 'internal-error') return undefined;
    receiptJobId = reconciliation.jobId;
  }
  const receipt = optionalRecord(() => store.readReceipt(receiptJobId));
  if (
    receipt !== undefined &&
    (receipt.planId !== job.planId ||
      receipt.planDigest !== job.planDigest ||
      (job.reconciliationJobId !== undefined && receipt.evidence?.publicationJobId !== job.jobId))
  ) {
    throw new Error('receipt binding is invalid');
  }
  return receipt;
}

export function publicationIntent(
  store: ReleaseStateStore,
  job: ReleaseJob,
  plan: ReleasePlan,
): ReleaseIntent | undefined {
  const intent = optionalRecord(() => store.readIntent(plan.planId));
  if (intent === undefined) return undefined;
  const accepted = Date.parse(intent.approvedAt);
  if (
    intent.jobId !== job.jobId ||
    intent.planDigest !== plan.digest ||
    contentHash(intent.approvedActions) !== contentHash(plan.payload.actions) ||
    plan.preparedAt === undefined ||
    !Number.isFinite(accepted) ||
    accepted < Date.parse(plan.preparedAt) ||
    accepted >= Date.parse(plan.approvalDeadline)
  ) {
    throw new Error('approval evidence is contradictory');
  }
  return intent;
}

/** Only a durably accepted, content-preserving recovery can supersede a prior attempt. */
export function activePublications(store: ReleaseStateStore): ReleaseJob[] {
  const jobs = store.listJobs().filter((job) => job.kind === 'publish');
  const superseded = new Set<string>();
  for (const job of jobs) {
    if (job.planId === null) continue;
    const plan = store.readPlan(job.planId);
    const recovery = plan.payload.recovery;
    if (recovery === undefined) continue;
    const original = jobs.find((entry) => entry.jobId === recovery.jobId);
    const intent = publicationIntent(store, job, plan);
    if (intent === undefined) continue;
    if (
      original?.planId === null ||
      original === undefined ||
      original.jobId === job.jobId ||
      intent.jobId !== job.jobId ||
      intent.planDigest !== job.planDigest ||
      !samePublication(store.readPlan(original.planId), plan)
    ) {
      throw new Error('recovery binding is invalid');
    }
    superseded.add(original.jobId);
  }
  const active = jobs.filter((job) => !superseded.has(job.jobId));
  if (jobs.length > 0 && active.length === 0) throw new Error('cyclic recovery evidence');
  return active;
}

export function recoverable(receipt: ReleaseReceipt | undefined): boolean {
  return (
    receipt?.evidence !== undefined &&
    receipt.state === 'blocked' &&
    receipt.errorCode === 'attempt-unresolved' &&
    receipt.remote.release === 'absent' &&
    ['absent', 'exact'].includes(receipt.remote.tag)
  );
}
