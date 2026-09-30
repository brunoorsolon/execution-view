import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureProvider } from './fixture.js';

const DEMO_PATH = fileURLToPath(new URL('../../test/fixtures/demo.json', import.meta.url));

let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ev-fixture-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeFixture(content: unknown): Promise<string> {
  const path = join(dir, `f${counter++}.json`);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

const OPTS = { native: true, subIssues: false };
const NO_NATIVE = { native: false, subIssues: false };

function issue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { owner: 'acme', repo: 'api', number: 1, title: 'T', state: 'open', ...over };
}

describe('createFixtureProvider', () => {
  it('has kind fixture and reads lazily', async () => {
    const provider = createFixtureProvider({ path: join(dir, 'does-not-exist.json') });
    expect(provider.kind).toBe('fixture');
    await expect(provider.listOpenIssues({ owner: 'a', repo: 'b' }, OPTS)).rejects.toThrow(
      /Cannot read fixture file/,
    );
  });

  it('maps fields, applies defaults and builds urls', async () => {
    const path = await writeFixture({
      _comment: 'ignored',
      issues: [
        issue({
          owner: 'Acme',
          repo: 'API',
          number: 7,
          title: 'Hello',
          body: 'Body',
          labels: ['b', 'a', 'b', 'B'],
          assignees: ['zed', 'amy', 'zed'],
          milestone: 'v1',
        }),
        issue({ number: 8 }),
      ],
    });
    const provider = createFixtureProvider({ path });
    const { issues, warnings } = await provider.listOpenIssues(
      { owner: 'acme', repo: 'api' },
      OPTS,
    );
    expect(warnings).toEqual([]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({
      key: 'acme/api#7',
      repo: { owner: 'acme', repo: 'api' },
      number: 7,
      title: 'Hello',
      state: 'open',
      url: 'https://fixture.local/acme/api/issues/7',
      body: 'Body',
      labels: ['B', 'a', 'b'],
      assignees: ['amy', 'zed'],
      milestone: 'v1',
      nativeRelations: [],
    });
    expect(issues[1]).toMatchObject({ body: '', labels: [], assignees: [], milestone: null });
  });

  it('honours a custom webUrl and strips trailing slashes', async () => {
    const path = await writeFixture({ issues: [issue()] });
    const provider = createFixtureProvider({ path, webUrl: 'https://git.example.com/' });
    const got = await provider.getIssue({ owner: 'acme', repo: 'api' }, 1);
    expect(got?.url).toBe('https://git.example.com/acme/api/issues/1');
  });

  it('lists only open issues of the repo, sorted by number', async () => {
    const path = await writeFixture({
      issues: [
        issue({ number: 5 }),
        issue({ number: 2, state: 'closed' }),
        issue({ number: 3 }),
        issue({ repo: 'web', number: 1 }),
        issue({ number: 10 }),
      ],
    });
    const provider = createFixtureProvider({ path });
    const api = await provider.listOpenIssues({ owner: 'acme', repo: 'api' }, OPTS);
    expect(api.issues.map((i) => i.number)).toEqual([3, 5, 10]);
    const web = await provider.listOpenIssues({ owner: 'acme', repo: 'web' }, OPTS);
    expect(web.issues.map((i) => i.key)).toEqual(['acme/web#1']);
    const none = await provider.listOpenIssues({ owner: 'acme', repo: 'nope' }, OPTS);
    expect(none.issues).toEqual([]);
  });

  it('matches repos case-insensitively', async () => {
    const path = await writeFixture({ issues: [issue({ owner: 'Acme', repo: 'Api', number: 4 })] });
    const provider = createFixtureProvider({ path });
    const r = await provider.listOpenIssues({ owner: 'ACME', repo: 'aPi' }, OPTS);
    expect(r.issues.map((i) => i.key)).toEqual(['acme/api#4']);
    const got = await provider.getIssue({ owner: 'ACME', repo: 'API' }, 4);
    expect(got?.key).toBe('acme/api#4');
  });

  it('getIssue returns closed issues and null for unknown ones', async () => {
    const path = await writeFixture({
      issues: [issue({ number: 1, state: 'closed' }), issue({ number: 2 })],
    });
    const provider = createFixtureProvider({ path });
    const repo = { owner: 'acme', repo: 'api' };
    expect((await provider.getIssue(repo, 1))?.state).toBe('closed');
    expect((await provider.getIssue(repo, 2))?.state).toBe('open');
    expect(await provider.getIssue(repo, 3)).toBeNull();
    expect(await provider.getIssue({ owner: 'acme', repo: 'web' }, 1)).toBeNull();
  });

  it('maps blockedBy to sorted native relations and honours the native toggle', async () => {
    const path = await writeFixture({
      issues: [
        issue({ number: 1 }),
        issue({ number: 2, blockedBy: ['acme/web#3', 'Acme/API#1', 'acme/api#9'] }),
      ],
    });
    const provider = createFixtureProvider({ path });
    const repo = { owner: 'acme', repo: 'api' };

    const withNative = await provider.listOpenIssues(repo, OPTS);
    expect(withNative.issues[1]?.nativeRelations).toEqual([
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 1 }, source: 'native' },
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'api', number: 9 }, source: 'native' },
      { kind: 'blocked-by', ref: { owner: 'acme', repo: 'web', number: 3 }, source: 'native' },
    ]);

    const without = await provider.listOpenIssues(repo, NO_NATIVE);
    expect(without.issues.every((i) => i.nativeRelations.length === 0)).toBe(true);

    // getIssue always includes native relations.
    expect((await provider.getIssue(repo, 2))?.nativeRelations).toHaveLength(3);
  });

  it('returns copies so callers cannot corrupt the cache', async () => {
    const path = await writeFixture({
      issues: [issue({ labels: ['x'], blockedBy: ['acme/api#2'] })],
    });
    const provider = createFixtureProvider({ path });
    const repo = { owner: 'acme', repo: 'api' };
    const first = await provider.listOpenIssues(repo, OPTS);
    first.issues[0]!.labels.push('mutated');
    first.issues[0]!.nativeRelations.length = 0;
    const second = await provider.listOpenIssues(repo, OPTS);
    expect(second.issues[0]?.labels).toEqual(['x']);
    expect(second.issues[0]?.nativeRelations).toHaveLength(1);
  });

  it('reads the file once and caches it', async () => {
    const path = await writeFixture({ issues: [issue()] });
    const provider = createFixtureProvider({ path });
    const repo = { owner: 'acme', repo: 'api' };
    expect((await provider.listOpenIssues(repo, OPTS)).issues).toHaveLength(1);
    await writeFile(path, JSON.stringify({ issues: [] }));
    expect((await provider.listOpenIssues(repo, OPTS)).issues).toHaveLength(1);
  });

  describe('validation errors', () => {
    const repo = { owner: 'acme', repo: 'api' };

    async function failure(content: unknown): Promise<string> {
      const provider = createFixtureProvider({ path: await writeFixture(content) });
      try {
        await provider.listOpenIssues(repo, OPTS);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error('expected an error');
    }

    it('rejects invalid JSON', async () => {
      expect(await failure('{ nope')).toMatch(/not valid JSON/);
    });

    it('rejects a missing issues array', async () => {
      expect(await failure({ things: [] })).toMatch(/expected \{ "issues": \[\.\.\.\] \}/);
    });

    it('rejects a duplicate key with both indexes', async () => {
      const msg = await failure({
        issues: [issue({ number: 1 }), issue({ number: 2 }), issue({ owner: 'ACME', number: 1 })],
      });
      expect(msg).toMatch(/issues\[2\] duplicates acme\/api#1/);
      expect(msg).toMatch(/issues\[0\]/);
    });

    it('rejects a bad state with the issue index', async () => {
      const msg = await failure({ issues: [issue(), issue({ number: 2, state: 'merged' })] });
      expect(msg).toMatch(/issues\[1\]\.state/);
    });

    it('rejects a bad number', async () => {
      expect(await failure({ issues: [issue({ number: 0 })] })).toMatch(/issues\[0\]\.number/);
      expect(await failure({ issues: [issue({ number: 1.5 })] })).toMatch(/issues\[0\]\.number/);
    });

    it('rejects a missing title', async () => {
      const bad = issue();
      delete bad.title;
      expect(await failure({ issues: [bad] })).toMatch(/issues\[0\]\.title/);
    });

    it('rejects a malformed blockedBy key with the index', async () => {
      const msg = await failure({
        issues: [issue({ number: 1 }), issue({ number: 2, blockedBy: ['acme/api#1', '#3'] })],
      });
      expect(msg).toMatch(/issues\[1\]\.blockedBy\[1\]/);
      expect(msg).toMatch(/"#3"/);
    });

    it('rejects a non-string blockedBy entry', async () => {
      expect(await failure({ issues: [issue({ blockedBy: [3] })] })).toMatch(
        /issues\[0\]\.blockedBy\.0/,
      );
    });

    it('does not cache a failed load', async () => {
      const path = await writeFixture('{ nope');
      const provider = createFixtureProvider({ path });
      await expect(provider.listOpenIssues(repo, OPTS)).rejects.toThrow(/not valid JSON/);
      await writeFile(path, JSON.stringify({ issues: [issue()] }));
      expect((await provider.listOpenIssues(repo, OPTS)).issues).toHaveLength(1);
    });
  });
});

