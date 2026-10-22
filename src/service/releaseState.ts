import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, join } from 'node:path';
import { contentHash } from '../core/hash.js';
import {
  RELEASE_CONTRACT_VERSION,
  RELEASE_STATE_SCHEMA_VERSION,
  type ReleaseErrorCode,
  type ReleaseIntent,
  type ReleaseJob,
  type ReleaseJobKind,
  type ReleaseJobState,
  type ReleaseJobStep,
  type ReleaseNotes,
  type ReleasePlan,
  type ReleaseReceipt,
  type ReleaseRemoteState,
  type ReleaseStepObservation,
} from '../core/release.js';
import { releasePlanDigest } from '../core/releaseDigest.js';

/**
 * Durable release state under `releases.stateDir`.
 *
 * Plans, jobs, approval intents, step observations and receipts are separate records with their
 * own identifiers, so one attempt can never overwrite another's evidence. Creation is exclusive;
 * updates replace only their own record through a same-directory rename, with the file and its
 * directory synchronized before the write reports success. Reads verify the private directory
 * chain, the envelope schema version and content digest, the shared-contract record shape, the
 * record identities and the plan digests, and refuse anything they cannot prove.
 */

export type ReleaseStateErrorCode =
  | 'invalid-id'
  | 'unsafe-path'
  | 'unsafe-owner'
  | 'unsafe-permissions'
  | 'unsafe-content'
  | 'unsupported-schema'
  | 'malformed-record'
  | 'digest-mismatch'
  | 'already-exists'
  | 'not-found'
  | 'read-failed'
  | 'write-failed';

/** A refused or failed state operation. `code` is stable so callers can report it safely. */
export class ReleaseStateError extends Error {
  readonly code: ReleaseStateErrorCode;

  constructor(code: ReleaseStateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReleaseStateError';
    this.code = code;
  }
}

type RecordKind = 'plan' | 'job' | 'intent' | 'observation' | 'receipt';

/** One directory per record kind, so unrelated evidence never shares a file name. */
const RECORD_DIR: Record<RecordKind, string> = {
  plan: 'plans',
  job: 'jobs',
  intent: 'intents',
  observation: 'observations',
  receipt: 'receipts',
};

/** The filesystem envelope around every record body. */
interface StoredRecord {
  stateSchemaVersion: number;
  kind: RecordKind;
  /** sha256 hex of the canonical JSON of `body`, so a rewritten body is detectable. */
  recordDigest: string;
  body: unknown;
}

export interface ReleaseStateStoreOptions {
  /** Private state directory validated at startup by `loadReleaseRuntime` (#85). */
  stateDir: string;
  /** Owner to require, defaulting to the real runtime user; overridable for tests. */
  uid?: () => number | undefined;
  /** File/directory synchronization, defaulting to `fsyncSync`; overridable for failure tests. */
  fsync?: (fd: number) => void;
}

/** A file name component that cannot escape its record directory. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Keys that would put a credential or raw subprocess stream into durable evidence. */
const FORBIDDEN_KEY =
  /token|password|authorization|private[-_]?key|secret|api[-_]?key|access[-_]?key|credential|stdout|stderr/i;

