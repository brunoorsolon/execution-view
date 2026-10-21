import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RELEASE_GIT_CONFIG,
  ReleaseGitError,
  releaseSshCommand,
  runReleaseGit,
} from './gitProcess.js';

const KEY_FILE = '/run/secrets/forge-desk-release-key';
const KNOWN_HOSTS = '/run/secrets/forge-desk-known-hosts';
const SSH = { privateKeyFile: KEY_FILE, knownHostsFile: KNOWN_HOSTS };
const TIMEOUT_MS = 5_000;

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'forge-desk-git-'));
}

/** A directory with one fake executable, prepended to PATH for the duration of a test. */
function fakeExecutable(name: string, body: string): { dir: string; script: string } {
  const dir = tempRoot();
  const script = join(dir, name);
  writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(script, 0o755);
  return { dir, script };
}

const pathRestorers: Array<() => void> = [];

function prependPath(...dirs: string[]): void {
  const original = process.env['PATH'] ?? '';
  process.env['PATH'] = [...dirs, original].join(':');
  pathRestorers.push(() => {
    process.env['PATH'] = original;
  });
}

afterEach(() => {
  while (pathRestorers.length > 0) pathRestorers.pop()?.();
});

/** A killed orphan can linger as a zombie, which no longer runs but still answers signal 0. */
function waitUntilNotRunning(pid: number): boolean {
  for (let i = 0; i < 100; i += 1) {
    let state: string | null = null;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    } catch {
      state = null;
    }
    if (state === null || state === 'Z' || state === 'X') return true;
    execFileSync('sleep', ['0.02']);
  }
  return false;
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (isDead(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return isDead(pid);
}

function run(cwd: string, argv: readonly string[] = ['rev-parse', 'HEAD'], signal?: AbortSignal) {
  return runReleaseGit(argv, {
    operation: 'read the test candidate',
    cwd,
    ssh: SSH,
    timeoutMs: TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  });
}

describe('releaseSshCommand', () => {
  it('trusts only the configured host keys, in batch mode, with the dedicated key', () => {
    const command = releaseSshCommand(SSH);
    for (const expected of [
      '-F /dev/null',
      '-oBatchMode=yes',
      '-oStrictHostKeyChecking=yes',
      '-oIdentitiesOnly=yes',
      '-oGlobalKnownHostsFile=/dev/null',
      `-oUserKnownHostsFile='${KNOWN_HOSTS}'`,
      '-i',
      `'${KEY_FILE}'`,
      '-oForwardAgent=no',
    ]) {
      expect(command).toContain(expected);
    }
    expect(command.startsWith('ssh ')).toBe(true);
  });

  it('quotes a path so it cannot break out of the option string', () => {
    const command = releaseSshCommand({
      privateKeyFile: "/run/secrets/it's key",
      knownHostsFile: KNOWN_HOSTS,
    });
    expect(command).toContain(`'/run/secrets/it'\\''s key'`);
  });

  it('refuses a relative or control-character path', () => {
    for (const path of ['relative/key', '/run/secrets/\nkey', '/run/secrets/\u0000key']) {
      expect(() =>
        releaseSshCommand({ privateKeyFile: path, knownHostsFile: KNOWN_HOSTS }),
      ).toThrow(ReleaseGitError);
    }
  });
});

describe('RELEASE_GIT_CONFIG', () => {
  it('disables hooks, credential helpers, askpass, filters and non-SSH protocols', () => {
    expect(RELEASE_GIT_CONFIG).toEqual(
      expect.arrayContaining([
        'core.hooksPath=/dev/null',
        'credential.helper=',
        'core.askPass=',
        'protocol.allow=never',
        'protocol.ssh.allow=always',
        'fetch.recurseSubmodules=false',
        'submodule.recurse=false',
        'filter.lfs.process=',
        'filter.lfs.required=false',
      ]),
    );
  });
});

describe('runReleaseGit', () => {
  it('passes hardening as arguments, runs without a shell and inherits no host git state', async () => {
    const argvLog = join(tempRoot(), 'argv.log');
    const envLog = join(tempRoot(), 'env.log');
    const { dir } = fakeExecutable(
      'git',
      `printf '%s\\n' "$@" > '${argvLog}'\nenv > '${envLog}'\nprintf 'ok'`,
    );
    prependPath(dir);
    process.env['GIT_DIR'] = '/hostile/host.git';
    process.env['GIT_SSH_COMMAND'] = 'ssh hostile';
    process.env['SSH_AUTH_SOCK'] = '/hostile/agent.sock';
    try {
      const result = await run(tempRoot(), ['rev-parse', 'HEAD']);
      expect(result.stdout.toString('utf8')).toBe('ok');
    } finally {
      delete process.env['GIT_DIR'];
      delete process.env['GIT_SSH_COMMAND'];
      delete process.env['SSH_AUTH_SOCK'];
    }

    const argv = readFileSync(argvLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    // Every hardening value precedes the caller's arguments as a separate argv entry.
    const flattened = RELEASE_GIT_CONFIG.flatMap((value) => ['-c', value]);
    expect(argv).toEqual([...flattened, 'rev-parse', 'HEAD']);
    expect(argv).not.toContain('push');
    expect(argv.some((arg) => arg.includes(' ; ') || arg.includes('&&'))).toBe(false);

    const env = readFileSync(envLog, 'utf8');
    expect(env).toContain('GIT_TERMINAL_PROMPT=0');
    expect(env).toContain('GIT_CONFIG_NOSYSTEM=1');
    expect(env).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    expect(env).toContain('LC_ALL=C');
    expect(env).toContain(`GIT_SSH_COMMAND=${releaseSshCommand(SSH)}`);
    expect(env).not.toContain('GIT_DIR=');
    expect(env).not.toContain('SSH_AUTH_SOCK=');
    expect(env).not.toContain('hostile');
  });

  it('reports a missing git executable as an unavailable capability', async () => {
    const original = process.env['PATH'];
    process.env['PATH'] = '/nonexistent-release-tools';
    try {
      await expect(run(tempRoot())).rejects.toMatchObject({ code: 'git-unavailable' });
    } finally {
      process.env['PATH'] = original;
    }
  });

  it('redacts key material paths and control characters from a failure message', async () => {
    const { dir } = fakeExecutable(
      'git',
      `printf '%s\\n' "$GIT_SSH_COMMAND" >&2\nprintf '\\033[31mfatal\\033[0m line\\n' >&2\nexit 128`,
    );
    prependPath(dir);
    const error = await run(tempRoot()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ReleaseGitError);
    const blocker = error as ReleaseGitError;
    expect(blocker.code).toBe('git-failed');
    expect(blocker.message).not.toContain(KEY_FILE);
    expect(blocker.message).not.toContain(KNOWN_HOSTS);
    expect(blocker.message).toContain('***');
    expect(/[\x00-\x1f\x7f]/.test(blocker.message)).toBe(false);
  });

  it('bounds a huge child failure output instead of buffering it', async () => {
    const { dir } = fakeExecutable('git', `head -c 5000 /dev/zero | tr '\\0' 'x' >&2\nexit 1`);
    prependPath(dir);
    const error = await run(tempRoot()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ReleaseGitError);
    expect((error as ReleaseGitError).message.length).toBeLessThan(1_000);
  });

  it('maps a refused host key and a broken ssh transport to distinct blockers', async () => {
    const hostKey = fakeExecutable(
      'git',
      `printf 'Host key verification failed.\\n' >&2\nexit 255`,
    );
    prependPath(hostKey.dir);
    const untrusted = await run(tempRoot()).catch((err: unknown) => err);
    expect((untrusted as ReleaseGitError).code).toBe('git-ssh-untrusted');
    expect((untrusted as ReleaseGitError).message).toContain('host key');

    pathRestorers.pop()?.();
    const transport = fakeExecutable(
      'git',
      `printf "ssh: connect to host gitea.example.test port 22: Connection refused\\n" >&2\nexit 128`,
    );
    prependPath(transport.dir);
    const failed = await run(tempRoot()).catch((err: unknown) => err);
    expect((failed as ReleaseGitError).code).toBe('git-ssh-failed');
  });

  it('terminates the child process tree when the lifetime bound expires', async () => {
    const pidFile = join(tempRoot(), 'child.pid');
    const { dir } = fakeExecutable('git', `echo $$ > '${pidFile}'\nsleep 60`);
    prependPath(dir);
    const started = Date.now();
    const error = await runReleaseGit(['fetch', 'candidate'], {
      operation: 'fetch the test candidate',
      cwd: tempRoot(),
      ssh: SSH,
      timeoutMs: 150,
    }).catch((err: unknown) => err);
    expect((error as ReleaseGitError).code).toBe('git-timeout');
    expect(Date.now() - started).toBeLessThan(4_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('forces a group kill when a TERM-resistant descendant outlives the child', async () => {
    const root = tempRoot();
    const pidFile = join(root, 'survivor.pid');
    const { dir } = fakeExecutable(
      'git',
      `( trap '' TERM; exec sleep 60 ) &\necho $! > '${pidFile}'\nsleep 60`,
    );
    prependPath(dir);
    const error = await runReleaseGit(['fetch', 'candidate'], {
      operation: 'fetch the test candidate',
      cwd: root,
      ssh: SSH,
      timeoutMs: 200,
    }).catch((err: unknown) => err);
    expect((error as ReleaseGitError).code).toBe('git-timeout');
    const survivor = Number(readFileSync(pidFile, 'utf8').trim());
    expect(waitUntilNotRunning(survivor)).toBe(true);
  });

  it('terminates the child process tree on interruption', async () => {
    const pidFile = join(tempRoot(), 'child.pid');
    const { dir } = fakeExecutable('git', `echo $$ > '${pidFile}'\nsleep 60`);
    prependPath(dir);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await run(tempRoot(), ['fetch'], controller.signal).catch((err: unknown) => err);
    expect((error as ReleaseGitError).code).toBe('git-interrupted');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('stops a child that exceeds the output bound', async () => {
    const pidFile = join(tempRoot(), 'child.pid');
    const { dir } = fakeExecutable(
      'git',
      `echo $$ > '${pidFile}'\nhead -c 2000000 /dev/zero | tr '\\0' 'x'`,
    );
    prependPath(dir);
    const error = await runReleaseGit(['rev-parse', 'HEAD'], {
      operation: 'read the test candidate',
      cwd: tempRoot(),
      ssh: SSH,
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: 1024,
    }).catch((err: unknown) => err);
    expect((error as ReleaseGitError).code).toBe('git-output-too-large');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('settles after the child exits even when a descendant holds the pipes open', async () => {
    const root = tempRoot();
    const pidFile = join(root, 'grandchild.pid');
    const { dir } = fakeExecutable(
      'git',
      `sleep 60 & echo $! > '${pidFile}'\nprintf 'done'\nexit 0`,
    );
    prependPath(dir);
    const started = Date.now();
    const result = await runReleaseGit(['rev-parse', 'HEAD'], {
      operation: 'read the test candidate',
      cwd: root,
      ssh: SSH,
      timeoutMs: 10_000,
    });
    expect(result.stdout.toString('utf8')).toBe('done');
    expect(Date.now() - started).toBeLessThan(2_000);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {
      // The descendant may already be gone.
    }
  });

  it('refuses arguments that would choose a program or another repository', async () => {
    for (const argv of [
      ['fetch', '--upload-pack=/bin/sh'],
      ['log', '--exec=sh'],
      ['rev-parse', '--git-dir=/host'],
      ['cat-file', '--config=core.pager=sh'],
    ]) {
      await expect(run(tempRoot(), argv)).rejects.toMatchObject({
        code: 'git-invalid-request',
      });
    }
  });

  it('refuses a Git verb that could mutate a remote', async () => {
    for (const verb of ['push', 'tag', 'update-ref', 'receive-pack', 'remote']) {
      await expect(run(tempRoot(), [verb, 'origin'])).rejects.toMatchObject({
        code: 'git-invalid-request',
      });
    }
  });

  it('rejects an empty or NUL-bearing argument list', async () => {
    await expect(run(tempRoot(), [])).rejects.toMatchObject({ code: 'git-invalid-request' });
    await expect(run(tempRoot(), ['rev-parse\0HEAD'])).rejects.toMatchObject({
      code: 'git-invalid-request',
    });
  });
});
