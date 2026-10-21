/**
 * Release CI evidence: the designated Gitea Actions push run for the exact candidate.
 *
 * Preparation may bind only one completed, successful `push` run of the configured workflow for
 * the verified repository, default branch and candidate commit. Discovery enumerates every run
 * the forge reports for that commit under a bounded page count, accepts only runs that prove all
 * of those identities, and selects the highest numeric qualifying run id. The same fields are
 * read again through one direct request, so publication can prove the bound run still qualifies.
 *
 * Every request here is a read through the release forge client: no run is triggered, no write
 * path exists, and nothing is retried. A mismatch, outage or malformed response becomes a stable
 * blocker; there is no manual attestation and no "any successful workflow" fallback.
 *
 * The run fields below are what the supported Gitea 1.26.1 API returns: `ToActionWorkflowRun`
 * reports GitHub-style `status`/`conclusion` (from `ToActionsStatus`), `path` as
 * `<WorkflowID>@<Ref>` where `WorkflowID` is the path inside the server's workflow directory,
 * and the run's repository object; the run list filters by `head_sha`. Because that identifier
 * omits the workflow directory, provenance is proved from two read-only observations: the
 * server's workflow list (the full path of each workflow it runs) and the candidate's own
 * committed tree. The candidate must contain exactly one supported workflow directory, so which
 * directory its runs used follows from the tree itself rather than from an assumed server order.
 */

import { workflowPathProblem } from '../config/schema.js';
import type { ReleaseEntry } from './checkout.js';
import type {
  ReleaseCandidate,
  ReleaseCiEvidence,
  ReleaseRepositoryIdentity,
} from '../core/release.js';
import {
  ReleaseForgeError,
  forgeOriginKey,
  type ReleaseBlockerCode,
  type ReleaseForgeClient,
} from './forgeClient.js';
import type { ReleaseGitResult } from './gitProcess.js';

/** A stable machine-readable reason the designated CI evidence could not be proved. */
export type ReleaseCiBlockerCode =
  | ReleaseBlockerCode
  | 'ci-workflow-invalid'
  | 'ci-run-missing'
  | 'ci-run-pending'
  | 'ci-run-failed'
  | 'ci-workflow-mismatch'
  | 'ci-event-mismatch'
  | 'ci-branch-mismatch'
  | 'ci-commit-mismatch'
  | 'ci-discovery-incomplete'
  | 'ci-evidence-too-large'
  | 'ci-evidence-conflict'
  | 'ci-evidence-changed'
  | 'ci-tree-unavailable';

/** Why the designated CI evidence is unusable. Safe to log, return or persist. */
export interface ReleaseCiBlocker {
  code: ReleaseCiBlockerCode;
  /** Redacted, bounded English text. Never contains a token or unbounded forge content. */
  message: string;
}

/** CI evidence is proved or blocked; a blocked result is never a substitute run. */
export type ReleaseCiResult =
  { ok: true; evidence: ReleaseCiEvidence } | { ok: false; blocker: ReleaseCiBlocker };

/** Runs requested per page; also the largest page Gitea serves, so a larger request is refused. */
export const DEFAULT_CI_PAGE_SIZE = 50;

/** Gitea's own maximum page size; asking for more would silently skip runs between pages. */
export const MAX_CI_PAGE_SIZE = 50;

/** Hard ceiling for the page bound, so no caller can turn bounded pagination unbounded. */
export const MAX_CI_MAX_PAGES = 100;

/** Hard ceiling for the run bound, so a huge bound cannot outgrow the response budget. */
export const MAX_CI_MAX_RUNS = 5_000;

/** Most run-list pages one discovery may read before it fails closed as incomplete. */
export const DEFAULT_CI_MAX_PAGES = 20;

/** Most runs one discovery may enumerate before the evidence set is too large to trust. */
export const DEFAULT_CI_MAX_RUNS = 500;

/**
 * Reads one committed entry at the candidate commit from the container-owned checkout. It is how
 * workflow provenance is bound to the exact tree the run was made for.
 */
export type ReleaseCiTreeReader = (path: string) => Promise<ReleaseGitResult<ReleaseEntry | null>>;

