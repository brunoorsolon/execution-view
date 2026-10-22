import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentHash } from './hash.js';
import {
  RELEASE_CONTRACT_VERSION,
  RELEASE_ERROR_HTTP_STATUS,
  type ReleaseErrorCode,
  type ReleaseJob,
  type ReleaseJobState,
  type ReleasePlanPayload,
  type ReleaseReceipt,
} from './release.js';
import {
  createReleaseNotes,
  isReleasePlanDigest,
  releaseNotesDigest,
  releasePlanDigest,
} from './releaseDigest.js';

function payload(overrides: Partial<ReleasePlanPayload> = {}): ReleasePlanPayload {
  return {
    contractVersion: RELEASE_CONTRACT_VERSION,
    stateSchemaVersion: 1,
    repository: {
      repositoryId: 'app',
      forge: 'gitea',
      baseUrl: 'https://gitea.example.com',
      owner: 'example',
      repo: 'app',
      forgeRepositoryId: 42,
      defaultBranch: 'main',
    },
    account: {
      forge: 'gitea',
      baseUrl: 'https://gitea.example.com',
      login: 'release-bot',
      forgeUserId: 7,
    },
    tagger: { name: 'Forge Desk Release Bot', email: 'releases@example.com' },
    candidate: { commit: 'a'.repeat(40), branch: 'main' },
    baseline: { tag: 'v0.1.0', commit: 'b'.repeat(40), stableTags: ['v0.1.0'] },
    ci: {
      workflowPath: '.gitea/workflows/validate.yaml',
      runId: 1234,
      headCommit: 'a'.repeat(40),
      branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    },
    notes: createReleaseNotes('Release v0.2.0\n\n- Fix the thing\n', 'file'),
    title: 'v0.2.0',
    tagName: 'v0.2.0',
    actions: [
      { kind: 'create-tag', tag: 'v0.2.0' },
      { kind: 'create-release', tag: 'v0.2.0' },
    ],
    warnings: [
      { code: 'recovered-attempt', message: 'Recovering the earlier interrupted attempt.' },
    ],
    blockers: [],
    recovery: {
      jobId: 'original-publication',
      defaultBranchHead: 'a'.repeat(40),
      tagCreatedAt: '2026-01-01T00:00:00.000Z',
    },
    tag: { state: 'absent', name: 'v0.2.0', commit: null, objectId: null, tagger: null },
    release: {
      state: 'absent',
      tag: null,
      title: null,
      notesDigest: null,
      draft: null,
      prerelease: null,
      author: null,
      assets: null,
    },
    ...overrides,
  };
}

function changed(overrides: Partial<ReleasePlanPayload>): string {
  return releasePlanDigest(payload(overrides));
}

function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries) out[key] = reorderKeys(entry);
  return out;
}

