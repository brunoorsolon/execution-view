import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedReleaseRepository } from '../config/schema.js';
import type {
  ReleaseObjectExpectation,
  ReleaseObservation,
  ReleaseRepositoryIdentity,
  ReleaseTagExpectation,
  ReleaseTagObservation,
} from '../core/release.js';
import { releaseNotesDigest } from '../core/releaseDigest.js';
import { createReleaseCheckout } from './checkout.js';
import { createReleaseForgeClient, type ReleaseForgeFetch } from './forgeClient.js';
import type { VerifiedReleaseIdentity } from './identity.js';
import {
  MAX_RELEASE_LIST_PAGES,
  MAX_TAGGER_FIELD,
  classifyRelease,
  classifyTag,
  combineRemoteState,
  observeReleaseRemoteState,
  observeReleaseState,
  observeTagState,
  type ReleaseObjectCheck,
  type ReleaseTagCheck,
} from './remoteState.js';

const REAL_PATH = process.env['PATH'] ?? '/usr/bin:/bin';
const NOTES = '## Changes\n\n- Ship the first safe release\n- Keep the exact bytes: é ☃\n';
const TAG = 'v1.0.0';
const TOKEN = 'canary_release_token_7f3a91';
const BASE = 'https://gitea.example.test';

const GIT_ENV: NodeJS.ProcessEnv = {
  HOME: tmpdir(),
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'author@example.test',
};

function gitEnv(): NodeJS.ProcessEnv {
  return { ...GIT_ENV, PATH: REAL_PATH };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();
}

function gitDir(dir: string, ...args: string[]): string {
  return execFileSync('git', ['--git-dir', dir, ...args], {
    encoding: 'utf8',
    env: gitEnv(),
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
  const root = mkdtempSync(join(tmpdir(), 'forge-desk-remote-state-'));
  chmodSync(root, 0o700);
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '--initial-branch=main', '--quiet');
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'first');
  const firstCommit = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'b.txt'), 'b\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'second');
  const headCommit = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '--quiet', '-b', 'side', firstCommit);
  writeFileSync(join(work, 'side.txt'), 'side\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'side');
  const sideCommit = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '--quiet', 'main');

  const remote = join(root, 'remote.git');
  execFileSync('git', ['clone', '--bare', '--quiet', work, remote], { env: gitEnv() });

  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const keyFile = join(root, 'release_key');
  writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
  const knownHostsFile = join(root, 'known_hosts');
  writeFileSync(knownHostsFile, 'gitea.example.test ssh-ed25519 AAAA\n', { mode: 0o600 });
  return { root, remote, stateDir, keyFile, knownHostsFile, firstCommit, headCommit, sideCommit };
}

/** A fake ssh that serves the disposable remote through the real Git transport. */
function fakeSsh(fixture: Fixture, behaviour?: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'forge-desk-ssh-'));
  const body = behaviour ?? `for arg do last=$arg; done\nexec git-upload-pack '${fixture.remote}'`;
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env['PATH'] = `${dir}:${REAL_PATH}`;
}

afterEach(() => {
  process.env['PATH'] = REAL_PATH;
});

const TAGGER_LINE = 'tagger Fixture Author <author@example.test> 1700000000 +0000';

/**
 * Writes a tag object into the bare remote. `literally` stores a corrupt object Git itself
 * refuses to hash, by writing the loose object and the ref file directly: `update-ref` refuses to
 * point a ref at an object it cannot parse.
 */
function writeRawTag(remote: string, name: string, body: string, literally = false): string {
  let oid: string;
  if (literally) {
    const content = Buffer.from(body, 'utf8');
    const stored = Buffer.concat([Buffer.from(`tag ${content.length}\0`, 'utf8'), content]);
    oid = createHash('sha1').update(stored).digest('hex');
    const directory = join(remote, 'objects', oid.slice(0, 2));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, oid.slice(2)), deflateSync(stored));
    mkdirSync(join(remote, 'refs', 'tags'), { recursive: true });
    writeFileSync(join(remote, 'refs', 'tags', name), `${oid}\n`);
    return oid;
  }
  oid = execFileSync('git', ['--git-dir', remote, 'hash-object', '-t', 'tag', '-w', '--stdin'], {
    input: body,
    encoding: 'utf8',
    env: gitEnv(),
  }).trim();
  gitDir(remote, 'update-ref', `refs/tags/${name}`, oid);
  return oid;
}

