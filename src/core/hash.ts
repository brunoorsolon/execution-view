import { createHash } from 'node:crypto';

function serialize(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: non-finite number (${String(value)})`);
      }
      return JSON.stringify(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'bigint':
      throw new Error('canonicalJson: bigint is not supported');
    default:
      break;
  }
  if (Array.isArray(value)) {
    // Like JSON.stringify: undefined/functions inside arrays become null.
    return `[${value.map((v) => serialize(v) ?? 'null').join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  // Default sort() compares UTF-16 code units, which is what we want.
  for (const k of Object.keys(obj).sort()) {
    const s = serialize(obj[k]);
    if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
  }
  return `{${parts.join(',')}}`;
}

/** JSON with object keys sorted recursively (code-unit order) and no whitespace. */
export function canonicalJson(value: unknown): string {
  return serialize(value) ?? 'null';
}

/** sha256 hex of canonicalJson(value). */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
