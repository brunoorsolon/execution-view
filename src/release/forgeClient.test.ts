import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  MAX_RESPONSE_BYTES,
  ReleaseForgeError,
  createReleaseForgeClient,
  createReleaseForgeWriter,
  type ReleaseForgeFetch,
} from './forgeClient.js';

const TOKEN = 'canary_release_token_7f3a91';
const BASE = 'https://gitea.example.test';

interface Call {
  url: string;
  init: RequestInit;
}

type Handler = (url: URL, call: Call) => Response | Error;

function fakeFetch(handler: Handler): { fetch: ReleaseForgeFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: ReleaseForgeFetch = (input, init) => {
    const call: Call = { url: input, init };
    calls.push(call);
    const result = handler(new URL(input), call);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { fetch: fetchFn, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

async function expectError(fn: () => Promise<unknown>): Promise<ReleaseForgeError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ReleaseForgeError);
    return err as ReleaseForgeError;
  }
  throw new Error('expected a ReleaseForgeError');
}

describe('non-retrying release creation', () => {
  it.each(['success', 'error', 'redirect', 'lost', 'silent'])(
    'sends one fixed stable request through real HTTP after %s',
    async (mode) => {
      const requests: Array<{ method?: string; url?: string; token?: string; body: string }> = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        requests.push({ method: req.method, url: req.url, token: req.headers.authorization, body });
        if (mode === 'silent') return;
        if (mode === 'lost') {
          req.socket.destroy();
          return;
        }
        res.writeHead(
          mode === 'error' ? 500 : mode === 'redirect' ? 307 : 201,
          mode === 'redirect' ? { location: '/credential-sink' } : {},
        );
        res.end(`untrusted ${TOKEN}`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gitea`;
      try {
        const reader = createReleaseForgeClient({ baseUrl, token: TOKEN });
        expect(Object.keys(reader).sort()).toEqual(['baseUrl', 'getJson']);
        const writer = createReleaseForgeWriter({ baseUrl, token: TOKEN, timeoutMs: 100 });
        const operation = () =>
          writer.createRelease(
            { owner: 'acme', repo: 'api' },
            {
              tag: 'v0.1.0',
              title: 'v0.1.0',
              notes: '# Exact\n\né é\r\n',
            },
          );
        if (mode === 'success') await expect(operation()).resolves.toBeUndefined();
        else {
          const error = await expectError(operation);
          expect(error.code).toBe(
            mode === 'redirect'
              ? 'redirect-refused'
              : mode === 'error'
                ? 'http-error'
                : 'network-error',
          );
          expect(error.message).not.toContain(TOKEN);
        }
        expect(requests).toEqual([
          {
            method: 'POST',
            url: '/gitea/api/v1/repos/acme/api/releases',
            token: `token ${TOKEN}`,
            body: JSON.stringify({
              tag_name: 'v0.1.0',
              name: 'v0.1.0',
              body: '# Exact\n\né é\r\n',
              draft: false,
              prerelease: false,
            }),
          },
        ]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe('createReleaseForgeClient request', () => {
  it('sends one GET with the dedicated token and manual redirect handling', async () => {
    const { fetch, calls } = fakeFetch(() => json({ login: 'release-bot', id: 7 }));
    const client = createReleaseForgeClient({ baseUrl: BASE, token: TOKEN, fetch });

    await expect(client.getJson('/user')).resolves.toEqual({ login: 'release-bot', id: 7 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/user`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: `token ${TOKEN}` });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps a subpath forge root and strips trailing slashes', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const client = createReleaseForgeClient({
      baseUrl: 'https://example.test/gitea///',
      token: TOKEN,
      fetch,
    });
    await client.getJson('/user');
    expect(calls[0]!.url).toBe('https://example.test/gitea/api/v1/user');
  });

  it('allows plain http only for a loopback test deployment', async () => {
    const ok = fakeFetch(() => json({}));
    const client = createReleaseForgeClient({
      baseUrl: 'http://127.0.0.1:3000',
      token: TOKEN,
      fetch: ok.fetch,
    });
    await client.getJson('/user');
    expect(ok.calls[0]!.url).toBe('http://127.0.0.1:3000/api/v1/user');

    const insecure = await expectError(() =>
      createReleaseForgeClient({ baseUrl: 'http://gitea.example.test', token: TOKEN }).getJson(
        '/user',
      ),
    );
    expect(insecure.code).toBe('insecure-forge-origin');
    expect(insecure.message).not.toContain(TOKEN);
  });

  it('rejects a forge origin that carries credentials, a query or a fragment', async () => {
    for (const baseUrl of [
      'https://user:pw@gitea.example.test',
      'https://gitea.example.test/?x=1',
      'https://gitea.example.test/#frag',
    ]) {
      const err = await expectError(() =>
        createReleaseForgeClient({ baseUrl, token: TOKEN }).getJson('/user'),
      );
      expect(err.code).toBe('insecure-forge-origin');
    }
  });

  it('rejects a missing, anonymous or control-character token without any request', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    for (const token of ['', '   ', 'tok\nen']) {
      const err = await expectError(() =>
        createReleaseForgeClient({ baseUrl: BASE, token, fetch }).getJson('/user'),
      );
      expect(err.code).toBe('invalid-credential');
    }
    expect(calls).toHaveLength(0);
  });

  it('accepts only a rooted API path, never an absolute or foreign URL', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const client = createReleaseForgeClient({ baseUrl: BASE, token: TOKEN, fetch });
    for (const path of ['https://evil.test/user', '//evil.test/user', 'user']) {
      const err = await expectError(() => client.getJson(path));
      expect(err.code).toBe('invalid-request');
      expect(err.message).not.toContain(TOKEN);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a redirect before the token could be forwarded', async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response('', { status: 302, headers: { location: 'https://evil.test/collect' } }),
    );
    const client = createReleaseForgeClient({ baseUrl: BASE, token: TOKEN, fetch });
    const err = await expectError(() => client.getJson('/user'));

    expect(err.code).toBe('redirect-refused');
    expect(err.message).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('maps status responses without echoing a body or the token', async () => {
    const handler: Handler = (url) =>
      url.pathname.endsWith('/user')
        ? new Response('{"message":"bad token ' + TOKEN + '"}', { status: 401 })
        : new Response('boom', { status: 500 });
    const { fetch } = fakeFetch(handler);
    const client = createReleaseForgeClient({ baseUrl: BASE, token: TOKEN, fetch });

    const unauthorized = await expectError(() => client.getJson('/user'));
    expect(unauthorized.code).toBe('unauthenticated');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.message).not.toContain(TOKEN);
    expect(unauthorized.message).not.toContain('bad token');

    const failed = await expectError(() => client.getJson('/version'));
    expect(failed.code).toBe('http-error');
    expect(failed.message).not.toContain('boom');
  });

  it('reports a malformed body as a malformed response', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>nope</html>', { status: 200 }));
    const client = createReleaseForgeClient({ baseUrl: BASE, token: TOKEN, fetch });
    const err = await expectError(() => client.getJson('/user'));
    expect(err.code).toBe('malformed-response');
  });

  it('bounds a response body by its declared size and by what it streams', async () => {
    const declared = fakeFetch(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        }),
    );
    const client = createReleaseForgeClient({
      baseUrl: BASE,
      token: TOKEN,
      fetch: declared.fetch,
    });
    const oversizedHeader = await expectError(() => client.getJson('/user'));
    expect(oversizedHeader.code).toBe('response-too-large');

    const streamed = fakeFetch(
      () => new Response(JSON.stringify({ pad: 'x'.repeat(512) }), { status: 200 }),
    );
    const smallClient = createReleaseForgeClient({
      baseUrl: BASE,
      token: TOKEN,
      fetch: streamed.fetch,
      maxResponseBytes: 64,
    });
    const oversizedBody = await expectError(() => smallClient.getJson('/user'));
    expect(oversizedBody.code).toBe('response-too-large');
    expect(oversizedBody.message).not.toContain(TOKEN);
  });

  it('redacts the token from a network failure cause', async () => {
    const { fetch } = fakeFetch(() => new Error(`connect failed with ${TOKEN} attached`));
    const client = createReleaseForgeClient({ baseUrl: BASE, token: TOKEN, fetch });
    const err = await expectError(() => client.getJson('/user'));
    expect(err.code).toBe('network-error');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('***');
  });

  it('redacts a failure raised while reading the response body', async () => {
    const { fetch } = fakeFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error(`body failed with ${TOKEN}`));
        },
      });
      return new Response(body, { status: 200 });
    });
    const client = createReleaseForgeClient({ baseUrl: BASE, token: TOKEN, fetch });
    const err = await expectError(() => client.getJson('/user'));
    expect(err.code).toBe('network-error');
    expect(err.message).not.toContain(TOKEN);
  });
});