function annotatedTag(remote: string, name: string, commit: string, message = name): string {
  return writeRawTag(
    remote,
    name,
    `object ${commit}\ntype commit\ntag ${name}\n${TAGGER_LINE}\n\n${message}\n`,
  );
}

function signedTag(remote: string, name: string, commit: string): string {
  return writeRawTag(
    remote,
    name,
    `object ${commit}\ntype commit\ntag ${name}\n${TAGGER_LINE}\n\n${name}\n-----BEGIN PGP SIGNATURE-----\n\niQEcBAABCAAGBQJfixture\n-----END PGP SIGNATURE-----\n`,
  );
}

function lightweightTag(remote: string, name: string, commit: string): void {
  gitDir(remote, 'update-ref', `refs/tags/${name}`, commit);
}

function repository(fixture: Fixture): ResolvedReleaseRepository {
  return {
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
}

const REPOSITORY: ReleaseRepositoryIdentity = {
  repositoryId: 'app',
  forge: 'gitea',
  baseUrl: BASE,
  owner: 'acme',
  repo: 'api',
  forgeRepositoryId: 1001,
  defaultBranch: 'main',
};

function identity(): VerifiedReleaseIdentity {
  return {
    serverVersion: '1.26.1',
    account: { forge: 'gitea', baseUrl: BASE, login: 'release-bot', forgeUserId: 42 },
    repository: REPOSITORY,
    ssh: { user: 'git', host: 'gitea.example.test', port: '22', path: 'acme/api' },
  };
}

function checkoutFor(fixture: Fixture) {
  return createReleaseCheckout({
    stateDir: fixture.stateDir,
    repository: repository(fixture),
    identity: identity(),
  });
}

function tagExpectation(fixture: Fixture, overrides: Partial<ReleaseTagExpectation> = {}) {
  return {
    name: TAG,
    commit: fixture.headCommit,
    message: TAG,
    objectId: null,
    ...overrides,
  };
}

function releaseExpectation(overrides: Partial<ReleaseObjectExpectation> = {}) {
  return { tag: TAG, title: TAG, notesDigest: releaseNotesDigest(NOTES), ...overrides };
}

function releaseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    tag_name: TAG,
    name: TAG,
    body: NOTES,
    draft: false,
    prerelease: false,
    html_url: `${BASE}/acme/api/releases/tag/${TAG}`,
    author: { login: 'someone-else', id: 9 },
    assets: [],
    ...overrides,
  };
}

interface Call {
  path: string;
  method: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function forge(routes: Record<string, (url: URL) => Response>): {
  client: ReturnType<typeof createReleaseForgeClient>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: ReleaseForgeFetch = (input, init) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, method: init.method ?? 'GET' });
    const route = routes[url.pathname];
    return Promise.resolve(route ? route(url) : json({ message: 'not found' }, 404));
  };
  return { client: createReleaseForgeClient({ baseUrl: BASE, token: TOKEN, fetch }), calls };
}

/** A listing route that answers each page with the requested entries. */
function listing(pages: unknown[][]): (url: URL) => Response {
  return (url) => {
    const page = Number(url.searchParams.get('page') ?? '1');
    return json(pages[page - 1] ?? []);
  };
}

const RELEASE_PATH = '/api/v1/repos/acme/api/releases';
const RELEASE_TAG_PATH = `${RELEASE_PATH}/tags/${TAG}`;

function codes(check: { reasons: { code: string }[] }): string[] {
  return check.reasons.map((r) => r.code);
}

function tagCheck(overrides: Partial<ReleaseTagObservation>): ReleaseTagCheck {
  return {
    tag: {
      state: 'absent',
      name: TAG,
      commit: null,
      objectId: null,
      tagger: null,
      ...overrides,
    },
    reasons: [],
  };
}

function releaseCheck(overrides: Partial<ReleaseObservation>): ReleaseObjectCheck {
  return {
    release: {
      state: 'absent',
      tag: null,
      title: null,
      notesDigest: null,
      draft: null,
      prerelease: null,
      author: null,
      assets: null,
      ...overrides,
    },
    reasons: [],
  };
}

