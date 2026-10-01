import { describe, expect, it } from 'vitest';
import { exporters, isExportFormat, toDot, toJson, toMarkdown, toMermaid } from './index.js';
import type { ExportFormat } from './index.js';
import { escapeDot } from './dot.js';
import { escapeMarkdown } from './markdown.js';
import { escapeMermaidLabel } from './mermaid.js';
import { makeSnapshot, TRICKY_TITLE } from './fixture.test-helpers.js';

const multi = makeSnapshot('acme/lib');
const single = makeSnapshot('acme/api');

describe('exporters registry', () => {
  it('declares content types and extensions', () => {
    expect(
      Object.fromEntries(
        Object.entries(exporters).map(([k, v]) => [k, [v.contentType, v.extension]]),
      ),
    ).toEqual({
      json: ['application/json; charset=utf-8', 'json'],
      md: ['text/markdown; charset=utf-8', 'md'],
      mermaid: ['text/plain; charset=utf-8', 'mmd'],
      dot: ['text/vnd.graphviz; charset=utf-8', 'dot'],
    });
  });

  it('renders through the registry with the named exporters', () => {
    expect(exporters.json.render(multi)).toBe(toJson(multi));
    expect(exporters.md.render(multi)).toBe(toMarkdown(multi));
    expect(exporters.mermaid.render(multi)).toBe(toMermaid(multi));
    expect(exporters.dot.render(multi)).toBe(toDot(multi));
  });

  it('isExportFormat accepts only known formats', () => {
    for (const f of ['json', 'md', 'mermaid', 'dot']) expect(isExportFormat(f)).toBe(true);
    for (const f of ['mmd', 'JSON', '', 'toString', '__proto__', 'constructor']) {
      expect(isExportFormat(f)).toBe(false);
    }
    const f: string = 'md';
    if (isExportFormat(f)) {
      const narrowed: ExportFormat = f;
      expect(narrowed).toBe('md');
    }
  });

  it('is deterministic across calls', () => {
    for (const format of Object.keys(exporters) as ExportFormat[]) {
      const a = exporters[format].render(multi);
      const b = exporters[format].render(makeSnapshot('acme/lib'));
      expect(b).toBe(a);
      expect(exporters[format].render(multi)).toBe(a);
      expect(a.endsWith('\n')).toBe(true);
    }
  });

  it('does not mutate the snapshot', () => {
    const snap = makeSnapshot();
    const before = JSON.stringify(snap);
    for (const format of Object.keys(exporters) as ExportFormat[]) exporters[format].render(snap);
    expect(JSON.stringify(snap)).toBe(before);
  });
});

describe('toJson', () => {
  it('is pretty-printed with a trailing newline and round-trips', () => {
    const out = toJson(multi);
    expect(out).toBe(JSON.stringify(multi, null, 2) + '\n');
    expect(JSON.parse(out)).toEqual(multi);
  });
});

describe('toMarkdown', () => {
  it('matches the snapshot (multi-repo)', () => {
    expect(toMarkdown(multi)).toMatchSnapshot();
  });

  it('matches the snapshot (single repo)', () => {
    expect(toMarkdown(single)).toMatchSnapshot();
  });

  it('has the header, stats and wave sections', () => {
    const lines = toMarkdown(multi).split('\n');
    expect(lines[0]).toBe('# Platform roadmap');
    expect(lines).toContain(
      'View `platform` · fetched 2026-01-02T03:04:05.000Z · hash `0123456789ab`',
    );
    expect(lines).toContain(
      '7 issues · 2 ready · 2 blocked · 3 unschedulable · 1 external · 6 dependencies · 2 waves',
    );
    expect(lines).toContain('## Execution order');
    expect(lines).toContain('### Wave 1');
    expect(lines).toContain('### Wave 2');
    expect(lines).not.toContain('### Wave 0');
    expect(lines).toContain('## Unschedulable');
    expect(lines).toContain('## Cycles');
    expect(lines).toContain('## Warnings');
    expect(lines).toContain('| # | Issue | Title | Priority | Status | Blocked by |');
    expect(lines).toContain('| Issue | Title | Priority | Status | Blocked by |');
  });

  it('numbers positions 1-based and stars the critical path', () => {
    const out = toMarkdown(multi);
    expect(out).toContain('| 1 | [acme/lib#7](https://github.com/acme/lib/issues/7) (external) |');
    expect(out).toContain('| 2 ★ | [acme/api#1](https://github.com/acme/api/issues/1) |');
    expect(out).toContain('| 3 ★ | [acme/api#2](https://github.com/acme/api/issues/2) |');
    expect(out).toContain('| 4 | [acme/api#3](https://github.com/acme/api/issues/3) |');
  });

  it('shows the priority label name, or an empty cell without one', () => {
    const out = toMarkdown(multi);
    const row = (needle: string): string =>
      out.split('\n').find((l) => l.includes(needle) && l.startsWith('|')) ?? '';
    expect(row('[acme/api#1](')).toContain(' | Set up schema | P0 | ready | ');
    expect(row('[acme/api#3](')).toContain(' | Write docs |  | blocked | ');
    expect(row('[acme/api#10](')).toContain(' | Cycle A | P1 | in-cycle | ');
  });

  it('uses #N links when the plan has a single repo', () => {
    const out = toMarkdown(single);
    expect(out).toContain('[#1](https://github.com/acme/api/issues/1)');
    expect(out).toContain('[#99](https://github.com/acme/api/issues/99) (external)');
    expect(out).not.toContain('[acme/api#1]');
    expect(out).toContain('| #1, #99 |');
  });

  it('lists warnings as "- **code**: message" on one line', () => {
    const out = toMarkdown(multi);
    expect(out).toContain('- **cycle**: Dependency cycle between acme/api#10 and acme/api#11');
    expect(out).toContain(
      '- **dangling-reference**: acme/api#2 references acme/api#404 | which does not exist',
    );
  });

  it('escapes pipes, brackets, angle brackets and newlines in cells', () => {
    const out = toMarkdown(multi);
    const row = out.split('\n').find((l) => l.includes('acme/api#2') && l.startsWith('| 3'));
    expect(row).toBeDefined();
    expect(row).toContain('Fix "login" \\| SSO \\[wip\\] #42 &lt;b&gt;');
    // Exactly 6 unescaped column separators plus the closing one.
    expect(row!.replace(/\\\|/g, '').match(/\|/g)).toHaveLength(7);
    expect(escapeMarkdown('a|b\nc\r\nd')).toBe('a\\|b c d');
    expect(escapeMarkdown('a\\b `c` *d* _e_')).toBe('a\\\\b \\`c\\` \\*d\\* \\_e\\_');
  });

  it('omits empty sections', () => {
    const snap = makeSnapshot();
    snap.plan = {
      ...snap.plan,
      unschedulable: [],
      cycles: [],
      warnings: [],
      waves: [],
      order: [],
    };
    const out = toMarkdown(snap);
    expect(out).not.toContain('## Unschedulable');
    expect(out).not.toContain('## Cycles');
    expect(out).not.toContain('## Warnings');
    expect(out).toContain('_No schedulable issues._');
  });
});

