import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { ConfigError, loadConfig } from '../config/load.js';
import type { AppConfig, ResolvedSource } from '../config/schema.js';
import type { IssueProvider, PlanStats, PlanWarning, Snapshot } from '../core/types.js';
import { exporters, type ExportFormat } from '../export/index.js';
import { PlanService, UnknownViewError, type ViewSummary } from '../service/planService.js';
import { startServer } from '../server/index.js';

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** True when stdout is a terminal. ANSI colours are used only then (and when NO_COLOR is unset). */
  isTTY?: boolean;
}

export interface CliDeps {
  providerFor?: (source: ResolvedSource) => IssueProvider;
  now?: () => Date;
  startServer?: typeof startServer;
}

/** Exit codes. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_PROBLEMS = 2;

const FORMATS = ['md', 'json', 'mermaid', 'mmd', 'dot'] as const;

/** Warning codes that make a view "not ok" (exit code 2). */
const PROBLEM_CODES: ReadonlySet<string> = new Set(['cycle', 'dangling-reference']);

const HINTS: Record<string, string> = {
  cycle:
    'break the cycle by removing one of these dependencies (a `Depends on` / `Blocked by` line in an issue body, or a native dependency in the tracker)',
  'blocked-by-cycle':
    'these issues wait on an issue that is part of a cycle; resolve the cycle first and they will be scheduled',
  'self-reference':
    'an issue lists itself as a dependency; remove that reference from its body or native dependencies',
  'dangling-reference':
    'check the issue number and the repo name in the reference, and that the token can read that repo (a typo, a deleted issue and a missing access right all look the same to the API)',
  'external-unresolved':
    'the cap on transitive lookups of issues outside the view was hit, so some external prerequisites are missing from the plan; narrow the view (scope, repos) or add the repos that hold those issues',
  'native-unsupported':
    'native dependencies are not available here. Gitea: enable issue dependencies for the repo (Settings, Advanced) on a version that supports them. GitHub Enterprise Server: issue dependencies need a recent GHES version (older ones answer 404). Or set `dependencies.native: false` and declare dependencies with `Depends on #N` lines',
  'fetch-error':
    'an issue could not be fetched; check that the token is set and valid, that it can read the repo, and that the network and baseUrl are reachable',
};

const NO_EDGES_HINT =
  'No dependencies found. Declare them natively or with `Depends on #N` lines; see docs/PREREQUISITES.md';

/** Thrown for user-facing failures that already carry their final message. */
class CliError extends Error {}

