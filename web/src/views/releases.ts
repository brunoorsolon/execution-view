import type { ReleaseJob, ReleasePlan } from '../../../src/core/release.js';
import {
  ApiError,
  errorMessage,
  fetchReleaseRepositories,
  fetchReleaseJobs,
  fetchReleaseJob,
  fetchReleasePlan,
  prepareRelease,
  type ReleaseRepository,
} from '../api.js';
import { clear, h, type Child } from '../dom.js';
import { releaseHash, type ReleaseRoute } from '../release-route.js';

function field(label: string, value: Child): HTMLElement {
  return h('div', { class: 'release-field' }, h('dt', null, label), h('dd', null, value));
}

function review(plan: ReleasePlan): HTMLElement {
  const p = plan.payload;
  const r = p.repository;
  // Construct links from the verified forge identity, never from notes or API-returned URLs.
  const base = new URL(r.baseUrl);
  const candidateUrl =
    ['https:', 'http:'].includes(base.protocol) && !base.username && !base.password
      ? `${r.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/commit/${encodeURIComponent(p.candidate.commit)}`
      : null;
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
  );
}

/** Owns only preparation and reads. Closing the view invalidates all in-flight UI work. */
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
  );
  let route: ReleaseRoute = { repositoryId: null, jobId: null, planId: null };
  let repositories: ReleaseRepository[] = [];
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    generation++;
    clearTimeout(timer);
    el.hidden = true;
  }

  function fail(e: unknown) {
    error.textContent = errorMessage(e);
    error.hidden = false;
    status.textContent = 'Release status could not be loaded. Reload to try again.';
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
    clear(plan);
    plan.append(review(result));
    plan.querySelector<HTMLElement>('h2')?.focus();
  }

  async function poll(id: string, token: number): Promise<void> {
    try {
      const job: ReleaseJob = await fetchReleaseJob(id);
      if (token !== generation) return;
      status.textContent = `${job.kind} ${job.jobId}: ${job.state} · ${job.step ?? 'waiting'} · tag ${job.remote.tag} · release ${job.remote.release}`;
      if (job.blocker !== undefined || job.errorCode !== null) {
        error.textContent =
          job.blocker === undefined
            ? `Job blocked: ${job.errorCode}`
            : `${job.blocker.code}: ${job.blocker.message}`;
        error.hidden = false;
      }
      if (job.state === 'queued' || job.state === 'running') {
        prepare.disabled = true;
        timer = setTimeout(() => void poll(id, token), 1500);
      } else {
        prepare.disabled =
          repositories.find((r) => r.id === route.repositoryId)?.capability !== 'available';
        if (job.planId !== null) await showPlan(job.planId, token);
        if (token === generation && route.repositoryId !== null) {
          await history(route.repositoryId, token);
        }
      }
    } catch (e) {
      if (token === generation) fail(e);
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
      if (route.planId !== null) await showPlan(route.planId, token);
      if (token === generation && route.jobId !== null) await poll(route.jobId, token);
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