describe('releasePlanDigest', () => {
  it('hashes the canonical JSON of the structured payload', () => {
    const plan = payload();
    expect(releasePlanDigest(plan)).toBe(contentHash(plan));
    expect(releasePlanDigest(plan)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for equivalent structured content regardless of key order', () => {
    const plan = payload();
    const reordered = reorderKeys(payload()) as ReleasePlanPayload;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(plan));
    expect(releasePlanDigest(reordered)).toBe(releasePlanDigest(plan));
    expect(releasePlanDigest(payload())).toBe(releasePlanDigest(plan));
  });

  it('changes for every approval-relevant candidate and baseline input', () => {
    const base = releasePlanDigest(payload());
    expect(changed({ candidate: { commit: 'c'.repeat(40), branch: 'main' } })).not.toBe(base);
    expect(changed({ candidate: { commit: 'a'.repeat(40), branch: 'release' } })).not.toBe(base);
    expect(
      changed({ baseline: { tag: 'v0.1.1', commit: 'b'.repeat(40), stableTags: ['v0.1.0'] } }),
    ).not.toBe(base);
    expect(changed({ baseline: { tag: null, commit: null, stableTags: [] } })).not.toBe(base);
    expect(
      changed({ recovery: { ...payload().recovery!, defaultBranchHead: 'd'.repeat(40) } }),
    ).not.toBe(base);
  });

  it('changes for every approval-relevant CI and policy input', () => {
    const base = releasePlanDigest(payload());
    expect(
      changed({ ci: { ...payload().ci, workflowPath: '.gitea/workflows/other.yaml' } }),
    ).not.toBe(base);
    expect(changed({ ci: { ...payload().ci, runId: 1235 } })).not.toBe(base);
    expect(changed({ ci: { ...payload().ci, headCommit: 'd'.repeat(40) } })).not.toBe(base);
    expect(changed({ tagger: { name: 'Other Bot', email: 'releases@example.com' } })).not.toBe(
      base,
    );
    expect(
      changed({ tagger: { name: 'Forge Desk Release Bot', email: 'other@example.com' } }),
    ).not.toBe(base);
  });

  it('changes for every approval-relevant identity input', () => {
    const base = releasePlanDigest(payload());
    const plan = payload();
    expect(changed({ repository: { ...plan.repository, forgeRepositoryId: 43 } })).not.toBe(base);
    expect(changed({ repository: { ...plan.repository, repo: 'other' } })).not.toBe(base);
    expect(changed({ repository: { ...plan.repository, defaultBranch: 'trunk' } })).not.toBe(base);
    expect(changed({ account: { ...plan.account, login: 'another-bot' } })).not.toBe(base);
    expect(changed({ account: { ...plan.account, forgeUserId: 8 } })).not.toBe(base);
  });

  it('changes when the notes text changes, and keeps the notes digest in step', () => {
    const base = releasePlanDigest(payload());
    const edited = payload({
      notes: createReleaseNotes('Release v0.2.0\n\n- Fix the other thing\n', 'file'),
    });
    expect(releasePlanDigest(edited)).not.toBe(base);
    expect(edited.notes.digest).toBe(releaseNotesDigest(edited.notes.text));
  });

  it('changes for changed intended actions and remote observations', () => {
    const base = releasePlanDigest(payload());
    expect(changed({ actions: [{ kind: 'create-release', tag: 'v0.2.0' }] })).not.toBe(base);
    expect(
      changed({
        tag: {
          state: 'exact',
          name: 'v0.2.0',
          commit: 'a'.repeat(40),
          objectId: 'e'.repeat(40),
          tagger: { name: 'Forge Desk Release Bot', email: 'releases@example.test' },
        },
      }),
    ).not.toBe(base);
    expect(changed({ release: { ...payload().release, state: 'conflict' } })).not.toBe(base);
    expect(changed({ title: 'v0.2.1' })).not.toBe(base);
    expect(changed({ tagName: 'v0.2.1' })).not.toBe(base);
    expect(changed({ contractVersion: RELEASE_CONTRACT_VERSION + 1 })).not.toBe(base);
    expect(changed({ stateSchemaVersion: 2 })).not.toBe(base);
  });

  it('rejects formatted text in place of the structured payload', () => {
    const formatted = 'v0.2.0\n\nRelease v0.2.0\n\n- Fix the thing\n';
    expect(() => releasePlanDigest(formatted as unknown as ReleasePlanPayload)).toThrow(
      /structured release plan payload/,
    );
    expect(() =>
      releasePlanDigest(JSON.stringify(payload()) as unknown as ReleasePlanPayload),
    ).toThrow(/structured release plan payload/);
    expect(() => releasePlanDigest({ text: formatted } as unknown as ReleasePlanPayload)).toThrow(
      /expected the stored structured payload/,
    );
  });

  it('rejects a payload whose notes digest does not match its notes text', () => {
    const plan = payload();
    const tampered: ReleasePlanPayload = {
      ...plan,
      notes: { ...plan.notes, digest: releaseNotesDigest('different notes') },
    };
    expect(() => releasePlanDigest(tampered)).toThrow(/notes digest matches its exact text/);
  });

  it('accepts a digest only for the exact structured payload it was computed from', () => {
    const plan = payload();
    const digest = releasePlanDigest(plan);
    expect(isReleasePlanDigest(plan, digest)).toBe(true);
    expect(isReleasePlanDigest(plan, contentHash('v0.2.0 release notes'))).toBe(false);
    expect(isReleasePlanDigest(plan, releasePlanDigest(payload({ title: 'v0.2.1' })))).toBe(false);
  });

  it('keeps secrets and volatile observation timestamps out of approval content', () => {
    // Exhaustive over the payload type: a new field must be added here and to the fixture,
    // so the name scan below covers it.
    const contractKeys: Record<keyof ReleasePlanPayload, true> = {
      contractVersion: true,
      stateSchemaVersion: true,
      repository: true,
      account: true,
      tagger: true,
      candidate: true,
      baseline: true,
      ci: true,
      notes: true,
      title: true,
      tagName: true,
      actions: true,
      warnings: true,
      blockers: true,
      recovery: true,
      tag: true,
      release: true,
    };
    expect(Object.keys(payload()).sort()).toEqual(Object.keys(contractKeys).sort());

    const canonical = JSON.stringify(payload()).toLowerCase();
    for (const key of [
      'token',
      'secret',
      'password',
      'authorization',
      'privatekey',
      'observedat',
      'fetchedat',
      'timestamp',
      'deadline',
    ]) {
      expect(canonical).not.toContain(`"${key}"`);
    }
  });
});

