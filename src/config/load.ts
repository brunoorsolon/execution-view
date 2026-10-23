import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodIssue } from 'zod';
import type { OrderingMode, ProviderKind } from '../core/types.js';
import {
  DEFAULT_KEYWORDS,
  MAX_REFRESH_MINUTES,
  enabledReleasesSchema,
  rawConfigSchema,
  type AppConfig,
  type RawConfig,
  type RawSource,
  type RawView,
  type ReleaseTokenSelector,
  type ResolvedReleaseRepository,
  type ResolvedReleases,
  type ResolvedSource,
  type ResolvedView,
} from './schema.js';

export { DEFAULT_KEYWORDS } from './schema.js';
export type {
  AppConfig,
  KeywordConfig,
  ReleaseTokenSelector,
  ResolvedReleaseRepository,
  ResolvedReleases,
  ResolvedSource,
  ResolvedView,
} from './schema.js';

type Env = Record<string, string | undefined>;

export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_PORT = 8080;
export const DEFAULT_CACHE_TTL_SECONDS = 300;
export const DEFAULT_REFRESH_MINUTES = 5;
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const DEFAULT_GITHUB_WEB_URL = 'https://github.com';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  path?: string;
  env?: Env;
  cwd?: string;
}

export interface ParseConfigOptions {
  /** Directory that relative fixture paths resolve against. Default: process.cwd(). */
  baseDir?: string;
}

const NO_CONFIG_MESSAGE =
  'No configuration found: create config.yaml (see config.example.yaml), set FD_CONFIG, or set FD_PROVIDER and FD_REPOS for env-only mode';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** An env value, with unset and empty/blank treated the same. */
function envValue(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

// shortcut: the EV_* names from before the Forge Desk rename still work and still win over FD_*,
// as in 3.0.0, so a 3.0.x upgrade changes nothing; remove them in the next major release.
const SETTINGS = [
  'CONFIG',
  'PROVIDER',
  'REPOS',
  'TOKEN',
  'BASE_URL',
  'SUB_ISSUES',
  'ORDERING_MODE',
  'VIEW_ID',
  'VIEW_TITLE',
  'PRIORITY_LABELS',
  'HOST',
  'PORT',
  'CACHE_TTL',
  'REFRESH_MINUTES',
  'BASIC_AUTH',
  'WEBHOOK_SECRET',
] as const;
type Setting = (typeof SETTINGS)[number];

/** The variable that supplies a fixed setting: its legacy `EV_` name when set, else `FD_`. */
function settingName(env: Env, name: Setting): string {
  return envValue(env, `EV_${name}`) !== undefined ? `EV_${name}` : `FD_${name}`;
}

function setting(env: Env, name: Setting): string | undefined {
  return envValue(env, settingName(env, name));
}

function legacySettingWarnings(env: Env): string[] {
  return SETTINGS.filter((name) => envValue(env, `EV_${name}`) !== undefined).map(
    (name) =>
      `EV_${name} is deprecated: rename it to FD_${name}` +
      (envValue(env, `FD_${name}`) !== undefined ? ` (EV_${name} overrides FD_${name})` : ''),
  );
}

function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, '');
}

function formatPath(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? seg : `.${seg}`;
  }
  return out === '' ? 'config' : out;
}

