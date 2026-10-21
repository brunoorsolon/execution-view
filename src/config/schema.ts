import { z } from 'zod';
import { DEFAULT_KEYWORDS, type KeywordConfig } from '../core/parser.js';
import type { OrderingMode, ProviderKind, RepoRef } from '../core/types.js';

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
  dependencies: {
    native: boolean;
    body: boolean | 'strict';
    subIssues: boolean;
    keywords: KeywordConfig;
  };
  scope: { labels: string[]; excludeLabels: string[]; milestones: string[] };
  ordering: { priorityLabels: string[]; mode: OrderingMode };
}

/** How a release repository's dedicated API token is supplied. Exactly one route, never a fallback. */
export type ReleaseTokenSelector = { kind: 'file'; path: string } | { kind: 'env'; name: string };

/** One explicitly allowlisted Gitea repository, resolved from the `releases` block. */
export interface ResolvedReleaseRepository {
  id: string;
  /** Id of the existing Gitea source this repository belongs to. */
  source: string;
  repo: RepoRef;
  /** `ssh://` origin used for tag pushes; never a scp-style or option-bearing string. */
  origin: string;
  /** Dedicated release token, separate from the planning source token. */
  token: ReleaseTokenSelector;
  expectedApiUser: string;
  ci: { workflowPath: string };
  ssh: { privateKeyFile: string; knownHostsFile: string };
  tagger: { name: string; email: string };
}

/** Releases are off unless the operator explicitly enables and completes the block. */
export type ResolvedReleases =
  | { enabled: false }
  | {
      enabled: true;
      publicOrigin: string;
      stateDir: string;
      repositories: ResolvedReleaseRepository[];
    };

export interface AppConfig {
  server: { host: string; port: number; basicAuth: { username: string; password: string } | null };
  cache: { ttlSeconds: number };
  /** How often the web UI refreshes the open view; 0 turns the timer off. */
  ui: { refreshMinutes: number };
  /** The webhook endpoints are enabled when a secret is configured; null otherwise. */
  webhooks: { secret: string } | null;
  sources: ResolvedSource[];
  views: ResolvedView[];
  /** Opt-in release publication; disabled by default so planning-only setups need nothing new. */
  releases: ResolvedReleases;
  /** Non-fatal problems found while loading (for example a tokenEnv naming an unset variable). */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Raw YAML schema
// ---------------------------------------------------------------------------

/** A day. Also keeps the UI timer far below setInterval's ~24.8-day limit, past which it fires at once. */
export const MAX_REFRESH_MINUTES = 1440;
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

/** No control characters, so a value cannot smuggle a newline into a diagnostic or a subprocess argument. */
const printable = (s: string): boolean => !/[\x00-\x1f\x7f]/.test(s);

/** A normalized absolute path: no relative segments, no empty segment, not the root. */
function absolutePathProblem(s: string): string | null {
  if (!s.startsWith('/')) return 'must be an absolute path';
  if (!printable(s)) return 'must not contain control characters';
  const segments = s.split('/').slice(1);
  if (segments.length === 0 || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return 'must be a normalized absolute path without ".", ".." or empty segments';
  }
  return null;
}

const absolutePathSchema = z
  .string()
  .min(1)
  .refine(
    (s) => absolutePathProblem(s) === null,
    (s) => ({
      message: `invalid path: ${absolutePathProblem(s)}`,
    }),
  );

function publicOriginProblem(s: string): string | null {
  if (!printable(s) || /\s/.test(s)) return 'must not contain whitespace or control characters';
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return 'must be an http(s) URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must use http:// or https://';
  if (url.username !== '' || url.password !== '') return 'must not contain credentials';
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return 'must be an origin without a path, query or fragment';
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return 'plain http is allowed only for an isolated loopback test deployment';
  }
  return null;
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  // A dotted prefix would also accept a public name such as 127.evil.com.
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return ipv4 !== null && ipv4.slice(1).every((part) => Number(part) <= 255);
}

const publicOriginSchema = z.string().refine(
  (s) => publicOriginProblem(s) === null,
  (s) => ({
    message: `invalid publicOrigin: ${publicOriginProblem(s)}`,
  }),
);