export interface DiscoverReleaseCiOptions {
  /** Release forge client for the verified forge; only a read-capable client is accepted. */
  client: ReleaseForgeClient;
  /** Repository identity already proved by `verifyReleaseIdentity`. */
  identity: ReleaseRepositoryIdentity;
  /** Exact candidate commit and branch selected by the container-owned checkout. */
  candidate: ReleaseCandidate;
  /** Configured designated workflow path from `releases.repositories[].ci.workflowPath`. */
  workflowPath: string;
  /** Reads a committed entry at the candidate commit; binds provenance to that exact tree. */
  readEntry: ReleaseCiTreeReader;
  pageSize?: number;
  maxPages?: number;
  maxRuns?: number;
}

export interface VerifyReleaseCiOptions {
  /** The same read-only release forge client used for discovery. */
  client: ReleaseForgeClient;
  /** Repository identity already proved by `verifyReleaseIdentity`. */
  identity: ReleaseRepositoryIdentity;
  /** Configured designated workflow path the evidence was bound to. */
  workflowPath: string;
  /** Reads a committed entry at the evidence's candidate commit. */
  readEntry: ReleaseCiTreeReader;
  /** Evidence bound into an approved plan; read again, never rewritten. */
  evidence: ReleaseCiEvidence;
}

class CiEvidenceError extends Error {
  readonly code: ReleaseCiBlockerCode;

  constructor(code: ReleaseCiBlockerCode, message: string) {
    super(message);
    this.name = 'CiEvidenceError';
    this.code = code;
  }
}

const COMMIT_ID = /^[0-9a-f]{40}$/;

/** A run the forge returned, reduced to the fields that decide qualification and freshness. */
interface ParsedRun {
  id: number;
  headCommit: string;
  branch: string;
  event: string;
  status: string;
  conclusion: string;
  path: string;
  repositoryId: number;
  repositoryFullName: string;
}

/** The identities one run must prove to become the designated evidence. */
interface ExpectedRun {
  forgeRepositoryId: number;
  slug: string;
  commit: string;
  branch: string;
  workflowPath: string;
}

/** One workflow the server reports for the default branch, by identifier and full repository path. */
interface ParsedWorkflow {
  id: string;
  path: string;
}

/**
 * The workflow directories this release target supports. Gitea's own configured order decides
 * which one it runs when a commit contains several, and that order is not observable through the
 * release API, so a candidate containing more than one of these is ambiguous and blocks.
 */
const GITEA_WORKFLOW_DIRECTORIES: readonly string[] = ['.gitea/workflows', '.github/workflows'];

/** The bounded enumeration limits one discovery resolved from its options. */
interface RunBounds {
  pageSize: number;
  maxPages: number;
  maxRuns: number;
}

/** A way a listed run fails to qualify. */
type Rejection = 'commit' | 'branch' | 'event' | 'workflow' | 'pending' | 'failed';

/** Most actionable first: a pending designated run can still become the evidence. */
const REJECTION_ORDER: readonly Rejection[] = [
  'pending',
  'failed',
  'workflow',
  'event',
  'branch',
  'commit',
];

const REJECTION_TEXT: Record<Rejection, string> = {
  pending: 'was still running',
  failed: 'did not succeed',
  workflow: 'ran another workflow',
  event: 'was not a push run',
  branch: 'ran on another branch',
  commit: 'was for another commit',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounds and neutralizes a value echoed in a diagnostic or persisted blocker. */
function bounded(value: string, maxLength = 64): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '?');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

function malformed(detail: string): CiEvidenceError {
  return new CiEvidenceError('malformed-response', `release CI evidence: ${detail}`);
}

/**
 * A field read from the forge is used as exact evidence. A padded, empty, oversized or
 * control-character value could name something other than what the run actually did, so it
 * blocks rather than being trimmed into a plausible value.
 */
function textField(raw: unknown, field: string, maxLength: number, allowEmpty = false): string {
  if (typeof raw !== 'string') throw malformed(`${field} was not a string`);
  if (raw === '' && !allowEmpty) throw malformed(`${field} was empty`);
  if (raw.trim() !== raw) throw malformed(`${field} was padded with whitespace`);
  if (/[\x00-\x1f\x7f]/.test(raw)) throw malformed(`${field} contained control characters`);
  if (raw.length > maxLength) throw malformed(`${field} was longer than ${maxLength} characters`);
  return raw;
}

