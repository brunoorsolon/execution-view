/**
 * Dedicated process wrapper for release Git and SSH reads.
 *
 * Every release Git read runs through here, so the hardening cannot be forgotten at a call site:
 * the git executable is invoked through an argument array (never a shell), a fixed set of `-c`
 * overrides disables hooks, credential helpers, askpass, filters and unsafe protocols, and the
 * child environment is rebuilt from an allowlist instead of inherited. SSH trusts only the
 * configured host-key file, in batch mode, with the configured dedicated key and no user or
 * system ssh configuration.
 *
 * Output and lifetime are bounded; a timeout or caller interruption terminates the whole child
 * process group. Failures become typed blockers whose text is bounded, control-character free
 * and stripped of the configured key material paths, never an exception carrying a credential.
 */

import { spawn } from 'node:child_process';

/** A stable machine-readable reason a release Git read could not be trusted. */
export type ReleaseGitBlockerCode =
  | 'git-unavailable'
  | 'git-invalid-request'
  | 'git-unsafe-cache'
  | 'git-unsafe-origin'
  | 'git-unsafe-revision'
  | 'git-repository-mismatch'
  | 'git-output-too-large'
  | 'git-timeout'
  | 'git-interrupted'
  | 'git-ssh-untrusted'
  | 'git-ssh-failed'
  | 'git-failed'
  | 'git-malformed-response'
  | 'git-internal-error';

/** Why a release Git read failed. Safe to log, return to a caller or persist. */
export interface ReleaseGitBlocker {
  code: ReleaseGitBlockerCode;
  /** Redacted, bounded English text. Never contains key material or unbounded child output. */
  message: string;
}

/** Every checkout read returns its outcome instead of throwing into a job. */
export type ReleaseGitResult<T> =
  { ok: true; value: T } | { ok: false; blocker: ReleaseGitBlocker };

export class ReleaseGitError extends Error {
  readonly code: ReleaseGitBlockerCode;

  constructor(code: ReleaseGitBlockerCode, message: string) {
    super(message);
    this.name = 'ReleaseGitError';
    this.code = code;
  }
}

/** Upper bound for one release Git command, including a fetch. */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** Upper bound for one child's stdout and stderr together. */
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Grace period between the polite and the forced kill of a timed-out child. */
const FORCE_KILL_MS = 2_000;

/** Grace period for pipe output to arrive after the child itself has exited. */
const DRAIN_MS = 100;

/** Longest child stderr excerpt repeated in a blocker message. */
const MAX_DIAGNOSTIC_LENGTH = 400;

/**
 * Config forced on every release Git invocation. `-c` values are read last, so they override a
 * cache repository's own config: a poisoned local config cannot re-enable hooks, a credential
 * helper, an askpass program, a fetch filter or a non-SSH transport.
 */
export const RELEASE_GIT_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.askPass=',
  // An empty value clears the accumulated helper list.
  'credential.helper=',
  'protocol.allow=never',
  // A more specific protocol.<name>.allow wins over protocol.allow, so every transport the
  // release reads never use is refused by name as well.
  'protocol.file.allow=never',
  'protocol.git.allow=never',
  'protocol.http.allow=never',
  'protocol.https.allow=never',
  'protocol.ftp.allow=never',
  'protocol.ftps.allow=never',
  'protocol.ext.allow=never',
  'protocol.ssh.allow=always',
  'fetch.recurseSubmodules=false',
  'submodule.recurse=false',
  'filter.lfs.process=',
  'filter.lfs.smudge=',
  'filter.lfs.required=false',
  'gc.auto=0',
  'advice.detachedHead=false',
];

/**
 * The only Git verbs release preparation may use. Local cache fetches and unreferenced tag
 * objects are permitted; no verb can push or create a remote tag or release.
 */
export const RELEASE_GIT_READ_ONLY_VERBS: readonly string[] = [
  'init',
  'fetch',
  'rev-parse',
  'rev-list',
  'cat-file',
  'ls-tree',
  'for-each-ref',
  'log',
  'merge-base',
  'ls-remote',
  // Writes only a local, unreferenced annotated tag object; never a remote ref.
  'mktag',
];

/**
 * Options that would let an argument choose a program to execute or redirect the repository.
 * No call site needs them, so the wrapper refuses them rather than relying on every caller.
 */
const FORBIDDEN_ARGUMENTS = [
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '--config',
  '--git-dir',
  '--work-tree',
];

export interface ReleaseGitSshOptions {
  /** Dedicated SSH private key readable by the runtime user. */
  privateKeyFile: string;
  /** Host keys trusted for the configured origin; the only trusted host-key source. */
  knownHostsFile: string;
}

