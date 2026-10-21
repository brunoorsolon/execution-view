import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireReleaseOwnership,
  OWNERSHIP_LOCK_FILE,
  ReleaseOwnershipError,
  repositoryOperationKey,
  type ReleaseOwnership,
  type ReleaseOwnershipOptions,
  type ReleaseRepositoryKey,
} from './releaseOwnership.js';

const run = promisify(execFile);

/** The ownership lock is Linux flock(2) through the platform helper. */
const flockAvailable = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v flock'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const enabled = process.platform === 'linux' && flockAvailable;

const cleanups: Array<() => Promise<void> | void> = [];
const owned: ReleaseOwnership[] = [];

afterEach(async () => {
  while (owned.length > 0) await owned.pop()?.shutdown();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ev-release-owner-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function tempStateDir(): string {
  const stateDir = join(tempRoot(), 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  return stateDir;
}

async function acquire(options: ReleaseOwnershipOptions): Promise<ReleaseOwnership> {
  const ownership = await acquireReleaseOwnership({ shutdownTimeoutMs: 1_000, ...options });
  owned.push(ownership);
  return ownership;
}

function repository(overrides: Partial<ReleaseRepositoryKey> = {}): ReleaseRepositoryKey {
  return {
    forge: 'gitea',
    baseUrl: 'https://gitea.example.com',
    owner: 'example',
    repo: 'app',
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(enabled)('release ownership', () => {
  it('refuses a second owner of the same release state directory', async () => {
    const stateDir = tempStateDir();
    await acquire({ stateDir });

    const refusal = await acquireReleaseOwnership({ stateDir }).then(
      () => null,
      (error: ReleaseOwnershipError) => error,
    );
    expect(refusal?.code).toBe('lock-busy');
    expect(refusal?.message).toContain(stateDir);
    // Another process cannot take the OS lock either: the kernel refuses it.
    const conflict = await run('flock', [
      '--nonblock',
      join(stateDir, OWNERSHIP_LOCK_FILE),
      'true',
    ]).then(
      () => 0,
      (error: { code?: number }) => error.code ?? -1,
    );
    expect(conflict).toBe(1);
  });

  it('keeps the ownership lock file private', async () => {
    const stateDir = tempStateDir();
    const ownership = await acquire({ stateDir });
    expect(ownership.lockFile).toBe(join(stateDir, OWNERSHIP_LOCK_FILE));
    expect(statSync(ownership.lockFile).mode & 0o777).toBe(0o600);
  });

  it('releases ownership on shutdown so a restart can own it, and reports once', async () => {
    const stateDir = tempStateDir();
    const first = await acquire({ stateDir });
    const report = await first.shutdown();
    expect(report.lockReleased).toBe(true);
    expect(first.accepting).toBe(false);
    expect(await first.shutdown()).toBe(report);

    const second = await acquire({ stateDir });
    expect(second.accepting).toBe(true);
  });

  it('serializes release operations for one forge-qualified repository', async () => {
    const ownership = await acquire({ stateDir: tempStateDir() });
    const events: string[] = [];
    let running = 0;
    let peak = 0;
    const operation = (name: string) => async (): Promise<string> => {
      running += 1;
      peak = Math.max(peak, running);
      events.push(`start:${name}`);
      await sleep(20);
      events.push(`end:${name}`);
      running -= 1;
      return name;
    };

    const results = await Promise.all([
      ownership.runExclusive(repository(), operation('first')),
      ownership.runExclusive(
        // Equivalent spellings of one endpoint: a trailing slash and an explicit default port.
        repository({ baseUrl: 'https://GITEA.example.com:443/' }),
        operation('second'),
      ),
    ]);

    expect(results).toEqual(['first', 'second']);
    expect(peak).toBe(1);
    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('lets separate configured repositories progress independently', async () => {
    const ownership = await acquire({ stateDir: tempStateDir() });
    let running = 0;
    let peak = 0;
    const operation = async (): Promise<string> => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(30);
      running -= 1;
      return 'done';
    };

    await Promise.all([
      ownership.runExclusive(repository(), operation),
      ownership.runExclusive(repository({ repo: 'other' }), operation),
      ownership.runExclusive(repository({ baseUrl: 'https://gitea2.example.com' }), operation),
    ]);

    expect(peak).toBe(3);
  });

  it('drains accepted queued work for one repository before releasing ownership', async () => {
    const ownership = await acquire({ stateDir: tempStateDir() });
    const events: string[] = [];
    const operation = (name: string) => async (): Promise<string> => {
      events.push(name);
      return name;
    };
    const first = ownership.runExclusive(repository(), operation('first'));
    const second = ownership.runExclusive(repository(), operation('second'));

    const report = await ownership.shutdown();

    // Both were admitted before shutdown, so both run and the report is truthful about it.
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(events).toEqual(['first', 'second']);
    expect(report).toEqual({ drained: true, pending: [], lockReleased: true });
  });

  it('drains accepted work within the bound on shutdown', async () => {
    const ownership = await acquire({ stateDir: tempStateDir() });
    const work = ownership.runExclusive(repository(), async () => {
      await sleep(20);
      return 'published';
    });

    const report = await ownership.shutdown();

    expect(report).toEqual({ drained: true, pending: [], lockReleased: true });
    expect(await work).toBe('published');
  });

  it('bounds shutdown, keeps ownership while admitted work is unresolved, and reports it', async () => {
    const stateDir = tempStateDir();
    const ownership = await acquire({ stateDir, shutdownTimeoutMs: 50 });
    let finish: (value: string) => void = () => undefined;
    const stuck = ownership.runExclusive(
      repository(),
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    await sleep(10);

    const started = Date.now();
    const report = await ownership.shutdown();
    const elapsed = Date.now() - started;

    expect(report.drained).toBe(false);
    expect(report.pending).toEqual([repositoryOperationKey(repository())]);
    expect(report.lockReleased).toBe(false);
    expect(elapsed).toBeLessThan(2_000);
    // The unresolved work may still mutate the directory, so ownership stays here and a
    // replacement owner is refused meanwhile.
    await expect(acquireReleaseOwnership({ stateDir })).rejects.toMatchObject({
      code: 'lock-busy',
    });

    // Once the late work ends, ownership is released terminally, so a restart can take over and
    // this process has nothing left holding it open.
    finish('late');
    await stuck;
    const restarted = await acquire({ stateDir });
    expect(restarted.accepting).toBe(true);
  });

  it('refuses a replacement owner while admitted work may still mutate', async () => {
    const stateDir = tempStateDir();
    const lost: string[] = [];
    const ownership = await acquire({ stateDir, onLost: (reason) => lost.push(reason) });
    let finish: () => void = () => undefined;
    const running = ownership.runExclusive(
      repository(),
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await sleep(20);

    // Kill the ownership helper: the kernel frees the lifetime lock while the operation runs.
    const holders = execFileSync('pgrep', ['-f', ownership.lockFile], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((pid) => pid !== '');
    expect(holders.length).toBeGreaterThan(0);
    for (const pid of holders) process.kill(Number(pid), 'SIGKILL');
    await expect.poll(() => ownership.accepting, { timeout: 2_000 }).toBe(false);
    expect(lost).toHaveLength(1);

    // The work lock of the still-running operation refuses the replacement owner.
    await expect(acquireReleaseOwnership({ stateDir })).rejects.toMatchObject({
      code: 'work-in-flight',
    });

    finish();
    await running;
    const restarted = await acquire({ stateDir });
    expect(restarted.accepting).toBe(true);
  });

  it('fences queued work when the ownership lock is lost, and reports the loss', async () => {
    const stateDir = tempStateDir();
    const lost: string[] = [];
    const ownership = await acquire({ stateDir, onLost: (reason) => lost.push(reason) });
    let finish: () => void = () => undefined;
    const running = ownership.runExclusive(
      repository(),
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const queued = ownership.runExclusive(repository(), async () => 'queued ran');
    await sleep(20);

    // Kill the helper: the kernel releases the lock, so this process no longer owns the directory.
    const holders = execFileSync('pgrep', ['-f', ownership.lockFile], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((pid) => pid !== '');
    expect(holders.length).toBeGreaterThan(0);
    for (const pid of holders) process.kill(Number(pid), 'SIGKILL');

    await expect.poll(() => ownership.accepting, { timeout: 2_000 }).toBe(false);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain(stateDir);
    expect(() => ownership.runExclusive(repository(), async () => 'never')).toThrow(
      /no longer owns/,
    );

    // The operation admitted before the loss finishes; the queued one never starts.
    finish();
    await running;
    await expect(queued).rejects.toMatchObject({ code: 'not-accepting' });
    await expect(queued).rejects.toThrow(/no longer owns/);
  });

  it('refuses new release work once shutdown starts', async () => {
    const ownership = await acquire({ stateDir: tempStateDir() });
    await ownership.shutdown();

    expect(() => ownership.runExclusive(repository(), async () => 'never')).toThrow(
      ReleaseOwnershipError,
    );
    expect(() => ownership.runExclusive(repository(), async () => 'never')).toThrow(
      /refusing|refused/,
    );
  });

  it('refuses an unsafe state directory', async () => {
    const root = tempRoot();
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    chmodSync(stateDir, 0o755);

    await expect(acquireReleaseOwnership({ stateDir })).rejects.toMatchObject({
      code: 'unsafe-state-dir',
    });

    chmodSync(stateDir, 0o700);
    const link = join(root, 'linked');
    symlinkSync(stateDir, link);
    await expect(acquireReleaseOwnership({ stateDir: link })).rejects.toMatchObject({
      code: 'unsafe-state-dir',
    });

    await expect(acquireReleaseOwnership({ stateDir, uid: () => 424242 })).rejects.toMatchObject({
      code: 'unsafe-state-dir',
    });
  });

  it('refuses a shared or network filesystem instead of claiming ownership', async () => {
    const stateDir = tempStateDir();

    await expect(
      acquireReleaseOwnership({ stateDir, filesystemType: () => 0x6969 }),
    ).rejects.toThrow(/\bNFS\b/);
    await expect(
      acquireReleaseOwnership({ stateDir, filesystemType: () => 0x1234_5678 }),
    ).rejects.toThrow(/unknown filesystem type/);
    // Nothing was created: the refusal happens before the lock is claimed.
    expect(existsSync(join(stateDir, OWNERSHIP_LOCK_FILE))).toBe(false);
  });

  it('reports a missing lock helper and an unsupported platform', async () => {
    const stateDir = tempStateDir();

    await expect(
      acquireReleaseOwnership({ stateDir, flockPath: join(stateDir, 'no-such-flock') }),
    ).rejects.toMatchObject({ code: 'helper-missing' });
    await expect(acquireReleaseOwnership({ stateDir, platform: 'darwin' })).rejects.toMatchObject({
      code: 'unsupported-platform',
    });
  });
});
