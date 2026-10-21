import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '../core/hash.js';
import {
  RELEASE_CONTRACT_VERSION,
  RELEASE_STATE_SCHEMA_VERSION,
  type ReleaseIntent,
  type ReleaseJob,
  type ReleasePlan,
  type ReleasePlanPayload,
  type ReleaseReceipt,
  type ReleaseStepObservation,
} from '../core/release.js';
import { createReleaseNotes, releasePlanDigest } from '../core/releaseDigest.js';
import {
  ReleaseStateError,
  ReleaseStateStore,
  type ReleaseStateErrorCode,
} from './releaseState.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempStateDir(): { root: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ev-release-state-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  return { root, stateDir };
}

function payload(overrides: Partial<ReleasePlanPayload> = {}): ReleasePlanPayload {
  return {
    contractVersion: RELEASE_CONTRACT_VERSION,
    stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION,
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
    warnings: [],
    tag: { state: 'absent', name: 'v0.2.0', commit: null, objectId: null },
    release: {
      state: 'absent',
      tag: null,
      title: null,
      notesDigest: null,
      draft: null,
      prerelease: null,
      author: null,
    },
    ...overrides,
  };
}

function plan(planId = 'plan-1', overrides: Partial<ReleasePlanPayload> = {}): ReleasePlan {
  const body = payload(overrides);
  return {
    planId,
    digest: releasePlanDigest(body),
    approvalDeadline: '2026-10-21T13:30:00.000Z',
    payload: body,
  };
}

function job(overrides: Partial<ReleaseJob> = {}): ReleaseJob {
  return {
    jobId: 'job-1',
    kind: 'publish',
    planId: 'plan-1',
    planDigest: plan().digest,
    state: 'queued',
    step: null,
    remote: { tag: 'absent', release: 'absent' },
    errorCode: null,
    ...overrides,
  };
}

function intent(overrides: Partial<ReleaseIntent> = {}): ReleaseIntent {
  return {
    intentId: 'intent-1',
    planId: 'plan-1',
    planDigest: plan().digest,
    jobId: 'job-1',
    operator: 'operator',
    approvedActions: [{ kind: 'create-tag', tag: 'v0.2.0' }],
    approvedAt: '2026-10-21T13:05:00.000Z',
    contractVersion: RELEASE_CONTRACT_VERSION,
    stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION,
    ...overrides,
  };
}

function observation(overrides: Partial<ReleaseStepObservation> = {}): ReleaseStepObservation {
  return {
    observationId: 'obs-1',
    jobId: 'job-1',
    step: 'observing-tag',
    remote: { tag: 'exact', release: 'absent' },
    observedAt: '2026-10-21T13:06:00.000Z',
    ...overrides,
  };
}

function receipt(overrides: Partial<ReleaseReceipt> = {}): ReleaseReceipt {
  return {
    receiptId: 'receipt-1',
    jobId: 'job-1',
    planId: 'plan-1',
    planDigest: plan().digest,
    contractVersion: RELEASE_CONTRACT_VERSION,
    stateSchemaVersion: RELEASE_STATE_SCHEMA_VERSION,
    state: 'complete',
    remote: { tag: 'exact', release: 'exact' },
    errorCode: null,
    ...overrides,
  };
}

function recordFile(stateDir: string, dir: string, id: string): string {
  return join(stateDir, dir, `${id}.json`);
}

function expectStateError(code: ReleaseStateErrorCode, run: () => unknown): ReleaseStateError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseStateError);
    const stateError = error as ReleaseStateError;
    expect(stateError.code).toBe(code);
    return stateError;
  }
  throw new Error(`expected a ReleaseStateError with code ${code}`);
}

/** Every file under the state directory, so absence checks cannot miss a stray record. */
function allBytes(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? allBytes(path) : readFileSync(path, 'utf8');
    })
    .join('\n');
}

