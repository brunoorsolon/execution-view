import type { ReleaseJob, ReleasePlanWarning } from '../core/release.js';
import { contentHash } from '../core/hash.js';
import { repositoryOperationKey } from '../service/releaseOwnership.js';
import { assertReleasePlanEligible, ReleaseApprovalError } from './approval.js';
import { activePublications, publicationIntent } from './attempts.js';
import { createReleaseTagCheckout } from './checkout.js';
import { verifyReleaseCi } from './ci.js';
import { createReleaseForgeClient, createReleaseForgeWriter } from './forgeClient.js';
import { verifyReleaseIdentity } from './identity.js';
import { ReleasePreparationError, type ReleasePreparationOptions } from './preparation.js';
import { ReleaseReconciliation } from './reconciliation.js';
import { observeReleaseRemoteState } from './remoteState.js';

class Stale extends Error {
  constructor(readonly detail: ReleasePlanWarning) {
    super(detail.message);
  }
}

function value<T>(result: { ok: true; value: T } | { ok: false; blocker: ReleasePlanWarning }): T {
  if (!result.ok) throw new Stale(result.blocker);
  return result.value;
}

/** Engine-only execution. Startup, approval retries and HTTP never call this implicitly. */
export class ReleasePublication {
  constructor(
    private readonly options: ReleasePreparationOptions & {
      /** Shutdown interrupts mutations, never their independent reconciliation reads. */
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ) {
    if (
      options.ownership.stateDir !== options.runtime.stateDir ||
      options.store.stateDir !== options.runtime.stateDir
    ) {
      throw new ReleasePreparationError('execution-unavailable', 'release state owners disagree');
    }
  }

  /** Only a fresh queued approval can execute. Every other state is inspection-only, never replay. */
  async execute(jobId: string): Promise<ReleaseJob> {
    const { store, ownership } = this.options;
    const original = store.readJob(jobId);
    if (original.kind !== 'publish' || original.planId === null) {
      throw new ReleasePreparationError(
        'attempt-unresolved',
        'execution requires an accepted publication',
      );
    }
    const plan = store.readPlan(original.planId);
    await ownership.runExclusive(plan.payload.repository, async () => {
      let inspect = false;
      let job = store.readJob(jobId);
      if (job.state !== 'queued') return;
      const save = (patch: Partial<ReleaseJob>) => {
        job = store.writeJob({ ...job, ...patch });
      };
      const changed = (message: string): never => {
        throw new Stale({ code: 'plan-stale', message });
      };
      try {
        if (!ownership.accepting) changed('Release execution owner is stopping.');
        // Mark consumed before any asynchronous work. A crash can only reconcile, never resume.
        save({ state: 'running', step: 'verifying-approval' });
        const stored = store.readPlan(plan.planId);
        const intent = publicationIntent(store, job, stored);
        if (intent === undefined) changed('Durable approval intent is missing.');
        const { config, runtime } = this.options;
        assertReleasePlanEligible(stored, this.options);
        if (intent!.operator !== config.server.basicAuth?.username) {
          changed('The authenticated application operator changed.');
        }
        for (const active of activePublications(store)) {
          if (active.jobId === jobId) continue;
          if (active.planId === null) changed('Another publication has no recoverable plan.');
          const previous = store.readPlan(active.planId!);
          if (
            repositoryOperationKey(previous.payload.repository) ===
              repositoryOperationKey(plan.payload.repository) &&
            active.state !== 'complete'
          ) {
            changed('Another unresolved publication requires reconciliation.');
          }
        }
        // Freeze inputs across awaited reads; repeat the live policy check before launch.
        const snapshot = { config: structuredClone(config), runtime: structuredClone(runtime) };
        const p = stored.payload;
        const loaded = snapshot.runtime.repositories.find(
          (entry) => entry.config.id === p.repository.repositoryId,
        )!;
        save({ step: 'verifying-identity' });
        const verifyIdentity = async () => {
          const result = await verifyReleaseIdentity({
            ...snapshot,
            repositoryId: p.repository.repositoryId,
            ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
          });
          if (!result.ok) throw new Stale(result.blocker);
          if (contentHash(result.identity.repository) !== contentHash(p.repository)) {
            changed('The forge repository identity or default branch changed.');
          }
          if (contentHash(result.identity.account) !== contentHash(p.account)) {
            changed('The authenticated API account identity changed.');
          }
          return result.identity;
        };
        const verified = await verifyIdentity();
        const checkout = createReleaseTagCheckout({
          stateDir: runtime.stateDir,
          repository: loaded.config,
          identity: verified,
          ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
          ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        });
        const forge = createReleaseForgeClient({
          baseUrl: p.repository.baseUrl,
          token: loaded.token,
          ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
        });
        save({ step: 'reading-candidate' });
        const candidate = value(await checkout.fetchCandidate());
        if (
          candidate.branch !== p.candidate.branch ||
          candidate.commit !== (p.recovery?.defaultBranchHead ?? p.candidate.commit) ||
          !value(await checkout.isAncestor(p.candidate.commit, candidate.commit))
        ) {
          changed('The default-branch candidate or recovery reachability changed.');
        }
        if (p.tag.state === 'absent') {
          const prepared = value(
            await checkout.prepareTag(
              p.tagName,
              p.tagger,
              p.recovery?.tagCreatedAt ?? stored.preparedAt!,
              p.candidate.commit,
            ),
          );
          if (prepared !== p.tag.objectId) changed('The frozen annotated tag object changed.');
        }
        const verifyFreshness = async (tagCreated = false) => {
          save({ step: 'reading-ci' });
          const ci = await verifyReleaseCi({
            client: forge,
            identity: p.repository,
            evidence: p.ci,
            workflowPath: loaded.config.ci.workflowPath,
            listPaths: (commit) => checkout.listPaths(commit),
          });
          if (!ci.ok) throw new Stale(ci.blocker);
          if (p.ci.headCommit !== p.candidate.commit) {
            changed('The bound CI candidate does not match the plan.');
          }
          // Candidate/tree reads can span slow CI or a push; renew identity and branch afterwards.
          await verifyIdentity();
          if (contentHash(value(await checkout.fetchCandidate())) !== contentHash(candidate)) {
            changed('The default-branch candidate changed during freshness checks.');
          }
          const tags = value(await checkout.listRemoteTags());
          const stable = tags.filter(
            (tag) =>
              /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag.name) &&
              !(tagCreated && tag.name === p.tagName),
          );
          if (
            contentHash(stable.map((tag) => tag.name).sort()) !==
              contentHash([...p.baseline.stableTags].sort()) ||
            (p.baseline.tag !== null &&
              stable.find((tag) => tag.name === p.baseline.tag)?.peeledCommit !== p.baseline.commit)
          ) {
            changed('The observed stable tags or baseline target changed.');
          }
        };
        await verifyFreshness();
        save({ step: 'observing-tag' });
        const observe = () =>
          observeReleaseRemoteState({
            repository: p.repository,
            checkout,
            forge,
            tag: {
              name: p.tagName,
              commit: p.candidate.commit,
              message: p.tagName,
              objectId: p.tag.objectId,
            },
            release: { tag: p.tagName, title: p.title, notesDigest: p.notes.digest },
          });
        let observed = await observe();
        const expectedTag = { ...p.tag, ...(p.tag.state === 'absent' ? { objectId: null } : {}) };
        if (
          observed.reasons.length > 0 ||
          contentHash(observed.tag) !== contentHash(expectedTag) ||
          contentHash(observed.release) !== contentHash(p.release)
        ) {
          changed('The reviewed remote tag or release state changed or could not be proved.');
        }
        const beforeMutation = () => {
          assertReleasePlanEligible(store.readPlan(plan.planId), this.options);
          if (intent!.operator !== config.server.basicAuth?.username) {
            changed('The authenticated application operator changed.');
          }
          if (!ownership.accepting || this.options.signal?.aborted) {
            changed('Release execution was interrupted before mutation.');
          }
          // Re-establish approval/intent binding and durability before each remote effect.
          const current = publicationIntent(store, job, store.readPlan(plan.planId));
          if (current === undefined || contentHash(current) !== contentHash(intent)) {
            changed('Durable approval intent changed.');
          }
          store.writeIntent(current!);
        };
        beforeMutation();
        if (p.tag.state !== 'absent') {
          inspect = p.actions.length === 0;
        } else {
          save({
            step: 'creating-tag',
            attemptedEffects: [{ kind: 'create-tag', tag: p.tagName }],
            remote: { tag: 'unknown', release: 'unknown' },
          });
          inspect = true;
          const pushed = await checkout.pushPreparedTag(p.tagName, p.tag.objectId!);
          // Never persist subprocess output or trust a successful response as remote truth.
          save({
            blocker: {
              code: pushed.ok ? 'tag-push-returned' : pushed.blocker.code,
              message: pushed.ok
                ? 'One non-force tag push returned; independent inspection is required.'
                : `One non-force tag push ended with ${pushed.blocker.code}; independent inspection is required.`,
            },
          });
          if (!ownership.accepting || this.options.signal?.aborted) {
            changed('Release execution was interrupted after the tag attempt.');
          }
          await verifyFreshness(true);
          save({ step: 'observing-tag' });
          observed = await observe();
        }
        if (p.actions.some((action) => action.kind === 'create-release')) {
          if (
            observed.tag.state !== 'exact' ||
            observed.release.state !== 'absent' ||
            observed.reasons.length > 0
          ) {
            changed(
              'Release creation requires an independently proved exact tag and authoritative release absence.',
            );
          }
          beforeMutation();
          save({
            step: 'creating-release',
            attemptedEffects: [
              ...(job.attemptedEffects ?? []),
              { kind: 'create-release', tag: p.tagName },
            ],
            remote: { tag: 'exact', release: 'unknown' },
          });
          inspect = true;
          let code = 'release-create-returned';
          try {
            await createReleaseForgeWriter({
              baseUrl: p.repository.baseUrl,
              token: loaded.token,
              ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
              ...(this.options.timeoutMs !== undefined
                ? { timeoutMs: this.options.timeoutMs }
                : {}),
            }).createRelease(
              p.repository,
              { tag: p.tagName, title: p.title, notes: p.notes.text },
              this.options.signal,
            );
          } catch {
            code = 'release-create-uncertain';
          }
          save({
            blocker: {
              code,
              message:
                'One release create request was attempted; only independent remote reads establish its outcome. Never retry this job.',
            },
          });
        }
      } catch (error) {
        const detail =
          error instanceof Stale
            ? error.detail
            : error instanceof ReleaseApprovalError
              ? { code: error.code, message: error.message }
              : {
                  code: 'internal-error',
                  message:
                    'Execution evidence could not be durably read or written. Keep the intent and reconcile (reads only); never replay this job.',
                };
        try {
          save({
            state: detail.code === 'internal-error' ? 'internal-error' : 'blocked',
            errorCode: detail.code === 'internal-error' ? 'internal-error' : 'plan-stale',
            blocker: detail,
          });
        } catch {
          // Durable effect markers and intent remain recovery-visible.
        }
      }
      // Drain inspection with the already-admitted operation, even after shutdown closes admission.
      if (inspect) {
        await new ReleaseReconciliation(this.options).reconcileAdmitted(jobId);
      }
    });
    return store.readJob(jobId);
  }
}
