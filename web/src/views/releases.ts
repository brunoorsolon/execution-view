import type { ReleaseJob, ReleaseJobState, ReleasePlan } from '../../../src/core/release.js';
import {
  ApiError,
  errorMessage,
  fetchReleaseRepositories,
  fetchReleaseJobs,
  fetchReleaseJob,
  fetchReleasePlan,
  fetchReleaseReceipt,
  prepareRelease,
  publishRelease,
  reconcileRelease,
  type ReleaseRepository,
} from '../api.js';
import { clear, h, type Child } from '../dom.js';
import { releaseHash, type ReleaseRoute } from '../release-route.js';

function field(label: string, value: Child): HTMLElement {
  return h('div', { class: 'release-field' }, h('dt', null, label), h('dd', null, value));
}

const TERMINAL: readonly ReleaseJobState[] = [
  'complete',
  'blocked',
  'needs-inspection',
  'internal-error',
];

function isTerminal(state: ReleaseJobState): boolean {
  return TERMINAL.includes(state);
}

/**
 * Why the Publish action is unavailable for this plan, or null when its digest may be
 * submitted. Mirrors the admission rules the reviewed plan already shows the operator.
 */
export function publishBlocker(plan: ReleasePlan, now = Date.now()): string | null {
  const p = plan.payload;
  if (Date.parse(plan.approvalDeadline) <= now) {
    return `the plan expired at ${plan.approvalDeadline}, so a fresh plan is needed`;
  }
  const blockers = p.blockers ?? [];
  if (blockers.length > 0) {
    return `blockers must be resolved first: ${blockers
      .map((blocker) => `${blocker.code}: ${blocker.message}`)
      .join('; ')}`;
  }
  if (
    !['absent', 'exact'].includes(p.tag.state) ||
    !['absent', 'exact'].includes(p.release.state) ||
    (p.tag.state === 'absent' && p.release.state === 'exact') ||
    p.tag.objectId === null
  ) {
    return 'the reviewed remote tag or release state does not allow publication, so a fresh plan is needed';
  }
  if (p.actions.length === 0) return 'this plan has no remaining changes to publish';
  return null;
}

interface ReviewHandlers {
  publish(plan: ReleasePlan, button: HTMLButtonElement): void;
  prepare(): void;
  /** Extra reason from an accepted job for this plan, added to the plan's own blockers. */
  attemptBlocker?(): string | null;
}

