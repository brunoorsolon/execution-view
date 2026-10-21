import { accessSync, constants, lstatSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AppConfig, ResolvedReleaseRepository, ResolvedReleases } from './schema.js';
import { ConfigError } from './load.js';

/**
 * Release prerequisites that can only be checked against the local filesystem at startup.
 *
 * Nothing here talks to a forge: a temporary forge outage must not stop Planning from starting.
 * The checks never change permissions on mounted files; they only report a violation.
 */

type Env = Record<string, string | undefined>;

/** One repository with its dedicated token read, ready for the release client. */
export interface ReleaseRepositoryRuntime {
  config: ResolvedReleaseRepository;
  /** Dedicated release API token. Never log, persist or return this value. */
  token: string;
}

export interface ReleaseRuntime {
  publicOrigin: string;
  stateDir: string;
  repositories: ReleaseRepositoryRuntime[];
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function runtimeUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** The controlled child processes need these tools; report a missing one at startup, not mid-job. */
const REQUIRED_EXECUTABLES = ['git', 'ssh'] as const;

function missingExecutables(): string[] {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '');
  return REQUIRED_EXECUTABLES.filter(
    (name) =>
      !dirs.some((dir) => {
        const candidate = join(dir, name);
        try {
          accessSync(candidate, constants.X_OK);
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      }),
  );
}

/** A private state directory: a real directory owned by the runtime user, not group/other open. */
function checkStateDir(dir: string, errors: string[]): void {
  const label = `releases.stateDir "${dir}"`;
  let info;
  try {
    info = lstatSync(dir);
  } catch {
    errors.push(`${label}: does not exist`);
    return;
  }
  if (info.isSymbolicLink()) {
    errors.push(`${label}: must not be a symbolic link`);
    return;
  }
  if (!info.isDirectory()) {
    errors.push(`${label}: must be a directory`);
    return;
  }
  const uid = runtimeUid();
  if (uid !== undefined && info.uid !== uid) {
    errors.push(`${label}: must be owned by the runtime user (uid ${uid}, found ${info.uid})`);
  }
  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    errors.push(`${label}: permissions ${octal(mode)} expose it to group or others; use 0700`);
  }
  if ((mode & 0o300) !== 0o300) {
    errors.push(`${label}: must be writable and searchable by the runtime user; use 0700`);
  } else {
    try {
      accessSync(dir, constants.W_OK | constants.X_OK);
    } catch {
      errors.push(
        `${label}: is not writable by the runtime user (a read-only mount cannot hold release state)`,
      );
    }
  }
}

/** A secret file mounted for the runtime user. Symlinks are allowed (Kubernetes secret mounts). */
function checkReadableFile(file: string, label: string, errors: string[]): boolean {
  let info;
  try {
    info = statSync(file);
  } catch {
    errors.push(`${label} "${file}": does not exist or is not readable by the runtime user`);
    return false;
  }
  if (!info.isFile()) {
    errors.push(`${label} "${file}": must be a regular file`);
    return false;
  }
  try {
    accessSync(file, constants.R_OK);
  } catch {
    errors.push(`${label} "${file}": is not readable by the runtime user`);
    return false;
  }
  return true;
}

/** SSH refuses a private key that anyone else can read. */
function checkSshKey(file: string, errors: string[]): void {
  if (!checkReadableFile(file, 'ssh.privateKeyFile', errors)) return;
  const info = statSync(file);
  const uid = runtimeUid();
  if (uid !== undefined && info.uid !== uid) {
    errors.push(
      `ssh.privateKeyFile "${file}": must be owned by the runtime user (uid ${uid}, found ${info.uid})`,
    );
  }
  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    errors.push(
      `ssh.privateKeyFile "${file}": permissions ${octal(mode)} are too open for an SSH key; use 0600`,
    );
  }
}

/** Host keys are public, but nobody else may change them. */
function checkKnownHosts(file: string, errors: string[]): void {
  if (!checkReadableFile(file, 'ssh.knownHostsFile', errors)) return;
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o022) !== 0) {
    errors.push(
      `ssh.knownHostsFile "${file}": permissions ${octal(mode)} let group or others write it; use 0600 or 0644`,
    );
  }
}

function readToken(
  repository: ResolvedReleaseRepository,
  env: Env,
  planningTokens: Set<string>,
  errors: string[],
): string | null {
  const at = `releases.repositories[${repository.id}]`;
  let token: string | null = null;
  if (repository.token.kind === 'env') {
    const value = env[repository.token.name]?.trim();
    if (value === undefined || value === '') {
      errors.push(`${at}.apiTokenEnv: environment variable ${repository.token.name} is not set`);
    } else {
      token = value;
    }
  } else if (checkReadableFile(repository.token.path, `${at}.apiTokenFile`, errors)) {
    try {
      const value = readFileSync(repository.token.path, 'utf8').trim();
      if (value === '') {
        errors.push(`${at}.apiTokenFile "${repository.token.path}": is empty`);
      } else {
        token = value;
      }
    } catch {
      errors.push(`${at}.apiTokenFile "${repository.token.path}": could not be read`);
    }
  }
  if (token !== null && planningTokens.has(token)) {
    errors.push(`${at}: the release token must be dedicated, not the planning source token`);
  }
  return token;
}

/**
 * Validate the local prerequisites for enabled releases and resolve the runtime secrets.
 * Returns null while releases are disabled, without touching the filesystem.
 */
export function loadReleaseRuntime(
  releases: ResolvedReleases,
  sources: AppConfig['sources'],
  env: Env = process.env,
): ReleaseRuntime | null {
  if (!releases.enabled) return null;

  const errors: string[] = [];
  checkStateDir(releases.stateDir, errors);
  for (const name of missingExecutables()) {
    errors.push(`release runtime: the ${name} executable was not found in PATH`);
  }
  const planningTokens = new Set(
    sources.map((s) => s.token).filter((t): t is string => t !== null && t !== ''),
  );
  const tokens = releases.repositories.map((repository) => {
    const at = `releases.repositories[${repository.id}]`;
    checkSshKey(repository.ssh.privateKeyFile, errors);
    checkKnownHosts(repository.ssh.knownHostsFile, errors);
    return readToken(repository, env, planningTokens, errors);
  });

  if (errors.length > 0) {
    throw new ConfigError(`Invalid release configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return {
    publicOrigin: releases.publicOrigin,
    stateDir: releases.stateDir,
    repositories: releases.repositories.map((config, i) => ({
      config,
      token: tokens[i] as string,
    })),
  };
}