describe('demo.json', () => {
  it('loads and contains both repos', async () => {
    const provider = createFixtureProvider({ path: DEMO_PATH });
    const api = await provider.listOpenIssues({ owner: 'acme', repo: 'api' }, OPTS);
    const web = await provider.listOpenIssues({ owner: 'acme', repo: 'web' }, OPTS);
    expect(api.issues.length).toBeGreaterThan(5);
    expect(web.issues.length).toBeGreaterThan(5);
    expect(api.issues.length + web.issues.length).toBeGreaterThanOrEqual(20);
    expect(api.issues.every((i) => i.state === 'open')).toBe(true);
    // A closed issue is reachable through getIssue but is not listed.
    expect(api.issues.some((i) => i.number === 1)).toBe(false);
    expect((await provider.getIssue({ owner: 'acme', repo: 'api' }, 1))?.state).toBe('closed');
    // Dangling reference target does not exist.
    expect(await provider.getIssue({ owner: 'acme', repo: 'api' }, 99)).toBeNull();
    // Priority labels and native relations are present.
    const labels = new Set([...api.issues, ...web.issues].flatMap((i) => i.labels));
    for (const p of ['P0', 'P1', 'P2']) expect(labels.has(p)).toBe(true);
    expect([...api.issues, ...web.issues].some((i) => i.nativeRelations.length > 0)).toBe(true);
  });
});
