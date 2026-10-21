import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, lstatSync, statfsSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseRepositoryIdentity } from '../core/release.js';

/**
 * Release execution ownership and per-repository serialization (source specification section 5).
 *
 * One application process owns the validated `releases.stateDir` for its lifetime through an
 * OS-backed exclusive lock: a supervised `flock` helper holds `LOCK_EX` on `owner.lock`, so the
 * kernel refuses a second owner and releases a dead owner without any stale-file cleanup.
 *
 * A second helper holds `work.lock` for exactly as long as this process has release work running.
 * A replacement owner probes that lock before it claims the directory, so losing the ownership
 * helper while work is still in flight cannot hand the directory to a second owner that would
 * mutate it beside the first. Without running work the probe is free, and a restart takes over
 * immediately.
 *
 * Within that owner, operations for one forge-qualified repository run one at a time while
 * different repositories progress independently. Shutdown stops admission immediately and drains
 * what was already accepted within a bound; work that outlives the bound keeps both locks until it
 * ends, so nothing may mutate beside it, and its durable intent (which the job engine records
 * before its first remote mutation) is what the next start reconciles. Every release operation the
 * engine adds must run through `runExclusive` of the owner this module returns.
 *
 * Shared/network filesystems and multiple application replicas are unsupported in this milestone,
 * so a filesystem type that cannot offer a local inode lock is refused instead of claimed.
 */

export type ReleaseOwnershipErrorCode =
  | 'unsupported-platform'
  | 'unsupported-filesystem'
  | 'unsafe-state-dir'
  | 'helper-missing'
  | 'lock-busy'
  | 'work-in-flight'
  | 'lock-failed'
  | 'not-accepting';

/** A refused ownership claim or gate call. `code` is stable so callers can report it safely. */
export class ReleaseOwnershipError extends Error {
  readonly code: ReleaseOwnershipErrorCode;

  constructor(code: ReleaseOwnershipErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReleaseOwnershipError';
    this.code = code;
  }
}

/**
 * Linux `statfs` magic numbers of filesystems where `flock` is a local inode lock. Anything else,
 * including every shared/network filesystem, fails closed rather than claiming ownership.
 */
const LOCAL_FILESYSTEMS: Record<number, string> = {
  0x0000ef53: 'ext2/ext3/ext4',
  0x58465342: 'xfs',
  0x9123683e: 'btrfs',
  0x01021994: 'tmpfs',
  0x2fc12fc1: 'zfs',
  0xf2f52010: 'f2fs',
  0x3153464a: 'jfs',
  0x794c7630: 'overlayfs',
  0x0000f15f: 'ecryptfs',
};

/** Named only to make the diagnostic concrete; these are never accepted. */
const SHARED_FILESYSTEMS: Record<number, string> = {
  0x00006969: 'NFS',
  0x00ff534d42: 'CIFS/SMB',
  0x00fe534d42: 'SMB2',
  0x00c36400: 'Ceph',
  0x01021997: '9p',
  0x65735546: 'FUSE (including virtiofs, sshfs and host-shared mounts)',
};

/** The lifetime lock lives in the state directory, next to the records it protects. */
export const OWNERSHIP_LOCK_FILE = 'owner.lock';

/** Held by this process while any release operation runs, so no replacement owner may start. */
export const WORK_LOCK_FILE = 'work.lock';

/** Bound on shutting a helper down once its lock is no longer needed. */
const RELEASE_TIMEOUT_MS = 2_000;

/** Bound on a helper's own start-up before it reports that it holds the lock. */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** The helper's lock-conflict exit status, which util-linux and BusyBox both use. */
const CONFLICT_EXIT_CODE = 1;

/**
 * Runs only once the helper holds the lock. `cat` reads the inherited stdin pipe, so the helper
 * exits (releasing the lock) when this process closes the pipe or dies.
 */
const HOLDER_SCRIPT = 'printf "locked\\n"; exec cat >/dev/null';

