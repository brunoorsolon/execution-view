import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ConfigError } from '../config/load.js';
import type { ReleaseRuntime } from '../config/releaseRuntime.js';
import type { AppConfig } from '../config/schema.js';
import type { Snapshot } from '../core/types.js';
import { exporters, type ExportFormat } from '../export/index.js';
import { UnknownViewError, type PlanService } from '../service/planService.js';
import { packageVersion } from '../version.js';
import { SESSION_COOKIE, checkBasicAuth, credentialsMatch, sessionToken } from './auth.js';
import { checkReleaseAccess } from './releaseAccess.js';
import { registerReleaseRoutes, releaseRouteError, type ReleaseMount } from './releaseRoutes.js';
import { registerWebhooks, WEBHOOK_PATHS } from './webhooks.js';

export interface BuildAppOptions {
  /** Directory with the built web UI. Default: `../web` next to this compiled file. */
  webDir?: string;
  /** Enable Fastify's request logger. Default: false. */
  logger?: boolean;
  /**
   * Loaded release runtime and its admission gate. Release routes are registered only when the
   * configuration enables releases and this mount is supplied.
   */
  releases?: ReleaseMount;
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** URL extension to exporter. `mmd` is the Mermaid exporter; any other value is unknown. */
const EXTENSION_FORMATS: Record<string, ExportFormat> = {
  json: 'json',
  md: 'md',
  mmd: 'mermaid',
  dot: 'dot',
};

const UI_NOT_BUILT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Forge Desk</title>
  </head>
  <body>
    <h1>Forge Desk</h1>
    <p>The web UI is not built. Run <code>npm run build</code> to create it.</p>
    <p>The API is available: <a href="/api/views">/api/views</a></p>
  </body>
</html>
`;

/**
 * Static login form. The head script applies the theme saved by the app's theme menu (same key as
 * `web/src/theme.ts`) before the first paint; the body script keeps a shared `#/view/...` link
 * across the login redirect.
 */
function loginPage(failed: boolean): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Log in · Forge Desk</title>
    <script>
      try {
        var theme = localStorage.getItem('execution-view:theme');
        if (theme === 'light' || theme === 'dark') {
          document.documentElement.setAttribute('data-theme', theme);
        }
      } catch (e) {
        // storage blocked: follow the system setting
      }
    </script>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3f4f6;
        --surface: #ffffff;
        --line: #c9ced6;
        --fg: #15181e;
        --fg-2: #464d5a;
        --accent: #2b52c4;
        --error: #b3261e;
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme='light']) {
          color-scheme: dark;
          --bg: #0e1014;
          --surface: #161920;
          --line: #353b46;
          --fg: #e9ebf0;
          --fg-2: #b6bcc7;
          --accent: #86a3ff;
          --error: #ff7a6e;
        }
      }
      :root[data-theme='dark'] {
        color-scheme: dark;
        --bg: #0e1014;
        --surface: #161920;
        --line: #353b46;
        --fg: #e9ebf0;
        --fg-2: #b6bcc7;
        --accent: #86a3ff;
        --error: #ff7a6e;
      }
      body {
        display: grid;
        place-items: center;
        min-height: 100vh;
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      }
      form {
        display: grid;
        gap: 6px;
        width: min(320px, calc(100vw - 32px));
        padding: 28px;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 10px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 18px;
      }
      label {
        margin-top: 8px;
        color: var(--fg-2);
        font-size: 13px;
      }
      input {
        height: 36px;
        padding: 0 10px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--bg);
        color: var(--fg);
        font: inherit;
      }
      button {
        height: 36px;
        margin-top: 16px;
        border: 0;
        border-radius: 6px;
        background: var(--accent);
        color: var(--surface);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      .error {
        margin: 0;
        color: var(--error);
      }
    </style>
  </head>
  <body>
    <form method="post" action="login">
      <h1>Forge Desk</h1>
      ${failed ? '<p class="error" role="alert">Wrong user name or password.</p>' : ''}
      <label for="username">User name</label>
      <input id="username" name="username" autocomplete="username" required autofocus />
      <label for="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autocomplete="current-password"
        required
      />
      <button type="submit">Log in</button>
    </form>
    <script>
      document.forms[0].action += location.hash;
    </script>
  </body>
</html>
`;
}

/** A failure while fetching from the provider; answered with 502. */
class BadGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadGatewayError';
  }
}

function defaultWebDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Cache policy for a static file: hashed build output under `assets/` never changes, everything
 * else (`index.html`, which references those hashed names, and any other file) is revalidated.
 */
function staticCacheControl(webDir: string, filePath: string): string {
  const relative = path.relative(webDir, filePath).split(path.sep).join('/');
  return relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

function isTruthyFlag(value: unknown): boolean {
  const v: unknown = Array.isArray(value) ? value[value.length - 1] : value;
  return v === '1' || v === 'true';
}

function pathnameOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * The session cookie. Without a Path attribute the browser scopes it to the directory of the login
 * URL, so it also works below a sub-path. `X-Forwarded-Proto` is read without trusting the proxy
 * because it can only add `Secure`, which makes the cookie stricter.
 */
function sessionCookie(request: FastifyRequest, value: string, maxAge: number): string {
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0];
  const secure = request.protocol === 'https' || forwarded?.trim() === 'https';
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** True when an If-None-Match header value matches the etag (weak comparison, `*` matches all). */
function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.trim() === '*') return true;
  return value.split(',').some((tag) => {
    const t = tag.trim();
    return (t.startsWith('W/') ? t.slice(2) : t) === etag;
  });
}

export function buildApp(
  config: AppConfig,
  service: PlanService,
  opts: BuildAppOptions = {},
): FastifyInstance {
  const app: FastifyInstance = Fastify({
    logger: opts.logger ?? false,
    frameworkErrors(error, request, reply: FastifyReply) {
      // Router-level URL/ID failures bypass application hooks and the normal error handler.
      if (request.url.startsWith('/api/releases/')) {
        return reply.header('Cache-Control', 'no-store').code(400).send({
          code: 'invalid-request',
          error: 'malformed release URL or resource ID',
        });
      }
      return reply.send(error);
    },
  });
  const webDir = path.resolve(opts.webDir ?? defaultWebDir());
  const hasWebDir = isDirectory(webDir);
  const basicAuth = config.server.basicAuth;

  const secrets = config.sources
    .map((s) => s.token)
    .filter((t): t is string => t !== null && t !== '');
  const redact = (message: string): string => {
    let out = message;
    for (const secret of secrets) out = out.split(secret).join('***');
    return out;
  };

  // --- auth (everything except /healthz, the login routes and, when enabled, the POST webhook
  // endpoints, which authenticate with a signature instead). A session cookie from the login page
  // or a basic-auth header both pass. No `WWW-Authenticate` challenge: it would make the browser
  // show its own dialog instead of the login page. ---
  const webhooks = config.webhooks;
  // Release routes exist only for a fully loaded, owned runtime with the application login the
  // configuration already requires. Anything else is absent, never silently unprotected.
  const releaseMount =
    config.releases.enabled && basicAuth !== null && opts.releases !== undefined
      ? opts.releases
      : null;
  if (basicAuth !== null) {
    // ponytail: sessions live in memory, so a restart logs everyone out; sign cookies with a
    // configured secret if that becomes a nuisance.
    const sessions = new Map<string, { expires: number; csrf: string }>();
    const liveSession = (cookie: string | undefined) => {
      const token = sessionToken(cookie);
      const session = token === null ? undefined : sessions.get(token);
      return session !== undefined && session.expires > Date.now() ? session : null;
    };
    const hasSession = (request: FastifyRequest): boolean =>
      liveSession(request.headers.cookie) !== null;
    // Browser release requests also prove the configured public Host/Origin and a session-bound
    // CSRF token; CLI requests prove an explicit header and carry no session cookie.
    const releaseAccess =
      releaseMount === null
        ? null
        : {
            publicOrigin: releaseMount.runtime.publicOrigin,
            sessionCsrf: (cookie: string | undefined) => liveSession(cookie)?.csrf ?? null,
            hasSessionCookie: (cookie: string | undefined) => sessionToken(cookie) !== null,
            headerAuthenticated: (header: string | undefined) => checkBasicAuth(header, basicAuth),
          };

    app.addHook('onRequest', async (request, reply) => {
      const pathname = pathnameOf(request.url);
      if (pathname === '/healthz' || pathname === '/login' || pathname === '/logout') return;
      if (webhooks !== null && request.method === 'POST' && WEBHOOK_PATHS.includes(pathname)) {
        return;
      }
      if (!hasSession(request) && !checkBasicAuth(request.headers.authorization, basicAuth)) {
        if (
          request.method === 'GET' &&
          !pathname.startsWith('/api/') &&
          (request.headers.accept ?? '').includes('text/html')
        ) {
          // Relative, so it also works below a sub-path: climb to the app root first.
          return reply.redirect(`${'../'.repeat(pathname.split('/').length - 2)}login`);
        }
        return pathname.startsWith('/api/releases')
          ? reply
              .code(401)
              .send({ error: 'release access requires authentication', code: 'not-authenticated' })
          : reply.code(401).send({ error: 'Unauthorized' });
      }
      // Release routes carry a stricter gate than the planning API. It runs for every release
      // path, so a route added later inherits it and an unknown one is rejected before 404.
      if (releaseAccess !== null && pathname.startsWith('/api/releases')) {
        const access = checkReleaseAccess(request.method, request.headers, releaseAccess);
        if (!access.ok) {
          return reply.code(access.status).send({ error: access.message, code: access.code });
        }
      }
    });

    // Own scope, so the form parser does not reach the webhook routes.
    void app.register((scope, _opts, done) => {
      scope.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_request, body, parserDone) => parserDone(null, new URLSearchParams(body as string)),
      );
      scope.get('/login', async (_request, reply) =>
        reply.type('text/html; charset=utf-8').send(loginPage(false)),
      );

      scope.post('/login', async (request, reply) => {
        const form = request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
        const ok = credentialsMatch(
          form.get('username') ?? '',
          form.get('password') ?? '',
          basicAuth,
        );
        if (!ok) return reply.code(401).type('text/html; charset=utf-8').send(loginPage(true));
        const now = Date.now();
        for (const [token, session] of sessions) {
          if (session.expires <= now) sessions.delete(token);
        }
        const token = randomBytes(32).toString('base64url');
        const csrf = randomBytes(32).toString('base64url');
        sessions.set(token, { expires: now + SESSION_TTL_SECONDS * 1000, csrf });
        return reply
          .header('Set-Cookie', sessionCookie(request, token, SESSION_TTL_SECONDS))
          .redirect('./', 303);
      });

      scope.post('/logout', async (request, reply) => {
        const token = sessionToken(request.headers.cookie);
        if (token !== null) sessions.delete(token);
        return reply.header('Set-Cookie', sessionCookie(request, '', 0)).redirect('login', 303);
      });

      scope.get('/api/session', async (request) => ({
        username: basicAuth.username,
        // The browser proves a release mutation with this session-bound token; a header-authenticated
        // caller needs none, so it gets null rather than another caller's token.
        csrfToken: liveSession(request.headers.cookie)?.csrf ?? null,
      }));
      done();
    });
  }

  // --- API responses are never cached ---
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  // --- errors ---
  app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
    if (request.url.startsWith('/api/releases')) {
      const releaseError = releaseRouteError(err);
      if (releaseError !== null) return reply.code(releaseError.status).send(releaseError.body);
      return reply.code(500).send({ code: 'internal-error', error: 'release request failed' });
    }
    if (err instanceof UnknownViewError) {
      return reply.code(404).send({ error: err.message });
    }
    if (err instanceof BadGatewayError) {
      return reply.code(502).send({ error: err.message });
    }
    const status = err.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: redact(err.message) });
    }
    request.log.error({ err }, 'unexpected error');
    return reply.code(500).send({ error: 'Internal Server Error' });
  });

  /** Unknown view stays as is (404); any other failure is a provider failure (502). */
  async function loadSnapshot(id: string, refresh: boolean): Promise<Snapshot> {
    try {
      return await service.getSnapshot(id, { refresh });
    } catch (err) {
      if (err instanceof UnknownViewError || err instanceof ConfigError) throw err;
      throw new BadGatewayError(redact(err instanceof Error ? err.message : String(err)));
    }
  }

  // --- routes ---
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/api/views', async () => service.listViews());

  const version = packageVersion();
  app.get('/api/settings', async () => ({ refreshMinutes: config.ui.refreshMinutes, version }));

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/api/views/:id/snapshot',
    async (request, reply) => {
      const snapshot = await loadSnapshot(request.params.id, isTruthyFlag(request.query.refresh));
      const etag = `"${snapshot.contentHash}"`;
      reply.header('ETag', etag);
      if (etagMatches(request.headers['if-none-match'], etag)) {
        return reply.code(304).send();
      }
      return snapshot;
    },
  );

  app.post<{ Params: { id: string } }>('/api/views/:id/refresh', async (request, reply) => {
    const snapshot = await loadSnapshot(request.params.id, true);
    reply.header('ETag', `"${snapshot.contentHash}"`);
    return snapshot;
  });

  app.get<{ Params: { id: string; format: string }; Querystring: { refresh?: string } }>(
    '/api/views/:id/export.:format',
    async (request, reply) => {
      const ext = request.params.format;
      if (!Object.hasOwn(EXTENSION_FORMATS, ext)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const exporter = exporters[EXTENSION_FORMATS[ext] as ExportFormat];
      const snapshot = await loadSnapshot(request.params.id, isTruthyFlag(request.query.refresh));
      return reply
        .type(exporter.contentType)
        .header(
          'Content-Disposition',
          `inline; filename="${snapshot.viewId}.${exporter.extension}"`,
        )
        .send(exporter.render(snapshot));
    },
  );

  // --- release routes (only with an owned release runtime; otherwise the routes do not exist) ---
  if (releaseMount !== null) registerReleaseRoutes(app, config, releaseMount);

  // --- webhooks (only with a configured secret; otherwise the routes do not exist) ---
  if (webhooks !== null) registerWebhooks(app, webhooks.secret, service);

  // --- static UI ---
  // Files are resolved per request (wildcard), so a rebuilt `dist/web` with new hashed asset names
  // is served without a restart, and so is a `dist/web` created after startup. `/api/*` and
  // `/healthz` are more specific routes and take precedence over the wildcard.
  if (!hasWebDir) {
    app.log.warn(`Web UI directory not found: ${webDir}. Serving the API only until it exists.`);
  }
  void app.register(fastifyStatic, {
    root: webDir,
    wildcard: true,
    index: false,
    suppressWarning: true,
    setHeaders: (reply, filePath) => {
      reply.header('Cache-Control', staticCacheControl(webDir, filePath));
    },
  });

  app.get('/', async (_request, reply) => {
    if (isDirectory(webDir)) return reply.sendFile('index.html');
    return reply.type('text/html; charset=utf-8').send(UI_NOT_BUILT_HTML);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const accept = request.headers.accept ?? '';
    if (
      request.method === 'GET' &&
      !pathnameOf(request.url).startsWith('/api/') &&
      accept.includes('text/html') &&
      isDirectory(webDir)
    ) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  return app;
}
