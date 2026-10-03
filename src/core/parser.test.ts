import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYWORDS, parseBodyRelations, type ParseOptions } from './parser.js';
import type { RawRelation } from './types.js';

/** Compact relation notation: "b:#12", "k:o/r#3", "p:#7" (b = blocked-by, k = blocks, p = parent). */
function rel(spec: string): RawRelation {
  const m = /^([bkp]):(?:([^#/]+)\/([^#/]+))?#(\d+)$/.exec(spec);
  if (!m) throw new Error(`bad spec ${spec}`);
  return {
    kind: m[1] === 'b' ? 'blocked-by' : m[1] === 'k' ? 'blocks' : 'parent',
    ref: {
      owner: m[2] ?? null,
      repo: m[3] ?? null,
      number: Number(m[4]),
    },
    source: 'body',
  };
}

interface Case {
  name: string;
  body: string;
  expected: string[];
  options?: ParseOptions;
}

function run(cases: Case[]): void {
  it.each(cases)('$name', ({ body, expected, options }) => {
    expect(parseBodyRelations(body, options)).toEqual(expected.map(rel));
  });
}

const HOSTS: ParseOptions = { webHosts: ['github.com'] };

describe('DEFAULT_KEYWORDS', () => {
  it('matches the contract', () => {
    expect(DEFAULT_KEYWORDS).toEqual({
      blockedBy: ['depends on', 'blocked by', 'requires', 'dependencies'],
      blocks: ['blocks', 'blocking', 'required by'],
    });
  });
});

describe('rule 1: keyword lines', () => {
  run([
    {
      name: 'plain keyword line with several refs',
      body: 'Depends on #12, #13',
      expected: ['b:#12', 'b:#13'],
    },
    {
      name: 'keyword is case-insensitive',
      body: 'DEPENDS ON #1\nbLoCkEd By #2',
      expected: ['b:#1', 'b:#2'],
    },
    { name: 'colon after keyword', body: 'Depends on: #4', expected: ['b:#4'] },
    {
      name: 'list marker dash with cross-repo ref',
      body: '- Blocked by: owner/repo#4',
      expected: ['b:owner/repo#4'],
    },
    { name: 'list marker star', body: '* requires #5', expected: ['b:#5'] },
    { name: 'list marker plus', body: '+ requires #5', expected: ['b:#5'] },
    { name: 'numbered list marker', body: '1. Requires #6', expected: ['b:#6'] },
    { name: 'multi-digit numbered marker', body: '12. Requires #6', expected: ['b:#6'] },
    { name: 'leading whitespace', body: '    \t Depends on #7', expected: ['b:#7'] },
    { name: 'indented list item', body: '  - Depends on #7', expected: ['b:#7'] },
    { name: 'bold keyword with colon inside', body: '**Blocks:** #20', expected: ['k:#20'] },
    { name: 'bold keyword with colon outside', body: '**Blocks**: #20', expected: ['k:#20'] },
    { name: 'underscore emphasis', body: '__Blocked by__ #21', expected: ['b:#21'] },
    {
      name: 'unchecked task checkbox',
      body: '- [ ] requires https://github.com/o/r/issues/9',
      expected: ['b:o/r#9'],
      options: HOSTS,
    },
    { name: 'checked task checkbox (x)', body: '- [x] Depends on #3', expected: ['b:#3'] },
    { name: 'checked task checkbox (X)', body: '- [X] Depends on #3', expected: ['b:#3'] },
    { name: 'checkbox then emphasis', body: '- [ ] **Depends on:** #3', expected: ['b:#3'] },
    { name: 'blocks keyword', body: 'Blocks #8', expected: ['k:#8'] },
    { name: 'blocking keyword', body: 'Blocking: #8', expected: ['k:#8'] },
    { name: 'multi-word keyword: required by', body: 'Required by #9', expected: ['k:#9'] },
    { name: 'multi-word keyword with extra spaces', body: 'depends   on #9', expected: ['b:#9'] },
    {
      name: 'every ref on the rest of the line counts',
      body: 'Blocked by #1 and #2, also o/r#3 (#4)',
      expected: ['b:#1', 'b:#2', 'b:#4', 'b:o/r#3'],
    },
    {
      name: 'keyword followed directly by the ref',
      body: 'blocks#3 is not a keyword line but blocks #3 is',
      expected: ['k:#3'],
    },
    {
      name: 'only lines that start with the keyword count',
      body: 'Depends on #1\nsee also #2',
      expected: ['b:#1'],
    },
    { name: 'no refs on a keyword line', body: 'Depends on nothing', expected: [] },
    { name: 'empty body', body: '', expected: [] },
    { name: 'blocksize #3 does not match blocks', body: 'blocksize #3', expected: [] },
    { name: 'requirements does not match requires', body: 'Requirements: #3', expected: [] },
    { name: 'blocks_x does not match blocks', body: 'blocks_x #3', expected: [] },
    {
      name: 'longest keyword first: blocked by is not blocks',
      body: 'Blocked by #1',
      expected: ['b:#1'],
    },
    {
      name: 'longest keyword first: required by beats requires',
      body: 'required by #1',
      expected: ['k:#1'],
    },
    {
      name: 'longest keyword wins over a shorter prefix keyword',
      body: 'blocks on #1',
      expected: ['b:#1'],
      options: { keywords: { blockedBy: ['blocks on'], blocks: ['blocks'] } },
    },
  ]);
});

describe('rule 2: section form', () => {
  run([
    {
      name: 'heading section with list items',
      body: '## Depends on\n- #1\n- #2, o/r#3\n',
      expected: ['b:#1', 'b:#2', 'b:o/r#3'],
    },
    { name: 'blocks section', body: '### Blocks\n* #10\n', expected: ['k:#10'] },
    { name: 'heading with trailing colon', body: '## Blocked by:\n- #1', expected: ['b:#1'] },
    { name: 'heading with emphasis', body: '## **Blocked by**\n- #1', expected: ['b:#1'] },
    {
      name: 'heading with emphasis and colon',
      body: '## **Blocked by:**\n- #1',
      expected: ['b:#1'],
    },
    { name: 'heading is case-insensitive', body: '# REQUIRES\n- #1', expected: ['b:#1'] },
    { name: 'h6 heading', body: '###### Blocks\n- #1', expected: ['k:#1'] },
    { name: 'heading with closing hashes', body: '## Blocks ##\n- #1', expected: ['k:#1'] },
    {
      name: 'numbered and nested list items',
      body: '## Requires\n1. #1\n   - #2\n',
      expected: ['b:#1', 'b:#2'],
    },
    {
      name: 'task list items under a section',
      body: '## Depends on\n- [ ] #1\n- [x] #2',
      expected: ['b:#1', 'b:#2'],
    },
    {
      name: 'blank lines do not end the section',
      body: '## Depends on\n\n- #1\n\n- #2',
      expected: ['b:#1', 'b:#2'],
    },
    {
      name: 'section ended by the next heading of any level',
      body: '## Depends on\n- #1\n### Notes\n- #2\n',
      expected: ['b:#1'],
    },
    {
      name: 'section ended by a higher-level heading',
      body: '### Blocks\n- #1\n# Other\n- #2\n',
      expected: ['k:#1'],
    },
    {
      name: 'section ended by another keyword heading switches kind',
      body: '## Depends on\n- #1\n## Blocks\n- #2\n',
      expected: ['b:#1', 'k:#2'],
    },
    {
      name: 'non-list line under a section is ignored',
      body: '## Depends on\nsee #1\n- #2\nalso #3',
      expected: ['b:#2'],
    },
    { name: 'list items before any heading are ignored', body: '- #1\n- #2', expected: [] },
    {
      name: 'list items under a non-keyword heading are ignored',
      body: '## Notes\n- #1',
      expected: [],
    },
    {
      name: 'heading text must equal the keyword',
      body: '## Depends on things\n- #1',
      expected: [],
    },
    {
      name: '#123 at line start is not a heading',
      body: '## Depends on\n#5\n- #6',
      expected: ['b:#6'],
    },
    {
      name: 'seven hashes are not a heading',
      body: '## Depends on\n- #1\n####### Foo\n- #2',
      expected: ['b:#1', 'b:#2'],
    },
    {
      name: 'an explicit keyword line under a section keeps its own kind',
      body: '## Depends on\n- Blocks #1\n- #2',
      expected: ['b:#2', 'k:#1'],
    },
    {
      name: 'blockquote under a section is ignored',
      body: '## Depends on\n> - #1\n- #2',
      expected: ['b:#2'],
    },
    {
      name: 'a blockquote does not end a section',
      body: '## Depends on\n> quote\n- #2',
      expected: ['b:#2'],
    },
    {
      name: 'a code fence does not end a section',
      body: '## Depends on\n```\ncode\n```\n- #2',
      expected: ['b:#2'],
    },
    {
      name: 'a heading inside a code fence does not end a section',
      body: '## Depends on\n```\n# Title\n```\n- #2',
      expected: ['b:#2'],
    },
    {
      name: 'section keywords follow custom config',
      body: '## Prerequisites\n- #1\n## Depends on\n- #2',
      expected: ['b:#1'],
      options: { keywords: { blockedBy: ['prerequisites'], blocks: [] } },
    },
  ]);
});

describe('rule 3: reference forms', () => {
  run([
    { name: '#123', body: 'Blocks #123', expected: ['k:#123'] },
    { name: 'owner/repo#123', body: 'Blocks acme/api#123', expected: ['k:acme/api#123'] },
    { name: 'owner/repo is lowercased', body: 'Blocks Acme/API#5', expected: ['k:acme/api#5'] },
    {
      name: 'owner/repo chars: digits, dash, underscore, dot',
      body: 'Blocks a-1/b_2.x#5',
      expected: ['k:a-1/b_2.x#5'],
    },
    { name: 'same-repo refs have null owner and repo', body: 'Blocks #5', expected: ['k:#5'] },
    {
      name: 'URL on an allowed host',
      body: 'Depends on https://github.com/Acme/Api/issues/9',
      expected: ['b:acme/api#9'],
      options: HOSTS,
    },
    {
      name: 'http URL and case-insensitive host',
      body: 'Depends on http://GitHub.COM/o/r/issues/9',
      expected: ['b:o/r#9'],
      options: HOSTS,
    },
    {
      name: 'configured host casing does not matter',
      body: 'Depends on https://github.com/o/r/issues/9',
      expected: ['b:o/r#9'],
      options: { webHosts: ['GitHub.com'] },
    },
    {
      name: 'URL host with port matches exactly as configured',
      body: 'Depends on http://gitea.local:3000/o/r/issues/9',
      expected: ['b:o/r#9'],
      options: { webHosts: ['gitea.local:3000'] },
    },
    {
      name: 'URL host with port does not match a host configured without a port',
      body: 'Depends on http://gitea.local:3000/o/r/issues/9',
      expected: [],
      options: { webHosts: ['gitea.local'] },
    },
    {
      name: 'URL host without port does not match a host configured with a port',
      body: 'Depends on http://gitea.local/o/r/issues/9',
      expected: [],
      options: { webHosts: ['gitea.local:3000'] },
    },
    {
      name: 'URL on a non-allowed host is ignored',
      body: 'Depends on https://gitlab.com/o/r/issues/9',
      expected: [],
      options: HOSTS,
    },
    {
      name: 'URLs are ignored without webHosts',
      body: 'Depends on https://github.com/o/r/issues/9',
      expected: [],
    },
    {
      name: 'URLs are ignored with empty webHosts',
      body: 'Depends on https://github.com/o/r/issues/9',
      expected: [],
      options: { webHosts: [] },
    },
    {
      name: 'URL fragment counts as the issue only (no double counting)',
      body: 'Depends on https://github.com/o/r/issues/5#issuecomment-1',
      expected: ['b:o/r#5'],
      options: HOSTS,
    },
    {
      name: 'URL with a numeric fragment is not double counted',
      body: 'Depends on https://github.com/o/r/issues/5#3',
      expected: ['b:o/r#5'],
      options: HOSTS,
    },
    {
      name: 'URL to a pull request path is not an issue ref',
      body: 'Depends on https://github.com/o/r/pull/5',
      expected: [],
      options: HOSTS,
    },
    {
      name: 'URL with a non-allowed host and the same ref as # are separate',
      body: 'Depends on https://gitlab.com/o/r/issues/5 #6',
      expected: ['b:#6'],
      options: HOSTS,
    },
    { name: 'abc#12 is not a ref', body: 'Depends on abc#12', expected: [] },
    { name: 'path/#12 is not a ref', body: 'Depends on path/#12', expected: [] },
    { name: 'x#12 followed by a valid ref', body: 'Depends on x#12 #13', expected: ['b:#13'] },
    {
      name: 'owner/repo#12 is not also counted as #12',
      body: 'Depends on o/r#12',
      expected: ['b:o/r#12'],
    },
    {
      name: 'owner/repo# preceded by a word char is one ref',
      body: 'Depends on xo/r#12',
      expected: ['b:xo/r#12'],
    },
    { name: '#12abc is not a ref', body: 'Depends on #12abc', expected: [] },
    { name: 'issue number 0 is ignored', body: 'Depends on #0, #1', expected: ['b:#1'] },
    {
      name: 'issue number 0 is ignored in owner/repo form',
      body: 'Depends on o/r#0',
      expected: [],
    },
    { name: 'leading zeros are numeric', body: 'Depends on #007', expected: ['b:#7'] },
    {
      name: 'unsafe huge numbers are ignored',
      body: 'Depends on #99999999999999999999, #2',
      expected: ['b:#2'],
    },
    {
      name: 'ref after punctuation',
      body: 'Depends on (#12), [#13];#14.',
      expected: ['b:#12', 'b:#13', 'b:#14'],
    },
    { name: 'ref after a colon', body: 'Depends on:#12', expected: ['b:#12'] },
    {
      name: 'URL in a section list item',
      body: '## Blocks\n- https://github.com/o/r/issues/3',
      expected: ['k:o/r#3'],
      options: HOSTS,
    },
  ]);
});

describe('rule 4: ignored regions', () => {
  run([
    { name: 'backtick fence', body: '```\nDepends on #1\n```\nDepends on #2', expected: ['b:#2'] },
    { name: 'tilde fence', body: '~~~\nDepends on #1\n~~~\nDepends on #2', expected: ['b:#2'] },
    {
      name: 'fence with info string',
      body: '```md\nDepends on #1\n```\nBlocks #2',
      expected: ['k:#2'],
    },
    { name: 'indented fence', body: '  ```\nDepends on #1\n  ```\nBlocks #2', expected: ['k:#2'] },
    {
      name: 'longer opening fence is not closed by a shorter one',
      body: '````\nDepends on #1\n```\nDepends on #2\n````\nDepends on #3',
      expected: ['b:#3'],
    },
    {
      name: 'a longer closing fence closes',
      body: '```\nDepends on #1\n`````\nDepends on #2',
      expected: ['b:#2'],
    },
    {
      name: 'a tilde fence is not closed by backticks',
      body: '~~~\nDepends on #1\n```\nDepends on #2\n~~~\nDepends on #3',
      expected: ['b:#3'],
    },
    {
      name: 'a backtick fence is not closed by tildes',
      body: '```\nDepends on #1\n~~~\nDepends on #2\n```\nDepends on #3',
      expected: ['b:#3'],
    },
    {
      name: 'a closing fence cannot have an info string',
      body: '```\nDepends on #1\n```js\nDepends on #2\n```\nDepends on #3',
      expected: ['b:#3'],
    },
    {
      name: 'an unclosed fence runs to the end',
      body: 'Depends on #1\n```\nDepends on #2\nDepends on #3',
      expected: ['b:#1'],
    },
    {
      name: 'a one-line triple backtick span is not a fence',
      body: '```Depends on #1``` and\nBlocks #2',
      expected: ['k:#2'],
    },
    { name: 'inline code around the ref', body: 'Depends on `#1`, #2', expected: ['b:#2'] },
    { name: 'inline code around the whole line', body: '`Depends on #1`', expected: [] },
    {
      name: 'inline code with double backticks',
      body: 'Depends on ``a ` #1``, #2',
      expected: ['b:#2'],
    },
    {
      name: 'inline code at line start defeats the keyword',
      body: '`x` depends on #1',
      expected: [],
    },
    { name: 'an unmatched backtick is literal', body: 'Depends on ` #1', expected: ['b:#1'] },
    {
      name: 'single-line HTML comment',
      body: '<!-- Depends on #1 -->\nDepends on #2',
      expected: ['b:#2'],
    },
    {
      name: 'HTML comment inside a keyword line',
      body: 'Depends on <!-- #1 --> #2',
      expected: ['b:#2'],
    },
    {
      name: 'multi-line HTML comment',
      body: 'Depends on #5\n<!--\nDepends on #1\nBlocks #2\n-->\nDepends on #3',
      expected: ['b:#3', 'b:#5'],
    },
    {
      name: 'text after a closing comment marker still counts',
      body: '<!--\nnote\n--> Depends on #4',
      expected: ['b:#4'],
    },
    {
      name: 'an unclosed HTML comment runs to the end',
      body: 'Depends on #1\n<!-- Depends on #2\nDepends on #3',
      expected: ['b:#1'],
    },
    {
      name: 'a fence marker inside a comment is not a fence',
      body: '<!--\n```\n-->\nDepends on #1',
      expected: ['b:#1'],
    },
    {
      name: 'a comment marker inside a fence is code',
      body: '```\n<!--\n```\nDepends on #1',
      expected: ['b:#1'],
    },
    {
      name: 'a comment marker inside inline code is code',
      body: 'Depends on `<!--` #1',
      expected: ['b:#1'],
    },
    { name: 'blockquote line', body: '> Depends on #1\nDepends on #2', expected: ['b:#2'] },
    { name: 'blockquote line without a space', body: '>Depends on #1', expected: [] },
    { name: 'indented blockquote line', body: '  > Blocks #1', expected: [] },
    { name: 'nested blockquote line', body: '> > Blocks #1', expected: [] },
    { name: 'blockquote inside a list item', body: '- > Blocks #1', expected: [] },
    {
      name: 'a fence inside a blockquote is not a fence',
      body: '> ```\nDepends on #1',
      expected: ['b:#1'],
    },
  ]);
});

describe('rule 5: prose is ignored', () => {
  run([
    { name: 'mid-sentence depends on', body: 'This depends on #3', expected: [] },
    { name: 'mid-sentence blocked by', body: 'We are blocked by #3 for now.', expected: [] },
    { name: 'a keyword later in a list item', body: '- see: depends on #3', expected: [] },
    { name: 'a keyword after other text', body: 'Note: Blocks #3', expected: [] },
    { name: 'a bare reference', body: 'See #3 and o/r#4', expected: [] },
    { name: 'an issue-closing keyword is not a relation', body: 'Fixes #3', expected: [] },
    {
      name: 'prose line followed by a keyword line',
      body: 'This depends on #3\nDepends on #4',
      expected: ['b:#4'],
    },
  ]);
});

describe('rule 6: output', () => {
  run([
    {
      name: 'unique within a kind',
      body: 'Depends on #1, #1, #1\nRequires #1',
      expected: ['b:#1'],
    },
    {
      name: 'same ref in both kinds is kept twice',
      body: 'Depends on #1\nBlocks #1',
      expected: ['b:#1', 'k:#1'],
    },
    {
      name: 'the same ref written two ways is unique',
      body: 'Depends on o/r#1, O/R#1, https://github.com/o/r/issues/1',
      expected: ['b:o/r#1'],
      options: HOSTS,
    },
    {
      name: 'a same-repo ref and an explicit ref are different',
      body: 'Depends on #1, o/r#1',
      expected: ['b:#1', 'b:o/r#1'],
    },
    {
      name: 'blocked-by sorts before blocks regardless of input order',
      body: 'Blocks #1\nDepends on #9',
      expected: ['b:#9', 'k:#1'],
    },
    {
      name: 'sorted numerically, not lexically',
      body: 'Depends on #10, #9, #100, #2',
      expected: ['b:#2', 'b:#9', 'b:#10', 'b:#100'],
    },
    {
      name: 'same-repo refs sort before cross-repo refs, then by owner/repo then number',
      body: 'Depends on z/a#1, b/b#5, b/a#7, #50, b/a#3, B/A#2',
      expected: ['b:#50', 'b:b/a#2', 'b:b/a#3', 'b:b/a#7', 'b:b/b#5', 'b:z/a#1'],
    },
    {
      name: 'sorted by code unit, not by locale',
      body: 'Depends on a/B#1, a/_b#1, a/a#1',
      expected: ['b:a/_b#1', 'b:a/a#1', 'b:a/b#1'].sort(),
    },
    {
      name: 'both kinds sorted independently',
      body: 'Blocks #3, #1\nRequires #7, #2',
      expected: ['b:#2', 'b:#7', 'k:#1', 'k:#3'],
    },
    {
      name: 'refs from several lines and sections are merged',
      body: 'Blocks #5\n## Depends on\n- #4\n- o/r#1\nRequires #3',
      expected: ['b:#3', 'b:#4', 'b:o/r#1', 'k:#5'],
    },
  ]);

  it('sets source to body on every relation', () => {
    const out = parseBodyRelations('Depends on #1\nBlocks #2');
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.source === 'body')).toBe(true);
  });

  it('is deterministic and does not mutate options', () => {
    const options: ParseOptions = {
      keywords: { blockedBy: ['needs'], blocks: ['unblocks'] },
      webHosts: ['github.com'],
    };
    const snapshot = JSON.stringify(options);
    const body = 'Needs #3, #1\nUnblocks #2';
    expect(parseBodyRelations(body, options)).toEqual(parseBodyRelations(body, options));
    expect(JSON.stringify(options)).toBe(snapshot);
  });
});

describe('custom keywords', () => {
  const custom: ParseOptions = {
    keywords: { blockedBy: ['needs', 'after'], blocks: ['unblocks', 'before'] },
  };
  run([
    {
      name: 'custom keywords match',
      body: 'Needs #1\nUnblocks #2\nBefore: #3\nAFTER #4',
      expected: ['b:#1', 'b:#4', 'k:#2', 'k:#3'],
      options: custom,
    },
    {
      name: 'default keywords are not used when custom ones are set',
      body: 'Depends on #1\nBlocks #2',
      expected: [],
      options: custom,
    },
    {
      name: 'custom keyword sections',
      body: '## Needs\n- #1',
      expected: ['b:#1'],
      options: custom,
    },
    {
      name: 'custom keywords with regex metacharacters are literal',
      body: 'a.b #1\naxb #2\nc++ #3',
      expected: ['b:#1', 'b:#3'],
      options: { keywords: { blockedBy: ['a.b', 'c++'], blocks: [] } },
    },
    {
      name: 'custom keywords are matched case-insensitively however configured',
      body: 'needs #1',
      expected: ['b:#1'],
      options: { keywords: { blockedBy: ['NEEDS'], blocks: [] } },
    },
    {
      name: 'a keyword configured as blocks only',
      body: 'Depends on #1\nBlocks #2',
      expected: ['k:#2'],
      options: { keywords: { blockedBy: [], blocks: ['blocks'] } },
    },
    {
      name: 'an empty blockedBy list never matches blocked-by',
      body: 'Depends on #1\nBlocks #2\n## Depends on\n- #3',
      expected: ['k:#2'],
      options: { keywords: { blockedBy: [], blocks: DEFAULT_KEYWORDS.blocks } },
    },
    {
      name: 'an empty blocks list never matches blocks',
      body: 'Depends on #1\nBlocks #2\n## Blocks\n- #3',
      expected: ['b:#1'],
      options: { keywords: { blockedBy: DEFAULT_KEYWORDS.blockedBy, blocks: [] } },
    },
    {
      name: 'both lists empty match nothing',
      body: 'Depends on #1\nBlocks #2',
      expected: [],
      options: { keywords: { blockedBy: [], blocks: [] } },
    },
    {
      name: 'blank keywords never match',
      body: '#1\n  #2\n- #3',
      expected: [],
      options: { keywords: { blockedBy: ['', '  '], blocks: [''] } },
    },
    {
      name: 'a keyword configured in both lists is blocked-by',
      body: 'Ties #1',
      expected: ['b:#1'],
      options: { keywords: { blockedBy: ['ties'], blocks: ['ties'] } },
    },
    {
      name: 'undefined keywords fall back to the defaults',
      body: 'Depends on #1',
      expected: ['b:#1'],
      options: { keywords: undefined },
    },
    { name: 'no options at all uses the defaults', body: 'Depends on #1', expected: ['b:#1'] },
  ]);
});

describe('CRLF and other line endings', () => {
  run([
    {
      name: 'CRLF keyword lines',
      body: 'Depends on #1\r\nBlocks #2\r\n',
      expected: ['b:#1', 'k:#2'],
    },
    {
      name: 'CRLF section',
      body: '## Depends on\r\n- #1\r\n- #2\r\n## Notes\r\n- #3\r\n',
      expected: ['b:#1', 'b:#2'],
    },
    {
      name: 'CRLF fence',
      body: '```\r\nDepends on #1\r\n```\r\nDepends on #2\r\n',
      expected: ['b:#2'],
    },
    {
      name: 'CRLF multi-line comment',
      body: '<!--\r\nDepends on #1\r\n-->\r\nDepends on #2',
      expected: ['b:#2'],
    },
    { name: 'CRLF blockquote', body: '> Depends on #1\r\nDepends on #2', expected: ['b:#2'] },
    {
      name: 'CRLF section heading with trailing carriage return',
      body: '## Depends on\r\n- #7',
      expected: ['b:#7'],
    },
    {
      name: 'mixed line endings',
      body: 'Depends on #1\rBlocks #2\nRequires #3\r\n',
      expected: ['b:#1', 'b:#3', 'k:#2'],
    },
  ]);
});

describe('default keyword: dependencies', () => {
  run([
    {
      name: '## Dependencies section with list items',
      body: '## Dependencies\n- #1\n- [ ] o/r#2\n',
      expected: ['b:#1', 'b:o/r#2'],
    },
    {
      name: '## Dependencies with trailing colon',
      body: '## Dependencies:\n- #1',
      expected: ['b:#1'],
    },
    {
      name: '## Dependencies with bold and colon',
      body: '## **Dependencies:**\n- #1',
      expected: ['b:#1'],
    },
    { name: 'heading is case-insensitive', body: '### DEPENDENCIES\n- #1', expected: ['b:#1'] },
    { name: 'line form', body: 'Dependencies: #3', expected: ['b:#3'] },
    {
      name: 'list item line form',
      body: '- Dependencies: #3, o/r#4',
      expected: ['b:#3', 'b:o/r#4'],
    },
    { name: 'line form is case-insensitive', body: 'dEpEnDeNcIeS #3', expected: ['b:#3'] },
    { name: 'bold line form', body: '**Dependencies:** #3', expected: ['b:#3'] },
    { name: 'word boundary: dependenciesfoo', body: 'Dependenciesfoo #3', expected: [] },
    { name: 'word boundary: dependencies_x', body: 'Dependencies_x #3', expected: [] },
    {
      name: 'heading must equal the keyword: dependenciesfoo',
      body: '## Dependenciesfoo\n- #1',
      expected: [],
    },
    { name: 'the singular is not a default keyword', body: 'Dependency: #3', expected: [] },
    {
      name: 'the singular heading is not a default keyword',
      body: '## Dependency\n- #1',
      expected: [],
    },
    { name: 'mid-sentence prose is ignored', body: 'See dependencies: #3', expected: [] },
    {
      name: 'a section ends at the next heading',
      body: '## Dependencies\n- #1\n## Notes\n- #2',
      expected: ['b:#1'],
    },
    {
      name: 'custom keywords replace the default, including dependencies',
      body: '## Dependencies\n- #1\nDependencies: #2',
      expected: [],
      options: { keywords: { blockedBy: ['needs'], blocks: [] } },
    },
  ]);
});

describe('relation lines', () => {
  run([
    {
      name: 'blocked by with a list marker and several refs',
      body: '- Blocked by: [#76, #77]',
      expected: ['b:#76', 'b:#77'],
    },
    {
      name: 'parent with a task checkbox',
      body: '* [x] Parent: [owner/repo#12]',
      expected: ['p:owner/repo#12'],
    },
    {
      name: 'keywords are case-insensitive',
      body: 'BLOCKED BY: [#1]\nparent: [#2]',
      expected: ['b:#1', 'p:#2'],
    },
    {
      name: 'an issue URL on the source web host is accepted',
      body: 'Parent: [https://github.com/o/r/issues/9]',
      expected: ['p:o/r#9'],
      options: HOSTS,
    },
    {
      name: 'a note after the brackets is ignored, in every mode',
      body: 'Blocked by: [puglab/cortex#12] needs the new API first (#99)',
      expected: ['b:puglab/cortex#12'],
    },
    {
      name: 'a reference outside the brackets is ignored',
      body: 'Parent: [#71] and also #72',
      expected: ['p:#71'],
    },
    {
      name: 'a URL on another host is ignored',
      body: 'Blocked by: [https://other.example/o/r/issues/9]',
      expected: [],
      options: HOSTS,
    },
    {
      name: 'a heading section does not change a relation line',
      body: '## Depends on\n- Blocked by: [#3]\n- #4',
      expected: ['b:#3', 'b:#4'],
    },
    {
      name: 'there is no Blocks relation keyword',
      body: 'Blocks: [#3]',
      expected: ['k:#3'],
    },
  ]);

  it('keeps the legacy forms in non-strict mode', () => {
    expect(parseBodyRelations('Depends on #12\n## Dependencies\n- #5')).toEqual(
      ['b:#5', 'b:#12'].map(rel),
    );
  });

  it('parses relation lines in strict mode', () => {
    expect(parseBodyRelations('Blocked by: [#1]\nParent: [o/r#2]', { strict: true })).toEqual(
      ['b:#1', 'p:o/r#2'].map(rel),
    );
  });

  it('the false-positive bullet: strict drops it, the legacy section form still reads it', () => {
    const body = '## Dependencies\n\n- No implementation dependency on #17 or #72\n';
    expect(parseBodyRelations(body, { strict: true })).toEqual([]);
    expect(parseBodyRelations(body)).toEqual(['b:#17', 'b:#72'].map(rel));
  });

  it('strict ignores keyword lines and section forms', () => {
    const body = 'Depends on #12\n## Depends on\n- #13\nBlocks: #14\nBlocked by: [#15]';
    expect(parseBodyRelations(body, { strict: true })).toEqual(['b:#15'].map(rel));
    expect(parseBodyRelations(body)).toEqual(['b:#12', 'b:#13', 'b:#15', 'k:#14'].map(rel));
  });

  it('parent sorts after both dependency kinds', () => {
    const body = 'Parent: [o/r#3]\nBlocks: #2\nDepends on #1';
    expect(parseBodyRelations(body)).toEqual(['b:#1', 'k:#2', 'p:o/r#3'].map(rel));
  });
});

describe('realistic bodies', () => {
  it('parses a typical issue description', () => {
    const body = [
      '## Summary',
      '',
      'Add the widget. This depends on #99 in prose, which is ignored.',
      '',
      '<!-- Depends on #98 -->',
      '',
      '## Dependencies',
      '',
      'Depends on: #1, acme/web#2',
      '- [ ] Blocked by https://github.com/acme/api/issues/3#issuecomment-5',
      '',
      '## Blocks',
      '- #10',
      '- [x] acme/docs#11',
      '',
      '## Notes',
      '- #12',
      '',
      '```',
      'Depends on #13',
      '```',
      '',
      '> Depends on #14',
      '',
    ].join('\n');
    expect(parseBodyRelations(body, HOSTS)).toEqual(
      ['b:#1', 'b:acme/api#3', 'b:acme/web#2', 'k:#10', 'k:acme/docs#11'].map(rel),
    );
  });
});
