/**
 * Shared release contract: the one versioned vocabulary that server, browser, CLI and
 * durable records use to describe a release plan, job and receipt.
 *
 * This module holds types and constants only, so browser code can import it as a type-only
 * module. Canonical hashing lives in `releaseDigest.ts` (Node-only).
 */

/** Version of this shared contract. Consumers must reject records they do not support. */
export const RELEASE_CONTRACT_VERSION = 1;

/**
 * Version of the durable state record envelope written under `releases.stateDir`.
 * A reader that does not know this exact version must refuse the record, never migrate it.
 */
export const RELEASE_STATE_SCHEMA_VERSION = 1;

/** Publication target. Only Gitea is supported by this contract version. */
export type ReleaseForge = 'gitea';

/** Forge-qualified repository identity. Numeric ids catch a renamed or re-created repository. */
export interface ReleaseRepositoryIdentity {
  /** Configured release-repository id from the operator allowlist. */
  repositoryId: string;
  forge: ReleaseForge;
  /** Forge base URL without a trailing slash. */
  baseUrl: string;
  owner: string;
  repo: string;
  forgeRepositoryId: number;
  defaultBranch: string;
}

/** Forge-qualified API account identity used for reads and mutations. */
export interface ReleaseAccountIdentity {
  forge: ReleaseForge;
  baseUrl: string;
  login: string;
  forgeUserId: number;
}

/** The Git identity that creates Forge Desk tag objects. */
export interface ReleaseTagger {
  name: string;
  email: string;
}

/** The exact remote default-branch commit the plan was prepared for. */
export interface ReleaseCandidate {
  commit: string;
  branch: string;
}

/** Highest stable version tag before the release, plus every observed stable tag. */
export interface ReleaseBaseline {
  /** Highest canonical stable tag, or null when the repository has none. */
  tag: string | null;
  /** Peeled commit of `tag`, or null when there is no baseline. */
  commit: string | null;
  /** Observed canonical stable tags, sorted ascending. */
  stableTags: string[];
}

/** The designated successful push run bound into the plan. */
export interface ReleaseCiEvidence {
  /** Configured designated workflow path. */
  workflowPath: string;
  runId: number;
  headCommit: string;
  branch: string;
  event: 'push';
  status: 'completed';
  conclusion: 'success';
}

/** Full release notes, exactly as they will be published. */
export interface ReleaseNotes {
  /** Exact UTF-8 text; never formatted or translated for display. */
  text: string;
  /** sha256 hex of the UTF-8 bytes of `text`. */
  digest: string;
  source: 'file' | 'commit-subjects';
}

/** Normalized remote tag/release classification (section 8 of the source specification). */
export type ReleaseRemoteState = 'absent' | 'exact' | 'conflict' | 'unknown';

export interface ReleaseTagObservation {
  state: ReleaseRemoteState;
  name: string;
  /** Commit the tag resolves to, or null when unavailable. */
  commit: string | null;
  /** Annotated tag object id, when one exists or has been prepared. */
  objectId: string | null;
  /**
   * Tagger recorded by an observed annotated tag object. An existing compatible tag keeps its
   * actual tagger, so a pre-existing tag is never attributed to the configured tagger.
   */
  tagger: ReleaseTagger | null;
}

/**
 * The planned immutable tag content a remote tag must match to be `exact`.
 *
 * An existing compatible tag does not have to claim the configured tagger, so no tagger is
 * expected here. `objectId` is the frozen prepared tag object, when the plan already has one.
 */
export interface ReleaseTagExpectation {
  name: string;
  /** Planned candidate commit the annotated tag must target. */
  commit: string;
  /** Exact annotation message the planned tag object records, without its trailing newline. */
  message: string;
  objectId: string | null;
}

/** The planned immutable release content a remote release must match to be `exact`. */
export interface ReleaseObjectExpectation {
  tag: string;
  title: string;
  /** sha256 hex of the exact notes bytes the release body must carry. */
  notesDigest: string;
}

export interface ReleaseObservation {
  state: ReleaseRemoteState;
  tag: string | null;
  title: string | null;
  /** sha256 of the observed release body bytes, to compare with the notes digest. */
  notesDigest: string | null;
  draft: boolean | null;
  prerelease: boolean | null;
  /** Observed release author login. Never attributed to the current job. */
  author: string | null;
  /** Assets attached to the observed release, or null when the response did not prove the set. */
  assets: number | null;
}

/** A remote mutation the approved plan permits. */
export interface ReleaseIntendedAction {
  kind: 'create-tag' | 'create-release';
  tag: string;
}

/** A plan warning. `code` is a stable machine code chosen by the producing slice. */
export interface ReleasePlanWarning {
  code: string;
  message: string;
}

/**
 * The structured, immutable approval content of one release plan.
 *
 * This object is hashed with the repository's canonical convention; a change to any field
 * changes the plan digest. It therefore contains no secrets and no volatile observation
 * timestamps: approval deadlines and read times are stored beside the payload, not inside it.
 * Configured policy enters the payload through `ci.workflowPath` (the designated pipeline) and
 * `tagger` (the tag identity). Ordering of array fields (such as `baseline.stableTags` and
 * `actions`) is part of the content, so producers must emit them in a stable order.
 */
