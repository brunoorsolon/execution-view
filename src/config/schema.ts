import { z } from 'zod';
import { DEFAULT_KEYWORDS, type KeywordConfig } from '../core/parser.js';
import type { ProviderKind, RepoRef } from '../core/types.js';

export { DEFAULT_KEYWORDS };
export type { KeywordConfig };

// ---------------------------------------------------------------------------
// Resolved (output) types, as specified in docs/ARCHITECTURE.md section 11.
// ---------------------------------------------------------------------------

export interface ResolvedSource {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  webUrl: string;
  token: string | null;
  path: string | null;
}

export interface ResolvedView {
  id: string;
  title: string;
  source: string;
  repos: RepoRef[];
  dependencies: { native: boolean; body: boolean; subIssues: boolean; keywords: KeywordConfig };
  scope: { labels: string[]; excludeLabels: string[]; milestones: string[] };
  ordering: { priorityLabels: string[] };
}

export interface AppConfig {
  server: { host: string; port: number; basicAuth: { username: string; password: string } | null };
  cache: { ttlSeconds: number };
  /** The webhook endpoints are enabled when a secret is configured; null otherwise. */
  webhooks: { secret: string } | null;
  sources: ResolvedSource[];
  views: ResolvedView[];
  /** Non-fatal problems found while loading (for example a tokenEnv naming an unset variable). */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Raw YAML schema
// ---------------------------------------------------------------------------

export const ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i;

const idSchema = z.string().refine(
  (s) => ID_PATTERN.test(s),
  (s) => ({ message: `invalid id "${s}" (must match ${ID_PATTERN.source})` }),
);

const urlSchema = z.string().refine(
  (s) => HTTP_URL_PATTERN.test(s),
  (s) => ({ message: `invalid URL "${s}" (must start with http:// or https://)` }),
);

const repoSchema = z.string().refine(
  (s) => REPO_PATTERN.test(s),
  (s) => ({ message: `invalid repo "${s}" (expected owner/repo)` }),
);

const keywordList = z.array(z.string().trim().min(1)).optional();
const stringList = z.array(z.string()).optional();

const sourceSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['github', 'gitea', 'fixture']),
    baseUrl: urlSchema.optional(),
    webUrl: urlSchema.optional(),
    tokenEnv: z.string().min(1).optional(),
    token: z.string().optional(),
    path: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.kind === 'gitea' && s.baseUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: 'baseUrl is required for gitea sources',
      });
    }
    if (s.kind === 'fixture' && s.path === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: 'path is required for fixture sources',
      });
    }
  });

const viewSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).optional(),
    source: z.string().min(1),
    repos: z.array(repoSchema).min(1, 'at least one repo is required'),
    dependencies: z
      .object({
        native: z.boolean().optional(),
        body: z.boolean().optional(),
        subIssues: z.boolean().optional(),
        keywords: z.object({ blockedBy: keywordList, blocks: keywordList }).strict().optional(),
      })
      .strict()
      .optional(),
    scope: z
      .object({ labels: stringList, excludeLabels: stringList, milestones: stringList })
      .strict()
      .optional(),
    ordering: z.object({ priorityLabels: stringList }).strict().optional(),
  })
  .strict();

const basicAuthSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1).optional(),
    passwordEnv: z.string().min(1).optional(),
  })
  .strict();

const webhooksSchema = z
  .object({
    secret: z.string().optional(),
    secretEnv: z.string().min(1).optional(),
  })
  .strict();

export const rawConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        basicAuth: basicAuthSchema.optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({ ttlSeconds: z.number().int().min(0).optional() })
      .strict()
      .optional(),
    webhooks: webhooksSchema.optional(),
    sources: z.array(sourceSchema).min(1, 'at least one source is required'),
    views: z.array(viewSchema).min(1, 'at least one view is required'),
  })
  .strict();

export type RawConfig = z.infer<typeof rawConfigSchema>;
export type RawSource = z.infer<typeof sourceSchema>;
export type RawView = z.infer<typeof viewSchema>;