function wholeNumber(raw: unknown, field: string, minimum: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum) {
    throw malformed(`${field} was not a whole number of at least ${minimum}`);
  }
  return raw;
}

/**
 * One run as Gitea reports it. A run without a repository identity cannot prove which repository
 * it belongs to, and a malformed entry blocks the whole discovery: a partially understood run
 * list is not evidence of absence for the missing runs.
 */
function parseRun(raw: unknown, field: string): ParsedRun {
  if (!isRecord(raw)) throw malformed(`${field} was not a JSON object`);
  const repository = raw['repository'];
  if (!isRecord(repository)) throw malformed(`${field}.repository was not a JSON object`);
  return {
    id: wholeNumber(raw['id'], `${field}.id`, 1),
    headCommit: textField(raw['head_sha'], `${field}.head_sha`, 64),
    branch: textField(raw['head_branch'], `${field}.head_branch`, 200),
    event: textField(raw['event'], `${field}.event`, 64),
    status: textField(raw['status'], `${field}.status`, 64),
    // An unfinished run reports an empty conclusion, so only the terminal check interprets it.
    conclusion: textField(raw['conclusion'], `${field}.conclusion`, 64, true),
    path: textField(raw['path'], `${field}.path`, 300),
    repositoryId: wholeNumber(repository['id'], `${field}.repository.id`, 1),
    repositoryFullName: textField(repository['full_name'], `${field}.repository.full_name`, 200),
  };
}

interface RunPage {
  totalCount: number;
  runs: ParsedRun[];
}

function parseRunPage(raw: unknown, field: string, pageSize: number): RunPage {
  if (!isRecord(raw)) throw malformed(`${field} did not return a JSON object`);
  const totalCount = wholeNumber(raw['total_count'], `${field}.total_count`, 0);
  const runs = raw['workflow_runs'];
  if (!Array.isArray(runs)) throw malformed(`${field}.workflow_runs was not a list`);
  if (runs.length > pageSize) {
    throw malformed(
      `${field} returned ${runs.length} runs, above the requested ${pageSize}-run page size`,
    );
  }
  return {
    totalCount,
    runs: runs.map((entry, index) => parseRun(entry, `${field}.workflow_runs[${index}]`)),
  };
}

function repositoryPath(identity: ReleaseRepositoryIdentity): string {
  return `/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}`;
}

/**
 * The list is narrowed server-side to the exact candidate commit; filtering only by commit keeps
 * pending, failed and wrong-workflow runs visible, so a blocker can name what the forge did
 * return. Every field is re-checked locally, so a forge that ignores the filter cannot become
 * evidence.
 */
function runsPath(
  identity: ReleaseRepositoryIdentity,
  commit: string,
  page: number,
  limit: number,
): string {
  const query = new URLSearchParams({
    head_sha: commit,
    page: String(page),
    limit: String(limit),
  });
  return `${repositoryPath(identity)}/actions/runs?${query.toString()}`;
}

function resolveBounds(options: DiscoverReleaseCiOptions): RunBounds {
  return {
    pageSize: boundedOption(options.pageSize, DEFAULT_CI_PAGE_SIZE, 'pageSize', MAX_CI_PAGE_SIZE),
    maxPages: boundedOption(options.maxPages, DEFAULT_CI_MAX_PAGES, 'maxPages', MAX_CI_MAX_PAGES),
    maxRuns: boundedOption(options.maxRuns, DEFAULT_CI_MAX_RUNS, 'maxRuns', MAX_CI_MAX_RUNS),
  };
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum?: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new CiEvidenceError('invalid-request', `${field} must be a positive whole number`);
  }
  if (maximum !== undefined && resolved > maximum) {
    throw new CiEvidenceError('invalid-request', `${field} must not exceed ${maximum}`);
  }
  return resolved;
}

/**
 * Evidence must be read from the forge origin whose repository identity was verified: the same
 * slug can exist on another instance, so a client pointed elsewhere would prove the wrong runs.
 */
function assertVerifiedClient(
  client: ReleaseForgeClient,
  identity: ReleaseRepositoryIdentity,
): void {
  if (forgeOriginKey(client.baseUrl) !== forgeOriginKey(identity.baseUrl)) {
    throw new CiEvidenceError(
      'invalid-request',
      'release CI evidence must be read through the client for the verified release forge origin',
    );
  }
}