describe('remote tag classification', () => {
  it('reads an exact annotated unsigned tag with its real tagger from the verified origin', async () => {
    const fixture = makeFixture();
    const objectId = annotatedTag(fixture.remote, TAG, fixture.headCommit);
    fakeSsh(fixture);

    const check = await observeTagState(checkoutFor(fixture), tagExpectation(fixture));

    expect(check.reasons).toEqual([]);
    expect(check.tag).toEqual({
      state: 'exact',
      name: TAG,
      commit: fixture.headCommit,
      objectId,
      // The observed tagger is retained as-is; it is never the configured tagger.
      tagger: { name: 'Fixture Author', email: 'author@example.test' },
    });
  });

  it('reports an authoritative absence when the verified origin answers without the tag', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture);

    const check = await observeTagState(checkoutFor(fixture), tagExpectation(fixture));

    expect(check.tag).toEqual({
      state: 'absent',
      name: TAG,
      commit: null,
      objectId: null,
      tagger: null,
    });
    expect(check.reasons).toEqual([]);
  });

  it('blocks a lightweight tag, a signed tag, a wrong target and divergent annotation content', async () => {
    const fixture = makeFixture();
    lightweightTag(fixture.remote, 'v1.0.1', fixture.headCommit);
    signedTag(fixture.remote, 'v1.0.2', fixture.headCommit);
    annotatedTag(fixture.remote, 'v1.0.3', fixture.sideCommit, TAG);
    annotatedTag(fixture.remote, 'v1.0.4', fixture.headCommit, 'v9.9.9');
    fakeSsh(fixture);
    const checkout = checkoutFor(fixture);

    const lightweight = await observeTagState(
      checkout,
      tagExpectation(fixture, { name: 'v1.0.1' }),
    );
    expect(lightweight.tag.state).toBe('conflict');
    expect(codes(lightweight)).toEqual(['tag-not-annotated']);

    const signed = await observeTagState(checkout, tagExpectation(fixture, { name: 'v1.0.2' }));
    expect(signed.tag.state).toBe('conflict');
    expect(codes(signed)).toContain('tag-signed');

    const wrongTarget = await observeTagState(
      checkout,
      tagExpectation(fixture, { name: 'v1.0.3' }),
    );
    expect(wrongTarget.tag.state).toBe('conflict');
    expect(wrongTarget.tag.commit).toBe(fixture.sideCommit);
    expect(codes(wrongTarget)).toEqual(['tag-target-mismatch']);

    const wrongMessage = await observeTagState(
      checkout,
      tagExpectation(fixture, { name: 'v1.0.4', message: TAG }),
    );
    expect(wrongMessage.tag.state).toBe('conflict');
    expect(codes(wrongMessage)).toEqual(['tag-content-mismatch']);
  });

  it('requires the frozen planned tag object when the plan already has one', async () => {
    const fixture = makeFixture();
    const objectId = annotatedTag(fixture.remote, TAG, fixture.headCommit);
    fakeSsh(fixture);
    const checkout = checkoutFor(fixture);

    const matching = await observeTagState(checkout, tagExpectation(fixture, { objectId }));
    expect(matching.tag.state).toBe('exact');

    const frozen = await observeTagState(
      checkout,
      tagExpectation(fixture, { objectId: 'f'.repeat(40) }),
    );
    expect(frozen.tag.state).toBe('conflict');
    expect(codes(frozen)).toEqual(['tag-object-mismatch']);
  });

  it('keeps a tag unknown when the remote cannot be read and never treats it as absent', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture, 'exit 255');

    const check = await observeTagState(checkoutFor(fixture), tagExpectation(fixture));

    expect(check.tag.state).toBe('unknown');
    expect(check.tag.commit).toBeNull();
    expect(codes(check)).toEqual(['tag-unreadable']);
  });

  it('rejects an unsafe tag name instead of building a refspec from it', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture);

    const check = await observeTagState(
      checkoutFor(fixture),
      tagExpectation(fixture, { name: '--upload-pack=evil' }),
    );

    expect(check.tag.state).toBe('unknown');
    expect(codes(check)).toEqual(['tag-unreadable']);
  });

  it('refuses a crafted tag object Git would not write', async () => {
    const fixture = makeFixture();
    // A tag object with no `tag` header, one that repeats a header Git writes once, and one
    // with no tagger identity to retain. Git itself refuses to write these, so the fixture
    // forces the corrupt objects into the remote.
    writeRawTag(
      fixture.remote,
      'v1.0.5',
      `object ${fixture.headCommit}\ntype commit\n${TAGGER_LINE}\n\nv1.0.5\n`,
      true,
    );
    writeRawTag(
      fixture.remote,
      'v1.0.6',
      `object ${fixture.headCommit}\ntype commit\ntag v1.0.6\ntag v1.0.6\n${TAGGER_LINE}\n\nv1.0.6\n`,
      true,
    );
    writeRawTag(
      fixture.remote,
      'v1.0.7',
      `object ${fixture.headCommit}\ntype commit\ntag v1.0.7\n\nv1.0.7\n`,
      true,
    );
    fakeSsh(fixture);
    const checkout = checkoutFor(fixture);

    for (const name of ['v1.0.5', 'v1.0.6', 'v1.0.7']) {
      const check = await observeTagState(
        checkout,
        tagExpectation(fixture, { name, message: name }),
      );
      expect(check.tag.state).toBe('unknown');
      expect(codes(check)).toEqual(['tag-unreadable']);
    }
  });

  it('does not accept a tagger identity it cannot retain, or an annotation that differs by a BOM', async () => {
    const fixture = makeFixture();
    const longName = 'A'.repeat(MAX_TAGGER_FIELD + 1);
    writeRawTag(
      fixture.remote,
      'v1.0.8',
      `object ${fixture.headCommit}\ntype commit\ntag v1.0.8\ntagger ${longName} <author@example.test> 1700000000 +0000\n\nv1.0.8\n`,
    );
    writeRawTag(
      fixture.remote,
      'v1.0.9',
      `object ${fixture.headCommit}\ntype commit\ntag v1.0.9\n${TAGGER_LINE}\n\n\uFEFFv1.0.9\n`,
    );
    fakeSsh(fixture);
    const checkout = checkoutFor(fixture);

    const oversized = await observeTagState(
      checkout,
      tagExpectation(fixture, { name: 'v1.0.8', message: 'v1.0.8' }),
    );
    expect(oversized.tag.state).toBe('unknown');
    expect(oversized.tag.tagger).toBeNull();
    expect(codes(oversized)).toEqual(['tag-unreadable']);

    // The BOM is a real byte the plan never approved, so the message is not the exact one.
    const bom = await observeTagState(
      checkout,
      tagExpectation(fixture, { name: 'v1.0.9', message: 'v1.0.9' }),
    );
    expect(bom.tag.state).toBe('conflict');
    expect(codes(bom)).toEqual(['tag-content-mismatch']);
  });

  it('keeps the tag unknown when the remote moves it between listing and fetching', async () => {
    const fixture = makeFixture();
    annotatedTag(fixture.remote, TAG, fixture.headCommit);
    const movedId = annotatedTag(fixture.remote, 'v9.9.9', fixture.headCommit, 'moved');
    // The first ssh invocation serves the listing; the second moves the ref, then serves the
    // fetch, so the two reads cannot agree on the tag object.
    const dir = mkdtempSync(join(tmpdir(), 'forge-desk-ssh-'));
    const counter = join(dir, 'count');
    writeFileSync(
      join(dir, 'ssh'),
      `#!/bin/sh\nn=$(cat '${counter}' 2>/dev/null || echo 0)\necho $((n+1)) > '${counter}'\nif [ "$n" = "0" ]; then\n  exec git-upload-pack '${fixture.remote}'\nfi\ngit --git-dir '${fixture.remote}' update-ref refs/tags/${TAG} '${movedId}'\nexec git-upload-pack '${fixture.remote}'\n`,
      { mode: 0o755 },
    );
    process.env['PATH'] = `${dir}:${REAL_PATH}`;

    const check = await observeTagState(checkoutFor(fixture), tagExpectation(fixture));

    expect(check.tag.state).toBe('unknown');
    expect(codes(check)).toEqual(['tag-unreadable']);
  });
});