export interface ReleaseGitRunOptions {
  /** Fixed description chosen by the calling code, for example "fetch the candidate". Never request text. */
  operation: string;
  /** Working directory: always the container-owned release cache. */
  cwd: string;
  ssh: ReleaseGitSshOptions;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Interruption for shutdown or a cancelled job; kills the child process group. */
  signal?: AbortSignal;
  /** Bounded bytes for local annotated-tag creation, never a shell command. */
  input?: Buffer;
}

export interface ReleaseGitOutput {
  stdout: Buffer;
  stderr: Buffer;
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const CONTROL_CHARS_GLOBAL = /[\x00-\x1f\x7f]/g;

/** POSIX single-quoting, so a configured path can never break out of the ssh option string. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function assertSshPath(value: string, field: string): void {
  if (!value.startsWith('/') || value.includes('\0') || CONTROL_CHARS.test(value)) {
    throw new ReleaseGitError(
      'git-invalid-request',
      `release ssh ${field} must be an absolute path without control characters`,
    );
  }
}

/**
 * The ssh command git runs for the configured origin. It is a fixed option list plus quoted,
 * validated operator paths: no request value and no shell-expandable input enters it.
 */
export function releaseSshCommand(ssh: ReleaseGitSshOptions): string {
  assertSshPath(ssh.privateKeyFile, 'privateKeyFile');
  assertSshPath(ssh.knownHostsFile, 'knownHostsFile');
  return [
    'ssh',
    // An explicit -F also makes ssh ignore the system-wide configuration file.
    '-F',
    '/dev/null',
    '-oBatchMode=yes',
    '-oStrictHostKeyChecking=yes',
    '-oIdentitiesOnly=yes',
    '-oGlobalKnownHostsFile=/dev/null',
    `-oUserKnownHostsFile=${shellQuote(ssh.knownHostsFile)}`,
    '-oUpdateHostKeys=no',
    '-oForwardAgent=no',
    '-oClearAllForwardings=yes',
    '-i',
    shellQuote(ssh.privateKeyFile),
  ].join(' ');
}

/**
 * The child environment. Nothing is inherited except PATH and TMPDIR, so a host GIT_DIR,
 * SSH_AUTH_SOCK, GIT_SSH_COMMAND or credential variable cannot reach a release read.
 */
function childEnvironment(cwd: string, ssh: ReleaseGitSshOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: cwd,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_SSH_COMMAND: releaseSshCommand(ssh),
    GIT_SSH_VARIANT: 'ssh',
    SSH_ASKPASS_REQUIRE: 'never',
  };
  const tmpdir = process.env['TMPDIR'];
  if (tmpdir !== undefined && tmpdir !== '') env['TMPDIR'] = tmpdir;
  return env;
}

interface ChildOutcome {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  interrupted: boolean;
  outputExceeded: boolean;
}

interface ChildLimits {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  input?: Buffer;
}

/** Runs one child in its own process group, with bounded output and lifetime. */
function spawnBounded(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  limits: ChildLimits,
): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: limits.cwd,
      env,
      shell: false,
      detached: true,
      stdio: [limits.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {
      // Exit status reports a rejected tag object.
    });
    child.stdin?.end(limits.input);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let timedOut = false;
    let interrupted = false;
    let outputExceeded = false;
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    let exitCode: number | null = null;

    const killGroup = (signal: NodeJS.Signals): void => {
      // The child leads its own group, so this also reaches a hanging ssh or upload-pack.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process already exited: there is nothing left to terminate.
        }
      }
    };
    let killPending = false;
    const groupAlive = (): boolean => {
      try {
        if (child.pid === undefined) return false;
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const stop = (): void => {
      if (killPending) return;
      killPending = true;
      killGroup('SIGTERM');
      // A descendant can outlive the leader and ignore SIGTERM, so the forced group kill must
      // still run after the leader exits; settlement waits for it while the group still lives.
      escalation = setTimeout(() => {
        killGroup('SIGKILL');
        killPending = false;
        settle();
      }, FORCE_KILL_MS);
      escalation.unref();
    };
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (outputExceeded) return;
      total += chunk.byteLength;
      if (total > limits.maxOutputBytes) {
        outputExceeded = true;
        stop();
        return;
      }
      chunks.push(chunk);
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, limits.timeoutMs);
    timer.unref();
    const onAbort = (): void => {
      interrupted = true;
      stop();
    };
    limits.signal?.addEventListener('abort', onAbort, { once: true });
    if (limits.signal?.aborted === true) onAbort();

    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation !== undefined) clearTimeout(escalation);
      if (drain !== undefined) clearTimeout(drain);
      limits.signal?.removeEventListener('abort', onAbort);
      done();
    };
    const settle = (): void =>
      finish(() =>
        resolve({
          code: exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          timedOut,
          interrupted,
          outputExceeded,
        }),
      );
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      exitCode = code;
      if (!killPending || !groupAlive()) settle();
    });
    // A descendant that left the process group can hold the inherited pipes open, so 'close'
    // may never arrive. Once the child itself has exited, drain briefly and settle anyway.
    child.on('exit', (code) => {
      exitCode = code;
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!killPending || !groupAlive()) settle();
      }, DRAIN_MS);
      drain.unref();
    });
  });
}