function expectedRun(
  identity: ReleaseRepositoryIdentity,
  candidate: ReleaseCandidate,
  workflowPath: string,
): ExpectedRun {
  const problem = workflowPathProblem(workflowPath);
  if (problem !== null) {
    throw new CiEvidenceError(
      'ci-workflow-invalid',
      `releases.repositories[${bounded(identity.repositoryId)}].ci.workflowPath cannot designate a release CI workflow: ${problem}`,
    );
  }
  if (!COMMIT_ID.test(candidate.commit)) {
    throw new CiEvidenceError(
      'invalid-request',
      `release CI evidence needs a full candidate commit id, got "${bounded(candidate.commit)}"`,
    );
  }
  if (candidate.branch !== identity.defaultBranch) {
    throw new CiEvidenceError(
      'ci-branch-mismatch',
      `the selected candidate is on a branch that is not the verified default branch`,
    );
  }
  return {
    forgeRepositoryId: identity.forgeRepositoryId,
    slug: `${identity.owner}/${identity.repo}`,
    commit: candidate.commit,
    branch: identity.defaultBranch,
    workflowPath,
  };
}

function parseWorkflowList(raw: unknown, field: string): ParsedWorkflow[] {
  if (!isRecord(raw)) throw malformed(`${field} did not return a JSON object`);
  const workflows = raw['workflows'];
  if (!Array.isArray(workflows)) throw malformed(`${field}.workflows was not a list`);
  return workflows.map((entry, index) => {
    if (!isRecord(entry)) throw malformed(`${field}.workflows[${index}] was not a JSON object`);
    return {
      id: textField(entry['id'], `${field}.workflows[${index}].id`, 300),
      path: textField(entry['path'], `${field}.workflows[${index}].path`, 300),
    };
  });
}

/**
 * Binds the configured workflow path to the identifier a run reports, for the exact candidate.
 *
 * A run's `path` names only the workflow inside the server's workflow directory, so the same file
 * name in another directory is a different workflow. Two read-only observations decide which
 * directory the identifier means for this candidate: the server's workflow list, which reports
 * every workflow it runs by full repository path at the current default-branch head, and the
 * candidate's own committed tree, which shows the workflow directory that commit contains.
 * Gitea runs only the first workflow directory a commit contains, so the candidate's tree picks
 * the directory; the configured path must sit inside it and be one the server reports, and the
 * identifier both observations imply must agree. A configured file the server does not run, or a
 * branch that moved since the candidate, therefore blocks instead of matching a same-named
 * workflow from another directory or from a different tree.
 */