export interface ReleaseOwnershipOptions {
  /** Private state directory validated at startup by `loadReleaseRuntime` (#85). */
  stateDir: string;
  /**
   * Bound on the shutdown drain. Keep it inside the container's stop grace period so termination
   * cannot cut the drain short.
   */
  shutdownTimeoutMs?: number;
  /** Owner to require, defaulting to the real runtime user; overridable for tests. */
  uid?: () => number | undefined;
  /** Filesystem type probe, defaulting to `statfsSync`; overridable for tests. */
  filesystemType?: (dir: string) => number;
  /** Platform, defaulting to `process.platform`; overridable for tests. */
  platform?: NodeJS.Platform;
  /** `flock` executable, defaulting to the one on PATH; overridable for tests. */
  flockPath?: string;
  /** Called once when a held ownership lock is lost while the runtime is still running. */
  onLost?: (reason: string) => void;
}

/** What bounded shutdown left behind. Durable intent remains the recovery record. */
export interface ReleaseShutdownReport {
  /** True when every admitted repository operation finished before the deadline. */
  drained: boolean;
  /** Keys of repository operations still running at the deadline. */
  pending: string[];
  /**
   * True when ownership was released before this report was produced. When the drain failed, the
   * lock is released as soon as the last admitted operation ends, never before.
   */
  lockReleased: boolean;
}

/** The parts of a plan's repository identity that decide which operations compete. */
export type ReleaseRepositoryKey = Pick<
  ReleaseRepositoryIdentity,
  'forge' | 'baseUrl' | 'owner' | 'repo'
>;

/** Canonical spelling of a configured base URL, so equivalent spellings share one queue. */
function normalizeBaseUrl(baseUrl: string): string {
  try {
    // `URL` lowercases the scheme and host and drops a default port, so `https://h:443` and
    // `https://h` are the same endpoint.
    return new URL(baseUrl).href.replace(/\/+$/, '');
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
}

/**
 * Serialization key for one forge-qualified repository, so two configured ids that point at the
 * same repository still share one queue.
 *
 * Case is folded because a Gitea owner/repo route and a host name are case-insensitive, and
 * serializing more than necessary is safe while sharing work across two queues is not. Distinct
 * configured URLs that alias each other beyond URL equivalence stay separate keys; the numeric
 * repository identity is only known after verification, so it cannot serve here.
 */
export function repositoryOperationKey(repository: ReleaseRepositoryKey): string {
  const baseUrl = normalizeBaseUrl(repository.baseUrl);
  return `${repository.forge}:${baseUrl}/${repository.owner}/${repository.repo}`.toLowerCase();
}

interface LockHolder {
  child: ChildProcess;
  /** Resolves when the helper is gone, which means the kernel has released the lock. */
  exited: Promise<void>;
}

function runtimeUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function delay(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
}

/** The validated state directory, rechecked here because ownership is claimed later than startup. */
function ensurePrivateStateDir(stateDir: string, uid: () => number | undefined): void {
  let info: Stats;
  try {
    info = lstatSync(stateDir);
  } catch (error) {
    throw new ReleaseOwnershipError(
      'unsafe-state-dir',
      `release state directory ${stateDir} is not usable`,
      { cause: error },
    );
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ReleaseOwnershipError(
      'unsafe-state-dir',
      `release state directory ${stateDir} must be a real directory, not a link or file`,
    );
  }
  const owner = uid();
  if (owner !== undefined && info.uid !== owner) {
    throw new ReleaseOwnershipError(
      'unsafe-state-dir',
      `release state directory ${stateDir} must be owned by the runtime user (uid ${owner}, found ${info.uid})`,
    );
  }
  if ((info.mode & 0o077) !== 0) {
    throw new ReleaseOwnershipError(
      'unsafe-state-dir',
      `release state directory ${stateDir} has permissions ${octal(info.mode)} and is accessible to group or others; use 0700`,
    );
  }
}

/** Refuse a filesystem whose lock is not a local inode lock, naming it where it is known. */
function assertLocalFilesystem(stateDir: string, type: number): void {
  if (Object.hasOwn(LOCAL_FILESYSTEMS, type)) return;
  const shared = SHARED_FILESYSTEMS[type];
  const name = shared ?? `unknown filesystem type 0x${type.toString(16)}`;
  throw new ReleaseOwnershipError(
    'unsupported-filesystem',
    `release state directory ${stateDir} is on ${name}; shared and network filesystems cannot own release execution, so move the release state volume to a local filesystem`,
  );
}

/** A lock file must be the private regular file this process just created or reused. */
function checkLockFile(lockFile: string, uid: () => number | undefined): void {
  const info = lstatSync(lockFile);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ReleaseOwnershipError(
      'unsafe-state-dir',
      `release lock ${lockFile} must be a regular file, not a link`,
    );
  }
  const owner = uid();
  if (owner !== undefined && info.uid !== owner) {
    throw new ReleaseOwnershipError(
      'unsafe-state-dir',
      `release lock ${lockFile} must be owned by the runtime user (uid ${owner}, found ${info.uid})`,
    );
  }
  // The helper creates the file under the caller's umask, so tighten it to the record mode.
  if ((info.mode & 0o077) !== 0) chmodSync(lockFile, 0o600);
}

