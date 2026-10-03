import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/load.js';
import { exporters, type ExportFormat } from '../export/index.js';
import { PlanService } from '../service/planService.js';
import { main, type CliDeps, type CliIo } from './main.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXED_NOW = new Date('2026-01-02T03:04:05.000Z');
const now = (): Date => FIXED_NOW;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; isTTY?: boolean } & CliDeps = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    env: opts.env ?? {},
    cwd: opts.cwd ?? ROOT,
    ...(opts.isTTY !== undefined ? { isTTY: opts.isTTY } : {}),
  };
  const deps: CliDeps = { now, ...opts };
  const code = await main(argv, io, deps);
  return { code, stdout, stderr };
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ev-cli-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function demoSnapshot() {
  const config = loadConfig({ path: 'config.demo.yaml', env: {}, cwd: ROOT });
  return new PlanService(config, { now }).getSnapshot('demo');
}

/** Write a fixture + config into a temp dir; returns the config path. */
function writeProject(
  issues: { number: number; title: string; body?: string; blockedBy?: string[] }[],
): string {
  const dir = tmp();
  writeFileSync(
    path.join(dir, 'fixture.json'),
    JSON.stringify({
      issues: issues.map((i) => ({ owner: 'o', repo: 'r', state: 'open', ...i })),
    }),
  );
  const configPath = path.join(dir, 'config.yaml');
  writeFileSync(
    configPath,
    [
      'sources:',
      '  - id: fx',
      '    kind: fixture',
      '    path: ./fixture.json',
      '    webUrl: https://fixture.local',
      'views:',
      '  - id: chain',
      '    title: Simple chain',
      '    source: fx',
      '    repos: [o/r]',
      '',
    ].join('\n'),
  );
  return configPath;
}

describe('views', () => {
  it('prints a table', async () => {
    const r = await run(['views', '--config', 'config.demo.yaml']);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ID\s+TITLE\s+KIND\s+REPOS$/);
    expect(lines[1]).toMatch(/^demo\s+Acme demo roadmap\s+fixture\s+acme\/api, acme\/web$/);
    expect(lines).toHaveLength(2);
    expect(r.stderr).toBe('');
  });

  it('prints JSON with --json', async () => {
    const r = await run(['views', '--json', '-c', 'config.demo.yaml']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      {
        id: 'demo',
        title: 'Acme demo roadmap',
        source: 'demo',
        kind: 'fixture',
        repos: ['acme/api', 'acme/web'],
      },
    ]);
  });

  it('honours EV_CONFIG', async () => {
    const r = await run(['views'], { env: { EV_CONFIG: 'config.demo.yaml' } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('demo');
  });
});