describe('ReleaseStateStore round trips', () => {
  it('stores and reloads plans, jobs, intents, observations and receipts as separate records', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    const storedPlan = plan();
    const storedJob = job();
    const storedIntent = intent();
    const storedObservation = observation();
    const storedReceipt = receipt();

    store.writePlan(storedPlan);
    store.writeJob(storedJob);
    store.writeIntent(storedIntent);
    store.writeObservation(storedObservation);
    store.writeReceipt(storedReceipt);

    // A restart reads the same evidence back from disk.
    const reopened = new ReleaseStateStore({ stateDir });
    expect(reopened.readPlan('plan-1')).toEqual(storedPlan);
    expect(reopened.readJob('job-1')).toEqual(storedJob);
    expect(reopened.readIntent('plan-1')).toEqual(storedIntent);
    expect(reopened.readObservation('obs-1')).toEqual(storedObservation);
    expect(reopened.readReceipt('job-1')).toEqual(storedReceipt);

    // Shared-contract identities survived the round trip and still agree with each other.
    const readPlan = reopened.readPlan('plan-1');
    expect(readPlan.digest).toBe(releasePlanDigest(readPlan.payload));
    expect(readPlan.payload.notes.digest).toBe(storedPlan.payload.notes.digest);
    expect(reopened.readIntent('plan-1').planDigest).toBe(readPlan.digest);
    expect(reopened.readReceipt('job-1').planDigest).toBe(readPlan.digest);
    expect(reopened.readJob('job-1').planDigest).toBe(readPlan.digest);
  });

  it('keeps private permissions on every record and record directory', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    store.writeJob(job());

    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    for (const dir of ['plans', 'jobs']) {
      expect(statSync(join(stateDir, dir)).mode & 0o777).toBe(0o700);
    }
    expect(statSync(recordFile(stateDir, 'plans', 'plan-1')).mode & 0o777).toBe(0o600);
    expect(statSync(recordFile(stateDir, 'jobs', 'job-1')).mode & 0o777).toBe(0o600);
  });

  it('updates only its own job record and leaves other evidence untouched', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    store.writeJob(job());
    store.writeJob(job({ jobId: 'job-2', state: 'queued' }));
    const otherBytes = readFileSync(recordFile(stateDir, 'jobs', 'job-2'), 'utf8');

    store.writeJob(job({ state: 'needs-inspection', step: 'reconciling' }));

    expect(store.readJob('job-1').state).toBe('needs-inspection');
    expect(store.readJob('job-1').step).toBe('reconciling');
    expect(readFileSync(recordFile(stateDir, 'jobs', 'job-2'), 'utf8')).toBe(otherBytes);
  });

  it('never overwrites an unrelated record stored under a different id', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    store.writePlan(plan('plan-2'));
    store.writeObservation(observation({ observationId: 'obs-1' }));
    store.writeObservation(observation({ observationId: 'obs-2', step: 'observing-release' }));
    store.writeIntent(intent());

    expect(store.readPlan('plan-1')).toEqual(plan());
    expect(store.readPlan('plan-2')).toEqual(plan('plan-2'));
    expect(store.readObservation('obs-1').step).toBe('observing-tag');
    expect(store.readObservation('obs-2').step).toBe('observing-release');
  });

  it('treats a repeated identical write as the same durable record', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    store.writeIntent(intent());
    store.writeReceipt(receipt());

    expect(store.writePlan(plan())).toEqual(plan());
    expect(store.writeIntent(intent())).toEqual(intent());
    expect(store.writeReceipt(receipt())).toEqual(receipt());
  });
});

