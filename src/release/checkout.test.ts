import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedReleaseRepository } from '../config/schema.js';
import type { VerifiedReleaseIdentity } from './identity.js';
import { createReleaseCheckout } from './checkout.js';
import type { ReleaseGitBlocker, ReleaseGitResult } from './gitProcess.js';

const REAL_PATH = process.env['PATH'] ?? '/usr/bin:/bin';
const NOTES = '## Changes\n\n- Ship the first safe release\n- Keep the exact bytes: é ☃\n';

const GIT_ENV: NodeJS.ProcessEnv = {
  HOME: tmpdir(),
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Forge Desk Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Forge Desk Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_ENV, PATH: REAL_PATH },
  }).trim();
}

interface Fixture {
  root: string;
  remote: string;
  stateDir: string;
  keyFile: string;
  knownHostsFile: string;
  firstCommit: string;
  headCommit: string;
  sideCommit: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'forge-desk-checkout-'));
  chmodSync(root, 0o700);
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '--initial-branch=main', '--quiet');
  writeFileSync(join(work, 'README.md'), '# api\n');
  writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
  // A hostile repository: submodule, LFS attribute and a symlink are present in the tree.
  writeFileSync(
    join(work, '.gitmodules'),
    '[submodule "evil"]\n\tpath = evil\n\turl = ssh://git@evil.test/evil/evil.git\n',
  );
  writeFileSync(join(work, '.gitattributes'), '* filter=lfs\n');
  symlinkSync('RELEASE_NOTES.md', join(work, 'notes-link'));
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'first');
  const firstCommit = git(work, 'rev-parse', 'HEAD');
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'src', 'index.ts'), 'export const api = 1;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'second');
  const headCommit = git(work, 'rev-parse', 'HEAD');

  git(work, 'checkout', '--quiet', '-b', 'side', firstCommit);
  writeFileSync(join(work, 'side.txt'), 'side\n');
  writeFileSync(join(work, 'RELEASE_NOTES.md'), 'side notes\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'side');
  const sideCommit = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '--quiet', 'main');

  const remote = join(root, 'remote.git');
  execFileSync('git', ['clone', '--bare', '--quiet', work, remote], {
    env: { ...GIT_ENV, PATH: REAL_PATH },
  });

  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const keyFile = join(root, 'release_key');
  writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
  const knownHostsFile = join(root, 'known_hosts');
  writeFileSync(knownHostsFile, 'gitea.example.test ssh-ed25519 AAAA\n', { mode: 0o600 });
  return {
    root,
    remote,
    stateDir,
    keyFile,
    knownHostsFile,
    firstCommit,
    headCommit,
    sideCommit,
  };
}