describe('toMermaid', () => {
  it('matches the snapshot (multi-repo)', () => {
    expect(toMermaid(multi)).toMatchSnapshot();
  });

  it('matches the snapshot (single repo)', () => {
    expect(toMermaid(single)).toMatchSnapshot();
  });

  it('sanitizes node ids and orders nodes by plan.order then unschedulable', () => {
    const lines = toMermaid(multi).split('\n');
    expect(lines[0]).toBe('flowchart LR');
    const ids = lines
      .filter((l) => /^ {2}n_\S+\["/.test(l))
      .map((l) => /^ {2}(n_\S+)\[/.exec(l)![1]);
    expect(ids).toEqual([
      'n_acme_lib_7',
      'n_acme_api_1',
      'n_acme_api_2',
      'n_acme_api_3',
      'n_acme_api_10',
      'n_acme_api_11',
      'n_acme_api_12',
    ]);
    for (const id of ids) expect(id).toMatch(/^n_[A-Za-z0-9_]+$/);
  });

  it('keeps ids unique when sanitizing collides', () => {
    const snap = makeSnapshot();
    snap.plan.nodes = snap.plan.nodes.map((n) =>
      n.number === 1 ? { ...n, key: 'a-b/c#1', repo: { owner: 'a-b', repo: 'c' } } : n,
    );
    snap.plan.order = snap.plan.order.map((k) => (k === 'acme/api#1' ? 'a-b/c#1' : k));
    snap.plan.nodes.push({
      ...snap.plan.nodes[0]!,
      key: 'a/b-c#1',
      repo: { owner: 'a', repo: 'b-c' },
      number: 1,
    });
    snap.plan.order.push('a/b-c#1');
    const ids = toMermaid(snap)
      .split('\n')
      .filter((l) => /^ {2}n_\S+\["/.test(l))
      .map((l) => /^ {2}(n_\S+)\[/.exec(l)![1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('n_a_b_c_1');
    expect(ids).toContain('n_a_b_c_1_2');
  });

  it('escapes the awkward title characters', () => {
    const out = toMermaid(multi);
    expect(out).toContain(
      '  n_acme_api_2["acme/api#35;2 Fix #quot;login#quot; #124; SSO #91;wip#93; #35;42 #lt;b#gt;"]',
    );
    // No raw label-breaking characters survive inside any node label.
    for (const line of out.split('\n')) {
      const m = /^ {2}n_\S+\["(.*)"\]$/.exec(line);
      if (m) expect(m[1]).not.toMatch(/["[\]<>{}|]/);
    }
  });

  it('escapes every special character with the documented entity', () => {
    expect(escapeMermaidLabel('"')).toBe('#quot;');
    expect(escapeMermaidLabel('#')).toBe('#35;');
    expect(escapeMermaidLabel('[]')).toBe('#91;#93;');
    expect(escapeMermaidLabel('<>')).toBe('#lt;#gt;');
    expect(escapeMermaidLabel('{}')).toBe('#123;#125;');
    expect(escapeMermaidLabel('|')).toBe('#124;');
    expect(escapeMermaidLabel('a\nb')).toBe('a b');
    // Entities produced for one character are not re-escaped.
    expect(escapeMermaidLabel('"#')).toBe('#quot;#35;');
  });

  it('uses #N labels for single-repo plans', () => {
    const out = toMermaid(single);
    expect(out).toContain('n_acme_api_1["#35;1 Set up schema"]');
    expect(out).toContain('n_acme_api_99["#35;99 Upstream library release"]');
  });

  it('emits classDefs, class lines, click lines and edges in order', () => {
    const lines = toMermaid(multi).split('\n');
    for (const c of ['ready', 'blocked', 'inCycle', 'blockedByCycle', 'external']) {
      expect(lines.some((l) => l.startsWith(`  classDef ${c} `))).toBe(true);
    }
    expect(lines.find((l) => l.startsWith('  classDef external'))).toContain('stroke-dasharray');
    expect(lines).toContain('  class n_acme_api_1,n_acme_lib_7 ready');
    expect(lines).toContain('  class n_acme_api_2,n_acme_api_3 blocked');
    expect(lines).toContain('  class n_acme_api_10,n_acme_api_11 inCycle');
    expect(lines).toContain('  class n_acme_api_12 blockedByCycle');
    expect(lines).toContain('  class n_acme_lib_7 external');
    expect(lines).toContain(
      '  click n_acme_api_1 href "https://github.com/acme/api/issues/1" _blank',
    );
    expect(lines.filter((l) => l.startsWith('  click ')).length).toBe(7);
    const edges = lines.filter((l) => l.includes(' --> '));
    expect(edges).toEqual([
      '  n_acme_api_1 --> n_acme_api_2',
      '  n_acme_api_1 --> n_acme_api_3',
      '  n_acme_api_10 --> n_acme_api_11',
      '  n_acme_api_11 --> n_acme_api_10',
      '  n_acme_api_11 --> n_acme_api_12',
      '  n_acme_lib_7 --> n_acme_api_3',
    ]);
  });
});

describe('toDot', () => {
  it('matches the snapshot (multi-repo)', () => {
    expect(toDot(multi)).toMatchSnapshot();
  });

  it('matches the snapshot (single repo)', () => {
    expect(toDot(single)).toMatchSnapshot();
  });

  it('has the digraph header, wave subgraphs and an unschedulable subgraph', () => {
    const out = toDot(multi);
    const lines = out.split('\n');
    expect(lines[0]).toBe('digraph "execution-view" {');
    expect(lines).toContain('  rankdir=LR;');
    expect(lines).toContain('  node [shape=box, style="rounded,filled"];');
    expect(lines).toContain('  subgraph "wave_1" {');
    expect(lines).toContain('  subgraph "wave_2" {');
    expect(lines).toContain('  subgraph "unschedulable" {');
    expect(out.match(/rank=same;/g)).toHaveLength(3);
    expect(lines.at(-2)).toBe('}');
  });

  it('marks external nodes dashed and links every node', () => {
    const out = toDot(multi);
    const ext = out.split('\n').find((l) => l.includes('"acme/lib#7" ['))!;
    expect(ext).toContain('style="rounded,filled,dashed"');
    expect(ext).toContain('URL="https://github.com/acme/lib/issues/7"');
    expect(out.match(/dashed/g)).toHaveLength(1);
    expect(out.match(/URL=/g)).toHaveLength(7);
  });

  it('escapes quotes and backslashes in labels', () => {
    const out = toDot(multi);
    expect(out).toContain('label="acme/api#2 Fix \\"login\\" | SSO [wip] #42 <b>"');
    expect(escapeDot('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    const snap = makeSnapshot();
    snap.plan.nodes = snap.plan.nodes.map((n) =>
      n.number === 3 ? { ...n, title: 'back\\slash "q"' } : n,
    );
    expect(toDot(snap)).toContain('label="acme/api#3 back\\\\slash \\"q\\""');
  });

  it('emits edges in plan.edges order', () => {
    const edges = toDot(multi)
      .split('\n')
      .filter((l) => l.includes(' -> '));
    expect(edges).toEqual([
      '  "acme/api#1" -> "acme/api#2";',
      '  "acme/api#1" -> "acme/api#3";',
      '  "acme/api#10" -> "acme/api#11";',
      '  "acme/api#11" -> "acme/api#10";',
      '  "acme/api#11" -> "acme/api#12";',
      '  "acme/lib#7" -> "acme/api#3";',
    ]);
  });

  it('uses #N labels for single-repo plans', () => {
    expect(toDot(single)).toContain('label="#1 Set up schema"');
  });
});

describe('fixture sanity', () => {
  it('contains the tricky title', () => {
    expect(TRICKY_TITLE).toMatch(/"/);
    expect(TRICKY_TITLE).toMatch(/\|/);
    expect(TRICKY_TITLE).toMatch(/\[/);
    expect(TRICKY_TITLE).toMatch(/#/);
    expect(TRICKY_TITLE).toMatch(/</);
  });
});