/**
 * Hold `LOCK_EX` on the lock file through a supervised helper process.
 *
 * The helper reports ownership on stdout only after `flock(2)` granted the lock, and it exits with
 * the conflict status when another process already holds it. Its stdin pipe ties the lock to this
 * process: closing it or dying delivers EOF to the holder, which exits and releases the lock.
 */
function holdLock(lockFile: string, flockPath: string): Promise<LockHolder> {
  return new Promise((resolve, reject) => {
    // A bare environment: the holder needs a shell, not the release credentials around it.
    const child = spawn(flockPath, ['--nonblock', lockFile, 'sh', '-c', HOLDER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin' },
    });
    const exited = new Promise<void>((done) => child.once('close', () => done()));
    let settled = false;
    let stdout = '';
    let stderr = '';

    const fail = (error: ReleaseOwnershipError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(
        new ReleaseOwnershipError(
          'lock-failed',
          `${flockPath} did not report ownership of ${lockFile} within ${HANDSHAKE_TIMEOUT_MS} ms`,
        ),
      );
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref();

    child.once('error', (error: NodeJS.ErrnoException) => {
      fail(
        error.code === 'ENOENT'
          ? new ReleaseOwnershipError(
              'helper-missing',
              `the ${flockPath} executable was not found; release execution needs util-linux or BusyBox flock on PATH`,
              { cause: error },
            )
          : new ReleaseOwnershipError(
              'lock-failed',
              `could not run ${flockPath}: ${error.message}`,
              {
                cause: error,
              },
            ),
      );
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString('utf8');
      if (stdout.includes('locked')) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, exited });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(0, 400);
    });
    child.once('close', (code) => {
      if (settled) return;
      // A conflict is silent; anything the helper printed is a real failure worth reporting as
      // such, so a permission problem is never disguised as another owner.
      fail(
        code === CONFLICT_EXIT_CODE && stderr.trim() === ''
          ? new ReleaseOwnershipError(
              'lock-busy',
              `another application process owns release state directory ${dirname(lockFile)}; only one process may run release work`,
            )
          : new ReleaseOwnershipError(
              'lock-failed',
              `${flockPath} could not take ownership of ${lockFile} (exit ${String(code)})${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`,
            ),
      );
    });
  });
}

/** Claim one lock file of the validated state directory, with the file checks applied. */
async function holdStateLock(
  stateDir: string,
  name: string,
  flockPath: string,
  uid: () => number | undefined,
): Promise<LockHolder> {
  const lockFile = join(stateDir, name);
  const holder = await holdLock(lockFile, flockPath);
  try {
    checkLockFile(lockFile, uid);
  } catch (error) {
    holder.child.kill('SIGKILL');
    if (error instanceof ReleaseOwnershipError) throw error;
    throw new ReleaseOwnershipError('unsafe-state-dir', `release lock ${lockFile} is not usable`, {
      cause: error,
    });
  }
  return holder;
}

async function waitForExit(holder: LockHolder, timeoutMs: number): Promise<boolean> {
  return await Promise.race([holder.exited.then(() => true), delay(timeoutMs)]);
}