async function resolveWorkflowIdentifier(
  client: ReleaseForgeClient,
  identity: ReleaseRepositoryIdentity,
  workflowPath: string,
  readEntry: ReleaseCiTreeReader,
): Promise<string> {
  const path = `${repositoryPath(identity)}/actions/workflows`;
  let raw: unknown;
  try {
    raw = await client.getJson<unknown>(path);
  } catch (err) {
    if (err instanceof ReleaseForgeError && err.status === 404) {
      throw new CiEvidenceError(
        'ci-workflow-mismatch',
        `the forge does not expose its workflow list for "${bounded(identity.owner)}/${bounded(identity.repo)}" (status 404), so the designated workflow cannot be proved`,
      );
    }
    throw err;
  }
  const workflows = parseWorkflowList(raw, `GET ${path}`);
  const matching = workflows.filter((workflow) => workflow.path === workflowPath);
  if (matching.length === 0) {
    throw new CiEvidenceError(
      'ci-workflow-mismatch',
      `the forge does not run ${bounded(workflowPath, 120)} on the default branch (it reports ${workflows.length} other workflow(s)), so the designated workflow cannot be proved`,
    );
  }
  if (matching.length > 1) {
    throw new CiEvidenceError(
      'ci-evidence-conflict',
      `the forge listed ${bounded(workflowPath, 120)} more than once, so the designated workflow is ambiguous`,
    );
  }
  const serverId = matching[0]!.id;

  // The candidate's own tree decides which workflow directory its runs used. Reading it here, at
  // this commit, is what keeps a branch that moved from relabelling an older run; a commit with
  // several workflow directories is left to the server's unobservable order, so it blocks.
  const present: string[] = [];
  for (const directory of GITEA_WORKFLOW_DIRECTORIES) {
    let entry: ReleaseGitResult<ReleaseEntry | null>;
    try {
      entry = await readEntry(directory);
    } catch {
      throw new CiEvidenceError(
        'ci-tree-unavailable',
        `the candidate's committed workflow entries could not be read, so the designated workflow cannot be proved`,
      );
    }
    if (!entry.ok) {
      throw new CiEvidenceError(
        'ci-tree-unavailable',
        `the candidate's committed workflow entries could not be read, so the designated workflow cannot be proved`,
      );
    }
    if (entry.value !== null && entry.value.type === 'tree') present.push(directory);
  }
  if (present.length === 0) {
    throw new CiEvidenceError(
      'ci-workflow-mismatch',
      `the candidate contains none of the supported workflow directories, so ${bounded(workflowPath, 120)} cannot be proved`,
    );
  }
  if (present.length > 1) {
    throw new CiEvidenceError(
      'ci-workflow-mismatch',
      `the candidate contains more than one workflow directory, so which one the server runs for ${bounded(workflowPath, 120)} cannot be proved`,
    );
  }
  const activeDirectory = present[0]!;
  if (!workflowPath.startsWith(`${activeDirectory}/`)) {
    throw new CiEvidenceError(
      'ci-workflow-mismatch',
      `the candidate's workflow directory is ${activeDirectory}, so ${bounded(workflowPath, 120)} is not the workflow a run of this candidate reports`,
    );
  }
  const candidateId = workflowPath.slice(activeDirectory.length + 1);
  if (candidateId !== serverId) {
    throw new CiEvidenceError(
      'ci-evidence-conflict',
      `the forge reports a different identifier for ${bounded(workflowPath, 120)} than the candidate's workflow directory implies, so the designated workflow is ambiguous`,
    );
  }
  return serverId;
}

/**
 * Decides one run against the expected identities. The order is deliberate: a run for another
 * commit, branch or event is reported before its workflow path, and a run that proves every
 * identity but is unfinished is reported as pending rather than as a missing success.
 */
function classifyRun(
  run: ParsedRun,
  expected: ExpectedRun,
  workflowId: string,
): ReleaseCiEvidence | Rejection {
  if (
    run.repositoryId !== expected.forgeRepositoryId ||
    run.repositoryFullName.toLowerCase() !== expected.slug.toLowerCase()
  ) {
    throw new CiEvidenceError(
      'repository-mismatch',
      `a CI run names a different repository or numeric id than the verified "${bounded(expected.slug)}"`,
    );
  }
  if (run.headCommit !== expected.commit) return 'commit';
  if (run.branch !== expected.branch) return 'branch';
  if (run.event !== 'push') return 'event';
  if (run.path !== `${workflowId}@refs/heads/${expected.branch}`) return 'workflow';
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion !== 'success') return 'failed';
  return {
    workflowPath: expected.workflowPath,
    runId: run.id,
    headCommit: expected.commit,
    branch: expected.branch,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  };
}

function rejectionCode(rejection: Rejection): ReleaseCiBlockerCode {
  switch (rejection) {
    case 'pending':
      return 'ci-run-pending';
    case 'failed':
      return 'ci-run-failed';
    case 'workflow':
      return 'ci-workflow-mismatch';
    case 'event':
      return 'ci-event-mismatch';
    case 'branch':
      return 'ci-branch-mismatch';
    case 'commit':
      return 'ci-commit-mismatch';
  }
}