describe('ReleaseStateStore immutability and integrity', () => {
  it('refuses a different immutable plan under an existing plan id', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    const before = readFileSync(recordFile(stateDir, 'plans', 'plan-1'), 'utf8');

    expectStateError('already-exists', () =>
      store.writePlan(plan('plan-1', { title: 'v9.9.9', tagName: 'v9.9.9' })),
    );
    expect(readFileSync(recordFile(stateDir, 'plans', 'plan-1'), 'utf8')).toBe(before);
    expect(store.readPlan('plan-1').payload.title).toBe('v0.2.0');
  });

  it('refuses a second, different approval intent for the same plan', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    store.writeIntent(intent());

    expectStateError('already-exists', () =>
      store.writeIntent(intent({ jobId: 'job-2', intentId: 'intent-2' })),
    );
    expect(store.readIntent('plan-1').jobId).toBe('job-1');
  });

  it('verifies the plan digest before writing and again when reading', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    const tamperedPlan: ReleasePlan = {
      ...plan(),
      digest: releasePlanDigest(payload({ title: 'v9.9.9' })),
    };
    expectStateError('digest-mismatch', () => store.writePlan(tamperedPlan));
    expect(() => store.readPlan('plan-1')).toThrow();

    const inconsistentNotes = plan();
    inconsistentNotes.payload.notes = {
      ...inconsistentNotes.payload.notes,
      digest: 'f'.repeat(64),
    };
    expectStateError('digest-mismatch', () => store.writePlan(inconsistentNotes));
  });

  it('rejects a stored record whose body no longer matches its record digest', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    const file = recordFile(stateDir, 'plans', 'plan-1');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      body: ReleasePlan;
      recordDigest: string;
    };
    stored.body.payload.notes = createReleaseNotes('Rewritten notes\n', 'file');
    writeFileSync(file, `${JSON.stringify(stored)}\n`, { mode: 0o600 });

    expectStateError('digest-mismatch', () => store.readPlan('plan-1'));
  });

  it('binds intents and receipts to the stored plan digest', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());

    expectStateError('digest-mismatch', () =>
      store.writeIntent(intent({ planDigest: 'e'.repeat(64) })),
    );
    expectStateError('digest-mismatch', () =>
      store.writeReceipt(receipt({ planDigest: 'e'.repeat(64) })),
    );
    expectStateError('not-found', () => store.writeIntent(intent({ planId: 'plan-missing' })));
  });

  it('binds a job to its stored plan and allows only the preparation transition', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    store.writePlan(plan('plan-2'));

    store.writeJob(job({ jobId: 'prep-1', kind: 'prepare', planId: null, planDigest: null }));
    // Preparation binds the plan it produced, once.
    store.writeJob(job({ jobId: 'prep-1', kind: 'prepare', state: 'complete', step: 'finished' }));
    expect(store.readJob('prep-1').planId).toBe('plan-1');
    expectStateError('already-exists', () =>
      store.writeJob(
        job({
          jobId: 'prep-1',
          kind: 'prepare',
          planId: 'plan-2',
          planDigest: plan('plan-2').digest,
        }),
      ),
    );

    // A job names a plan only with that plan's digest, and only for a stored plan.
    expectStateError('digest-mismatch', () =>
      store.writeJob(job({ jobId: 'job-bad', planDigest: 'c'.repeat(64) })),
    );
    expectStateError('not-found', () =>
      store.writeJob(job({ jobId: 'job-missing', planId: 'plan-3' })),
    );
    expectStateError('malformed-record', () =>
      store.writeJob({ ...job({ jobId: 'job-null-digest' }), planDigest: null }),
    );

    // The read path re-checks the binding, not only the record digest.
    const file = recordFile(stateDir, 'jobs', 'prep-1');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as ReleaseJob & {
      recordDigest: string;
      body: ReleaseJob;
    };
    stored.body.planDigest = 'd'.repeat(64);
    stored.recordDigest = contentHash(stored.body);
    writeFileSync(file, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    expectStateError('digest-mismatch', () => store.readJob('prep-1'));
  });

  it('fails closed on an unsupported state schema or contract version', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    const file = recordFile(stateDir, 'plans', 'plan-1');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      body: unknown;
      recordDigest: string;
      stateSchemaVersion: number;
    };
    stored.stateSchemaVersion = RELEASE_STATE_SCHEMA_VERSION + 1;
    stored.recordDigest = contentHash(stored.body);
    writeFileSync(file, `${JSON.stringify(stored)}\n`, { mode: 0o600 });

    expectStateError('unsupported-schema', () => store.readPlan('plan-1'));
  });

  it('fails closed on a plan built for a different contract version', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    const futurePayload = payload({ contractVersion: RELEASE_CONTRACT_VERSION + 1 });
    expectStateError('unsupported-schema', () =>
      store.writePlan({
        ...plan(),
        digest: releasePlanDigest(futurePayload),
        payload: futurePayload,
      }),
    );
  });

  it('fails closed on malformed stored records', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    mkdirSync(join(stateDir, 'jobs'), { mode: 0o700 });
    writeFileSync(recordFile(stateDir, 'jobs', 'job-1'), '{"stateSchemaVersion": 1,', {
      mode: 0o600,
    });

    expectStateError('malformed-record', () => store.readJob('job-1'));
  });

  it('survives an interrupted write without exposing partial evidence', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    // An interrupted create or replacement leaves only its temporary copy behind.
    writeFileSync(join(stateDir, 'plans', '.plan-1.json.deadbeef.tmp'), '{"partial":', {
      mode: 0o600,
    });

    const reopened = new ReleaseStateStore({ stateDir });
    expect(reopened.readPlan('plan-1')).toEqual(plan());
    expect(reopened.writePlan(plan('plan-2'))).toEqual(plan('plan-2'));
    expect(readdirSync(join(stateDir, 'plans')).filter((name) => name.endsWith('.tmp'))).toEqual([
      '.plan-1.json.deadbeef.tmp',
    ]);
  });
});