/** Bounded, printable, redacted excerpt of child stderr for a blocker message. */
function diagnostic(stderr: Buffer, secrets: readonly string[]): string {
  let text = stderr.toString('utf8').replace(CONTROL_CHARS_GLOBAL, '?').replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret !== '') text = text.split(secret).join('***');
  }
  return text.length > MAX_DIAGNOSTIC_LENGTH ? `${text.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : text;
}

/** English ssh failures, stable because the child runs with LC_ALL=C. */
const SSH_UNTRUSTED =
  /host key verification failed|remote host identification has changed|host key for .* has changed|no .* host key is known/i;
const SSH_FAILED =
  /\bssh: |permission denied \(publickey|connection (refused|timed out|closed)|kex_exchange_identification|no matching host key/i;

function failure(
  operation: string,
  outcome: ChildOutcome,
  secrets: readonly string[],
): ReleaseGitError {
  const detail = diagnostic(outcome.stderr, secrets);
  const suffix = detail === '' ? '' : `: ${detail}`;
  if (outcome.outputExceeded) {
    return new ReleaseGitError(
      'git-output-too-large',
      `${operation} exceeded the release output bound and the child process tree was terminated`,
    );
  }
  if (outcome.timedOut) {
    return new ReleaseGitError(
      'git-timeout',
      `${operation} did not finish within its lifetime bound and the child process tree was terminated${suffix}`,
    );
  }
  if (outcome.interrupted) {
    return new ReleaseGitError(
      'git-interrupted',
      `${operation} was interrupted and the child process tree was terminated${suffix}`,
    );
  }
  const stderr = outcome.stderr.toString('utf8');
  if (SSH_UNTRUSTED.test(stderr)) {
    return new ReleaseGitError(
      'git-ssh-untrusted',
      `${operation} failed because ssh does not trust the configured host key${suffix}`,
    );
  }
  if (SSH_FAILED.test(stderr)) {
    return new ReleaseGitError(
      'git-ssh-failed',
      `${operation} failed in the ssh transport${suffix}`,
    );
  }
  return new ReleaseGitError(
    'git-failed',
    `${operation} failed with status ${String(outcome.code)}${suffix}`,
  );
}

/**
 * Runs one read-only release Git command. Callers pass fixed argv arrays; a request value never
 * becomes a command string. A failing or unbounded child is a typed blocker, never a fallback.
 */
export async function runReleaseGit(
  argv: readonly string[],
  opts: ReleaseGitRunOptions,
): Promise<ReleaseGitOutput> {
  const verb = argv[0];
  const forbidden = argv.some(
    (arg) =>
      arg.includes('\0') ||
      FORBIDDEN_ARGUMENTS.some((option) => arg === option || arg.startsWith(`${option}=`)),
  );
  if (verb === undefined || !RELEASE_GIT_READ_ONLY_VERBS.includes(verb) || forbidden) {
    throw new ReleaseGitError(
      'git-invalid-request',
      `release Git reads accept only the read-only verbs ${RELEASE_GIT_READ_ONLY_VERBS.join(', ')} without executable or repository overrides`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
  if (opts.input !== undefined && (verb !== 'mktag' || opts.input.byteLength > 4096)) {
    throw new ReleaseGitError(
      'git-invalid-request',
      'only a bounded local tag object may use stdin',
    );
  }
  const secrets = [opts.ssh.privateKeyFile, opts.ssh.knownHostsFile];
  const env = childEnvironment(opts.cwd, opts.ssh);
  const command = [...RELEASE_GIT_CONFIG.flatMap((value) => ['-c', value]), ...argv];

  let outcome: ChildOutcome;
  try {
    outcome = await spawnBounded('git', command, env, {
      cwd: opts.cwd,
      timeoutMs,
      maxOutputBytes,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ReleaseGitError(
        'git-unavailable',
        `${opts.operation} is unavailable: the git executable was not found in PATH`,
      );
    }
    throw new ReleaseGitError('git-internal-error', `${opts.operation} could not be started`);
  }

  if (outcome.code !== 0 || outcome.timedOut || outcome.interrupted || outcome.outputExceeded) {
    throw failure(opts.operation, outcome, secrets);
  }
  return { stdout: outcome.stdout, stderr: outcome.stderr };
}

/** Turns a checkout failure into the returned blocker shape, never an escaping credential. */
export function releaseGitBlocker(err: unknown): ReleaseGitBlocker {
  if (err instanceof ReleaseGitError) return { code: err.code, message: err.message };
  return { code: 'git-internal-error', message: 'the release Git read failed unexpectedly' };
}