describe('remote release classification', () => {
  it('classifies an exact release and retains the actual author', async () => {
    const { client, calls } = forge({ [RELEASE_TAG_PATH]: () => json(releaseRecord()) });

    const check = await observeReleaseState(client, REPOSITORY, releaseExpectation());

    expect(check.reasons).toEqual([]);
    expect(check.release).toEqual({
      state: 'exact',
      tag: TAG,
      title: TAG,
      notesDigest: releaseNotesDigest(NOTES),
      draft: false,
      prerelease: false,
      author: 'someone-else',
      assets: 0,
    });
    // Read-only: the classifier only ever issues GET requests.
    expect(calls).toEqual([{ path: RELEASE_TAG_PATH, method: 'GET' }]);
  });

  it('blocks a release whose tag, title, notes, flags or assets diverge', async () => {
    const cases: { record: Record<string, unknown>; code: string }[] = [
      { record: releaseRecord({ tag_name: 'v1.0.1' }), code: 'release-content-mismatch' },
      { record: releaseRecord({ name: 'Other title' }), code: 'release-content-mismatch' },
      { record: releaseRecord({ body: 'other notes\n' }), code: 'release-content-mismatch' },
      { record: releaseRecord({ draft: true }), code: 'release-content-mismatch' },
      { record: releaseRecord({ prerelease: true }), code: 'release-content-mismatch' },
      {
        record: releaseRecord({ assets: [{ id: 1, name: 'artifact.zip' }] }),
        code: 'release-has-assets',
      },
    ];
    for (const { record, code } of cases) {
      const { client } = forge({ [RELEASE_TAG_PATH]: () => json(record) });
      const check = await observeReleaseState(client, REPOSITORY, releaseExpectation());
      expect(check.release.state).toBe('conflict');
      expect(codes(check)).toContain(code);
    }
  });

  it('keeps an unverifiable release identity, shape or author unknown, never exact', async () => {
    const cases: Record<string, unknown>[] = [
      releaseRecord({ assets: undefined }),
      releaseRecord({ body: undefined }),
      releaseRecord({ draft: 'false' }),
      // An exact release must retain its actual author, so unusable attribution blocks it.
      releaseRecord({ author: undefined }),
      releaseRecord({ author: {} }),
      releaseRecord({ author: { login: '' } }),
      releaseRecord({ author: { login: '   ' } }),
      releaseRecord({ author: { login: ' release-bot ' } }),
    ];
    for (const record of cases) {
      const { client } = forge({ [RELEASE_TAG_PATH]: () => json(record) });
      const check = await observeReleaseState(client, REPOSITORY, releaseExpectation());
      expect(check.release.state).toBe('unknown');
      expect(codes(check)).toEqual(['release-unreadable']);
    }

    const foreignUrl: Record<string, unknown>[] = [
      releaseRecord({ html_url: 'https://evil.test/acme/api/releases/tag/v1.0.0' }),
      releaseRecord({ html_url: `${BASE}/acme/other/releases/tag/v1.0.0` }),
      releaseRecord({ html_url: undefined }),
    ];
    for (const record of foreignUrl) {
      const { client } = forge({ [RELEASE_TAG_PATH]: () => json(record) });
      const check = await observeReleaseState(client, REPOSITORY, releaseExpectation());
      expect(check.release.state).toBe('unknown');
      expect(codes(check)).toEqual(['release-identity-unverified']);
    }
  });

  it('treats a 404 as absence only when a complete release listing agrees', async () => {
    const { client } = forge({
      [RELEASE_PATH]: listing([[{ tag_name: 'v0.9.0' }]]),
    });

    const check = await observeReleaseState(client, REPOSITORY, releaseExpectation());

    expect(check.release).toEqual({
      state: 'absent',
      tag: null,
      title: null,
      notesDigest: null,
      draft: null,
      prerelease: null,
      author: null,
      assets: null,
    });
    expect(check.reasons).toEqual([]);
  });

  it('keeps a contradictory 404 unknown when the listing names the tag', async () => {
    const { client } = forge({
      [RELEASE_PATH]: listing([[{ tag_name: 'v0.9.0' }, { tag_name: TAG }]]),
    });

    const check = await observeReleaseState(client, REPOSITORY, releaseExpectation());

    expect(check.release.state).toBe('unknown');
    expect(codes(check)).toEqual(['release-contradictory']);
  });

  it('keeps an ambiguous 404 unknown when the listing cannot be read or is truncated', async () => {
    const failing = forge({
      [RELEASE_PATH]: () => json({ message: 'internal error' }, 500),
    }).client;
    const failed = await observeReleaseState(failing, REPOSITORY, releaseExpectation());
    expect(failed.release.state).toBe('unknown');
    expect(codes(failed)).toEqual(['release-listing-unproven']);

    // A listing whose entries cannot name their release has not disproved the planned tag.
    const unreadable = forge({
      [RELEASE_PATH]: listing([[null, { name: 'unreadable-release' }], []]),
    }).client;
    const malformed = await observeReleaseState(unreadable, REPOSITORY, releaseExpectation());
    expect(malformed.release.state).toBe('unknown');
    expect(codes(malformed)).toEqual(['release-listing-unproven']);

    // A listing that never ends inside the page bound cannot prove absence either.
    const fullPage = Array.from({ length: 50 }, (_, index) => ({ tag_name: `v0.0.${index}` }));
    const truncated = forge({ [RELEASE_PATH]: () => json(fullPage) }).client;
    const bounded = await observeReleaseState(truncated, REPOSITORY, releaseExpectation());
    expect(bounded.release.state).toBe('unknown');
    expect(codes(bounded)).toEqual(['release-listing-unproven']);

    // The page bound is caller-controlled, so a narrower bound also fails closed.
    const narrow = await observeReleaseState(truncated, REPOSITORY, releaseExpectation(), {
      maxListPages: 1,
    });
    expect(narrow.release.state).toBe('unknown');
    expect(codes(narrow)).toEqual(['release-listing-unproven']);
    expect(MAX_RELEASE_LIST_PAGES).toBeGreaterThan(0);
  });

  it('keeps transport, access and malformed answers unknown without any write', async () => {
    const unreachable: ReleaseForgeFetch = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const transport = createReleaseForgeClient({ baseUrl: BASE, token: TOKEN, fetch: unreachable });
    const transportCheck = await observeReleaseState(transport, REPOSITORY, releaseExpectation());
    expect(transportCheck.release.state).toBe('unknown');
    expect(codes(transportCheck)).toEqual(['release-unreadable']);

    const unauthenticated = forge({
      [RELEASE_TAG_PATH]: () => json({ message: 'denied' }, 403),
    }).client;
    const denied = await observeReleaseState(unauthenticated, REPOSITORY, releaseExpectation());
    expect(denied.release.state).toBe('unknown');
    expect(codes(denied)).toEqual(['release-unreadable']);

    const malformed = forge({
      [RELEASE_TAG_PATH]: () => new Response('{not json', { status: 200 }),
    }).client;
    const broken = await observeReleaseState(malformed, REPOSITORY, releaseExpectation());
    expect(broken.release.state).toBe('unknown');
    expect(codes(broken)).toEqual(['release-unreadable']);

    // A redirect would move the release token elsewhere, so it can never read as absence.
    const redirected = forge({
      [RELEASE_TAG_PATH]: () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.test/releases' } }),
    }).client;
    const redirect = await observeReleaseState(redirected, REPOSITORY, releaseExpectation());
    expect(redirect.release.state).toBe('unknown');
    expect(codes(redirect)).toEqual(['release-unreadable']);
  });
});

