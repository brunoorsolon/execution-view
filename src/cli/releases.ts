/**
 * Release CLI (source specification section 10): an HTTP client of the running server.
 *
 * Every command reaches the server's own release workflow over its authenticated routes, so a CLI
 * run can never become a second writer over the running server's release state volume. The
 * application credentials arrive from an environment variable or a private file and leave only as
 * an Authorization header, never as a command-line argument and never in output.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Command, CommanderError, Option } from 'commander';
import type {
  ReleaseJob,
  ReleaseObservation,
  ReleasePlan,
  ReleaseTagObservation,
} from '../core/release.js';
import type { CliDeps, CliIo } from './main.js';

/**
 * Release exit codes. Planning keeps its own unchanged codes.
 * `2` also covers a cancellation, `4` an unproved mutation and `5` an internal failure.
 */
export const RELEASE_EXIT = { cancelled: 2, blocked: 3, unproved: 4, internal: 5 } as const;

interface ReleaseOptions {
  server?: string;
  authEnv?: string;
  authFile?: string;
  json?: boolean;
  wait?: boolean;
  approve?: string;
}

interface Connection {
  baseUrl: string;
  authorization: string;
}

/** The invocation or the answer was wrong, and nothing was submitted. */
class InvocationError extends Error {}

/** The server answered, or could not answer, with a specific outcome. */
class ServerError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// connection and authentication
// ---------------------------------------------------------------------------

function connectionFor(opts: ReleaseOptions, io: CliIo): Connection {
  if (opts.server === undefined) throw new InvocationError('--server <url> is required');
  let server: URL;
  try {
    server = new URL(opts.server);
  } catch {
    throw new InvocationError('--server must be an absolute URL');
  }
  if (server.protocol !== 'http:' && server.protocol !== 'https:') {
    throw new InvocationError('--server must use http or https');
  }
  // Credentials in the URL would reach fetch error messages, so they are refused outright.
  if (server.username !== '' || server.password !== '') {
    throw new InvocationError('--server must not carry credentials; use --auth-env or --auth-file');
  }
  return {
    baseUrl: server.toString().replace(/\/+$/, ''),
    authorization: `Basic ${Buffer.from(authMaterial(opts, io), 'utf8').toString('base64')}`,
  };
}

/** `username:password` from the environment variable or the private file the operator names. */
function authMaterial(opts: ReleaseOptions, io: CliIo): string {
  if ((opts.authEnv === undefined) === (opts.authFile === undefined)) {
    throw new InvocationError('set exactly one of --auth-env <name> or --auth-file <path>');
  }
  let material: string;
  if (opts.authEnv !== undefined) {
    const value = io.env[opts.authEnv];
    if (value === undefined || value === '') {
      throw new InvocationError(`environment variable ${opts.authEnv} is empty or not set`);
    }
    material = value;
  } else {
    const file = path.resolve(io.cwd, opts.authFile as string);
    let mode: number;
    try {
      const stats = statSync(file);
      if (!stats.isFile()) throw new Error('not a regular file');
      mode = stats.mode;
    } catch (err) {
      throw new InvocationError(`cannot read ${opts.authFile}: ${errorMessage(err)}`);
    }
    if ((mode & 0o077) !== 0) {
      throw new InvocationError(`${opts.authFile} is readable by group or others; use mode 0600`);
    }
    material = readFileSync(file, 'utf8').trim();
  }
  if (!material.includes(':')) {
    throw new InvocationError('application credentials must read "username:password"');
  }
  return material;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** A client-side problem before submission, or the server's answer, as an exit code. */
function exitForStatus(status: number): number {
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return RELEASE_EXIT.cancelled;
  }
  if (status === 409 || status === 410 || status === 503) return RELEASE_EXIT.blocked;
  return RELEASE_EXIT.internal;
}

async function call(
  connection: Connection,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  /** Exit code when the answer is lost: only a publication can carry a remote effect. */
  lostAnswerExit: number = RELEASE_EXIT.internal,
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: connection.authorization,
  };
  const init: RequestInit = { method, headers, redirect: 'error' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  // A publication whose answer never arrives may still have reached the server, so it reports
  // unproved completion instead of an internal failure.
  let response: Response;
  try {
    response = await fetch(connection.baseUrl + path, init);
  } catch (err) {
    throw new ServerError(lostAnswerExit, `cannot reach the server: ${errorMessage(err)}`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new ServerError(lostAnswerExit, `lost the server response: ${errorMessage(err)}`);
  }
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const body = parsed as { code?: unknown; error?: unknown } | null;
    const code = typeof body?.code === 'string' ? body.code : `http-${response.status}`;
    const detail = typeof body?.error === 'string' ? body.error : 'request failed';
    throw new ServerError(exitForStatus(response.status), `${code}: ${detail}`);
  }
  if (parsed === null) {
    throw new ServerError(lostAnswerExit, 'the server returned an unreadable response');
  }
  return parsed;
}

