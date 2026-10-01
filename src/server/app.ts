import { createHash, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ConfigError } from '../config/load.js';
import type { AppConfig } from '../config/schema.js';
import type { Snapshot } from '../core/types.js';
import { exporters, type ExportFormat } from '../export/index.js';
import { UnknownViewError, type PlanService } from '../service/planService.js';

export interface BuildAppOptions {
  /** Directory with the built web UI. Default: `../web` next to this compiled file. */
  webDir?: string;
  /** Enable Fastify's request logger. Default: false. */
  logger?: boolean;
}

const BASIC_REALM = 'execution-view';

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
    <title>execution-view</title>
  </head>
  <body>
    <h1>execution-view</h1>
    <p>The web UI is not built. Run <code>npm run build</code> to create it.</p>
    <p>The API is available: <a href="/api/views">/api/views</a></p>
  </body>
</html>
`;

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

/** Constant-time string comparison that does not leak the length (compares digests). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function checkBasicAuth(
  header: string | undefined,
  expected: { username: string; password: string },
): boolean {
  if (header === undefined) return false;
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header);
  if (match === null) return false;
  const decoded = Buffer.from(match[1] as string, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const username = colon === -1 ? decoded : decoded.slice(0, colon);
  const password = colon === -1 ? '' : decoded.slice(colon + 1);
  // Evaluate both comparisons so timing does not reveal which one failed.
  const userOk = safeEqual(username, expected.username);
  const passOk = safeEqual(password, expected.password);
  return userOk && passOk && colon !== -1;
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
  const app: FastifyInstance = Fastify({ logger: opts.logger ?? false });
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

  // --- auth (everything except /healthz) ---
  if (basicAuth !== null) {
    app.addHook('onRequest', async (request, reply) => {
      if (pathnameOf(request.url) === '/healthz') return;
      if (checkBasicAuth(request.headers.authorization, basicAuth)) return;
      return reply
        .code(401)
        .header('WWW-Authenticate', `Basic realm="${BASIC_REALM}"`)
        .send({ error: 'Unauthorized' });
    });
  }

  // --- API responses are never cached ---
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  // --- errors ---
  app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
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
