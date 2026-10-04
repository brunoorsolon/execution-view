import { createRequire } from 'node:module';

/** The version in package.json (one level above both `src/` and `dist/`), or 0.0.0 if unreadable. */
export function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