function isReleaseJob(value: unknown): value is ReleaseJob {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { jobId?: unknown }).jobId === 'string' &&
    typeof (value as { state?: unknown }).state === 'string'
  );
}

function isReleasePlan(value: unknown): value is ReleasePlan {
  const plan = value as { planId?: unknown; digest?: unknown; payload?: unknown } | null;
  return (
    typeof plan?.planId === 'string' &&
    typeof plan.digest === 'string' &&
    typeof plan.payload === 'object' &&
    plan.payload !== null
  );
}

async function getPlan(connection: Connection, planId: string): Promise<ReleasePlan> {
  const plan = await call(connection, 'GET', `/api/releases/plans/${encodeURIComponent(planId)}`);
  if (!isReleasePlan(plan)) {
    throw new ServerError(RELEASE_EXIT.internal, 'the server did not return a release plan');
  }
  return plan;
}

async function getJob(connection: Connection, jobId: string): Promise<ReleaseJob> {
  const job = await call(connection, 'GET', `/api/releases/jobs/${encodeURIComponent(jobId)}`);
  if (!isReleaseJob(job)) {
    throw new ServerError(RELEASE_EXIT.internal, 'the server did not return a release job');
  }
  return job;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function tagState(tag: ReleaseTagObservation): string {
  const parts: string[] = [tag.state];
  if (tag.name !== '') parts.push(tag.name);
  if (tag.commit !== null) parts.push(`commit ${tag.commit}`);
  if (tag.objectId !== null) parts.push(`object ${tag.objectId}`);
  if (tag.tagger !== null) parts.push(`tagger ${tag.tagger.name} <${tag.tagger.email}>`);
  return parts.join(' · ');
}

function releaseState(release: ReleaseObservation): string {
  const parts: string[] = [release.state];
  if (release.tag !== null) parts.push(`tag ${release.tag}`);
  if (release.title !== null) parts.push(`title ${release.title}`);
  if (release.notesDigest !== null) parts.push(`notes ${release.notesDigest}`);
  if (release.draft !== null) parts.push(`draft ${release.draft}`);
  if (release.prerelease !== null) parts.push(`prerelease ${release.prerelease}`);
  if (release.author !== null) parts.push(`author ${release.author}`);
  if (release.assets !== null) parts.push(`assets ${release.assets}`);
  return parts.join(' · ');
}

function describeWarnings(warnings: { code: string; message: string }[]): string {
  return warnings.length === 0
    ? 'none'
    : warnings.map((warning) => `${warning.code}: ${warning.message}`).join('; ');
}

/** The whole reviewed plan as text: every approval-relevant fact and the complete notes. */
export function renderPlan(plan: ReleasePlan): string {
  const payload = plan.payload;
  const lines = [
    `Plan ${plan.planId} · digest ${plan.digest}`,
    `Repository: ${payload.repository.owner}/${payload.repository.repo} on ${payload.repository.baseUrl} (configured id ${payload.repository.repositoryId}, forge id ${payload.repository.forgeRepositoryId})`,
    `Default branch: ${payload.repository.defaultBranch}`,
    `Candidate: ${payload.candidate.commit} on ${payload.candidate.branch}`,
    `Baseline: ${payload.baseline.tag ?? 'none'}${payload.baseline.commit === null ? '' : ` (${payload.baseline.commit})`} · ${payload.baseline.stableTags.length} stable tags observed`,
    `Version: ${payload.tagName}`,
    `Title: ${payload.title}`,
    `CI: ${payload.ci.workflowPath} run ${payload.ci.runId} · ${payload.ci.event} ${payload.ci.status}/${payload.ci.conclusion} at ${payload.ci.headCommit}`,
    `API account: ${payload.account.login} on ${payload.account.baseUrl} (forge user id ${payload.account.forgeUserId})`,
    `Tagger: ${payload.tagger.name} <${payload.tagger.email}>`,
    `Intended changes: ${payload.actions.length === 0 ? 'none' : payload.actions.map((action) => `${action.kind} ${action.tag}`).join(', ')}`,
    `Tag now: ${tagState(payload.tag)}`,
    `Release now: ${releaseState(payload.release)}`,
    `Warnings: ${describeWarnings(payload.warnings)}`,
    `Blockers: ${describeWarnings(payload.blockers ?? [])}`,
    `Deadline: ${plan.approvalDeadline}${plan.preparedAt === undefined ? '' : ` · prepared ${plan.preparedAt}`}`,
  ];
  if (payload.recovery !== undefined) {
    lines.push(
      `Recovery: job ${payload.recovery.jobId} · default-branch head ${payload.recovery.defaultBranchHead} · tag created ${payload.recovery.tagCreatedAt}`,
    );
  }
  lines.push(
    '',
    `Notes (${payload.notes.source}, sha256 ${payload.notes.digest}):`,
    payload.notes.text,
  );
  return lines.join('\n');
}

export function renderJob(job: ReleaseJob): string {
  const lines = [
    `Job ${job.jobId} · ${job.kind} · ${job.state}${job.step === null ? '' : ` · step ${job.step}`}`,
    `Remote: tag ${job.remote.tag} · release ${job.remote.release}`,
    `Plan: ${job.planId ?? 'none'} · digest ${job.planDigest ?? 'none'}`,
  ];
  if (job.errorCode !== null) lines.push(`Error: ${job.errorCode}`);
  if (job.blocker !== undefined) lines.push(`Blocker: ${job.blocker.code}: ${job.blocker.message}`);
  if (job.attemptedEffects !== undefined && job.attemptedEffects.length > 0) {
    lines.push(
      `Attempted: ${job.attemptedEffects.map((effect) => `${effect.kind} ${effect.tag}`).join(', ')}`,
    );
  }
  if (job.reconciliationJobId !== undefined) {
    lines.push(`Reconciliation job: ${job.reconciliationJobId}`);
  }
  return lines.join('\n');
}

function isTerminal(state: ReleaseJob['state']): boolean {
  return (
    state === 'complete' ||
    state === 'blocked' ||
    state === 'needs-inspection' ||
    state === 'internal-error'
  );
}

function exitForJob(job: ReleaseJob): number {
  switch (job.state) {
    case 'blocked':
      return RELEASE_EXIT.blocked;
    case 'needs-inspection':
      return RELEASE_EXIT.unproved;
    case 'internal-error':
      return RELEASE_EXIT.internal;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function printJson(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value, null, 2) + '\n');
}

/** Report an accepted job: never call an accepted job published. */
function acceptedJobId(reply: unknown): string {
  const jobId = (reply as { jobId?: unknown } | null)?.jobId;
  if (typeof jobId !== 'string' || jobId === '') {
    throw new ServerError(RELEASE_EXIT.internal, 'the server did not return a job id');
  }
  return jobId;
}

function reportAccepted(io: CliIo, jobId: string): void {
  io.stdout(`accepted job ${jobId}\nTrack it with: releases status ${jobId}\n`);
}

async function waitForJob(
  connection: Connection,
  jobId: string,
  opts: ReleaseOptions,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const interval = deps.releasePollMs ?? 1000;
  let last = '';
  // shortcut: --wait follows the job until it is terminal with no deadline of its own; add one
  // if a stuck server job becomes possible.
  for (;;) {
    const job = await getJob(connection, jobId);
    if (isTerminal(job.state)) {
      if (opts.json === true) printJson(io, job);
      else io.stdout(renderJob(job) + '\n');
      return exitForJob(job);
    }
    const progress = `${job.state}${job.step === null ? '' : ` · ${job.step}`}`;
    if (progress !== last) {
      io.stderr(`job ${job.jobId}: ${progress}\n`);
      last = progress;
    }
    await sleep(interval);
  }
}

async function afterSubmit(
  connection: Connection,
  reply: unknown,
  opts: ReleaseOptions,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const jobId = acceptedJobId(reply);
  // One JSON document per command: a waiting command reports only the final job.
  if (opts.wait === true) {
    if (opts.json !== true) reportAccepted(io, jobId);
    return await waitForJob(connection, jobId, opts, io, deps);
  }
  if (opts.json === true) printJson(io, reply);
  else reportAccepted(io, jobId);
  return 0;
}

async function publish(
  connection: Connection,
  planId: string,
  opts: ReleaseOptions,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const plan = await getPlan(connection, planId);
  // The plan is the human review affordance; --json prints only the server response.
  if (opts.json !== true) io.stdout(renderPlan(plan) + '\n');

  if (opts.approve !== undefined) {
    if (opts.approve !== plan.digest) {
      throw new InvocationError(
        `--approve ${opts.approve} is not the digest of plan ${plan.planId} (${plan.digest}); review the plan again`,
      );
    }
  } else if (deps.confirm === undefined) {
    throw new InvocationError(
      'non-interactive publication needs --approve <digest>; it was not submitted',
    );
  } else {
    const approved = await deps.confirm(
      `Publish ${plan.payload.repository.owner}/${plan.payload.repository.repo} ${plan.payload.tagName} (digest ${plan.digest})? [y/N] `,
    );
    if (!approved) throw new InvocationError('cancelled before submission');
  }

  const reply = await call(
    connection,
    'POST',
    `/api/releases/plans/${encodeURIComponent(planId)}/publish`,
    { digest: plan.digest },
    RELEASE_EXIT.unproved,
  );
  return await afterSubmit(connection, reply, opts, io, deps);
}

async function runRelease(
  command: 'prepare' | 'plan' | 'publish' | 'status' | 'reconcile',
  id: string,
  cmd: Command,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const opts = cmd.optsWithGlobals<ReleaseOptions>();
  try {
    const connection = connectionFor(opts, io);
    switch (command) {
      case 'prepare': {
        const reply = await call(
          connection,
          'POST',
          `/api/releases/repositories/${encodeURIComponent(id)}/prepare`,
        );
        return await afterSubmit(connection, reply, opts, io, deps);
      }
      case 'plan': {
        const plan = await getPlan(connection, id);
        if (opts.json === true) printJson(io, plan);
        else io.stdout(renderPlan(plan) + '\n');
        return 0;
      }
      case 'publish':
        return await publish(connection, id, opts, io, deps);
      case 'status': {
        if (opts.wait === true) return await waitForJob(connection, id, opts, io, deps);
        const job = await getJob(connection, id);
        if (opts.json === true) printJson(io, job);
        else io.stdout(renderJob(job) + '\n');
        return exitForJob(job);
      }
      case 'reconcile': {
        const reply = await call(
          connection,
          'POST',
          `/api/releases/jobs/${encodeURIComponent(id)}/reconcile`,
        );
        return await afterSubmit(connection, reply, opts, io, deps);
      }
    }
  } catch (err) {
    if (err instanceof InvocationError) {
      io.stderr(`${err.message}\n`);
      return RELEASE_EXIT.cancelled;
    }
    if (err instanceof ServerError) {
      io.stderr(`${err.message}\n`);
      return err.exitCode;
    }
    io.stderr(`Error: ${errorMessage(err)}\n`);
    return RELEASE_EXIT.internal;
  }
}

/** Register `releases` and its commands on the CLI program. */
export function addReleaseCommands(
  program: Command,
  io: CliIo,
  deps: CliDeps,
  setExit: (code: number) => void,
): void {
  const releases = program
    .command('releases')
    .description('drive the running server\u2019s release workflow');

  // Release user errors are invalid invocations (2); planning keeps its own codes.
  releases.exitOverride((err: CommanderError): never => {
    if (err.exitCode !== 0) err.exitCode = RELEASE_EXIT.cancelled;
    throw err;
  });

  // Every release command names its own server and authentication material, so a caller cannot
  // fall back to a planning config, the release state directory or the forge token.
  const connectionOptions = (command: Command): Command =>
    command
      .option('--server <url>', 'base URL of the running server')
      .option('--auth-env <name>', 'environment variable holding "username:password"')
      .option('--auth-file <path>', 'private file (mode 0600) holding "username:password"')
      .option('--json', 'print the server response as JSON');

  const action =
    (command: 'prepare' | 'plan' | 'publish' | 'status' | 'reconcile') =>
    async (id: string, _opts: unknown, cmd: Command): Promise<void> => {
      setExit(await runRelease(command, id, cmd, io, deps));
    };

  connectionOptions(
    releases
      .command('prepare')
      .description('start or reuse preparation of one release repository')
      .argument('<repositoryId>', 'configured release-repository id')
      .option('--wait', 'wait for the job and report its result'),
  ).action(action('prepare'));

  connectionOptions(
    releases.command('plan').description('print one release plan').argument('<planId>', 'plan id'),
  ).action(action('plan'));

  connectionOptions(
    releases
      .command('publish')
      .description('publish one reviewed release plan')
      .argument('<planId>', 'plan id')
      .addOption(
        new Option(
          '--approve <digest>',
          'reviewed plan digest; approves without asking (required when not interactive)',
        ),
      )
      .option('--wait', 'wait for the job and report its result'),
  ).action(action('publish'));

  connectionOptions(
    releases
      .command('status')
      .description('print one release job')
      .argument('<jobId>', 'job id')
      .option('--wait', 'wait for the job and report its final result'),
  ).action(action('status'));

  connectionOptions(
    releases
      .command('reconcile')
      .description('start or reuse a read-only reconciliation job')
      .argument('<jobId>', 'publication job id')
      .option('--wait', 'wait for the job and report its result'),
  ).action(action('reconcile'));
}