describe('ReleaseStateStore path and permission safety', () => {
  it('rejects ids that would escape the record directory', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    for (const badId of ['../escape', '../../etc/passwd', 'a/b', '/etc/passwd', '', '.hidden']) {
      expectStateError('invalid-id', () => store.readPlan(badId));
      expectStateError('invalid-id', () => store.writePlan(plan(badId)));
    }
  });

  it('rejects a symlinked record file instead of following it', () => {
    const { root, stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    const file = recordFile(stateDir, 'plans', 'plan-1');
    const real = join(root, 'elsewhere.json');
    renameSync(file, real);
    symlinkSync(real, file);

    expectStateError('unsafe-path', () => store.readPlan('plan-1'));
  });

  it('rejects a symlinked record directory', () => {
    const { root, stateDir } = tempStateDir();
    mkdirSync(join(root, 'redirect'), { mode: 0o700 });
    symlinkSync(join(root, 'redirect'), join(stateDir, 'plans'));
    const store = new ReleaseStateStore({ stateDir });

    expectStateError('unsafe-path', () => store.writePlan(plan()));
  });

  it('rejects records or directories that are accessible to group or others', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    chmodSync(recordFile(stateDir, 'plans', 'plan-1'), 0o644);
    expectStateError('unsafe-permissions', () => store.readPlan('plan-1'));

    chmodSync(stateDir, 0o755);
    expectStateError('unsafe-permissions', () => new ReleaseStateStore({ stateDir }));
  });

  it('rejects a state directory owned by another user', () => {
    const { stateDir } = tempStateDir();
    const stranger = (process.getuid?.() ?? 0) + 1;
    expectStateError(
      'unsafe-owner',
      () => new ReleaseStateStore({ stateDir, uid: () => stranger }),
    );
  });

  it('rejects a missing state directory rather than creating it', () => {
    const { root } = tempStateDir();
    expectStateError(
      'unsafe-path',
      () => new ReleaseStateStore({ stateDir: join(root, 'absent') }),
    );
  });
});

