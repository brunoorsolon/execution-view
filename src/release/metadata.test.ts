import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseNotesDigest } from '../core/releaseDigest.js';
import type { ResolvedReleaseRepository } from '../config/schema.js';
import { createReleaseCheckout, type ReleaseCheckout } from './checkout.js';
import type { VerifiedReleaseIdentity } from './identity.js';
import {
  DEFAULT_MAX_NOTES_BYTES,
  deriveReleaseMetadata,
  type ObservedTag,
  type ReleaseMetadata,
  type ReleaseMetadataBlocker,
  type ReleaseMetadataResult,
} from './metadata.js';

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
  work: string;
  remote: string;
  stateDir: string;
  keyFile: string;
  knownHostsFile: string;
}

/** A disposable Git repository whose default branch is `main` and whose remote is local. */
function newWork(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-desk-metadata-'));
  chmodSync(root, 0o700);
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '--initial-branch=main', '--quiet');
  return work;
}

function commitAll(work: string, message: string): string {
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
}

/** Creates an annotated tag and returns the observation a caller would supply for it. */
function annotate(work: string, name: string, target = 'HEAD'): ObservedTag {
  git(work, 'tag', '-a', name, '-m', name, target);
  return { name, peeledCommit: git(work, 'rev-parse', `${name}^{}`) };
}

/** Publishes the working repository as a disposable remote plus a fake ssh that serves it. */
function publish(work: string): Fixture {
  const root = join(work, '..');
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

  const sshDir = mkdtempSync(join(tmpdir(), 'forge-desk-ssh-'));
  writeFileSync(
    join(sshDir, 'ssh'),
    `#!/bin/sh\nfor arg do last=$arg; done\nexec git-upload-pack '${remote}'\n`,
    { mode: 0o755 },
  );
  process.env['PATH'] = `${sshDir}:${REAL_PATH}`;
  return { root, work, remote, stateDir, keyFile, knownHostsFile };
}

afterEach(() => {
  process.env['PATH'] = REAL_PATH;
});