describe('plan', () => {
  const formats: [string, ExportFormat][] = [
    ['md', 'md'],
    ['json', 'json'],
    ['mermaid', 'mermaid'],
    ['mmd', 'mermaid'],
    ['dot', 'dot'],
  ];

  it.each(formats)('--format %s equals the exporter output', async (flag, format) => {
    const snapshot = await demoSnapshot();
    const r = await run(['plan', 'demo', '-c', 'config.demo.yaml', '--format', flag]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(exporters[format].render(snapshot));
    expect(r.stderr).toBe('');
  });

  it('defaults to markdown', async () => {
    const snapshot = await demoSnapshot();
    const r = await run(['plan', 'demo', '-c', 'config.demo.yaml']);
    expect(r.stdout).toBe(exporters.md.render(snapshot));
  });

  it('is stable across runs', async () => {
    const a = await run(['plan', 'demo', '-c', 'config.demo.yaml', '-f', 'json']);
    const b = await run(['plan', 'demo', '-c', 'config.demo.yaml', '-f', 'json']);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout.length).toBeGreaterThan(100);
  });

  it('writes a file with --out and reports on stderr', async () => {
    const dir = tmp();
    const configPath = path.join(ROOT, 'config.demo.yaml');
    const r = await run(
      ['plan', 'demo', '-c', configPath, '-f', 'dot', '--out', 'nested/plan.dot'],
      {
        cwd: dir,
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('Wrote nested/plan.dot\n');
    expect(readFileSync(path.join(dir, 'nested', 'plan.dot'), 'utf8')).toBe(
      exporters.dot.render(await demoSnapshot()),
    );
  });

  it('rejects an unknown format', async () => {
    const r = await run(['plan', 'demo', '-c', 'config.demo.yaml', '--format', 'pdf']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('pdf');
    expect(r.stdout).toBe('');
  });

  it('fails on an unknown view', async () => {
    const r = await run(['plan', 'nope', '-c', 'config.demo.yaml']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('Unknown view "nope". Available: demo\n');
    expect(r.stdout).toBe('');
  });
});

describe('check', () => {
  it('reports the demo problems and exits 2', async () => {
    const r = await run(['check', '--config', 'config.demo.yaml']);
    expect(r.code).toBe(2);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('✖ demo (Acme demo roadmap) · fixture · acme/api, acme/web');
    expect(lines[1]).toBe(
      '  23 issues · 4 ready · 14 blocked · 5 unschedulable · 0 external · 34 dependencies · 7 waves',
    );
    expect(r.stdout).toMatch(
      /^ {2}✖ cycle: Dependency cycle: acme\/api#11 → acme\/api#12 → acme\/api#13$/m,
    );
    expect(r.stdout).toMatch(/^ {2}✖ dangling-reference: .*acme\/api#99/m);
    expect(r.stdout).toMatch(/^ {4}hint: break the cycle/m);
    expect(r.stdout).toMatch(/^ {4}hint: check the issue number/m);
    expect(r.stdout).toMatch(/^ {2}⚠ blocked-by-cycle: /m);
    expect(r.stdout).not.toContain('\u001b[');
    expect(r.stdout).not.toContain('No dependencies found');
  });

  it('checks only the given views', async () => {
    const r = await run(['check', 'demo', '-c', 'config.demo.yaml', '--json']);
    expect(r.code).toBe(2);
    const json = JSON.parse(r.stdout) as {
      ok: boolean;
      views: {
        id: string;
        ok: boolean;
        stats: { total: number };
        warnings: { code: string }[];
        error: null;
      }[];
    };
    expect(json.ok).toBe(false);
    expect(json.views).toHaveLength(1);
    expect(json.views[0]).toMatchObject({ id: 'demo', ok: false, error: null });
    expect(json.views[0]?.stats.total).toBe(23);
    expect(json.views[0]?.warnings.map((w) => w.code)).toContain('cycle');
  });

  it('exits 0 for a view without problems', async () => {
    const configPath = writeProject([
      { number: 1, title: 'First' },
      { number: 2, title: 'Second', body: 'Depends on #1' },
      { number: 3, title: 'Third', blockedBy: ['o/r#2'] },
    ]);
    const r = await run(['check', '-c', configPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        '✔ chain (Simple chain) · fixture · o/r',
        '  3 issues · 1 ready · 2 blocked · 0 unschedulable · 0 external · 2 dependencies · 3 waves',
        '',
      ].join('\n'),
    );
  });

  it('accepts dependencies.body: strict and reads only relation lines', async () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, 'fixture.json'),
      JSON.stringify({
        issues: [
          { owner: 'o', repo: 'r', number: 1, title: 'First', state: 'open' },
          {
            owner: 'o',
            repo: 'r',
            number: 2,
            title: 'Second',
            state: 'open',
            body: 'Blocked by: [#1]',
          },
          {
            owner: 'o',
            repo: 'r',
            number: 3,
            title: 'Third',
            state: 'open',
            body: 'Depends on #1',
          },
        ],
      }),
    );
    const configPath = path.join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'sources:',
        '  - id: fx',
        '    kind: fixture',
        '    path: ./fixture.json',
        '    webUrl: https://fixture.local',
        'views:',
        '  - id: chain',
        '    source: fx',
        '    repos: [o/r]',
        '    dependencies:',
        '      body: strict',
        '',
      ].join('\n'),
    );
    const r = await run(['check', '-c', configPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      '  3 issues · 2 ready · 1 blocked · 0 unschedulable · 0 external · 1 dependencies · 2 waves',
    );
  });

  it('hints when a view has no dependencies', async () => {
    const configPath = writeProject([
      { number: 1, title: 'A' },
      { number: 2, title: 'B' },
    ]);
    const r = await run(['check', '-c', configPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      'hint: No dependencies found. Declare them natively or with `Depends on #N` lines; see docs/PREREQUISITES.md',
    );
  });

  it('uses colours only on a TTY without NO_COLOR', async () => {
    const configPath = writeProject([{ number: 1, title: 'A' }]);
    const tty = await run(['check', '-c', configPath], { isTTY: true });
    expect(tty.stdout).toContain('\u001b[32m✔');
    const noColor = await run(['check', '-c', configPath], { isTTY: true, env: { NO_COLOR: '1' } });
    expect(noColor.stdout).not.toContain('\u001b[');
  });

  it('continues after a fetch failure and exits 1', async () => {
    const configPath = writeProject([{ number: 1, title: 'A' }]);
    const r = await run(['check', '-c', configPath], {
      providerFor: () => ({
        kind: 'fixture',
        listOpenIssues: () => Promise.reject(new Error('boom')),
        getIssue: () => Promise.resolve(null),
      }),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('✖ chain (Simple chain) · fixture');
    expect(r.stdout).toContain('fetch failed: boom');
    const json = await run(['check', '--json', '-c', configPath], {
      providerFor: () => ({
        kind: 'fixture',
        listOpenIssues: () => Promise.reject(new Error('boom')),
        getIssue: () => Promise.resolve(null),
      }),
    });
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout).views[0]).toMatchObject({
      ok: false,
      error: 'boom',
      stats: null,
    });
  });

  it('fails on an unknown view', async () => {
    const r = await run(['check', 'demo', 'x', '-c', 'config.demo.yaml']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('Unknown view "x". Available: demo\n');
  });
});

describe('errors', () => {
  it('reports a missing config file', async () => {
    const r = await run(['views', '-c', 'does-not-exist.yaml']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Config file not found');
    expect(r.stdout).toBe('');
  });

  it('reports an invalid config readably', async () => {
    const dir = tmp();
    const file = path.join(dir, 'bad.yaml');
    writeFileSync(file, 'sources: []\nviews:\n  - id: a\n    source: missing\n    repos: [a/b]\n');
    for (const cmd of [['views'], ['check'], ['plan', 'a']]) {
      const r = await run([...cmd, '-c', file]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('bad.yaml');
      expect(r.stderr).not.toContain('    at ');
    }
  });

  it('reports no configuration at all', async () => {
    const r = await run(['check'], { cwd: tmp() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No configuration found');
  });

  it('prefixes other errors with "Error:"', async () => {
    const r = await run(['plan', 'demo', '-c', 'config.demo.yaml'], {
      providerFor: () => ({
        kind: 'fixture',
        listOpenIssues: () => Promise.reject(new Error('kaput')),
        getIssue: () => Promise.resolve(null),
      }),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('Error: kaput\n');
  });
});

describe('help and version', () => {
  it('--help lists the commands', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    for (const word of ['serve', 'views', 'plan', 'check', '--config']) {
      expect(r.stdout).toContain(word);
    }
  });

  it('plan --help lists the formats', async () => {
    const r = await run(['plan', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--format');
    expect(r.stdout).toContain('mermaid');
    expect(r.stdout).toContain('--out');
  });

  it('--version prints the package version', async () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it('fails on an unknown command', async () => {
    const r = await run(['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('frobnicate');
  });
});

describe('serve', () => {
  it('calls startServer with the config path', async () => {
    const startServer = vi.fn(() => Promise.resolve({} as never));
    const r = await run(['serve', '--config', 'config.demo.yaml'], {
      startServer,
      env: { EV_PORT: '9999' },
    });
    expect(r.code).toBe(0);
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledWith({
      configPath: path.join(ROOT, 'config.demo.yaml'),
      env: { EV_PORT: '9999' },
    });
  });

  it('omits configPath when --config is not given', async () => {
    const startServer = vi.fn(() => Promise.resolve({} as never));
    await run(['serve'], { startServer });
    expect(startServer).toHaveBeenCalledWith({ env: {} });
  });

  it('reports a startup failure', async () => {
    const r = await run(['serve'], {
      startServer: () => Promise.reject(new Error('EADDRINUSE')),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('Error: EADDRINUSE\n');
  });
});