function sshOriginProblem(s: string): string | null {
  if (!printable(s) || /\s/.test(s)) return 'must not contain whitespace or control characters';
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return 'must be an ssh:// URL';
  }
  if (url.protocol !== 'ssh:') return 'must start with ssh://';
  if (url.username !== '' && !/^[A-Za-z0-9_.-]+$/.test(url.username)) return 'has an unsafe user';
  if (url.password !== '') return 'must not contain a password';
  if (url.hostname === '' || url.hostname.startsWith('-')) return 'must name a host';
  if (url.port !== '' && !/^\d{1,5}$/.test(url.port)) return 'has an invalid port';
  if (url.search !== '' || url.hash !== '') return 'must not contain a query or fragment';
  if (url.pathname.split('/').length !== 3) return 'must name exactly /owner/repo(.git)';
  return null;
}

const sshOriginSchema = z.string().refine(
  (s) => sshOriginProblem(s) === null,
  (s) => ({
    message: `invalid SSH origin: ${sshOriginProblem(s)}`,
  }),
);

function workflowPathProblem(s: string): string | null {
  if (s.startsWith('/') || s.includes('\\')) return 'must be a relative path inside the repository';
  if (!/^[A-Za-z0-9._/-]+$/.test(s))
    return 'may contain only letters, digits, ".", "_", "-" and "/"';
  if (!/\.ya?ml$/i.test(s)) return 'must name a .yml or .yaml workflow';
  if (s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return 'must not contain ".", ".." or empty segments';
  }
  return null;
}

const workflowPathSchema = z.string().refine(
  (s) => workflowPathProblem(s) === null,
  (s) => ({
    message: `invalid workflow path: ${workflowPathProblem(s)}`,
  }),
);

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name');

const gitIdentitySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .refine(
        (s) => printable(s) && !/[<>]/.test(s),
        () => ({
          message: 'must not contain control characters, "<" or ">"',
        }),
      ),
    email: z
      .string()
      .trim()
      .refine(
        (s) => /^[^@<>\s]+@[^@<>\s]+$/.test(s),
        () => ({
          message: 'must be a plain email address without "<" or ">"',
        }),
      ),
  })
  .strict();

const releaseRepoSchema = z
  .object({
    id: idSchema,
    source: z.string().min(1),
    repo: repoSchema,
    origin: sshOriginSchema,
    apiTokenFile: absolutePathSchema.optional(),
    apiTokenEnv: envNameSchema.optional(),
    expectedApiUser: z
      .string()
      .trim()
      .min(1)
      .refine(
        (s) => printable(s),
        () => ({ message: 'must not contain control characters' }),
      ),
    ci: z.object({ workflowPath: workflowPathSchema }).strict(),
    ssh: z
      .object({ privateKeyFile: absolutePathSchema, knownHostsFile: absolutePathSchema })
      .strict(),
    tagger: gitIdentitySchema,
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.apiTokenFile === undefined) === (r.apiTokenEnv === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiTokenFile'],
        message: 'exactly one of apiTokenFile or apiTokenEnv is required',
      });
    }
  });

/**
 * The `releases` key is accepted structurally even while disabled, so a stale or partial release
 * block cannot stop a planning-only deployment from starting. The full allowlist is validated
 * only when `enabled: true`.
 */
const releasesSchema = z
  .object({
    enabled: z.boolean().optional(),
    publicOrigin: z.string().optional(),
    stateDir: z.string().optional(),
    repositories: z.array(z.unknown()).optional(),
  })
  .strict();

export const enabledReleasesSchema = z
  .object({
    enabled: z.literal(true),
    publicOrigin: publicOriginSchema,
    stateDir: absolutePathSchema,
    repositories: z.array(releaseRepoSchema).min(1, 'at least one release repository is required'),
  })
  .strict();

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
        body: z.union([z.boolean(), z.literal('strict')]).optional(),
        subIssues: z.boolean().optional(),
        keywords: z.object({ blockedBy: keywordList, blocks: keywordList }).strict().optional(),
      })
      .strict()
      .optional(),
    scope: z
      .object({ labels: stringList, excludeLabels: stringList, milestones: stringList })
      .strict()
      .optional(),
    ordering: z
      .object({ priorityLabels: stringList, mode: z.enum(['priority', 'waves']).optional() })
      .strict()
      .optional(),
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
    ui: z
      .object({ refreshMinutes: z.number().int().min(0).max(MAX_REFRESH_MINUTES).optional() })
      .strict()
      .optional(),
    webhooks: webhooksSchema.optional(),
    releases: releasesSchema.optional(),
    sources: z.array(sourceSchema).min(1, 'at least one source is required'),
    views: z.array(viewSchema).min(1, 'at least one view is required'),
  })
  .strict();

export type RawConfig = z.infer<typeof rawConfigSchema>;
export type RawSource = z.infer<typeof sourceSchema>;
export type RawView = z.infer<typeof viewSchema>;
