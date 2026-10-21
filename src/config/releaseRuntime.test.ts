import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './load.js';
import { loadReleaseRuntime } from './releaseRuntime.js';
import { startServer } from '../server/index.js';
import type { ResolvedReleaseRepository, ResolvedReleases, ResolvedSource } from './schema.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Files {
  root: string;
  stateDir: string;
  tokenFile: string;
  key: string;
  knownHosts: string;
}

function files(): Files {
  const root = mkdtempSync(join(tmpdir(), 'ev-release-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const out = {
    root,
    stateDir: join(root, 'state'),
    tokenFile: join(root, 'token'),
    key: join(root, 'id_ed25519'),
    knownHosts: join(root, 'known_hosts'),
  };
  mkdirSync(out.stateDir);
  writeFileSync(out.tokenFile, 'release-token\n');
  writeFileSync(out.key, 'PRIVATE KEY\n');
  writeFileSync(out.knownHosts, 'gitea.example.com ssh-ed25519 AAAA\n');
  chmodSync(out.stateDir, 0o700);
  chmodSync(out.tokenFile, 0o600);
  chmodSync(out.key, 0o600);
  chmodSync(out.knownHosts, 0o644);
  return out;
}

function repository(f: Files): ResolvedReleaseRepository {
  return {
    id: 'app',
    source: 'gt',
    repo: { owner: 'example', repo: 'app' },
    origin: 'ssh://git@gitea.example.com/example/app.git',
    token: { kind: 'file', path: f.tokenFile },
    expectedApiUser: 'release-bot',
    ci: { workflowPath: '.gitea/workflows/validate.yaml' },
    ssh: { privateKeyFile: f.key, knownHostsFile: f.knownHosts },
    tagger: { name: 'Forge Desk Release Bot', email: 'releases@example.com' },
  };
}

type EnabledReleases = Extract<ResolvedReleases, { enabled: true }>;

function releases(f: Files, mutate?: (r: ResolvedReleaseRepository) => void): EnabledReleases {
  const repo = repository(f);
  mutate?.(repo);
  return {
    enabled: true,
    publicOrigin: 'https://forge-desk.example.com',
    stateDir: f.stateDir,
    repositories: [repo],
  };
}

function planningSource(token: string | null): ResolvedSource {
  return {
    id: 'gt',
    kind: 'gitea',
    baseUrl: 'https://gitea.example.com',
    webUrl: 'https://gitea.example.com',
    token,
    path: null,
  };
}

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

describe('release runtime prerequisites', () => {
  it('does nothing while releases are disabled', () => {
    expect(
      loadReleaseRuntime({ enabled: false }, [planningSource('planning-token')], {}),
    ).toBeNull();
  });

  it('resolves the dedicated token and paths for enabled releases', () => {
    const f = files();
    const runtime = loadReleaseRuntime(releases(f), [planningSource('planning-token')], {});
    expect(runtime).not.toBeNull();
    expect(runtime!.stateDir).toBe(f.stateDir);
    expect(runtime!.publicOrigin).toBe('https://forge-desk.example.com');
    expect(runtime!.repositories).toHaveLength(1);
    expect(runtime!.repositories[0]!.token).toBe('release-token');
    expect(runtime!.repositories[0]!.config.repo).toEqual({ owner: 'example', repo: 'app' });
  });

  it('reads the token from the configured environment variable', () => {
    const f = files();
    const envRepo = releases(f, (r) => {
      r.token = { kind: 'env', name: 'RELEASE_TOKEN' };
    });
    expect(errorOf(() => loadReleaseRuntime(envRepo, [], {})).message).toContain('RELEASE_TOKEN');
    expect(
      loadReleaseRuntime(envRepo, [], { RELEASE_TOKEN: 'from-env' })!.repositories[0]!.token,
    ).toBe('from-env');
  });

  it('refuses to reuse the planning source token', () => {
    const f = files();
    expect(
      errorOf(() => loadReleaseRuntime(releases(f), [planningSource('release-token')], {})).message,
    ).toContain('dedicated');
  });

  it('compares the effective token, ignoring surrounding whitespace', () => {
    const f = files();
    expect(
      errorOf(() => loadReleaseRuntime(releases(f), [planningSource('release-token ')], {}))
        .message,
    ).toContain('dedicated');

    // The same through the real config path, where an inline planning token keeps its whitespace.
    const cfg = parseConfig(
      JSON.stringify({
        sources: [
          {
            id: 'gt',
            kind: 'gitea',
            baseUrl: 'https://gitea.example.com',
            token: 'release-token ',
          },
        ],
        views: [{ id: 'v', source: 'gt', repos: ['example/app'] }],
      }),
      {},
    );
    expect(errorOf(() => loadReleaseRuntime(releases(f), cfg.sources, {})).message).toContain(
      'dedicated',
    );
  });

  it('requires a private state directory owned by the runtime user', () => {
    const f = files();
    chmodSync(f.stateDir, 0o755);
    const error = errorOf(() => loadReleaseRuntime(releases(f), [], {}));
    expect(error.message).toContain('releases.stateDir');
    expect(error.message).toContain('0700');
    // Reported, never repaired: the operator's mount keeps its permissions.
    expect(lstatSync(f.stateDir).mode & 0o777).toBe(0o755);
  });

  it('rejects a missing or symbolic-link state directory', () => {
    const f = files();
    const missing = releases(f);
    missing.stateDir = join(f.root, 'absent');
    expect(errorOf(() => loadReleaseRuntime(missing, [], {})).message).toContain('does not exist');

    const real = join(f.root, 'real-state');
    mkdirSync(real);
    chmodSync(real, 0o700);
    symlinkSync(real, join(f.root, 'linked-state'));
    const linked = releases(f);
    linked.stateDir = join(f.root, 'linked-state');
    expect(errorOf(() => loadReleaseRuntime(linked, [], {})).message).toContain('symbolic link');
  });

  it('rejects secret files the runtime user cannot read', () => {
    const f = files();
    const missing = releases(f, (r) => {
      r.token = { kind: 'file', path: join(f.root, 'absent-token') };
    });
    expect(errorOf(() => loadReleaseRuntime(missing, [], {})).message).toContain('apiTokenFile');

    writeFileSync(f.tokenFile, '  \n');
    expect(errorOf(() => loadReleaseRuntime(releases(f), [], {})).message).toContain('is empty');
  });

  it('applies the SSH key permission rules without changing them', () => {
    const f = files();
    chmodSync(f.key, 0o644);
    const error = errorOf(() => loadReleaseRuntime(releases(f), [], {}));
    expect(error.message).toContain('ssh.privateKeyFile');
    expect(error.message).toContain('0600');
    expect(lstatSync(f.key).mode & 0o777).toBe(0o644);

    chmodSync(f.knownHosts, 0o666);
    expect(errorOf(() => loadReleaseRuntime(releases(f), [], {})).message).toContain(
      'knownHostsFile',
    );
    expect(lstatSync(f.knownHosts).mode & 0o777).toBe(0o666);
  });

  it('requires the git and ssh executables', () => {
    const f = files();
    const saved = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const error = errorOf(() => loadReleaseRuntime(releases(f), [], {}));
      expect(error.message).toContain('git');
      expect(error.message).toContain('ssh');
      expect(error.message).toContain('PATH');
    } finally {
      process.env['PATH'] = saved;
    }
  });

  it('keeps credential values out of diagnostics', () => {
    const f = files();
    const error = errorOf(() =>
      loadReleaseRuntime(releases(f), [planningSource('release-token')], {}),
    );
    expect(error.message).not.toContain('release-token');
  });
});