function review(plan: ReleasePlan, handlers: ReviewHandlers): HTMLElement {
  const p = plan.payload;
  const r = p.repository;
  // Construct links from the verified forge identity, never from notes or API-returned URLs.
  const base = new URL(r.baseUrl);
  const candidateUrl =
    ['https:', 'http:'].includes(base.protocol) && !base.username && !base.password
      ? `${r.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/commit/${encodeURIComponent(p.candidate.commit)}`
      : null;
  const blocker = publishBlocker(plan) ?? handlers.attemptBlocker?.() ?? null;
  const publishButton = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      disabled: blocker !== null,
      onclick: () => handlers.publish(plan, publishButton),
    },
    `Publish ${r.owner}/${r.repo} ${p.tagName}`,
  );
  return h(
    'section',
    { class: 'release-review', 'aria-label': 'Release plan' },
    h('h2', { tabindex: '-1' }, `Review ${p.tagName}`),
    h(
      'p',
      null,
      'Read-only review. Preparing or leaving this screen does not publish a tag or release.',
    ),
    h(
      'dl',
      { class: 'release-fields' },
      field('Forge', `${r.forge} · ${r.baseUrl}`),
      field(
        'Repository',
        `${r.owner}/${r.repo} · ID ${r.forgeRepositoryId} · configured as ${r.repositoryId}`,
      ),
      field('Default branch', r.defaultBranch),
      field(
        'Candidate',
        candidateUrl === null
          ? p.candidate.commit
          : h(
              'a',
              { href: candidateUrl, target: '_blank', rel: 'noopener noreferrer' },
              p.candidate.commit,
            ),
      ),
      field('Candidate branch', p.candidate.branch),
      field(
        'Baseline',
        p.baseline.tag === null
          ? 'None (first release)'
          : `${p.baseline.tag} · ${p.baseline.commit}`,
      ),
      field('Observed stable tags', p.baseline.stableTags.join(', ') || 'None'),
      field('Version', p.tagName),
      field('Title', p.title),
      field('CI run', `#${p.ci.runId} · ${p.ci.workflowPath}`),
      field(
        'CI result',
        `${p.ci.status} · ${p.ci.conclusion} · ${p.ci.event} · ${p.ci.branch} · ${p.ci.headCommit}`,
      ),
      field(
        'API account',
        `${p.account.login} · ID ${p.account.forgeUserId} · ${p.account.forge} · ${p.account.baseUrl}`,
      ),
      field('Configured tagger', `${p.tagger.name} <${p.tagger.email}>`),
      field(
        'Observed tagger',
        p.tag.tagger === null ? 'Not observed' : `${p.tag.tagger.name} <${p.tag.tagger.email}>`,
      ),
      field(
        'Tag state',
        `${p.tag.state} · ${p.tag.name} · commit ${p.tag.commit ?? 'not observed'} · object ${p.tag.objectId ?? 'not observed'}`,
      ),
      field(
        'Release state',
        `${p.release.state} · tag ${p.release.tag ?? 'not observed'} · title ${p.release.title ?? 'not observed'}`,
      ),
      field('Observed release author', p.release.author ?? 'Not observed'),
      field(
        'Observed release details',
        `draft: ${p.release.draft ?? 'unknown'} · prerelease: ${p.release.prerelease ?? 'unknown'} · assets: ${p.release.assets ?? 'unknown'} · notes digest: ${p.release.notesDigest ?? 'not observed'}`,
      ),
      field(
        'Intended changes',
        p.actions.length === 0
          ? 'None (no-op)'
          : h('ul', null, ...p.actions.map((a) => h('li', null, `${a.kind}: ${a.tag}`))),
      ),
      field(
        'Warnings',
        p.warnings.length === 0
          ? 'None'
          : h('ul', null, ...p.warnings.map((w) => h('li', null, `${w.code}: ${w.message}`))),
      ),
      field(
        'Blockers',
        (p.blockers?.length ?? 0) === 0
          ? 'None'
          : h('ul', null, ...p.blockers!.map((b) => h('li', null, `${b.code}: ${b.message}`))),
      ),
      ...(p.recovery === undefined
        ? []
        : [
            field(
              'Recovery of',
              `Publication ${p.recovery.jobId} · original candidate ${p.candidate.commit} · tag created at ${p.recovery.tagCreatedAt}`,
            ),
          ]),
      field('Approval deadline', plan.approvalDeadline),
      field('Prepared at', plan.preparedAt ?? 'Not recorded'),
      field('Plan ID', plan.planId),
      field('Plan digest', plan.digest),
      field('Notes source / digest', `${p.notes.source} · ${p.notes.digest}`),
    ),
    h('h3', null, 'Complete release notes'),
    h(
      'pre',
      { class: 'release-notes', tabindex: '0', 'aria-label': 'Complete release notes' },
      p.notes.text,
    ),
    h(
      'section',
      { class: 'release-approval', 'aria-label': 'Publish this plan' },
      h('h3', null, 'Publish'),
      h(
        'p',
        null,
        `Publish submits the digest above for ${r.owner}/${r.repo} ${p.tagName}. This creates the remote tag and release shown here. Closing or reloading the tab after acceptance does not cancel the job, and this browser has no Cancel control.`,
      ),
      ...(p.recovery === undefined
        ? []
        : [
            h(
              'p',
              null,
              'This recovery plan publishes only the original version, candidate and notes shown above. Approve its new digest explicitly; nothing missing is published automatically.',
            ),
          ]),
      ...(blocker === null
        ? []
        : [h('p', { class: 'release-blocked' }, `Publish unavailable: ${blocker}.`)]),
      h(
        'div',
        { class: 'release-actions' },
        publishButton,
        h(
          'button',
          { class: 'btn', type: 'button', onclick: () => handlers.prepare() },
          'Prepare a fresh plan',
        ),
      ),
    ),
  );
}