describe('ReleaseStateStore secret hygiene', () => {
  it('refuses credential-bearing values and credential or raw-output keys', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());

    const canaryUrl = 'https://release-bot:hunter2@example.com/api';
    expectStateError('unsafe-content', () =>
      store.writePlan(
        plan('plan-secret', { notes: createReleaseNotes(`Fetched ${canaryUrl}\n`, 'file') }),
      ),
    );
    expectStateError('unsafe-content', () =>
      store.writePlan(plan('plan-secret', { warnings: [{ code: 'x', message: canaryUrl }] })),
    );
    expectStateError('unsafe-content', () =>
      store.writePlan(
        plan('plan-secret', {
          notes: createReleaseNotes('Fetched https://ghp_secrettoken@example.com/api\n', 'file'),
        }),
      ),
    );
    expectStateError('unsafe-content', () =>
      store.writeJob({ ...job(), apiToken: 'token-value' } as unknown as ReleaseJob),
    );
    expectStateError('unsafe-content', () =>
      store.writeJob({ ...job(), apiKey: 'key-value' } as unknown as ReleaseJob),
    );
    expectStateError('unsafe-content', () =>
      store.writeObservation({
        ...observation(),
        stdout: 'command output',
      } as ReleaseStepObservation),
    );
    expectStateError('unsafe-content', () =>
      store.writePlan(
        plan('plan-secret', {
          notes: createReleaseNotes(
            '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n',
            'file',
          ),
        }),
      ),
    );
    expectStateError('unsafe-content', () =>
      store.writePlan(
        plan('plan-secret', {
          notes: createReleaseNotes('Authorization: Bearer abcdefghijklmnop\n', 'file'),
        }),
      ),
    );
    expectStateError('unsafe-content', () =>
      store.writePlan(
        plan('plan-secret', {
          notes: createReleaseNotes('authorization=Digest abcdef\n', 'file'),
        }),
      ),
    );

    expect(() => store.readPlan('plan-secret')).toThrow();
  });

  it('keeps canaries out of every persisted byte', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    const canary = 'hunter2-canary-token';
    store.writePlan(plan());
    store.writeJob(job());
    store.writeIntent(intent());
    store.writeObservation(observation());
    store.writeReceipt(receipt());

    const persisted = allBytes(stateDir);
    expect(persisted).toContain('release-bot');
    expect(persisted).not.toContain(canary);
    expect(persisted).not.toMatch(/PRIVATE KEY|Bearer |authorization/i);
  });
});

describe('ReleaseStateStore failure recovery', () => {
  it('keeps the durable intent recoverable when receipt finalization fails', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    store.writeJob(job({ state: 'running', step: 'recording-receipt' }));
    store.writeIntent(intent());

    // Storage failure at finalization: the receipt directory cannot be created.
    writeFileSync(join(stateDir, 'receipts'), 'not a directory', { mode: 0o600 });
    expectStateError('unsafe-path', () => store.writeReceipt(receipt()));

    // A restart still sees what was approved, and nothing claims success.
    const reopened = new ReleaseStateStore({ stateDir });
    expect(reopened.readIntent('plan-1')).toEqual(intent());
    expect(reopened.readJob('job-1').state).toBe('running');
    expectStateError('not-found', () => reopened.readReceipt('job-1'));

    // Once storage is repaired the same intent can finalize its receipt.
    rmSync(join(stateDir, 'receipts'));
    expect(reopened.writeReceipt(receipt())).toEqual(receipt());
    expect(reopened.readReceipt('job-1').state).toBe('complete');
  });

  it('reports a storage failure instead of returning the record', () => {
    const { stateDir } = tempStateDir();
    const store = new ReleaseStateStore({ stateDir });
    store.writePlan(plan());
    // A plan directory that became a file can never report a successful write.
    rmSync(join(stateDir, 'plans'), { recursive: true });
    writeFileSync(join(stateDir, 'plans'), 'not a directory', { mode: 0o600 });

    expectStateError('unsafe-path', () => store.writePlan(plan('plan-2')));
  });
});