describe('release runtime startup', () => {
  function writeConfig(f: Files): string {
    const config = {
      server: { host: '127.0.0.1', basicAuth: { username: 'admin', password: 'pw' } },
      sources: [{ id: 'gt', kind: 'gitea', baseUrl: 'https://gitea.example.com' }],
      views: [{ id: 'v', source: 'gt', repos: ['example/app'] }],
      releases: {
        enabled: true,
        publicOrigin: 'https://forge-desk.example.com',
        stateDir: f.stateDir,
        repositories: [
          {
            id: 'app',
            source: 'gt',
            repo: 'example/app',
            origin: 'ssh://git@gitea.example.com/example/app.git',
            apiTokenFile: f.tokenFile,
            expectedApiUser: 'release-bot',
            ci: { workflowPath: '.gitea/workflows/validate.yaml' },
            ssh: { privateKeyFile: f.key, knownHostsFile: f.knownHosts },
            tagger: { name: 'Release Bot', email: 'releases@example.com' },
          },
        ],
      },
    };
    const path = join(f.root, 'config.json');
    writeFileSync(path, JSON.stringify(config));
    return path;
  }

  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  it('fails closed on unsafe local prerequisites before listening', async () => {
    const f = files();
    chmodSync(f.stateDir, 0o755);
    await expect(startServer({ configPath: writeConfig(f), env: {} })).rejects.toThrow(
      /releases\.stateDir/,
    );
  });

  it('starts Planning with valid release configuration without contacting a forge', async () => {
    const f = files();
    const port = await freePort();
    const app = await startServer({
      configPath: writeConfig(f),
      env: { EV_PORT: String(port) },
    });
    cleanups.push(() => app.close());
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  /** A release repository whose forge is unreachable, plus a Planning view on a local fixture. */
  function writeOutageConfig(f: Files): string {
    const config = {
      server: { host: '127.0.0.1', basicAuth: { username: 'admin', password: 'pw' } },
      sources: [
        {
          id: 'demo',
          kind: 'fixture',
          path: fileURLToPath(new URL('../../test/fixtures/demo.json', import.meta.url)),
        },
        { id: 'gt', kind: 'gitea', baseUrl: 'http://127.0.0.1:1' },
      ],
      views: [{ id: 'v', source: 'demo', repos: ['acme/api'] }],
      releases: {
        enabled: true,
        publicOrigin: 'https://forge-desk.example.com',
        stateDir: f.stateDir,
        repositories: [
          {
            id: 'app',
            source: 'gt',
            repo: 'example/app',
            origin: 'ssh://git@gitea.example.com/example/app.git',
            apiTokenFile: f.tokenFile,
            expectedApiUser: 'release-bot',
            ci: { workflowPath: '.gitea/workflows/validate.yaml' },
            ssh: { privateKeyFile: f.key, knownHostsFile: f.knownHosts },
            tagger: { name: 'Release Bot', email: 'releases@example.com' },
          },
        ],
      },
    };
    const path = join(f.root, 'outage.json');
    writeFileSync(path, JSON.stringify(config));
    return path;
  }

  it('blocks release capability on a forge outage while Planning stays live', async () => {
    const f = files();
    const app = await startServer({
      configPath: writeOutageConfig(f),
      env: { EV_PORT: String(await freePort()) },
    });
    cleanups.push(() => app.close());
    const authorization = `Basic ${Buffer.from('admin:pw').toString('base64')}`;

    const capability = await app.inject({
      url: '/api/releases/repositories',
      headers: { authorization },
    });
    expect(capability.statusCode).toBe(200);
    expect(capability.json()).toEqual([
      {
        id: 'app',
        repo: 'example/app',
        source: 'gt',
        forge: 'http://127.0.0.1:1/',
        capability: 'blocked',
        blockers: [expect.objectContaining({ code: 'network-error' })],
      },
    ]);
    expect(capability.body).not.toContain('release-token');

    // The same process keeps serving Planning and liveness.
    expect((await app.inject({ url: '/api/views', headers: { authorization } })).statusCode).toBe(
      200,
    );
    expect(
      (await app.inject({ url: '/api/views/v/snapshot', headers: { authorization } })).statusCode,
    ).toBe(200);
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
  });

  it('refuses a second application process owning the same release state directory', async () => {
    const f = files();
    const configPath = writeConfig(f);
    const first = await startServer({
      configPath,
      env: { EV_PORT: String(await freePort()) },
    });
    cleanups.push(() => first.close());

    await expect(
      startServer({ configPath, env: { EV_PORT: String(await freePort()) } }),
    ).rejects.toThrow(/owns release state directory/);

    // Closing the first process releases ownership, so a restart can take over.
    await first.close();
    const restarted = await startServer({
      configPath,
      env: { EV_PORT: String(await freePort()) },
    });
    cleanups.push(() => restarted.close());
    expect(restarted.server.listening).toBe(true);
  });
});