interface Painter {
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

function painter(io: CliIo): Painter {
  const noColor = (io.env['NO_COLOR'] ?? '') !== '';
  const on = io.isTTY === true && !noColor;
  const wrap = (open: number, close: number) => (s: string) =>
    on ? `\u001b[${open}m${s}\u001b[${close}m` : s;
  return {
    green: wrap(32, 39),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  };
}

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Context {
  io: CliIo;
  config: AppConfig;
  service: PlanService;
  views: ViewSummary[];
}

function loadContext(io: CliIo, deps: CliDeps, configPath: string | undefined): Context {
  const config = loadConfig({
    ...(configPath !== undefined ? { path: configPath } : {}),
    env: io.env,
    cwd: io.cwd,
  });
  const service = new PlanService(config, {
    ...(deps.providerFor !== undefined ? { providerFor: deps.providerFor } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  return { io, config, service, views: service.listViews() };
}

function unknownViewMessage(id: string, views: ViewSummary[]): string {
  return `Unknown view "${id}". Available: ${views.map((v) => v.id).join(', ')}`;
}

function requireViews(ctx: Context, ids: string[]): void {
  for (const id of ids) {
    if (!ctx.views.some((v) => v.id === id)) throw new CliError(unknownViewMessage(id, ctx.views));
  }
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)));
  return rows
    .map((r) =>
      r
        .map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function runViews(ctx: Context, opts: { json?: boolean }): number {
  if (opts.json === true) {
    ctx.io.stdout(JSON.stringify(ctx.views, null, 2) + '\n');
    return EXIT_OK;
  }
  const rows = [
    ['ID', 'TITLE', 'KIND', 'REPOS'],
    ...ctx.views.map((v) => [v.id, v.title, v.kind, v.repos.join(', ')]),
  ];
  ctx.io.stdout(table(rows) + '\n');
  return EXIT_OK;
}

async function runPlan(
  ctx: Context,
  viewId: string,
  opts: { format: string; out?: string },
): Promise<number> {
  requireViews(ctx, [viewId]);
  const format: ExportFormat = opts.format === 'mmd' ? 'mermaid' : (opts.format as ExportFormat);
  const snapshot = await ctx.service.getSnapshot(viewId, { refresh: true });
  const text = exporters[format].render(snapshot);
  if (opts.out !== undefined) {
    const file = path.resolve(ctx.io.cwd, opts.out);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
    } catch (err) {
      throw new CliError(`Cannot write ${opts.out}: ${errorMessage(err)}`);
    }
    ctx.io.stderr(`Wrote ${opts.out}\n`);
  } else {
    ctx.io.stdout(text);
  }
  return EXIT_OK;
}

interface ViewCheck {
  id: string;
  ok: boolean;
  stats: PlanStats | null;
  warnings: PlanWarning[];
  error: string | null;
}

function hasProblems(snapshot: Snapshot): boolean {
  return (
    snapshot.plan.cycles.length > 0 || snapshot.plan.warnings.some((w) => PROBLEM_CODES.has(w.code))
  );
}

function formatStats(s: PlanStats): string {
  return [
    `${s.total} issues`,
    `${s.ready} ready`,
    `${s.blocked} blocked`,
    `${s.unschedulable} unschedulable`,
    `${s.external} external`,
    `${s.edges} dependencies`,
    `${s.waves} waves`,
  ].join(' · ');
}

async function runCheck(ctx: Context, ids: string[], opts: { json?: boolean }): Promise<number> {
  const { io } = ctx;
  const c = painter(io);
  const selected = ids.length > 0 ? ids : ctx.views.map((v) => v.id);
  requireViews(ctx, selected);
  const json = opts.json === true;
  const configWarnings = ctx.config.warnings ?? [];

  const out: string[] = [];
  const results: ViewCheck[] = [];
  let failed = false;
  let problems = false;

  for (const w of configWarnings) out.push(`${c.yellow('⚠')} config: ${w}`);

  for (const id of selected) {
    const summary = ctx.views.find((v) => v.id === id)!;
    let snapshot: Snapshot;
    try {
      snapshot = await ctx.service.getSnapshot(id, { refresh: true });
    } catch (err) {
      failed = true;
      const message = errorMessage(err);
      results.push({ id, ok: false, stats: null, warnings: [], error: message });
      out.push(`${c.red('✖')} ${c.bold(id)} (${summary.title}) · ${summary.kind}`);
      out.push(`  ${c.red('✖')} fetch failed: ${message}`);
      continue;
    }

    const bad = hasProblems(snapshot);
    if (bad) problems = true;
    const { stats, warnings } = snapshot.plan;
    results.push({ id, ok: !bad, stats, warnings, error: null });

    const mark = bad ? c.red('✖') : c.green('✔');
    out.push(
      `${mark} ${c.bold(id)} (${snapshot.title}) · ${summary.kind} · ${summary.repos.join(', ')}`,
    );
    out.push(`  ${formatStats(stats)}`);
    for (const w of warnings) {
      const wm = PROBLEM_CODES.has(w.code) ? c.red('✖') : c.yellow('⚠');
      out.push(`  ${wm} ${w.code}: ${w.message}`);
      const hint = HINTS[w.code];
      if (hint !== undefined) out.push(c.dim(`    hint: ${hint}`));
    }
    if (stats.edges === 0) out.push(c.dim(`  hint: ${NO_EDGES_HINT}`));
  }

  if (json) {
    io.stdout(
      JSON.stringify({ ok: !failed && !problems, configWarnings, views: results }, null, 2) + '\n',
    );
  } else {
    io.stdout(out.join('\n') + '\n');
  }
  return failed ? EXIT_ERROR : problems ? EXIT_PROBLEMS : EXIT_OK;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function main(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  let exitCode = EXIT_OK;
  let ctx: Context | null = null;

  const program = new Command();
  program
    .name('execution-view')
    .description('Deterministic dependency graph and execution order for open issues')
    .version(packageVersion())
    .option(
      '-c, --config <path>',
      'path to the config file (default: EV_CONFIG, then ./config.yaml)',
    )
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      writeErr: (s) => io.stderr(s),
      getOutHelpWidth: () => 100,
      getErrHelpWidth: () => 100,
    });

  const context = (cmd: Command): Context => {
    const { config } = cmd.optsWithGlobals<{ config?: string }>();
    const loaded = loadContext(io, deps, config);
    ctx = loaded;
    for (const w of loaded.config.warnings ?? []) io.stderr(`warning: ${w}\n`);
    return loaded;
  };

  program
    .command('serve')
    .description('start the HTTP server and web UI')
    .action(async (_opts: unknown, cmd: Command) => {
      const { config } = cmd.optsWithGlobals<{ config?: string }>();
      const start = deps.startServer ?? startServer;
      await start({
        ...(config !== undefined ? { configPath: path.resolve(io.cwd, config) } : {}),
        env: io.env,
      });
      exitCode = EXIT_OK;
    });

  program
    .command('views')
    .description('list the configured views')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }, cmd: Command) => {
      exitCode = runViews(context(cmd), opts);
    });

  program
    .command('plan')
    .description('print the execution plan of a view')
    .argument('<viewId>', 'id of the view')
    .addOption(new Option('-f, --format <format>', 'output format').choices(FORMATS).default('md'))
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .action(async (viewId: string, opts: { format: string; out?: string }, cmd: Command) => {
      exitCode = await runPlan(context(cmd), viewId, opts);
    });

  program
    .command('check')
    .description('validate the config, fetch the views and report cycles and dangling references')
    .argument('[viewId...]', 'views to check (default: all)')
    .option('--json', 'print machine-readable JSON')
    .action(async (viewIds: string[], opts: { json?: boolean }, cmd: Command) => {
      exitCode = await runCheck(context(cmd), viewIds, opts);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    if (err instanceof ConfigError || err instanceof CliError) {
      io.stderr(`${err.message}\n`);
    } else if (err instanceof UnknownViewError) {
      const known = (ctx as Context | null)?.views ?? [];
      io.stderr(`${unknownViewMessage(err.viewId, known)}\n`);
    } else {
      io.stderr(`Error: ${errorMessage(err)}\n`);
    }
    return EXIT_ERROR;
  }
}