const FORBIDDEN_VALUE = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bauthorization\s*[:=]\s*\S+/i,
  // Credential-bearing URL: userinfo that carries a password, which no record may retain.
  /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+:[^\s/?#@]+@/i,
  // HTTP userinfo is always authentication material; SSH keeps its plain `ssh://git@host` form.
  /https?:\/\/[^\s/?#@]+@/i,
  // A query parameter that names a credential carries it, which is the same leak as userinfo.
  /[?&][^=\s#&]*(?:token|secret|password|api[-_]?key|access[-_]?key|signature|credential)[^=\s#&]*=/i,
];

/**
 * Every permitted value of each shared-contract union. `Record<Union, true>` makes the compiler
 * reject a forgotten or unknown member, so these lists cannot drift from the contract types.
 */
const JOB_KINDS: Record<ReleaseJobKind, true> = {
  prepare: true,
  publish: true,
  reconcile: true,
};
const JOB_STATES: Record<ReleaseJobState, true> = {
  queued: true,
  running: true,
  complete: true,
  blocked: true,
  'needs-inspection': true,
  'internal-error': true,
};
const JOB_STEPS: Record<ReleaseJobStep, true> = {
  'verifying-identity': true,
  'reading-candidate': true,
  'reading-ci': true,
  'deriving-metadata': true,
  'verifying-approval': true,
  'creating-tag': true,
  'observing-tag': true,
  'creating-release': true,
  'observing-release': true,
  reconciling: true,
  'recording-receipt': true,
  finished: true,
};
const REMOTE_STATES: Record<ReleaseRemoteState, true> = {
  absent: true,
  exact: true,
  conflict: true,
  unknown: true,
};
const ERROR_CODES: Record<ReleaseErrorCode, true> = {
  'invalid-request': true,
  'not-authenticated': true,
  'origin-rejected': true,
  'not-found': true,
  'evidence-too-large': true,
  'plan-stale': true,
  'repository-busy': true,
  'repository-ineligible': true,
  'attempt-unresolved': true,
  'plan-expired': true,
  'internal-error': true,
  'execution-unavailable': true,
};
const NOTES_SOURCES: Record<ReleaseNotes['source'], true> = {
  file: true,
  'commit-subjects': true,
};
const ACTION_KINDS: Record<'create-tag' | 'create-release', true> = {
  'create-tag': true,
  'create-release': true,
};

function runtimeUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function describe(info: Stats): string {
  return `uid ${info.uid}, mode 0${(info.mode & 0o777).toString(8)}`;
}

/** Percent-decode a string (twice) so encoded parameter names cannot hide a credential. */
function decodePercent(text: string): string {
  let decoded = text;
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
  return decoded;
}

function malformed(message: string): ReleaseStateError {
  return new ReleaseStateError('malformed-record', message);
}

/** Reject a body that would persist a credential, key material or unsanitized process output. */
function assertSafeContent(value: unknown, key = 'record', depth = 0): void {
  if (depth > 64) {
    throw new ReleaseStateError('unsafe-content', `${key}: nested too deeply to verify safely`);
  }
  if (typeof value === 'string') {
    const decoded = decodePercent(value);
    if (FORBIDDEN_VALUE.some((pattern) => pattern.test(value) || pattern.test(decoded))) {
      throw new ReleaseStateError('unsafe-content', `${key}: contains credential material`);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeContent(item, `${key}[${index}]`, depth + 1));
    return;
  }
  for (const [name, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(name)) {
      throw new ReleaseStateError(
        'unsafe-content',
        `${key}.${name}: durable records may not carry credentials or raw process output`,
      );
    }
    assertSafeContent(child, `${key}.${name}`, depth + 1);
  }
}

function assertId(kind: RecordKind, id: unknown): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new ReleaseStateError(
      'invalid-id',
      `${kind} record id ${JSON.stringify(id)} is not usable as a record file name`,
    );
  }
  return id;
}

// --- structural record validation ------------------------------------------------------

