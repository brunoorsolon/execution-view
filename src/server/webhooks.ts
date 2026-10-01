import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PlanService } from '../service/planService.js';

/** Paths of the webhook endpoints. They authenticate with a signature instead of basic auth. */
export const WEBHOOK_PATHS: readonly string[] = ['/api/webhooks/github', '/api/webhooks/gitea'];

/** Largest accepted webhook body, in bytes. */
export const WEBHOOK_BODY_LIMIT = 1_048_576;

/**
 * Constant-time check of a hex signature (after an optional prefix such as `sha256=`) against the
 * HMAC-SHA256 of the raw body. A missing header, wrong prefix, malformed hex or a length mismatch
 * all reject.
 */
function signatureMatches(
  secret: string,
  body: Buffer,
  header: string | string[] | undefined,
  prefix: string,
): boolean {
  if (typeof header !== 'string') return false;
  const value = header.trim();
  if (!value.startsWith(prefix)) return false;
  const hex = value.slice(prefix.length);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const provided = Buffer.from(hex, 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/** `repository.full_name` of the payload, lowercased; null when absent. */
function repositoryOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const repository = (payload as { repository?: unknown }).repository;
  if (typeof repository !== 'object' || repository === null) return null;
  const fullName = (repository as { full_name?: unknown }).full_name;
  if (typeof fullName !== 'string' || fullName.trim() === '') return null;
  return fullName.trim().toLowerCase();
}

/**
 * Register `POST /api/webhooks/github` and `POST /api/webhooks/gitea`. A verified delivery
 * invalidates the cached snapshots of every view that includes the repository.
 *
 * The routes live in an encapsulated plugin with its own JSON parser that keeps the raw bytes, so
 * the HMAC is computed over exactly what the sender signed. Only `application/json` is accepted
 * (other content types get 415).
 */
export function registerWebhooks(app: FastifyInstance, secret: string, service: PlanService): void {
  void app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
      (_request, body, parserDone) => parserDone(null, body),
    );

    const handle =
      (verify: (request: FastifyRequest, raw: Buffer) => boolean) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const raw = request.body as Buffer;
        if (!verify(request, raw)) {
          return reply.code(401).send({ error: 'Invalid signature' });
        }
        const event =
          headerValue(request, 'x-github-event') ??
          headerValue(request, 'x-gitea-event') ??
          headerValue(request, 'x-forgejo-event') ??
          'unknown';
        if (event === 'ping') {
          request.log.info({ event }, 'webhook ping accepted');
          return reply.code(200).send({ ok: true });
        }

        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          return reply.code(400).send({ error: 'Invalid JSON body' });
        }
        const repo = repositoryOf(payload);
        const invalidated = repo === null ? [] : service.viewsForRepo(repo);
        for (const viewId of invalidated) service.invalidate(viewId);
        request.log.info({ event, repo, invalidated }, 'webhook delivery accepted');
        return reply.code(202).send({ invalidated });
      };

    scope.post(
      '/api/webhooks/github',
      handle((request, raw) =>
        signatureMatches(secret, raw, request.headers['x-hub-signature-256'], 'sha256='),
      ),
    );

    // Gitea sends X-Gitea-Signature (plain hex) and also X-Hub-Signature-256; Forgejo sends
    // X-Forgejo-Signature. Any one valid signature authenticates the delivery.
    scope.post(
      '/api/webhooks/gitea',
      handle(
        (request, raw) =>
          signatureMatches(secret, raw, request.headers['x-gitea-signature'], '') ||
          signatureMatches(secret, raw, request.headers['x-forgejo-signature'], '') ||
          signatureMatches(secret, raw, request.headers['x-hub-signature-256'], 'sha256='),
      ),
    );
    done();
  });
}
