import { compareRefs } from './keys.js';
import type { RawRelation } from './types.js';

export interface KeywordConfig {
  blockedBy: string[];
  blocks: string[];
}

export const DEFAULT_KEYWORDS: KeywordConfig = {
  blockedBy: ['depends on', 'blocked by', 'requires', 'dependencies'],
  blocks: ['blocks', 'blocking', 'required by'],
};

export interface ParseOptions {
  keywords?: KeywordConfig;
  /** Hostnames accepted in URL references (e.g. ['github.com']). Empty or undefined: URLs are ignored. */
  webHosts?: string[];
}

type Kind = RawRelation['kind'];

interface KeywordEntry {
  /** Lowercased, single-spaced. */
  text: string;
  kind: Kind;
}

/** Placeholder for an inline code span: not a word character, not whitespace. */
const CODE_PLACEHOLDER = '\u0001';

const WORD = '\\p{L}\\p{N}_';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKeyword(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Deduplicated keyword entries, longest first (ties: blocked-by first, then code-unit order). */
function buildKeywords(config: KeywordConfig): KeywordEntry[] {
  const seen = new Set<string>();
  const entries: KeywordEntry[] = [];
  const add = (list: string[] | undefined, kind: Kind): void => {
    for (const raw of list ?? []) {
      const text = normalizeKeyword(raw);
      if (text === '' || seen.has(text)) continue;
      seen.add(text);
      entries.push({ text, kind });
    }
  };
  add(config.blockedBy, 'blocked-by');
  add(config.blocks, 'blocks');
  entries.sort((a, b) => {
    if (a.text.length !== b.text.length) return b.text.length - a.text.length;
    if (a.kind !== b.kind) return a.kind === 'blocked-by' ? -1 : 1;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });
  return entries;
}

interface LineState {
  inComment: boolean;
}

/**
 * Removes HTML comments (replaced by a space) and inline code spans (replaced by a
 * placeholder) from one line. Comment state carries over to following lines.
 */
function cleanLine(line: string, state: LineState): string {
  let out = '';
  let i = 0;
  if (state.inComment) {
    const end = line.indexOf('-->');
    if (end < 0) return ' ';
    state.inComment = false;
    out = ' ';
    i = end + 3;
  }
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '<' && line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i + 4);
      out += ' ';
      if (end < 0) {
        state.inComment = true;
        return out;
      }
      i = end + 3;
    } else if (ch === '`') {
      let n = 1;
      while (line[i + n] === '`') n++;
      // Find the next backtick run of exactly the same length.
      let j = i + n;
      let close = -1;
      while (j < line.length) {
        if (line[j] !== '`') {
          j++;
          continue;
        }
        let m = 1;
        while (line[j + m] === '`') m++;
        if (m === n) {
          close = j + m;
          break;
        }
        j += m;
      }
      if (close < 0) {
        out += line.slice(i, i + n);
        i += n;
      } else {
        out += CODE_PLACEHOLDER;
        i = close;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^\s*(`+|~+)\s*$/;
const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+\.)\s+/;

/** Removes surrounding `**` / `__` emphasis markers. */
function stripEmphasis(s: string): string {
  let r = s.trim();
  for (;;) {
    const next = r
      .replace(/^(?:\*\*|__)/, '')
      .replace(/(?:\*\*|__)$/, '')
      .trim();
    if (next === r) return r;
    r = next;
  }
}

/** Normalizes heading text: drops closing #s, emphasis and a trailing colon. */
function headingText(raw: string | undefined): string {
  let t = (raw ?? '').trim().replace(/(?:^|[ \t]+)#+[ \t]*$/, '');
  t = stripEmphasis(t).replace(/:$/, '');
  return normalizeKeyword(stripEmphasis(t));
}

export function parseBodyRelations(body: string, options: ParseOptions = {}): RawRelation[] {
  const keywords = buildKeywords(options.keywords ?? DEFAULT_KEYWORDS);
  if (keywords.length === 0 || !body) return [];
  const kindOf = new Map<string, Kind>(keywords.map((k) => [k.text, k.kind]));
  const hosts = new Set(
    (options.webHosts ?? []).map((h) => h.trim().toLowerCase()).filter((h) => h !== ''),
  );

  const alternation = keywords.map((k) => escapeRegex(k.text).replace(/ /g, '\\s+')).join('|');
  const keywordLineRe = new RegExp(
    `^\\s*(?:(?:[-*+]|\\d+\\.)\\s+)?(?:\\[[ xX]\\]\\s*)?(?:\\*\\*|__)?(${alternation})(?:(?=__)|(?![${WORD}]))`,
    'iu',
  );

  const refRe = new RegExp(
    [
      // 1: host, 2: owner, 3: repo, 4: number
      `(?<![${WORD}])https?://([A-Za-z0-9.-]+(?::\\d+)?)/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\\d+)(?![${WORD}])`,
      // 5: owner, 6: repo, 7: number
      `(?<![${WORD}])([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\\d+)(?![${WORD}])`,
      // 8: number
      `(?<![${WORD}/])#(\\d+)(?![${WORD}])`,
    ].join('|'),
    'gu',
  );

  const found = new Map<string, RawRelation>();
  const addRefs = (text: string, kind: Kind): void => {
    for (const m of text.matchAll(refRe)) {
      let owner: string | null = null;
      let repo: string | null = null;
      let numText: string;
      if (m[4] !== undefined) {
        if (!hosts.has(m[1]!.toLowerCase())) continue;
        owner = m[2]!.toLowerCase();
        repo = m[3]!.toLowerCase();
        numText = m[4];
      } else if (m[7] !== undefined) {
        owner = m[5]!.toLowerCase();
        repo = m[6]!.toLowerCase();
        numText = m[7];
      } else {
        numText = m[8]!;
      }
      const number = Number(numText);
      if (!Number.isSafeInteger(number) || number < 1) continue;
      const id = `${kind}|${owner ?? ''}/${repo ?? ''}#${number}`;
      if (!found.has(id)) {
        found.set(id, { kind, ref: { owner, repo, number }, source: 'body' });
      }
    }
  };

  const lineState: LineState = { inComment: false };
  let fence: { char: string; length: number } | null = null;
  let section: Kind | null = null;

  for (const raw of body.split(/\r\n|\r|\n/)) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(raw);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (!lineState.inComment) {
      const open = FENCE_OPEN_RE.exec(raw);
      if (open) {
        const marker = open[1]!;
        // A backtick fence's info string cannot contain backticks (that is an inline span).
        if (!(marker[0] === '`' && open[2]!.includes('`'))) {
          fence = { char: marker[0]!, length: marker.length };
          continue;
        }
      }
    }

    const line = cleanLine(raw, lineState);
    if (/^\s*>/.test(line)) continue;

    const heading = HEADING_RE.exec(line);
    if (heading) {
      section = kindOf.get(headingText(heading[1])) ?? null;
      continue;
    }

    const kw = keywordLineRe.exec(line);
    if (kw) {
      const kind = kindOf.get(normalizeKeyword(kw[1]!));
      if (kind) addRefs(line.slice(kw[0].length), kind);
      continue;
    }

    if (section) {
      const marker = LIST_MARKER_RE.exec(line);
      if (marker) addRefs(line.slice(marker[0].length), section);
    }
  }

  const kindRank = (k: Kind): number => (k === 'blocked-by' ? 0 : 1);
  return [...found.values()].sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || compareRefs(a.ref, b.ref),
  );
}
