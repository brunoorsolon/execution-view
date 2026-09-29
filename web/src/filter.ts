export interface FilterTarget {
  key: string;
  number: number;
  title: string;
  labels: readonly string[];
}

export type Term =
  | { kind: 'label'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'key'; value: string }
  | { kind: 'text'; value: string };

const TOKEN_RE = /(?:label:)?"[^"]*"|\S+/gi;
const NUMBER_RE = /^#(\d+)$/;
const KEY_RE = /^[^\s/#]+\/[^\s/#]+#\d+$/;

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/**
 * Splits a query into AND-ed terms:
 *  - `label:P1` / `label:"good first issue"`: exact, case-insensitive label match
 *  - `#12`: issue number
 *  - `owner/repo#12`: full issue key
 *  - anything else: case-insensitive substring of the title or of the key
 */
export function parseQuery(q: string): Term[] {
  const terms: Term[] = [];
  for (const raw of q.match(TOKEN_RE) ?? []) {
    if (raw.toLowerCase().startsWith('label:')) {
      const value = unquote(raw.slice('label:'.length)).trim().toLowerCase();
      if (value !== '') terms.push({ kind: 'label', value });
      continue;
    }
    const num = NUMBER_RE.exec(raw);
    if (num) {
      terms.push({ kind: 'number', value: Number(num[1]) });
      continue;
    }
    if (KEY_RE.test(raw)) {
      terms.push({ kind: 'key', value: raw.toLowerCase() });
      continue;
    }
    const text = unquote(raw).trim().toLowerCase();
    if (text !== '') terms.push({ kind: 'text', value: text });
  }
  return terms;
}

function matchesTerm(term: Term, t: FilterTarget): boolean {
  switch (term.kind) {
    case 'label':
      return t.labels.some((l) => l.toLowerCase() === term.value);
    case 'number':
      return t.number === term.value;
    case 'key':
      return t.key.toLowerCase() === term.value;
    case 'text':
      return t.title.toLowerCase().includes(term.value) || t.key.toLowerCase().includes(term.value);
  }
}

export function matchesTerms(terms: readonly Term[], target: FilterTarget): boolean {
  return terms.every((term) => matchesTerm(term, target));
}

/** null when the query is empty (nothing to dim). */
export function compileFilter(q: string): ((target: FilterTarget) => boolean) | null {
  const terms = parseQuery(q);
  if (terms.length === 0) return null;
  return (target) => matchesTerms(terms, target);
}