export interface ReleasePlanPayload {
  contractVersion: number;
  stateSchemaVersion: number;
  repository: ReleaseRepositoryIdentity;
  account: ReleaseAccountIdentity;
  /** Frozen non-secret configuration; legacy plans remain readable but cannot execute writes. */
  configurationDigest?: string;
  tagger: ReleaseTagger;
  candidate: ReleaseCandidate;
  baseline: ReleaseBaseline;
  ci: ReleaseCiEvidence;
  notes: ReleaseNotes;
  title: string;
  tagName: string;
  actions: ReleaseIntendedAction[];
  warnings: ReleasePlanWarning[];
  /** Preparation blockers. Absent in older schema-1 plans, which predate preparation. */
  blockers?: ReleasePlanWarning[];
  tag: ReleaseTagObservation;
  release: ReleaseObservation;
  /** Original attempt and current branch head sealed into a newly reviewed recovery plan. */
  recovery?: { jobId: string; defaultBranchHead: string; tagCreatedAt: string };
}

/** One immutable plan: its identifiers, server-owned approval deadline and structured payload. */
export interface ReleasePlan {
  planId: string;
  /** sha256 hex of the structured payload, computed by the server (`releasePlanDigest`). */
  digest: string;
  /** ISO timestamp after which the plan no longer accepts approval. Not approval content. */
  approvalDeadline: string;
  /** Frozen tag creation time for newly prepared objects; absent on pre-preparation schema-1 plans. */
  preparedAt?: string;
  payload: ReleasePlanPayload;
}

/** Durable job states. The remote classification is tracked separately in `ReleaseJob.remote`. */
export type ReleaseJobState =
  'queued' | 'running' | 'complete' | 'blocked' | 'needs-inspection' | 'internal-error';

/** Current step of a job, tracked separately from its state. Null before the job starts. */
export type ReleaseJobStep =
  | 'verifying-identity'
  | 'reading-candidate'
  | 'reading-ci'
  | 'deriving-metadata'
  | 'verifying-approval'
  | 'creating-tag'
  | 'observing-tag'
  | 'creating-release'
  | 'observing-release'
  | 'reconciling'
  | 'recording-receipt'
  | 'finished';

export type ReleaseJobKind = 'prepare' | 'publish' | 'reconcile';

/** Independently observed remote state of the job's tag and release objects. */
export interface ReleaseRemoteClassification {
  tag: ReleaseRemoteState;
  release: ReleaseRemoteState;
}

export interface ReleaseJob {
  jobId: string;
  kind: ReleaseJobKind;
  /** Plan the job belongs to; null while a preparation plan does not exist yet. */
  planId: string | null;
  /** Digest of the stored plan; null until preparation has produced a plan. */
  planDigest: string | null;
  state: ReleaseJobState;
  step: ReleaseJobStep | null;
  /** Remote truth, which can stay `exact` while a storage failure makes the job `internal-error`. */
  remote: ReleaseRemoteClassification;
  errorCode: ReleaseErrorCode | null;
  /** Sanitized preparation failure detail, absent in older schema-1 jobs. */
  blocker?: ReleasePlanWarning;
  /** Reconciliation jobs name their original publication; publications name their latest receipt. */
  publicationJobId?: string;
  reconciliationJobId?: string;
}

/**
 * Durable approval intent: one authenticated operator's acceptance of one stored plan.
 *
 * It is written exclusively before the first remote mutation, so an interrupted attempt still
 * shows what was approved. One intent exists per plan; a duplicate approval returns its job.
 */
export interface ReleaseIntent {
  intentId: string;
  planId: string;
  planDigest: string;
  /** Durable job created for this approval. */
  jobId: string;
  /** Authenticated application operator/approver identity, not the forge or SSH identity. */
  operator: string;
  approvedActions: ReleaseIntendedAction[];
  /** ISO timestamp of acceptance. */
  approvedAt: string;
  contractVersion: number;
  stateSchemaVersion: number;
}

/**
 * One durable observation recorded while a job runs: what independent reads saw at a step.
 *
 * `observedAt` is volatile read time, which is why it can never enter a plan digest.
 */
export interface ReleaseStepObservation {
  observationId: string;
  jobId: string;
  step: ReleaseJobStep;
  remote: ReleaseRemoteClassification;
  observedAt: string;
}

/** Durable receipt identity and outcome. The full receipt body belongs to the storage slice. */
export interface ReleaseReceipt {
  receiptId: string;
  jobId: string;
  planId: string;
  planDigest: string;
  contractVersion: number;
  stateSchemaVersion: number;
  state: ReleaseJobState;
  remote: ReleaseRemoteClassification;
  errorCode: ReleaseErrorCode | null;
  /** Additive schema-1 evidence; legacy receipts remain readable. */
  evidence?: {
    publicationJobId: string;
    operator: string | null;
    approvedAt: string | null;
    observedAt: string;
    interruptedStep: ReleaseJobStep | null;
    tag: ReleaseTagObservation;
    release: ReleaseObservation;
    instruction: string;
  };
}

/** Stable machine error codes shared by release routes, jobs, receipts and the CLI. */
export type ReleaseErrorCode =
  | 'invalid-request'
  | 'not-authenticated'
  | 'origin-rejected'
  | 'not-found'
  | 'evidence-too-large'
  | 'plan-stale'
  | 'repository-busy'
  | 'repository-ineligible'
  | 'attempt-unresolved'
  | 'plan-expired'
  | 'internal-error'
  | 'execution-unavailable';

/** HTTP status for each stable error code (section 10 of the source specification). */
export const RELEASE_ERROR_HTTP_STATUS: Record<ReleaseErrorCode, number> = {
  'invalid-request': 400,
  'not-authenticated': 401,
  'origin-rejected': 403,
  'not-found': 404,
  'evidence-too-large': 400,
  'plan-stale': 409,
  'repository-busy': 409,
  'repository-ineligible': 409,
  'attempt-unresolved': 409,
  'plan-expired': 410,
  'internal-error': 500,
  'execution-unavailable': 503,
};