/** Release a helper by closing its stdin; a stuck helper is killed. */
async function releaseHolder(holder: LockHolder): Promise<boolean> {
  if (holder.child.exitCode !== null || holder.child.signalCode !== null) return true;
  holder.child.stdin?.end();
  if (await waitForExit(holder, RELEASE_TIMEOUT_MS)) return true;
  holder.child.kill('SIGKILL');
  return await waitForExit(holder, RELEASE_TIMEOUT_MS);
}

/**
 * The one release-execution owner of a state directory.
 *
 * Every release operation of this process runs through `runExclusive`, so the owner's admission
 * state and its per-repository queues stay the single place that decides what may run.
 */
export class ReleaseOwnership {
  readonly stateDir: string;
  readonly lockFile: string;
  readonly workLockFile: string;

  private readonly shutdownTimeoutMs: number;
  private readonly flockPath: string;
  private readonly uid: () => number | undefined;
  private readonly onLost: ((reason: string) => void) | undefined;
  private readonly owner: LockHolder;
  /** Tail of the queue per repository key; a stored tail never rejects. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Number of running operations per repository key. */
  private readonly active = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];
  /** Serializes holding and releasing the work lock so it spans every running operation. */
  private workChain: Promise<void> = Promise.resolve();
  private work: LockHolder | null = null;
  private workDepth = 0;
  private closed = false;
  private releasing = false;
  private lockHeld = true;
  private lockReleased = false;
  private release: Promise<boolean> | null = null;
  private shutdownReport: Promise<ReleaseShutdownReport> | null = null;

  constructor(options: ReleaseOwnershipOptions, holder: LockHolder) {
    this.stateDir = options.stateDir;
    this.lockFile = join(options.stateDir, OWNERSHIP_LOCK_FILE);
    this.workLockFile = join(options.stateDir, WORK_LOCK_FILE);
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.flockPath = options.flockPath ?? 'flock';
    this.uid = options.uid ?? runtimeUid;
    this.onLost = options.onLost;
    this.owner = holder;
    void holder.exited.then(() => this.noteOwnerExit());
  }

  /** True while new release work may be admitted. */
  get accepting(): boolean {
    return !this.closed && this.lockHeld;
  }

  /**
   * Run `work` as the only release operation for this forge-qualified repository.
   *
   * Calls for the same key queue in arrival order; calls for different repositories run at the
   * same time. A refused call never starts `work`. Accepted work holds the work lock for as long
   * as it runs, so a replacement owner cannot take the directory beside it.
   */
  runExclusive<T>(repository: ReleaseRepositoryKey, work: () => Promise<T>): Promise<T> {
    const key = repositoryOperationKey(repository);
    if (!this.accepting) throw this.refusal(key);
    // Work admitted here is drained even if shutdown starts before it reaches the head of its
    // queue, but a lost lock fences it: this process may no longer touch the directory.
    const run = (this.queues.get(key) ?? Promise.resolve()).then(async () => {
      try {
        if (!this.lockHeld) throw this.refusal(key);
        await this.enterWork();
        try {
          return await work();
        } finally {
          await this.leaveWork();
        }
      } finally {
        // Admitted work counts as unfinished until it settles, so ownership is released only
        // after every admitted operation — running or still queued — has finished.
        this.untrack(key);
        if (this.closed) await this.releaseWhenIdle();
      }
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    this.track(key);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  /**
   * Stop admitting release work, drain what is already running (and queued) within the bound,
   * then release ownership. Undrained work keeps both locks until every admitted operation ends,
   * and ownership is released then, so a process can never hand the directory to a replacement
   * while admitted work may still mutate it. Idempotent: a second call returns the first report.
   */
  shutdown(): Promise<ReleaseShutdownReport> {
    this.shutdownReport ??= this.close();
    return this.shutdownReport;
  }

  private async close(): Promise<ReleaseShutdownReport> {
    this.closed = true;
    const drained = await this.waitForIdle(this.shutdownTimeoutMs);
    const pending = [...this.active.keys()].sort();
    const lockReleased = drained ? await this.releaseOwnership() : false;
    return { drained, pending, lockReleased };
  }

  private refusal(key: string): ReleaseOwnershipError {
    return new ReleaseOwnershipError(
      'not-accepting',
      `release work for ${key} was refused: ${
        this.closed
          ? 'the runtime is shutting down'
          : `this process no longer owns release state directory ${this.stateDir}`
      }`,
    );
  }

  /** Hold the work lock across the first running operation, and keep it until the last ends. */
  private enterWork(): Promise<void> {
    const entry = this.workChain.then(async () => {
      if (this.workDepth === 0) {
        this.work = await holdStateLock(this.stateDir, WORK_LOCK_FILE, this.flockPath, this.uid);
      }
      this.workDepth += 1;
    });
    this.workChain = entry.then(
      () => undefined,
      () => undefined,
    );
    return entry;
  }

  private leaveWork(): Promise<void> {
    const exit = this.workChain.then(async () => {
      this.workDepth -= 1;
      if (this.workDepth > 0) return;
      const holder = this.work;
      this.work = null;
      if (holder !== null) await releaseHolder(holder);
    });
    this.workChain = exit.then(
      () => undefined,
      () => undefined,
    );
    return exit;
  }

  /** Give up ownership once a shutdown has no admitted work left, however late that is. */
  private async releaseWhenIdle(): Promise<void> {
    if (this.lockReleased || this.active.size > 0 || this.workDepth > 0) return;
    await this.releaseOwnership();
  }

  private track(key: string): void {
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
  }

  private untrack(key: string): void {
    const remaining = (this.active.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.active.set(key, remaining);
      return;
    }
    this.active.delete(key);
    if (this.active.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  private waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.active.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (drained: boolean): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== wake);
        resolve(drained);
      };
      const wake = (): void => done(true);
      // Not unref'd: the drain bound must fire even when running work holds no timers.
      timer = setTimeout(() => done(false), timeoutMs);
      this.idleWaiters.push(wake);
    });
  }

  /** Release the lifetime lock once; also releases the helper that keeps this process alive. */
  private releaseOwnership(): Promise<boolean> {
    this.release ??= (async () => {
      this.releasing = true;
      const released = await releaseHolder(this.owner);
      if (released) {
        this.lockHeld = false;
        this.lockReleased = true;
      }
      return released;
    })();
    return this.release;
  }

  private noteOwnerExit(): void {
    if (this.releasing) return;
    this.lockHeld = false;
    this.onLost?.(
      `release state directory ${this.stateDir} is no longer owned by this process: the ownership helper exited; release work is refused until a restart`,
    );
  }
}