function formatIssues(issues: ZodIssue[]): string {
  const lines = issues.map((i) => `  - ${formatPath(i.path)}: ${i.message}`);
  return `Invalid configuration:\n${lines.join('\n')}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseCommaList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function parseBoolEnv(name: string, value: string): boolean {
  const v = value.toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ConfigError(`${name}: expected "true" or "false" (got "${value}")`);
}

function parseOrderingModeEnv(name: string, value: string): OrderingMode {
  const v = value.toLowerCase();
  if (v === 'priority' || v === 'waves') return v;
  throw new ConfigError(`${name}: expected "priority" or "waves" (got "${value}")`);
}

function parseIntEnv(name: string, value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${name}: expected an integer (got "${value}")`);
  }
  const n = Number(value);
  if (n < min || n > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `between ${min} and ${max}`;
    throw new ConfigError(`${name}: must be an integer ${range} (got "${value}")`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

function deriveWebUrl(kind: ProviderKind, baseUrl: string, explicit: string | undefined): string {
  if (explicit !== undefined) return stripTrailingSlashes(explicit);
  if (kind === 'fixture') return '';
  if (kind === 'gitea') return baseUrl;
  if (baseUrl.toLowerCase() === DEFAULT_GITHUB_API_URL) return DEFAULT_GITHUB_WEB_URL;
  return stripTrailingSlashes(baseUrl.replace(/\/api\/v3$/i, ''));
}

function resolveSource(
  raw: RawSource,
  env: Env,
  baseDir: string,
  warnings: string[],
): ResolvedSource {
  let baseUrl: string;
  if (raw.kind === 'fixture') baseUrl = '';
  else if (raw.kind === 'github') {
    baseUrl = stripTrailingSlashes(raw.baseUrl ?? DEFAULT_GITHUB_API_URL);
  } else baseUrl = stripTrailingSlashes(raw.baseUrl ?? '');

  let token: string | null = null;
  if (raw.tokenEnv !== undefined) {
    const fromEnv = envValue(env, raw.tokenEnv);
    if (fromEnv !== undefined) token = fromEnv;
    else {
      warnings.push(
        `source "${raw.id}": environment variable ${raw.tokenEnv} is not set` +
          (raw.token ? '; using the inline token' : '; using anonymous access'),
      );
    }
  }
  if (token === null && raw.token !== undefined && raw.token !== '') token = raw.token;

  return {
    id: raw.id,
    kind: raw.kind,
    baseUrl,
    webUrl: deriveWebUrl(raw.kind, baseUrl, raw.webUrl),
    token,
    path: raw.kind === 'fixture' && raw.path !== undefined ? resolve(baseDir, raw.path) : null,
  };
}

function resolveView(raw: RawView): ResolvedView {
  const repoSet = new Set(raw.repos.map((r) => r.toLowerCase()));
  const repos = [...repoSet].sort(compareStrings).map((full) => {
    const slash = full.indexOf('/');
    return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
  });
  const deps = raw.dependencies;
  return {
    id: raw.id,
    title: raw.title ?? raw.id,
    source: raw.source,
    repos,
    dependencies: {
      native: deps?.native ?? true,
      body: deps?.body ?? true,
      subIssues: deps?.subIssues ?? false,
      keywords: {
        blockedBy: [...(deps?.keywords?.blockedBy ?? DEFAULT_KEYWORDS.blockedBy)],
        blocks: [...(deps?.keywords?.blocks ?? DEFAULT_KEYWORDS.blocks)],
      },
    },
    scope: {
      labels: [...(raw.scope?.labels ?? [])],
      excludeLabels: [...(raw.scope?.excludeLabels ?? [])],
      milestones: [...(raw.scope?.milestones ?? [])],
    },
    ordering: {
      priorityLabels: [...(raw.ordering?.priorityLabels ?? [])],
      mode: raw.ordering?.mode ?? 'priority',
    },
  };
}

function resolveBasicAuth(
  raw: NonNullable<RawConfig['server']>['basicAuth'],
  env: Env,
): { username: string; password: string } | null {
  const override = setting(env, 'BASIC_AUTH');
  if (override !== undefined) {
    const colon = override.indexOf(':');
    if (colon <= 0 || colon === override.length - 1) {
      throw new ConfigError(`${settingName(env, 'BASIC_AUTH')}: expected "user:password"`);
    }
    return { username: override.slice(0, colon), password: override.slice(colon + 1) };
  }
  if (raw === undefined) return null;
  const password =
    (raw.passwordEnv !== undefined ? envValue(env, raw.passwordEnv) : undefined) ?? raw.password;
  if (password === undefined || password === '') {
    const hint =
      raw.passwordEnv !== undefined
        ? `environment variable ${raw.passwordEnv} is not set and no password is given`
        : 'a password or passwordEnv is required';
    throw new ConfigError(`Invalid configuration:\n  - server.basicAuth: ${hint}`);
  }
  return { username: raw.username, password };
}

function resolveWebhooks(
  raw: RawConfig['webhooks'],
  env: Env,
  warnings: string[],
): { secret: string } | null {
  const override = setting(env, 'WEBHOOK_SECRET');
  if (override !== undefined) return { secret: override };
  if (raw === undefined) return null;
  const fromEnv = raw.secretEnv !== undefined ? envValue(env, raw.secretEnv) : undefined;
  const inline = raw.secret !== undefined && raw.secret.trim() !== '' ? raw.secret : undefined;
  const secret = fromEnv ?? inline;
  if (secret !== undefined) return { secret };
  warnings.push(
    raw.secretEnv !== undefined
      ? `webhooks: environment variable ${raw.secretEnv} is not set and no secret is given; webhooks are disabled`
      : 'webhooks: no secret is given; webhooks are disabled',
  );
  return null;
}

/**
 * Resolve the opt-in `releases` block. Everything is optional while releases are disabled, so an
 * existing planning-only file keeps working; an enabled block must be complete and safe.
 */
function resolveReleases(
  raw: RawConfig['releases'],
  kindById: Map<string, ProviderKind>,
  hasLogin: boolean,
): ResolvedReleases {
  if (raw === undefined) return { enabled: false };
  const parsed = enabledReleasesSchema.safeParse(raw);
  if (!parsed.success) {
    // A disabled or partial block must not keep an existing planning deployment from starting.
    if (raw.enabled !== true) return { enabled: false };
    const issues = parsed.error.issues.map((issue) => ({
      ...issue,
      path: ['releases', ...issue.path],
    }));
    throw new ConfigError(formatIssues(issues));
  }
  const enabled = parsed.data;

  const errors: string[] = [];
  if (!hasLogin) {
    errors.push(
      'releases.enabled: the application login (server.basicAuth or FD_BASIC_AUTH) is required when releases are enabled',
    );
  }

  const ids = new Set<string>();
  const repositories = enabled.repositories.map((r, i): ResolvedReleaseRepository => {
    const at = `releases.repositories[${i}]`;
    if (ids.has(r.id)) errors.push(`${at}.id: duplicate release repository id "${r.id}"`);
    ids.add(r.id);
    const kind = kindById.get(r.source);
    if (kind === undefined) {
      errors.push(`${at}.source: unknown source "${r.source}"`);
    } else if (kind !== 'gitea') {
      errors.push(
        `${at}.source: release repositories require a gitea source ("${r.source}" is ${kind})`,
      );
    }
    const slash = r.repo.indexOf('/');
    const repo = {
      owner: r.repo.slice(0, slash).toLowerCase(),
      repo: r.repo.slice(slash + 1).toLowerCase(),
    };
    const originPath = new URL(r.origin).pathname.replace(/\.git$/i, '').toLowerCase();
    if (originPath !== `/${repo.owner}/${repo.repo}`) {
      errors.push(
        `${at}.origin: path must be /${repo.owner}/${repo.repo}(.git) to match repo "${r.repo}"`,
      );
    }
    const token: ReleaseTokenSelector =
      r.apiTokenFile !== undefined
        ? { kind: 'file', path: r.apiTokenFile }
        : { kind: 'env', name: r.apiTokenEnv as string };
    return {
      id: r.id,
      source: r.source,
      repo,
      origin: r.origin,
      token,
      expectedApiUser: r.expectedApiUser,
      ci: { workflowPath: r.ci.workflowPath },
      ssh: { privateKeyFile: r.ssh.privateKeyFile, knownHostsFile: r.ssh.knownHostsFile },
      tagger: { name: r.tagger.name, email: r.tagger.email },
    };
  });

  if (errors.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return {
    enabled: true,
    // Store the browser's serialized origin, so later request-origin comparisons cannot differ in
    // case, default port or dot segments.
    publicOrigin: new URL(enabled.publicOrigin).origin,
    stateDir: enabled.stateDir,
    repositories,
  };
}

/** Validate an already-parsed raw config object and resolve it into an AppConfig. */
function resolveConfig(input: unknown, env: Env, baseDir: string): AppConfig {
  const parsed = rawConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error.issues));
  const raw = parsed.data;

  const errors: string[] = [];
  const sourceIds = new Set<string>();
  raw.sources.forEach((s, i) => {
    if (sourceIds.has(s.id)) errors.push(`sources[${i}].id: duplicate source id "${s.id}"`);
    sourceIds.add(s.id);
  });
  const known = raw.sources.map((s) => s.id);
  const kindById = new Map<string, ProviderKind>();
  for (const s of raw.sources) if (!kindById.has(s.id)) kindById.set(s.id, s.kind);
  const viewIds = new Set<string>();
  raw.views.forEach((v, i) => {
    if (viewIds.has(v.id)) errors.push(`views[${i}].id: duplicate view id "${v.id}"`);
    viewIds.add(v.id);
    if (!sourceIds.has(v.source)) {
      errors.push(
        `views[${i}].source: unknown source "${v.source}" (known: ${[...new Set(known)].join(', ')})`,
      );
    }
  });
  if (errors.length > 0)
    throw new ConfigError(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);

  const warnings: string[] = legacySettingWarnings(env);
  const sources = raw.sources.map((s) => resolveSource(s, env, baseDir, warnings));
  const views = raw.views.map(resolveView);
  for (const v of views) {
    if (v.dependencies.subIssues && kindById.get(v.source) !== 'github') {
      warnings.push(`view "${v.id}": subIssues is only supported by github sources; it is ignored`);
    }
  }

  const host = setting(env, 'HOST') ?? raw.server?.host ?? DEFAULT_HOST;
  const portEnv = setting(env, 'PORT');
  const port =
    portEnv !== undefined
      ? parseIntEnv(settingName(env, 'PORT'), portEnv, 1, 65535)
      : (raw.server?.port ?? DEFAULT_PORT);
  const ttlEnv = setting(env, 'CACHE_TTL');
  const ttlSeconds =
    ttlEnv !== undefined
      ? parseIntEnv(settingName(env, 'CACHE_TTL'), ttlEnv, 0, Number.MAX_SAFE_INTEGER)
      : (raw.cache?.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS);
  const refreshEnv = setting(env, 'REFRESH_MINUTES');
  const refreshMinutes =
    refreshEnv !== undefined
      ? parseIntEnv(settingName(env, 'REFRESH_MINUTES'), refreshEnv, 0, MAX_REFRESH_MINUTES)
      : (raw.ui?.refreshMinutes ?? DEFAULT_REFRESH_MINUTES);

  const basicAuth = resolveBasicAuth(raw.server?.basicAuth, env);
  const releases = resolveReleases(raw.releases, kindById, basicAuth !== null);

  return {
    server: { host, port, basicAuth },
    cache: { ttlSeconds },
    ui: { refreshMinutes },
    webhooks: resolveWebhooks(raw.webhooks, env, warnings),
    sources,
    views,
    releases,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Parse and resolve YAML config text. Relative fixture paths resolve against
 * `options.baseDir` (default: process.cwd()).
 */
export function parseConfig(
  yamlText: string,
  env: Env,
  options: ParseConfigOptions = {},
): AppConfig {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    throw new ConfigError(`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError(
      'Invalid configuration:\n  - config: expected a mapping at the top level',
    );
  }
  return resolveConfig(doc, env, options.baseDir ?? process.cwd());
}

/**
 * Build a config from FD_* variables alone (used when there is no config file).
 * Relative fixture paths do not apply here; `cwd` is only the base directory.
 */
export function configFromEnv(env: Env, cwd: string = process.cwd()): AppConfig {
  const provider = setting(env, 'PROVIDER');
  if (provider === undefined) throw new ConfigError(NO_CONFIG_MESSAGE);
  if (provider !== 'github' && provider !== 'gitea') {
    throw new ConfigError(
      `${settingName(env, 'PROVIDER')}: expected "github" or "gitea" (got "${provider}")`,
    );
  }
  const repos = parseCommaList(setting(env, 'REPOS'));
  if (repos.length === 0) {
    throw new ConfigError(
      'FD_REPOS is required in env-only mode (comma-separated owner/repo list)',
    );
  }
  const token =
    setting(env, 'TOKEN') ?? envValue(env, provider === 'github' ? 'GITHUB_TOKEN' : 'GITEA_TOKEN');
  const baseUrl = setting(env, 'BASE_URL');
  const subIssues = setting(env, 'SUB_ISSUES');
  const orderingMode = setting(env, 'ORDERING_MODE');

  const source: Record<string, unknown> = { id: 'default', kind: provider };
  if (baseUrl !== undefined) source['baseUrl'] = baseUrl;
  if (token !== undefined) source['token'] = token;

  const view: Record<string, unknown> = {
    id: setting(env, 'VIEW_ID') ?? 'default',
    source: 'default',
    repos,
    ordering: {
      priorityLabels: parseCommaList(setting(env, 'PRIORITY_LABELS')),
      ...(orderingMode !== undefined
        ? { mode: parseOrderingModeEnv(settingName(env, 'ORDERING_MODE'), orderingMode) }
        : {}),
    },
  };
  const title = setting(env, 'VIEW_TITLE');
  if (title !== undefined) view['title'] = title;
  if (subIssues !== undefined) {
    view['dependencies'] = { subIssues: parseBoolEnv(settingName(env, 'SUB_ISSUES'), subIssues) };
  }

  return resolveConfig({ sources: [source], views: [view] }, env, cwd);
}

/**
 * Load the configuration. Path precedence: opts.path, env.FD_CONFIG (or legacy EV_CONFIG),
 * `<cwd>/config.yaml`. An explicit path must exist. When the default path does
 * not exist, fall back to env-only mode.
 */
export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.path !== undefined && opts.path !== '' ? opts.path : setting(env, 'CONFIG');
  const filePath = resolve(cwd, explicit ?? 'config.yaml');

  let exists = false;
  try {
    exists = statSync(filePath).isFile();
  } catch {
    exists = false;
  }

  if (!exists) {
    if (explicit !== undefined) throw new ConfigError(`Config file not found: ${filePath}`);
    if (setting(env, 'PROVIDER') === undefined) throw new ConfigError(NO_CONFIG_MESSAGE);
    return configFromEnv(env, cwd);
  }

  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `Cannot read config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return parseConfig(text, env, { baseDir: dirname(filePath) });
  } catch (err) {
    if (err instanceof ConfigError) throw new ConfigError(`${filePath}: ${err.message}`);
    throw err;
  }
}
