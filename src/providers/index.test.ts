import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ResolvedSource } from '../config/schema.js';
import { createProvider } from './index.js';

const DEMO_PATH = fileURLToPath(new URL('../../test/fixtures/demo.json', import.meta.url));
const REPO = { owner: 'acme', repo: 'api' };
const OPTS = { native: false, subIssues: false };

function source(over: Partial<ResolvedSource>): ResolvedSource {
  return {
    id: 's',
    kind: 'github',
    baseUrl: 'https://api.github.com',
    webUrl: 'https://github.com',
    token: null,
    path: null,
    ...over,
  };
}

function recordingFetch(): {
  fetch: typeof fetch;
  calls: { url: string; headers: string }[];
} {
  const calls: { url: string; headers: string }[] = [];
  const fakeFetch = (async (input: unknown, init?: { headers?: unknown }) => {
    calls.push({ url: String(input), headers: JSON.stringify(init?.headers ?? {}) });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe('createProvider', () => {
  it('dispatches github sources to the GitHub provider', async () => {
    const rec = recordingFetch();
    const provider = createProvider(source({ token: 'tok' }), { fetch: rec.fetch });
    expect(provider.kind).toBe('github');
    await provider.listOpenIssues(REPO, OPTS);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toContain('https://api.github.com/repos/acme/api/issues');
    expect(rec.calls[0]!.headers).toContain('Bearer tok');
  });

  it('dispatches gitea sources to the Gitea provider', async () => {
    const rec = recordingFetch();
    const provider = createProvider(
      source({ kind: 'gitea', baseUrl: 'https://gitea.example.com', token: 'tok' }),
      { fetch: rec.fetch },
    );
    expect(provider.kind).toBe('gitea');
    await provider.listOpenIssues(REPO, OPTS);
    expect(rec.calls[0]!.url).toContain('https://gitea.example.com/api/v1/repos/acme/api/issues');
    expect(rec.calls[0]!.headers).toContain('token tok');
  });

  it('dispatches fixture sources to the fixture provider', async () => {
    const provider = createProvider(
      source({ kind: 'fixture', baseUrl: '', webUrl: 'https://fx.test', path: DEMO_PATH }),
    );
    expect(provider.kind).toBe('fixture');
    const issue = await provider.getIssue(REPO, 2);
    expect(issue?.key).toBe('acme/api#2');
    expect(issue?.url).toBe('https://fx.test/acme/api/issues/2');
  });

  it('falls back to the default fixture web url when webUrl is empty', async () => {
    const provider = createProvider(
      source({ kind: 'fixture', baseUrl: '', webUrl: '', path: DEMO_PATH }),
    );
    const issue = await provider.getIssue(REPO, 2);
    expect(issue?.url).toBe('https://fixture.local/acme/api/issues/2');
  });

  it('rejects a fixture source without a path', () => {
    expect(() => createProvider(source({ kind: 'fixture', path: null }))).toThrow(/path/);
  });
});