/** Owns preparation, approval submission and reads. Closing the view invalidates in-flight UI work. */
export function createReleasesView() {
  const heading = h('h1', { tabindex: '-1' }, 'Releases');
  const status = h('p', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const error = h('p', { role: 'alert', hidden: true });
  const select = h('select', {
    id: 'release-repository',
    onchange: () => {
      location.hash = releaseHash({
        repositoryId: select.value || null,
        jobId: null,
        planId: null,
      });
    },
  });
  const capability = h('div');
  const prepare = h(
    'button',
    { class: 'btn', type: 'button', disabled: true, onclick: () => void start() },
    'Prepare release',
  );
  const jobs = h('div');
  const plan = h('div');
  const outcome = h('div');
  const controls = h(
    'div',
    { hidden: true },
    h('label', { for: select.id }, 'Release repository'),
    select,
    capability,
    prepare,
    h('h2', null, 'Recent jobs'),
    jobs,
  );
  const el = h(
    'main',
    { class: 'releases', hidden: true },
    h('p', { class: 'muted' }, 'Forge Desk'),
    heading,
    status,
    error,
    h(
      'button',
      { class: 'btn', type: 'button', onclick: () => void open(route) },
      'Reload release status',
    ),
    controls,
    plan,
    outcome,
  );
  let route: ReleaseRoute = { repositoryId: null, jobId: null, planId: null };
  let repositories: ReleaseRepository[] = [];
  let currentPlan: ReleasePlan | null = null;
  let attemptBlocker: string | null = null;
  let generation = 0;
  let publishing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    generation++;
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    currentPlan = null;
    attemptBlocker = null;
    clear(outcome);
    el.hidden = true;
  }

  function fail(e: unknown) {
    error.textContent = errorMessage(e);
    error.hidden = false;
    status.textContent = 'Release status could not be loaded. Reload to try again.';
  }

  function prepareAgain(label: string): HTMLElement {
    return h('button', { class: 'btn', type: 'button', onclick: () => void start() }, label);
  }

  function staleNotice(message: string): HTMLElement {
    return h(
      'section',
      { class: 'release-outcome', 'aria-label': 'Stale plan' },
      h('h2', { tabindex: '-1' }, 'This plan is stale'),
      h('p', null, `An approval-relevant fact changed: ${message}`),
      h(
        'p',
        null,
        'Publication of this plan is closed before any remote change. A fresh plan needs its own review and approval; the server never substitutes a newer candidate or regenerated notes.',
      ),
      h('div', { class: 'release-actions' }, prepareAgain('Prepare a fresh plan')),
    );
  }

  /** A truthful refusal that is not a stale plan; fresh preparation would not clear it. */
  function admissionNotice(message: string, code: string): HTMLElement {
    const title =
      code === 'attempt-unresolved'
        ? 'An earlier publication needs attention'
        : code === 'repository-busy'
          ? 'Another release operation is running'
          : 'Publication was not accepted';
    const next =
      code === 'attempt-unresolved'
        ? 'Fresh preparation does not resolve an earlier uncertain attempt. Inspect and reconcile that job from the recent jobs list before approving again.'
        : code === 'repository-busy'
          ? 'Wait for the running operation, then reload release status before approving.'
          : 'Resolve the repository blockers, then prepare and review a fresh plan.';
    return h(
      'section',
      { class: 'release-outcome', 'aria-label': title },
      h('h2', { tabindex: '-1' }, title),
      h('p', null, `The server refused this approval: ${message}.`),
      h('p', null, next),
      h(
        'div',
        { class: 'release-actions' },
        h(
          'a',
          {
            class: 'btn',
            href:
              route.repositoryId === null
                ? '#/releases'
                : releaseHash({ repositoryId: route.repositoryId, jobId: null, planId: null }),
          },
          'Review recent jobs',
        ),
      ),
    );
  }

  /** An accepted job makes another approval pointless or unsafe until the plan is fresh. */
  function attemptReason(job: ReleaseJob): string | null {
    if (job.kind === 'prepare') return null;
    if (job.state === 'queued' || job.state === 'running') {
      return 'an accepted publication is still running; follow its progress instead of approving again';
    }
    if (job.state === 'complete') {
      return 'this plan has an accepted publication that already finished; prepare a fresh plan for another release';
    }
    if (job.errorCode === 'plan-stale') {
      return 'this plan is stale; prepare a fresh plan';
    }
    return 'an accepted publication needs read-only reconciliation before another approval';
  }

  async function history(id: string, token: number) {
    const result = await fetchReleaseJobs(id);
    if (token !== generation) return;
    clear(jobs);
    jobs.append(
      h('p', null, `Showing ${result.items.length} of ${result.total} jobs (most recent 25).`),
      h(
        'ul',
        null,
        ...result.items.map((job) =>
          h(
            'li',
            null,
            h(
              'a',
              { href: releaseHash({ repositoryId: id, jobId: job.jobId, planId: null }) },
              `${job.kind} · ${job.state} · ${job.jobId}`,
            ),
          ),
        ),
      ),
    );
  }

  async function showPlan(id: string, token: number) {
    const result = await fetchReleasePlan(id);
    if (token !== generation) return;
    if (result.payload.repository.repositoryId !== route.repositoryId) {
      throw new Error(
        'This plan belongs to a different release repository. Select its repository first.',
      );
    }
    currentPlan = result;
    renderReview(true);
  }

  /** Re-renders the reviewed plan, including its expiry state, from the stored plan. */
  function renderReview(focus: boolean): void {
    const reviewed = currentPlan;
    if (reviewed === null) return;
    clear(plan);
    plan.append(
      review(reviewed, {
        publish: (plan, publishButton) => void publish(plan, publishButton),
        prepare: () => void start(),
        attemptBlocker: () => attemptBlocker,
      }),
    );
    if (focus) plan.querySelector<HTMLElement>('h2')?.focus();
    // The approval deadline passes while the plan is on screen: disable Publish then, not
    // only when the operator happens to click it.
    clearTimeout(expiryTimer);
    const remaining = Date.parse(reviewed.approvalDeadline) - Date.now();
    // An already expired plan is rendered disabled; scheduling again would redraw it forever.
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    expiryTimer = setTimeout(
      () => {
        if (currentPlan !== reviewed) return;
        renderReview(false);
        status.textContent = `This plan expired at ${reviewed.approvalDeadline}. Prepare a fresh plan and review it.`;
      },
      // Plans expire within 30 minutes; the cap only keeps an unexpected far-future deadline
      // from overflowing the timer and re-rendering in a loop.
      Math.min(Math.max(0, remaining + 1), 2_147_483_647),
    );
  }

  async function loadReceipt(
    jobId: string,
    button: HTMLButtonElement,
    receipt: HTMLElement,
  ): Promise<void> {
    const token = generation;
    button.disabled = true;
    try {
      const text = await fetchReleaseReceipt(jobId);
      if (token !== generation) return;
      receipt.textContent = text;
      receipt.hidden = false;
      receipt.focus();
      status.textContent = 'Receipt loaded. It is the durable evidence recorded for this attempt.';
    } catch (e) {
      if (token !== generation) return;
      fail(e);
    } finally {
      if (token === generation) button.disabled = false;
    }
  }

  async function reconcile(jobId: string, button: HTMLButtonElement): Promise<void> {
    const token = generation;
    button.disabled = true;
    error.hidden = true;
    status.textContent =
      'Reconciling: reading the remote repository only. No tag or release will be written.';
    try {
      const result = await reconcileRelease(jobId);
      if (token !== generation) return;
      status.textContent = `Reconciliation ${result.state}: tag ${result.remote.tag}, release ${result.remote.release}. ${result.blocker?.message ?? ''}`;
      // The original publication carries the reconciled state and its own receipt.
      const original = await fetchReleaseJob(jobId);
      if (token !== generation) return;
      showOutcome(original, token);
      outcome.querySelector<HTMLElement>('h2')?.focus();
    } catch (e) {
      if (token !== generation) return;
      fail(e);
      button.disabled = false;
    }
  }

  /**
   * Renders a terminal publication or reconciliation job without ever offering a write.
   * `original` is the publication named by a reconciliation job: attempted effects stay on it.
   * A failed read of that record is reported as unavailable, never as an empty history.
   */
  function showOutcome(
    job: ReleaseJob,
    token: number,
    original?: ReleaseJob,
    historyUnavailable = false,
  ): void {
    if (token !== generation) return;
    clear(outcome);
    if (job.kind === 'prepare') return;
    const stale = job.errorCode === 'plan-stale';
    const publicationJobId = job.kind === 'publish' ? job.jobId : (job.publicationJobId ?? null);
    const attempts = original?.attemptedEffects ?? job.attemptedEffects;
    const p = currentPlan?.payload;
    const receipt = h('pre', {
      class: 'release-receipt',
      tabindex: '0',
      'aria-label': 'Publication receipt',
      hidden: true,
    });
    const receiptButton = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        disabled: publicationJobId === null,
        onclick: () => {
          if (publicationJobId !== null) void loadReceipt(publicationJobId, receiptButton, receipt);
        },
      },
      'View receipt (read-only)',
    );
    const reconcileButton = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          if (publicationJobId !== null) void reconcile(publicationJobId, reconcileButton);
        },
      },
      'Reconcile (read-only)',
    );
    const actions = h('div', { class: 'release-actions' });
    const title = stale
      ? 'This plan is stale'
      : job.kind === 'reconcile'
        ? 'Reconciliation outcome'
        : 'Publication outcome';
    const summary = stale
      ? `Publication stopped before the first remote change because an approval-relevant fact changed: ${job.blocker?.message ?? 'no further detail was recorded'} A fresh plan and a new approval are required.`
      : job.state === 'complete'
        ? `The job finished. The last independent reads recorded tag ${job.remote.tag} and release ${job.remote.release}; the receipt holds the durable evidence.`
        : `The job stopped with ${job.state}${job.errorCode === null ? '' : ` (${job.errorCode})`}. The remote state is not trusted until read-only reconciliation proves it: ${job.blocker?.message ?? 'no further detail was recorded'}`;
    outcome.append(
      h(
        'section',
        { class: 'release-outcome', 'aria-label': title },
        h('h2', { tabindex: '-1' }, title),
        h('p', null, summary),
        h(
          'dl',
          { class: 'release-fields' },
          field('Job', `${job.kind} · ${job.jobId}`),
          field(
            'State',
            `${job.state} · step ${job.step ?? 'not started'} · ${job.errorCode ?? 'no error code'}`,
          ),
          field('Original candidate', p === undefined ? 'Not recorded' : p.candidate.commit),
          field(
            'Original version and title',
            p === undefined ? 'Not recorded' : `${p.tagName} · ${p.title}`,
          ),
          field(
            'Notes',
            p === undefined ? 'Not recorded' : `${p.notes.source} · ${p.notes.digest}`,
          ),
          field(
            'Attempted steps',
            historyUnavailable
              ? 'Unavailable: the original publication record could not be read'
              : (attempts?.length ?? 0) === 0
                ? 'None recorded'
                : h(
                    'ul',
                    null,
                    ...attempts!.map((effect) => h('li', null, `${effect.kind}: ${effect.tag}`)),
                  ),
          ),
          field('Observed tag', job.remote.tag),
          field('Observed release', job.remote.release),
        ),
        ...(p === undefined
          ? []
          : [
              h('h3', null, 'Original release notes'),
              h(
                'pre',
                {
                  class: 'release-notes',
                  tabindex: '0',
                  'aria-label': 'Original release notes',
                },
                p.notes.text,
              ),
            ]),
      ),
    );
    if (job.state !== 'complete' && !stale) {
      actions.append(reconcileButton);
    }
    if (publicationJobId !== null) actions.append(receiptButton);
    if (job.state !== 'complete') actions.append(prepareAgain('Prepare a fresh plan'));
    if (job.state !== 'complete') {
      outcome.append(
        h(
          'p',
          null,
          'Reconcile performs remote reads only. A missing effect is never published from this screen: prepare a fresh recovery plan for the original version and notes, review it, then approve its new digest.',
        ),
      );
    }
    outcome.append(actions, receipt);
  }

  async function poll(id: string, token: number): Promise<void> {
    try {
      const job: ReleaseJob = await fetchReleaseJob(id);
      if (token !== generation) return;
      status.textContent = `${job.kind} ${job.jobId}: ${job.state} · ${job.step ?? 'waiting'} · tag ${job.remote.tag} · release ${job.remote.release}`;
      attemptBlocker = attemptReason(job);
      if (job.blocker !== undefined || job.errorCode !== null) {
        error.textContent =
          job.blocker === undefined
            ? `Job blocked: ${job.errorCode}`
            : `${job.blocker.code}: ${job.blocker.message}`;
        error.hidden = false;
      } else {
        error.hidden = true;
      }
      if (!isTerminal(job.state)) {
        prepare.disabled = true;
        timer = setTimeout(() => void poll(id, token), 1500);
        return;
      }
      prepare.disabled =
        repositories.find((r) => r.id === route.repositoryId)?.capability !== 'available';
      if (job.planId !== null) await showPlan(job.planId, token);
      if (token !== generation) return;
      // A reconciliation job reports observed state; its attempted effects belong to the
      // original publication it names, so show that history instead of "None recorded".
      // An unreadable publication is a read failure, never a claim that nothing was attempted.
      let original: ReleaseJob | undefined;
      let historyUnavailable = false;
      if (job.kind === 'reconcile' && job.publicationJobId !== undefined) {
        try {
          original = await fetchReleaseJob(job.publicationJobId);
        } catch (e) {
          historyUnavailable = true;
          error.textContent = `The original publication record could not be read: ${errorMessage(e)}`;
          error.hidden = false;
          status.textContent =
            'Reconciliation outcome shown; the original attempt history is unavailable.';
        }
        if (token !== generation) return;
      }
      showOutcome(job, token, original, historyUnavailable);
      if (route.repositoryId !== null) {
        await history(route.repositoryId, token);
      }
    } catch (e) {
      if (token === generation) fail(e);
    }
  }

  async function publish(reviewed: ReleasePlan, button: HTMLButtonElement): Promise<void> {
    if (publishing || button.disabled || route.repositoryId === null) return;
    // The plan can expire while it is on screen; never submit an approval it can no longer carry.
    const expired = publishBlocker(reviewed);
    if (expired !== null) {
      button.disabled = true;
      error.hidden = true;
      clear(outcome);
      outcome.append(staleNotice(expired));
      status.textContent = 'This plan can no longer be published. Prepare a fresh plan.';
      return;
    }
    publishing = true;
    const token = generation;
    button.disabled = true;
    error.hidden = true;
    status.textContent = `Submitting approval for ${reviewed.payload.tagName}. Closing or reloading this tab does not cancel an accepted job.`;
    try {
      const job = await publishRelease(reviewed.planId, reviewed.digest);
      if (token !== generation) return;
      const next = { ...route, jobId: job.jobId, planId: reviewed.planId };
      const hash = releaseHash(next);
      if (location.hash === hash) void open(next);
      else location.hash = hash;
    } catch (e) {
      if (token !== generation) return;
      fail(e);
      const code = e instanceof ApiError ? e.code : undefined;
      clear(outcome);
      if (code === 'plan-stale' || code === 'plan-expired') {
        outcome.append(staleNotice(errorMessage(e)));
      } else if (
        code === 'attempt-unresolved' ||
        code === 'repository-busy' ||
        code === 'repository-ineligible'
      ) {
        outcome.append(admissionNotice(errorMessage(e), code));
      }
      outcome.querySelector<HTMLElement>('h2')?.focus();
      button.disabled = false;
    } finally {
      publishing = false;
    }
  }

  async function start() {
    if (route.repositoryId === null || prepare.disabled) return;
    const token = generation;
    prepare.disabled = true;
    error.hidden = true;
    status.textContent = 'Starting or reusing preparation. No tag or release will be published.';
    try {
      const result = await prepareRelease(route.repositoryId);
      if (token === generation) {
        const next = { ...route, jobId: result.jobId, planId: null };
        const hash = releaseHash(next);
        if (location.hash === hash) void open(next);
        else location.hash = hash;
      }
    } catch (e) {
      if (token === generation) {
        fail(e);
        prepare.disabled = false;
      }
    }
  }

  async function open(next: ReleaseRoute) {
    close();
    const token = generation;
    route = next;
    publishing = false;
    el.hidden = false;
    heading.focus();
    controls.hidden = true;
    error.hidden = true;
    prepare.disabled = true;
    clear(plan);
    clear(jobs);
    status.textContent = 'Checking release capability…';
    try {
      repositories = await fetchReleaseRepositories();
      if (token !== generation) return;
      clear(select);
      select.append(
        h('option', { value: '' }, 'Select a repository'),
        ...repositories.map((r) =>
          h('option', { value: r.id }, `${r.repo} (${r.id}) · ${r.capability}`),
        ),
      );
      controls.hidden = false;
      select.value = route.repositoryId ?? '';
      const repo = repositories.find((r) => r.id === route.repositoryId);
      clear(capability);
      if (repo === undefined) {
        status.textContent =
          repositories.length === 0
            ? 'Releases unavailable: no repositories configured.'
            : 'Select a configured release repository.';
        if (route.repositoryId !== null) {
          throw new Error('Unknown release repository. Choose one from the list.');
        }
        return;
      }
      capability.append(
        h('p', null, `${repo.forge} · ${repo.repo} · source ${repo.source} · ${repo.capability}`),
        ...repo.blockers.map((b) => h('p', null, `${b.code}: ${b.message}`)),
      );
      prepare.disabled = repo.capability !== 'available';
      status.textContent =
        repo.capability === 'available'
          ? 'Ready to prepare. Preparation only reads the remote repository.'
          : 'Preparation unavailable. Resolve the setup blockers shown below.';
      await history(repo.id, token);
      if (token !== generation) return;
      if (route.jobId !== null) {
        await poll(route.jobId, token);
      } else if (route.planId !== null) {
        await showPlan(route.planId, token);
      }
    } catch (e) {
      if (token !== generation) return;
      if (e instanceof ApiError && e.status === 404 && controls.hidden) {
        status.textContent =
          'Releases unavailable: this server has releases disabled or does not support release routes. No release credentials are needed for Planning.';
      } else {
        fail(e);
      }
    }
  }

  return { el, open, close };
}