function checkoutFor(fixture: Fixture): ReleaseCheckout {
  const repository: ResolvedReleaseRepository = {
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
  const identity: VerifiedReleaseIdentity = {
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
  return createReleaseCheckout({ stateDir: fixture.stateDir, repository, identity });
}

async function derive(
  fixture: Fixture,
  tags: readonly ObservedTag[],
  options: { maxNotesBytes?: number } = {},
): Promise<ReleaseMetadataResult> {
  const checkout = checkoutFor(fixture);
  const fetched = await checkout.fetchCandidate();
  if (!fetched.ok) throw new Error(`expected a candidate, got ${fetched.blocker.code}`);
  return deriveReleaseMetadata({
    checkout,
    candidate: fetched.value,
    tags,
    ...(options.maxNotesBytes !== undefined ? { maxNotesBytes: options.maxNotesBytes } : {}),
  });
}

async function metadataOf(
  fixture: Fixture,
  tags: readonly ObservedTag[] = [],
  options: { maxNotesBytes?: number } = {},
): Promise<ReleaseMetadata> {
  const result = await derive(fixture, tags, options);
  if (!result.ok) throw new Error(`expected metadata, got ${result.blocker.code}`);
  return result.value;
}

function blockerOf(result: ReleaseMetadataResult): ReleaseMetadataBlocker {
  if (result.ok) throw new Error('expected a metadata blocker');
  return result.blocker;
}

describe('release version derivation', () => {
  it('derives v0.1.0 with the exact committed notes for a first release', async () => {
    const work = newWork();
    writeFileSync(join(work, 'README.md'), '# api\n');
    commitAll(work, 'Add the API');
    writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
    const head = commitAll(work, 'Add the release notes');
    const fixture = publish(work);

    const metadata = await metadataOf(fixture);

    expect(metadata.candidate).toEqual({ commit: head, branch: 'main' });
    expect(metadata.version).toBe('v0.1.0');
    expect(metadata.title).toBe('v0.1.0');
    expect(metadata.tagMessage).toBe('v0.1.0');
    expect(metadata.baseline).toEqual({ tag: null, commit: null, stableTags: [] });
    expect(metadata.otherTags).toEqual([]);
    expect(metadata.notes).toEqual({
      text: NOTES,
      source: 'file',
      digest: releaseNotesDigest(NOTES),
    });
  });

  it('increments the patch of the numerically highest canonical stable tag', async () => {
    const work = newWork();
    writeFileSync(join(work, 'README.md'), '# api\n');
    writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
    const first = commitAll(work, 'Add the API');
    writeFileSync(join(work, 'docs.md'), '# docs\n');
    commitAll(work, 'Add docs');
    const tags = [
      annotate(work, 'v0.1.0', first),
      annotate(work, 'v0.0.9', first),
      annotate(work, 'v1.2.9', first),
      annotate(work, 'v1.2.99999999999999999999', first),
    ];
    const fixture = publish(work);

    const metadata = await metadataOf(fixture, tags);

    expect(metadata.version).toBe('v1.2.100000000000000000000');
    expect(metadata.baseline).toEqual({
      tag: 'v1.2.99999999999999999999',
      commit: first,
      stableTags: ['v0.0.9', 'v0.1.0', 'v1.2.9', 'v1.2.99999999999999999999'],
    });
  });

  it('never selects a noncanonical or prerelease tag but retains it as an observation', async () => {
    const work = newWork();
    writeFileSync(join(work, 'README.md'), '# api\n');
    writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
    const first = commitAll(work, 'Add the API');
    const tags = [
      annotate(work, 'v0.3.4', first),
      annotate(work, 'v01.2.3', first),
      annotate(work, 'v2.0.0-rc.1', first),
      annotate(work, 'V1.0.0', first),
      annotate(work, '1.5.0', first),
      annotate(work, 'release-9', first),
    ];
    const fixture = publish(work);

    const metadata = await metadataOf(fixture, tags);

    expect(metadata.version).toBe('v0.3.5');
    expect(metadata.baseline).toEqual({
      tag: 'v0.3.4',
      commit: first,
      stableTags: ['v0.3.4'],
    });
    expect(metadata.otherTags).toEqual(['1.5.0', 'V1.0.0', 'release-9', 'v01.2.3', 'v2.0.0-rc.1']);
  });

  it('blocks a baseline tag that is not an ancestor of the candidate', async () => {
    const work = newWork();
    writeFileSync(join(work, 'README.md'), '# api\n');
    const first = commitAll(work, 'Add the API');
    writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
    const second = commitAll(work, 'Add release notes');
    const behind = annotate(work, 'v0.1.0', second);
    const fixture = publish(work);

    // The first preparation sees `second` and leaves it in the cache.
    expect((await metadataOf(fixture, [])).candidate.commit).toBe(second);
    // The remote branch is force-moved back behind the tagged commit.
    git(work, 'reset', '--quiet', '--hard', first);
    execFileSync('git', ['push', '--quiet', '--force', fixture.remote, 'main'], {
      cwd: work,
      env: { ...GIT_ENV, PATH: REAL_PATH },
    });

    const blocker = blockerOf(await derive(fixture, [behind]));

    expect(blocker.code).toBe('baseline-not-ancestor');
    expect(blocker.message).toContain('v0.1.0');
    expect(blocker.message).toContain(first);
  });

  it('blocks a baseline whose commit the candidate history does not contain', async () => {
    const work = newWork();
    writeFileSync(join(work, 'README.md'), '# api\n');
    writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
    commitAll(work, 'Add the API');
    git(work, 'checkout', '--quiet', '-b', 'side');
    writeFileSync(join(work, 'side.md'), 'side\n');
    const side = commitAll(work, 'Unmerged side work');
    const elsewhere = annotate(work, 'v0.1.0', side);
    git(work, 'checkout', '--quiet', 'main');
    writeFileSync(join(work, 'README.md'), '# api, no side branch\n');
    commitAll(work, 'Add the API again');
    const fixture = publish(work);

    const blocker = blockerOf(await derive(fixture, [elsewhere]));

    expect(blocker.code).toBe('baseline-unavailable');
    expect(blocker.message).toContain('v0.1.0');
  });

  it('rejects unsafe tag observations instead of choosing a version from them', async () => {
    const work = newWork();
    writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
    const first = commitAll(work, 'Add the release notes');
    const fixture = publish(work);

    const cases: Array<{ tags: ObservedTag[]; detail: string }> = [
      {
        tags: [
          { name: 'v0.1.0', peeledCommit: first },
          { name: 'v0.1.0', peeledCommit: 'b'.repeat(40) },
        ],
        detail: 'two different commits',
      },
      { tags: [{ name: 'v0.1.0\u0007', peeledCommit: first }], detail: 'control characters' },
      { tags: [{ name: 'v0.1.0', peeledCommit: 'not-a-commit' }], detail: 'full commit id' },
      { tags: [{ name: '', peeledCommit: first }], detail: 'empty' },
    ];

    for (const { tags, detail } of cases) {
      const blocker = blockerOf(await derive(fixture, tags));
      expect(blocker.code).toBe('tag-invalid');
      expect(blocker.message).toContain(detail);
    }
  });
});

describe('release notes derivation', () => {
  it('falls back to committed subjects since the baseline, oldest to newest', async () => {
    const work = newWork();
    writeFileSync(join(work, 'README.md'), '# api\n');
    const first = commitAll(work, 'Add the deterministic parser');
    mkdirSync(join(work, 'src'));
    writeFileSync(join(work, 'src', 'index.ts'), 'export const api = 1;\n');
    commitAll(work, 'Add the release metadata module');
    const baseline = annotate(work, 'v0.1.0', first);
    writeFileSync(join(work, 'src', 'notes.test.ts'), 'export const covered = true;\n');
    const head = commitAll(work, 'Cover the notes fallback');
    const fixture = publish(work);

    const metadata = await metadataOf(fixture, [baseline]);

    expect(metadata.version).toBe('v0.1.1');
    expect(metadata.notes).toEqual({
      text: '# v0.1.1\n\n- Add the release metadata module\n- Cover the notes fallback\n',
      source: 'commit-subjects',
      digest: releaseNotesDigest(
        '# v0.1.1\n\n- Add the release metadata module\n- Cover the notes fallback\n',
      ),
    });

    const all = await metadataOf(fixture);
    expect(all.notes.text).toBe(
      '# v0.1.0\n\n- Add the deterministic parser\n- Add the release metadata module\n- Cover the notes fallback\n',
    );
    expect(all.candidate.commit).toBe(head);
  });

  it('falls back to committed subjects when RELEASE_NOTES.md is a symlink', async () => {
    const work = newWork();
    writeFileSync(join(work, 'other.md'), 'uncommitted notes are irrelevant\n');
    symlinkSync('other.md', join(work, 'RELEASE_NOTES.md'));
    commitAll(work, 'Add the release notes link');
    const fixture = publish(work);

    const metadata = await metadataOf(fixture);

    expect(metadata.notes.source).toBe('commit-subjects');
    expect(metadata.notes.text).toBe('# v0.1.0\n\n- Add the release notes link\n');
  });

  it('rejects notes that cannot be published exactly as committed', async () => {
    const cases: Array<{ notes: Buffer | 'directory'; code: string }> = [
      { notes: Buffer.alloc(0), code: 'notes-empty' },
      {
        notes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# x\n')]),
        code: 'notes-bom',
      },
      { notes: Buffer.from('a\0b\n'), code: 'notes-nul' },
      { notes: Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]), code: 'notes-invalid-utf8' },
      { notes: 'directory', code: 'notes-unsupported-mode' },
    ];

    for (const { notes, code } of cases) {
      const work = newWork();
      writeFileSync(join(work, 'README.md'), '# api\n');
      if (notes === 'directory') {
        mkdirSync(join(work, 'RELEASE_NOTES.md'));
        writeFileSync(join(work, 'RELEASE_NOTES.md', 'inner.md'), '# inner\n');
      } else {
        writeFileSync(join(work, 'RELEASE_NOTES.md'), notes);
      }
      commitAll(work, 'Add the release notes');
      const fixture = publish(work);

      expect(blockerOf(await derive(fixture, [])).code).toBe(code);
    }
  });

  it('blocks oversized notes with an explicit code instead of truncating them', async () => {
    const work = newWork();
    const oversized = Buffer.alloc(DEFAULT_MAX_NOTES_BYTES + 1, 'a');
    writeFileSync(join(work, 'RELEASE_NOTES.md'), oversized);
    commitAll(work, 'Add huge release notes');
    const fixture = publish(work);

    const blocker = blockerOf(await derive(fixture, [], { maxNotesBytes: 1024 }));

    expect(blocker.code).toBe('notes-too-large');
    expect(blocker.message).toContain(String(oversized.byteLength));
    expect(blocker.message).toContain('1024');
  });

  it('blocks unpreparable bounds and candidates without touching the notes', async () => {
    const work = newWork();
    writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
    commitAll(work, 'Add the release notes');
    const fixture = publish(work);

    expect(blockerOf(await derive(fixture, [], { maxNotesBytes: 0 })).code).toBe('invalid-request');
  });

  it('never lets local working-tree edits change the derived notes', async () => {
    const work = newWork();
    writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
    commitAll(work, 'Add the release notes');
    const fixture = publish(work);

    const committed = await metadataOf(fixture);
    writeFileSync(join(work, 'RELEASE_NOTES.md'), '# local edit\n\n- Never published\n');
    writeFileSync(join(work, 'untracked.md'), '# extra\n');
    const after = await metadataOf(fixture);

    expect(after.notes).toEqual(committed.notes);
    expect(after.notes.text).toBe(NOTES);
  });
});

describe('prepared metadata immutability', () => {
  it('freezes the tag metadata, baseline, notes and observations', async () => {
    const work = newWork();
    writeFileSync(join(work, 'RELEASE_NOTES.md'), NOTES);
    const first = commitAll(work, 'Add the release notes');
    const fixture = publish(work);

    const metadata = await metadataOf(fixture, [annotate(work, 'v0.1.0', first)]);

    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.candidate)).toBe(true);
    expect(Object.isFrozen(metadata.baseline)).toBe(true);
    expect(Object.isFrozen(metadata.baseline.stableTags)).toBe(true);
    expect(Object.isFrozen(metadata.notes)).toBe(true);
    expect(Object.isFrozen(metadata.otherTags)).toBe(true);
    expect(() => {
      (metadata as { version: string }).version = 'v9.9.9';
    }).toThrow(TypeError);
    expect(() => {
      (metadata.notes as { text: string }).text = '# edited\n';
    }).toThrow(TypeError);
    expect(metadata.version).toBe('v0.1.1');
  });
});