function noQualifyingRun(
  counts: ReadonlyMap<Rejection, number>,
  expected: ExpectedRun,
  workflowId: string,
  listedRuns: number,
): CiEvidenceError {
  // Messages carry only configuration-derived values, validated commit ids and counts: a forge
  // field is never echoed, because a hostile or broken server can return any text in it.
  const where = `a completed successful push run of ${bounded(expected.workflowPath, 120)} for commit ${expected.commit} on the verified default branch`;
  if (listedRuns === 0) {
    return new CiEvidenceError(
      'ci-run-missing',
      `the forge lists no run for the candidate commit; release preparation needs ${where}`,
    );
  }
  const reason = REJECTION_ORDER.find((rejection) => counts.has(rejection));
  const observed = REJECTION_ORDER.filter((rejection) => counts.has(rejection))
    .map((rejection) => `${counts.get(rejection)} ${REJECTION_TEXT[rejection]}`)
    .join(', ');
  if (reason === undefined) {
    return new CiEvidenceError('ci-run-missing', `the forge lists no ${where}`);
  }
  return new CiEvidenceError(rejectionCode(reason), `the forge lists no ${where}: ${observed}`);
}

/**
 * Reads every run page for the candidate within the configured bounds. The reported total must
 * be covered exactly; a short page, a repeated run, a changed total or an exhausted page budget
 * fails closed instead of treating an unseen page as absence.
 */
async function enumerateRuns(
  options: DiscoverReleaseCiOptions,
  expected: ExpectedRun,
  bounds: RunBounds,
): Promise<ParsedRun[]> {
  const { pageSize, maxPages, maxRuns } = bounds;
  const seen = new Map<number, ParsedRun>();
  let totalCount: number | null = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const path = runsPath(options.identity, expected.commit, page, pageSize);
    let raw: unknown;
    try {
      raw = await options.client.getJson<unknown>(path);
    } catch (err) {
      if (err instanceof ReleaseForgeError && err.status === 404) {
        throw new CiEvidenceError(
          'ci-run-missing',
          `the forge does not expose a run list for ${bounded(expected.slug)} (status 404), so no CI evidence can be proved`,
        );
      }
      throw err;
    }
    const parsed = parseRunPage(raw, `GET ${path.split('?')[0]}`, pageSize);
    if (totalCount === null) {
      totalCount = parsed.totalCount;
      if (totalCount > maxRuns) {
        throw new CiEvidenceError(
          'ci-evidence-too-large',
          `the forge reports ${totalCount} runs for the candidate commit, above the ${maxRuns}-run bound; refusing to accept a partially read run list`,
        );
      }
    } else if (parsed.totalCount !== totalCount) {
      throw new CiEvidenceError(
        'ci-evidence-conflict',
        `the run list total changed from ${totalCount} to ${parsed.totalCount} between pages`,
      );
    }
    for (const run of parsed.runs) {
      if (seen.has(run.id)) {
        throw new CiEvidenceError(
          'ci-evidence-conflict',
          `the run list returned run id ${run.id} more than once`,
        );
      }
      seen.set(run.id, run);
    }
    if (seen.size > totalCount) {
      throw new CiEvidenceError(
        'ci-evidence-conflict',
        `the run list returned ${seen.size} runs but reported a total of ${totalCount}`,
      );
    }
    if (seen.size === totalCount) return [...seen.values()];
    if (parsed.runs.length === 0) {
      throw new CiEvidenceError(
        'ci-discovery-incomplete',
        `page ${page} of the run list was empty while only ${seen.size} of ${totalCount} reported runs were read`,
      );
    }
  }
  throw new CiEvidenceError(
    'ci-discovery-incomplete',
    `reading ${maxPages} pages did not cover the ${totalCount ?? 0} runs the forge reports for the candidate commit`,
  );
}

function sameEvidence(left: ReleaseCiEvidence, right: ReleaseCiEvidence): boolean {
  return (
    left.workflowPath === right.workflowPath &&
    left.runId === right.runId &&
    left.headCommit === right.headCommit &&
    left.branch === right.branch &&
    left.event === right.event &&
    left.status === right.status &&
    left.conclusion === right.conclusion
  );
}

function assertBoundEvidence(
  evidence: ReleaseCiEvidence,
  identity: ReleaseRepositoryIdentity,
  workflowPath: string,
): void {
  const changed = (detail: string): CiEvidenceError =>
    new CiEvidenceError(
      'ci-evidence-changed',
      `the bound CI evidence cannot prove a run: ${detail}`,
    );
  if (!Number.isSafeInteger(evidence.runId) || evidence.runId < 1) {
    throw changed('its run id is not a positive whole number');
  }
  if (!COMMIT_ID.test(evidence.headCommit)) throw changed('its commit is not a full commit id');
  if (evidence.branch !== identity.defaultBranch) {
    throw changed('its branch is not the verified default branch');
  }
  if (evidence.workflowPath !== workflowPath) {
    throw changed('its workflow is not the configured designated workflow');
  }
  if (
    evidence.event !== 'push' ||
    evidence.status !== 'completed' ||
    evidence.conclusion !== 'success'
  ) {
    throw changed('it is not a completed successful push run');
  }
}