describe('releaseNotesDigest', () => {
  it('is the sha256 of the exact UTF-8 bytes', () => {
    expect(releaseNotesDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(releaseNotesDigest('héllo ✓')).toBe(
      createHash('sha256').update('héllo ✓', 'utf8').digest('hex'),
    );
  });

  it('changes with the notes text and is referenced by the plan payload', () => {
    const notes = createReleaseNotes('- one\n', 'commit-subjects');
    expect(notes.digest).toBe(releaseNotesDigest('- one\n'));
    expect(notes.digest).not.toBe(releaseNotesDigest('- two\n'));
    expect(createReleaseNotes('- one\n', 'commit-subjects').digest).toBe(notes.digest);
    expect(payload({ notes }).notes.digest).toBe(notes.digest);
  });
});

describe('release job and error contract', () => {
  it('keeps job state, current step and remote classification separate', () => {
    const job: ReleaseJob = {
      jobId: 'job-1',
      kind: 'publish',
      planId: 'plan-1',
      planDigest: releasePlanDigest(payload()),
      state: 'internal-error',
      step: 'recording-receipt',
      remote: { tag: 'exact', release: 'exact' },
      errorCode: 'internal-error',
    };
    // A storage failure leaves remote state exact without letting the job claim completion.
    expect(job.state).not.toBe('complete');
    expect(job.remote).toEqual({ tag: 'exact', release: 'exact' });
    expect(job.step).toBe('recording-receipt');

    const states: ReleaseJobState[] = [
      'queued',
      'running',
      'complete',
      'blocked',
      'needs-inspection',
      'internal-error',
    ];
    expect(new Set(states).size).toBe(6);
  });

  it('exposes one stable HTTP status for every error code', () => {
    const codes = Object.keys(RELEASE_ERROR_HTTP_STATUS).sort() as ReleaseErrorCode[];
    expect(codes).toEqual([
      'attempt-unresolved',
      'evidence-too-large',
      'execution-unavailable',
      'internal-error',
      'invalid-request',
      'not-authenticated',
      'not-found',
      'origin-rejected',
      'plan-expired',
      'plan-stale',
      'repository-busy',
      'repository-ineligible',
    ]);
    for (const code of codes) {
      expect([400, 401, 403, 404, 409, 410, 500, 503]).toContain(RELEASE_ERROR_HTTP_STATUS[code]);
    }
    expect(RELEASE_ERROR_HTTP_STATUS['plan-stale']).toBe(409);
    expect(RELEASE_ERROR_HTTP_STATUS['attempt-unresolved']).toBe(409);
    expect(RELEASE_ERROR_HTTP_STATUS['plan-expired']).toBe(410);
    expect(RELEASE_ERROR_HTTP_STATUS['execution-unavailable']).toBe(503);
  });

  it('carries the shared state versions on receipts', () => {
    const receipt: ReleaseReceipt = {
      receiptId: 'receipt-1',
      jobId: 'job-1',
      planId: 'plan-1',
      planDigest: releasePlanDigest(payload()),
      contractVersion: RELEASE_CONTRACT_VERSION,
      stateSchemaVersion: 1,
      state: 'complete',
      remote: { tag: 'exact', release: 'exact' },
      errorCode: null,
    };
    expect(receipt.contractVersion).toBe(RELEASE_CONTRACT_VERSION);
    expect(receipt.stateSchemaVersion).toBe(1);
  });
});