/** A fake ssh that serves the disposable remote, or runs one failure behaviour instead. */
function fakeSsh(fixture: Fixture, behaviour?: string): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-desk-ssh-'));
  const log = join(dir, 'ssh.log');
  writeFileSync(log, '');
  const body = behaviour ?? `for arg do last=$arg; done\nexec git-upload-pack '${fixture.remote}'`;
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n${body}\n`, {
    mode: 0o755,
  });
  process.env['PATH'] = `${dir}:${REAL_PATH}`;
  return { dir, log };
}

afterEach(() => {
  process.env['PATH'] = REAL_PATH;
});

function repository(fixture: Fixture, overrides: Partial<ResolvedReleaseRepository> = {}) {
  const base: ResolvedReleaseRepository = {
    id: 'app',
    source: 'gt',
    repo: { owner: 'acme', repo: 'api' },
    origin: 'ssh://git@gitea.example.test/acme/api.git',
    token: { kind: 'env', name: 'RELEASE_TOKEN_ENV' },
    expectedApiUser: 'release-bot',
    ci: { workflowPath: '.gitea/workflows/validate.yaml' },
    ssh: { privateKeyFile: fixture.keyFile, knownHostsFile: fixture.knownHostsFile },
    tagger: { name: 'Forge Desk Release Bot', email: 'releases@example.test' },
  };
  return { ...base, ...overrides };
}

function identity(overrides: Partial<VerifiedReleaseIdentity['repository']> = {}) {
  const base: VerifiedReleaseIdentity = {
    serverVersion: '1.26.1',
    account: {
      forge: 'gitea',
      baseUrl: 'https://gitea.example.test',
      login: 'release-bot',
      forgeUserId: 42,
    },
    repository: {
      repositoryId: 'app',
      forge: 'gitea',
      baseUrl: 'https://gitea.example.test',
      owner: 'acme',
      repo: 'api',
      forgeRepositoryId: 1001,
      defaultBranch: 'main',
    },
    ssh: { user: 'git', host: 'gitea.example.test', port: '22', path: 'acme/api' },
  };
  return { ...base, repository: { ...base.repository, ...overrides } };
}

function checkoutFor(
  fixture: Fixture,
  options: {
    origin?: string;
    verified?: VerifiedReleaseIdentity;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
) {
  return createReleaseCheckout({
    stateDir: fixture.stateDir,
    repository: repository(fixture, options.origin === undefined ? {} : { origin: options.origin }),
    identity: options.verified ?? identity(),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
  });
}

async function candidate(fixture: Fixture, options = {}) {
  const result = await checkoutFor(fixture, options).fetchCandidate();
  if (!result.ok) throw new Error(`expected a candidate, got ${result.blocker.code}`);
  return result.value;
}

function blockerOf<T>(result: ReleaseGitResult<T>): ReleaseGitBlocker {
  if (result.ok) throw new Error('expected a blocker');
  return result.blocker;
}

describe('release candidate fetch', () => {
  it('selects the verified remote default-branch head with hardened ssh options', async () => {
    const fixture = makeFixture();
    const ssh = fakeSsh(fixture);

    expect(await candidate(fixture)).toEqual({ commit: fixture.headCommit, branch: 'main' });

    const lines = readFileSync(ssh.log, 'utf8').split('\n');
    for (const expected of [
      '-F',
      '/dev/null',
      '-oBatchMode=yes',
      '-oStrictHostKeyChecking=yes',
      '-oIdentitiesOnly=yes',
      '-oGlobalKnownHostsFile=/dev/null',
      `-oUserKnownHostsFile=${fixture.knownHostsFile}`,
      '-oForwardAgent=no',
    ]) {
      expect(lines).toContain(expected);
    }
    expect(lines[lines.indexOf('-i') + 1]).toBe(fixture.keyFile);
    expect(lines.some((line) => line.startsWith('git-upload-pack '))).toBe(true);
    // Read-only transport: the ssh command never asks the remote for a push service.
    const log = lines.join('\n');
    expect(log).not.toContain('receive-pack');
    expect(log).not.toContain('push');
  });

  it('ignores a decoy cache HEAD, candidate ref and FETCH_HEAD', async () => {
    const fixture = makeFixture();
    const cache = join(fixture.stateDir, 'checkout', 'app.git');
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    chmodSync(cache, 0o700);
    git(cache, 'init', '--bare', '--quiet');
    git(cache, 'fetch', '--quiet', fixture.remote, '+refs/heads/main:refs/heads/bootstrap');
    fakeSsh(fixture);
    git(cache, 'update-ref', 'refs/heads/decoy', fixture.firstCommit);
    git(cache, 'update-ref', 'refs/forge-desk/candidate', fixture.firstCommit);
    git(cache, 'symbolic-ref', 'HEAD', 'refs/heads/decoy');
    writeFileSync(join(cache, 'FETCH_HEAD'), `${fixture.firstCommit}\t\tbranch 'main' of decoy\n`);

    expect(await candidate(fixture)).toEqual({ commit: fixture.headCommit, branch: 'main' });
  });

  it('never reaches the remote when identity, origin or branch disagree', async () => {
    const cases: Array<{ options: Parameters<typeof checkoutFor>[1]; code: string }> = [
      { options: { verified: identity({ owner: 'other' }) }, code: 'git-repository-mismatch' },
      {
        options: { origin: 'ssh://git@gitea.example.test/other/api.git' },
        code: 'git-unsafe-origin',
      },
      {
        options: { origin: 'ssh://git@gitea.example.test:2222/acme/api.git' },
        code: 'git-unsafe-origin',
      },
      {
        options: { origin: 'ssh://git@evil.example.test/acme/api.git' },
        code: 'git-unsafe-origin',
      },
      {
        options: { origin: 'ssh://root@gitea.example.test/acme/api.git' },
        code: 'git-unsafe-origin',
      },
      { options: { origin: 'git@gitea.example.test:acme/api.git' }, code: 'git-unsafe-origin' },
      {
        options: { origin: 'ssh://git:secret@gitea.example.test/acme/api.git' },
        code: 'git-unsafe-origin',
      },
      {
        options: { origin: 'ssh://git@gitea.example.test/acme/api.git?x=1' },
        code: 'git-unsafe-origin',
      },
    ];
    for (const { options, code } of cases) {
      const fixture = makeFixture();
      const ssh = fakeSsh(fixture);
      expect(blockerOf(await checkoutFor(fixture, options).fetchCandidate()).code).toBe(code);
      expect(readFileSync(ssh.log, 'utf8')).toBe('');
    }

    const fixture = makeFixture();
    const ssh = fakeSsh(fixture);
    const unsafe = blockerOf(
      await checkoutFor(fixture, {
        verified: identity({ defaultBranch: '-evil' }),
      }).fetchCandidate(),
    );
    expect(unsafe.code).toBe('git-unsafe-revision');
    expect(readFileSync(ssh.log, 'utf8')).toBe('');
  });

  it('fails closed on a cache that is exposed or reached through a symlink', async () => {
    const exposed = makeFixture();
    const checkoutDir = join(exposed.stateDir, 'checkout');
    mkdirSync(checkoutDir, { mode: 0o755 });
    chmodSync(checkoutDir, 0o755);
    fakeSsh(exposed);
    expect(blockerOf(await checkoutFor(exposed).fetchCandidate()).code).toBe('git-unsafe-cache');

    const vanished = makeFixture();
    fakeSsh(vanished);
    rmSync(vanished.stateDir, { recursive: true, force: true });
    expect(blockerOf(await checkoutFor(vanished).fetchCandidate()).code).toBe('git-unsafe-cache');

    const linked = makeFixture();
    fakeSsh(linked);
    const linkedCheckout = join(linked.stateDir, 'checkout');
    mkdirSync(linkedCheckout, { mode: 0o700 });
    chmodSync(linkedCheckout, 0o700);
    symlinkSync(join(linked.root, 'elsewhere'), join(linkedCheckout, 'app.git'));
    expect(blockerOf(await checkoutFor(linked).fetchCandidate()).code).toBe('git-unsafe-cache');
  });

  it('ignores cache configuration that rewrites the origin or re-enables file transport', async () => {
    const fixture = makeFixture();
    const ssh = fakeSsh(fixture);
    expect((await candidate(fixture)).commit).toBe(fixture.headCommit);

    // A distinct decoy repository whose main branch is not the verified remote's head.
    const decoy = join(fixture.root, 'decoy.git');
    mkdirSync(decoy, { mode: 0o700 });
    git(decoy, 'init', '--bare', '--quiet');
    git(decoy, 'fetch', '--quiet', fixture.remote, '+refs/heads/main:refs/heads/main');
    git(decoy, 'update-ref', 'refs/heads/main', fixture.firstCommit);

    const cache = join(fixture.stateDir, 'checkout', 'app.git');
    git(cache, 'config', `url.${decoy}.insteadOf`, 'ssh://git@gitea.example.test/acme/api.git');
    git(cache, 'config', 'protocol.file.allow', 'always');
    writeFileSync(ssh.log, '');

    expect(await candidate(fixture)).toEqual({ commit: fixture.headCommit, branch: 'main' });
    expect(readFileSync(ssh.log, 'utf8')).toContain('git-upload-pack');
    expect(readFileSync(join(cache, 'config'), 'utf8')).not.toContain('insteadOf');
  });

  it('fails closed on an untrusted host key without echoing key paths', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture, `printf 'Host key verification failed.\\n' >&2\nexit 255`);
    const blocker = blockerOf(await checkoutFor(fixture).fetchCandidate());
    expect(blocker.code).toBe('git-ssh-untrusted');
    expect(blocker.message).not.toContain(fixture.keyFile);
    expect(blocker.message).not.toContain(fixture.knownHostsFile);
  });

  it('fails closed on a malformed Git response', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture, `printf 'not a git upload-pack response\\n'`);
    const blocker = blockerOf(await checkoutFor(fixture).fetchCandidate());
    expect(blocker.code).toBe('git-failed');
    expect(blocker.message).toContain('protocol error');
  });

  it('terminates a hanging ssh inside the configured lifetime bound', async () => {
    const fixture = makeFixture();
    const pidFile = join(fixture.root, 'ssh.pid');
    fakeSsh(fixture, `echo $$ > '${pidFile}'\nsleep 60`);
    const blocker = blockerOf(await checkoutFor(fixture, { timeoutMs: 200 }).fetchCandidate());
    expect(blocker.code).toBe('git-timeout');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('disables cache hooks, credential helpers, filters and submodule recursion', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture);
    expect((await candidate(fixture)).commit).toBe(fixture.headCommit);

    const cache = join(fixture.stateDir, 'checkout', 'app.git');
    const hooks = join(fixture.root, 'hooks');
    mkdirSync(hooks, { mode: 0o700 });
    const marker = join(fixture.root, 'hostile-ran');
    for (const hook of ['post-fetch', 'reference-transaction', 'post-checkout']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    }
    git(cache, 'config', 'core.hooksPath', hooks);
    git(cache, 'config', 'credential.helper', `!touch '${marker}'`);
    git(cache, 'config', 'filter.lfs.process', `!touch '${marker}'`);
    git(cache, 'config', 'filter.lfs.required', 'true');
    git(cache, 'config', 'submodule.recurse', 'true');
    git(cache, 'config', 'protocol.file.allow', 'always');

    // The remote moves forward, so a fresh fetch must actually run.
    const work = join(fixture.root, 'work');
    writeFileSync(join(work, 'README.md'), '# api v2\n');
    git(work, 'commit', '--quiet', '-am', 'third');
    const next = git(work, 'rev-parse', 'HEAD');
    execFileSync('git', ['push', '--quiet', fixture.remote, 'main'], {
      cwd: work,
      env: { ...GIT_ENV, PATH: REAL_PATH },
    });

    expect((await candidate(fixture)).commit).toBe(next);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(cache, 'modules'))).toBe(false);
  });
});

describe('release object reads', () => {
  it('reads exact committed bytes and Git tree modes without following a symlink', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture);
    const checkout = checkoutFor(fixture);
    const fetched = await checkout.fetchCandidate();
    if (!fetched.ok) throw new Error('expected a candidate');
    const head = fetched.value;
    const notes = await checkout.readEntry(head.commit, 'RELEASE_NOTES.md');
    if (!notes.ok || notes.value === null) throw new Error('expected the committed notes');
    expect(notes.value.mode).toBe('100644');
    expect(notes.value.type).toBe('blob');
    expect(notes.value.bytes?.toString('utf8')).toBe(NOTES);

    const link = await checkout.readEntry(head.commit, 'notes-link');
    if (!link.ok || link.value === null) throw new Error('expected the committed symlink');
    expect(link.value.mode).toBe('120000');
    expect(link.value.bytes?.toString('utf8')).toBe('RELEASE_NOTES.md');

    const tree = await checkout.readEntry(head.commit, 'src');
    if (!tree.ok || tree.value === null) throw new Error('expected the committed tree');
    expect(tree.value).toEqual({ mode: '040000', type: 'tree', bytes: null });

    expect(await checkout.readEntry(head.commit, 'absent.txt')).toEqual({ ok: true, value: null });

    // An object outside the fetched candidate's history is not release evidence, even when a
    // previous cache write left it in the same repository.
    const cache = join(fixture.stateDir, 'checkout', 'app.git');
    git(cache, 'fetch', '--quiet', fixture.remote, '+refs/heads/side:refs/heads/side');
    expect(blockerOf(await checkout.readEntry(fixture.sideCommit, 'side.txt')).code).toBe(
      'git-unsafe-revision',
    );

    // A replacement ref must not substitute another commit's bytes for the verified candidate.
    git(cache, 'replace', head.commit, fixture.sideCommit);
    const replaced = await checkout.readEntry(head.commit, 'RELEASE_NOTES.md');
    if (!replaced.ok || replaced.value === null) throw new Error('expected the committed notes');
    expect(replaced.value.bytes?.toString('utf8')).toBe(NOTES);
    expect(blockerOf(await checkout.readEntry(head.commit, '../outside')).code).toBe(
      'git-invalid-request',
    );
    expect(blockerOf(await checkout.readEntry('main', 'README.md')).code).toBe(
      'git-unsafe-revision',
    );
  });

  it('classifies an entry without reading blob content', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture);
    const work = join(fixture.root, 'work');
    writeFileSync(join(work, 'RELEASE_NOTES.md'), 'y'.repeat(4096));
    git(work, 'commit', '--quiet', '-am', 'grow the notes');
    execFileSync('git', ['push', '--quiet', fixture.remote, 'main'], {
      cwd: work,
      env: { ...GIT_ENV, PATH: REAL_PATH },
    });
    const checkout = checkoutFor(fixture, { maxOutputBytes: 1024 });
    const fetched = await checkout.fetchCandidate();
    if (!fetched.ok) throw new Error('expected a candidate');

    const notes = await checkout.readEntry(fetched.value.commit, 'RELEASE_NOTES.md', {
      content: false,
    });
    if (!notes.ok) throw new Error(`expected an entry, got ${notes.blocker.code}`);
    expect(notes.value).toEqual({ mode: '100644', type: 'blob', bytes: null });

    const link = await checkout.readEntry(fetched.value.commit, 'notes-link', { content: false });
    if (!link.ok) throw new Error(`expected an entry, got ${link.blocker.code}`);
    expect(link.value).toEqual({ mode: '120000', type: 'blob', bytes: null });

    // The same read with content still fails closed on the output bound.
    expect(blockerOf(await checkout.readEntry(fetched.value.commit, 'RELEASE_NOTES.md')).code).toBe(
      'git-output-too-large',
    );
  });

  it('exposes read-only operations and no mutation surface', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture);
    const checkout = checkoutFor(fixture);
    expect(Object.keys(checkout).sort()).toEqual([
      'candidate',
      'fetchCandidate',
      'isAncestor',
      'readCommitSubjects',
      'readEntry',
    ]);
    // Reads cannot precede a verified candidate fetch, and no candidate is exposed yet.
    expect(checkout.candidate()).toBeNull();
    expect(blockerOf(await checkout.readEntry('0'.repeat(40), 'README.md')).code).toBe(
      'git-invalid-request',
    );
    expect(blockerOf(await checkout.isAncestor('0'.repeat(40), '0'.repeat(40))).code).toBe(
      'git-invalid-request',
    );
    expect(blockerOf(await checkout.readCommitSubjects(null, '0'.repeat(40))).code).toBe(
      'git-invalid-request',
    );
  });
});