function objectAt(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed(`${at}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(obj: Record<string, unknown>, field: string, at: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value === '') {
    throw malformed(`${at}.${field}: expected a non-empty string`);
  }
  return value;
}

function nullableStringAt(obj: Record<string, unknown>, field: string, at: string): string | null {
  const value = obj[field];
  if (value !== null && typeof value !== 'string') {
    throw malformed(`${at}.${field}: expected a string or null`);
  }
  return value;
}

function numberAt(obj: Record<string, unknown>, field: string, at: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw malformed(`${at}.${field}: expected a finite number`);
  }
  return value;
}

function nullableBooleanAt(
  obj: Record<string, unknown>,
  field: string,
  at: string,
): boolean | null {
  const value = obj[field];
  if (value !== null && typeof value !== 'boolean') {
    throw malformed(`${at}.${field}: expected a boolean or null`);
  }
  return value;
}

function hexAt(obj: Record<string, unknown>, field: string, at: string): string {
  const value = stringAt(obj, field, at);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw malformed(`${at}.${field}: expected a sha256 hex digest`);
  }
  return value;
}

function nullableHexAt(obj: Record<string, unknown>, field: string, at: string): string | null {
  const value = obj[field];
  if (value === null) return null;
  return hexAt(obj, field, at);
}

function enumAt<T extends string>(
  permitted: Record<T, true>,
  obj: Record<string, unknown>,
  field: string,
  at: string,
): T {
  const value = obj[field];
  if (typeof value !== 'string' || !Object.hasOwn(permitted, value)) {
    throw malformed(`${at}.${field}: ${JSON.stringify(value)} is not a permitted value`);
  }
  return value as T;
}

function listAt(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw malformed(`${at}: expected an array`);
  return value;
}

function checkRemote(
  value: unknown,
  at: string,
): { tag: ReleaseRemoteState; release: ReleaseRemoteState } {
  const remote = objectAt(value, at);
  return {
    tag: enumAt(REMOTE_STATES, remote, 'tag', at),
    release: enumAt(REMOTE_STATES, remote, 'release', at),
  };
}

function checkActions(value: unknown, at: string): void {
  if (!Array.isArray(value)) throw malformed(`${at}.actions: expected an array`);
  value.forEach((action, index) => {
    const entry = objectAt(action, `${at}.actions[${index}]`);
    enumAt(ACTION_KINDS, entry, 'kind', `${at}.actions[${index}]`);
    stringAt(entry, 'tag', `${at}.actions[${index}]`);
  });
}

function checkVersions(obj: Record<string, unknown>, at: string): void {
  const contractVersion = numberAt(obj, 'contractVersion', at);
  if (contractVersion !== RELEASE_CONTRACT_VERSION) {
    throw new ReleaseStateError(
      'unsupported-schema',
      `${at}: contract version ${contractVersion} is not supported`,
    );
  }
  const stateSchemaVersion = numberAt(obj, 'stateSchemaVersion', at);
  if (stateSchemaVersion !== RELEASE_STATE_SCHEMA_VERSION) {
    throw new ReleaseStateError(
      'unsupported-schema',
      `${at}: state schema version ${stateSchemaVersion} is not supported`,
    );
  }
}

/** The shared-contract shape of a full release plan, checked before storing or returning it. */
function checkPlanBody(body: Record<string, unknown>): void {
  const at = 'plan';
  hexAt(body, 'digest', at);
  stringAt(body, 'approvalDeadline', at);
  if (body.preparedAt !== undefined) {
    const preparedAt = Date.parse(stringAt(body, 'preparedAt', at));
    if (
      !Number.isFinite(preparedAt) ||
      Date.parse(body.approvalDeadline as string) !== preparedAt + 30 * 60_000
    ) {
      throw malformed('plan: preparation time and 30-minute deadline do not agree');
    }
  }
  const payload = objectAt(body.payload, `${at}.payload`);
  checkVersions(payload, `${at}.payload`);
  const repository = objectAt(payload.repository, `${at}.payload.repository`);
  stringAt(repository, 'repositoryId', `${at}.payload.repository`);
  enumAt({ gitea: true }, repository, 'forge', `${at}.payload.repository`);
  stringAt(repository, 'baseUrl', `${at}.payload.repository`);
  stringAt(repository, 'owner', `${at}.payload.repository`);
  stringAt(repository, 'repo', `${at}.payload.repository`);
  numberAt(repository, 'forgeRepositoryId', `${at}.payload.repository`);
  stringAt(repository, 'defaultBranch', `${at}.payload.repository`);
  const account = objectAt(payload.account, `${at}.payload.account`);
  enumAt({ gitea: true }, account, 'forge', `${at}.payload.account`);
  stringAt(account, 'baseUrl', `${at}.payload.account`);
  stringAt(account, 'login', `${at}.payload.account`);
  numberAt(account, 'forgeUserId', `${at}.payload.account`);
  const tagger = objectAt(payload.tagger, `${at}.payload.tagger`);
  stringAt(tagger, 'name', `${at}.payload.tagger`);
  stringAt(tagger, 'email', `${at}.payload.tagger`);
  const candidate = objectAt(payload.candidate, `${at}.payload.candidate`);
  stringAt(candidate, 'commit', `${at}.payload.candidate`);
  stringAt(candidate, 'branch', `${at}.payload.candidate`);
  const baseline = objectAt(payload.baseline, `${at}.payload.baseline`);
  nullableStringAt(baseline, 'tag', `${at}.payload.baseline`);
  nullableStringAt(baseline, 'commit', `${at}.payload.baseline`);
  listAt(baseline.stableTags, `${at}.payload.baseline.stableTags`).forEach((tag, index) => {
    if (typeof tag !== 'string') throw malformed(`${at}.payload.baseline.stableTags[${index}]`);
  });
  const ci = objectAt(payload.ci, `${at}.payload.ci`);
  stringAt(ci, 'workflowPath', `${at}.payload.ci`);
  numberAt(ci, 'runId', `${at}.payload.ci`);
  stringAt(ci, 'headCommit', `${at}.payload.ci`);
  stringAt(ci, 'branch', `${at}.payload.ci`);
  enumAt({ push: true }, ci, 'event', `${at}.payload.ci`);
  enumAt({ completed: true }, ci, 'status', `${at}.payload.ci`);
  enumAt({ success: true }, ci, 'conclusion', `${at}.payload.ci`);
  const notes = objectAt(payload.notes, `${at}.payload.notes`);
  stringAt(notes, 'text', `${at}.payload.notes`);
  hexAt(notes, 'digest', `${at}.payload.notes`);
  enumAt(NOTES_SOURCES, notes, 'source', `${at}.payload.notes`);
  stringAt(payload, 'title', `${at}.payload`);
  stringAt(payload, 'tagName', `${at}.payload`);
  checkActions(payload.actions, `${at}.payload`);
  listAt(payload.warnings, `${at}.payload.warnings`).forEach((warning, index) => {
    const entry = objectAt(warning, `${at}.payload.warnings[${index}]`);
    stringAt(entry, 'code', `${at}.payload.warnings[${index}]`);
    stringAt(entry, 'message', `${at}.payload.warnings[${index}]`);
  });
  if (payload.blockers !== undefined) {
    listAt(payload.blockers, `${at}.payload.blockers`).forEach((blocker, index) => {
      const entry = objectAt(blocker, `${at}.payload.blockers[${index}]`);
      stringAt(entry, 'code', `${at}.payload.blockers[${index}]`);
      stringAt(entry, 'message', `${at}.payload.blockers[${index}]`);
    });
  }
  if (payload.recovery !== undefined) {
    const recovery = objectAt(payload.recovery, 'plan.payload.recovery');
    assertId('job', stringAt(recovery, 'jobId', 'plan.payload.recovery'));
    const createdAt = stringAt(recovery, 'tagCreatedAt', 'plan.payload.recovery');
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw malformed('recovery tag creation time is invalid');
    }
    const head = stringAt(recovery, 'defaultBranchHead', 'plan.payload.recovery');
    if (!/^[0-9a-f]{40}$/.test(head)) throw malformed('recovery branch head is invalid');
  }
  checkObjectObservations(payload);
}

function checkObjectObservations(payload: Record<string, unknown>): void {
  const at = 'evidence';
  const tag = objectAt(payload.tag, `${at}.payload.tag`);
  enumAt(REMOTE_STATES, tag, 'state', `${at}.payload.tag`);
  stringAt(tag, 'name', `${at}.payload.tag`);
  nullableStringAt(tag, 'commit', `${at}.payload.tag`);
  nullableStringAt(tag, 'objectId', `${at}.payload.tag`);
  if (tag.tagger !== null) {
    const tagger = objectAt(tag.tagger, `${at}.payload.tag.tagger`);
    stringAt(tagger, 'name', `${at}.payload.tag.tagger`);
    stringAt(tagger, 'email', `${at}.payload.tag.tagger`);
  }
  const release = objectAt(payload.release, `${at}.payload.release`);
  enumAt(REMOTE_STATES, release, 'state', `${at}.payload.release`);
  nullableStringAt(release, 'tag', `${at}.payload.release`);
  nullableStringAt(release, 'title', `${at}.payload.release`);
  nullableHexAt(release, 'notesDigest', `${at}.payload.release`);
  nullableBooleanAt(release, 'draft', `${at}.payload.release`);
  nullableBooleanAt(release, 'prerelease', `${at}.payload.release`);
  nullableStringAt(release, 'author', `${at}.payload.release`);
  if (
    release.assets !== null &&
    (typeof release.assets !== 'number' ||
      !Number.isSafeInteger(release.assets) ||
      release.assets < 0)
  ) {
    throw malformed(`${at}.payload.release.assets: expected a non-negative integer or null`);
  }
}

function checkJobBody(job: ReleaseJob): void {
  const body = objectAt(job, 'job');
  const at = `job ${String(body.jobId)}`;
  stringAt(body, 'jobId', 'job');
  enumAt(JOB_KINDS, body, 'kind', at);
  nullableStringAt(body, 'planId', at);
  nullableHexAt(body, 'planDigest', at);
  enumAt(JOB_STATES, body, 'state', at);
  const step = body.step;
  if (step !== null) enumAt(JOB_STEPS, body, 'step', at);
  checkRemote(body.remote, `${at}.remote`);
  if (body.errorCode !== null) enumAt(ERROR_CODES, body, 'errorCode', at);
  for (const field of ['publicationJobId', 'reconciliationJobId']) {
    if (body[field] !== undefined) assertId('job', stringAt(body, field, at));
  }
  if (body.blocker !== undefined) {
    const blocker = objectAt(body.blocker, `${at}.blocker`);
    stringAt(blocker, 'code', `${at}.blocker`);
    stringAt(blocker, 'message', `${at}.blocker`);
  }
}

function checkIntentBody(intent: ReleaseIntent): void {
  const body = objectAt(intent, 'intent');
  const at = `intent ${String(body.intentId)}`;
  stringAt(body, 'intentId', 'intent');
  stringAt(body, 'planId', at);
  hexAt(body, 'planDigest', at);
  stringAt(body, 'jobId', at);
  stringAt(body, 'operator', at);
  checkActions(body.approvedActions, at);
  stringAt(body, 'approvedAt', at);
  checkVersions(body, at);
}

function checkObservationBody(observation: ReleaseStepObservation): void {
  const body = objectAt(observation, 'observation');
  const at = `observation ${String(body.observationId)}`;
  stringAt(body, 'observationId', 'observation');
  stringAt(body, 'jobId', at);
  enumAt(JOB_STEPS, body, 'step', at);
  checkRemote(body.remote, `${at}.remote`);
  stringAt(body, 'observedAt', at);
}

function checkReceiptBody(receipt: ReleaseReceipt): void {
  const body = objectAt(receipt, 'receipt');
  const at = `receipt ${String(body.receiptId)}`;
  stringAt(body, 'receiptId', 'receipt');
  stringAt(body, 'jobId', at);
  stringAt(body, 'planId', at);
  hexAt(body, 'planDigest', at);
  checkVersions(body, at);
  enumAt(JOB_STATES, body, 'state', at);
  checkRemote(body.remote, `${at}.remote`);
  if (body.errorCode !== null) enumAt(ERROR_CODES, body, 'errorCode', at);
  if (body.evidence !== undefined) {
    const evidence = objectAt(body.evidence, `${at}.evidence`);
    assertId('job', stringAt(evidence, 'publicationJobId', at));
    nullableStringAt(evidence, 'operator', at);
    nullableStringAt(evidence, 'approvedAt', at);
    stringAt(evidence, 'observedAt', at);
    if (evidence.interruptedStep !== null) enumAt(JOB_STEPS, evidence, 'interruptedStep', at);
    stringAt(evidence, 'instruction', at);
    checkObjectObservations(evidence);
    const tag = objectAt(evidence.tag, 'receipt.tag');
    const release = objectAt(evidence.release, 'receipt.release');
    const remote = checkRemote(body.remote, at);
    if (tag.state !== remote.tag || release.state !== remote.release) {
      throw malformed('receipt observations contradict classification');
    }
  }
}

export class ReleaseStateStore {
  readonly stateDir: string;
  private readonly uid: () => number | undefined;
  private readonly fsync: (fd: number) => void;

  constructor(options: ReleaseStateStoreOptions) {
    this.stateDir = options.stateDir;
    this.uid = options.uid ?? runtimeUid;
    this.fsync = options.fsync ?? fsyncSync;
    this.ensureRoot();
  }

  // --- plans: immutable approval content -----------------------------------------------

  writePlan(plan: ReleasePlan): ReleasePlan {
    const planId = assertId('plan', plan.planId);
    checkPlanBody(objectAt(plan, 'plan'));
    this.validatePlan(plan);
    const stored = this.readExisting<ReleasePlan>('plan', planId);
    if (stored !== null) {
      if (contentHash(stored) === contentHash(plan)) {
        this.resync('plan', planId);
        return stored;
      }
      throw new ReleaseStateError(
        'already-exists',
        `plan ${planId}: a different immutable plan is already stored under this id`,
      );
    }
    this.persist('plan', planId, plan, 'create');
    return plan;
  }

  readPlan(planId: string): ReleasePlan {
    const id = assertId('plan', planId);
    const body = objectAt(this.readRecord('plan', id), `plan ${id}`);
    checkPlanBody(body);
    const plan = body as unknown as ReleasePlan;
    if (plan.planId !== id) {
      throw malformed(`plan ${id}: record carries id ${String(plan.planId)}`);
    }
    this.validatePlan(plan);
    return plan;
  }

  // --- jobs: the only mutable record ---------------------------------------------------

  /** Create or replace one job record. Only the job with this exact id is ever replaced. */
  writeJob(job: ReleaseJob): ReleaseJob {
    const jobId = assertId('job', job.jobId);
    checkJobBody(job);
    this.assertJobPlan(job);
    const stored = this.readExisting<ReleaseJob>('job', jobId);
    // A preparation job binds the plan it produces exactly once, and never rebinds afterwards.
    if (stored !== null && stored.planId !== null && stored.planId !== job.planId) {
      throw new ReleaseStateError(
        'already-exists',
        `job ${jobId}: is bound to plan ${String(stored.planId)} and cannot be replaced`,
      );
    }
    this.persist('job', jobId, job, stored === null ? 'create' : 'replace');
    return job;
  }

  readJob(jobId: string): ReleaseJob {
    const id = assertId('job', jobId);
    const body = objectAt(this.readRecord('job', id), `job ${id}`);
    checkJobBody(body as unknown as ReleaseJob);
    const job = body as unknown as ReleaseJob;
    if (job.jobId !== id) {
      throw malformed(`job ${id}: record carries id ${String(job.jobId)}`);
    }
    this.assertJobPlan(job);
    return job;
  }

  /** Enumerate bounded job record names without reading plans or job bodies. */
  listJobIds(): string[] {
    const dir = this.checkRecordDir('job');
    if (dir === null) return [];
    const ids: string[] = [];
    const handle = opendirSync(dir);
    let entries = 0;
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (++entries > 10_000) {
          throw new ReleaseStateError(
            'read-failed',
            'release job history exceeds the 10000-entry safety bound',
          );
        }
        if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) continue;
        if (!entry.name.endsWith('.json')) {
          throw malformed('release job history has an unexpected entry');
        }
        ids.push(assertId('job', entry.name.slice(0, -5)));
      }
    } finally {
      handle.closeSync();
    }
    return ids.sort();
  }

  /** Complete bounded history for safety decisions; never silently skips malformed evidence. */
  listJobs(): ReleaseJob[] {
    return this.listJobIds().map((jobId) => this.readJob(jobId));
  }

  /** A job names a plan only together with that plan's digest, and it must match the stored plan. */
  private assertJobPlan(job: ReleaseJob): void {
    if (job.planId === null) {
      if (job.planDigest !== null) {
        throw malformed(`job ${job.jobId}: carries a plan digest without a plan`);
      }
      return;
    }
    if (job.planDigest === null) {
      throw malformed(`job ${job.jobId}: names plan ${String(job.planId)} without its digest`);
    }
    this.assertPlanBinding(job.planId, job.planDigest);
  }

  // --- approval intents: one per plan, written before any remote mutation --------------

  writeIntent(intent: ReleaseIntent): ReleaseIntent {
    const planId = assertId('plan', intent.planId);
    assertId('intent', intent.intentId);
    checkIntentBody(intent);
    this.assertPlanBinding(planId, intent.planDigest);
    const stored = this.readExisting<ReleaseIntent>('intent', planId);
    if (stored !== null) {
      if (contentHash(stored) === contentHash(intent)) {
        this.resync('intent', planId);
        return stored;
      }
      throw new ReleaseStateError(
        'already-exists',
        `plan ${planId}: an approval intent is already stored and is not this one`,
      );
    }
    this.persist('intent', planId, intent, 'create');
    return intent;
  }

  readIntent(planId: string): ReleaseIntent {
    const id = assertId('plan', planId);
    const body = objectAt(this.readRecord('intent', id), `intent for plan ${id}`);
    checkIntentBody(body as unknown as ReleaseIntent);
    const intent = body as unknown as ReleaseIntent;
    if (intent.planId !== id) {
      throw malformed(`intent ${id}: record carries plan ${String(intent.planId)}`);
    }
    this.assertPlanBinding(id, intent.planDigest);
    return intent;
  }

  // --- step observations: append-only, one record per observation ---------------------

  writeObservation(observation: ReleaseStepObservation): ReleaseStepObservation {
    const observationId = assertId('observation', observation.observationId);
    assertId('job', observation.jobId);
    checkObservationBody(observation);
    const stored = this.readExisting<ReleaseStepObservation>('observation', observationId);
    if (stored !== null) {
      if (contentHash(stored) === contentHash(observation)) {
        this.resync('observation', observationId);
        return stored;
      }
      throw new ReleaseStateError(
        'already-exists',
        `observation ${observationId}: a different observation is already stored under this id`,
      );
    }
    this.persist('observation', observationId, observation, 'create');
    return observation;
  }

  readObservation(observationId: string): ReleaseStepObservation {
    const id = assertId('observation', observationId);
    const body = objectAt(this.readRecord('observation', id), `observation ${id}`);
    checkObservationBody(body as unknown as ReleaseStepObservation);
    const observation = body as unknown as ReleaseStepObservation;
    if (observation.observationId !== id) {
      throw malformed(`observation ${id}: record carries id ${String(observation.observationId)}`);
    }
    return observation;
  }

  // --- receipts: one finalization record per job --------------------------------------

  /** Write the receipt once. A failure here leaves the stored intent as the recovery record. */
  writeReceipt(receipt: ReleaseReceipt): ReleaseReceipt {
    const jobId = assertId('job', receipt.jobId);
    assertId('receipt', receipt.receiptId);
    checkReceiptBody(receipt);
    this.assertPlanBinding(assertId('plan', receipt.planId), receipt.planDigest);
    const stored = this.readExisting<ReleaseReceipt>('receipt', jobId);
    if (stored !== null) {
      if (contentHash(stored) === contentHash(receipt)) {
        this.resync('receipt', jobId);
        return stored;
      }
      throw new ReleaseStateError(
        'already-exists',
        `job ${jobId}: a receipt is already stored and is not this one`,
      );
    }
    this.persist('receipt', jobId, receipt, 'create');
    return receipt;
  }

  readReceipt(jobId: string): ReleaseReceipt {
    const id = assertId('job', jobId);
    const body = objectAt(this.readRecord('receipt', id), `receipt for job ${id}`);
    checkReceiptBody(body as unknown as ReleaseReceipt);
    const receipt = body as unknown as ReleaseReceipt;
    if (receipt.jobId !== id) {
      throw malformed(`receipt ${id}: record carries job ${String(receipt.jobId)}`);
    }
    this.assertPlanBinding(assertId('plan', receipt.planId), receipt.planDigest);
    return receipt;
  }

  // --- shared validation --------------------------------------------------------------

  private validatePlan(plan: ReleasePlan): void {
    const payload = plan?.payload;
    if (typeof plan?.digest !== 'string' || typeof payload !== 'object' || payload === null) {
      throw malformed('plan: expected a digest and payload');
    }
    let digest: string;
    try {
      digest = releasePlanDigest(payload);
    } catch (error) {
      throw new ReleaseStateError('digest-mismatch', `plan ${plan.planId}: ${String(error)}`, {
        cause: error,
      });
    }
    if (digest !== plan.digest) {
      throw new ReleaseStateError(
        'digest-mismatch',
        `plan ${plan.planId}: stored digest does not describe its payload`,
      );
    }
  }

  /** Intent and receipt must name the plan the store actually holds, by digest. */
  private assertPlanBinding(planId: string, planDigest: string): void {
    const plan = this.readPlan(planId);
    if (plan.digest !== planDigest) {
      throw new ReleaseStateError(
        'digest-mismatch',
        `plan ${planId}: record digest does not match the stored plan`,
      );
    }
  }

  // --- filesystem ---------------------------------------------------------------------

  /** The state directory itself: a real private directory owned by the runtime user. */
  private ensureRoot(): void {
    let info: Stats;
    try {
      info = lstatSync(this.stateDir);
    } catch (error) {
      throw new ReleaseStateError('unsafe-path', `state directory ${this.stateDir} is not usable`, {
        cause: error,
      });
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ReleaseStateError(
        'unsafe-path',
        `state directory ${this.stateDir} must be a real directory, not a link or file`,
      );
    }
    this.assertOwnership(this.stateDir, info);
    if ((info.mode & 0o077) !== 0) {
      throw new ReleaseStateError(
        'unsafe-permissions',
        `state directory ${this.stateDir} (${describe(info)}) is accessible to group or others`,
      );
    }
  }

  private assertOwnership(file: string, info: Stats): void {
    const uid = this.uid();
    if (uid !== undefined && info.uid !== uid) {
      throw new ReleaseStateError(
        'unsafe-owner',
        `${file} (${describe(info)}) is not owned by the runtime user (uid ${uid})`,
      );
    }
  }

  /**
   * Validate one record directory, creating nothing. Reading and writing both check the chain,
   * so a substituted directory cannot redirect existing evidence.
   */
  private checkRecordDir(kind: RecordKind): string | null {
    this.ensureRoot();
    const dir = join(this.stateDir, RECORD_DIR[kind]);
    let info: Stats | null = null;
    try {
      info = lstatSync(dir);
    } catch {
      info = null;
    }
    if (info === null) return null;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ReleaseStateError('unsafe-path', `${dir} must be a real directory`);
    }
    this.assertOwnership(dir, info);
    if ((info.mode & 0o077) !== 0) {
      throw new ReleaseStateError(
        'unsafe-permissions',
        `${dir} (${describe(info)}) is accessible to group or others`,
      );
    }
    return dir;
  }

  private ensureRecordDir(kind: RecordKind): string {
    const existing = this.checkRecordDir(kind);
    if (existing !== null) return existing;
    const dir = join(this.stateDir, RECORD_DIR[kind]);
    try {
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
    } catch (error) {
      throw new ReleaseStateError('write-failed', `could not create ${dir}`, { cause: error });
    }
    return dir;
  }

  /** Inspect one private record file without following a substitution. */
  private inspectRecord(file: string): Stats | null {
    let info: Stats;
    try {
      info = lstatSync(file);
    } catch {
      return null;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ReleaseStateError('unsafe-path', `${file} must be a regular file, not a link`);
    }
    this.assertOwnership(file, info);
    if ((info.mode & 0o077) !== 0) {
      throw new ReleaseStateError(
        'unsafe-permissions',
        `${file} (${describe(info)}) is accessible to group or others`,
      );
    }
    return info;
  }

  /** Read a stored record, or null when it does not exist yet. */
  private readExisting<T>(kind: RecordKind, id: string): T | null {
    try {
      return this.readRecord<T>(kind, id);
    } catch (error) {
      if (error instanceof ReleaseStateError && error.code === 'not-found') return null;
      throw error;
    }
  }

  private readRecord<T>(kind: RecordKind, id: string): T {
    const dir = this.checkRecordDir(kind);
    if (dir === null) {
      throw new ReleaseStateError('not-found', `${kind} record ${id} does not exist`);
    }
    const file = join(dir, `${id}.json`);
    if (this.inspectRecord(file) === null) {
      throw new ReleaseStateError('not-found', `${kind} record ${id} does not exist`);
    }
    let raw: string;
    try {
      // O_NOFOLLOW closes the gap where a record file is swapped for a link after the check.
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        raw = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new ReleaseStateError('unsafe-path', `${file} must be a regular file, not a link`);
      }
      throw new ReleaseStateError('read-failed', `could not read ${file}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ReleaseStateError('malformed-record', `${file} is not valid JSON`, {
        cause: error,
      });
    }
    const envelope = objectAt(parsed, file) as Partial<StoredRecord>;
    if (envelope.stateSchemaVersion !== RELEASE_STATE_SCHEMA_VERSION) {
      throw new ReleaseStateError(
        'unsupported-schema',
        `${file}: state schema version ${JSON.stringify(envelope.stateSchemaVersion)} is not supported`,
      );
    }
    if (envelope.kind !== kind) {
      throw malformed(`${file} holds a ${String(envelope.kind)} record, not a ${kind} record`);
    }
    const body = objectAt(envelope.body, file);
    if (envelope.recordDigest !== contentHash(body)) {
      throw new ReleaseStateError('digest-mismatch', `${file} does not match its record digest`);
    }
    return body as T;
  }

  /**
   * Re-establish file and directory durability for an already stored record before reporting
   * success again, so a retry cannot claim success that a failed earlier synchronization denied.
   */
  private resync(kind: RecordKind, id: string): void {
    const dir = this.checkRecordDir(kind);
    const file = dir === null ? null : join(dir, `${id}.json`);
    if (dir === null || file === null || this.inspectRecord(file) === null) {
      throw new ReleaseStateError('not-found', `${kind} record ${id} does not exist`);
    }
    try {
      const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        this.fsync(fd);
      } finally {
        closeSync(fd);
      }
      this.syncDirectory(dir);
      // The record directory's own entry must be durable too, including one created earlier.
      this.syncDirectory(this.stateDir);
    } catch (error) {
      if (error instanceof ReleaseStateError) throw error;
      throw new ReleaseStateError('write-failed', `could not synchronize ${kind} record ${id}`, {
        cause: error,
      });
    }
  }

  private persist(kind: RecordKind, id: string, body: unknown, mode: 'create' | 'replace'): void {
    assertSafeContent(body, `${kind} ${id}`);
    const envelope: StoredRecord = {
      stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION,
      kind,
      recordDigest: contentHash(body),
      body,
    };
    const text = `${JSON.stringify(envelope)}\n`;
    try {
      const dir = this.ensureRecordDir(kind);
      const file = join(dir, `${id}.json`);
      if (mode === 'replace' && this.inspectRecord(file) === null) {
        throw new ReleaseStateError('not-found', `cannot replace missing ${kind} record ${id}`);
      }
      if (mode === 'create') this.writeExclusive(file, dir, text);
      else this.writeAtomic(file, dir, text);
      this.syncDirectory(dir);
      // Establish the record directory's entry as well, even when it already existed.
      this.syncDirectory(this.stateDir);
    } catch (error) {
      if (error instanceof ReleaseStateError) throw error;
      throw new ReleaseStateError(
        (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'already-exists' : 'write-failed',
        `could not store ${kind} record ${id}`,
        { cause: error },
      );
    }
  }

  /**
   * Exclusive creation: the complete bytes are linked into place, which fails if the name is
   * taken, so a crash leaves either no record or the whole record and never replaces a record.
   */
  private writeExclusive(file: string, dir: string, text: string): void {
    const temp = this.writeTemp(dir, file, text);
    try {
      linkSync(temp, file);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // The temporary file never became the record.
      }
    }
  }

  /** Same-directory replacement, so the record holds either the old or the new bytes. */
  private writeAtomic(file: string, dir: string, text: string): void {
    const temp = this.writeTemp(dir, file, text);
    try {
      renameSync(temp, file);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // The temporary file never became the record.
      }
      throw error;
    }
  }

  /** A synchronized 0600 copy of `text` beside `file`, named so it can never be read as a record. */
  private writeTemp(dir: string, file: string, text: string): string {
    const temp = join(dir, `.${basename(file)}.${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, text);
      this.fsync(fd);
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        // The temporary file never became the record.
      }
      throw error;
    }
    closeSync(fd);
    return temp;
  }

  private syncDirectory(dir: string): void {
    const fd = openSync(dir, 'r');
    try {
      this.fsync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