describe('combined remote state', () => {
  it('permits only the section 8 outcomes and blocks every other combination', () => {
    const absentTagCheck = tagCheck({ state: 'absent' });
    const exactTagCheck = tagCheck({
      state: 'exact',
      commit: 'a'.repeat(40),
      objectId: 'b'.repeat(40),
    });
    const conflictTagCheck: ReleaseTagCheck = {
      tag: { state: 'conflict', name: TAG, commit: null, objectId: null, tagger: null },
      reasons: [{ code: 'tag-not-annotated', message: 'lightweight' }],
    };
    const unknownTagCheck: ReleaseTagCheck = {
      tag: { state: 'unknown', name: TAG, commit: null, objectId: null, tagger: null },
      reasons: [{ code: 'tag-unreadable', message: 'unreachable' }],
    };
    const absentReleaseCheck = releaseCheck({ state: 'absent' });
    const exactReleaseCheck = releaseCheck({ state: 'exact', tag: TAG, title: TAG });
    const conflictReleaseCheck: ReleaseObjectCheck = {
      release: { ...exactReleaseCheck.release, state: 'conflict' },
      reasons: [{ code: 'release-has-assets', message: 'one asset' }],
    };
    const unknownReleaseCheck: ReleaseObjectCheck = {
      release: { ...exactReleaseCheck.release, state: 'unknown' },
      reasons: [{ code: 'release-unreadable', message: 'unreadable' }],
    };

    expect(combineRemoteState(absentTagCheck, absentReleaseCheck)).toMatchObject({
      actions: [
        { kind: 'create-tag', tag: TAG },
        { kind: 'create-release', tag: TAG },
      ],
      reasons: [],
    });
    expect(combineRemoteState(exactTagCheck, absentReleaseCheck)).toMatchObject({
      actions: [{ kind: 'create-release', tag: TAG }],
      reasons: [],
    });
    expect(combineRemoteState(exactTagCheck, exactReleaseCheck)).toMatchObject({
      actions: [],
      reasons: [],
    });
    expect(combineRemoteState(absentTagCheck, exactReleaseCheck)).toMatchObject({
      actions: [],
      reasons: [{ code: 'release-without-tag' }],
    });

    for (const [tag, release] of [
      [conflictTagCheck, absentReleaseCheck],
      [unknownTagCheck, absentReleaseCheck],
      [exactTagCheck, conflictReleaseCheck],
      [exactTagCheck, unknownReleaseCheck],
      [conflictTagCheck, conflictReleaseCheck],
    ] as const) {
      const combined = combineRemoteState(tag, release);
      expect(combined.actions).toEqual([]);
      expect(combined.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('observeReleaseRemoteState', () => {
  it('combines an exact tag and exact release into a verified no-op', async () => {
    const fixture = makeFixture();
    const objectId = annotatedTag(fixture.remote, TAG, fixture.headCommit);
    fakeSsh(fixture);
    const { client, calls } = forge({ [RELEASE_TAG_PATH]: () => json(releaseRecord()) });

    const observation = await observeReleaseRemoteState({
      repository: REPOSITORY,
      checkout: checkoutFor(fixture),
      forge: client,
      tag: tagExpectation(fixture, { objectId }),
      release: releaseExpectation(),
    });

    expect(observation.tag.state).toBe('exact');
    expect(observation.release.state).toBe('exact');
    expect(observation.actions).toEqual([]);
    expect(observation.reasons).toEqual([]);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('permits tag and release creation only for an absent/absent repository', async () => {
    const fixture = makeFixture();
    fakeSsh(fixture);
    const { client } = forge({ [RELEASE_PATH]: listing([[]]) });

    const observation = await observeReleaseRemoteState({
      repository: REPOSITORY,
      checkout: checkoutFor(fixture),
      forge: client,
      tag: tagExpectation(fixture),
      release: releaseExpectation(),
    });

    expect(observation.actions).toEqual([
      { kind: 'create-tag', tag: TAG },
      { kind: 'create-release', tag: TAG },
    ]);
    expect(observation.reasons).toEqual([]);
  });

  it('blocks the whole repository when either observation is not exact or absent', async () => {
    const fixture = makeFixture();
    annotatedTag(fixture.remote, TAG, fixture.sideCommit);
    fakeSsh(fixture);
    const { client } = forge({ [RELEASE_TAG_PATH]: () => json(releaseRecord()) });

    const observation = await observeReleaseRemoteState({
      repository: REPOSITORY,
      checkout: checkoutFor(fixture),
      forge: client,
      tag: tagExpectation(fixture),
      release: releaseExpectation(),
    });

    expect(observation.tag.state).toBe('conflict');
    expect(observation.release.state).toBe('exact');
    expect(observation.actions).toEqual([]);
    expect(codes(observation)).toContain('tag-target-mismatch');
  });
});

describe('release classification units', () => {
  it('never marks an unparseable release record exact', () => {
    const check = classifyRelease('not a record', releaseExpectation(), REPOSITORY);
    expect(check.release.state).toBe('unknown');
    expect(codes(check)).toEqual(['release-unreadable']);
  });

  it('rejects an annotated tag object whose message is not valid UTF-8', () => {
    const check = classifyTag(
      {
        objectId: 'a'.repeat(40),
        objectType: 'tag',
        bytes: Buffer.concat([
          Buffer.from(`object ${'b'.repeat(40)}\ntype commit\ntag ${TAG}\n${TAGGER_LINE}\n\n`),
          Buffer.from([0xff, 0xfe]),
        ]),
      },
      {
        name: TAG,
        commit: 'b'.repeat(40),
        message: TAG,
        objectId: null,
      },
    );
    expect(check.tag.state).toBe('unknown');
    expect(codes(check)).toEqual(['tag-unreadable']);
  });
});