function ciBlocker(err: unknown): ReleaseCiBlocker {
  if (err instanceof CiEvidenceError) return { code: err.code, message: err.message };
  // The release forge client already redacts its token from every message it produces.
  if (err instanceof ReleaseForgeError) return { code: err.code, message: err.message };
  return { code: 'internal-error', message: 'reading release CI evidence failed unexpectedly' };
}

/**
 * Discovers the designated CI evidence for one candidate. Pages are read until the reported
 * total is covered; among qualifying runs the highest numeric run id wins, and its complete
 * identity/result fields are returned for the plan.
 */
export async function discoverReleaseCi(
  options: DiscoverReleaseCiOptions,
): Promise<ReleaseCiResult> {
  try {
    const bounds = resolveBounds(options);
    assertVerifiedClient(options.client, options.identity);
    const expected = expectedRun(options.identity, options.candidate, options.workflowPath);
    const workflowId = await resolveWorkflowIdentifier(
      options.client,
      options.identity,
      options.workflowPath,
      options.readEntry,
    );
    const runs = await enumerateRuns(options, expected, bounds);
    const counts = new Map<Rejection, number>();
    let selected: ReleaseCiEvidence | null = null;
    for (const run of runs) {
      const outcome = classifyRun(run, expected, workflowId);
      if (typeof outcome === 'string') {
        counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
        continue;
      }
      if (selected === null || outcome.runId > selected.runId) selected = outcome;
    }
    if (selected === null) throw noQualifyingRun(counts, expected, workflowId, runs.length);
    return { ok: true, evidence: selected };
  } catch (err) {
    return { ok: false, blocker: ciBlocker(err) };
  }
}

/**
 * Reads the exact bound run again and proves it still qualifies for the same repository,
 * candidate, branch and workflow. Any drift, disappearance or unreadable run blocks; the
 * evidence is never rewritten to a newer qualifying run.
 */
export async function verifyReleaseCi(options: VerifyReleaseCiOptions): Promise<ReleaseCiResult> {
  try {
    assertVerifiedClient(options.client, options.identity);
    assertBoundEvidence(options.evidence, options.identity, options.workflowPath);
    const expected = expectedRun(
      options.identity,
      { commit: options.evidence.headCommit, branch: options.evidence.branch },
      options.workflowPath,
    );
    // Provenance is re-proved, not assumed: the designated path must still be a workflow the
    // server runs, so a same-named workflow in another directory can never satisfy the evidence.
    const workflowId = await resolveWorkflowIdentifier(
      options.client,
      options.identity,
      options.workflowPath,
      options.readEntry,
    );
    const path = `${repositoryPath(options.identity)}/actions/runs/${options.evidence.runId}`;
    let raw: unknown;
    try {
      raw = await options.client.getJson<unknown>(path);
    } catch (err) {
      if (err instanceof ReleaseForgeError && err.status === 404) {
        throw new CiEvidenceError(
          'ci-evidence-changed',
          `the bound CI run ${options.evidence.runId} is no longer readable (status 404), so its evidence is not current`,
        );
      }
      throw err;
    }
    const run = parseRun(raw, `GET ${path}`);
    const outcome = classifyRun(run, expected, workflowId);
    if (typeof outcome === 'string') {
      throw new CiEvidenceError(
        'ci-evidence-changed',
        `the bound CI run ${options.evidence.runId} no longer qualifies: it ${REJECTION_TEXT[outcome]}`,
      );
    }
    if (!sameEvidence(outcome, options.evidence)) {
      throw new CiEvidenceError(
        'ci-evidence-changed',
        `the bound CI run ${options.evidence.runId} no longer matches the evidence recorded in the plan`,
      );
    }
    return { ok: true, evidence: outcome };
  } catch (err) {
    return { ok: false, blocker: ciBlocker(err) };
  }
}
