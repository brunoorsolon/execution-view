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
  type ReleaseIntent,
  type ReleaseJob,
  type ReleasePlan,
  type ReleaseReceipt,
  type ReleaseStepObservation,
} from '../core/release.js';
import { releasePlanDigest } from '../core/releaseDigest.js';

/**
 * Durable release state under `releases.stateDir`.
 *
 * Plans, jobs, approval intents, step observations and receipts are separate records with their
 * own identifiers, so one attempt can never overwrite another's evidence. Creation is exclusive;
 * updates replace only their own record through a same-directory rename, with the file and its
 * directory synchronized before the write reports success. Readers verify the envelope schema
 * version and content digest, then the shared-contract identities and plan digests, and refuse
 * anything they cannot prove.
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
];

function runtimeUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function describe(info: Stats): string {
  return `uid ${info.uid}, mode 0${(info.mode & 0o777).toString(8)}`;
}

/** Reject a body that would persist a credential, key material or unsanitized process output. */
function assertSafeContent(value: unknown, key = 'record', depth = 0): void {
  if (depth > 64) {
    throw new ReleaseStateError('unsafe-content', `${key}: nested too deeply to verify safely`);
  }
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.some((pattern) => pattern.test(value))) {
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

function assertContractVersion(record: { contractVersion: number }, where: string): void {
  if (record.contractVersion !== RELEASE_CONTRACT_VERSION) {
    throw new ReleaseStateError(
      'unsupported-schema',
      `${where}: contract version ${String(record.contractVersion)} is not supported`,
    );
  }
}

function assertStateSchemaVersion(version: unknown, where: string): void {
  if (version !== RELEASE_STATE_SCHEMA_VERSION) {
    throw new ReleaseStateError(
      'unsupported-schema',
      `${where}: state schema version ${JSON.stringify(version)} is not supported`,
    );
  }
}

export class ReleaseStateStore {
  private readonly stateDir: string;
  private readonly uid: () => number | undefined;

  constructor(options: ReleaseStateStoreOptions) {
    this.stateDir = options.stateDir;
    this.uid = options.uid ?? runtimeUid;
    this.ensureRoot();
  }

  // --- plans: immutable approval content -----------------------------------------------

  writePlan(plan: ReleasePlan): ReleasePlan {
    const planId = assertId('plan', plan.planId);
    this.validatePlan(plan);
    const stored = this.readExisting<ReleasePlan>('plan', planId);
    if (stored !== null) {
      if (contentHash(stored) === contentHash(plan)) return stored;
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
    const plan = this.readRecord<ReleasePlan>('plan', id);
    this.validatePlan(plan);
    if (plan.planId !== id) {
      throw new ReleaseStateError(
        'malformed-record',
        `plan ${id}: record carries id ${plan.planId}`,
      );
    }
    return plan;
  }

  // --- jobs: the only mutable record ---------------------------------------------------

  /** Create or replace one job record. Only the job with this exact id is ever replaced. */
  writeJob(job: ReleaseJob): ReleaseJob {
    const jobId = assertId('job', job.jobId);
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
    const job = this.readRecord<ReleaseJob>('job', id);
    if (job.jobId !== id) {
      throw new ReleaseStateError(
        'malformed-record',
        `job ${id}: record carries id ${String(job.jobId)}`,
      );
    }
    this.assertJobPlan(job);
    return job;
  }

  /** A job names a plan only together with that plan's digest, and it must match the stored plan. */
  private assertJobPlan(job: ReleaseJob): void {
    if (job.planId === null) {
      if (job.planDigest !== null) {
        throw new ReleaseStateError(
          'malformed-record',
          `job ${job.jobId}: carries a plan digest without a plan`,
        );
      }
      return;
    }
    if (job.planDigest === null) {
      throw new ReleaseStateError(
        'malformed-record',
        `job ${job.jobId}: names plan ${String(job.planId)} without its digest`,
      );
    }
    this.assertPlanBinding(job.planId, job.planDigest);
  }

  // --- approval intents: one per plan, written before any remote mutation --------------

  writeIntent(intent: ReleaseIntent): ReleaseIntent {
    const planId = assertId('plan', intent.planId);
    assertId('intent', intent.intentId);
    assertContractVersion(intent, `intent for plan ${planId}`);
    assertStateSchemaVersion(intent.stateSchemaVersion, `intent for plan ${planId}`);
    this.assertPlanBinding(planId, intent.planDigest);
    const stored = this.readExisting<ReleaseIntent>('intent', planId);
    if (stored !== null) {
      if (contentHash(stored) === contentHash(intent)) return stored;
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
    const intent = this.readRecord<ReleaseIntent>('intent', id);
    assertContractVersion(intent, `intent for plan ${id}`);
    assertStateSchemaVersion(intent.stateSchemaVersion, `intent for plan ${id}`);
    if (intent.planId !== id) {
      throw new ReleaseStateError(
        'malformed-record',
        `intent ${id}: record carries plan ${String(intent.planId)}`,
      );
    }
    this.assertPlanBinding(id, intent.planDigest);
    return intent;
  }

  // --- step observations: append-only, one record per observation ---------------------

  writeObservation(observation: ReleaseStepObservation): ReleaseStepObservation {
    const observationId = assertId('observation', observation.observationId);
    assertId('job', observation.jobId);
    const stored = this.readExisting<ReleaseStepObservation>('observation', observationId);
    if (stored !== null) {
      if (contentHash(stored) === contentHash(observation)) return stored;
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
    const observation = this.readRecord<ReleaseStepObservation>('observation', id);
    if (observation.observationId !== id) {
      throw new ReleaseStateError(
        'malformed-record',
        `observation ${id}: record carries id ${String(observation.observationId)}`,
      );
    }
    return observation;
  }

  // --- receipts: one finalization record per job --------------------------------------

  /** Write the receipt once. A failure here leaves the stored intent as the recovery record. */
  writeReceipt(receipt: ReleaseReceipt): ReleaseReceipt {
    const jobId = assertId('job', receipt.jobId);
    assertId('receipt', receipt.receiptId);
    assertContractVersion(receipt, `receipt for job ${jobId}`);
    assertStateSchemaVersion(receipt.stateSchemaVersion, `receipt for job ${jobId}`);
    this.assertPlanBinding(assertId('plan', receipt.planId), receipt.planDigest);
    const stored = this.readExisting<ReleaseReceipt>('receipt', jobId);
    if (stored !== null) {
      if (contentHash(stored) === contentHash(receipt)) return stored;
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
    const receipt = this.readRecord<ReleaseReceipt>('receipt', id);
    assertContractVersion(receipt, `receipt for job ${id}`);
    assertStateSchemaVersion(receipt.stateSchemaVersion, `receipt for job ${id}`);
    if (receipt.jobId !== id) {
      throw new ReleaseStateError(
        'malformed-record',
        `receipt ${id}: record carries job ${String(receipt.jobId)}`,
      );
    }
    this.assertPlanBinding(assertId('plan', receipt.planId), receipt.planDigest);
    return receipt;
  }

  // --- shared validation --------------------------------------------------------------

  private validatePlan(plan: ReleasePlan): void {
    const payload = plan?.payload;
    if (typeof plan?.digest !== 'string' || typeof payload !== 'object' || payload === null) {
      throw new ReleaseStateError('malformed-record', 'plan: expected a digest and payload');
    }
    assertContractVersion(payload, `plan ${plan.planId}`);
    assertStateSchemaVersion(payload.stateSchemaVersion, `plan ${plan.planId}`);
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

  /** Create or verify one record directory; a symlink there would redirect every record. */
  private ensureRecordDir(kind: RecordKind): string {
    const dir = join(this.stateDir, RECORD_DIR[kind]);
    let info: Stats | null = null;
    try {
      info = lstatSync(dir);
    } catch {
      info = null;
    }
    if (info === null) {
      try {
        mkdirSync(dir, { mode: 0o700 });
        chmodSync(dir, 0o700);
      } catch (error) {
        throw new ReleaseStateError('write-failed', `could not create ${dir}`, { cause: error });
      }
      // The new directory entry must survive a crash too.
      this.syncDirectory(this.stateDir);
      return dir;
    }
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
    const dir = join(this.stateDir, RECORD_DIR[kind]);
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ReleaseStateError('malformed-record', `${file} is not a state record`);
    }
    const envelope = parsed as Partial<StoredRecord>;
    assertStateSchemaVersion(envelope.stateSchemaVersion, file);
    if (envelope.kind !== kind) {
      throw new ReleaseStateError(
        'malformed-record',
        `${file} holds a ${String(envelope.kind)} record, not a ${kind} record`,
      );
    }
    const body = envelope.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ReleaseStateError('malformed-record', `${file} has no record body`);
    }
    if (envelope.recordDigest !== contentHash(body)) {
      throw new ReleaseStateError('digest-mismatch', `${file} does not match its record digest`);
    }
    return body as T;
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
      fsyncSync(fd);
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
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