/** Claim release execution for one state directory, or refuse with a concrete diagnostic. */
export async function acquireReleaseOwnership(
  options: ReleaseOwnershipOptions,
): Promise<ReleaseOwnership> {
  const platform = options.platform ?? (process.platform as NodeJS.Platform);
  if (platform !== 'linux') {
    throw new ReleaseOwnershipError(
      'unsupported-platform',
      `release execution owns its state directory through Linux flock(2); platform ${platform} is unsupported`,
    );
  }
  const uid = options.uid ?? runtimeUid;
  ensurePrivateStateDir(options.stateDir, uid);
  const probe = options.filesystemType ?? ((dir: string) => statfsSync(dir).type);
  assertLocalFilesystem(options.stateDir, probe(options.stateDir));
  const flockPath = options.flockPath ?? 'flock';
  const owner = await holdStateLock(options.stateDir, OWNERSHIP_LOCK_FILE, flockPath, uid);
  try {
    // A previous owner that still has work running keeps its work lock, so a replacement must not
    // start: it would mutate the same repository beside still-running work.
    const workProbe = await holdStateLock(options.stateDir, WORK_LOCK_FILE, flockPath, uid);
    await releaseHolder(workProbe);
  } catch (error) {
    await releaseHolder(owner);
    if (error instanceof ReleaseOwnershipError && error.code === 'lock-busy') {
      throw new ReleaseOwnershipError(
        'work-in-flight',
        `release state directory ${options.stateDir} still has release work running in another process; wait for it to finish before starting again`,
        { cause: error },
      );
    }
    throw error;
  }
  return new ReleaseOwnership({ ...options, flockPath }, owner);
}
